/**
 * ═══════════ «HỌC TỪ HỘI THOẠI CŨ» — CHỈ MÁY CHỦ ═══════════
 *
 * Phần thuần (làm sạch, gom lô, lọc giá, kiểu dữ liệu): `lib/sales-chatbot/playbook-shared.ts`. Tệp này: đọc lịch sử tin
 * nhắn fanpage qua Pancake bằng page access token ĐÃ LƯU của tổ chức (`pancake-fanpage`), cho AI của CHÍNH shop (khoá BYOK)
 * chắt thành «Sổ tay bán hàng» NHÁP, rồi các bước người: lưu nháp · xuất bản (có phiên bản) · quay lại bản trước · gỡ.
 * Bot chỉ đọc bản ĐÃ XUẤT BẢN (`publishedPlaybookText`). Tin nhắn gốc chỉ sống trong bộ nhớ của lượt chạy — không lưu.
 * Mỗi lời gọi AI một dòng sổ dùng AI (`sales_playbook`), chịu trần chi phí của gói.
 */
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { estimateCostUsd, type AiBlock } from "@/lib/ai/provider";
import { recordAiUsage } from "@/lib/ai-usage/ledger";
import { checkAiQuota } from "@/lib/ai-usage/quota";
import { describeNetworkFailure, isNetworkFailure } from "@/lib/connectors/net-error";
import { openActiveConnection } from "@/lib/connectors/service";
import { PANCAKE_PAGES_API, scrubSecrets } from "@/lib/connectors/testers";
import { canUseModule } from "@/lib/platform/capabilities";
import { currentOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { readJsonSetting, salesChatProvider } from "@/lib/sales-chatbot/engine";
import {
  batchTranscripts,
  CLOSED_TAG,
  customerLeftPhone,
  OPEN_TAG,
  parsePlaybookRun,
  parsePlaybookState,
  PLAYBOOK_LIMITS,
  PLAYBOOK_RUN_SETTING_KEY,
  PLAYBOOK_SETTING_KEY,
  stripPrices,
  transcriptFor,
  type PlaybookRun,
  type PlaybookState,
  type PlaybookStats,
} from "@/lib/sales-chatbot/playbook-shared";
import { saveLearnedQuickReplies } from "@/lib/sales-chatbot/quick-replies";
import { parseLearnedQuickReplies, QUICK_REPLY_LIMITS } from "@/lib/sales-chatbot/quick-replies-shared";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";
import { CUSTOMER_AI_NOT_READY_LABEL, customerFacing, customerQuotaError, customerSafeAiError } from "@/lib/saas/visibility";
import { setSettingJson } from "@/lib/settings";

const FANPAGE = "pancake-fanpage";
/** Ngân sách token đầu ra của một lượt AI khi học (gồm cả phần suy luận của model có suy luận). */
export const PLAYBOOK_AI_TOKENS = 12_000;
/** Hỏng liền chừng này hội thoại ⇒ lỗi hệ thống (token / mạng), không phải một hội thoại lẻ ⇒ dừng lượt học. */
export const PLAYBOOK_MAX_CONSECUTIVE_SKIPS = 5;

export async function loadPlaybook(): Promise<PlaybookState> {
  return parsePlaybookState(await readJsonSetting(PLAYBOOK_SETTING_KEY));
}

export async function loadPlaybookRun(): Promise<PlaybookRun> {
  return parsePlaybookRun(await readJsonSetting(PLAYBOOK_RUN_SETTING_KEY));
}

/** Văn bản sổ tay ĐÃ XUẤT BẢN cho lời nhắc của bot ('' khi chưa có). */
export async function publishedPlaybookText(): Promise<string> {
  return ((await loadPlaybook()).published?.text ?? "").slice(0, PLAYBOOK_LIMITS.playbookChars);
}

type Gate = { ok: true } | { ok: false; error: string };

async function gate(user: SessionUser): Promise<Gate> {
  if (!(await canUseModule("ai_sales"))) return { ok: false, error: "Module AI bán hàng chưa bật." };
  if (!can(user, SALES_CHATBOT_MANAGE)) return { ok: false, error: "Bạn không có quyền cấu hình chatbot bán hàng (ai_sales:manage)." };
  return { ok: true };
}

export type PlaybookDeps = { fetch?: typeof fetch; now?: () => Date; sleep?: (ms: number) => Promise<void> };

/**
 * Kiểm mọi điều kiện rồi ĐÁNH DẤU lượt chạy (RUNNING). Việc nặng (`runPlaybookLearning`) do server action chạy SAU phản
 * hồi. Một lượt mỗi lúc; lượt treo quá `runStaleMinutes` thì lượt sau được chạy lại.
 */
export async function startPlaybookLearning(user: SessionUser, raw: { conversations?: unknown; days?: unknown }, now: Date = new Date()): Promise<{ ok: true; target: number; days: number } | { error: string }> {
  const g = await gate(user);
  if (!g.ok) return { error: g.error };
  const target = Number(raw.conversations);
  const days = Number(raw.days);
  if (!(PLAYBOOK_LIMITS.conversationChoices as readonly number[]).includes(target)) return { error: "Số hội thoại không hợp lệ." };
  if (!(PLAYBOOK_LIMITS.dayChoices as readonly number[]).includes(days)) return { error: "Khoảng ngày không hợp lệ." };
  const conn = await openActiveConnection(FANPAGE);
  if (!conn.ok) return { error: "Bật kết nối «Fanpage qua Pancake» (Cài đặt → Kết nối) trước — máy đọc lịch sử bằng page access token của shop." };
  // Workspace KHÁCH (lib/saas/visibility.ts): câu nguồn AI / hạn mức gốc mang tên khoá, USD ⇒ câu của khách; cổng gói giữ nguyên.
  const customer = customerFacing(user.organization);
  const prov = await salesChatProvider();
  if (!prov.ok) return { error: customer ? customerSafeAiError(prov.error, CUSTOMER_AI_NOT_READY_LABEL) : prov.error };
  const org = await currentOrganization();
  const quota = await checkAiQuota(org.code, prov.source);
  if (!quota.ok) return { error: customer ? customerQuotaError(quota.reason) : quota.error };
  const run = await loadPlaybookRun();
  if (run.state === "RUNNING" && now.getTime() - new Date(run.startedAt).getTime() < PLAYBOOK_LIMITS.runStaleMinutes * 60_000) return { error: "Đang có một lượt học chạy — đợi xong rồi chạy lại." };
  await setSettingJson(PLAYBOOK_RUN_SETTING_KEY, { state: "RUNNING", startedAt: now.toISOString(), startedBy: user.email, target, days, fetched: 0, note: "Đang đọc lịch sử tin nhắn" } satisfies PlaybookRun);
  return { ok: true, target, days };
}

/** Lỗi Pancake đáng thử lại: mạng / hết giờ chờ, 429, 5xx. Lỗi khác (token sai, 4xx) thử lại cũng vô ích. */
class PancakeTransient extends Error {}

/** Lịch chờ giữa các lần thử lại một lời gọi Pancake (ms). */
export const PANCAKE_RETRY_DELAYS_MS = [2_000, 5_000] as const;

/**
 * GET Pancake có THỬ LẠI (02/10/2026: một lời gọi hết 30 giây chờ trong ~150 lời gọi liên tiếp làm HỎNG CẢ lượt học, dù
 * Pancake vẫn chạy). Hết giờ chờ / mạng / 429 / 5xx ⇒ chờ 2 giây, 5 giây rồi thử lại; vẫn hỏng ⇒ ném.
 */
async function pancakeJson(fetchImpl: typeof fetch, url: string, token: string, sleep: (ms: number) => Promise<void>): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt++) {
    try {
      let res: Response;
      try {
        res = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(30_000) });
      } catch (e) {
        throw new PancakeTransient(isNetworkFailure(e) ? describeNetworkFailure(e, "pages.fm") : `Không gọi được Pancake: ${e instanceof Error ? e.message : String(e)}`);
      }
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.status === 429 || res.status >= 500) throw new PancakeTransient(scrubSecrets(`Pancake bận (HTTP ${res.status})`, [token]));
      if (!res.ok || !body || body.success === false) throw new Error(scrubSecrets(`Pancake từ chối: ${String(body?.message ?? `HTTP ${res.status}`)}`, [token]));
      return body;
    } catch (e) {
      if (!(e instanceof PancakeTransient) || attempt >= PANCAKE_RETRY_DELAYS_MS.length) throw e;
      await sleep(PANCAKE_RETRY_DELAYS_MS[attempt]);
    }
  }
}

type PancakeMsg = { id?: unknown; from?: { id?: unknown; name?: unknown; uid?: unknown; admin_id?: unknown }; message?: unknown; original_message?: unknown; inserted_at?: unknown };
type PancakeConv = { id?: unknown; updated_at?: unknown; from?: { name?: unknown } };

const EXTRACT_SYSTEM = (shop: string) =>
  [
    `Bạn phân tích hội thoại bán hàng THẬT trên fanpage của shop «${shop}». Mọi con số đã bị che thành [số], tên khách thành [khách].`,
    `Dòng đầu mỗi hội thoại là KẾT QUẢ: «${CLOSED_TAG}» hoặc «${OPEN_TAG}». Học từ KẾT QUẢ, không chỉ từ lời lẽ:`,
    "so sánh shop đã nói / hỏi / gửi gì ở hội thoại CHỐT ĐƯỢC mà không có ở hội thoại khách bỏ đi, và khách bỏ đi ngay sau câu nào.",
    "Viết tiếng Việt, gạch đầu dòng, tối đa 2500 ký tự, rút ra:",
    "1) giọng điệu và cách xưng hô của shop; 2) câu khách hay hỏi + cách shop trả lời TỐT — ưu tiên câu ở hội thoại chốt được (trích câu mẫu ngắn);",
    "3) cách xử lý khi khách chê giá / phân vân / so sánh; 4) cách dẫn tới chốt đơn (xin SĐT / địa chỉ lúc nào, bằng câu nào);",
    "5) câu trả lời KÉM cần tránh — câu khiến khách im lặng / bỏ đi; 6) câu hỏi khách hỏi mà shop trả lời chậm hoặc không trả lời.",
    "TUYỆT ĐỐI không nêu giá, số tiền, mức giảm, khuyến mãi cụ thể, thời gian giao cụ thể hay thông tin của khách nào.",
  ].join("\n");

const MERGE_SYSTEM = (shop: string, hasCurrent: boolean) =>
  [
    `Gộp các ghi chú phân tích dưới đây thành «SỔ TAY BÁN HÀNG» cho trợ lý chat của shop «${shop}». Tiếng Việt, tối đa 5000 ký tự,`,
    "đúng năm mục: 1. Giọng điệu & xưng hô · 2. Câu hỏi thường gặp & cách trả lời mẫu · 3. Khi khách chê giá / phân vân ·",
    "4. Dẫn tới chốt đơn · 5. Không bao giờ nói. Câu mẫu ngắn, dùng được ngay. TUYỆT ĐỐI không nêu giá, số tiền, khuyến mãi,",
    "thời gian giao cụ thể — trợ lý luôn lấy giá và tồn từ hệ thống lúc chat. Không nhắc tên khách.",
    "Ưu tiên điều đã được chứng minh ở hội thoại CHỐT ĐƯỢC; điều chỉ thấy ở hội thoại khách bỏ đi thì đưa vào mục 5.",
    ...(hasCurrent
      ? ["Có «SỔ TAY ĐANG DÙNG» ở cuối: GIỮ điều còn đúng, SỬA điều ghi chú mới cho thấy là sai, THÊM điều mới — không viết lại từ đầu, không bỏ mất câu mẫu tốt đang có."]
      : []),
  ].join("\n");

const QUICK_REPLY_SYSTEM = (shop: string) =>
  [
    `Từ các ghi chú phân tích hội thoại bán hàng của shop «${shop}», chọn tối đa ${QUICK_REPLY_LIMITS.learnedMax} câu hỏi khách hỏi NHIỀU NHẤT mà trả lời được bằng MỘT câu soạn sẵn (cách bảo quản, cách dùng, quy cách đóng gói, ship đi đâu, thanh toán, còn hàng không…).`,
    "Trả về DUY NHẤT một mảng JSON: [{\"title\": \"tên ngắn\", \"triggers\": [\"3–6 cách khách hay gõ, viết như khách gõ\"], \"answer\": \"câu trả lời theo giọng shop, ngắn\"}].",
    "TUYỆT ĐỐI không ghi giá, số tiền, khuyến mãi, phí ship hay số lượng tồn cụ thể — chỗ cần giá thì viết đúng chữ [giá lấy từ ERP]. Không nhắc tên khách.",
  ].join("\n");

const textOf = (content: AiBlock[]) =>
  content
    .filter((b): b is Extract<AiBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

/**
 * Lượt chạy NẶNG (sau phản hồi, trong đúng ngữ cảnh tổ chức): đọc lịch sử ⇒ làm sạch ⇒ AI từng lô ⇒ gộp ⇒ lọc giá ⇒ lưu
 * NHÁP. Không ném: lỗi ⇒ trạng thái FAILED với câu đã che token.
 */
export async function runPlaybookLearning(opts: { target: number; days: number }, actor: { id: string | null; email: string | null }, deps: PlaybookDeps = {}): Promise<PlaybookRun> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchImpl = deps.fetch ?? fetch;
  const startedAt = now().toISOString();
  const stats: PlaybookStats = { conversations: 0, messages: 0, aiCalls: 0, costUsd: 0, pricesRemoved: 0, closed: 0, skipped: 0 };
  let token = "";
  // Câu lỗi mạng phải nêu ĐÚNG máy đang gọi: lượt hỏng lúc AI đang đọc không phải lỗi Pancake.
  let phase: "PANCAKE" | "AI" = "PANCAKE";
  const progress = (fetched: number, note: string) =>
    setSettingJson(PLAYBOOK_RUN_SETTING_KEY, { state: "RUNNING", startedAt, startedBy: actor.email, target: opts.target, days: opts.days, fetched, note } satisfies PlaybookRun);
  try {
    const conn = await openActiveConnection(FANPAGE);
    if (!conn.ok) throw new Error("Kết nối «Fanpage qua Pancake» chưa bật.");
    const pageId = (conn.settings.pageId ?? "").trim();
    token = (conn.secrets.pageAccessToken ?? "").trim();
    const since = now().getTime() - opts.days * 86_400_000;
    const q = `page_access_token=${encodeURIComponent(token)}`;

    // 1. Danh sách hội thoại INBOX mới nhất ⇒ đủ số cần đọc hoặc hết khoảng ngày.
    const convs: PancakeConv[] = [];
    let last = "";
    for (let page = 0; page < 20 && convs.length < opts.target * 2; page++) {
      const body = await pancakeJson(fetchImpl, `${PANCAKE_PAGES_API}/v2/pages/${encodeURIComponent(pageId)}/conversations?${q}&type=INBOX&order_by=updated_at${last ? `&last_conversation_id=${encodeURIComponent(last)}` : ""}`, token, sleep);
      const list = (Array.isArray(body.conversations) ? body.conversations : []) as PancakeConv[];
      if (!list.length) break;
      let tooOld = false;
      for (const c of list) {
        const t = Date.parse(String(c.updated_at ?? ""));
        if (Number.isFinite(t) && t < since) {
          tooOld = true;
          break;
        }
        convs.push(c);
      }
      last = String(list[list.length - 1].id ?? "");
      if (tooOld || !last) break;
      await sleep(250);
    }

    // 2. Tin của từng hội thoại ⇒ bản chép đã làm sạch (giữ hội thoại có CẢ khách lẫn shop). Một hội thoại Pancake không trả
    //    được sau khi thử lại ⇒ BỎ QUA hội thoại đó, đếm vào `skipped`, học tiếp; hỏng liền `PLAYBOOK_MAX_CONSECUTIVE_SKIPS`
    //    hội thoại ⇒ lỗi hệ thống (token, mạng) ⇒ dừng với câu lỗi thật.
    const transcripts: string[] = [];
    let fetched = 0;
    let consecutiveSkips = 0;
    let lastSkipError: unknown = null;
    for (const c of convs) {
      if (transcripts.length >= opts.target) break;
      const id = String(c.id ?? "");
      if (!id) continue;
      await sleep(250);
      let body: Record<string, unknown>;
      try {
        body = await pancakeJson(fetchImpl, `${PANCAKE_PAGES_API}/v1/pages/${encodeURIComponent(pageId)}/conversations/${encodeURIComponent(id)}/messages?${q}`, token, sleep);
        consecutiveSkips = 0;
      } catch (e) {
        stats.skipped = (stats.skipped ?? 0) + 1;
        consecutiveSkips += 1;
        lastSkipError = e;
        if (consecutiveSkips >= PLAYBOOK_MAX_CONSECUTIVE_SKIPS) throw e;
        continue;
      }
      fetched += 1;
      const msgs = ((Array.isArray(body.messages) ? body.messages : []) as PancakeMsg[])
        .slice()
        .sort((a, b) => Date.parse(String(a.inserted_at ?? "")) - Date.parse(String(b.inserted_at ?? "")));
      const names = [String(c.from?.name ?? "")];
      const lines = msgs.map((m) => {
        const fromShop = String(m.from?.id ?? "") === pageId || Boolean(m.from?.uid) || Boolean(m.from?.admin_id);
        if (!fromShop && m.from?.name) names.push(String(m.from.name));
        return { fromShop, text: String(m.original_message ?? m.message ?? "") };
      });
      const closed = customerLeftPhone(lines);
      const tr = transcriptFor(lines, names, { closed });
      if (tr) {
        transcripts.push(tr);
        stats.messages += lines.length;
        if (closed) stats.closed = (stats.closed ?? 0) + 1;
      }
      if (fetched % 10 === 0) await progress(fetched, `Đã đọc ${fetched} hội thoại — ${transcripts.length} đủ để học`);
    }
    // Không đọc được hội thoại NÀO ⇒ lỗi thật là lỗi Pancake, không phải «chưa đủ hội thoại để học».
    if (fetched === 0 && lastSkipError) throw lastSkipError;
    stats.conversations = transcripts.length;
    if (transcripts.length < 3) throw new Error(`Chỉ có ${transcripts.length} hội thoại có cả khách lẫn shop trả lời trong ${opts.days} ngày — chưa đủ để học (cần ≥ 3).`);

    // 3. AI của shop đọc từng lô ⇒ ghi chú; gộp ⇒ sổ tay.
    phase = "AI";
    const org = await currentOrganization();
    const shop = (await findOrganization(org.code))?.name ?? org.code;
    const prov = await salesChatProvider();
    if (!prov.ok) throw new Error(prov.error);
    const ask = async (system: string, text: string, reasoning: "low" | "medium" = "low"): Promise<string> => {
      const quota = await checkAiQuota(org.code, prov.source);
      if (!quota.ok) throw new Error(quota.error);
      let status: "OK" | "ERROR" = "OK";
      try {
        // Ngân sách rộng + suy luận «low»: đo 01/10/2026 — ngân sách 1.800 với suy luận «medium» ⇒ model suy nghĩ hết ngân
        // sách và trả RỖNG, bản nháp lưu trống. Rỗng ⇒ thử lại MỘT lần với ngân sách gấp đôi; vẫn rỗng ⇒ báo lỗi, không lưu.
        let out = "";
        let stop = "";
        for (const budget of [PLAYBOOK_AI_TOKENS, PLAYBOOK_AI_TOKENS * 2]) {
          const res = await prov.provider.complete({ system, messages: [{ role: "user", content: [{ type: "text", text }] }], tools: [], maxTokens: budget, reasoning });
          const cost = estimateCostUsd(res.model || prov.provider.model, res.usage);
          stats.aiCalls += 1;
          stats.costUsd = stats.costUsd === null || cost === null ? null : stats.costUsd + cost;
          await recordAiUsage({ orgCode: org.code, feature: "sales_playbook", source: prov.source, provider: prov.provider.name, model: res.model || prov.provider.model, requests: 1, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUsd: cost, status, actorId: actor.id, ref: "playbook" }).catch(() => undefined);
          out = textOf(res.content);
          stop = res.stopReason;
          if (out) break;
        }
        if (!out) throw new Error(`AI không trả về nội dung (dừng: ${stop}) — chạy lại, hoặc chọn model khác ở khung Cấu hình.`);
        return out;
      } catch (e) {
        status = "ERROR";
        await recordAiUsage({ orgCode: org.code, feature: "sales_playbook", source: prov.source, provider: prov.provider.name, model: prov.provider.model, requests: 1, inputTokens: null, outputTokens: null, costUsd: null, status, actorId: actor.id, ref: "playbook" }).catch(() => undefined);
        throw e;
      }
    };
    const batches = batchTranscripts(transcripts);
    const notes: string[] = [];
    for (let i = 0; i < batches.length; i++) {
      await progress(fetched, `AI đang đọc lô ${i + 1}/${batches.length}`);
      notes.push(await ask(EXTRACT_SYSTEM(shop), batches[i]));
    }
    await progress(fetched, "AI đang soạn sổ tay");
    // LUÔN soạn qua bước gộp — kể cả một lô — để sổ tay luôn đủ năm mục, không phải ghi chú thô.
    // Bước gộp suy luận «medium» (một lời gọi, quyết định chất lượng cả sổ tay) và HỌC TIẾP trên sổ tay đang dùng thay vì
    // viết lại từ đầu — câu mẫu tốt của lượt trước không mất đi chỉ vì lượt này đọc tập hội thoại khác.
    const current = (await loadPlaybook()).published?.text?.trim() ?? "";
    const mergeInput = `${notes.map((n, i) => `### Ghi chú ${i + 1}\n${n}`).join("\n\n")}${current ? `\n\n### SỔ TAY ĐANG DÙNG\n${current}` : ""}`;
    const merged = await ask(MERGE_SYSTEM(shop, Boolean(current)), mergeInput, "medium");
    const clean = stripPrices(merged);
    stats.pricesRemoved = clean.removed;
    if (!clean.text.trim()) throw new Error("Sổ tay AI soạn ra rỗng sau khi lọc giá — không lưu bản nháp trống; chạy lại.");
    // Gợi ý CÂU TRẢ LỜI MẪU (0183) từ cùng ghi chú: luôn TẮT, chờ người duyệt. Hỏng ở bước này không làm hỏng lượt học.
    await progress(fetched, "AI đang gợi ý câu trả lời mẫu");
    try {
      stats.quickReplies = await saveLearnedQuickReplies(parseLearnedQuickReplies(await ask(QUICK_REPLY_SYSTEM(shop), notes.map((n, i) => `### Ghi chú ${i + 1}\n${n}`).join("\n\n"))), actor.email);
    } catch {
      stats.quickReplies = 0;
    }
    const state = await loadPlaybook();
    await setSettingJson(PLAYBOOK_SETTING_KEY, { ...state, draft: { text: clean.text.slice(0, PLAYBOOK_LIMITS.playbookChars), createdAt: now().toISOString(), createdBy: actor.email, stats } } satisfies PlaybookState);
    const done: PlaybookRun = { state: "DONE", startedAt, finishedAt: now().toISOString(), stats };
    await setSettingJson(PLAYBOOK_RUN_SETTING_KEY, done);
    return done;
  } catch (e) {
    const raw = isNetworkFailure(e)
      ? phase === "PANCAKE"
        ? `Không gọi được Pancake: ${describeNetworkFailure(e, "pages.fm")}`
        : `Không gọi được AI: ${describeNetworkFailure(e, "nhà cung cấp AI")}`
      : e instanceof PancakeTransient
        ? `Không gọi được Pancake sau ${PANCAKE_RETRY_DELAYS_MS.length + 1} lần thử: ${e.message}`
        : e instanceof Error
          ? e.message
          : String(e);
    const failed: PlaybookRun = { state: "FAILED", startedAt, finishedAt: now().toISOString(), error: scrubSecrets(raw, [token]).slice(0, 300) };
    await setSettingJson(PLAYBOOK_RUN_SETTING_KEY, failed).catch(() => undefined);
    return failed;
  }
}

/** Lưu bản nháp sau khi chủ shop sửa tay (vẫn lọc giá). */
export async function savePlaybookDraft(user: SessionUser, text: unknown): Promise<{ ok: true; message: string } | { error: string }> {
  const g = await gate(user);
  if (!g.ok) return { error: g.error };
  const t = String(text ?? "").trim();
  if (t.length < 20) return { error: "Sổ tay quá ngắn." };
  if (t.length > PLAYBOOK_LIMITS.playbookChars) return { error: `Sổ tay tối đa ${PLAYBOOK_LIMITS.playbookChars} ký tự.` };
  const clean = stripPrices(t);
  const state = await loadPlaybook();
  await setSettingJson(PLAYBOOK_SETTING_KEY, { ...state, draft: { text: clean.text, createdAt: new Date().toISOString(), createdBy: user.email, stats: state.draft?.stats ?? null } } satisfies PlaybookState);
  return { ok: true, message: clean.removed ? `Đã lưu nháp — gỡ ${clean.removed} con số dạng giá (giá luôn lấy từ ERP).` : "Đã lưu nháp." };
}

/** Xuất bản bản nháp ⇒ bot dùng ngay. Bản đang dùng lùi vào lịch sử (giữ `keepVersions` bản). */
export async function publishPlaybook(user: SessionUser): Promise<{ ok: true; message: string } | { error: string }> {
  const g = await gate(user);
  if (!g.ok) return { error: g.error };
  const state = await loadPlaybook();
  if (!state.draft) return { error: "Chưa có bản nháp để xuất bản." };
  const version = Math.max(0, state.published?.version ?? 0, ...state.history.map((h) => h.version)) + 1;
  const published = { version, text: state.draft.text, publishedAt: new Date().toISOString(), publishedBy: user.email };
  const history = [...(state.published ? [state.published] : []), ...state.history].slice(0, PLAYBOOK_LIMITS.keepVersions);
  await setSettingJson(PLAYBOOK_SETTING_KEY, { draft: null, published, history } satisfies PlaybookState);
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_PLAYBOOK_PUBLISH", entity: "SETTINGS", entityId: PLAYBOOK_SETTING_KEY, before: { version: state.published?.version ?? null }, after: { version }, reason: "Xuất bản sổ tay bán hàng cho chatbot" });
  return { ok: true, message: `Đã xuất bản sổ tay bản ${version} — bot dùng từ tin nhắn kế tiếp.` };
}

/** Quay lại một bản đã xuất bản trước đó (bản đang dùng lùi vào lịch sử). */
export async function rollbackPlaybook(user: SessionUser, versionRaw: unknown): Promise<{ ok: true; message: string } | { error: string }> {
  const g = await gate(user);
  if (!g.ok) return { error: g.error };
  const version = Number(versionRaw);
  const state = await loadPlaybook();
  const target = state.history.find((h) => h.version === version);
  if (!target) return { error: "Không có bản này trong lịch sử." };
  const history = [...(state.published ? [state.published] : []), ...state.history.filter((h) => h.version !== version)].slice(0, PLAYBOOK_LIMITS.keepVersions);
  await setSettingJson(PLAYBOOK_SETTING_KEY, { ...state, published: { ...target, publishedAt: new Date().toISOString(), publishedBy: user.email }, history } satisfies PlaybookState);
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_PLAYBOOK_ROLLBACK", entity: "SETTINGS", entityId: PLAYBOOK_SETTING_KEY, before: { version: state.published?.version ?? null }, after: { version }, reason: "Quay lại sổ tay bán hàng bản trước" });
  return { ok: true, message: `Bot đang dùng lại sổ tay bản ${version}.` };
}

/** Gỡ sổ tay khỏi bot (bản đang dùng lùi vào lịch sử, quay lại được). */
export async function unpublishPlaybook(user: SessionUser): Promise<{ ok: true; message: string } | { error: string }> {
  const g = await gate(user);
  if (!g.ok) return { error: g.error };
  const state = await loadPlaybook();
  if (!state.published) return { error: "Bot chưa dùng sổ tay nào." };
  await setSettingJson(PLAYBOOK_SETTING_KEY, { ...state, published: null, history: [state.published, ...state.history].slice(0, PLAYBOOK_LIMITS.keepVersions) } satisfies PlaybookState);
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_PLAYBOOK_UNPUBLISH", entity: "SETTINGS", entityId: PLAYBOOK_SETTING_KEY, before: { version: state.published.version }, after: { version: null }, reason: "Gỡ sổ tay bán hàng khỏi chatbot" });
  return { ok: true, message: "Đã gỡ sổ tay — bot trả lời theo cấu hình gốc." };
}

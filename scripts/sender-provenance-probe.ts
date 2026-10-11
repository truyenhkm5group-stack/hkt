/*
  ops `sender-provenance-probe` — TIN PHÍA PAGE CỦA MỘT TỔ CHỨC MANG DẤU NGƯỜI GỬI GÌ (CHỈ ĐỌC, KHÔNG IN CHỮ TIN).

  Vì sao có (P0 11/10/2026, trước khi deploy nhánh `fix/response-ownership`): bản vá chỉ cho AI nhường khi tin phía page do một NGƯỜI
  ĐÃ XÁC MINH gửi (tài khoản nhân viên Pancake `from.uid` / `from.admin_id`, ứng dụng Hộp thư Page của Meta, hộp thư ERP). Tin không
  mang dấu nào thành UNKNOWN ⇒ KHÔNG nhường. Nếu nhân viên HSLC gõ trên Pancake mà phần lớn tin KHÔNG mang uid thì sau bản vá AI sẽ chen
  vào cuộc chat của người. Script này ĐO trước khi quyết:

   1. CSDL của tổ chức (getDbForInspection — Postgres ép chỉ đọc, hỏi lại phiên): dòng `PAGE_REPLY` 7 ngày (gồm dòng hộp thư ERP
      `staff-out:`), dòng `BOT_SENT` (để nhận tiếng vọng của bot), danh sách hội thoại có tin phía page — mới nhất trước.
   2. API Pancake (token page của CHÍNH tổ chức qua pageTokensForOffboard, CHỈ GET, nghỉ giữa các lượt gọi, dừng khi gặp 429): tin của
      ≤ N hội thoại, đúng điểm cuối `fetchThreadMessages` của đường xử lý tin.
   3. Phân loại MỖI tin phía page trong cửa sổ (`classifyProbeMessage` — BẢN ĐO; nguồn sự thật của luật là
      lib/sales-chatbot/response-ownership.ts trên nhánh fix/response-ownership, chưa có trên main nên chép logic tối thiểu):
      tiếng vọng bot · nhân viên hộp thư ERP · ghi chú tự động Pancake / tin không chữ · chữ hệ thống trả lời bình luận · có uid/admin_id
      nhân viên · cờ tự động · app Hộp thư Page (263902037430900) · app khác (mã ẩn 4 số cuối) · tin mẫu (≥ 40 ký tự, cùng khoá ở ≥ 3
      hội thoại — đúng cách audit `integrity-audit.ts::templateKeys`) · KHÔNG GÌ CẢ (⇒ sau bản vá là UNKNOWN).
   4. Trong nhóm KHÔNG GÌ CẢ: bao nhiêu tin nằm GIỮA chuỗi người đang chat (có tin người đã xác minh trong ±10 phút cùng hội thoại) — đúng
      rủi ro «AI chen vào cuộc chat của người»; bao nhiêu nằm ±10 phút sau một câu bot (luật cũ «bot vừa nói ⇒ là người» bắt chúng); bao
      nhiêu ở đầu phiên (tin chào). Cộng: tên các KHOÁ mang chữ «app» trong payload tin (đường khoá, không giá trị) — để biết Pancake
      có chuyển mã app của Meta hay không.

  Cả lượt MÃ HOÁ (ops-vps `OPS_THAO_TAC_MA_HOA`); dòng [ops:tom-tat] chỉ mang số đếm / tỷ lệ / mã app đã ẩn — không chữ tin, tên, SĐT,
  mã hội thoại, token.

  arg: `<mã tổ chức> [--days=1..14] [--threads=1..80]` (mặc định 7 ngày, 40 hội thoại).
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("sender-provenance-probe.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDbForInspection, schema, type Db } from "@/db";
import { pageTokensForOffboard } from "@/lib/connectors/service";
import { PANCAKE_PAGES_API, scrubSecrets } from "@/lib/connectors/testers";
import { findOrganization } from "@/lib/platform/organizations";
import { FANPAGE_CONNECTOR, PAGE_REPLY, PANCAKE_AUTO_NOTE_RE, STAFF_OUT_PREFIX, stripHtml } from "@/lib/sales-chatbot/fanpage";
import { foldVi } from "@/lib/sales-chatbot/text";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);

// ─────────────────────────── PHẦN THUẦN ───────────────────────────

export const PROBE_DEFAULT_DAYS = 7;
export const PROBE_MAX_DAYS = 14;
export const PROBE_DEFAULT_THREADS = 40;
export const PROBE_MAX_THREADS = 80;
/** App Hộp thư Page / Meta Business Suite — bản đo, cùng giá trị `META_HUMAN_INBOX_APP_IDS` của response-ownership.ts. */
export const META_INBOX_APP_ID = "263902037430900";
/** Cửa sổ «giữa chuỗi người đang chat» quanh một tin không dấu. */
export const HUMAN_CHAIN_WINDOW_MS = 10 * 60_000;
/** Tin mẫu: đúng ngưỡng audit (`integrity-audit.ts` — TEMPLATE_MIN_LENGTH / TEMPLATE_MIN_THREADS). */
export const PROBE_TEMPLATE_MIN_LENGTH = 40;
export const PROBE_TEMPLATE_MIN_THREADS = 3;
const SESSION_GAP_MS = 24 * 3_600_000;
const GREETING_WINDOW_MS = 60_000;
const SYSTEM_COMMENT_RE = /\bban dang phan hoi binh luan\b|you(?:'|’)?re replying to (?:a )?comment/;

export const PROBE_CLASSES = ["BOT_ECHO", "ERP_STAFF", "AUTO_NOTE", "META_COMMENT_SYSTEM", "STAFF_UID", "AUTO_FLAG", "META_INBOX_APP", "OTHER_APP", "TEMPLATE", "NONE"] as const;
export type ProbeClass = (typeof PROBE_CLASSES)[number];
/** Nhóm nào sau bản vá là NGƯỜI ĐÃ XÁC MINH (được làm AI nhường). */
export const VERIFIED_CLASSES: ReadonlySet<ProbeClass> = new Set(["ERP_STAFF", "STAFF_UID", "META_INBOX_APP"]);

export function parseProbeArgs(argv: readonly string[]): { code: string; days: number; threads: number } | { error: string } {
  const code = (argv.find((a) => !a.startsWith("--")) ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(code)) return { error: "thiếu / sai mã tổ chức" };
  const num = (k: string, def: number, max: number): number | null => {
    const raw = argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
    const n = raw === undefined ? def : Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
  };
  const days = num("days", PROBE_DEFAULT_DAYS, PROBE_MAX_DAYS);
  const threads = num("threads", PROBE_DEFAULT_THREADS, PROBE_MAX_THREADS);
  if (days === null) return { error: `--days phải là số nguyên 1..${PROBE_MAX_DAYS}` };
  if (threads === null) return { error: `--threads phải là số nguyên 1..${PROBE_MAX_THREADS}` };
  return { code, days, threads };
}

/** Mã app ẩn 4 số cuối (đủ để phân biệt các app, không đủ để dùng lại). HÀM THUẦN. */
export function maskAppId(id: string): string {
  const s = id.trim();
  if (s.length <= 4) return "****";
  return `${s.slice(0, -4)}****`;
}

/** Khoá câu mẫu — cùng cách audit (`foldVi`: bỏ dấu, gộp khoảng trắng). HÀM THUẦN. */
export const probeTemplateKey = (text: string) => foldVi(text);

/** Khoá tin mẫu từ (hội thoại, chữ): ≥ 40 ký tự, cùng khoá ở ≥ 3 hội thoại. HÀM THUẦN. */
export function probeTemplateKeys(rows: readonly { thread: string; text: string }[]): Set<string> {
  const by = new Map<string, Set<string>>();
  for (const r of rows) {
    const k = probeTemplateKey(r.text);
    if (k.length < PROBE_TEMPLATE_MIN_LENGTH) continue;
    by.set(k, (by.get(k) ?? new Set()).add(r.thread));
  }
  return new Set([...by].filter(([, s]) => s.size >= PROBE_TEMPLATE_MIN_THREADS).map(([k]) => k));
}

/** Một tin phía page đọc từ Pancake — đã chuẩn hoá, không còn trường thô. */
export type ProbeMessage = { id: string; thread: string; at: number; text: string; uid: boolean; automated: boolean; appId: string | null; fromPage: boolean };

const ws = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Nhóm của MỘT tin phía page (BẢN ĐO — nguồn sự thật là response-ownership.ts::classifyOutbound). `bot` = mã + chữ (đã gộp khoảng trắng)
 * các dòng BOT_SENT của CÙNG hội thoại; `erpStaff` = chữ dòng `staff-out:` của cùng hội thoại. HÀM THUẦN.
 */
export function classifyProbeMessage(m: ProbeMessage, ctx: { botIds: ReadonlySet<string>; botTexts: readonly string[]; erpStaffTexts: ReadonlySet<string>; templates: ReadonlySet<string> }): ProbeClass {
  const t = ws(m.text);
  if (ctx.botIds.has(m.id) || (t && ctx.botTexts.some((b) => b === t || (b.length >= 20 && t.includes(b))))) return "BOT_ECHO";
  if (t && ctx.erpStaffTexts.has(t)) return "ERP_STAFF";
  if (!t || PANCAKE_AUTO_NOTE_RE.test(t)) return "AUTO_NOTE";
  if (SYSTEM_COMMENT_RE.test(foldVi(t))) return "META_COMMENT_SYSTEM";
  if (m.uid && !m.automated) return "STAFF_UID";
  if (m.automated) return "AUTO_FLAG";
  if (m.appId) return m.appId === META_INBOX_APP_ID ? "META_INBOX_APP" : "OTHER_APP";
  if (ctx.templates.has(probeTemplateKey(t))) return "TEMPLATE";
  return "NONE";
}

export type NoneContext = { inHumanChain: boolean; afterBot: boolean; sessionStart: boolean };

/**
 * Bối cảnh của một tin KHÔNG DẤU: có tin người đã xác minh trong ±10 phút cùng hội thoại (rủi ro AI chen vào); có câu bot trong 10 phút
 * TRƯỚC (luật cũ coi là người); nằm quanh tin MỞ PHIÊN của khách (tin chào). HÀM THUẦN.
 */
export function noneContext(m: { at: number }, thread: { verifiedAt: readonly number[]; botAt: readonly number[]; customerAt: readonly number[] }): NoneContext {
  const inHumanChain = thread.verifiedAt.some((a) => Math.abs(a - m.at) <= HUMAN_CHAIN_WINDOW_MS);
  const afterBot = thread.botAt.some((a) => a <= m.at && m.at - a <= HUMAN_CHAIN_WINDOW_MS);
  const cust = [...thread.customerAt].sort((a, b) => a - b);
  const starts = cust.filter((c, i) => i === 0 || c - cust[i - 1] >= SESSION_GAP_MS);
  const sessionStart = starts.some((s) => Math.abs(s - m.at) <= GREETING_WINDOW_MS);
  return { inHumanChain, afterBot, sessionStart };
}

/** Đường khoá (không giá trị) có chữ «app» trong một payload tin — biết Pancake có chuyển mã app Meta không. HÀM THUẦN. */
export function appishKeyPaths(v: unknown, prefix = "", depth = 0, out: Set<string> = new Set()): Set<string> {
  if (depth > 4 || !v || typeof v !== "object") return out;
  if (Array.isArray(v)) {
    if (v.length) appishKeyPaths(v[0], `${prefix}[]`, depth + 1, out);
    return out;
  }
  for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
    const key = /^\d{4,}$/.test(k) ? "<mã>" : k;
    const path = prefix ? `${prefix}.${key}` : key;
    if (/app/i.test(k)) out.add(path);
    appishKeyPaths(child, path, depth + 1, out);
  }
  return out;
}

/** Mã app đọc từ payload tin (các khoá ứng viên) — `null` = không có. HÀM THUẦN. */
export function appIdOf(m: Record<string, unknown>): string | null {
  const from = (m.from && typeof m.from === "object" ? m.from : {}) as Record<string, unknown>;
  for (const v of [m.app_id, m.application_id, from.app_id, (m.application && typeof m.application === "object" ? (m.application as Record<string, unknown>).id : undefined)]) {
    const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
    if (s) return s;
  }
  return null;
}

export const pct = (n: number, d: number): string => (d > 0 ? `${n}/${d} (${((100 * n) / d).toFixed(1)}%)` : `${n}/0 (—)`);

// ─────────────────────────── ĐỌC ───────────────────────────

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

function pancakeMs(v: unknown): number | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  const ms = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(ms) ? ms : null;
}

async function main() {
  const args = parseProbeArgs(process.argv.slice(2));
  if ("error" in args) {
    tomTat(`sender-provenance-probe: DỪNG · cách dùng sai — ${args.error} (arg: <mã tổ chức> [--days=1..${PROBE_MAX_DAYS}] [--threads=1..${PROBE_MAX_THREADS}])`);
    process.exit(1);
  }
  const org = await findOrganization(args.code);
  if (!org) {
    tomTat(`sender-provenance-probe: DỪNG · không có tổ chức «${args.code}»`);
    process.exit(1);
  }
  const db: Db = await getDbForInspection({ code: org.code, isHome: org.isHome });
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    tomTat("sender-provenance-probe: DỪNG · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì");
    process.exit(1);
  }
  const { tokens } = await pageTokensForOffboard(db, org.code, FANPAGE_CONNECTOR);
  const pages = [...tokens.entries()];
  if (!pages.length) {
    tomTat(`sender-provenance-probe ${org.code}: DỪNG · không có page Pancake nào có token — tin Meta trực tiếp không mang mã app trong CSDL (CHƯA ĐO ĐƯỢC)`);
    process.exit(0);
  }
  const [pageId, token] = pages[0];
  const secrets = [token, pageId];
  const now = Date.now();
  const since = new Date(now - args.days * 86_400_000);
  const t = schema.salesChatInbound;

  // 1. CSDL: hội thoại có tin phía page trong kỳ (mới nhất trước) + BOT_SENT / staff-out để nhận tiếng vọng / hộp thư ERP.
  const threadRows = await db
    .select({ threadId: t.threadId, last: sql<Date>`max(${t.createdAt})`, n: sql<number>`count(*)::int` })
    .from(t)
    .where(and(eq(t.pageId, pageId), eq(t.note, PAGE_REPLY), gte(t.createdAt, since), sql`${t.messageId} not like ${`${STAFF_OUT_PREFIX}%`}`))
    .groupBy(t.threadId)
    .orderBy(desc(sql`max(${t.createdAt})`))
    .limit(args.threads);
  const [dbCount] = await db
    .select({ all: sql<number>`count(*)::int`, erp: sql<number>`count(*) filter (where ${t.messageId} like ${`${STAFF_OUT_PREFIX}%`})::int`, threads: sql<number>`count(distinct ${t.threadId})::int` })
    .from(t)
    .where(and(eq(t.pageId, pageId), eq(t.note, PAGE_REPLY), gte(t.createdAt, since)));
  tomTat(`sender-provenance-probe ${org.code} · ${args.days} ngày · CSDL: ${dbCount?.all ?? 0} dòng PAGE_REPLY (${dbCount?.erp ?? 0} từ hộp thư ERP) ở ${dbCount?.threads ?? 0} hội thoại · đọc Pancake ${threadRows.length} hội thoại mới nhất`);

  // 2. Pancake: tin của từng hội thoại (CHỈ GET, nghỉ 600 ms, dừng khi 429).
  const q = `page_access_token=${encodeURIComponent(token)}`;
  const msgs: ProbeMessage[] = [];
  const customerAtBy = new Map<string, number[]>();
  const appish = new Map<string, number>();
  let read = 0;
  let failed = 0;
  let limited = false;
  for (const th of threadRows) {
    if (limited) break;
    if (read) await new Promise((r) => setTimeout(r, 600));
    try {
      const url = `${PANCAKE_PAGES_API}/v1/pages/${encodeURIComponent(pageId)}/conversations/${encodeURIComponent(th.threadId)}/messages?${q}`;
      const res = await fetch(url, { method: "GET", redirect: "manual", headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (res.status === 429) {
        limited = true;
        break;
      }
      const body = (await res.json().catch(() => null)) as { messages?: unknown } | null;
      if (!res.ok || !Array.isArray(body?.messages)) {
        failed += 1;
        continue;
      }
      read += 1;
      for (const raw of body.messages as Record<string, unknown>[]) {
        const at = pancakeMs(raw.inserted_at ?? raw.created_at);
        const id = str(raw.id);
        if (!id || at === null || raw.is_removed === true) continue;
        const from = (raw.from && typeof raw.from === "object" ? raw.from : {}) as Record<string, unknown>;
        const fromPage = str(from.id) === pageId || Boolean(from.uid) || Boolean(from.admin_id);
        if (!fromPage) {
          customerAtBy.set(th.threadId, [...(customerAtBy.get(th.threadId) ?? []), at]);
          continue;
        }
        if (at < since.getTime()) continue;
        for (const p of appishKeyPaths(raw)) appish.set(p, (appish.get(p) ?? 0) + 1);
        msgs.push({ id, thread: th.threadId, at, text: stripHtml(str(raw.original_message) || str(raw.message)).slice(0, 2000), uid: Boolean(from.uid || from.admin_id), automated: Boolean(from.ai_generated || from.is_automated || raw.is_automated || raw.ai_generated), appId: appIdOf(raw), fromPage });
      }
    } catch (e) {
      failed += 1;
      console.log(`hội thoại lỗi: ${scrubSecrets(e instanceof Error ? e.message : String(e), secrets).slice(0, 120)}`);
    }
  }
  tomTat(`Pancake: đọc được ${read} · hỏng ${failed}${limited ? " · DỪNG vì 429 (số đo bên dưới chỉ trên phần đã đọc)" : ""} · ${msgs.length} tin phía page trong kỳ`);

  // 3. Phân loại.
  const threadIds = [...new Set(msgs.map((m) => m.thread))];
  const dbRows = threadIds.length
    ? await db
        .select({ threadId: t.threadId, messageId: t.messageId, text: t.text, note: t.note, createdAt: t.createdAt })
        .from(t)
        .where(and(eq(t.pageId, pageId), gte(t.createdAt, new Date(since.getTime() - 86_400_000)), sql`${t.threadId} in (${sql.join(threadIds.map((x) => sql`${x}`), sql`, `)})`, sql`${t.note} in ('BOT_SENT', ${PAGE_REPLY})`))
    : [];
  const bot = new Map<string, { ids: Set<string>; texts: string[]; at: number[] }>();
  const erp = new Map<string, { texts: Set<string>; at: number[] }>();
  for (const r of dbRows) {
    if (r.note === "BOT_SENT") {
      const b = bot.get(r.threadId) ?? { ids: new Set<string>(), texts: [], at: [] };
      b.ids.add(r.messageId);
      if (ws(r.text)) b.texts.push(ws(r.text));
      b.at.push(r.createdAt.getTime());
      bot.set(r.threadId, b);
    } else if (r.messageId.startsWith(STAFF_OUT_PREFIX)) {
      const e = erp.get(r.threadId) ?? { texts: new Set<string>(), at: [] };
      e.texts.add(ws(r.text));
      e.at.push(r.createdAt.getTime());
      erp.set(r.threadId, e);
    }
  }
  // Tin mẫu: khoá chung trên MỌI tin page đã đọc + mọi dòng PAGE_REPLY của page trong kỳ (không chỉ các hội thoại đã đọc).
  const pageTexts = await db
    .select({ threadId: t.threadId, text: t.text })
    .from(t)
    .where(and(eq(t.pageId, pageId), eq(t.note, PAGE_REPLY), gte(t.createdAt, since), sql`length(${t.text}) >= ${PROBE_TEMPLATE_MIN_LENGTH}`))
    .limit(20_000);
  const templates = probeTemplateKeys([...msgs.map((m) => ({ thread: m.thread, text: m.text })), ...pageTexts.map((r) => ({ thread: r.threadId, text: r.text }))]);
  const counts = Object.fromEntries(PROBE_CLASSES.map((c) => [c, 0])) as Record<ProbeClass, number>;
  const apps = new Map<string, number>();
  const classified = msgs.map((m) => {
    const b = bot.get(m.thread);
    const c = classifyProbeMessage(m, { botIds: b?.ids ?? new Set(), botTexts: b?.texts ?? [], erpStaffTexts: erp.get(m.thread)?.texts ?? new Set(), templates });
    counts[c] += 1;
    if (c === "OTHER_APP" && m.appId) apps.set(maskAppId(m.appId), (apps.get(maskAppId(m.appId)) ?? 0) + 1);
    return { m, c };
  });
  const total = msgs.length;
  tomTat(`NHÓM (trên ${total} tin phía page): ${PROBE_CLASSES.map((c) => `${c} ${pct(counts[c], total)}`).join(" · ")}`.slice(0, 300));
  tomTat(`đã xác minh (được nhường sau bản vá) ${pct(counts.ERP_STAFF + counts.STAFF_UID + counts.META_INBOX_APP, total)} · KHÔNG DẤU (⇒ UNKNOWN, không nhường) ${pct(counts.NONE, total)}`);
  tomTat(`app khác (mã ẩn 4 số cuối): ${[...apps].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ${n}`).join(" · ") || "không có"}`);
  tomTat(`khoá mang chữ «app» trong payload tin page: ${[...appish].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ${n}`).join(" · ") || "KHÔNG CÓ (Pancake không chuyển mã app)"}`);

  // 4. Rủi ro trong nhóm KHÔNG DẤU.
  const verifiedBy = new Map<string, number[]>();
  for (const { m, c } of classified) if (VERIFIED_CLASSES.has(c)) verifiedBy.set(m.thread, [...(verifiedBy.get(m.thread) ?? []), m.at]);
  for (const [th, e] of erp) verifiedBy.set(th, [...(verifiedBy.get(th) ?? []), ...e.at]);
  let chain = 0;
  let afterBot = 0;
  let session = 0;
  let isolated = 0;
  const chainThreads = new Set<string>();
  for (const { m, c } of classified) {
    if (c !== "NONE") continue;
    const ctx = noneContext(m, { verifiedAt: verifiedBy.get(m.thread) ?? [], botAt: bot.get(m.thread)?.at ?? [], customerAt: customerAtBy.get(m.thread) ?? [] });
    if (ctx.inHumanChain) {
      chain += 1;
      chainThreads.add(m.thread);
    }
    if (ctx.afterBot) afterBot += 1;
    if (ctx.sessionStart) session += 1;
    if (!ctx.inHumanChain && !ctx.afterBot && !ctx.sessionStart) isolated += 1;
  }
  tomTat(`KHÔNG DẤU ${counts.NONE}: giữa chuỗi người đã xác minh ±10′ (RỦI RO AI chen) ${pct(chain, counts.NONE)} ở ${chainThreads.size} hội thoại · ≤10′ sau câu bot (luật cũ coi là người) ${pct(afterBot, counts.NONE)} · đầu phiên (tin chào) ${pct(session, counts.NONE)} · lẻ loi ${pct(isolated, counts.NONE)}`);
  process.exit(0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("sender-provenance-probe lỗi:", e instanceof Error ? e.name : "lỗi");
    tomTat("sender-provenance-probe: LỖI ngoài phép đo — chi tiết trong phần mã hoá");
    process.exit(1);
  });
}

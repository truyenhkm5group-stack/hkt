/**
 * ═══════════ CỔNG CHẠY THEO PAGE CỦA WORKSPACE NHÀ — LÕI MÁY CHỦ (luật ở page-runtime-shared.ts) ═══════════
 *
 * Mọi đường runtime Chốt Đơn có thể nói với khách thật đều hỏi ở đây TRƯỚC lời gọi tốn tiền / lời gọi gửi:
 *  · xử lý tin khách — fanpage qua Pancake, Messenger trực tiếp, Zalo OA (`inboundPageGate`, ngay sau lượt giành tin). Lượt
 *    quét bù (`sweepStale*`), quét lại tin rơi (`catchUpFanpage`), thử lại tin AI hỏng (`retryAiDownMessages`) đều đi qua
 *    ĐÚNG ba hàm xử lý đó nên cùng một cổng;
 *  · follow-up nhắc khách im lặng (`runSalesFollowups`, trước lời gọi AI);
 *  · ghi đơn từ hội thoại + tin xác nhận đặt lại (`runFanpageOrderSync`: nguồn của page không LIVE bị bỏ);
 *  · CHỐT CUỐI ở hai hàm gửi tin bot (`sendFanpageText` / `sendMessengerPageText` khi không mang dấu nhân viên) — đường nào
 *    quên hỏi cổng thì vẫn không gửi được;
 *  · việc không gắn page (tin sáng khách đến hạn mua lại · báo nhóm đơn mới · bot tự học) ⇒ `homeRuntimeIdleReason`.
 * Tin NHÂN VIÊN gửi từ hộp thư ERP không đi qua cổng: đó là người bấm gửi, không phải bot.
 * «Cứu hội thoại bỏ sót» (recovery.ts) chỉ ĐỌC — không có đường gửi để chặn.
 */
import { and, gt, isNotNull, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { listChannelPages, messagingConnectionSummaries } from "@/lib/connectors/service";
import { canUseModule } from "@/lib/platform/capabilities";
import { currentOrganization } from "@/lib/platform/context";
import { loadSalesChatbotConfig, readJsonSetting } from "@/lib/sales-chatbot/engine";
import { draftCopilotSuggestion } from "@/lib/sales-chatbot/operating-mode";
import {
  PAGE_OFF_NOTE,
  PAGE_RUNTIME_LABEL,
  PAGE_RUNTIME_SETTING_KEY,
  PAGE_SHADOW_BOT_OFF_NOTE,
  PAGE_SHADOW_NOTE,
  isPageRuntimeMode,
  pageRuntimeModeOf,
  parsePageRuntime,
  runtimeServesCustomers,
  validPageId,
  type PageRuntimeMap,
  type PageRuntimeMode,
} from "@/lib/sales-chatbot/page-runtime-shared";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";
import { setSettingJson } from "@/lib/settings";

/** Khoá kết nối — chép ở đây (không import fanpage.ts / zalo.ts) để hai tệp đó import được tệp này mà không vòng. */
const PANCAKE_FANPAGE_KEY = "pancake-fanpage";
const MESSENGER_KEY = "facebook-messenger";
const ZALO_KEY = "zalo-oa";

export async function loadPageRuntime(): Promise<{ isHome: boolean; map: PageRuntimeMap }> {
  const org = await currentOrganization();
  if (!org.isHome) return { isHome: false, map: {} };
  return { isHome: true, map: parsePageRuntime(await readJsonSetting(PAGE_RUNTIME_SETTING_KEY)) };
}

/** Chế độ của `pageId` trong tổ chức NGỮ CẢNH. Lỗi đọc ⇒ OFF (hẹp) — khách cũng vậy: không biết tổ chức nào thì không gửi. */
export async function pageRuntimeMode(pageId: string | null | undefined): Promise<PageRuntimeMode> {
  try {
    const { isHome, map } = await loadPageRuntime();
    return pageRuntimeModeOf({ isHome }, map, pageId);
  } catch {
    return "OFF";
  }
}

/** Nhà mà chưa page nào LIVE ⇒ lý do để BỎ một việc không gắn page; còn lại ⇒ `null` (cứ làm). Lỗi đọc ⇒ có lý do (hẹp). */
export async function homeRuntimeIdleReason(): Promise<string | null> {
  try {
    const { isHome, map } = await loadPageRuntime();
    return runtimeServesCustomers({ isHome }, map) ? null : "workspace nhà chưa có page nào LIVE cho bot Chốt Đơn";
  } catch {
    return "không đọc được cổng page của tổ chức";
  }
}

export type GateRow = { createdAt: Date; text: string };

/**
 * Cổng của MỘT lượt tin khách đã giành. `null` ⇒ page LIVE, nơi gọi đi tiếp như trước. Có chữ ⇒ nơi gọi đánh dấu các tin
 * của lượt là SKIPPED với đúng chữ đó và DỪNG lượt (không AI thật, không gửi).
 *
 * SHADOW: soạn câu ở hội thoại BÓNG (`draftCopilotSuggestion` — kênh thử, công cụ chỉ mô phỏng: «đơn sẽ tạo» chỉ là một dòng
 * trong `tools` của gợi ý) và lưu vào `sales_copilot_suggestions` với mốc = tin khách SỚM NHẤT của lượt, để câu thật của page
 * (bot cũ / nhân viên) tới sau tin khách được đem so — kể cả khi nó đã tới trước lúc bot mới soạn xong. Đặt TRƯỚC mọi bước
 * «page đã trả lời ⇒ bỏ qua» của nơi gọi: ở nhà bot cũ trả lời gần như mọi tin, bỏ qua theo luật đó thì bóng không bao giờ
 * soạn được câu nào. Mọi lỗi của nhánh bóng vẫn trả chữ (không bao giờ rơi xuống đường gửi).
 */
export async function inboundPageGate(input: {
  pageId: string;
  threadId: string;
  rows: readonly GateRow[];
  conversation: () => Promise<{ id: string } | null>;
  mirror?: (conversationId: string, beforeAt: Date) => Promise<void>;
}): Promise<string | null> {
  const mode = await pageRuntimeMode(input.pageId);
  if (mode === "LIVE") return null;
  if (mode === "OFF") return PAGE_OFF_NOTE;
  try {
    // Công tắc bot vẫn là công tắc tổng: bot tắt thì bóng cũng không tốn tiền AI.
    if (!(await loadSalesChatbotConfig()).enabled) return PAGE_SHADOW_BOT_OFF_NOTE;
    const conv = await input.conversation();
    if (!conv) return PAGE_SHADOW_NOTE;
    const sorted = [...input.rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const oldest = sorted[0]?.createdAt ?? new Date();
    if (input.mirror) await input.mirror(conv.id, oldest);
    const text = sorted
      .map((r) => r.text)
      .filter((s) => s.trim())
      .join("\n")
      .slice(0, 2_000);
    if (text) await draftCopilotSuggestion({ conversationId: conv.id, pageId: input.pageId, threadId: input.threadId, text, now: oldest });
  } catch {
    // Bóng hỏng không được biến thành «gửi thật».
  }
  return PAGE_SHADOW_NOTE;
}

// ─────────────────────────── Màn hình + lưu ───────────────────────────

export type PageRuntimeRow = { id: string; name: string; mode: PageRuntimeMode; updatedAt: string | null; updatedByEmail: string | null; shadowDrafts7d: number; lastShadowAt: string | null };
export type PageRuntimeView = { isHome: boolean; pages: PageRuntimeRow[] };

/** Page ứng viên của tổ chức ngữ cảnh: page đã nối (Pancake · Messenger · Zalo) + page đã có hội thoại + page đã có trong danh sách. */
async function candidatePages(map: PageRuntimeMap): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const conns = await messagingConnectionSummaries([PANCAKE_FANPAGE_KEY, ZALO_KEY]);
  for (const r of conns) {
    if (r.connectorKey === PANCAKE_FANPAGE_KEY && r.plainSettings.pageId?.trim()) out.set(r.plainSettings.pageId.trim(), `Fanpage ${r.plainSettings.pageId.trim()} (qua Pancake)`);
    if (r.connectorKey === ZALO_KEY && r.plainSettings.oaId?.trim()) out.set(`zalo:${r.plainSettings.oaId.trim()}`, "Zalo OA");
  }
  for (const p of await listChannelPages(MESSENGER_KEY)) out.set(p.pageId, p.name || p.pageId);
  const db = await getDb();
  const c = schema.salesChatConversations;
  const used = await db.selectDistinct({ pageId: c.pageId }).from(c).where(and(ne(c.channel, "TEST"), isNotNull(c.pageId)));
  for (const r of used) if (r.pageId && !r.pageId.startsWith("comment:") && !out.has(r.pageId)) out.set(r.pageId, r.pageId.startsWith("zalo:") ? "Zalo OA" : `Fanpage ${r.pageId}`);
  for (const id of Object.keys(map)) if (!out.has(id)) out.set(id, `Page ${id}`);
  return out;
}

export async function pageRuntimeView(now: Date = new Date()): Promise<PageRuntimeView> {
  const { isHome, map } = await loadPageRuntime();
  if (!isHome) return { isHome, pages: [] };
  const pages = await candidatePages(map);
  const db = await getDb();
  const s = schema.salesCopilotSuggestions;
  const counts = await db
    .select({ pageId: s.pageId, n: sql<number>`count(*)::int`, last: sql<Date | string | null>`max(${s.createdAt})` })
    .from(s)
    .where(gt(s.createdAt, new Date(now.getTime() - 7 * 86_400_000)))
    .groupBy(s.pageId);
  const byPage = new Map(counts.map((r) => [r.pageId, r]));
  return {
    isHome,
    pages: [...pages]
      .map(([id, name]) => {
        const e = map[id];
        const k = byPage.get(id);
        return { id, name, mode: pageRuntimeModeOf({ isHome }, map, id), updatedAt: e?.updatedAt ?? null, updatedByEmail: e?.updatedByEmail ?? null, shadowDrafts7d: Number(k?.n ?? 0), lastShadowAt: k?.last ? new Date(k.last).toISOString() : null };
      })
      .sort((a, b) => a.name.localeCompare(b.name, "vi")),
  };
}

/**
 * Đặt chế độ của MỘT page. Chỉ workspace NHÀ (khách luôn LIVE — công tắc này không có nghĩa ở khách), chỉ người cấu hình bot,
 * chỉ page ứng viên của tổ chức. LIVE đòi người bấm XÁC NHẬN đã xử lý bot cũ `chatbot/` trên page đó — mã không tự tắt bot
 * cũ, và hai bot cùng trả lời là khách nhận hai câu. Nhật ký mỗi lượt.
 */
export async function savePageRuntime(user: SessionUser, pageId: unknown, mode: unknown, opts: { acknowledgeLegacyBot?: unknown } = {}, now: Date = new Date()): Promise<{ ok: true; message: string } | { error: string }> {
  if (!(await canUseModule("ai_sales"))) return { error: "Module AI bán hàng chưa bật." };
  if (!can(user, SALES_CHATBOT_MANAGE)) return { error: "Bạn không có quyền cấu hình chatbot bán hàng (ai_sales:manage)." };
  const { isHome, map } = await loadPageRuntime();
  if (!isHome) return { error: "Tổ chức khách: bot trả lời mọi page đã nối — công tắc theo page chỉ dùng cho workspace nhà." };
  if (!validPageId(pageId)) return { error: "Mã page không hợp lệ." };
  if (!isPageRuntimeMode(mode)) return { error: "Chế độ không hợp lệ." };
  if (!(await candidatePages(map)).has(pageId)) return { error: "Không có page này trong tổ chức." };
  if (mode === "LIVE" && opts.acknowledgeLegacyBot !== true) return { error: "Chuyển LIVE cần xác nhận bot cũ (chatbot/) đã thôi trả lời page này — nếu không khách nhận hai câu trả lời." };
  const before = map[pageId] ?? null;
  if ((before?.mode ?? "OFF") === mode) return { ok: true, message: `Page đang ở chế độ «${PAGE_RUNTIME_LABEL[mode]}».` };
  const next: PageRuntimeMap = { ...map };
  if (mode === "OFF") delete next[pageId];
  else next[pageId] = { mode, updatedAt: now.toISOString(), updatedByEmail: user.email };
  await setSettingJson(PAGE_RUNTIME_SETTING_KEY, next);
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "SALES_CHATBOT_PAGE_RUNTIME",
    entity: "SETTING",
    entityId: `${PAGE_RUNTIME_SETTING_KEY}:${pageId}`,
    before,
    after: next[pageId] ?? { mode: "OFF" },
    reason: mode === "LIVE" ? "Chuyển page sang LIVE cho bot Chốt Đơn (đã xác nhận bot cũ thôi trả lời page)" : mode === "SHADOW" ? "Chạy bóng page cho bot Chốt Đơn" : "Tắt page cho bot Chốt Đơn",
  });
  return { ok: true, message: mode === "LIVE" ? "Page đã LIVE — bot Chốt Đơn trả lời khách từ tin kế tiếp." : mode === "SHADOW" ? "Page chạy bóng — bot soạn câu để so, không gửi tin nào." : "Page đã tắt cho bot Chốt Đơn." };
}

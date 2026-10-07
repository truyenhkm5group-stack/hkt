/**
 * ═══════════ CỔNG CHẠY THEO PAGE CỦA WORKSPACE NHÀ — HÀM THUẦN, DÙNG ĐƯỢC Ở CLIENT (docs/saas/OWNERSHIP.md §4) ═══════════
 *
 * Bot bán hàng của VNX hôm nay là container `chatbot/` (runtime cũ) — nó vẫn đang trả lời khách thật của nhà. Runtime Chốt Đơn
 * (`lib/sales-chatbot`) chỉ được chạm vào khách của nhà TỪNG PAGE, theo một danh sách TƯỜNG MINH do người có quyền đặt:
 *
 *  · OFF    — mặc định của MỌI page của nhà (kể cả page chưa từng có trong danh sách): runtime mới không gọi AI, không gửi gì,
 *             không nhắc khách, không ghi đơn — chỉ đánh dấu tin «bỏ qua» kèm lý do. Danh sách RỖNG ⇒ nhà im hoàn toàn, kể cả
 *             khi module `ai_sales` và công tắc bot (`cfg.enabled`) đều bật.
 *  · SHADOW — bot soạn câu trả lời cho từng lượt tin khách ở hội thoại BÓNG (kênh thử: công cụ chỉ mô phỏng, không khách,
 *             không đơn, không giữ hàng) và GHI vào sổ gợi ý (`sales_copilot_suggestions`) để đem so với câu thật của page —
 *             câu bot cũ / nhân viên tới sau tin khách. KHÔNG một tin nào rời máy.
 *  · LIVE   — như tổ chức khách: bot trả lời. Chuyển page sang LIVE là QUYẾT ĐỊNH CỦA CHỦ SHOP; mã không bật page nào.
 *
 * Tổ chức KHÁCH không có cổng này: mọi page luôn LIVE (hành vi như trước), danh sách nếu có cũng bị bỏ qua.
 * Mọi nhánh lỗi rơi về phía HẸP (nhà ⇒ OFF).
 */

export const PAGE_RUNTIME_SETTING_KEY = "ai.salesChatbot.pageRuntime";

export const PAGE_RUNTIME_MODES = ["OFF", "SHADOW", "LIVE"] as const;
export type PageRuntimeMode = (typeof PAGE_RUNTIME_MODES)[number];

export const PAGE_RUNTIME_LABEL: Record<PageRuntimeMode, string> = {
  OFF: "Tắt — bot mới không đụng tới page",
  SHADOW: "Bóng — bot soạn câu, lưu để so, KHÔNG gửi",
  LIVE: "Chạy thật — bot mới trả lời khách",
};

export type PageRuntimeEntry = { mode: PageRuntimeMode; updatedAt: string | null; updatedByEmail: string | null };
export type PageRuntimeMap = Record<string, PageRuntimeEntry>;

/** Ghi chú trên tin khách bị bỏ qua (cột `sales_chat_inbound.note`) — người đọc hộp thư biết vì sao bot im. */
export const PAGE_OFF_NOTE = "Workspace nhà: page chưa bật cho bot Chốt Đơn — bot im";
export const PAGE_SHADOW_NOTE = "Workspace nhà: page chạy BÓNG — bot đã soạn câu để so, KHÔNG gửi";
export const PAGE_SHADOW_BOT_OFF_NOTE = "Workspace nhà: page chạy BÓNG nhưng bot đang tắt — không soạn";
/** Lỗi của đường gửi chặn ở chốt cuối (`sendFanpageText` / `sendMessengerPageText` không mang dấu nhân viên). */
export const PAGE_NOT_LIVE_SEND_ERROR = "Workspace nhà: page chưa LIVE cho bot Chốt Đơn — không gửi";

const PAGE_ID_RE = /^[A-Za-z0-9_:.-]{1,80}$/;

export function isPageRuntimeMode(v: unknown): v is PageRuntimeMode {
  return typeof v === "string" && (PAGE_RUNTIME_MODES as readonly string[]).includes(v);
}

/** Đọc danh sách đã lưu — mã page lạ / chế độ lạ bị BỎ (page đó về OFF), không đoán. HÀM THUẦN. */
export function parsePageRuntime(raw: unknown): PageRuntimeMap {
  const out: PageRuntimeMap = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [pageId, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!PAGE_ID_RE.test(pageId) || !v || typeof v !== "object") continue;
    const e = v as Record<string, unknown>;
    if (!isPageRuntimeMode(e.mode)) continue;
    out[pageId] = { mode: e.mode, updatedAt: typeof e.updatedAt === "string" ? e.updatedAt : null, updatedByEmail: typeof e.updatedByEmail === "string" ? e.updatedByEmail : null };
  }
  return out;
}

export function validPageId(pageId: unknown): pageId is string {
  return typeof pageId === "string" && PAGE_ID_RE.test(pageId);
}

/**
 * Chế độ của MỘT page. Khách ⇒ LIVE (không đổi gì). Nhà ⇒ chế độ đã khai, không khai ⇒ OFF; mã page rỗng ⇒ OFF. HÀM THUẦN.
 */
export function pageRuntimeModeOf(org: { isHome: boolean }, map: PageRuntimeMap, pageId: string | null | undefined): PageRuntimeMode {
  if (!org.isHome) return "LIVE";
  const id = (pageId ?? "").trim();
  if (!id) return "OFF";
  return map[id]?.mode ?? "OFF";
}

/**
 * Runtime mới có đang phục vụ khách thật của tổ chức không — câu hỏi cho những việc KHÔNG gắn với một page (tin sáng khách
 * đến hạn mua lại, báo nhóm đơn mới, bot tự học): khách ⇒ luôn có; nhà ⇒ chỉ khi ít nhất một page LIVE (SHADOW không tính —
 * bóng không được sinh ra hành động thật nào). HÀM THUẦN.
 */
export function runtimeServesCustomers(org: { isHome: boolean }, map: PageRuntimeMap): boolean {
  if (!org.isHome) return true;
  return Object.values(map).some((e) => e.mode === "LIVE");
}

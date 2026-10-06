/**
 * ═══════════ AI ĐÃ SẴN SÀNG TỰ TRẢ LỜI KHÁCH CHƯA? (docs/product-audit.md P8) — HÀM THUẦN ═══════════
 *
 * Ba kết luận: CHƯA SẴN SÀNG (có mục hỏng — bot sẽ trả lời sai hoặc không trả lời được) · SẴN SÀNG, CÒN LƯU Ý · SẴN SÀNG.
 * Chỉ dùng mục ĐO ĐƯỢC từ dữ liệu thật của tổ chức; không có ngưỡng «đạt» do máy đặt (AGENTS §38) — mỗi mục là có / không.
 * Bảng này là THÔNG TIN, không chặn chủ shop đổi chế độ: chặn là đổi hành vi với tổ chức đang chạy Tự động.
 */

export type ReadinessStatus = "PASS" | "WARN" | "FAIL";
export type ReadinessVerdict = "NOT_READY" | "READY_WITH_WARNINGS" | "READY";

export const READINESS_VERDICT_LABEL: Record<ReadinessVerdict, string> = {
  NOT_READY: "Chưa sẵn sàng",
  READY_WITH_WARNINGS: "Sẵn sàng — còn lưu ý",
  READY: "Sẵn sàng",
};

export type ReadinessCheck = { key: string; label: string; status: ReadinessStatus; detail: string; href: string | null };

export type ReadinessInput = {
  botEnabled: boolean;
  aiReady: boolean;
  aiReason: string | null;
  pricedVariants: number;
  sellWithoutStockCheck: boolean;
  stockReceipts: number;
  notifyGroupOnHandoff: boolean;
  realConversations30d: number;
  testDrafts30d: number;
  replayRuns30d: number;
  confirmedPriceErrors7d: number;
};

export function assessReadiness(i: ReadinessInput): { verdict: ReadinessVerdict; checks: ReadinessCheck[] } {
  const c: ReadinessCheck[] = [
    i.botEnabled
      ? { key: "BOT_ENABLED", label: "Bot đang bật", status: "PASS", detail: "Bot trả lời khách trên các kênh đã nối.", href: null }
      : { key: "BOT_ENABLED", label: "Bot đang tắt", status: "FAIL", detail: "Bật bot ở phần Cấu hình bên dưới.", href: null },
    i.aiReady
      ? { key: "AI_READY", label: "Khoá AI dùng được", status: "PASS", detail: "Lượt kiểm tra gần nhất của khoá AI đang chọn đạt.", href: null }
      : { key: "AI_READY", label: "Khoá AI chưa dùng được", status: "FAIL", detail: i.aiReason ?? "Kiểm tra lại kết nối AI ở Cài đặt → Kết nối.", href: "/integrations" },
    i.pricedVariants > 0
      ? { key: "PRICES", label: `${i.pricedVariants.toLocaleString("vi-VN")} mẫu mã có giá`, status: "PASS", detail: "Bot chỉ báo giá đọc từ đây — không bao giờ tự nghĩ ra giá.", href: "/products" }
      : { key: "PRICES", label: "Chưa có mẫu mã nào có giá", status: "FAIL", detail: "Bot không có giá nào để báo — thêm sản phẩm và giá bán trước.", href: "/products" },
    i.sellWithoutStockCheck
      ? { key: "STOCK", label: "Bán không kiểm tồn (shop chọn)", status: "WARN", detail: "Bot sẽ nhận đơn kể cả khi kho chưa đủ hàng.", href: null }
      : i.stockReceipts > 0
        ? { key: "STOCK", label: "Có số tồn kho", status: "PASS", detail: "Bot kiểm tồn trước khi chốt.", href: "/inventory" }
        : { key: "STOCK", label: "Chưa có phiếu nhập kho", status: "WARN", detail: "Tồn là CHƯA BIẾT — bot sẽ không khẳng định còn hàng.", href: "/inventory" },
    i.notifyGroupOnHandoff
      ? { key: "HANDOFF", label: "Chuyển người có báo nhóm", status: "PASS", detail: "Khi bot chuyển khách cho người, nhóm Lark / Telegram được báo.", href: null }
      : { key: "HANDOFF", label: "Chuyển người không báo nhóm", status: "WARN", detail: "Khách bot chuyển sang người chỉ hiện trong ERP — dễ bị bỏ quên. Bật «báo nhóm» ở Cấu hình.", href: null },
    i.realConversations30d > 0
      ? { key: "CHANNEL", label: `${i.realConversations30d.toLocaleString("vi-VN")} hội thoại thật trong 30 ngày`, status: "PASS", detail: "Kênh đang nhận tin khách.", href: "/ai/sales-chatbot/performance" }
      : { key: "CHANNEL", label: "Chưa có tin khách thật nào trong 30 ngày", status: "WARN", detail: "Kiểm tra kênh đã nối (fanpage / Messenger / Zalo / chat web) và webhook.", href: null },
    i.testDrafts30d > 0
      ? { key: "TEST_ORDER", label: "Đã thử lên đơn trong khung thử", status: "PASS", detail: "Ít nhất một lượt thử đi tới đơn nháp trong 30 ngày.", href: null }
      : { key: "TEST_ORDER", label: "Chưa thử lên đơn trong khung thử", status: "WARN", detail: "Chat thử một lượt mua trọn vòng ở khung thử bên phải trước khi để bot tự chốt.", href: null },
    i.replayRuns30d > 0
      ? { key: "REPLAY", label: "Đã phát lại hội thoại cũ", status: "PASS", detail: "Đã đọc AI hôm nay sẽ nói gì với khách cũ.", href: "/ai/sales-chatbot/replay" }
      : { key: "REPLAY", label: "Chưa phát lại hội thoại cũ", status: "WARN", detail: "Phát lại vài hội thoại cũ để đọc bot sẽ trả lời ra sao trước khi bật Tự động.", href: "/ai/sales-chatbot/replay" },
    i.confirmedPriceErrors7d === 0
      ? { key: "PRICE_ERRORS", label: "Không có lỗi giá đã xác nhận (7 ngày)", status: "PASS", detail: "Theo hàng đợi Rà lỗi AI.", href: "/ai/sales-chatbot/quality" }
      : { key: "PRICE_ERRORS", label: `${i.confirmedPriceErrors7d} lỗi giá đã xác nhận (7 ngày)`, status: "WARN", detail: "Người rà đã xác nhận bot nói giá không có căn cứ — sửa sổ tay / câu mẫu trước khi để bot tự chốt.", href: "/ai/sales-chatbot/quality" },
  ];
  const verdict: ReadinessVerdict = c.some((x) => x.status === "FAIL") ? "NOT_READY" : c.some((x) => x.status === "WARN") ? "READY_WITH_WARNINGS" : "READY";
  return { verdict, checks: c };
}

/**
 * ═══════════ ĐỒNG HỒ ĐO DÙNG (USAGE METER) — THUẦN, CLIENT-SAFE (docs/platform/pricing-billing-foundation.md §2) ═══════════
 *
 * KHÔNG có bảng đếm thứ hai. Mỗi đồng hồ khai ĐẾM TỪ ĐÂU — một trong hai nguồn đã có:
 *  · `platform_ai_usage` (0176, mở rộng 0222) — mỗi lượt AI một dòng: lời gọi, token, model, nguồn trả tiền, khoá sự kiện.
 *  · chứng từ có mốc thời gian trong CSDL của chính tổ chức, bằng ĐÚNG câu đếm của sổ dùng theo ngày (0204,
 *    `lib/platform/saas-ledger.ts::readOrgUsage`) — hội thoại, tin khách, tin AI, đơn do AI chốt; cộng fanpage đang hoạt động.
 *    Đọc TƯƠI cho cả kỳ (hội thoại AI đếm PHÂN BIỆT cả tháng — cộng số theo ngày sẽ đếm hai lần hội thoại kéo dài hai ngày).
 * Đồng hồ chưa có nguồn khai `availability` + `missingWhat` cụ thể tới mức sửa được — màn hình in "—", không in 0 (luật 42).
 *
 * KỲ ĐO = THÁNG LỊCH GIỜ VIỆT NAM — trùng kỳ của credit AI và trần tiền AI đã có (`lib/ai-usage/types.ts::monthStartVN`), để
 * "dùng tháng này" chỉ có một nghĩa. Nó KHÁC kỳ trả tiền (`paid_through`): ngày gia hạn in riêng.
 */

export const METER_KEYS = [
  "conversation_count",
  "ai_conversations",
  "incoming_messages",
  "outgoing_ai_messages",
  "ai_calls",
  "input_tokens",
  "output_tokens",
  "image_calls",
  "orders_created_by_ai",
  "fanpages_active",
] as const;
export type MeterKey = (typeof METER_KEYS)[number];

export type MeterAvailability = "MEASURED" | "PARTIAL";

export type MeterSpec = { label: string; unit: string; source: string; availability: MeterAvailability; missingWhat: string | null };

export const METER_SPEC: Record<MeterKey, MeterSpec> = {
  conversation_count: { label: "Hội thoại mới", unit: "hội thoại", source: "sales_chat_conversations · không kênh THỬ, không lượt nhập lịch sử (CSDL tổ chức, cùng câu đếm với sổ dùng theo ngày 0204)", availability: "MEASURED", missingWhat: null },
  ai_conversations: {
    label: "Hội thoại AI",
    unit: "hội thoại",
    source: "sales_chat_messages · hội thoại có ít nhất một tin AI trong kỳ (đếm phân biệt cả kỳ, đọc CSDL tổ chức)",
    availability: "MEASURED",
    missingWhat: null,
  },
  incoming_messages: { label: "Tin khách gửi", unit: "tin", source: "sales_chat_messages · khối chữ của khách (CSDL tổ chức, cùng câu đếm với 0204)", availability: "MEASURED", missingWhat: null },
  outgoing_ai_messages: { label: "Tin AI gửi", unit: "tin", source: "sales_chat_messages · tin AI, không tính tin shop chép vào lịch sử (CSDL tổ chức, cùng câu đếm với 0204)", availability: "MEASURED", missingWhat: null },
  ai_calls: { label: "Lời gọi model", unit: "lời gọi", source: "platform_ai_usage.requests (không tính lượt bị chặn)", availability: "MEASURED", missingWhat: null },
  input_tokens: { label: "Token vào", unit: "token", source: "platform_ai_usage.input_tokens", availability: "MEASURED", missingWhat: null },
  output_tokens: { label: "Token ra", unit: "token", source: "platform_ai_usage.output_tokens", availability: "MEASURED", missingWhat: null },
  image_calls: {
    label: "Lượt đọc / vẽ ảnh",
    unit: "lượt",
    source: "platform_ai_usage · modality VISION/IMAGE hoặc tính năng creative_image",
    availability: "PARTIAL",
    missingWhat: "Lượt AI bán hàng ĐỌC ảnh khách gửi chỉ đếm được khi đường gọi AI truyền modality = 'VISION' vào recordAiUsage (việc của sứ mệnh ai-sales-reliability); hôm nay chỉ lượt vẽ ảnh quảng cáo được đếm.",
  },
  orders_created_by_ai: { label: "Đơn AI tạo", unit: "đơn", source: "orders nối sales_chat_conversations.order_id (CSDL tổ chức, cùng câu đếm với 0204)", availability: "MEASURED", missingWhat: null },
  fanpages_active: {
    label: "Fanpage đang hoạt động",
    unit: "fanpage",
    source: "org_channel_pages · ACTIVE · PAGE (CSDL tổ chức, lúc đọc; sổ theo ngày giữ lịch sử ở platform_tenant_usage_daily.fanpages_active)",
    availability: "PARTIAL",
    missingWhat: "Tổ chức nối fanpage trước 0220 bằng một hàng kết nối đơn (chưa có dòng org_channel_pages) ⇒ chưa đếm được, hiện «—».",
  },
};

/** Kỳ đo của một thời điểm: [đầu tháng VN, đầu tháng sau VN). `day` dạng `YYYY-MM-DD` để lọc sổ theo ngày. */
export type UsagePeriod = { from: Date; to: Date; fromDay: string; toDay: string; label: string; resetsOn: string };

export function usagePeriodOf(now: Date): UsagePeriod {
  const vn = new Date(now.getTime() + 7 * 3_600_000);
  const y = vn.getUTCFullYear();
  const m = vn.getUTCMonth();
  const from = new Date(Date.UTC(y, m, 1) - 7 * 3_600_000);
  const to = new Date(Date.UTC(y, m + 1, 1) - 7 * 3_600_000);
  const day = (d: Date) => new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  const lastDay = day(new Date(to.getTime() - 1));
  return { from, to, fromDay: day(from), toDay: lastDay, label: `${String(m + 1).padStart(2, "0")}/${y}`, resetsOn: day(to) };
}

/** Số ngày đã qua của kỳ (tính cả hôm nay) và tổng số ngày của kỳ — cho phép chiếu cuối kỳ. */
export function periodProgress(period: UsagePeriod, now: Date): { elapsedDays: number; totalDays: number } {
  const totalDays = Math.round((period.to.getTime() - period.from.getTime()) / 86_400_000);
  const elapsed = Math.min(totalDays, Math.max(1, Math.ceil((now.getTime() - period.from.getTime()) / 86_400_000)));
  return { elapsedDays: elapsed, totalDays };
}

/**
 * Khoá sự kiện cho MỘT lượt AI — lượt thử lại của CÙNG lời gọi phải ra CÙNG khoá, lượt gọi mới ra khoá mới. Nơi gọi tự chọn
 * thành phần ổn định (vd id tin khách đang được trả lời + số thứ tự bước); hàm này chỉ ghép và giới hạn độ dài.
 */
export function usageEventKey(parts: readonly (string | number | null | undefined)[]): string | null {
  const clean = parts.filter((p) => p !== null && p !== undefined && String(p).length > 0).map((p) => String(p).replace(/[^\w:.\-]/g, "_"));
  if (!clean.length) return null;
  return clean.join(":").slice(0, 200);
}

/** Số đếm của kỳ cho một tổ chức (đã đọc ở máy chủ). `null` = CHƯA BIẾT — không phải 0. */
export type MeterReadings = Record<MeterKey, number | null>;

export const EMPTY_READINGS: MeterReadings = Object.fromEntries(METER_KEYS.map((k) => [k, null])) as MeterReadings;

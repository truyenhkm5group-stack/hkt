/**
 * NẠP TIN SỐNG — ĐỌC LIÊN TỤC, KHÔNG BAO GIỜ GỬI.
 *
 * ─── VÌ SAO ĐỌC ĐƯỢC TỰ ĐỘNG CÒN GỬI THÌ KHÔNG ───
 *
 * Trước đây bộ lập lịch bị tắt hẳn trên bản chạy thử, vì "job nền" và "tin nhắn tự đi ra" bị coi là
 * một. Chúng không phải một. Bốn việc, bốn mức rủi ro:
 *
 *   ĐỌC tin về            — không ai thấy gì, không đổi gì ở phía khách. Chạy nền được.
 *   SOẠN câu gợi ý        — tốn token, nhưng vẫn nằm trong nhà. Chạy nền được ở nấc TRỢ LÝ.
 *   GỬI cho khách         — người ngoài đọc được. CHỈ khi có người bấm.
 *   TẠO ĐƠN              — tiền và hàng đi theo. TẮT ở giai đoạn này.
 *
 * Gộp bốn việc vào một công tắc thì để bật cái thứ nhất phải bật cả cái thứ ba. Tách ra thì bộ nạp
 * chạy suốt ngày mà vẫn không có đường nào tới được khách: nó không import cổng gửi, và cổng gửi
 * đòi một khoá tài khoản mà job nền không có.
 *
 * ─── VÌ SAO HỎI LIÊN TỤC CHỨ KHÔNG ĐỢI WEBHOOK ───
 *
 * Webhook chat của Pancake chưa được kiểm chứng trên bản chạy thử — 27 giờ không một tin nào về
 * trong khi page vẫn chạy quảng cáo. Một đường vào chưa chứng minh được thì không dựng cả đợt thí
 * điểm lên nó. Hỏi liên tục thì chậm hơn vài chục giây nhưng ĐO ĐƯỢC: mỗi vòng để lại một mốc thời
 * gian, nên "hệ thống có đang sống không" trả lời được bằng một con số chứ không bằng niềm tin.
 */

/** Bật / tắt bộ nạp sống. Vắng mặt = TẮT, như mọi công tắc khác trong ERP. */
export const LIVE_INGEST_ENV = "AI_LIVE_INGEST_ENABLED";

/** Giây giữa hai vòng. Khai ở env để chỉnh mà không phải phát hành lại. */
export const LIVE_INGEST_INTERVAL_ENV = "AI_LIVE_INGEST_INTERVAL_SECONDS";

/**
 * 45 giây: đủ nhanh để nhân viên thấy thẻ hiện ra gần như ngay, đủ chậm để một page không ngốn
 * hạn mức Pancake. Hai mươi giây cũng chạy được nhưng không mua thêm được gì — người trực còn
 * phải đọc câu gợi ý trước khi bấm.
 */
export const LIVE_INGEST_DEFAULT_SECONDS = 45;
export const LIVE_INGEST_MIN_SECONDS = 20;
export const LIVE_INGEST_MAX_SECONDS = 600;

/**
 * CỬA SỔ ĐỌC CHỒNG LẤN — vì sao không hỏi đúng từ mốc lần trước.
 *
 * Pancake lọc hội thoại theo lần CẬP NHẬT, và đồng hồ hai bên không bao giờ khớp tuyệt đối. Hỏi
 * đúng từ mốc cũ thì một tin rơi vào đúng khe giữa hai vòng sẽ mất luôn, và không ai biết.
 *
 * Nên mỗi vòng lùi lại thêm ngần này phút. Chồng lấn KHÔNG sinh ra bản sao: `ingestMessage` chống
 * trùng bằng `external_id` và bằng vân tay nội dung, nên đọc lại một tin cũ là một phép không-thao-tác.
 * Thà đọc thừa mười lần còn hơn mất một câu của khách.
 */
export const LIVE_INGEST_OVERLAP_MINUTES = 10;

/** Trần cho một vòng. Vòng nào cũng nhỏ thì một lượt hỏng chỉ mất một ít, và thử lại rẻ. */
export const LIVE_INGEST_MAX_CONVERSATIONS = 30;

/**
 * NGHỈ DÀI DẦN KHI HỎNG — 1× · 2× · 4× · 8×, trần 8.
 *
 * Pancake trả 429 hoặc token hết hạn thì hỏi tiếp cùng nhịp chỉ làm mọi thứ tệ hơn và lấp đầy log
 * bằng cùng một dòng. Nhân đôi khoảng nghỉ cho tới trần, và trở lại nhịp thường ngay khi có một
 * vòng chạy được.
 */
export const LIVE_INGEST_MAX_BACKOFF = 8;

/** Bao lâu không có vòng nào chạy được thì coi là ĐỨT, không phải "đang chậm". */
export const LIVE_INGEST_STALE_MINUTES = 5;

export type LiveIngestHealth = "LIVE" | "SLOW" | "ERROR" | "OFF";

export const LIVE_INGEST_HEALTH_LABEL: Record<LiveIngestHealth, string> = {
  LIVE: "ĐANG CHẠY",
  SLOW: "CHẬM — chưa thấy vòng nào gần đây",
  ERROR: "LỖI",
  OFF: "TẮT",
};

/**
 * Sức khoẻ của bộ nạp. HÀM THUẦN, nên màn hình và kiểm thử đọc cùng một luật.
 *
 * Thứ tự các nhánh có chủ ý: TẮT trước LỖI. Một bộ nạp đang tắt mà báo "LỖI" sẽ khiến người vận
 * hành đi tìm một sự cố không tồn tại, trong khi việc phải làm chỉ là bật nó lên.
 */
export function liveIngestHealth(input: { enabled: boolean; lastOkAt: Date | null; consecutiveErrors: number; now?: Date }): LiveIngestHealth {
  if (!input.enabled) return "OFF";
  if (input.consecutiveErrors > 0 && !input.lastOkAt) return "ERROR";
  const now = input.now ?? new Date();
  const phut = input.lastOkAt ? (now.getTime() - input.lastOkAt.getTime()) / 60_000 : Number.POSITIVE_INFINITY;
  if (phut > LIVE_INGEST_STALE_MINUTES) return input.consecutiveErrors > 0 ? "ERROR" : "SLOW";
  return input.consecutiveErrors > 0 ? "SLOW" : "LIVE";
}

/** Giây nghỉ của vòng tiếp theo. HÀM THUẦN. */
export function nextDelaySeconds(base: number, consecutiveErrors: number): number {
  const heSo = Math.min(2 ** Math.max(0, consecutiveErrors - 1), LIVE_INGEST_MAX_BACKOFF);
  return Math.min(base * (consecutiveErrors > 0 ? heSo : 1), LIVE_INGEST_MAX_SECONDS);
}

/**
 * Cửa sổ giờ cần hỏi lại, tính từ mốc lần đọc được cuối.
 *
 * Chưa có mốc nào (lần chạy đầu, hoặc vừa dựng lại CSDL) ⇒ lấy `mặc định`, KHÔNG lấy "từ đầu thời
 * gian": một lượt nạp toàn bộ lịch sử ở vòng đầu sẽ nuốt hạn mức Pancake và đổ hàng nghìn dòng vào
 * hàng đợi cùng lúc.
 */
export function windowHours(lastOkAt: Date | null, now = new Date(), mặcĐịnh = 2): number {
  if (!lastOkAt) return mặcĐịnh;
  const gio = (now.getTime() - lastOkAt.getTime()) / 3_600_000 + LIVE_INGEST_OVERLAP_MINUTES / 60;
  return Math.min(Math.max(Math.ceil(gio), 1), 24);
}

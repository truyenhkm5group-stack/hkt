/**
 * SỨC KHOẺ NHÀ CUNG CẤP + CẦU DAO — CHUẨN HOÁ LỖI, KHÔNG RẼ NHÁNH THEO TÊN.
 *
 * ═══ VÌ SAO TỆP NÀY TỒN TẠI ═══
 *
 * Ngày 17–19/09/2026, nấc rẻ hỏng 470/470 lượt liên tiếp trong hai ngày vì tài khoản hết hạn mức
 * (`429 You have no credits remaining`). Dây chuyền hành xử ĐÚNG ở mức một lượt — leo nấc rồi
 * chuyển người — nhưng nó làm đúng như vậy **bốn trăm bảy mươi lần**, mỗi lần một lượt gọi mạng
 * chắc chắn hỏng, mỗi lần một khoảng chờ tính vào thời gian trả lời khách.
 *
 * Bài học KHÔNG phải "hãy nạp tiền". Nó là: MỘT LƯỢT HỎNG là chuyện của lượt ấy; BỐN TRĂM LƯỢT
 * HỎNG GIỐNG HỆT NHAU là một sự thật về nhà cung cấp, và sự thật ấy phải được nhớ giữa các lượt.
 *
 * ═══ HAI ĐIỀU TỆP NÀY CỐ TÌNH KHÔNG LÀM ═══
 *
 * 1. **Không rẽ nhánh theo tên nhà cung cấp.** Chính sách đi theo NHÓM LỖI, không theo ai gây ra
 *    nó: hết hạn mức của OpenAI, của Anthropic và của Google đều đáng bị xử như nhau, vì thứ
 *    quyết định cách xử là "thử lại có ích không", chứ không phải logo trên hoá đơn. Phần duy
 *    nhất được biết tên là bộ ĐỌC lời lỗi (mỗi API viết lỗi một kiểu) — và đó là phép DỊCH, không
 *    phải chính sách.
 *
 * 2. **Không thay một lưới nghiệp vụ nào.** Cầu dao chỉ trả lời đúng một câu: *lượt gọi tiếp theo
 *    nên đi tới nhà cung cấp nào*. Nó KHÔNG đụng tới máy trạng thái, điều kiện lên đơn, chính
 *    sách rủi ro hay luật chuyển người. Đổi nhà cung cấp mà đổi luôn mức kiểm tra là biến một sự
 *    cố hạ tầng thành một lỗ hổng nghiệp vụ — xem `docs/` và mục 3 của đặc tả.
 */

/** Sáu trạng thái. Thứ tự này là thứ tự XẤU DẦN, và bài kiểm dựa vào nó. */
export const PROVIDER_HEALTH_STATES = ["HEALTHY", "DEGRADED", "RATE_LIMITED", "QUOTA_EXHAUSTED", "AUTH_ERROR", "OFFLINE"] as const;
export type ProviderHealth = (typeof PROVIDER_HEALTH_STATES)[number];

export const PROVIDER_HEALTH_LABEL: Record<ProviderHealth, string> = {
  HEALTHY: "Bình thường",
  DEGRADED: "Chập chờn — có lỗi rải rác",
  RATE_LIMITED: "Bị chặn tốc độ — chờ rồi thử lại",
  QUOTA_EXHAUSTED: "Hết hạn mức / hết tiền — thử lại vô ích",
  AUTH_ERROR: "Sai khoá hoặc sai dự án — người phải sửa",
  OFFLINE: "Không gọi tới được",
};

/**
 * NHÓM LỖI — bản dịch từ muôn kiểu lời lỗi về một tập ĐÓNG.
 *
 * `QUOTA_EXHAUSTED` và `RATE_LIMITED` đều tới từ HTTP 429 và gộp chúng là sai lầm tốn kém nhất ở
 * đây: chặn tốc độ thì chờ vài giây là qua, còn hết tiền thì chờ bao lâu cũng không qua. Gộp lại
 * thành "RATE_LIMIT" nghĩa là hệ thống sẽ kiên nhẫn thử lại suốt hai ngày — đúng thứ vừa xảy ra.
 */
export const PROVIDER_ERROR_KINDS = [
  "QUOTA_EXHAUSTED",
  "RATE_LIMITED",
  "AUTH_ERROR",
  "TIMEOUT",
  "OFFLINE",
  "BAD_REQUEST",
  "SERVER_ERROR",
  "SCHEMA_INVALID",
  "UNKNOWN",
] as const;
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

export const PROVIDER_ERROR_LABEL: Record<ProviderErrorKind, string> = {
  QUOTA_EXHAUSTED: "Hết hạn mức / hết tiền",
  RATE_LIMITED: "Bị chặn tốc độ",
  AUTH_ERROR: "Khoá sai · hết hạn · sai dự án",
  TIMEOUT: "Quá thời gian",
  OFFLINE: "Không kết nối được",
  BAD_REQUEST: "Yêu cầu sai (tên mô hình, tham số)",
  SERVER_ERROR: "Nhà cung cấp lỗi phía họ",
  SCHEMA_INVALID: "Trả về sai cấu trúc",
  UNKNOWN: "Chưa phân loại được",
};

/**
 * CHÍNH SÁCH THEO NHÓM LỖI — đây là toàn bộ phần "business policy" của cầu dao, và nó là một
 * BẢNG chứ không phải một chuỗi lệnh `if`. Thêm nhà cung cấp không thêm một dòng nào ở đây.
 *
 *   `retries`     số lần thử lại NGAY trong cùng một lượt. 0 = không thử lại.
 *   `openCircuit` có mở cầu dao (bỏ qua nhà cung cấp này ở các lượt SAU) không.
 *   `cooldownMs`  bao lâu thì cho một lượt dò thử. 0 = không tự đóng lại, người phải sửa.
 *   `health`      trạng thái mà nhóm lỗi này đặt cho nhà cung cấp.
 */
export type ErrorPolicy = { retries: number; openCircuit: boolean; cooldownMs: number; health: ProviderHealth; why: string };

const PHUT = 60_000;

export const ERROR_POLICY: Record<ProviderErrorKind, ErrorPolicy> = {
  // Thử lại là vô ích cho tới khi CON NGƯỜI nạp tiền. Mở cầu dao ngay từ lần đầu, chờ lâu.
  QUOTA_EXHAUSTED: { retries: 0, openCircuit: true, cooldownMs: 30 * PHUT, health: "QUOTA_EXHAUSTED", why: "Hết tiền thì chờ bao lâu cũng không qua — mở cầu dao ngay, dò lại thưa" },
  // Chặn tốc độ thì chờ là qua. Cho thử lại ngắn, và cầu dao đóng lại nhanh.
  RATE_LIMITED: { retries: 2, openCircuit: true, cooldownMs: 1 * PHUT, health: "RATE_LIMITED", why: "Chờ vài giây tới vài phút là qua — lùi dần rồi dò lại sớm" },
  // Khoá sai không tự đúng. `cooldownMs: 0` = KHÔNG tự dò lại; người phải sửa rồi mở tay.
  AUTH_ERROR: { retries: 0, openCircuit: true, cooldownMs: 0, health: "AUTH_ERROR", why: "Khoá sai không tự đúng — spam thêm chỉ tổ khoá tài khoản" },
  TIMEOUT: { retries: 1, openCircuit: false, cooldownMs: 0, health: "DEGRADED", why: "Có thể là một lượt xui — cho đúng một lần nữa, không hơn" },
  OFFLINE: { retries: 1, openCircuit: true, cooldownMs: 2 * PHUT, health: "OFFLINE", why: "Mạng hoặc nhà cung cấp chết — dò lại sau ít phút" },
  // Yêu cầu sai là lỗi CỦA TA (sai tên mô hình, sai tham số). Thử lại y hệt thì hỏng y hệt.
  BAD_REQUEST: { retries: 0, openCircuit: false, cooldownMs: 0, health: "DEGRADED", why: "Lỗi của ta, không của họ — gửi lại y hệt thì hỏng y hệt" },
  SERVER_ERROR: { retries: 1, openCircuit: false, cooldownMs: 0, health: "DEGRADED", why: "Lỗi phía họ và thường thoáng qua" },
  // KHÔNG mở cầu dao: mô hình trả sai cấu trúc là chuyện của lượt ấy, nhà cung cấp vẫn khoẻ, và
  // bộ định tuyến đã có sẵn đường xử lý (leo nấc). Mở cầu dao ở đây là tắt một nhà cung cấp đang
  // chạy tốt chỉ vì một câu trả lời lạc lối.
  SCHEMA_INVALID: { retries: 0, openCircuit: false, cooldownMs: 0, health: "HEALTHY", why: "Nhà cung cấp vẫn khoẻ — đây là chuyện của một câu trả lời, bộ định tuyến tự leo nấc" },
  UNKNOWN: { retries: 0, openCircuit: false, cooldownMs: 0, health: "DEGRADED", why: "Chưa phân loại được thì KHÔNG đoán — không thử lại, không tắt ai, và nêu ra để bổ sung luật" },
};

/**
 * ĐỌC LỜI LỖI RA NHÓM.
 *
 * Đây là chỗ DUY NHẤT trong toàn bộ cơ chế được phép biết rằng các API viết lỗi khác nhau — và nó
 * vẫn không rẽ nhánh theo tên nhà cung cấp: nó khớp theo CHỮ trong lời lỗi và theo MÃ HTTP, hai
 * thứ mà mọi nhà cung cấp đều có.
 *
 * ─── PHÂN BIỆT 429 HẾT TIỀN vs 429 CHẶN TỐC ĐỘ ───
 *
 * Cả hai cùng là 429. Phân biệt bằng CHỮ, vì đó là thứ duy nhất khác nhau:
 *   hết tiền   — "no credits", "insufficient_quota", "exceeded your current quota", "billing"
 *   chặn tốc độ — mọi 429 còn lại (thường kèm "rate limit", "requests per minute", "TPM")
 *
 * Mặc định của 429 là `RATE_LIMITED` (nhóm NHẸ hơn), có chủ ý: đoán nhầm hết-tiền-thành-chặn-tốc
 * làm ta thử lại thừa vài lần rồi cầu dao vẫn mở; đoán nhầm chiều ngược lại làm ta TẮT một nhà
 * cung cấp đang khoẻ trong nửa tiếng. Sai về phía ồn ào hơn nhưng không tự cắt tay mình.
 *
 * Và phép thử HẾT TIỀN đứng NGOÀI nhánh 429, không nằm trong — xem chú thích tại chỗ.
 */
export function normalizeProviderError(input: { status?: number; message?: string; name?: string }): ProviderErrorKind {
  const chu = `${input.name ?? ""} ${input.message ?? ""}`.toLowerCase();
  const ma = input.status ?? 0;

  if (/timeout|timed out|etimedout|aborted/.test(chu)) return "TIMEOUT";
  if (/econnrefused|enotfound|econnreset|network|fetch failed|socket hang up|không kết nối được/.test(chu)) return "OFFLINE";

  if (ma === 401 || ma === 403 || /invalid[_ ]api[_ ]key|incorrect api key|unauthorized|forbidden|invalid[_ ]project|no access to model|permission/.test(chu)) {
    return "AUTH_ERROR";
  }

  /*
    HẾT HẠN MỨC XÉT TRƯỚC, VÀ KHÔNG PHỤ THUỘC MÃ HTTP.

    Bản đầu đặt phép thử này BÊN TRONG nhánh `429`, với một cổng ngoài là
    `/rate.?limit|quota|no credits|billing/`. Bài kiểm bắt ngay: lời lỗi hết tiền THẬT của một nhà
    cung cấp là *"Your credit balance is too low to access the API"* — không có chữ "quota", không
    có "no credits", và có thể về kèm một mã khác 429. Nó rơi thẳng vào `UNKNOWN`, tức là KHÔNG mở
    cầu dao, tức là đúng lại kịch bản thử-lại-suốt-hai-ngày mà cả cơ chế này sinh ra để chặn.

    Nên: hỏi "có phải hết tiền không" trước, bằng chính CHỮ, rồi mới tới mã HTTP. Một cổng ngoài
    dựng bằng danh sách chữ là một cổng sẽ quên mất cách diễn đạt thứ năm.
  */
  const HET_TIEN = /no credits|insufficient[_ ]quota|exceeded your current quota|billing|credit balance|out of (credits|quota)|hết hạn mức/;
  // Ngân sách tổ chức / dự án là MỘT DẠNG hết hạn mức: người phải vào bảng điều khiển nới nó, thử
  // lại không giúp gì. Gộp vào `RATE_LIMITED` là lặp lại đúng sai lầm cũ với một cái tên khác.
  const HET_NGAN_SACH = /budget|spend limit|usage limit|organization.*limit|project.*limit/;
  if (HET_TIEN.test(chu) || HET_NGAN_SACH.test(chu)) return "QUOTA_EXHAUSTED";

  // Còn lại của 429 (và mọi lời lỗi nói "rate limit") là chặn tốc độ — chờ là qua.
  if (ma === 429 || /rate.?limit|too many requests/.test(chu)) return "RATE_LIMITED";

  if (ma === 400 || ma === 404 || ma === 422 || /model.*not found|unsupported|invalid.*(parameter|request|model)/.test(chu)) return "BAD_REQUEST";
  if (ma >= 500 || /internal|overloaded|service unavailable|bad gateway/.test(chu)) return "SERVER_ERROR";
  if (/sai lược đồ|schema/.test(chu)) return "SCHEMA_INVALID";
  return "UNKNOWN";
}

/** Trạng thái sức khoẻ mà một nhóm lỗi đặt ra. Không lỗi ⇒ `HEALTHY`. */
export function healthForError(kind: ProviderErrorKind | null): ProviderHealth {
  return kind === null ? "HEALTHY" : ERROR_POLICY[kind].health;
}

/** Cầu dao có ĐANG MỞ không (tức là phải bỏ qua nhà cung cấp này). */
export type CircuitState = {
  provider: string;
  health: ProviderHealth;
  /** Nhóm lỗi đã làm nó mở. `null` = đang đóng. */
  openedBy: ProviderErrorKind | null;
  openedAt: Date | null;
  /** Sớm nhất được phép dò lại. `null` = KHÔNG tự dò; người phải sửa rồi mở tay. */
  probeAfter: Date | null;
  /** Số lượt đã bị bỏ qua vì cầu dao mở — con số này là cái giá mà cầu dao đã tiết kiệm. */
  skipped: number;
};

/**
 * Còn phải bỏ qua nhà cung cấp này không, tính ở LÚC ĐỌC.
 *
 * Tính lúc đọc chứ không ghi một cờ "đang mở" vào CSDL: cờ ấy sẽ đúng lúc ghi rồi sai dần theo
 * từng giây, còn phép so `now >= probeAfter` thì đúng tới từng giây mà không tốn một dòng nào.
 * Đây cũng là cách luật 26 của kho mã xử lý leo thang hạn xử lý.
 */
export function circuitOpen(state: CircuitState | null, now: Date): boolean {
  if (!state || state.openedBy === null) return false;
  if (state.probeAfter === null) return true; // chờ người, không tự đóng lại
  return now < state.probeAfter;
}

/** Mốc được phép dò lại sau một lỗi. `null` = không tự dò. */
export function probeAfterFor(kind: ProviderErrorKind, at: Date): Date | null {
  const p = ERROR_POLICY[kind];
  if (!p.openCircuit) return null;
  if (p.cooldownMs <= 0) return null;
  return new Date(at.getTime() + p.cooldownMs);
}

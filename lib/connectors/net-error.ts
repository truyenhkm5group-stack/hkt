/**
 * ═══════════ LỖI MẠNG KHI GỌI DỊCH VỤ NGOÀI ⇒ CÂU ĐỌC ĐƯỢC — HÀM THUẦN ═══════════
 *
 * `fetch` của Node ném `TypeError("fetch failed")` cho MỌI lỗi mạng; nguyên nhân thật nằm trong chuỗi `cause`
 * (`ENOTFOUND`, `ECONNRESET`, `UND_ERR_CONNECT_TIMEOUT`…). Trước đây màn hình Kết nối chỉ in «fetch failed»: đo UAT
 * 30/09/2026, kết nối Telegram của một tổ chức hỏng như vậy và phải dựng một phép thử riêng (token giả, trên tổ chức
 * thử) mới biết đó là MÁY CHỦ ERP không mở được kết nối tới api.telegram.org — không phải token sai. Người dùng không
 * có cách nào tự phân biệt hai chuyện đó, và hai chuyện đó sửa ở hai chỗ khác nhau.
 *
 * Không in URL, không in token: chỉ tên máy (host) và mã lỗi.
 */
export type NetFailureKind = "DNS" | "RESET" | "REFUSED" | "TIMEOUT" | "TLS" | "OTHER";

/** Mã lỗi đầu tiên tìm thấy trong chuỗi `cause` (tối đa 5 tầng), hoặc tên lỗi hẹn giờ. */
export function networkErrorCode(e: unknown): string | null {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const o = cur as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof o.code === "string" && o.code) return o.code;
    if (o.name === "TimeoutError" || o.name === "AbortError") return o.name;
    cur = o.cause;
  }
  return null;
}

export function networkFailureKind(code: string | null): NetFailureKind {
  if (!code) return "OTHER";
  if (/^(ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_NODATA)$/.test(code)) return "DNS";
  if (/^(ECONNRESET|EPIPE|UND_ERR_SOCKET|UND_ERR_CLOSED)$/.test(code)) return "RESET";
  if (code === "ECONNREFUSED") return "REFUSED";
  if (/^(ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|TimeoutError|AbortError)$/.test(code)) return "TIMEOUT";
  if (/CERT|TLS|SSL|UNABLE_TO_VERIFY|SELF_SIGNED|DEPTH_ZERO/.test(code)) return "TLS";
  return "OTHER";
}

/**
 * Lỗi mạng xảy ra TRƯỚC KHI yêu cầu rời máy (không mở được kết nối: hết giờ chờ kết nối · không có đường · bị từ chối ·
 * không phân giải được tên) ⇒ nhà cung cấp CHẮC CHẮN chưa nhận gì ⇒ gửi lại an toàn, không thể sinh tin trùng. Kết nối bị
 * NGẮT (`ECONNRESET`) hay hết giờ chờ PHẢN HỒI thì KHÔNG thuộc nhóm này: yêu cầu có thể đã tới nơi, gửi lại là đánh cược tin
 * trùng («đơn mới» hai lần ⇒ kho đóng hai lần). Đo 01/10/2026: máy chủ ERP (Việt Nam) chập chờn tới api.telegram.org — cùng
 * một nhóm chat, 16:42 gửi được, 21:12 `ETIMEDOUT`.
 */
export function failedBeforeSending(e: unknown): boolean {
  const code = networkErrorCode(e);
  return code !== null && /^(ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_NODATA)$/.test(code);
}

/** Có phải lỗi MẠNG (không mở được kết nối) chứ không phải lỗi của chính dịch vụ. */
export function isNetworkFailure(e: unknown): boolean {
  return networkErrorCode(e) !== null || (e instanceof Error && /fetch failed/i.test(e.message));
}

/** Câu tiếng Việt cho một lỗi mạng khi gọi `host`, kèm mã lỗi để hỗ trợ tra. */
export function describeNetworkFailure(e: unknown, host: string): string {
  const code = networkErrorCode(e);
  const tail = code ? ` (${code})` : "";
  switch (networkFailureKind(code)) {
    case "DNS":
      return `Máy chủ ERP không phân giải được tên miền ${host}${tail}.`;
    case "RESET":
      return `Kết nối từ máy chủ ERP tới ${host} bị ngắt ngay khi mở${tail} — thường do nhà mạng hoặc nhà cung cấp máy chủ chặn dịch vụ này.`;
    case "REFUSED":
      return `${host} từ chối kết nối từ máy chủ ERP${tail}.`;
    case "TIMEOUT":
      return `Máy chủ ERP không tới được ${host} (hết thời gian chờ hoặc không có đường mạng)${tail} — thường do tường lửa hoặc nhà mạng chặn.`;
    case "TLS":
      return `Kết nối tới ${host} lỗi chứng chỉ bảo mật${tail} — có thiết bị mạng đang chen giữa đường truyền.`;
    default:
      return `Máy chủ ERP không mở được kết nối tới ${host}${tail}.`;
  }
}

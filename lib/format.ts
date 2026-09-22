const VN_TZ = "Asia/Ho_Chi_Minh";

/**
 * ═══════════ HỢP ĐỒNG HIỂN THỊ: CHƯA BIẾT KHÔNG ĐƯỢC IN RA THÀNH 0 ═══════════
 *
 * ─── LỖI ĐÃ SỬA ───
 *
 * Suốt tầng truy vấn, kho mã này giữ `NULL` rất cẩn thận: `metricTrust` tách `UNKNOWN` khỏi
 * `WEAK`, `verdict()` có `NOT_MEASURED` riêng, `stockKnown = false` thay vì số 0, `cogsKnown`,
 * `reasonCoverage`… Rồi ở đúng một phân đoạn cuối cùng — lúc in ra màn hình — cả công trình đó bị
 * xoá bởi một biểu thức:
 *
 *     const n = Number(value ?? 0);   // formatVND, bản cũ
 *
 * `formatVND(null)` in ra `0 ₫`. `formatNumber(null)` in ra `0`. `formatPercent(null)` in ra
 * `0.0%`. Người đọc thấy một con số dứt khoát ở chỗ đáng lẽ phải thấy "chưa có dữ liệu".
 *
 * Đó là vi phạm thẳng AGENTS.md mục 0.3 ("`NULL` là CHƯA BIẾT, không phải 0") và mục 8.5
 * ("Unknown phải là UNKNOWN, không đổi thành 0"), và nó nguy hiểm hơn một ô trống: một ô trống làm
 * người ta đi hỏi, còn `0 ₫` làm người ta kết luận. "Giá vốn 0 ₫" đọc ra là "hàng không tốn tiền
 * vốn"; "tỷ lệ hoàn 0.0%" đọc ra là "không đơn nào hoàn" trong khi sự thật là "chưa đơn nào có kết
 * quả cuối để tính".
 *
 * ─── BA TRẠNG THÁI, BA CÁCH IN ───
 *
 *   0 THẬT          →  `0 ₫` · `0` · `0.0%`     đã đo, và kết quả bằng không
 *   CHƯA BIẾT       →  `—`                       chưa có chứng từ / chưa có mẫu số / chưa đo
 *   KHÔNG ÁP DỤNG   →  `N/A`                     dòng này không có khái niệm đó
 *
 * `NaN` và `Infinity` đi cùng nhánh CHƯA BIẾT: chúng luôn là dấu vết của một phép chia cho 0 hoặc
 * một giá trị hỏng, và `NaN ₫` thì vừa sai vừa khó truy.
 *
 * ─── CÁCH GỌI ───
 *
 * Nơi nào `null` thật sự CÓ NGHĨA LÀ KHÔNG (chưa chi đồng nào, chưa có việc nào) thì viết
 * `?? 0` NGAY TẠI CHỖ GỌI: `formatVND(x ?? 0)`. Viết ra như vậy là một lời khẳng định đọc được và
 * tìm được bằng grep, khác hẳn một mặc định ẩn nằm trong hàm định dạng.
 */

/** CHƯA BIẾT / chưa có dữ liệu. Khác hẳn 0. */
export const MISSING_TEXT = "—";

/** KHÔNG ÁP DỤNG cho dòng này — khác hẳn "chưa biết". */
export const NOT_APPLICABLE_TEXT = "N/A";

/** Câu giải thích dùng chung cho tooltip của một ô `—`. */
export const MISSING_HINT = "Chưa có dữ liệu — không phải 0";

export type MissingOpt = {
  /** Chữ thay cho `—` khi giá trị chưa biết (ví dụ "chưa đo được"). KHÔNG dùng để in "0". */
  missing?: string;
};

/**
 * Quy về một con số HỮU HẠN, hoặc `null`.
 *
 * Nhận cả chuỗi vì tầng truy vấn có chỗ khai `sql<number>` nhưng trình điều khiển trả về chuỗi
 * (kiểu `numeric` của Postgres). Chuỗi rỗng là CHƯA BIẾT chứ không phải 0 — `Number("")` ra 0 là
 * đúng cái bẫy đang sửa.
 */
function finiteOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function formatVND(value: number | null | undefined, opts: { compact?: boolean; sign?: boolean } & MissingOpt = {}) {
  const n = finiteOrNull(value);
  if (n === null) return opts.missing ?? MISSING_TEXT;
  if (opts.compact) {
    const abs = Math.abs(n);
    const sign = n < 0 ? "-" : opts.sign && n > 0 ? "+" : "";
    if (abs >= 1_000_000_000) return `${sign}${trimZero((abs / 1_000_000_000).toFixed(2))} tỷ`;
    if (abs >= 1_000_000) return `${sign}${trimZero((abs / 1_000_000).toFixed(1))} tr`;
    if (abs >= 1_000) return `${sign}${Math.round(abs / 1_000)}k`;
    return `${sign}${abs}`;
  }
  const formatted = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(Math.abs(n));
  const sign = n < 0 ? "-" : opts.sign && n > 0 ? "+" : "";
  return `${sign}${formatted} ₫`;
}

function trimZero(value: string) {
  return value.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

export function formatNumber(value: number | null | undefined, opts: MissingOpt = {}) {
  const n = finiteOrNull(value);
  if (n === null) return opts.missing ?? MISSING_TEXT;
  return new Intl.NumberFormat("vi-VN").format(n);
}

export function formatPercent(value: number | null | undefined, digits = 1, opts: MissingOpt = {}) {
  const n = finiteOrNull(value);
  if (n === null) return opts.missing ?? MISSING_TEXT;
  return `${n.toFixed(digits)}%`;
}

export function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value: string | Date | null | undefined, withTime = false) {
  const date = toDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: VN_TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(date);
}

export function formatDateTime(value: string | Date | null | undefined) {
  return formatDate(value, true);
}

export function formatTimeAgo(value: string | Date | null | undefined) {
  const date = toDate(value);
  if (!date) return "—";
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "vừa xong";
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} ngày trước`;
  return formatDate(date);
}

/**
 * ═══ MỐC NGẮN "NGÀY/THÁNG GIỜ:PHÚT" THEO GIỜ VIỆT NAM — GHÉP TAY, KHÔNG PHÓ THÁC CHO LOCALE ═══
 *
 * `toLocaleString("vi-VN", …)` trả về THỨ TỰ KHÁC NHAU tuỳ bản ICU của môi trường: trình duyệt cho
 * "14/09 10:05", còn Node dựng trong ảnh Docker của kho này cho "10:05 14-09". Cùng một dòng dữ
 * liệu, hai chỗ đọc ra hai mốc khác nhau — và không ai phát hiện cho tới khi so hai màn hình.
 *
 * Nên: lấy TỪNG PHẦN rồi tự ghép. Cùng cách `vnDateKey` đã làm, cùng lý do.
 */
export function vnShortStamp(value: string | Date | null | undefined) {
  const date = toDate(value);
  if (!date) return MISSING_TEXT;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: VN_TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}/${get("month")} ${get("hour")}:${get("minute")}`;
}

/** Ngày theo giờ Việt Nam ở dạng YYYY-MM-DD */
export function vnDateKey(value: string | Date) {
  const date = toDate(value);
  if (!date) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: VN_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Đầu ngày (00:00 giờ VN) của một ngày YYYY-MM-DD, trả về Date UTC */
export function vnStartOfDay(dateKey: string) {
  return new Date(`${dateKey}T00:00:00+07:00`);
}

export function vnEndOfDay(dateKey: string) {
  return new Date(`${dateKey}T23:59:59.999+07:00`);
}

export function todayVN() {
  return vnDateKey(new Date());
}

export function addDays(dateKey: string, days: number) {
  const date = vnStartOfDay(dateKey);
  date.setUTCDate(date.getUTCDate() + days);
  return vnDateKey(date);
}

export function clampInt(value: unknown, fallback = 0) {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/[^\d.-]/g, "")) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(-2_147_483_647, Math.min(2_147_483_647, Math.round(n)));
}

/**
 * Tỷ lệ phần trăm dùng cho TÍNH TOÁN (bề rộng thanh biểu đồ, ngưỡng so sánh). Mẫu số 0 ⇒ 0, vì một
 * thanh biểu đồ dài 0 là đúng khi chưa có gì để vẽ.
 *
 * ĐỪNG dùng hàm này cho một con số ĐỌC ĐƯỢC trên màn hình khi mẫu số có thể bằng 0 — ở đó "0%"
 * nói rằng đã đo và kết quả bằng không, trong khi sự thật là CHƯA CÓ MẪU SỐ. Chỗ đó dùng
 * `pctOrNull` rồi để `formatPercent` in ra `—`.
 */
export function pct(part: number, total: number) {
  return total ? (part / total) * 100 : 0;
}

/**
 * Tỷ lệ phần trăm dùng để HIỂN THỊ. Mẫu số 0 ⇒ `null` = CHƯA CÓ MẪU SỐ, không phải 0%.
 *
 * "Tỷ lệ hoàn 0.0%" trên một kỳ chưa đơn nào có kết quả cuối là một câu khẳng định sai: nó nói
 * không đơn nào hoàn. `—` nói đúng thứ đang có: chưa đủ dữ liệu để trả lời.
 */
export function pctOrNull(part: number | null | undefined, total: number | null | undefined): number | null {
  const t = typeof total === "number" && Number.isFinite(total) ? total : null;
  const p = typeof part === "number" && Number.isFinite(part) ? part : null;
  if (t === null || p === null || t === 0) return null;
  return (p / t) * 100;
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(-2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");
}

export function maskPhone(phone: string) {
  if (!phone) return "";
  return phone.length > 6 ? `${phone.slice(0, 3)}***${phone.slice(-3)}` : phone;
}

/**
 * Giờ:phút:giây theo giờ Việt Nam. Ghép tay từ `formatToParts` vì cùng lý do với `vnShortStamp`:
 * cùng một mốc, hai bản ICU khác nhau in ra hai chuỗi khác nhau.
 *
 * Dùng cho nhãn "số liệu tải lúc …" — ở đó GIÂY là phần có nghĩa: người dùng bấm làm mới hai lần
 * cách nhau vài chục giây và cần thấy mốc đã đổi.
 */
export function vnClock(value: string | Date | null | undefined) {
  const date = toDate(value);
  if (!date) return MISSING_TEXT;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: VN_TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")}:${get("second")}`;
}

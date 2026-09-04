const VN_TZ = "Asia/Ho_Chi_Minh";

export function formatVND(value: number | null | undefined, opts: { compact?: boolean; sign?: boolean } = {}) {
  const n = Number(value ?? 0);
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

export function formatNumber(value: number | null | undefined) {
  return new Intl.NumberFormat("vi-VN").format(Number(value ?? 0));
}

export function formatPercent(value: number | null | undefined, digits = 1) {
  return `${Number(value ?? 0).toFixed(digits)}%`;
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

export function pct(part: number, total: number) {
  return total ? (part / total) * 100 : 0;
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

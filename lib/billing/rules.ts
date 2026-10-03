/**
 * ═══════════ LUẬT THU PHÍ THUÊ BAO — HÀM THUẦN, client-safe (docs/platform/billing.md) ═══════════
 *
 * Không đọc / ghi CSDL, không đọc đồng hồ: "hôm nay" luôn là THAM SỐ. Cùng đầu vào ⇒ cùng kết quả, nên mọi nhánh kiểm
 * được bằng bảng chân lý (`tests/platform-billing.test.ts`) mà không cần một lịch chạy đúng giờ.
 *
 * MÔ HÌNH "TRẢ TỚI NGÀY". Tổ chức có ĐÚNG MỘT con số: `paid_through` — ngày cuối cùng đã trả (giờ Việt Nam, tính cả ngày
 * đó). Tình trạng là hàm của con số ấy, số ngày ân hạn và hôm nay:
 *
 *   hôm nay ≤ paid_through − 7  ⇒ ACTIVE
 *   hôm nay ≤ paid_through       ⇒ DUE_SOON  (còn ≤ 7 ngày — nhắc, vẫn dùng đủ)
 *   hôm nay ≤ paid_through + ân hạn ⇒ OVERDUE (quá hạn — nhắc đỏ, VẪN dùng đủ)
 *   sau đó                       ⇒ LOCKED   (CHỈ XEM: xem, xuất được; không tạo / sửa / xoá; job nền dừng)
 *
 * KHÔNG BAO GIỜ XOÁ DỮ LIỆU, không bao giờ tự đình chỉ (đình chỉ là công tắc khẩn của người, không phải của tiền). Tổ
 * chức chưa bật thu phí ⇒ NOT_BILLED: không nhắc, không khoá — khách pilot có từ trước không đổi gì.
 */

/** Số tháng một lần gia hạn được chọn. KHÔNG có chiết khấu theo kỳ dài — giảm giá là quyết định kinh doanh (luật 38). */
export const BILLING_MONTH_OPTIONS = [1, 3, 6, 12] as const;
export type BillingMonths = (typeof BILLING_MONTH_OPTIONS)[number];

/** Ân hạn mặc định khi người vận hành bật thu phí. Sửa theo từng tổ chức ở /platform/org/<mã> (0–60). */
export const BILLING_DEFAULT_GRACE_DAYS = 7;
export const BILLING_GRACE_MAX = 60;
/** Còn bấy nhiêu ngày thì bắt đầu nhắc (DUE_SOON). */
export const BILLING_DUE_SOON_DAYS = 7;
/** Một "tháng" khi quy đổi phần còn lại của gói cũ ra tiền lúc NÂNG gói: giá tháng / 30 mỗi ngày. */
export const BILLING_DAYS_PER_MONTH = 30;

/** Tiền tố nội dung chuyển khoản. Mã đầy đủ: `ERPHD` + 6 ký tự (không có 0 · 1 · I · O — đọc qua điện thoại không nhầm). */
export const TRANSFER_CODE_PREFIX = "ERPHD";
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const TRANSFER_CODE_PATTERN = /^ERPHD[0-9A-Z]{6}$/;

export type BillingStandingKind = "NOT_BILLED" | "ACTIVE" | "DUE_SOON" | "OVERDUE" | "LOCKED";

export const BILLING_STANDING_LABEL: Record<BillingStandingKind, string> = {
  NOT_BILLED: "Chưa thu phí",
  ACTIVE: "Còn hạn",
  DUE_SOON: "Sắp hết hạn",
  OVERDUE: "Quá hạn — đang ân hạn",
  LOCKED: "Chỉ xem — quá hạn thanh toán",
};

export type SubscriptionTerms = { billingEnabled: boolean; paidThrough: string | null; graceDays: number };

export type BillingStanding = {
  kind: BillingStandingKind;
  paidThrough: string | null;
  /** `paid_through − hôm nay` (0 = hôm nay là ngày cuối; âm = đã quá hạn). `null` khi không thu phí. */
  daysLeft: number | null;
  /** Ngày bắt đầu CHỈ XEM nếu không gia hạn. `null` khi không thu phí. */
  lockOn: string | null;
};

// ─────────────────────────── Ngày (chuỗi YYYY-MM-DD, không múi giờ) ───────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Ngày lịch ở Việt Nam (UTC+7, không giờ mùa hè) của một thời điểm. */
export function vnDate(now: Date): string {
  return new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

function toUtc(d: string): Date {
  return new Date(`${d}T00:00:00Z`);
}

export function addDays(d: string, n: number): string {
  const t = toUtc(d);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** `a − b` theo ngày. */
export function diffDays(a: string, b: string): number {
  return Math.round((toUtc(a).getTime() - toUtc(b).getTime()) / 86_400_000);
}

/** Cộng tháng lịch, kẹp ngày vào cuối tháng (31/01 + 1 tháng = 28 hoặc 29/02). */
export function addMonths(d: string, n: number): string {
  const [y, m, day] = d.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${String(ny).padStart(4, "0")}-${String(nm + 1).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

/** Ngày cuối của kỳ `months` tháng bắt đầu từ `start` (01/03 + 1 tháng ⇒ 31/03). */
export function periodEndFor(start: string, months: number): string {
  return addDays(addMonths(start, months), -1);
}

// ─────────────────────────── Tình trạng ───────────────────────────

export function billingStanding(terms: SubscriptionTerms | null, today: string): BillingStanding {
  if (!terms || !terms.billingEnabled || !terms.paidThrough) return { kind: "NOT_BILLED", paidThrough: terms?.paidThrough ?? null, daysLeft: null, lockOn: null };
  const grace = Math.max(0, Math.min(BILLING_GRACE_MAX, Math.trunc(terms.graceDays)));
  const daysLeft = diffDays(terms.paidThrough, today);
  const lockOn = addDays(terms.paidThrough, grace + 1);
  let kind: BillingStandingKind;
  if (daysLeft >= BILLING_DUE_SOON_DAYS) kind = "ACTIVE";
  else if (daysLeft >= 0) kind = "DUE_SOON";
  else if (-daysLeft <= grace) kind = "OVERDUE";
  else kind = "LOCKED";
  return { kind, paidThrough: terms.paidThrough, daysLeft, lockOn };
}

/** Tình trạng nào còn được tính vào doanh thu định kỳ (MRR): khách đang dùng và chưa bị khoá. */
export function countsTowardMrr(kind: BillingStandingKind): boolean {
  return kind === "ACTIVE" || kind === "DUE_SOON" || kind === "OVERDUE";
}

// ─────────────────────────── Cổng CHỈ XEM ───────────────────────────

/**
 * Đường dẫn vẫn GHI được khi tổ chức ở chế độ chỉ xem — đúng những chỗ cần để TRẢ TIỀN và để RA KHỎI hệ thống. Lượt
 * gọi server action đi tới đường dẫn của TRANG đang mở, nên `/settings/plan` (trang gia hạn) phải nằm đây.
 */
export const BILLING_WRITE_EXEMPT_PATHS = ["/settings/plan", "/billing-locked", "/login", "/logout", "/api/auth"] as const;

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isWriteMethod(method: string | null | undefined): boolean {
  return !!method && !READ_METHODS.has(method.toUpperCase());
}

export function billingExemptPath(path: string | null | undefined): boolean {
  if (!path) return false;
  return BILLING_WRITE_EXEMPT_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Lượt request này có bị chặn vì quá hạn không. Tổ chức nhà KHÔNG BAO GIỜ (nó không trả tiền cho chính nó). Phương thức
 * đọc (GET/HEAD/OPTIONS) không bao giờ — chỉ xem nghĩa là XEM được. Thiếu phương thức (gọi ngoài request) ⇒ không chặn ở
 * đây; job nền có cổng riêng ở `runJob`.
 */
export function billingWriteDenied(input: { isHome: boolean; standing: BillingStandingKind; method: string | null | undefined; path: string | null | undefined }): boolean {
  if (input.isHome) return false;
  if (input.standing !== "LOCKED") return false;
  if (!isWriteMethod(input.method)) return false;
  return !billingExemptPath(input.path);
}

// ─────────────────────────── Báo giá gia hạn ───────────────────────────

export type PricedPlan = { key: string; name: string; priceVnd: number | null };

export type RenewalKind = "START" | "RENEW" | "UPGRADE" | "DOWNGRADE";

export const RENEWAL_KIND_LABEL: Record<RenewalKind, string> = {
  START: "Bắt đầu thuê bao",
  RENEW: "Gia hạn",
  UPGRADE: "Nâng gói — trừ phần chưa dùng của gói cũ",
  DOWNGRADE: "Đổi sang gói thấp hơn",
};

export type RenewalQuote = {
  kind: RenewalKind;
  planKey: string;
  months: number;
  periodStart: string;
  periodEnd: string;
  listAmountVnd: number;
  creditVnd: number;
  amountVnd: number;
  /** Phần MUA THÊM cộng vào giá một tháng của gói đích (`lib/billing/addons.ts`). 0 = không mua thêm gì. */
  addonMonthlyVnd: number;
  /** Câu giải thích cho người bấm — vì sao kỳ bắt đầu từ ngày này, vì sao có / không có phần trừ. */
  explain: string;
};

/**
 * Báo giá MỘT lần gia hạn. Gói mới luôn có hiệu lực NGAY khi tiền về (đổi `platform_organizations.plan`); điều khác nhau
 * giữa các trường hợp là kỳ được trả BẮT ĐẦU từ đâu:
 *
 *  · Chưa từng trả / đã bị khoá        ⇒ từ HÔM NAY (không bắt trả cho những ngày đã bị khoá).
 *  · Quá hạn nhưng còn ân hạn          ⇒ nối tiếp ngay sau `paid_through` (những ngày ân hạn đã được dùng đủ).
 *  · Còn hạn, cùng giá / giá thấp hơn  ⇒ nối tiếp sau `paid_through` — không mất ngày nào đã trả.
 *  · Còn hạn, NÂNG lên gói giá cao hơn ⇒ từ HÔM NAY, trừ phần chưa dùng của gói cũ (giá cũ / 30 × số ngày còn lại, kể cả
 *    hôm nay, làm tròn xuống). Phần trừ phải NHỎ HƠN tiền gói mới — nếu không, chọn nhiều tháng hơn.
 *
 * Gói đang dùng không có giá (Dùng thử, gói cũ) ⇒ không có gì để trừ: những ngày còn lại là ngày dùng thử, kỳ nối tiếp.
 *
 * MUA THÊM (`lib/billing/addons.ts`): giá một tháng = giá gói + phần mua thêm theo bảng giá của CHÍNH gói đó — nơi gọi
 * tính sẵn `targetAddonMonthlyVnd` / `currentAddonMonthlyVnd` (thiếu = 0). Phép so nâng / hạ và phần trừ đều dùng TỔNG,
 * vì đó là số tiền khách thật sự trả mỗi tháng.
 */
export function quoteRenewal(input: { terms: SubscriptionTerms | null; currentPlan: PricedPlan | null; target: PricedPlan; months: number; today: string; targetAddonMonthlyVnd?: number; currentAddonMonthlyVnd?: number }): RenewalQuote | { error: string } {
  const { target, months, today } = input;
  if (target.priceVnd === null || !Number.isInteger(target.priceVnd) || target.priceVnd <= 0) return { error: `Gói «${target.name}» không bán — chọn một gói có giá.` };
  if (!(BILLING_MONTH_OPTIONS as readonly number[]).includes(months)) return { error: `Số tháng phải là một trong ${BILLING_MONTH_OPTIONS.join(" · ")}.` };
  const addonMonthly = Math.max(0, Math.trunc(input.targetAddonMonthlyVnd ?? 0));
  const list = (target.priceVnd + addonMonthly) * months;
  const standing = billingStanding(input.terms, today);
  const pt = input.terms?.paidThrough ?? null;
  const base = { planKey: target.key, months, listAmountVnd: list, addonMonthlyVnd: addonMonthly };

  const fromToday = (kind: RenewalKind, explain: string, credit = 0): RenewalQuote => ({ ...base, kind, periodStart: today, periodEnd: periodEndFor(today, months), creditVnd: credit, amountVnd: list - credit, explain });
  const afterPaid = (kind: RenewalKind, explain: string): RenewalQuote => {
    const start = addDays(pt!, 1);
    return { ...base, kind, periodStart: start, periodEnd: periodEndFor(start, months), creditVnd: 0, amountVnd: list, explain };
  };

  if (!pt || standing.kind === "LOCKED" || (standing.kind === "NOT_BILLED" && diffDays(pt, today) < 0)) {
    return fromToday("START", "Kỳ tính từ hôm nay.");
  }
  if (standing.kind === "OVERDUE") return afterPaid("RENEW", "Kỳ nối tiếp ngay sau ngày đã trả — những ngày ân hạn đã dùng nằm trong kỳ này.");

  // Còn hạn (hoặc chưa bật thu phí nhưng đã có ngày dùng thử còn lại).
  const current = input.currentPlan;
  const currentPrice = current?.priceVnd == null ? null : current.priceVnd + Math.max(0, Math.trunc(input.currentAddonMonthlyVnd ?? 0));
  if (!current || currentPrice === null || current.key === target.key) {
    const sameKind: RenewalKind = current?.key === target.key ? "RENEW" : "START";
    return afterPaid(sameKind, currentPrice === null ? "Những ngày dùng thử còn lại giữ nguyên; kỳ trả tiền bắt đầu sau đó." : "Kỳ nối tiếp sau ngày đã trả — không mất ngày nào.");
  }
  if (target.priceVnd + addonMonthly <= currentPrice) {
    return afterPaid("DOWNGRADE", "Kỳ nối tiếp sau ngày đã trả. Gói mới có hiệu lực ngay khi tiền về; những ngày còn lại của gói cũ không được quy đổi ra tiền.");
  }
  const remaining = diffDays(pt, today) + 1;
  const credit = Math.floor((currentPrice * remaining) / BILLING_DAYS_PER_MONTH);
  if (credit >= list) return { error: `Phần chưa dùng của gói «${current.name}» (${credit.toLocaleString("vi-VN")} ₫) không nhỏ hơn tiền gói mới cho ${months} tháng — chọn nhiều tháng hơn.` };
  return fromToday("UPGRADE", `Kỳ tính từ hôm nay; trừ ${remaining} ngày chưa dùng của gói «${current.name}».`, credit);
}

// ─────────────────────────── Mã chuyển khoản ───────────────────────────

/** Mã mới từ 6 số ngẫu nhiên 0..31 (truyền vào để hàm thuần — máy chủ dùng `crypto.getRandomValues`). */
export function transferCodeFrom(randoms: readonly number[]): string {
  if (randoms.length < 6) throw new Error("cần 6 số ngẫu nhiên");
  return TRANSFER_CODE_PREFIX + randoms.slice(0, 6).map((r) => CODE_ALPHABET[Math.abs(Math.trunc(r)) % CODE_ALPHABET.length]).join("");
}

/**
 * Mọi mã thanh toán trong nội dung một giao dịch. Ngân hàng có thể đổi chữ thường, chèn dấu cách / gạch / chấm, hay nối
 * thêm chữ phía sau — nên bỏ dấu, bỏ ký tự lạ, viết hoa rồi tìm `ERPHD` + đúng 6 ký tự.
 */
export function extractTransferCodes(description: string): string[] {
  const squashed = description
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "D")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "");
  const out: string[] = [];
  // Chỉ ký tự của bảng mã (không 0 · 1 · I · O): gộp chữ có thể dán phần chữ đi sau vào mã — «ERPHD12 THIẾU» không được
  // thành một mã. Mã giả vẫn có thể lọt (chữ đi sau toàn ký tự hợp lệ) — khi đó nó là `NO_INVOICE`, hiện cho người xem.
  const re = /ERPHD([2-9A-HJ-NP-Z]{6})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(squashed))) {
    const code = `${TRANSFER_CODE_PREFIX}${m[1]}`;
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

// ─────────────────────────── Phán quyết một khoản tiền vào ───────────────────────────

export type PaymentOutcome = "MATCHED" | "UNDERPAID" | "INVOICE_NOT_OPEN" | "NO_INVOICE";

export const PAYMENT_OUTCOME_LABEL: Record<PaymentOutcome, string> = {
  MATCHED: "Đã khớp — gia hạn",
  UNDERPAID: "Thiếu tiền — chưa gia hạn",
  INVOICE_NOT_OPEN: "Hoá đơn đã trả / đã huỷ",
  NO_INVOICE: "Không có hoá đơn mang mã này",
};

/**
 * Trả THỪA vẫn là khớp (khách chuyển tròn số) — số thực nhận ghi ở hoá đơn để người vận hành thấy. Trả THIẾU không gia
 * hạn: một phần kỳ là một quyết định, không phải phép chia — người vận hành xác nhận tay nếu đồng ý.
 */
export function judgePayment(amountVnd: number, invoice: { status: string; amountVnd: number } | null): PaymentOutcome {
  if (!invoice) return "NO_INVOICE";
  if (invoice.status !== "OPEN") return "INVOICE_NOT_OPEN";
  if (amountVnd < invoice.amountVnd) return "UNDERPAID";
  return "MATCHED";
}

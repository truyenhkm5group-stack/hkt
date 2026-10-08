/**
 * ═══════════ SỐ DƯ AI — LUẬT THUẦN (docs/saas/AI_BALANCE_V1.md) · client-safe ═══════════
 *
 * «Số dư AI» là tiền TRẢ TRƯỚC chỉ để dùng dịch vụ Chốt Đơn — KHÔNG phải ví điện tử: không chuyển giữa khách, không rút,
 * không dùng ngoài nền tảng. Số dư KHÔNG lưu thành một cột: nó là TỔNG các dòng sổ cái chỉ-ghi-thêm
 * (`platform_ai_ledger_entries`), nên luôn dựng lại được từ sổ và mọi đồng đều truy về một chứng từ.
 *
 * Quyết định chủ shop 08/10/2026 (bộ nhớ `so-du-ai-v1-quyet-dinh`): gói giữ phần khách AI gồm sẵn; khách AI VƯỢT phần gồm
 * trừ vào số dư theo giá vượt của gói; dùng thử phải chọn gói; hết số dư chỉ chặn khách AI MỚI. Tiền nạp đi cùng tài khoản
 * SePay thu thuê bao, mã chuyển khoản riêng `ERPNAP…`.
 *
 * Hai lớp tiền tách bạch cho kế toán: `CASH` (tiền khách thật sự chuyển) và `PROMO` (nền tảng tặng — không phải doanh thu).
 */

export const AI_LEDGER_ENTRY_TYPES = ["TOPUP", "PROMO_CREDIT", "AI_USAGE", "REFUND", "ADJUSTMENT", "EXPIRY"] as const;
export type AiLedgerEntryType = (typeof AI_LEDGER_ENTRY_TYPES)[number];

export const AI_FUNDS_CLASSES = ["CASH", "PROMO"] as const;
export type AiFundsClass = (typeof AI_FUNDS_CLASSES)[number];

/** Nguồn của một dòng sổ — `source_ref` trỏ vào đúng chứng từ của nguồn đó. */
export const AI_LEDGER_SOURCES = ["PAYMENT_INTENT", "BANK_PAYMENT", "AI_CUSTOMER", "OPERATOR", "SYSTEM"] as const;
export type AiLedgerSource = (typeof AI_LEDGER_SOURCES)[number];

export type AiLedgerDraft = { entryType: AiLedgerEntryType; fundsClass: AiFundsClass; amountVnd: number };

/**
 * Luật dấu của một dòng sổ — `null` = hợp lệ. Cùng một luật với ràng buộc `platform_ai_ledger_entries_sign_check` ở CSDL
 * (`tests/ai-balance.test.ts` so hai bên): nạp / tặng luôn DƯƠNG, dùng / hoàn / hết hạn luôn ÂM, điều chỉnh khác 0.
 */
export function ledgerEntryProblem(e: AiLedgerDraft): string | null {
  if (!(AI_LEDGER_ENTRY_TYPES as readonly string[]).includes(e.entryType)) return `Loại dòng sổ lạ: ${String(e.entryType)}`;
  if (!(AI_FUNDS_CLASSES as readonly string[]).includes(e.fundsClass)) return `Lớp tiền lạ: ${String(e.fundsClass)}`;
  if (!Number.isInteger(e.amountVnd) || e.amountVnd === 0) return "Số tiền phải là số nguyên khác 0";
  if (Math.abs(e.amountVnd) > AI_LEDGER_ENTRY_MAX_VND) return "Số tiền vượt trần một dòng sổ";
  switch (e.entryType) {
    case "TOPUP":
      return e.fundsClass === "CASH" && e.amountVnd > 0 ? null : "Nạp tiền phải là tiền thật (CASH) và dương";
    case "PROMO_CREDIT":
      return e.fundsClass === "PROMO" && e.amountVnd > 0 ? null : "Tặng thêm phải là lớp PROMO và dương";
    case "REFUND":
      return e.fundsClass === "CASH" && e.amountVnd < 0 ? null : "Hoàn tiền trả lại tiền thật (CASH) nên phải âm";
    case "AI_USAGE":
    case "EXPIRY":
      return e.amountVnd < 0 ? null : "Dùng / hết hạn làm giảm số dư nên phải âm";
    case "ADJUSTMENT":
      return null;
  }
}

/** Trần một dòng sổ — chặn gõ thừa số 0, không phải hạn mức kinh doanh. */
export const AI_LEDGER_ENTRY_MAX_VND = 1_000_000_000;

// ─────────────────────────── Nạp tiền ───────────────────────────

/** Mức gợi ý trên màn nạp tiền (chủ shop giao 08/10/2026). */
export const TOPUP_PRESETS_VND = [500_000, 1_000_000, 2_000_000, 5_000_000] as const;
/** Nhập số khác: sàn / trần một lần nạp. Trần chặn gõ thừa số 0 — muốn nạp nhiều hơn thì nạp nhiều lần. */
export const TOPUP_MIN_VND = 100_000;
export const TOPUP_MAX_VND = 50_000_000;
/** Phiếu nạp sống bao lâu (đồng hồ đếm ngược trên màn). Tiền tới SAU hạn vẫn được cộng — tiền không bao giờ biến mất. */
export const TOPUP_INTENT_TTL_MINUTES = 30;

/** Mã chuyển khoản của phiếu nạp: `ERPNAP` + 6 ký tự — cùng bảng chữ của mã thuê bao `ERPHD…` (không 0 · 1 · I · O). */
export const TOPUP_CODE_PREFIX = "ERPNAP";
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const TOPUP_CODE_PATTERN = /^ERPNAP[2-9A-HJ-NP-Z]{6}$/;

export function makeTopupCode(randoms: readonly number[]): string {
  return TOPUP_CODE_PREFIX + randoms.slice(0, 6).map((r) => CODE_ALPHABET[Math.abs(Math.trunc(r)) % CODE_ALPHABET.length]).join("");
}

/**
 * Mọi mã phiếu nạp trong nội dung một giao dịch ngân hàng. Ngân hàng có thể đổi chữ thường, chèn dấu cách / gạch / chấm
 * hay nối thêm chữ phía sau — nên bỏ dấu, bỏ ký tự lạ, viết hoa rồi tìm `ERPNAP` + đúng 6 ký tự của bảng mã (cùng cách
 * `extractTransferCodes` đọc mã thuê bao).
 */
export function extractTopupCodes(description: string): string[] {
  const squashed = description
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "D")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "");
  const out = new Set<string>();
  const re = /ERPNAP([2-9A-HJ-NP-Z]{6})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(squashed))) out.add(`${TOPUP_CODE_PREFIX}${m[1]}`);
  return [...out];
}

export type TopupAmountCheck = { ok: true; amountVnd: number } | { ok: false; error: string };

/**
 * Số tiền VND NGUYÊN gõ tay: «1.000.000» · «1,000,000» · «1000000» · «-500.000» (dấu chấm / phẩy chỉ được là phân cách nghìn,
 * đủ nhóm 3 chữ số). «1.000.000,5» / «1,5» / «abc» ⇒ `null` — đọc bỏ dấu sẽ biến 1.000.000,5 thành 10.000.005 (review 08/10/2026).
 */
export function parseVndInteger(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isSafeInteger(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const t = raw.replace(/\s+/g, "").replace(/(?:đ|₫|vnd)$/i, "");
  const m = /^(-?)(\d{1,3}(?:\.\d{3})+|\d{1,3}(?:,\d{3})+|\d+)$/.exec(t);
  if (!m) return null;
  const n = Number(`${m[1]}${m[2].replace(/[.,]/g, "")}`);
  return Number.isSafeInteger(n) ? n : null;
}

/** Số tiền khách chọn / gõ — số nguyên VND trong [sàn, trần]. */
export function parseTopupAmount(raw: unknown): TopupAmountCheck {
  const n = parseVndInteger(raw) ?? Number.NaN;
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "Chọn hoặc nhập số tiền muốn nạp." };
  if (n < TOPUP_MIN_VND) return { ok: false, error: `Nạp tối thiểu ${TOPUP_MIN_VND.toLocaleString("vi-VN")}đ.` };
  if (n > TOPUP_MAX_VND) return { ok: false, error: `Mỗi lần nạp tối đa ${TOPUP_MAX_VND.toLocaleString("vi-VN")}đ — muốn nạp nhiều hơn thì nạp nhiều lần.` };
  return { ok: true, amountVnd: n };
}

/** Trạng thái phiếu nạp. `EXPIRED` chỉ là nhãn hiển thị — tiền tới muộn vẫn được cộng (xem `topupOutcome`). */
export const TOPUP_INTENT_STATUSES = ["PENDING", "PAID", "EXPIRED", "CANCELLED"] as const;
export type TopupIntentStatus = (typeof TOPUP_INTENT_STATUSES)[number];

/** Mỗi tổ chức giữ tối đa bấy nhiêu phiếu nạp còn hạn cùng lúc — màn khách hỏi trạng thái từng phiếu, không để sinh vô hạn. */
export const TOPUP_PENDING_MAX = 3;

/** Kết quả ghi ở `platform_billing_payments` cho tiền nạp — tách khỏi tiền thuê bao ở mọi danh sách / bộ đếm. */
export const TOPUP_PAYMENT_OUTCOMES = ["TOPUP_CREDITED", "TOPUP_CREDITED_REVIEW", "TOPUP_HELD"] as const;
export type TopupPaymentOutcome = (typeof TOPUP_PAYMENT_OUTCOMES)[number];

/**
 * Phán quyết MỘT khoản tiền về mang mã phiếu nạp (review độc lập 08/10/2026, H1):
 *  · phiếu CHƯA được trả (PENDING — kể cả đã quá hạn hiển thị; CANCELLED) ⇒ cộng NGUYÊN số tiền thật nhận được, ĐÚNG MỘT lần
 *    (lượt cộng giành phiếu bằng câu UPDATE có điều kiện trong cùng giao dịch). Đúng số ⇒ `TOPUP_CREDITED`; lệch số / phiếu đã
 *    huỷ ⇒ `TOPUP_CREDITED_REVIEW` (đã cộng, người vận hành nhìn thấy);
 *  · phiếu ĐÃ được trả (PAID) ⇒ `TOPUP_HELD`: KHÔNG cộng. Máy không phân biệt được «khách chuyển lần hai thật» với «cùng một khoản
 *    tiền vào sổ ngân hàng hai lần» (sao kê nhập + webhook khác mã tham chiếu) — cộng là có thể sinh tiền không có thật. Tiền
 *    không mất: dòng nằm ở «cần xem lại», người vận hành cộng tay (có lý do + nhật ký) nếu là tiền thật.
 */
export function topupOutcome(intent: { status: TopupIntentStatus; amountVnd: number } | null, receivedVnd: number): TopupPaymentOutcome | "NO_INTENT" {
  if (!intent) return "NO_INTENT";
  if (intent.status === "PAID") return "TOPUP_HELD";
  if (intent.status === "PENDING" && intent.amountVnd === receivedVnd) return "TOPUP_CREDITED";
  return "TOPUP_CREDITED_REVIEW";
}

/** Nguồn của dòng `bank_transactions` do CHÍNH SePay tạo — webhook hoặc lượt quét API (`bank_txn_source_check`). */
export const SEPAY_ROW_SOURCES = ["WEBHOOK", "API"] as const;

/**
 * Dòng sổ ngân hàng của nhà có được TỰ cộng vào Số dư AI không (review 08/10/2026, H1). Chỉ khi SePay đã XÁC NHẬN dòng ấy
 * (webhook / lượt quét API — mang mã giao dịch SePay) VÀ tiền vào ĐÚNG tài khoản nhận đã khai:
 *  · `UNCONFIRMED` — dòng KHÔNG do SePay tạo (gõ tay / sao kê nhập), kể cả khi SePay điền mã giao dịch vào SAU: SePay chỉ điền ô
 *    còn rỗng, không bao giờ sửa SỐ TIỀN hay mô tả của dòng đã có — dòng ấy vẫn mang số tiền + mã nạp do người nhập dựng (review
 *    #650, N1 chiều ngược: nhập sao kê «ERPNAP…» 50 triệu trước khi khoản 10.000đ thật tới). KHÔNG tự cộng, KHÔNG ghi gì — nằm ở
 *    danh sách «chưa xác nhận» của người vận hành. Một người có quyền ghi sổ ngân hàng không được tự «nạp» cho khách;
 *  · `OTHER_ACCOUNT` — SePay xác nhận nhưng tiền vào tài khoản KHÁC tài khoản nhận ⇒ giữ lại chờ người vận hành;
 *  · `TRUSTED` — tự cộng.
 * HÀM THUẦN — so số tài khoản theo CHỮ SỐ (bỏ khoảng trắng / dấu).
 */
export function topupBankRowTrust(row: { provider: string; providerTxnId: string; account: string; source: string }, receiverAccount: string | null): "TRUSTED" | "UNCONFIRMED" | "OTHER_ACCOUNT" {
  if (!(SEPAY_ROW_SOURCES as readonly string[]).includes(row.source) || row.provider !== "SEPAY" || !row.providerTxnId.trim()) return "UNCONFIRMED";
  const digits = (v: string) => v.replace(/\D/g, "");
  if (!receiverAccount || !digits(row.account) || digits(row.account) !== digits(receiverAccount)) return "OTHER_ACCOUNT";
  return "TRUSTED";
}

/**
 * CÙNG luật cho tiền THUÊ BAO (`reconcileBillingPayments`, mã `ERPHD…`): một tài khoản SePay thu cả hai (chủ shop 08/10/2026), và
 * một người có quyền ghi sổ ngân hàng của nhà cũng không được tự «gia hạn» cho khách bằng một dòng gõ tay / sao kê dựng sẵn.
 */
export const paymentBankRowTrust = topupBankRowTrust;

// ─────────────────────────── Dự báo cho khách ───────────────────────────

export type BalanceForecast = {
  /** Chi tiêu trung bình mỗi ngày trong 7 ngày qua; `null` = chưa có chi tiêu nào (không dự báo được — khác 0). */
  avgDailyVnd: number | null;
  /** Số ngày còn chạy được với nhịp chi hiện tại; `null` = chưa dự báo được. */
  daysRemaining: number | null;
  /** Nạp thêm bao nhiêu để chạy tới cuối tháng (làm tròn lên mức gợi ý); `null` = không cần / chưa dự báo được. */
  recommendTopupVnd: number | null;
};

/** Dự báo THUẦN — chi 7 ngày (số dương) + số dư + số ngày còn lại của tháng. */
export function balanceForecast(input: { balanceVnd: number; spend7dVnd: number; daysToMonthEnd: number }): BalanceForecast {
  const spend = Math.max(0, Math.round(input.spend7dVnd));
  if (spend === 0) return { avgDailyVnd: null, daysRemaining: null, recommendTopupVnd: null };
  const avg = spend / 7;
  const daysRemaining = input.balanceVnd <= 0 ? 0 : Math.floor(input.balanceVnd / avg);
  const need = Math.ceil(avg * Math.max(0, input.daysToMonthEnd) - input.balanceVnd);
  const recommendTopupVnd = need <= 0 ? null : (TOPUP_PRESETS_VND.find((p) => p >= need) ?? Math.ceil(need / 100_000) * 100_000);
  return { avgDailyVnd: Math.round(avg), daysRemaining, recommendTopupVnd: recommendTopupVnd === null ? null : Math.max(recommendTopupVnd, TOPUP_MIN_VND) };
}

/** Ngưỡng cảnh báo số dư thấp mặc định khi khách chưa khai (gợi ý trong yêu cầu 08/10/2026). */
export const LOW_BALANCE_DEFAULT_VND = 300_000;

// ─────────────────────────── Nhãn cho khách — KHÔNG token / model / chi phí nhà cung cấp ───────────────────────────

export const AI_LEDGER_LABEL: Record<AiLedgerEntryType, string> = {
  TOPUP: "Nạp tiền",
  PROMO_CREDIT: "Được tặng",
  AI_USAGE: "AI xử lý khách",
  REFUND: "Hoàn tiền",
  ADJUSTMENT: "Điều chỉnh",
  EXPIRY: "Hết hạn",
};

export const TOPUP_STATUS_LABEL: Record<TopupIntentStatus, string> = {
  PENDING: "Chờ chuyển khoản",
  PAID: "Đã nhận tiền",
  EXPIRED: "Hết hạn",
  CANCELLED: "Đã huỷ",
};

// ─────────────────────────── Kinh tế đơn vị (người vận hành) ───────────────────────────

/**
 * Sổ cái Số dư AI của MỘT tổ chức trong một kỳ, cho khung doanh thu · chi phí · biên ở /platform. Ba loại tiền KHÔNG lẫn:
 *  · `usageCashVnd` — tiền THẬT khách đã dùng cho AI = doanh thu ghi nhận lúc dùng; `reversalCashVnd` — khoản trừ oan đã ĐẢO
 *    (loại điều chỉnh riêng `REVERSE_USAGE`) — trừ khỏi doanh thu (`aiBalanceRevenueVnd`);
 *  · `topupVnd` (nạp qua QR) / `adjustCashVnd` (điều chỉnh tiền thật của người vận hành) / `balanceCashVnd` — tiền khách đưa
 *    trước, còn giữ để phục vụ — CHƯA phải doanh thu;
 *  · `usagePromoVnd` / `balancePromoVnd` — tiền nền tảng TẶNG — doanh thu BỎ QUA, KHÔNG BAO GIỜ là doanh thu (chi phí thật của
 *    lượt AI ấy đã nằm ở `platform_ai_usage` — không cộng thêm lần hai);
 *  · `aiCustomerUnits` — SỐ khách AI đã thu qua Số dư trong kỳ (dòng `aic-charge`, kể cả khoản đã đảo): bảng kê / hoá đơn ước
 *    tính KHÔNG tính lại những khách này (`overageNetOfBalance`).
 * Số dương (đã đổi dấu từ sổ); số dư tính tới cuối kỳ đọc.
 */
export type AiBalancePeriod = {
  topupVnd: number;
  usageCashVnd: number;
  usagePromoVnd: number;
  reversalCashVnd: number;
  adjustCashVnd: number;
  aiCustomerUnits: number;
  balanceCashVnd: number;
  balancePromoVnd: number;
};

export const EMPTY_AI_BALANCE_PERIOD: AiBalancePeriod = { topupVnd: 0, usageCashVnd: 0, usagePromoVnd: 0, reversalCashVnd: 0, adjustCashVnd: 0, aiCustomerUnits: 0, balanceCashVnd: 0, balancePromoVnd: 0 };

/** Doanh thu Số dư AI của kỳ = tiền THẬT đã dùng − khoản trừ oan đã đảo. Không có sổ ⇒ 0 THẬT (chưa dùng thì không thu). */
export function aiBalanceRevenueVnd(b: AiBalancePeriod | null): number {
  return b ? b.usageCashVnd - b.reversalCashVnd : 0;
}

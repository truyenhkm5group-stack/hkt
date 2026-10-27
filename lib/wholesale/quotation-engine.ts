/**
 * ═══════════ BÁO GIÁ SỈ — BỘ TÍNH TẤT ĐỊNH (HÀM THUẦN, client-safe) — docs/tech/hslc-b2b-sales-agent.md · P1b ═══════════
 *
 * LLM KHÔNG BAO GIỜ tính tiền (quyết định D5). Mọi con số trên một báo giá sỉ đi qua đúng một hàm: `computeQuotation`. Nó
 * không đọc CSDL, không đọc đồng hồ, không băm bằng thư viện máy chủ — cùng đầu vào ⇒ cùng kết quả, kể cả mã phiên bản giá.
 *
 * Đơn giá chọn bằng ĐÚNG `quoteUnitPrice` (lib/constants/price-lists.ts) — hàm mà form đơn tay, lõi đơn agent
 * (`agentUnitQuote`) và chatbot đang dùng: bảng của khách → bảng mặc định → giá lẻ. Báo giá SỈ chỉ nhận hai nguồn đầu: dòng
 * rơi về GIÁ LẺ (hoặc không có giá) là CHẶN, vì giá lẻ không phải giá sỉ (D6) — không có bộ tính giá thứ hai ở đây.
 *
 * Ba trạng thái không gộp (AGENTS.md luật 42): tồn CHƯA BIẾT (chưa có phiếu nhập) ⇒ cảnh báo «chưa xác minh tồn», KHÔNG chặn
 * và KHÔNG coi là 0; giá vốn chưa biết ⇒ biên lợi nhuận `null`, KHÔNG phải 0%; ship / thuế chưa khai ⇒ để trống + cảnh báo
 * «chưa có», KHÔNG bịa một con số.
 *
 * Chính sách chiết khấu (`settings["wholesale.quotation"]`) là QUYẾT ĐỊNH KINH DOANH (luật 38): không có trần mặc định gõ cứng.
 * Chưa khai trần % hoặc sàn biên lợi nhuận ⇒ MỌI chiết khấu > 0 đều cần người duyệt. Vượt trần đã khai ⇒ CHẶN.
 */
import { quoteUnitPrice, type PriceListBook, type PriceSource } from "@/lib/constants/price-lists";

// ─────────────────────────── Hằng số & chính sách ───────────────────────────

export const QUOTATION_SETTING_KEY = "wholesale.quotation";

/** Tiền tệ báo giá. ERP CHƯA có nguồn tỷ giá có hiệu lực + căn cứ ⇒ chỉ VND (CHECK ở CSDL). Thêm tiền tệ = thêm nguồn tỷ giá trước. */
export const QUOTATION_CURRENCIES = ["VND"] as const;
export type QuotationCurrency = (typeof QUOTATION_CURRENCIES)[number];

/** Incoterms® 2020 — chỉ ghi khi người lập KHAI, máy không suy điều kiện giao hàng. */
export const INCOTERMS = ["EXW", "FCA", "CPT", "CIP", "DAP", "DPU", "DDP", "FAS", "FOB", "CFR", "CIF"] as const;
export type Incoterm = (typeof INCOTERMS)[number];

export const QUOTATION_LIMITS = { maxLines: 200, maxQuantity: 100_000, maxAmount: 1_000_000_000_000, notesMax: 2000, sourceMax: 300, reasonMax: 1000 } as const;

/**
 * Chính sách báo giá của tổ chức. `null` = CHƯA KHAI (không phải 0). Thuế chỉ có hiệu lực khi có CẢ thuế suất lẫn căn cứ —
 * một con số không ai nói lấy từ đâu thì không được in lên giấy gửi khách.
 */
export type QuotationPolicy = {
  maxDiscountPercent: number | null;
  minMarginPercent: number | null;
  taxRatePercent: number | null;
  taxSource: string | null;
};

const pctOrNull = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null);
const textOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, QUOTATION_LIMITS.sourceMax) : null);

/** Đọc chính sách từ giá trị `settings` THÔ. Ô sai kiểu / ngoài khoảng ⇒ `null` (chưa khai), không ép một số mặc định. */
export function parseQuotationPolicy(raw: unknown): QuotationPolicy {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const taxRate = pctOrNull(o.taxRatePercent, 0, 100);
  const taxSource = textOrNull(o.taxSource);
  return {
    maxDiscountPercent: pctOrNull(o.maxDiscountPercent, 0, 100),
    minMarginPercent: pctOrNull(o.minMarginPercent, -100, 100),
    taxRatePercent: taxRate !== null && taxSource ? taxRate : null,
    taxSource: taxRate !== null && taxSource ? taxSource : null,
  };
}

// ─────────────────────────── Đầu vào ───────────────────────────

/** Một mẫu mã đã đọc sẵn từ CSDL (lib/wholesale/quotation.ts). `exists = false` ⇒ không có / đã gỡ. */
export type EngineVariant = {
  variantId: string;
  name: string;
  sku: string;
  exists: boolean;
  retailPrice: number | null;
  /** Sổ kho `stockKnownExpr` — `false` = chưa có phiếu nhập ⇒ tồn CHƯA BIẾT. */
  stockKnown: boolean;
  /** `availableStockExpr` — chỉ có nghĩa khi `stockKnown`. */
  available: number | null;
  /** Giá vốn sống (luật 3.13, `liveLineUnitCost`) — `null` = chưa biết. */
  unitCost: number | null;
  costSource: string | null;
  /** Khối lượng một đơn vị (gram) — `null` / ≤ 0 = chưa nhập. */
  weightGrams: number | null;
};

export type EngineLineInput = { variantId: string; quantity: number; lineDiscount?: number };

export type QuotationEngineInput = {
  party: { leadId: string | null; customerId: string | null };
  books: { customerList: PriceListBook | null; defaultList: PriceListBook | null };
  lines: readonly EngineLineInput[];
  variants: ReadonlyMap<string, EngineVariant>;
  /** Chiết khấu cả báo giá (đồng) — ngoài chiết khấu từng dòng. */
  quoteDiscount: number;
  /** Phí ship NHẬP TAY có căn cứ; `null` = chưa khai. */
  shipping: { amount: number; source: string } | null;
  policy: QuotationPolicy;
};

// ─────────────────────────── Đầu ra ───────────────────────────

export const BLOCKER_CODES = ["NO_PARTY", "EMPTY", "TOO_MANY_LINES", "DUPLICATE_LINE", "UNKNOWN_VARIANT", "BAD_QUANTITY", "BAD_AMOUNT", "NO_WHOLESALE_PRICE", "BELOW_MOQ", "STOCK_SHORT", "NEGATIVE_TOTAL", "DISCOUNT_OVER_CAP", "SHIPPING_NO_SOURCE"] as const;
export type BlockerCode = (typeof BLOCKER_CODES)[number];
export const WARNING_CODES = ["STOCK_UNVERIFIED", "SHIPPING_MISSING", "TAX_MISSING", "COST_UNKNOWN", "WEIGHT_MISSING"] as const;
export type WarningCode = (typeof WARNING_CODES)[number];
export const APPROVAL_CODES = ["DISCOUNT_CAP_UNDECLARED", "MARGIN_FLOOR_UNDECLARED", "MARGIN_UNKNOWN", "MARGIN_BELOW_FLOOR"] as const;
export type ApprovalCode = (typeof APPROVAL_CODES)[number];

export type QuotationIssue<C extends string> = { code: C; line: number | null; message: string };

export type QuotationLineResult = {
  lineNo: number;
  variantId: string;
  name: string;
  sku: string;
  quantity: number;
  /** `null` = không có giá sỉ ở bảng hiệu lực (dòng bị chặn). */
  unitPrice: number | null;
  priceSource: Exclude<PriceSource, "RETAIL"> | null;
  priceListId: string | null;
  priceListName: string | null;
  /** Bậc «mua từ» đã áp. */
  tierMinQty: number | null;
  /** MOQ = bậc «mua từ» nhỏ nhất của mẫu mã trong các bảng hiệu lực; `null` = không có bậc. */
  moq: number | null;
  lineDiscount: number;
  /** Đơn giá × SL − chiết khấu dòng; `null` khi chưa có giá. */
  lineTotal: number | null;
  stockKnown: boolean;
  /** Tồn khả dụng lúc báo giá — `null` = CHƯA BIẾT (không phải 0). */
  stockAvailable: number | null;
  unitCost: number | null;
  warnings: string[];
};

export type QuotationTotals = {
  /** Σ đơn giá × số lượng (trước chiết khấu) của các dòng CÓ giá. */
  subtotal: number;
  /** Σ chiết khấu dòng + chiết khấu cả báo giá. */
  discount: number;
  /** `null` = chưa khai ⇒ tổng CHƯA gồm vận chuyển. */
  shipping: number | null;
  /** `null` = chưa khai thuế suất có căn cứ ⇒ tổng CHƯA gồm thuế. */
  tax: number | null;
  total: number;
};

export type QuotationResult = {
  lines: QuotationLineResult[];
  totals: QuotationTotals;
  /** Chiết khấu / tiền hàng × 100; `null` khi tiền hàng = 0. */
  discountPercent: number | null;
  /** Giá vốn cả báo giá — `null` khi CÒN một dòng chưa biết giá vốn (thiếu một phần = chưa biết). */
  cogs: number | null;
  /** (Tiền hàng sau chiết khấu − giá vốn) / tiền hàng sau chiết khấu × 100; `null` = chưa biết. */
  marginPercent: number | null;
  taxRatePercent: number | null;
  taxSource: string | null;
  blockers: QuotationIssue<BlockerCode>[];
  warnings: QuotationIssue<WarningCode>[];
  requiresApproval: boolean;
  /** Lý do cần duyệt (rỗng khi không cần). */
  reasons: QuotationIssue<ApprovalCode>[];
  /** Bảng giá đứng tên trên báo giá: bảng của khách nếu có dòng lấy giá từ đó, không thì bảng mặc định. */
  priceListId: string | null;
  /** Dấu phiên bản bảng giá — băm tất định các bậc của mẫu mã có mặt trong báo giá. Đổi một bậc ⇒ đổi dấu. */
  priceVersion: string;
};

// ─────────────────────────── Phép tính ───────────────────────────

const isAmount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= QUOTATION_LIMITS.maxAmount;
const round2 = (n: number) => Math.round(n * 100) / 100;
const vnd = (n: number) => `${n.toLocaleString("vi-VN")} ₫`;

/** FNV-1a 32 bit — băm THUẦN (client-safe), đủ để dấu phiên bản đổi khi một bậc đổi. Không phải băm mật mã. */
function fnv1a(text: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Dấu phiên bản bảng giá cho một tập mẫu mã — HÀM THUẦN, không phụ thuộc thứ tự dòng hay thứ tự bậc. */
export function priceVersionOf(books: QuotationEngineInput["books"], variantIds: readonly string[]): string {
  const ids = [...new Set(variantIds)].sort();
  const part = (b: PriceListBook | null, tag: string) =>
    b
      ? `${tag}:${b.id}:${ids
          .map((v) =>
            b.tiers
              .filter((t) => t.variantId === v)
              .map((t) => `${v}@${t.minQuantity}=${t.unitPrice}`)
              .sort()
              .join(","),
          )
          .join(";")}`
      : `${tag}:-`;
  const text = `${part(books.customerList, "C")}|${part(books.defaultList, "D")}`;
  return `pv1-${fnv1a(text, 0x811c9dc5)}${fnv1a(text, 0x9747b28c)}`;
}

/** MOQ của một mẫu mã trong các bảng hiệu lực — bậc «mua từ» nhỏ nhất; `null` = không có bậc nào. */
export function moqOf(books: QuotationEngineInput["books"], variantId: string): number | null {
  const lists = [books.customerList, books.defaultList].filter((b): b is PriceListBook => b !== null);
  let moq: number | null = null;
  for (const b of lists) for (const t of b.tiers) if (t.variantId === variantId && (moq === null || t.minQuantity < moq)) moq = t.minQuantity;
  return moq;
}

/** Kết quả báo giá — HÀM THUẦN. Không ném: mọi vấn đề thành `blockers` / `warnings` / `reasons`. */
export function computeQuotation(input: QuotationEngineInput): QuotationResult {
  const blockers: QuotationIssue<BlockerCode>[] = [];
  const warnings: QuotationIssue<WarningCode>[] = [];
  const reasons: QuotationIssue<ApprovalCode>[] = [];
  const block = (code: BlockerCode, message: string, line: number | null = null) => blockers.push({ code, line, message });
  const warn = (code: WarningCode, message: string, line: number | null = null) => warnings.push({ code, line, message });

  if (!input.party.leadId && !input.party.customerId) block("NO_PARTY", "Báo giá phải gắn với một lead hoặc một khách hàng.");
  if (input.lines.length === 0) block("EMPTY", "Báo giá chưa có dòng hàng nào.");
  if (input.lines.length > QUOTATION_LIMITS.maxLines) block("TOO_MANY_LINES", `Một báo giá tối đa ${QUOTATION_LIMITS.maxLines} dòng.`);

  const seen = new Set<string>();
  const lines: QuotationLineResult[] = input.lines.slice(0, QUOTATION_LIMITS.maxLines).map((l, i) => {
    const lineNo = i + 1;
    const lineWarnings: string[] = [];
    const v = input.variants.get(l.variantId);
    const qtyOk = Number.isSafeInteger(l.quantity) && l.quantity >= 1 && l.quantity <= QUOTATION_LIMITS.maxQuantity;
    const quantity = qtyOk ? l.quantity : 0;
    const lineDiscount = l.lineDiscount ?? 0;
    if (!qtyOk) block("BAD_QUANTITY", `Dòng ${lineNo}: số lượng là số nguyên từ 1 tới ${QUOTATION_LIMITS.maxQuantity.toLocaleString("vi-VN")}.`, lineNo);
    if (!isAmount(lineDiscount)) block("BAD_AMOUNT", `Dòng ${lineNo}: chiết khấu dòng là số tiền nguyên không âm (đồng).`, lineNo);
    if (seen.has(l.variantId)) block("DUPLICATE_LINE", `Dòng ${lineNo}: mẫu mã đã có ở dòng trước — gộp số lượng vào một dòng (bậc giá đi theo tổng số lượng).`, lineNo);
    seen.add(l.variantId);

    const base: QuotationLineResult = {
      lineNo,
      variantId: l.variantId,
      name: v?.name ?? "",
      sku: v?.sku ?? "",
      quantity,
      unitPrice: null,
      priceSource: null,
      priceListId: null,
      priceListName: null,
      tierMinQty: null,
      moq: moqOf(input.books, l.variantId),
      lineDiscount: isAmount(lineDiscount) ? lineDiscount : 0,
      lineTotal: null,
      stockKnown: Boolean(v?.stockKnown),
      stockAvailable: v?.stockKnown && v.available !== null && Number.isFinite(v.available) ? Math.trunc(v.available) : null,
      unitCost: v?.unitCost ?? null,
      warnings: lineWarnings,
    };
    if (!v || !v.exists) {
      block("UNKNOWN_VARIANT", `Dòng ${lineNo}: mẫu mã không còn trong danh mục.`, lineNo);
      return base;
    }
    if (!qtyOk) return base;

    // ĐÚNG hàm chọn giá của mọi đường đặt giá. Rơi về giá lẻ ⇒ không phải giá sỉ ⇒ chặn.
    const q = quoteUnitPrice({ variantId: v.variantId, quantity, retailPrice: v.retailPrice, customerList: input.books.customerList, defaultList: input.books.defaultList });
    if (!q || q.source === "RETAIL") {
      if (base.moq !== null && quantity < base.moq) block("BELOW_MOQ", `Dòng ${lineNo} (${v.name}): ${quantity.toLocaleString("vi-VN")} dưới MOQ ${base.moq.toLocaleString("vi-VN")} của bảng giá sỉ.`, lineNo);
      else block("NO_WHOLESALE_PRICE", `Dòng ${lineNo} (${v.name}): không có giá sỉ trong bảng giá hiệu lực — giá lẻ không phải giá sỉ.`, lineNo);
      return base;
    }
    const list = q.source === "CUSTOMER_LIST" ? input.books.customerList : input.books.defaultList;
    const gross = q.unitPrice * quantity;
    const lineTotal = gross - base.lineDiscount;
    if (lineTotal < 0) block("NEGATIVE_TOTAL", `Dòng ${lineNo}: chiết khấu dòng (${vnd(base.lineDiscount)}) lớn hơn tiền hàng của dòng (${vnd(gross)}).`, lineNo);

    if (!v.stockKnown || base.stockAvailable === null) {
      lineWarnings.push("Chưa xác minh tồn (chưa có phiếu nhập) — không phải hết hàng.");
      warn("STOCK_UNVERIFIED", `Dòng ${lineNo} (${v.name}): chưa xác minh tồn — sổ kho chưa có phiếu nhập; nhân viên kiểm trước khi hứa giao.`, lineNo);
    } else if (base.stockAvailable < quantity) {
      block("STOCK_SHORT", `Dòng ${lineNo} (${v.name}): tồn khả dụng ${base.stockAvailable.toLocaleString("vi-VN")} < ${quantity.toLocaleString("vi-VN")} cần báo.`, lineNo);
    }
    if (v.unitCost === null) {
      lineWarnings.push("Chưa biết giá vốn.");
      warn("COST_UNKNOWN", `Dòng ${lineNo} (${v.name}): chưa biết giá vốn — biên lợi nhuận của báo giá là «chưa biết».`, lineNo);
    }
    if (v.weightGrams === null || !(v.weightGrams > 0)) {
      lineWarnings.push("Chưa nhập khối lượng — chưa tính được cước.");
      warn("WEIGHT_MISSING", `Dòng ${lineNo} (${v.name}): chưa nhập khối lượng — chưa tính được cước vận chuyển.`, lineNo);
    }
    return { ...base, unitPrice: q.unitPrice, priceSource: q.source, priceListId: list?.id ?? null, priceListName: q.listName, tierMinQty: q.minQuantity, lineTotal };
  });

  const priced = lines.filter((l) => l.unitPrice !== null);
  const subtotal = priced.reduce((s, l) => s + (l.unitPrice as number) * l.quantity, 0);
  const lineDiscounts = priced.reduce((s, l) => s + l.lineDiscount, 0);
  const quoteDiscount = isAmount(input.quoteDiscount) ? input.quoteDiscount : 0;
  if (!isAmount(input.quoteDiscount)) block("BAD_AMOUNT", "Chiết khấu cả báo giá là số tiền nguyên không âm (đồng).");
  const discount = lineDiscounts + quoteDiscount;
  const net = subtotal - discount;

  let shipping: number | null = null;
  if (input.shipping === null) warn("SHIPPING_MISSING", "Chưa có phí vận chuyển — tổng CHƯA gồm ship (nhập phí kèm căn cứ khi đã có báo giá cước).");
  else if (!isAmount(input.shipping.amount)) block("BAD_AMOUNT", "Phí vận chuyển là số tiền nguyên không âm (đồng).");
  else if (!input.shipping.source.trim()) block("SHIPPING_NO_SOURCE", "Phí vận chuyển phải kèm căn cứ (vd báo giá cước của đơn vị vận chuyển) — không in một con số không nguồn.");
  else shipping = input.shipping.amount;

  const { taxRatePercent, taxSource } = input.policy;
  const tax = taxRatePercent !== null && net >= 0 ? Math.round((net * taxRatePercent) / 100) : null;
  if (taxRatePercent === null) warn("TAX_MISSING", "Chưa có thuế suất có căn cứ trong cấu hình báo giá — giá trên báo giá CHƯA gồm thuế.");

  const total = net + (shipping ?? 0) + (tax ?? 0);
  if (net < 0 || total < 0) block("NEGATIVE_TOTAL", `Tổng âm: chiết khấu (${vnd(discount)}) lớn hơn tiền hàng (${vnd(subtotal)}).`);

  const discountPercent = subtotal > 0 ? round2((discount / subtotal) * 100) : null;
  // Biên lợi nhuận chỉ khi MỌI dòng có giá và có giá vốn — một dòng chưa biết thì cả báo giá chưa biết (không cộng nửa vời).
  const allCostKnown = priced.length > 0 && priced.length === lines.length && priced.every((l) => l.unitCost !== null);
  const cogs = allCostKnown ? priced.reduce((s, l) => s + Math.round((l.unitCost as number) * l.quantity), 0) : null;
  const marginPercent = cogs !== null && net > 0 ? round2(((net - cogs) / net) * 100) : null;

  // Chiết khấu: vượt trần đã khai ⇒ CHẶN; mọi trường hợp «không chứng minh được là trong chính sách» ⇒ CẦN DUYỆT.
  if (discount > 0) {
    const { maxDiscountPercent, minMarginPercent } = input.policy;
    if (maxDiscountPercent === null) reasons.push({ code: "DISCOUNT_CAP_UNDECLARED", line: null, message: "Chủ shop chưa khai trần chiết khấu (%) — mọi chiết khấu cần người duyệt." });
    else if (discountPercent !== null && discountPercent > maxDiscountPercent) block("DISCOUNT_OVER_CAP", `Chiết khấu ${discountPercent}% vượt trần ${maxDiscountPercent}% chủ shop đã khai.`);
    if (minMarginPercent === null) reasons.push({ code: "MARGIN_FLOOR_UNDECLARED", line: null, message: "Chủ shop chưa khai biên lợi nhuận tối thiểu — chiết khấu cần người duyệt." });
    else if (marginPercent === null) reasons.push({ code: "MARGIN_UNKNOWN", line: null, message: "Chưa biết giá vốn của mọi dòng ⇒ biên lợi nhuận chưa biết — chiết khấu cần người duyệt." });
    else if (marginPercent < minMarginPercent) reasons.push({ code: "MARGIN_BELOW_FLOOR", line: null, message: `Biên lợi nhuận sau chiết khấu ${marginPercent}% dưới sàn ${minMarginPercent}% — cần người duyệt.` });
  }

  const priceListId = priced.find((l) => l.priceSource === "CUSTOMER_LIST")?.priceListId ?? priced.find((l) => l.priceSource === "DEFAULT_LIST")?.priceListId ?? null;
  return {
    lines,
    totals: { subtotal, discount, shipping, tax, total },
    discountPercent,
    cogs,
    marginPercent,
    taxRatePercent: tax === null ? null : taxRatePercent,
    taxSource: tax === null ? null : taxSource,
    blockers,
    warnings,
    requiresApproval: reasons.length > 0,
    reasons,
    priceListId,
    priceVersion: priceVersionOf(input.books, input.lines.map((l) => l.variantId)),
  };
}

// ─────────────────────────── Trạng thái ───────────────────────────

export const QUOTATION_STATUSES = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENT", "ACCEPTED", "REJECTED", "EXPIRED", "SUPERSEDED"] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];
export const QUOTATION_STATUS_LABEL: Record<QuotationStatus, string> = {
  DRAFT: "Nháp",
  PENDING_APPROVAL: "Chờ duyệt",
  APPROVED: "Đã duyệt",
  SENT: "Đã gửi khách",
  ACCEPTED: "Khách chấp nhận",
  REJECTED: "Khách từ chối",
  EXPIRED: "Hết hạn",
  SUPERSEDED: "Đã có bản mới",
};
export const isQuotationStatus = (s: string): s is QuotationStatus => (QUOTATION_STATUSES as readonly string[]).includes(s);

/** Trạng thái còn «sống» — quá hạn hiệu lực thì đọc ra là HẾT HẠN. */
const EXPIRABLE: readonly QuotationStatus[] = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENT"];

/**
 * Trạng thái HIỆU LỰC lúc đọc: báo giá còn sống mà ngày hôm nay (giờ VN, `todayKey` dạng YYYY-MM-DD) đã qua `validUntil` ⇒
 * `EXPIRED`. TÍNH LÚC ĐỌC, không ghi đè cột `status` — lịch sử (đã gửi lúc nào, ai duyệt) giữ nguyên. Ngày hiệu lực là NGÀY CUỐI
 * còn hiệu lực (hết ngày đó mới hết hạn).
 */
export function effectiveQuotationStatus(status: string, validUntil: string, todayKey: string): QuotationStatus {
  const s = isQuotationStatus(status) ? status : "DRAFT";
  return EXPIRABLE.includes(s) && validUntil < todayKey ? "EXPIRED" : s;
}

/** Sửa được (tạo phiên bản mới) từ trạng thái nào. Khách đã chấp nhận / đã có bản mới ⇒ không. */
export const REVISABLE_STATUSES: readonly QuotationStatus[] = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENT", "REJECTED", "EXPIRED"];

/**
 * ═══════════ CỔNG SẴN SÀNG DANH MỤC BÁN SỈ + SẴN SÀNG XUẤT KHẨU — HÀM THUẦN, client-safe ═══════════
 *
 * (docs/tech/hslc-b2b-sales-agent.md · khối P1c). CHỈ ĐỌC — không bảng mới, không ghi gì. Trả lời một câu hỏi trước khi
 * cho AI B2B báo giá: «mẫu mã này đã đủ dữ kiện để báo giá sỉ ĐÚNG chưa, và nếu chưa thì thiếu ĐÚNG cái gì?».
 *
 * Bậc giá đọc ở BẢNG MẶC ĐỊNH đang bật, không phải «bảng nào cũng được»: khách sỉ mới từ lead CHƯA được gán bảng riêng, và
 * đường agent khi danh tính chưa xác minh chạy chế độ `DEFAULT_BOOK` (lib/commerce/pricing.ts) — bảng mặc định → giá lẻ.
 * Mẫu mã chỉ có bậc ở một bảng riêng thì khách mới nhận GIÁ LẺ, nên với AI B2B nó CHƯA sẵn sàng.
 *
 * Ba trạng thái không gộp (luật 42): tồn CHƯA BIẾT (chưa có phiếu nhập) khác tồn 0; khối lượng 0 trong cột `weight` là
 * CHƯA NHẬP, không phải 0 gram; hạng mục xuất khẩu mà ERP KHÔNG CÓ NGUỒN là `UNAVAILABLE` kèm `missingWhat` — không suy,
 * không bịa, và cổng xuất khẩu không bao giờ «sẵn sàng» khi còn một hạng mục như vậy.
 */

// ─────────────────────────── Nguồn field tuỳ biến (khoá do mẫu ngành khai, không đoán) ───────────────────────────

/**
 * Field sản phẩm được coi là MÔ TẢ cho người mua sỉ — đúng các khoá mà mẫu ngành có sẵn khai ở `meta_custom_fields`
 * (`lib/blueprints/templates/food-commerce.ts` · `seafood-commerce.ts`). Tổ chức không khai khoá nào trong số này thì ERP
 * KHÔNG CÓ chỗ để đọc mô tả — mô tả thiếu, kèm lý do «chưa khai field», không phải đi đoán một khoá khác.
 */
export const DESCRIPTION_FIELD_KEYS = ["package_size", "net_weight", "selling_unit", "food_category", "usage_instruction", "dang_hang", "co_size", "don_vi_ban", "vung_nguon"] as const;
/** Field BẢO QUẢN — `storage_instruction` (mẫu thực phẩm) · `bao_quan` (mẫu hải sản). */
export const STORAGE_FIELD_KEYS = ["storage_instruction", "bao_quan"] as const;

// ─────────────────────────── Kiểm danh mục bán sỉ ───────────────────────────

export const CATALOG_CHECKS = ["PRICE_TIER", "MOQ", "WEIGHT", "IMAGE", "DESCRIPTION", "STOCK"] as const;
export type CatalogCheck = (typeof CATALOG_CHECKS)[number];
export const CATALOG_CHECK_LABEL: Record<CatalogCheck, string> = {
  PRICE_TIER: "Bậc giá sỉ",
  MOQ: "MOQ",
  WEIGHT: "Khối lượng",
  IMAGE: "Ảnh",
  DESCRIPTION: "Mô tả",
  STOCK: "Tồn kho",
};

export type ReadinessStatus = "READY" | "MISSING";
export const READINESS_STATUS_LABEL: Record<ReadinessStatus, string> = { READY: "Sẵn sàng bán sỉ", MISSING: "Còn thiếu" };

export type TierLite = { minQuantity: number; unitPrice: number };

/** Một mẫu mã ĐANG BÁN, đã đọc sẵn mọi dữ kiện (truy vấn ở lib/queries/wholesale-readiness.ts). */
export type ReadinessVariantInput = {
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  variantLabel: string;
  addOnOnly: boolean;
  /** Cột `product_variants.weight` (gram) THÔ — 0 / âm / null = CHƯA NHẬP. */
  weightGrams: number | null;
  /** Ảnh mẫu mã đầu tiên, rơi về ảnh sản phẩm; `null` / rỗng = không có ảnh. */
  imageUrl: string | null;
  /** Bậc giá của mẫu mã trong BẢNG MẶC ĐỊNH đang bật (rỗng = không có bậc hoặc không có bảng mặc định). */
  defaultTiers: readonly TierLite[];
  /** Tên các bảng giá ĐANG BẬT khác (không phải mặc định) có bậc cho mẫu mã — chỉ để nói vì sao vẫn thiếu. */
  otherListNames: readonly string[];
  /** `stockKnownExpr` của sổ kho — `false` = chưa có phiếu nhập nào ⇒ tồn CHƯA BIẾT. */
  stockKnown: boolean;
  onHand: number | null;
  available: number | null;
  /** NHÃN các field mô tả có chữ (đã lọc theo field tổ chức đang khai). */
  descriptionFields: readonly string[];
  /** Có chữ ở field bảo quản không — `null` khi tổ chức KHÔNG khai field bảo quản nào (không có nguồn). */
  storageFilled: boolean | null;
  /** Lô khai hạn dùng (`stock_lots`) của mẫu mã. */
  lotCount: number;
  lotEarliestExpiry: string | null;
  lotLatestExpiry: string | null;
};

/** Ngữ cảnh chung của tổ chức — đọc một lần cho cả danh mục. */
export type ReadinessSources = {
  /** Tên bảng giá mặc định đang bật; `null` = tổ chức chưa có bảng mặc định nào. */
  defaultListName: string | null;
  /** Khoá field mô tả / bảo quản tổ chức đang khai (ACTIVE) trong `meta_custom_fields`. */
  descriptionFieldKeys: readonly string[];
  storageFieldKeys: readonly string[];
};

export type MissingItem = { key: CatalogCheck; label: string; detail: string };

export type VariantReadiness = {
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  variantLabel: string;
  addOnOnly: boolean;
  status: ReadinessStatus;
  missing: MissingItem[];
  /** Cảnh báo KHÔNG chặn (vd tồn đã biết mà hết hàng khả dụng) — dữ kiện đủ, nhưng hôm nay chưa bán được. */
  warnings: string[];
  /** Bậc nhỏ nhất của bảng mặc định — `null` = chưa có (KHÔNG phải MOQ 0). */
  moq: number | null;
  /** Đơn giá ở bậc MOQ. */
  moqUnitPrice: number | null;
  tierCount: number;
  weightGrams: number | null;
  hasImage: boolean;
  imageUrl: string | null;
  descriptionFields: readonly string[];
  stockKnown: boolean;
  onHand: number | null;
  available: number | null;
  storageFilled: boolean | null;
  lotCount: number;
  lotEarliestExpiry: string | null;
  lotLatestExpiry: string | null;
};

const intOrNull = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null);

/** Kết luận cho MỘT mẫu mã. HÀM THUẦN: cùng đầu vào ⇒ cùng kết quả. */
export function evaluateVariantReadiness(v: ReadinessVariantInput, src: ReadinessSources): VariantReadiness {
  const missing: MissingItem[] = [];
  const warnings: string[] = [];
  const add = (key: CatalogCheck, detail: string) => missing.push({ key, label: CATALOG_CHECK_LABEL[key], detail });

  const tiers = v.defaultTiers.filter((t) => Number.isSafeInteger(t.minQuantity) && t.minQuantity >= 1 && Number.isSafeInteger(t.unitPrice) && t.unitPrice > 0);
  const moqTier = tiers.reduce<TierLite | null>((best, t) => (!best || t.minQuantity < best.minQuantity ? t : best), null);

  if (!src.defaultListName) add("PRICE_TIER", "Tổ chức chưa có bảng giá MẶC ĐỊNH đang bật — khách sỉ mới (chưa gán bảng) chỉ nhận giá lẻ.");
  else if (!moqTier)
    add(
      "PRICE_TIER",
      v.otherListNames.length
        ? `Có bậc ở bảng «${v.otherListNames.join("», «")}» nhưng KHÔNG có ở bảng mặc định «${src.defaultListName}» — khách sỉ mới (chưa gán bảng) sẽ nhận giá lẻ.`
        : `Chưa có bậc giá nào ở bảng mặc định «${src.defaultListName}».`,
    );
  if (!moqTier) add("MOQ", "MOQ = bậc «mua từ» nhỏ nhất của bảng mặc định — chưa có bậc nên chưa có MOQ.");

  const weight = intOrNull(v.weightGrams);
  const weightKnown = weight !== null && weight > 0 ? weight : null;
  if (weightKnown === null) add("WEIGHT", "Cột khối lượng của mẫu mã đang trống (0 = CHƯA NHẬP, không phải 0 gram) — chưa tính được cước cho đơn sỉ.");

  const image = typeof v.imageUrl === "string" && v.imageUrl.trim() ? v.imageUrl.trim() : null;
  if (!image) add("IMAGE", "Mẫu mã và sản phẩm đều chưa có ảnh.");

  if (src.descriptionFieldKeys.length === 0) add("DESCRIPTION", `Tổ chức chưa khai field mô tả sản phẩm nào (${DESCRIPTION_FIELD_KEYS.join(", ")}) — ERP không có chỗ để đọc mô tả.`);
  else if (v.descriptionFields.length === 0) add("DESCRIPTION", "Các field mô tả của sản phẩm (quy cách, đơn vị bán, nhóm hàng…) đều trống.");

  const onHand = v.stockKnown ? intOrNull(v.onHand) : null;
  const available = v.stockKnown ? intOrNull(v.available) : null;
  if (!v.stockKnown) add("STOCK", "Chưa có phiếu nhập — tồn CHƯA BIẾT (không phải 0). AI không được nói còn / hết hàng.");
  else if (available !== null && available <= 0) warnings.push(`Tồn đã biết nhưng khả dụng ${available} — dữ kiện đủ, hôm nay chưa bán được.`);

  if (v.addOnOnly) warnings.push("Mẫu mã CHỈ BÁN KÈM — không báo giá / bán riêng.");

  return {
    variantId: v.variantId,
    productId: v.productId,
    productName: v.productName,
    sku: v.sku,
    variantLabel: v.variantLabel,
    addOnOnly: v.addOnOnly,
    status: missing.length ? "MISSING" : "READY",
    missing,
    warnings,
    moq: moqTier?.minQuantity ?? null,
    moqUnitPrice: moqTier?.unitPrice ?? null,
    tierCount: tiers.length,
    weightGrams: weightKnown,
    hasImage: image !== null,
    imageUrl: image,
    descriptionFields: v.descriptionFields,
    stockKnown: v.stockKnown,
    onHand,
    available,
    storageFilled: v.storageFilled,
    lotCount: Math.max(0, intOrNull(v.lotCount) ?? 0),
    lotEarliestExpiry: v.lotEarliestExpiry,
    lotLatestExpiry: v.lotLatestExpiry,
  };
}

export type ReadinessSummary = {
  total: number;
  ready: number;
  missing: number;
  /** Số mẫu mã thiếu theo TỪNG hạng mục (một mẫu thiếu nhiều thứ đếm ở nhiều hạng mục). */
  missingBy: Record<CatalogCheck, number>;
  addOnOnly: number;
  outOfStock: number;
};

export function summarizeReadiness(rows: readonly VariantReadiness[]): ReadinessSummary {
  const missingBy = Object.fromEntries(CATALOG_CHECKS.map((k) => [k, 0])) as Record<CatalogCheck, number>;
  let ready = 0;
  let addOnOnly = 0;
  let outOfStock = 0;
  for (const r of rows) {
    if (r.status === "READY") ready++;
    for (const m of r.missing) missingBy[m.key]++;
    if (r.addOnOnly) addOnOnly++;
    if (r.stockKnown && r.available !== null && r.available <= 0) outOfStock++;
  }
  return { total: rows.length, ready, missing: rows.length - ready, missingBy, addOnOnly, outOfStock };
}

// ─────────────────────────── Lọc · xếp · phân trang (bảng) ───────────────────────────

export const READINESS_SORTABLE = ["productName", "missingCount", "moq", "available"] as const;
export const READINESS_FILTERS = ["status", "missing"];

export function pageReadinessRows(
  rows: readonly VariantReadiness[],
  p: { page: number; pageSize: number; sort: string; dir: "asc" | "desc"; q: string; filters: Record<string, string[]> },
): { rows: VariantReadiness[]; total: number; pageCount: number } {
  const q = p.q.trim().toLowerCase();
  const statuses = p.filters.status ?? [];
  const missingKeys = p.filters.missing ?? [];
  let out = rows.filter(
    (r) =>
      (!q || `${r.productName} ${r.sku} ${r.variantLabel}`.toLowerCase().includes(q)) &&
      (!statuses.length || statuses.includes(r.status)) &&
      (!missingKeys.length || r.missing.some((m) => missingKeys.includes(m.key))),
  );
  const sign = p.dir === "asc" ? 1 : -1;
  // Giá trị CHƯA BIẾT (null) luôn xuống cuối, ở cả hai chiều — không được đứng như số 0.
  const num = (a: number | null, b: number | null) => (a === null && b === null ? 0 : a === null ? 1 : b === null ? -1 : sign * (a - b));
  const byName = (a: VariantReadiness, b: VariantReadiness) => a.productName.localeCompare(b.productName, "vi") || a.sku.localeCompare(b.sku, "vi") || a.variantId.localeCompare(b.variantId);
  out = [...out].sort((a, b) => {
    const k = p.sort;
    const c = k === "missingCount" ? sign * (a.missing.length - b.missing.length) : k === "moq" ? num(a.moq, b.moq) : k === "available" ? num(a.available, b.available) : k === "productName" ? sign * byName(a, b) : 0;
    return c || byName(a, b);
  });
  const total = out.length;
  const pageCount = Math.max(1, Math.ceil(total / p.pageSize));
  const start = (Math.max(1, p.page) - 1) * p.pageSize;
  return { rows: out.slice(start, start + p.pageSize), total, pageCount };
}

// ─────────────────────────── Sẵn sàng xuất khẩu ───────────────────────────

export const EXPORT_CHECKS = ["CERTIFICATION", "EXPORT_TERMS", "HS_CODE", "SHELF_LIFE", "STORAGE"] as const;
export type ExportCheck = (typeof EXPORT_CHECKS)[number];
export const EXPORT_CHECK_LABEL: Record<ExportCheck, string> = {
  CERTIFICATION: "Chứng nhận (ATTP · HACCP · ISO · công bố sản phẩm…)",
  EXPORT_TERMS: "Điều kiện xuất khẩu (Incoterms · cảng · chứng từ)",
  HS_CODE: "Mã HS",
  SHELF_LIFE: "Hạn dùng",
  STORAGE: "Điều kiện bảo quản",
};

/** `AVAILABLE` đủ mọi mẫu · `PARTIAL` có nguồn, phủ một phần · `MISSING` có nguồn, chưa mẫu nào có · `UNAVAILABLE` ERP KHÔNG có nguồn. */
export type ExportItemStatus = "AVAILABLE" | "PARTIAL" | "MISSING" | "UNAVAILABLE";
export const EXPORT_STATUS_LABEL: Record<ExportItemStatus, string> = { AVAILABLE: "Đủ", PARTIAL: "Một phần", MISSING: "Chưa có", UNAVAILABLE: "ERP chưa có nguồn" };

export type ExportItem = {
  key: ExportCheck;
  label: string;
  status: ExportItemStatus;
  /** Bảng / cột đang đọc — `null` khi không có nguồn. */
  source: string | null;
  /** Số mẫu mã có dữ kiện / tổng — `null` khi không có nguồn (KHÔNG phải 0/N). */
  covered: number | null;
  total: number;
  /** Bắt buộc khi không `AVAILABLE`: thiếu ĐÚNG cái gì, cụ thể tới mức sửa được. */
  missingWhat: string | null;
  note: string | null;
};

export type ExportReadiness = { ready: boolean; items: ExportItem[]; unavailable: number };

/**
 * Ba hạng mục ERP hôm nay KHÔNG có nơi lưu nào — luôn `UNAVAILABLE`. Đây là một lời khai về LƯỢC ĐỒ, không phải về dữ liệu:
 * khi có cột / field thật thì sửa ở đây cùng truy vấn, không được viết một truy vấn gần đúng rồi gọi nó là chứng nhận.
 */
const NO_SOURCE: Record<"CERTIFICATION" | "EXPORT_TERMS" | "HS_CODE", string> = {
  CERTIFICATION:
    "ERP không có bảng / cột / field nào lưu chứng nhận (số giấy, cơ quan cấp, ngày hết hạn, tệp scan). Cần: khai field sản phẩm (vd `chung_nhan` kiểu file + `chung_nhan_het_han` kiểu ngày) hoặc bảng chứng nhận riêng, rồi chủ shop nhập giấy thật.",
  EXPORT_TERMS:
    "ERP không lưu điều kiện xuất khẩu (Incoterms, cảng xếp hàng, chứng từ C/O · kiểm dịch, quốc gia được phép). Cần chủ shop quyết có bán xuất khẩu không; có thì khai một bộ điều khoản xuất khẩu của tổ chức (settings) trước khi AI được nhắc tới.",
  HS_CODE: "Mẫu mã / sản phẩm không có cột mã HS. Cần: field sản phẩm `hs_code` (8 số, theo Biểu thuế XNK) do người khai — máy không suy mã HS từ tên hàng.",
};

export function evaluateExportReadiness(rows: readonly VariantReadiness[], src: ReadinessSources): ExportReadiness {
  const total = rows.length;
  const items: ExportItem[] = [];
  for (const key of ["CERTIFICATION", "EXPORT_TERMS", "HS_CODE"] as const)
    items.push({ key, label: EXPORT_CHECK_LABEL[key], status: "UNAVAILABLE", source: null, covered: null, total, missingWhat: NO_SOURCE[key], note: null });

  const withLots = rows.filter((r) => r.lotCount > 0).length;
  const shelfStatus: ExportItemStatus = total > 0 && withLots === total ? "AVAILABLE" : withLots > 0 ? "PARTIAL" : "MISSING";
  items.push({
    key: "SHELF_LIFE",
    label: EXPORT_CHECK_LABEL.SHELF_LIFE,
    status: shelfStatus,
    source: "stock_lots.expires_on (hạn dùng theo LÔ đã nhập — module «Lô & hạn dùng»)",
    covered: withLots,
    total,
    missingWhat:
      shelfStatus === "AVAILABLE"
        ? null
        : `${total - withLots}/${total} mẫu mã chưa có lô nào khai hạn dùng — kho khai lô + hạn dùng khi lập phiếu nhập (/inventory/lots).`,
    note: "Đây là hạn của LÔ đã nhập, không phải «thời hạn sử dụng» chuẩn của sản phẩm (vd 6 tháng kể từ ngày sản xuất) — ERP chưa có trường đó cho báo giá xuất khẩu.",
  });

  if (src.storageFieldKeys.length === 0)
    items.push({
      key: "STORAGE",
      label: EXPORT_CHECK_LABEL.STORAGE,
      status: "UNAVAILABLE",
      source: null,
      covered: null,
      total,
      missingWhat: `Tổ chức chưa khai field bảo quản (${STORAGE_FIELD_KEYS.join(" / ")}) cho sản phẩm. Cần: cài field «Bảo quản & chế biến» của mẫu ngành hải sản / thực phẩm rồi nhập cho từng sản phẩm.`,
      note: null,
    });
  else {
    const filled = rows.filter((r) => r.storageFilled === true).length;
    const st: ExportItemStatus = total > 0 && filled === total ? "AVAILABLE" : filled > 0 ? "PARTIAL" : "MISSING";
    items.push({
      key: "STORAGE",
      label: EXPORT_CHECK_LABEL.STORAGE,
      status: st,
      source: `custom_values (field sản phẩm ${src.storageFieldKeys.join(", ")})`,
      covered: filled,
      total,
      missingWhat: st === "AVAILABLE" ? null : `${total - filled}/${total} mẫu mã thuộc sản phẩm chưa nhập field bảo quản.`,
      note: null,
    });
  }
  const unavailable = items.filter((i) => i.status === "UNAVAILABLE").length;
  return { ready: total > 0 && items.every((i) => i.status === "AVAILABLE"), items, unavailable };
}

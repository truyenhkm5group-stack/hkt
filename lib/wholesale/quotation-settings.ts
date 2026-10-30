/**
 * ═══════════ CÀI ĐẶT BÁO GIÁ SỈ — GỢI Ý TỪ BẢNG GIÁ SỈ ĐANG BẬT (HÀM THUẦN, client-safe) ═══════════
 *
 * Chủ shop 30/10/2026: «trần chiết khấu / biên lợi nhuận tối thiểu: xem bảng giá sỉ của HSLC». Tệp này ĐỌC bảng giá đã có và
 * đưa ra CHỮ GỢI Ý. Nó không ghi gì và không tự áp một con số nào (luật 38: đích / ngưỡng là quyết định kinh doanh). Chỉ khi
 * người có quyền cấu hình bấm «Lưu» kèm lý do thì `settings["wholesale.quotation"]` mới đổi (lib/wholesale/quotation-policy.ts).
 *
 *  · Trần chiết khấu gợi ý = mức giảm SÂU NHẤT mà bảng giá sỉ đang bật đã cho so với giá lẻ, đo ở bậc «mua từ» lớn nhất của từng
 *    mẫu mã. Bậc nào, mẫu mã nào được in ra cùng con số. Mẫu mã không có giá lẻ thì không so được, và được đếm riêng.
 *  · Biên lợi nhuận gợi ý = biên gộp THẤP NHẤT ở bậc sâu nhất, tính theo giá vốn sống (luật 3.13). Mẫu mã chưa biết giá vốn là
 *    «chưa biết», không phải 0 (luật 42). Chúng không tham gia phép tìm min, nhưng được đếm và nêu tên.
 *  · Thuế: KHÔNG gợi ý số, vì thuế suất phụ thuộc tư cách thuế của tổ chức. Để trống thì báo giá ghi «chưa gồm thuế».
 */

export type PolicyTier = { listId: string; listName: string; variantId: string; minQuantity: number; unitPrice: number };
export type PolicyVariant = { label: string; retailPrice: number | null; unitCost: number | null };

/** Một điểm gợi ý: con số + chỗ nó đến từ đâu (bảng · mẫu mã · bậc). */
export type PolicyPick = { percent: number; listName: string; variantId: string; variantLabel: string; minQuantity: number; unitPrice: number; basePrice: number };

export type PolicySuggestion = {
  /** Số cặp (bảng, mẫu mã) có bậc giá trong các bảng đang bật. */
  deepestTiers: number;
  /** Giảm sâu nhất so với giá lẻ ở bậc sâu nhất — `null` = không cặp nào so được. */
  maxDiscount: PolicyPick | null;
  /** Biên gộp thấp nhất ở bậc sâu nhất — `null` = không cặp nào biết giá vốn. */
  minMargin: PolicyPick | null;
  /** Cặp không có giá lẻ (không so được mức giảm). */
  noRetail: number;
  /** Cặp chưa biết giá vốn — biên lợi nhuận «chưa biết». */
  unknownCost: { count: number; examples: string[] };
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const MAX_EXAMPLES = 10;

/** Gợi ý từ bảng giá đang bật — HÀM THUẦN, cùng đầu vào ⇒ cùng kết quả (hoà thì giữ cặp đến trước theo bảng rồi mẫu mã). */
export function suggestQuotationPolicy(tiers: readonly PolicyTier[], variants: ReadonlyMap<string, PolicyVariant>): PolicySuggestion {
  const deepest = new Map<string, PolicyTier>();
  for (const t of tiers) {
    if (!Number.isSafeInteger(t.unitPrice) || t.unitPrice <= 0 || !Number.isSafeInteger(t.minQuantity) || t.minQuantity < 1) continue;
    const k = `${t.listId}|${t.variantId}`;
    const cur = deepest.get(k);
    if (!cur || t.minQuantity > cur.minQuantity) deepest.set(k, t);
  }
  const pairs = [...deepest.values()].sort((a, b) => (a.listName === b.listName ? a.variantId.localeCompare(b.variantId) : a.listName.localeCompare(b.listName)));
  let maxDiscount: PolicyPick | null = null;
  let minMargin: PolicyPick | null = null;
  let noRetail = 0;
  const unknown: string[] = [];
  for (const t of pairs) {
    const v = variants.get(t.variantId);
    const label = v?.label || t.variantId;
    const retail = v?.retailPrice ?? null;
    if (retail !== null && retail > 0) {
      const percent = round2(((retail - t.unitPrice) / retail) * 100);
      if (!maxDiscount || percent > maxDiscount.percent) maxDiscount = { percent, listName: t.listName, variantId: t.variantId, variantLabel: label, minQuantity: t.minQuantity, unitPrice: t.unitPrice, basePrice: retail };
    } else noRetail += 1;
    const cost = v?.unitCost ?? null;
    if (cost !== null && cost > 0) {
      const percent = round2(((t.unitPrice - cost) / t.unitPrice) * 100);
      if (!minMargin || percent < minMargin.percent) minMargin = { percent, listName: t.listName, variantId: t.variantId, variantLabel: label, minQuantity: t.minQuantity, unitPrice: t.unitPrice, basePrice: cost };
    } else unknown.push(`${label} (${t.listName})`);
  }
  return { deepestTiers: pairs.length, maxDiscount, minMargin, noRetail, unknownCost: { count: unknown.length, examples: unknown.slice(0, MAX_EXAMPLES) } };
}

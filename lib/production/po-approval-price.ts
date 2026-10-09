import type { EstimatedCost } from "@/lib/constants/estimated-cost";
import { getEstimatedCosts } from "@/lib/queries/profit-nominal";

/**
 * ═══════════ SỐ TIỀN ĐƯA VÀO CỔNG DUYỆT ĐẶT XƯỞNG — KHÔNG BAO GIỜ LÀ 0 VÌ CHƯA CÓ GIÁ ═══════════
 *
 * Bản cũ: lệnh SX chưa có giá gia công lưu `unit_cost = 0` (zod `.default(0)`), rồi cổng
 * `PURCHASING_LARGE` nhận `amount = số món × 0 = 0` — dưới mọi ngưỡng — nên đúng lệnh chưa ai biết
 * tốn bao nhiêu lại là lệnh lọt qua duyệt hai bước dễ nhất (AGENTS.md mục 42: chưa biết không phải 0).
 *
 * Luật (Tech Lead chốt 09/10/2026):
 *  1. Có giá gia công (> 0) ⇒ `KNOWN`, số tiền = số món × giá.
 *  2. Chưa có ⇒ GIÁ DỰ TÍNH của mã (`ESTIMATED`): giá báo MKT đang hiệu lực, không có thì con số đặt
 *     tay ở Bàn dự tính — đúng `getEstimatedCosts` mà báo cáo lợi nhuận danh nghĩa dùng (chủ shop chốt
 *     26/09/2026 "giá dự tính = giá báo MKT", luật 5 ở `lib/constants/estimated-cost.ts`).
 *  3. Không cái nào ⇒ `UNPRICED_FORCED`: số tiền `null` — cổng coi CHƯA BIẾT là VƯỢT ngưỡng
 *     (`overThreshold`), nên lệnh bắt duyệt khi nhóm đang cưỡng chế. Không bao giờ đi qua với 0.
 *
 * Giá dự tính CHỈ dùng để quyết lệnh có phải xin duyệt không — nó KHÔNG được ghi vào `unit_cost` của
 * lệnh (cột đó là giá xưởng báo; đoán ghi vào đó là biến ước tính thành chứng từ).
 */

export type PoPriceBasis = "KNOWN" | "ESTIMATED" | "UNPRICED_FORCED";

export const PO_PRICE_BASIS_LABEL: Record<PoPriceBasis, string> = {
  KNOWN: "giá gia công đã nhập",
  ESTIMATED: "giá dự tính",
  UNPRICED_FORCED: "chưa có giá — bắt duyệt",
};

export type PoApprovalPrice = {
  basis: PoPriceBasis;
  /** Đơn giá đã dùng để tính số tiền — `null` khi chưa có giá nào. */
  unitPrice: number | null;
  /** Số tiền đưa vào cổng duyệt — `null` = CHƯA BIẾT (cổng coi như vượt ngưỡng). */
  amount: number | null;
  /** Nguồn của giá dự tính khi `basis = ESTIMATED`. */
  estimateSource: "MARKETER_PRICE" | "MANUAL" | null;
};

function positive(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** Hàm THUẦN: chọn căn cứ giá cho cổng duyệt theo ba bậc ở trên. */
export function resolvePoApprovalPrice(input: { qty: number; unitCost: number | null; estimate: Pick<EstimatedCost, "unitCost" | "source"> | null }): PoApprovalPrice {
  const known = positive(input.unitCost);
  if (known !== null) return { basis: "KNOWN", unitPrice: known, amount: input.qty * known, estimateSource: null };
  const est = positive(input.estimate?.unitCost);
  if (est !== null) return { basis: "ESTIMATED", unitPrice: est, amount: input.qty * est, estimateSource: input.estimate?.source ?? "MANUAL" };
  return { basis: "UNPRICED_FORCED", unitPrice: null, amount: null, estimateSource: null };
}

/** Câu tóm tắt của yêu cầu duyệt — nói rõ số tiền đứng trên căn cứ nào. */
export function poApprovalSummary(p: { productName: string; qty: number; supplier: string; price: PoApprovalPrice }): string {
  const tien = p.price.amount === null ? "chưa có giá — bắt duyệt" : `${p.price.amount}đ theo ${PO_PRICE_BASIS_LABEL[p.price.basis]}${p.price.basis === "ESTIMATED" ? ` (${p.price.unitPrice}đ/sp${p.price.estimateSource === "MARKETER_PRICE" ? " · giá báo MKT" : " · Bàn dự tính"})` : ""}`;
  return `Đặt xưởng ${p.productName} · ${p.qty} món · ${tien}${p.supplier ? ` · ${p.supplier}` : ""}`;
}

/** Đọc giá dự tính của MỘT mã rồi chọn căn cứ. Giá gia công đã có thì không đọc gì thêm. */
export async function poApprovalPrice(input: { productId: string; qty: number; unitCost: number | null; at?: Date }): Promise<PoApprovalPrice> {
  if (positive(input.unitCost) !== null) return resolvePoApprovalPrice({ qty: input.qty, unitCost: input.unitCost, estimate: null });
  const estimates = await getEstimatedCosts(input.at ?? new Date());
  return resolvePoApprovalPrice({ qty: input.qty, unitCost: input.unitCost, estimate: estimates[input.productId] ?? null });
}

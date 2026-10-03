import type { DeliveryRateSource } from "@/lib/constants/delivery-rate";
import { opsCosts, type ProfitAssumptions } from "@/lib/constants/profit";
import { RETURN_RULE } from "@/lib/constants/returns";

/**
 * ═══════════ GIÁ SÀN XẢ HÀNG — XẢ TỚI ĐÂU THÌ MỖI ĐƠN BẮT ĐẦU MẤT TIỀN ═══════════
 *
 * Trang Quyết định vốn tồn kho nói "nên xả" / "đang chôn vốn" mà không nói XẢ GIÁ BAO NHIÊU. Câu "mức giảm tối
 * ưu" cần biết khách phản ứng với giá thế nào — đo production 03/10/2026: 603/4.221 đơn 180 ngày có chiết khấu
 * nhưng lẫn giá gói / giá landing, chỉ 35 mẫu mã đủ 20 dòng bán. Ước độ co giãn trên nền đó là bịa (luật 38).
 * Thứ TÍNH ĐƯỢC mà không đoán là cái SÀN: dưới mức này, bán thêm một đơn là mất tiền — bất kể khách mua nhiều hay ít.
 *
 * Với hàng COD, mỗi đơn gửi đi chỉ thành tiền với xác suất g (tỷ lệ giao thành công của mã); đơn hoàn vẫn tốn
 * cước hai chiều. Nên cái sàn KHÔNG phải "giá vốn + cước" mà là chi phí kỳ vọng của MỘT đơn gửi đi chia cho
 * phần doanh thu thật sự về:
 *
 *   chi phí kỳ vọng / đơn gửi = đóng gói + nhân công vận đơn + g × cước giao + (1 − g) × cước hoàn (đi + về)
 *   GIÁ SÀN TIỀN MẶT           = chi phí kỳ vọng ÷ (g × (1 − thuế))
 *   GIÁ HOÀ VỐN SỔ SÁCH        = (chi phí kỳ vọng + g × giá vốn + (1 − g) × (1 − r) × giá vốn) ÷ (g × (1 − thuế))
 *
 *   r = tỷ lệ hàng hoàn kho nhập lại được (đếm thật, của Kế hoạch SX).
 *
 * VÌ SAO HAI CON SỐ: hàng nằm trong kho thì tiền vốn ĐÃ CHI. Xả dưới giá hoà vốn là lỗ trên sổ, nhưng vẫn THU
 * VỀ tiền mặt cho tới giá sàn tiền mặt — đó là quyết định của chủ shop (giải phóng vốn hay giữ giá). Xả dưới giá
 * sàn tiền mặt thì không còn gì để cân: mỗi đơn gửi đi đốt thêm tiền thật.
 *
 * CỐ Ý KHÔNG GỒM: tiền quảng cáo để bán được đơn đó (xả qua khách cũ / livestream thì 0đ, qua QC thì phải cộng
 * CPO — màn hình nói ra), chi phí cố định (không đổi theo việc có xả hay không). Một đơn = một món: gộp nhiều món
 * một đơn thì cước chia ra, sàn mỗi món thấp hơn.
 *
 * LUẬT TIỀN COD: đơn có giá trị ≤ `RETURN_RULE.maxCodForFakeDelivery` mà ĐVVC không gửi mã cuối thì luật tiền xếp
 * là KHÔNG THÀNH CÔNG (`docs/business-rules/ORDER_OUTCOME.md`) — đơn đã giao hiện như đơn hoàn trên mọi báo cáo.
 * Không đổi luật đó ở đây; chỉ CẢNH BÁO khi giá sàn rơi vào vùng ấy và gợi ý gộp món để giá trị đơn vượt ngưỡng.
 */

export type ClearanceFloorInput = {
  /** Giá nhập; `null` = CHƯA BIẾT (sàn tiền mặt vẫn tính được, hoà vốn sổ sách thì không). */
  unitCost: number | null;
  /** Tỷ lệ giao thành công (%) của mã theo thang bậc chung; `null` = chưa biết. */
  deliveryRatePct: number | null;
  deliverySource: DeliveryRateSource | null;
  /** Tỷ lệ hàng hoàn kho nhập lại được, 0–1. */
  returnRecoveryRate: number;
  /** Cước MỘT đơn giao thành công (đ). */
  shipFeeDelivered: number;
  /** Tổng cước MỘT đơn hoàn = đi + về (đ). */
  shipFeeReturned: number;
  assumptions: Pick<ProfitAssumptions, "packingFeePerOrder" | "opsStaffPerOrder" | "opsStaffPerRescued" | "rescueRatePercent" | "taxPercent">;
  /** Giá bán niêm yết; `null` = chưa khai. */
  retailPrice: number | null;
};

export type ClearanceFloor = {
  /** Dưới mức này mỗi đơn gửi đi mất tiền mặt; `null` khi tỷ lệ giao thành công chưa biết / bằng 0. */
  cashFloor: number | null;
  /** Dưới mức này lỗ trên sổ (gồm giá vốn); `null` khi thiếu giá nhập hoặc tỷ lệ giao. */
  bookFloor: number | null;
  /** Chi phí kỳ vọng của MỘT đơn gửi đi (đ), trước giá vốn — để người đọc kiểm lại phép chia. */
  expectedCostPerSent: number;
  deliveryRatePct: number | null;
  deliverySource: DeliveryRateSource | null;
  /** Mức giảm tối đa (%) so với giá bán trước khi chạm sàn tiền mặt; `null` khi thiếu giá bán hoặc sàn. */
  maxDiscountPct: number | null;
  /** Giá sàn tiền mặt ≤ ngưỡng luật tiền COD ⇒ bán một món một đơn ở quanh giá sàn sẽ bị luật tiền xếp là hoàn. */
  belowCodRule: boolean;
  /** Giá bán hiện tại đã thấp hơn sàn tiền mặt ⇒ đang bán lỗ tiền mặt mỗi đơn. */
  retailBelowCashFloor: boolean;
  notes: string[];
};

/** Làm tròn LÊN tới nghìn đồng — sàn làm tròn xuống là hứa một mức giá mà thật ra đã lỗ vài trăm đồng. */
const ceilK = (v: number) => Math.ceil(v / 1000) * 1000;

export function clearanceFloor(i: ClearanceFloorInput): ClearanceFloor {
  const notes: string[] = [];
  const g = i.deliveryRatePct === null || !Number.isFinite(i.deliveryRatePct) ? null : Math.min(1, Math.max(0, i.deliveryRatePct / 100));
  const r = Math.min(1, Math.max(0, i.returnRecoveryRate));
  const tax = Math.min(0.99, Math.max(0, (i.assumptions.taxPercent || 0) / 100));
  // Cùng phép tính chi phí vận hành của báo cáo lợi nhuận danh nghĩa, cho MỘT đơn gửi (đơn cứu được là phần lẻ).
  const ops = opsCosts({ orders: 1, rescued: Math.max(0, i.assumptions.rescueRatePercent || 0) / 100 }, i.assumptions);
  const handling = ops.packingCost + ops.opsStaffCost;
  const shipD = Math.max(0, i.shipFeeDelivered);
  const shipR = Math.max(0, i.shipFeeReturned);
  const expectedCostPerSent = Math.round(handling + (g ?? 0) * shipD + (1 - (g ?? 0)) * shipR);

  if (g === null) notes.push("chưa biết tỷ lệ giao thành công của mã — không tính được sàn");
  else if (g === 0) notes.push("tỷ lệ giao thành công 0% — mọi đơn gửi đi đều mất tiền, giá nào cũng không cứu được");
  else if (i.deliverySource === "default") notes.push(`tỷ lệ giao thành công ${Math.round(g * 100)}% là MỤC TIÊU khai ở Giả định, chưa phải số đo của mã`);
  else if (i.deliverySource === "blended") notes.push(`tỷ lệ giao thành công ${Math.round(g * 100)}% là số đo của mã CO NGÓT về tỷ lệ khai — mã chưa đủ đơn kết thúc`);

  const denom = g === null || g === 0 ? null : g * (1 - tax);
  const cashFloor = denom === null ? null : ceilK(expectedCostPerSent / denom);
  let bookFloor: number | null = null;
  if (denom !== null && i.unitCost !== null && i.unitCost > 0 && g !== null) {
    bookFloor = ceilK((expectedCostPerSent + g * i.unitCost + (1 - g) * (1 - r) * i.unitCost) / denom);
  } else if (denom !== null) notes.push("chưa có giá nhập — chỉ tính được sàn tiền mặt");

  const retail = i.retailPrice !== null && i.retailPrice > 0 ? i.retailPrice : null;
  const maxDiscountPct = retail === null || cashFloor === null ? null : Math.max(0, Math.floor((1 - cashFloor / retail) * 100));
  const retailBelowCashFloor = retail !== null && cashFloor !== null && retail < cashFloor;
  const belowCodRule = cashFloor !== null && cashFloor <= RETURN_RULE.maxCodForFakeDelivery;
  if (belowCodRule)
    notes.push(
      `giá đơn ≤ ${RETURN_RULE.maxCodForFakeDelivery.toLocaleString("vi-VN")}đ mà ĐVVC không gửi mã cuối thì luật tiền xếp là KHÔNG THÀNH CÔNG — xả theo gói nhiều món để giá trị đơn vượt ngưỡng`,
    );

  return { cashFloor, bookFloor, expectedCostPerSent, deliveryRatePct: g === null ? null : Math.round(g * 1000) / 10, deliverySource: i.deliverySource, maxDiscountPct, belowCodRule, retailBelowCashFloor, notes };
}

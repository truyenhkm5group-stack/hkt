/**
 * ═══════════ GIÁ VỐN "SỐNG" CỦA MỘT ĐƠN — VÀ BẬC CUỐI LÀ **CHƯA BIẾT**, KHÔNG PHẢI 0 ═══════════
 *
 * Thứ tự nguồn (AGENTS.md mục 3.13, KHÔNG đổi ở đây): đơn giá phiếu NHẬP ERP gần nhất → giá vốn
 * Pancake ghi trên dòng đơn → giá nhập của mẫu mã. Cả ba cột đều `NOT NULL DEFAULT 0` trong CSDL, và
 * theo chính mục 3.13 "dòng ghi 0 = CHƯA BIẾT" — nên ở đây chỉ số DƯƠNG mới là một căn cứ.
 *
 * Bản cũ (`lib/queries/orders.ts`) kết thúc chuỗi bằng `|| 0`: một dòng không có nguồn nào hiện ra
 * "Giá vốn 0 ₫", và "Lãi gộp ước tính" của đơn bằng nguyên doanh thu, tô XANH — sai đúng theo hướng
 * dễ chịu nhất (mục 42). `lib/queries/canonical-outcome.ts` đã chốt cùng điều này cho giá vốn ghi
 * nhận: "0 không bao giờ tự sinh".
 *
 * Hàm THUẦN để trang chi tiết đơn và bài kiểm dùng cùng một luật.
 */

export type LiveCostSource = "RECEIPT" | "ORDER_SNAPSHOT" | "VARIANT_DEFAULT";

/** Một nguồn giá chỉ được tính khi là số hữu hạn DƯƠNG — 0 / âm / NULL / NaN đều là chưa khai giá. */
function positiveOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Đơn giá vốn của MỘT dòng theo thứ tự mục 3.13. Không nguồn nào ⇒ `unitCost: null` (CHƯA BIẾT). */
export function liveLineUnitCost(sources: { receipt: number | null | undefined; orderSnapshot: number | null | undefined; variantDefault: number | null | undefined }): { unitCost: number | null; source: LiveCostSource | null } {
  const receipt = positiveOrNull(sources.receipt);
  if (receipt !== null) return { unitCost: receipt, source: "RECEIPT" };
  const snapshot = positiveOrNull(sources.orderSnapshot);
  if (snapshot !== null) return { unitCost: snapshot, source: "ORDER_SNAPSHOT" };
  const variant = positiveOrNull(sources.variantDefault);
  if (variant !== null) return { unitCost: variant, source: "VARIANT_DEFAULT" };
  return { unitCost: null, source: null };
}

export type LiveOrderCogs = {
  /** Giá vốn cả đơn — `null` khi CÒN MỘT dòng chưa biết giá (thiếu một phần = chưa biết, không cộng nửa vời). */
  cogs: number | null;
  /** Tổng phần ĐÃ BIẾT giá — chỉ để in độ phủ, KHÔNG được dùng làm giá vốn của đơn. */
  knownCogs: number;
  knownLines: number;
  totalLines: number;
};

/**
 * Giá vốn của cả đơn. Dòng số lượng 0 đóng góp 0 THẬT (không có hàng nào đi ra) nên không làm đơn
 * thành "chưa biết". Đơn không có dòng hàng nào ⇒ `null`: ERP không có căn cứ để nói đơn tốn 0 ₫.
 */
export function liveOrderCogs(lines: readonly { unitCost: number | null; quantity: number }[]): LiveOrderCogs {
  let knownCogs = 0;
  let knownLines = 0;
  for (const l of lines) {
    const qty = Number(l.quantity) || 0;
    if (qty === 0) {
      knownLines += 1;
      continue;
    }
    if (l.unitCost === null) continue;
    knownLines += 1;
    knownCogs += l.unitCost * qty;
  }
  const totalLines = lines.length;
  const cogs = totalLines > 0 && knownLines === totalLines ? knownCogs : null;
  return { cogs, knownCogs, knownLines, totalLines };
}

/**
 * Lãi gộp ước tính của đơn = tổng đơn − giá vốn − phí ĐVVC − phí hoàn. Giá vốn chưa biết ⇒ `null`:
 * in "—", KHÔNG tô xanh / đỏ (mục 42, 44 — không kết luận được thì không tô màu).
 */
export function orderGrossMargin(totalAfterDiscount: number, cogs: number | null, partnerFee: number, returnFee: number): number | null {
  return cogs === null ? null : totalAfterDiscount - cogs - partnerFee - returnFee;
}

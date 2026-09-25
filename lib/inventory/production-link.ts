import { eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { batchLinkFacts } from "@/lib/queries/workshop-ledger";

/**
 * ═══════════ PHIẾU NHẬP ↔ LỆNH SẢN XUẤT / LÔ XƯỞNG (Company OS · Agent D · 0132) ═══════════
 *
 * Hai cột `stock_receipts.production_order_id` / `production_batch_id` trả lời "phiếu nhập này là hàng
 * của lần đặt xưởng nào". Chỉ do NGƯỜI chọn trên form nhập hàng — máy KHÔNG đoán (khớp theo tên xưởng
 * hay ngày là bịa một quy kết, AGENTS.md mục 35). Để trống = chưa khai, hoàn toàn hợp lệ.
 *
 * Kiểm ở đây (không ở zod vì zod không đọc được CSDL):
 *  · chỉ phiếu `RECEIPT` được gắn — tái nhập hoàn / xuất tay / điều chỉnh không phải hàng của xưởng;
 *  · mã phải TỒN TẠI và không ở trạng thái huỷ;
 *  · chọn cả hai mà lô đã nối với MỘT lệnh khác ⇒ từ chối: hai cột nói hai lần đặt khác nhau.
 */
export type ProductionLinkInput = { kind: string; productionOrderId?: string | null; productionBatchId?: string | null };
export type ProductionLink = { productionOrderId: string | null; productionBatchId: string | null };

export async function validateProductionLink(db: Db, input: ProductionLinkInput): Promise<{ ok: true; link: ProductionLink } | { error: string }> {
  const orderId = input.productionOrderId?.trim() || null;
  const batchId = input.productionBatchId?.trim() || null;
  if (!orderId && !batchId) return { ok: true, link: { productionOrderId: null, productionBatchId: null } };
  if (input.kind !== "RECEIPT") return { error: "Chỉ phiếu Nhập hàng mới gắn được lệnh sản xuất / lô xưởng" };

  let batchOrderId: string | null = null;
  if (orderId) {
    const [po] = await db.select({ id: schema.productionOrders.id, status: schema.productionOrders.status }).from(schema.productionOrders).where(eq(schema.productionOrders.id, orderId));
    if (!po) return { error: "Lệnh sản xuất đã chọn không tồn tại" };
    if (po.status === "CANCELLED") return { error: "Lệnh sản xuất đã chọn đã bị huỷ" };
  }
  if (batchId) {
    // Bảng lô thuộc sổ đặt xưởng — chỉ đọc qua hàm của sổ (tests/workshop-ledger.test.ts).
    const b = await batchLinkFacts(batchId);
    if (!b) return { error: "Lô xưởng đã chọn không tồn tại" };
    if (b.status === "CANCELLED") return { error: "Lô xưởng đã chọn đã bị huỷ" };
    batchOrderId = b.productionOrderId;
  }
  if (orderId && batchId && batchOrderId && batchOrderId !== orderId) return { error: "Lô xưởng đã chọn nối với một lệnh sản xuất khác — chọn lại cho khớp, hoặc chỉ chọn một" };
  return { ok: true, link: { productionOrderId: orderId, productionBatchId: batchId } };
}

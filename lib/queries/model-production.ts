import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { TOPIC_OPEN_STATUSES, type SampleStatus, type TopicStatus } from "@/lib/constants/production-os";

/**
 * ═══════════ `getModelProductionSummary(modelId)` — HÀM ĐỌC GIAO CHO TRANG 360 (shared-contracts.md mục 6) ═══════════
 *
 * Agent A2 vẽ khối "Sản xuất" trên `/models/[id]` từ hàm này; Agent C KHÔNG thêm gì vào trang đó. Chỉ đọc
 * bảng có sẵn, không công thức mới:
 *
 *  · topic: danh sách + số đang mở (`TOPIC_OPEN_STATUSES`);
 *  · giá thành CHỐT mới nhất (tổng đã LƯU lúc chốt — không tính lại);
 *  · mẫu mới nhất (phiên bản lớn nhất) và bản thiết kế đã duyệt mới nhất;
 *  · lệnh sản xuất ĐANG MỞ (DRAFT / SENT) của sản phẩm của mẫu: số đặt = `production_orders.total_qty`;
 *    số đã nhận = tổng dòng phiếu NHẬP HÀNG đã NỐI vào lệnh (`stock_receipts.production_order_id`, cột của
 *    Agent D, KHÔNG backfill). Lệnh chưa có phiếu nào nối vào ⇒ `null` (CHƯA BIẾT — có thể đã nhận mà
 *    phiếu cũ chưa nối), không phải 0 (mục 42).
 *
 * Mẫu chưa có sản phẩm Pancake ⇒ `openOrders = []` kèm `productId = null`: không có sản phẩm thì không
 * có lệnh nào đặt được cho nó — khác với "có sản phẩm, không lệnh mở".
 */
export type ModelProductionSummary = {
  modelId: string;
  productId: string | null;
  topics: { id: string; title: string; status: TopicStatus; updatedAt: Date }[];
  openTopics: number;
  finalCosting: { id: string; version: number; totalUnitCost: number; finalizedAt: Date | null; finalizedBy: string } | null;
  /** Số phiên bản giá thành còn NHÁP (chưa chốt). */
  draftCostings: number;
  latestSample: { id: string; version: number; status: SampleStatus; supplierName: string | null; submittedAt: Date | null } | null;
  approvedDesign: { id: string; version: number; approvedAt: Date; approvedBy: string; costSheetId: string | null } | null;
  openOrders: { id: string; code: string; status: string; plannedQty: number; receivedViaLinkedReceipts: number | null; designVersionId: string | null; dueDate: Date | null }[];
  basis: { received: string };
};

export const RECEIVED_BASIS =
  "Đã nhận = tổng dòng phiếu NHẬP HÀNG đã nối vào lệnh (stock_receipts.production_order_id). Lệnh chưa có phiếu nào nối ⇒ “—” (chưa biết), vì phiếu nhập trước khi có cột này không được nối ngược.";

export async function getModelProductionSummary(modelId: string): Promise<ModelProductionSummary | null> {
  const db = await getDb();
  const [m] = await db.select({ id: schema.productModels.id, productId: schema.productModels.productId }).from(schema.productModels).where(eq(schema.productModels.id, modelId)).limit(1);
  if (!m) return null;
  const cs = schema.costSheets;
  const sm = schema.samples;
  const dv = schema.designVersions;
  const po = schema.productionOrders;

  const [topics, [finalSheet], [{ drafts }], [sample], [design], orders] = await Promise.all([
    db
      .select({ id: schema.productionTopics.id, title: schema.productionTopics.title, status: schema.productionTopics.status, updatedAt: schema.productionTopics.updatedAt })
      .from(schema.productionTopics)
      .where(eq(schema.productionTopics.modelId, modelId))
      .orderBy(desc(schema.productionTopics.updatedAt)),
    db
      .select({ id: cs.id, version: cs.version, totalUnitCost: cs.totalUnitCost, finalizedAt: cs.finalizedAt, finalizedBy: cs.finalizedBy })
      .from(cs)
      .where(and(eq(cs.modelId, modelId), eq(cs.status, "FINAL")))
      .orderBy(desc(cs.version))
      .limit(1),
    db.select({ drafts: sql<number>`count(*)::int` }).from(cs).where(and(eq(cs.modelId, modelId), eq(cs.status, "DRAFT"))),
    db
      .select({ id: sm.id, version: sm.version, status: sm.status, supplierName: schema.suppliers.name, submittedAt: sm.submittedAt })
      .from(sm)
      .leftJoin(schema.suppliers, eq(schema.suppliers.id, sm.supplierId))
      .where(eq(sm.modelId, modelId))
      .orderBy(desc(sm.version))
      .limit(1),
    db.select({ id: dv.id, version: dv.version, approvedAt: dv.approvedAt, approvedBy: dv.approvedBy, costSheetId: dv.costSheetId }).from(dv).where(eq(dv.modelId, modelId)).orderBy(desc(dv.version)).limit(1),
    m.productId
      ? db
          .select({
            id: po.id,
            code: po.code,
            status: po.status,
            plannedQty: po.totalQty,
            designVersionId: po.designVersionId,
            dueDate: po.dueDate,
            linkedReceipts: sql<number>`(select count(*)::int from ${schema.stockReceipts} r where r.production_order_id = "production_orders"."id" and r.kind = 'RECEIPT')`,
            received: sql<number>`(select coalesce(sum(ri.quantity), 0)::int from ${schema.stockReceiptItems} ri join ${schema.stockReceipts} r on r.id = ri.receipt_id where r.production_order_id = "production_orders"."id" and r.kind = 'RECEIPT')`,
          })
          .from(po)
          .where(and(eq(po.productId, m.productId), inArray(po.status, ["DRAFT", "SENT"])))
          .orderBy(desc(po.createdAt))
      : Promise.resolve([]),
  ]);

  return {
    modelId,
    productId: m.productId,
    topics: topics.map((t) => ({ ...t, status: t.status as TopicStatus })),
    openTopics: topics.filter((t) => (TOPIC_OPEN_STATUSES as readonly string[]).includes(t.status)).length,
    finalCosting: finalSheet ?? null,
    draftCostings: Number(drafts),
    latestSample: sample ? { ...sample, status: sample.status as SampleStatus } : null,
    approvedDesign: design ?? null,
    openOrders: orders.map((o) => ({
      id: o.id,
      code: o.code,
      status: o.status,
      plannedQty: o.plannedQty,
      receivedViaLinkedReceipts: Number(o.linkedReceipts) > 0 ? Number(o.received) : null,
      designVersionId: o.designVersionId,
      dueDate: o.dueDate,
    })),
    basis: { received: RECEIVED_BASIS },
  };
}

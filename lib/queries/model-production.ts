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
  return (await getModelProductionSummariesBatch([modelId])).get(modelId) ?? null;
}

/**
 * CÙNG tóm tắt cho NHIỀU mẫu một lượt (Bảng quy trình mẫu — Agent BD): mỗi bảng đọc ĐÚNG MỘT câu cho cả lô
 * rồi cắt theo mẫu. `getModelProductionSummary` gọi chính hàm này với một mẫu — không có công thức thứ hai.
 * Mẫu không tồn tại ⇒ không có trong bản đồ (bản một mẫu trả `null`).
 */
export async function getModelProductionSummariesBatch(modelIds: readonly string[]): Promise<Map<string, ModelProductionSummary>> {
  const out = new Map<string, ModelProductionSummary>();
  const ids = [...new Set(modelIds)];
  if (!ids.length) return out;
  const db = await getDb();
  const pm = schema.productModels;
  const tp = schema.productionTopics;
  const cs = schema.costSheets;
  const sm = schema.samples;
  const dv = schema.designVersions;
  const po = schema.productionOrders;

  const models = await db.select({ id: pm.id, productId: pm.productId }).from(pm).where(inArray(pm.id, ids));
  if (!models.length) return out;
  const found = models.map((m) => m.id);
  const productIds = [...new Set(models.map((m) => m.productId).filter((x): x is string => !!x))];

  const [topics, finals, drafts, samples, designs, orders] = await Promise.all([
    db.select({ modelId: tp.modelId, id: tp.id, title: tp.title, status: tp.status, updatedAt: tp.updatedAt }).from(tp).where(inArray(tp.modelId, found)).orderBy(desc(tp.updatedAt)),
    // Bản CHỐT mới nhất của từng mẫu (phiên bản lớn nhất) — `distinct on` = `limit 1` theo từng mẫu.
    db
      .selectDistinctOn([cs.modelId], { modelId: cs.modelId, id: cs.id, version: cs.version, totalUnitCost: cs.totalUnitCost, finalizedAt: cs.finalizedAt, finalizedBy: cs.finalizedBy })
      .from(cs)
      .where(and(inArray(cs.modelId, found), eq(cs.status, "FINAL")))
      .orderBy(cs.modelId, desc(cs.version)),
    db.select({ modelId: cs.modelId, drafts: sql<number>`count(*)::int` }).from(cs).where(and(inArray(cs.modelId, found), eq(cs.status, "DRAFT"))).groupBy(cs.modelId),
    db
      .selectDistinctOn([sm.modelId], { modelId: sm.modelId, id: sm.id, version: sm.version, status: sm.status, supplierName: schema.suppliers.name, submittedAt: sm.submittedAt })
      .from(sm)
      .leftJoin(schema.suppliers, eq(schema.suppliers.id, sm.supplierId))
      .where(inArray(sm.modelId, found))
      .orderBy(sm.modelId, desc(sm.version)),
    db
      .selectDistinctOn([dv.modelId], { modelId: dv.modelId, id: dv.id, version: dv.version, approvedAt: dv.approvedAt, approvedBy: dv.approvedBy, costSheetId: dv.costSheetId })
      .from(dv)
      .where(inArray(dv.modelId, found))
      .orderBy(dv.modelId, desc(dv.version)),
    productIds.length
      ? db
          .select({
            productId: po.productId,
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
          .where(and(inArray(po.productId, productIds), inArray(po.status, ["DRAFT", "SENT"])))
          .orderBy(desc(po.createdAt))
      : Promise.resolve([]),
  ]);

  const byModel = <T extends { modelId: string }>(rows: readonly T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.modelId, [...(m.get(r.modelId) ?? []), r]);
    return m;
  };
  const topicsOf = byModel(topics);
  const finalOf = new Map(finals.map((r) => [r.modelId, r]));
  const draftsOf = new Map(drafts.map((r) => [r.modelId, Number(r.drafts)]));
  const sampleOf = new Map(samples.map((r) => [r.modelId, r]));
  const designOf = new Map(designs.map((r) => [r.modelId, r]));
  const ordersOf = new Map<string, typeof orders>();
  for (const o of orders) if (o.productId) ordersOf.set(o.productId, [...(ordersOf.get(o.productId) ?? []), o]);

  for (const m of models) {
    const t = (topicsOf.get(m.id) ?? []).map(({ id, title, status, updatedAt }) => ({ id, title, status: status as TopicStatus, updatedAt }));
    const f = finalOf.get(m.id);
    const s = sampleOf.get(m.id);
    const d = designOf.get(m.id);
    out.set(m.id, {
      modelId: m.id,
      productId: m.productId,
      topics: t,
      openTopics: t.filter((x) => (TOPIC_OPEN_STATUSES as readonly string[]).includes(x.status)).length,
      finalCosting: f ? { id: f.id, version: f.version, totalUnitCost: f.totalUnitCost, finalizedAt: f.finalizedAt, finalizedBy: f.finalizedBy } : null,
      draftCostings: draftsOf.get(m.id) ?? 0,
      latestSample: s ? { id: s.id, version: s.version, status: s.status as SampleStatus, supplierName: s.supplierName, submittedAt: s.submittedAt } : null,
      approvedDesign: d ? { id: d.id, version: d.version, approvedAt: d.approvedAt, approvedBy: d.approvedBy, costSheetId: d.costSheetId } : null,
      openOrders: (m.productId ? (ordersOf.get(m.productId) ?? []) : []).map((o) => ({
        id: o.id,
        code: o.code,
        status: o.status,
        plannedQty: o.plannedQty,
        receivedViaLinkedReceipts: Number(o.linkedReceipts) > 0 ? Number(o.received) : null,
        designVersionId: o.designVersionId,
        dueDate: o.dueDate,
      })),
      basis: { received: RECEIVED_BASIS },
    });
  }
  return out;
}

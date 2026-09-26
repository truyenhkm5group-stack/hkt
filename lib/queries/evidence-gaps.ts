import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  LIFECYCLE_REQUIRED_EVIDENCE,
  lifecycleEvidenceGap,
  matchReceiptToOrders,
  type LifecycleEvidenceGap,
  type ModelEvidenceFacts,
  type ProductionOrderLinkFacts,
} from "@/lib/constants/evidence-gaps";
import { MODEL_STATES, type ModelState } from "@/lib/constants/model-lifecycle";
import type { ModelProductionSummary } from "@/lib/queries/model-production";

/**
 * ═══════════ ĐỌC HAI CHỖ HỞ "LỜI KHAI ≠ CHỨNG CỨ" (Company OS · Agent P2) ═══════════
 *
 * Luật nằm ở `lib/constants/evidence-gaps.ts` (thuần). Tệp này chỉ dựng dữ kiện rồi gọi luật — không
 * điều kiện nghiệp vụ thứ hai. Mọi thứ tính LÚC ĐỌC, không ghi dòng nào (luật 19 / 26).
 */

const TRANG_THAI_DOI_CHUNG_CU = Object.keys(LIFECYCLE_REQUIRED_EVIDENCE) as ModelState[];

function asState(v: string | null): ModelState | null {
  return v && (MODEL_STATES as readonly string[]).includes(v) ? (v as ModelState) : null;
}

/**
 * Dữ kiện chứng cứ của mọi mẫu đang KHAI một trạng thái sản xuất (cả shop), hoặc của đúng các mẫu chỉ
 * định. "Lệnh đang mở" = DRAFT / SENT của sản phẩm của mẫu — cùng định nghĩa `openOrders` của
 * `getModelProductionSummary` (bài kiểm so hai đường trên cùng dữ liệu).
 */
export async function listModelEvidenceFacts(opts: { modelIds?: string[] } = {}): Promise<ModelEvidenceFacts[]> {
  if (opts.modelIds && opts.modelIds.length === 0) return [];
  const db = await getDb();
  const pm = schema.productModels;
  const rows = await db
    .select({
      modelId: pm.id,
      code: pm.code,
      state: pm.lifecycleState,
      productId: pm.productId,
      /*
        Cột bảng ngoài viết TƯỜNG MINH "product_models"."…": drizzle bỏ tên bảng khi truy vấn chỉ một bảng,
        nên `${pm.id}` trong câu con thành `"id"` trần và Postgres gắn nó vào BẢNG CON (tp.id) — mọi mẫu
        "không có topic", mọi lệnh "khớp chính nó". Bài kiểm CSDL bắt đúng lỗi này (cùng họ 42702 — handoff-c).
      */
      hasTopic: sql<boolean>`exists (select 1 from production_topics tp where tp.model_id = "product_models"."id")`,
      hasCostSheet: sql<boolean>`exists (select 1 from cost_sheets cs where cs.model_id = "product_models"."id")`,
      hasSample: sql<boolean>`exists (select 1 from samples sm where sm.model_id = "product_models"."id")`,
      hasDesignVersion: sql<boolean>`exists (select 1 from design_versions dv where dv.model_id = "product_models"."id")`,
      hasOpenProductionOrder: sql<boolean>`exists (select 1 from production_orders po where po.product_id = "product_models"."product_id" and po.status in ('DRAFT', 'SENT'))`,
    })
    .from(pm)
    .where(and(inArray(pm.lifecycleState, TRANG_THAI_DOI_CHUNG_CU), opts.modelIds ? inArray(pm.id, opts.modelIds) : undefined))
    .orderBy(pm.code);
  return rows.map((r) => ({
    modelId: r.modelId,
    code: r.code,
    state: asState(r.state),
    productId: r.productId,
    hasTopic: r.hasTopic === true || String(r.hasTopic) === "true",
    hasCostSheet: r.hasCostSheet === true || String(r.hasCostSheet) === "true",
    hasSample: r.hasSample === true || String(r.hasSample) === "true",
    hasDesignVersion: r.hasDesignVersion === true || String(r.hasDesignVersion) === "true",
    hasOpenProductionOrder: r.hasOpenProductionOrder === true || String(r.hasOpenProductionOrder) === "true",
  }));
}

/** Chỗ hở của cả shop (hoặc các mẫu chỉ định), kèm mốc khai gần nhất để trang Chất lượng dữ liệu in "gần nhất". */
export async function listLifecycleEvidenceGaps(opts: { modelIds?: string[] } = {}): Promise<(LifecycleEvidenceGap & { stateChangedAt: Date | null })[]> {
  const facts = await listModelEvidenceFacts(opts);
  const gaps = facts.map(lifecycleEvidenceGap).filter((g): g is LifecycleEvidenceGap => g !== null);
  if (!gaps.length) return [];
  const db = await getDb();
  const moc = await db
    .select({ id: schema.productModels.id, at: schema.productModels.stateChangedAt })
    .from(schema.productModels)
    .where(inArray(schema.productModels.id, gaps.map((g) => g.modelId)));
  const theoMau = new Map(moc.map((m) => [m.id, m.at]));
  return gaps.map((g) => ({ ...g, stateChangedAt: theoMau.get(g.modelId) ?? null }));
}

/**
 * Cùng dữ kiện, dựng từ tóm tắt sản xuất của trang 360 (`getModelProductionSummary`, Agent C) — trang 360
 * không đọc CSDL lần hai cho ô cảnh báo. Có bảng giá thành = có bản chốt HOẶC có bản nháp.
 */
export function evidenceFactsOfSummary(model: { id: string; code: string; state: ModelState | null }, s: ModelProductionSummary): ModelEvidenceFacts {
  return {
    modelId: model.id,
    code: model.code,
    state: model.state,
    productId: s.productId,
    hasTopic: s.topics.length > 0,
    hasCostSheet: s.finalCosting !== null || s.draftCostings > 0,
    hasSample: s.latestSample !== null,
    hasDesignVersion: s.approvedDesign !== null,
    hasOpenProductionOrder: s.openOrders.length > 0,
  };
}

// ─────────────────────────── PHIẾU NHẬP CHƯA NỐI ───────────────────────────

export type LinkableReceipt = {
  receiptId: string;
  receivedAt: Date;
  reference: string;
  supplier: string;
  /** Lệnh ứng viên theo `matchReceiptToOrders` — một lệnh ⇒ điền sẵn; nhiều ⇒ người chọn. */
  candidates: ProductionOrderLinkFacts[];
};

function mangChuoi(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? (JSON.parse(v) as unknown) : [];
  return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Phiếu NHẬP HÀNG chưa nối lệnh / lô mà có ít nhất một lệnh SX đang mở khớp. SQL chỉ LỌC THÔ (phiếu chưa
 * nối, có mẫu mã thuộc sản phẩm của một lệnh `SENT`) để không kéo cả sổ kho lên; điều kiện thật — ngày,
 * xưởng, trạng thái — đi qua `matchReceiptToOrders`, một chỗ duy nhất.
 */
export async function listLinkableReceipts(opts: { receiptIds?: string[] } = {}): Promise<LinkableReceipt[]> {
  if (opts.receiptIds && opts.receiptIds.length === 0) return [];
  const db = await getDb();
  const po = schema.productionOrders;
  const orders = await db.select({ id: po.id, code: po.code, status: po.status, productId: po.productId, supplierId: po.supplierId, sentAt: po.sentAt }).from(po).where(eq(po.status, "SENT"));
  const sanPham = [...new Set(orders.map((o) => o.productId).filter((x): x is string => !!x))];
  if (!sanPham.length) return [];
  const r = schema.stockReceipts;
  const ri = schema.stockReceiptItems;
  const pv = schema.productVariants;
  const rows = await db
    .select({
      id: r.id,
      kind: r.kind,
      productionOrderId: r.productionOrderId,
      productionBatchId: r.productionBatchId,
      receivedAt: r.receivedAt,
      supplierId: r.supplierId,
      reference: r.reference,
      supplier: r.supplier,
      productIds: sql<unknown>`json_agg(distinct ${pv.productId})`,
    })
    .from(r)
    .innerJoin(ri, eq(ri.receiptId, r.id))
    .innerJoin(pv, eq(pv.id, ri.variantId))
    .where(and(eq(r.kind, "RECEIPT"), isNull(r.productionOrderId), isNull(r.productionBatchId), inArray(pv.productId, sanPham), opts.receiptIds ? inArray(r.id, opts.receiptIds) : undefined))
    .groupBy(r.id)
    .orderBy(sql`${r.receivedAt} desc`, r.id);
  const out: LinkableReceipt[] = [];
  for (const row of rows) {
    const receivedAt = new Date(row.receivedAt);
    const candidates = matchReceiptToOrders(
      { receiptId: row.id, kind: row.kind, productionOrderId: row.productionOrderId, productionBatchId: row.productionBatchId, receivedAt, supplierId: row.supplierId, productIds: mangChuoi(row.productIds) },
      orders.map((o) => ({ ...o, sentAt: o.sentAt ? new Date(o.sentAt) : null })),
    );
    if (candidates.length) out.push({ receiptId: row.id, receivedAt, reference: row.reference, supplier: row.supplier, candidates });
  }
  return out;
}

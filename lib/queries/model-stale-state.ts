import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { buildStalePreview, BULK_DECLARE_MAX, type DeclarePreviewRow } from "@/lib/constants/model-bulk-declare";
import type { ModelEvidence } from "@/lib/constants/model-lifecycle";
import { MODEL_STATES } from "@/lib/constants/model-lifecycle";
import { staleCandidateState, staleFactsOf, type StaleStateFacts } from "@/lib/constants/model-stale-state";
import { getModelProductionSummariesBatch } from "@/lib/queries/model-production";
import { getModelsEvidenceBatch, listModels } from "@/lib/queries/models";
import type { ListParams } from "@/lib/search-params";

/**
 * ═══════════ DỮ KIỆN "LỜI KHAI ĐI SAU THỰC TẾ" THEO LÔ (Company OS · Agent ST) ═══════════
 *
 * Không công thức mới, không truy vấn theo từng mẫu: ghép BA lô đọc có sẵn rồi đưa qua luật thuần
 * `staleStateSuggestion` (lib/constants/model-stale-state.ts):
 *  · `getModelsEvidenceBatch` (Q)            — trạng thái thiết kế TK + chi QC 30 ngày đã ghép;
 *  · `getModelProductionSummariesBatch` (C)  — topic · giá thành · mẫu thử · bản duyệt · lệnh mở;
 *  · `getLinkedReceiptCountsBatch` (ở đây)    — số phiếu NHẬP HÀNG đã nối lệnh / lô của sản phẩm (một câu).
 *
 * Không đệm: lô dùng cho một thao tác GHI (lõi tính lại ở máy chủ) và cho bảng xem trước ngay trước cú bấm.
 */

/**
 * Số phiếu NHẬP HÀNG (`kind = 'RECEIPT'`) đã nối vào một lệnh sản xuất HOẶC một lô xưởng, của sản phẩm của
 * mẫu — MỘT câu cho cả lô. Phiếu nối lệnh: sản phẩm của LỆNH. Phiếu nối lô: sản phẩm của CÁC DÒNG phiếu (mẫu mã
 * nhập vào) — không đọc bảng lô xưởng, vì sổ đặt xưởng là sổ công nợ / giá thành chỉ bốn tệp của nó được chạm
 * (tests/workshop-ledger.test.ts). Mẫu có sản phẩm mà không phiếu nào ⇒ 0 (đã đếm); mẫu chưa có sản phẩm ⇒ vắng
 * mặt (CHƯA BIẾT — không có sản phẩm thì không có lệnh nào để nối).
 */
export async function getLinkedReceiptCountsBatch(modelIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = [...new Set(modelIds)];
  if (!ids.length) return out;
  const db = await getDb();
  const pm = schema.productModels;
  const models = await db.select({ id: pm.id, productId: pm.productId }).from(pm).where(inArray(pm.id, ids));
  const productIds = [...new Set(models.map((m) => m.productId).filter((x): x is string => !!x))];
  if (!productIds.length) return out;
  const r = schema.stockReceipts;
  const po = schema.productionOrders;
  const ri = schema.stockReceiptItems;
  const pv = schema.productVariants;
  const sp = sql<string>`coalesce(${po.productId}, ${pv.productId})`;
  const rows = await db
    .select({ productId: sp, n: sql<number>`count(distinct ${r.id})::int` })
    .from(r)
    .leftJoin(po, eq(po.id, r.productionOrderId))
    // Dòng phiếu chỉ cần cho phiếu nối LÔ (không nối lệnh) — phiếu nối lệnh đã có sản phẩm của lệnh.
    .leftJoin(ri, and(isNull(r.productionOrderId), isNotNull(r.productionBatchId), eq(ri.receiptId, r.id)))
    .leftJoin(pv, eq(pv.id, ri.variantId))
    .where(and(eq(r.kind, "RECEIPT"), or(inArray(po.productId, productIds), inArray(pv.productId, productIds))))
    .groupBy(sp);
  const theoSp = new Map(rows.map((x) => [String(x.productId), Number(x.n)]));
  for (const m of models) if (m.productId) out.set(m.id, theoSp.get(m.productId) ?? 0);
  return out;
}

/**
 * Dữ kiện của NHIỀU mẫu một lượt. `evidence` truyền vào khi người gọi đã đọc lô chứng cứ (lõi ghi đọc một lần
 * cho cả hai luồng khai / cập nhật). Mẫu không tồn tại ⇒ vắng mặt.
 */
export async function getModelsStaleFactsBatch(modelIds: readonly string[], opts: { now?: Date; evidence?: ReadonlyMap<string, ModelEvidence> } = {}): Promise<Map<string, StaleStateFacts>> {
  const out = new Map<string, StaleStateFacts>();
  const ids = [...new Set(modelIds)];
  if (!ids.length) return out;
  const [evidence, production, receipts] = await Promise.all([
    opts.evidence ? Promise.resolve(opts.evidence) : getModelsEvidenceBatch(ids, { now: opts.now }),
    getModelProductionSummariesBatch(ids),
    getLinkedReceiptCountsBatch(ids),
  ]);
  for (const id of ids) {
    const p = production.get(id);
    if (!p) continue; // không có trong sổ
    out.set(id, staleFactsOf(evidence.get(id) ?? null, p, receipts.get(id) ?? null));
  }
  return out;
}

/** Lời khai có thể nhận đề xuất — cho bộ lọc `state` của `listModels`. */
export const STALE_CANDIDATE_STATES: readonly string[] = MODEL_STATES.filter((s) => staleCandidateState(s));

/**
 * Bảng xem trước "Cập nhật theo thực tế" trên `/models`: mẫu ĐÃ KHAI khớp ô tìm / bộ lọc "Nối với" đang áp
 * (bỏ phân trang, tối đa `BULK_DECLARE_MAX`), chỉ giữ dòng máy có đề xuất.
 */
export async function listStaleStatePreview(params: ListParams, opts: { now?: Date } = {}): Promise<{ rows: DeclarePreviewRow[]; scanned: number; total: number }> {
  const daKhai = await listModels({ ...params, filters: { ...params.filters, state: [...STALE_CANDIDATE_STATES] }, page: 1, pageSize: BULK_DECLARE_MAX, sort: "code", dir: "asc" });
  const facts = await getModelsStaleFactsBatch(
    daKhai.rows.map((r) => r.id),
    opts,
  );
  return { rows: buildStalePreview(daKhai.rows, facts), scanned: daKhai.rows.length, total: daKhai.total };
}

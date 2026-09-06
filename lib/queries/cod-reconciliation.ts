import { and, eq, gte, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import { COD_COLLECTABLE } from "@/lib/queries/return-rate";
import type { Period } from "@/lib/search-params";

const s = schema.shipments;
const b = schema.codBatches;

/**
 * ĐỐI SOÁT TIỀN COD — trả lời đúng sáu câu hỏi: phải thu, đã thu thực tế, đã về ngân hàng,
 * phí, còn treo, chênh lệch ở đâu.
 *
 * Nguyên tắc: mỗi con số đi kèm MỘT BẬC BẰNG CHỨNG, không trộn lẫn.
 *   1. KHAI BÁO   — `shipments.cod_amount`: số phải thu ghi trên vận đơn. Chưa phải tiền.
 *   2. ĐVVC BÁO   — `shipments.cod_collected` khi cod_status đã thu. Viettel Post nói đã thu,
 *                   nhưng chưa có chứng từ tiền nào của shop.
 *   3. CÓ BẢNG KÊ — vận đơn đã ghép vào một đợt (`cod_batch_id`). Truy được về chứng từ.
 *   4. VỀ TÀI KHOẢN — `cod_batches.total_amount`: tiền thực nhận sau khi ĐVVC trừ cước.
 *
 * Khoảng cách giữa bậc 2 và bậc 3 chính là phần "ĐVVC bảo đã thu nhưng shop chưa có chứng từ".
 */

const COLLECTED_STATUSES = sql`${s.codStatus} in ('COLLECTED','RECONCILED','PAID_TO_BANK')`;
/** Tiền COD đã thu theo ĐVVC: ưu tiên số thực thu, chưa có thì lấy COD khai báo khi trạng thái đã xác nhận thu. */
const COLLECTED_AMOUNT = sql<number>`coalesce(nullif(${s.codCollected}, 0), ${s.codAmount}, 0)`;

function batchPeriod(period: Period): SQL[] {
  const conds: SQL[] = [];
  if (period.from) conds.push(gte(b.receivedAt, period.from));
  if (period.to) conds.push(lte(b.receivedAt, period.to));
  return conds;
}

export type CodReconciliation = Awaited<ReturnType<typeof codReconciliation>>;

export async function codReconciliation(period: Period) {
  const db = await getDb();
  return memo(`cod-reconciliation:${period.key}:${period.fromKey ?? ""}:${period.toKey ?? ""}`, 90, async () => {
    const [shipmentRow] = await db
      .select({
        // 1. PHẢI THU: vận đơn còn khả năng thu tiền (chưa hoàn / chưa huỷ), theo COD khai báo.
        receivableAmount: sql<number>`coalesce(sum(${s.codAmount}) filter (where ${COD_COLLECTABLE} and ${s.codAmount} > 0), 0)`,
        receivableCount: sql<number>`count(*) filter (where ${COD_COLLECTABLE} and ${s.codAmount} > 0)`,

        // 2. ĐVVC BÁO ĐÃ THU
        collectedAmount: sql<number>`coalesce(sum(${COLLECTED_AMOUNT}) filter (where ${COLLECTED_STATUSES}), 0)`,
        collectedCount: sql<number>`count(*) filter (where ${COLLECTED_STATUSES})`,

        // 3. CÓ BẢNG KÊ: đã ghép được vào một đợt tiền về
        onStatementAmount: sql<number>`coalesce(sum(${COLLECTED_AMOUNT}) filter (where ${s.codBatchId} is not null), 0)`,
        onStatementCount: sql<number>`count(*) filter (where ${s.codBatchId} is not null)`,

        // ĐÃ THU NHƯNG CHƯA CÓ CHỨNG TỪ — phần cần đối soát
        unprovenAmount: sql<number>`coalesce(sum(${COLLECTED_AMOUNT}) filter (where ${COLLECTED_STATUSES} and ${s.codBatchId} is null), 0)`,
        unprovenCount: sql<number>`count(*) filter (where ${COLLECTED_STATUSES} and ${s.codBatchId} is null)`,

        // CHƯA THU: đã giao xong nhưng ĐVVC chưa xác nhận thu
        pendingAmount: sql<number>`coalesce(sum(${s.codAmount}) filter (where ${s.codStatus} = 'PENDING' and ${COD_COLLECTABLE} and ${s.codAmount} > 0), 0)`,
        pendingCount: sql<number>`count(*) filter (where ${s.codStatus} = 'PENDING' and ${COD_COLLECTABLE} and ${s.codAmount} > 0)`,

        // Vận đơn đã hoàn/huỷ mà trạng thái COD vẫn treo "còn thu được" → dữ liệu mâu thuẫn
        staleOnReturned: sql<number>`count(*) filter (where not ${COD_COLLECTABLE} and ${s.codStatus} in ('PENDING','COLLECTED'))`,
        staleOnReturnedAmount: sql<number>`coalesce(sum(${s.codAmount}) filter (where not ${COD_COLLECTABLE} and ${s.codStatus} in ('PENDING','COLLECTED')), 0)`,
      })
      .from(s);

    const batchConds = batchPeriod(period);
    const [batchRow] = await db
      .select({
        batches: sql<number>`count(*)`,
        gross: sql<number>`coalesce(sum(coalesce(nullif(${b.codGross}, 0), ${b.totalAmount} + ${b.feeTotal})), 0)`,
        net: sql<number>`coalesce(sum(${b.totalAmount}), 0)`,
        fee: sql<number>`coalesce(sum(${b.feeTotal}), 0)`,
        linkedShipments: sql<number>`coalesce(sum((select count(*) from shipments sh where sh.cod_batch_id = ${b.id})), 0)`,
        linkedAmount: sql<number>`coalesce(sum((select coalesce(sum(coalesce(nullif(sh.cod_collected,0), sh.cod_amount, 0)), 0) from shipments sh where sh.cod_batch_id = ${b.id})), 0)`,
      })
      .from(b)
      .where(batchConds.length ? and(...batchConds) : undefined);

    const n = (v: unknown) => Number(v ?? 0);
    const gross = n(batchRow?.gross);
    const linkedAmount = n(batchRow?.linkedAmount);
    const collectedAmount = n(shipmentRow?.collectedAmount);

    return {
      // 1 — phải thu
      receivable: { amount: n(shipmentRow?.receivableAmount), count: n(shipmentRow?.receivableCount) },
      // 2 — ĐVVC báo đã thu
      collected: { amount: collectedAmount, count: n(shipmentRow?.collectedCount) },
      // 3 — có bảng kê (truy được về chứng từ)
      onStatement: { amount: n(shipmentRow?.onStatementAmount), count: n(shipmentRow?.onStatementCount) },
      // 4 — tiền về tài khoản theo chứng từ đợt
      bank: {
        batches: n(batchRow?.batches),
        gross,
        net: n(batchRow?.net),
        fee: n(batchRow?.fee),
        linkedShipments: n(batchRow?.linkedShipments),
        linkedAmount,
        /** Phần tiền trên bảng kê CHƯA ghép được về vận đơn nào — không truy nguyên được. */
        unlinkedAmount: Math.max(0, gross - linkedAmount),
      },
      // còn treo / chênh lệch
      unproven: { amount: n(shipmentRow?.unprovenAmount), count: n(shipmentRow?.unprovenCount) },
      pending: { amount: n(shipmentRow?.pendingAmount), count: n(shipmentRow?.pendingCount) },
      stale: { count: n(shipmentRow?.staleOnReturned), amount: n(shipmentRow?.staleOnReturnedAmount) },
      /** Tỷ lệ tiền đã thu có chứng từ (%); null khi chưa thu đồng nào — hiển thị "—", không phải 0%. */
      provenRate: collectedAmount > 0 ? Math.round((n(shipmentRow?.onStatementAmount) / collectedAmount) * 1000) / 10 : null,
    };
  });
}

export type CodBatchGap = {
  id: string;
  reference: string;
  receivedAt: Date | string;
  gross: number;
  net: number;
  fee: number;
  linkedShipments: number;
  linkedAmount: number;
  gap: number;
  source: string;
};

/** Từng đợt tiền về: chênh lệch giữa COD trên bảng kê và tổng COD của vận đơn đã ghép. */
export async function codBatchGaps(period: Period): Promise<CodBatchGap[]> {
  const db = await getDb();
  const conds = batchPeriod(period);
  const rows = await db
    .select({
      id: b.id,
      reference: b.reference,
      receivedAt: b.receivedAt,
      source: b.source,
      gross: sql<number>`coalesce(nullif(${b.codGross}, 0), ${b.totalAmount} + ${b.feeTotal})`,
      net: b.totalAmount,
      fee: b.feeTotal,
      linkedShipments: sql<number>`(select count(*) from shipments sh where sh.cod_batch_id = ${b.id})`,
      linkedAmount: sql<number>`(select coalesce(sum(coalesce(nullif(sh.cod_collected,0), sh.cod_amount, 0)), 0) from shipments sh where sh.cod_batch_id = ${b.id})`,
    })
    .from(b)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(sql`${b.receivedAt} desc`);

  return rows.map((r) => ({
    ...r,
    gross: Number(r.gross ?? 0),
    net: Number(r.net ?? 0),
    fee: Number(r.fee ?? 0),
    linkedShipments: Number(r.linkedShipments ?? 0),
    linkedAmount: Number(r.linkedAmount ?? 0),
    gap: Number(r.gross ?? 0) - Number(r.linkedAmount ?? 0),
  }));
}

/** Vận đơn ĐVVC báo đã thu nhưng chưa ghép được vào bảng kê nào — danh sách cần đối soát. */
export async function unprovenCollectedShipments(page: number, pageSize: number, q: string) {
  const db = await getDb();
  const conds: SQL[] = [COLLECTED_STATUSES as SQL, isNull(s.codBatchId)];
  const term = q.trim();
  if (term) {
    const like = `%${term}%`;
    conds.push(sql`(${s.vtpOrderNumber} ilike ${like} or ${s.trackingCode} ilike ${like} or ${s.receiverName} ilike ${like} or ${s.receiverPhone} ilike ${like})`);
  }
  const where = and(...conds);
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: s.id,
        vtpOrderNumber: s.vtpOrderNumber,
        orderId: s.orderId,
        stage: s.stage,
        codStatus: s.codStatus,
        codAmount: s.codAmount,
        codCollected: s.codCollected,
        deliveredAt: s.deliveredAt,
        receiverName: s.receiverName,
      })
      .from(s)
      .where(where)
      .orderBy(sql`coalesce(${s.deliveredAt}, ${s.vtpStatusDate}, ${s.updatedAt}) desc`)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)` }).from(s).where(where),
  ]);
  return { rows, total: Number(total?.n ?? 0) };
}

/** Vận đơn đã hoàn/huỷ nhưng trạng thái COD vẫn treo như còn thu được — cần dọn. */
export async function staleCodOnReturned(page: number, pageSize: number) {
  const db = await getDb();
  const where = and(sql`not ${COD_COLLECTABLE}`, sql`${s.codStatus} in ('PENDING','COLLECTED')`);
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: s.id,
        vtpOrderNumber: s.vtpOrderNumber,
        orderId: s.orderId,
        stage: s.stage,
        codStatus: s.codStatus,
        codAmount: s.codAmount,
        codCollected: s.codCollected,
        deliveredAt: s.deliveredAt,
        receiverName: s.receiverName,
      })
      .from(s)
      .where(where)
      .orderBy(sql`coalesce(${s.returnedAt}, ${s.updatedAt}) desc`)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)` }).from(s).where(where),
  ]);
  return { rows, total: Number(total?.n ?? 0) };
}

/** Đợt tiền về chưa ghép được vận đơn nào — tiền có thật nhưng không truy nguyên được. */
export async function unlinkedBatches() {
  const db = await getDb();
  return db
    .select({ id: b.id, reference: b.reference, receivedAt: b.receivedAt, net: b.totalAmount })
    .from(b)
    .where(and(isNotNull(b.id), sql`not exists (select 1 from shipments sh where sh.cod_batch_id = ${b.id})`))
    .orderBy(sql`${b.receivedAt} desc`);
}

/** Dùng cho kiểm thử/khai báo: điều kiện vận đơn còn khả năng thu tiền. */
export { COD_COLLECTABLE, COLLECTED_STATUSES, COLLECTED_AMOUNT };

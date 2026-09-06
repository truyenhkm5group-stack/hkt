import { and, asc, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import type { DqIssue, VerifiedOutcome } from "@/lib/constants/data-quality";
import { CONFIRMED_STAGES } from "@/lib/constants/pancake";
import { RETURN_RULE } from "@/lib/constants/returns";
import {
  HAS_CASH_PROOF,
  IS_PANCAKE_DECLARED_ONLY,
  IS_RETURN_NOT_RECEIVED,
  IS_STATUS_CONFLICT,
  IS_VTP_LOW_CASH,
  ORDER_OUTCOME,
  ORDER_OUTCOME_VERIFIED,
  VERIFIED_CASH,
} from "@/lib/queries/return-rate";
import type { Period } from "@/lib/search-params";

const o = schema.orders;
const s = schema.shipments;
const oi = schema.orderItems;

/** COD KHAI BÁO (chưa chứng minh đã thu) — chỉ dùng để nêu "giá trị đang chờ xác minh". */
const DECLARED_COD = sql<number>`coalesce(nullif(${s.codAmount}, 0), ${o.cod}, 0)`;
const DECLARED_REVENUE = sql<number>`coalesce(${o.totalPriceAfterDiscount}, 0)`;

/**
 * Phạm vi đơn: dùng CHUNG `CONFIRMED_STAGES` với Tổng quan / Báo cáo lợi nhuận / Lương / Quảng cáo.
 * Nếu trang này đếm cả đơn "Mới" chưa xác nhận thì cùng một kỳ sẽ ra tổng đơn khác Tổng quan,
 * và bảng "Ảnh hưởng đến quyết định" sẽ so hai phạm vi khác nhau — vô nghĩa.
 */
function periodWhere(period: Period): SQL[] {
  const conds: SQL[] = [inArray(o.stage, [...CONFIRMED_STAGES])];
  if (period.from) conds.push(gte(o.insertedAt, period.from));
  if (period.to) conds.push(lte(o.insertedAt, period.to));
  return conds;
}

const num = (v: unknown) => Number(v ?? 0);
/** Tỷ lệ %; trả null khi mẫu số = 0 để giao diện hiện "—" thay vì 0%. */
const pct = (top: number, bottom: number) => (bottom > 0 ? Math.round((top / bottom) * 1000) / 10 : null);

export type DataQualitySummary = Awaited<ReturnType<typeof dataQualitySummary>>;

/**
 * Toàn bộ KPI của Trung tâm Chất lượng dữ liệu.
 * Con số "thực tế" dựa trên ORDER_OUTCOME_VERIFIED (bắt buộc có tiền thực thu);
 * con số "legacy" dựa trên ORDER_OUTCOME đang chạy, để chỉ ra chênh lệch.
 */
export async function dataQualitySummary(period: Period) {
  const db = await getDb();
  return memo(`data-quality:summary:${period.key}:${period.fromKey ?? ""}:${period.toKey ?? ""}`, 90, async () => {
    const where = periodWhere(period);
    const V = ORDER_OUTCOME_VERIFIED;
    const L = ORDER_OUTCOME;
    const scope = where.length ? and(...where) : undefined;

    const [row] = await db
      .select({
        total: sql<number>`count(*) filter (where ${V} <> 'CANCELLED')`,
        delivered: sql<number>`count(*) filter (where ${V} = 'DELIVERED')`,
        returned: sql<number>`count(*) filter (where ${V} in ('RETURNED','RETURNED_BY_RULE'))`,
        inTransit: sql<number>`count(*) filter (where ${V} = 'IN_TRANSIT')`,
        unverified: sql<number>`count(*) filter (where ${V} = 'UNVERIFIED')`,
        notShipped: sql<number>`count(*) filter (where ${V} = 'NOT_SHIPPED')`,
        cancelled: sql<number>`count(*) filter (where ${V} = 'CANCELLED')`,

        provenCash: sql<number>`coalesce(sum(${VERIFIED_CASH}) filter (where ${V} = 'DELIVERED'), 0)`,
        unverifiedCod: sql<number>`coalesce(sum(${DECLARED_COD}) filter (where ${V} = 'UNVERIFIED'), 0)`,
        legacyRevenue: sql<number>`coalesce(sum(${DECLARED_REVENUE}) filter (where ${L} = 'DELIVERED'), 0)`,
        verifiedRevenue: sql<number>`coalesce(sum(${DECLARED_REVENUE}) filter (where ${V} = 'DELIVERED'), 0)`,

        pancakeDeclared: sql<number>`count(*) filter (where ${IS_PANCAKE_DECLARED_ONLY})`,
        vtpLowCash: sql<number>`count(*) filter (where ${IS_VTP_LOW_CASH})`,
        statusConflict: sql<number>`count(*) filter (where ${IS_STATUS_CONFLICT})`,

        mismatch: sql<number>`count(*) filter (where ${L} <> ${V})`,
        legacyDelivered: sql<number>`count(*) filter (where ${L} = 'DELIVERED')`,
        legacyReturned: sql<number>`count(*) filter (where ${L} in ('RETURNED','RETURNED_BY_RULE'))`,
        marketingRiskRevenue: sql<number>`coalesce(sum(${DECLARED_REVENUE}) filter (where ${L} = 'DELIVERED' and ${V} <> 'DELIVERED'), 0)`,
      })
      .from(o)
      .leftJoin(s, eq(s.orderId, o.id))
      .where(scope);

    // Vận đơn chưa ghép được với đơn ERP (nằm ngoài không gian bảng orders).
    const [unlinked] = await db
      .select({
        count: sql<number>`count(*)`,
        codAmount: sql<number>`coalesce(sum(coalesce(${s.codAmount}, 0)), 0)`,
        codCollected: sql<number>`coalesce(sum(coalesce(${s.codCollected}, 0)), 0)`,
        open: sql<number>`count(*) filter (where ${s.isFinal} = false)`,
      })
      .from(s)
      .where(isNull(s.orderId));

    // Hàng hoàn kho chưa xác nhận nhận về → đang bị cộng nhầm vào tồn ERP.
    // Đếm vận đơn ở GRAIN VẬN ĐƠN (kể cả vận đơn chưa ghép được mẫu mã nào trong ERP),
    // còn số SKU/sản phẩm ở GRAIN DÒNG HÀNG. Hai con số khác grain nên tách hai truy vấn.
    const [returnShipments] = await db
      .select({ n: sql<number>`count(*)` })
      .from(s)
      .where(IS_RETURN_NOT_RECEIVED);

    const [returnRisk] = await db
      .select({
        skus: sql<number>`count(distinct ${oi.variantId})`,
        units: sql<number>`coalesce(sum(${oi.quantity}), 0)`,
      })
      .from(s)
      .innerJoin(o, eq(o.id, s.orderId))
      .innerJoin(oi, eq(oi.orderId, o.id))
      .where(and(IS_RETURN_NOT_RECEIVED, eq(oi.isBonus, false)));

    const delivered = num(row?.delivered);
    const returned = num(row?.returned);
    const legacyDelivered = num(row?.legacyDelivered);
    const legacyReturned = num(row?.legacyReturned);

    return {
      total: num(row?.total),
      delivered,
      returned,
      inTransit: num(row?.inTransit),
      unverified: num(row?.unverified),
      notShipped: num(row?.notShipped),
      cancelled: num(row?.cancelled),
      /** null khi chưa có đơn nào kết thúc — KHÔNG hiển thị 0%. */
      successRate: pct(delivered, delivered + returned),
      legacySuccessRate: pct(legacyDelivered, legacyDelivered + legacyReturned),
      provenCash: num(row?.provenCash),
      unverifiedCod: num(row?.unverifiedCod),
      legacyRevenue: num(row?.legacyRevenue),
      verifiedRevenue: num(row?.verifiedRevenue),
      pancakeDeclared: num(row?.pancakeDeclared),
      vtpLowCash: num(row?.vtpLowCash),
      statusConflict: num(row?.statusConflict),
      mismatch: num(row?.mismatch),
      legacyDelivered,
      marketingRiskRevenue: num(row?.marketingRiskRevenue),
      unlinkedShipments: num(unlinked?.count),
      unlinkedOpen: num(unlinked?.open),
      unlinkedCod: num(unlinked?.codAmount),
      unlinkedCollected: num(unlinked?.codCollected),
      returnRiskShipments: num(returnShipments?.n),
      returnRiskSkus: num(returnRisk?.skus),
      returnRiskUnits: num(returnRisk?.units),
      rule: RETURN_RULE,
    };
  });
}

/** Điều kiện SQL cho từng nhóm vấn đề (drill-down theo đơn hàng). */
function issueCondition(issue: DqIssue): SQL {
  switch (issue) {
    case "pancake-declared":
      return IS_PANCAKE_DECLARED_ONLY as SQL;
    case "vtp-low-cash":
      return IS_VTP_LOW_CASH as SQL;
    case "status-conflict":
      return IS_STATUS_CONFLICT as SQL;
    case "return-not-received":
      return IS_RETURN_NOT_RECEIVED as SQL;
    default:
      return sql`${ORDER_OUTCOME_VERIFIED} = 'UNVERIFIED'`;
  }
}

export type DqOrderRow = {
  id: string;
  insertedAt: Date | string | null;
  orderStage: string;
  shipmentStage: string | null;
  vtpOrderNumber: string | null;
  declaredRevenue: number;
  declaredCod: number;
  cash: number;
  hasCashProof: boolean;
  legacyOutcome: string;
  verifiedOutcome: VerifiedOutcome;
  customerName: string;
  returnReceivedAt: Date | string | null;
};

/** Danh sách đơn thuộc một nhóm vấn đề, kèm tổng số để phân trang. */
export async function dataQualityOrders(issue: DqIssue, period: Period, page: number, pageSize: number, q: string) {
  const db = await getDb();
  const conds: SQL[] = [...periodWhere(period), issueCondition(issue)];
  const term = q.trim();
  if (term) {
    const like = `%${term}%`;
    conds.push(sql`(${o.id} ilike ${like} or ${s.vtpOrderNumber} ilike ${like} or ${o.billFullName} ilike ${like} or ${o.billPhone} ilike ${like})`);
  }
  const where = and(...conds);

  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: o.id,
        insertedAt: o.insertedAt,
        orderStage: o.stage,
        shipmentStage: s.stage,
        vtpOrderNumber: s.vtpOrderNumber,
        declaredRevenue: DECLARED_REVENUE,
        declaredCod: DECLARED_COD,
        cash: VERIFIED_CASH,
        hasCashProof: sql<boolean>`${HAS_CASH_PROOF}`,
        legacyOutcome: ORDER_OUTCOME,
        verifiedOutcome: ORDER_OUTCOME_VERIFIED,
        customerName: sql<string>`coalesce(${o.billFullName}, '')`,
        returnReceivedAt: s.returnReceivedAt,
      })
      .from(o)
      .leftJoin(s, eq(s.orderId, o.id))
      .where(where)
      .orderBy(desc(o.insertedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)` }).from(o).leftJoin(s, eq(s.orderId, o.id)).where(where),
  ]);
  return { rows: rows as DqOrderRow[], total: num(total?.n) };
}

export type DqShipmentRow = {
  id: string;
  vtpOrderNumber: string | null;
  orderReference: string | null;
  stage: string;
  codStatus: string;
  codAmount: number | null;
  codCollected: number | null;
  receiverName: string;
  receiverPhone: string;
  vtpStatusName: string | null;
  updatedAt: Date | string | null;
  isFinal: boolean;
  returnReceivedAt: Date | string | null;
};

const SHIPMENT_COLUMNS = {
  id: s.id,
  vtpOrderNumber: s.vtpOrderNumber,
  orderReference: s.orderReference,
  stage: s.stage,
  codStatus: s.codStatus,
  codAmount: s.codAmount,
  codCollected: s.codCollected,
  receiverName: s.receiverName,
  receiverPhone: s.receiverPhone,
  vtpStatusName: s.vtpStatusName,
  updatedAt: s.updatedAt,
  isFinal: s.isFinal,
  returnReceivedAt: s.returnReceivedAt,
} as const;

/** Vận đơn chưa ghép được với đơn ERP — "Vận đơn chưa đối soát". */
export async function unlinkedShipments(page: number, pageSize: number, q: string, sort: string, dir: "asc" | "desc") {
  const db = await getDb();
  const conds: SQL[] = [isNull(s.orderId)];
  const term = q.trim();
  if (term) {
    const like = `%${term}%`;
    conds.push(sql`(${s.vtpOrderNumber} ilike ${like} or ${s.orderReference} ilike ${like} or ${s.receiverName} ilike ${like} or ${s.receiverPhone} ilike ${like})`);
  }
  const where = and(...conds);
  const sortable = { vtpOrderNumber: s.vtpOrderNumber, stage: s.stage, codAmount: s.codAmount, codCollected: s.codCollected, updatedAt: s.updatedAt } as const;
  const column = sortable[sort as keyof typeof sortable] ?? s.updatedAt;

  const [rows, [total]] = await Promise.all([
    db.select(SHIPMENT_COLUMNS).from(s).where(where).orderBy(dir === "asc" ? asc(column) : desc(column)).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)` }).from(s).where(where),
  ]);
  return { rows: rows as DqShipmentRow[], total: num(total?.n) };
}

/** Vận đơn đã/đang hoàn nhưng kho chưa xác nhận nhận hàng — drill-down của rủi ro tồn kho. */
export async function returnsAwaitingWarehouse(page: number, pageSize: number, q: string) {
  const db = await getDb();
  const conds: SQL[] = [IS_RETURN_NOT_RECEIVED as SQL];
  const term = q.trim();
  if (term) {
    const like = `%${term}%`;
    conds.push(sql`(${s.vtpOrderNumber} ilike ${like} or ${s.receiverName} ilike ${like} or ${s.receiverPhone} ilike ${like})`);
  }
  const where = and(...conds);
  const [rows, [total]] = await Promise.all([
    db.select(SHIPMENT_COLUMNS).from(s).where(where).orderBy(desc(s.returnedAt), desc(s.updatedAt)).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)` }).from(s).where(where),
  ]);
  return { rows: rows as DqShipmentRow[], total: num(total?.n) };
}

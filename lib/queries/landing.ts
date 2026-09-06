import { and, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { RiskAssessment } from "@/lib/alerts/risk";
import { memo, periodKey } from "@/lib/cache";
import type { DuplicateHit, LandingStatus } from "@/lib/constants/landing";
import type { OrderOutcome } from "@/lib/constants/returns";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import type { Period } from "@/lib/search-params";

const l = schema.landingOrders;
const o = schema.orders;
const s = schema.shipments;
const pv = schema.productVariants;
const p = schema.products;

export type LandingRow = {
  id: string;
  rowIndex: number;
  submittedAt: Date | null;
  createdAt: Date;
  customerName: string;
  phone: string;
  address: string;
  province: string;
  productText: string;
  variantText: string;
  sizeText: string;
  colorText: string;
  quantity: number;
  price: number;
  total: number;
  note: string;
  source: string;
  sheetStatus: string;
  status: LandingStatus;
  variantId: string | null;
  variantLabel: string;
  variantMatchScore: number;
  orderId: string | null;
  orderSystemId: number | null;
  orderStage: string | null;
  outcome: OrderOutcome | null;
  shipmentStage: string | null;
  tracking: string | null;
  pancakeSystemId: number | null;
  /** Đã có đơn trên POS chưa (HAS / DRAFT / NONE) */
  posState: LandingPosState;
  /** Mã hàng suy ra từ sheet (Q002, Q003…) */
  landingProductCode: string;
  pushedAt: Date | null;
  pushError: string;
  duplicates: DuplicateHit[];
  risk: RiskAssessment | null;
  assignee: string;
  internalNote: string;
};

/** Trạng thái đơn trên POS của một dòng landing: HAS = đã có đơn Pancake (ghép theo SĐT hoặc do ERP gửi), DRAFT = đã gửi POS nhưng chưa đồng bộ về, NONE = chưa lên POS */
export type LandingPosState = "HAS" | "DRAFT" | "NONE";
export const LANDING_POS_LABEL: Record<LandingPosState, string> = { HAS: "Đã có đơn POS", DRAFT: "Đơn nháp POS · chờ đồng bộ", NONE: "Chưa lên POS" };
export type LandingFilters = { q?: string; status?: LandingStatus[]; outcome?: (OrderOutcome | "NONE")[]; flag?: ("DUP" | "RISK" | "NO_VARIANT" | "PUSH_ERROR" | "MISSING_INFO")[]; pos?: LandingPosState[]; product?: string[]; period: Period };

/** Mã hàng của dòng landing: cột sản phẩm trên sheet (Q003…) hoặc tên tab (tab:Q003 → Q003) */
const PRODUCT_CODE = sql<string>`upper(coalesce(nullif(regexp_replace(${l.productText}, '^.*?([A-Za-z]{1,2}[0-9]{3}).*$', '\\1'), ''), nullif(regexp_replace(${l.sheetGid}, '^tab:', ''), ''), ''))`;
/** Thiếu thông tin để lên đơn: không có địa chỉ, hoặc không rõ size (chưa ghép mẫu mã và không đọc được size) */
const MISSING_INFO = sql`(${l.status} <> 'CANCELLED' and (${l.address} = '' or (${l.variantId} is null and ${l.sizeText} = '')))`;
const POS_STATE = sql<LandingPosState>`case when ${l.orderId} is not null then 'HAS' when ${l.pancakeSystemId} is not null then 'DRAFT' else 'NONE' end`;

function conds(f: LandingFilters): SQL[] {
  const out: SQL[] = [];
  const at = sql`coalesce(${l.submittedAt}, ${l.createdAt})`;
  if (f.period.from) out.push(gte(at, f.period.from));
  if (f.period.to) out.push(lte(at, f.period.to));
  if (f.q) {
    const q = `%${f.q.trim()}%`;
    const digits = f.q.replace(/\D/g, "");
    out.push(or(ilike(l.customerName, q), ilike(l.productText, q), ilike(l.address, q), digits.length >= 3 ? ilike(l.phone, `%${digits}%`) : sql`false`) as SQL);
  }
  if (f.status?.length) out.push(inArray(l.status, f.status));
  if (f.outcome?.length) {
    const parts: SQL[] = [];
    for (const oc of f.outcome) parts.push(oc === "NONE" ? isNull(l.orderId) : sql`(${l.orderId} is not null and ${ORDER_OUTCOME} = ${oc})`);
    out.push(or(...parts) as SQL);
  }
  if (f.pos?.length) out.push(inArray(POS_STATE, f.pos));
  if (f.product?.length) out.push(inArray(PRODUCT_CODE, f.product.map((c) => c.toUpperCase())));
  for (const fl of f.flag ?? []) {
    if (fl === "DUP") out.push(sql`jsonb_array_length(coalesce(${l.duplicates}, '[]'::jsonb)) > 0`);
    if (fl === "RISK") out.push(sql`coalesce((${l.risk}->>'risky')::boolean, false)`);
    if (fl === "NO_VARIANT") out.push(isNull(l.variantId));
    if (fl === "PUSH_ERROR") out.push(sql`${l.pushError} <> ''`);
    if (fl === "MISSING_INFO") out.push(MISSING_INFO);
  }
  return out;
}

export async function listLandingOrders(f: LandingFilters, limit = 300): Promise<LandingRow[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: l.id,
      rowIndex: l.rowIndex,
      submittedAt: l.submittedAt,
      createdAt: l.createdAt,
      customerName: l.customerName,
      phone: l.phone,
      address: l.address,
      province: l.province,
      productText: l.productText,
      variantText: l.variantText,
      sizeText: l.sizeText,
      colorText: l.colorText,
      quantity: l.quantity,
      price: l.price,
      total: l.total,
      note: l.note,
      source: l.source,
      sheetStatus: l.sheetStatus,
      status: l.status,
      variantId: l.variantId,
      variantMatchScore: l.variantMatchScore,
      productName: p.name,
      productCode: p.customId,
      vSize: pv.size,
      vColor: pv.color,
      orderId: l.orderId,
      orderSystemId: o.systemId,
      orderStage: o.stage,
      outcome: sql<OrderOutcome | null>`case when ${l.orderId} is null then null else ${ORDER_OUTCOME} end`,
      shipmentStage: s.stage,
      tracking: sql<string | null>`coalesce(${s.vtpOrderNumber}, ${s.trackingCode})`,
      pancakeSystemId: l.pancakeSystemId,
      posState: POS_STATE,
      landingProductCode: PRODUCT_CODE,
      pushedAt: l.pushedAt,
      pushError: l.pushError,
      duplicates: l.duplicates,
      risk: l.risk,
      assignee: l.assignee,
      internalNote: l.internalNote,
    })
    .from(l)
    .leftJoin(o, eq(o.id, l.orderId))
    .leftJoin(s, eq(s.orderId, o.id))
    .leftJoin(pv, eq(pv.id, l.variantId))
    .leftJoin(p, eq(p.id, pv.productId))
    .where(and(...conds(f)))
    .orderBy(desc(sql`coalesce(${l.submittedAt}, ${l.createdAt})`))
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    status: r.status as LandingStatus,
    variantLabel: r.variantId ? `${r.productCode ? `${r.productCode} · ` : ""}${r.productName ?? ""}${r.vSize || r.vColor ? ` · ${[r.vColor, r.vSize].filter(Boolean).join(" ")}` : ""}` : "",
    duplicates: Array.isArray(r.duplicates) ? (r.duplicates as DuplicateHit[]).map((d) => ({ ...d, at: d.at ? new Date(d.at) : null })) : [],
    risk: (r.risk as RiskAssessment | null) ?? null,
  }));
}

export type LandingSummary = { total: number; byStatus: Record<LandingStatus, number>; byOutcome: Record<OrderOutcome | "NONE", number>; duplicates: number; risky: number; noVariant: number; pushErrors: number; missingInfo: number; lastImportAt: Date | null };

export async function landingSummary(period: Period): Promise<LandingSummary> {
  return memo(`landingSummary:${periodKey(period)}`, 60_000, async () => {
    const db = await getDb();
    const where = and(...conds({ period }));
    const [row] = await db
      .select({
        total: sql<number>`count(*)`,
        st: sql<Record<string, number>>`coalesce(jsonb_object_agg(${l.status}, 1) filter (where false), '{}'::jsonb)`,
        duplicates: sql<number>`count(*) filter (where jsonb_array_length(coalesce(${l.duplicates}, '[]'::jsonb)) > 0)`,
        risky: sql<number>`count(*) filter (where coalesce((${l.risk}->>'risky')::boolean, false))`,
        noVariant: sql<number>`count(*) filter (where ${l.variantId} is null and ${l.status} <> 'CANCELLED')`,
        pushErrors: sql<number>`count(*) filter (where ${l.pushError} <> '')`,
        missingInfo: sql<number>`count(*) filter (where ${MISSING_INFO})`,
        lastImportAt: sql<string | null>`max(${l.createdAt})`,
      })
      .from(l)
      .where(where);
    const statusRows = await db.select({ status: l.status, n: sql<number>`count(*)` }).from(l).where(where).groupBy(l.status);
    const outcomeRows = await db
      .select({ oc: sql<string>`case when ${l.orderId} is null then 'NONE' else ${ORDER_OUTCOME} end`, n: sql<number>`count(*)` })
      .from(l)
      .leftJoin(o, eq(o.id, l.orderId))
      .leftJoin(s, eq(s.orderId, o.id))
      .where(where)
      .groupBy(sql`1`);
    const byStatus: Record<LandingStatus, number> = { NEW: 0, CONFIRMED: 0, PUSHED: 0, CANCELLED: 0 };
    for (const r of statusRows) byStatus[r.status as LandingStatus] = Number(r.n);
    const byOutcome: Record<OrderOutcome | "NONE", number> = { NONE: 0, NOT_SHIPPED: 0, IN_TRANSIT: 0, DELIVERED: 0, RETURNED: 0, RETURNED_BY_RULE: 0, CANCELLED: 0 };
    for (const r of outcomeRows) byOutcome[r.oc as OrderOutcome | "NONE"] = Number(r.n);
    return { total: Number(row?.total ?? 0), byStatus, byOutcome, duplicates: Number(row?.duplicates ?? 0), risky: Number(row?.risky ?? 0), noVariant: Number(row?.noVariant ?? 0), pushErrors: Number(row?.pushErrors ?? 0),
      missingInfo: Number(row?.missingInfo ?? 0), lastImportAt: row?.lastImportAt ? new Date(row.lastImportAt) : null };
  });
}

/** Các mã hàng có đơn landing trong kỳ (để lọc Q002 / Q003…) kèm số dòng và số đã có đơn POS */
export async function listLandingProductOptions(period: Period): Promise<{ code: string; count: number; withPos: number }[]> {
  const db = await getDb();
  const rows = await db
    .select({ code: PRODUCT_CODE, count: sql<number>`count(*)`, withPos: sql<number>`count(*) filter (where ${l.orderId} is not null)` })
    .from(l)
    .where(and(...conds({ period })))
    .groupBy(PRODUCT_CODE)
    .orderBy(desc(sql`count(*)`));
  return rows.filter((r) => r.code).map((r) => ({ code: r.code, count: Number(r.count), withPos: Number(r.withPos) }));
}

export type VariantOption = { id: string; label: string; productId: string };

/** Mẫu mã đang bán để chọn tay khi không tự ghép được */
export async function listVariantOptions(): Promise<VariantOption[]> {
  return memo("landingVariantOptions", 300_000, async () => {
    const db = await getDb();
    const rows = await db
      .select({ id: pv.id, productId: pv.productId, name: p.name, code: p.customId, size: pv.size, color: pv.color, removed: pv.isRemoved, hidden: pv.isHidden })
      .from(pv)
      .innerJoin(p, eq(p.id, pv.productId))
      .where(and(eq(pv.isRemoved, false), isNotNull(pv.productId)))
      .orderBy(p.name, pv.color, pv.size);
    return rows.map((r) => ({ id: r.id, productId: r.productId, label: `${r.code ? `${r.code} · ` : ""}${r.name}${r.color || r.size ? ` · ${[r.color, r.size].filter(Boolean).join(" ")}` : ""}${r.hidden ? " (ẩn)" : ""}` }));
  });
}

/**
 * Đơn rủi ro: khách có lịch sử hoàn cao (theo số liệu Pancake: giao thành công / hoàn, bị chặn) hoặc theo lịch sử vận đơn trong ERP
 * (cùng SĐT) → cảnh báo cho CSKH xin cọc / xác nhận kỹ trước khi gửi hàng.
 */
import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";

export type RiskInput = { succeed: number; returned: number; isBlock: boolean; erpDelivered?: number; erpReturned?: number };
export type RiskConfig = { riskMinReturned: number; riskReturnRatePct: number };
export type RiskAssessment = { risky: boolean; severity: "critical" | "warning"; succeed: number; returned: number; rate: number; reasons: string[] };

/** Gộp số liệu Pancake và ERP (lấy số lớn hơn từng loại) rồi chấm rủi ro */
export function assessCustomerRisk(input: RiskInput, cfg: RiskConfig): RiskAssessment {
  const succeed = Math.max(input.succeed, input.erpDelivered ?? 0);
  const returned = Math.max(input.returned, input.erpReturned ?? 0);
  const finished = succeed + returned;
  const rate = finished ? returned / finished : 0;
  const reasons: string[] = [];
  if (input.isBlock) reasons.push("Pancake đánh dấu chặn");
  if (returned >= Math.max(1, cfg.riskMinReturned) && rate * 100 >= cfg.riskReturnRatePct) reasons.push(`hoàn ${returned}/${finished} đơn (${Math.round(rate * 100)}%)`);
  else if (returned >= Math.max(5, cfg.riskMinReturned * 3)) reasons.push(`hoàn ${returned} đơn`);
  const risky = reasons.length > 0;
  const severity: RiskAssessment["severity"] = input.isBlock || rate >= 0.7 || returned >= 10 ? "critical" : "warning";
  return { risky, severity, succeed, returned, rate, reasons };
}

/** Lịch sử vận đơn trong ERP theo SĐT (không tính đơn hiện tại) */
export async function erpHistoryByPhone(phones: string[], excludeOrderId?: string) {
  const db = await getDb();
  const clean = [...new Set(phones.map((p) => p.replace(/\D/g, "")).filter((p) => p.length >= 9))];
  if (!clean.length) return { delivered: 0, returned: 0 };
  const [row] = await db
    .select({
      delivered: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
      returned: sql<number>`count(*) filter (where ${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE'))`,
    })
    .from(schema.shipments)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId))
    .where(and(inArray(schema.orders.billPhone, clean), excludeOrderId ? ne(schema.orders.id, excludeOrderId) : sql`true`));
  return { delivered: Number(row?.delivered ?? 0), returned: Number(row?.returned ?? 0) };
}

/** Các đơn chưa gửi ĐVVC trong N ngày gần đây có khách rủi ro */
export async function riskyOrderCandidates(cfg: RiskConfig, lookback: Date) {
  const db = await getDb();
  const o = schema.orders;
  const c = schema.customers;
  const rows = await db
    .select({ id: o.id, systemId: o.systemId, name: o.billFullName, phone: o.billPhone, total: o.totalPriceAfterDiscount, stage: o.stage, insertedAt: o.insertedAt, succeed: c.succeedOrderCount, returned: c.returnedOrderCount, isBlock: c.isBlock })
    .from(o)
    .leftJoin(c, eq(c.id, o.customerId))
    .where(and(inArray(o.stage, ["NEW", "CONFIRMED", "PACKING", "READY_TO_SHIP"]), gte(o.insertedAt, lookback)));
  const out: { order: (typeof rows)[number]; risk: RiskAssessment }[] = [];
  for (const r of rows) {
    const erp = r.phone ? await erpHistoryByPhone([r.phone], r.id) : { delivered: 0, returned: 0 };
    const risk = assessCustomerRisk({ succeed: r.succeed ?? 0, returned: r.returned ?? 0, isBlock: Boolean(r.isBlock), erpDelivered: erp.delivered, erpReturned: erp.returned }, cfg);
    if (risk.risky) out.push({ order: r, risk });
  }
  return out;
}

/** Số đơn khác trong ERP (mọi trạng thái trừ huỷ) cùng SĐT — 0 = SĐT mới, chưa từng lên đơn */
export async function erpOrderCountByPhone(phones: string[], excludeOrderId?: string): Promise<number> {
  const db = await getDb();
  const clean = [...new Set(phones.map((p) => p.replace(/\D/g, "")).filter((p) => p.length >= 9))];
  if (!clean.length) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.orders)
    .where(and(inArray(schema.orders.billPhone, clean), sql`${schema.orders.stage} not in ('CANCELLED','DELETED')`, excludeOrderId ? ne(schema.orders.id, excludeOrderId) : sql`true`));
  return Number(row?.n ?? 0);
}

export type NewPhoneInput = { phone: string | null | undefined; succeed: number; returned: number; erpOtherOrders: number };

/**
 * SĐT mới = Pancake tô xanh: khách chưa có đơn giao thành công / hoàn nào và ERP không có đơn nào khác cùng số
 * → CSKH cần hỏi khách xác nhận SĐT đúng chưa và xin số phụ trước khi gửi hàng (tránh giao không thành vì sai số).
 */
export function isNewPhone(input: NewPhoneInput): boolean {
  const digits = (input.phone ?? "").replace(/\D/g, "");
  if (digits.length < 9) return false;
  return (input.succeed ?? 0) === 0 && (input.returned ?? 0) === 0 && (input.erpOtherOrders ?? 0) === 0;
}

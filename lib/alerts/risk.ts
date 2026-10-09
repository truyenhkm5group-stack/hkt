/**
 * Đơn rủi ro: khách có lịch sử hoàn cao → cảnh báo cho CSKH xin cọc / xác nhận kỹ trước khi gửi hàng.
 *
 * HAI TÍN HIỆU, KHÔNG TRỘN (AGENTS §0.1 · §0.2 · §3.1):
 *  · LỊCH SỬ ERP cùng SĐT — giao thành công / hoàn đọc bằng `ORDER_OUTCOME` (`erpHistoryByPhone`).
 *    Đây là số duy nhất được gọi là "giao thành công" (`succeed` / `returned` / `rate` của kết quả).
 *  · BỘ ĐẾM PANCAKE của khách (`customers.succeed_order_count` / `returned_order_count`, cờ chặn) — trạng
 *    thái bán hàng của Pancake, KHÔNG phải chứng từ giao. Vẫn là một tín hiệu cảnh giác hợp lệ, nhưng
 *    chấm RIÊNG và lý do luôn mang nhãn "Pancake ghi nhận".
 * Bản trước lấy `Math.max` từng loại giữa hai nguồn rồi in ra là "GTC" — bộ đếm Pancake nâng được số
 * giao thành công của ERP. Uy tín SĐT toàn mạng Pancake là một tín hiệu khác nữa (`phoneRisk*`), ở `rules.ts`.
 */
import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { RETURNED_OUTCOMES_SQL } from "@/lib/constants/truth";

/**
 * `succeed` / `returned` / `isBlock`: bộ đếm và cờ của PANCAKE (tham khảo).
 * `erpDelivered` / `erpReturned`: lịch sử cùng SĐT theo `ORDER_OUTCOME` — vắng ⇒ người gọi không tra ERP.
 */
export type RiskInput = { succeed: number; returned: number; isBlock: boolean; erpDelivered?: number; erpReturned?: number };
export type RiskConfig = { riskMinReturned: number; riskReturnRatePct: number };
export type RiskTally = { succeed: number; returned: number; rate: number | null };
/** `succeed` / `returned` / `rate`: CHỈ lịch sử ERP (`ORDER_OUTCOME`); `rate = null` khi chưa đơn nào kết thúc. */
export type RiskAssessment = { risky: boolean; severity: "critical" | "warning"; succeed: number; returned: number; rate: number | null; pancake: RiskTally; reasons: string[] };

function tally(succeed: number, returned: number): RiskTally {
  const finished = succeed + returned;
  return { succeed, returned, rate: finished ? returned / finished : null };
}

/** Lý do (nếu có) của MỘT nguồn — cùng ngưỡng cho cả hai nguồn, nhãn nguồn đứng đầu câu. */
function tallyReason(t: RiskTally, cfg: RiskConfig, label: string): string | null {
  const finished = t.succeed + t.returned;
  if (t.returned >= Math.max(1, cfg.riskMinReturned) && (t.rate ?? 0) * 100 >= cfg.riskReturnRatePct) return `${label} hoàn ${t.returned}/${finished} đơn (${Math.round((t.rate ?? 0) * 100)}%)`;
  if (t.returned >= Math.max(5, cfg.riskMinReturned * 3)) return `${label} hoàn ${t.returned} đơn`;
  return null;
}

const critical = (t: RiskTally) => (t.rate ?? 0) >= 0.7 || t.returned >= 10;

/** Chấm rủi ro: lịch sử ERP và bộ đếm Pancake chấm RIÊNG, mỗi lý do mang nhãn nguồn của nó. */
export function assessCustomerRisk(input: RiskInput, cfg: RiskConfig): RiskAssessment {
  const erp = tally(input.erpDelivered ?? 0, input.erpReturned ?? 0);
  const pancake = tally(input.succeed, input.returned);
  const reasons: string[] = [];
  if (input.isBlock) reasons.push("Pancake đánh dấu chặn");
  const erpReason = tallyReason(erp, cfg, "lịch sử ERP");
  const pancakeReason = tallyReason(pancake, cfg, "Pancake ghi nhận");
  if (erpReason) reasons.push(erpReason);
  if (pancakeReason) reasons.push(pancakeReason);
  const risky = reasons.length > 0;
  const severity: RiskAssessment["severity"] = input.isBlock || (erpReason !== null && critical(erp)) || (pancakeReason !== null && critical(pancake)) ? "critical" : "warning";
  return { risky, severity, succeed: erp.succeed, returned: erp.returned, rate: erp.rate, pancake, reasons };
}

/** Lịch sử vận đơn trong ERP theo SĐT (không tính đơn hiện tại) */
export async function erpHistoryByPhone(phones: string[], excludeOrderId?: string) {
  const db = await getDb();
  const clean = [...new Set(phones.map((p) => p.replace(/\D/g, "")).filter((p) => p.length >= 9))];
  if (!clean.length) return { delivered: 0, returned: 0 };
  const [row] = await db
    .select({
      // Đọc kết quả ĐÃ VẬT CHẤT HOÁ (cùng công thức, chỉ khác lúc tính) và MỖI ĐƠN MỘT DÒNG: đơn gửi
      // lại hai lần mà nối cả hai vận đơn thì lịch sử khách hiện ra tệ gấp đôi sự thật.
      delivered: sql<number>`count(*) filter (where ${ORDER_OUTCOME_FAST} = 'DELIVERED')`,
      returned: sql<number>`count(*) filter (where ${ORDER_OUTCOME_FAST} in (${sql.raw(RETURNED_OUTCOMES_SQL)}))`,
    })
    .from(schema.shipments)
    .innerJoin(schema.orders, and(eq(schema.orders.id, schema.shipments.orderId), PRIMARY_ATTEMPT))
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

/**
 * Tập đơn xét UY TÍN SĐT THEO PANCAKE — ĐÚNG tập của cảnh báo "Đơn rủi ro" ở trên (đơn chưa gửi ĐVVC
 * trong kỳ cảnh báo), đơn MỚI NHẤT trước. Job `phone-reputation` làm ấm đệm cho tập này, luật cảnh
 * báo đọc đệm cho CHÍNH tập này — hai nơi không thể xét hai tập đơn khác nhau.
 */
export async function phoneRiskOrderRows(lookback: Date) {
  const db = await getDb();
  const o = schema.orders;
  return db
    .select({ id: o.id, systemId: o.systemId, name: o.billFullName, phone: o.billPhone, shipPhone: o.shipPhone, total: o.totalPriceAfterDiscount, insertedAt: o.insertedAt })
    .from(o)
    .where(and(inArray(o.stage, ["NEW", "CONFIRMED", "PACKING", "READY_TO_SHIP"]), gte(o.insertedAt, lookback)))
    .orderBy(sql`${o.insertedAt} desc`);
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

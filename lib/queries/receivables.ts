import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { addDays, todayVN, vnDateKey } from "@/lib/format";
import { AGING_BUCKETS, agingBucket, type AgingBucket, type OpenDebt } from "@/lib/constants/price-lists";
import { IS_MANUAL_ORDER, MANUAL_ORDER_AMOUNT_DUE_SQL, MANUAL_ORDER_DELIVERED, MANUAL_PAYMENT_NET_SQL } from "@/lib/queries/manual-order-sql";

/**
 * ═══════════ CÔNG NỢ KHÁCH HÀNG — ĐỌC TỪ CHỨNG TỪ THANH TOÁN (ORDER_OUTCOME.md mục 11.1) ═══════════
 *
 * Không có bảng công nợ. Một đơn tay còn nợ = số phải trả (tiền hàng sau chiết khấu + ship) − Σ chứng từ CÒN HIỆU LỰC
 * (thu − hoàn), chỉ khi > 0 — cùng công thức `manualPaymentStatus().outstanding`, bản SQL dùng lại ĐÚNG các mảnh của
 * `lib/queries/manual-order-sql.ts`. Chỉ đơn ĐÃ CHỐT (`CONFIRMED`) hoặc ĐÃ GIAO (`DELIVERED`) mang nợ; đơn mới / chờ hàng /
 * đã huỷ không. Hai phần tách riêng vì chúng trả lời hai câu khác nhau:
 *  · PHẢI THU — đơn đã giao (có phiếu giao ký nhận, `MANUAL_ORDER_DELIVERED`): khách đã cầm hàng mà chưa trả đủ;
 *  · ĐÃ CHỐT CHƯA GIAO — đơn chốt mà chưa giao: khoản sắp thành nợ. Hạn mức nợ chấm trên TỔNG hai phần.
 * Tuổi nợ chỉ tính cho phần PHẢI THU: hạn trả = ngày giao (giờ VN) + số ngày được nợ của khách. Khách chưa khai số ngày
 * được nợ ⇒ KHÔNG tính quá hạn (`termsUnknown`), không đoán một con số mặc định.
 */

export type DebtOrderRow = {
  orderId: string;
  customerId: string;
  /** Ngày lên đơn (giờ VN). */
  orderedOn: string;
  /** Mốc lên đơn đầy đủ (ISO) — để xếp thứ tự trong cùng một ngày. */
  orderedAt: string;
  /** Ngày giao theo phiếu ký nhận (giờ VN) — `null` khi chưa giao. */
  deliveredOn: string | null;
  amountDue: number;
  paid: number;
  outstanding: number;
  /** Hạn trả (giờ VN) — `null` khi chưa giao hoặc khách chưa khai số ngày được nợ. */
  dueOn: string | null;
  /** Số ngày đã quá hạn (> 0 là quá hạn) — `null` khi chưa tính được. */
  daysOverdue: number | null;
};

export type CustomerDebtSummary = {
  customerId: string;
  name: string;
  phone: string | null;
  priceListName: string | null;
  creditLimit: number | null;
  paymentTermsDays: number | null;
  /** Đã giao, chưa trả đủ. */
  receivable: number;
  /** Đã chốt, chưa giao, chưa trả đủ. */
  committed: number;
  /** receivable + committed — số chấm hạn mức. */
  exposure: number;
  overdue: number;
  maxDaysOverdue: number | null;
  buckets: Record<AgingBucket, number>;
  /** Có khoản phải thu mà khách chưa khai số ngày được nợ ⇒ tuổi nợ của khách này CHƯA BIẾT. */
  termsUnknown: boolean;
  /** Vượt hạn mức đã khai. `false` khi chưa khai hạn mức. */
  overLimit: boolean;
  openOrders: number;
};

type Db = Awaited<ReturnType<typeof getDb>>;

const OPEN_STAGES = ["CONFIRMED", "DELIVERED"] as const;

/** Mốc ký nhận của phiếu giao còn hiệu lực (MỘT phiếu mỗi đơn — ORDER_OUTCOME.md mục 11). */
const DELIVERED_AT_SQL = sql<Date | null>`(select dn.signed_at from order_delivery_notes dn where dn.order_id = "orders"."id" and dn.voided_at is null limit 1)`;

/** Dòng đơn còn nợ — tuỳ chọn lọc theo khách / bỏ một đơn (lượt chấm hạn mức của chính đơn đang sửa). */
export async function openDebtOrders(opts: { customerIds?: readonly string[]; excludeOrderId?: string; db?: Db; today?: string } = {}): Promise<DebtOrderRow[]> {
  const db = opts.db ?? (await getDb());
  if (opts.customerIds && opts.customerIds.length === 0) return [];
  const o = schema.orders;
  const rows = await db
    .select({
      orderId: o.id,
      customerId: o.customerId,
      insertedAt: o.insertedAt,
      deliveredAt: DELIVERED_AT_SQL,
      delivered: sql<boolean>`${MANUAL_ORDER_DELIVERED}`,
      amountDue: sql<number>`${MANUAL_ORDER_AMOUNT_DUE_SQL}`.mapWith(Number),
      paid: sql<number>`${MANUAL_PAYMENT_NET_SQL}`.mapWith(Number),
      termsDays: schema.customerTradeTerms.paymentTermsDays,
    })
    .from(o)
    .leftJoin(schema.customerTradeTerms, eq(schema.customerTradeTerms.customerId, o.customerId))
    .where(
      and(
        IS_MANUAL_ORDER,
        inArray(o.stage, [...OPEN_STAGES]),
        sql`${o.customerId} is not null`,
        sql`${MANUAL_ORDER_AMOUNT_DUE_SQL} - ${MANUAL_PAYMENT_NET_SQL} > 0`,
        opts.customerIds ? inArray(o.customerId, [...opts.customerIds]) : undefined,
        opts.excludeOrderId ? sql`${o.id} <> ${opts.excludeOrderId}` : undefined,
      ),
    )
    .orderBy(asc(o.insertedAt), asc(o.id));
  const today = opts.today ?? todayVN();
  return rows.map((r) => {
    const deliveredOn = r.delivered && r.deliveredAt ? vnDateKey(r.deliveredAt) : null;
    const dueOn = deliveredOn && r.termsDays !== null ? addDays(deliveredOn, r.termsDays) : null;
    const daysOverdue = dueOn ? Math.round((new Date(`${today}T00:00:00Z`).getTime() - new Date(`${dueOn}T00:00:00Z`).getTime()) / 86_400_000) : null;
    return {
      orderId: r.orderId,
      customerId: r.customerId!,
      orderedOn: vnDateKey(r.insertedAt),
      orderedAt: r.insertedAt.toISOString(),
      deliveredOn,
      amountDue: r.amountDue,
      paid: r.paid,
      outstanding: Math.max(0, r.amountDue - r.paid),
      dueOn,
      daysOverdue,
    };
  });
}

/** Dư nợ (phải thu + đã chốt chưa giao) của MỘT khách, bỏ một đơn — đầu vào của phép chấm hạn mức. */
export async function customerExposure(customerId: string, opts: { excludeOrderId?: string; db?: Db } = {}): Promise<number> {
  const rows = await openDebtOrders({ customerIds: [customerId], excludeOrderId: opts.excludeOrderId, db: opts.db });
  return rows.reduce((s, r) => s + r.outstanding, 0);
}

/**
 * Đơn còn nợ của một khách — đầu vào của thu nợ gộp. Khoá thứ tự: đơn ĐÃ GIAO (nợ thật, khách đã cầm hàng) trước đơn mới
 * chốt, rồi mốc lên đơn đầy đủ — hai đơn cùng ngày vẫn đúng thứ tự cũ → mới.
 */
export function toOpenDebts(rows: readonly DebtOrderRow[]): OpenDebt[] {
  return rows.map((r) => ({ orderId: r.orderId, outstanding: r.outstanding, orderedAt: `${r.deliveredOn ? 0 : 1}|${r.orderedAt}` }));
}

function summarize(customer: { id: string; name: string; phone: string | null; priceListName: string | null; creditLimit: number | null; paymentTermsDays: number | null }, rows: readonly DebtOrderRow[]): CustomerDebtSummary {
  const buckets = Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) as Record<AgingBucket, number>;
  let receivable = 0;
  let committed = 0;
  let overdue = 0;
  let maxDaysOverdue: number | null = null;
  let termsUnknown = false;
  for (const r of rows) {
    if (r.deliveredOn) {
      receivable += r.outstanding;
      if (r.daysOverdue === null) termsUnknown = true;
      else {
        buckets[agingBucket(r.daysOverdue)] += r.outstanding;
        if (r.daysOverdue > 0) {
          overdue += r.outstanding;
          maxDaysOverdue = Math.max(maxDaysOverdue ?? 0, r.daysOverdue);
        }
      }
    } else committed += r.outstanding;
  }
  const exposure = receivable + committed;
  return {
    customerId: customer.id,
    name: customer.name,
    phone: customer.phone,
    priceListName: customer.priceListName,
    creditLimit: customer.creditLimit,
    paymentTermsDays: customer.paymentTermsDays,
    receivable,
    committed,
    exposure,
    overdue,
    maxDaysOverdue,
    buckets,
    termsUnknown,
    overLimit: customer.creditLimit !== null && exposure > customer.creditLimit,
    openOrders: rows.length,
  };
}

async function customersWithTerms(ids: readonly string[]) {
  if (ids.length === 0) return [];
  const db = await getDb();
  return db
    .select({ id: schema.customers.id, name: schema.customers.name, phone: schema.customers.phone, priceListName: schema.priceLists.name, creditLimit: schema.customerTradeTerms.creditLimit, paymentTermsDays: schema.customerTradeTerms.paymentTermsDays })
    .from(schema.customers)
    .leftJoin(schema.customerTradeTerms, eq(schema.customerTradeTerms.customerId, schema.customers.id))
    .leftJoin(schema.priceLists, eq(schema.priceLists.id, schema.customerTradeTerms.priceListId))
    .where(inArray(schema.customers.id, [...ids]));
}

export type ReceivablesBoard = {
  today: string;
  rows: CustomerDebtSummary[];
  totals: { receivable: number; committed: number; overdue: number; buckets: Record<AgingBucket, number>; customers: number; overLimit: number; termsUnknown: number };
};

/** Bảng công nợ toàn tổ chức — mọi khách còn nợ, nợ quá hạn lâu nhất trước, rồi dư nợ lớn nhất. */
export async function listReceivables(today: string = todayVN()): Promise<ReceivablesBoard> {
  const rows = await openDebtOrders({ today });
  const byCustomer = new Map<string, DebtOrderRow[]>();
  for (const r of rows) byCustomer.set(r.customerId, [...(byCustomer.get(r.customerId) ?? []), r]);
  const customers = await customersWithTerms([...byCustomer.keys()]);
  const summaries = customers.map((c) => summarize(c, byCustomer.get(c.id) ?? []));
  summaries.sort((a, b) => (b.maxDaysOverdue ?? -1) - (a.maxDaysOverdue ?? -1) || b.exposure - a.exposure || a.name.localeCompare(b.name, "vi"));
  const buckets = Object.fromEntries(AGING_BUCKETS.map((b) => [b, summaries.reduce((s, x) => s + x.buckets[b], 0)])) as Record<AgingBucket, number>;
  return {
    today,
    rows: summaries,
    totals: {
      receivable: summaries.reduce((s, x) => s + x.receivable, 0),
      committed: summaries.reduce((s, x) => s + x.committed, 0),
      overdue: summaries.reduce((s, x) => s + x.overdue, 0),
      buckets,
      customers: summaries.length,
      overLimit: summaries.filter((x) => x.overLimit).length,
      termsUnknown: summaries.filter((x) => x.termsUnknown).length,
    },
  };
}

/** Công nợ của MỘT khách: tóm tắt + từng đơn còn nợ. Khách không còn nợ vẫn trả tóm tắt (số 0 thật — đã đọc chứng từ). */
export async function customerDebt(customerId: string, today: string = todayVN()): Promise<{ summary: CustomerDebtSummary; orders: DebtOrderRow[] } | null> {
  const [customer] = await customersWithTerms([customerId]);
  if (!customer) return null;
  const orders = await openDebtOrders({ customerIds: [customerId], today });
  return { summary: summarize(customer, orders), orders };
}

/** Bảng giá đang bật + điều khoản đang lưu của một khách — cho form điều khoản bán. */
export async function customerTermsView(customerId: string): Promise<{ lists: { id: string; name: string; isDefault: boolean }[]; terms: { priceListId: string | null; creditLimit: number | null; paymentTermsDays: number | null } }> {
  const db = await getDb();
  const [lists, [terms]] = await Promise.all([
    db.select({ id: schema.priceLists.id, name: schema.priceLists.name, isDefault: schema.priceLists.isDefault }).from(schema.priceLists).where(eq(schema.priceLists.active, true)).orderBy(asc(schema.priceLists.name)),
    db.select().from(schema.customerTradeTerms).where(eq(schema.customerTradeTerms.customerId, customerId)).limit(1),
  ]);
  return { lists, terms: { priceListId: terms?.priceListId ?? null, creditLimit: terms?.creditLimit ?? null, paymentTermsDays: terms?.paymentTermsDays ?? null } };
}

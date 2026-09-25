import { asc, eq, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { marketerPriceCutoff } from "@/lib/constants/marketer-price";
import { LINE_UNIT_COST } from "@/lib/queries/cogs";


/**
 * ═══════════ GIÁ BÁO MKT — ĐƯỜNG ĐỌC ═══════════
 *
 * Luật: `lib/constants/marketer-price.ts`. Tệp này là nơi DUY NHẤT dựng biểu thức "giá vốn phía MKT"
 * cho dòng đơn; hai người dùng của nó là cơ sở tính lương (`productEconomics`) và lợi nhuận danh
 * nghĩa theo MKT (`getNominalProfitReport` → `getNominalMarketerBreakdown`). Báo cáo lợi nhuận SHOP
 * không được đọc nó — `tests/marketer-price.test.ts` quét mã nguồn.
 */

const i = schema.orderItems;
const o = schema.orders;
const pv = schema.productVariants;
const mp = schema.marketerPrices;

/**
 * Giá báo đang hiệu lực cho dòng đơn đang xét (cần join `order_items`, `product_variants`), hoặc NULL
 * khi không có. `orderAt` = NGÀY LÊN ĐƠN của dòng — mặc định `orders.inserted_at`; truy vấn nào đã gói
 * đơn vào một CTE thì truyền cột ngày của CTE ấy. Đơn lên trước ngày bắt đầu áp dụng ⇒ NULL, bất kể
 * dòng giá khai từ lúc nào.
 */
export function marketerPriceOnOrderDate(orderAt: SQL): SQL<number | null> {
  return sql<number | null>`(
  select ${mp.price} from ${mp}
  where ${mp.productId} = coalesce(${pv.productId}, ${i.productId})
    and ${mp.effectiveFrom} <= ${orderAt}
    and ${orderAt} >= ${marketerPriceCutoff().toISOString()}::timestamptz
  order by ${mp.effectiveFrom} desc
  limit 1
)`;
}

export const LINE_MARKETER_PRICE = marketerPriceOnOrderDate(sql`${o.insertedAt}`);

/** Giá vốn phía MKT của một sản phẩm trên dòng đơn: giá báo nếu có, không thì giá vốn thật. */
export const MKT_LINE_UNIT_COST = sql<number>`coalesce(${LINE_MARKETER_PRICE}, ${LINE_UNIT_COST})`;

export type MarketerPriceRow = typeof schema.marketerPrices.$inferSelect;

export async function listMarketerPrices(): Promise<MarketerPriceRow[]> {
  const db = await getDb();
  return db.select().from(mp).orderBy(asc(mp.productCode), asc(mp.effectiveFrom));
}

/**
 * Kỳ lương ĐÃ KHOÁ nào chồng lên khoảng [from, to] (to = null ⇒ tới vô hạn). Giá báo / phạt xưởng
 * không được sửa lùi vào kỳ đã khoá: kỳ ấy đọc ẢNH CHỤP, và phần chênh sẽ thành khoản truy thu / bù
 * lương ở lượt quyết toán — một quyết định của chủ shop, không phải tác dụng phụ của một ô nhập.
 */
export async function frozenPayrollOverlapping(from: Date, to: Date | null): Promise<string | null> {
  const db = await getDb();
  const rows = await db
    .select({ key: schema.payrollPeriods.periodKey })
    .from(schema.payrollPeriods)
    .where(sql`${schema.payrollPeriods.status} in ('LOCKED', 'PAID', 'FINAL')`);
  for (const r of rows) {
    const [a, b] = r.key.split("..");
    if (!a || !b) continue;
    const start = new Date(`${a}T00:00:00+07:00`).getTime();
    const end = new Date(`${b}T23:59:59.999+07:00`).getTime();
    if (end >= from.getTime() && (to === null || start <= to.getTime())) return r.key;
  }
  return null;
}

export async function marketerPricesOfProduct(productId: string): Promise<MarketerPriceRow[]> {
  const db = await getDb();
  return db.select().from(mp).where(eq(mp.productId, productId)).orderBy(asc(mp.effectiveFrom));
}

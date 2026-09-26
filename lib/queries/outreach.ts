import { and, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { ListParams } from "@/lib/search-params";
import { CUSTOMER_OUTCOMES, type CustomerOutcome } from "@/lib/constants/outreach-segment";
import { NURTURE_MAX_WINDOW_HOURS, NURTURE_WINDOW_MARGIN_MINUTES } from "@/lib/constants/outreach";
import { FINISHED_OUTCOMES_SQL, OPEN_OUTCOMES, RETURNED_OUTCOMES_SQL } from "@/lib/constants/truth";

export const OUTREACH_SORTABLE = ["createdAt", "lastActivityAt", "sentAt", "nextAt"];

/**
 * "Đang chạy" của KHÁCH = "chưa ngã ngũ" của ĐƠN (`OPEN_OUTCOMES`) TRỪ `UNKNOWN`. Cố ý không phải
 * nguyên tập: đơn `UNKNOWN` là có vận đơn mà KHÔNG có chứng từ ĐVVC nào, đúng nghĩa nhãn khách
 * "Chưa xác định — thiếu chứng từ", nên nó đi về nhóm `UNKNOWN` chứ không được gọi là "Đang giao".
 * Sinh ra từ hằng số để một kết quả "đang chạy" mới (như `AWAITING_PICKUP` ngày 13/09/2026) tự
 * đi theo, không phải một bản chép tay thứ hai.
 */
const DANG_CHAY_SQL = OPEN_OUTCOMES.filter((o) => o !== "UNKNOWN")
  .map((o) => `'${o}'`)
  .join(",");

/**
 * ═══ KẾT QUẢ LOGISTICS CỦA KHÁCH — ĐỌC LẠI `ORDER_OUTCOME`, KHÔNG TÍNH LẠI ═══
 *
 * Lấy đơn GẦN NHẤT ĐÃ CÓ KẾT QUẢ của khách (nối bằng `customer_id`, thiếu thì bằng SĐT đã chuẩn
 * hoá) rồi đọc kết quả đã vật chất hoá trong `canonical_order_outcome`.
 *
 * Vì sao "đơn gần nhất" chứ không phải "từng hoàn": một khách mua mười lần, hoàn một lần, là khách
 * tốt — không phải "khách hoàn hàng". Lấy "từng hoàn" làm nhãn sẽ dán nhãn xấu lên gần hết khách
 * quen (đo production: 936 khách từng có đơn hoàn so với 485 khách từng có đơn giao thành công).
 *
 * KHÔNG dùng trạng thái Pancake và KHÔNG suy từ COD — tiền và logistics là hai chiều độc lập.
 */
const KET_QUA_KHACH = sql<string>`(
  select case
    when k.outcome = 'DELIVERED' then 'DELIVERED'
    when k.outcome in (${sql.raw(RETURNED_OUTCOMES_SQL)}) then 'RETURNED'
    when k.outcome in (${sql.raw(DANG_CHAY_SQL)}) then 'PENDING'
    else 'UNKNOWN'
  end
  from canonical_order_outcome k
  join orders o2 on o2.id = k.order_id
  where (
    (${schema.outreachTargets.customerId} is not null and o2.customer_id = ${schema.outreachTargets.customerId})
    or (${schema.outreachTargets.customerId} is null and ${schema.outreachTargets.phone} <> '' and o2.bill_phone = ${schema.outreachTargets.phone})
  )
  -- Ưu tiên đơn ĐÃ CÓ KẾT QUẢ; trong đó lấy đơn mới nhất. Đơn đang chạy chỉ dùng khi không còn gì.
  order by (k.outcome in (${sql.raw(FINISHED_OUTCOMES_SQL)})) desc, o2.inserted_at desc
  limit 1
)`;

function whereOf(params: ListParams, segment: string) {
  const t = schema.outreachTargets;
  const conds: (SQL | undefined)[] = [eq(t.segment, segment)];
  if (params.filters.status?.length) conds.push(inArray(t.status, params.filters.status));
  // Lọc theo kết quả logistics của khách — cùng biểu thức với cột hiển thị, nên bộ đếm và bảng
  // không thể nói hai con số khác nhau.
  const ketQua = params.filters.outcome?.filter((v) => (CUSTOMER_OUTCOMES as readonly string[]).includes(v));
  if (ketQua?.length) conds.push(sql`coalesce(${KET_QUA_KHACH}, 'UNKNOWN') in ${ketQua}`);
  const term = params.q.trim();
  if (term) conds.push(or(ilike(t.customerName, `%${term}%`), ilike(t.phone, `%${term}%`), ilike(t.context, `%${term}%`)));
  return and(...conds.filter((c): c is SQL => Boolean(c)));
}

/** Đếm khách theo kết quả logistics — cho hàng tab trên đầu trang. */
export async function outreachOutcomeFacet(segment: string): Promise<{ value: CustomerOutcome; label: string; count: number }[]> {
  const db = await getDb();
  const t = schema.outreachTargets;
  const rows = await db
    .select({ value: sql<string>`coalesce(${KET_QUA_KHACH}, 'UNKNOWN')`, count: count() })
    .from(t)
    .where(eq(t.segment, segment))
    .groupBy(sql`coalesce(${KET_QUA_KHACH}, 'UNKNOWN')`);
  const theo = new Map(rows.map((r) => [r.value, Number(r.count)]));
  return CUSTOMER_OUTCOMES.map((v) => ({ value: v, label: v, count: theo.get(v) ?? 0 }));
}

export async function listOutreachTargets(params: ListParams, segment: string) {
  const db = await getDb();
  const t = schema.outreachTargets;
  const where = whereOf(params, segment);
  const sortCol = params.sort === "lastActivityAt" ? t.lastActivityAt : params.sort === "sentAt" ? t.sentAt : params.sort === "nextAt" ? t.nextAt : t.createdAt;
  const [rows, [{ total }]] = await Promise.all([
    db.query.outreachTargets.findMany({
      where,
      orderBy: [params.dir === "asc" ? sql`${sortCol} asc nulls last` : sql`${sortCol} desc nulls last`],
      limit: params.pageSize,
      offset: (params.page - 1) * params.pageSize,
      with: { order: { columns: { id: true, systemId: true } } },
      // CÙNG biểu thức với bộ lọc và với hàng tab. Ba nơi hỏi cùng một câu thì không thể lệch nhau.
      extras: { customerOutcome: sql<string>`coalesce(${KET_QUA_KHACH}, 'UNKNOWN')`.as("customer_outcome") },
    }),
    db.select({ total: count() }).from(t).where(where),
  ]);
  return { rows, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}
export type OutreachRow = Awaited<ReturnType<typeof listOutreachTargets>>["rows"][number];

export async function outreachSummary() {
  const db = await getDb();
  const t = schema.outreachTargets;
  const rows = await db.select({ segment: t.segment, status: t.status, count: count() }).from(t).groupBy(t.segment, t.status);
  /*
    "Đến hạn" của kịch bản băn khoăn KHÔNG gồm khách đã quá 24 giờ từ tin cuối: Meta không cho nhắn, bấm gửi chỉ
    ra một dòng bỏ qua. Họ được ĐẾM RIÊNG (`stale`) — tính lúc đọc, không hạ trạng thái dòng nào trong CSDL.
  */
  const windowStart = new Date(Date.now() - NURTURE_MAX_WINDOW_HOURS * 3_600_000 + NURTURE_WINDOW_MARGIN_MINUTES * 60_000);
  const nurtureDue = and(eq(t.segment, "NURTURE"), eq(t.status, "PENDING"), or(isNull(t.nextAt), lte(t.nextAt, new Date())));
  const [[today], [dueN], [staleN], [dueC]] = await Promise.all([
    db.select({ count: count() }).from(t).where(gte(t.sentAt, new Date(Date.now() - 86_400_000))),
    db.select({ count: count() }).from(t).where(and(nurtureDue, or(isNull(t.lastActivityAt), gte(t.lastActivityAt, windowStart)))),
    db.select({ count: count() }).from(t).where(and(eq(t.segment, "NURTURE"), eq(t.status, "PENDING"), sql`${t.lastActivityAt} < ${windowStart.toISOString()}::timestamptz`)),
    db.select({ count: count() }).from(t).where(and(eq(t.segment, "CROSS_SELL"), eq(t.status, "PENDING"), or(isNull(t.nextAt), lte(t.nextAt, new Date())))),
  ]);
  const get = (seg: string, st: string) => Number(rows.find((r) => r.segment === seg && r.status === st)?.count ?? 0);
  return {
    nurture: { pending: get("NURTURE", "PENDING"), due: Number(dueN?.count ?? 0), stale: Number(staleN?.count ?? 0), sent: get("NURTURE", "SENT"), failed: get("NURTURE", "FAILED"), converted: get("NURTURE", "CONVERTED"), replied: get("NURTURE", "REPLIED") },
    crossSell: { pending: get("CROSS_SELL", "PENDING"), due: Number(dueC?.count ?? 0), sent: get("CROSS_SELL", "SENT"), failed: get("CROSS_SELL", "FAILED") },
    sentToday: Number(today?.count ?? 0),
  };
}

export async function outreachStatusFacet(segment: string) {
  const db = await getDb();
  const t = schema.outreachTargets;
  const rows = await db.select({ value: t.status, count: count() }).from(t).where(eq(t.segment, segment)).groupBy(t.status).orderBy(desc(count()));
  return rows.map((r) => ({ value: r.value, label: r.value, count: Number(r.count) }));
}

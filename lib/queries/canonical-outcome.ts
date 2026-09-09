import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import { CANONICAL_OUTCOME_VERSION } from "@/lib/constants/canonical-outcome";

/**
 * ───────────── VẬT CHẤT HOÁ KẾT QUẢ ĐƠN ─────────────
 *
 * Bảng `canonical_order_outcome` là LỚP TĂNG TỐC. Nguồn sự thật vẫn là `ORDER_OUTCOME`.
 *
 * ĐIỀU QUAN TRỌNG NHẤT CỦA FILE NÀY: nó **không chép lại luật**. Câu lệnh ghi dùng lại đúng biểu
 * thức `ORDER_OUTCOME` đã nhập từ `return-rate.ts`, nên kết quả trùng khớp **theo cấu trúc**, không
 * phải nhờ may mắn hay nhờ ai đó nhớ đồng bộ hai bản. Chép luật sang đây là cách chắc chắn nhất để
 * hai con số bắt đầu lệch nhau sau vài tháng mà không ai biết.
 *
 * VÌ SAO CẦN: đo trên production 09/09/2026, `ORDER_OUTCOME` tốn ~2,4ms mỗi đơn. Mỗi báo cáo phải
 * trả ~6 giây chỉ để dựng lại cùng một kết luận cho 2.426 đơn; trang chủ mất 30–47 giây.
 */

export { CANONICAL_OUTCOME_VERSION };

const c = schema.canonicalOrderOutcome;

/**
 * Dựng lại kết quả cho một tập đơn — hoặc TOÀN BỘ nếu không truyền gì.
 *
 * · **Xác định**: cùng dữ liệu vào, cùng kết quả ra, vì nó chạy chính biểu thức chuẩn.
 * · **Chạy lại được**: xoá rồi ghi trong MỘT giao dịch, nên gọi hai lần không nhân đôi dòng.
 * · **An toàn**: không đụng một cột nghiệp vụ nào — chỉ ghi vào bảng dẫn xuất.
 * · **Không suy luận từ tiền hay từ Pancake**: nó không có luật riêng để mà suy.
 */
export async function rematerializeOutcomes(orderIds?: string[]): Promise<{ rows: number }> {
  const db = await getDb();
  const ids = orderIds ? [...new Set(orderIds.filter((id) => id.trim()))] : null;
  if (ids && !ids.length) return { rows: 0 };

  const scope = ids ? sql`${schema.orders.id} in ${ids}` : sql`true`;

  return db.transaction(async (tx) => {
    if (ids) await tx.delete(c).where(sql`${c.orderId} in ${ids}`);
    else await tx.delete(c);

    const inserted = await tx.execute(sql`
      insert into canonical_order_outcome (id, order_id, shipment_id, outcome, logic_version, computed_at)
      select
        md5(${schema.orders.id} || ':' || coalesce(${schema.shipments.id}, '')),
        ${schema.orders.id},
        ${schema.shipments.id},
        ${ORDER_OUTCOME},
        ${CANONICAL_OUTCOME_VERSION},
        now()
      from ${schema.orders}
      left join ${schema.shipments} on ${schema.shipments.orderId} = ${schema.orders.id}
      where ${scope}
      on conflict do nothing
    `);
    const rows = typeof inserted === "object" && inserted !== null && "rowCount" in inserted ? Number((inserted as { rowCount: number }).rowCount ?? 0) : 0;
    return { rows };
  });
}

/**
 * ───────────── DỰNG LẠI TĂNG DẦN: CHỈ NHỮNG ĐƠN CÓ ĐẦU VÀO ĐÃ ĐỔI ─────────────
 *
 * Không gắn hook rải rác ở từng đường ghi — đường ghi có nhiều (webhook, đồng bộ, nhập tệp, sửa tay)
 * và chỉ cần sót MỘT đường là bảng lệch âm thầm. Thay vào đó hỏi thẳng dữ liệu: đơn nào **thiếu**
 * dòng, **mang phiên bản luật cũ**, hoặc có đầu vào **mới hơn** lần tính gần nhất.
 *
 * Bốn nguồn đầu vào của kết quả đơn, đúng theo `ORDER_OUTCOME`: bản thân đơn · vận đơn · sự kiện
 * ĐVVC · dòng bảng kê COD. Bất kỳ cái nào mới hơn `computed_at` thì đơn đó phải tính lại.
 *
 * Idempotent (chạy lại không đổi kết quả), chạy tiếp được (có trần mỗi lượt), và quan sát được (trả
 * về số đơn đã dựng lại cùng số đơn còn tồn).
 */
export async function rematerializeStale(limit = 2000): Promise<{ rebuilt: number; remaining: number }> {
  const db = await getDb();
  const staleIds = await db.execute(sql`
    select distinct o.id
    from orders o
    left join shipments s on s.order_id = o.id
    left join canonical_order_outcome m
      on m.order_id = o.id and coalesce(m.shipment_id, '') = coalesce(s.id, '')
    where m.id is null
       or m.logic_version <> ${CANONICAL_OUTCOME_VERSION}
       or o.updated_at > m.computed_at
       or s.updated_at > m.computed_at
       or exists (select 1 from shipment_events e where e.shipment_id = s.id and e.created_at > m.computed_at)
       or exists (select 1 from cod_statement_lines l where l.shipment_id = s.id and l.created_at > m.computed_at)
    limit ${limit}
  `);
  const ids = ((Array.isArray(staleIds) ? staleIds : ((staleIds as { rows?: unknown[] }).rows ?? [])) as { id: string }[]).map((r) => String(r.id));
  if (!ids.length) return { rebuilt: 0, remaining: 0 };

  await rematerializeOutcomes(ids);

  // Còn lại bao nhiêu — để người vận hành biết một lượt đã đủ hay phải chạy tiếp.
  const rest = await db.execute(sql`
    select count(distinct o.id)::int as n
    from orders o
    left join shipments s on s.order_id = o.id
    left join canonical_order_outcome m
      on m.order_id = o.id and coalesce(m.shipment_id, '') = coalesce(s.id, '')
    where m.id is null or m.logic_version <> ${CANONICAL_OUTCOME_VERSION} or o.updated_at > m.computed_at or s.updated_at > m.computed_at
  `);
  const restRows = (Array.isArray(rest) ? rest : ((rest as { rows?: unknown[] }).rows ?? [])) as { n: number }[];
  return { rebuilt: ids.length, remaining: Number(restRows[0]?.n ?? 0) };
}

export type OutcomeParityRow = { orderId: string; shipmentId: string | null; live: string; materialized: string | null };

/**
 * ĐỐI CHIẾU: bảng đã vật chất hoá có nói **đúng y** những gì biểu thức chuẩn nói không.
 *
 * Chạy TRƯỚC khi cho báo cáo nào đọc bảng này, và chạy lại sau mỗi lần đổi luật. Lệch một dòng là
 * dừng — và đi tìm nguyên nhân, **không** sửa dữ liệu đơn/vận đơn để ép cho khớp.
 */
export async function outcomeParity(limit = 50): Promise<{ total: number; matched: number; mismatches: OutcomeParityRow[]; stale: number }> {
  const db = await getDb();
  // KHÔNG đặt bí danh cho `orders`/`shipments`: biểu thức chuẩn tham chiếu chúng bằng đúng tên bảng,
  // đặt bí danh là biểu thức không còn nhìn thấy chúng nữa.
  const rows = await db.execute(sql`
    select
      ${schema.orders.id} as order_id,
      ${schema.shipments.id} as shipment_id,
      (${ORDER_OUTCOME}) as live,
      m.outcome as materialized
    from ${schema.orders}
    left join ${schema.shipments} on ${schema.shipments.orderId} = ${schema.orders.id}
    left join canonical_order_outcome m
      on m.order_id = ${schema.orders.id} and coalesce(m.shipment_id, '') = coalesce(${schema.shipments.id}, '')
    where m.outcome is null or m.outcome <> (${ORDER_OUTCOME})
    limit ${limit}
  `);

  const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
  const mismatches: OutcomeParityRow[] = list.map((r) => ({
    orderId: String(r.order_id),
    shipmentId: r.shipment_id === null || r.shipment_id === undefined ? null : String(r.shipment_id),
    live: String(r.live),
    materialized: r.materialized === null || r.materialized === undefined ? null : String(r.materialized),
  }));

  const [totalRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.orders)
    .leftJoin(schema.shipments, sql`${schema.shipments.orderId} = ${schema.orders.id}`);
  const [staleRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(c)
    .where(sql`${c.logicVersion} <> ${CANONICAL_OUTCOME_VERSION}`);

  const total = Number(totalRow?.n ?? 0);
  return { total, matched: total - mismatches.length, mismatches, stale: Number(staleRow?.n ?? 0) };
}

/** Bao nhiêu dòng đã vật chất hoá, và bao nhiêu dòng mang phiên bản luật cũ. */
export async function outcomeCoverage(): Promise<{ rows: number; stale: number; computedAt: Date | null }> {
  const db = await getDb();
  const [row] = await db
    .select({
      rows: sql<number>`count(*)`,
      stale: sql<number>`count(*) filter (where ${c.logicVersion} <> ${CANONICAL_OUTCOME_VERSION})`,
      computedAt: sql<Date | null>`max(${c.computedAt})`,
    })
    .from(c);
  return { rows: Number(row?.rows ?? 0), stale: Number(row?.stale ?? 0), computedAt: row?.computedAt ?? null };
}

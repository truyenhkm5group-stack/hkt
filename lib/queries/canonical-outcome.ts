import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import { ORDER_COGS } from "@/lib/queries/cogs";
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

/** Mã hành động trong `audit_logs` cho lần chốt lại giá vốn. Nhãn: `lib/constants/audit.ts`. */
export const COGS_TRUE_UP_ACTION = "COGS_TRUE_UP";
/** Người ghi: hệ thống (không có người bấm), để dòng nhật ký không giả danh ai. */
const COGS_TRUE_UP_ACTOR = "hệ thống";

/**
 * Độ mạnh của căn cứ giá vốn — dùng để so "chứng từ mới có MẠNH HƠN cái đang chốt không".
 * NULL / 'NONE' = 0. Chỉ phiếu nhập kho (≥ 2) mới được coi là chứng từ.
 */
function basisRank(basis: ReturnType<typeof sql>) {
  return sql`case ${basis} when 'RECEIPT_BEFORE' then 3 when 'RECEIPT_AFTER' then 2 when 'PROVISIONAL' then 1 else 0 end`;
}

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

  /**
   * Mốc ghi nhận doanh thu = ngày hàng tới tay khách.
   */
  const RECOGNIZED_AT = sql`coalesce(${schema.shipments.deliveredAt}, ${schema.shipments.vtpStatusDate})`;

  /**
   * ───────────── GIÁ VỐN TẠI THỜI ĐIỂM GHI NHẬN, VÀ CĂN CỨ CỦA NÓ ─────────────
   *
   * Chủ shop chốt 11/09/2026 ba điều, và khối này thực hiện đúng ba điều đó:
   *
   *  1. Đơn đã giao KHÔNG được giữ giá vốn 0 chỉ vì phiếu nhập đến sau. Chưa có phiếu thì dùng giá
   *     vốn TẠM TÍNH có thể bảo vệ được: phiếu nhập gần ngày giao nhất (`RECEIPT_AFTER`), rồi giá vốn
   *     Pancake trên dòng hàng / giá nhập mẫu mã (`PROVISIONAL`).
   *  2. Không có nguồn nào ⇒ `recognized_cogs` là NULL (CHƯA BIẾT), **không phải 0**. Chỉ là 0 khi
   *     thực sự miễn phí — mà dữ liệu hiện không có cách khai điều đó, nên 0 không bao giờ tự sinh.
   *  3. Khi xuất hiện căn cứ MẠNH HƠN (phiếu nhập kho), chốt lại ĐÚNG MỘT LẦN có nhật ký, rồi đóng băng.
   *
   * Từng dòng hàng lấy MỘT nguồn theo thứ tự mạnh → yếu; căn cứ của cả đơn là nguồn YẾU NHẤT trong
   * các dòng (một đơn hai món, một món có phiếu, một món chỉ có giá Pancake ⇒ cả đơn là PROVISIONAL —
   * nói thật về mắt xích yếu nhất chứ không khoe mắt xích mạnh nhất).
   *
   * Khác `ORDER_COGS` (cột `cogs` — ước tính "sống" theo phiếu gần nhất tính tới hôm nay): ở đây
   * phiếu "trước ngày giao" được ưu tiên, nên nhập lô mới sau này không làm số đã ghi nhận trôi.
   */
  const COST_FACTS = sql`(
    select
      coalesce(min(case
        when l.before_cost is not null then 3
        when l.after_cost is not null then 2
        when l.provisional is not null then 1
        else 0 end), 0) as rank,
      sum(l.quantity * coalesce(l.before_cost, l.after_cost, l.provisional))::bigint as cost
    from (
      select oi.quantity,
        (select ri.unit_cost from stock_receipt_items ri join stock_receipts r on r.id = ri.receipt_id
          where ri.variant_id = oi.variant_id and ri.unit_cost > 0 and r.received_at <= (${RECOGNIZED_AT})
          order by r.received_at desc, r.created_at desc limit 1) as before_cost,
        (select ri.unit_cost from stock_receipt_items ri join stock_receipts r on r.id = ri.receipt_id
          where ri.variant_id = oi.variant_id and ri.unit_cost > 0 and r.received_at > coalesce((${RECOGNIZED_AT}), '-infinity'::timestamptz)
          order by r.received_at asc, r.created_at asc limit 1) as after_cost,
        coalesce(nullif(oi.unit_cost, 0), nullif(pv2.last_imported_price, 0)) as provisional
      from order_items oi left join product_variants pv2 on pv2.id = oi.variant_id
      where oi.order_id = ${schema.orders.id}
    ) l
  )`;

  const BASIS_FROM_RANK = sql`case k.rank when 3 then 'RECEIPT_BEFORE' when 2 then 'RECEIPT_AFTER' when 1 then 'PROVISIONAL' else 'NONE' end`;

  /**
   * CHỐT LẠI MỘT LẦN — điều kiện, viết một chỗ để đọc được:
   *  · chưa từng chốt lại (`trued_up_at` NULL);
   *  · đơn ĐÃ từng được ghi nhận (có `cogs_basis`) — lần ghi nhận đầu tiên không phải là chốt lại;
   *  · căn cứ mới là CHỨNG TỪ KHO (phiếu nhập, rank ≥ 2) và MẠNH HƠN căn cứ đang chốt.
   * Phiếu nhập mới cùng hạng (thêm một lô nữa sau ngày giao) KHÔNG phải chứng từ mạnh hơn ⇒ không đổi.
   */
  const TRUE_UP = sql`(
    canonical_order_outcome.trued_up_at is null
    and canonical_order_outcome.cogs_basis is not null
    and excluded.outcome = 'DELIVERED'
    and (${basisRank(sql`excluded.cogs_basis`)}) >= 2
    and (${basisRank(sql`excluded.cogs_basis`)}) > (${basisRank(sql`canonical_order_outcome.cogs_basis`)})
  )`;

  return db.transaction(async (tx) => {
    // KHÔNG xoá rồi ghi lại: giá vốn ĐÃ CHỐT phải sống sót qua mọi lần dựng lại, nếu không thì việc
    // đóng băng chẳng có nghĩa gì. Dùng upsert và cố ý GIỮ giá trị cũ của các cột đã chốt.
    const inserted = await tx.execute(sql`
      insert into canonical_order_outcome
        (id, order_id, shipment_id, outcome, cogs, recognized_cogs, recognized_at, cogs_basis, logic_version, computed_at)
      select
        md5(${schema.orders.id} || ':' || coalesce(${schema.shipments.id}, '')),
        ${schema.orders.id},
        ${schema.shipments.id},
        ${ORDER_OUTCOME},
        ${ORDER_COGS},
        case when (${ORDER_OUTCOME}) = 'DELIVERED' and k.rank > 0 then k.cost end,
        case when (${ORDER_OUTCOME}) = 'DELIVERED' then ${RECOGNIZED_AT} end,
        case when (${ORDER_OUTCOME}) = 'DELIVERED' then (${BASIS_FROM_RANK}) end,
        ${CANONICAL_OUTCOME_VERSION},
        now()
      from ${schema.orders}
      left join ${schema.shipments} on ${schema.shipments.orderId} = ${schema.orders.id}
      cross join lateral ${COST_FACTS} k
      where ${scope}
      on conflict (order_id, (coalesce(shipment_id, ''))) do update set
        outcome = excluded.outcome,
        cogs = excluded.cogs,
        -- ĐÃ CHỐT LÀ KHÔNG ĐỔI — trừ đúng hai ngoại lệ: (a) chưa biết thì điền khi biết; (b) chốt lại
        -- MỘT LẦN khi có chứng từ mạnh hơn. Một phiếu nhập cùng hạng không được viết lại kỳ đã qua.
        recognized_cogs = case
          when ${TRUE_UP} then excluded.recognized_cogs
          when canonical_order_outcome.recognized_cogs is null then excluded.recognized_cogs
          else canonical_order_outcome.recognized_cogs end,
        cogs_basis = case
          when ${TRUE_UP} then excluded.cogs_basis
          when canonical_order_outcome.recognized_cogs is null and excluded.cogs_basis is not null then excluded.cogs_basis
          else coalesce(canonical_order_outcome.cogs_basis, excluded.cogs_basis) end,
        recognized_at   = coalesce(canonical_order_outcome.recognized_at, excluded.recognized_at),
        trued_up_at         = case when ${TRUE_UP} then now() else canonical_order_outcome.trued_up_at end,
        trued_up_from       = case when ${TRUE_UP} then canonical_order_outcome.recognized_cogs else canonical_order_outcome.trued_up_from end,
        trued_up_from_basis = case when ${TRUE_UP} then canonical_order_outcome.cogs_basis else canonical_order_outcome.trued_up_from_basis end,
        logic_version = excluded.logic_version,
        computed_at = now()
    `);

    // NHẬT KÝ cho từng lần chốt lại. `now()` là mốc bắt đầu giao dịch nên bằng đúng giá trị vừa ghi
    // vào `trued_up_at` — đó là cách nhận ra chính xác những dòng được chốt lại trong lượt này.
    await tx.execute(sql`
      insert into audit_logs (id, user_id, user_email, action, entity, entity_id, detail, created_at)
      select gen_random_uuid()::text, null, ${COGS_TRUE_UP_ACTOR}, ${COGS_TRUE_UP_ACTION}, 'ORDER', m.order_id,
        jsonb_build_object(
          'before', jsonb_build_object('recognizedCogs', m.trued_up_from, 'cogsBasis', m.trued_up_from_basis),
          'after',  jsonb_build_object('recognizedCogs', m.recognized_cogs, 'cogsBasis', m.cogs_basis),
          'shipmentId', m.shipment_id,
          'recognizedAt', m.recognized_at,
          'reason', 'Có chứng từ kho mạnh hơn căn cứ đang chốt — chốt lại giá vốn đúng MỘT lần, từ nay đóng băng.'
        ),
        now()
      from canonical_order_outcome m
      where m.trued_up_at = now() and ${ids ? sql`m.order_id in ${ids}` : sql`true`}
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
       -- DAU VAO CUA GIA VON, KHONG CHI CUA KET QUA DON: gia von lay gia tren phieu nhap GAN NHAT
       -- cua mau ma, tinh theo THOI DIEM HIEN TAI chu khong theo ngay len don. Nhap mot phieu moi
       -- hom nay se doi gia von cua MOI don lich su co mau ma do.
       or exists (
         select 1 from order_items oi
         join stock_receipt_items ri on ri.variant_id = oi.variant_id
         join stock_receipts r on r.id = ri.receipt_id
         where oi.order_id = o.id and r.updated_at > m.computed_at
       )
       -- Sua dong hang cua don (so luong, mau ma, gia von Pancake) cung doi gia von ca don.
       or exists (select 1 from order_items oi2 where oi2.order_id = o.id and o.updated_at > m.computed_at)
       -- DON DA GIAO MA CHUA CHOT GIA VON: dong duoc ghi TRUOC ban P0.4 khong co recognized_cogs.
       --
       -- P0.4 them ba cot dong cung gia von nhung KHONG tang logic_version (co y: tang version lam
       -- moi dong thanh cu cung luc, ca 2.433 don roi ve duong tinh truc tiep va trang chu quay lai
       -- muc 60 giay cua truoc P0.3). He qua khong luong truoc: bo do dong cu chi nhin version, nen
       -- nhung dong cu KHONG BAO GIO duoc dien, va gia von cua chung van troi theo phieu nhap moi -
       -- tuc viec dong cung im lang khong ap dung cho chinh nhung don lich su can no nhat.
       --
       -- Dieu kien nay lap dung khoang trong do, va no TU TAT: mot lan dung lai la cogs_basis
       -- khac NULL ('NONE' neu khong tra duoc gia von), nen khong lap vo han.
       --
       -- Từ 11/09/2026 "chưa biết" được ghi là NULL chứ không phải 0, nên điều kiện phải nhìn vào
       -- CĂN CỨ (cogs_basis) chứ không nhìn con số: dòng đã ghi nhận mà không tra được nguồn nào mang
       -- basis = 'NONE' và recognized_cogs NULL — đó là kết luận, không phải việc còn dở.
       or (m.outcome = 'DELIVERED' and m.cogs_basis is null)
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
    where m.outcome is null or m.outcome <> (${ORDER_OUTCOME}) or coalesce(m.cogs, -1) <> (${ORDER_COGS})
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

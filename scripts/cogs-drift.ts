/**
 * GIÁ VỐN LỊCH SỬ CÓ ĐANG TỰ ĐỔI KHÔNG — ĐO TRƯỚC KHI SỬA.
 *
 * `ORDER_COGS` lấy giá trên phiếu nhập GẦN NHẤT, và "gần nhất" tính theo THỜI ĐIỂM HIỆN TẠI. Nên
 * nhập một lô mới hôm nay có thể đổi giá vốn — và do đó đổi LỢI NHUẬN — của những đơn đã giao từ
 * tháng trước. Lợi nhuận kỳ đã chốt tự đổi là chuyện không được phép xảy ra âm thầm.
 *
 * Script này CHỈ ĐO, không sửa gì. Nó dựng lại giá vốn "tại thời điểm ghi nhận" (chỉ tính phiếu nhập
 * có ngày nhập ≤ ngày giao) rồi so với giá vốn đang tính hôm nay.
 *
 * Chạy: docker exec erp-app npx tsx --tsconfig tsconfig.json scripts/cogs-drift.ts
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

async function main() {
  const db = await getDb();

  /**
   * Mốc ghi nhận doanh thu = ngày hàng tới tay khách. Không có ngày giao thì lấy ngày trạng thái
   * cuối của ĐVVC; không có nữa thì đơn đó không dựng lại được (đếm riêng, không đoán).
   */
  const rows = rowsOf<{
    order_id: string;
    recognized_at: string | null;
    cogs_now: number;
    cogs_then: number;
    from_receipt_then: number;
    lines: number;
  }>(
    await db.execute(sql`
      with delivered as (
        select o.id as order_id,
               coalesce(s.delivered_at, s.vtp_status_date) as recognized_at
        from orders o
        join shipments s on s.order_id = o.id
        join canonical_order_outcome m on m.order_id = o.id and coalesce(m.shipment_id,'') = coalesce(s.id,'')
        where m.outcome = 'DELIVERED'
      )
      select
        d.order_id,
        d.recognized_at::text as recognized_at,
        -- HÔM NAY: phiếu nhập gần nhất, không giới hạn thời gian (đúng công thức đang chạy).
        coalesce((
          select sum(oi.quantity * coalesce(
            (select ri2.unit_cost from stock_receipt_items ri2 join stock_receipts r2 on r2.id = ri2.receipt_id
              where ri2.variant_id = oi.variant_id and ri2.unit_cost > 0
              order by r2.received_at desc, r2.created_at desc limit 1),
            nullif(oi.unit_cost, 0), pv.last_imported_price, 0))
          from order_items oi left join product_variants pv on pv.id = oi.variant_id
          where oi.order_id = d.order_id), 0)::bigint as cogs_now,
        -- TẠI THỜI ĐIỂM GHI NHẬN: chỉ tính phiếu nhập có ngày nhập <= ngày giao.
        coalesce((
          select sum(oi.quantity * coalesce(
            (select ri2.unit_cost from stock_receipt_items ri2 join stock_receipts r2 on r2.id = ri2.receipt_id
              where ri2.variant_id = oi.variant_id and ri2.unit_cost > 0 and r2.received_at <= d.recognized_at
              order by r2.received_at desc, r2.created_at desc limit 1),
            nullif(oi.unit_cost, 0), pv.last_imported_price, 0))
          from order_items oi left join product_variants pv on pv.id = oi.variant_id
          where oi.order_id = d.order_id), 0)::bigint as cogs_then,
        -- Bao nhiêu dòng hàng thật sự tra được phiếu nhập TẠI thời điểm đó (phần còn lại rơi về giá
        -- Pancake hoặc giá mẫu mã — hai nguồn KHÔNG dựng lại được theo thời gian).
        (select count(*) from order_items oi
          where oi.order_id = d.order_id
            and exists (select 1 from stock_receipt_items ri3 join stock_receipts r3 on r3.id = ri3.receipt_id
                        where ri3.variant_id = oi.variant_id and ri3.unit_cost > 0 and r3.received_at <= d.recognized_at))::int as from_receipt_then,
        (select count(*) from order_items oi where oi.order_id = d.order_id)::int as lines
      from delivered d
      where d.recognized_at is not null
    `),
  );

  let matched = 0;
  let drifted = 0;
  let zero = 0;
  let unverified = 0;
  let deltaTotal = 0;
  let totalNow = 0;
  let totalThen = 0;
  const worst: { order: string; now: number; then: number; delta: number }[] = [];

  for (const r of rows) {
    const now = Number(r.cogs_now);
    const then = Number(r.cogs_then);
    totalNow += now;
    totalThen += then;
    if (now === 0 && then === 0) {
      zero += 1;
      continue;
    }
    // Dòng hàng không tra được phiếu nhập tại thời điểm đó ⇒ giá vốn rơi về nguồn KHÔNG dựng lại
    // được theo thời gian. Không kết luận là khớp, cũng không kết luận là trôi.
    if (Number(r.from_receipt_then) < Number(r.lines)) unverified += 1;
    if (now === then) matched += 1;
    else {
      drifted += 1;
      deltaTotal += now - then;
      worst.push({ order: r.order_id, now, then, delta: now - then });
    }
  }

  worst.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const vnd = (n: number) => new Intl.NumberFormat("vi-VN").format(Math.round(n)) + "đ";
  console.log("\n── GIÁ VỐN LỊCH SỬ CÓ TỰ ĐỔI KHÔNG ──");
  console.log(`TOTAL_DELIVERED   ${rows.length}`);
  console.log(`MATCHED           ${matched}`);
  console.log(`DRIFTED           ${drifted}   ← đơn đã giao mà giá vốn hôm nay KHÁC lúc ghi nhận`);
  console.log(`ZERO_COGS         ${zero}`);
  console.log(`UNVERIFIABLE      ${unverified}   ← có dòng hàng không tra được phiếu nhập tại thời điểm đó`);
  console.log("");
  console.log(`TOTAL_COGS_NOW    ${vnd(totalNow)}`);
  console.log(`TOTAL_COGS_THEN   ${vnd(totalThen)}`);
  console.log(`DELTA             ${vnd(deltaTotal)}   ← lợi nhuận lịch sử đang bị lệch đúng bằng số này (dấu ngược)`);

  if (worst.length) {
    console.log("\nMười đơn lệch nhiều nhất:");
    for (const w of worst.slice(0, 10)) console.log(`   ${w.order}: hôm nay ${vnd(w.now)} · lúc ghi nhận ${vnd(w.then)} · lệch ${vnd(w.delta)}`);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("cogs-drift lỗi:", error instanceof Error ? error.message : error);
  process.exit(1);
});

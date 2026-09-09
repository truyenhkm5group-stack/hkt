/**
 * ĐỐI CHIẾU TOÀN BỘ DÂN SỐ: bảng đã vật chất hoá có nói đúng y luật chuẩn không.
 *
 * Chạy trên production, CHỈ ĐỌC. Khác bài kiểm thử ở một điểm quyết định: kiểm thử chạy trên fixture
 * vài trăm dòng, còn ở đây quét TẤT CẢ đơn thật. 107/107 trên fixture không chứng minh được gì về
 * 2.426 đơn của shop.
 *
 * Chạy: docker exec erp-app npx tsx --tsconfig tsconfig.json scripts/outcome-parity.ts [--apply]
 *
 * Mặc định CHỈ ĐO. `--apply` mới dựng lại bảng dẫn xuất (và chỉ bảng đó — không đụng đơn, vận đơn,
 * sự kiện hay tiền).
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CANONICAL_OUTCOME_VERSION } from "@/lib/constants/canonical-outcome";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import { ORDER_COGS } from "@/lib/queries/cogs";
import { rematerializeStale } from "@/lib/queries/canonical-outcome";

/**
 * Hai trình điều khiển trả kết quả hai kiểu: `pg` trả `{ rows: [...] }`, PGlite trả thẳng mảng.
 * Đã có tiền lệ script ops hỏng vì giả định một kiểu — nên đọc cả hai ở đúng một chỗ.
 */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

const apply = process.argv.includes("--apply");

async function main() {
  const db = await getDb();

  if (apply) {
    console.log("▶ Dựng lại bảng dẫn xuất (không đụng dữ liệu nghiệp vụ)…");
    let round = 0;
    for (;;) {
      const r = await rematerializeStale(2000);
      round += 1;
      console.log(`  lượt ${round}: dựng lại ${r.rebuilt} đơn · còn ${r.remaining}`);
      if (r.rebuilt === 0 || r.remaining === 0 || round >= 20) break;
    }
  }

  // ───────── ĐỘ PHỦ ─────────
  const [cov] = rowsOf<{ eligible: number; current_version: number; missing: number; stale_version: number }>(await db.execute(sql`
    select
      count(*)::int                                                                as eligible,
      count(m.id) filter (where m.logic_version = ${CANONICAL_OUTCOME_VERSION})::int as current_version,
      count(*) filter (where m.id is null)::int                                    as missing,
      count(m.id) filter (where m.logic_version <> ${CANONICAL_OUTCOME_VERSION})::int as stale_version
    from orders o
    left join shipments s on s.order_id = o.id
    left join canonical_order_outcome m
      on m.order_id = o.id and coalesce(m.shipment_id, '') = coalesce(s.id, '')
  `));

  // ───────── ĐỐI CHIẾU TỪNG DÒNG, TOÀN BỘ ─────────
  const [par] = rowsOf<{ total: number; matched: number; mismatched: number }>(await db.execute(sql`
    select
      count(*)::int as total,
      count(*) filter (where m.outcome is not null and m.logic_version = ${CANONICAL_OUTCOME_VERSION}
                         and m.outcome = (${ORDER_OUTCOME}) and m.cogs = (${ORDER_COGS}))::int as matched,
      count(*) filter (where m.outcome is not null and m.logic_version = ${CANONICAL_OUTCOME_VERSION}
                         and (m.outcome <> (${ORDER_OUTCOME}) or m.cogs <> (${ORDER_COGS})))::int as mismatched
    from ${schema.orders}
    left join ${schema.shipments} on ${schema.shipments.orderId} = ${schema.orders.id}
    left join canonical_order_outcome m
      on m.order_id = ${schema.orders.id} and coalesce(m.shipment_id, '') = coalesce(${schema.shipments.id}, '')
  `));

  const eligible = Number(cov?.eligible ?? 0);
  const current = Number(cov?.current_version ?? 0);
  const fallback = eligible ? Math.round(((eligible - current) / eligible) * 1000) / 10 : 0;

  console.log("\n── ĐỐI CHIẾU KẾT QUẢ ĐƠN ĐÃ VẬT CHẤT HOÁ ──");
  console.log(`TOTAL_ORDERS      ${Number(par?.total ?? 0)}   (grain: đơn × vận đơn, đúng grain báo cáo đang dùng)`);
  console.log(`MATCHED           ${Number(par?.matched ?? 0)}`);
  console.log(`MISMATCHED        ${Number(par?.mismatched ?? 0)}   ← phải bằng 0`);
  console.log(`MISSING_FACT      ${Number(cov?.missing ?? 0)}`);
  console.log(`STALE_VERSION     ${Number(cov?.stale_version ?? 0)}`);
  console.log("");
  console.log(`ELIGIBLE          ${eligible}`);
  console.log(`CURRENT_VERSION   ${current}`);
  console.log(`FALLBACK_RATE     ${fallback}%   ← lớp dự phòng là lưới an toàn, không phải đường chạy chính`);

  // Vài dòng lệch đầu tiên, nếu có — để đi tìm nguyên nhân, KHÔNG để sửa dữ liệu cho khớp.
  if (Number(par?.mismatched ?? 0) > 0) {
    const rows = rowsOf<Record<string, unknown>>(await db.execute(sql`
      select ${schema.orders.id} as order_id, ${schema.shipments.id} as shipment_id,
             (${ORDER_OUTCOME}) as live, m.outcome as materialized,
             (${ORDER_COGS}) as live_cogs, m.cogs as materialized_cogs
      from ${schema.orders}
      left join ${schema.shipments} on ${schema.shipments.orderId} = ${schema.orders.id}
      left join canonical_order_outcome m
        on m.order_id = ${schema.orders.id} and coalesce(m.shipment_id, '') = coalesce(${schema.shipments.id}, '')
      where m.outcome is not null and m.logic_version = ${CANONICAL_OUTCOME_VERSION}
        and (m.outcome <> (${ORDER_OUTCOME}) or m.cogs <> (${ORDER_COGS}))
      limit 10
    `));
    console.log("\n✗ CÁC DÒNG LỆCH (dừng lại và tìm nguyên nhân, KHÔNG sửa dữ liệu cho khớp):");
    for (const r of rows) console.log(`   ${r.order_id}/${r.shipment_id ?? "—"}: kết quả chuẩn=${r.live} bảng=${r.materialized} · giá vốn chuẩn=${r.live_cogs} bảng=${r.materialized_cogs}`);
    process.exit(1);
  }

  console.log("\n✓ Không có dòng nào lệch.");
  process.exit(0);
}

main().catch((error) => {
  console.error("outcome-parity lỗi:", error instanceof Error ? error.message : error);
  process.exit(1);
});

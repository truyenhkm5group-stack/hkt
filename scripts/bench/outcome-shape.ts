/**
 * THỬ NGHIỆM: ORDER_OUTCOME tính MỘT LẦN cho mỗi dòng thay vì một lần cho mỗi cột gộp.
 *
 * EXPLAIN cho thấy Postgres nội tuyến cả biểu thức CASE (kèm ~13 truy vấn con tương quan) vào TỪNG
 * cột `filter (where ORDER_OUTCOME = …)`. Một truy vấn 8 cột gộp ⇒ hơn 100 truy vấn con cho mỗi dòng.
 *
 * Script này đo ba cách viết cho CÙNG một kết quả, để chọn cách nhanh nhất mà KHÔNG đổi con số:
 *   A. hiện tại        — CASE nội tuyến trong từng cột gộp
 *   B. subquery thường — Postgres kéo lên (pull-up) rồi nội tuyến lại, không giúp gì
 *   C. subquery có rào — `offset 0` chặn kéo lên ⇒ CASE tính đúng một lần mỗi dòng
 *
 * Chạy: npx tsx scripts/bench/outcome-shape.ts --scale=10
 */
import "dotenv/config";
import { rmSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";

const args = process.argv.slice(2);
const scale = Number((args.find((a) => a.startsWith("--scale=")) ?? "--scale=10").slice(8));

const dataDir = path.join("data", `pglite-shape-${process.pid}`);
rmSync(dataDir, { recursive: true, force: true });
process.env.DATABASE_URL = `pglite://${dataDir}`;

async function main() {
  const { ensureMigrated } = await import("@/db/migrate");
  const { seedBenchData } = await import("./seed");
  await ensureMigrated();
  await seedBenchData(scale);

  const { getDb } = await import("@/db");
  const { ORDER_OUTCOME } = await import("@/lib/queries/return-rate");
  const db = await getDb();

  // Cố ý KHÔNG đặt bí danh bảng: ORDER_OUTCOME sinh ra "shipments"."stage", "orders"."stage"…
  const FROM = sql`from order_items
    join orders on orders.id = order_items.order_id
    left join shipments on shipments.order_id = orders.id
    where orders.stage <> 'NEW' and not order_items.is_bonus`;

  const aggregates = (outcome: ReturnType<typeof sql>, qty: ReturnType<typeof sql>, total: ReturnType<typeof sql>, orderId: ReturnType<typeof sql>) => sql`
      coalesce(sum(${qty}) filter (where ${outcome} <> 'CANCELLED'), 0) as ordered_qty,
      coalesce(sum(${qty}) filter (where ${outcome} = 'DELIVERED'), 0) as delivered_qty,
      coalesce(sum(${qty}) filter (where ${outcome} in ('RETURNED','RETURNED_BY_RULE')), 0) as returned_qty,
      coalesce(sum(${total}) filter (where ${outcome} <> 'CANCELLED'), 0) as booked_revenue,
      coalesce(sum(${total}) filter (where ${outcome} = 'DELIVERED'), 0) as delivered_revenue,
      coalesce(sum(${total}) filter (where ${outcome} in ('RETURNED','RETURNED_BY_RULE')), 0) as lost_revenue,
      count(distinct ${orderId}) filter (where ${outcome} = 'DELIVERED') as delivered_orders,
      count(distinct ${orderId}) filter (where ${outcome} in ('RETURNED','RETURNED_BY_RULE')) as returned_orders`;

  const A = sql`select order_items.variant_id,
      ${aggregates(sql`(${ORDER_OUTCOME})`, sql`order_items.quantity`, sql`order_items.line_total`, sql`orders.id`)}
    ${FROM} group by order_items.variant_id order by 6 desc limit 50`;

  const inner = (fence: boolean) => sql`(select order_items.variant_id as variant_id, order_items.quantity as quantity,
      order_items.line_total as line_total, orders.id as order_id, (${ORDER_OUTCOME}) as outcome
    ${FROM}${fence ? sql` offset 0` : sql``}) t`;
  const outer = (fence: boolean) => sql`select t.variant_id,
      ${aggregates(sql`t.outcome`, sql`t.quantity`, sql`t.line_total`, sql`t.order_id`)}
    from ${inner(fence)} group by t.variant_id order by 6 desc limit 50`;

  const run = async (label: string, query: ReturnType<typeof sql>) => {
    await db.execute(query); // làm nóng
    const started = performance.now();
    const result = await db.execute(query);
    const ms = performance.now() - started;
    const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[];
    if (!rows.length) console.log("  (chẩn đoán)", JSON.stringify(result).slice(0, 200));
    const plan = await db.execute(sql`explain (analyze) ${query}`);
    const planRows = (Array.isArray(plan) ? plan : (plan as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[];
    const lines = planRows.map((r) => String(Object.values(r)[0]));
    const subplans = lines.filter((l) => l.trim().startsWith("SubPlan")).length;
    console.log(`${label.padEnd(30)} ${ms.toFixed(0).padStart(9)} ms · ${String(rows.length).padStart(3)} dòng · ${String(subplans).padStart(3)} SubPlan`);
    return rows;
  };

  const ra = await run("A. CASE trong từng cột gộp", A);
  const rb = await run("B. subquery (bị kéo lên)", outer(false));
  const rc = await run("C. subquery + rào offset 0", outer(true));

  const norm = (rows: Record<string, unknown>[]) => JSON.stringify(rows.map((r) => Object.values(r).map(String)));
  console.log("\nA == C (số liệu giống hệt từng dòng):", norm(ra) === norm(rc));
  console.log("A == B (số liệu giống hệt từng dòng):", norm(ra) === norm(rb));

  rmSync(dataDir, { recursive: true, force: true });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(1);
  });

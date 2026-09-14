/**
 * DIỄN TẬP MIGRATION + CHỨNG MINH INDEX ĐƯỢC DÙNG THẬT.
 *
 * Ba câu hỏi phải trả lời trước khi phát hành một migration index:
 *  1. Chạy từ CSDL trống có áp được không, và áp đúng một lần?
 *  2. Chạy lại lần hai có an toàn không (idempotent)?
 *  3. Bộ tối ưu có THẬT SỰ dùng index đó không, hay chỉ tạo ra rồi để đấy?
 *
 * Câu 3 mới là câu đáng tiền: một index không được dùng chỉ làm chậm ghi và tốn đĩa.
 *
 * Chạy: npx tsx scripts/bench/migration-verify.ts
 */
import "dotenv/config";
import { rmSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";

const dir = path.join("data", `pglite-migrate-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.DATABASE_URL = `pglite://${dir}`;

const INDEX = "shipments_order_reference_lookup_idx";

async function main() {
  const { ensureMigrated } = await import("@/db/migrate");
  const started = Date.now();
  await ensureMigrated();
  console.log(`1. Ap migration tu CSDL trong: ${Date.now() - started} ms`);

  const { getDb } = await import("@/db");
  const db = await getDb();

  const idx = await db.execute(sql`select indexname, indexdef from pg_indexes where indexname = ${INDEX}`);
  const idxRows = (Array.isArray(idx) ? idx : (idx as { rows?: unknown[] }).rows ?? []) as Record<string, string>[];
  console.log(`2. Index ton tai: ${idxRows.length === 1}`);
  console.log(`   ${idxRows[0]?.indexdef ?? "(khong thay)"}`);

  const applied = await db.execute(sql`select count(*)::int as n from "drizzle"."__drizzle_migrations"`);
  const appliedRows = (Array.isArray(applied) ? applied : (applied as { rows?: unknown[] }).rows ?? []) as Record<string, number>[];
  console.log(`3. So migration da ap: ${appliedRows[0]?.n}`);

  // Chạy lại: migrator phải bỏ qua, và câu lệnh có IF NOT EXISTS nên chạy tay cũng vô hại
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS "${INDEX}" ON "shipments" USING btree ("order_reference") WHERE "order_reference" IS NOT NULL`));
  console.log("4. Chay lai cau lenh index lan hai: khong loi (idempotent)");

  // ── Dữ liệu để bộ tối ưu có cái mà chọn ──────────────────────────────────
  const { seedBenchData } = await import("./seed");
  await seedBenchData(1);

  // Câu hỏi mà index này sinh ra để trả lời: "co van don nao tro nguoc ve ma nay khong?"
  const { schema } = await import("@/db");
  const s = schema.shipments;
  const probe = sql`select count(*) from ${s} where exists (
    select 1 from shipments leg where leg.order_reference = ${s.vtpOrderNumber} and leg.id <> ${s.id})`;
  const plan = await db.execute(sql`explain (analyze, buffers) ${probe}`);
  const planRows = (Array.isArray(plan) ? plan : (plan as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[];
  const text = planRows.map((r) => String(Object.values(r)[0])).join("\n");
  const dungIndex = text.includes(INDEX);
  console.log(`\n5. Bo toi uu co dung index khong: ${dungIndex ? "CO" : "KHONG"}`);
  for (const line of text.split("\n").filter((l) => /Index Scan|Seq Scan|SubPlan|Buffers: shared/.test(l)).slice(0, 8)) {
    console.log(`   ${line.trim()}`);
  }
  if (!dungIndex) {
    console.error("\nINDEX KHONG DUOC DUNG — dung phat hanh, xem lai.");
    process.exitCode = 1;
  }

  rmSync(dir, { recursive: true, force: true });
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error);
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  });

/**
 * ĐO SỐ CÂU TRUY VẤN CỦA HÀNG ĐỢI CSKH THEO KHÁCH — số liệu N+1, không phải cảm nhận.
 *
 *   ERP_PERF_PROBE=1 npx tsx scripts/bench-cs-queue.ts
 *
 * Câu hỏi duy nhất: số câu truy vấn có TĂNG THEO SỐ DÒNG không. Thời gian tường trên PGlite (một
 * luồng, WASM) không so được với Postgres 16 của VPS; SỐ CÂU thì so được, và nó mới là thứ quyết
 * định trang có sập khi hàng đợi từ 57 khách lên 570.
 *
 * Dựng một CSDL PGlite TRỐNG riêng mỗi lượt, đổ N khách × M case, rồi đo.
 */
process.env.ERP_PERF_PROBE = "1";
const dir = `./data/pglite-bench-cs-${process.pid}`;
process.env.DATABASE_URL = `pglite://${dir}`;

import { rmSync } from "node:fs";
import { getDb, schema } from "@/db";
import { ensureMigrated } from "@/db/migrate";
import { probe } from "@/lib/perf/probe";
import { csOwnerLoad, listCsCustomerQueue } from "@/lib/queries/cs";
import { parseListParams } from "@/lib/search-params";

const KINDS = ["COMPLAINT", "EXCHANGE_SIZE", "RETURN", "URGE_DELIVERY", "ORDER_NOT_CREATED", "SIZE_ADVICE"];

async function gieo(khach: number, caseMoiKhach: number) {
  const db = await getDb();
  const rows = [];
  for (let i = 0; i < khach; i++) {
    for (let j = 0; j < caseMoiKhach; j++) {
      rows.push({
        id: `bench-${i}-${j}`,
        kind: KINDS[(i + j) % KINDS.length],
        status: "OPEN",
        source: "PANCAKE_CHAT",
        title: `việc ${i}/${j}`,
        customerPhone: `09${String(10_000_000 + i).slice(0, 8)}`,
        customerName: `Khách ${i}`,
        createdAt: new Date(Date.now() - (i * 3 + j) * 3_600_000),
      });
    }
  }
  for (let i = 0; i < rows.length; i += 500) await db.insert(schema.csCases).values(rows.slice(i, i + 500)).onConflictDoNothing();
}

async function main() {
  rmSync(dir, { recursive: true, force: true });
  await ensureMigrated();
  const params = parseListParams({ pageSize: "50" }, { defaultSort: "createdAt", filterKeys: ["kind", "status", "assignee", "domain", "sla"], sortable: ["createdAt"], defaultPeriod: "all" });

  const moc: { khach: number; cases: number; queries: number; ms: number; owner: number }[] = [];
  for (const [khach, moiKhach] of [[10, 2], [100, 3], [400, 3]] as const) {
    await gieo(khach, moiKhach);
    const q = await probe("cs-queue", () => listCsCustomerQueue(params));
    const o = await probe("cs-owner", () => csOwnerLoad());
    moc.push({ khach, cases: khach * moiKhach, queries: q.stats.queries, ms: Math.round(q.stats.ms), owner: o.stats.queries });
    console.log(`${String(khach).padStart(4)} khách · ${String(khach * moiKhach).padStart(5)} case  →  ${q.stats.queries} câu truy vấn · ${Math.round(q.stats.ms)}ms · ${q.value.rows.length} dòng trang  |  khối lượng việc: ${o.stats.queries} câu`);
  }

  const soCau = new Set(moc.map((m) => m.queries));
  console.log(
    soCau.size === 1
      ? `\n✓ KHÔNG N+1: ${[...soCau][0]} câu truy vấn ở MỌI quy mô (10 → 400 khách). Số câu là hằng số, không phải hàm của số dòng.`
      : `\n✗ SỐ CÂU TĂNG THEO DỮ LIỆU: ${moc.map((m) => `${m.khach}→${m.queries}`).join(" · ")} — đây là N+1.`,
  );
  rmSync(dir, { recursive: true, force: true });
  process.exit(soCau.size === 1 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});

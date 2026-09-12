/**
 * ĐO RIÊNG TRANG QUẢNG CÁO — quy trách nhiệm từng lời gọi, không đo gộp cả trang.
 *
 * Chạy:
 *   npx tsx scripts/bench/ads.ts --scale=4 --out=docs/perf/ads-before.json
 *
 * Vì sao cần một dụng cụ riêng thay vì dùng `bench-reports.ts`: bench đo CẢ TRANG như một khối,
 * nên khi trang mất 5,8 giây ta chỉ biết "trang chậm" chứ không biết lời gọi nào ăn hết thời gian.
 * Ở đây mỗi lời gọi chạy trong một phạm vi đo riêng, đệm bị xoá trước từng lượt, nên con số in ra
 * là chi phí THẬT của chính lời gọi đó — đủ để chỉ mặt nút thắt thay vì đoán.
 *
 * Cùng giới hạn trung thực như `bench-reports.ts`: PGlite là Postgres biên dịch sang WebAssembly,
 * chạy MỘT luồng. Con số tuyệt đối không bằng VPS; thứ so sánh được là tỷ lệ giữa các lời gọi,
 * SỐ CÂU truy vấn, số dòng, và so sánh TRƯỚC/SAU trên cùng một máy.
 */
import "dotenv/config";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const scale = Number(arg("scale", "4"));
/**
 * TƯƠNG ĐƯƠNG PRODUCTION: production chạy `rematerializeStale` theo lịch nên bảng
 * `canonical_order_outcome` LUÔN có dữ liệu, và `ORDER_OUTCOME_FAST` đọc bảng đó thay vì tính lại.
 * Bộ dữ liệu đo không dựng bảng này, nên nếu không bật cờ dưới đây thì mọi con số đo được là
 * TRƯỜNG HỢP XẤU NHẤT (mỗi đơn tính kết quả sống), không phải cái production thật sự chạy.
 * `--materialize=0` giữ lại trường hợp xấu nhất để đối chiếu.
 */
const materialize = arg("materialize", "1") !== "0";
const rounds = Number(arg("rounds", "3"));
const outPath = arg("out", "");
const label = arg("label", "");

const dataDir = path.join("data", `pglite-ads-${process.pid}`);
rmSync(dataDir, { recursive: true, force: true });
process.env.DATABASE_URL = `pglite://${dataDir}`;
process.env.ERP_PERF_PROBE = "1";

type Case = { name: string; note: string; run: () => Promise<unknown> };
type Row = {
  name: string;
  note: string;
  coldMs: number;
  warmMs: number;
  p95Ms: number;
  queries: number;
  dbMs: number;
  rows: number;
  payloadKb: number;
  slowest: { sql: string; count: number; ms: number; rows: number }[];
};

function quantile(values: number[], q: number) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/**
 * ───────────── CANH TRƯỚC KHI ĐO: BỘ DỮ LIỆU PHẢI THẬT SỰ ĐỌC ĐƯỢC ─────────────
 *
 * Đo được 12/09/2026: từ `--scale=4` trở lên, PGlite trả **mảng rỗng cho MỌI câu lệnh** — kể cả
 * `select count(*) from orders`. Một hàm gộp không có GROUP BY mà trả 0 dòng là điều SQL không cho
 * phép, nên đây là hỏng ở tầng driver (WASM), không phải dữ liệu trống.
 *
 * Vì sao phải chặn: bộ đo vẫn chạy trót lọt và vẫn in ra những con số trông rất đẹp — chúng là thời
 * gian của các câu lệnh KHÔNG trả về gì. `docs/perf/*-scale4.json` và `*-scale10.json` có sẵn trong
 * kho được đo đúng trong tình trạng đó, nên không dùng để kết luận được.
 *
 * Quy mô 1–3 đã kiểm: đọc đúng. Thà dừng hẳn còn hơn in ra một con số sai mà không ai biết.
 */
async function assertDataReadable(scale: number, expectedOrders: number) {
  const { getDb, schema } = await import("@/db");
  const { sql } = await import("drizzle-orm");
  const db = await getDb();
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(schema.orders);
  const got = rows[0]?.n;
  if (got === undefined) {
    throw new Error(
      `PGlite trả mảng rỗng cho "select count(*) from orders" ở --scale=${scale}. ` +
        "Driver hỏng ở quy mô này: mọi con số đo được sẽ là thời gian của câu lệnh KHÔNG trả về gì. " +
        "Hãy đo ở --scale=3 trở xuống (đã kiểm đọc đúng).",
    );
  }
  if (got !== expectedOrders) {
    throw new Error(`Đếm được ${got} đơn nhưng bộ dữ liệu khai ${expectedOrders} — bộ dữ liệu không nhất quán, không đo.`);
  }
}

async function main() {
  const { ensureMigrated } = await import("@/db/migrate");
  const { seedBenchData } = await import("./seed");
  const { probe } = await import("@/lib/perf/probe");
  const { clearMemo } = await import("@/lib/cache");
  const { resolvePeriod } = await import("@/lib/search-params");

  await ensureMigrated();
  const seeded = await seedBenchData(scale);
  await assertDataReadable(scale, Number(seeded.orders ?? 0));
  if (materialize) {
    const { rematerializeOutcomes } = await import("@/lib/queries/canonical-outcome");
    const started = performance.now();
    await rematerializeOutcomes();
    // ĐẾM LẠI, KHÔNG TIN `rowCount`: PGlite không báo số dòng cho `insert ... select`, nên
    // `rematerializeOutcomes()` trả 0 trong khi bảng đã đầy. In số 0 ở đây từng khiến tôi tưởng
    // phép đo không tương đương production.
    const { getDb: getBenchDb, schema: benchSchema } = await import("@/db");
    const { sql: rawSql } = await import("drizzle-orm");
    const counted = await (await getBenchDb()).select({ n: rawSql<number>`count(*)::int` }).from(benchSchema.canonicalOrderOutcome);
    const n = Number(counted[0]?.n ?? 0);
    console.log(`Đã dựng canonical_order_outcome: ${n} dòng trong ${Math.round(performance.now() - started)}ms`);
  }

  const month = resolvePeriod({ period: "month" }, "month");

  const { getAdsRoas } = await import("@/lib/queries/ads-roas");
  const { getAdsAttributionAudit } = await import("@/lib/queries/ads-attribution");
  const { getAdsPerformance } = await import("@/lib/queries/ads-performance");
  const { adsAttributionCoverage, adsAttributionCoverageByDay } = await import("@/lib/queries/ads-attribution-coverage");
  const { getAdsDecision } = await import("@/lib/queries/ads-decision");
  const { getMarketerReport } = await import("@/lib/queries/payroll");
  const { getNominalProfitReport } = await import("@/lib/queries/profit-nominal");
  const { salesByProductPage, listEmployees } = await import("@/lib/queries/payroll");

  const cases: Case[] = [
    // ── MỚI: bảng quyết định, không đi qua bộ máy lương/lợi nhuận ──
    { name: "getAdsDecision(campaign)", note: "Bảng quyết định theo chiến dịch", run: () => getAdsDecision(month, "campaign") },
    { name: "getAdsDecision(product)", note: "Bảng quyết định theo mã hàng", run: () => getAdsDecision(month, "product") },
    { name: "getAdsDecision(adset)", note: "Bảng quyết định theo nhóm QC", run: () => getAdsDecision(month, "adset") },
    { name: "getAdsDecision(ad)", note: "Bảng quyết định theo mẩu QC", run: () => getAdsDecision(month, "ad") },
    { name: "getAdsRoas(campaign)", note: "Bảng ROAS theo chiến dịch", run: () => getAdsRoas(month, "campaign") },
    { name: "getAdsRoas(ad)", note: "Bảng ROAS theo mẩu quảng cáo", run: () => getAdsRoas(month, "ad") },
    { name: "getAdsAttributionAudit", note: "Soát quy kết", run: () => getAdsAttributionAudit(month) },
    { name: "getAdsPerformance", note: "Theo marketer / mã hàng", run: () => getAdsPerformance(month) },
    { name: "  └ getMarketerReport", note: "Phụ thuộc của getAdsPerformance", run: () => getMarketerReport(month) },
    { name: "    └ getNominalProfitReport", note: "Phụ thuộc của getMarketerReport", run: () => getNominalProfitReport(month) },
    { name: "    └ salesByProductPage(delivered)", note: "Phụ thuộc của getMarketerReport", run: () => salesByProductPage(month, "delivered") },
    { name: "    └ listEmployees", note: "Phụ thuộc của getMarketerReport", run: () => listEmployees() },
    { name: "adsAttributionCoverage", note: "Độ phủ quy kết", run: () => adsAttributionCoverage(month.from, month.to) },
    { name: "adsAttributionCoverageByDay", note: "Độ phủ theo ngày", run: () => adsAttributionCoverageByDay(30) },
    /**
     * HAI CON SỐ CỦA CẢ TRANG, và chúng đo hai thứ khác nhau:
     *  · PHẦN CHỜ  — thứ người dùng phải đợi trước khi thấy gì. Sau khi tách `Suspense`, đây chỉ
     *    còn là bảng quyết định.
     *  · TOÀN BỘ   — tổng công sức máy chủ bỏ ra cho cả trang, kể cả phần điền vào sau.
     * Chỉ nhìn con số thứ hai sẽ tưởng không cải thiện gì; chỉ nhìn con số thứ nhất sẽ tưởng phần
     * đắt đã biến mất. Cả hai phải đứng cạnh nhau.
     */
    {
      name: "TRANG — PHẦN CHỜ (sau)",
      note: "Người dùng đợi bấy nhiêu trước khi thấy bảng quyết định",
      run: () => getAdsDecision(month, "campaign"),
    },
    {
      name: "TRANG — PHẦN CHỜ (trước)",
      note: "Trang cũ chờ cả ba khối rồi mới vẽ",
      run: () => Promise.all([getAdsRoas(month, "campaign"), getAdsAttributionAudit(month), getAdsPerformance(month)]),
    },
    {
      name: "TRANG — TOÀN BỘ (sau)",
      note: "Cả trang mới, gồm phần điền vào sau",
      run: () =>
        Promise.all([
          getAdsDecision(month, "campaign"),
          getAdsRoas(month, "campaign"),
          getAdsAttributionAudit(month),
          getAdsPerformance(month),
        ]),
    },
  ];

  const results: Row[] = [];
  for (const c of cases) {
    let warmupError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      clearMemo();
      try {
        await c.run();
        warmupError = null;
        break;
      } catch (error) {
        warmupError = error as Error;
      }
    }
    if (warmupError) {
      results.push({ name: `${c.name} — LỖI: ${warmupError.message.slice(0, 160)}`, note: c.note, coldMs: -1, warmMs: -1, p95Ms: -1, queries: 0, dbMs: 0, rows: 0, payloadKb: 0, slowest: [] });
      continue;
    }

    const times: number[] = [];
    let stats = { queries: 0, dbMs: 0, rows: 0, slowest: [] as Row["slowest"] };
    let payloadKb = 0;
    for (let r = 0; r < rounds; r += 1) {
      clearMemo();
      const measured = await probe(c.name, c.run);
      times.push(measured.stats.ms);
      if (r === 0) {
        stats = { queries: measured.stats.queries, dbMs: measured.stats.dbMs, rows: measured.stats.rows, slowest: measured.stats.slowest };
        payloadKb = Math.round((JSON.stringify(measured.value)?.length ?? 0) / 102.4) / 10;
      }
    }
    const warm = await probe(c.name, c.run);
    results.push({
      name: c.name,
      note: c.note,
      coldMs: Math.round(quantile(times, 0.5) * 10) / 10,
      warmMs: Math.round(warm.stats.ms * 10) / 10,
      p95Ms: Math.round(quantile(times, 0.95) * 10) / 10,
      queries: stats.queries,
      dbMs: Math.round(stats.dbMs * 10) / 10,
      rows: stats.rows,
      payloadKb,
      slowest: stats.slowest.slice(0, 5),
    });
  }

  const report = {
    label: label || (outPath ? path.basename(outPath, ".json") : "ads-bench"),
    scale,
    rounds,
    materialized: materialize,
    node: process.version,
    engine: "PGlite (Postgres 16 → WASM, một luồng)",
    measuredAt: new Date().toISOString(),
    rows: seeded,
    results,
  };

  const json = JSON.stringify(report, null, 2);
  if (outPath) {
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, json + "\n", "utf8");
  }
  console.log("─".repeat(96));
  console.log(
    `QUY MÔ ${scale}× · đơn ${seeded.orders} · vận đơn ${seeded.shipments} · ` +
      `${materialize ? "CÓ dựng canonical_order_outcome (như production)" : "KHÔNG dựng canonical (trường hợp xấu nhất)"}`,
  );
  console.log("─".repeat(96));
  console.log("lạnh(ms)   ấm(ms)  câu   dòng  KB    lời gọi");
  for (const r of results) {
    console.log(
      `${String(r.coldMs).padStart(8)}  ${String(r.warmMs).padStart(7)}  ${String(r.queries).padStart(4)}  ${String(r.rows).padStart(5)}  ${String(r.payloadKb).padStart(5)}  ${r.name}`,
    );
  }
  if (outPath) console.log(`\nĐã ghi ${outPath}`);
  rmSync(dataDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

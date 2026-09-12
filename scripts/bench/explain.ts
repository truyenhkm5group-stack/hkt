/**
 * EXPLAIN ANALYZE cho các truy vấn báo cáo nặng — bằng chứng để thêm (hoặc KHÔNG thêm) index.
 *
 * Chạy: npx tsx scripts/bench/explain.ts --scale=4 [--grep=GTC]
 *
 * Dựng CSDL đo giống `scripts/bench-reports.ts`, chạy hàm báo cáo một lần để BẮT câu lệnh thật
 * (kèm tham số) tại lớp driver, rồi chạy lại từng câu với EXPLAIN (ANALYZE, BUFFERS). Nhờ vậy
 * kế hoạch in ra là kế hoạch của ĐÚNG câu ứng dụng chạy, không phải một câu chép tay gần giống.
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
const grep = arg("grep", "");
const outPath = arg("out", "");
const topN = Number(arg("top", "12"));

const dataDir = path.join("data", `pglite-explain-${process.pid}`);
rmSync(dataDir, { recursive: true, force: true });
process.env.DATABASE_URL = `pglite://${dataDir}`;
process.env.ERP_PERF_PROBE = "1";

type Captured = { page: string; sql: string; params: unknown[]; ms: number };

async function main() {
  const { ensureMigrated } = await import("@/db/migrate");
  const { seedBenchData } = await import("./seed");
  const { clearMemo } = await import("@/lib/cache");
  const { resolvePeriod, parseListParams } = await import("@/lib/search-params");

  await ensureMigrated();
  await seedBenchData(scale);

  const { getDb } = await import("@/db");
  await getDb();
  const holder = globalThis as unknown as { __erpDb?: { pglite?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> } } };
  const client = holder.__erpDb!.pglite!;

  // Bắt câu lệnh + tham số ngay tại driver
  const captured: Captured[] = [];
  let capturing: string | null = null;
  const original = client.query.bind(client);
  client.query = (async (sql: unknown, params?: unknown[], ...rest: unknown[]) => {
    const text = typeof sql === "string" ? sql : String((sql as { text?: string })?.text ?? "");
    const started = performance.now();
    const result = await (original as (...a: unknown[]) => Promise<{ rows: unknown[] }>)(sql, params, ...rest);
    if (capturing && !text.startsWith("explain")) captured.push({ page: capturing, sql: text, params: params ?? [], ms: performance.now() - started });
    return result;
  }) as typeof client.query;

  const month = resolvePeriod({ period: "month" }, "month");
  const d30 = resolvePeriod({ period: "30d" }, "30d");
  const all = resolvePeriod({ period: "all" }, "all");

  const { getDashboardData } = await import("@/lib/queries/dashboard");
  const { getProfitReport } = await import("@/lib/queries/reports");
  const { listOrders, orderSummary } = await import("@/lib/queries/orders");
  const { listShipments, shipmentSummary } = await import("@/lib/queries/shipments");
  const { getAdsRoas } = await import("@/lib/queries/ads-roas");
  const { getAdsDecision } = await import("@/lib/queries/ads-decision");
  const { getAdsPerformance } = await import("@/lib/queries/ads-performance");
  const { getProductIntelligence } = await import("@/lib/queries/product-intelligence");
  const { dataQualitySummary } = await import("@/lib/queries/data-quality");
  const { getControlTower } = await import("@/lib/queries/control-tower");
  const { getReturnRateSummary, getReturnRateByVariant } = await import("@/lib/queries/return-rate");
  const { getFinancialTruth } = await import("@/lib/queries/financial-truth");
  const { listProducts, productFacets, productSummary, PRODUCT_SORTABLE } = await import("@/lib/queries/products");

  const orderParams = parseListParams({ period: "all" }, { defaultSort: "insertedAt", filterKeys: ["stage", "source", "cod"] });
  const shipmentParams = parseListParams({ period: "all" }, { defaultSort: "vtpStatusDate", filterKeys: ["stage", "cod", "carrier"] });
  const productParams = parseListParams({}, { defaultSort: "erpStock", defaultDir: "asc", filterKeys: ["stock", "category", "warehouse", "status"], sortable: PRODUCT_SORTABLE, defaultPeriod: "all" });

  const pages: { page: string; run: () => Promise<unknown> }[] = [
    { page: "Dashboard", run: () => getDashboardData(d30) },
    { page: "Profit", run: () => getProfitReport(month, "created") },
    { page: "Orders", run: () => Promise.all([listOrders(orderParams), orderSummary(orderParams)]) },
    { page: "Shipments", run: () => Promise.all([listShipments(shipmentParams), shipmentSummary(shipmentParams)]) },
    { page: "Ads", run: () => Promise.all([getAdsRoas(month, "campaign"), getAdsPerformance(month)]) },
    { page: "AdsDecision", run: () => Promise.all([getAdsDecision(month, "campaign"), getAdsDecision(month, "product")]) },
    { page: "Product", run: () => getProductIntelligence({ period: month, limit: 50 }) },
    { page: "DataQuality", run: () => Promise.all([dataQualitySummary(all), getControlTower()]) },
    { page: "GTC", run: () => getReturnRateSummary(month, "") },
    { page: "GTCVariant", run: () => getReturnRateByVariant({ period: month, q: "", minShipped: 0, sort: "returned", dir: "desc", page: 1, pageSize: 50 }) },
    { page: "Truth", run: () => getFinancialTruth(month) },
    { page: "Products", run: () => Promise.all([listProducts(productParams), productFacets(productParams), productSummary(productParams)]) },
  ];

  for (const p of pages) {
    if (grep && !p.page.toLowerCase().includes(grep.toLowerCase())) continue;
    clearMemo();
    capturing = p.page;
    try {
      await p.run();
    } catch {
      // bỏ qua: mục tiêu là bắt câu lệnh, không phải kết quả
    }
    capturing = null;
  }

  // Chạy tuần tự để thời gian đo được là thời gian THẬT, không phải thời gian xếp hàng
  const measured: Captured[] = [];
  for (const c of captured) {
    const started = performance.now();
    await (original as (...a: unknown[]) => Promise<unknown>)(c.sql, c.params);
    measured.push({ ...c, ms: performance.now() - started });
  }

  const top = measured.sort((a, b) => b.ms - a.ms).slice(0, topN);
  const out: string[] = [];
  for (const c of top) {
    out.push(`\n${"═".repeat(100)}\n[${c.page}] ${c.ms.toFixed(1)} ms\n${c.sql.replace(/\s+/g, " ").slice(0, 400)}\n${"─".repeat(100)}`);
    try {
      const plan = (await (original as (...a: unknown[]) => Promise<{ rows: Record<string, string>[] }>)(`explain (analyze, buffers, verbose false) ${c.sql}`, c.params)).rows;
      out.push(plan.map((r) => Object.values(r)[0]).join("\n"));
    } catch (error) {
      out.push(`EXPLAIN lỗi: ${(error as Error).message}`);
    }
  }
  const text = out.join("\n");
  console.log(text);
  if (outPath) {
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, text + "\n", "utf8");
  }
  rmSync(dataDir, { recursive: true, force: true });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(1);
  });

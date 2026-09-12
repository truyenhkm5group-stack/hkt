/**
 * ĐO HIỆU NĂNG BÁO CÁO — số liệu TRƯỚC / SAU cho mọi thay đổi hiệu năng.
 *
 * Chạy:
 *   npx tsx scripts/bench-reports.ts --scale=1  --out=docs/perf/before-scale1.json
 *   npx tsx scripts/bench-reports.ts --scale=10 --out=docs/perf/before-scale10.json
 *
 * Mỗi lần chạy dựng một CSDL PGlite TRỐNG riêng, đổ dữ liệu theo `--scale` rồi đo từng "gói truy
 * vấn của một trang" — đúng những hàm mà Server Component của trang đó gọi. Ghi lại:
 *   · thời gian tường (lạnh = xoá đệm trước mỗi lượt, ấm = lượt kế tiếp)
 *   · SỐ CÂU truy vấn thật sự chạy (bắt tại lớp driver, nên không bỏ sót câu nào)
 *   · tổng thời gian CSDL, tổng số dòng CSDL trả về
 *   · kích thước dữ liệu trả về cho trang (JSON) — để thấy trang nào kéo cả nghìn dòng về máy chủ
 *
 * LƯU Ý TRUNG THỰC: PGlite là Postgres biên dịch sang WebAssembly, chạy một luồng. Con số tuyệt đối
 * KHÔNG bằng con số trên Postgres 16 của VPS; điều so sánh được là TỶ LỆ giữa các trang, SỐ CÂU
 * truy vấn, số dòng và độ tăng theo quy mô — và so sánh TRƯỚC/SAU trên cùng một máy.
 */
import "dotenv/config";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const scale = Number(arg("scale", "1"));
const rounds = Number(arg("rounds", "3"));
const outPath = arg("out", "");
const label = arg("label", "");
const grep = arg("grep", "");

// CSDL riêng cho lần đo — phải đặt TRƯỚC khi nạp bất kỳ mô-đun nào chạm @/db
const dataDir = path.join("data", `pglite-bench-${process.pid}`);
rmSync(dataDir, { recursive: true, force: true });
process.env.DATABASE_URL = `pglite://${dataDir}`;
process.env.SKIP_AUTO_MIGRATE = "";
// Bật lớp đếm câu truy vấn ở `db/index.ts` (mặc định tắt, production không bọc gì cả)
process.env.ERP_PERF_PROBE = "1";

type Case = { page: string; run: () => Promise<unknown> };
type Result = {
  page: string;
  coldMs: number;
  warmMs: number;
  p50Ms: number;
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

async function main() {
  const { ensureMigrated } = await import("@/db/migrate");
  const { seedBenchData } = await import("./bench/seed");
  const { probe } = await import("@/lib/perf/probe");
  const { clearMemo } = await import("@/lib/cache");
  const { resolvePeriod } = await import("@/lib/search-params");
  const { parseListParams } = await import("@/lib/search-params");

  const startedAt = Date.now();
  await ensureMigrated();
  const seeded = await seedBenchData(scale);
  const seedMs = Date.now() - startedAt;

  // Kỳ báo cáo mặc định của từng trang, dựng đúng như `resolvePeriod` trong trang
  const month = resolvePeriod({ period: "month" }, "month");
  const d30 = resolvePeriod({ period: "30d" }, "30d");
  const all = resolvePeriod({ period: "all" }, "all");

  const { getDashboardData } = await import("@/lib/queries/dashboard");
  const { getProfitReport } = await import("@/lib/queries/reports");
  const { listOrders, orderFacets, orderSummary } = await import("@/lib/queries/orders");
  const { listShipments, shipmentFacets, shipmentSummary } = await import("@/lib/queries/shipments");
  const { getAdsRoas } = await import("@/lib/queries/ads-roas");
  const { getAdsAttributionAudit } = await import("@/lib/queries/ads-attribution");
  const { getAdsPerformance } = await import("@/lib/queries/ads-performance");
  const { getProductIntelligence } = await import("@/lib/queries/product-intelligence");
  const { listInventory, inventoryFacets, inventorySummary } = await import("@/lib/queries/inventory");
  const { listProducts, productFacets, productSummary, listWarehouses, PRODUCT_SORTABLE } = await import("@/lib/queries/products");
  const { getActionQueue } = await import("@/lib/queries/action-queue");
  const { listOpenNotifications, openCountsByKind } = await import("@/lib/queries/notifications");
  const { dataQualitySummary } = await import("@/lib/queries/data-quality");
  const { getControlTower } = await import("@/lib/queries/control-tower");
  const { getReturnRateSummary, getReturnRateByVariant } = await import("@/lib/queries/return-rate");
  const { getFinancialTruth } = await import("@/lib/queries/financial-truth");
  const { getCashPosition } = await import("@/lib/queries/cash-position");
  const { getCashflowStatement } = await import("@/lib/queries/cashflow-statement");
  const { getCashflow } = await import("@/lib/queries/cashflow");
  const { getProfitCashBridge } = await import("@/lib/queries/profit-cash-bridge");
  const { getExpenseReport } = await import("@/lib/queries/expense-report");
  const { getFinanceOverview } = await import("@/lib/queries/finance-overview");

  const orderParams = parseListParams({ period: "all" }, { defaultSort: "insertedAt", filterKeys: ["stage", "source", "cod"] });
  const shipmentParams = parseListParams({ period: "all" }, { defaultSort: "vtpStatusDate", filterKeys: ["stage", "cod", "carrier"] });
  const inventoryParams = parseListParams({}, { defaultSort: "remain", filterKeys: ["status"] });
  const productParams = parseListParams({}, { defaultSort: "erpStock", defaultDir: "asc", filterKeys: ["stock", "category", "warehouse", "status"], sortable: PRODUCT_SORTABLE, defaultPeriod: "all" });

  const cases: Case[] = [
    { page: "Tổng quan (Dashboard)", run: () => getDashboardData(d30) },
    { page: "Báo cáo lợi nhuận (Profit)", run: () => getProfitReport(month, "created") },
    { page: "Đơn hàng (Orders)", run: () => Promise.all([listOrders(orderParams), orderFacets(orderParams), orderSummary(orderParams)]) },
    { page: "Vận đơn (Shipments)", run: () => Promise.all([listShipments(shipmentParams), shipmentFacets(shipmentParams), shipmentSummary(shipmentParams)]) },
    {
      page: "Quảng cáo (Ads)",
      run: () => Promise.all([getAdsRoas(month, "campaign"), getAdsAttributionAudit(month), getAdsPerformance(month)]),
    },
    { page: "Hiệu quả mẫu mã (Product)", run: () => getProductIntelligence({ period: month, limit: 50 }) },
    { page: "Tồn kho (Inventory)", run: () => Promise.all([listInventory(inventoryParams), inventoryFacets(inventoryParams), inventorySummary(inventoryParams)]) },
    { page: "Sản phẩm & tồn kho (Products)", run: () => Promise.all([listProducts(productParams), productFacets(productParams), productSummary(productParams), listWarehouses()]) },
    { page: "Hàng đợi việc (Action Queue)", run: () => Promise.all([listOpenNotifications(300), openCountsByKind(), getActionQueue({ limit: 300 })]) },
    { page: "Chất lượng dữ liệu (Data Quality)", run: () => Promise.all([dataQualitySummary(all), getControlTower()]) },
    // Tách riêng: 22 luật đối soát, dùng chung giữa Tổng quan và Chất lượng dữ liệu
    { page: "Trung tâm điều khiển (22 luật)", run: () => getControlTower() },
    { page: "Tỷ lệ giao thành công (GTC)", run: () => getReturnRateSummary(month, "") },
    {
      page: "GTC theo mẫu mã",
      run: () => getReturnRateByVariant({ period: month, q: "", minShipped: 0, sort: "returned", dir: "desc", page: 1, pageSize: 50 }),
    },
    { page: "Chân lý tài chính (Truth)", run: () => getFinancialTruth(month) },
    /*
      ═══ NHÓM TÀI CHÍNH ═══

      `Tổng quan tài chính` là trang tài chính NẶNG NHẤT vì nó đọc năm engine cùng lúc. Đo cả trang
      VÀ đo từng engine riêng: nếu trang chậm mà từng engine đều nhanh thì lỗi ở cách gộp, còn nếu
      một engine chậm thì đã biết ngay engine nào — chỉ đo con số tổng thì phải đi dò lại từ đầu.

      Hai dòng dòng tiền đứng cạnh nhau CÓ CHỦ ĐÍCH: `Dự phóng` là truy vấn đã có từ trước,
      `Tiền thật` là truy vấn mới. Đặt cùng một lượt đo để so trực tiếp trên cùng một máy, cùng một
      bộ dữ liệu — đó là phép so TRƯỚC/SAU duy nhất có nghĩa với một trang vừa được thêm tab.
    */
    { page: "Tổng quan tài chính (Finance)", run: () => getFinanceOverview(month) },
    { page: "· Tiền hiện có (Cash position)", run: () => getCashPosition() },
    { page: "· Dòng tiền THẬT (Statement)", run: () => getCashflowStatement(month) },
    { page: "· Dòng tiền DỰ PHÓNG (Forecast — đã có trước)", run: () => getCashflow() },
    { page: "· Lợi nhuận ≠ tiền (Bridge)", run: () => getProfitCashBridge(month) },
    { page: "· Báo cáo chi phí (Expense report)", run: () => getExpenseReport(month) },
  ];

  const results: Result[] = [];
  for (const c of cases) {
    if (grep && !c.page.toLowerCase().includes(grep.toLowerCase())) continue;
    // Làm nóng đường dẫn mã (JIT, chuẩn bị câu lệnh) rồi mới đo, để không tính chi phí khởi động lần đầu.
    // Thử lại một lần: PGlite thỉnh thoảng suy sai kiểu tham số ở lượt đầu khi có vài chục câu chạy
    // đồng thời trên MỘT kết nối. Đây là giới hạn của công cụ đo, không phải của ứng dụng
    // (Postgres thật dùng pool nhiều kết nối) — nhưng cũng là dấu hiệu trang đang bung quá nhiều câu.
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
      results.push({ page: `${c.page} — LỖI: ${warmupError.message.slice(0, 160)}`, coldMs: -1, warmMs: -1, p50Ms: -1, p95Ms: -1, queries: 0, dbMs: 0, rows: 0, payloadKb: 0, slowest: [] });
      continue;
    }

    const coldTimes: number[] = [];
    let stats = { queries: 0, dbMs: 0, rows: 0, slowest: [] as Result["slowest"] };
    let payloadKb = 0;
    for (let r = 0; r < rounds; r += 1) {
      clearMemo();
      const measured = await probe(c.page, c.run);
      coldTimes.push(measured.stats.ms);
      if (r === 0) {
        stats = { queries: measured.stats.queries, dbMs: measured.stats.dbMs, rows: measured.stats.rows, slowest: measured.stats.slowest };
        payloadKb = Math.round((JSON.stringify(measured.value)?.length ?? 0) / 102.4) / 10;
      }
    }
    // Lượt ẤM: không xoá đệm → đo đúng chi phí khi memo trúng
    const warm = await probe(c.page, c.run);

    results.push({
      page: c.page,
      coldMs: Math.round(quantile(coldTimes, 0.5) * 10) / 10,
      warmMs: Math.round(warm.stats.ms * 10) / 10,
      p50Ms: Math.round(quantile(coldTimes, 0.5) * 10) / 10,
      p95Ms: Math.round(quantile(coldTimes, 0.95) * 10) / 10,
      queries: stats.queries,
      dbMs: stats.dbMs,
      rows: stats.rows,
      payloadKb,
      slowest: stats.slowest,
    });
  }

  const report = {
    label: label || (outPath ? path.basename(outPath, ".json") : "bench"),
    scale,
    rounds,
    seedMs,
    node: process.version,
    engine: "PGlite (Postgres 16 → WASM, một luồng)",
    measuredAt: new Date().toISOString(),
    rows: seeded,
    results: results.sort((a, b) => b.coldMs - a.coldMs),
  };

  const json = JSON.stringify(report, null, 2);
  if (outPath) {
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, json + "\n", "utf8");
    console.log(`Đã ghi ${outPath}`);
  }
  console.log(json);
  rmSync(dataDir, { recursive: true, force: true });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(1);
  });

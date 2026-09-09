/**
 * ĐO TỪNG TRUY VẤN CỦA TRANG CHẬM, TRÊN DỮ LIỆU THẬT.
 *
 * Smoke test nói được TRANG nào chậm, không nói được HÀM nào chậm. Đo bằng PGlite tại máy cũng
 * không thay được: dữ liệu khác, kế hoạch truy vấn khác. Script này chạy TRONG container
 * production, chỉ ĐỌC, và in thời gian từng hàm mà Server Component của trang đó gọi.
 *
 * Chạy: docker exec erp-app npx tsx --tsconfig tsconfig.json scripts/perf-probe.ts
 */
import "dotenv/config";
import { resolvePeriod } from "@/lib/search-params";
import { clearMemo } from "@/lib/cache";

const results: { page: string; fn: string; ms: number; note: string }[] = [];

/**
 * XOÁ ĐỆM TRƯỚC MỖI PHÉP ĐO.
 *
 * Lượt đo đầu tiên đã lấp đệm cho các lượt sau: `getControlTower` từng ra 0ms chỉ vì trang chủ vừa
 * gọi nó xong. Không xoá thì bảng xếp hạng nói dối, và ta đi sửa nhầm hàm.
 */
async function timed(page: string, fn: string, run: () => Promise<unknown>) {
  clearMemo();
  const t0 = Date.now();
  try {
    const out = await run();
    const ms = Date.now() - t0;
    const size = out === undefined ? 0 : JSON.stringify(out).length;
    results.push({ page, fn, ms, note: `${Math.round(size / 1024)}kB` });
  } catch (error) {
    results.push({ page, fn, ms: Date.now() - t0, note: `LỖI: ${error instanceof Error ? error.message : String(error)}` });
  }
}

async function main() {
  // Đúng kỳ mặc định của từng trang: đó là thứ người dùng thật mở ra.
  const month = resolvePeriod({ period: "30d" }, "30d");
  const all = resolvePeriod({ period: "all" }, "all");

  // Đo TRUNG TÂM ĐIỀU KHIỂN TRƯỚC trang chủ: trang chủ gọi nó bên trong, nên đo sau là đo đệm.
  const tower = await import("@/lib/queries/control-tower");
  await timed("/ (thành phần)", "getControlTower", () => tower.getControlTower());

  // Bóc từng thành phần trang chủ: biết "trang chủ chậm" chưa sửa được gì, phải biết HÀM nào.
  const fin = await import("@/lib/queries/financial-truth");
  await timed("/ (thành phần)", "getFinancialTruth", () => fin.getFinancialTruth(month));
  const codq = await import("@/lib/queries/cod");
  await timed("/ (thành phần)", "codCashSummary", () => codq.codCashSummary(month));
  const eng = await import("@/lib/queries/cost-engine");
  await timed("/ (thành phần)", "getOperatingCost", () => eng.getOperatingCost(month));

  const cod = await import("@/lib/queries/cod-settlement");
  await timed("/cod", "codSettlementSummary", () => cod.codSettlementSummary(month));
  await timed("/cod", "codSettlementCounts", () => cod.codSettlementCounts(month));
  await timed("/cod", "listCodSettlement", () => cod.listCodSettlement({ period: month, status: "ALL", q: "", page: 1, pageSize: 50 }));
  await timed("/cod", "listStatementPayments", () => cod.listStatementPayments(40));
  await timed("/cod", "statementGapDays", () => cod.statementGapDays());
  await timed("/cod", "missingStatementPeriods", () => cod.missingStatementPeriods());

  const rr = await import("@/lib/queries/return-rate");
  await timed("/reports/returns", "getReturnRateSummary", () => rr.getReturnRateSummary(month, ""));
  await timed("/reports/returns", "getReturnRateByVariant", () =>
    rr.getReturnRateByVariant({ period: month, q: "", minShipped: 0, sort: "returned", dir: "desc", page: 1, pageSize: 50 }),
  );

  const dash = await import("@/lib/queries/dashboard");
  await timed("/", "getDashboardData", () => dash.getDashboardData(month));
  // Trang NHANH để đối chiếu — nếu mọi thứ đều chậm thì vấn đề nằm ở chỗ khác.
  const ads = await import("@/lib/queries/ads-roas");
  // Kỳ MẶC ĐỊNH của trang (30 ngày) và kỳ TOÀN BỘ — chênh nhau bao nhiêu cho biết chi phí đi theo
  // lượng dữ liệu hay theo số câu truy vấn.
  await timed("/ads", "adsRoas 30 ngày", () => ads.getAdsRoas(month, "campaign"));
  await timed("/ads", "adsRoas toàn kỳ", () => ads.getAdsRoas(all, "campaign"));

  results.sort((a, b) => b.ms - a.ms);
  console.log("\n── THỜI GIAN TỪNG TRUY VẤN (chậm nhất trước) ──");
  for (const r of results) console.log(`${String(r.ms).padStart(7)}ms  ${r.page.padEnd(18)} ${r.fn.padEnd(26)} ${r.note}`);
  const total = results.reduce((t, r) => t + r.ms, 0);
  console.log(`\nTổng ${total}ms cho ${results.length} truy vấn.`);
  process.exit(0);
}

main().catch((error) => {
  console.error("perf-probe lỗi:", error instanceof Error ? error.message : error);
  process.exit(1);
});

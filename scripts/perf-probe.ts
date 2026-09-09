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

const results: { page: string; fn: string; ms: number; note: string }[] = [];

async function timed(page: string, fn: string, run: () => Promise<unknown>) {
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
  const tower = await import("@/lib/queries/control-tower");
  await timed("/", "getControlTower", () => tower.getControlTower());

  // Trang NHANH để đối chiếu — nếu mọi thứ đều chậm thì vấn đề nằm ở chỗ khác.
  const ads = await import("@/lib/queries/ads-roas");
  await timed("/ads (đối chiếu)", "adsRoas", () => ads.getAdsRoas(all, "campaign"));

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

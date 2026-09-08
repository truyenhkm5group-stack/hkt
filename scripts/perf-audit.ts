/**
 * ĐO TRƯỚC, SỬA SAU.
 *
 * In thời gian chạy của các truy vấn nặng nhất để biết chỗ nào thật sự chậm, thay vì tối ưu theo
 * cảm tính. Chạy được trên CSDL tạm (PGlite) lẫn production chỉ-đọc.
 *
 * Dùng: npx tsx scripts/perf-audit.ts
 */
import { ensureMigrated } from "@/db/migrate";
import { clearMemo } from "@/lib/cache";
import type { Period } from "@/lib/search-params";

const ALL: Period = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

async function time<T>(label: string, run: () => Promise<T>): Promise<{ label: string; ms: number }> {
  const started = Date.now();
  await run();
  return { label, ms: Date.now() - started };
}

async function main() {
  await ensureMigrated();
  const { getDashboardData } = await import("@/lib/queries/dashboard");
  const { getReturnRateSummary, getReturnRateByVariant } = await import("@/lib/queries/return-rate");
  const { getControlTower } = await import("@/lib/queries/control-tower");
  const { getActionQueue } = await import("@/lib/queries/action-queue");
  const { getAdsRoas } = await import("@/lib/queries/ads-roas");
  const { getFinancialTruth } = await import("@/lib/queries/financial-truth");
  const { getProductIntelligence } = await import("@/lib/queries/product-intelligence");
  const { getIntegrationHealth } = await import("@/lib/queries/integration-health");
  const { scanReconciliation } = await import("@/lib/sync/consistency");
  const { getReplenishmentPlan } = await import("@/lib/queries/planning");

  const results: { label: string; ms: number }[] = [];
  const measure = async (label: string, run: () => Promise<unknown>) => {
    clearMemo();
    results.push(await time(label, run));
  };

  await measure("Tổng quan", () => getDashboardData(ALL));
  await measure("Tỷ lệ giao thành công (tổng hợp)", () => getReturnRateSummary(ALL, ""));
  await measure("Tỷ lệ giao thành công (theo mẫu mã)", () => getReturnRateByVariant({ period: ALL, q: "", minShipped: 0, sort: "returned", dir: "desc", page: 1, pageSize: 50 }));
  await measure("Trung tâm điều khiển", () => getControlTower());
  await measure("Quét đối soát", () => scanReconciliation());
  await measure("Hàng đợi việc", () => getActionQueue({ limit: 200 }));
  await measure("Chân lý tài chính", () => getFinancialTruth(ALL));
  await measure("Hiệu quả mẫu mã", () => getProductIntelligence({ period: ALL, limit: 50 }));
  await measure("ROAS quảng cáo", () => getAdsRoas(ALL));
  await measure("Sức khoẻ tích hợp", () => getIntegrationHealth());
  await measure("Kế hoạch sản xuất", () => getReplenishmentPlan());

  results.sort((a, b) => b.ms - a.ms);
  const total = results.reduce((t, r) => t + r.ms, 0);
  console.log(JSON.stringify({ tong_ms: total, cham_nhat: results }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

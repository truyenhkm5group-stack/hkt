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
import { resolvePeriod, type Period } from "@/lib/search-params";

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
  const { getMarketingDaily } = await import("@/lib/queries/marketing-daily");
  const { getNominalProfitReport } = await import("@/lib/queries/profit-nominal");
  const { getMarketerDailyNominal } = await import("@/lib/queries/marketer-daily-nominal");
  const D30 = resolvePeriod({}, "30d");

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
  /*
    /ads/daily TÁCH BA PHẦN (23/09/2026: trang từ 1,3–11s lên 17s sau khi bóc tách MKTer chuyển
    sang số của Báo cáo lợi nhuận). Phần thứ ba đo khi LN danh nghĩa ĐÃ nằm trong đệm, để tách
    chi phí của riêng phép chia ngày × MKTer khỏi chi phí của báo cáo nó đọc.
  */
  await measure("/ads/daily · bảng theo ngày (30 ngày)", () => getMarketingDaily(D30, "created", {}, null));
  await measure("/ads/daily · LN danh nghĩa theo mã (30 ngày)", () => getNominalProfitReport(D30, "ORDERED"));
  await measure("/ads/daily · bóc tách MKTer (30 ngày, nguội)", () => getMarketerDailyNominal(D30));
  clearMemo();
  await getNominalProfitReport(D30, "ORDERED");
  results.push(await time("/ads/daily · bóc tách MKTer (30 ngày, LN danh nghĩa đã trong đệm)", () => getMarketerDailyNominal(D30)));

  /*
    ═══════════ /ads: THỜI GIAN VÀ DUNG LƯỢNG TỪNG KHỐI ═══════════

    Smoke 23/09/2026: `/ads` 18,4 s · 6.768 kB — đầu phản hồi 221 ms, thân 18,1 s. Đầu phản hồi
    nhanh mà thân chậm nghĩa là trang ĐANG STREAM các ranh giới `Suspense`; và 6,7 MB thì không thể
    là tiền của câu SQL — nó là dữ liệu được đẩy xuống trình duyệt. Nên đo CẢ HAI cho từng khối: bao
    lâu, và kết quả nặng bao nhiêu byte khi tuần tự hoá.

    Byte ở đây là `JSON.stringify` của kết quả truy vấn — xấp xỉ phần mà khối ấy đẩy xuống client
    (một client component nhận nguyên mảng dòng thì mảng ấy vào cả payload RSC lẫn HTML dựng sẵn).
    Đủ để biết khối nào nặng, không đủ để cộng lại ra đúng 6.768 kB.

    Kỳ là THÁNG, đúng mặc định của trang (`resolvePeriod(raw, "month")`), không phải toàn bộ.
  */
  const { getAdsDecision } = await import("@/lib/queries/ads-decision");
  const { getAdsAttributionAudit } = await import("@/lib/queries/ads-attribution");
  const { getAdsPerformance } = await import("@/lib/queries/ads-performance");
  const THANG = resolvePeriod({}, "month");
  const kichThuoc: { label: string; ms: number; kb: number; dong: number | null }[] = [];
  const doKhoi = async (label: string, run: () => Promise<unknown>) => {
    clearMemo();
    const started = Date.now();
    const kq = await run();
    const ms = Date.now() - started;
    const kb = Math.round(Buffer.byteLength(JSON.stringify(kq) ?? "", "utf8") / 1024);
    const rows = (kq as { rows?: unknown[] } | null)?.rows;
    kichThuoc.push({ label, ms, kb, dong: Array.isArray(rows) ? rows.length : null });
    results.push({ label, ms });
  };
  await doKhoi("/ads · bảng quyết định (chiến dịch)", () => getAdsDecision(THANG, "campaign"));
  await doKhoi("/ads · bảng quyết định (mã hàng)", () => getAdsDecision(THANG, "product"));
  await doKhoi("/ads · ROAS theo kết quả đơn", () => getAdsRoas(THANG, "campaign"));
  await doKhoi("/ads · độ phủ quy kết", () => getAdsAttributionAudit(THANG));
  await doKhoi("/ads · hiệu quả theo marketer (khối cuối trang)", () => getAdsPerformance(THANG));

  results.sort((a, b) => b.ms - a.ms);
  const total = results.reduce((t, r) => t + r.ms, 0);
  kichThuoc.sort((a, b) => b.kb - a.kb);
  console.log(JSON.stringify({ tong_ms: total, cham_nhat: results, ads_theo_khoi: kichThuoc }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

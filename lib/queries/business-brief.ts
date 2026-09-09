import { getDashboardData } from "@/lib/queries/dashboard";
import { getDashboardActionQueue } from "@/lib/queries/dashboard-queue";
import { detectAdsAnomalies } from "@/lib/queries/ads-anomaly";
import { getPurchasingReport } from "@/lib/queries/purchasing";
import { getSlowMoving } from "@/lib/queries/slow-moving";
import { adSpendByProduct, getProductIntelligence } from "@/lib/queries/product-intelligence";
import { classifyProduct } from "@/lib/constants/product-verdict";
import { RECOMMENDATION_CONFIDENCE, type Recommendation } from "@/lib/constants/recommendation";
import type { Period } from "@/lib/search-params";

/**
 * ───────────── BẢN TÓM TẮT KINH DOANH ─────────────
 *
 * MỌI CON SỐ Ở ĐÂY ĐƯỢC TÍNH BẰNG SQL, KHÔNG BẰNG MÔ HÌNH NGÔN NGỮ.
 *
 * Đây là ranh giới quan trọng nhất của cả lớp trợ lý: nếu để một mô hình đọc dữ liệu thô rồi tự
 * cộng trừ, thì mỗi lần chạy sẽ ra một con số hơi khác, và không ai truy được con số đó từ đâu ra.
 * Ở đây dữ liệu là DETERMINISTIC — cùng đầu vào luôn cho cùng đầu ra — và mô hình (nếu sau này có)
 * chỉ được phép DIỄN ĐẠT LẠI những gì đã tính sẵn.
 *
 * Toàn bộ số liệu dùng lại các truy vấn đã có (bảng điều khiển, hàng đợi việc, quảng cáo, tồn kho,
 * phân loại mẫu mã). KHÔNG có công thức mới nào trong file này.
 */

export type BriefMetric = {
  key: string;
  label: string;
  value: number;
  /** Đơn vị để giao diện biết cách hiển thị. */
  unit: "vnd" | "count" | "percent";
  /** Thay đổi so với kỳ liền trước (%); `null` khi không có kỳ trước để so. */
  changePct: number | null;
  note: string;
};

export type BusinessBrief = {
  period: Period;
  metrics: BriefMetric[];
  /** Việc cần làm, đã xếp theo cùng công thức ưu tiên của toàn ERP. */
  topActions: { title: string; why: string; amount: number; ageLabel: string; overdue: boolean; href: string }[];
  risks: Recommendation[];
  /** Câu tóm tắt bằng tiếng Việt, sinh theo quy tắc — không phải văn mô hình. */
  summary: string[];
  generatedAt: Date;
};

function pctChange(now: number, before: number | undefined | null): number | null {
  if (before === undefined || before === null || before === 0) return null;
  return ((now - before) / before) * 100;
}

const vnd = (v: number) => `${Math.round(v).toLocaleString("vi-VN")}đ`;

export async function getBusinessBrief(period: Period): Promise<BusinessBrief> {
  const [dash, queue, adsAnomalies, slow, products, adSpend, muaHang] = await Promise.all([
    getDashboardData(period),
    getDashboardActionQueue(),
    detectAdsAnomalies().catch(() => []),
    getSlowMoving().catch(() => null),
    getProductIntelligence({ period, limit: 100 }).catch(() => []),
    adSpendByProduct(period).catch(() => new Map<string, number>()),
    // Chạy song song với phần còn lại và có nhớ tạm riêng, nên không kéo dài thời gian dựng trang.
    getPurchasingReport().catch(() => null),
  ]);

  const metrics: BriefMetric[] = [
    {
      key: "booked",
      label: "Doanh thu lên đơn",
      value: dash.money.booked,
      unit: "vnd",
      changePct: pctChange(dash.kpi.revenue, dash.previous?.revenue),
      note: `${dash.kpi.orders} đơn đã xác nhận`,
    },
    {
      key: "delivered",
      label: "Doanh thu giao thành công",
      value: dash.money.delivered,
      unit: "vnd",
      changePct: pctChange(dash.kpi.successRevenue, dash.previous?.successRevenue),
      note: `${dash.kpi.successOrders} đơn tới tay khách`,
    },
    { key: "cash", label: "Tiền thực nhận", value: dash.money.cashReceived, unit: "vnd", changePct: null, note: "Đã vào tài khoản theo bảng kê" },
    { key: "codOutstanding", label: "Viettel Post còn giữ", value: dash.money.codOutstanding, unit: "vnd", changePct: null, note: `${dash.money.codOutstandingCount} đơn chưa thấy tiền` },
    { key: "contribution", label: "Lợi nhuận góp", value: dash.money.contribution, unit: "vnd", changePct: null, note: "Đã trừ giá vốn, cước, phí hoàn, quảng cáo" },
    { key: "adSpend", label: "Chi quảng cáo", value: dash.finance.adSpend, unit: "vnd", changePct: null, note: "Trong kỳ, đã bỏ chiến dịch loại trừ" },
  ];

  const topActions = queue.cases
    .filter((c) => c.status === "OPEN" || c.status === "ACKNOWLEDGED")
    .slice(0, 5)
    .map((c) => ({ title: c.title, why: c.scoreExplanation, amount: c.financialImpact, ageLabel: c.ageLabel, overdue: Boolean(c.sla?.breached), href: c.href }));

  const risks: Recommendation[] = [];

  // ── Rủi ro quảng cáo ──
  for (const a of adsAnomalies.slice(0, 5)) {
    risks.push({
      area: "ADS",
      title: `${a.campaignName}: ${a.detail}`,
      metric: a.profitability ? "Lợi nhuận góp / ROAS giao thành công" : "Chi tiêu so với doanh thu giao thành công",
      evidence: `Chi tiêu Meta đã đồng bộ + kết quả đơn theo ORDER_OUTCOME, 7 ngày gần nhất so với 7 ngày liền trước`,
      timeRange: "7 ngày gần nhất",
      amount: a.amount,
      reason: a.detail,
      confidence: RECOMMENDATION_CONFIDENCE.HIGH,
      href: "/ads",
    });
  }

  // ── Rủi ro mẫu mã ──
  const judged = products
    .map((row) => ({
      row,
      verdict: classifyProduct({
        deliveredQty: row.deliveredQty,
        successRate: row.successRate,
        returnRate: row.returnRate,
        deliveredRevenue: row.deliveredRevenue,
        contribution: row.contribution,
        adSpend: row.productId ? (adSpend.get(row.productId) ?? null) : null,
        daysOfCover: row.daysOfCover,
        available: row.available,
      }),
    }))
    .filter((j) => j.verdict.verdict === "LOSER" || j.verdict.verdict === "RISK");
  for (const j of judged.slice(0, 5)) {
    risks.push({
      area: "PRODUCT",
      title: `${j.row.productName}${j.row.color || j.row.size ? ` (${[j.row.color, j.row.size].filter(Boolean).join("/")})` : ""}`,
      metric: "Sáu chiều phân loại mẫu mã",
      evidence: j.verdict.checks.map((c) => `${c.label}: ${c.detail}`).join(" · "),
      timeRange: period.label,
      amount: j.row.lostRevenue,
      reason: j.verdict.reason,
      // Thiếu chiều nào thì độ tin cậy thấp hơn — nói ra thay vì giấu.
      confidence: j.verdict.checks.some((c) => c.passed === null) ? RECOMMENDATION_CONFIDENCE.MEDIUM : RECOMMENDATION_CONFIDENCE.HIGH,
      href: "/products/performance",
    });
  }

  // ── Rủi ro tồn kho ──
  if (slow) {
    for (const r of slow.rows.filter((x) => x.risk === "DEAD" || x.risk === "EXCESS").slice(0, 5)) {
      risks.push({
        area: "INVENTORY",
        title: `${r.productName}${r.color || r.size ? ` (${[r.color, r.size].filter(Boolean).join("/")})` : ""}`,
        metric: "Vốn tồn theo giá nhập và số ngày còn đủ bán",
        evidence: `Còn ${r.available} món · bán ${r.velocity}/ngày · vốn ${vnd(r.stockValue)}`,
        timeRange: "Tồn hiện tại",
        amount: r.excessValue,
        reason: r.reason,
        confidence: RECOMMENDATION_CONFIDENCE.HIGH,
        href: "/inventory/planning",
      });
    }
  }

  // ── Rủi ro mua hàng: tiền đã hứa với xưởng đang treo, và giá vốn sắp đổi ──
  // CỐ Ý chỉ đưa hai loại này vào bản tóm tắt: cả hai đều gấp và làm được ngay. Chỉ số giữ chân
  // khách thì đúng nhưng nhúc nhích theo tháng — để trong bản tóm tắt hằng ngày là nhiễu.
  if (muaHang) {
    if (muaHang.open.overdueCount > 0) {
      risks.push({
        area: "PURCHASING",
        title: `${muaHang.open.overdueCount} lô đã gửi xưởng quá hạn hẹn`,
        metric: "Tiền cam kết với xưởng và hạn hẹn trên đơn sản xuất",
        evidence: `${vnd(muaHang.open.overdueCommitted)} nằm ở lô quá hạn · trễ nhiều nhất ${muaHang.open.maxLateDays ?? 0} ngày · tổng đang cam kết ${vnd(muaHang.open.committed)}`,
        timeRange: "Toàn bộ lô chưa nhận",
        amount: muaHang.open.overdueCommitted,
        reason: "Hàng chưa về thì tiền đã hứa vẫn phải trả, còn kế hoạch bán theo mẫu đó thì trượt. Gọi xưởng chốt lại ngày giao.",
        confidence: RECOMMENDATION_CONFIDENCE.HIGH,
        href: "/inventory/purchasing",
      });
    }
    const tangGia = muaHang.priceJumps[0];
    if (tangGia) {
      risks.push({
        area: "PURCHASING",
        title: `Giá nhập ${tangGia.productName || tangGia.sku} tăng ${tangGia.changePercent}%`,
        metric: "Giá nhập lần gần nhất so với chính lần nhập trước của cùng mẫu mã",
        evidence: `${vnd(tangGia.previousCost)} → ${vnd(tangGia.latestCost)} · ${tangGia.supplier}${muaHang.priceJumps.length > 1 ? ` · còn ${muaHang.priceJumps.length - 1} mẫu khác cũng tăng` : ""}`,
        timeRange: `${muaHang.windowDays} ngày gần nhất`,
        amount: Math.max(0, tangGia.latestCost - tangGia.previousCost),
        reason: "Giá vốn tăng mà giá bán giữ nguyên thì lãi gộp mỏng đi ở mọi đơn của mẫu này — xem lại giá bán hoặc đổi xưởng.",
        confidence: RECOMMENDATION_CONFIDENCE.HIGH,
        href: "/inventory/purchasing",
      });
    }
  }

  // ── Rủi ro số liệu: đứng đầu danh sách vì nó làm mọi con số phía trên đáng ngờ ──
  if (dash.dataIssues.critical > 0) {
    risks.unshift({
      area: "DATA",
      title: `${dash.dataIssues.critical} bản ghi sai nghiêm trọng`,
      metric: "Luật chất lượng dữ liệu",
      evidence: `${dash.dataIssues.firing}/${dash.dataIssues.ruleCount} luật đối soát đang có vi phạm`,
      timeRange: "Hiện tại",
      amount: 0,
      reason: "Còn dữ liệu sai nghiêm trọng thì mọi con số trong bản tóm tắt này đều cần đọc dè dặt.",
      confidence: RECOMMENDATION_CONFIDENCE.HIGH,
      href: "/data-quality",
    });
  }

  risks.sort((a, b) => Number(b.area === "DATA") - Number(a.area === "DATA") || b.amount - a.amount);

  return { period, metrics, topActions, risks, summary: renderSummary(metrics, topActions, risks, queue.breached), generatedAt: new Date() };
}

/**
 * DIỄN ĐẠT BẰNG QUY TẮC, KHÔNG BẰNG MÔ HÌNH.
 *
 * Dự án chưa nối nhà cung cấp AI nào. Thay vì để trống chỗ này chờ có AI, sinh câu theo quy tắc:
 * kết quả ổn định, không tốn tiền gọi API, không gửi dữ liệu kinh doanh ra ngoài, và quan trọng
 * nhất là KHÔNG BAO GIỜ bịa ra một con số không có trong dữ liệu.
 *
 * Nếu sau này nối AI, nó chỉ được diễn đạt lại chính những câu này — không được tự tính lại.
 */
function renderSummary(metrics: BriefMetric[], actions: BusinessBrief["topActions"], risks: Recommendation[], overdue: number): string[] {
  const out: string[] = [];
  const get = (key: string) => metrics.find((m) => m.key === key);
  const booked = get("booked");
  const delivered = get("delivered");
  const contribution = get("contribution");

  if (booked && delivered) {
    const gap = booked.value > 0 ? ((booked.value - delivered.value) / booked.value) * 100 : 0;
    out.push(
      `Khách chốt ${vnd(booked.value)}, tới tay khách ${vnd(delivered.value)}` +
        (gap > 0 ? ` — chênh ${gap.toFixed(0)}% là phần chưa giao xong hoặc đã hoàn về.` : "."),
    );
  }
  if (delivered?.changePct !== null && delivered?.changePct !== undefined) {
    out.push(`Doanh thu giao thành công ${delivered.changePct >= 0 ? "tăng" : "giảm"} ${Math.abs(delivered.changePct).toFixed(0)}% so với kỳ trước.`);
  }
  if (contribution) {
    out.push(
      contribution.value >= 0
        ? `Lợi nhuận góp ${vnd(contribution.value)} sau khi trừ giá vốn, cước, phí hoàn và quảng cáo.`
        : `LỖ ${vnd(-contribution.value)} sau khi trừ giá vốn, cước, phí hoàn và quảng cáo — cần xem lại giá bán hoặc chi quảng cáo.`,
    );
  }
  if (actions.length) {
    out.push(`Việc gấp nhất: ${actions[0].title}${actions[0].amount > 0 ? ` (${vnd(actions[0].amount)} đang treo)` : ""}.`);
  }
  if (overdue > 0) out.push(`${overdue} việc đã quá hạn xử lý.`);
  const treoXuong = risks.find((r) => r.area === "PURCHASING" && r.amount > 0);
  if (treoXuong) out.push(`${treoXuong.title} — ${vnd(treoXuong.amount)} liên quan.`);
  if (risks.length) out.push(`${risks.length} rủi ro đang theo dõi, đứng đầu là: ${risks[0].title}.`);
  if (!out.length) out.push("Chưa đủ dữ liệu trong kỳ này để tóm tắt.");
  return out;
}

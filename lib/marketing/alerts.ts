import { MARKETING_ALERT_MAX_PER_RUN, MARKETING_DIAGNOSIS, findingDedupeKey } from "@/lib/constants/marketing-diagnosis";
import { MARKETING_NOTIFICATION_KIND } from "@/lib/constants/marketing-alerts";
import { baselineOf, diagnose, lossStreakOf, sortFindings, type DiagnoseSnapshot, type MarketingFinding } from "@/lib/marketing/diagnose";
import { getMarketingDaily, type MarketingDailyBase } from "@/lib/queries/marketing-daily";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ CẢNH BÁO MARKETING VÀO HÀNG ĐỢI VIỆC CỦA ERP ═══════════
 *
 * Tệp này KHÔNG gửi gì đi. Nó chỉ dựng ứng viên cho `lib/alerts/rules.ts`, nơi đã có sẵn toàn bộ
 * máy móc mà một cảnh báo tử tế cần: chống trùng theo `dedupeKey`, TỰ ĐÓNG khi điều kiện không còn
 * (`resolution = 'AUTO'`, khác hẳn "có người xử lý"), gán người, và gửi đi một lần.
 *
 * Dựng một đường gửi riêng ở đây sẽ là đường thứ hai — và đường thứ hai là đường không có chống
 * trùng, không có tự đóng, không ai thấy trong hàng đợi.
 *
 * ─── HAI CỬA SỔ, VÀ CHÚNG TRẢ LỜI HAI CÂU KHÁC NHAU ───
 *
 *   · HÔM NAY (đang chạy)  — chỉ xét những thứ KHÔNG cần đợi hàng giao xong: tiêu tiền mà không ra
 *     đơn, nguồn dữ liệu chết. Đây là tiền đang chảy ngay lúc này; đợi tới sáng mai là mất trọn
 *     một ngày ngân sách.
 *   · HÔM QUA (đã đóng)    — mọi thứ còn lại. Một ngày chưa đóng luôn trông như đang lỗ, vì tiền
 *     quảng cáo tiêu hết từ sáng còn hàng thì chưa tới tay ai.
 *
 * Gộp hai cửa sổ là lý do khiến phần lớn hệ thống cảnh báo bị tắt sau một tuần.
 */

function vnDay(at: Date): string {
  return new Date(at.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function period(fromDay: string, toDay: string): Period {
  return { key: "custom", from: new Date(`${fromDay}T00:00:00+07:00`), to: new Date(`${toDay}T23:59:59.999+07:00`), label: `${fromDay}→${toDay}`, fromKey: fromDay, toKey: toDay };
}

function toSnapshot(b: MarketingDailyBase): DiagnoseSnapshot {
  return {
    adSpend: b.adSpend,
    messages: b.messages,
    orders: b.orders,
    posRevenue: b.posRevenue,
    deliveredRevenue: b.deliveredRevenue,
    deliveredOrders: b.deliveredOrders,
    returnedOrders: b.returnedOrders,
    finishedOrders: b.finishedOrders,
    pendingOrders: b.pendingOrders,
    contributionProfit: b.contributionProfit,
  };
}

export type MarketingAlertCandidate = {
  kind: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  href: string;
  entityType: string;
  entityId: string;
  dedupeKey: string;
  occurredAt?: Date | null;
};

const SEVERITY_MAP = { CRITICAL: "critical", WARNING: "warning", INFO: "info" } as const;

function toCandidate(f: MarketingFinding): MarketingAlertCandidate {
  const href = `/ads/daily?period=custom&from=${f.day}&to=${f.day}${f.scope.startsWith("marketer:") ? `&marketer=${encodeURIComponent(f.scope.slice("marketer:".length))}` : ""}`;
  return {
    kind: MARKETING_NOTIFICATION_KIND,
    severity: SEVERITY_MAP[f.severity],
    title: `${f.title} · ${f.scopeLabel} · ${f.day}`,
    // Bằng chứng TRƯỚC, việc phải làm SAU. Một cảnh báo không kèm số của chính nó thì người nhận
    // phải tự đi tra, và phần lớn sẽ không tra.
    body: [...f.evidence, "", "Nên làm:", ...f.actions.map((a) => `· ${a}`)].join("\n"),
    href,
    entityType: "MARKETING_DAY",
    entityId: `${f.day}${f.scope ? `|${f.scope}` : ""}`,
    dedupeKey: findingDedupeKey(f.kind, f.scope, f.day),
    occurredAt: new Date(`${f.day}T12:00:00+07:00`),
  };
}

/** Những loại được phép kêu khi NGÀY CHƯA ĐÓNG — vì chúng không nói gì về kết quả giao hàng. */
const HOT_KINDS = new Set(["SPEND_NO_ORDERS", "DATA_STALE"]);

export async function detectMarketingDailyAlerts(now: Date = new Date()): Promise<MarketingAlertCandidate[]> {
  const today = vnDay(now);
  const yesterday = shiftDay(today, -1);
  const baseFrom = shiftDay(yesterday, -MARKETING_DIAGNOSIS.baselineDays);
  const baseTo = shiftDay(yesterday, -1);

  const [todayData, yesterdayData, baselineData] = await Promise.all([
    getMarketingDaily(period(today, today), "created"),
    getMarketingDaily(period(yesterday, yesterday), "created"),
    getMarketingDaily(period(baseFrom, baseTo), "created"),
  ]);

  const baseline = baselineOf(baselineData.rows.map(toSnapshot), 3);
  const staleSources = todayData.freshness.filter((f) => f.stale).map((f) => f.label);

  const hot = diagnose({ day: today, current: toSnapshot(todayData.totals), baseline: null, staleSources }).filter((f) => HOT_KINDS.has(f.kind));

  const settled = diagnose({
    day: yesterday,
    current: toSnapshot(yesterdayData.totals),
    baseline,
    // Chuỗi lỗ đọc trên cả nền lẫn ngày hôm qua, và `lossStreakOf` tự bỏ qua ngày chưa ngã ngũ.
    lossStreak: lossStreakOf([...baselineData.rows, ...yesterdayData.rows]),
  }).filter((f) => !HOT_KINDS.has(f.kind));

  /*
    TRẦN SỐ CẢNH BÁO MỖI LƯỢT.

    Không phải để giấu việc: mọi phát hiện đều tính được lại bất cứ lúc nào trên màn hình. Trần này
    chặn đúng một tình huống — nguồn dữ liệu hỏng làm mọi ngưỡng cùng vỡ một lúc và hàng đợi nhận
    vài chục việc trong một phút. Xếp nặng trước nên phần bị cắt luôn là phần nhẹ nhất.
  */
  return sortFindings([...hot, ...settled]).slice(0, MARKETING_ALERT_MAX_PER_RUN).map(toCandidate);
}

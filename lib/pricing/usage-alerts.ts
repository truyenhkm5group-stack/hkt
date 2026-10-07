/**
 * ═══════════ NGƯỠNG CẢNH BÁO KHÁCH AI 80 · 100 · 120 · 150 — GỬI THẬT, MỘT LẦN MỖI NGƯỠNG MỖI KỲ — CHỈ MÁY CHỦ ═══════════
 *
 * Kiểm toán 07/10/2026: `usageAlert` tính đúng cờ `notifyCustomer` / `notifyOperator` nhưng KHÔNG nơi nào đọc chúng ⇒ không ai
 * nhận gì. Bước này chạy trong job `sales-health` SẴN CÓ (mỗi 5 phút, fan-out theo tổ chức có module AI bán hàng — không thêm lịch
 * mới) cho tổ chức NGỮ CẢNH:
 *  · ngưỡng = của PHIÊN BẢN giá của tổ chức (`alert_thresholds`, V1 = 80 · 100 · 120 · 150) — không gõ số ở đây;
 *  · chỉ báo ngưỡng CAO NHẤT đã chạm (`highestUsageThreshold`); khoá chống trùng `pricing:ai-customers:<kỳ>:<ngưỡng>` NEO THEO KỲ
 *    (tháng VN của CHÍNH mốc đo — cùng mốc với kỳ đếm), không theo khung giờ ⇒ lượt kiểm sát ranh giới giờ / chạy chồng không gửi
 *    lần hai, sang tháng mới đếm lại từ đầu;
 *  · KHÁCH = một dòng `notifications` (chuông trong ERP) — chỉ số đếm theo đơn vị khách hiểu, KHÔNG token / USD / model;
 *  · NGƯỜI VẬN HÀNH = kênh vận hành nhà (`notifyPlatformOperator` — mã tổ chức + số đếm, không dữ liệu khách), sổ riêng
 *    `OPERATOR_STATE_KEY`: gửi hỏng ⇒ lượt sau thử lại; đã gửi được ⇒ đúng một tin mỗi ngưỡng mỗi kỳ.
 * Số dùng chưa biết ⇒ không báo gì (không kết luận từ «—»). Lỗi không làm hỏng job giám sát.
 */
import { getDb, schema } from "@/db";
import { currentOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { readAiCustomerUsage } from "@/lib/pricing/ai-customer";
import { AI_STOP_MESSAGE, highestUsageThreshold, usageAlertDedupeKey, type UsageThresholdKey } from "@/lib/pricing/ai-entitlement";
import { resolveOrgPricing } from "@/lib/pricing/entitlements";
import { usagePeriodOf } from "@/lib/pricing/meter";
import { orgPriceVersion } from "@/lib/pricing/price-book";
import { DEFAULT_USAGE_ALERTS, meterMonthOf } from "@/lib/pricing/versions";
import { notifyPlatformOperator, type OperatorNotifyResult } from "@/lib/sales-chatbot/alerts";
import { getSettingJson, setSettingJson } from "@/lib/settings";

/** `sent` = dòng chuông của KHÁCH vừa ghi mới · `operator` = tin người vận hành lượt này (`ALREADY` = đã gửi được trong kỳ). */
export type UsageAlertRun = { sent: UsageThresholdKey | null; operator: OperatorNotifyResult | "ALREADY" | null; skipped: string | null; used: number | null; included: number | null | undefined };
export type UsageAlertDeps = { notifyOperator?: (title: string, lines: string[]) => Promise<OperatorNotifyResult> };
/** Sổ tin người vận hành đã gửi được (cài đặt của CHÍNH tổ chức) — chỉ giữ khoá của kỳ đang đo. */
export const OPERATOR_STATE_KEY = "pricing.usageAlerts.operatorSent";

const fmt = (n: number) => n.toLocaleString("vi-VN");

/** Câu cho KHÁCH (chủ shop) của một ngưỡng — không token / USD / model. HÀM THUẦN. */
export function customerUsageAlertText(input: { key: UsageThresholdKey; used: number; included: number; pct: number; planName: string; periodLabel: string; trial: boolean; blockSize: number | null }): { title: string; body: string; severity: "info" | "warning" | "critical" } {
  const line = `${fmt(input.used)} / ${fmt(input.included)} khách AI (${Math.floor(input.pct)}%) của gói ${input.planName}, kỳ ${input.periodLabel}.`;
  const over = input.blockSize ? `phần vượt tính theo khối ${fmt(input.blockSize)} khách AI` : "phần vượt tính theo bảng giá của gói";
  if (input.key === "notify")
    return { title: "Sắp dùng hết khách AI của gói", body: `${line} ${input.trial ? "Khi hết lượt, AI dùng thử tạm dừng trả lời khách — hộp thư vẫn hoạt động." : `Vượt 100% thì ${over}; AI vẫn chạy.`}`, severity: "info" };
  if (input.key === "limit")
    return input.trial
      ? { title: AI_STOP_MESSAGE.TRIAL_QUOTA_EXHAUSTED, body: `${line} AI tạm dừng tự trả lời; hộp thư và trả lời tay vẫn hoạt động. Chọn gói để AI trả lời lại.`, severity: "critical" }
      : { title: "Đã dùng hết khách AI gồm trong gói", body: `${line} Từ giờ ${over}; AI vẫn chạy bình thường.`, severity: "warning" };
  if (input.key === "strong") return { title: "Khách AI vượt nhiều so với gói — nên nâng gói", body: `${line} Nâng gói thường rẻ hơn trả phần vượt.`, severity: "warning" };
  return { title: "Khách AI vượt xa gói — đội vận hành sẽ liên hệ", body: `${line} Đội vận hành sẽ rà soát cùng bạn để chọn gói phù hợp.`, severity: "warning" };
}

/** Một lượt kiểm ngưỡng cho tổ chức NGỮ CẢNH lúc `now`. Không ném. */
export async function runAiCustomerUsageAlerts(now: Date = new Date(), deps: UsageAlertDeps = {}): Promise<UsageAlertRun> {
  try {
    const ctxOrg = await currentOrganization();
    const org = await findOrganization(ctxOrg.code);
    if (!org) return { sent: null, operator: null, skipped: "không có tổ chức", used: null, included: undefined };
    const pricing = await resolveOrgPricing(org);
    const price = pricing.plan?.planPrice ?? null;
    if (!price) return { sent: null, operator: null, skipped: "gói không có dòng giá theo phiên bản", used: null, included: undefined };
    const included = price.included.aiCustomers;
    const period = usagePeriodOf(now);
    const [version, usage] = await Promise.all([orgPriceVersion(org.code, now), readAiCustomerUsage([org.code], period, now)]);
    const used = usage.get(org.code)?.value ?? null;
    const hit = highestUsageThreshold(used, included, version.version?.alerts ?? DEFAULT_USAGE_ALERTS);
    if (!hit || used === null || typeof included !== "number") return { sent: null, operator: null, skipped: used === null ? "chưa đo được khách AI" : "chưa chạm ngưỡng", used, included };
    const dedupe = usageAlertDedupeKey(org.code, meterMonthOf(now), hit.key);
    const trial = price.trialDays !== null;
    const text = customerUsageAlertText({ key: hit.key, used, included, pct: hit.pct, planName: pricing.plan?.name ?? price.name, periodLabel: period.label, trial, blockSize: price.overage.aiCustomerBlockSize });
    const db = await getDb();
    const inserted = await db
      .insert(schema.notifications)
      .values({ kind: "SYSTEM", severity: text.severity, title: text.title, body: text.body, href: "/settings/plan", entityType: "PLAN_USAGE", entityId: `ai-customers:${hit.key}`, dedupeKey: dedupe, occurredAt: now })
      .onConflictDoNothing({ target: schema.notifications.dedupeKey })
      .returning({ id: schema.notifications.id });
    const customerNew = inserted.length > 0;
    // Tin NGƯỜI VẬN HÀNH có sổ riêng (cài đặt của tổ chức, chỉ giữ khoá của kỳ đang đo): gửi hỏng ⇒ KHÔNG ghi ⇒ lượt sau thử lại
    // (không mất cảnh báo); gửi được / nền tảng chưa khai kênh ⇒ ghi ⇒ không bao giờ gửi lần hai.
    const month = meterMonthOf(now);
    const state = await getSettingJson<{ sent?: unknown }>(OPERATOR_STATE_KEY, {});
    const sentKeys = Array.isArray(state.sent) ? state.sent.filter((k): k is string => typeof k === "string" && k.includes(`:${month}:`)) : [];
    let operator: UsageAlertRun["operator"] = "ALREADY";
    if (!sentKeys.includes(dedupe)) {
      operator = await (deps.notifyOperator ?? notifyPlatformOperator)(`Khách AI ${hit.thresholdPct}% hạn mức — tổ chức ${org.code}`, [
        `Gói ${pricing.plan?.key ?? price.planKey} (phiên bản ${price.versionKey})${trial ? " · DÙNG THỬ" : ""}`,
        `Khách AI kỳ ${period.label}: ${fmt(used)} / ${fmt(included)} (${Math.floor(hit.pct)}%) — ngưỡng ${hit.thresholdPct}%`,
        hit.key === "review" ? "Cần rà soát chi phí / rủi ro, đề xuất gói riêng." : hit.key === "strong" ? "Đề xuất nâng gói." : hit.key === "limit" ? (trial ? "AI dùng thử đã dừng tự trả lời." : "Bắt đầu tính phần vượt.") : "Cảnh báo sớm.",
      ]);
      if (operator !== "FAILED") await setSettingJson(OPERATOR_STATE_KEY, { sent: [...sentKeys, dedupe] });
    }
    if (!customerNew && operator === "ALREADY") return { sent: null, operator, skipped: "ngưỡng này đã báo trong kỳ", used, included };
    return { sent: customerNew ? hit.key : null, operator, skipped: null, used, included };
  } catch (e) {
    return { sent: null, operator: null, skipped: `lỗi: ${e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160)}`, used: null, included: undefined };
  }
}

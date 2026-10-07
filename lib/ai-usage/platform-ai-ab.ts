/**
 * ═══════════ A/B MODEL CỦA AI DÙNG CHUNG — CANARY vs ĐỐI CHỨNG (07/10/2026 · docs/platform/ai-model-control.md §7) ═══════════
 *
 * Model rẻ hơn chỉ được THẮNG khi KPI bán hàng không giảm đáng kể — token rẻ mà chốt ít đơn hơn là lỗ. Bảng này so hai
 * cohort của Platform AI Policy trên CÙNG thời kỳ:
 *
 *  · Cohort = hội thoại có lượt AI nguồn PLATFORM, tính năng `sales_chatbot`, mà lượt ĐẦU TIÊN của nó ≥ `cohortSince` (hội
 *    thoại mở trước khi bật canary không vào — chúng chưa từng được chia nhánh). Nhánh theo Ý ĐỊNH ĐIỀU TRỊ: có bất kỳ dòng
 *    sổ AI nào (OK hay ERROR) mang tên model canary ⇒ CANARY, kể cả lượt model dự phòng đỡ; còn lại ⇒ ĐỐI CHỨNG. Khung thử
 *    của chủ shop (`TEST`) không vào.
 *  · Tiền / token / lỗi: sổ `platform_ai_usage` (CSDL nhà). Hành vi bán hàng: sổ sự kiện `sales_conversation_events` + tin
 *    `sales_chat_messages` của CHÍNH tổ chức — ĐÚNG các định nghĩa đang dùng ở màn «Hiệu quả» (events-shared.ts), không có
 *    công thức thứ hai:
 *      SĐT = cột `customer_phone` / `state.customer.phone` có giá trị HOẶC `customer.identified`;
 *      địa chỉ = `customer.identified` (lưu khách bắt buộc SĐT + địa chỉ giao ≥ 5 ký tự);
 *      chốt = `order.confirmed` không mô phỏng; handoff = `handoff.requested`; upsell = `upsell.offered` / `.accepted`;
 *      thời gian phản hồi = `ai.replied.payload.responseMs` của lượt có gọi model (tin khách → câu trả lời, gồm cả công cụ);
 *      công cụ đúng = khối `tool_result` không `isError` / mọi `tool_result`.
 *  · Tỷ lệ dưới `AI_SALES_MIN_SAMPLE` hội thoại ⇒ `null` (CHƯA ĐỦ), không in 0%.
 *
 * HAI WORKLOAD, HAI BẢNG (đo 07/10/2026: 100% chi phí AI dùng chung 30 ngày là GHI ĐƠN TỪ HỘI THOẠI của shop `qa` — sổ AI
 * `ref = order-sync:<hội thoại>` — và 0 hội thoại AI Sales với khách). Ghi đơn không có SĐT / địa chỉ / upsell / handoff của
 * BOT: kết quả kinh doanh của nó là ĐƠN GHI ĐƯỢC và LEAD BỊ LỠ (khách để SĐT mà máy không lên đơn — chuông
 * `sales-order-sync:lead:*` báo nhân viên). Một workload chỉ được xét khi nhánh đối chứng của nó có ≥ `AI_SALES_MIN_SAMPLE`
 * hội thoại; workload không có lưu lượng KHÔNG chặn và KHÔNG được tính là "đạt".
 *
 * Ngưỡng quyết định (`AB_RULES`) là lời chủ nền tảng chốt ngày 07/10/2026 — MỘT chỗ khai, máy chỉ ĐỀ XUẤT; người (nút ở
 * /platform/saas hoặc ops `--apply`) mới đổi nấc. Đọc CSDL từng tổ chức chỉ để ĐẾM — không trả tên, SĐT, nội dung tin.
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { getDbFor, getPlatformDb, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { defaultEnvReader, platformAiConfig, type EnvReader } from "@/lib/ai-usage/platform-ai";
import { giaCuaModel } from "@/lib/ai/provider";
import { policyForWorkload, readPlatformAiPolicies, type PlatformAiPolicy } from "@/lib/ai-usage/platform-ai-policy";
import { findOrganization } from "@/lib/platform/organizations";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { AI_SALES_MIN_SAMPLE, rateOrNull } from "@/lib/sales-chatbot/performance-shared";
import { rowsOf } from "@/lib/sql-rows";

/** Ngưỡng chủ nền tảng chốt 07/10/2026 — sửa ở đây, không chép sang chỗ khác. */
export const AB_RULES = {
  /** Đủ mẫu khi cohort canary có ≥ 200 hội thoại HOẶC ≥ 50 đơn chốt — điều kiện nào tới trước. */
  minCanaryConversations: 200,
  minCanaryOrders: 50,
  /** Tỷ lệ lỗi AI không được tăng quá 1 điểm %. */
  maxErrorRateIncrease: 0.01,
  /** Chốt / SĐT / địa chỉ không giảm quá 5% TƯƠNG ĐỐI. */
  maxRelativeDrop: 0.05,
  /** Công cụ đúng không giảm quá 2 điểm % («không giảm đáng kể»). */
  maxToolSuccessDrop: 0.02,
  /** Chi phí / hội thoại phải giảm ít nhất 15%. */
  minCostReduction: 0.15,
  /** Hồi quy NẶNG ⇒ hoàn tác ngay, không đợi đủ mẫu: lỗi tăng > 5 điểm % khi canary đã ≥ 30 hội thoại. */
  severeErrorRateIncrease: 0.05,
  severeMinConversations: 30,
  /**
   * ĐẮT HƠN RÕ RỆT ⇒ hoàn tác sớm (chủ nền tảng 07/10/2026): canary ≥ 30 hội thoại mà chi phí / hội thoại cao hơn đối chứng
   * > 20% và KHÔNG có lợi ích chất lượng rõ (chỉ số chính — chốt / ra đơn — không cao hơn ≥ 5% tương đối). Không cần chờ 200
   * hội thoại chỉ để chứng minh một model đang đắt hơn.
   */
  expensiveMinConversations: 30,
  maxCostIncrease: 0.2,
  qualityBenefit: 0.05,
  /** Mỗi nấc chạy ít nhất 24 giờ (đủ một vòng giờ cao điểm) trước khi lên nấc sau. */
  minStepHours: 24,
  steps: [10, 30, 50, 100],
} as const;

export type AbArmKey = "CANARY" | "CONTROL";

/**
 * QUAN SÁT TOKEN (0231) của một hội thoại: chỉ các lượt OK đã có `thinking_tokens` (dòng trước 0231 là CHƯA ĐO). `outKnown` =
 * token ra của chính các lượt đó, để % suy nghĩ = suy nghĩ / token ra cùng tập lượt — không trộn lượt đo với lượt chưa đo.
 */
export type TokenObs = { okCalls: number; thinkKnownCalls: number; thinkingTokens: number; outKnown: number; callMs: number[] };
export const NO_OBS: TokenObs = { okCalls: 0, thinkKnownCalls: 0, thinkingTokens: 0, outKnown: 0, callMs: [] };

/** Cột token của một nhánh: hiện ra / suy nghĩ / % suy nghĩ / tổng ra mỗi hội thoại, độ trễ lời gọi, tiền phần suy nghĩ. */
export type TokenArm = {
  /** Lượt OK đã đo được phần suy nghĩ / mọi lượt OK. */
  thinkCoverage: number | null;
  visibleOutPerConv: number | null;
  thinkingPerConv: number | null;
  thinkingPct: number | null;
  callP50Ms: number | null;
  callP95Ms: number | null;
  /** USD phần suy nghĩ mỗi hội thoại — ƯỚC TÍNH theo giá ra của model nhánh. */
  thinkingCostPerConvUsd: number | null;
};

/** HÀM THUẦN. */
export function tokenArm(model: string, rows: readonly { obs: TokenObs }[]): TokenArm {
  const fully = rows.filter((r) => r.obs.okCalls > 0 && r.obs.thinkKnownCalls === r.obs.okCalls);
  const ok = rows.reduce((t, r) => t + r.obs.okCalls, 0);
  const known = rows.reduce((t, r) => t + r.obs.thinkKnownCalls, 0);
  const n = fully.length;
  const think = fully.reduce((t, r) => t + r.obs.thinkingTokens, 0);
  const out = fully.reduce((t, r) => t + r.obs.outKnown, 0);
  const lat = rows.flatMap((r) => r.obs.callMs);
  const outPrice = giaCuaModel(model)?.output ?? null;
  const enough = n >= AI_SALES_MIN_SAMPLE;
  return {
    thinkCoverage: ok > 0 ? known / ok : null,
    visibleOutPerConv: enough ? (out - think) / n : null,
    thinkingPerConv: enough ? think / n : null,
    thinkingPct: enough && out > 0 ? think / out : null,
    callP50Ms: lat.length >= AI_SALES_MIN_SAMPLE ? quantile(lat, 0.5) : null,
    callP95Ms: lat.length >= AI_SALES_MIN_SAMPLE ? quantile(lat, 0.95) : null,
    thinkingCostPerConvUsd: enough && outPrice !== null ? (think / n) * outPrice / 1_000_000 : null,
  };
}

/** Một hội thoại của cohort (đã ghép sổ AI + sổ sự kiện). */
export type AbConversation = {
  obs: TokenObs;
  arm: AbArmKey;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  unpriced: boolean;
  phone: boolean;
  address: boolean;
  orders: number;
  handoff: boolean;
  upsellOffered: boolean;
  upsellAccepted: boolean;
  toolResults: number;
  toolErrors: number;
  responseMs: number[];
};

export type AbArm = TokenArm & {
  model: string;
  conversations: number;
  orders: number;
  closeRate: number | null;
  phoneRate: number | null;
  addressRate: number | null;
  handoffRate: number | null;
  upsellOfferRate: number | null;
  /** nhận / mời — `null` khi chưa có lời mời nào đo được. */
  upsellAcceptRate: number | null;
  requests: number;
  errorRate: number | null;
  toolSuccessRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  inputPerConv: number | null;
  outputPerConv: number | null;
  tokensPerConv: number | null;
  /** `null` khi có lượt chưa định giá (chi phí là cận dưới) hoặc chưa có hội thoại. */
  costPerConvUsd: number | null;
  costPerOrderUsd: number | null;
  costUsd: number;
};

/** Phân vị (nội suy tuyến tính); mảng rỗng ⇒ `null`. HÀM THUẦN. */
export function quantile(xs: readonly number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Gộp các hội thoại của MỘT nhánh. HÀM THUẦN. */
export function armStats(model: string, rows: readonly AbConversation[]): AbArm {
  const n = rows.length;
  const count = (f: (r: AbConversation) => boolean) => rows.filter(f).length;
  const sum = (f: (r: AbConversation) => number) => rows.reduce((s, r) => s + f(r), 0);
  const orders = sum((r) => r.orders);
  const requests = sum((r) => r.requests);
  const toolResults = sum((r) => r.toolResults);
  const offered = count((r) => r.upsellOffered);
  const lat = rows.flatMap((r) => r.responseMs);
  const costUsd = sum((r) => r.costUsd);
  const complete = n > 0 && rows.every((r) => !r.unpriced);
  const inT = sum((r) => r.inputTokens);
  const outT = sum((r) => r.outputTokens);
  const per = (v: number) => (n >= AI_SALES_MIN_SAMPLE ? v / n : null);
  return {
    ...tokenArm(model, rows),
    model,
    conversations: n,
    orders,
    closeRate: rateOrNull(count((r) => r.orders > 0), n),
    phoneRate: rateOrNull(count((r) => r.phone), n),
    addressRate: rateOrNull(count((r) => r.address), n),
    handoffRate: rateOrNull(count((r) => r.handoff), n),
    upsellOfferRate: rateOrNull(offered, n),
    upsellAcceptRate: rateOrNull(count((r) => r.upsellAccepted), offered, 1),
    requests,
    errorRate: rateOrNull(sum((r) => r.errors), requests),
    toolSuccessRate: rateOrNull(toolResults - sum((r) => r.toolErrors), toolResults),
    p50Ms: lat.length >= AI_SALES_MIN_SAMPLE ? quantile(lat, 0.5) : null,
    p95Ms: lat.length >= AI_SALES_MIN_SAMPLE ? quantile(lat, 0.95) : null,
    inputPerConv: per(inT),
    outputPerConv: per(outT),
    tokensPerConv: per(inT + outT),
    costPerConvUsd: complete ? per(costUsd) : null,
    costPerOrderUsd: complete && orders > 0 ? costUsd / orders : null,
    costUsd,
  };
}

export const AB_DECISIONS = ["INSUFFICIENT_DATA", "HOLD", "PROMOTE", "ROLLBACK", "DONE"] as const;
export type AbDecision = (typeof AB_DECISIONS)[number];
export const AB_DECISION_LABEL: Record<AbDecision, string> = {
  INSUFFICIENT_DATA: "GIỮ nấc hiện tại — chưa đủ mẫu để kết luận",
  HOLD: "GIỮ nấc hiện tại — chưa đủ điều kiện để lên nấc",
  PROMOTE: "ĐỀ XUẤT lên nấc tiếp theo",
  ROLLBACK: "ĐỀ XUẤT HOÀN TÁC về model ổn định",
  DONE: "Đã ở 100% và vẫn đạt — giữ",
};
export type AbCheck = { key: string; label: string; ok: boolean | null; detail: string };
export type AbVerdict = { decision: AbDecision; nextPct: number | null; checks: AbCheck[]; reasons: string[] };

const pct = (v: number | null, d = 1) => (v === null ? "—" : `${(v * 100).toFixed(d)}%`);

/** Kết luận theo `AB_RULES`. HÀM THUẦN — máy chỉ ĐỀ XUẤT; đổi nấc là việc của người. */
export function abVerdict(canary: AbArm, control: AbArm, ctx: { currentPct: number; hoursSinceChange: number; enabled: boolean }): AbVerdict {
  const R = AB_RULES;
  const errDiff = canary.errorRate !== null && control.errorRate !== null ? canary.errorRate - control.errorRate : null;
  const rel = (c: number | null, b: number | null): boolean | null => (c === null || b === null ? null : b === 0 ? true : c >= b * (1 - R.maxRelativeDrop));
  const checks: AbCheck[] = [
    { key: "error", label: "Lỗi AI tăng ≤ 1 điểm %", ok: errDiff === null ? null : errDiff <= R.maxErrorRateIncrease, detail: `${pct(canary.errorRate)} vs ${pct(control.errorRate)}` },
    { key: "close", label: "Tỷ lệ chốt giảm ≤ 5% tương đối", ok: rel(canary.closeRate, control.closeRate), detail: `${pct(canary.closeRate)} vs ${pct(control.closeRate)}` },
    { key: "phone", label: "Tỷ lệ lấy SĐT giảm ≤ 5% tương đối", ok: rel(canary.phoneRate, control.phoneRate), detail: `${pct(canary.phoneRate)} vs ${pct(control.phoneRate)}` },
    { key: "address", label: "Tỷ lệ lấy địa chỉ giảm ≤ 5% tương đối", ok: rel(canary.addressRate, control.addressRate), detail: `${pct(canary.addressRate)} vs ${pct(control.addressRate)}` },
    { key: "tool", label: "Công cụ đúng giảm ≤ 2 điểm %", ok: canary.toolSuccessRate === null || control.toolSuccessRate === null ? null : canary.toolSuccessRate >= control.toolSuccessRate - R.maxToolSuccessDrop, detail: `${pct(canary.toolSuccessRate)} vs ${pct(control.toolSuccessRate)}` },
    {
      key: "cost",
      label: "Chi phí / hội thoại giảm ≥ 15%",
      ok: canary.costPerConvUsd === null || control.costPerConvUsd === null || control.costPerConvUsd <= 0 ? null : canary.costPerConvUsd <= control.costPerConvUsd * (1 - R.minCostReduction),
      detail: `${canary.costPerConvUsd === null ? "—" : canary.costPerConvUsd.toFixed(5)} vs ${control.costPerConvUsd === null ? "—" : control.costPerConvUsd.toFixed(5)} USD`,
    },
  ];
  return decide(checks, { conversations: canary.conversations, orders: canary.orders, errDiff, costRatio: ratio(canary.costPerConvUsd, control.costPerConvUsd), qualityBenefit: benefit(canary.closeRate, control.closeRate) }, ctx);
}

const ratio = (c: number | null, b: number | null) => (c === null || b === null || b <= 0 ? null : c / b);
const benefit = (c: number | null, b: number | null) => c !== null && b !== null && b > 0 && c >= b * (1 + AB_RULES.qualityBenefit);

// ─────────────────────────── Workload GHI ĐƠN TỪ HỘI THOẠI (order-sync) ───────────────────────────

export type SyncConversation = { obs: TokenObs; arm: AbArmKey; requests: number; errors: number; inputTokens: number; outputTokens: number; costUsd: number; unpriced: boolean; orders: number; missedLead: boolean };

export type SyncArm = TokenArm & {
  model: string;
  threads: number;
  requests: number;
  errorRate: number | null;
  orders: number;
  /** hội thoại có ≥ 1 đơn ghi được / hội thoại được đọc */
  orderRate: number | null;
  /** hội thoại có đơn / hội thoại khách đã để SĐT (có đơn HOẶC bị báo «lead chưa lên đơn») */
  leadConversion: number | null;
  missedLeadRate: number | null;
  tokensPerThread: number | null;
  costPerThreadUsd: number | null;
  costPerOrderUsd: number | null;
  costUsd: number;
};

/** HÀM THUẦN. */
export function syncArmStats(model: string, rows: readonly SyncConversation[]): SyncArm {
  const n = rows.length;
  const withOrder = rows.filter((r) => r.orders > 0).length;
  const missed = rows.filter((r) => r.missedLead && r.orders === 0).length;
  const requests = rows.reduce((t, r) => t + r.requests, 0);
  const costUsd = rows.reduce((t, r) => t + r.costUsd, 0);
  const orders = rows.reduce((t, r) => t + r.orders, 0);
  const complete = n > 0 && rows.every((r) => !r.unpriced);
  const tokens = rows.reduce((t, r) => t + r.inputTokens + r.outputTokens, 0);
  return {
    ...tokenArm(model, rows),
    model,
    threads: n,
    requests,
    errorRate: rateOrNull(rows.reduce((t, r) => t + r.errors, 0), requests),
    orders,
    orderRate: rateOrNull(withOrder, n),
    leadConversion: rateOrNull(withOrder, withOrder + missed),
    missedLeadRate: rateOrNull(missed, n),
    tokensPerThread: n >= AI_SALES_MIN_SAMPLE ? tokens / n : null,
    costPerThreadUsd: complete && n >= AI_SALES_MIN_SAMPLE ? costUsd / n : null,
    costPerOrderUsd: complete && orders > 0 ? costUsd / orders : null,
    costUsd,
  };
}

/**
 * Cùng luật `AB_RULES` cho ghi đơn: đủ mẫu (200 hội thoại / 50 đơn) · lỗi ≤ +1 điểm · tỷ lệ ra đơn và lead → đơn giảm ≤ 5%
 * tương đối (thay cho chốt / SĐT / địa chỉ của bot) · chi phí / hội thoại giảm ≥ 15%. HÀM THUẦN.
 */
export function syncVerdict(canary: SyncArm, control: SyncArm, ctx: { currentPct: number; hoursSinceChange: number; enabled: boolean }): AbVerdict {
  const R = AB_RULES;
  const errDiff = canary.errorRate !== null && control.errorRate !== null ? canary.errorRate - control.errorRate : null;
  const rel = (c: number | null, b: number | null): boolean | null => (c === null || b === null ? null : b === 0 ? true : c >= b * (1 - R.maxRelativeDrop));
  const checks: AbCheck[] = [
    { key: "error", label: "Lỗi AI tăng ≤ 1 điểm %", ok: errDiff === null ? null : errDiff <= R.maxErrorRateIncrease, detail: `${pct(canary.errorRate)} vs ${pct(control.errorRate)}` },
    { key: "orderRate", label: "Tỷ lệ ra đơn giảm ≤ 5% tương đối", ok: rel(canary.orderRate, control.orderRate), detail: `${pct(canary.orderRate)} vs ${pct(control.orderRate)}` },
    { key: "leadConversion", label: "Lead → đơn giảm ≤ 5% tương đối", ok: rel(canary.leadConversion, control.leadConversion), detail: `${pct(canary.leadConversion)} vs ${pct(control.leadConversion)}` },
    {
      key: "cost",
      label: "Chi phí / hội thoại giảm ≥ 15%",
      ok: canary.costPerThreadUsd === null || control.costPerThreadUsd === null || control.costPerThreadUsd <= 0 ? null : canary.costPerThreadUsd <= control.costPerThreadUsd * (1 - R.minCostReduction),
      detail: `${canary.costPerThreadUsd === null ? "—" : canary.costPerThreadUsd.toFixed(5)} vs ${control.costPerThreadUsd === null ? "—" : control.costPerThreadUsd.toFixed(5)} USD`,
    },
  ];
  return decide(checks, { conversations: canary.threads, orders: canary.orders, errDiff, costRatio: ratio(canary.costPerThreadUsd, control.costPerThreadUsd), qualityBenefit: benefit(canary.orderRate, control.orderRate) || benefit(canary.leadConversion, control.leadConversion) }, ctx);
}

/** Phần chung của hai bảng: thứ tự kết luận. HÀM THUẦN. */
function decide(checks: AbCheck[], canary: { conversations: number; orders: number; errDiff: number | null; costRatio: number | null; qualityBenefit: boolean }, ctx: { currentPct: number; hoursSinceChange: number; enabled: boolean }): AbVerdict {
  const R = AB_RULES;
  if (!ctx.enabled) return { decision: "HOLD", nextPct: null, checks, reasons: ["Chính sách đang tắt — không có canary nào chạy."] };
  if (canary.errDiff !== null && canary.conversations >= R.severeMinConversations && canary.errDiff > R.severeErrorRateIncrease) return { decision: "ROLLBACK", nextPct: null, checks, reasons: [`Hồi quy NẶNG: lỗi AI tăng ${(canary.errDiff * 100).toFixed(1)} điểm % (> ${R.severeErrorRateIncrease * 100}) — hoàn tác ngay, không đợi đủ mẫu.`] };
  if (canary.costRatio !== null && canary.conversations >= R.expensiveMinConversations && canary.costRatio > 1 + R.maxCostIncrease && !canary.qualityBenefit)
    return { decision: "ROLLBACK", nextPct: null, checks, reasons: [`ĐẮT HƠN RÕ RỆT: chi phí / hội thoại gấp ${canary.costRatio.toFixed(2)} lần đối chứng (> +${R.maxCostIncrease * 100}%) sau ${canary.conversations} hội thoại, không có lợi ích chất lượng rõ — hoàn tác, không chờ đủ mẫu.`] };
  if (canary.conversations < R.minCanaryConversations && canary.orders < R.minCanaryOrders) return { decision: "INSUFFICIENT_DATA", nextPct: null, checks, reasons: [`Cohort canary mới ${canary.conversations}/${R.minCanaryConversations} hội thoại · ${canary.orders}/${R.minCanaryOrders} đơn.`] };
  const failed = checks.filter((c) => c.ok === false);
  if (failed.length) return { decision: "ROLLBACK", nextPct: null, checks, reasons: failed.map((c) => `Không đạt: ${c.label} (${c.detail}).`) };
  const unknown = checks.filter((c) => c.ok === null);
  if (unknown.length) return { decision: "HOLD", nextPct: null, checks, reasons: unknown.map((c) => `Chưa đo được: ${c.label}.`) };
  if (ctx.currentPct >= 100) return { decision: "DONE", nextPct: null, checks, reasons: [] };
  if (ctx.hoursSinceChange < R.minStepHours) return { decision: "HOLD", nextPct: null, checks, reasons: [`Nấc ${ctx.currentPct}% mới chạy ${Math.floor(ctx.hoursSinceChange)} giờ (< ${R.minStepHours} giờ).`] };
  const nextPct = R.steps.find((x) => x > ctx.currentPct) ?? 100;
  return { decision: "PROMOTE", nextPct, checks, reasons: [`Đạt mọi điều kiện — lên ${nextPct}% (vẫn giữ model dự phòng).`] };
}

/**
 * Gộp kết luận của các workload CÓ lưu lượng (đối chứng ≥ AI_SALES_MIN_SAMPLE): một ROLLBACK ⇒ ROLLBACK; lên nấc chỉ khi MỌI
 * workload có lưu lượng đều PROMOTE (nấc kế = nhỏ nhất); không workload nào có lưu lượng ⇒ chưa đủ mẫu. HÀM THUẦN.
 */
export function combineVerdicts(parts: readonly { label: string; active: boolean; verdict: AbVerdict }[]): AbVerdict {
  const live = parts.filter((p) => p.active);
  if (!live.length) return { decision: "INSUFFICIENT_DATA", nextPct: null, checks: [], reasons: ["Chưa workload nào có đủ lưu lượng đối chứng trong cohort."] };
  const tag = (p: (typeof live)[number]) => p.verdict.reasons.map((r) => `[${p.label}] ${r}`);
  const rb = live.filter((p) => p.verdict.decision === "ROLLBACK");
  if (rb.length) return { decision: "ROLLBACK", nextPct: null, checks: [], reasons: rb.flatMap(tag) };
  const order: AbDecision[] = ["INSUFFICIENT_DATA", "HOLD", "PROMOTE", "DONE"];
  const worst = live.reduce((w, p) => (order.indexOf(p.verdict.decision) < order.indexOf(w.verdict.decision) ? p : w));
  if (worst.verdict.decision === "PROMOTE") {
    const next = Math.min(...live.map((p) => p.verdict.nextPct ?? 100));
    return { decision: "PROMOTE", nextPct: next, checks: [], reasons: live.flatMap(tag) };
  }
  return { decision: worst.verdict.decision, nextPct: null, checks: [], reasons: live.filter((p) => p.verdict.decision === worst.verdict.decision).flatMap(tag) };
}

/** Một workload: chính sách CÓ HIỆU LỰC của nó (riêng hoặc chung) + hai nhánh + kết luận. */
export type AbSection<A> = { scope: string; policy: PlatformAiPolicy; canaryModel: string; controlModel: string; since: string; canary: A; control: A; verdict: AbVerdict };

export type ModelAbReport = {
  /** Workload AI Sales chat với khách — `null` khi không có chính sách nào áp lên nó. */
  chat: AbSection<AbArm> | null;
  /** Workload ghi đơn từ hội thoại nhân viên. */
  sync: AbSection<SyncArm> | null;
  /** Kết luận chung (combineVerdicts). */
  verdict: AbVerdict;
  /** Tổ chức không đọc được (CSDL lỗi) — hội thoại của nó nằm NGOÀI phép so, không phải 0. */
  errors: string[];
  orgs: number;
};

type LedgerConv = { orgCode: string; ref: string; firstAt: number; models: string[]; requests: number; errors: number; inputTokens: number; outputTokens: number; costUsd: number; unpriced: number; obs: TokenObs };
const SYNC_PREFIX = "order-sync:";
const DAY_MS = 86_400_000;

/** Đọc cả hai sổ cho cohort của chính sách CÓ HIỆU LỰC của từng workload. Không workload nào có chính sách ⇒ `null`. */
async function readModelAb(now: Date, env: EnvReader): Promise<ModelAbReport | null> {
  const set = await readPlatformAiPolicies({ fresh: true });
  const chatEff = policyForWorkload(set, "sales_chatbot");
  const syncEff = policyForWorkload(set, "order_sync");
  if (!chatEff.policy && !syncEff.policy) return null;
  const cfg = platformAiConfig(env);
  const controlOf = (p: PlatformAiPolicy) => p.fallbackModel ?? (cfg.ready ? cfg.model : "");
  const sinces = [chatEff.policy, syncEff.policy].filter((p): p is PlatformAiPolicy => Boolean(p)).map((p) => Date.parse(p.cohortSince));
  const earliest = Math.min(...sinces);
  const pdb = await getPlatformDb();
  const a = schema.platformAiUsage;
  // Lượt đầu của hội thoại phải ≥ mốc cohort ⇒ đọc lùi 30 ngày để biết hội thoại nào đã có lượt TRƯỚC mốc.
  const ledger = await pdb
    .select({
      orgCode: a.orgCode,
      ref: a.ref,
      firstAt: sql<string>`min(${a.at})`,
      models: sql<string[]>`array_remove(array_agg(distinct ${a.model}), null)`,
      requests: sql<number>`coalesce(sum(${a.requests}), 0)::int`,
      errors: sql<number>`coalesce(sum(${a.requests}) filter (where ${a.status} = 'ERROR'), 0)::int`,
      inputTokens: sql<number>`coalesce(sum(${a.inputTokens}), 0)::float8`,
      outputTokens: sql<number>`coalesce(sum(${a.outputTokens}), 0)::float8`,
      costUsd: sql<number>`coalesce(sum(${a.costUsd}), 0)::float8`,
      unpriced: sql<number>`count(*) filter (where ${a.costUsd} is null and ${a.status} = 'OK')::int`,
      okCalls: sql<number>`coalesce(sum(${a.requests}) filter (where ${a.status} = 'OK'), 0)::int`,
    })
    .from(a)
    .where(and(eq(a.billingSource, "PLATFORM"), eq(a.feature, "sales_chatbot"), gte(a.at, new Date(earliest - 30 * DAY_MS)), sql`${a.ref} is not null`, sql`${a.status} <> 'BLOCKED_QUOTA'`))
    .groupBy(a.orgCode, a.ref);
  const convs: LedgerConv[] = ledger.map((r) => ({
    orgCode: r.orgCode,
    ref: String(r.ref),
    firstAt: Date.parse(String(r.firstAt)),
    models: (r.models ?? []).map(String),
    requests: Number(r.requests),
    errors: Number(r.errors),
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    costUsd: Number(r.costUsd),
    unpriced: Number(r.unpriced),
    // Cột suy nghĩ / độ trễ của sổ đi ở migration riêng (ledger.ts) — tới lúc đó độ phủ = 0 ⇒ cột token in «—», không phải 0.
    obs: { ...NO_OBS, okCalls: Number(r.okCalls) },
  }));
  // Mỗi workload chỉ nhận hội thoại mở từ mốc cohort CỦA NÓ; nhánh = hội thoại có dòng mang tên model canary của nó.
  const inCohort = (p: PlatformAiPolicy | null, c: LedgerConv) => Boolean(p) && c.firstAt >= Date.parse(p!.cohortSince);
  const chatList = convs.filter((c) => !c.ref.includes(":") && inCohort(chatEff.policy, c)).map((c) => ({ ...c, canary: c.models.includes(chatEff.policy!.primaryModel) }));
  const syncList = convs.filter((c) => c.ref.startsWith(SYNC_PREFIX) && inCohort(syncEff.policy, c)).map((c) => ({ ...c, ref: c.ref.slice(SYNC_PREFIX.length), canary: c.models.includes(syncEff.policy!.primaryModel) }));
  const orgs = new Set([...chatList, ...syncList].map((c) => c.orgCode));
  const rows: AbConversation[] = [];
  const syncRows: SyncConversation[] = [];
  const errors: string[] = [];
  for (const orgCode of orgs) {
    try {
      const org = await findOrganization(orgCode);
      if (!org) {
        errors.push(`${orgCode}: không tìm thấy tổ chức`);
        continue;
      }
      const chat = chatList.filter((c) => c.orgCode === orgCode);
      const sync = syncList.filter((c) => c.orgCode === orgCode);
      if (chat.length) rows.push(...(await readOrgBehaviour(org, chat)));
      if (sync.length) syncRows.push(...(await readOrgSync(org, sync, new Date(syncEff.policy!.cohortSince))));
    } catch (e) {
      errors.push(`${orgCode}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
    }
  }
  const ctxOf = (p: PlatformAiPolicy) => ({ currentPct: p.canaryPct, hoursSinceChange: (now.getTime() - Date.parse(p.changedAt)) / 3_600_000, enabled: p.enabled });
  let chat: AbSection<AbArm> | null = null;
  if (chatEff.policy) {
    const p = chatEff.policy;
    const canary = armStats(p.primaryModel, rows.filter((r) => r.arm === "CANARY"));
    const control = armStats(controlOf(p), rows.filter((r) => r.arm === "CONTROL"));
    chat = { scope: chatEff.scope, policy: p, canaryModel: p.primaryModel, controlModel: controlOf(p), since: p.cohortSince, canary, control, verdict: abVerdict(canary, control, ctxOf(p)) };
  }
  let sync: AbSection<SyncArm> | null = null;
  if (syncEff.policy) {
    const p = syncEff.policy;
    const canary = syncArmStats(p.primaryModel, syncRows.filter((r) => r.arm === "CANARY"));
    const control = syncArmStats(controlOf(p), syncRows.filter((r) => r.arm === "CONTROL"));
    sync = { scope: syncEff.scope, policy: p, canaryModel: p.primaryModel, controlModel: controlOf(p), since: p.cohortSince, canary, control, verdict: syncVerdict(canary, control, ctxOf(p)) };
  }
  const verdict = combineVerdicts([
    ...(chat ? [{ label: "AI Sales chat", active: chat.control.conversations >= AI_SALES_MIN_SAMPLE, verdict: chat.verdict }] : []),
    ...(sync ? [{ label: "Ghi đơn từ hội thoại", active: sync.control.threads >= AI_SALES_MIN_SAMPLE, verdict: sync.verdict }] : []),
  ]);
  return { chat, sync, verdict, errors, orgs: orgs.size };
}

/** Hành vi bán hàng của các hội thoại cohort trong CSDL của MỘT tổ chức — chỉ đếm. */
async function readOrgBehaviour(org: { code: string; isHome: boolean }, list: readonly (LedgerConv & { canary: boolean })[]): Promise<AbConversation[]> {
  const db = await getDbFor(org);
  const ids = list.map((c) => c.ref);
  const c = schema.salesChatConversations;
  const e = schema.salesConversationEvents;
  const [conv, ev, tools] = await Promise.all([
    db
      .select({ id: c.id, channel: c.channel, phone: sql<boolean>`(coalesce(${c.customerPhone}, '') <> '' or coalesce(${c.state}->'customer'->>'phone', '') <> '')` })
      .from(c)
      .where(inArray(c.id, ids)),
    db
      .select({
        id: e.conversationId,
        identified: sql<boolean>`bool_or(${e.type} = 'customer.identified' and coalesce(${e.payload}->>'simulated', 'false') <> 'true')`,
        orders: sql<number>`(count(*) filter (where ${e.type} = 'order.confirmed' and coalesce(${e.payload}->>'simulated', 'false') <> 'true'))::int`,
        handoff: sql<boolean>`bool_or(${e.type} = 'handoff.requested')`,
        upsellOffered: sql<boolean>`bool_or(${e.type} = 'upsell.offered')`,
        upsellAccepted: sql<boolean>`bool_or(${e.type} = 'upsell.accepted')`,
        responseMs: sql<number[] | null>`array_agg((${e.payload}->>'responseMs')::bigint) filter (where ${e.type} = 'ai.replied' and ${e.payload}->>'mode' = 'AI' and (${e.payload}->>'responseMs') is not null)`,
      })
      .from(e)
      .where(inArray(e.conversationId, ids))
      .groupBy(e.conversationId),
    db.execute(sql`select m.conversation_id as id,
        (count(*) filter (where b->>'type' = 'tool_result'))::int as total,
        (count(*) filter (where b->>'type' = 'tool_result' and coalesce(b->>'isError', 'false') = 'true'))::int as errs
      from ${schema.salesChatMessages} m
      cross join lateral jsonb_array_elements(case when jsonb_typeof(m.content) = 'array' then m.content else '[]'::jsonb end) b
      where m.conversation_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
      group by m.conversation_id`),
  ]);
  const convById = new Map(conv.map((r) => [r.id, r]));
  const evById = new Map(ev.map((r) => [r.id, r]));
  const toolById = new Map(rowsOf<{ id: string; total: number; errs: number }>(tools).map((r) => [r.id, r]));
  const out: AbConversation[] = [];
  for (const l of list) {
    const cv = convById.get(l.ref);
    if (!cv || cv.channel === "TEST") continue;
    const x = evById.get(l.ref);
    const t = toolById.get(l.ref);
    const identified = Boolean(x?.identified);
    out.push({
      obs: l.obs,
      arm: l.canary ? "CANARY" : "CONTROL",
      requests: l.requests,
      errors: l.errors,
      inputTokens: l.inputTokens,
      outputTokens: l.outputTokens,
      costUsd: l.costUsd,
      unpriced: l.unpriced > 0,
      phone: Boolean(cv.phone) || identified,
      address: identified,
      orders: Number(x?.orders ?? 0),
      handoff: Boolean(x?.handoff),
      upsellOffered: Boolean(x?.upsellOffered),
      upsellAccepted: Boolean(x?.upsellAccepted),
      toolResults: Number(t?.total ?? 0),
      toolErrors: Number(t?.errs ?? 0),
      responseMs: (x?.responseMs ?? []).map(Number).filter((v) => Number.isFinite(v) && v >= 0),
    });
  }
  return out;
}

/**
 * Kết quả ghi đơn của các hội thoại cohort trong CSDL của MỘT tổ chức — chỉ đếm: đơn `origin = AI_ORDER_SYNC` gắn hội thoại
 * (ghi từ mốc cohort, không tính đơn đã xoá) và chuông «khách để SĐT mà máy chưa lên đơn».
 */
async function readOrgSync(org: { code: string; isHome: boolean }, list: readonly (LedgerConv & { canary: boolean })[], since: Date): Promise<SyncConversation[]> {
  const db = await getDbFor(org);
  const ids = list.map((c) => c.ref);
  const o = schema.orders;
  const n = schema.notifications;
  const [orders, leads] = await Promise.all([
    db
      .select({ id: o.salesConversationId, orders: sql<number>`count(*)::int` })
      .from(o)
      .where(and(inArray(o.salesConversationId, ids), eq(o.origin, "AI_ORDER_SYNC"), gte(o.insertedAt, since), sql`${o.stage} <> 'DELETED'`))
      .groupBy(o.salesConversationId),
    db
      .selectDistinct({ id: n.entityId })
      .from(n)
      .where(and(inArray(n.entityId, ids), sql`${n.dedupeKey} like 'sales-order-sync:lead:%'`, gte(n.occurredAt, since))),
  ]);
  const ordersById = new Map(orders.map((r) => [String(r.id), Number(r.orders)]));
  const leadIds = new Set(leads.map((r) => r.id));
  return list.map((l) => ({ obs: l.obs, arm: l.canary ? "CANARY" : "CONTROL", requests: l.requests, errors: l.errors, inputTokens: l.inputTokens, outputTokens: l.outputTokens, costUsd: l.costUsd, unpriced: l.unpriced > 0, orders: ordersById.get(l.ref) ?? 0, missedLead: leadIds.has(l.ref) }));
}

/** Bảng A/B ở /platform/saas — người vận hành nền tảng. */
export async function loadPlatformModelAb(user: SessionUser, now: Date = new Date(), env: EnvReader = defaultEnvReader): Promise<{ ok: true; value: ModelAbReport | null } | { ok: false; error: string }> {
  const denial = platformOperatorDenial(user);
  if (denial) return { ok: false, error: denial };
  return { ok: true, value: await readModelAb(now, env) };
}

/** Cùng bảng cho ops `platform-ai-model-probe --report` — chỉ in số tổng hợp, không người, không mã hội thoại. */
export async function readPlatformModelAbForScript(now: Date = new Date(), env: EnvReader = defaultEnvReader): Promise<ModelAbReport | null> {
  return readModelAb(now, env);
}

/**
 * ═══════════ KINH TẾ SAAS CỦA NỀN TẢNG — HÀM THUẦN (docs/productization/11_SAAS_METRICS_SPEC.md) ═══════════
 *
 * Không đọc / ghi CSDL. Đầu vào là ảnh chụp `platform_saas_daily` + mốc `platform_org_milestones` + tổng sổ AI; đầu ra là
 * con số kèm ĐỘ PHỦ. Ba luật chạy xuyên tệp:
 *  · CHƯA BIẾT ≠ 0 (AGENTS §0.3, §42): ảnh chụp thiếu ⇒ `null`, không phải 0. Một tổ chức VẮNG trong một ảnh chụp CÓ
 *    THẬT nghĩa là nó chưa tồn tại ⇒ 0 (đúng nghĩa); một NGÀY không có ảnh chụp nào ⇒ chưa đo.
 *  · Tổ chức nhà là NỘI BỘ: không vào MRR, không vào kích hoạt, không vào mẫu số churn.
 *  · Không có điểm "sức khoẻ" tổng: chưa có dữ liệu kiểm chứng trọng số (yêu cầu §18) — chỉ trả tín hiệu rời.
 */
import type { BillingStandingKind } from "@/lib/billing/rules";

export const SAAS_METRICS_VERSION = "2026-10-04.1";

export type SaasDailyRow = {
  day: string;
  orgCode: string;
  orgStatus: string;
  isHome: boolean;
  planKey: string;
  billingEnabled: boolean;
  standing: BillingStandingKind;
  paying: boolean;
  /** `null` = CHƯA BIẾT. */
  mrrVnd: number | null;
};

// ─────────────────────────── Biến động MRR ───────────────────────────

export const MRR_MOVEMENTS = ["NEW", "EXPANSION", "CONTRACTION", "CHURN", "REACTIVATION", "RETAINED", "NONE", "UNKNOWN"] as const;
export type MrrMovement = (typeof MRR_MOVEMENTS)[number];

export const MRR_MOVEMENT_LABEL: Record<MrrMovement, string> = {
  NEW: "Mới",
  EXPANSION: "Mở rộng",
  CONTRACTION: "Thu hẹp",
  CHURN: "Rời bỏ",
  REACTIVATION: "Quay lại",
  RETAINED: "Giữ nguyên",
  NONE: "Không thu",
  UNKNOWN: "Chưa biết",
};

/**
 * Một tổ chức đi từ `prev` tới `cur` (VND/tháng). `paidBefore` = đã từng có MRR > 0 TRƯỚC mốc đầu kỳ — phân biệt khách
 * mới với khách quay lại (gộp hai cái làm "New MRR" phồng lên mỗi lần một khách cũ trả nợ).
 */
export function classifyMovement(prev: number | null, cur: number | null, paidBefore: boolean): MrrMovement {
  if (prev === null || cur === null) return "UNKNOWN";
  if (prev <= 0 && cur <= 0) return "NONE";
  if (prev <= 0) return paidBefore ? "REACTIVATION" : "NEW";
  if (cur <= 0) return "CHURN";
  if (cur > prev) return "EXPANSION";
  if (cur < prev) return "CONTRACTION";
  return "RETAINED";
}

export type OrgMovement = { orgCode: string; prevVnd: number | null; curVnd: number | null; movement: MrrMovement };

export type PeriodMovement = {
  /** Ngày của ảnh chụp đầu kỳ / cuối kỳ thật sự đem so. `null` = không có ảnh chụp ⇒ cả kỳ CHƯA ĐO. */
  startDay: string | null;
  endDay: string | null;
  /** Ảnh chụp đầu kỳ nằm TRONG kỳ (sổ bắt đầu giữa kỳ) — biến động chỉ tính từ `startDay`. */
  partial: boolean;
  startMrrVnd: number | null;
  endMrrVnd: number | null;
  newMrrVnd: number | null;
  expansionMrrVnd: number | null;
  contractionMrrVnd: number | null;
  churnedMrrVnd: number | null;
  reactivationMrrVnd: number | null;
  netNewMrrVnd: number | null;
  startPayingLogos: number | null;
  newLogos: number | null;
  churnedLogos: number | null;
  /** Gross / Net revenue retention của nhóm trả tiền đầu kỳ. `null` khi đầu kỳ không ai trả tiền / chưa đo. */
  grr: number | null;
  nrr: number | null;
  logoChurn: number | null;
  /** Tổ chức mà một trong hai đầu là CHƯA BIẾT — MRR của chúng không vào bất kỳ dòng biến động nào. */
  unknownOrgs: string[];
  byOrg: OrgMovement[];
  note: string | null;
};

/** Ảnh chụp mới nhất ở hoặc trước `day` (theo ngày), hoặc `null`. */
function latestDayAtOrBefore(days: readonly string[], day: string): string | null {
  let best: string | null = null;
  for (const d of days) if (d <= day && (best === null || d > best)) best = d;
  return best;
}

function earliestDayInRange(days: readonly string[], from: string, to: string): string | null {
  let best: string | null = null;
  for (const d of days) if (d >= from && d <= to && (best === null || d < best)) best = d;
  return best;
}

const ratio = (num: number, den: number) => (den > 0 ? num / den : null);

/**
 * Biến động MRR của kỳ [from, to] (ngày giờ VN, tính cả hai đầu).
 * Đầu kỳ = ảnh chụp mới nhất TRƯỚC `from`; sổ chưa có ⇒ ảnh chụp sớm nhất TRONG kỳ (`partial`, nói ra trong `note`).
 * Cuối kỳ = ảnh chụp mới nhất ≤ `to` mà ≥ đầu kỳ. Một tổ chức vắng mặt trong một ảnh chụp có thật ⇒ 0.
 */
export function periodMovement(rows: readonly SaasDailyRow[], from: string, to: string): PeriodMovement {
  const tenant = rows.filter((r) => !r.isHome);
  const days = [...new Set(rows.map((r) => r.day))];
  const before = latestDayAtOrBefore(days, prevDay(from));
  const startDay = before ?? earliestDayInRange(days, from, to);
  const endDay = startDay ? latestDayAtOrBefore(days.filter((d) => d >= startDay), to) : null;
  const empty: PeriodMovement = {
    startDay,
    endDay,
    partial: before === null && startDay !== null,
    startMrrVnd: null,
    endMrrVnd: null,
    newMrrVnd: null,
    expansionMrrVnd: null,
    contractionMrrVnd: null,
    churnedMrrVnd: null,
    reactivationMrrVnd: null,
    netNewMrrVnd: null,
    startPayingLogos: null,
    newLogos: null,
    churnedLogos: null,
    grr: null,
    nrr: null,
    logoChurn: null,
    unknownOrgs: [],
    byOrg: [],
    note: null,
  };
  if (!startDay || !endDay) return { ...empty, note: "Chưa có ảnh chụp nào trong / trước kỳ — sổ MRR bắt đầu từ ngày deploy, không suy ngược." };

  const at = (day: string) => new Map(tenant.filter((r) => r.day === day).map((r) => [r.orgCode, r]));
  const start = at(startDay);
  const end = at(endDay);
  const codes = [...new Set([...start.keys(), ...end.keys()])].sort();
  const paidBeforeStart = new Set(tenant.filter((r) => r.day < startDay && (r.mrrVnd ?? 0) > 0).map((r) => r.orgCode));

  const byOrg: OrgMovement[] = [];
  let startMrr = 0;
  let endMrr = 0;
  let neu = 0;
  let exp = 0;
  let con = 0;
  let churn = 0;
  let react = 0;
  let startLogos = 0;
  let newLogos = 0;
  let churnedLogos = 0;
  const unknown: string[] = [];
  for (const code of codes) {
    const prevVnd = start.has(code) ? start.get(code)!.mrrVnd : 0;
    const curVnd = end.has(code) ? end.get(code)!.mrrVnd : 0;
    const movement = startDay === endDay ? (prevVnd === null ? "UNKNOWN" : prevVnd > 0 ? "RETAINED" : "NONE") : classifyMovement(prevVnd, curVnd, paidBeforeStart.has(code));
    byOrg.push({ orgCode: code, prevVnd, curVnd, movement });
    if (movement === "UNKNOWN") {
      unknown.push(code);
      continue;
    }
    const p = prevVnd ?? 0;
    const c = curVnd ?? 0;
    startMrr += p;
    endMrr += c;
    if (p > 0) startLogos += 1;
    if (movement === "NEW") {
      neu += c;
      newLogos += 1;
    } else if (movement === "REACTIVATION") react += c;
    else if (movement === "EXPANSION") exp += c - p;
    else if (movement === "CONTRACTION") con += p - c;
    else if (movement === "CHURN") {
      churn += p;
      churnedLogos += 1;
    }
  }
  const notes: string[] = [];
  if (before === null) notes.push(`Sổ bắt đầu từ ${startDay} — biến động tính từ ngày đó, không phải từ đầu kỳ.`);
  if (unknown.length) notes.push(`${unknown.length} tổ chức có MRR chưa biết ở một đầu kỳ — không cộng vào dòng biến động nào.`);
  return {
    ...empty,
    startMrrVnd: startMrr,
    endMrrVnd: endMrr,
    newMrrVnd: neu,
    expansionMrrVnd: exp,
    contractionMrrVnd: con,
    churnedMrrVnd: churn,
    reactivationMrrVnd: react,
    netNewMrrVnd: neu + exp + react - con - churn,
    startPayingLogos: startLogos,
    newLogos,
    churnedLogos,
    grr: ratio(startMrr - con - churn, startMrr),
    nrr: ratio(startMrr + exp - con - churn, startMrr),
    logoChurn: ratio(churnedLogos, startLogos),
    unknownOrgs: unknown,
    byOrg,
    note: notes.length ? notes.join(" ") : null,
  };
}

/** Ngày liền trước (YYYY-MM-DD, lịch thuần — không múi giờ). */
export function prevDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** [ngày đầu, ngày cuối] của tháng `YYYY-MM`. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

// ─────────────────────────── Vòng đời tổ chức ───────────────────────────

export const TENANT_LIFECYCLES = ["PAID", "TRIAL", "FREE", "LOCKED", "SUSPENDED", "CHURNED", "INTERNAL"] as const;
export type TenantLifecycle = (typeof TENANT_LIFECYCLES)[number];

export const TENANT_LIFECYCLE_LABEL: Record<TenantLifecycle, string> = {
  PAID: "Trả tiền",
  TRIAL: "Dùng thử",
  FREE: "Không thu phí",
  LOCKED: "Quá hạn — chỉ xem",
  SUSPENDED: "Đình chỉ",
  CHURNED: "Đã rời",
  INTERNAL: "Nội bộ",
};

/**
 * Vòng đời đọc từ ảnh chụp + một sự thật bất biến (`everPaid` = có hoá đơn ĐÃ THU). Không cột mới nào lưu nó.
 *  · PAID = đang tính MRR (cùng định nghĩa với MRR — `mrrContribution`).
 *  · TRIAL = đang thu phí mà chưa tính MRR (gói dùng thử không có giá), chưa trả tiền lần nào.
 *  · CHURNED = đã từng có hoá đơn đã thu, nay không còn tính MRR (khoá / tắt thu phí / lưu trữ / về gói không giá).
 */
export function tenantLifecycle(row: Pick<SaasDailyRow, "isHome" | "orgStatus" | "billingEnabled" | "standing" | "paying" | "planKey">, everPaid: boolean): TenantLifecycle {
  if (row.isHome || row.planKey === "internal") return "INTERNAL";
  if (row.orgStatus === "SUSPENDED") return "SUSPENDED";
  // Tính MRR = trả tiền, kể cả khi tiền về ngoài hệ thống và người vận hành tự đặt «đã trả tới» — cùng định nghĩa với MRR.
  if (row.paying) return "PAID";
  if (row.orgStatus !== "ACTIVE") return everPaid ? "CHURNED" : "FREE";
  if (!row.billingEnabled) return everPaid ? "CHURNED" : "FREE";
  if (row.standing === "LOCKED") return everPaid ? "CHURNED" : "LOCKED";
  return everPaid ? "CHURNED" : "TRIAL";
}

// ─────────────────────────── Kích hoạt / Time-to-Value ───────────────────────────

export const ACTIVATION_MILESTONES = [
  "SIGNED_UP",
  "CHANNEL_CONNECTED",
  "CATALOG_IMPORTED",
  "FIRST_CONVERSATION",
  "FIRST_AI_REPLY",
  "FIRST_AI_ORDER",
  "FIRST_DELIVERED_AI_ORDER",
] as const;
export type ActivationMilestone = (typeof ACTIVATION_MILESTONES)[number];

export type MilestoneSpec = {
  key: ActivationMilestone;
  label: string;
  /** Chứng từ CÓ THẬT mà mốc đọc ra (min thời điểm). */
  source: string;
  /** `UNAVAILABLE` = chưa đo được; `missingWhat` nói thiếu gì, đủ cụ thể để sửa (AGENTS §37). */
  availability: "MEASURED" | "UNAVAILABLE";
  missingWhat?: string;
};

export const MILESTONE_SPECS: Record<ActivationMilestone, MilestoneSpec> = {
  SIGNED_UP: { key: "SIGNED_UP", label: "Tạo cửa hàng", source: "platform_organizations.created_at", availability: "MEASURED" },
  CHANNEL_CONNECTED: { key: "CHANNEL_CONNECTED", label: "Nối kênh bán", source: "org_connections: kết nối kênh bán (CHANNEL_CONNECTOR_KEYS) đang bật — activated_at", availability: "MEASURED" },
  CATALOG_IMPORTED: { key: "CATALOG_IMPORTED", label: "Có sản phẩm", source: "products.created_at (sản phẩm đầu tiên)", availability: "MEASURED" },
  FIRST_CONVERSATION: { key: "FIRST_CONVERSATION", label: "Hội thoại khách đầu tiên", source: "sales_chat_conversations.created_at — kênh thật (khác TEST)", availability: "MEASURED" },
  FIRST_AI_REPLY: {
    key: "FIRST_AI_REPLY",
    label: "AI trả lời khách thật",
    source: "sales_chat_conversations kênh thật có ai_calls > 0 — mốc MỞ hội thoại đó (cận dưới của lượt trả lời đầu)",
    availability: "MEASURED",
  },
  FIRST_AI_ORDER: { key: "FIRST_AI_ORDER", label: "Đơn đầu tiên do AI chốt", source: "orders.created_at của đơn gắn sales_chat_conversations.order_id (kênh thật)", availability: "MEASURED" },
  FIRST_DELIVERED_AI_ORDER: {
    key: "FIRST_DELIVERED_AI_ORDER",
    label: "Đơn AI giao thành công đầu tiên",
    source: "orders.created_at của đơn AI (gắn sales_chat_conversations.order_id, kênh thật) đầu tiên có ORDER_OUTCOME = DELIVERED — mốc ĐẶT của đơn ấy, không phải mốc giao",
    availability: "MEASURED",
  },
};

/** Mốc định nghĩa «đã kích hoạt»: AI đã trả lời một khách thật. Một chỗ, đổi ở đây. */
export const ACTIVATED_AT: ActivationMilestone = "FIRST_AI_REPLY";

/**
 * Khoá connector được tính là "kênh bán" (nơi khách nhắn tới). Kênh báo nhóm nội bộ (Lark / Telegram / Zalo bot) KHÔNG
 * phải kênh bán. Thêm kênh mới (Messenger trực tiếp, Zalo OA…) thì khai ở đây.
 */
export const CHANNEL_CONNECTOR_KEYS = ["pancake-fanpage", "pancake-chatbot", "pancake-pages", "facebook-messenger"] as const;

/** Mẫu dưới ngưỡng ⇒ trung vị `null` (cùng tinh thần AGENTS §63) — "1 khách mất 2 ngày" không phải một chỉ số. */
export const SAAS_MEDIAN_MIN_SAMPLE = 3;

export function median(values: readonly number[]): number | null {
  if (values.length < SAAS_MEDIAN_MIN_SAMPLE) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export type OrgMilestones = { orgCode: string; reached: Partial<Record<ActivationMilestone, Date>> };

export type FunnelStep = { milestone: ActivationMilestone; label: string; availability: MilestoneSpec["availability"]; missingWhat: string | null; reached: number | null; of: number; medianDaysFromSignup: number | null; sample: number };

/** Phễu kích hoạt trên các tổ chức khách (không có nhà). Mốc chưa đo được ⇒ `reached = null`, không phải 0. */
export function activationFunnel(orgs: readonly OrgMilestones[]): FunnelStep[] {
  return ACTIVATION_MILESTONES.map((m) => {
    const spec = MILESTONE_SPECS[m];
    if (spec.availability === "UNAVAILABLE") return { milestone: m, label: spec.label, availability: spec.availability, missingWhat: spec.missingWhat ?? null, reached: null, of: orgs.length, medianDaysFromSignup: null, sample: 0 };
    const durations: number[] = [];
    let reached = 0;
    for (const o of orgs) {
      const at = o.reached[m];
      if (!at) continue;
      reached += 1;
      const signup = o.reached.SIGNED_UP;
      if (signup && m !== "SIGNED_UP") durations.push(Math.max(0, (at.getTime() - signup.getTime()) / 86_400_000));
    }
    return { milestone: m, label: spec.label, availability: spec.availability, missingWhat: null, reached, of: orgs.length, medianDaysFromSignup: m === "SIGNED_UP" ? null : median(durations), sample: durations.length };
  });
}

// ─────────────────────────── Biên lợi nhuận ───────────────────────────

/**
 * Chi phí nền tảng chủ shop KHAI (luật 38 — không hằng số nào trong mã). `null` = chưa khai ⇒ biên gộp chỉ trừ được
 * chi phí AI và PHẢI nói ra là chưa đủ.
 */
export type PlatformCostDeclaration = { infraMonthlyVnd: number | null; supportMonthlyVnd: number | null; reason: string | null; updatedAt: string | null; updatedByEmail: string | null };

export const EMPTY_COST_DECLARATION: PlatformCostDeclaration = { infraMonthlyVnd: null, supportMonthlyVnd: null, reason: null, updatedAt: null, updatedByEmail: null };

export function parseCostDeclaration(raw: unknown): PlatformCostDeclaration {
  if (!raw || typeof raw !== "object") return EMPTY_COST_DECLARATION;
  const v = raw as Record<string, unknown>;
  const money = (x: unknown) => (typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : null);
  const str = (x: unknown) => (typeof x === "string" && x ? x : null);
  return { infraMonthlyVnd: money(v.infraMonthlyVnd), supportMonthlyVnd: money(v.supportMonthlyVnd), reason: str(v.reason), updatedAt: str(v.updatedAt), updatedByEmail: str(v.updatedByEmail) };
}

export type AiCost = { costUsd: number; requests: number; unpricedRequests: number };

/** VND từ USD theo tỷ giá NỀN TẢNG (không phải tỷ giá ngân hàng). Dòng chưa định giá không được coi là 0. */
export function aiCostVnd(cost: AiCost, usdToVnd: number): { vnd: number; complete: boolean } {
  return { vnd: Math.round(cost.costUsd * usdToVnd), complete: cost.unpricedRequests === 0 };
}

export type TenantEconomics = {
  mrrVnd: number | null;
  /** Chi phí AI do NỀN TẢNG trả (`billing_source = PLATFORM`). BYOK là tiền của khách — không phải giá vốn của nền tảng. */
  platformAiCostVnd: number;
  aiCostComplete: boolean;
  /** MRR − chi phí AI nền tảng trả. Hạ tầng / hỗ trợ CHƯA phân bổ về từng tổ chức (chưa có căn cứ — AGENTS §14). */
  contributionVnd: number | null;
  contributionMargin: number | null;
};

export function tenantEconomics(mrrVnd: number | null, platformAi: AiCost, usdToVnd: number): TenantEconomics {
  const ai = aiCostVnd(platformAi, usdToVnd);
  const contribution = mrrVnd === null ? null : mrrVnd - ai.vnd;
  return { mrrVnd, platformAiCostVnd: ai.vnd, aiCostComplete: ai.complete, contributionVnd: contribution, contributionMargin: mrrVnd && contribution !== null ? contribution / mrrVnd : null };
}

export type PlatformMargin = {
  revenueVnd: number;
  aiCostVnd: number;
  infraVnd: number | null;
  supportVnd: number | null;
  /** (doanh thu − AI − hạ tầng) / doanh thu. `null` khi chưa có doanh thu hoặc chưa khai hạ tầng. */
  grossMargin: number | null;
  /** (doanh thu − AI − hạ tầng − hỗ trợ) / doanh thu. `null` khi thiếu một khoản khai. */
  contributionMargin: number | null;
  /** Chỉ trừ AI — luôn tính được khi có doanh thu; nhãn "chưa đủ chi phí". */
  aiOnlyMargin: number | null;
  missing: string[];
};

export function platformMargin(revenueVnd: number, aiCostVndTotal: number, costs: PlatformCostDeclaration): PlatformMargin {
  const missing: string[] = [];
  if (costs.infraMonthlyVnd === null) missing.push("chi phí hạ tầng / tháng");
  if (costs.supportMonthlyVnd === null) missing.push("chi phí hỗ trợ khách / tháng");
  const gross = revenueVnd > 0 && costs.infraMonthlyVnd !== null ? (revenueVnd - aiCostVndTotal - costs.infraMonthlyVnd) / revenueVnd : null;
  const contribution = revenueVnd > 0 && costs.infraMonthlyVnd !== null && costs.supportMonthlyVnd !== null ? (revenueVnd - aiCostVndTotal - costs.infraMonthlyVnd - costs.supportMonthlyVnd) / revenueVnd : null;
  return {
    revenueVnd,
    aiCostVnd: aiCostVndTotal,
    infraVnd: costs.infraMonthlyVnd,
    supportVnd: costs.supportMonthlyVnd,
    grossMargin: gross,
    contributionMargin: contribution,
    aiOnlyMargin: revenueVnd > 0 ? (revenueVnd - aiCostVndTotal) / revenueVnd : null,
    missing,
  };
}

// ─────────────────────────── Tín hiệu sức khoẻ (rời, không chấm điểm) ───────────────────────────

export type Trend = "UP" | "DOWN" | "FLAT" | "NEW" | "NONE";

/** Xu hướng 7 ngày gần nhất so với 7 ngày trước đó. Dưới 10 lượt cả hai kỳ ⇒ `NONE` (quá ít để gọi là xu hướng). */
export function trendOf(recent: number, previous: number): Trend {
  if (recent + previous < 10) return recent + previous === 0 ? "NONE" : recent > 0 && previous === 0 ? "NEW" : "NONE";
  if (previous === 0) return "NEW";
  const r = recent / previous;
  if (r >= 1.2) return "UP";
  if (r <= 0.8) return "DOWN";
  return "FLAT";
}

export const TREND_LABEL: Record<Trend, string> = { UP: "Tăng", DOWN: "Giảm", FLAT: "Đều", NEW: "Mới bắt đầu", NONE: "—" };

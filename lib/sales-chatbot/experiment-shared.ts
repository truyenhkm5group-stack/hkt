/**
 * ═══════════ SO AI vs NGƯỜI THEO NHÁNH THỬ NGHIỆM + LỌC DRILL-DOWN — HÀM THUẦN, DÙNG ĐƯỢC Ở CLIENT ═══════════
 *
 * Thử nghiệm (operating-mode-shared.ts) chia hội thoại NGẪU NHIÊN theo băm và ghim nhánh vào `state.experiment` — nên hai
 * nhánh là hai nhóm so sánh được. Báo cáo đọc theo ý định điều trị (intent-to-treat): mọi đơn gắn với hội thoại của nhánh
 * đều tính cho nhánh ấy, kể cả khi hội thoại AI về sau được người chốt.
 *
 * Ba luật (đã thống nhất với chủ màn «Hiệu quả»):
 *  · kết cục đơn chỉ qua ORDER_OUTCOME (+ tập hoàn / ngã ngũ sinh từ OUTCOME_GROUP); huỷ không vào mẫu số giao thành công;
 *  · mẫu dưới `AI_SALES_MIN_SAMPLE` ⇒ tỷ lệ `null`, không in 0%;
 *  · nhánh NGƯỜI chỉ có đơn khi «AI ghi đơn hộ nhân viên» (order-sync) BẬT — tắt ⇒ đơn nhánh người là CHƯA ĐO, không phải 0
 *    (nếu không, AI thắng giả). Luôn in độ phủ: bao nhiêu hội thoại nhánh người có đường ghi đơn.
 */
import { LOST_REASONS, type LostReason } from "@/lib/sales-chatbot/lost-reasons-shared";
import { AI_SALES_MIN_SAMPLE, rateOrNull } from "@/lib/sales-chatbot/performance-shared";

export type ArmRaw = { conversations: number; orders: number; ordersValueVnd: number; settled: number; delivered: number; deliveredRevenueVnd: number };

export type ArmStats = {
  conversations: number;
  /** `null` = CHƯA ĐO (không có đường ghi đơn cho nhánh này). */
  orders: number | null;
  delivered: number | null;
  deliveredRevenueVnd: number | null;
  /** đơn / hội thoại */
  conversion: number | null;
  /** đơn giao thành công / hội thoại */
  deliveredConversion: number | null;
  /** giao thành công / đơn đã ngã ngũ */
  deliveryRate: number | null;
  aovVnd: number | null;
  deliveredAovVnd: number | null;
  /** Hội thoại của nhánh có đường ghi đơn (độ phủ). */
  measurableConversations: number;
  note: string | null;
};

/** Số của một nhánh. `measurable` = số hội thoại có đường ghi đơn; 0 ⇒ mọi số đơn `null`. HÀM THUẦN. */
export function armStats(raw: ArmRaw, measurable: number, note: string | null = null): ArmStats {
  if (measurable <= 0) {
    return { conversations: raw.conversations, orders: null, delivered: null, deliveredRevenueVnd: null, conversion: null, deliveredConversion: null, deliveryRate: null, aovVnd: null, deliveredAovVnd: null, measurableConversations: 0, note };
  }
  return {
    conversations: raw.conversations,
    orders: raw.orders,
    delivered: raw.delivered,
    deliveredRevenueVnd: raw.deliveredRevenueVnd,
    conversion: rateOrNull(raw.orders, measurable),
    deliveredConversion: rateOrNull(raw.delivered, measurable),
    deliveryRate: rateOrNull(raw.delivered, raw.settled, 1),
    aovVnd: raw.orders > 0 ? Math.round(raw.ordersValueVnd / raw.orders) : null,
    deliveredAovVnd: raw.delivered > 0 ? Math.round(raw.deliveredRevenueVnd / raw.delivered) : null,
    measurableConversations: measurable,
    note,
  };
}

/** Chênh lệch AI − người của một tỷ lệ; `null` khi một bên chưa đủ mẫu. Không bao giờ "AI thắng" khi một bên chưa đo. */
export function liftOrNull(ai: number | null, human: number | null): number | null {
  return ai === null || human === null ? null : ai - human;
}

export const MIN_ARM_SAMPLE = AI_SALES_MIN_SAMPLE;

// ─────────────────────────── Lọc drill-down từ ô KPI ───────────────────────────

export const DRILL_COHORTS = ["AI_ONLY", "AI_THEN_HUMAN"] as const;
export type DrillCohort = (typeof DRILL_COHORTS)[number];
export const DRILL_ARMS = ["AI", "HUMAN"] as const;
export type DrillArm = (typeof DRILL_ARMS)[number];

export type DrillFilter = { days: number; cohort: DrillCohort | null; reason: string | null; arm: DrillArm | null; confirmed: boolean; /** Lý do không mua (`lost-reasons-shared.ts`). */ lost?: LostReason | null };

export const DRILL_PERIODS = [7, 30, 90] as const;

/** Đọc bộ lọc từ searchParams — giá trị lạ bị bỏ, không đoán. HÀM THUẦN. */
export function parseDrillFilter(sp: Record<string, string | string[] | undefined>): DrillFilter {
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : null);
  const days = (DRILL_PERIODS as readonly number[]).includes(Number(one("days"))) ? Number(one("days")) : 30;
  const cohort = (DRILL_COHORTS as readonly string[]).includes(one("cohort") ?? "") ? (one("cohort") as DrillCohort) : null;
  const arm = (DRILL_ARMS as readonly string[]).includes(one("arm") ?? "") ? (one("arm") as DrillArm) : null;
  const reason = one("reason");
  const lost = (LOST_REASONS as readonly string[]).includes(one("lost") ?? "") ? (one("lost") as LostReason) : null;
  return { days, cohort, arm, reason: reason && /^[A-Z_]{2,40}$/.test(reason) ? reason : null, confirmed: one("confirmed") === "1", lost };
}

export function drillHref(f: Partial<DrillFilter>): string {
  const q = new URLSearchParams();
  if (f.days) q.set("days", String(f.days));
  if (f.cohort) q.set("cohort", f.cohort);
  if (f.reason) q.set("reason", f.reason);
  if (f.arm) q.set("arm", f.arm);
  if (f.confirmed) q.set("confirmed", "1");
  if (f.lost) q.set("lost", f.lost);
  const s = q.toString();
  return `/ai/sales-chatbot/conversations${s ? `?${s}` : ""}`;
}

/** Che SĐT trong chữ hội thoại cho màn xem lại: giữ 3 số cuối. HÀM THUẦN. */
export function maskPhones(text: string): string {
  return text.replace(/(?<!\d)(\+?84|0)[\s.-]?(\d[\s.-]?){6,9}(\d{3})(?!\d)/g, (_m, _p, _mid, tail: string) => `••••${tail}`);
}

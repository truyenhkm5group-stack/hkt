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
 *
 * LỢI NHUẬN (Master Mission P0.5 + P1.7, 08/10/2026 — docs/revenue-attribution.md mục 7):
 *  · LÃI GỘP ĐÃ GIAO cộng bằng `orderRow` (attribution-shared.ts) — ĐÚNG luật của bảng quy kết theo nhãn: giá vốn đường chung
 *    của Báo cáo lợi nhuận; đơn giao có doanh thu mà giá vốn 0 = CHƯA BIẾT, đứng riêng, không cộng vào lãi.
 *  · Lãi CHƯA ĐỦ (còn đơn chưa có giá vốn) thì KHÔNG chia cho hội thoại, KHÔNG trừ chi phí AI, KHÔNG so hai nhánh — nhánh thiếu
 *    giá vốn trông nghèo (hoặc giàu) hơn thật và bên kia «thắng» giả. Tổng lãi gộp vẫn in (như #646) kèm số đơn thiếu giá vốn.
 *  · CHI PHÍ AI (ƯỚC TÍNH) chỉ có khi người xem được thấy tiền AI; còn lượt chưa định giá ⇒ chi phí là CẬN DƯỚI, lãi sau AI là
 *    CẬN TRÊN — in ra, không giấu.
 *  · Thử nghiệm đã DỪNG ⇒ không so chênh lệch LÃI (`STOPPED_LIFT_REASON` — chưa có mốc dừng); số từng nhánh vẫn in.
 */
import { formatNumber } from "@/lib/format";
import { grossMarginOf, orderRow, type OrderFacts } from "@/lib/sales-chatbot/attribution-shared";
import { LOST_REASONS, type LostReason } from "@/lib/sales-chatbot/lost-reasons-shared";
import { AI_SALES_MIN_SAMPLE, rateOrNull } from "@/lib/sales-chatbot/performance-shared";

export type ArmRaw = {
  conversations: number;
  orders: number;
  ordersValueVnd: number;
  settled: number;
  delivered: number;
  deliveredRevenueVnd: number;
  /** Lãi gộp đã giao CHỈ trên đơn biết giá vốn + doanh thu của chính các đơn ấy (mẫu số của biên gộp). */
  grossProfitVnd: number;
  costedRevenueVnd: number;
  /** Đơn đã giao CHƯA có giá vốn + doanh thu của chúng — đứng riêng, không cộng vào lãi với giá vốn 0. */
  cogsUnknown: number;
  cogsUnknownRevenueVnd: number;
};

/** Số thô của MỘT nhánh từ TỪNG đơn của nó — cộng bằng `orderRow`, đúng một luật với bảng quy kết theo nhãn (#646). HÀM THUẦN. */
export function armRaw(conversations: number, orders: readonly OrderFacts[]): ArmRaw {
  const r = orderRow(orders);
  return {
    conversations,
    orders: r.orders,
    ordersValueVnd: r.valueVnd,
    settled: r.settled,
    delivered: r.delivered,
    deliveredRevenueVnd: r.deliveredRevenueVnd,
    grossProfitVnd: r.grossProfitVnd,
    costedRevenueVnd: r.costedRevenueVnd,
    cogsUnknown: r.cogsUnknown,
    cogsUnknownRevenueVnd: r.cogsUnknownRevenueVnd,
  };
}

/** Tiền AI (ƯỚC TÍNH) của các hội thoại thuộc nhánh — máy chủ đọc qua lib/ai-usage/conversation-cost.ts. */
export type ArmAiCost = { costVnd: number | null; turns: number; unknownTurns: number };

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
  /** Lãi gộp đã giao (chỉ đơn biết giá vốn). `null` = chưa đo, hoặc MỌI đơn đã giao có doanh thu đều chưa có giá vốn. */
  grossProfitVnd: number | null;
  /** Biên gộp — chỉ trên đơn biết giá vốn (`grossMarginOf`). */
  grossMargin: number | null;
  /** Đơn đã giao CHƯA có giá vốn + doanh thu của chúng (`null` = chưa đo). > 0 ⇒ lãi CHƯA ĐỦ. */
  cogsUnknown: number | null;
  cogsUnknownRevenueVnd: number | null;
  /** Lãi gộp / hội thoại đo được. `null` = dưới mẫu, hoặc lãi chưa đủ (còn đơn chưa có giá vốn — không chia). */
  grossProfitPerConversationVnd: number | null;
  /** Tiền AI ƯỚC TÍNH của các hội thoại thuộc nhánh. `null` = người xem không được thấy tiền AI, hoặc chưa lượt nào định giá. */
  aiCostVnd: number | null;
  /** Lượt AI của nhánh · lượt CHƯA định giá (> 0 ⇒ chi phí là CẬN DƯỚI). `null` = người xem không được thấy tiền AI. */
  aiTurns: number | null;
  aiUnknownTurns: number | null;
  /** Lãi gộp − chi phí AI (ƯỚC TÍNH; chi phí là cận dưới ⇒ đây là CẬN TRÊN). `null` khi một vế chưa có hoặc lãi chưa đủ. */
  profitAfterAiVnd: number | null;
  profitAfterAiPerConversationVnd: number | null;
};

/**
 * Số của một nhánh. `measurable` = số hội thoại có đường ghi đơn; 0 ⇒ mọi số đơn / lãi `null`. `ai` = tiền AI của nhánh,
 * `null` khi người xem không được thấy tiền AI (khi đó máy chủ không đọc sổ AI). HÀM THUẦN.
 */
export function armStats(raw: ArmRaw, measurable: number, note: string | null = null, ai: ArmAiCost | null = null): ArmStats {
  const money = { aiCostVnd: ai ? ai.costVnd : null, aiTurns: ai ? ai.turns : null, aiUnknownTurns: ai ? ai.unknownTurns : null };
  if (measurable <= 0) {
    return {
      conversations: raw.conversations,
      orders: null,
      delivered: null,
      deliveredRevenueVnd: null,
      conversion: null,
      deliveredConversion: null,
      deliveryRate: null,
      aovVnd: null,
      deliveredAovVnd: null,
      measurableConversations: 0,
      note,
      grossProfitVnd: null,
      grossMargin: null,
      cogsUnknown: null,
      cogsUnknownRevenueVnd: null,
      grossProfitPerConversationVnd: null,
      ...money,
      profitAfterAiVnd: null,
      profitAfterAiPerConversationVnd: null,
    };
  }
  // Lãi ĐỦ = không còn đơn đã giao nào chưa có giá vốn. Chưa đủ ⇒ tổng vẫn in (như bảng quy kết), mọi phép dẫn xuất thì không.
  const complete = raw.cogsUnknown === 0;
  const grossProfitVnd = raw.cogsUnknown > 0 && raw.costedRevenueVnd === 0 ? null : raw.grossProfitVnd;
  const perConversation = (v: number | null): number | null => {
    const r = v === null || !complete ? null : rateOrNull(v, measurable);
    return r === null ? null : Math.round(r);
  };
  const profitAfterAiVnd = complete && grossProfitVnd !== null && money.aiCostVnd !== null ? grossProfitVnd - money.aiCostVnd : null;
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
    grossProfitVnd,
    grossMargin: grossMarginOf(raw),
    cogsUnknown: raw.cogsUnknown,
    cogsUnknownRevenueVnd: raw.cogsUnknownRevenueVnd,
    grossProfitPerConversationVnd: perConversation(grossProfitVnd),
    ...money,
    profitAfterAiVnd,
    profitAfterAiPerConversationVnd: perConversation(profitAfterAiVnd),
  };
}

/** Chênh lệch AI − người của một tỷ lệ; `null` khi một bên chưa đủ mẫu. Không bao giờ "AI thắng" khi một bên chưa đo. */
export function liftOrNull(ai: number | null, human: number | null): number | null {
  return ai === null || human === null ? null : ai - human;
}

/** Chiều của chênh lệch «lãi sau AI»: `UPPER` = chênh lệch thật ≤ số in · `LOWER` = chênh lệch thật ≥ số in. */
export type LiftBound = "EXACT" | "UPPER" | "LOWER";

/** Một chênh lệch LÃI AI − người. `reason` = lý do ở cấp KHỐI khiến ô trống (lý do của từng nhánh in dưới ô của nhánh đó). */
export type ProfitLift = { value: number | null; bound: LiftBound; reason: string | null };

/**
 * Thử nghiệm đã DỪNG (chế độ rời EXPERIMENT, khoá giữ nguyên): `replyGate` thôi chia nhánh — bot trả lời cả hội thoại từng thuộc
 * nhánh người — mà ERP CHƯA LƯU mốc dừng (`stoppedAt`), nên đơn (không mốc trên) và tiền AI (chỉ có mốc dưới) sau lúc dừng vẫn
 * cộng vào nhánh. Hai nhóm không còn là hai nhóm chia ngẫu nhiên ⇒ không so chênh lệch LÃI; số từng nhánh vẫn in.
 */
export const STOPPED_LIFT_REASON = "Thử nghiệm đã dừng — đơn và tiền AI sau lúc dừng vẫn cộng vào nhánh, không so chênh lệch";

const stoppedLift = (): ProfitLift => ({ value: null, bound: "EXACT", reason: STOPPED_LIFT_REASON });

/** Chênh lệch AI − người của «lãi gộp / hội thoại» (`liftOrNull`). Thử nghiệm đã dừng ⇒ `null` + lý do. HÀM THUẦN. */
export function grossProfitLift(ai: ArmStats, human: ArmStats, running: boolean): ProfitLift {
  if (!running) return stoppedLift();
  return { value: liftOrNull(ai.grossProfitPerConversationVnd, human.grossProfitPerConversationVnd), bound: "EXACT", reason: null };
}

/**
 * Chênh lệch AI − người của «lãi sau AI / hội thoại» (`liftOrNull` — một bên chưa đo / dưới mẫu ⇒ `null`). Chi phí AI một bên
 * là CẬN DƯỚI ⇒ lãi bên đó là CẬN TRÊN ⇒ chênh lệch là cận TRÊN (bên AI) / cận DƯỚI (bên người). CẢ HAI bên cận dưới ⇒ không
 * có chiều nào chắc ⇒ `null`. Thử nghiệm đã dừng ⇒ `null` + lý do. HÀM THUẦN.
 */
export function profitAfterAiLift(ai: ArmStats, human: ArmStats, running: boolean): ProfitLift {
  if (!running) return stoppedLift();
  const value = liftOrNull(ai.profitAfterAiPerConversationVnd, human.profitAfterAiPerConversationVnd);
  const aiLow = aiCostIsLowerBound(ai);
  const humanLow = aiCostIsLowerBound(human);
  if (value === null || (aiLow && humanLow)) return { value: null, bound: "EXACT", reason: null };
  return { value, bound: aiLow ? "UPPER" : humanLow ? "LOWER" : "EXACT", reason: null };
}

/** Chi phí AI CÓ SỐ mà còn lượt chưa định giá ⇒ CẬN DƯỚI. Ô «—» (chưa lượt nào định giá) không có gì để làm cận. HÀM THUẦN. */
export function aiCostIsLowerBound(a: Pick<ArmStats, "aiCostVnd" | "aiUnknownTurns">): boolean {
  return a.aiCostVnd !== null && (a.aiUnknownTurns ?? 0) > 0;
}

/** Dòng phụ của ô chi phí AI: «cận dưới» CHỈ đứng cạnh một con số; ô «—» chỉ nói số lượt chưa định giá. `null` = không xem tiền. HÀM THUẦN. */
export function aiCostNote(a: Pick<ArmStats, "aiCostVnd" | "aiTurns" | "aiUnknownTurns">): string | null {
  if (a.aiTurns === null) return null;
  const unknown = a.aiUnknownTurns ?? 0;
  if (aiCostIsLowerBound(a)) return `cận dưới · ${formatNumber(unknown)} lượt chưa định giá`;
  return unknown > 0 ? `${formatNumber(unknown)} lượt chưa định giá` : `${formatNumber(a.aiTurns)} lượt`;
}

export const MIN_ARM_SAMPLE = AI_SALES_MIN_SAMPLE;

// ─────────────────────────── Lọc drill-down từ ô KPI ───────────────────────────

export const DRILL_COHORTS = ["AI_ONLY", "AI_THEN_HUMAN"] as const;
export type DrillCohort = (typeof DRILL_COHORTS)[number];
export const DRILL_ARMS = ["AI", "HUMAN"] as const;
export type DrillArm = (typeof DRILL_ARMS)[number];

export type DrillFilter = { days: number; cohort: DrillCohort | null; reason: string | null; arm: DrillArm | null; confirmed: boolean; /** Lý do không mua (`lost-reasons-shared.ts`). */ lost?: LostReason | null; /** Một page (chiều lọc của shop nhiều page). */ page?: string | null };

export const DRILL_PERIODS = [7, 30, 90] as const;

/** Đọc bộ lọc từ searchParams — giá trị lạ bị bỏ, không đoán. HÀM THUẦN. */
export function parseDrillFilter(sp: Record<string, string | string[] | undefined>): DrillFilter {
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : null);
  const days = (DRILL_PERIODS as readonly number[]).includes(Number(one("days"))) ? Number(one("days")) : 30;
  const cohort = (DRILL_COHORTS as readonly string[]).includes(one("cohort") ?? "") ? (one("cohort") as DrillCohort) : null;
  const arm = (DRILL_ARMS as readonly string[]).includes(one("arm") ?? "") ? (one("arm") as DrillArm) : null;
  const reason = one("reason");
  const lost = (LOST_REASONS as readonly string[]).includes(one("lost") ?? "") ? (one("lost") as LostReason) : null;
  const pg = one("pg");
  return { days, cohort, arm, reason: reason && /^[A-Z_]{2,40}$/.test(reason) ? reason : null, confirmed: one("confirmed") === "1", lost, page: pg && /^[A-Za-z0-9_:.-]{1,80}$/.test(pg) ? pg : null };
}

export function drillHref(f: Partial<DrillFilter>): string {
  const q = new URLSearchParams();
  if (f.days) q.set("days", String(f.days));
  if (f.cohort) q.set("cohort", f.cohort);
  if (f.reason) q.set("reason", f.reason);
  if (f.arm) q.set("arm", f.arm);
  if (f.confirmed) q.set("confirmed", "1");
  if (f.lost) q.set("lost", f.lost);
  if (f.page) q.set("pg", f.page);
  const s = q.toString();
  return `/ai/sales-chatbot/conversations${s ? `?${s}` : ""}`;
}

/** Che SĐT trong chữ hội thoại cho màn xem lại: giữ 3 số cuối. HÀM THUẦN. */
export function maskPhones(text: string): string {
  return text.replace(/(?<!\d)(\+?84|0)[\s.-]?(\d[\s.-]?){6,9}(\d{3})(?!\d)/g, (_m, _p, _mid, tail: string) => `••••${tail}`);
}

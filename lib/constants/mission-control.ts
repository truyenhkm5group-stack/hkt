import { z } from "zod";
import { AGENT_ZONES, type AgentZone } from "@/lib/constants/department-ai";
import type { AiUsageFeature } from "@/lib/ai-usage/types";
import type { OwnerDecisionKind } from "@/lib/constants/owner-decisions";

/**
 * ═══════════ MISSION CONTROL — ĐO CÁC AI AGENT ĐANG CÓ (chủ shop 30/10/2026) ═══════════
 *
 * Danh sách agent KHÔNG khai ở đây: nó là `AGENTS` của `lib/constants/department-ai.ts` (sổ khai DUY NHẤT, luật 69). Tệp này chỉ
 * khai, CHO TỪNG KHOÁ của sổ ấy (`Record<AgentZone, …>` — thiếu / thừa một khoá là lỗi biên dịch), ĐO BẰNG NGUỒN NÀO:
 *  · lượt / token / chi phí AI — tính năng nào của sổ dùng AI (`platform_ai_usage.feature`); phòng chạy bằng LUẬT, không gọi mô hình,
 *    thì in «không dùng mô hình AI» (KHÔNG ÁP DỤNG), khác hẳn «chưa đo được»;
 *  · tỷ lệ NGƯỜI DUYỆT / BÁC — nguồn có thật nào ghi phản ứng của người với việc máy làm; chưa có ⇒ `NONE` + thiếu gì (luật 37/39);
 *  · kết quả bằng TIỀN THẬT — chỉ nơi có (bot bán hàng: đơn GIAO THÀNH CÔNG theo ORDER_OUTCOME + VERIFIED_CASH).
 *
 * ĐIỀU KIỆN «TỐT NGHIỆP» lên tự động là QUYẾT ĐỊNH KINH DOANH (luật 38/43): KHÔNG có bộ mặc định. Chưa khai ⇒ hiện thực tế, không kết
 * luận. Khai rồi ⇒ «đủ / chưa đủ điều kiện» chỉ khi đủ mẫu. Màn hình KHÔNG BAO GIỜ tự đổi nấc tự chủ: đổi nấc là người quyết + sửa sổ
 * department-ai + deploy (luật 69).
 */

export const MC_GRADUATION_KEY = "missionControl.graduation";

/** Cửa sổ HIỂN THỊ (không phải ngưỡng): hai mốc chủ shop yêu cầu đọc. */
export const MC_WINDOWS = [7, 30] as const;

export type ReviewSpec =
  /** Bot bán hàng: đơn «AI tự bán» đã ngã ngũ — ĐÚNG = không bị huỷ. Nguồn: quy kết của màn «Hiệu quả» (attribution.ts). */
  | { kind: "BOT_ORDERS"; definition: string; missingPart: string }
  /** Đề xuất của buồng lái: phản ứng MỚI NHẤT của người (`recommendation_decisions`) — ĐÚNG = chấp nhận; bỏ qua = bác; nhắc lại sau không vào mẫu. */
  | { kind: "OWNER_DECISIONS"; decisionKinds: OwnerDecisionKind[]; definition: string }
  /** Phòng Tech AI: PR của việc agent cầm đã khép — ĐÚNG = đã gộp; đóng không gộp = bác. */
  | { kind: "TECH_PRS"; definition: string }
  | { kind: "NONE"; missing: string };

export type OutcomeSpec = { kind: "BOT_CASH"; definition: string } | { kind: "NONE"; missing: string };

export type ZoneMeasure = {
  /** Tính năng của sổ dùng AI thuộc agent này. Rỗng ⇒ `usageNone` nói vì sao (không phải «chưa đo»). */
  usageFeatures: AiUsageFeature[];
  usageNone?: string;
  /** Khối lượng việc máy làm có nguồn riêng ngoài /work (vd care mở ca). */
  volume?: { kind: "CARE_MACHINE_EPISODES"; label: string };
  review: ReviewSpec;
  outcome: OutcomeSpec;
};

const RULE_ONLY = "Phòng này chạy bằng LUẬT trong mã (không gọi mô hình AI) — không có lượt / token để đo.";

export const MC_MEASURES: Record<AgentZone, ZoneMeasure> = {
  SALES: {
    // Bot bán hàng trên fanpage + học từ hội thoại cũ + lời chào khách sỉ — cùng phòng Kinh doanh & CSKH.
    usageFeatures: ["sales_chatbot", "sales_playbook", "lead_hunter"],
    review: {
      kind: "BOT_ORDERS",
      definition: "Đơn «AI tự bán» (quy kết của màn Hiệu quả AI bán hàng) đã ngã ngũ trong kỳ; ĐÚNG = không bị huỷ, BÁC = bị huỷ.",
      missingPart: "Phần SỬA chưa đo được: ERP chưa ghi lượt người sửa đơn bot lên (không có sự kiện «order.edited»).",
    },
    outcome: { kind: "BOT_CASH", definition: "Đơn «AI tự bán» + «AI góp công» GIAO THÀNH CÔNG (ORDER_OUTCOME) trong kỳ, tiền = VERIFIED_CASH (COD thực thu + chuyển khoản có ghi nhận)." },
  },
  MARKETING: {
    usageFeatures: ["creative_image", "creative_copy"],
    review: { kind: "OWNER_DECISIONS", decisionKinds: ["ADS_CUT", "SCALE_STOCK_RISK", "STOCK_PUSH"], definition: "Đề xuất quảng cáo của buồng lái (cắt · rủi ro tồn khi tăng · đẩy tồn); ĐÚNG = người chấp nhận, BÁC = bỏ qua." },
    outcome: { kind: "NONE", missing: "Chưa nối được đề xuất ĐÃ CHẤP NHẬN với tiền quảng cáo tiết kiệm / doanh thu giao thành công sau đó — cần ảnh chụp chi tiêu trước/sau cho từng đề xuất." },
  },
  LOGISTICS: {
    usageFeatures: [],
    usageNone: RULE_ONLY,
    volume: { kind: "CARE_MACHINE_EPISODES", label: "Ca care máy tự mở" },
    review: { kind: "NONE", missing: "Chưa ghi được NGƯỜI BÁC một ca máy mở: đóng ca không có lý do «mở nhầm» riêng (shipment_care chỉ có kết cục giao / hoàn)." },
    outcome: { kind: "NONE", missing: "«Cứu được» là kết cục ĐVVC, không phải công của máy (luật 56) — chưa có phép so có / không có care." },
  },
  WAREHOUSE: {
    usageFeatures: [],
    usageNone: RULE_ONLY,
    review: { kind: "OWNER_DECISIONS", decisionKinds: ["INVENTORY_STOCKOUT", "INVENTORY_REORDER", "INVENTORY_CLEARANCE"], definition: "Đề xuất vốn tồn của buồng lái (sắp hết · đặt lại · xả); ĐÚNG = người chấp nhận, BÁC = bỏ qua." },
    outcome: { kind: "NONE", missing: "Chưa đo tiền vốn tồn giải phóng / doanh thu giữ được sau đề xuất — cần ảnh chụp tồn trước/sau." },
  },
  PRODUCTION: {
    usageFeatures: ["sourcing"],
    review: { kind: "OWNER_DECISIONS", decisionKinds: ["MODEL_SCALE", "MODEL_EARLY_TOPIC", "PRODUCTION_LATE"], definition: "Tín hiệu mẫu / lệnh sản xuất trễ của buồng lái; ĐÚNG = người chấp nhận, BÁC = bỏ qua." },
    outcome: { kind: "NONE", missing: "Chưa nối tín hiệu mẫu ĐÃ CHẤP NHẬN với doanh thu giao thành công của mẫu ấy sau đó." },
  },
  FINANCE: {
    usageFeatures: [],
    usageNone: RULE_ONLY,
    review: { kind: "NONE", missing: "Phân loại dòng tiền tự động không ghi phản ứng của người (giữ / sửa nhãn) thành một bảng đo được." },
    outcome: { kind: "NONE", missing: "Không áp dụng tiền kết quả: AI không ghi vào tiền (RISK_FLOOR)." },
  },
  MANAGEMENT: {
    usageFeatures: ["copilot", "ai_builder"],
    review: { kind: "NONE", missing: "Lượt tool ghi có xác nhận của Copilot chưa lưu kết quả NGƯỜI bấm đồng ý / huỷ — cần sổ phản ứng cho từng đề nghị." },
    outcome: { kind: "NONE", missing: "Copilot trả lời câu hỏi, không sinh tiền trực tiếp — chưa có định nghĩa kết quả bằng tiền." },
  },
  HR: {
    usageFeatures: [],
    usageNone: "Phòng Nhân sự chưa có agent (sổ department-ai khai name = null) — không có lượt AI để đo.",
    review: { kind: "NONE", missing: "Chưa có agent nên chưa có việc máy làm để người duyệt." },
    outcome: { kind: "NONE", missing: "Chưa có agent." },
  },
  SYSTEM: {
    usageFeatures: [],
    usageNone: "Agent Phòng Tech chạy ngoài ERP (Claude Code) — lượt / token của nó KHÔNG ghi vào platform_ai_usage; chưa có sổ chi phí để đọc.",
    review: { kind: "TECH_PRS", definition: "Việc Tech có agent cầm và có PR đã khép trong kỳ; ĐÚNG = PR đã gộp, BÁC = PR đóng không gộp." },
    outcome: { kind: "NONE", missing: "Giá trị một PR không quy được ra tiền thật." },
  },
};

export const MC_ZONES: AgentZone[] = AGENT_ZONES;

/** Một chỉ số: ĐO ĐƯỢC (có số, kể cả 0 thật) · CHƯA ĐO ĐƯỢC (thiếu gì) · KHÔNG ÁP DỤNG. Không bao giờ «0 vì không biết» (luật 42). */
export type McMetric = { state: "MEASURED"; value: number } | { state: "UNAVAILABLE"; missing: string } | { state: "NOT_APPLICABLE"; why: string };

/** Mẫu đúng / bác của một agent trong một cửa sổ. `correct + rejected = sample`. */
export type ReviewSample = { correct: number; rejected: number; sample: number };

export function accuracyOf(r: ReviewSample | null): number | null {
  if (!r || r.sample <= 0) return null;
  return r.correct / r.sample;
}

// ─────────────────────────── ĐIỀU KIỆN TỐT NGHIỆP ───────────────────────────

export type GraduationRule = { minAccuracyPct: number; minSamples: number; windowDays: number };

export const graduationRuleZ = z
  .object({
    minAccuracyPct: z.number({ error: "Nhập tỷ lệ đúng tối thiểu" }).min(1, "Tỷ lệ 1–100%").max(100, "Tỷ lệ 1–100%"),
    minSamples: z.number({ error: "Nhập số mẫu tối thiểu" }).int("Số mẫu là số nguyên").min(1, "Ít nhất 1 mẫu").max(100_000),
    windowDays: z.number({ error: "Nhập cửa sổ ngày" }).int("Số ngày là số nguyên").min(1, "Cửa sổ 1–180 ngày").max(180, "Cửa sổ 1–180 ngày"),
  })
  .strict();

/** Đọc settings THẬN TRỌNG: khoá lạ / giá trị hỏng bị BỎ (không đoán, không mặc định). HÀM THUẦN. */
export function parseGraduation(value: unknown): Partial<Record<AgentZone, GraduationRule>> {
  const out: Partial<Record<AgentZone, GraduationRule>> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const zone of MC_ZONES) {
    const parsed = graduationRuleZ.safeParse((value as Record<string, unknown>)[zone]);
    if (parsed.success) out[zone] = parsed.data;
  }
  return out;
}

export type GraduationVerdict =
  | { kind: "NO_RULE" }
  | { kind: "NOT_MEASURABLE"; missing: string }
  | { kind: "INSUFFICIENT_SAMPLE"; sample: number; need: number }
  | { kind: "PASS" | "FAIL"; accuracy: number; sample: number; need: number; minAccuracyPct: number };

export const GRADUATION_VERDICT_LABEL: Record<GraduationVerdict["kind"], string> = {
  NO_RULE: "Chưa khai điều kiện — chỉ hiện số thực tế, không kết luận",
  NOT_MEASURABLE: "Chưa đo được tỷ lệ đúng — không kết luận",
  INSUFFICIENT_SAMPLE: "Chưa đủ mẫu — không kết luận",
  PASS: "Đủ điều kiện (người quyết đổi nấc)",
  FAIL: "Chưa đủ điều kiện",
};

/**
 * Kết luận tốt nghiệp: chỉ khi CÓ luật (do chủ shop khai), ĐO ĐƯỢC tỷ lệ đúng và ĐỦ MẪU. Không bao giờ đổi nấc tự chủ. HÀM THUẦN.
 */
export function graduationVerdict(rule: GraduationRule | undefined, review: ReviewSample | null, missing = "chưa có nguồn ghi phản ứng của người"): GraduationVerdict {
  if (!rule) return { kind: "NO_RULE" };
  if (!review) return { kind: "NOT_MEASURABLE", missing };
  if (review.sample < rule.minSamples) return { kind: "INSUFFICIENT_SAMPLE", sample: review.sample, need: rule.minSamples };
  const accuracy = review.correct / review.sample;
  return { kind: accuracy * 100 >= rule.minAccuracyPct ? "PASS" : "FAIL", accuracy, sample: review.sample, need: rule.minSamples, minAccuracyPct: rule.minAccuracyPct };
}

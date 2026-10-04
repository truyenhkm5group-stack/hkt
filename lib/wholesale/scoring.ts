import { type LeadSegment, LEAD_SEGMENT_LABEL, SEGMENT_POINTS } from "@/lib/wholesale/segments";
import type { PhoneKind } from "@/lib/wholesale/phone";

/**
 * ═══════════ CHẤM ĐIỂM LEAD KHÁCH SỈ — HÀM THUẦN, XÁC ĐỊNH ═══════════
 *
 * Điểm 0–100 = TỔNG sáu thành phần có trần, mỗi thành phần đọc ĐÚNG chứng cứ có trong dữ liệu:
 *
 *   PHÙ HỢP NGÀNH   0–30  nhóm khách (segments.ts) — khả năng cần nhập hải sản / thực phẩm thường xuyên
 *   Ý ĐỊNH MUA      0–15  nhóm ưu tiên của HSLC (hải sản, lẩu, nướng, buffet, tiệc cao nhất)
 *   QUY MÔ          0–20  số đánh giá, dấu hiệu chuỗi / nhiều chi nhánh
 *   LIÊN HỆ ĐƯỢC    0–15  SĐT (di động > cố định > tổng đài), website, email / mạng xã hội công khai
 *   VỊ TRÍ          0–10  tỉnh nằm trong vùng HSLC phục vụ được (cấu hình)
 *   CHẤT LƯỢNG      0–10  đang hoạt động, đánh giá sao, dữ liệu đủ
 *   (HỌC TỪ KẾT QUẢ ±5    chỉ khi nhóm đã đủ mẫu lead đi tới kết cục — xem `learnedAdjustment`)
 *
 * KHÔNG chấm bằng sao đơn thuần: sao chỉ góp tối đa 2 điểm. KHÔNG có LLM trong phép tính: cùng dữ
 * liệu ⇒ cùng điểm, cùng lý do. Thiếu dữ liệu ⇒ thành phần đó 0 điểm VÀ lý do nói rõ «chưa có», không
 * suy ra (AGENTS mục 42: chưa biết không phải 0 — ở đây «0 điểm vì chưa biết» được in thành chữ).
 */

export const LEAD_GRADES = ["A", "B", "C", "D"] as const;
export type LeadGrade = (typeof LEAD_GRADES)[number];

/** Ngưỡng hạng do chủ shop khai (A ≥ 80, B ≥ 65, C ≥ 45, còn lại D); ghi đè ở cấu hình module. */
export type GradeThresholds = { A: number; B: number; C: number };
export const DEFAULT_GRADE_THRESHOLDS: GradeThresholds = { A: 80, B: 65, C: 45 };

export function gradeOf(score: number, t: GradeThresholds = DEFAULT_GRADE_THRESHOLDS): LeadGrade {
  if (score >= t.A) return "A";
  if (score >= t.B) return "B";
  if (score >= t.C) return "C";
  return "D";
}

export type ServiceAreaLevel = "PRIORITY" | "SERVED";
/** Khoá tỉnh đã chuẩn hoá (`normalizeProvince`) ⇒ mức phục vụ. Tỉnh không có trong bảng = ngoài vùng. */
export type ServiceAreas = Record<string, ServiceAreaLevel>;

export type ScoreInput = {
  segment: LeadSegment;
  segmentEvidence?: string | null;
  reviewCount: number | null;
  rating: number | null;
  businessStatus: string | null;
  phoneKind: PhoneKind | null;
  hasWebsite: boolean;
  /** Có email doanh nghiệp / Facebook / Zalo công khai (từ website của chính doanh nghiệp). */
  hasOtherChannel: boolean;
  /** Khoá tỉnh chuẩn hoá; `null` = chưa rõ tỉnh. */
  provinceKey: string | null;
  provinceLabel?: string | null;
  /** Số lead khác cùng tên miền website / cùng tên chuỗi — dấu hiệu nhiều chi nhánh. */
  siblingCount: number;
  /** Tên có «chi nhánh», «cơ sở 2»… */
  branchHint: boolean;
  hasAddress: boolean;
  hasName: boolean;
};

export type ScoreComponentKey = "categoryFit" | "purchaseIntent" | "scale" | "contactability" | "location" | "quality" | "learned";
export type ScoreComponent = { key: ScoreComponentKey; label: string; points: number; max: number; reason: string };

export type ScoreResult = {
  score: number;
  grade: LeadGrade;
  components: ScoreComponent[];
  /** Một câu cho người bán đọc — ghép từ chứng cứ, không thêm thông tin nào ngoài dữ liệu. */
  summary: string;
};

export const SCORE_COMPONENT_LABEL: Record<ScoreComponentKey, string> = {
  categoryFit: "Phù hợp ngành",
  purchaseIntent: "Ý định mua",
  scale: "Quy mô",
  contactability: "Liên hệ được",
  location: "Vị trí",
  quality: "Chất lượng dữ liệu",
  learned: "Học từ kết quả bán",
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function scalePoints(input: ScoreInput): { points: number; reason: string } {
  const r = input.reviewCount;
  let points = 0;
  let reason: string;
  if (r == null) reason = "chưa có số đánh giá";
  else {
    points = r >= 1000 ? 14 : r >= 500 ? 12 : r >= 200 ? 10 : r >= 100 ? 8 : r >= 30 ? 5 : r >= 1 ? 2 : 0;
    reason = `${r.toLocaleString("vi-VN")} đánh giá`;
  }
  if (input.siblingCount > 0 || input.branchHint) {
    points += 4;
    reason += input.siblingCount > 0 ? ` · có ${input.siblingCount + 1} điểm cùng thương hiệu` : " · tên cho thấy có nhiều chi nhánh";
  }
  if (input.segment === "HOTEL_RESORT" || input.segment === "CATERING" || input.segment === "BUFFET") {
    points += 2;
    reason += " · loại hình phục vụ số lượng lớn";
  }
  return { points: clamp(points, 0, 20), reason };
}

function contactPoints(input: ScoreInput): { points: number; reason: string } {
  const parts: string[] = [];
  let points = 0;
  if (input.phoneKind === "MOBILE") {
    points += 10;
    parts.push("có SĐT di động");
  } else if (input.phoneKind === "LANDLINE") {
    points += 8;
    parts.push("có SĐT cố định");
  } else if (input.phoneKind === "SPECIAL") {
    points += 5;
    parts.push("chỉ có số tổng đài");
  } else parts.push("chưa có SĐT");
  if (input.hasWebsite) {
    points += 3;
    parts.push("có website");
  }
  if (input.hasOtherChannel) {
    points += 2;
    parts.push("có email / mạng xã hội công khai");
  }
  return { points: clamp(points, 0, 15), reason: parts.join(", ") };
}

function locationPoints(input: ScoreInput, areas: ServiceAreas): { points: number; reason: string } {
  const label = input.provinceLabel || input.provinceKey;
  if (!input.provinceKey) return { points: 3, reason: "chưa rõ tỉnh / thành" };
  const level = areas[input.provinceKey];
  if (level === "PRIORITY") return { points: 10, reason: `${label} — vùng ưu tiên phục vụ` };
  if (level === "SERVED") return { points: 6, reason: `${label} — trong vùng giao được` };
  return { points: 0, reason: `${label} — ngoài vùng phục vụ đã khai` };
}

function qualityPoints(input: ScoreInput): { points: number; reason: string } {
  const parts: string[] = [];
  let points = 0;
  if (input.businessStatus === "OPERATIONAL") {
    points += 6;
    parts.push("đang hoạt động");
  } else if (input.businessStatus == null || input.businessStatus === "") {
    points += 3;
    parts.push("chưa rõ trạng thái hoạt động");
  } else parts.push(input.businessStatus === "CLOSED_TEMPORARILY" ? "tạm đóng cửa" : `trạng thái ${input.businessStatus}`);
  if (input.rating != null) {
    if (input.rating >= 4) points += 2;
    else if (input.rating >= 3.5) points += 1;
    parts.push(`${input.rating.toFixed(1)}★`);
  }
  if (input.hasName && input.hasAddress && input.phoneKind && input.phoneKind !== "UNKNOWN" && input.segment !== "UNCLASSIFIED") {
    points += 2;
    parts.push("dữ liệu đủ");
  }
  return { points: clamp(points, 0, 10), reason: parts.join(", ") };
}

/**
 * ĐIỀU CHỈNH HỌC TỪ KẾT QUẢ BÁN (±5). Đầu vào là tỷ lệ chốt (WON / lead đã đi tới kết cục) của NHÓM
 * so với toàn bộ, đã làm trơn theo Bayes với `prior` lead giả định ở tỷ lệ chung — nhóm 1/1 thắng
 * không thành «tỷ lệ 100%». Dưới `minSample` kết cục ⇒ 0 và lý do nói rõ chưa đủ mẫu (luật 39).
 */
export type SegmentOutcomeStats = { segment: LeadSegment; resolved: number; won: number };
export type LearningConfig = { minSample: number; prior: number; maxAdjust: number };
export const DEFAULT_LEARNING: LearningConfig = { minSample: 20, prior: 10, maxAdjust: 5 };

export function learnedAdjustment(segment: LeadSegment, stats: readonly SegmentOutcomeStats[], cfg: LearningConfig = DEFAULT_LEARNING): { points: number; reason: string } {
  const totalResolved = stats.reduce((s, x) => s + x.resolved, 0);
  const totalWon = stats.reduce((s, x) => s + x.won, 0);
  const mine = stats.find((s) => s.segment === segment);
  if (!mine || mine.resolved < cfg.minSample || totalResolved === 0) {
    return { points: 0, reason: `chưa đủ ${cfg.minSample} lead nhóm này đi tới kết cục để học (${mine?.resolved ?? 0})` };
  }
  const base = totalWon / totalResolved;
  const smoothed = (mine.won + cfg.prior * base) / (mine.resolved + cfg.prior);
  if (base === 0) return { points: smoothed > 0 ? cfg.maxAdjust : 0, reason: `${mine.won}/${mine.resolved} lead nhóm này đã chốt` };
  const ratio = smoothed / base; // 1 = như trung bình
  const points = Math.round(clamp((ratio - 1) * cfg.maxAdjust, -cfg.maxAdjust, cfg.maxAdjust));
  return { points, reason: `${mine.won}/${mine.resolved} lead nhóm này đã chốt (chung ${totalWon}/${totalResolved})` };
}

export function scoreLead(input: ScoreInput, opts: { areas: ServiceAreas; thresholds?: GradeThresholds; learned?: { points: number; reason: string } | null }): ScoreResult {
  const seg = SEGMENT_POINTS[input.segment];
  const segLabel = LEAD_SEGMENT_LABEL[input.segment];
  const evidence = input.segmentEvidence ? ` (${input.segmentEvidence})` : "";
  const scale = scalePoints(input);
  const contact = contactPoints(input);
  const location = locationPoints(input, opts.areas);
  const quality = qualityPoints(input);
  const components: ScoreComponent[] = [
    { key: "categoryFit", label: SCORE_COMPONENT_LABEL.categoryFit, points: seg.fit, max: 30, reason: `${segLabel}${evidence}` },
    { key: "purchaseIntent", label: SCORE_COMPONENT_LABEL.purchaseIntent, points: seg.intent, max: 15, reason: seg.intent >= 13 ? "nhóm ưu tiên nhập hàng số lượng lớn" : seg.intent >= 9 ? "nhóm có nhu cầu nhập đều" : "nhu cầu nhập hải sản không rõ" },
    { key: "scale", label: SCORE_COMPONENT_LABEL.scale, points: scale.points, max: 20, reason: scale.reason },
    { key: "contactability", label: SCORE_COMPONENT_LABEL.contactability, points: contact.points, max: 15, reason: contact.reason },
    { key: "location", label: SCORE_COMPONENT_LABEL.location, points: location.points, max: 10, reason: location.reason },
    { key: "quality", label: SCORE_COMPONENT_LABEL.quality, points: quality.points, max: 10, reason: quality.reason },
  ];
  if (opts.learned) components.push({ key: "learned", label: SCORE_COMPONENT_LABEL.learned, points: opts.learned.points, max: 5, reason: opts.learned.reason });

  let score = clamp(Math.round(components.reduce((s, c) => s + c.points, 0)), 0, 100);
  // Không hoạt động ⇒ không bao giờ hạng A/B, dù các phần khác cao: gọi một quán đã đóng là phí công.
  if (input.businessStatus === "CLOSED_PERMANENTLY") score = Math.min(score, 20);
  const grade = gradeOf(score, opts.thresholds);
  return { score, grade, components, summary: summarize(input, segLabel, scale.reason, contact.reason, location.reason, grade) };
}

function summarize(input: ScoreInput, segLabel: string, scale: string, contact: string, location: string, grade: LeadGrade): string {
  const fit =
    SEGMENT_POINTS[input.segment].intent >= 13
      ? "phù hợp nhu cầu nhập hàng số lượng lớn"
      : SEGMENT_POINTS[input.segment].fit >= 15
        ? "có nhu cầu nhập thực phẩm"
        : "chưa rõ nhu cầu nhập hải sản";
  return `${segLabel}, ${scale}, ${contact}; ${location} — hạng ${grade}: ${fit}.`;
}

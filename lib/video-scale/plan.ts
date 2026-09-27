import { VIDEO_ANGLE_REQUIRES, VIDEO_ANGLES, isVideoAngle, jaccard, DUPLICATE_THRESHOLD, type VideoAngle } from "@/lib/constants/video-scale";
import { sampleBeta, seededRandom } from "@/lib/creative/learn";

/**
 * ═══════════ CHỌN GÓC BÁN CHO MỘT LƯỢT — HÀM THUẦN ═══════════
 *
 * Ranh giới "mô hình không quyết định" (cùng vòng mẫu ảnh): góc nào được làm do hàm này chọn, LLM chỉ viết kịch bản cho
 * góc đã chọn.
 *
 *  1. Góc người chỉ định đứng trước (bỏ góc lạ / góc thiếu dữ liệu, có lý do).
 *  2. Phần còn lại: lấy mẫu Thompson trên sổ học theo góc (`thành công / đã thử` của video đã chấm) — góc chưa thử tự được
 *     thử, góc thua nhiều lần tự bị bỏ, không cần xoá dữ liệu. Không có sổ ⇒ mọi góc ngang nhau (Beta(1,1)).
 *  3. Không lặp góc trong một lượt khi còn góc khác dùng được.
 *
 * Tất định theo `seed` (chạy lại cùng đầu vào ra cùng kết quả).
 */

export type AngleStat = { angle: VideoAngle; tried: number; success: number };

export type AngleFacts = { priceKnown: boolean; colorCount: number };

export function angleAllowed(angle: VideoAngle, facts: AngleFacts): string | null {
  const need = VIDEO_ANGLE_REQUIRES[angle];
  if (need === "PRICE" && !facts.priceKnown) return "chưa có một giá bán duy nhất trong ERP";
  if (need === "MULTI_COLOR" && facts.colorCount < 2) return "mã có dưới 2 màu còn bán";
  return null;
}

export type AnglePlan = { angles: VideoAngle[]; dropped: { angle: string; reason: string }[] };

export function planAngles(input: { n: number; requested: readonly string[]; stats: readonly AngleStat[]; facts: AngleFacts; seed: string }): AnglePlan {
  const n = Math.max(0, Math.floor(input.n));
  const dropped: { angle: string; reason: string }[] = [];
  const out: VideoAngle[] = [];
  for (const raw of input.requested) {
    if (out.length >= n) break;
    if (!isVideoAngle(raw)) {
      dropped.push({ angle: String(raw), reason: "góc không có trong từ vựng" });
      continue;
    }
    const why = angleAllowed(raw, input.facts);
    if (why) {
      dropped.push({ angle: raw, reason: why });
      continue;
    }
    if (!out.includes(raw)) out.push(raw);
  }
  const usable = VIDEO_ANGLES.filter((a) => angleAllowed(a, input.facts) === null);
  const stat = new Map(input.stats.map((s) => [s.angle, s]));
  const rand = seededRandom(input.seed);
  while (out.length < n && usable.length > 0) {
    const pool = usable.filter((a) => !out.includes(a));
    const candidates = pool.length ? pool : usable;
    let best: VideoAngle = candidates[0];
    let bestScore = -1;
    for (const a of candidates) {
      const s = stat.get(a);
      const score = sampleBeta(1 + (s?.success ?? 0), 1 + Math.max(0, (s?.tried ?? 0) - (s?.success ?? 0)), rand);
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }
    out.push(best);
  }
  return { angles: out, dropped };
}

/** Kịch bản mới có GẦN GIỐNG một kịch bản đã có không (Jaccard ≥ ngưỡng). Trả chỉ số của bản giống nhất, hoặc `null`. */
export function nearDuplicate(tokens: ReadonlySet<string>, existing: readonly ReadonlySet<string>[], threshold = DUPLICATE_THRESHOLD): { index: number; score: number } | null {
  let best: { index: number; score: number } | null = null;
  existing.forEach((e, index) => {
    const score = jaccard(tokens, e);
    if (score >= threshold && (!best || score > best.score)) best = { index, score };
  });
  return best;
}

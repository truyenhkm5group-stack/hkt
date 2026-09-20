/**
 * ═════════ MỖI LƯỢT NGƯỜI CHẤM LÀ MỘT DÒNG DỮ LIỆU ĐỐI CHỨNG ═════════
 *
 * MÁY KHÔNG TỰ CHẤM MÁY. Không có một mô hình nào chấm điểm câu của mô hình khác ở đây, và không
 * được thêm: một điểm số do máy sinh ra trông y hệt một điểm số có căn cứ, nên nó sẽ lặng lẽ thay
 * chỗ cho phần việc đắt nhất mà cũng là phần duy nhất đáng tin — một người đọc câu ấy và nói nó
 * dùng được hay không.
 *
 * NÊN NGUỒN ĐỐI CHỨNG CHỈ CÓ MỘT: `sales_review_labels`, do người bấm ở `/ai/review`.
 *
 * ─── "ĐỦ ĐIỀU KIỆN ĐỐI CHỨNG" LÀ GÌ ───
 *
 * Một lượt chấm vào được bộ đối chứng khi nó nói rõ MÁY ĐÃ LÀM GÌ SAI VÀ ĐÁNG LẼ PHẢI LÀM GÌ.
 * Đếm cả những dòng chỉ có một cái tích thì con số mẫu phồng lên mà không đo được gì thêm: một
 * dòng `verdict = 'BAD'` trơ trọi nói được "có lỗi", không nói được lỗi ở đâu, nên không so được
 * với kết quả của một mô hình khác.
 *
 * Hai mức, và chúng trả lời hai câu khác nhau:
 *   · ĐẠT/KHÔNG ĐẠT (`verdict`) — đủ để đo TỶ LỆ. Đây là mẫu cho mọi con số phần trăm.
 *   · CÓ CĂN CỨ (`verdict` + lý do + điều đáng lẽ phải làm) — đủ để SO HAI MÔ HÌNH trên cùng một
 *     lượt. Đây mới là bộ đối chứng thật.
 *
 * Con số thứ hai luôn nhỏ hơn con số thứ nhất, và in cả hai cạnh nhau là cố ý: gộp lại thì một bộ
 * đối chứng 40 dòng "có căn cứ" và một bộ 40 dòng chỉ có tích đọc ra giống hệt nhau.
 */
import { PILOT_REVIEWED_TURNS_TARGET } from "@/lib/constants/sales-copilot";

/**
 * BỐN MỨC CỠ MẪU.
 *
 * `min` và `max` LẤY LẠI từ `PILOT_REVIEWED_TURNS_TARGET` chứ không gõ lại — gõ lại một con số là
 * mở đường cho hai nơi nói hai số khác nhau (cùng lý do như luật 22).
 *
 * Hai mốc còn lại (`MEANINGFUL_FROM`, `STRONGER_FROM`) là con số CHỦ SHOP ĐẶT trong đặc tả phiên
 * 20/09/2026, không phải một hằng số thống kê. Chúng ở đây để mọi màn hình đọc cùng một chỗ.
 */
export const BENCHMARK_SAMPLE_TIERS = {
  /** Dưới mức này mọi tỷ lệ đọc ra đều là tiếng ồn. */
  INSUFFICIENT_BELOW: PILOT_REVIEWED_TURNS_TARGET.min,
  /** Đọc được xu hướng, CHƯA kết luận được. */
  PRELIMINARY_FROM: PILOT_REVIEWED_TURNS_TARGET.min,
  /** Con số đầu tiên đáng mang ra quyết định. */
  MEANINGFUL_FROM: 38,
  /** Đủ để so hai mô hình với nhau mà chênh lệch nhỏ vẫn có nghĩa. */
  STRONGER_FROM: 100,
} as const;

export const BENCHMARK_TIERS = ["INSUFFICIENT", "PRELIMINARY", "MEANINGFUL", "STRONGER"] as const;
export type BenchmarkTier = (typeof BENCHMARK_TIERS)[number];

export const BENCHMARK_TIER_LABEL: Record<BenchmarkTier, string> = {
  INSUFFICIENT: "Chưa đủ để đọc ra gì",
  PRELIMINARY: "Đọc được xu hướng, chưa kết luận",
  MEANINGFUL: "Con số đầu tiên dùng để quyết định được",
  STRONGER: "Đủ để so hai mô hình",
};

/** HÀM THUẦN. Ranh giới ĐÓNG ở dưới: đúng 20 dòng là `PRELIMINARY`, không phải `INSUFFICIENT`. */
export function benchmarkTierOf(labelled: number): BenchmarkTier {
  if (labelled >= BENCHMARK_SAMPLE_TIERS.STRONGER_FROM) return "STRONGER";
  if (labelled >= BENCHMARK_SAMPLE_TIERS.MEANINGFUL_FROM) return "MEANINGFUL";
  if (labelled >= BENCHMARK_SAMPLE_TIERS.PRELIMINARY_FROM) return "PRELIMINARY";
  return "INSUFFICIENT";
}

/**
 * Chỉ `MEANINGFUL` trở lên mới được kết luận mô hình nào hơn mô hình nào.
 *
 * Dưới mức ấy KHÔNG phải "hai mô hình ngang nhau" — nó là CHƯA BIẾT, và hai câu ấy dẫn tới hai
 * quyết định ngược nhau (giữ nguyên vs. đi lấy thêm dữ liệu).
 */
export function canRankModels(labelled: number): boolean {
  return labelled >= BENCHMARK_SAMPLE_TIERS.MEANINGFUL_FROM;
}

/** Một lượt chấm đủ điều kiện vào bộ đối chứng CÓ CĂN CỨ chưa. HÀM THUẦN. */
export function isGroundedLabel(label: {
  verdict: string | null;
  reasonTags: readonly string[] | null;
  expectedBehavior: string | null;
}): boolean {
  if (!label.verdict) return false;
  const coLyDo = (label.reasonTags ?? []).length > 0;
  const coKyVong = (label.expectedBehavior ?? "").trim().length > 0;
  return coLyDo || coKyVong;
}

/**
 * ═══════════ MỘT TRUNG VỊ CHỈ ĐƯỢC PHÁT BIỂU KHI CÓ ĐỦ MẪU ═══════════
 *
 * ─── LỖI ĐO ĐƯỢC TRÊN PRODUCTION 16/09/2026 ───
 *
 * `care-performance.ts` in ra "thời gian phản hồi trung vị" tính từ `shipment_care.first_action_at`.
 * Đếm trên 319 đợt care:
 *
 *   first_response_at   193 dòng có giá trị  (60%)
 *   first_action_at       2 dòng có giá trị  (0,6%)
 *
 * Nghĩa là con số ấy là **trung vị của HAI dòng**, in ra cạnh tên nhân viên như một chỉ số về họ.
 * Hai dòng không nói gì về cách làm việc của ai — nó nói về sự ngẫu nhiên.
 *
 * ─── VÀ ĐÂY KHÔNG PHẢI "LÀM KÉM" ───
 *
 * Mục 39 đã chốt: `WEAK` (mẫu dưới ngưỡng) tách hẳn khỏi kết luận về năng lực. Một ô trống kèm
 * "chưa đủ mẫu" nói đúng sự thật; một con số tính từ hai dòng thì nói sai mà trông như đúng — và
 * cái sau nguy hiểm hơn nhiều vì không ai đi kiểm lại một con số trông hợp lý.
 *
 * ─── ĐỘ PHỦ LUÔN ĐỨNG CẠNH ───
 *
 * Trả về cả cỡ mẫu và tổng thể, để màn hình in được "3,4 giờ (193/319 ca)" thay vì một con số trần
 * trụi. Người đọc phải thấy được phần mình KHÔNG biết.
 */

/**
 * Dưới ngưỡng này thì KHÔNG phát biểu một trung vị.
 *
 * Mười, cùng con số với bảng kiểm kê ca chăm sóc — cố ý dùng chung để hai màn hình không nói hai
 * ngưỡng khác nhau về cùng một loại đại lượng.
 */
export const TIMING_MIN_SAMPLE = 10;

export type TimingStat = {
  /** Trung vị. `null` = CHƯA ĐỦ MẪU, khác hẳn 0. */
  median: number | null;
  /** Số quan sát thật sự có mốc để tính. */
  sample: number;
  /** Tổng số ca trong nhóm — mẫu số của độ phủ. */
  population: number;
  /** `sample / population`. `null` khi tổng thể rỗng (mục 42: mẫu số 0 ⇒ CHƯA BIẾT, không phải 0%). */
  coverage: number | null;
  minSample: number;
};

/** Trung vị thô, `null` khi mảng rỗng. Không áp ngưỡng — `timingStat` mới là cửa duy nhất có ngưỡng. */
export function rawMedian(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const v = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Trung vị KÈM ĐỘ PHỦ, và `null` khi mẫu chưa đủ.
 *
 * `population` là tổng thể để tính độ phủ — thường lớn hơn `values.length`, và chênh lệch đó CHÍNH
 * LÀ thứ cần in ra: 2/319 và 193/319 cho ra hai con số rất khác nhau về mức đáng tin.
 */
export function timingStat(values: readonly number[], population: number, minSample = TIMING_MIN_SAMPLE): TimingStat {
  const sach = values.filter((v) => Number.isFinite(v) && v >= 0);
  return {
    median: sach.length >= minSample ? rawMedian(sach) : null,
    sample: sach.length,
    population,
    coverage: population > 0 ? sach.length / population : null,
    minSample,
  };
}

/** Câu giải thích cho một ô trống — người đọc phải phân biệt được CHƯA ĐỦ DỮ LIỆU với LÀM KÉM. */
export function timingNote(s: TimingStat): string {
  if (s.median !== null) return `${s.sample}/${s.population} ca có mốc để tính`;
  if (!s.sample) return "chưa ca nào có mốc để tính";
  return `chưa đủ mẫu (${s.sample}/${s.minSample} ca) — CHƯA ĐỦ DỮ LIỆU, không phải làm chậm`;
}

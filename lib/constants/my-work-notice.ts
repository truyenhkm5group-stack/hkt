/**
 * ═══════════ «VIỆC CỦA TÔI» KHI MỘT PHẦN NGUỒN CHƯA CÓ SỐ (OD-UX-05 mục 2, 24/10/2026) ═══════════
 *
 * Đo production 23/10/2026: lượt đệm nguội có 4/14 nguồn chạm hạn 2,5 s của /work và trả 0 việc. Màn hình khi ấy vẫn in
 * «Không còn việc nào được giao cho bạn.», ô «Quá hạn / Đang cầm» như số chốt, và thẻ «Hàng đợi trống» — tức là biến CHƯA BIẾT
 * thành 0 (AGENTS 42). Hàm THUẦN này dựng mọi câu chữ phụ thuộc vào việc danh sách có ĐỦ hay không, để trang không tự viết luật.
 */
import { WORK_SOURCE_SPEC, type WorkSource } from "@/lib/constants/work-sources";

export type FailedSource = { source: WorkSource; error: string };

export type MyWorkNotice = {
  /** Dòng mô tả dưới tiêu đề trang. */
  description: string;
  /** Khung cảnh báo — `null` khi đủ nguồn. */
  banner: string | null;
  /** Chú thích cho ô đếm: đủ nguồn ⇒ `undefined` (giữ chú thích cũ của ô); thiếu ⇒ nói số là CẬN DƯỚI. */
  countNote: string | undefined;
  /** Chỉ hiện «Hàng đợi trống» khi ĐỦ nguồn và thật sự không có việc. */
  showEmpty: boolean;
};

/** Lỗi do chạm hạn thời gian của /work (đang tính lại phía sau) — khác lỗi thật của nguồn. */
const DANG_TINH_LAI = /đang tính lại/;

function nhanNguon(f: FailedSource): string {
  const ten = WORK_SOURCE_SPEC[f.source]?.label ?? f.source;
  return DANG_TINH_LAI.test(f.error) ? `${ten} (đang tính lại)` : `${ten} (lỗi)`;
}

export function myWorkNotice(input: { total: number; overdue: number; failed: readonly FailedSource[] }): MyWorkNotice {
  const n = input.failed.length;
  if (n === 0) {
    return {
      description: input.total ? `${input.total} việc đang cầm · ${input.overdue} việc quá hạn` : "Không còn việc nào được giao cho bạn.",
      banner: null,
      countNote: undefined,
      showEmpty: input.total === 0,
    };
  }
  const dangTinh = input.failed.every((f) => DANG_TINH_LAI.test(f.error));
  return {
    description: input.total
      ? `Ít nhất ${input.total} việc đang cầm · ${input.overdue} việc quá hạn — ${n} nguồn chưa có số`
      : `Chưa biết bạn còn việc hay không — ${n} nguồn chưa có số`,
    banner:
      `Chưa đọc được ${n} nguồn: ${input.failed.map(nhanNguon).join(" · ")}. Việc của các nguồn này chưa hiện ở đây và KHÔNG được tính là 0.` +
      (dangTinh ? " Máy đang tính lại phía sau — mở lại trang sau ít giây là có." : ""),
    countNote: `thiếu ${n} nguồn — có thể nhiều hơn`,
    showEmpty: false,
  };
}

/**
 * ═══════════ LỚP NHÓM LÝ DO: SỬA ĐƯỢC MÀ KHÔNG ĐỘNG VÀO MỘT DÒNG LỊCH SỬ NÀO ═══════════
 *
 * ─── VẤN ĐỀ ───
 *
 * Xếp lý do vào nhóm là một QUYẾT ĐỊNH KINH DOANH, không phải một sự thật. "Khách đi vắng" thuộc
 * nhóm *giao lâu* hay nhóm *boom hàng*? Câu trả lời đổi theo cách shop nhìn, và nó sẽ đổi.
 *
 * Trước bản này, cách xếp nhóm nằm CỨNG trong `RETURN_REASON_GROUP_OF`. Đổi ý nghĩa là sửa mã
 * nguồn và triển khai lại — hoặc tệ hơn, chạy một lượt `UPDATE` trên bảng `shipment_return_reasons`
 * để viết lại cột `reason_group` của hàng trăm dòng đã ghi.
 *
 * ─── CÁCH SỬA: TÁCH SỰ THẬT KHỎI CÁCH XẾP ───
 *
 *   · DÒNG DỮ LIỆU giữ LÝ DO CHI TIẾT (`reason`) và CHỮ GỐC (`raw_reason`). Hai thứ này là quan
 *     sát — chúng KHÔNG BAO GIỜ bị sửa, và khoá của chúng không bao giờ đổi tên.
 *   · NHÓM được suy lúc ĐỌC, từ bảng tra ở đây cộng với phần ghi đè chủ shop đặt trong `settings`.
 *
 * Nên "chỉnh nhóm" là sửa MỘT dòng cấu hình. Báo cáo đổi ngay, và không một dòng lịch sử nào bị
 * viết lại — đúng điều kiện để còn tra ngược được về chứng từ sau này.
 *
 * (Cột `shipment_return_reasons.reason_group` vẫn được ghi, nhưng nay nó là ẢNH CHỤP LÚC GHI để
 * trả lời câu "hồi đó báo cáo xếp nó vào đâu", KHÔNG phải nguồn của phép gộp. Mọi tổng hợp đi qua
 * `effectiveGroupOf`.)
 */
import {
  RETURN_REASONS,
  RETURN_REASON_GROUPS,
  RETURN_REASON_GROUP_OF,
  type ReturnReason,
  type ReturnReasonGroup,
} from "@/lib/constants/return-reason";

/** Khoá trong bảng `settings`. Chỉ chứa khoá chủ shop ĐÃ SỬA — bảng thưa, không phải bản chụp đầy đủ. */
export const REASON_GROUP_KEY = "returns.reason-groups";

export type ReasonGroupOverrides = Partial<Record<ReturnReason, ReturnReasonGroup>>;

/**
 * ═══ HAI LÝ DO BỊ GHIM, KHÔNG AI ĐỔI ĐƯỢC ═══
 *
 * `UNKNOWN` = CHƯA AI HỎI VÌ SAO. `OTHER` = có chứng từ nhưng không khớp danh mục nào.
 *
 * Cả hai là "CHƯA CHẮC CHẮN", và chỗ của chúng là *Chưa xác định được* / *Lý do khác*. Cho phép
 * kéo chúng sang một nhóm QUY LỖI (chất lượng · size · giao vận · boom) là biến một chỗ trống
 * thành một lời buộc tội: 299 kiện chưa ai hỏi sẽ xuất hiện trong cột "Chất lượng kém" và trông
 * y hệt 299 ca đã có người gọi cho khách xác minh vải.
 *
 * Đây cũng chính là luật mà `tests/kpi-clarity.test.ts` khoá ở phía máy suy chữ — ghim ở đây là
 * bịt nốt đường vòng qua cấu hình.
 */
export const PINNED_REASON_GROUP: Partial<Record<ReturnReason, ReturnReasonGroup>> = {
  UNKNOWN: "UNKNOWN",
  OTHER: "OTHER",
};

/** Nhóm mang nghĩa QUY LỖI cho một phía. `OTHER`/`UNKNOWN` thì không. */
export const BLAMING_GROUPS: readonly ReturnReasonGroup[] = ["QUALITY", "SIZE", "SLOW", "BOOM"];

/** Một lượt đổi nhóm có được phép không, và nếu không thì vì sao — dùng chung cho UI và server action. */
export function canRegroup(reason: string, group: string): { ok: boolean; reason?: string } {
  if (!(RETURN_REASONS as readonly string[]).includes(reason)) return { ok: false, reason: `Lý do "${reason}" không có trong sổ` };
  if (!(RETURN_REASON_GROUPS as readonly string[]).includes(group)) return { ok: false, reason: `Nhóm "${group}" không có trong sổ` };
  const ghim = PINNED_REASON_GROUP[reason as ReturnReason];
  if (ghim && ghim !== group) {
    return {
      ok: false,
      reason:
        reason === "UNKNOWN"
          ? "“Chưa xác định được” là chỗ TRỐNG, không phải một nguyên nhân — kéo nó sang nhóm quy lỗi là biến số ca chưa ai hỏi thành một lời buộc tội. Cách tăng độ phủ là ghi lý do khi xử lý ca hoàn."
          : "“Lý do khác” gom những ca có chứng từ nhưng không khớp danh mục nào. Muốn tách ra thì thêm một lý do CHI TIẾT vào sổ, đừng kéo cả nhóm sang một phía chịu lỗi.",
    };
  }
  return { ok: true };
}

/** Bỏ mọi khoá hỏng và mọi lượt đổi bị cấm; giữ phần còn lại. Dòng rác không được làm sập báo cáo. */
export function sanitizeReasonGroups(raw: unknown): ReasonGroupOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ReasonGroupOverrides = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string") continue;
    if (!canRegroup(k, v).ok) continue;
    // Ghi đè TRÙNG mặc định thì bỏ luôn: bảng thưa phải thưa, nếu không mặc định trong mã thành vô nghĩa.
    if (RETURN_REASON_GROUP_OF[k as ReturnReason] === v) continue;
    out[k as ReturnReason] = v as ReturnReasonGroup;
  }
  return out;
}

/**
 * NHÓM CÓ HIỆU LỰC của một lý do. MỘT đường duy nhất — mọi tổng hợp, mọi bộ lọc, mọi drilldown
 * phải đi qua đây, nếu không bảng nhóm và bảng chi tiết sẽ cộng ra hai con số khác nhau.
 */
export function effectiveGroupOf(reason: ReturnReason, overrides: ReasonGroupOverrides): ReturnReasonGroup {
  const ghim = PINNED_REASON_GROUP[reason];
  if (ghim) return ghim;
  return overrides[reason] ?? RETURN_REASON_GROUP_OF[reason];
}

/** Bảng tra đầy đủ đã áp ghi đè — dựng MỘT lần cho mỗi lượt báo cáo thay vì gọi hàm trên mỗi dòng. */
export function reasonGroupTable(overrides: ReasonGroupOverrides): Record<ReturnReason, ReturnReasonGroup> {
  return Object.fromEntries(RETURN_REASONS.map((r) => [r, effectiveGroupOf(r, overrides)])) as Record<ReturnReason, ReturnReasonGroup>;
}

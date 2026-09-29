/**
 * ═══════════ SỰ KIỆN BẢN GHI TUỲ BIẾN CHỈ PHÁT CHO ĐỐI TƯỢNG TUỲ BIẾN (pilot P1 #7) — THUẦN, CLIENT-SAFE ═══════════
 *
 * `custom_record.created/updated/deleted` do lõi DUY NHẤT `lib/objects/records.ts` phát — lõi ghi `custom_records`, tức chỉ
 * bản ghi của đối tượng TỔ CHỨC TỰ TẠO (`x_…`). Khách hàng, đơn hàng, sản phẩm… là đối tượng HỆ THỐNG: không đường ghi nào
 * của chúng phát `custom_record.*`. Luật "khi TẠO khách hàng" trỏ `event:custom_record.created` + `objectKey: "customer"`
 * vì thế lưu được, bật được, chạy thật được — và KHÔNG BAO GIỜ chạy (bài kiểm toán pilot 29/09: luật "khách mới" bật CHẠY
 * THẬT, tạo khách xong không có lượt chạy nào).
 *
 * Lựa chọn: TỪ CHỐI tổ hợp này ở mọi cửa lưu luật (trình soạn · `validateRuleInput` · `validateBlueprint` của mẫu / AI),
 * kèm câu gợi ý trigger đúng. KHÔNG phát thêm sự kiện miền "khách được tạo": khách của tổ chức nhà do đồng bộ Pancake tạo
 * hàng loạt, một sự kiện như vậy là một dòng `domain_events` cho mỗi khách mỗi lượt đồng bộ — quyết định ấy cần chủ nền tảng.
 * Trigger đúng hôm nay cho đối tượng hệ thống là `custom_status` (field trạng thái nghiệp vụ tự khai trên đối tượng đó).
 */
import { objectDef } from "@/lib/constants/object-registry";
import { isCustomObjectKey } from "@/lib/metadata/types";

export const CUSTOM_RECORD_EVENT_PREFIX = "custom_record.";

/** Câu lỗi khi luật nghe `custom_record.*` trên một đối tượng không phải đối tượng tuỳ biến; `null` = hợp lệ. */
export function recordEventObjectProblem(event: string, objectKey: string | null | undefined): string | null {
  if (!event.startsWith(CUSTOM_RECORD_EVENT_PREFIX) || !objectKey) return null;
  if (isCustomObjectKey(objectKey)) return null;
  const label = objectDef(objectKey)?.label ?? objectKey;
  return `Sự kiện «${event}» chỉ phát cho đối tượng TỰ TẠO (x_…) — «${label}» là đối tượng hệ thống nên luật này sẽ không bao giờ chạy. Dùng trigger «Trạng thái nghiệp vụ» (custom_status) trên một field trạng thái của ${label}, hoặc chọn một đối tượng tự tạo.`;
}

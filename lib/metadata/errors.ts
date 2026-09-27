/**
 * Lỗi và kết quả của lớp dịch vụ metadata (Phase 2) — thuần, client-safe.
 *
 * Hai hình, hai cách dùng:
 *  · Lượt GHI trả `{ ok: false, code, errors }` — lỗi nghiệp vụ không ném (luật kho: server action trả
 *    `{ error }` thay vì throw), và mỗi lỗi gắn với MỘT field để form tô đúng ô.
 *  · Lượt ĐỌC ném `MetadataError` — trang đọc metadata của một đối tượng không có trong sổ, hoặc của
 *    module đang tắt, là lỗi lập trình / lỗi cổng, không phải thứ người dùng sửa được bằng cách gõ lại.
 */
import type { FieldError } from "@/lib/metadata/types";

export type MetadataErrorCode =
  /** Khoá đối tượng không có trong sổ (`lib/constants/object-registry.ts`). */
  | "OBJECT_UNKNOWN"
  /** Đối tượng có trong sổ nhưng không có năng lực này (vd `order` không có form ghi). */
  | "NOT_SUPPORTED"
  /** Module của đối tượng đang tắt cho tổ chức (M14). */
  | "MODULE_DISABLED"
  /** Người thao tác thiếu quyền trên đối tượng hoặc trên field. */
  | "FORBIDDEN"
  /** Bản ghi / field / cấu hình không tồn tại TRONG CSDL CỦA TỔ CHỨC NÀY. */
  | "NOT_FOUND"
  /** Đầu vào sai (kiểm hợp lệ, cấu hình sai). */
  | "INVALID"
  /** Có người khác vừa ghi cùng bản ghi / cùng cấu hình — tải lại rồi làm lại. */
  | "CONFLICT";

export class MetadataError extends Error {
  constructor(
    readonly code: MetadataErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MetadataError";
  }
}

export type MetaFailure = { ok: false; code: MetadataErrorCode; errors: FieldError[] };

export function fail(code: MetadataErrorCode, errors: FieldError[] | string, field = "_"): MetaFailure {
  return { ok: false, code, errors: typeof errors === "string" ? [{ field, message: errors }] : errors };
}

/**
 * Kiểu dùng chung của dịch vụ đối tượng tuỳ biến (Phase 6) — thuần, client-safe.
 *
 * Lượt GHI trả `{ ok: true, … } | { ok: false, code, errors: { path, message }[] }` (hợp đồng mục 5 của đợt giao việc):
 * lỗi nghiệp vụ không ném, mỗi lỗi gắn với MỘT đường dẫn (`label`, `system:title`, `gia_tri`…) để form tô đúng ô.
 */
import type { MetadataErrorCode } from "@/lib/metadata/errors";
import type { CustomValues } from "@/lib/metadata/types";

export type ObjectsError = { path: string; message: string };
export type ObjectsFailure = { ok: false; code: MetadataErrorCode; errors: ObjectsError[] };
export type ObjectsResult<T = object> = ({ ok: true } & T) | ObjectsFailure;

/** Một đối tượng tuỳ biến nhìn từ màn hình quản trị / menu. */
export type CustomObjectSummary = {
  key: string;
  label: string;
  labelPlural: string;
  icon: string;
  moduleKey: string;
  titleLabel: string;
  description: string | null;
  viewPermission: string;
  writePermission: string;
  status: "ACTIVE" | "ARCHIVED";
  origin: string | null;
  /** Số bản ghi còn sống (chưa xoá). */
  recordCount: number;
  /** Số field tuỳ biến đang dùng. */
  fieldCount: number;
};

/** Một dòng của danh sách bản ghi. Giá trị custom chỉ gồm field người xem ĐƯỢC xem. */
export type CustomRecordRow = {
  id: string;
  title: string;
  ownerId: string | null;
  ownerName: string | null;
  createdAt: string;
  updatedAt: string;
  values: CustomValues;
};

export type CustomRecordDetail = CustomRecordRow & { version: number; createdBy: string | null; updatedBy: string | null };

/** Một nhóm bản ghi trỏ TỚI một bản ghi (chiều ngược của quan hệ — một-nhiều). */
export type ReverseRelationGroup = {
  objectKey: string;
  objectLabel: string;
  fieldKey: string;
  fieldLabel: string;
  /** Trang chi tiết của bản ghi nguồn (chỉ đối tượng tuỳ biến có trang `/o/…`; hệ thống thì `null`). */
  records: { id: string; title: string; href: string | null }[];
  /** Có thêm bản ghi ngoài trần hiển thị. */
  truncated: boolean;
};

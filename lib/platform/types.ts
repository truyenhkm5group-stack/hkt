/**
 * Kiểu dùng chung của nền tảng đa tổ chức — hợp đồng `docs/platform/shared-contracts.md` mục 1.
 *
 * Client-safe: KHÔNG import gì (kể cả `import type`), để mọi tầng — middleware, trang, bài kiểm —
 * dùng được mà không kéo theo CSDL hay mã chỉ-máy-chủ.
 */

/** `SETUP_FAILED` (Phase 10): lượt dựng tự phục vụ hỏng giữa chừng — không đăng nhập, không job; người vận hành xử lý ở /platform. */
export type OrganizationStatus = "ACTIVE" | "SUSPENDED" | "ARCHIVED" | "SETUP_FAILED";

/** Dòng module THIẾU nghĩa là gì với tổ chức này (target-architecture P7): khai ở cấp tổ chức, không đoán. */
export type ModuleDefault = "ENABLED" | "DISABLED";

export type Organization = {
  id: string;
  /** Khoá ổn định `^[a-z][a-z0-9-]{1,30}$` — BẤT BIẾN (nằm trong JWT, khoá đệm, tên CSDL). */
  code: string;
  name: string;
  status: OrganizationStatus;
  /** ĐÚNG MỘT tổ chức: CSDL của nó là `DATABASE_URL`. */
  isHome: boolean;
  moduleDefault: ModuleDefault;
  /** Chỗ cho gói dịch vụ — Phase 1 không có luật nào đọc. */
  plan: string | null;
  templateKey: string | null;
  /** Tên miền con khách chọn (0180) — `null` = chưa chọn. Chỉ tổ chức `PUBLISHED` mới được định tuyến theo nó. */
  domainSlug?: string | null;
  /** `null` = không theo dõi (nhà / tổ chức có từ trước 0180) · `DRAFT` · `PUBLISHED`. */
  publishState?: "DRAFT" | "PUBLISHED" | null;
  /** Thương hiệu nơi khách tự đăng ký (0215) — `null` = không theo dõi ⇒ liên kết về `APP_URL` như trước. */
  brand?: "vnx" | "chotdon" | null;
};

/**
 * Một dòng `platform_organization_modules` đã đọc ra, ở dạng thuần.
 *
 * `moduleKey` là `string` chứ không phải `ModuleKey`: dữ liệu có thể mang khoá lạ (gõ tay, module đã
 * bỏ khỏi mã nguồn). Bộ phân giải BỎ QUA khoá lạ thay vì tin nó. `features` là ghi đè
 * `{ "<module>.<feature>": boolean }` của mặc định trong sổ.
 */
export type ModuleRow = { moduleKey: string; enabled: boolean; features: Record<string, boolean> };

export const ORGANIZATION_CODE_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

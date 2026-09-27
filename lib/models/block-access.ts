import { decideScope } from "@/lib/auth/scope-guard";
import { can, type SessionUser } from "@/lib/auth/session";
import { MODEL_360_BLOCK_ACCESS, type Model360Block } from "@/lib/constants/model-360";

/**
 * Người xem có được đọc nguồn của một khối Model 360 không: ĐÚNG quyền của màn hình chủ nguồn ấy, và phạm vi
 * dữ liệu không phải "từ chối" (cùng cổng mà màn hình chủ áp — `requireResource`). Trang 360 và Bảng quy trình
 * mẫu KHÔNG được là cửa sau đọc lợi nhuận / chi quảng cáo cho người chỉ có "Vòng đời mẫu: xem".
 *
 * Một bản cho cả hai màn hình (trước đây là hàm cục bộ của trang 360) — bảng quy trình dựng đề xuất từ CÙNG
 * nguồn, nên phải qua CÙNG cổng.
 */
export async function modelBlockAllowed(user: SessionUser, block: Model360Block): Promise<boolean> {
  const a = MODEL_360_BLOCK_ACCESS[block];
  if (!can(user, a.permission)) return false;
  if (!a.resource) return true;
  const d = await decideScope(a.resource, user, a.permission);
  return d.allow !== "NONE";
}

/** Cổng của MỌI khối một lượt. */
export async function modelBlockAccess(user: SessionUser): Promise<Record<Model360Block, boolean>> {
  const blocks = Object.keys(MODEL_360_BLOCK_ACCESS) as Model360Block[];
  const allow = await Promise.all(blocks.map((b) => modelBlockAllowed(user, b)));
  return Object.fromEntries(blocks.map((b, i) => [b, allow[i]])) as Record<Model360Block, boolean>;
}

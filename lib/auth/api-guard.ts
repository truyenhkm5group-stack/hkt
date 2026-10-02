import { NextResponse } from "next/server";
import type { Permission } from "@/lib/auth/permissions";
import { can, permissionModuleDisabled, resolveCurrentUser, type SessionUser } from "@/lib/auth/session";

/**
 * ═══════════ CỔNG CỦA ROUTE `/api/*` ═══════════
 *
 * `getCurrentUser()` nuốt LÝ DO từ chối, nên một route dựng trên nó chỉ nói được "Chưa đăng nhập".
 * Với nền tảng đa tổ chức điều đó sai hướng: một người ĐÃ đăng nhập mà gọi API của module chưa bật
 * sẽ nhận 401 và đi đăng nhập lại — rồi bị chặn đúng chỗ cũ. Cổng này trả ĐÚNG mã
 * (docs/platform/shared-contracts.md mục 7):
 *
 *  · 401 — không có phiên dùng được (chưa đăng nhập · tài khoản không còn · bị khoá · bị thu hồi).
 *  · 403 `MODULE_DISABLED` — đường dẫn, hoặc khoá quyền được đòi, thuộc module tổ chức chưa bật.
 *  · 403 `ORG_INACTIVE` — tổ chức của phiên đang tạm ngừng / không còn.
 *  · 403 `FORBIDDEN` — thiếu khoá quyền được đòi.
 *  · 402 `BILLING_LOCKED` — lượt GHI của tổ chức đang chỉ xem vì quá hạn thanh toán (0187); lượt đọc vẫn đi.
 *
 * Route cũ trả chữ trần (tệp xuất, ảnh, SSE) dùng `format: "text"` để thân phản hồi giữ nguyên dạng;
 * mã trạng thái là thứ trình duyệt và `fetch` đọc, và nó giống hệt nhau ở hai dạng.
 */

export type ApiDenyCode = "UNAUTHENTICATED" | "MODULE_DISABLED" | "ORG_INACTIVE" | "FORBIDDEN" | "BILLING_LOCKED";

export type ApiGuardOptions = {
  /** `json` (mặc định): `{ ok: false, error, code }`. `text`: chỉ câu lỗi, cho route trước đây trả chữ trần. */
  format?: "json" | "text";
  /** Câu trả về khi thiếu quyền — giữ đúng câu route đã dùng trước khi chuyển sang cổng này. */
  forbiddenMessage?: string;
};

export const API_DENY_MESSAGE: Record<ApiDenyCode, string> = {
  UNAUTHENTICATED: "Chưa đăng nhập",
  MODULE_DISABLED: "Chức năng này chưa được bật cho tổ chức của bạn",
  ORG_INACTIVE: "Tổ chức của phiên đăng nhập đang tạm ngừng hoặc không còn tồn tại",
  FORBIDDEN: "Không có quyền",
  BILLING_LOCKED: "Tổ chức đang ở chế độ chỉ xem vì quá hạn thanh toán — gia hạn ở Hệ thống → Gói & thanh toán",
};

function deny(status: 401 | 402 | 403, code: ApiDenyCode, opts: ApiGuardOptions, extra: { module?: string; message?: string } = {}): NextResponse {
  const error = extra.message ?? API_DENY_MESSAGE[code];
  if (opts.format === "text") return new NextResponse(error, { status, headers: { "x-erp-deny": code } });
  return NextResponse.json({ ok: false, error, code, ...(extra.module ? { module: extra.module } : {}) }, { status });
}

/**
 * `{ user }` khi được đi tiếp, hoặc MỘT `NextResponse` từ chối để route trả thẳng:
 *
 * ```ts
 * const guard = await apiGuard("orders:read");
 * if (guard instanceof Response) return guard;
 * const { user } = guard;
 * ```
 *
 * `permission` bỏ trống ⇒ chỉ kiểm danh tính + tổ chức + module của đường dẫn; route tự kiểm quyền
 * bằng `can()` sau đó (giữ nguyên câu báo riêng của nó).
 */
export async function apiGuard(permission?: Permission | null, opts: ApiGuardOptions = {}): Promise<{ user: SessionUser } | NextResponse> {
  const ket = await resolveCurrentUser();
  if ("denied" in ket) {
    if (ket.denied === "MODULE_DISABLED") return deny(403, "MODULE_DISABLED", opts, { module: ket.module });
    if (ket.denied === "ORG_INACTIVE") return deny(403, "ORG_INACTIVE", opts);
    if (ket.denied === "BILLING_LOCKED") return deny(402, "BILLING_LOCKED", opts);
    return deny(401, "UNAUTHENTICATED", opts);
  }
  const user = ket.user;
  if (permission) {
    const offModule = permissionModuleDisabled(user, permission);
    if (offModule) return deny(403, "MODULE_DISABLED", opts, { module: offModule });
    if (!can(user, permission)) return deny(403, "FORBIDDEN", opts, { message: opts.forbiddenMessage });
  }
  return { user };
}

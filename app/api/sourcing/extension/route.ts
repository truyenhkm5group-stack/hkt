import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/api-guard";
import { can } from "@/lib/auth/session";
import { buildExtensionPackage } from "@/lib/sourcing/extension-package";

export const dynamic = "force-dynamic";

/**
 * Tải tiện ích Chrome «Lưu mẫu từ 1688» dạng .zip (SRC-6) — cho người KHÔNG có kho mã. Cần phiên + quyền xem Tìm hàng nguồn. Gói
 * dựng từ đúng `extensions/sourcing-1688/` theo danh sách manifest khai (`lib/sourcing/extension-package.ts`), không mang token
 * hay địa chỉ ERP nào — người dùng tự dán ở trang Cài đặt của tiện ích.
 */
export async function GET() {
  // apiGuard: 401 chưa đăng nhập · 403 module Tìm hàng nguồn tắt / tổ chức ngừng / thiếu quyền (S18).
  const guard = await apiGuard("sourcing:view");
  if (guard instanceof Response) return guard;
  const { user } = guard;
  if (!can(user, "sourcing:view")) return NextResponse.json({ ok: false, error: "Bạn chưa có quyền xem Tìm hàng nguồn." }, { status: 403 });
  const pkg = buildExtensionPackage();
  return new NextResponse(new Uint8Array(pkg.zip), {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${pkg.filename}"`,
      "cache-control": "no-store",
    },
  });
}

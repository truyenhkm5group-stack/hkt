import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/api-guard";
import { readLogo } from "@/lib/branding/service";

export const dynamic = "force-dynamic";

/**
 * LOGO CỦA TỔ CHỨC ĐANG ĐĂNG NHẬP (Phase 10 · §4).
 *
 * Không nhận mã tổ chức hay id tệp: logo đọc từ `settings["org.branding"]` của CSDL tổ chức CỦA PHIÊN (`apiGuard` →
 * `getDb()`), nên người của tổ chức A không có cách nào lấy logo của B — kể cả biết id tệp. `?v=` chỉ để phá đệm
 * trình duyệt khi logo đổi, không được đọc.
 *
 * Kiểu nội dung là kiểu đọc LẠI theo chữ ký byte (png / jpeg / webp), `nosniff`, `inline` — tệp người dùng tải lên
 * không bao giờ được trình duyệt đoán thành HTML.
 */
export async function GET() {
  const guard = await apiGuard(null, { format: "text" });
  if (guard instanceof Response) return guard;
  const logo = await readLogo();
  if (!logo) return new NextResponse("Không có logo", { status: 404, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  return new NextResponse(new Uint8Array(logo.data), {
    status: 200,
    headers: {
      "content-type": logo.mime,
      "content-length": String(logo.data.length),
      "content-disposition": "inline; filename=\"logo\"",
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=300",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

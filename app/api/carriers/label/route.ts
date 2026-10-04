import { NextResponse, type NextRequest } from "next/server";
import { apiGuard } from "@/lib/auth/api-guard";
import { can } from "@/lib/auth/session";
import { labelPdfCore } from "@/lib/carriers/engine";

export const dynamic = "force-dynamic";

/**
 * NHÃN IN CỦA HÃNG CHỈ TRẢ TỆP PDF SAU TOKEN (GHTK · POS tự chủ).
 *
 * GHTK không có link in công khai: nhãn là tệp PDF mà chỉ token của shop đọc được. ERP chuyển tiếp tệp — token KHÔNG BAO GIỜ ra
 * trình duyệt. Cần phiên đăng nhập + quyền vận đơn; mã phải là của một lần gửi ERP tạo bằng đúng hãng đó (`labelPdfCore`).
 */
export async function GET(request: NextRequest) {
  // apiGuard: 401 chưa đăng nhập · 403 module Giao vận tắt / tổ chức ngừng / thiếu quyền (S18).
  const guard = await apiGuard("shipments:manage", { format: "text" });
  if (guard instanceof Response) return guard;
  const { user } = guard;
  if (!can(user, "shipments:manage")) return NextResponse.json({ error: "Không có quyền thao tác vận đơn" }, { status: 403 });
  const carrier = request.nextUrl.searchParams.get("carrier");
  const code = request.nextUrl.searchParams.get("code");
  const r = await labelPdfCore(user, carrier, code);
  if (!r.ok) return new NextResponse(r.error, { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new NextResponse(Buffer.from(r.pdf), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="nhan-${r.trackingCode.replace(/[^A-Za-z0-9.-]/g, "_")}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}

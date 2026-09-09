import { NextResponse } from "next/server";
import { can, getCurrentUser } from "@/lib/auth/session";
import { getIdeaImage } from "@/lib/queries/ideas";

export const dynamic = "force-dynamic";

/**
 * Phục vụ ảnh của ý tưởng marketing.
 *
 * Ảnh nằm trong CSDL nên phải đi qua đây thay vì link tĩnh. Vẫn đòi phiên đăng nhập: ảnh ý tưởng
 * là tài liệu nội bộ, không để ai có link cũng xem được.
 *
 * Ảnh không bao giờ đổi nội dung sau khi tải lên (sửa ảnh = xoá rồi thêm ảnh mới, id khác) nên
 * cho trình duyệt giữ lâu — danh sách ý tưởng có nhiều ảnh, tải lại mỗi lần vào trang là phí.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Chưa đăng nhập", { status: 401 });
  if (!can(user, "ideas:view")) return new NextResponse("Không có quyền xem ý tưởng", { status: 403 });
  const { id } = await ctx.params;
  const anh = await getIdeaImage(id);
  if (!anh) return new NextResponse("Không tìm thấy ảnh", { status: 404 });
  const buffer = Buffer.from(anh.data, "base64");
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "content-type": anh.contentType || "image/jpeg",
      "content-length": String(buffer.length),
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}

import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { can, getCurrentUser } from "@/lib/auth/session";
import { readCreativeImage } from "@/lib/creative/images";

export const dynamic = "force-dynamic";

/**
 * Phục vụ điểm ảnh của vòng mẫu quảng cáo (ảnh nguồn · ảnh mẫu sinh ra).
 *
 * Ảnh nằm trong CSDL nên phải đi qua đây; vẫn đòi phiên đăng nhập và quyền xem ý tưởng — cùng cách
 * `app/api/ideas/images/[id]/route.ts` làm. Đọc qua `readCreativeImage` (đường đọc DUY NHẤT), nên
 * ảnh đã bị xoá điểm ảnh (mẫu thua quá hạn giữ) trả 404 chứ không trả một ảnh rỗng.
 *
 * Nội dung của một id không bao giờ đổi (sinh lại = ảnh mới, id mới) nên cho trình duyệt giữ lâu.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Chưa đăng nhập", { status: 401 });
  if (!can(user, "ideas:view")) return new NextResponse("Không có quyền xem ảnh vòng mẫu", { status: 403 });
  const { id } = await ctx.params;
  const anh = await readCreativeImage(await getDb(), id);
  if (!anh) return new NextResponse("Không tìm thấy ảnh, hoặc điểm ảnh đã bị xoá", { status: 404 });
  return new NextResponse(new Uint8Array(anh.bytes), {
    headers: {
      "content-type": anh.contentType || "image/jpeg",
      "content-length": String(anh.bytes.length),
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}

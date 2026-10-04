import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/api-guard";
import { can } from "@/lib/auth/session";
import { readFieldJobPhoto } from "@/lib/queries/field-jobs";

export const dynamic = "force-dynamic";

/**
 * Ảnh trước / sau của PHIẾU CÔNG VIỆC (0200 · `field_job_photos`). Đòi phiên + quyền xem phiếu của CHÍNH tổ chức (CSDL ngữ
 * cảnh). Kiểu nội dung là kiểu ĐÃ KIỂM lúc tải lên (JPEG / PNG / WEBP); `nosniff` + `sandbox` như các tệp khác trong CSDL.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await apiGuard(null, { format: "text" });
  if (guard instanceof Response) return guard;
  const { user } = guard;
  if (!can(user, "field_jobs:view")) return new NextResponse("Không có quyền xem phiếu công việc", { status: 403 });
  const { id } = await ctx.params;
  const img = await readFieldJobPhoto(id);
  if (!img) return new NextResponse("Không tìm thấy ảnh", { status: 404 });
  return new NextResponse(new Uint8Array(img.data), {
    status: 200,
    headers: {
      "content-type": img.contentType,
      "content-length": String(img.data.length),
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}

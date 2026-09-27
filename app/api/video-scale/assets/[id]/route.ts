import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { apiGuard } from "@/lib/auth/api-guard";
import { can } from "@/lib/auth/session";
import { parseByteRange } from "@/lib/constants/production-files";
import { VIDEO_ASSET_CHUNK_BYTES } from "@/lib/constants/video-scale";
import { getAssetMeta, readAssetRange } from "@/lib/video-scale/storage";

export const dynamic = "force-dynamic";

/**
 * Phục vụ tệp của Video Scale (clip nguồn, bản hoàn chỉnh, ảnh bìa, giọng đọc, nhạc).
 *
 * Tệp nằm trong CSDL nên phải đi qua đây; đòi phiên đăng nhập + quyền xem ý tưởng (cùng quyền xem ảnh vòng mẫu). Hỗ trợ
 * `Range` (Safari không phát video nếu không có 206); khoảng mở cắt còn tối đa 2 khúc để một lượt mở video không nạp cả
 * tệp vào RAM. Kiểu nội dung là kiểu máy chủ tự đặt lúc ghi; `nosniff` + `sandbox` để tệp không bao giờ chạy như trang.
 */
const OPEN_RANGE_MAX = 2 * VIDEO_ASSET_CHUNK_BYTES;

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await apiGuard(null, { format: "text" });
  if (guard instanceof Response) return guard;
  const { user } = guard;
  if (!can(user, "ideas:view")) return new NextResponse("Không có quyền xem tệp Video Scale", { status: 403 });
  const { id } = await ctx.params;
  const db = await getDb();
  const meta = await getAssetMeta(db, id);
  if (!meta) return new NextResponse("Không tìm thấy tệp, hoặc nội dung đã bị xoá sau hạn giữ", { status: 404 });
  const headers: Record<string, string> = {
    "content-type": meta.contentType,
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
    "cache-control": "private, max-age=31536000, immutable",
  };
  const range = parseByteRange(request.headers.get("range"), meta.bytes);
  if (range === "UNSATISFIABLE") return new NextResponse(null, { status: 416, headers: { ...headers, "content-range": `bytes */${meta.bytes}` } });
  if (!range) {
    const body = await readAssetRange(db, meta.id, 0, meta.bytes - 1);
    return new NextResponse(new Uint8Array(body), { status: 200, headers: { ...headers, "content-length": String(body.length) } });
  }
  const open = /^bytes=\d+-$/.test((request.headers.get("range") ?? "").trim());
  const end = open ? Math.min(range.end, range.start + OPEN_RANGE_MAX - 1) : range.end;
  const body = await readAssetRange(db, meta.id, range.start, end);
  return new NextResponse(new Uint8Array(body), {
    status: 206,
    headers: { ...headers, "content-length": String(body.length), "content-range": `bytes ${range.start}-${range.start + body.length - 1}/${meta.bytes}` },
  });
}

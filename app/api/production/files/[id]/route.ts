import { NextResponse } from "next/server";
import { can, getCurrentUser } from "@/lib/auth/session";
import { parseByteRange, TOPIC_FILE_CHUNK_BYTES } from "@/lib/constants/production-files";
import { getTopicFileMeta, readTopicFileRange } from "@/lib/queries/production-files";

export const dynamic = "force-dynamic";

/**
 * Phục vụ ảnh / video đính kèm topic sản xuất (`production_topic_files`).
 *
 * Tệp nằm trong CSDL nên phải đi qua đây; vẫn đòi phiên đăng nhập + quyền xem sản xuất (`planning:view`,
 * cùng quyền của trang topic) — ảnh mẫu chưa ra mắt là tài liệu nội bộ.
 *
 * Hỗ trợ `Range`: Safari KHÔNG phát video nếu máy chủ không trả 206, và tua video chỉ xin đúng đoạn cần.
 * Khoảng mở (`bytes=0-`, cái trình duyệt gửi đầu tiên) được cắt còn tối đa 2 khúc — trả ít hơn khoảng xin
 * là hợp lệ, trình duyệt tự xin tiếp — để một lượt mở video 50 MB không nạp cả tệp vào RAM.
 *
 * Kiểu nội dung là kiểu ĐÃ KIỂM trong danh sách đóng lúc tải lên; `nosniff` + `sandbox` để một tệp khai
 * sai kiểu không bao giờ được trình duyệt chạy như một trang.
 */
const OPEN_RANGE_MAX = 2 * TOPIC_FILE_CHUNK_BYTES;

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Chưa đăng nhập", { status: 401 });
  if (!can(user, "planning:view")) return new NextResponse("Không có quyền xem sản xuất", { status: 403 });
  const { id } = await ctx.params;
  const meta = await getTopicFileMeta(id);
  if (!meta) return new NextResponse("Không tìm thấy tệp", { status: 404 });

  const headers: Record<string, string> = {
    "content-type": meta.contentType,
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
    // Nội dung một tệp không bao giờ đổi (gỡ rồi tải lại là id khác).
    "cache-control": "private, max-age=31536000, immutable",
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(meta.fileName || `tep-${meta.id}`)}`,
  };

  const range = parseByteRange(request.headers.get("range"), meta.bytes);
  if (range === "UNSATISFIABLE") {
    return new NextResponse(null, { status: 416, headers: { ...headers, "content-range": `bytes */${meta.bytes}` } });
  }
  if (!range) {
    const body = await readTopicFileRange(meta.id, 0, meta.bytes - 1);
    return new NextResponse(new Uint8Array(body), { status: 200, headers: { ...headers, "content-length": String(body.length) } });
  }
  const moRong = /^bytes=\d+-$/.test((request.headers.get("range") ?? "").trim());
  const end = moRong ? Math.min(range.end, range.start + OPEN_RANGE_MAX - 1) : range.end;
  const body = await readTopicFileRange(meta.id, range.start, end);
  return new NextResponse(new Uint8Array(body), {
    status: 206,
    headers: { ...headers, "content-length": String(body.length), "content-range": `bytes ${range.start}-${range.start + body.length - 1}/${meta.bytes}` },
  });
}

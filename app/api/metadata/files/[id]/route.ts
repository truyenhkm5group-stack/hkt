import { NextResponse } from "next/server";
import { apiGuard, API_DENY_MESSAGE } from "@/lib/auth/api-guard";
import { audit } from "@/lib/audit";
import { customFileResponseHeaders } from "@/lib/metadata/display";
import { openCustomFile } from "@/lib/metadata/values";

export const dynamic = "force-dynamic";

/**
 * TẢI TỆP CỦA FIELD TUỲ BIẾN KIỂU `file` (Phase 2 M3 · Phase 3.1).
 *
 * Tệp nằm trong CSDL CỦA TỔ CHỨC (`custom_files.data`, bytea) — không có đường dẫn hệ thống nào để lộ, và
 * `getDb()` đọc đúng CSDL của phiên: id của tổ chức khác không tồn tại ở đây.
 *
 * Mã trả về:
 *  · 401 / 403 `ORG_INACTIVE` — `apiGuard` (phiên, tổ chức). Đường dẫn thuộc lõi (`/api/metadata`), nên cổng
 *    đường dẫn không tắt được nó; module của ĐỐI TƯỢNG sở hữu tệp thì kiểm ở dưới.
 *  · 403 `MODULE_DISABLED` — module của đối tượng đang tắt (cùng mã, cùng câu với `apiGuard`).
 *  · 404 — MỌI lý do còn lại, CÙNG MỘT CÂU: id sai định dạng, id không có (kể cả id của tổ chức khác), field đã
 *    lưu trữ, bản ghi đã xoá, thiếu quyền xem field. Không cho người ngoài dò id nào có thật.
 *  · 200 — byte của tệp. Kiểu mở-ngay chỉ theo danh sách ĐÓNG (ảnh raster, pdf); mọi kiểu khác, kể cả html / svg,
 *    đi dạng `application/octet-stream` + `attachment` (`customFileResponseHeaders`) — tệp người dùng tải lên
 *    không bao giờ được chạy như một trang trên miền ERP.
 *
 * Nhật ký tải xuống: `audit()` entity `CUSTOM_FILE`, action `CUSTOM_FILE_DOWNLOAD` — ai, tệp nào, của bản ghi
 * nào; KHÔNG ghi nội dung. Hành động nằm trong `KHONG_DOI_SO_LIEU` của `lib/audit.ts` nên một lượt tải chỉ tốn
 * đúng một dòng nhật ký, không xoá đệm báo cáo.
 */
const NOT_FOUND = "Không tìm thấy tệp";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await apiGuard(null, { format: "text" });
  if (guard instanceof Response) return guard;
  const { user } = guard;
  const { id } = await ctx.params;
  const r = await openCustomFile(id, user);
  if (!r.ok) {
    if (r.code === "MODULE_DISABLED") return new NextResponse(API_DENY_MESSAGE.MODULE_DISABLED, { status: 403, headers: { "x-erp-deny": "MODULE_DISABLED", "cache-control": "private, no-store" } });
    return new NextResponse(NOT_FOUND, { status: 404, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  }
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CUSTOM_FILE_DOWNLOAD",
    entity: "CUSTOM_FILE",
    entityId: id,
    detail: { objectKey: r.objectKey, recordId: r.recordId, fieldKey: r.fieldKey, filename: r.file.filename, size: r.file.size },
  });
  return new NextResponse(new Uint8Array(r.file.data), { status: 200, headers: customFileResponseHeaders({ ...r.file, size: r.file.data.length }) });
}

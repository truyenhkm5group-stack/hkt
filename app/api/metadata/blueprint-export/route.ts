import { NextResponse } from "next/server";
import { apiGuard, API_DENY_MESSAGE } from "@/lib/auth/api-guard";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth/session";
import { exportDenial, exportFileName, exportForUser } from "@/lib/blueprints/export";

export const dynamic = "force-dynamic";

/**
 * TẢI BLUEPRINT CẤU HÌNH CỦA TỔ CHỨC (Phase 11 · H3) — `/settings/export`.
 *
 *  · 401 / 403 — `apiGuard` (phiên, tổ chức còn hoạt động). `/api/metadata` thuộc lõi nên module không tắt được nó.
 *  · 403 `FORBIDDEN` — thiếu `metadata:manage` HOẶC `settings:manage` (xuất là đọc CẢ cấu hình).
 *  · 409 — phiên thuộc tổ chức khác với ngữ cảnh đang chạy: không bao giờ xuất cấu hình của B cho người của A.
 *  · 200 — JSON của gói, luôn `attachment` + `nosniff` + `private, no-store`: tệp chỉ để tải về, không để trình duyệt
 *    dựng như một trang, và không nằm lại trong đệm dùng chung nào.
 *
 * Tổ chức là tổ chức của NGỮ CẢNH (`getDb()`), không có tham số nào nhận mã tổ chức. Một dòng nhật ký
 * `BLUEPRINT_EXPORT` (ai, gói nào, băm nội dung) — không ghi nội dung gói.
 */
export async function GET() {
  const guard = await apiGuard(null, { format: "text" });
  if (guard instanceof Response) return guard;
  const { user } = guard;
  // Hai khoá quản trị hỏi TƯỜNG MINH ở cửa route (xuất là đọc CẢ cấu hình); `exportDenial` lặp lại cùng luật + tổ chức.
  const denial = !can(user, "metadata:manage") || !can(user, "settings:manage") ? "FORBIDDEN" : exportDenial(user);
  if (denial) return new NextResponse(API_DENY_MESSAGE.FORBIDDEN, { status: 403, headers: { "x-erp-deny": "FORBIDDEN", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  const r = await exportForUser(user);
  if (!r.ok) return new NextResponse(r.error, { status: 409, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  const { blueprint, contentHash, validation, omitted } = r.value;
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "BLUEPRINT_EXPORT",
    entity: "BLUEPRINT",
    entityId: blueprint.key,
    detail: { version: blueprint.version, contentHash, valid: validation.ok, omitted: omitted.length },
  });
  const body = `${JSON.stringify(blueprint, null, 2)}\n`;
  const name = exportFileName(blueprint);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
      "content-security-policy": "sandbox; default-src 'none'",
    },
  });
}

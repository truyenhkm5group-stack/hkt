/**
 * ═══════════ MÀN HÌNH LỖI KHÔNG RÒ NỘI DUNG LỖI VÀ LUÔN CÓ LỐI RA (app/(dashboard)/error.tsx · app/error.tsx) ═══════════
 *
 * Đo 08/10/2026 (Commercial Sweep C1 #11): màn hình lỗi dashboard in nguyên `error.message` kèm «kiểm tra DATABASE_URL và xem
 * log server» cho mọi người dùng — khách Chốt Đơn đọc được tên bảng / câu SQL / đường dẫn tệp của máy chủ, và câu chỉ dẫn là cho
 * người cài máy chủ. Trang ngoài dashboard không có màn hình lỗi nào (màn trắng tiếng Anh của Next). Khoá ở mức mã nguồn:
 *  1. Hai màn hình tồn tại, là client component (`"use client"`), nhận `reset`.
 *  2. KHÔNG in `error.message` / `error.stack` / `String(error)`; KHÔNG nhắc `DATABASE_URL`, «log server», SQL.
 *  3. Chỉ in MÃ THAM CHIẾU (`error.digest`) — đủ để hỗ trợ tra log, không đủ để lộ nội bộ.
 *  4. Lối ra tải CẢ TRANG bằng `<a href="/">` (không `<Link>`): trạng thái bộ định tuyến có thể chính là thứ hỏng (#671 / #686).
 *  5. Giữ ERROR_MARKER «Có lỗi khi tải trang» cho lá chắn smoke (scripts/smoke.ts) — bài smoke-coverage khoá riêng, đây kiểm lại.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function testErrorBoundary() {
  const marker = /const ERROR_MARKER = "([^"]+)"/.exec(readFileSync("scripts/smoke.ts", "utf8"))?.[1] ?? "";
  assert.ok(marker.length > 5, "ERROR_MARKER của smoke phải là chuỗi thật");
  for (const f of ["app/(dashboard)/error.tsx", "app/error.tsx"]) {
    const raw = readFileSync(f, "utf8");
    // Quét MÃ, không quét chú thích: chú thích được phép kể lại lỗi cũ («in error.message», «DATABASE_URL») để giải thích vì sao.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    assert.match(raw, /^"use client";/, `${f}: error boundary phải là client component`);
    assert.match(src, /reset/, `${f}: phải có nút Thử lại (reset)`);
    assert.doesNotMatch(src, /error\.message|error\.stack|String\(error\)|\{error\}/, `${f}: không in nội dung lỗi cho người dùng`);
    assert.doesNotMatch(src, /DATABASE_URL|log server|SQL/i, `${f}: không chỉ dẫn dành cho người cài máy chủ`);
    assert.match(src, /error\.digest/, `${f}: in mã tham chiếu để hỗ trợ tra log`);
    assert.match(src, /<a href="\/"/, `${f}: lối ra tải cả trang bằng thẻ <a>, không điều hướng phía client`);
    assert.doesNotMatch(src, /from "next\/link"/, `${f}: không dùng <Link> ở màn hình lỗi`);
    assert.ok(src.includes(marker), `${f}: giữ ERROR_MARKER «${marker}» cho lá chắn smoke`);
  }
  console.log("  ✓ màn hình lỗi: dashboard + gốc là client component, không in error.message / DATABASE_URL, chỉ mã tham chiếu, lối ra <a href=\"/\">, giữ ERROR_MARKER");
}

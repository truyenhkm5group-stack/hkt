import assert from "node:assert/strict";
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS_ADDED_AFTER_SNAPSHOT, resolvePermissions } from "@/lib/auth/permissions";

/**
 * QUYỀN TUỲ CHỈNH KHÔNG ĐƯỢC ĐÓNG BĂNG NGƯỜI DÙNG.
 *
 * Lỗi đã xảy ra thật: tài khoản Quản lý có danh sách quyền tuỳ chỉnh 37 khoá lưu từ trước, nên khi
 * ERP thêm module Ý tưởng marketing thì menu không hiện — và không ai biết vì sao, vì thiếu quyền
 * chỉ đơn giản là không thấy gì cả.
 *
 * Quy tắc: danh sách tuỳ chỉnh chỉ nói về những khoá ĐÃ TỒN TẠI lúc lưu. Khoá sinh ra sau đó áp
 * mẫu của vai trò; khoá đã tồn tại mà bị bỏ ra vẫn là quyết định có chủ ý, phải giữ nguyên.
 */
export async function testPermissions() {
  const moi = PERMISSIONS_ADDED_AFTER_SNAPSHOT[0];
  assert.ok(moi, "phải khai báo được khoá quyền nào là mới so với các bản lưu cũ");

  // ───────── 1. Bản lưu CŨ (không có ảnh chụp) ─────────
  // Mô phỏng đúng tình huống thật: danh sách lưu trước khi khoá mới ra đời.
  const luuCu = (ALL_PERMISSIONS as string[]).filter((p) => !PERMISSIONS_ADDED_AFTER_SNAPSHOT.includes(p) && p !== "payroll:view");
  const ketQua = resolvePermissions("MANAGER", luuCu, null, null);
  assert.ok(ketQua.includes(moi), "khoá sinh ra SAU khi lưu phải theo mẫu vai trò, không bị đóng băng");
  assert.ok(!ketQua.includes("payroll:view"), "khoá đã tồn tại mà bị bỏ ra là quyết định có chủ ý — phải giữ nguyên");

  // ───────── 2. Bản lưu MỚI (có ảnh chụp) ─────────
  // Đã được hỏi về khoá mới và cố ý không cấp ⇒ tôn trọng, không tự cấp lại.
  const anhChup = [...(ALL_PERMISSIONS as string[])];
  const coYKhongCap = resolvePermissions("MANAGER", luuCu, null, anhChup);
  assert.ok(!coYKhongCap.includes(moi), "đã được hỏi mà không cấp thì không được tự cấp lại");

  // ───────── 3. Không có danh sách tuỳ chỉnh thì dùng nguyên mẫu vai trò ─────────
  const theoMau = resolvePermissions("MANAGER", null, null, null);
  assert.deepEqual([...theoMau].sort(), [...DEFAULT_ROLE_PERMISSIONS.MANAGER].sort(), "không tuỳ chỉnh thì đúng bằng mẫu vai trò");
  assert.ok(theoMau.includes(moi), "mẫu vai trò Quản lý phải có khoá mới");

  // ───────── 4. ADMIN luôn toàn quyền, kể cả khi có danh sách tuỳ chỉnh ─────────
  const admin = resolvePermissions("ADMIN", ["dashboard:view"], null, null);
  assert.equal(admin.length, ALL_PERMISSIONS.length, "quản trị viên luôn có đủ mọi khoá");

  // ───────── 5. Khoá mới không được vượt quá mẫu vai trò ─────────
  // Vai trò không có khoá đó trong mẫu thì cũng không được tự nhiên có.
  const kho = resolvePermissions("WAREHOUSE", [], null, null);
  const mauKho = new Set<string>(DEFAULT_ROLE_PERMISSIONS.WAREHOUSE);
  for (const p of kho) {
    assert.ok(mauKho.has(p), `khoá ${p} không có trong mẫu vai trò Kho thì không được cấp`);
  }

  console.log(`✓ Quyền: khoá mới (${PERMISSIONS_ADDED_AFTER_SNAPSHOT.length} khoá) theo mẫu vai trò cho bản lưu cũ, tôn trọng quyết định đã có, ADMIN toàn quyền`);
}

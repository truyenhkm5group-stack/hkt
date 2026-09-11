import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, PERMISSION_LABEL } from "@/lib/auth/permissions";
import { ROLE_LABEL } from "@/lib/constants/roles";

/**
 * ───────── KIỂM SOÁT TRUY CẬP & TRÁCH NHIỆM ─────────
 *
 * Lỗ hổng thật đã tìm thấy khi rà soát: **năm đường xuất CSV chỉ hỏi "đã đăng nhập chưa"**, không
 * hỏi quyền. Một bạn kho hay CSKH — người không mở được trang Báo cáo lợi nhuận — vẫn tải được
 * nguyên file CSV doanh thu, giá vốn, lợi nhuận, và file đơn hàng kèm tên, số điện thoại, địa chỉ
 * khách, chỉ cần biết đường dẫn. Cùng kiểu đó: bấm đẩy lại vận đơn sang Viettel Post và bấm thử
 * kết nối API cũng chỉ cần "đã đăng nhập".
 *
 * Ma trận quyền đã ghi đúng từ đầu; chỗ sai là mã nguồn KHÔNG hỏi tới nó. Bài kiểm thử này bắt đúng
 * loại sai đó ở mức mã nguồn, vì nó không thể hiện ra trên giao diện: menu ẩn đi không có nghĩa là
 * đường dẫn bị khoá.
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name === "route.ts") out.push(full.split(path.sep).join("/"));
  }
  return out;
}

/**
 * Đường công khai CÓ CHỦ ĐÍCH — mỗi mục phải nêu lý do.
 * Webhook không có phiên đăng nhập: chúng tự xác thực bằng bí mật trong URL / phong bì phản hồi.
 */
const CO_Y_CONG_KHAI: Record<string, string> = {
  "app/api/health/route.ts": "health check cho Docker và giám sát — không trả dữ liệu kinh doanh",
  "app/api/webhooks/pancake/[secret]/[[...event]]/route.ts": "webhook Pancake, xác thực bằng bí mật trong đường dẫn",
  "app/api/webhooks/viettelpost/route.ts": "webhook Viettel Post, phải trả HTTP 200 trong 1 giây",
  "app/api/webhooks/vtp-statement/route.ts": "webhook bảng kê Viettel Post",
  "app/api/webhooks/sepay/route.ts": "webhook SePay, xác thực bằng HMAC-SHA256 trên byte gốc + chống phát lại 5 phút — không có phiên đăng nhập",
  "app/api/sync/[job]/route.ts": "gọi bằng x-cron-secret (bộ lập lịch) hoặc phiên có quyền sync:run",
};

export function testAccessControl() {
  const routes = walk("app/api");
  assert.ok(routes.length >= 15, `phải quét được toàn bộ route, mới thấy ${routes.length}`);

  let daKhoa = 0;
  for (const file of routes) {
    if (CO_Y_CONG_KHAI[file]) continue;
    const src = readFileSync(file, "utf8");
    // "Đã đăng nhập" KHÔNG phải kiểm soát truy cập: mọi nhân viên đều đăng nhập được.
    const coQuyen = /can\(\s*user\s*,\s*"[a-z0-9:_-]+"\s*\)/.test(src) || /requirePermission\(\s*"[a-z0-9:_-]+"\s*\)/.test(src);
    assert.ok(
      coQuyen,
      `${file}: chỉ kiểm tra phiên đăng nhập là chưa đủ — phải hỏi đúng quyền của module. Menu ẩn không khoá được đường dẫn.`,
    );
    daKhoa += 1;
  }

  // Mọi khoá quyền được dùng trong mã phải TỒN TẠI trong ma trận. Gõ sai một chữ thì lệnh kiểm tra
  // luôn trả về "không có quyền" và không ai hiểu vì sao — một lỗi im lặng đúng nghĩa.
  const nguon = [...walk("app/api"), ...tsFiles("app"), ...tsFiles("lib"), ...tsFiles("components")];
  const dungKhoa = new Set<string>();
  for (const file of nguon) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:requirePermission|hasPermission|can)\(\s*(?:user,\s*|subject,\s*)?"([a-z0-9:_-]+)"/g)) dungKhoa.add(m[1]);
    for (const m of src.matchAll(/permission:\s*"([a-z0-9:_-]+)"/g)) dungKhoa.add(m[1]);
  }
  const la = [...dungKhoa].filter((k) => !(ALL_PERMISSIONS as string[]).includes(k));
  assert.deepEqual(la, [], `khoá quyền không có trong ma trận (gõ sai thì luôn bị từ chối, im lặng): ${la.join(", ")}`);

  // Mọi khoá trong ma trận phải có nhãn tiếng Việt — trang phân quyền hiện khoá thô thì không ai
  // dám bấm.
  for (const key of ALL_PERMISSIONS) {
    assert.ok(PERMISSION_LABEL[key]?.length > 3, `khoá quyền ${key} chưa có nhãn tiếng Việt`);
  }

  // Mọi vai trò phải có mẫu quyền, và không vai trò nào cầm khoá lạ.
  for (const role of Object.keys(ROLE_LABEL) as (keyof typeof ROLE_LABEL)[]) {
    const perms = DEFAULT_ROLE_PERMISSIONS[role];
    assert.ok(Array.isArray(perms), `vai trò ${role} chưa có mẫu quyền`);
    const laCuaVaiTro = perms.filter((p) => !(ALL_PERMISSIONS as string[]).includes(p));
    assert.deepEqual(laCuaVaiTro, [], `vai trò ${role} cầm khoá không tồn tại: ${laCuaVaiTro.join(", ")}`);
  }
  // Chỉ quản trị viên được toàn quyền. Một vai trò khác vô tình bằng ADMIN là mất kiểm soát mà
  // không ai nhận ra.
  for (const role of Object.keys(DEFAULT_ROLE_PERMISSIONS) as (keyof typeof DEFAULT_ROLE_PERMISSIONS)[]) {
    if (role === "ADMIN") continue;
    assert.ok(
      DEFAULT_ROLE_PERMISSIONS[role].length < ALL_PERMISSIONS.length,
      `vai trò ${role} đang có đủ mọi quyền như quản trị viên — nếu cố ý thì phải đổi vai trò, không phải mở hết khoá`,
    );
  }

  // ───────── Ghi dữ liệu thì phải có người chịu trách nhiệm ─────────
  // Mỗi file hành động có phép ghi drizzle phải vừa kiểm quyền vừa ghi nhật ký. Thiếu nhật ký thì
  // sau này không ai trả lời được "ai sửa con số này".
  // Đăng nhập là ngoại lệ duy nhất và hiển nhiên: chưa có phiên thì không có quyền nào để hỏi.
  // Nó vẫn PHẢI ghi nhật ký — biết ai đăng nhập lúc nào là một phần của trách nhiệm.
  const KHONG_CAN_QUYEN: Record<string, string> = {
    "lib/actions/auth.ts": "đăng nhập / đăng xuất — chạy khi người dùng chưa có phiên",
  };
  const actions = readdirSync("lib/actions").filter((f) => f.endsWith(".ts"));
  let coGhi = 0;
  for (const name of actions) {
    const file = `lib/actions/${name}`;
    const src = readFileSync(file, "utf8");
    if (!/\.(insert|update|delete)\s*\(/.test(src)) continue;
    coGhi += 1;
    if (!KHONG_CAN_QUYEN[file]) {
      assert.ok(/requirePermission\(|requireUser\(/.test(src), `${file}: có phép ghi nhưng không kiểm quyền`);
    }
    assert.ok(/\baudit\(/.test(src), `${file}: có phép ghi nhưng không ghi nhật ký — mất dấu vết ai đã sửa`);
  }
  assert.ok(coGhi >= 10, `phải quét được các file hành động có ghi dữ liệu, mới thấy ${coGhi}`);

  console.log(
    `✓ Kiểm soát truy cập: ${daKhoa} route đòi đúng quyền (không route nào chỉ hỏi "đã đăng nhập") · ${CO_Y_CONG_KHAI ? Object.keys(CO_Y_CONG_KHAI).length : 0} đường công khai có lý do · ${dungKhoa.size} khoá dùng trong mã đều có trong ma trận · ${coGhi} file hành động ghi dữ liệu đều kiểm quyền và ghi nhật ký`,
  );
}

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(full, out);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full.split(path.sep).join("/"));
  }
  return out;
}

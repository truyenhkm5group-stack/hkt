import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  LOCAL_TEST_DATABASE_URL,
  LOCAL_TEST_FLAG,
  guardLocalDatabase,
  isLocalDatabaseUrl,
  isLocalTestMode,
  pgliteDirectory,
} from "@/lib/local-mode";

/**
 * BẢN TEST TRÊN MÁY — ba điều phải giữ, vì hỏng cái nào cũng hỏng cả quy trình "thử trước, đưa
 * lên ERP sau":
 *
 *   1. Lệnh dựng bản test XOÁ và GIEO lại dữ liệu ⇒ chỉ được chạm vào CSDL của máy mình. Địa chỉ
 *      lạ, địa chỉ đọc không ra, hay CSDL của máy chủ thật đều phải bị chặn.
 *   2. Nhãn "BẢN TEST" chỉ bật bằng cờ ERP_LOCAL_TEST=1. Không được suy từ địa chỉ CSDL: máy chủ
 *      thật cũng nối tới CSDL trong mạng nội bộ của nó, suy kiểu đó là ERP thật đeo nhãn test.
 *   3. `.env.local` (nơi giữ cờ và khoá phiên của bản test) không bao giờ được vào kho mã.
 */
export function testLocalMode() {
  // 1. CSDL nào là "máy mình"
  assert.equal(isLocalDatabaseUrl(LOCAL_TEST_DATABASE_URL), true, "PGlite trong thư mục dự án phải là máy mình");
  assert.equal(isLocalDatabaseUrl("pglite:memory"), true);
  assert.equal(isLocalDatabaseUrl("postgresql://erp:erp_secret@localhost:5432/erp?schema=public"), true);
  assert.equal(isLocalDatabaseUrl("postgres://erp:erp_secret@127.0.0.1:5432/erp"), true);
  assert.equal(isLocalDatabaseUrl("postgresql://erp:erp_secret@erp.vnxcommerce.com:5432/erp"), false, "CSDL trên máy chủ thật KHÔNG phải máy mình");
  assert.equal(isLocalDatabaseUrl("postgresql://erp:erp_secret@db:5432/erp"), false, "tên dịch vụ Docker Compose của máy chủ thật phải bị chặn");
  assert.equal(isLocalDatabaseUrl(""), false, "chưa biết địa chỉ thì phải coi như dữ liệu thật");
  assert.equal(isLocalDatabaseUrl(undefined), false);
  assert.equal(isLocalDatabaseUrl("mysql://localhost/erp"), false);

  // Cổng chặn nói rõ lý do và KHÔNG in mật khẩu ra màn hình.
  const chan = guardLocalDatabase("postgresql://erp:mat_khau_that@erp.vnxcommerce.com:5432/erp");
  assert.equal(chan.ok, false);
  if (!chan.ok) {
    assert.ok(chan.error.includes("ngoài máy này"), "phải nói rõ vì sao bị chặn");
    assert.ok(!chan.error.includes("mat_khau_that"), "thông báo lỗi không được lộ mật khẩu");
  }
  const cho = guardLocalDatabase(LOCAL_TEST_DATABASE_URL);
  assert.equal(cho.ok, true);
  assert.equal(guardLocalDatabase("").ok, false, "thiếu DATABASE_URL thì không được chạy tiếp");

  // 2. Nhãn "BẢN TEST" chỉ bật bằng cờ, không suy từ CSDL
  assert.equal(isLocalTestMode({ [LOCAL_TEST_FLAG]: "1" }), true);
  assert.equal(isLocalTestMode({ [LOCAL_TEST_FLAG]: " 1 " }), true);
  assert.equal(isLocalTestMode({ [LOCAL_TEST_FLAG]: "0" }), false);
  assert.equal(isLocalTestMode({}), false, "không có cờ ⇒ là bản thật, không hiện nhãn test");
  assert.equal(isLocalTestMode({ DATABASE_URL: LOCAL_TEST_DATABASE_URL }), false, "CSDL nội bộ KHÔNG được tự bật nhãn test");

  // Thư mục dữ liệu để lệnh `--reset` xoá đúng chỗ
  assert.equal(pgliteDirectory(LOCAL_TEST_DATABASE_URL), "./data/pglite-local");
  assert.equal(pgliteDirectory("pglite:memory"), null);
  assert.equal(pgliteDirectory("postgresql://erp@localhost/erp"), null, "PostgreSQL không có thư mục để xoá");

  // 3. Cấu hình bản test không được vào kho mã
  if (existsSync(".gitignore")) {
    const bo = readFileSync(".gitignore", "utf8");
    assert.ok(/^\.env\.local$/m.test(bo), ".gitignore phải bỏ qua .env.local — tệp này giữ khoá phiên của bản test");
  }

  console.log("✓ Bản test trên máy: cổng chặn CSDL, nhãn BẢN TEST và .env.local");
}

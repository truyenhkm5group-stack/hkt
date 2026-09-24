/**
 * ═══════ SCRIPT ĐỐI CHIẾU PHẢI CHỈ ĐỌC, VÀ ĐÓ LÀ RÀNG BUỘC CHỨ KHÔNG PHẢI LỜI HỨA ═══════
 *
 * Script này được thiết kế để chạy trên PRODUCTION. Một script chạy ở đó với quyền ghi, mà ai đó
 * "tiện tay" thêm một dòng `update`, là một lượt sửa dữ liệu thật không ai duyệt và không ai thấy.
 *
 * Nên quét MÃ NGUỒN đã vào kho. Đây là loại lỗi không bài kiểm nào bắt được bằng cách CHẠY: chạy
 * thử trên CSDL kiểm thử thì một lệnh `update` cũng thành công êm đẹp.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";

export function testPayrollReconcileScript() {
  const src = execSync("git show HEAD:scripts/payroll-reconcile.ts", { encoding: "utf8" });

  // ─────────── 1. KHÔNG MỘT LỆNH GHI NÀO ───────────
  const camGhi = [
    ".insert(",
    ".update(",
    ".delete(",
    "db.transaction",
    "setSettingJson",
    "movePayrollRun",
    "migrateEmployeeToPolicy",
    "finalizePayrollPeriod",
    "saveEmployeePolicyAssignment",
    "savePayrollInput",
    "savePayrollAdjustment",
    "activateSalaryPolicyVersion",
  ];
  for (const c of camGhi) {
    assert.ok(!src.includes(c), `script đối chiếu gọi \`${c}\` — nó chạy trên PRODUCTION, và một lệnh ghi ở đó là một lượt sửa dữ liệu thật không ai duyệt`);
  }

  // Không import lược đồ: không có lược đồ thì không dựng được một lệnh ghi nào.
  assert.ok(!/from\s+"@\/db"/.test(src), "script đối chiếu KHÔNG được import lược đồ CSDL — không có nó thì không dựng được lệnh ghi");
  assert.ok(!/\bsql`\s*(insert|update|delete|drop|alter|truncate)/i.test(src), "không được dựng lệnh ghi bằng SQL thô");

  // ─────────── 2. NÓI RÕ NÓ CHỈ ĐỌC, NGAY TRÊN MÀN HÌNH NGƯỜI CHẠY ───────────
  /*
    Người chạy một script trên production cần biết nó làm gì TRƯỚC khi nó chạy xong, không phải sau.
  */
  assert.ok(/CHỈ ĐỌC/.test(src), "script phải in ra rằng nó chỉ đọc — người chạy trên production cần biết điều đó trước khi nó chạy xong");

  // ─────────── 3. DÙNG ĐÚNG ĐƯỜNG ĐỐI CHIẾU CỦA MÀN HÌNH ───────────
  /*
    Nếu script tự dựng phép so riêng thì nó là một đường tính THỨ BA, và nó sẽ khớp với màn hình
    đúng tới lúc một trong hai bên đổi.
  */
  assert.ok(src.includes("previewLegacyMigration"), "script phải dùng CHÍNH đường đối chiếu mà màn hình dùng, không dựng phép so riêng");

  // ─────────── 4. CÓ ĐƯỜNG XUẤT BÁO CÁO ───────────
  assert.ok(src.includes("--json") && src.includes("--csv"), "phải xuất được báo cáo để đính kèm khi ra quyết định");

  // ─────────── 5. ĐĂNG KÝ TRONG package.json ───────────
  /*
    Một script không có lối chạy thì với người vận hành nó không tồn tại — cùng bài học với
    `tests/action-wiring.test.ts`.
  */
  const pkg = JSON.parse(execSync("git show HEAD:package.json", { encoding: "utf8" })) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts["payroll:reconcile"], "script đối chiếu phải có lối chạy trong package.json");
  assert.ok(pkg.scripts["payroll:reconcile"].includes("payroll-reconcile.ts"), "và lối ấy phải trỏ đúng tệp");

  /*
    ─────────── 6. "CHỈ ĐỌC" PHẢI LÀ RÀNG BUỘC CỦA MÁY CHỦ, KHÔNG PHẢI LỜI HỨA CỦA MÃ NGUỒN ───────────

    Khối 1 chứng minh BẢN THÂN script không có lệnh ghi. Nhưng nó gọi `previewLegacyMigration`, và
    lần theo cây phụ thuộc thì tới cả `lib/sync/runner.ts`, `lib/integrations/facebook/*`,
    `lib/settings.ts` — những tệp CÓ lệnh ghi thật. Script không gọi tới chúng hôm nay; nhưng
    "hôm nay không gọi" là thứ chỉ đúng cho tới lần sửa sau.

    Nên chỗ dựa không phải phép quét, mà là `default_transaction_read_only=on` đặt ngay ở gói khởi
    tạo kết nối: CHÍNH POSTGRES từ chối mọi INSERT/UPDATE/DELETE/DDL, bất kể mã nào chạy. (Thao tác
    `db-query` đi xa hơn một bậc từ 24/09/2026: role `erp_ro` không có quyền ghi, nên cờ ấy chỉ còn là
    lớp thứ hai — `scripts/ops-erp-ro-role.sql`.)
  */
  {
    // Cờ phải được bật TRƯỚC mọi import chạm tới `@/db` — đặt trong `main()` là quá muộn, bể kết
    // nối đã dựng xong từ lúc mô-đun được nạp.
    const viTriCo = src.indexOf('process.env.ERP_READ_ONLY = "1"');
    assert.ok(viTriCo > 0, "script phải tự bật chế độ chỉ đọc cho chính nó");
    const viTriImportDb = src.search(/import\s[^\n]*from\s+"@\/(db|lib\/queries)/);
    assert.ok(
      viTriImportDb < 0 || viTriCo < viTriImportDb,
      "cờ chỉ đọc phải đứng TRƯỚC import đầu tiên chạm tới CSDL — đặt sau thì bể kết nối đã dựng xong với quyền ghi",
    );

    const dbSrc = execSync("git show HEAD:db/index.ts", { encoding: "utf8" });
    assert.ok(dbSrc.includes("ERP_READ_ONLY"), "db/index.ts phải đọc cờ ấy — không thì script bật một cờ không ai nghe");
    assert.ok(dbSrc.includes("default_transaction_read_only=on"), "và phải đẩy nó xuống tham số kết nối PostgreSQL");
    assert.ok(
      dbSrc.includes("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY"),
      "PGlite không nhận tham số kết nối nên phải đặt ở mức phiên — bỏ sót thì máy cá nhân chạy với quyền ghi trong khi tưởng là chỉ đọc",
    );
  }

  console.log("  ✓ Script đối chiếu lương: không một lệnh ghi nào · không import lược đồ · CHÍNH POSTGRES ép chỉ đọc (`default_transaction_read_only=on`, bật trước khi mở kết nối) · dùng chung đường đối chiếu với màn hình · xuất được JSON/CSV");
}

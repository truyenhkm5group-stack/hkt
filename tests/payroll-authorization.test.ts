import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { canAdministerPayroll, canOpenPayroll, canSeeAllPayroll, payrollLineVisible, resolvePayrollScope, PAYROLL_SCOPES, TEAM_SCOPE_NOT_IMPLEMENTED, type PayrollScope } from "@/lib/auth/payroll-scope";
import { DEFAULT_ROLE_PERMISSIONS, resolvePermissions, rolePermissions, type RolePermissionMap } from "@/lib/auth/permissions";
import { SENSITIVE_BY_PERMISSION } from "@/lib/constants/access-scope";

/**
 * ═══════════ AI XEM ĐƯỢC LƯƠNG CỦA AI ═══════════
 *
 * Bài này khoá một sự cố ĐÃ ĐO ĐƯỢC TRÊN PRODUCTION (15/09/2026), không phải một giả thiết:
 *
 *   `settings['auth.rolePermissions']` có mảng cho vai trò `MANAGER`, và mảng ấy chứa
 *   `payroll:view`. `rolePermissions()` đọc mẫu vai trò bằng phép THAY THẾ, nên mảng lưu ấy LÀ
 *   quyền của vai trò và mặc định trong mã không được hỏi tới.
 *
 * Nghĩa là: **một bản vá quyền chỉ sửa mặc định trong mã sẽ không với tới được production.** Đó
 * là điều bài này tồn tại để không bao giờ xảy ra lần nữa — nên fixture dưới đây dựng lại ĐÚNG
 * hình dạng cấu hình thật, và bài kiểm đòi kết quả phải là KHÔNG PHẢI `ALL`.
 *
 * `matches` dùng khắp bài là phép khớp bằng KHOÁ TÀI KHOẢN (email), giống `employeeMatchesUser`.
 */

type NV = { name: string; shortName: string; userEmail?: string };
const matches = (e: NV, u: { email: string }) => Boolean((e.userEmail ?? "").trim()) && (e.userEmail ?? "").trim().toLowerCase() === (u.email ?? "").trim().toLowerCase();

/** Dựng một người dùng như `requireUser()` trả về: quyền ĐÃ tính xong từ vai trò + bản ghi đè. */
function nguoiDung(role: string, templates: RolePermissionMap | null, custom: string[] | null = null) {
  return { role, permissions: resolvePermissions(role as never, custom, templates, null) };
}

export function testPayrollAuthorization() {
  /* ═══ 1. BẢN GHI ĐÈ THẬT TRÊN PRODUCTION KHÔNG ĐƯỢC MỞ BẢNG LƯƠNG TOÀN CÔNG TY ═══ */
  {
    // Hình dạng đúng như production: một mảng cho MANAGER, trong đó có `payroll:view`.
    const production: RolePermissionMap = {
      MANAGER: ["dashboard:view", "orders:read", "reports:nominal", "payroll:view"] as never,
    };

    const manager = nguoiDung("MANAGER", production);
    assert.ok(manager.permissions.includes("payroll:view"), "fixture phải giữ đúng khoá cũ mà production đang có, nếu không bài kiểm này vô nghĩa");
    assert.ok(!manager.permissions.includes("payroll:view-all"), "bản ghi đè cũ KHÔNG được tự sinh ra khoá xem toàn công ty");

    const scope = resolvePayrollScope(manager);
    assert.notEqual(scope, "ALL", "BẢN GHI ĐÈ CŨ VẪN MỞ ĐƯỢC LƯƠNG TOÀN CÔNG TY — đây chính là lỗ hổng bản vá này sinh ra để đóng");
    assert.equal(scope, "SELF");
    assert.equal(canSeeAllPayroll(scope), false);

    // Và không dòng nào của NGƯỜI KHÁC lọt qua.
    const toi = { email: "manager@shop.vn" };
    assert.equal(payrollLineVisible(scope, { name: "Quản lý", shortName: "QL", userEmail: "manager@shop.vn" }, toi, matches), true);
    assert.equal(payrollLineVisible(scope, { name: "Người khác", shortName: "NK", userEmail: "khac@shop.vn" }, toi, matches), false);
  }

  /* ═══ 2. MA TRẬN PHÂN GIẢI PHẠM VI ═══ */
  {
    const legacy = (role: string): RolePermissionMap => ({ [role]: ["dashboard:view", "payroll:view"] }) as never;

    // ADMIN: toàn quyền — `can()` cũng đối xử với ADMIN như vậy, hai máy phải nói cùng một điều.
    assert.equal(resolvePayrollScope(nguoiDung("ADMIN", null)), "ALL");

    // ACCOUNTANT theo MẶC ĐỊNH TRONG MÃ: có khoá toàn công ty tường minh.
    assert.ok(DEFAULT_ROLE_PERMISSIONS.ACCOUNTANT.includes("payroll:view-all" as never), "kế toán cần bảng lương toàn công ty để trả tiền — đây là quyết định tường minh");
    assert.equal(resolvePayrollScope(nguoiDung("ACCOUNTANT", null)), "ALL");

    // MANAGER / LEADER với khoá CŨ ⇒ SELF, không bao giờ ALL.
    for (const role of ["MANAGER", "LEADER"]) {
      assert.equal(resolvePayrollScope(nguoiDung(role, legacy(role))), "SELF", `${role} mang khoá cũ vẫn phải rơi về SELF`);
    }

    // MANAGER / LEADER theo MẶC ĐỊNH TRONG MÃ: cũng không có khoá toàn công ty.
    for (const role of ["MANAGER", "LEADER"] as const) {
      assert.ok(!DEFAULT_ROLE_PERMISSIONS[role].includes("payroll:view-all" as never), `${role} KHÔNG được có khoá xem lương toàn công ty theo mặc định`);
      assert.notEqual(resolvePayrollScope(nguoiDung(role, null)), "ALL");
    }

    // Nhân viên chỉ có khoá "của mình".
    assert.equal(resolvePayrollScope({ role: "MARKETING", permissions: ["payroll:view-own"] }), "SELF");

    // Không có quyền lương nào ⇒ NONE, và không mở được màn hình.
    assert.equal(resolvePayrollScope({ role: "CS", permissions: ["dashboard:view"] }), "NONE");
    assert.equal(canOpenPayroll("NONE"), false);

    // Vai trò lạ / thiếu dữ liệu ⇒ NONE. Mọi nhánh hỏng rơi về phía HẸP HƠN.
    assert.equal(resolvePayrollScope({ role: "KHONG_TON_TAI", permissions: [] }), "NONE");
    assert.equal(resolvePayrollScope(null), "NONE");
    assert.equal(resolvePayrollScope(undefined), "NONE");
    assert.equal(resolvePayrollScope({ role: "MANAGER", permissions: null }), "NONE");
    assert.equal(resolvePayrollScope({} as never), "NONE");
  }

  /* ═══ 3. CẤU HÌNH HỎNG / THIẾU ⇒ KHÔNG BAO GIỜ NỚI RỘNG ═══ */
  {
    // Thiếu hẳn bản ghi đè: rơi về mặc định trong mã (đã an toàn).
    assert.notEqual(resolvePayrollScope(nguoiDung("MANAGER", null)), "ALL");
    assert.notEqual(resolvePayrollScope(nguoiDung("LEADER", {})), "ALL");

    // Bản ghi đè méo mó: không phải mảng ⇒ `rolePermissions` bỏ qua, dùng mặc định.
    for (const beo of [{ MANAGER: "payroll:view-all" }, { MANAGER: null }, { MANAGER: 123 }, { MANAGER: { payroll: true } }]) {
      const scope = resolvePayrollScope(nguoiDung("MANAGER", beo as never));
      assert.notEqual(scope, "ALL", `cấu hình méo mó ${JSON.stringify(beo)} không được nâng quyền`);
    }

    // Khoá rác trong mảng bị lọc bỏ, không sinh quyền.
    const rac = nguoiDung("MANAGER", { MANAGER: ["payroll:view-all-the-things", "payroll:*", "payroll:viewall"] } as never);
    assert.equal(resolvePayrollScope(rac), "NONE", "khoá gần giống KHÔNG được tính là khoá thật — hệ thống không có ký tự đại diện");
  }

  /* ═══ 4. CHIỀU KÉO CỦA QUYỀN CHỈ ĐI TỪ RỘNG XUỐNG HẸP ═══ */
  {
    // Ai có khoá toàn công ty thì đương nhiên xem được của mình.
    const all = rolePermissions("MANAGER" as never, { MANAGER: ["payroll:view-all"] } as never);
    assert.ok(all.includes("payroll:view-own"), "xem-tất-cả phải kéo theo xem-của-mình");
    assert.equal(resolvePayrollScope({ role: "MANAGER", permissions: all }), "ALL");

    // Nhưng khoá cũ TUYỆT ĐỐI không kéo ngược lên khoá toàn công ty.
    const cu = rolePermissions("MANAGER" as never, { MANAGER: ["payroll:view"] } as never);
    assert.ok(!cu.includes("payroll:view-all"), "`payroll:view` KHÔNG được kéo theo `payroll:view-all` — đó là cả điểm của bản vá");
  }

  /* ═══ 5. `TEAM` CHƯA XÂY ⇒ TỪ CHỐI, KHÔNG BAO GIỜ NÂNG THÀNH `ALL` ═══ */
  {
    assert.equal(TEAM_SCOPE_NOT_IMPLEMENTED, true);
    assert.ok(PAYROLL_SCOPES.includes("TEAM"), "mức TEAM phải có tên để buộc mọi câu rẽ nhánh phải xử lý nó");

    assert.equal(canSeeAllPayroll("TEAM"), false, "TEAM nằm giữa SELF và ALL — một câu switch viết ẩu rất dễ cho nó đi chung đường với ALL");
    assert.equal(canOpenPayroll("TEAM"), false);
    assert.equal(payrollLineVisible("TEAM", { name: "A", shortName: "A", userEmail: "a@shop.vn" }, { email: "a@shop.vn" }, matches), false, "kể cả dòng của CHÍNH MÌNH: TEAM là mức chưa xây, nó phải từ chối hẳn chứ không hoạt động một nửa");

    // Không mức nào ngoài ALL cho xem dòng người khác.
    for (const scope of PAYROLL_SCOPES) {
      const thay = payrollLineVisible(scope as PayrollScope, { name: "Người khác", shortName: "NK", userEmail: "khac@shop.vn" }, { email: "toi@shop.vn" }, matches);
      assert.equal(thay, scope === "ALL", `chỉ ALL mới được thấy dòng của người khác — mức ${scope} thì không`);
    }
  }

  /* ═══ 6. IDOR: ĐỔI `?employee=` KHÔNG ĐƯỢC ĐỔI THỨ MÌNH THẤY ═══ */
  {
    const toi = { email: "a@shop.vn" };
    const lines = [
      { employee: { name: "A", shortName: "A", userEmail: "a@shop.vn" }, id: "A" },
      { employee: { name: "B", shortName: "B", userEmail: "b@shop.vn" }, id: "B" },
      { employee: { name: "C không khai email", shortName: "C", userEmail: undefined }, id: "C" },
    ];
    const visible = (scope: PayrollScope) => lines.filter((l) => payrollLineVisible(scope, l.employee, toi, matches));

    // Đúng trình tự của màn hình: LỌC trước, rồi mới chọn theo tham số địa chỉ.
    const chon = (scope: PayrollScope, wanted: string) => visible(scope).find((l) => l.id === wanted);

    assert.equal(chon("SELF", "A")?.id, "A", "tự xem phiếu lương của mình thì được");
    assert.equal(chon("SELF", "B"), undefined, "đổi ?employee= sang người khác KHÔNG được trả dòng của họ");
    assert.equal(chon("SELF", "C"), undefined);
    assert.equal(chon("NONE", "A"), undefined);
    assert.equal(chon("TEAM", "B"), undefined);
    assert.equal(chon("ALL", "B")?.id, "B", "người có quyền toàn công ty thì xem được");

    // Chưa khai email ⇒ không khớp ai. Mất quyền xem, không phải lộ dữ liệu.
    const chuaKhai = { email: "" };
    assert.equal(payrollLineVisible("SELF", lines[2].employee, chuaKhai, matches), false);
    assert.equal(lines.filter((l) => payrollLineVisible("SELF", l.employee, chuaKhai, matches)).length, 0);
  }

  /* ═══ 7. XEM KHÔNG BAO GIỜ SINH RA QUYỀN GHI ═══ */
  {
    const xemHet = { role: "ACCOUNTANT", permissions: rolePermissions("ACCOUNTANT" as never, null) };
    assert.equal(resolvePayrollScope(xemHet), "ALL");
    for (const ghi of ["payroll:manage", "payroll:approve"]) {
      assert.ok(!xemHet.permissions.includes(ghi), `xem toàn công ty KHÔNG được kéo theo ${ghi} — khai số và duyệt số là hai việc khác`);
    }

    const managerProd = nguoiDung("MANAGER", { MANAGER: ["payroll:view"] } as never);
    for (const ghi of ["payroll:manage", "payroll:approve"]) {
      assert.ok(!managerProd.permissions.includes(ghi), `khoá cũ ${"payroll:view"} không được sinh ra ${ghi}`);
    }
  }

  /* ═══ 7b. `payroll:manage` MỘT MÌNH KHÔNG MỞ ĐƯỢC MÀN HÌNH IN RA TIỀN CỦA MỌI NGƯỜI ═══ */
  {
    /*
      Lỗ hổng THỨ HAI đo được cùng ngày: mảng ghi đè của MANAGER trên production mang CẢ
      `payroll:view` LẪN `payroll:manage`. Chặn `/payroll` mà để ngỏ `/payroll/migration` thì bản vá
      bị đi vòng qua đúng một mục trong thanh tab — `previewLegacyMigration` dựng bảng lương cũ/mới
      cho TOÀN BỘ nhân sự.
    */
    const managerProd = nguoiDung("MANAGER", { MANAGER: ["dashboard:view", "payroll:view", "payroll:manage"] } as never);
    assert.ok(managerProd.permissions.includes("payroll:manage"), "fixture phải giữ đúng cấu hình production, nếu không bài kiểm này vô nghĩa");

    assert.equal(canAdministerPayroll(managerProd, true), false, "CÓ quyền khai báo nhưng KHÔNG có phạm vi toàn công ty ⇒ không được mở màn hình quản trị lương");
    assert.equal(resolvePayrollScope(managerProd), "SELF");

    // Kế toán: có phạm vi toàn công ty nhưng KHÔNG có quyền khai báo ⇒ cũng không vào được.
    const ketToan = nguoiDung("ACCOUNTANT", null);
    assert.equal(resolvePayrollScope(ketToan), "ALL");
    assert.equal(canAdministerPayroll(ketToan, false), false, "xem được không có nghĩa là sửa được");

    // Phải có ĐỦ HAI.
    const quanTriLuong = { role: "MANAGER", permissions: ["payroll:view-all", "payroll:manage"] };
    assert.equal(canAdministerPayroll(quanTriLuong, true), true);

    // ADMIN luôn vào được, khớp với `can()`.
    assert.equal(canAdministerPayroll({ role: "ADMIN", permissions: [] }, false), true);

    // Không người dùng ⇒ từ chối.
    assert.equal(canAdministerPayroll(null, true), false);
  }

  /* ═══ 8. KHOÁ TOÀN CÔNG TY NẰM TRONG VÙNG NHẠY CẢM, NHƯ BA KHOÁ LƯƠNG KIA ═══ */
  {
    for (const p of ["payroll:view", "payroll:view-all", "payroll:manage", "payroll:approve"]) {
      assert.ok(SENSITIVE_BY_PERMISSION[p], `${p} phải nằm trong một vùng nhạy cảm để phạm vi dữ liệu còn cắt được nó`);
      assert.equal(SENSITIVE_BY_PERMISSION[p].department, "HR");
    }
  }

  /* ═══ 9. QUÉT MÃ NGUỒN: KHÔNG CỔNG NÀO ĐƯỢC TỰ VIẾT LẠI LUẬT ═══ */
  {
    const goc = path.resolve(__dirname, "..");
    const files: string[] = [];
    const di = (thuMuc: string) => {
      for (const f of fs.readdirSync(path.join(goc, thuMuc), { withFileTypes: true })) {
        const p = `${thuMuc}/${f.name}`;
        if (f.isDirectory()) di(p);
        else if (/\.tsx?$/.test(f.name)) files.push(p);
      }
    };
    di("app");
    di("lib");

    /*
      `can(user, "payroll:view")` là ĐÚNG hình dạng của lỗ hổng vừa sửa: nó đọc một khoá mà cấu
      hình cũ trên production đang mang, và nó trả về "xem tất cả". Không cổng nào được viết lại
      câu ấy — phạm vi tính ở `lib/auth/payroll-scope.ts`, một chỗ.
    */
    const pham: string[] = [];
    for (const f of files) {
      if (f === "lib/auth/payroll-scope.ts" || f === "lib/auth/permissions.ts") continue;
      const src = fs.readFileSync(path.join(goc, f), "utf8");
      if (/can\(\s*user\s*,\s*"payroll:view"\s*\)/.test(src)) pham.push(`${f}: đọc thẳng "payroll:view" làm cổng`);
      if (/can\(\s*user\s*,\s*"payroll:view-own"\s*\)/.test(src)) pham.push(`${f}: đọc thẳng "payroll:view-own" làm cổng`);
    }
    assert.deepEqual(pham, [], `Cổng lương phải đi qua resolvePayrollScope():\n${pham.join("\n")}`);

    // Và mọi màn hình / điểm cuối lương thật sự có gọi máy tính phạm vi.
    for (const f of ["app/(dashboard)/payroll/page.tsx", "app/(dashboard)/payroll/payslip/page.tsx", "app/(dashboard)/payroll/runs/page.tsx", "app/api/export/payroll/route.ts"]) {
      const src = fs.readFileSync(path.join(goc, f), "utf8");
      assert.ok(/resolvePayrollScope\(/.test(src), `${f} phải tính phạm vi ở máy chủ trước khi đọc dữ liệu`);
    }

    /*
      NĂM MÀN HÌNH QUẢN TRỊ VÀ CÁC HÀNH ĐỘNG GHI phải đi qua `canAdministerPayroll`. `payroll:manage`
      một mình là chưa đủ — production cấp đúng khoá ấy cho MANAGER.
    */
    for (const f of [
      "app/(dashboard)/payroll/policies/page.tsx",
      "app/(dashboard)/payroll/assignments/page.tsx",
      "app/(dashboard)/payroll/adjustments/page.tsx",
      "app/(dashboard)/payroll/migration/page.tsx",
      "app/(dashboard)/payroll/settings/page.tsx",
      "lib/actions/payroll.ts",
      "lib/actions/payroll-policy.ts",
      "lib/actions/payroll-period.ts",
      "lib/actions/payroll-preview.ts",
      "lib/actions/payroll-run.ts",
    ]) {
      const src = fs.readFileSync(path.join(goc, f), "utf8");
      assert.ok(/canAdministerPayroll\(/.test(src), `${f}: quyền khai báo lương một mình KHÔNG được mở màn hình / hành động in ra tiền của mọi người`);
      assert.ok(
        !/^\s*if \(!can\(user, "payroll:manage"\)\)/m.test(src),
        `${f}: còn một cổng chỉ hỏi "payroll:manage" — production cấp đúng khoá ấy cho MANAGER, nên nó không còn đủ một mình`,
      );
    }

    // Tệp xuất phải lọc bằng đúng hàm chung — đây là nơi dữ liệu rời khỏi hệ thống thành một tệp.
    const exportSrc = fs.readFileSync(path.join(goc, "app/api/export/payroll/route.ts"), "utf8");
    assert.ok(/payrollLineVisible\(/.test(exportSrc), "cổng xuất tệp phải lọc dòng bằng cùng một luật với màn hình");
  }
}

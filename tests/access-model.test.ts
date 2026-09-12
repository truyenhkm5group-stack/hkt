import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { applyScope, effectiveAccess, grantedPermissions, type CustomRole } from "@/lib/auth/access";
import { ROLE_BUILDER_FORBIDDEN, SENSITIVE_AREAS } from "@/lib/constants/access-scope";
import { saveAccessRoleSchema, setUserAccessSchema } from "@/lib/validation/access";

/**
 * ═══════════════ BA CHIỀU QUYỀN TRUY CẬP: VAI TRÒ · CHỨC DANH · PHẠM VI ═══════════════
 *
 * Đặc tả ở đầu `lib/constants/access-scope.ts`. Bài này khoá bốn tính chất mà nếu mất đi thì
 * mô hình trông vẫn chạy nhưng đã hỏng — và hỏng theo hướng NỚI RỘNG, kiểu hỏng mà không ai
 * phát hiện cho tới lúc dữ liệu đã lộ:
 *
 *  1. CHỨC DANH KHÔNG SINH QUYỀN — khoá ở mức MÃ NGUỒN, vì đây là thứ người ta thêm vào "cho
 *     tiện" chứ không phải thứ ai đó cố tình phá.
 *  2. Vai trò tuỳ chỉnh KHÔNG cấp được quyền quản lý người dùng — chặn ngay ở lược đồ đầu vào.
 *  3. Phạm vi CHỈ THU HẸP, và chỉ thu hẹp đúng vùng nhạy cảm.
 *  4. Mọi nhánh hỏng (vai trò bị tắt, dữ liệu lạ) rơi về phía HẸP HƠN, không bao giờ về toàn quyền.
 */

function quetMaNguon(): { file: string; src: string }[] {
  const goc = path.resolve(__dirname, "..");
  const ra: { file: string; src: string }[] = [];
  const di = (thuMuc: string) => {
    for (const f of fs.readdirSync(path.join(goc, thuMuc), { withFileTypes: true })) {
      const p = `${thuMuc}/${f.name}`;
      if (f.isDirectory()) di(p);
      else if (f.name.endsWith(".ts") || f.name.endsWith(".tsx")) ra.push({ file: p, src: fs.readFileSync(path.join(goc, p), "utf8") });
    }
  };
  di("lib");
  di("app");
  return ra;
}

/** Các hàm TÍNH QUYỀN. Không cái nào được nhận chức danh làm đầu vào. */
const HAM_TINH_QUYEN = ["grantedPermissions", "applyScope", "effectiveAccess", "resolvePermissions", "rolePermissions", "hasPermission", "can"];

/** Hai tệp DUY NHẤT được phép tính quyền. Chúng phải không biết chức danh tồn tại. */
const MAY_TINH_QUYEN = ["lib/auth/access.ts", "lib/auth/permissions.ts"];

function boChuThich(src: string) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * LÁ CHẮN MÃ NGUỒN: không đường nào nối CHỨC DANH sang QUYỀN.
 *
 * Cái bẫy: đặt chức danh "Kế toán trưởng" rồi ở đâu đó code đọc chuỗi ấy và mở quyền tài chính.
 * Từ lúc đó ĐỔI TÊN CHỨC DANH LÀ LEO THANG QUYỀN, mà người đổi tên tưởng mình chỉ sửa một cái
 * nhãn. Khoá bằng hai mệnh đề hẹp và kiểm được, thay vì một phép quét rộng:
 *
 *  · MÁY TÍNH QUYỀN KHÔNG BIẾT CHỨC DANH TỒN TẠI — hai tệp tính quyền không được nhắc tới nó.
 *  · KHÔNG LỜI GỌI NÀO truyền chức danh vào một hàm tính quyền.
 *
 * Cố ý KHÔNG cấm hai chữ đứng cùng dòng: `columns: { permissions, positionId }` hay một dòng
 * nhật ký ghi cả hai là chuyện bình thường và đúng. Một lá chắn bắt cả những dòng vô hại sẽ bị
 * người ta tắt đi, và lúc đó nó không chặn được gì nữa.
 */
export function testPositionGrantsNothing() {
  const tep = quetMaNguon();
  assert.ok(tep.length > 200, `đọc hụt mã nguồn (chỉ thấy ${tep.length} tệp)`);

  const pham: string[] = [];

  // Mệnh đề 1: máy tính quyền không được nhắc tới chức danh.
  for (const f of MAY_TINH_QUYEN) {
    const t = tep.find((x) => x.file === f);
    assert.ok(t, `không tìm thấy ${f} — đổi tên tệp thì đổi luôn hằng số MAY_TINH_QUYEN ở đây`);
    for (const dong of boChuThich(t.src).split("\n")) {
      if (/position/i.test(dong)) pham.push(`${f} (máy tính quyền không được biết chức danh tồn tại): ${dong.trim().slice(0, 140)}`);
    }
  }

  // Mệnh đề 2: không lời gọi hàm tính quyền nào nhận chức danh làm đối số.
  const goi = new RegExp(`\\b(${HAM_TINH_QUYEN.join("|")})\\s*\\([^)]*position`, "i");
  for (const { file, src } of tep) {
    for (const dong of boChuThich(src).split("\n")) {
      if (goi.test(dong)) pham.push(`${file} (truyền chức danh vào hàm tính quyền): ${dong.trim().slice(0, 140)}`);
    }
  }

  assert.deepEqual(
    pham,
    [],
    `Chức danh không được tham gia vào phép tính quyền. Dòng vi phạm:\n${pham.join("\n")}\n` +
      `Nếu thật sự cần một quyền mới thì thêm khoá quyền, đừng suy quyền từ tên chức danh.`,
  );

  console.log(`✓ Chức danh không sinh quyền: ${MAY_TINH_QUYEN.length} tệp tính quyền không nhắc tới nó, ${tep.length} tệp không lời gọi nào truyền nó vào ${HAM_TINH_QUYEN.length} hàm tính quyền`);
}

/** Vai trò tuỳ chỉnh không được cấp quyền quản lý người dùng — chặn ngay ở cửa vào. */
export function testRoleBuilderCannotEscalate() {
  assert.ok(ROLE_BUILDER_FORBIDDEN.includes("users:manage"), "danh sách cấm phải chứa users:manage");

  const xau = saveAccessRoleSchema.safeParse({
    code: "TU_NANG",
    name: "Tự nâng",
    baseRole: "VIEWER",
    permissions: ["orders:read", "users:manage"],
    defaultScope: "ALL",
  });
  assert.equal(xau.success, false, "lược đồ phải từ chối bó quyền chứa users:manage");

  const tot = saveAccessRoleSchema.safeParse({ code: "THU_QUY", name: "Thủ quỹ", baseRole: "VIEWER", permissions: ["orders:read", "bank:view"], defaultScope: "DEPARTMENT" });
  assert.equal(tot.success, true, "bó quyền hợp lệ phải qua được");

  // `ADMIN` không được làm vai trò nền: nền toàn quyền biến mọi giới hạn phía trên thành trang trí.
  const nenAdmin = saveAccessRoleSchema.safeParse({ code: "X", name: "X", baseRole: "ADMIN", permissions: [], defaultScope: "ALL" });
  assert.equal(nenAdmin.success, false, "lược đồ phải từ chối vai trò nền ADMIN");

  // Phạm vi là danh sách ĐÓNG — chuỗi tự do bị từ chối, không được âm thầm hiểu thành gì đó.
  const phamViLa = setUserAccessSchema.safeParse({ userId: "u1", accessRoleId: "", positionId: "", scope: "mọi thứ" });
  assert.equal(phamViLa.success, false, "phạm vi dạng chuỗi tự do phải bị từ chối");

  // Ngay cả khi một bó quyền cũ trong CSDL đã lỡ chứa quyền cấm, phép tính vẫn phải lọc nó ra.
  const roleXau: CustomRole = { id: "r", code: "R", name: "R", baseRole: "VIEWER", permissions: ["orders:read", "users:manage"], defaultScope: "ALL", active: true };
  const { permissions } = grantedPermissions("CS", null, roleXau, null, null);
  assert.ok(!permissions.includes("users:manage"), "quyền cấm lọt vào CSDL vẫn phải bị lọc lúc tính — hai lớp, không một");

  console.log("✓ Vai trò tuỳ chỉnh không leo thang được: chặn ở lược đồ, chặn lại lúc tính, nền ADMIN bị từ chối, phạm vi là danh sách đóng");
}

/** Phạm vi chỉ THU HẸP, và chỉ thu hẹp đúng vùng nhạy cảm. */
export function testScopeOnlyNarrows() {
  const bo = ["orders:read", "bank:view", "payroll:view", "work:all", "products:view"];

  // `ALL` không đụng gì.
  const toanBo = applyScope("CS", bo, "ALL", []);
  assert.deepEqual(toanBo.permissions, bo, "phạm vi ALL không được đổi danh sách quyền");
  assert.equal(toanBo.dropped.length, 0);

  // Phạm vi hẹp + không thuộc phòng sở hữu ⇒ quyền nhạy cảm bị cắt, quyền thường giữ nguyên.
  const hep = applyScope("CS", bo, "DEPARTMENT", ["SALES"]);
  assert.deepEqual(hep.permissions, ["orders:read", "products:view"], "quyền tiền / lương / điều hành phải bị cắt khi người đó không thuộc phòng sở hữu");
  assert.deepEqual(
    hep.dropped.map((d) => d.permission).sort(),
    ["bank:view", "payroll:view", "work:all"],
    "ba quyền nhạy cảm phải được nêu kèm lý do, không biến mất im lặng",
  );
  assert.ok(hep.dropped.every((d) => d.reason.length > 20), "mỗi quyền bị cắt phải nói được VÌ SAO");

  // Thuộc phòng sở hữu ⇒ giữ đúng vùng của mình, vẫn mất vùng của phòng khác.
  const keToan = applyScope("ACCOUNTANT", bo, "DEPARTMENT", ["FINANCE"]);
  assert.ok(keToan.permissions.includes("bank:view"), "người thuộc phòng Kế toán phải giữ được quyền sổ ngân hàng");
  assert.ok(!keToan.permissions.includes("payroll:view"), "nhưng không vì thế mà thấy lương của người khác");

  // Phạm vi KHÔNG BAO GIỜ thêm quyền: kết quả luôn là tập con.
  for (const scope of ["SELF", "ASSIGNED", "TEAM", "DEPARTMENT", "ALL"] as const) {
    const r = applyScope("CS", bo, scope, ["SALES", "FINANCE", "HR", "MANAGEMENT"]);
    assert.ok(r.permissions.every((p) => bo.includes(p)), `phạm vi ${scope} không được thêm quyền nào`);
  }

  // ADMIN không phải đối tượng của luật này — họ là người dựng ra nó.
  assert.deepEqual(applyScope("ADMIN", bo, "SELF", []).permissions, bo, "quản trị viên không bị phạm vi cắt");

  console.log(`✓ Phạm vi chỉ thu hẹp: ${SENSITIVE_AREAS.length} vùng nhạy cảm, cắt đúng vùng, nêu đủ lý do, không nhánh nào thêm quyền`);
}

/** Vai trò tuỳ chỉnh bị TẮT phải rơi về mẫu vai trò hệ thống — không bao giờ về toàn quyền. */
export function testDisabledRoleFallsBackNarrow() {
  const roleRong: CustomRole = { id: "r", code: "R", name: "Rộng", baseRole: "VIEWER", permissions: ["orders:read", "bank:view", "cod:write"], defaultScope: "ALL", active: true };
  const bat = grantedPermissions("VIEWER", null, roleRong, null, null);
  assert.equal(bat.source, "CUSTOM_ROLE");
  assert.ok(bat.permissions.includes("cod:write"), "vai trò đang bật phải cấp đúng bó của nó");

  const tat = grantedPermissions("VIEWER", null, { ...roleRong, active: false }, null, null);
  assert.equal(tat.source, "ROLE_TEMPLATE", "vai trò bị tắt phải rơi về mẫu vai trò hệ thống");
  assert.ok(!tat.permissions.includes("cod:write"), "rơi về KHÔNG được giữ lại quyền của bó đã tắt");
  assert.ok(tat.permissions.length < bat.permissions.length + 50, "và không được rơi về toàn quyền");

  // Quyền tuỳ chỉnh riêng của người vẫn thắng vai trò tuỳ chỉnh (đã có từ trước, giữ nguyên ngữ nghĩa).
  const rieng = grantedPermissions("VIEWER", ["orders:read"], roleRong, null, ["orders:read", "bank:view", "cod:write"]);
  assert.equal(rieng.source, "USER_CUSTOM");
  assert.ok(!rieng.permissions.includes("cod:write"), "danh sách riêng của người phải thắng bó vai trò");

  console.log("✓ Mọi nhánh rơi về phía hẹp hơn: vai trò tắt → mẫu hệ thống, quyền riêng thắng bó vai trò");
}

/** Đường đi đầy đủ trên CSDL thật: gán ba chiều, đọc lại, và chức danh không đổi được quyền. */
export async function testAccessModel(db: Db) {
  const P = "acc-";
  const uid = `${P}u1`;

  await db.insert(schema.users).values({ id: uid, email: `${P}a@t.local`, name: "Access A", role: "CS", passwordHash: "x", active: true });
  // Phòng Kế toán do migration gieo sẵn — dùng lại, không tạo bản thứ hai cùng mã.
  const phongKeToan = await db.query.departments.findFirst({ where: eq(schema.departments.code, "FINANCE"), columns: { id: true } });
  assert.ok(phongKeToan, "phòng FINANCE phải được migration gieo sẵn");
  const dFin = phongKeToan.id;

  const [role] = await db
    .insert(schema.accessRoles)
    .values({ code: `${P}THUQUY`.toUpperCase().replace(/-/g, "_"), name: "Thủ quỹ", baseRole: "VIEWER", permissions: ["orders:read", "bank:view"], defaultScope: "DEPARTMENT", active: true })
    .returning({ id: schema.accessRoles.id });
  const [pos] = await db
    .insert(schema.positions)
    .values({ code: `${P}KTT`.toUpperCase().replace(/-/g, "_"), name: "Kế toán trưởng", departmentId: dFin, active: true })
    .returning({ id: schema.positions.id });

  await db.update(schema.users).set({ accessRoleId: role.id, positionId: pos.id, dataScope: "DEPARTMENT" }).where(eq(schema.users.id, uid));

  const cr: CustomRole = { id: role.id, code: "X", name: "Thủ quỹ", baseRole: "VIEWER", permissions: ["orders:read", "bank:view"], defaultScope: "DEPARTMENT", active: true };

  /*
    ĐIỂM MẤU CHỐT: người này MANG CHỨC DANH "Kế toán trưởng" gắn phòng Kế toán, nhưng CHƯA là
    THÀNH VIÊN phòng Kế toán. Chức danh không phải tư cách thành viên, và chỉ tư cách thành viên
    mới mở được vùng nhạy cảm. Nếu một ngày bài này xanh với `bank:view` còn trong danh sách thì
    ai đó đã nối chức danh sang quyền.
  */
  const chuaVaoPhong = effectiveAccess({ role: "CS", userCustom: null, customRole: cr, scope: "DEPARTMENT", departmentCodes: [] });
  assert.ok(!chuaVaoPhong.permissions.includes("bank:view"), "chức danh 'Kế toán trưởng' KHÔNG được tự mở quyền sổ ngân hàng");
  assert.ok(chuaVaoPhong.permissions.includes("orders:read"), "quyền thường vẫn phải còn");
  assert.equal(chuaVaoPhong.dropped[0]?.area, "Tài chính");

  // Xếp họ vào phòng Kế toán — việc thật, có người chịu trách nhiệm, có nhật ký — thì mới mở.
  const daVaoPhong = effectiveAccess({ role: "CS", userCustom: null, customRole: cr, scope: "DEPARTMENT", departmentCodes: ["FINANCE"] });
  assert.ok(daVaoPhong.permissions.includes("bank:view"), "vào phòng Kế toán rồi thì quyền sổ ngân hàng mới có hiệu lực");

  // Phạm vi ALL vẫn là đường mở đủ — và là mặc định của mọi tài khoản đang chạy.
  const toanCongTy = effectiveAccess({ role: "CS", userCustom: null, customRole: cr, scope: "ALL", departmentCodes: [] });
  assert.ok(toanCongTy.permissions.includes("bank:view"), "phạm vi toàn công ty không bị cắt");
  assert.equal(toanCongTy.dropped.length, 0);

  const luu = await db.query.users.findFirst({ where: eq(schema.users.id, uid), columns: { accessRoleId: true, positionId: true, dataScope: true } });
  assert.equal(luu?.dataScope, "DEPARTMENT");
  assert.equal(luu?.accessRoleId, role.id);
  assert.equal(luu?.positionId, pos.id);

  console.log("✓ Ba chiều trên CSDL thật: vai trò tuỳ chỉnh cấp đúng bó · chức danh 'Kế toán trưởng' không tự mở quyền tiền · vào phòng Kế toán mới mở · phạm vi ALL không cắt gì");
}

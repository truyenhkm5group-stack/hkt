import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { decideScope, rowInScope, type ScopeDecision } from "@/lib/auth/scope-guard";
import { SCOPE_RESOURCES, hasRowOwnership } from "@/lib/constants/data-scope-policy";
import { employeeMatchesUser } from "@/lib/queries/payroll";

/**
 * ═══════════════ PHẠM VI DỮ LIỆU PHẢI THẬT SỰ CHẶN ═══════════════
 *
 * TRẠNG THÁI TRƯỚC BẢN NÀY (kiểm kê 13/09/2026): `users.data_scope` tồn tại, hiện trên màn hình
 * quản trị, có trong phiên đăng nhập — và **KHÔNG một hàm truy vấn nào đọc nó**. Chủ shop đặt
 * "Chỉ của mình" cho một người, màn hình xác nhận đã lưu, và người đó vẫn xem được toàn bộ đơn
 * hàng của shop. Một ô cấu hình không nối vào đâu còn tệ hơn không có ô đó: nó tạo ra niềm tin.
 *
 * Bài kiểm này chống đúng bốn kiểu lách, xếp theo mức nguy hiểm:
 *
 *  1. **Nới rộng lặng lẽ** — phạm vi hẹp mà kết quả ra `ALL`. Kiểu chết người nhất, vì không ai thấy.
 *  2. **Nhầm "không có người dùng" thành "hệ thống"** — cookie hỏng phải là ĐÓNG, không phải MỞ.
 *  3. **Bỏ sót tuyến** — khai luật trong sổ nhưng quên gắn vào trang.
 *  4. **Rò rỉ qua con số đếm** — danh sách bị lọc nhưng ô "tổng 384 case" thì không.
 */

function nguoi(over: Partial<SessionUser> = {}): SessionUser {
  return {
    id: "sc-u1",
    email: "nv@t.local",
    name: "Nhân Viên",
    role: "CS",
    permissions: [],
    scope: "ALL",
    departmentCodes: [],
    positionId: null,
    ...over,
  };
}

/** Không chạm CSDL: luật quyết định phải đúng ngay ở mức hàm thuần. */
export async function testScopeDecisions(db: Db) {
  const P = "sc-";
  await db.insert(schema.users).values([
    { id: `${P}u1`, email: `${P}a@t.local`, name: "Người A", role: "CS", passwordHash: "x", active: true },
    { id: `${P}u2`, email: `${P}b@t.local`, name: "Người B", role: "CS", passwordHash: "x", active: true },
  ]);
  const phong = await db.query.departments.findMany({ columns: { id: true, code: true } });
  const finance = phong.find((d) => d.code === "FINANCE")!;
  const sales = phong.find((d) => d.code === "SALES")!;
  await db.insert(schema.departmentMembers).values([
    { departmentId: finance.id, userId: `${P}u1`, roleInDept: "MEMBER", active: true },
    { departmentId: sales.id, userId: `${P}u2`, roleInDept: "LEAD", active: true },
  ]);
  await db.update(schema.departments).set({ leadUserId: `${P}u2` }).where(sql`${schema.departments.id} = ${sales.id}`);

  const keToan = nguoi({ id: `${P}u1`, email: `${P}a@t.local`, name: "Người A", scope: "DEPARTMENT" });
  const truongKD = nguoi({ id: `${P}u2`, email: `${P}b@t.local`, name: "Người B", scope: "TEAM" });

  /* ═══ 1 · KHÔNG BAO GIỜ NỚI RỘNG LẶNG LẼ ═══ */

  // Người phòng Kế toán, phạm vi hẹp: vào được Tài chính…
  const tc = await decideScope("FINANCE", keToan);
  assert.equal(tc.allow, "ALL", "người THUỘC phòng Kế toán, phạm vi DEPARTMENT ⇒ xem được sổ tài chính");

  // …nhưng KHÔNG vào được Quảng cáo (phòng khác), dù có quyền `expenses:view`.
  const qc = await decideScope("ADS", keToan);
  assert.equal(qc.allow, "NONE", "phạm vi DEPARTMENT không cho xem dữ liệu của phòng mình KHÔNG thuộc");
  assert.ok(qc.allow === "NONE" && qc.reason.includes("MARKETING"), "câu từ chối phải nói rõ dữ liệu thuộc phòng nào");
  assert.ok(qc.allow === "NONE" && qc.fix.length > 20, "từ chối phải kèm LỐI RA, không phải ngõ cụt");

  // Và người phòng Kinh doanh KHÔNG vào được Tài chính — vùng nhạy cảm, đúng luật P0.2.
  const tcSai = await decideScope("FINANCE", nguoi({ id: `${P}u2`, email: `${P}b@t.local`, scope: "DEPARTMENT" }));
  assert.equal(tcSai.allow, "NONE", "người ngoài phòng Kế toán không được vào sổ tài chính khi phạm vi đã hẹp");

  /* ═══ 2 · PHẠM VI HẸP TRÊN DỮ LIỆU KHÔNG CÓ CHỦ DÒNG ⇒ TỪ CHỐI, KHÔNG PHẢI CHO XEM HẾT ═══ */
  for (const key of ["ORDERS", "CUSTOMERS", "SHIPMENTS", "REPORTS"]) {
    for (const scope of ["SELF", "ASSIGNED"] as const) {
      const d = await decideScope(key, nguoi({ id: `${P}u1`, email: `${P}a@t.local`, scope }));
      assert.equal(d.allow, "NONE", `${key} + ${scope} phải TỪ CHỐI — bảng không biết ai là chủ của một dòng`);
      assert.ok(d.allow === "NONE" && d.fix.length > 30, `${key} + ${scope}: phải nói được thiếu đúng cái gì`);
    }
  }

  /* ═══ 3 · TEAM KHÔNG PHẢI TRƯỞNG PHÒNG THÌ RƠI XUỐNG, KHÔNG NỚI LÊN ═══ */
  const teamKhongLam = await decideScope("FINANCE", nguoi({ id: `${P}u1`, email: `${P}a@t.local`, scope: "TEAM" }));
  assert.equal(teamKhongLam.allow, "NONE", "TEAM mà không làm trưởng phòng nào thì KHÔNG được mở bằng cả phòng");

  const teamCoLam = await decideScope("CUSTOMERS", truongKD);
  assert.equal(teamCoLam.allow, "ALL", "trưởng phòng Kinh doanh, phạm vi TEAM ⇒ xem được dữ liệu của phòng mình");

  /* ═══ 4 · QUẢN TRỊ VIÊN VÀ PHẠM VI TOÀN CÔNG TY ═══ */
  for (const key of SCOPE_RESOURCES.map((r) => r.key)) {
    assert.equal((await decideScope(key, nguoi({ role: "ADMIN", scope: "SELF" }))).allow, "ALL", `ADMIN không bị phạm vi cắt (${key})`);
    assert.equal((await decideScope(key, nguoi({ scope: "ALL" }))).allow, "ALL", `phạm vi ALL không bị cắt (${key})`);
  }

  /* ═══ 5 · KHÔNG CÓ PHIÊN ⇒ ĐÓNG. Loại lạ ⇒ ĐÓNG. ═══ */
  assert.equal((await decideScope("ORDERS", null)).allow, "NONE", "không có phiên hợp lệ ⇒ ĐÓNG, không phải mở");
  assert.equal((await decideScope("KHONG_CO_LOAI_NAY", nguoi())).allow, "NONE", "loại dữ liệu chưa khai ⇒ ĐÓNG");

  /* ═══ 6 · CSKH: mệnh đề SQL phải LỌC THẬT, VÀ LỌC BẰNG KHOÁ TÀI KHOẢN ═══ */
  /*
    SỰ CỐ ĐÃ CÓ: sổ phạm vi từng nối CSKH theo EMAIL trên cột `assignee` — mà cột đó chứa TÊN HIỂN
    THỊ ("Linh CSKH"), không phải email. Mệnh đề không khớp dòng nào, và người phạm vi "Chỉ của
    mình" mở trang CSKH thấy trống trơn. Khoá thật là `assignee_user_id` / `created_by_user_id`.
  */
  await db.insert(schema.csCases).values([
    { id: `${P}c1`, kind: "OTHER", status: "OPEN", title: "Của A", createdBy: `${P}a@t.local`, createdByUserId: `${P}u1`, assignee: "" },
    { id: `${P}c2`, kind: "OTHER", status: "OPEN", title: "Của B", createdBy: `${P}b@t.local`, createdByUserId: `${P}u2`, assignee: "" },
    // Giao cho A: ô chữ mang TÊN (đúng như trang CSKH ghi), khoá mang tài khoản.
    { id: `${P}c3`, kind: "OTHER", status: "OPEN", title: "Giao cho A", createdBy: `${P}b@t.local`, createdByUserId: `${P}u2`, assignee: "Người A", assigneeUserId: `${P}u1` },
    // Dòng cũ chỉ có tên gõ tay, CHƯA nối khoá: không đoán người (AGENTS.md mục 35) ⇒ không hiện với phạm vi hẹp.
    { id: `${P}c4`, kind: "OTHER", status: "OPEN", title: "Tên gõ tay", createdBy: "pancake-bot", assignee: "Người A" },
  ]);

  const csSelf = await decideScope("CS", nguoi({ id: `${P}u1`, email: `${P}a@t.local`, name: "Người A", scope: "SELF" }));
  assert.equal(csSelf.allow, "ROWS", "CSKH có cột người ⇒ lọc được theo dòng");
  assert.match(csSelf.allow === "ROWS" ? csSelf.explain : "", /khoá tài khoản/, "câu giải thích phải nói lọc bằng KHOÁ, không phải email");
  const dem = async (w: ScopeDecision) => {
    if (w.allow !== "ROWS") throw new Error("cần ROWS");
    const r = await db.execute(sql`select count(*)::int as n from cs_cases where id like ${P + "%"} and (${w.where})`);
    return Number((r as unknown as { rows: { n: number }[] }).rows[0]?.n ?? 0);
  };
  assert.equal(await dem(csSelf), 1, "SELF: chỉ case do chính người đó tạo (created_by_user_id)");

  const csAssigned = await decideScope("CS", nguoi({ id: `${P}u1`, email: `${P}a@t.local`, name: "Người A", scope: "ASSIGNED" }));
  assert.equal(await dem(csAssigned), 2, "ASSIGNED: case được giao (assignee_user_id) CỘNG case của chính mình — case ghi tên 'Người A' mà không có khoá KHÔNG được tính");

  const csKhac = await decideScope("CS", nguoi({ id: `${P}u2`, email: `${P}b@t.local`, name: "Người B", scope: "SELF" }));
  assert.equal(await dem(csKhac), 2, "người khác thấy đúng phần của họ, không thấy phần của A");

  /* ═══ 6b · THAO TÁC GHI HỎI LẠI ĐÚNG MỆNH ĐỀ ĐÓ ═══ */
  assert.equal(await rowInScope(csAssigned, "cs_cases", "id", `${P}c3`), true, "case được giao cho A nằm trong phạm vi ghi của A");
  assert.equal(await rowInScope(csAssigned, "cs_cases", "id", `${P}c2`), false, "case của B KHÔNG nằm trong phạm vi ghi của A — dù A biết id");
  assert.equal(await rowInScope({ allow: "ALL", explain: "" }, "cs_cases", "id", `${P}c2`), true);
  assert.equal(await rowInScope({ allow: "NONE", reason: "", fix: "" }, "cs_cases", "id", `${P}c3`), false, "NONE ⇒ không dòng nào là của họ");
  await assert.rejects(() => rowInScope(csAssigned, "cs_cases; drop table users", "id", "x"), "tên bảng lạ phải bị chặn trước khi ghép vào SQL");

  /* ═══ 7 · CÔNG VIỆC: hàng đợi cá nhân mở, hàng đợi phòng / giao việc đóng với phạm vi hẹp ═══ */
  const nvHep = nguoi({ id: `${P}u1`, email: `${P}a@t.local`, scope: "SELF" });
  assert.equal((await decideScope("WORK", nvHep, "work:view")).allow, "ALL", "SELF vẫn mở hàng đợi CÁ NHÂN — lớp chiếu lọc bằng isMine");
  for (const perm of ["work:department", "work:all", "work:assign"]) {
    const d = await decideScope("WORK", nvHep, perm);
    assert.equal(d.allow, "NONE", `SELF + ${perm} ⇒ TỪ CHỐI: hàng đợi phòng chứa việc chưa giao cho ai, không thu hẹp theo người được`);
    assert.ok(d.allow === "NONE" && d.fix.includes("Việc của tôi"), "lời từ chối phải chỉ về hàng đợi cá nhân");
  }
  assert.equal((await decideScope("WORK", nguoi({ id: `${P}u1`, email: `${P}a@t.local`, scope: "DEPARTMENT" }), "work:department")).allow, "ALL", "DEPARTMENT mở hàng đợi phòng — trang tự giới hạn về phòng của họ");

  /*
    DỌN DẸP. `tests/sync-fixtures.test.ts` dùng CHUNG một CSDL cho mọi khối, và nhiều khối đếm
    tổng số case CSKH. Ba dòng gieo ở trên sẽ làm lệch tổng của những khối chạy sau — AGENTS.md
    mục 6 đã cảnh báo đúng chuyện này. Khối nào gieo thì khối đó dọn.
  */
  await db.execute(sql`delete from cs_cases where id like ${P + "%"}`);
  await db.execute(sql`delete from department_members where user_id like ${P + "%"}`);
  await db.execute(sql`update departments set lead_user_id = null where lead_user_id like ${P + "%"}`);
  await db.execute(sql`delete from users where id like ${P + "%"}`);

  console.log(
    `✓ Phạm vi dữ liệu chặn thật: ${SCOPE_RESOURCES.length} loại · phòng khác bị từ chối kèm lối ra · SELF/ASSIGNED trên bảng không có chủ dòng KHÔNG rơi về "xem hết" · TEAM không trưởng phòng thì hẹp lại · không phiên ⇒ đóng · CSKH lọc bằng KHOÁ TÀI KHOẢN đúng 1/2/2 dòng, tên gõ tay không đoán · thao tác ghi hỏi lại cùng mệnh đề · hàng đợi phòng từ chối phạm vi hẹp`,
  );
}

/**
 * LÁ CHẮN MÃ NGUỒN: khai luật trong sổ mà quên gắn vào trang thì luật đó không tồn tại.
 *
 * Đây là kiểu hỏng đã xảy ra một lần với chính `data_scope` — mô hình đủ, giao diện đủ, và không
 * chỗ nào thi hành. Bài này đọc từng tệp `page.tsx` của từng tuyến đã khai.
 */
export function testEveryScopedRouteIsGuarded() {
  const goc = path.resolve(__dirname, "..");
  const thieu: string[] = [];
  const khongXuLyTuChoi: string[] = [];

  for (const res of SCOPE_RESOURCES) {
    // Bảng lương được thi hành bởi quyền `payroll:view-own`; sổ đã khai đích danh lớp đó.
    // Hàng đợi công việc (PROJECTION) VẪN phải gọi cổng: cổng là nơi từ chối người phạm vi hẹp mở hàng đợi phòng.
    if (res.enforcement === "OWN_LINE") continue;
    for (const route of res.routes) {
      const p = path.join(goc, "app/(dashboard)", route.replace(/^\//, ""), "page.tsx");
      if (!fs.existsSync(p)) {
        thieu.push(`${route} — không có tệp page.tsx`);
        continue;
      }
      const src = fs.readFileSync(p, "utf8");
      if (!src.includes(`requireResource("${res.key}"`)) thieu.push(`${route} — chưa gọi requireResource("${res.key}", …)`);
      else if (!src.includes('decision.allow === "NONE"')) khongXuLyTuChoi.push(`${route} — gọi cổng nhưng KHÔNG xử lý nhánh từ chối`);
    }
  }

  assert.deepEqual(thieu, [], `Tuyến đã khai luật phạm vi nhưng chưa gắn cổng:\n${thieu.join("\n")}`);
  assert.deepEqual(
    khongXuLyTuChoi,
    [],
    `Tuyến gọi cổng nhưng bỏ qua kết quả TỪ CHỐI — tức là vẫn dựng trang như thường:\n${khongXuLyTuChoi.join("\n")}`,
  );

  /*
    Mỗi loại dữ liệu phải chỉ ĐÍCH DANH nơi thi hành. Không có mục nào được để trống, vì "chưa
    khai" và "không cần" trông giống hệt nhau khi đọc lướt, và một trong hai là lỗ hổng.
  */
  for (const res of SCOPE_RESOURCES) {
    if (res.enforcement === "DEPARTMENT_ONLY") {
      assert.ok(!hasRowOwnership(res), `${res.key}: khai DEPARTMENT_ONLY thì không được đồng thời khai cột chủ dòng`);
      assert.ok((res.noRowOwnerReason ?? "").length > 30, `${res.key}: phải nói VÌ SAO không thu hẹp theo người được`);
    }
    if (res.enforcement === "SQL_ROWS") {
      assert.ok(hasRowOwnership(res), `${res.key}: khai SQL_ROWS thì phải có cột chủ dòng`);
      for (const link of [res.rowOwner, res.rowAssignee]) {
        // Cột EMAIL chỉ khớp được khi cột đó THẬT SỰ chứa email. `cs_cases.assignee` chứa tên hiển thị.
        if (link?.by === "EMAIL") assert.ok(!/^(assignee|assigned_to|owner)$/.test(link.column), `${res.key}: cột ${link.column} là ô TÊN, không nối theo email được`);
      }
    }
    if (res.enforcement === "PROJECTION") {
      assert.ok(!hasRowOwnership(res) && (res.noRowOwnerReason ?? "").length > 30, `${res.key}: phép chiếu không lọc bằng SQL trên một bảng — khai cột dòng ở đây là khai một luật không nơi nào thi hành`);
    }
  }

  const soTuyen = SCOPE_RESOURCES.flatMap((r) => r.routes).length;
  console.log(`✓ Phủ cổng phạm vi: ${SCOPE_RESOURCES.length} loại dữ liệu · ${soTuyen} tuyến · mỗi tuyến gọi cổng VÀ xử lý nhánh từ chối`);
}

/**
 * KHOÁ KÝ PHIÊN KHÔNG ĐƯỢC CÓ GIÁ TRỊ DỰ PHÒNG TRÊN PRODUCTION.
 *
 * `lib/env.ts` và `middleware.ts` phải nói CÙNG một câu. Chúng không import được nhau
 * (middleware chạy ở Edge), nên luật bị chép ra hai chỗ — và hai bản chép là hai cách để chúng
 * lệch nhau. Bài này giữ chúng khớp.
 */
export function testAuthSecretHasNoProdFallback() {
  const goc = path.resolve(__dirname, "..");
  const env = fs.readFileSync(path.join(goc, "lib/env.ts"), "utf8");
  const mw = fs.readFileSync(path.join(goc, "middleware.ts"), "utf8");

  assert.ok(
    /NODE_ENV === "production"/.test(env) && /throw new Error\([^)]*AUTH_SECRET/.test(env),
    "lib/env.ts phải NÉM LỖI khi production thiếu AUTH_SECRET, không được rơi về khoá dự phòng",
  );
  assert.ok(
    /NODE_ENV === "production"/.test(mw) && /AUTH_SECRET/.test(mw),
    "middleware.ts phải áp cùng luật — nó là nơi cookie được xác minh đầu tiên",
  );
  /*
    Khoá dự phòng vẫn còn cho máy của người viết code, nhưng chỉ được đọc tới SAU khi đã loại trừ
    production. Kiểm bằng thứ tự xuất hiện trong tệp: nhánh môi trường phải đứng TRƯỚC khoá.
  */
  for (const [ten, src] of [["lib/env.ts", env], ["middleware.ts", mw]] as const) {
    const viTriKhoa = src.indexOf("dev-secret-change-me");
    const viTriNhanh = src.indexOf('NODE_ENV === "production"');
    assert.ok(viTriKhoa > 0, `${ten}: không tìm thấy khoá dự phòng — nếu đã bỏ hẳn thì sửa bài kiểm này`);
    assert.ok(viTriNhanh > 0 && viTriNhanh < viTriKhoa, `${ten}: khoá dự phòng phải nằm SAU nhánh kiểm môi trường, không đứng một mình`);
  }

  console.log("✓ Khoá ký phiên: production thiếu AUTH_SECRET thì app dừng, không ký bằng khoá công khai trong kho mã");
}

/**
 * ═══ "LƯƠNG: XEM CỦA MÌNH" ĐI BẰNG KHOÁ TÀI KHOẢN, KHÔNG BẰNG Ô CHỮ ═══
 *
 * `employeeMatchesUser` là CỔNG duy nhất của quyền `payroll:view-own`: nó quyết định người đăng
 * nhập thấy dòng lương nào ở `/payroll`. Bản cũ, khi email không khớp hoặc bỏ trống, rơi xuống so
 * TÊN ĐẦY ĐỦ và TÊN NGẮN đã bỏ dấu — nên hai nhân sự cùng tên (hay cùng tên ngắn "Nam") đọc được
 * bảng lương của nhau, và đổi một ô chữ hiển thị trở thành một lượt cấp quyền.
 *
 * AGENTS.md mục 34 (quy kết đi bằng khoá tài khoản) và mục 31 (mọi nhánh lỗi rơi về phía HẸP HƠN).
 */
export function testPayrollOwnLineNeedsAccountKey() {
  const ns = (over: Partial<{ name: string; shortName: string; userEmail: string }>) => ({
    name: "Nguyễn Văn Nam",
    shortName: "Nam",
    userEmail: "",
    ...over,
  });

  // ── Bằng chứng DUY NHẤT được chấp nhận: liên kết tài khoản quản trị khai đích danh ──
  assert.equal(
    employeeMatchesUser(ns({ userEmail: "nam@shop.vn" }), { email: "nam@shop.vn", name: "Nguyễn Văn Nam" }),
    true,
    "email khai đích danh, khớp đúng phiên đăng nhập ⇒ thấy dòng của mình",
  );
  assert.equal(
    employeeMatchesUser(ns({ userEmail: " NAM@Shop.VN " }), { email: "nam@shop.vn", name: "x" }),
    true,
    "khoảng trắng và hoa/thường không làm người ta mất quyền xem lương của chính mình",
  );

  // ── HAI NGƯỜI CÙNG TÊN: đây là ca đã mở cửa cho nhau ở bản cũ ──
  assert.equal(
    employeeMatchesUser(ns({ userEmail: "nam.a@shop.vn" }), { email: "nam.b@shop.vn", name: "Nguyễn Văn Nam" }),
    false,
    "trùng TÊN ĐẦY ĐỦ nhưng khác tài khoản ⇒ KHÔNG được đọc lương người kia",
  );
  assert.equal(
    employeeMatchesUser(ns({ userEmail: "nam.a@shop.vn" }), { email: "nam.b@shop.vn", name: "Nam" }),
    false,
    "trùng TÊN NGẮN cũng không phải bằng chứng",
  );
  assert.equal(
    employeeMatchesUser(ns({ userEmail: "nam.a@shop.vn" }), { email: "nam.b@shop.vn", name: "Nguyen Van Nam" }),
    false,
    "bỏ dấu rồi trùng lại càng không — bỏ dấu làm hai cái tên khác nhau trông giống nhau",
  );

  // ── CHƯA KHAI LIÊN KẾT ⇒ KHÔNG KHỚP AI. Mất quyền xem, không phải lộ dữ liệu. ──
  assert.equal(employeeMatchesUser(ns({}), { email: "nam@shop.vn", name: "Nguyễn Văn Nam" }), false, "chưa khai email ⇒ không khớp ai, dù tên trùng khít");
  assert.equal(employeeMatchesUser(ns({ userEmail: "" }), { email: "", name: "Nguyễn Văn Nam" }), false, "phiên không có email cũng không mở được gì");

  /*
    LÁ CHẮN MÃ NGUỒN: nhánh so tên đã bị bỏ thì không được lặng lẽ quay lại. Hàm này chỉ được
    chạm tới `userEmail` — chạm tới `name`/`shortName` là dấu hiệu ô chữ đang tham gia tính quyền.
  */
  const src = fs.readFileSync(path.resolve(__dirname, "..", "lib/queries/payroll.ts"), "utf8");
  const than = src.slice(src.indexOf("export function employeeMatchesUser"));
  const body = than.slice(than.indexOf("{"), than.indexOf("\n}") + 2);
  for (const oChu of ["e.name", "e.shortName", "user.name"]) {
    assert.ok(!body.includes(oChu), `employeeMatchesUser không được đọc ô chữ ${oChu} — quyền xem lương đi bằng khoá tài khoản`);
  }

  console.log("✓ Lương xem-của-mình đi bằng KHOÁ TÀI KHOẢN: hai người cùng tên (đầy đủ · ngắn · đã bỏ dấu) không đọc được lương của nhau; chưa khai liên kết ⇒ không khớp ai");
}

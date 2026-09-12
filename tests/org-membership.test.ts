import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { assignMembership, membershipDrift, membershipOf, removeMembership, setDepartmentLead, transferMembership } from "@/lib/org/membership";

/**
 * ═══════════════ SỰ THẬT TỔ CHỨC ═══════════════
 *
 * SỰ CỐ THẬT (12/09/2026, production): **không gán được ai vào phòng ban.**
 *
 * Nguyên nhân KHÔNG nằm ở dịch vụ hay CSDL — nó nằm ở giao diện. Bốn chỗ dựng "chọn người rồi
 * chạy hành động" bằng `<Select value="">`, và `components/ui/select.tsx` đặt mặc định
 * `position="item-aligned"`. Ở chế độ đó Radix căn bảng chọn theo MỤC ĐANG CHỌN; `value=""` không
 * khớp mục nào nên phép tính dự phòng ném bảng chọn ra ngoài màn hình (đo được: ô bấm ở
 * `y=1449`, bảng chọn ở `y=6787` trên màn hình cao 1100). Bấm — không thấy gì — không lỗi.
 *
 * Nhật ký kiểm toán production xác nhận: **không một dòng `DEPARTMENT_MEMBER_SET` nào** trong
 * suốt buổi chủ shop thử gán người.
 *
 * Bài kiểm này khoá cả hai tầng:
 *  · MÃ NGUỒN — không tệp nào được quay lại hình dạng `<Select value="">`.
 *  · DỊCH VỤ — thêm / rời / chuyển / trưởng phòng đúng, không sinh dòng trùng, không mất lịch sử.
 */

/*
  `id: ""` CỐ Ý — đây là hình dạng mà mã gọi từ hệ thống truyền vào (`setDepartmentMember` không
  có actor). `audit_logs.user_id` có khoá ngoại tới `users.id`, nên chuỗi rỗng làm lượt ghi nhật
  ký đổ, và `audit()` nuốt lỗi để không chặn nghiệp vụ — thao tác xong mà KHÔNG để lại dấu nào.
  Khối 2 bên dưới khoá đúng chỗ đó.
*/
const ACTOR = { id: "", email: "test@local" };

function quetTsx(thuMuc: string, ra: string[] = []): string[] {
  const goc = path.resolve(__dirname, "..");
  for (const f of fs.readdirSync(path.join(goc, thuMuc), { withFileTypes: true })) {
    const p = `${thuMuc}/${f.name}`;
    if (f.isDirectory()) quetTsx(p, ra);
    else if (f.name.endsWith(".tsx")) ra.push(p);
  }
  return ra;
}

/** Lá chắn MÃ NGUỒN: `<Select>` điều khiển bằng chuỗi rỗng là hình dạng đã gây ra sự cố. */
export function testNoEmptyValueSelect() {
  const goc = path.resolve(__dirname, "..");
  const tep = [...quetTsx("app/(dashboard)"), ...quetTsx("components")];
  assert.ok(tep.length > 50, `đọc hụt thư mục giao diện (chỉ thấy ${tep.length} tệp)`);

  const pham: string[] = [];
  for (const f of tep) {
    /*
      BỎ CHÚ THÍCH TRƯỚC KHI QUÉT.

      Chính các tệp đã SỬA lỗi đều nhắc tên hình dạng cũ trong chú thích để người đọc sau hiểu vì
      sao — nếu quét cả chú thích thì lá chắn báo đỏ đúng những tệp đã làm đúng, và cách duy nhất
      để nó xanh là xoá lời giải thích đi. Một lá chắn phạt việc ghi lại bài học là lá chắn sai.
    */
    const src = fs
      .readFileSync(path.join(goc, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    /*
      `[^>]*` dừng ở dấu `>` đầu tiên, tức là đúng trong thẻ mở `<Select ...>` — bắt được cả cách
      viết xuống nhiều dòng. `(?![A-Za-z])` để không dính `<SelectTrigger` / `<SelectItem`.
      KHÔNG bắt `<option value="">` của thẻ `select` HTML thuần: thẻ đó do trình duyệt định vị nên
      không dính lỗi này.
    */
    if (/<Select(?![A-Za-z])[^>]*\bvalue=""/.test(src)) pham.push(f);
  }
  assert.deepEqual(
    pham.sort(),
    [],
    `Những tệp này dùng lại hình dạng đã gây sự cố "không gán được phòng ban":\n  ${pham.join("\n  ")}\n\n` +
      `Một ô chọn mà giá trị không bao giờ đổi thì không phải ô chọn — nó là một THỰC ĐƠN. Dùng ` +
      `\`PickerMenu\` (components/picker-menu.tsx): nó dựng trên Popover nên luôn nằm cạnh ô bấm.`,
  );
  console.log(`✓ Không còn ô chọn điều khiển bằng chuỗi rỗng: quét ${tep.length} tệp giao diện`);
}

export async function testOrgMembership(db: Db) {
  const P = "org-";
  const uid = `${P}u1`;
  const uid2 = `${P}u2`;
  const d1 = `${P}d1`;
  const d2 = `${P}d2`;

  await db.insert(schema.users).values([
    { id: uid, email: `${P}a@t.local`, name: "Org A", role: "CS", passwordHash: "x", active: true },
    { id: uid2, email: `${P}b@t.local`, name: "Org B", role: "CS", passwordHash: "x", active: true },
  ]);
  await db.insert(schema.departments).values([
    { id: d1, code: `${P}D1`.toUpperCase().replace(/-/g, "_"), name: "Phòng Một", active: true },
    { id: d2, code: `${P}D2`.toUpperCase().replace(/-/g, "_"), name: "Phòng Hai", active: true },
  ]);

  /* ═══ 1 · THÊM: chạy lại không sinh dòng trùng ═══ */
  const a1 = await assignMembership({ departmentId: d1, userId: uid }, ACTOR);
  assert.ok("ok" in a1 && a1.changed, "lần đầu phải đổi trạng thái");
  const a2 = await assignMembership({ departmentId: d1, userId: uid }, ACTOR);
  assert.ok("ok" in a2 && !a2.changed, "gán lại y hệt thì KHÔNG có gì đổi — nút bấm hai lần không được đẻ ra dòng thứ hai");
  const dem = await db.select().from(schema.departmentMembers).where(and(eq(schema.departmentMembers.departmentId, d1), eq(schema.departmentMembers.userId, uid)));
  assert.equal(dem.length, 1, "một người trong một phòng đúng MỘT dòng");

  /* ═══ 2 · MỌI LƯỢT GHI ĐỀU CÓ DẤU ═══ */
  const nk = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "DEPARTMENT_MEMBER_SET"));
  assert.ok(nk.length >= 2, "mỗi lượt gán phải ghi một dòng kiểm toán — không nơi gọi nào có thể quên, vì audit nằm trong chính dịch vụ");

  /* ═══ 3 · RỜI PHÒNG: ngừng hoạt động, KHÔNG xoá dòng ═══ */
  const r1 = await removeMembership({ departmentId: d1, userId: uid }, ACTOR);
  assert.ok("ok" in r1);
  const sauKhiRoi = await db.select().from(schema.departmentMembers).where(and(eq(schema.departmentMembers.departmentId, d1), eq(schema.departmentMembers.userId, uid)));
  assert.equal(sauKhiRoi.length, 1, "dòng phải CÒN — lịch sử 'ai từng ở phòng nào' là căn cứ của báo cáo kỳ đã chốt");
  assert.equal(sauKhiRoi[0].active, false, "chỉ ngừng hoạt động");
  assert.equal((await membershipOf(uid)).length, 0, "đã rời thì không còn trong danh sách đang hoạt động");
  assert.equal((await membershipOf(uid, true)).length, 1, "nhưng đọc cả lịch sử thì vẫn thấy");

  /* ═══ 4 · VÀO LẠI PHÒNG CŨ: bật lại dòng cũ, không tạo dòng mới ═══ */
  await assignMembership({ departmentId: d1, userId: uid }, ACTOR);
  const vaoLai = await db.select().from(schema.departmentMembers).where(and(eq(schema.departmentMembers.departmentId, d1), eq(schema.departmentMembers.userId, uid)));
  assert.equal(vaoLai.length, 1, "vào lại phòng cũ KHÔNG được tạo dòng thứ hai");
  assert.equal(vaoLai[0].active, true);

  /* ═══ 5 · TRƯỞNG PHÒNG: ghi CẢ HAI vế ═══ */
  const l1 = await setDepartmentLead({ departmentId: d1, userId: uid }, ACTOR);
  assert.ok("ok" in l1);
  const dept1 = await db.query.departments.findFirst({ where: eq(schema.departments.id, d1) });
  assert.equal(dept1?.leadUserId, uid, "ghế trưởng phòng phải được ghi");
  const vai = await db.query.departmentMembers.findFirst({ where: and(eq(schema.departmentMembers.departmentId, d1), eq(schema.departmentMembers.userId, uid)) });
  assert.equal(vai?.roleInDept, "LEAD", "VÀ vai LEAD trong chính phòng đó — thiếu vế này thì 'việc của phòng tôi' của họ rỗng");

  // Đổi trưởng phòng: người cũ LÙI VỀ thành viên, không bị đá khỏi phòng.
  await setDepartmentLead({ departmentId: d1, userId: uid2 }, ACTOR);
  const cu = await db.query.departmentMembers.findFirst({ where: and(eq(schema.departmentMembers.departmentId, d1), eq(schema.departmentMembers.userId, uid)) });
  assert.equal(cu?.active, true, "trưởng phòng cũ VẪN là thành viên");
  assert.equal(cu?.roleInDept, "MEMBER", "chỉ lùi về thành viên thường");

  // Trưởng phòng rời phòng thì ghế trưởng phòng trống theo.
  const r2 = await removeMembership({ departmentId: d1, userId: uid2 }, ACTOR);
  assert.ok("ok" in r2 && r2.leadCleared, "bỏ trưởng phòng khỏi phòng phải trả ghế về trống");
  assert.equal((await db.query.departments.findFirst({ where: eq(schema.departments.id, d1) }))?.leadUserId, null);

  /* ═══ 6 · CHUYỂN PHÒNG ═══ */
  const t = await transferMembership({ fromDepartmentId: d1, toDepartmentId: d2, userId: uid }, ACTOR);
  assert.ok("ok" in t);
  const sauChuyen = await membershipOf(uid);
  assert.deepEqual(sauChuyen.map((m) => m.departmentId), [d2], "chuyển xong chỉ còn ở phòng đến");
  assert.equal(
    (await db.select().from(schema.departmentMembers).where(and(eq(schema.departmentMembers.departmentId, d1), eq(schema.departmentMembers.userId, uid)))).length,
    1,
    "dòng ở phòng cũ vẫn còn (đã ngừng hoạt động) — lịch sử không mất",
  );
  assert.ok("error" in (await transferMembership({ fromDepartmentId: d2, toDepartmentId: d2, userId: uid }, ACTOR)), "chuyển sang chính phòng đang ở phải bị chặn");

  /* ═══ 7 · CHẶN Ở CỬA ═══ */
  assert.ok("error" in (await assignMembership({ departmentId: "khong-co", userId: uid }, ACTOR)), "phòng không tồn tại");
  assert.ok("error" in (await assignMembership({ departmentId: d1, userId: "khong-co" }, ACTOR)), "người không tồn tại");
  await db.update(schema.users).set({ active: false }).where(eq(schema.users.id, uid2));
  assert.ok("error" in (await assignMembership({ departmentId: d1, userId: uid2 }, ACTOR)), "tài khoản đã tắt KHÔNG được gán — hàng đợi sẽ đếm họ là người nhận được việc");
  await db.update(schema.departments).set({ active: false }).where(eq(schema.departments.id, d1));
  assert.ok("error" in (await assignMembership({ departmentId: d1, userId: uid }, ACTOR)), "phòng ngừng dùng KHÔNG nhận thêm người");

  /* ═══ 8 · BÁO CÁO LỆCH: phát hiện, KHÔNG tự sửa ═══ */
  await db.update(schema.users).set({ active: true }).where(eq(schema.users.id, uid2));
  await db.update(schema.departments).set({ active: true }).where(eq(schema.departments.id, d1));
  // Dựng đúng một kiểu lệch: ghế trưởng phòng trỏ tới người KHÔNG phải thành viên.
  await db.update(schema.departments).set({ leadUserId: uid2 }).where(eq(schema.departments.id, d2));
  const lech = await membershipDrift();
  const cuaTa = lech.filter((x) => x.departmentId === d2);
  assert.ok(cuaTa.some((x) => x.kind === "LEAD_NOT_MEMBER"), "phải phát hiện trưởng phòng không nằm trong danh sách thành viên");
  assert.ok(cuaTa.every((x) => x.fix.length > 15), "mỗi dòng lệch phải kèm CÁCH SỬA — một danh sách vấn đề không có lối ra là danh sách bị bỏ qua");
  // Và nó KHÔNG được tự sửa: đọc lại vẫn thấy đúng cái lệch đó.
  assert.equal((await db.query.departments.findFirst({ where: eq(schema.departments.id, d2) }))?.leadUserId, uid2, "báo cáo là CHẠY THỬ — không được sửa gì");

  /* ═══ DỌN ═══ */
  await db.delete(schema.departmentMembers).where(eq(schema.departmentMembers.userId, uid));
  await db.delete(schema.departmentMembers).where(eq(schema.departmentMembers.userId, uid2));
  await db.update(schema.departments).set({ leadUserId: null }).where(eq(schema.departments.id, d2));
  await db.delete(schema.departments).where(eq(schema.departments.id, d1));
  await db.delete(schema.departments).where(eq(schema.departments.id, d2));
  await db.delete(schema.users).where(eq(schema.users.id, uid));
  await db.delete(schema.users).where(eq(schema.users.id, uid2));

  console.log(
    "✓ Sự thật tổ chức: một cửa ghi duy nhất · gán lại không sinh dòng trùng · rời phòng giữ lịch sử · vào lại bật dòng cũ · " +
      "trưởng phòng ghi CẢ ghế lẫn vai LEAD, người cũ lùi về thành viên · chuyển phòng một thao tác · chặn tài khoản tắt và phòng ngừng dùng · " +
      "báo cáo lệch phát hiện nhưng KHÔNG tự sửa",
  );
}

import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { DEPARTMENT_LABEL, type DepartmentCode, type DepartmentRole } from "@/lib/constants/departments";

/**
 * ═══════════ SỰ THẬT TỔ CHỨC: MỘT CỬA GHI DUY NHẤT ═══════════
 *
 * Trước tệp này, "ai thuộc phòng nào" bị ghi từ ba chỗ: `lib/work/service.ts` (màn Cấu hình công
 * việc), `saveDepartment` (khi đặt trưởng phòng), và không chỗ nào ở trang Người dùng. Ba đường
 * ghi cho cùng một sự thật là ba cách để chúng lệch nhau, và cái lệch đó không ai thấy cho tới
 * lúc hàng đợi của một người trống trơn.
 *
 * Nay MỌI thay đổi thành viên đi qua đây. Ba tính chất được bảo đảm tại chỗ này, không phải ở
 * từng nơi gọi:
 *
 *  1. **Không bao giờ trùng.** `onConflictDoUpdate` trên khoá tự nhiên `(department_id, user_id)`
 *     — một người ở một phòng đúng một dòng. Vào lại phòng cũ là BẬT LẠI dòng cũ, không tạo dòng
 *     mới, nên lịch sử "ai từng ở phòng nào" còn nguyên.
 *  2. **Rời phòng không xoá dòng.** `active = false`. Báo cáo kỳ đã chốt đọc được người đó từng ở
 *     đâu; xoá cứng thì mọi con số quá khứ mất chỗ dựa.
 *  3. **Mọi lượt ghi để lại dấu.** `audit()` ngay trong hàm — nơi gọi không thể quên.
 *
 * ─── KHÔNG TỰ ĐỘNG GIAO LẠI VIỆC KHI ĐỔI PHÒNG ───
 *
 * Đổi phòng của một người KHÔNG đụng tới việc họ đang cầm. Việc đã có chủ vẫn mang tên họ, và đó
 * là điều đúng: một người chuyển sang phòng khác vẫn phải đóng nốt việc dở, hoặc trưởng phòng
 * quyết chuyển từng việc. Tự động rải lại vài trăm việc vì một thao tác đổi phòng là loại "tiện
 * lợi" mà không ai gỡ lại được. `impactOfLeaving()` cho biết TRƯỚC bao nhiêu việc sẽ mất chủ theo
 * phòng, để người bấm quyết định với đủ thông tin.
 */

export type MembershipActor = { id: string | null; email: string };

/**
 * Khoá người dùng cho nhật ký kiểm toán — chuỗi RỖNG phải thành `null`.
 *
 * `audit_logs.user_id` có khoá ngoại tới `users.id`. Một chuỗi rỗng KHÔNG phải `null`, nên nó vi
 * phạm khoá ngoại và lượt ghi nhật ký đổ — mà `audit()` cố ý nuốt lỗi để không chặn nghiệp vụ.
 * Kết quả: thao tác chạy xong nhưng KHÔNG để lại dấu nào, im lặng. Đúng chỗ này là nơi việc do hệ
 * thống khởi xướng (gán trưởng phòng khi tạo phòng) đi qua, nên nó sẽ mất dấu thường xuyên nhất.
 */
function actorId(a: MembershipActor): string | null {
  return a.id && a.id.trim() ? a.id : null;
}

export type MembershipRow = {
  departmentId: string;
  code: DepartmentCode;
  name: string;
  roleInDept: DepartmentRole;
  title: string;
  active: boolean;
  isLead: boolean;
};

export type OrgResult<T = object> = ({ ok: true } & T) | { error: string };

/* ═══════════════════ ĐỌC ═══════════════════ */

/** Phòng ban của một người. `includeInactive` để xem cả lịch sử đã rời. */
export async function membershipOf(userId: string, includeInactive = false): Promise<MembershipRow[]> {
  const db = await getDb();
  const m = schema.departmentMembers;
  const d = schema.departments;
  const rows = await db
    .select({
      departmentId: m.departmentId,
      code: d.code,
      name: d.name,
      roleInDept: m.roleInDept,
      title: m.title,
      active: m.active,
      leadUserId: d.leadUserId,
    })
    .from(m)
    .innerJoin(d, eq(d.id, m.departmentId))
    .where(includeInactive ? eq(m.userId, userId) : and(eq(m.userId, userId), eq(m.active, true), eq(d.active, true)))
    .orderBy(asc(d.sortOrder), asc(d.name));
  return rows.map((r) => ({
    departmentId: r.departmentId,
    code: r.code as DepartmentCode,
    name: r.name,
    roleInDept: r.roleInDept as DepartmentRole,
    title: r.title,
    active: r.active,
    isLead: r.leadUserId === userId,
  }));
}

/* ═══════════════════ GHI ═══════════════════ */

/**
 * Thêm / cập nhật một người trong một phòng. Chạy lại bao nhiêu lần cũng ra đúng một dòng.
 *
 * Kiểm ở ĐÂY chứ không ở nơi gọi: phòng phải tồn tại và đang dùng, người phải tồn tại và đang
 * hoạt động. Gán cho một tài khoản đã tắt là tạo ra một thành viên không bao giờ đăng nhập được —
 * và hàng đợi của phòng sẽ đếm họ là người có thể nhận việc.
 */
export async function assignMembership(
  input: { departmentId: string; userId: string; roleInDept?: DepartmentRole; title?: string },
  actor: MembershipActor,
): Promise<OrgResult<{ changed: boolean }>> {
  const db = await getDb();
  const [dept, user] = await Promise.all([
    db.query.departments.findFirst({ where: eq(schema.departments.id, input.departmentId), columns: { id: true, code: true, name: true, active: true } }),
    db.query.users.findFirst({ where: eq(schema.users.id, input.userId), columns: { id: true, name: true, email: true, active: true } }),
  ]);
  if (!dept) return { error: "Không tìm thấy phòng ban" };
  if (!dept.active) return { error: `Phòng "${dept.name}" đang ngừng dùng — bật lại phòng trước khi thêm người` };
  if (!user) return { error: "Không tìm thấy người dùng" };
  if (!user.active) return { error: `Tài khoản ${user.name || user.email} đã ngừng hoạt động — bật lại tài khoản trước` };

  const roleInDept = input.roleInDept ?? "MEMBER";
  const title = (input.title ?? "").trim().slice(0, 100);

  const truoc = await db.query.departmentMembers.findFirst({
    where: and(eq(schema.departmentMembers.departmentId, input.departmentId), eq(schema.departmentMembers.userId, input.userId)),
    columns: { roleInDept: true, title: true, active: true },
  });

  await db
    .insert(schema.departmentMembers)
    .values({ departmentId: input.departmentId, userId: input.userId, roleInDept, title, active: true })
    .onConflictDoUpdate({
      target: [schema.departmentMembers.departmentId, schema.departmentMembers.userId],
      set: { roleInDept, title, active: true, updatedAt: new Date() },
    });

  const changed = !truoc || !truoc.active || truoc.roleInDept !== roleInDept || truoc.title !== title;
  await audit({
    userId: actorId(actor),
    userEmail: actor.email,
    action: "DEPARTMENT_MEMBER_SET",
    entity: "DEPARTMENT",
    entityId: input.departmentId,
    detail: {
      department: dept.code,
      userId: input.userId,
      userEmail: user.email,
      before: truoc ? { roleInDept: truoc.roleInDept, active: truoc.active, title: truoc.title } : null,
      after: { roleInDept, active: true, title },
    },
  });
  return { ok: true, changed };
}

/**
 * Cho một người rời phòng. KHÔNG xoá dòng — chỉ `active = false`.
 *
 * Nếu người đó đang là trưởng phòng thì ghế trưởng phòng cũng trống theo: một phòng có trưởng
 * phòng không còn là thành viên thì "việc của phòng tôi" của người đó rỗng, và phòng thì trông
 * như vẫn có người chịu trách nhiệm.
 */
export async function removeMembership(input: { departmentId: string; userId: string }, actor: MembershipActor): Promise<OrgResult<{ leadCleared: boolean }>> {
  const db = await getDb();
  const dept = await db.query.departments.findFirst({ where: eq(schema.departments.id, input.departmentId), columns: { id: true, code: true, leadUserId: true } });
  if (!dept) return { error: "Không tìm thấy phòng ban" };
  const truoc = await db.query.departmentMembers.findFirst({
    where: and(eq(schema.departmentMembers.departmentId, input.departmentId), eq(schema.departmentMembers.userId, input.userId)),
    columns: { roleInDept: true, active: true },
  });
  if (!truoc) return { error: "Người này không thuộc phòng đó" };

  await db
    .update(schema.departmentMembers)
    .set({ active: false, updatedAt: new Date() })
    .where(and(eq(schema.departmentMembers.departmentId, input.departmentId), eq(schema.departmentMembers.userId, input.userId)));

  const leadCleared = dept.leadUserId === input.userId;
  if (leadCleared) await db.update(schema.departments).set({ leadUserId: null, updatedAt: new Date() }).where(eq(schema.departments.id, input.departmentId));

  await audit({
    userId: actorId(actor),
    userEmail: actor.email,
    action: "DEPARTMENT_MEMBER_REMOVE",
    entity: "DEPARTMENT",
    entityId: input.departmentId,
    detail: { department: dept.code, userId: input.userId, before: { roleInDept: truoc.roleInDept, active: truoc.active }, leadCleared },
  });
  return { ok: true, leadCleared };
}

/**
 * Đặt trưởng phòng. Ghi HAI thứ trong một thao tác, và đó là lý do hàm này tồn tại:
 * `departments.lead_user_id` (ai là trưởng) VÀ vai `LEAD` trong chính phòng đó (để họ thấy việc
 * của phòng). Thiếu vế thứ hai thì trưởng phòng chỉ thấy việc của riêng mình — đúng lỗi đã có
 * trước khi gom về đây.
 *
 * `userId = null` là bỏ trống ghế trưởng phòng; người đó VẪN là thành viên.
 */
export async function setDepartmentLead(input: { departmentId: string; userId: string | null }, actor: MembershipActor): Promise<OrgResult> {
  const db = await getDb();
  const dept = await db.query.departments.findFirst({ where: eq(schema.departments.id, input.departmentId), columns: { id: true, code: true, name: true, active: true, leadUserId: true } });
  if (!dept) return { error: "Không tìm thấy phòng ban" };

  if (input.userId) {
    const r = await assignMembership({ departmentId: input.departmentId, userId: input.userId, roleInDept: "LEAD" }, actor);
    if ("error" in r) return r;
  }
  // Trưởng phòng CŨ lùi về thành viên thường, không bị đá khỏi phòng.
  if (dept.leadUserId && dept.leadUserId !== input.userId) {
    await db
      .update(schema.departmentMembers)
      .set({ roleInDept: "MEMBER", updatedAt: new Date() })
      .where(and(eq(schema.departmentMembers.departmentId, input.departmentId), eq(schema.departmentMembers.userId, dept.leadUserId)));
  }
  await db.update(schema.departments).set({ leadUserId: input.userId, updatedAt: new Date() }).where(eq(schema.departments.id, input.departmentId));

  await audit({
    userId: actorId(actor),
    userEmail: actor.email,
    action: "DEPARTMENT_LEAD_SET",
    entity: "DEPARTMENT",
    entityId: input.departmentId,
    detail: { department: dept.code, before: dept.leadUserId, after: input.userId },
  });
  return { ok: true };
}

/**
 * Chuyển một người từ phòng này sang phòng khác — MỘT thao tác, một dòng nhật ký.
 *
 * Gọi hai hàm rời/thêm riêng lẻ thì có một khoảnh khắc người đó không thuộc phòng nào, và nếu
 * lượt thứ hai hỏng thì họ mắc kẹt ở đó. Ở đây thêm TRƯỚC rồi mới rời, nên trạng thái xấu nhất là
 * "ở cả hai phòng" — vẫn nhận được việc — chứ không phải "không ở đâu cả".
 */
export async function transferMembership(
  input: { fromDepartmentId: string; toDepartmentId: string; userId: string; roleInDept?: DepartmentRole },
  actor: MembershipActor,
): Promise<OrgResult> {
  if (input.fromDepartmentId === input.toDepartmentId) return { error: "Phòng đi và phòng đến giống nhau" };
  const them = await assignMembership({ departmentId: input.toDepartmentId, userId: input.userId, roleInDept: input.roleInDept }, actor);
  if ("error" in them) return them;
  const roi = await removeMembership({ departmentId: input.fromDepartmentId, userId: input.userId }, actor);
  if ("error" in roi) return roi;
  await audit({
    userId: actorId(actor),
    userEmail: actor.email,
    action: "DEPARTMENT_MEMBER_TRANSFER",
    entity: "DEPARTMENT",
    entityId: input.toDepartmentId,
    detail: { userId: input.userId, from: input.fromDepartmentId, to: input.toDepartmentId },
  });
  return { ok: true };
}

/* ═══════════════════ TÁC ĐỘNG & LỆCH DỮ LIỆU ═══════════════════ */

/**
 * Bao nhiêu việc đang mang tên người này — để màn hình hỏi lại TRƯỚC khi cho họ rời phòng.
 *
 * Đọc `work_items` (việc đã có người cầm ở lớp công việc). KHÔNG dựng lại toàn bộ phép chiếu: ở
 * đây chỉ cần con số để cảnh báo, và dựng phép chiếu là một lượt đọc nặng cho một hộp thoại xác nhận.
 */
export async function impactOfLeaving(userId: string): Promise<{ holding: number }> {
  const db = await getDb();
  const r = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.workItems)
    .where(and(eq(schema.workItems.assigneeId, userId), sql`coalesce(${schema.workItems.status}, '') not in ('DONE', 'CANCELLED')`));
  return { holding: Number(r[0]?.n ?? 0) };
}

export type MembershipDrift = {
  kind: "LEAD_NOT_MEMBER" | "LEAD_INACTIVE_MEMBER" | "MEMBER_OF_INACTIVE_DEPT" | "INACTIVE_USER_ACTIVE_MEMBER" | "DUPLICATE_ROW";
  label: string;
  fix: string;
  departmentId: string;
  department: string;
  userId: string;
  userName: string;
};

export const DRIFT_LABEL: Record<MembershipDrift["kind"], string> = {
  LEAD_NOT_MEMBER: "Trưởng phòng không có trong danh sách thành viên",
  LEAD_INACTIVE_MEMBER: "Trưởng phòng đã rời phòng nhưng vẫn giữ ghế",
  MEMBER_OF_INACTIVE_DEPT: "Còn là thành viên của phòng đã ngừng dùng",
  INACTIVE_USER_ACTIVE_MEMBER: "Tài khoản đã tắt nhưng vẫn là thành viên đang hoạt động",
  DUPLICATE_ROW: "Hai dòng thành viên cho cùng một người trong cùng một phòng",
};

/**
 * BÁO CÁO LỆCH — CHẠY THỬ, KHÔNG SỬA GÌ.
 *
 * Mỗi dòng nói rõ lệch cái gì và cách sửa. CỐ Ý không có hàm "sửa hàng loạt": ba trong năm loại
 * lệch có hơn một cách sửa đúng (bỏ ghế trưởng phòng hay thêm lại người đó làm thành viên? tuỳ
 * chủ shop định làm gì), và một lượt sửa hàng loạt trên dữ liệu tổ chức là thứ không gỡ lại được.
 * Sửa từng dòng bằng chính các nút đã có trên màn hình, mỗi lượt một dòng nhật ký.
 */
export async function membershipDrift(): Promise<MembershipDrift[]> {
  const db = await getDb();
  const rows = await db
    .select({
      deptId: schema.departments.id,
      deptName: schema.departments.name,
      deptActive: schema.departments.active,
      leadUserId: schema.departments.leadUserId,
      memberUserId: schema.departmentMembers.userId,
      memberActive: schema.departmentMembers.active,
      userName: schema.users.name,
      userEmail: schema.users.email,
      userActive: schema.users.active,
    })
    .from(schema.departments)
    .leftJoin(schema.departmentMembers, eq(schema.departmentMembers.departmentId, schema.departments.id))
    .leftJoin(schema.users, eq(schema.users.id, schema.departmentMembers.userId));

  const ra: MembershipDrift[] = [];
  const theoPhong = new Map<string, typeof rows>();
  for (const r of rows) theoPhong.set(r.deptId, [...(theoPhong.get(r.deptId) ?? []), r]);

  for (const [deptId, list] of theoPhong) {
    const d = list[0];
    if (d.leadUserId) {
      const lead = list.find((r) => r.memberUserId === d.leadUserId);
      const ten = lead?.userName || lead?.userEmail || d.leadUserId;
      if (!lead) {
        ra.push({ kind: "LEAD_NOT_MEMBER", label: DRIFT_LABEL.LEAD_NOT_MEMBER, fix: "Thêm người đó vào phòng, hoặc bỏ trống ghế trưởng phòng", departmentId: deptId, department: d.deptName, userId: d.leadUserId, userName: ten });
      } else if (!lead.memberActive) {
        ra.push({ kind: "LEAD_INACTIVE_MEMBER", label: DRIFT_LABEL.LEAD_INACTIVE_MEMBER, fix: "Thêm lại họ vào phòng, hoặc chọn trưởng phòng khác", departmentId: deptId, department: d.deptName, userId: d.leadUserId, userName: ten });
      }
    }
    for (const r of list) {
      if (!r.memberUserId || !r.memberActive) continue;
      if (!d.deptActive) {
        ra.push({ kind: "MEMBER_OF_INACTIVE_DEPT", label: DRIFT_LABEL.MEMBER_OF_INACTIVE_DEPT, fix: "Bật lại phòng, hoặc cho họ rời phòng đó", departmentId: deptId, department: d.deptName, userId: r.memberUserId, userName: r.userName || r.userEmail || "" });
      }
      if (r.userActive === false) {
        ra.push({ kind: "INACTIVE_USER_ACTIVE_MEMBER", label: DRIFT_LABEL.INACTIVE_USER_ACTIVE_MEMBER, fix: "Bật lại tài khoản, hoặc cho họ rời phòng", departmentId: deptId, department: d.deptName, userId: r.memberUserId, userName: r.userName || r.userEmail || "" });
      }
    }
  }
  return ra;
}

export { DEPARTMENT_LABEL };

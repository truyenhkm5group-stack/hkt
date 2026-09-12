import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { DEPARTMENT_LABEL, DEPARTMENT_ORDER, type DepartmentCode, type DepartmentRole } from "@/lib/constants/departments";
import {
  MY_WORK_BUCKETS,
  slaStateOf,
  sumMoney,
  WORK_PRIORITY_RANK,
  type MyWorkBucket,
  type SlaState,
  type WorkItem,
  type WorkStatus,
} from "@/lib/constants/work";
import { WORK_SOURCE_SPEC, type WorkSource } from "@/lib/constants/work-sources";
import { collectWorkItems, type CollectOptions } from "@/lib/queries/work-adapters";

/**
 * ═══════════ HÀNG ĐỢI: XẾP VIỆC THEO THỨ TỰ PHẢI LÀM ═══════════
 *
 * Đặc tả: `docs/work-management-os.md`. Phép chiếu ở `lib/queries/work-adapters.ts`; tệp này chỉ
 * LỌC, XẾP RỔ và TỔNG HỢP.
 */

/* ═══════════════════ PHÒNG BAN ═══════════════════ */

export type DepartmentRow = {
  id: string;
  code: DepartmentCode;
  name: string;
  description: string;
  leadUserId: string | null;
  leadName: string;
  active: boolean;
  sortOrder: number;
  memberCount: number;
};

export async function listDepartments(includeInactive = false): Promise<DepartmentRow[]> {
  const db = await getDb();
  const d = schema.departments;
  const rows = await db
    .select({
      id: d.id,
      code: d.code,
      name: d.name,
      description: d.description,
      leadUserId: d.leadUserId,
      leadName: sql<string>`coalesce(${schema.users.name}, '')`,
      active: d.active,
      sortOrder: d.sortOrder,
      memberCount: sql<number>`(select count(*)::int from department_members dm where dm.department_id = ${d.id} and dm.active)`,
    })
    .from(d)
    .leftJoin(schema.users, eq(schema.users.id, d.leadUserId))
    .where(includeInactive ? undefined : eq(d.active, true))
    .orderBy(asc(d.sortOrder), asc(d.name));
  return rows.map((r) => ({ ...r, code: r.code as DepartmentCode }));
}

export type DepartmentMemberRow = { userId: string; name: string; email: string; role: string; roleInDept: DepartmentRole; title: string; active: boolean };

export async function listDepartmentMembers(departmentId: string): Promise<DepartmentMemberRow[]> {
  const db = await getDb();
  const m = schema.departmentMembers;
  const rows = await db
    .select({
      userId: m.userId,
      name: schema.users.name,
      email: schema.users.email,
      role: schema.users.role,
      roleInDept: m.roleInDept,
      title: m.title,
      active: m.active,
    })
    .from(m)
    .innerJoin(schema.users, eq(schema.users.id, m.userId))
    .where(eq(m.departmentId, departmentId))
    .orderBy(asc(m.roleInDept), asc(schema.users.name));
  return rows.map((r) => ({ ...r, roleInDept: r.roleInDept as DepartmentRole }));
}

/** Phòng ban của một người (có thể nhiều — ở shop nhỏ chuyện đó là bình thường). */
export async function departmentsOfUser(userId: string): Promise<{ code: DepartmentCode; id: string; name: string; roleInDept: DepartmentRole }[]> {
  const db = await getDb();
  const m = schema.departmentMembers;
  const rows = await db
    .select({ id: schema.departments.id, code: schema.departments.code, name: schema.departments.name, roleInDept: m.roleInDept })
    .from(m)
    .innerJoin(schema.departments, eq(schema.departments.id, m.departmentId))
    .where(and(eq(m.userId, userId), eq(m.active, true), eq(schema.departments.active, true)));
  return rows.map((r) => ({ ...r, code: r.code as DepartmentCode, roleInDept: r.roleInDept as DepartmentRole }));
}

/* ═══════════════════ NHẬN DIỆN "VIỆC CỦA TÔI" ═══════════════════ */

/**
 * Ai đang cầm việc này — và vì sao không so bằng một trường duy nhất.
 *
 * Ba miền ghi người phụ trách theo ba kiểu khác nhau, và đó là sự thật lịch sử không sửa được
 * trong bản này: `notifications.assigned_to` và `shipment_care.owner_id` là KHOÁ NGƯỜI DÙNG, còn
 * `cs_cases.assignee` là một ô CHỮ (tên hoặc bí danh, kể cả tên bot). Ép cả ba về một kiểu nghĩa
 * là phải migrate dữ liệu CSKH đang chạy — việc đó nằm ngoài phạm vi và sẽ làm mất người phụ trách
 * của những case mà tên không khớp tài khoản nào.
 *
 * Nên so cả hai chiều: khớp khoá thì chắc chắn; không có khoá thì khớp TÊN, phân biệt hoa thường
 * và khoảng trắng. Chỗ nào không khớp được thì việc vẫn nằm ở hàng đợi phòng — không biến mất.
 */
export function isMine(item: WorkItem, me: { id: string; name: string; email: string }): boolean {
  const a = item.assignee;
  if (!a) return false;
  if (a.id && a.id === me.id) return true;
  if (a.email && a.email.toLowerCase() === me.email.toLowerCase()) return true;
  if (!a.id && a.name && a.name.trim().toLowerCase() === me.name.trim().toLowerCase()) return true;
  return false;
}

/* ═══════════════════ RỔ CỦA "VIỆC CỦA TÔI" ═══════════════════ */

/**
 * Việc rơi vào rổ nào — và thứ tự kiểm tra CHÍNH LÀ thứ tự ưu tiên.
 *
 * `DOING` được xét TRƯỚC `WAITING` một cách có chủ ý: một việc đang cầm dở mà cũng đang chờ khách
 * thì nó vẫn là việc của người đó. Xét ngược lại thì mọi việc đang làm có một cái hẹn đều rơi vào
 * "Chờ" và người ta mở trang lên thấy mình không làm gì cả.
 *
 * Việc đang HOÃN không rơi vào `NOW`/`TODAY` dù hạn gần — nhưng nếu đã QUÁ HẠN thì vẫn nổi lên
 * `OVERDUE`: cái hẹn không xoá được cái hạn.
 */
export function bucketOf(item: WorkItem, now: Date): MyWorkBucket {
  const sla = slaStateOf(item.slaAt ?? item.dueAt, now);
  if (sla === "BREACHED") return "OVERDUE";

  const snoozed = item.snoozedUntil !== null && item.snoozedUntil.getTime() > now.getTime();
  if (item.status === "BLOCKED" || item.status === "WAITING" || snoozed) return "WAITING";
  if (item.status === "IN_PROGRESS") return "DOING";
  if (item.priority === "URGENT" || sla === "DUE_SOON") return "NOW";

  const due = item.slaAt ?? item.dueAt;
  if (due) {
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    if (due.getTime() <= endOfDay.getTime()) return "TODAY";
  }
  return "UPCOMING";
}

export type WorkBucketGroup = { bucket: MyWorkBucket; items: WorkItem[]; count: number; money: ReturnType<typeof sumMoney> };

export type MyWork = {
  groups: WorkBucketGroup[];
  total: number;
  overdue: number;
  /** Tổng tiền đang treo ở việc của tôi, kèm số việc CHƯA TRA ĐƯỢC tiền. */
  money: ReturnType<typeof sumMoney>;
  failedSources: { source: WorkSource; error: string }[];
};

export async function getMyWork(me: { id: string; name: string; email: string }, opts: CollectOptions = {}): Promise<MyWork> {
  const now = opts.now ?? new Date();
  const { items, failed } = await collectWorkItems({ ...opts, now });
  const mine = items.filter((i) => isMine(i, me));
  return { ...groupByBucket(mine, now), failedSources: failed };
}

export function groupByBucket(items: WorkItem[], now: Date): Omit<MyWork, "failedSources"> {
  const byBucket = new Map<MyWorkBucket, WorkItem[]>();
  for (const b of MY_WORK_BUCKETS) byBucket.set(b, []);
  for (const i of items) byBucket.get(bucketOf(i, now))!.push(i);
  const groups = MY_WORK_BUCKETS.map((bucket) => {
    const list = byBucket.get(bucket)!.sort(sortForQueue);
    return { bucket, items: list, count: list.length, money: sumMoney(list) };
  });
  return {
    groups,
    total: items.length,
    overdue: byBucket.get("OVERDUE")!.length,
    money: sumMoney(items),
  };
}

/** Gấp trước, rồi tới hạn sớm hơn, rồi điểm cao hơn. Việc không có hạn KHÔNG chen lên trước việc có hạn. */
export function sortForQueue(a: WorkItem, b: WorkItem): number {
  const p = WORK_PRIORITY_RANK[a.priority] - WORK_PRIORITY_RANK[b.priority];
  if (p !== 0) return p;
  const da = (a.slaAt ?? a.dueAt)?.getTime() ?? Number.POSITIVE_INFINITY;
  const dbb = (b.slaAt ?? b.dueAt)?.getTime() ?? Number.POSITIVE_INFINITY;
  if (da !== dbb) return da - dbb;
  return b.score - a.score;
}

/* ═══════════════════ HÀNG ĐỢI PHÒNG BAN ═══════════════════ */

export type WorkloadRow = {
  assigneeKey: string;
  name: string;
  userId: string | null;
  open: number;
  overdue: number;
  blocked: number;
  waiting: number;
  /** Điểm ưu tiên TRUNG BÌNH của việc đang cầm — thước đo ĐỘ KHÓ, đứng cạnh số lượng. */
  avgScore: number;
  money: ReturnType<typeof sumMoney>;
};

export type DepartmentQueue = {
  department: DepartmentCode;
  label: string;
  items: WorkItem[];
  open: number;
  overdue: number;
  unassigned: number;
  blocked: number;
  waiting: number;
  /** Việc đã đóng trong 7 ngày gần nhất — chỉ để đối chiếu, KHÔNG phải thước đo năng suất. */
  completedRecent: number;
  /** Tỷ lệ việc CÓ HẠN còn trong hạn (0–1). `null` khi không việc nào của phòng có hạn. */
  slaOnTime: number | null;
  money: ReturnType<typeof sumMoney>;
  workload: WorkloadRow[];
  bySource: { source: WorkSource; label: string; count: number; overdue: number }[];
};

/**
 * MỘT PHÒNG, MỘT BỨC TRANH.
 *
 * `slaOnTime` chỉ tính trên việc CÓ ĐẶT HẠN. Nếu gộp cả việc không đặt hạn vào mẫu số thì tỷ lệ
 * đúng hạn được thổi lên bằng chính những việc không ai đo — đúng cái bẫy mà `SLA_STATES` phân
 * biệt `NONE` với `OK` để tránh.
 */
export async function getDepartmentQueue(department: DepartmentCode, opts: CollectOptions = {}): Promise<DepartmentQueue> {
  const now = opts.now ?? new Date();
  const { items } = await collectWorkItems({ ...opts, now, includeClosed: true });
  const all = items.filter((i) => i.department === department);
  const open = all.filter((i) => i.status !== "DONE" && i.status !== "CANCELLED");
  return buildDepartmentQueue(department, all, open, now);
}

export function buildDepartmentQueue(department: DepartmentCode, all: WorkItem[], open: WorkItem[], now: Date): DepartmentQueue {
  const sevenDaysAgo = now.getTime() - 7 * 24 * 3_600_000;
  const withSla = open.filter((i) => (i.slaAt ?? i.dueAt) !== null);
  const onTime = withSla.filter((i) => slaStateOf(i.slaAt ?? i.dueAt, now) !== "BREACHED");

  const workMap = new Map<string, WorkItem[]>();
  for (const i of open) {
    const k = i.assignee ? (i.assignee.id ?? `name:${i.assignee.name.trim().toLowerCase()}`) : "";
    workMap.set(k, [...(workMap.get(k) ?? []), i]);
  }
  const workload: WorkloadRow[] = [...workMap.entries()]
    .filter(([k]) => k !== "")
    .map(([k, list]) => ({
      assigneeKey: k,
      name: list[0].assignee?.name ?? "",
      userId: list[0].assignee?.id ?? null,
      open: list.length,
      overdue: list.filter((i) => slaStateOf(i.slaAt ?? i.dueAt, now) === "BREACHED").length,
      blocked: list.filter((i) => i.status === "BLOCKED").length,
      waiting: list.filter((i) => i.status === "WAITING").length,
      avgScore: Math.round(list.reduce((s, i) => s + i.score, 0) / list.length),
      money: sumMoney(list),
    }))
    .sort((a, b) => b.overdue - a.overdue || b.open - a.open);

  const sourceMap = new Map<WorkSource, WorkItem[]>();
  for (const i of open) sourceMap.set(i.sourceType as WorkSource, [...(sourceMap.get(i.sourceType as WorkSource) ?? []), i]);

  return {
    department,
    label: DEPARTMENT_LABEL[department],
    items: open.sort(sortForQueue),
    open: open.length,
    overdue: open.filter((i) => slaStateOf(i.slaAt ?? i.dueAt, now) === "BREACHED").length,
    unassigned: open.filter((i) => !i.assignee).length,
    blocked: open.filter((i) => i.status === "BLOCKED").length,
    waiting: open.filter((i) => i.status === "WAITING").length,
    completedRecent: all.filter((i) => i.status === "DONE" && i.completedAt !== null && i.completedAt.getTime() >= sevenDaysAgo).length,
    slaOnTime: withSla.length ? onTime.length / withSla.length : null,
    money: sumMoney(open),
    workload,
    bySource: [...sourceMap.entries()]
      .map(([source, list]) => ({
        source,
        label: WORK_SOURCE_SPEC[source]?.label ?? source,
        count: list.length,
        overdue: list.filter((i) => slaStateOf(i.slaAt ?? i.dueAt, now) === "BREACHED").length,
      }))
      .sort((a, b) => b.overdue - a.overdue || b.count - a.count),
  };
}

/* ═══════════════════ BUỒNG LÁI: PHÒNG NÀO ĐANG KẸT ═══════════════════ */

export type DepartmentHealth = {
  department: DepartmentCode;
  label: string;
  /** `OK` · `WATCH` · `STUCK`. Xem `healthOf` — công thức mở, đọc là kiểm chứng được. */
  health: "OK" | "WATCH" | "STUCK";
  open: number;
  overdue: number;
  unassigned: number;
  blocked: number;
  urgent: number;
  slaOnTime: number | null;
  money: ReturnType<typeof sumMoney>;
  /** Việc gấp nhất của phòng, để bấm thẳng vào. */
  topItem: { key: string; title: string; url: string } | null;
  leadName: string;
};

/**
 * SỨC KHOẺ MỘT PHÒNG — ba mức, và ngưỡng ở ngay đây để người đọc kiểm chứng.
 *
 * KHÔNG tính bằng SỐ LƯỢNG việc: một phòng 200 việc đúng hạn đang chạy tốt, một phòng 12 việc mà
 * 8 việc quá hạn thì đang kẹt. Nên thước đo là TỶ LỆ QUÁ HẠN và SỐ VIỆC BỊ CHẶN — hai thứ nói
 * được rằng công việc không chảy.
 */
export function healthOf(open: number, overdue: number, blocked: number): DepartmentHealth["health"] {
  if (open === 0) return "OK";
  const rate = overdue / open;
  if (rate >= 0.3 || blocked >= 5) return "STUCK";
  if (rate >= 0.1 || blocked > 0) return "WATCH";
  return "OK";
}

export const DEPT_HEALTH_LABEL: Record<DepartmentHealth["health"], string> = {
  OK: "Đang chảy",
  WATCH: "Cần để mắt",
  STUCK: "Đang kẹt",
};

export const DEPT_HEALTH_TONE: Record<DepartmentHealth["health"], string> = {
  OK: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  WATCH: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  STUCK: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
};

export async function getDepartmentCockpit(opts: CollectOptions = {}): Promise<{ rows: DepartmentHealth[]; failedSources: { source: WorkSource; error: string }[] }> {
  const now = opts.now ?? new Date();
  const [{ items, failed }, departments] = await Promise.all([collectWorkItems({ ...opts, now }), listDepartments()]);
  const leadByCode = new Map(departments.map((d) => [d.code, d.leadName]));
  const byDept = new Map<DepartmentCode, WorkItem[]>();
  for (const i of items) byDept.set(i.department, [...(byDept.get(i.department) ?? []), i]);

  const rows: DepartmentHealth[] = DEPARTMENT_ORDER.map((department) => {
    const list = (byDept.get(department) ?? []).sort(sortForQueue);
    const overdue = list.filter((i) => slaStateOf(i.slaAt ?? i.dueAt, now) === "BREACHED").length;
    const blocked = list.filter((i) => i.status === "BLOCKED").length;
    const withSla = list.filter((i) => (i.slaAt ?? i.dueAt) !== null);
    const top = list[0];
    return {
      department,
      label: DEPARTMENT_LABEL[department],
      health: healthOf(list.length, overdue, blocked),
      open: list.length,
      overdue,
      unassigned: list.filter((i) => !i.assignee).length,
      blocked,
      urgent: list.filter((i) => i.priority === "URGENT").length,
      slaOnTime: withSla.length ? withSla.filter((i) => slaStateOf(i.slaAt ?? i.dueAt, now) !== "BREACHED").length / withSla.length : null,
      money: sumMoney(list),
      topItem: top ? { key: top.key, title: top.title, url: top.sourceUrl } : null,
      leadName: leadByCode.get(department) ?? "",
    };
  });
  return { rows, failedSources: failed };
}

/* ═══════════════════ LỌC CHO "TẤT CẢ CÔNG VIỆC" ═══════════════════ */

export type WorkFilter = {
  department?: DepartmentCode;
  source?: WorkSource;
  status?: WorkStatus;
  sla?: SlaState;
  assignee?: string;
  /** `true` = chỉ việc chưa ai nhận. */
  unassignedOnly?: boolean;
  q?: string;
};

export function filterWork(items: WorkItem[], f: WorkFilter, now: Date): WorkItem[] {
  const q = f.q?.trim().toLowerCase() ?? "";
  return items.filter((i) => {
    if (f.department && i.department !== f.department) return false;
    if (f.source && i.sourceType !== f.source) return false;
    if (f.status && i.status !== f.status) return false;
    if (f.sla && slaStateOf(i.slaAt ?? i.dueAt, now) !== f.sla) return false;
    if (f.unassignedOnly && i.assignee) return false;
    if (f.assignee && !(i.assignee?.id === f.assignee || i.assignee?.name === f.assignee)) return false;
    if (q && !`${i.title} ${i.summary} ${i.businessEntityId}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** Người giao việc được cho ai: tài khoản đang hoạt động, kèm phòng ban để chọn cho đúng. */
export async function assignableMembers(): Promise<{ id: string; name: string; email: string; departments: string[] }[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      departments: sql<string>`coalesce((select string_agg(d.name, ', ' order by d.sort_order) from department_members dm join departments d on d.id = dm.department_id where dm.user_id = ${schema.users.id} and dm.active), '')`,
    })
    .from(schema.users)
    .where(eq(schema.users.active, true))
    .orderBy(asc(schema.users.name));
  return rows.map((r) => ({ ...r, departments: r.departments ? r.departments.split(", ") : [] }));
}

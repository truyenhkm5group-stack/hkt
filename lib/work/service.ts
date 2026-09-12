import { and, eq } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { DEPARTMENT_LABEL, type DepartmentCode } from "@/lib/constants/departments";
import { canTransition, parseWorkKey, WORK_STATUSES, type WorkPriority, type WorkStatus } from "@/lib/constants/work";
import { authorityOf, isWorkSource, WORK_SOURCE_SPEC, type WorkSource } from "@/lib/constants/work-sources";

/**
 * ═══════════ GHI VÀO LỚP CÔNG VIỆC ═══════════
 *
 * Tách khỏi `lib/actions/work.ts` theo đúng lối `lib/cs/workqueue.ts`: Server Action lo kiểm
 * quyền / zod / `audit()` / `revalidatePath`, tệp này lo LUẬT. Nhờ vậy kiểm thử gọi thẳng được mà
 * không phải dựng một phiên đăng nhập giả.
 *
 * ─── ĐIỀU DUY NHẤT TỆP NÀY KHÔNG BAO GIỜ LÀM ───
 *
 * Không hàm nào ở đây ghi vào `cs_cases`, `shipment_care`, `bank_transactions`, `notifications`
 * hay bất kỳ bảng nghiệp vụ nào. Đóng một việc ở nguồn phải đi qua Server Action của chính miền
 * đó (xem `WORK_ACTION` mode `DOMAIN`). Nếu một ngày có hàm ở đây `update` một bảng nghiệp vụ thì
 * ERP có hai đường ghi cho cùng một sự thật, và đường thứ hai sẽ không có `audit()` của miền kia.
 */

export type WorkActor = { id: string; email: string; name: string; source?: "UI" | "API" | "SYSTEM" | "RECURRENCE" };

export type WorkResult<T = object> = ({ ok: true } & T) | { error: string };

async function departmentIdOf(db: Db, code: DepartmentCode | null | undefined): Promise<string | null> {
  if (!code) return null;
  const row = await db.query.departments.findFirst({ where: eq(schema.departments.code, code), columns: { id: true } });
  return row?.id ?? null;
}

/**
 * Lấy (hoặc tạo) dòng ghi chú cho một việc CHIẾU.
 *
 * Dòng chỉ sinh ra khi có người thật sự chạm vào. Tạo sẵn cho mọi việc chiếu thì bảng `work_items`
 * sẽ phình bằng tổng số việc từng tồn tại, và phần lớn dòng không mang thông tin gì.
 */
export async function ensureOverlay(db: Db, key: string, actor: WorkActor, department?: DepartmentCode | null): Promise<WorkResult<{ id: string }>> {
  const parsed = parseWorkKey(key);
  if (!parsed) return { error: "Khoá việc không hợp lệ" };
  if (!isWorkSource(parsed.sourceType)) return { error: `Nguồn việc không tồn tại: ${parsed.sourceType}` };
  const source = parsed.sourceType as WorkSource;
  if (authorityOf(source) !== "SOURCE") return { error: "Việc này do lớp công việc sở hữu — không cần lớp ghi chú" };

  const existing = await db.query.workItems.findFirst({
    where: and(eq(schema.workItems.sourceType, source), eq(schema.workItems.sourceKey, parsed.sourceKey)),
    columns: { id: true },
  });
  if (existing) return { ok: true, id: existing.id };

  const deptId = await departmentIdOf(db, department ?? WORK_SOURCE_SPEC[source].department);
  const id = crypto.randomUUID();
  await db
    .insert(schema.workItems)
    .values({
      id,
      sourceType: source,
      sourceKey: parsed.sourceKey,
      authority: "SOURCE",
      // `status` CỐ Ý bỏ trống: ràng buộc `work_items_authority_check` đòi `NULL` với dòng chiếu.
      departmentId: deptId,
      businessEntity: WORK_SOURCE_SPEC[source].businessEntity,
      creationSource: "AUTO",
      createdBy: actor.id,
    })
    .onConflictDoNothing();
  const row = await db.query.workItems.findFirst({
    where: and(eq(schema.workItems.sourceType, source), eq(schema.workItems.sourceKey, parsed.sourceKey)),
    columns: { id: true },
  });
  return row ? { ok: true, id: row.id } : { error: "Không tạo được lớp ghi chú cho việc này" };
}

export async function logWorkEvent(
  db: Db,
  input: {
    workKey: string;
    workItemId: string | null;
    actor: WorkActor;
    action: string;
    note?: string;
    previousStatus?: string | null;
    nextStatus?: string | null;
    previousAssignee?: string | null;
    nextAssignee?: string | null;
    payload?: unknown;
  },
) {
  await db.insert(schema.workItemEvents).values({
    workKey: input.workKey,
    workItemId: input.workItemId,
    actorId: input.actor.id || null,
    actorEmail: input.actor.email,
    actorName: input.actor.name,
    source: input.actor.source ?? "UI",
    action: input.action,
    note: input.note ?? "",
    previousStatus: input.previousStatus ?? null,
    nextStatus: input.nextStatus ?? null,
    previousAssignee: input.previousAssignee ?? null,
    nextAssignee: input.nextAssignee ?? null,
    payload: (input.payload ?? null) as never,
  });
}

/* ═══════════════════ GIAO VIỆC ═══════════════════ */

export async function assignWork(key: string, assigneeId: string | null, actor: WorkActor): Promise<WorkResult> {
  const db = await getDb();
  const parsed = parseWorkKey(key);
  if (!parsed) return { error: "Khoá việc không hợp lệ" };

  if (assigneeId) {
    const u = await db.query.users.findFirst({ where: eq(schema.users.id, assigneeId), columns: { id: true, active: true } });
    if (!u) return { error: "Không tìm thấy người dùng" };
    if (!u.active) return { error: "Tài khoản này đã ngừng hoạt động" };
  }

  const owned = isWorkSource(parsed.sourceType) && authorityOf(parsed.sourceType as WorkSource) === "WORK";
  const row = owned
    ? await db.query.workItems.findFirst({ where: and(eq(schema.workItems.sourceType, parsed.sourceType), eq(schema.workItems.sourceKey, parsed.sourceKey)) })
    : null;
  if (owned && !row) return { error: "Không tìm thấy việc" };

  let itemId = row?.id ?? null;
  if (!owned) {
    const ov = await ensureOverlay(db, key, actor);
    if ("error" in ov) return ov;
    itemId = ov.id;
  }

  const before = row?.assigneeId ?? (await db.query.workItems.findFirst({ where: eq(schema.workItems.id, itemId!), columns: { assigneeId: true } }))?.assigneeId ?? null;
  await db
    .update(schema.workItems)
    .set({
      assigneeId,
      assignedBy: actor.id || null,
      assignedAt: assigneeId ? new Date() : null,
      // Giao việc cho ai đó KHÔNG có nghĩa là họ đã bắt đầu: `NEW` → `ASSIGNED`, không nhảy thẳng
      // sang `IN_PROGRESS`. Giơ tay không phải là đang chạy.
      ...(owned && row?.status === "NEW" && assigneeId ? { status: "ASSIGNED" as const } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.workItems.id, itemId!));

  await logWorkEvent(db, { workKey: key, workItemId: itemId, actor, action: "ASSIGN", previousAssignee: before, nextAssignee: assigneeId });
  return { ok: true };
}

/* ═══════════════════ ĐỔI TRẠNG THÁI (chỉ việc tay / định kỳ) ═══════════════════ */

export async function setWorkStatus(key: string, next: WorkStatus, actor: WorkActor, opts: { blockedReason?: string } = {}): Promise<WorkResult> {
  const db = await getDb();
  const parsed = parseWorkKey(key);
  if (!parsed) return { error: "Khoá việc không hợp lệ" };
  if (!(WORK_STATUSES as readonly string[]).includes(next)) return { error: "Trạng thái không hợp lệ" };
  if (!isWorkSource(parsed.sourceType) || authorityOf(parsed.sourceType as WorkSource) !== "WORK") {
    /*
      ĐÂY LÀ BỨC TƯỜNG GIỮA HAI CHIỀU.

      Việc chiếu từ miền nghiệp vụ phải đóng TẠI NGUỒN — bằng chính Server Action của trang CSKH /
      care / sổ ngân hàng. Cho phép đóng ở đây là mở đúng cái cửa mà cả kiến trúc này sinh ra để
      đóng: hai nơi giữ trạng thái cho một sự việc.
    */
    return { error: "Việc này thuộc miền nghiệp vụ — phải xử lý ở đúng nguồn, không đóng được từ hàng đợi" };
  }

  const row = await db.query.workItems.findFirst({ where: and(eq(schema.workItems.sourceType, parsed.sourceType), eq(schema.workItems.sourceKey, parsed.sourceKey)) });
  if (!row) return { error: "Không tìm thấy việc" };
  const from = (row.status ?? "NEW") as WorkStatus;
  if (from === next) return { ok: true };
  if (!canTransition(from, next)) return { error: `Không chuyển được từ "${from}" sang "${next}"` };

  const reason = (opts.blockedReason ?? row.blockedReason ?? "").trim();
  if (next === "BLOCKED" && !reason) return { error: "Báo bị chặn thì phải nói rõ đang vướng cái gì" };

  const now = new Date();
  await db
    .update(schema.workItems)
    .set({
      status: next,
      blockedReason: next === "BLOCKED" ? reason : "",
      startedAt: next === "IN_PROGRESS" && !row.startedAt ? now : row.startedAt,
      completedAt: next === "DONE" || next === "CANCELLED" ? now : null,
      completedBy: next === "DONE" ? actor.id || null : null,
      updatedAt: now,
    })
    .where(eq(schema.workItems.id, row.id));

  await logWorkEvent(db, { workKey: key, workItemId: row.id, actor, action: next === "BLOCKED" ? "BLOCK" : "STATUS", note: next === "BLOCKED" ? reason : "", previousStatus: from, nextStatus: next });
  return { ok: true };
}

/* ═══════════════════ GHI CHÚ / HOÃN / HẠN / ƯU TIÊN / CHẶN ═══════════════════ */

export async function addWorkNote(key: string, note: string, actor: WorkActor): Promise<WorkResult> {
  const text = note.trim();
  if (!text) return { error: "Ghi chú rỗng" };
  const db = await getDb();
  const parsed = parseWorkKey(key);
  if (!parsed) return { error: "Khoá việc không hợp lệ" };
  // Ghi chú KHÔNG cần lớp ghi chú: `work_key` đủ để gắn lịch sử vào bất kỳ việc nào.
  const row = await db.query.workItems.findFirst({
    where: and(eq(schema.workItems.sourceType, parsed.sourceType), eq(schema.workItems.sourceKey, parsed.sourceKey)),
    columns: { id: true },
  });
  await logWorkEvent(db, { workKey: key, workItemId: row?.id ?? null, actor, action: "NOTE", note: text });
  return { ok: true };
}

export async function snoozeWork(key: string, until: Date | null, actor: WorkActor): Promise<WorkResult> {
  const db = await getDb();
  if (until && until.getTime() <= Date.now()) return { error: "Giờ hẹn phải ở tương lai" };
  const id = await overlayIdFor(db, key, actor);
  if (typeof id !== "string") return id;
  await db.update(schema.workItems).set({ snoozedUntil: until, updatedAt: new Date() }).where(eq(schema.workItems.id, id));
  await logWorkEvent(db, { workKey: key, workItemId: id, actor, action: "SNOOZE", note: until ? until.toISOString() : "bỏ hoãn" });
  return { ok: true };
}

export async function setWorkDue(key: string, dueAt: Date | null, actor: WorkActor): Promise<WorkResult> {
  const db = await getDb();
  const id = await overlayIdFor(db, key, actor);
  if (typeof id !== "string") return id;
  await db.update(schema.workItems).set({ dueAt, updatedAt: new Date() }).where(eq(schema.workItems.id, id));
  await logWorkEvent(db, { workKey: key, workItemId: id, actor, action: "DUE", note: dueAt ? dueAt.toISOString() : "bỏ hạn" });
  return { ok: true };
}

export async function setWorkPriority(key: string, priority: WorkPriority | null, actor: WorkActor): Promise<WorkResult> {
  const db = await getDb();
  const id = await overlayIdFor(db, key, actor);
  if (typeof id !== "string") return id;
  await db.update(schema.workItems).set({ priority, updatedAt: new Date() }).where(eq(schema.workItems.id, id));
  await logWorkEvent(db, { workKey: key, workItemId: id, actor, action: "PRIORITY", note: priority ?? "theo điểm tính được" });
  return { ok: true };
}

/**
 * Báo bị chặn cho việc CHIẾU.
 *
 * Trạng thái thật vẫn nằm ở nguồn — cái ghi ở đây chỉ là lý do, và phép chiếu biến "có lý do" thành
 * hiển thị `BLOCKED` (xem `applyOverlay`). Nhờ vậy trưởng phòng thấy được nút thắt mà không ai phải
 * nói dối trạng thái nghiệp vụ.
 */
export async function blockWork(key: string, reason: string, actor: WorkActor): Promise<WorkResult> {
  const text = reason.trim();
  const db = await getDb();
  const parsed = parseWorkKey(key);
  if (!parsed) return { error: "Khoá việc không hợp lệ" };
  if (isWorkSource(parsed.sourceType) && authorityOf(parsed.sourceType as WorkSource) === "WORK") {
    return setWorkStatus(key, text ? "BLOCKED" : "IN_PROGRESS", actor, { blockedReason: text });
  }
  if (!text) {
    const id = await overlayIdFor(db, key, actor);
    if (typeof id !== "string") return id;
    await db.update(schema.workItems).set({ blockedReason: "", updatedAt: new Date() }).where(eq(schema.workItems.id, id));
    await logWorkEvent(db, { workKey: key, workItemId: id, actor, action: "BLOCK", note: "gỡ chặn" });
    return { ok: true };
  }
  const id = await overlayIdFor(db, key, actor);
  if (typeof id !== "string") return id;
  await db.update(schema.workItems).set({ blockedReason: text, updatedAt: new Date() }).where(eq(schema.workItems.id, id));
  await logWorkEvent(db, { workKey: key, workItemId: id, actor, action: "BLOCK", note: text });
  return { ok: true };
}

async function overlayIdFor(db: Db, key: string, actor: WorkActor): Promise<string | { error: string }> {
  const parsed = parseWorkKey(key);
  if (!parsed) return { error: "Khoá việc không hợp lệ" };
  const row = await db.query.workItems.findFirst({
    where: and(eq(schema.workItems.sourceType, parsed.sourceType), eq(schema.workItems.sourceKey, parsed.sourceKey)),
    columns: { id: true },
  });
  if (row) return row.id;
  const ov = await ensureOverlay(db, key, actor);
  return "error" in ov ? ov : ov.id;
}

/* ═══════════════════ VIỆC TAY ═══════════════════ */

export type ManualTaskInput = {
  id?: string;
  title: string;
  summary?: string;
  department: DepartmentCode;
  assigneeId?: string | null;
  ownerId?: string | null;
  priority?: WorkPriority;
  dueAt?: Date | null;
  tags?: string[];
  checklist?: { text: string; done: boolean }[];
  businessEntity?: string;
  businessEntityId?: string;
  moneyAtRisk?: number | null;
  moneyBasis?: string;
};

export async function saveManualTask(input: ManualTaskInput, actor: WorkActor): Promise<WorkResult<{ id: string; key: string }>> {
  const db = await getDb();
  const title = input.title.trim();
  if (title.length < 2) return { error: "Tiêu đề quá ngắn" };
  const deptId = await departmentIdOf(db, input.department);
  if (!deptId) return { error: `Không tìm thấy phòng ban ${DEPARTMENT_LABEL[input.department] ?? input.department}` };

  // Tiền khai tay: có số thì phải nói CĂN CỨ. Ràng buộc CSDL cũng đòi, chặn sớm để báo lỗi dễ hiểu.
  const hasMoney = input.moneyAtRisk !== null && input.moneyAtRisk !== undefined;
  const basis = (input.moneyBasis ?? "").trim();
  if (hasMoney && !basis) return { error: "Khai số tiền thì phải nói rõ căn cứ ở đâu ra" };

  const now = new Date();
  if (input.id) {
    const row = await db.query.workItems.findFirst({ where: eq(schema.workItems.id, input.id) });
    if (!row) return { error: "Không tìm thấy việc" };
    if (row.authority !== "WORK") return { error: "Việc này thuộc miền nghiệp vụ, không sửa được ở đây" };
    await db
      .update(schema.workItems)
      .set({
        title,
        summary: input.summary?.trim() ?? "",
        departmentId: deptId,
        assigneeId: input.assigneeId ?? null,
        ownerId: input.ownerId ?? null,
        priority: input.priority ?? "NORMAL",
        dueAt: input.dueAt ?? null,
        tags: input.tags ?? [],
        checklist: input.checklist ?? [],
        businessEntity: input.businessEntity ?? "NONE",
        businessEntityId: input.businessEntityId ?? "",
        moneyAtRisk: hasMoney ? input.moneyAtRisk! : null,
        moneyConfidence: hasMoney ? "MEASURED" : "UNKNOWN",
        moneyBasis: hasMoney ? basis : "",
        updatedAt: now,
      })
      .where(eq(schema.workItems.id, input.id));
    const key = `${row.sourceType}:${row.sourceKey}`;
    await logWorkEvent(db, { workKey: key, workItemId: row.id, actor, action: "NOTE", note: "cập nhật nội dung việc" });
    return { ok: true, id: row.id, key };
  }

  const id = crypto.randomUUID();
  const sourceKey = id;
  await db.insert(schema.workItems).values({
    id,
    sourceType: "MANUAL_TASK",
    sourceKey,
    authority: "WORK",
    status: input.assigneeId ? "ASSIGNED" : "NEW",
    title,
    summary: input.summary?.trim() ?? "",
    departmentId: deptId,
    assigneeId: input.assigneeId ?? null,
    assignedBy: input.assigneeId ? actor.id || null : null,
    assignedAt: input.assigneeId ? now : null,
    ownerId: input.ownerId ?? null,
    priority: input.priority ?? "NORMAL",
    dueAt: input.dueAt ?? null,
    tags: input.tags ?? [],
    checklist: input.checklist ?? [],
    businessEntity: input.businessEntity ?? "NONE",
    businessEntityId: input.businessEntityId ?? "",
    moneyAtRisk: hasMoney ? input.moneyAtRisk! : null,
    moneyConfidence: hasMoney ? "MEASURED" : "UNKNOWN",
    moneyBasis: hasMoney ? basis : "",
    creationSource: "MANUAL",
    createdBy: actor.id || null,
  });
  const key = `MANUAL_TASK:${sourceKey}`;
  await logWorkEvent(db, { workKey: key, workItemId: id, actor, action: "CREATE", note: title, nextStatus: input.assigneeId ? "ASSIGNED" : "NEW", nextAssignee: input.assigneeId ?? null });
  return { ok: true, id, key };
}

export async function deleteManualTask(id: string, actor: WorkActor): Promise<WorkResult> {
  const db = await getDb();
  const row = await db.query.workItems.findFirst({ where: eq(schema.workItems.id, id) });
  if (!row) return { error: "Không tìm thấy việc" };
  if (row.authority !== "WORK") return { error: "Chỉ xoá được việc tay / việc định kỳ" };
  await logWorkEvent(db, { workKey: `${row.sourceType}:${row.sourceKey}`, workItemId: null, actor, action: "STATUS", note: `xoá việc "${row.title}"`, previousStatus: row.status });
  await db.delete(schema.workItems).where(eq(schema.workItems.id, id));
  return { ok: true };
}

/* ═══════════════════ VIỆC ĐỊNH KỲ ═══════════════════ */

export const CADENCES = ["DAILY", "WEEKDAYS", "WEEKLY", "MONTHLY"] as const;
export type Cadence = (typeof CADENCES)[number];

export const CADENCE_LABEL: Record<Cadence, string> = {
  DAILY: "Hằng ngày",
  WEEKDAYS: "Thứ Hai → thứ Sáu",
  WEEKLY: "Hằng tuần",
  MONTHLY: "Hằng tháng",
};

/**
 * KHOÁ KỲ của một lần lặp — và nó chính là cơ chế chống sinh hai lần.
 *
 * Job có thể chạy nhiều lần trong một ngày (scheduler thử lại, người bấm tay, hai container cùng
 * chạy). `(recurrence_id, occurrence_key)` là khoá tự nhiên của MỘT lần lặp, nên lần chạy thứ hai
 * không tạo thêm gì. Không cần khoá phân tán, không cần cờ "đang chạy".
 *
 * Giờ Việt Nam, cố ý: "việc của thứ Hai" phải là thứ Hai theo giờ người làm việc, không phải theo UTC.
 */
export function occurrenceKeyFor(cadence: Cadence, at: Date, cadenceDay: number | null): string {
  const vn = new Date(at.getTime() + 7 * 3_600_000);
  const y = vn.getUTCFullYear();
  const m = String(vn.getUTCMonth() + 1).padStart(2, "0");
  const d = String(vn.getUTCDate()).padStart(2, "0");
  if (cadence === "MONTHLY") return `${y}-${m}`;
  if (cadence === "WEEKLY") {
    // Tuần ISO: thứ Hai là ngày đầu tuần. Dùng thứ Năm của tuần đó để xác định năm, đúng chuẩn ISO.
    const tmp = new Date(Date.UTC(y, vn.getUTCMonth(), vn.getUTCDate()));
    const day = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
    return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }
  void cadenceDay;
  return `${y}-${m}-${d}`;
}

/** Kỳ này có phải lúc phải sinh việc không. Trả về `false` khi chưa tới giờ hoặc sai ngày. */
export function shouldGenerate(rec: { cadence: string; cadenceDay: number | null; hourOfDay: number }, at: Date): boolean {
  const vn = new Date(at.getTime() + 7 * 3_600_000);
  if (vn.getUTCHours() < rec.hourOfDay) return false;
  const dow = vn.getUTCDay() === 0 ? 7 : vn.getUTCDay();
  if (rec.cadence === "WEEKDAYS") return dow >= 1 && dow <= 5;
  if (rec.cadence === "WEEKLY") return dow === (rec.cadenceDay ?? 1);
  if (rec.cadence === "MONTHLY") return vn.getUTCDate() === (rec.cadenceDay ?? 1);
  return true;
}

export type GenerateResult = { created: number; skipped: number };

/**
 * Sinh việc của kỳ hiện tại cho mọi định nghĩa đang bật.
 *
 * Chạy được bao nhiêu lần cũng chỉ ra đúng ngần ấy việc một lần — `onConflictDoNothing` trên
 * `(source_type, source_key)` với `source_key = "<recurrenceId>:<occurrenceKey>"`.
 */
export async function generateRecurringTasks(at: Date = new Date(), actor: WorkActor = { id: "", email: "", name: "hệ thống", source: "RECURRENCE" }): Promise<GenerateResult> {
  const db = await getDb();
  const recs = await db.query.workRecurrences.findMany({ where: eq(schema.workRecurrences.active, true) });
  let created = 0;
  let skipped = 0;
  for (const rec of recs) {
    if (!shouldGenerate(rec, at)) {
      skipped += 1;
      continue;
    }
    const key = occurrenceKeyFor(rec.cadence as Cadence, at, rec.cadenceDay);
    const sourceKey = `${rec.id}:${key}`;
    const id = crypto.randomUUID();
    const inserted = await db
      .insert(schema.workItems)
      .values({
        id,
        sourceType: "RECURRING_TASK",
        sourceKey,
        authority: "WORK",
        status: rec.assigneeId ? "ASSIGNED" : "NEW",
        title: rec.title,
        summary: rec.description,
        departmentId: rec.departmentId,
        assigneeId: rec.assigneeId,
        assignedAt: rec.assigneeId ? at : null,
        ownerId: rec.ownerId,
        priority: rec.priority,
        dueAt: new Date(at.getTime() + rec.dueInHours * 3_600_000),
        checklist: rec.checklist,
        recurrenceId: rec.id,
        occurrenceKey: key,
        creationSource: "RECURRING",
      })
      .onConflictDoNothing()
      .returning({ id: schema.workItems.id });
    if (inserted.length) {
      created += 1;
      await db.update(schema.workRecurrences).set({ lastGeneratedKey: key, lastGeneratedAt: at }).where(eq(schema.workRecurrences.id, rec.id));
      await logWorkEvent(db, { workKey: `RECURRING_TASK:${sourceKey}`, workItemId: inserted[0].id, actor: { ...actor, source: "RECURRENCE" }, action: "CREATE", note: `việc định kỳ "${rec.title}" kỳ ${key}` });
    } else {
      skipped += 1;
    }
  }
  return { created, skipped };
}

export type RecurrenceInput = {
  id?: string;
  title: string;
  description?: string;
  department: DepartmentCode;
  assigneeId?: string | null;
  ownerId?: string | null;
  priority?: WorkPriority;
  cadence: Cadence;
  cadenceDay?: number | null;
  hourOfDay?: number;
  dueInHours?: number;
  checklist?: { text: string; done: boolean }[];
  active?: boolean;
};

export async function saveRecurrence(input: RecurrenceInput, actor: WorkActor): Promise<WorkResult<{ id: string }>> {
  const db = await getDb();
  const title = input.title.trim();
  if (title.length < 2) return { error: "Tiêu đề quá ngắn" };
  const deptId = await departmentIdOf(db, input.department);
  if (!deptId) return { error: "Không tìm thấy phòng ban" };
  if (input.cadence === "WEEKLY" && (!input.cadenceDay || input.cadenceDay < 1 || input.cadenceDay > 7)) return { error: "Việc hằng tuần phải chọn thứ trong tuần" };
  // Ngày 29–31 không có ở mọi tháng — chọn nó nghĩa là có tháng việc không bao giờ sinh.
  if (input.cadence === "MONTHLY" && (!input.cadenceDay || input.cadenceDay < 1 || input.cadenceDay > 28)) return { error: "Việc hằng tháng chỉ chọn được ngày 1–28 (tháng nào cũng có)" };

  const values = {
    title,
    description: input.description?.trim() ?? "",
    departmentId: deptId,
    assigneeId: input.assigneeId ?? null,
    ownerId: input.ownerId ?? null,
    priority: input.priority ?? "NORMAL",
    cadence: input.cadence,
    cadenceDay: input.cadence === "DAILY" || input.cadence === "WEEKDAYS" ? null : (input.cadenceDay ?? null),
    hourOfDay: input.hourOfDay ?? 8,
    dueInHours: input.dueInHours ?? 24,
    checklist: input.checklist ?? [],
    active: input.active ?? true,
    updatedAt: new Date(),
  };

  if (input.id) {
    const row = await db.query.workRecurrences.findFirst({ where: eq(schema.workRecurrences.id, input.id), columns: { id: true } });
    if (!row) return { error: "Không tìm thấy việc định kỳ" };
    await db.update(schema.workRecurrences).set(values).where(eq(schema.workRecurrences.id, input.id));
    return { ok: true, id: input.id };
  }
  const id = crypto.randomUUID();
  await db.insert(schema.workRecurrences).values({ id, ...values, createdBy: actor.id || null });
  return { ok: true, id };
}

export async function deleteRecurrence(id: string): Promise<WorkResult> {
  const db = await getDb();
  // Việc ĐÃ SINH giữ nguyên: chúng là lịch sử có thật, không phải phần phụ của định nghĩa.
  await db.update(schema.workItems).set({ recurrenceId: null }).where(eq(schema.workItems.recurrenceId, id));
  await db.delete(schema.workRecurrences).where(eq(schema.workRecurrences.id, id));
  return { ok: true };
}

/* ═══════════════════ PHÒNG BAN ═══════════════════ */

export async function saveDepartment(input: { id?: string; code: string; name: string; description?: string; leadUserId?: string | null; sortOrder?: number; active?: boolean }): Promise<WorkResult<{ id: string }>> {
  const db = await getDb();
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,30}$/.test(code)) return { error: "Mã phòng chỉ gồm chữ HOA, số và gạch dưới" };
  const name = input.name.trim();
  if (name.length < 2) return { error: "Tên phòng quá ngắn" };
  const values = { code, name, description: input.description?.trim() ?? "", leadUserId: input.leadUserId ?? null, sortOrder: input.sortOrder ?? 100, active: input.active ?? true, updatedAt: new Date() };
  if (input.id) {
    await db.update(schema.departments).set(values).where(eq(schema.departments.id, input.id));
    // Trưởng phòng phải là thành viên của chính phòng đó, nếu không "việc của phòng tôi" sẽ rỗng.
    if (values.leadUserId) await setDepartmentMember(input.id, values.leadUserId, "LEAD");
    return { ok: true, id: input.id };
  }
  const dup = await db.query.departments.findFirst({ where: eq(schema.departments.code, code), columns: { id: true } });
  if (dup) return { error: `Mã phòng "${code}" đã tồn tại` };
  const id = crypto.randomUUID();
  await db.insert(schema.departments).values({ id, ...values });
  if (values.leadUserId) await setDepartmentMember(id, values.leadUserId, "LEAD");
  return { ok: true, id };
}

export async function setDepartmentMember(departmentId: string, userId: string, roleInDept: "LEAD" | "MEMBER", title = ""): Promise<WorkResult> {
  const db = await getDb();
  await db
    .insert(schema.departmentMembers)
    .values({ departmentId, userId, roleInDept, title, active: true })
    .onConflictDoUpdate({ target: [schema.departmentMembers.departmentId, schema.departmentMembers.userId], set: { roleInDept, title, active: true, updatedAt: new Date() } });
  return { ok: true };
}

export async function removeDepartmentMember(departmentId: string, userId: string): Promise<WorkResult> {
  const db = await getDb();
  // Ngừng hoạt động thay vì xoá: lịch sử "ai từng ở phòng nào" là căn cứ của báo cáo kỳ đã chốt.
  await db
    .update(schema.departmentMembers)
    .set({ active: false, updatedAt: new Date() })
    .where(and(eq(schema.departmentMembers.departmentId, departmentId), eq(schema.departmentMembers.userId, userId)));
  await db.update(schema.departments).set({ leadUserId: null }).where(and(eq(schema.departments.id, departmentId), eq(schema.departments.leadUserId, userId)));
  return { ok: true };
}

/** Lịch sử một việc, mới nhất trước. */
export async function listWorkEvents(key: string, limit = 100) {
  const db = await getDb();
  return db.query.workItemEvents.findMany({
    where: eq(schema.workItemEvents.workKey, key),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit,
  });
}


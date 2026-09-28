/**
 * ═══════════ ĐỊNH NGHĨA ĐỐI TƯỢNG TUỲ BIẾN (Phase 6 · mục 1, 4, 5) — CHỈ MÁY CHỦ ═══════════
 *
 * Một cửa duy nhất ghi `meta_objects`. Mỗi lượt ghi ⇒ `audit()` entity `META_OBJECT` kèm TRƯỚC/SAU.
 *
 * Luật không thương lượng:
 *  · khoá `^x_[a-z][a-z0-9_]{1,40}$` (tiền tố `x_` ⇒ không bao giờ trùng khoá hệ thống), BẤT BIẾN, duy nhất trong
 *    tổ chức — kể cả đối tượng đã lưu trữ (field, form, danh sách, giá trị, luật đã gắn theo khoá);
 *  · không xoá — `archiveObject` (dữ liệu, field, form giữ nguyên; đối tượng thôi hiện, thôi nhận đọc / ghi);
 *  · biểu tượng là tập ĐÓNG (`CUSTOM_OBJECT_ICONS`), nhóm menu là khoá MODULE có thật, khoá quyền siết là khoá CÓ
 *    THẬT trong sổ quyền — không ô gõ tự do nào đi thẳng vào một cổng;
 *  · quyền cấu hình là `metadata:manage` (cùng bốn màn hình metadata của Phase 2) và phiên phải mang tổ chức.
 * `getDb()` là CSDL của tổ chức người thao tác (silo): không hàm nào nhận mã tổ chức.
 */
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { ALL_PERMISSIONS, type Permission } from "@/lib/auth/permissions";
import { can, type SessionUser } from "@/lib/auth/session";
import { isModuleKey, moduleDef } from "@/lib/constants/platform-modules";
import { isUniqueViolation } from "@/lib/metadata/common";
import { CUSTOM_OBJECTS_MODULE, customObjectInfo, type MetaObjectRow } from "@/lib/metadata/custom-object-def";
import { zodFieldErrors } from "@/lib/metadata/fields";
import { RECORDS_VIEW_PERMISSION, RECORDS_WRITE_PERMISSION } from "@/lib/metadata/permissions";
import { CUSTOM_OBJECT_KEY_PATTERN } from "@/lib/metadata/types";
import { CUSTOM_OBJECT_ICONS, CUSTOM_OBJECT_MAX } from "@/lib/objects/constants";
import type { CustomObjectSummary, ObjectsError, ObjectsFailure, ObjectsResult } from "@/lib/objects/types";
import { canUseModule } from "@/lib/platform/capabilities";

export function objectsFail(code: ObjectsFailure["code"], errors: ObjectsError[] | string, path = "_"): ObjectsFailure {
  return { ok: false, code, errors: typeof errors === "string" ? [{ path, message: errors }] : errors };
}

/** Vì sao người này KHÔNG cấu hình được đối tượng tuỳ biến (`null` = được). Hỏng về phía hẹp. */
export function objectAdminDenial(user: SessionUser): string | null {
  if (!can(user, "metadata:manage")) return "Bạn không có quyền cấu hình dữ liệu (đối tượng, field, form, danh sách).";
  if (!user.organization) return "Phiên chưa gắn tổ chức — đăng nhập lại.";
  return null;
}

const textZ = (max: number, what: string) => z.string().trim().min(1, `${what} không được để trống`).max(max, `${what} tối đa ${max} ký tự`);
const permissionZ = z
  .string()
  .trim()
  .refine((p) => (ALL_PERMISSIONS as readonly string[]).includes(p), "khoá quyền không có trong sổ quyền");

const baseShape = {
  label: textZ(60, "tên đối tượng"),
  labelPlural: textZ(60, "tên số nhiều"),
  icon: z.enum(CUSTOM_OBJECT_ICONS as unknown as [string, ...string[]], { message: "biểu tượng không có trong bộ biểu tượng" }),
  moduleKey: z.string().trim().min(1).max(40).optional(),
  titleLabel: textZ(40, "tên ô tiêu đề").optional(),
  description: z.string().trim().max(500, "mô tả tối đa 500 ký tự").nullable().optional(),
  viewPermission: permissionZ.optional(),
  writePermission: permissionZ.optional(),
};

const createZ = z.object({ key: z.string().trim(), ...baseShape }).strict();
const patchZ = z
  .object({ ...baseShape, label: baseShape.label.optional(), labelPlural: baseShape.labelPlural.optional(), icon: baseShape.icon.optional() })
  .strict();

export type CreateObjectInput = z.input<typeof createZ>;
export type UpdateObjectPatch = z.input<typeof patchZ>;

function errorsOf(e: z.ZodError): ObjectsError[] {
  return zodFieldErrors(e).map((x) => ({ path: x.field, message: x.message }));
}

type Row = typeof schema.metaObjects.$inferSelect;

function summarize(row: Row, recordCount: number, fieldCount: number): CustomObjectSummary {
  const info = customObjectInfo(row as MetaObjectRow);
  return {
    key: row.key,
    label: row.label,
    labelPlural: row.labelPlural,
    icon: info.icon,
    moduleKey: info.menuModule,
    titleLabel: row.titleLabel,
    description: row.description ?? null,
    viewPermission: row.viewPermission,
    writePermission: row.writePermission,
    status: info.status,
    origin: row.origin ?? null,
    recordCount,
    fieldCount,
  };
}

/** Kiểm nhóm menu: khoá module CÓ THẬT, không phải module lõi-chỉ-hệ-thống, và đang bật (đối tượng tạo ra phải thấy được). */
async function checkMenuModule(key: string): Promise<ObjectsError | null> {
  if (!isModuleKey(key)) return { path: "moduleKey", message: `Nhóm menu "${key}" không phải một module có thật.` };
  const def = moduleDef(key);
  if (def?.category === "CONNECTOR") return { path: "moduleKey", message: `«${def.label}» là kết nối dữ liệu — không làm nhóm menu cho đối tượng.` };
  if (!(await canUseModule(key))) return { path: "moduleKey", message: `Module «${def?.label ?? key}» đang tắt với tổ chức — bật trước, hoặc chọn nhóm khác.` };
  return null;
}

// ─────────────────────────── ĐỌC ───────────────────────────

async function loadRows(includeArchived: boolean): Promise<Row[]> {
  const db = await getDb();
  const t = schema.metaObjects;
  return db
    .select()
    .from(t)
    .where(includeArchived ? undefined : eq(t.status, "ACTIVE"))
    .orderBy(t.label, t.key);
}

/** Đối tượng tuỳ biến của tổ chức (màn hình quản trị — `metadata:manage`). Kèm số bản ghi còn sống / số field đang dùng. */
export async function listObjects(user: SessionUser, opts: { includeArchived?: boolean } = {}): Promise<ObjectsResult<{ objects: CustomObjectSummary[] }>> {
  const denial = objectAdminDenial(user);
  if (denial) return objectsFail("FORBIDDEN", denial);
  const rows = await loadRows(opts.includeArchived !== false);
  const db = await getDb();
  const recs = await db
    .select({ key: schema.customRecords.objectKey, n: count() })
    .from(schema.customRecords)
    .where(isNull(schema.customRecords.deletedAt))
    .groupBy(schema.customRecords.objectKey);
  const fields = await db
    .select({ key: schema.metaCustomFields.objectKey, n: count() })
    .from(schema.metaCustomFields)
    .where(and(eq(schema.metaCustomFields.status, "ACTIVE"), sql`${schema.metaCustomFields.objectKey} like 'x!_%' escape '!'`))
    .groupBy(schema.metaCustomFields.objectKey);
  const rc = new Map(recs.map((r) => [r.key, Number(r.n)]));
  const fc = new Map(fields.map((r) => [r.key, Number(r.n)]));
  return { ok: true, objects: rows.map((r) => summarize(r, rc.get(r.key) ?? 0, fc.get(r.key) ?? 0)) };
}

export async function getObject(user: SessionUser, key: string): Promise<ObjectsResult<{ object: CustomObjectSummary }>> {
  const r = await listObjects(user, { includeArchived: true });
  if (!r.ok) return r;
  const object = r.objects.find((o) => o.key === key);
  return object ? { ok: true, object } : objectsFail("NOT_FOUND", `Không có đối tượng «${String(key).slice(0, 60)}» trong tổ chức này.`, "key");
}

// ─────────────────────────── GHI ───────────────────────────

export async function createObject(user: SessionUser, input: unknown): Promise<ObjectsResult<{ object: CustomObjectSummary }>> {
  const denial = objectAdminDenial(user);
  if (denial) return objectsFail("FORBIDDEN", denial);
  const parsed = createZ.safeParse(input);
  if (!parsed.success) return objectsFail("INVALID", errorsOf(parsed.error));
  const p = parsed.data;
  const errors: ObjectsError[] = [];
  if (!CUSTOM_OBJECT_KEY_PATTERN.test(p.key)) errors.push({ path: "key", message: "Khoá bắt đầu bằng «x_», rồi chữ thường không dấu / số / «_»; 4–43 ký tự (vd x_hop_dong)." });
  const moduleKey = p.moduleKey || CUSTOM_OBJECTS_MODULE;
  const menuErr = await checkMenuModule(moduleKey);
  if (menuErr) errors.push(menuErr);
  if (errors.length) return objectsFail("INVALID", errors);

  const db = await getDb();
  const [{ n }] = await db.select({ n: count() }).from(schema.metaObjects);
  if (Number(n) >= CUSTOM_OBJECT_MAX) return objectsFail("INVALID", `Tổ chức đã có ${CUSTOM_OBJECT_MAX} đối tượng tuỳ biến — lưu trữ không giải phóng khoá; liên hệ quản trị nền tảng.`);
  const [dup] = await db.select({ key: schema.metaObjects.key, status: schema.metaObjects.status }).from(schema.metaObjects).where(eq(schema.metaObjects.key, p.key)).limit(1);
  if (dup) return objectsFail("CONFLICT", `Khoá «${p.key}» đã có${dup.status === "ARCHIVED" ? " (đối tượng đã lưu trữ — khôi phục thay vì tạo lại)" : ""}. Khoá không dùng lại được.`, "key");

  let row: Row;
  try {
    [row] = await db
      .insert(schema.metaObjects)
      .values({
        key: p.key,
        label: p.label,
        labelPlural: p.labelPlural,
        icon: p.icon,
        moduleKey,
        titleLabel: p.titleLabel || "Tên",
        description: p.description?.trim() || null,
        viewPermission: p.viewPermission || RECORDS_VIEW_PERMISSION,
        writePermission: p.writePermission || RECORDS_WRITE_PERMISSION,
        status: "ACTIVE",
        createdBy: user.id,
        updatedBy: user.id,
      })
      .returning();
  } catch (error) {
    if (isUniqueViolation(error)) return objectsFail("CONFLICT", `Khoá «${p.key}» vừa được tạo bởi người khác.`, "key");
    throw error;
  }
  const object = summarize(row, 0, 0);
  await audit({ userId: user.id, userEmail: user.email, action: "META_OBJECT_CREATE", entity: "META_OBJECT", entityId: row.key, before: null, after: object });
  return { ok: true, object };
}

export async function updateObject(user: SessionUser, key: string, patch: unknown): Promise<ObjectsResult<{ object: CustomObjectSummary }>> {
  const denial = objectAdminDenial(user);
  if (denial) return objectsFail("FORBIDDEN", denial);
  const parsed = patchZ.safeParse(patch);
  if (!parsed.success) return objectsFail("INVALID", errorsOf(parsed.error));
  const p = parsed.data;
  const db = await getDb();
  const t = schema.metaObjects;
  const [current] = await db.select().from(t).where(eq(t.key, key)).limit(1);
  if (!current) return objectsFail("NOT_FOUND", `Không có đối tượng «${String(key).slice(0, 60)}» trong tổ chức này.`, "key");
  if (current.status === "ARCHIVED") return objectsFail("INVALID", `«${current.label}» đã lưu trữ — khôi phục trước khi sửa.`, "key");
  if (p.moduleKey !== undefined && p.moduleKey !== current.moduleKey) {
    const menuErr = await checkMenuModule(p.moduleKey || CUSTOM_OBJECTS_MODULE);
    if (menuErr) return objectsFail("INVALID", [menuErr]);
  }
  const next = {
    label: p.label ?? current.label,
    labelPlural: p.labelPlural ?? current.labelPlural,
    icon: p.icon ?? current.icon,
    moduleKey: p.moduleKey !== undefined ? p.moduleKey || CUSTOM_OBJECTS_MODULE : current.moduleKey,
    titleLabel: p.titleLabel ?? current.titleLabel,
    description: p.description !== undefined ? p.description?.trim() || null : current.description,
    viewPermission: p.viewPermission ?? current.viewPermission,
    writePermission: p.writePermission ?? current.writePermission,
  };
  const same = (Object.keys(next) as (keyof typeof next)[]).every((k) => next[k] === current[k]);
  if (same) return { ok: true, object: summarize(current, 0, 0) };
  const [row] = await db
    .update(t)
    .set({ ...next, updatedBy: user.id, updatedAt: new Date() })
    .where(and(eq(t.key, key), eq(t.status, "ACTIVE")))
    .returning();
  if (!row) return objectsFail("CONFLICT", "Đối tượng vừa bị lưu trữ bởi người khác — tải lại.", "key");
  const object = summarize(row, 0, 0);
  await audit({ userId: user.id, userEmail: user.email, action: "META_OBJECT_UPDATE", entity: "META_OBJECT", entityId: key, before: summarize(current, 0, 0), after: object });
  return { ok: true, object };
}

async function setStatus(user: SessionUser, key: string, to: "ACTIVE" | "ARCHIVED"): Promise<ObjectsResult<{ object: CustomObjectSummary }>> {
  const denial = objectAdminDenial(user);
  if (denial) return objectsFail("FORBIDDEN", denial);
  const db = await getDb();
  const t = schema.metaObjects;
  const [current] = await db.select().from(t).where(eq(t.key, key)).limit(1);
  if (!current) return objectsFail("NOT_FOUND", `Không có đối tượng «${String(key).slice(0, 60)}» trong tổ chức này.`, "key");
  // Đã ở trạng thái xin ⇒ không ghi gì, không thêm nhật ký (cùng tinh thần luật 61).
  if (current.status === to) return { ok: true, object: summarize(current, 0, 0) };
  const [row] = await db
    .update(t)
    .set({ status: to, updatedBy: user.id, updatedAt: new Date() })
    .where(and(eq(t.key, key), eq(t.status, current.status)))
    .returning();
  if (!row) return objectsFail("CONFLICT", "Đối tượng vừa được người khác đổi — tải lại.", "key");
  const object = summarize(row, 0, 0);
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: to === "ARCHIVED" ? "META_OBJECT_ARCHIVE" : "META_OBJECT_RESTORE",
    entity: "META_OBJECT",
    entityId: key,
    before: { status: current.status },
    after: { status: to },
  });
  return { ok: true, object };
}

/** Lưu trữ: đối tượng thôi hiện / thôi nhận đọc-ghi; bản ghi, field, form, giá trị giữ NGUYÊN. */
export function archiveObject(user: SessionUser, key: string) {
  return setStatus(user, key, "ARCHIVED");
}

export function restoreObject(user: SessionUser, key: string) {
  return setStatus(user, key, "ACTIVE");
}

/** Khoá quyền chọn được làm khoá siết — cả sổ quyền (UI hiện nhãn); lược đồ đầu vào vẫn kiểm lại ở máy chủ. */
export function permissionChoices(): Permission[] {
  return [...ALL_PERMISSIONS];
}

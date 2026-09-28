"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission, requireUser } from "@/lib/auth/session";
import { customObjectHref } from "@/lib/metadata/custom-object-def";
import type { MetadataErrorCode } from "@/lib/metadata/errors";
import type { CustomValues, FieldError } from "@/lib/metadata/types";
import { saveCustomFile } from "@/lib/metadata/values";
import { archiveObject, createObject, restoreObject, updateObject } from "@/lib/objects/objects";
import { createRecord, deleteRecord, recordGate, updateRecord } from "@/lib/objects/records";
import type { ObjectsFailure, ObjectsResult } from "@/lib/objects/types";

/**
 * ═══════════ SERVER ACTION CỦA ĐỐI TƯỢNG TUỲ BIẾN (Phase 6) ═══════════
 *
 * Mỏng có chủ đích: đọc phiên → lõi `lib/objects/*` (quyền, module, phạm vi, kiểm hợp lệ, nhật ký, sự kiện) →
 * `revalidatePath`. Lỗi nghiệp vụ trả `{ error, errors, code }` (cùng hình `MetaActionResult` của Phase 2 để
 * `DynamicForm` tô đúng ô), không ném. KHÔNG kèm `router.refresh()` ở client — dựng trang hai lần (PR #272).
 *
 * Đường dẫn revalidate DẪN XUẤT từ khoá đối tượng đã qua lược đồ (`x_…`), không nhận đường dẫn từ client.
 */

type Failure = { ok: false; error: string; errors: FieldError[]; code: MetadataErrorCode };

function failure(r: ObjectsFailure): Failure {
  return { ok: false, error: r.errors.map((e) => e.message).join(" · ") || "Không lưu được.", errors: r.errors.map((e) => ({ field: e.path, message: e.message })), code: r.code };
}

const objectKeyZ = z.string().regex(/^x_[a-z][a-z0-9_]{1,40}$/);
const recordIdZ = z.string().min(1).max(200);

function badInput(): Failure {
  return { ok: false, error: "Dữ liệu gửi lên không đúng dạng.", errors: [{ field: "_", message: "Dữ liệu gửi lên không đúng dạng." }], code: "INVALID" };
}

function refreshObject(objectKey: string, recordId?: string) {
  revalidatePath(customObjectHref(objectKey));
  if (recordId) revalidatePath(customObjectHref(objectKey, recordId));
}

// ─────────────────────────── Định nghĩa (metadata:manage) ───────────────────────────

const ADMIN_PATHS = ["/settings/objects", "/settings/data-model", "/settings/forms", "/settings/lists", "/settings/workflows"] as const;

function refreshAdmin<T>(r: ObjectsResult<T>): ObjectsResult<T> {
  if (r.ok) {
    for (const p of ADMIN_PATHS) revalidatePath(p);
    // Menu động của mọi trang (đối tượng mới / đổi tên / lưu trữ).
    revalidatePath("/", "layout");
  }
  return r;
}

export async function createObjectAction(input: unknown): Promise<({ ok: true; key: string }) | Failure> {
  const user = await requirePermission("metadata:manage");
  const r = refreshAdmin(await createObject(user, input));
  return r.ok ? { ok: true, key: r.object.key } : failure(r);
}

export async function updateObjectAction(key: string, patch: unknown): Promise<({ ok: true }) | Failure> {
  const user = await requirePermission("metadata:manage");
  if (!objectKeyZ.safeParse(key).success) return badInput();
  const r = refreshAdmin(await updateObject(user, key, patch));
  if (r.ok) refreshObject(key);
  return r.ok ? { ok: true } : failure(r);
}

export async function setObjectArchivedAction(key: string, archived: boolean): Promise<({ ok: true }) | Failure> {
  const user = await requirePermission("metadata:manage");
  if (!objectKeyZ.safeParse(key).success) return badInput();
  const r = refreshAdmin(archived ? await archiveObject(user, key) : await restoreObject(user, key));
  if (r.ok) refreshObject(key);
  return r.ok ? { ok: true } : failure(r);
}

// ─────────────────────────── Bản ghi (records:*) ───────────────────────────

const recordInputZ = z.object({ system: z.record(z.string(), z.unknown()).default({}), custom: z.record(z.string(), z.unknown()).default({}), version: z.number().int().optional() });

export async function createRecordAction(objectKey: string, input: { system: Record<string, unknown>; custom: CustomValues }): Promise<({ ok: true; id: string; redirectTo: string; message: string }) | Failure> {
  const user = await requireUser();
  const parsed = recordInputZ.safeParse(input);
  if (!objectKeyZ.safeParse(objectKey).success || !parsed.success) return badInput();
  const r = await createRecord(objectKey, parsed.data, user);
  if (!r.ok) return failure(r);
  refreshObject(objectKey);
  return { ok: true, id: r.id, redirectTo: r.href, message: "Đã tạo bản ghi" };
}

export async function updateRecordAction(objectKey: string, recordId: string, input: { system: Record<string, unknown>; custom: CustomValues; version?: number }): Promise<({ ok: true; values: CustomValues }) | Failure> {
  const user = await requireUser();
  const parsed = recordInputZ.safeParse(input);
  if (!objectKeyZ.safeParse(objectKey).success || !recordIdZ.safeParse(recordId).success || !parsed.success) return badInput();
  const r = await updateRecord(objectKey, recordId, parsed.data, user);
  if (!r.ok) return failure(r);
  if (r.changed.length) refreshObject(objectKey, recordId);
  return { ok: true, values: r.values };
}

export async function deleteRecordAction(objectKey: string, recordId: string): Promise<({ ok: true; redirectTo: string }) | Failure> {
  const user = await requireUser();
  if (!objectKeyZ.safeParse(objectKey).success || !recordIdZ.safeParse(recordId).success) return badInput();
  const r = await deleteRecord(objectKey, recordId, user);
  if (!r.ok) return failure(r);
  refreshObject(objectKey, recordId);
  return { ok: true, redirectTo: customObjectHref(objectKey) };
}

/**
 * Tải tệp cho field `file` của MỘT bản ghi tuỳ biến (`FormData`: `objectKey`, `recordId`, `field`, `file`). Cổng bản
 * ghi (module · quyền ghi · phạm vi) trước; trần dung lượng, quyền field, tồn tại bản ghi và gán id tệp ở `saveCustomFile`.
 */
export async function uploadRecordFileAction(formData: FormData): Promise<{ ok: true; id: string; filename: string } | { ok: false; error: string }> {
  const user = await requireUser();
  const objectKey = formData.get("objectKey");
  const recordId = formData.get("recordId");
  const field = formData.get("field");
  const file = formData.get("file");
  if (!objectKeyZ.safeParse(objectKey).success || typeof recordId !== "string" || typeof field !== "string" || !(file instanceof File)) return { ok: false, error: "Thiếu tệp hoặc thiếu bản ghi." };
  const gate = await recordGate(String(objectKey), user, "write");
  if (!gate.ok) return { ok: false, error: gate.errors.map((e) => e.message).join(" · ") };
  const r = await saveCustomFile(String(objectKey), recordId, field, { filename: file.name, mime: file.type, data: Buffer.from(await file.arrayBuffer()) }, user);
  if (!r.ok) return { ok: false, error: r.errors.map((e) => e.message).join(" · ") || "Không tải lên được." };
  refreshObject(String(objectKey), recordId);
  return { ok: true, id: r.file.id, filename: r.file.filename };
}


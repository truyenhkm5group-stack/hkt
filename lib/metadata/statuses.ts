/**
 * ═══════════ TRẠNG THÁI HỆ THỐNG: NHÃN / THỨ TỰ / ẨN KHỎI BỘ LỌC (M10) — CHỈ MÁY CHỦ ═══════════
 *
 * Core sở hữu trạng thái hệ thống (vd `orders.stage`). Tổ chức CHỈ đổi được ba thứ HIỂN THỊ: nhãn, thứ tự,
 * ẩn khỏi bộ lọc (`active: false`). KHÔNG thêm giá trị (chỉ nhận value có trong `options` của field hệ thống
 * trong sổ), KHÔNG đổi chuyển trạng thái, và KHÔNG chạm logistics / COD / ORDER_OUTCOME — bảng
 * `meta_status_overrides` chỉ được đọc để VẼ, không phép tính nào đọc nó.
 *
 * Trạng thái NGHIỆP VỤ (field custom kiểu `status`) không đi qua đây: tổ chức khai giá trị + chuyển trạng thái
 * ngay trên định nghĩa field, máy chủ ép ở `validateCustomValues`.
 */
import { and, eq, notInArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import type { AnyObjectDef } from "@/lib/constants/object-registry";
import { auditActor, checkObject, loadCustomDefs, requireObject } from "@/lib/metadata/common";
import { fail, MetadataError, type MetaFailure } from "@/lib/metadata/errors";
import { zodFieldErrors } from "@/lib/metadata/fields";
import type { FieldError, FieldOption, MetadataActor, SystemFieldDef } from "@/lib/metadata/types";

export type StatusOverride = { value: string; label: string | null; position: number | null; active: boolean };

const rowsZ = z
  .array(
    z
      .object({
        value: z.string().min(1).max(100),
        label: z.string().max(60, "nhãn tối đa 60 ký tự").nullable().optional(),
        position: z.number().int().min(0).max(1_000).nullable().optional(),
        active: z.boolean().optional(),
      })
      .strict(),
  )
  .max(200);

function statusField(def: AnyObjectDef, fieldKey: string): SystemFieldDef | null {
  if (!def.statusFields.includes(fieldKey)) return null;
  const f = def.fields.find((x) => x.key === fieldKey);
  return f && (f.options?.length ?? 0) > 0 ? f : null;
}

/** Áp ghi đè lên tuỳ chọn hệ thống — HÀM THUẦN. Ghi đè trỏ value lạ bị bỏ (không bao giờ sinh giá trị mới). */
export function applyStatusOverrides(options: readonly FieldOption[], overrides: readonly StatusOverride[]): FieldOption[] {
  const byValue = new Map(overrides.map((o) => [o.value, o]));
  return options
    .map((o) => {
      const ov = byValue.get(o.value);
      return {
        ...o,
        label: ov?.label?.trim() ? ov.label.trim() : o.label,
        position: ov?.position ?? o.position,
        active: ov ? ov.active && o.active : o.active,
      };
    })
    .sort((a, b) => a.position - b.position || options.findIndex((x) => x.value === a.value) - options.findIndex((x) => x.value === b.value));
}

async function readOverrides(objectKey: string, fieldKey: string): Promise<StatusOverride[]> {
  const db = await getDb();
  const t = schema.metaStatusOverrides;
  const rows = await db.select().from(t).where(and(eq(t.objectKey, objectKey), eq(t.fieldKey, fieldKey)));
  return rows.map((r) => ({ value: r.value, label: r.label ?? null, position: r.position ?? null, active: r.active }));
}

export async function getStatusOverrides(objectKey: string, fieldKey: string): Promise<StatusOverride[]> {
  const def = await requireObject(objectKey, "statuses");
  const field = statusField(def, fieldKey);
  if (!field) throw new MetadataError("NOT_FOUND", `${def.label} không có trạng thái hệ thống "${fieldKey}".`);
  const known = new Set((field.options ?? []).map((o) => o.value));
  return (await readOverrides(objectKey, fieldKey)).filter((o) => known.has(o.value));
}

export type StatusSaveResult = { ok: true; overrides: StatusOverride[] } | MetaFailure;

/** Thay TOÀN BỘ ghi đè của một trạng thái hệ thống. Value không có sẵn trong sổ ⇒ lỗi, không thêm. */
export async function saveStatusOverrides(objectKey: string, fieldKey: string, rows: unknown, actor: MetadataActor): Promise<StatusSaveResult> {
  const obj = await checkObject(objectKey, "statuses");
  if (!obj.ok) return obj;
  const field = statusField(obj.def, fieldKey);
  if (!field) return fail("NOT_FOUND", `${obj.def.label} không có trạng thái hệ thống "${fieldKey}".`, "fieldKey");
  const parsed = rowsZ.safeParse(rows);
  if (!parsed.success) return fail("INVALID", zodFieldErrors(parsed.error));
  const known = new Set((field.options ?? []).map((o) => o.value));
  const errors: FieldError[] = [];
  const seen = new Set<string>();
  for (const r of parsed.data) {
    if (!known.has(r.value)) errors.push({ field: r.value, message: `"${r.value}" không phải giá trị của ${field.label} — trạng thái hệ thống không thêm được giá trị mới.` });
    if (seen.has(r.value)) errors.push({ field: r.value, message: `"${r.value}" khai hai lần.` });
    seen.add(r.value);
  }
  if (errors.length > 0) return fail("INVALID", errors);
  const next: StatusOverride[] = parsed.data.map((r) => ({ value: r.value, label: r.label?.trim() || null, position: r.position ?? null, active: r.active !== false }));
  const before = await readOverrides(objectKey, fieldKey);
  const norm = (list: StatusOverride[]) => JSON.stringify([...list].sort((a, b) => a.value.localeCompare(b.value)));
  if (norm(before) === norm(next)) return { ok: true, overrides: next };

  const db = await getDb();
  const t = schema.metaStatusOverrides;
  const now = new Date();
  await db.transaction(async (tx) => {
    const keep = next.map((r) => r.value);
    await tx.delete(t).where(and(eq(t.objectKey, objectKey), eq(t.fieldKey, fieldKey), ...(keep.length > 0 ? [notInArray(t.value, keep)] : [])));
    for (const r of next) {
      await tx
        .insert(t)
        .values({ objectKey, fieldKey, value: r.value, label: r.label, position: r.position, active: r.active, updatedBy: actor.id, updatedAt: now })
        .onConflictDoUpdate({ target: [t.objectKey, t.fieldKey, t.value], set: { label: r.label, position: r.position, active: r.active, updatedBy: actor.id, updatedAt: now } });
    }
  });
  await audit({ ...auditActor(actor), action: "META_STATUS_SAVE", entity: "META_STATUS", entityId: `${objectKey}.${fieldKey}`, before, after: next });
  return { ok: true, overrides: next };
}

/** Tuỳ chọn đã áp nhãn / thứ tự / bật-tắt của tổ chức. Field custom kiểu chọn / trạng thái: trả tuỳ chọn của chính nó. */
export async function resolveStatusOptions(objectKey: string, fieldKey: string): Promise<FieldOption[]> {
  const def = await requireObject(objectKey);
  const field = statusField(def, fieldKey);
  if (field) {
    if (!def.capabilities.statuses) return [...(field.options ?? [])];
    return applyStatusOverrides(field.options ?? [], await readOverrides(objectKey, fieldKey));
  }
  const sys = def.fields.find((f) => f.key === fieldKey);
  if (sys?.options) return [...sys.options];
  if (def.capabilities.customFields) {
    const custom = (await loadCustomDefs(objectKey, true)).find((c) => c.key === fieldKey && (c.type === "status" || c.type === "select" || c.type === "multi_select"));
    if (custom) return [...custom.options];
  }
  throw new MetadataError("NOT_FOUND", `${def.label} không có field trạng thái "${fieldKey}".`);
}

/** Nhãn hiển thị của một giá trị. Giá trị không có trong tuỳ chọn ⇒ in nguyên giá trị (không đoán, không để trống). */
export async function resolveStatusLabel(objectKey: string, fieldKey: string, value: string): Promise<string> {
  const options = await resolveStatusOptions(objectKey, fieldKey);
  return options.find((o) => o.value === value)?.label ?? value;
}

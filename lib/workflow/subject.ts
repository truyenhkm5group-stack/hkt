/**
 * ═══════════ DỰNG "SUBJECT" CHO ĐIỀU KIỆN CỦA LUẬT — CHỈ MÁY CHỦ ═══════════
 *
 * Subject là ảnh chụp mà `evaluateCondition` đọc. Ba nhóm khoá, không nhóm nào tự bịa:
 *  · `system:event.*` / `system:payload.*` — thông tin của sự kiện đã kích hoạt luật (tên, subject, người làm,
 *    từng khoá cấp một của payload);
 *  · `system:<k>` — field HỆ THỐNG của bản ghi, đọc từ CỘT THẬT theo sổ đối tượng (`lib/constants/object-registry.ts`);
 *  · `custom:<k>` — field custom ACTIVE của đối tượng, đọc thẳng `custom_values` của CSDL tổ chức hiện hành.
 * Field biết được mà bản ghi chưa có giá trị ⇒ `null` (CHƯA BIẾT) — khoá vẫn có mặt, để phân biệt với ref lạ.
 */
import { and, eq } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import { METADATA_RECORD_SUBJECT } from "@/lib/constants/domain-events";
import { isObjectKey, objectDef } from "@/lib/constants/object-registry";
import { idColumnOf, loadCustomDefs } from "@/lib/metadata/common";

export type SubjectRef = { objectKey: string; recordId: string };

export type EventLike = {
  name: string;
  subjectType: string;
  subjectId: string;
  actorKind: string;
  payload: Record<string, unknown>;
};

/** Khoá thông tin sự kiện luôn có trong subject — lúc lưu luật, điều kiện được phép trỏ tới chúng. */
export const EVENT_SUBJECT_REFS = ["system:event.name", "system:event.subject_type", "system:event.subject_id", "system:event.actor_kind"] as const;
export const PAYLOAD_REF_PREFIX = "system:payload.";

/** Bản ghi mà sự kiện nói về — `null` khi subject của sự kiện không phải một đối tượng trong sổ. */
export function subjectRefOf(ev: Pick<EventLike, "subjectType" | "subjectId" | "payload">): SubjectRef | null {
  if (ev.subjectType === METADATA_RECORD_SUBJECT) {
    const o = ev.payload?.objectKey;
    const r = ev.payload?.recordId;
    return typeof o === "string" && typeof r === "string" && isObjectKey(o) ? { objectKey: o, recordId: r } : null;
  }
  return isObjectKey(ev.subjectType) ? { objectKey: ev.subjectType, recordId: ev.subjectId } : null;
}

function scalarOrList(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string" || typeof x === "number" || typeof x === "boolean");
  return null;
}

/** Phần subject đến từ SỰ KIỆN (thuần). */
export function eventSubjectFields(ev: EventLike): Record<string, unknown> {
  const out: Record<string, unknown> = {
    "system:event.name": ev.name,
    "system:event.subject_type": ev.subjectType,
    "system:event.subject_id": ev.subjectId,
    "system:event.actor_kind": ev.actorKind,
  };
  for (const [k, v] of Object.entries(ev.payload ?? {})) out[`${PAYLOAD_REF_PREFIX}${k}`] = scalarOrList(v);
  return out;
}

/** Phần subject đến từ BẢN GHI: field hệ thống (cột thật) + field custom ACTIVE. `null` khi bản ghi không tồn tại. */
export async function recordSubjectFields(ref: SubjectRef): Promise<Record<string, unknown> | null> {
  const def = objectDef(ref.objectKey);
  if (!def || typeof ref.recordId !== "string" || ref.recordId.length === 0 || ref.recordId.length > 200) return null;
  const db = await getDb();
  const table = (schema as unknown as Record<string, unknown>)[def.table] as PgTable;
  const rows = (await db.select().from(table).where(eq(idColumnOf(def), ref.recordId)).limit(1)) as Record<string, unknown>[];
  const row = rows[0];
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const f of def.fields) out[`system:${f.key}`] = scalarOrList(row[f.column]);
  if (def.customizable && def.capabilities.customFields) {
    const defs = await loadCustomDefs(ref.objectKey, false);
    const t = schema.customValues;
    const [cv] = await db
      .select({ values: t.values })
      .from(t)
      .where(and(eq(t.objectKey, ref.objectKey), eq(t.recordId, ref.recordId)))
      .limit(1);
    const values = cv?.values ?? {};
    for (const d of defs) out[`custom:${d.key}`] = scalarOrList(values[d.key]);
  }
  return out;
}

/** Nhãn ngắn của bản ghi để ghi vào việc / thông báo: `<đối tượng> "<tên>"` hoặc `<đối tượng> <id>`. */
export function subjectLabel(ref: SubjectRef | null, fields: Record<string, unknown> | null, fallback: string): string {
  if (!ref) return fallback;
  const def = objectDef(ref.objectKey);
  const title = def ? fields?.[`system:${def.titleField}`] : null;
  return `${def?.label ?? ref.objectKey} ${typeof title === "string" && title.trim() ? `"${title.trim()}"` : ref.recordId}`;
}

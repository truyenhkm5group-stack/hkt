import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { auditActionLabel } from "@/lib/constants/audit";
import { METADATA_RECORD_SUBJECT } from "@/lib/constants/domain-events";

/**
 * ═══════════ LỊCH SỬ DỮ LIỆU BỔ SUNG CỦA MỘT BẢN GHI (Phase 4 · nguồn `custom_record_<đối tượng>`) ═══════════
 *
 * Hai nhật ký có sẵn, KHÔNG chép sang đâu:
 *  · `domain_events` — sự kiện miền của field custom (`custom_status.changed`…), subject `custom_record`,
 *    `subject_id` ĐÚNG BẰNG `"<đối tượng>:<id>"` (so bằng, không `like`: id `abc` không được kéo theo `abc2`).
 *  · `audit_logs` — lượt ghi giá trị custom, `entity_id` ĐÚNG BẰNG cùng chuỗi ấy.
 *
 * Hàm chỉ ĐỌC và trả nguyên liệu thô; lọc theo quyền xem field (field người xem không được xem thì mốc của
 * nó không hiện, kể cả tên field) là việc của trình phân giải — nó biết người xem, hàm này thì không.
 * `getDb()` là CSDL của tổ chức hiện hành: id của tổ chức khác không có ở đây.
 */
export type RecordTimelineRaw = {
  id: string;
  at: Date;
  kind: "EVENT" | "AUDIT";
  name: string;
  title: string;
  /** Khoá field custom mà mốc này chạm tới — trình phân giải dùng để lọc theo quyền xem. */
  fieldKeys: string[];
  detail: string;
  source: string;
};

const RECORD_TIMELINE_MAX = 200;

function keysOf(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value as Record<string, unknown>) : [];
}

export async function getRecordTimeline(objectKey: string, recordId: string, limit = 50): Promise<RecordTimelineRaw[]> {
  const subjectId = `${objectKey}:${recordId}`;
  const take = Math.max(1, Math.min(limit, RECORD_TIMELINE_MAX));
  const db = await getDb();
  const de = schema.domainEvents;
  const al = schema.auditLogs;
  const [events, audits] = await Promise.all([
    db
      .select({ id: de.id, name: de.name, payload: de.payload, source: de.source, at: de.occurredAt })
      .from(de)
      .where(and(eq(de.subjectType, METADATA_RECORD_SUBJECT), eq(de.subjectId, subjectId)))
      .orderBy(desc(de.occurredAt))
      .limit(take),
    db
      .select({ id: al.id, action: al.action, entity: al.entity, detail: al.detail, email: al.userEmail, at: al.createdAt })
      .from(al)
      .where(eq(al.entityId, subjectId))
      .orderBy(desc(al.createdAt))
      .limit(take),
  ]);
  const out: RecordTimelineRaw[] = [];
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const fieldKey = typeof p.fieldKey === "string" ? p.fieldKey : null;
    const from = p.from === null || p.from === undefined ? "—" : String(p.from);
    const to = p.to === null || p.to === undefined ? "—" : String(p.to);
    out.push({
      id: `event-${e.id}`,
      at: e.at,
      kind: "EVENT",
      name: e.name,
      title: e.name === "custom_status.changed" ? "Đổi trạng thái" : e.name,
      fieldKeys: fieldKey ? [fieldKey] : [],
      detail: fieldKey ? `${fieldKey}: ${from} → ${to}` : "",
      source: e.source,
    });
  }
  for (const a of audits) {
    const d = (a.detail ?? {}) as Record<string, unknown>;
    // Nhật ký lưu trước/sau của ĐÚNG các khoá đổi — chỉ lấy TÊN khoá, không lấy giá trị (giá trị đi qua lọc quyền ở nơi gọi).
    const changed = [...new Set([...keysOf(d.before), ...keysOf(d.after)])].sort();
    out.push({
      id: `audit-${a.id}`,
      at: a.at,
      kind: "AUDIT",
      name: a.action,
      title: auditActionLabel(a.action),
      fieldKeys: changed,
      detail: "",
      source: a.email,
    });
  }
  return out.sort((x, y) => y.at.getTime() - x.at.getTime()).slice(0, take);
}

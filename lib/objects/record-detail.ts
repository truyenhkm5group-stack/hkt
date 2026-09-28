/**
 * ═══════════ DỮ LIỆU CỦA TRANG CHI TIẾT BẢN GHI `/o/<khoá>/<id>` (Phase 6 · mục 5; Phase 11 · H2) — CHỈ MÁY CHỦ ═══════════
 *
 * Trước đây trang tự gọi bảy dịch vụ; mỗi dịch vụ tự hỏi lại `meta_objects` / `meta_custom_fields` của CÙNG đối tượng
 * (đo: 13 / 28 câu của một lượt mở là metadata lặp). Gom về một hàm để cả lượt nằm trong MỘT phạm vi đọc metadata
 * (`withMetadataReadScope`) — và để bài kiểm ngân sách câu (`tests/page-query-budget.test.ts`) đo ĐÚNG đường trang đi,
 * không phải một bản chép tay của nó. Không đổi cổng nào: `getRecord` (cổng bản ghi + phạm vi) chạy trước mọi thứ khác,
 * y như trang cũ; mọi dịch vụ con giữ nguyên kiểm quyền của chúng.
 */
import type { SessionUser } from "@/lib/auth/session";
import type { AnyObjectDef } from "@/lib/constants/object-registry";
import { CUSTOM_RECORD_FORM_EDIT } from "@/lib/metadata/custom-object-def";
import { listFields } from "@/lib/metadata/fields";
import { getPublishedForm } from "@/lib/metadata/forms";
import { withMetadataReadScope } from "@/lib/metadata/read-scope";
import { customFileNames } from "@/lib/metadata/values";
import { getRecord, recordGate, recordTimeline, relationOptionsFor, reverseRelations, type RecordDetailResult, type RecordTimelineEntry } from "@/lib/objects/records";
import type { ObjectsFailure, ReverseRelationGroup } from "@/lib/objects/types";
import { userPickOptions } from "@/lib/queries/users";

export type RecordDetailPageData = {
  def: AnyObjectDef;
  detail: RecordDetailResult;
  form: Awaited<ReturnType<typeof getPublishedForm>>;
  fields: Awaited<ReturnType<typeof listFields>>;
  users: { id: string; label: string }[];
  relationOptions: Record<string, { id: string; label: string }[]>;
  reverse: ReverseRelationGroup[];
  timeline: RecordTimelineEntry[];
  fileNames: Record<string, string>;
};

/** `failure` = cổng bản ghi từ chối (trang in lời giải thích); `failure: null` = đối tượng biến mất giữa hai lượt đọc (404). */
export type RecordDetailPageResult = { ok: true; data: RecordDetailPageData } | { ok: false; failure: ObjectsFailure | null };

export function loadRecordDetailPage(objectKey: string, id: string, user: SessionUser): Promise<RecordDetailPageResult> {
  return withMetadataReadScope(async (): Promise<RecordDetailPageResult> => {
    const detail = await getRecord(objectKey, id, user);
    if (!detail.ok) return { ok: false, failure: detail };
    const gate = await recordGate(objectKey, user, "view");
    if (!gate.ok) return { ok: false, failure: null };
    const def = gate.def;
    const rec = detail.record;
    const [form, fields, users, relationOptions, reverse, timeline] = await Promise.all([
      getPublishedForm(def.key, CUSTOM_RECORD_FORM_EDIT),
      listFields(def.key),
      userPickOptions(),
      detail.canWrite ? relationOptionsFor(user, detail.customFields) : Promise.resolve({} as Record<string, { id: string; label: string }[]>),
      reverseRelations(def.key, rec.id, user),
      recordTimeline(def.key, rec.id, user, def),
    ]);
    // Tên tệp chỉ cho field người xem ĐƯỢC xem (dịch vụ đã lọc giá trị; định nghĩa lọc theo cùng luật).
    const visibleKeys = new Set(detail.customFields.map((f) => f.key));
    const fileIds = fields.custom.filter((f) => visibleKeys.has(f.key) && f.type === "file" && typeof rec.values[f.key] === "string").map((f) => String(rec.values[f.key]));
    const fileNames = fileIds.length ? await customFileNames(def.key, rec.id, fileIds, user) : {};
    return { ok: true, data: { def, detail, form, fields, users, relationOptions, reverse, timeline, fileNames } };
  });
}

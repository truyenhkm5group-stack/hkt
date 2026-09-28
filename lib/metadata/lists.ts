/**
 * ═══════════ DANH SÁCH METADATA: NHÁP / ĐÃ XUẤT BẢN (M9, M12) — CHỈ MÁY CHỦ ═══════════
 *
 * Cùng hình với `forms.ts`. Chưa xuất bản bao giờ ⇒ danh sách MẶC ĐỊNH (`defaultListView`): cột hệ thống như
 * mã nguồn, cột custom có mặt nhưng ẩn — trang chạy y như trước khi có metadata.
 */
import { audit } from "@/lib/audit";
import type { AnyObjectDef } from "@/lib/constants/object-registry";
import { auditActor, checkObject, loadCustomDefs, requireObject } from "@/lib/metadata/common";
import { loadConfigRow, publishConfig, publisherOf, upsertDraft } from "@/lib/metadata/config-store";
import { fail, MetadataError, type MetaFailure } from "@/lib/metadata/errors";
import { zodFieldErrors } from "@/lib/metadata/fields";
import { parseRef } from "@/lib/metadata/form-schema";
import { defaultListView, listRefProblems, listViewSchemaZ, normalizeListView } from "@/lib/metadata/list-schema";
import type { ListViewSchema, MetadataActor } from "@/lib/metadata/types";

// Hàm thuần nằm ở `list-schema.ts` (client-safe, trình soạn dùng lại); xuất lại ở đây cho nơi gọi phía máy chủ.
export { defaultListView, normalizeListView } from "@/lib/metadata/list-schema";

function requireViewKey(def: AnyObjectDef, viewKey: string): void {
  if (!def.lists.some((l) => l.key === viewKey)) throw new MetadataError("NOT_FOUND", `${def.label} không có danh sách "${viewKey}".`);
}

export type PublishedListView = { schema: ListViewSchema; version: number; isDefault: boolean; publishedAt: Date | null; publishedBy: string | null };

export async function getPublishedListView(objectKey: string, viewKey: string): Promise<PublishedListView> {
  const def = await requireObject(objectKey, "lists");
  requireViewKey(def, viewKey);
  const custom = def.capabilities.customFields ? await loadCustomDefs(objectKey, true) : [];
  const row = await loadConfigRow("LIST_VIEW", objectKey, viewKey);
  if (!row || row.published === null || row.published === undefined) {
    return { schema: normalizeListView(defaultListView(def, viewKey, custom), def.fields, custom), version: 0, isDefault: true, publishedAt: null, publishedBy: null };
  }
  return {
    schema: normalizeListView(row.published as ListViewSchema, def.fields, custom),
    version: row.publishedVersion,
    isDefault: false,
    publishedAt: row.publishedAt,
    publishedBy: await publisherOf("LIST_VIEW", objectKey, viewKey, row),
  };
}

export async function getListViewDraft(objectKey: string, viewKey: string): Promise<ListViewSchema> {
  const def = await requireObject(objectKey, "lists");
  requireViewKey(def, viewKey);
  const custom = def.capabilities.customFields ? await loadCustomDefs(objectKey, true) : [];
  const row = await loadConfigRow("LIST_VIEW", objectKey, viewKey);
  const base = (row?.draft ?? row?.published ?? defaultListView(def, viewKey, custom)) as ListViewSchema;
  return normalizeListView(base, def.fields, custom, { appendMissing: true });
}

export type ListSaveResult = { ok: true; schema: ListViewSchema } | MetaFailure;
export type ListPublishResult = { ok: true; schema: ListViewSchema; version: number } | MetaFailure;

export async function saveListViewDraft(objectKey: string, viewKey: string, schemaInput: unknown, actor: MetadataActor): Promise<ListSaveResult> {
  const obj = await checkObject(objectKey, "lists");
  if (!obj.ok) return obj;
  if (!obj.def.lists.some((l) => l.key === viewKey)) return fail("NOT_FOUND", `${obj.def.label} không có danh sách "${viewKey}".`, "viewKey");
  const parsed = listViewSchemaZ.safeParse(schemaInput);
  if (!parsed.success) return fail("INVALID", zodFieldErrors(parsed.error));
  const custom = obj.def.capabilities.customFields ? await loadCustomDefs(objectKey, true) : [];
  const input = parsed.data as ListViewSchema;
  const problems = listRefProblems(input, obj.def.fields, custom);
  if (problems.length > 0) return fail("INVALID", problems);
  const schema = normalizeListView(input, obj.def.fields, custom);
  const before = await loadConfigRow("LIST_VIEW", objectKey, viewKey);
  if (JSON.stringify(before?.draft ?? null) === JSON.stringify(schema)) return { ok: true, schema };
  await upsertDraft("LIST_VIEW", objectKey, viewKey, schema, actor.id);
  await audit({ ...auditActor(actor), action: "META_LIST_DRAFT_SAVE", entity: "META_LIST_VIEW", entityId: `${objectKey}.${viewKey}`, before: before?.draft ?? null, after: schema });
  return { ok: true, schema };
}

export async function publishListView(objectKey: string, viewKey: string, actor: MetadataActor): Promise<ListPublishResult> {
  const obj = await checkObject(objectKey, "lists");
  if (!obj.ok) return obj;
  if (!obj.def.lists.some((l) => l.key === viewKey)) return fail("NOT_FOUND", `${obj.def.label} không có danh sách "${viewKey}".`, "viewKey");
  let row = await loadConfigRow("LIST_VIEW", objectKey, viewKey);
  /*
    CHƯA AI LƯU NHÁP ⇒ XUẤT BẢN ĐÚNG THỨ TRÌNH SOẠN ĐANG HIỆN.

    Trình soạn mở một cấu hình chưa từng lưu bằng `getListViewDraft()` (bản mặc định dựng từ sổ). Nút "Lưu nháp"
    khoá khi chưa có thay đổi, còn "Xuất bản" thì mở — bản đầu trả "Chưa có bản nháp" ở đúng tình huống
    đó, nên quản trị KHÔNG có đường nào xuất bản cấu hình mặc định lần đầu (bắt được bằng bài chạy thử
    trên trình duyệt thật, 27/09/2026). Lưu đúng bản đang hiện làm nháp rồi xuất bản nó.
  */
  if (!row || row.draft === null || row.draft === undefined) {
    await upsertDraft("LIST_VIEW", objectKey, viewKey, await getListViewDraft(objectKey, viewKey), actor.id);
    row = await loadConfigRow("LIST_VIEW", objectKey, viewKey);
    if (!row || row.draft === null || row.draft === undefined) return fail("INVALID", "Chưa có bản nháp để xuất bản.", "draft");
  }
  const custom = obj.def.capabilities.customFields ? await loadCustomDefs(objectKey, true) : [];
  const schema = normalizeListView(row.draft as ListViewSchema, obj.def.fields, custom);
  const refs = new Set(
    [...schema.columns.map((c) => c.ref), ...schema.defaultFilters.map((f) => f.ref), ...(schema.defaultSort ? [schema.defaultSort.ref] : [])]
      .map((r) => parseRef(r))
      .filter((p) => p?.kind === "custom")
      .map((p) => p!.key),
  );
  const snapshot = { schema, fields: custom.filter((c) => refs.has(c.key)) };
  const version = await publishConfig("LIST_VIEW", objectKey, viewKey, schema, row.publishedVersion, snapshot, actor);
  if (version === null) return fail("CONFLICT", "Danh sách vừa được người khác xuất bản — tải lại rồi thử lại.");
  await audit({
    ...auditActor(actor),
    action: "META_LIST_PUBLISH",
    entity: "META_LIST_VIEW",
    entityId: `${objectKey}.${viewKey}`,
    before: { version: row.publishedVersion, schema: row.published ?? null },
    after: { version, schema },
  });
  return { ok: true, schema, version };
}

/**
 * ═══════════ FORM METADATA: NHÁP / ĐÃ XUẤT BẢN (M7, M12) — CHỈ MÁY CHỦ ═══════════
 *
 * Người dùng chỉ thấy bản ĐÃ XUẤT BẢN; chưa xuất bản bao giờ ⇒ form MẶC ĐỊNH dựng từ sổ + định nghĩa field
 * (tổ chức nhà không đổi gì). Mọi lần đọc đều chuẩn hoá theo định nghĩa field HIỆN TẠI
 * (`normalizeFormSchema`) — field bị lưu trữ sau khi xuất bản biến khỏi form ngay, không cần xuất bản lại.
 */
import { audit } from "@/lib/audit";
import { auditActor, checkObject, loadCustomDefs, requireObject } from "@/lib/metadata/common";
import { loadConfigRow, publishConfig, publisherOf, upsertDraft } from "@/lib/metadata/config-store";
import { fail, MetadataError, type MetaFailure } from "@/lib/metadata/errors";
import { zodFieldErrors } from "@/lib/metadata/fields";
import { defaultFormSchema, formRefProblems, formSchemaZ, normalizeFormSchema, parseRef } from "@/lib/metadata/form-schema";
import type { ObjectDef } from "@/lib/constants/object-registry";
import type { FormSchema, MetadataActor } from "@/lib/metadata/types";

function requireFormKey(def: ObjectDef, formKey: string): void {
  if (!def.forms.some((f) => f.key === formKey)) throw new MetadataError("NOT_FOUND", `${def.label} không có form "${formKey}".`);
}

export type PublishedForm = { schema: FormSchema; version: number; isDefault: boolean; publishedAt: Date | null; publishedBy: string | null };

/** Bản người dùng thấy. `publishedBy` = email người xuất bản phiên bản đang chạy (để in "phiên bản N · lúc · bởi ai"). */
export async function getPublishedForm(objectKey: string, formKey: string): Promise<PublishedForm> {
  const def = await requireObject(objectKey, "forms");
  requireFormKey(def, formKey);
  const custom = def.capabilities.customFields ? await loadCustomDefs(objectKey, true) : [];
  const row = await loadConfigRow("FORM", objectKey, formKey);
  if (!row || row.published === null || row.published === undefined) {
    return { schema: normalizeFormSchema(defaultFormSchema(objectKey, formKey, custom), def.fields, custom), version: 0, isDefault: true, publishedAt: null, publishedBy: null };
  }
  return {
    schema: normalizeFormSchema(row.published as FormSchema, def.fields, custom),
    version: row.publishedVersion,
    isDefault: false,
    publishedAt: row.publishedAt,
    publishedBy: await publisherOf("FORM", objectKey, formKey, row),
  };
}

/** Bản nháp cho trình soạn: nháp đã lưu → bản đã xuất bản → mặc định; field chưa có được nối vào cuối ở trạng thái ẨN. */
export async function getFormDraft(objectKey: string, formKey: string): Promise<FormSchema> {
  const def = await requireObject(objectKey, "forms");
  requireFormKey(def, formKey);
  const custom = def.capabilities.customFields ? await loadCustomDefs(objectKey, true) : [];
  const row = await loadConfigRow("FORM", objectKey, formKey);
  const base = (row?.draft ?? row?.published ?? defaultFormSchema(objectKey, formKey, custom)) as FormSchema;
  return normalizeFormSchema(base, def.fields, custom, { appendMissing: true });
}

export type FormSaveResult = { ok: true; schema: FormSchema } | MetaFailure;
export type FormPublishResult = { ok: true; schema: FormSchema; version: number } | MetaFailure;

export async function saveFormDraft(objectKey: string, formKey: string, schemaInput: unknown, actor: MetadataActor): Promise<FormSaveResult> {
  const obj = await checkObject(objectKey, "forms");
  if (!obj.ok) return obj;
  if (!obj.def.forms.some((f) => f.key === formKey)) return fail("NOT_FOUND", `${obj.def.label} không có form "${formKey}".`, "formKey");
  const parsed = formSchemaZ.safeParse(schemaInput);
  if (!parsed.success) return fail("INVALID", zodFieldErrors(parsed.error));
  const custom = obj.def.capabilities.customFields ? await loadCustomDefs(objectKey, true) : [];
  const problems = formRefProblems(parsed.data, obj.def.fields, custom);
  if (problems.length > 0) return fail("INVALID", problems);
  const schema = normalizeFormSchema(parsed.data, obj.def.fields, custom);
  const before = await loadConfigRow("FORM", objectKey, formKey);
  if (JSON.stringify(before?.draft ?? null) === JSON.stringify(schema)) return { ok: true, schema };
  await upsertDraft("FORM", objectKey, formKey, schema, actor.id);
  await audit({ ...auditActor(actor), action: "META_FORM_DRAFT_SAVE", entity: "META_FORM", entityId: `${objectKey}.${formKey}`, before: before?.draft ?? null, after: schema });
  return { ok: true, schema };
}

export async function publishForm(objectKey: string, formKey: string, actor: MetadataActor): Promise<FormPublishResult> {
  const obj = await checkObject(objectKey, "forms");
  if (!obj.ok) return obj;
  if (!obj.def.forms.some((f) => f.key === formKey)) return fail("NOT_FOUND", `${obj.def.label} không có form "${formKey}".`, "formKey");
  let row = await loadConfigRow("FORM", objectKey, formKey);
  /*
    CHƯA AI LƯU NHÁP ⇒ XUẤT BẢN ĐÚNG THỨ TRÌNH SOẠN ĐANG HIỆN.

    Trình soạn mở một cấu hình chưa từng lưu bằng `getFormDraft()` (bản mặc định dựng từ sổ). Nút "Lưu nháp"
    khoá khi chưa có thay đổi, còn "Xuất bản" thì mở — bản đầu trả "Chưa có bản nháp" ở đúng tình huống
    đó, nên quản trị KHÔNG có đường nào xuất bản cấu hình mặc định lần đầu (bắt được bằng bài chạy thử
    trên trình duyệt thật, 27/09/2026). Lưu đúng bản đang hiện làm nháp rồi xuất bản nó.
  */
  if (!row || row.draft === null || row.draft === undefined) {
    await upsertDraft("FORM", objectKey, formKey, await getFormDraft(objectKey, formKey), actor.id);
    row = await loadConfigRow("FORM", objectKey, formKey);
    if (!row || row.draft === null || row.draft === undefined) return fail("INVALID", "Chưa có bản nháp để xuất bản.", "draft");
  }
  const custom = obj.def.capabilities.customFields ? await loadCustomDefs(objectKey, true) : [];
  const schema = normalizeFormSchema(row.draft as FormSchema, obj.def.fields, custom);
  // Ảnh chụp mang cả định nghĩa của các field custom được form trỏ tới — nhãn / kiểu LÚC xuất bản.
  const refs = new Set(schema.sections.flatMap((s) => s.fields.map((f) => parseRef(f.ref))).filter((p) => p?.kind === "custom").map((p) => p!.key));
  const snapshot = { schema, fields: custom.filter((c) => refs.has(c.key)) };
  const version = await publishConfig("FORM", objectKey, formKey, schema, row.publishedVersion, snapshot, actor);
  if (version === null) return fail("CONFLICT", "Form vừa được người khác xuất bản — tải lại rồi thử lại.");
  await audit({
    ...auditActor(actor),
    action: "META_FORM_PUBLISH",
    entity: "META_FORM",
    entityId: `${objectKey}.${formKey}`,
    before: { version: row.publishedVersion, schema: row.published ?? null },
    after: { version, schema },
  });
  return { ok: true, schema, version };
}

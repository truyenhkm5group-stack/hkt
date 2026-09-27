import { can, type SessionUser } from "@/lib/auth/session";
import { objectDef, type ObjectDef } from "@/lib/constants/object-registry";
import { formatDateTime } from "@/lib/format";
import { MetadataError, type MetaFailure } from "@/lib/metadata/errors";
import { archiveCustomField, createCustomField, listFields, updateCustomField, type CustomFieldInput as ServiceFieldInput, type CustomFieldPatch as ServiceFieldPatch } from "@/lib/metadata/fields";
import { getFormDraft, getPublishedForm, publishForm, saveFormDraft } from "@/lib/metadata/forms";
import { getListViewDraft, getPublishedListView, publishListView, saveListViewDraft } from "@/lib/metadata/lists";
import { getStatusOverrides, saveStatusOverrides } from "@/lib/metadata/statuses";
import type { CustomFieldDef, FieldError, FormSchema, ListViewSchema, MetadataActor, SystemFieldDef } from "@/lib/metadata/types";
import {
  adminObjects,
  buildCatalog,
  moveItem,
  type AdminCapability,
  type AdminObjectOption,
  type AdminWriteResult,
  type CatalogField,
  type CustomFieldInput,
  type CustomFieldPatch,
  type PublishInfo,
  type StatusOverrideRow,
} from "@/lib/platform-ui/metadata-admin-shared";

/**
 * ═══════════ LÕI CỦA MÀN HÌNH QUẢN TRỊ METADATA ═══════════
 *
 * Bốn trang `/settings/{data-model,forms,lists,statuses}` đọc qua các hàm `load*` ở đây, và MỘT lớp server
 * action (`lib/actions/metadata-admin.ts`) gọi các hàm `admin*` ở đây. Tệp THƯỜNG (không "use server") để bộ
 * kiểm thử chạy ngoài Next gọi được với một `SessionUser` dựng tay — cùng mẫu với `module-toggle.ts`.
 *
 * Mỗi lượt: kiểm quyền LẦN HAI (`metadata:manage` — lần một là `requirePermission` của trang/action),
 * phiên phải mang tổ chức, đối tượng phải nằm trong sổ + `customizable` + có năng lực + module đang bật
 * ⇒ rồi mới gọi dịch vụ `lib/metadata/*` (M14: giao diện không đọc bảng `meta_*` trực tiếp). Dịch vụ tự kiểm
 * lại đối tượng/module theo CSDL của tổ chức hiện hành; câu lỗi của nó đi NGUYÊN VĂN về màn hình.
 *
 * Tổ chức luôn là tổ chức CỦA NGƯỜI XEM (`getDb()` chọn theo ngữ cảnh phiên): không tham số nào ở đây nhận
 * mã tổ chức.
 */

export type AdminDenied = { ok: false; errors: FieldError[] };

function denied(message: string): AdminDenied {
  return { ok: false, errors: [{ field: "_", message }] };
}

/** Kết quả dịch vụ ⇒ kết quả màn hình: bỏ phần dữ liệu trả về (trang dựng lại từ `revalidatePath`), giữ nguyên lỗi. */
function toResult(r: { ok: true } | MetaFailure): AdminWriteResult {
  return r.ok ? { ok: true } : { ok: false, errors: r.errors };
}

/** Lượt ĐỌC của dịch vụ ném `MetadataError` (đối tượng lạ, module tắt) — đổi thành lời từ chối đọc được. */
async function reading<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | AdminDenied> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (error instanceof MetadataError) return denied(error.message);
    throw error;
  }
}

/** Vì sao người này KHÔNG cấu hình được metadata (`null` = được). Hỏng về phía hẹp. */
export function metadataAdminDenial(user: SessionUser): string | null {
  if (!can(user, "metadata:manage")) return "Bạn không có quyền cấu hình dữ liệu (field, form, danh sách, trạng thái).";
  if (!user.organization) return "Phiên chưa gắn tổ chức — đăng nhập lại.";
  return null;
}

export type ResolvedObject = { object: AdminObjectOption; def: ObjectDef };

/** Đối tượng có cấu hình được ở màn hình này với người này không — cùng một luật với ô chọn đối tượng. */
export function resolveAdminObject(user: SessionUser, objectKey: unknown, capability: AdminCapability): { ok: true; value: ResolvedObject } | AdminDenied {
  const denial = metadataAdminDenial(user);
  if (denial) return denied(denial);
  const key = typeof objectKey === "string" ? objectKey : "";
  const def = objectDef(key);
  if (!def) return denied(`Không có đối tượng «${key}» trong sổ.`);
  const object = adminObjects(user, capability).find((o) => o.key === def.key);
  if (!object) {
    if (!def.customizable || !def.capabilities[capability]) return denied(`«${def.label}» không cấu hình được ở màn hình này.`);
    return denied(`Module của «${def.label}» đang tắt với tổ chức — bật module trước khi cấu hình.`);
  }
  return { ok: true, value: { object, def } };
}

export function actorOf(user: SessionUser): MetadataActor {
  return { id: user.id, email: user.email, permissions: user.permissions, isAdmin: user.role === "ADMIN" };
}

/**
 * Kiểm LÚC BIÊN DỊCH: đầu vào mà form giao diện gửi đi là đầu vào hợp lệ về HÌNH của dịch vụ M1 (tên thuộc
 * tính khớp — lược đồ của dịch vụ là `.strict()`, thuộc tính lạ bị từ chối). Thừa một thuộc tính, hay lệch kiểu một
 * thuộc tính, là lỗi `tsc` chứ không phải một lượt lưu bị từ chối trên màn hình.
 */
type ExtraKeys<A, B> = Exclude<keyof A, keyof B>;
export const FIELD_INPUT_MATCHES_SERVICE: [ExtraKeys<CustomFieldInput, ServiceFieldInput> | ExtraKeys<CustomFieldPatch, ServiceFieldPatch>] extends [never]
  ? [CustomFieldInput] extends [ServiceFieldInput]
    ? [CustomFieldPatch] extends [ServiceFieldPatch]
      ? true
      : false
    : false
  : false = true;

// ═══════════ ĐỌC ═══════════

export type DataModelView = { object: AdminObjectOption; system: SystemFieldDef[]; custom: CustomFieldDef[] };
export type FormEditorView = {
  object: AdminObjectOption;
  form: ObjectDef["forms"][number];
  catalog: CatalogField[];
  draft: FormSchema;
  published: PublishInfo & { schema: FormSchema };
};
export type ListEditorView = {
  object: AdminObjectOption;
  list: ObjectDef["lists"][number];
  catalog: CatalogField[];
  draft: ListViewSchema;
  published: PublishInfo & { schema: ListViewSchema };
};
export type StatusEditorView = { object: AdminObjectOption; fieldKey: string; fieldLabel: string; rows: StatusOverrideRow[] };

type Loaded<T> = { ok: true; value: T } | AdminDenied;

function publishInfo(p: { version: number; isDefault: boolean; publishedAt: Date | null; publishedBy: string | null }): PublishInfo {
  return { version: p.version, isDefault: p.isDefault, publishedAt: p.publishedAt ? formatDateTime(p.publishedAt) : null, publishedBy: p.publishedBy };
}

export async function loadDataModel(user: SessionUser, objectKey: unknown): Promise<Loaded<DataModelView>> {
  const r = resolveAdminObject(user, objectKey, "customFields");
  if (!r.ok) return r;
  const fields = await reading(() => listFields(r.value.def.key, { includeArchived: true }));
  if (!fields.ok) return fields;
  return { ok: true, value: { object: r.value.object, system: fields.value.system, custom: [...fields.value.custom].sort((a, b) => a.position - b.position || a.key.localeCompare(b.key)) } };
}

export async function loadFormEditor(user: SessionUser, objectKey: unknown, formKey: unknown): Promise<Loaded<FormEditorView>> {
  const r = resolveAdminObject(user, objectKey, "forms");
  if (!r.ok) return r;
  const form = r.value.object.forms.find((f) => f.key === formKey) ?? null;
  if (!form) return denied(`«${r.value.def.label}» không có form «${String(formKey)}».`);
  const key = r.value.def.key;
  const loaded = await reading(async () => {
    const [fields, draft, published] = await Promise.all([listFields(key), getFormDraft(key, form.key), getPublishedForm(key, form.key)]);
    return { fields, draft, published };
  });
  if (!loaded.ok) return loaded;
  const { fields, draft, published } = loaded.value;
  return { ok: true, value: { object: r.value.object, form, catalog: buildCatalog(fields.system, fields.custom), draft, published: { schema: published.schema, ...publishInfo(published) } } };
}

export async function loadListEditor(user: SessionUser, objectKey: unknown, viewKey: unknown): Promise<Loaded<ListEditorView>> {
  const r = resolveAdminObject(user, objectKey, "lists");
  if (!r.ok) return r;
  const list = r.value.object.lists.find((l) => l.key === viewKey) ?? null;
  if (!list) return denied(`«${r.value.def.label}» không có danh sách «${String(viewKey)}».`);
  const key = r.value.def.key;
  const loaded = await reading(async () => {
    const [fields, draft, published] = await Promise.all([listFields(key), getListViewDraft(key, list.key), getPublishedListView(key, list.key)]);
    return { fields, draft, published };
  });
  if (!loaded.ok) return loaded;
  const { fields, draft, published } = loaded.value;
  return { ok: true, value: { object: r.value.object, list, catalog: buildCatalog(fields.system, fields.custom), draft, published: { schema: published.schema, ...publishInfo(published) } } };
}

export async function loadStatusEditor(user: SessionUser, objectKey: unknown, fieldKey: unknown): Promise<Loaded<StatusEditorView>> {
  const r = resolveAdminObject(user, objectKey, "statuses");
  if (!r.ok) return r;
  const key = typeof fieldKey === "string" && r.value.object.statusFields.includes(fieldKey) ? fieldKey : null;
  const field = key ? r.value.def.fields.find((f) => f.key === key) : null;
  if (!key || !field) return denied(`«${r.value.def.label}» không có trạng thái hệ thống «${String(fieldKey)}».`);
  const overrides = await reading(() => getStatusOverrides(r.value.def.key, key));
  if (!overrides.ok) return overrides;
  // Giá trị GỐC của sổ là khung; ghi đè của tổ chức chỉ phủ nhãn / thứ tự / bật-tắt lên trên (M10).
  const byValue = new Map(overrides.value.map((o) => [o.value, o]));
  const options = field.options ?? [];
  const rows: StatusOverrideRow[] = options.map((o) => {
    const ov = byValue.get(o.value);
    return { value: o.value, systemLabel: o.label, label: ov?.label ?? null, position: ov?.position ?? o.position, active: ov ? ov.active : o.active };
  });
  const order = (v: string) => options.findIndex((o) => o.value === v);
  rows.sort((a, b) => a.position - b.position || order(a.value) - order(b.value));
  return { ok: true, value: { object: r.value.object, fieldKey: key, fieldLabel: field.label, rows } };
}

// ═══════════ GHI ═══════════

export async function adminCreateField(user: SessionUser, objectKey: unknown, input: unknown): Promise<AdminWriteResult> {
  const r = resolveAdminObject(user, objectKey, "customFields");
  if (!r.ok) return r;
  return toResult(await createCustomField(r.value.def.key, input, actorOf(user)));
}

export async function adminUpdateField(user: SessionUser, objectKey: unknown, fieldKey: unknown, patch: unknown): Promise<AdminWriteResult> {
  const r = resolveAdminObject(user, objectKey, "customFields");
  if (!r.ok) return r;
  if (typeof fieldKey !== "string" || !fieldKey) return denied("Thiếu khoá field.");
  return toResult(await updateCustomField(r.value.def.key, fieldKey, patch, actorOf(user)));
}

export async function adminArchiveField(user: SessionUser, objectKey: unknown, fieldKey: unknown): Promise<AdminWriteResult> {
  const r = resolveAdminObject(user, objectKey, "customFields");
  if (!r.ok) return r;
  if (typeof fieldKey !== "string" || !fieldKey) return denied("Thiếu khoá field.");
  return toResult(await archiveCustomField(r.value.def.key, fieldKey, actorOf(user)));
}

/**
 * Đổi vị trí một field custom với láng giềng (nút lên/xuống). Vị trí lưu là số nguyên tuỳ ý, có thể trùng
 * (field tạo cùng lúc) — nên đánh lại 0..n−1 theo thứ tự MỚI và chỉ ghi field có vị trí đổi thật.
 */
export async function adminMoveField(user: SessionUser, objectKey: unknown, fieldKey: unknown, delta: unknown): Promise<AdminWriteResult> {
  const r = resolveAdminObject(user, objectKey, "customFields");
  if (!r.ok) return r;
  if (delta !== 1 && delta !== -1) return denied("Hướng di chuyển không hợp lệ.");
  const fields = await reading(() => listFields(r.value.def.key));
  if (!fields.ok) return fields;
  const active = fields.value.custom.filter((f) => f.status === "ACTIVE").sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));
  const index = active.findIndex((f) => f.key === fieldKey);
  if (index < 0) return denied(`Field «${String(fieldKey)}» không còn đang dùng.`);
  const next = moveItem(active, index, delta);
  for (const [i, f] of next.entries()) {
    if (f.position === i) continue;
    const res = await updateCustomField(r.value.def.key, f.key, { position: i }, actorOf(user));
    if (!res.ok) return toResult(res);
  }
  return { ok: true };
}

export async function adminSaveFormDraft(user: SessionUser, objectKey: unknown, formKey: unknown, schema: unknown): Promise<AdminWriteResult> {
  const r = resolveAdminObject(user, objectKey, "forms");
  if (!r.ok) return r;
  const form = r.value.object.forms.find((f) => f.key === formKey);
  if (!form) return denied(`Không có form «${String(formKey)}».`);
  return toResult(await saveFormDraft(r.value.def.key, form.key, schema, actorOf(user)));
}

export async function adminPublishForm(user: SessionUser, objectKey: unknown, formKey: unknown): Promise<AdminWriteResult> {
  const r = resolveAdminObject(user, objectKey, "forms");
  if (!r.ok) return r;
  const form = r.value.object.forms.find((f) => f.key === formKey);
  if (!form) return denied(`Không có form «${String(formKey)}».`);
  return toResult(await publishForm(r.value.def.key, form.key, actorOf(user)));
}

export async function adminSaveListDraft(user: SessionUser, objectKey: unknown, viewKey: unknown, schema: unknown): Promise<AdminWriteResult> {
  const r = resolveAdminObject(user, objectKey, "lists");
  if (!r.ok) return r;
  const list = r.value.object.lists.find((l) => l.key === viewKey);
  if (!list) return denied(`Không có danh sách «${String(viewKey)}».`);
  return toResult(await saveListViewDraft(r.value.def.key, list.key, schema, actorOf(user)));
}

export async function adminPublishList(user: SessionUser, objectKey: unknown, viewKey: unknown): Promise<AdminWriteResult> {
  const r = resolveAdminObject(user, objectKey, "lists");
  if (!r.ok) return r;
  const list = r.value.object.lists.find((l) => l.key === viewKey);
  if (!list) return denied(`Không có danh sách «${String(viewKey)}».`);
  return toResult(await publishListView(r.value.def.key, list.key, actorOf(user)));
}

export async function adminSaveStatusOverrides(user: SessionUser, objectKey: unknown, fieldKey: unknown, rows: unknown): Promise<AdminWriteResult> {
  const r = resolveAdminObject(user, objectKey, "statuses");
  if (!r.ok) return r;
  if (typeof fieldKey !== "string" || !r.value.object.statusFields.includes(fieldKey)) return denied(`Không có trạng thái hệ thống «${String(fieldKey)}».`);
  return toResult(await saveStatusOverrides(r.value.def.key, fieldKey, rows, actorOf(user)));
}

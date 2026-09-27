# Phase 2 — Metadata & tuỳ biến theo tổ chức: hợp đồng chung

> Đọc sau `target-architecture.md` và `shared-contracts.md`. Agent KHÔNG tự tạo phiên bản riêng của
> bất kỳ thứ gì ở đây. Audit 27/09/2026: kho CHƯA có hệ custom field / form / trạng thái cấu hình được
> nào (`product_variants.attributes` là thuộc tính biến thể Pancake; nhãn trạng thái ghi cứng trong
> `lib/constants/*`). Tái dùng: `settings` (cấu hình JSON), `audit()` (nhật ký), `DataTable`, RBAC.

## 1. Mười bốn quyết định

**M1 — Metadata nằm trong CSDL CỦA TỔ CHỨC.** Định nghĩa field, form, danh sách, cấu hình trạng thái
và giá trị custom đều là dữ liệu của tổ chức ⇒ silo cô lập chúng miễn phí: tổ chức B không có cách nào
đọc metadata của A, kể cả khi biết id. Mặt phẳng điều khiển không chứa metadata.

**M2 — Sổ đối tượng + field hệ thống là MÃ NGUỒN** (`lib/constants/object-registry.ts`, thuần,
client-safe). Mỗi đối tượng: `key`, nhãn, `module`, bảng + cột id, field hệ thống (trỏ cột THẬT),
năng lực (`customFields`, `forms`, `lists`, `statuses`, `create`), `customizable`. Không thay mô hình
miền nào — sổ chỉ là lớp mô tả phía trên. Đối tượng do tổ chức tự tạo: CHƯA (Phase 3+).

**M3 — Lưu giá trị custom: MỘT DÒNG MỞ RỘNG cho mỗi bản ghi** — bảng `custom_values(object_key,
record_id, values jsonb, …)`, khoá chính `(object_key, record_id)`.

| Phương án | Vì sao KHÔNG |
| --- | --- |
| Cột vật lý cho mỗi field | Cấm: mỗi field của khách là một migration |
| Cột `custom jsonb` trên từng bảng nghiệp vụ | ALTER hơn 10 bảng lớn; đồng bộ Pancake upsert cả dòng `customers`/`products` ⇒ nguy cơ ghi đè giá trị người nhập |
| EAV một dòng mỗi giá trị | N dòng mỗi bản ghi, đọc danh sách = pivot, cập nhật không nguyên tử |
| **Một dòng jsonb mỗi bản ghi (chọn)** | Một lượt nối cho cả danh sách; cập nhật nguyên tử; lọc bằng `values->>'k'` + chỉ mục GIN; đồng bộ từ đối tác KHÔNG BAO GIỜ chạm bảng này |

Tệp (`file`): bytea trong `custom_files` (cùng lối các tệp đính kèm hiện có), trần 5 MB; giá trị lưu id.

**M4 — Khoá field BẤT BIẾN**, dạng `^[a-z][a-z0-9_]{1,40}$`, duy nhất theo (tổ chức, đối tượng), không
trùng khoá field hệ thống. Nhãn đổi thoải mái; khoá không. Không xoá — `ARCHIVED` (giá trị giữ nguyên,
không hiện, không nhận ghi).

**M5 — Kiểu field:** `text` · `textarea` · `number` · `currency` (VND nguyên) · `boolean` · `date` ·
`datetime` · `select` · `multi_select` · `status` (select + chuyển trạng thái) · `user` (id tài khoản
CÙNG tổ chức) · `relation` (id bản ghi của một đối tượng trong sổ, CÙNG CSDL) · `file` · `email` ·
`phone` · `url`.

**M6 — Kiểm hợp lệ CHẠY Ở MÁY CHỦ** (`validateCustomValues`, hàm thuần): bắt buộc · min/max (số) ·
minLength/maxLength · regex (≤ 200 ký tự, giá trị ≤ 2.000 ký tự — chặn ReDoS) · tuỳ chọn hợp lệ ·
chuyển trạng thái hợp lệ · `user`/`relation` tồn tại trong CSDL tổ chức. Trình duyệt chỉ kiểm để UX.

**M7 — Form = metadata có Nháp / Đã xuất bản.** `meta_forms(object_key, form_key, draft, published,
published_version, …)`. Người dùng CHỈ thấy bản đã xuất bản; chưa xuất bản bao giờ ⇒ form MẶC ĐỊNH
dựng từ sổ (tổ chức nhà không đổi gì). Mỗi lần xuất bản chép ảnh vào `meta_config_versions`.

**M8 — Form runtime là MỘT renderer** (`components/metadata/dynamic-form.tsx`) đọc schema đã xuất bản
+ định nghĩa field ⇒ vẽ bằng component UI hiện có. Không sinh mã, không sinh tệp React cho tổ chức.

**M9 — Danh sách = metadata cùng mô hình Nháp/Xuất bản** (`meta_list_views`): cột (field hệ thống
khai `listable` + field custom), thứ tự, ẩn/hiện, sắp xếp mặc định, bộ lọc mặc định. Chưa cấu hình ⇒
cột của mã nguồn y như cũ.

**M10 — Trạng thái: HAI loại, không trộn.**
- *Trạng thái HỆ THỐNG* (vd `orders.stage`, `shipments.stage`): Core sở hữu. Tổ chức CHỈ đổi được
  nhãn hiển thị, thứ tự, ẩn khỏi bộ lọc (`meta_status_overrides`). KHÔNG thêm giá trị, KHÔNG đổi
  chuyển trạng thái, KHÔNG động tới logistics/COD/ORDER_OUTCOME.
- *Trạng thái NGHIỆP VỤ* = field custom kiểu `status`: tổ chức khai giá trị, thứ tự, bật/tắt, và
  chuyển trạng thái được phép — máy chủ ép khi ghi.

**M11 — Quyền:** khoá mới `metadata:manage` (cấu hình field/form/danh sách/trạng thái; ADMIN mặc định;
loại khỏi mẫu MANAGER; vai trò tuỳ chỉnh không cấp được). Field có thể khai `viewPermission` /
`editPermission` (khoá quyền SẴN CÓ) — máy chủ lọc khi đọc, chặn khi ghi. Không làm bảo mật theo
dòng mới.

**M12 — Nhật ký & phiên bản:** mọi lượt đổi cấu hình ⇒ `audit()` trong CSDL tổ chức (ai, trước, sau,
lúc); mọi lượt xuất bản ⇒ một dòng `meta_config_versions` (ảnh chụp bất biến). Ghi giá trị custom ⇒
`audit()` kèm trước/sau của đúng các field đổi.

**M13 — Đệm:** KHÔNG đệm metadata trong tiến trình. Đọc metadata là 1–3 câu nhỏ mỗi trang; `cache()`
của React khử trùng lặp trong một lần dựng. Hệ quả: xuất bản có hiệu lực ở lần tải kế tiếp, mọi tiến
trình, không cần xoá đệm — "đổi cấu hình không deploy" là tính chất, không phải cơ chế.

**M14 — Một cửa dịch vụ:** `lib/metadata/*` (máy chủ) + server actions: `lib/actions/metadata-admin.ts` (cấu hình, qua lõi `lib/platform-ui/metadata-admin.ts`) và `lib/actions/metadata.ts` (ghi giá trị custom). Giao
diện KHÔNG đọc bảng `meta_*` / `custom_values` trực tiếp. Module của đối tượng tắt ⇒ metadata của đối
tượng đó không đọc/ghi được (`MODULE_DISABLED`).

## 2. Lược đồ (migration `0154_metadata_foundation`, CHỈ THÊM, trong CSDL tổ chức)

```sql
meta_custom_fields (id text pk, object_key text, field_key text, label text, field_type text,
  required boolean default false, default_value jsonb, options jsonb,     -- select/status: [{value,label,color?,active,position}]
  validation jsonb,                                                       -- {min,max,minLength,maxLength,pattern,patternMessage}
  transitions jsonb,                                                      -- status: {"<from>":["<to>",…]}
  relation_object text, help_text text, view_permission text, edit_permission text,
  listable boolean default true, filterable boolean default false, position int default 0,
  status text default 'ACTIVE' check in ('ACTIVE','ARCHIVED'),
  created_by text, created_at, updated_at, unique(object_key, field_key))
custom_values (object_key text, record_id text, values jsonb default '{}', version int default 1,
  updated_by text, updated_at, primary key(object_key, record_id))  + GIN(values jsonb_path_ops)
custom_files (id text pk, object_key, record_id, field_key, filename, mime, size int, data bytea, created_by, created_at)
meta_forms (object_key, form_key, draft jsonb, published jsonb, published_version int default 0,
  published_at, published_by, updated_by, updated_at, primary key(object_key, form_key))
meta_list_views (object_key, view_key, draft jsonb, published jsonb, published_version int default 0,
  published_at, published_by, updated_by, updated_at, primary key(object_key, view_key))
meta_status_overrides (object_key, field_key, value, label, position int, active boolean default true,
  updated_by, updated_at, primary key(object_key, field_key, value))
meta_config_versions (id text pk, kind text, object_key, config_key, version int, snapshot jsonb,
  actor_id text, actor_email text, created_at)   -- append-only
```

## 3. Kiểu TypeScript (`lib/metadata/types.ts`, client-safe)

```ts
export type FieldType = "text"|"textarea"|"number"|"currency"|"boolean"|"date"|"datetime"|"select"|"multi_select"|"status"|"user"|"relation"|"file"|"email"|"phone"|"url";
export type FieldRef = `system:${string}` | `custom:${string}`;
export type FieldOption = { value: string; label: string; color?: string; active: boolean; position: number };
export type FieldValidation = { min?: number; max?: number; minLength?: number; maxLength?: number; pattern?: string; patternMessage?: string };
export type CustomFieldDef = { id: string; objectKey: string; key: string; label: string; type: FieldType; required: boolean;
  defaultValue: unknown; options: FieldOption[]; validation: FieldValidation; transitions: Record<string, string[]>;
  relationObject: string | null; helpText: string | null; viewPermission: string | null; editPermission: string | null;
  listable: boolean; filterable: boolean; position: number; status: "ACTIVE" | "ARCHIVED" };
export type SystemFieldDef = { key: string; label: string; type: FieldType; column: string; required: boolean;
  editable: boolean; listable: boolean; filterable: boolean; options?: FieldOption[] };
export type FormFieldConfig = { ref: FieldRef; visible: boolean; readOnly: boolean; required: boolean; defaultValue?: unknown };
export type FormSchema = { version: 1; sections: { key: string; label: string; fields: FormFieldConfig[] }[] };
export type ListColumnConfig = { ref: FieldRef; visible: boolean };
export type ListFilter = { ref: FieldRef; op: "eq" | "neq" | "contains" | "gte" | "lte" | "in" | "empty" | "not_empty"; value?: unknown };
export type ListViewSchema = { version: 1; columns: ListColumnConfig[]; defaultSort: { ref: FieldRef; dir: "asc" | "desc" } | null; defaultFilters: ListFilter[] };
export type CustomValues = Record<string, unknown>;          // theo khoá field custom
export type FieldError = { field: string; message: string }; // message tiếng Việt
```

Luật form: `required` chỉ được làm CHẶT hơn (field hệ thống bắt buộc không nới được); field
`editable: false` luôn read-only; field ẩn không nhận ghi.

## 4. Dịch vụ (`lib/metadata/*`, chỉ máy chủ) — chữ ký chốt

```ts
// fields.ts
listFields(objectKey, opts?: { includeArchived?: boolean }): Promise<{ system: SystemFieldDef[]; custom: CustomFieldDef[] }>;
createCustomField(objectKey, input, actor): Promise<{ ok: true; field: CustomFieldDef } | { ok: false; errors: FieldError[] }>;
updateCustomField(objectKey, key, patch, actor): Promise<…>;     // KHÔNG đổi key/type sau khi có giá trị
archiveCustomField(objectKey, key, actor): Promise<…>;
// values.ts
getCustomValues(objectKey, recordIds: string[], viewer): Promise<Map<string, CustomValues>>;   // lọc viewPermission
saveCustomValues(objectKey, recordId, input: CustomValues, viewer): Promise<{ ok: true; values } | { ok: false; errors: FieldError[] }>;
customValuesFilterSql(objectKey, filters: ListFilter[]): SQL | undefined;                     // cho truy vấn danh sách
// validate.ts (thuần, client-safe)
validateCustomValues(defs: CustomFieldDef[], input: CustomValues, previous: CustomValues | null): { values: CustomValues; errors: FieldError[] };
// forms.ts
getPublishedForm(objectKey, formKey): Promise<{ schema: FormSchema; version: number; isDefault: boolean }>;
getFormDraft(objectKey, formKey): Promise<FormSchema>;  saveFormDraft(…); publishForm(objectKey, formKey, actor);
// lists.ts — cùng hình với forms: getPublishedListView / getListViewDraft / saveListViewDraft / publishListView
// statuses.ts
getStatusOverrides(objectKey, fieldKey): Promise<…>; saveStatusOverrides(…, actor);
resolveStatusLabel(objectKey, fieldKey, value): Promise<string>;  // cho hiển thị
```

## 5. Đối tượng mẫu (Phase 2 KHÔNG chuyển toàn bộ ERP)

| Đối tượng | Làm gì ở Phase 2 |
| --- | --- |
| `customer` | Field custom + form "Hồ sơ bổ sung" trên `/customers/[id]` + danh sách `/customers` theo metadata + form TẠO khách (chỉ khi tổ chức KHÔNG bật `connector_pancake` — nhà giữ nguyên hành vi) + trạng thái nghiệp vụ custom |
| `order` | Danh sách `/orders`: cột ẩn/hiện/thứ tự + cột custom; nhãn/thứ tự của `orders.stage` (trạng thái HỆ THỐNG) |
| `product`, `shipment`, `return`, `production_order`, `employee`, `campaign` | Khai trong sổ (field hệ thống + năng lực), field custom lưu được qua dịch vụ; chưa có UI runtime |

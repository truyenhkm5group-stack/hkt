# Phase 7 — Blueprint + mẫu ngành: hợp đồng

> Quyết định gốc: X3 (blueprint là định dạng gói duy nhất) và X4 (cài đặt không đè tuỳ biến) trong `builder-roadmap.md`.
> Mẫu ngành KHÔNG chép mã. Nó là một gói metadata; bộ cài chỉ gọi các dịch vụ metadata đã có.

## 1. Định dạng (`lib/blueprints/types.ts`, thuần, client-safe, zod ở `lib/blueprints/schema.ts`)

```ts
Blueprint = {
  format: "erp-blueprint"; formatVersion: 1;
  key: string;                 // ^[a-z][a-z0-9-]{1,40}$ — mẫu: "fashion-commerce", AI: "ai-<ngẫu nhiên>"
  version: string;             // semver của GÓI (mẫu nâng version khi đổi nội dung)
  name: string; description: string; industry: string | null;
  modules: ModuleKey[];        // đủ phụ thuộc (kiểm bằng sổ module)
  roles?:     { key; label; base: Role; permissions: Permission[] }[];      // vai trò tuỳ chỉnh — KHÔNG users:manage, KHÔNG base ADMIN (luật 31)
  objects?:   { key: `x_${string}`; label; labelPlural; icon; moduleKey; titleLabel; viewPermission?; writePermission? }[];
  fields?:    { objectKey; key; label; type; options?; validation?; relation?; required?; listable?; filterable? }[];
  statuses?:  { objectKey; field; options: { value; label; color?; position; active }[] }[];   // override trạng thái HỆ THỐNG
  forms?:     { objectKey; formKey; schema: FormSchema }[];
  listViews?: { objectKey; listKey; schema: ListViewSchema }[];
  pages?:     { slug; name; moduleKey; requiredPermission?; nav; schema: PageSchema }[];
  workflows?: { key; name; trigger; conditions; actions; gate? }[];          // luôn cài ở NHÁP + CHẠY THỬ (luật 23, 25)
  settings?:  { key: SafeSettingKey; value: unknown }[];                      // danh sách khoá AN TOÀN đóng
  integrations?: { connectorKey; reason }[];                                  // CHỈ gợi ý — không bao giờ cấu hình secrets
  ai?: { businessProfile: string; glossary?: { term; meaning }[] };           // ngữ cảnh AI của tổ chức (Phase 8)
}
```

## 2. Một bộ kiểm, một bộ lập kế hoạch, một bộ cài

- `validateBlueprint(bp)` — hình dạng (zod) + tham chiếu chéo nội bộ (field trỏ đối tượng có trong gói hoặc hệ thống;
  trang/khối qua `validatePageSchema` với module của GÓI; luật qua bộ kiểm luật Phase 3; vai trò qua luật 31).
- `planBlueprint(bp, { orgState })` — CHẠY THỬ, không ghi: danh sách thao tác `{ kind, key, action }` với
  `action ∈ CREATE | UPDATE | UNCHANGED | SKIP_CUSTOMIZED | SKIP_DELETED | CONFLICT | BLOCKED(lý do)`.
- `applyBlueprint(plan, actor, { resolutions })` — ghi THEO THỨ TỰ phụ thuộc (module → vai trò → đối tượng → field →
  trạng thái → form → danh sách → trang → luật → cài đặt) qua dịch vụ sẵn có: `setOrgModules`, `createObject`,
  `createCustomField`, `saveFormDraft/publishForm`, `saveListViewDraft/publish`, `createPage/savePageDraft/publishPage`,
  `createWorkflowRule` (NHÁP)… Mỗi bước audit. Hỏng giữa chừng ⇒ dừng, báo bước hỏng; chạy lại là idempotent (bước đã
  xong thành UNCHANGED).
- KHÔNG có đường ghi thẳng bảng nào trong `lib/blueprints/*` (bài kiểm quét mã).

## 3. Nâng phiên bản không đè tuỳ biến (X4)

Bảng CSDL tổ chức (migration CHỈ THÊM):
`blueprint_installs (id, blueprint_key, version, installed_at, installed_by, plan jsonb)` và
`blueprint_items (install_id, kind, key, template_hash, applied_hash)`.

- `template_hash` = băm của mục trong GÓI; `applied_hash` = băm của thực thể ngay sau khi cài.
- Lần cài sau: băm thực thể HIỆN TẠI. Bằng `applied_hash` (tổ chức chưa sửa) ⇒ `UPDATE`. Khác ⇒ `SKIP_CUSTOMIZED` mặc định,
  người chọn ghi đè từng mục (`CONFLICT` hiện diff). Thực thể không còn ⇒ `SKIP_DELETED` (không dựng lại).
- Trang/form/danh sách: cập nhật vào NHÁP; xuất bản là việc của người (trừ lần cài đầu với `publish: true` khai trong mẫu).

## 4. Năm mẫu tham chiếu (`lib/blueprints/templates/*.ts`)

| Mẫu | Module | Chứng minh |
|---|---|---|
| `fashion-commerce` | như VNX (trừ phần chỉ-VNX) | trang Tổng quan bán hàng, luật hàng hoàn → việc kiểm hàng, field size/màu |
| `general-ecommerce` | khách · sản phẩm · đơn · kho · giao vận · tài chính | trang đơn theo trạng thái, luật đơn lớn → duyệt |
| `wholesale` | CRM · đơn · mua hàng · kho · tài chính (KHÔNG marketing/sản xuất) | field hạn mức công nợ khách, trang công nợ |
| `manufacturing` | sản phẩm · sản xuất · kho · mua hàng | đối tượng `x_work_center`, kanban lệnh sản xuất |
| `service-business` | khách · ứng dụng tuỳ biến · việc · tài chính | `x_contract`, `x_project` quan hệ tới khách, luật hợp đồng > ngưỡng → duyệt → việc |

Không chép secrets, luật COD/ngưỡng hoàn hay bất cứ thứ gì chỉ đúng với VNX (xem `vnx-specific-rules.md`).

## 5. Giao diện

`/settings/templates`: danh sách mẫu (module kèm theo, số đối tượng/trang/luật) → Xem trước (= `planBlueprint`, hiện
từng thao tác) → Cài (xác nhận) → kết quả từng bước. Lịch sử cài + "Cập nhật lên phiên bản mới" (xem trước 3 chiều).

## 6. Chấp nhận

Tổ chức mới (bài kiểm + máy thử) → chọn mẫu → xem trước → cài → mở ERP dùng được (trang, đối tượng, luật NHÁP) → không
deploy. Sửa một trang của mẫu → nâng mẫu → trang đó `SKIP_CUSTOMIZED`, trang chưa sửa `UPDATE`. Cài lại ⇒ toàn `UNCHANGED`.

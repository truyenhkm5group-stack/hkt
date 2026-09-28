# Phase 6 — Đối tượng tuỳ biến (Data / App Builder): hợp đồng

> Khách tạo nghiệp vụ Core không có sẵn (Công trình, Hợp đồng bảo trì, Xe, Showroom…) ở phạm vi AN TOÀN.
> Quyết định gốc: X5 trong `builder-roadmap.md` — KHÔNG có bảng vật lý cho mỗi đối tượng.

## 1. Lưu trữ (CSDL của tổ chức, migration CHỈ THÊM)

```sql
meta_objects (key text pk  CHECK key ~ '^x_[a-z][a-z0-9_]{1,40}$',   -- tiền tố x_ ⇒ không bao giờ trùng khoá hệ thống
  label, label_plural, icon (tập ĐÓNG), module_key, title_label, description,
  view_permission text, write_permission text,                         -- khoá quyền SẴN CÓ; mặc định records:view / records:write
  status ACTIVE|ARCHIVED, origin text null, created_by, updated_by, timestamps)
custom_records (id uuid pk, object_key → meta_objects.key, title text not null, owner_id, created_by, updated_by,
  created_at, updated_at, deleted_at)                                   -- CỘT HỆ THỐNG; mọi field khác ở custom_values
```

- Giá trị field: `custom_values` (một dòng jsonb mỗi bản ghi — đúng như field tuỳ biến của Phase 2).
- Định nghĩa field: `meta_custom_fields` với `object_key = x_…`. Trạng thái nghiệp vụ = field kiểu `status` (Phase 2),
  nên trigger `custom_status` của luật (Phase 3) chạy được ngay.
- Xoá bản ghi = đặt `deleted_at` (không xoá cứng). Lưu trữ đối tượng không xoá dữ liệu.

## 2. MỘT bộ phân giải đối tượng

`resolveObject(key): Promise<ObjectDef | null>` (`lib/metadata/object-resolver.ts`) trả `ObjectDef` cho CẢ đối tượng hệ
thống (sổ tĩnh `OBJECT_REGISTRY`) LẪN đối tượng tuỳ biến (đọc `meta_objects` của tổ chức hiện hành, không đệm trong
tiến trình — M13). `ObjectDef` nới: `key: string`, `system: boolean`, `table: "custom_records"`, `idColumn: "id"`,
`titleField: "title"`, `fields` = field hệ thống của bản ghi tuỳ biến (title · owner · created_at · updated_at).
Mọi dịch vụ Phase 2 (`fields`, `values`, `forms`, `lists`, `statuses`) và Phase 3 (chủ thể luật) đi qua bộ phân giải
này thay cho `objectDef()` đồng bộ khi khoá có thể là đối tượng tuỳ biến. `objectDef()` tĩnh ở lại cho mã chỉ nói về
đối tượng hệ thống.

## 3. Quan hệ (kiểu field mới)

| Kiểu | Lưu | Nghĩa |
|---|---|---|
| `relation` | một id | nhiều-một (khai `unique: true` ⇒ một-một) |
| `relation_many` | mảng id (≤ 50) | nhiều-nhiều |

Field quan hệ khai `target: { objectKey }`: đích là đối tượng hệ thống có trong sổ (khách, sản phẩm, đơn…) HOẶC đối
tượng tuỳ biến. Một-nhiều là CHIỀU NGƯỢC: trang chi tiết của đích liệt kê bản ghi trỏ tới nó. Ghi: đích phải tồn tại,
chưa xoá, và NGƯỜI GHI xem được. Đọc: tên hiển thị của đích chỉ hiện khi người xem xem được đích (không thì "—").
Mọi thứ trong CSDL của tổ chức ⇒ không thể trỏ sang tổ chức khác.

## 4. Quyền, module, audit

- Khoá quyền MỚI (tĩnh): `records:view`, `records:write` (ADMIN có sẵn; vai trò khác chủ shop / quản trị tự cấp),
  quản trị định nghĩa đối tượng dùng `metadata:manage` sẵn có. Mỗi đối tượng có thể siết bằng một khoá quyền sẵn có
  khác (`view_permission` / `write_permission`) — chọn từ sổ quyền, không gõ tự do.
- Module MỚI `apps` ("Ứng dụng tuỳ biến", tuyến `/o`): tắt ⇒ mọi đối tượng tuỳ biến ẩn và bị từ chối ở máy chủ. Mỗi đối
  tượng còn mang `module_key` (nhóm menu); module đó tắt ⇒ đối tượng đó ẩn.
- Phạm vi dữ liệu (`users.data_scope`): `SELF`/`ASSIGNED` ⇒ chỉ bản ghi `owner_id = mình`; `TEAM`/`DEPARTMENT` ⇒ chủ
  sở hữu trong nhóm/phòng (qua `lib/auth/scope-guard`); `ALL` ⇒ tất cả.
- Mọi ghi: `audit()` (tạo/sửa/xoá bản ghi, tạo/sửa/lưu trữ đối tượng) + sự kiện miền `custom_record.created` /
  `custom_record.updated` / `custom_record.deleted` (chủ thể `custom_record`, khoá `<objectKey>:<id>`).

## 5. Giao diện tự sinh (không cần soạn gì)

- `/settings/objects`: tạo/sửa/lưu trữ đối tượng (khoá · tên · tên số nhiều · biểu tượng · nhóm menu · quyền); field,
  form, danh sách, trạng thái soạn ở các màn Phase 2 sẵn có (chúng nhận khoá `x_…` qua bộ phân giải).
- `/o/<key>`: danh sách (DataTable, list view Phase 2, lọc/sắp/phân trang ở máy chủ) · `/o/<key>/new` · `/o/<key>/<id>`:
  chi tiết = form Phase 2 + danh sách quan hệ ngược + dòng thời gian (audit + sự kiện miền).
- Menu: đối tượng ACTIVE vào nhóm menu của `module_key` qua cùng adapter menu động của Phase 4.

## 6. Luật tự động

Trigger `event:custom_record.created|updated|deleted` và `custom_status` dùng được với đối tượng tuỳ biến; điều kiện đọc
giá trị field (số, chọn, trạng thái, quan hệ = id); hành động sẵn có (tạo việc · báo · ghi giá trị · cửa duyệt).
Ví dụ chấp nhận: "Hợp đồng tạo mới → giá trị > 20 triệu → trưởng phòng duyệt → tạo việc", chạy ĐÚNG MỘT lần.

## 7. Trang (Phase 4/5)

Sau khi Phase 5 và 6 cùng vào `main`: `LIST_SOURCES` động = sổ tĩnh + đối tượng tuỳ biến ACTIVE (module `apps` +
`records:view`/quyền siết); bảng, kanban, form, KPI/biểu đồ tổng hợp, dòng thời gian dùng được với `x_…`. Việc nối này
là một bước tích hợp riêng (không agent nào của đợt 1 sửa `lib/pages/*` cho Phase 6).

## 8. Chấp nhận

Tạo đối tượng "Hợp đồng bảo trì" → field (khách = quan hệ tới khách hàng, giá trị = tiền, trạng thái) → form → danh
sách → tạo bản ghi → luật (giá trị > ngưỡng ⇒ duyệt ⇒ tạo việc, đúng một lần) → không deploy. Tổ chức khác không đọc/ghi
được bản ghi, quan hệ, tệp, định nghĩa bằng id trực tiếp.

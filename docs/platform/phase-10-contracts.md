# Phase 10 — Tự phục vụ / sản phẩm hoá: hợp đồng

> Tổ chức mới đi qua MỘT luồng ứng dụng có kiểm soát — không SQL tay, không script ops. Luồng dùng lại
> `provisionOrganization` (Phase 1) + `installBlueprint` (Phase 7). Không có đường tạo tổ chức thứ hai.

## 1. Cửa vào (X7)

- Cờ `PLATFORM_SIGNUP_MODE` ∈ `off | invite | open` (mặc định `off`; production giữ `off` cho tới khi chủ nền tảng đổi).
- `invite`: người vận hành nền tảng (`platform:operate`, màn `/platform`) tạo mã mời dùng MỘT lần, có hạn
  (`platform_signup_invites` ở control plane: băm mã, hạn, người tạo, dùng lúc, tổ chức sinh ra). Mã thô chỉ hiện một lần.
- `open`: không cần mã, nhưng có trần theo IP / giờ và theo ngày toàn nền tảng.
- Người vận hành luôn tạo được tổ chức cho khách từ `/platform` (cùng luồng, không cần cờ).

## 2. Luồng `/start` (không cần đăng nhập khi cờ cho phép)

```
Mã mời (nếu invite) → Tổ chức (tên, mã — ^[a-z][a-z0-9-]{1,30}$, kiểm trùng) → Quản trị đầu tiên (tên, email, mật khẩu ≥ 10)
→ Loại hình (thời trang · TMĐT chung · bán sỉ · sản xuất · dịch vụ · bắt đầu trắng) → Mẫu gợi ý (đổi được)
→ Module (từ mẫu; bật/tắt; phụ thuộc hiện rõ, bật cái cần thì tự bật cái nó cần) → Xem trước (= planBlueprint)
→ Tạo: provisionOrganization(modules lõi) → installBlueprint (với module đã chọn) → đăng nhập vào tổ chức mới
```

- Mỗi bước kiểm ở MÁY CHỦ; bước tạo idempotent theo mã tổ chức; hỏng giữa chừng ⇒ tổ chức ở trạng thái `SETUP_FAILED`
  hiện ở `/platform` cho người vận hành (không xoá CSDL tự động).
- Quản trị đầu tiên: tài khoản ADMIN trong CSDL CỦA tổ chức mới (như `provisionOrganization` đang làm), mật khẩu băm.
- Audit ở control plane (`platform_audit_log`) + ở tổ chức mới.

## 3. Trạng thái rỗng

Tổ chức mới không được trông như "ERP của VNX bị xoá dữ liệu":
- Trang chủ của tổ chức không-nhà: thẻ "Bắt đầu" (bước đã xong / còn lại: nhập sản phẩm, tạo khách, mời người, xem
  trang của mẫu, kết nối), không phải các thẻ KPI VNX trống.
- Mọi danh sách rỗng có trạng thái rỗng + nút hành động đầu tiên (khuôn `ui-consistency` sẵn có).
- Menu chỉ có module đã bật (Phase 1 đã làm) + trang/đối tượng của mẫu.

## 4. Thương hiệu tối thiểu

`settings["org.branding"] = { displayName, accent (tập ĐÓNG 8 màu), logoFileId? }` — logo lưu trong CSDL tổ chức (khuôn
`custom_files`: ≤ 512 KB, png/jpeg/webp, tải qua route có kiểm tổ chức). Thanh đầu hiện tên + logo của tổ chức; accent
đổi biến CSS `--primary`. Tổ chức nhà giữ nguyên giao diện hiện tại.

## 5. Gói và hạn mức

- Control plane: `platform_plans` (key, tên, `limits` jsonb: users, pages, objects, records, workflows, aiDraftsPerDay,
  storageMb) + `platform_organizations.plan_key` (mặc định `trial`; tổ chức nhà `internal` = không giới hạn).
- `checkEntitlement(orgCode, kind, delta)` — gọi ở ĐÚNG các điểm tạo: tạo người dùng, trang, đối tượng, bản ghi tuỳ biến,
  luật, bản nháp AI, tải tệp. Vượt ⇒ lỗi nghiệp vụ rõ ràng (không throw), hiện "đã tới hạn mức gói X".
- Bộ đếm dùng đếm thật từ CSDL tổ chức (không ghi đếm riêng dễ lệch), đệm 60 s.
- Không cổng thanh toán ở phase này.

## 6. Chấp nhận

`PLATFORM_SIGNUP_MODE=invite` trên máy thử: mã mời → tạo "Bán sỉ Minh An" → chọn mẫu bán sỉ → bỏ module Mua hàng → xem
trước → tạo → đăng nhập → ERP dùng được, trạng thái rỗng đúng, không lộ bất cứ thứ gì của VNX. Production: `/start` trả
"chưa mở đăng ký".

## 7. Hiện thực (Phase 10a) — chỗ khác chữ của hợp đồng

- Gói của tổ chức nằm ở cột CÓ SẴN `platform_organizations.plan` (0152, "chỗ cho gói dịch vụ") — không thêm cột
  `plan_key` thứ hai cho cùng một điều. Nhà LUÔN là `internal` trong mã; tổ chức khác thiếu gói ⇒ `trial`.
- `checkEntitlement(kind, delta, { orgCode? })` — bỏ trống `orgCode` ⇒ tổ chức của ngữ cảnh (đúng tổ chức mà lượt ghi
  ngay sau đó chạm vào). Đệm 60 s, nhưng sát 80% trần thì đếm tươi. `objects` / `records` / `aiDraftsPerDay` đã khai
  trong sổ (`lib/entitlements/kinds.ts`) nhưng CHƯA có bộ đếm (Phase 6 / 8 chưa có ở base) ⇒ không chặn, hiện "—".
- Trạng thái dựng ở `platform_organizations.settings.onboarding` (`RUNNING` · `DONE` · `FAILED`), giành quyền dựng
  bằng MỘT câu `UPDATE` điều kiện; `SETUP_FAILED` là trạng thái tổ chức thật (0169). Trần đăng ký đếm từ bảng
  `platform_signup_attempts` (IP chỉ lưu băm).
- Logo trong `custom_files` của CSDL tổ chức (`object_key = org_branding`), tải qua `/api/branding/logo` (không nhận id).
- `/settings/branding` và `/settings/plan` không có mục menu (không đổi menu của tổ chức nhà) — vào từ thẻ «Bắt đầu».

# Cấp phát — runbook

## Thêm một khách mới (không sửa mã, không sửa CSDL)

1. `/platform/customers` → «Tạo khách»: tài khoản mới (tên, loại INTERNAL/EXTERNAL) hoặc chọn tài khoản có sẵn · mã + tên
   workspace · sản phẩm · gói · thương hiệu · email quản trị · lý do. Luật ở MÁY CHỦ (`lib/saas/create-customer-rules.ts`,
   `validateRequest` chặn trước khi ghi job — form chỉ phản ánh, kiểm khởi chạy 08/10/2026):
   - **Gói** = bảng giá CATALOG đang niêm yết + `trial` (mặc định). Gói chỉ còn ở giá cũ (basic · pro · standard) chỉ cho tài
     khoản NỘI BỘ (luật đang có); khách NGOÀI chọn nó là giá cũ, không dùng thử, trần AI của gói cũ (credit 0 ⇒ bot im).
     `internal` (không giới hạn) không cấp cho ai — chỉ của workspace nhà.
   - **Thương hiệu** theo bộ sản phẩm: chỉ Chốt Đơn ⇒ `chotdon` (tự đặt, không đổi được — thiếu nó khách thấy menu ERP và liên kết
     mời trỏ erp.vnxcommerce.com); có ERP ⇒ người vận hành chọn (gợi ý VNX).
   - Nút «Tạo khách…» nằm dưới các ô; chưa bấm được thì câu cạnh nút nói còn thiếu gì.
2. Job `CREATE_CUSTOMER` chạy: `ACCOUNT → WORKSPACE (CSDL + migration + module + quản trị) → ADMIN → SUBSCRIPTIONS → BILLING →
   TEMPLATE`. TEMPLATE: khách CHỈ thuê Chốt Đơn ⇒ cài mẫu «Chỉ cần AI bán hàng» bằng ĐÚNG bộ cài của `/start`
   (`lib/saas/provisioning-template.ts`; khách trong vỏ Chốt Đơn không tự mở được `/settings/templates`); đã cài ⇒ SKIPPED; hỏng ⇒
   bước FAILED kèm câu + nhật ký `ORG_SETUP` · `provisioning-template`, job vẫn xong. Có ERP ⇒ SKIPPED (quản trị tự chọn mẫu ngành).
3. Màn hình in **liên kết kích hoạt dùng một lần** cho quản trị (mật khẩu quản trị là ngẫu nhiên, không lưu, không hiện).
   Gửi riêng cho khách. Quản trị mời thêm người ở `/settings/users`.
4. Thu phí khách ngoài: đặt hạn trả / ân hạn ở `/platform/org/<mã>` (đường 0187). Khách tự đăng ký qua `/start` thì
   dùng thử tự bật.
5. Kết nối (fanpage, Messenger, Zalo, khoá AI riêng): quản trị khách tự nối ở `/settings/connections`,
   `/ai/sales-chatbot/messenger`.

Tự đăng ký (`/start`), người vận hành tạo ở `/platform`, script `platform-provision-org` đều đi qua
`provisionOrganization` ⇒ bước 6 tạo tài khoản + thuê bao. Không workspace nào thiếu tài khoản.

`/start` cấp workspace với module LÕI rồi mới cài mẫu ngành, nên bước 6 của nó không thấy sản phẩm nào (F-02, kiểm vỏ khách
08/10/2026 — trước bản vá, cửa hàng tự đăng ký không có thuê bao). Lượt dựng nay mở thuê bao SAU khi cài mẫu
(`lib/saas/signup-subscriptions.ts::openSignupSubscriptions` — cùng luật «sản phẩm đang dùng theo module», nguồn `SIGNUP`); bước
này không làm hỏng lượt dựng: hỏng ⇒ vết ở `settings.onboarding.subscriptions` + nhật ký `ORG_SETUP` · `product-subscriptions`.

**Sửa bù workspace tự đăng ký trước bản vá:** `npx tsx scripts/saas-subscription-repair.ts` (CHẠY THỬ, chỉ đọc — liệt kê
workspace có thương hiệu đang thiếu thuê bao, sản phẩm sẽ mở, tình trạng sẽ hiện, mốc dùng thử đã chụp, hệ quả) →
`--apply --reason="…"` (đi qua đúng hàm của `/start`; không bật thu phí, không đổi dùng thử, `started_at` = lúc chạy). Chưa nối
vào `ops-vps.yml`: sửa bù workspace thật là quyết định của chủ shop.

Trên production, `CREATE DATABASE` cần quyền CREATEDB của role ứng dụng (đã có — workspace khách hiện có được tạo như vậy).

## Thêm một sản phẩm mới

1. Thêm mục vào `PRODUCTS` (`lib/saas/catalog.ts`): khoá (bất biến), khả năng → module + tính năng, module độc quyền,
   module cấp, có cần lõi thương mại, `aiFeatures`, chỉ số dùng (mỗi chỉ số một nguồn), miền sở hữu.
2. Module mới (nếu có) khai ở `lib/constants/platform-modules.ts` như mọi module.
3. Tính năng thương mại mới khai ở `lib/pricing/features.ts`.
4. Gói riêng: tạo dòng `platform_plans` với `product_keys = '{<khoá>}'` (migration hoặc màn giá).
5. Sản phẩm ghi dùng qua `recordProductUsage`, hỏi quyền qua `hasProductFeature`. Không bảng thuê bao / bảng kê mới.
6. Cập nhật backfill? Không — backfill 0224 chỉ chạy một lần; workspace mới đi qua job cấp phát.

## Khi cấp phát hỏng

- Trang khách → «Job cấp phát»: bước nào FAILED, `last_error`. Sửa nguyên nhân rồi «Chạy lại» (mọi bước idempotent; job
  ghi tài khoản đã tạo ở lượt trước nên không tạo tài khoản thứ hai).
- Job RUNNING quá 10 phút = tiến trình chết giữa chừng ⇒ chạy lại được.
- «Workspace chưa gắn tài khoản» (chỉ có thể là workspace tạo trước 0224 mà migration chưa chạy, hoặc chèn tay): tạo khách
  với tài khoản mới cho đúng mã workspace đó (bước WORKSPACE nhận workspace đã có), hoặc chuyển vào tài khoản có sẵn.
- «Module lệch thuê bao»: module bật mà chưa có thuê bao ⇒ «Mở thuê bao còn thiếu»; có thuê bao mà module tắt ⇒ bật module
  ở trang workspace.
- Gộp hai tài khoản trùng khách: mở từng tài khoản thừa → «Chuyển sang tài khoản khác». Máy chỉ gợi ý (cùng từ đầu tên),
  không bao giờ tự gộp.

## Vận hành

- Nhật ký: mọi thao tác ghi `platform_audit_log` (`ACCOUNT_*`, `WORKSPACE_ACCOUNT_SET`, `PRODUCT_*`, `COST_ENTRY_*`,
  `STATEMENT_FINALIZE`, `PROVISIONING_RUN`).
- Đo trên production (chỉ đọc): `db-query` `select status, count(*) from platform_provisioning_jobs group by 1`;
  `select account_type, billing_mode, count(*) from platform_accounts group by 1,2`.

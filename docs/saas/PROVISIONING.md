# Cấp phát — runbook

## Thêm một khách mới (không sửa mã, không sửa CSDL)

1. `/platform/customers` → «Tạo khách»: tài khoản mới (tên, loại INTERNAL/EXTERNAL) hoặc chọn tài khoản có sẵn · mã + tên
   workspace · sản phẩm · gói · thương hiệu · email quản trị · lý do. Luật ở MÁY CHỦ (`lib/saas/create-customer-rules.ts` thuần +
   `lib/saas/workspace-commercial.ts` đọc sổ; `validateRequest` chặn trước khi ghi job — form chỉ phản ánh, kiểm khởi chạy
   08/10/2026 + review #682):
   - **Gói** = bảng giá CATALOG đang niêm yết + `trial` (mặc định — 7 ngày hoặc 100 khách AI, mốc nào tới trước). Gói chỉ còn ở
     giá cũ (basic · pro · standard) chỉ cho tài khoản NỘI BỘ mà workspace KHÔNG chỉ dùng Chốt Đơn (luật đang có); khách NGOÀI
     chọn nó là giá cũ, không dùng thử, trần AI của gói cũ (credit 0 ⇒ bot im) — workspace chỉ Chốt Đơn cũng vậy, kể cả nội bộ.
     `internal` (không giới hạn) không cấp cho ai — chỉ của workspace nhà.
   - **Thương hiệu** theo bộ sản phẩm: chỉ Chốt Đơn ⇒ `chotdon` (tự đặt; CHỌN VNX ⇒ từ chối — thiếu nó khách thấy menu ERP và
     liên kết mời trỏ erp.vnxcommerce.com); có ERP ⇒ người vận hành chọn (gợi ý VNX).
   - **Một luật cho mọi cửa**: `provisionOrganization` hỏi lại `decideNewWorkspace` lúc ghi dòng tổ chức khi cửa khai
     `commercial` — job «Tạo khách», `/start` (công khai · mã mời · người vận hành tạo hộ), script `platform-provision-org`
     (`tests/create-customer-rules.test.ts` quét mã nguồn: lời gọi ngoài tests/ thiếu ô này là đỏ). Thương hiệu của host lúc tự
     đăng ký chỉ là GỢI Ý — mẫu chỉ AI ⇒ `chotdon` dù khách đứng ở host VNX. Đổi gói sau lúc tạo (`/platform/org/<mã>`), thuê
     thêm sản phẩm có gói riêng, mã mời mang gói: cùng luật gói; đổi thương hiệu workspace chỉ Chốt Đơn sang VNX ⇒ từ chối.
     CHƯA chặn: đổi LOẠI tài khoản sau lúc tạo (workspace nội bộ đang ở gói cũ chuyển thành khách ngoài vẫn giữ gói cũ) —
     đổi loại ở trang khách thì kiểm gói ngay sau đó.
   - Nút «Tạo khách…» nằm dưới các ô; chạm vào khung mà nút chưa bấm được ⇒ câu cạnh nút nói còn thiếu gì.
2. Job `CREATE_CUSTOMER` chạy: `ACCOUNT → WORKSPACE (CSDL + migration + module + quản trị) → ADMIN → SUBSCRIPTIONS → BILLING →
   TEMPLATE`. TEMPLATE: khách CHỈ thuê Chốt Đơn ở gói có AI bán hàng ⇒ cài mẫu «Chỉ cần AI bán hàng» bằng ĐÚNG bộ cài của `/start`
   (`lib/saas/provisioning-template.ts`; khách trong vỏ Chốt Đơn không tự mở được `/settings/templates`; nhật ký của lượt cài ghi
   lý do «Job cấp phát <khoá>»); đã cài ⇒ SKIPPED. Gói KHÔNG có AI bán hàng (Inbox) hoặc có ERP ⇒ SKIPPED. Hỏng ⇒ bước FAILED +
   nhật ký `ORG_SETUP` · `provisioning-template`; cấp phát vẫn xong NHƯNG job mang `last_error` «Chưa cài được mẫu: …» — form báo
   «Đã tạo khách — CHƯA cài được mẫu», trang khách hiện «Xong — CHƯA cài được mẫu» (đỏ) + nút **«Cài lại mẫu»** (chạy RIÊNG
   bước mẫu, không đụng tài khoản / workspace / thuê bao / thu phí), danh sách khách bật cờ «Cấp phát hỏng» tới khi cài xong.
3. Màn hình in **liên kết kích hoạt dùng một lần** cho quản trị (mật khẩu quản trị là ngẫu nhiên, không lưu, không hiện).
   Gửi riêng cho khách. Khách mở liên kết, đặt mật khẩu, rồi đăng nhập ở `/login` bằng **email + mật khẩu** — KHÔNG cần «mã
   tổ chức» (chỉ mục đăng nhập ghi ngay lúc cấp phát, `IDENTITY.md` §1b; ô «Đăng nhập bằng mã tổ chức» chỉ còn là đường phụ).
   Quản trị mời thêm người ở `/settings/users`.
4. Trang khách `/platform/customers/<mã>` → từng workspace có dòng **«Quản trị khách»**: email · trạng thái đọc từ dữ liệu
   THẬT của workspace (Đã kích hoạt · Chưa kích hoạt — liên kết còn hạn / đã hết hạn / không còn liên kết · Chưa có tài khoản
   quản trị · Đang khoá) — `lib/saas/activation.ts`. Chưa kích hoạt ⇒ nút **«Gửi lại liên kết kích hoạt»** (lý do bắt buộc,
   nhật ký nền tảng `PASSWORD_RESET_LINK` · `purpose: ACTIVATION`): liên kết cũ chưa dùng HẾT hiệu lực ngay, liên kết mới hiện
   MỘT lần để sao chép (chưa có kênh thư — dịch vụ ngoài mới cần chủ shop duyệt). Người nhận do máy chủ tra (email job «Tạo
   khách» đã tạo; workspace không qua job ⇒ quản trị ADMIN tạo sớm nhất), không nhận email từ trình duyệt. Quản trị ĐÃ kích hoạt
   mà quên mật khẩu ⇒ «Đặt lại mật khẩu cho khách» ở `/platform/org/<mã>`. Gửi lại form «Tạo khách» cùng yêu cầu cũng không phát
   liên kết cho người đã kích hoạt.
5. Thu phí khách ngoài: đặt hạn trả / ân hạn ở `/platform/org/<mã>` (đường 0187). Khách tự đăng ký qua `/start` thì
   dùng thử tự bật.
6. Kết nối (fanpage, Messenger, Zalo, khoá AI riêng): quản trị khách tự nối ở `/settings/connections`,
   `/ai/sales-chatbot/messenger`.

Tự đăng ký (`/start`), người vận hành tạo hộ (`/platform` → «Dựng theo mẫu ngành»), script `platform-provision-org` đều đi qua
`provisionOrganization` ⇒ bước 6 tạo tài khoản + thuê bao, và cùng luật gói / thương hiệu ở bước 1. Không workspace nào thiếu tài
khoản. Khách trả tiền mới: «Tạo khách mới» ở `/platform/customers` (nút đầu tiên của `/platform`).

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
- «Chạy lại» một job xếp TRƯỚC luật hiện hành (thương hiệu trống cho workspace chỉ Chốt Đơn, gói cũ cho khách ngoài) bị TỪ CHỐI
  kèm chỗ sửa — chạy đúng đầu vào cũ là dựng lại đúng cái sai: workspace chưa tạo ⇒ gửi «Tạo khách» mới; tạo dở ⇒ sửa gói /
  thương hiệu ở `/platform/org/<mã>`.
- Job «Xong — CHƯA cài được mẫu» ⇒ «Cài lại mẫu» (bước 2).
- Mỗi yêu cầu một khoá idempotent. Gửi lại CÙNG khoá mà thông tin KHÁC (form «Tạo khách» đã sửa · «Thuê thêm sản phẩm» chọn
  sản phẩm khác) ⇒ TỪ CHỐI, không job nào chạy: câu nói job cũ (mã · trạng thái) và lối ra — job đã tạo workspace thì ở trang
  khách «Chạy lại» (nếu còn hỏng) rồi «Gửi lại liên kết kích hoạt»; chưa tạo thì tải lại form. So trên bản ĐÃ chuẩn hoá (thương
  hiệu đã chốt) — bản ghi lên job; dấu vân phủ MỌI trường của yêu cầu (`FingerprintFields`, thiếu trường là lỗi biên dịch). Form
  «Thuê thêm sản phẩm» sinh khoá MỚI sau mỗi lượt thành công; câu «Đã thuê …» đọc tên sản phẩm từ job, không từ form.
- «Workspace chưa gắn tài khoản» (chỉ có thể là workspace tạo trước 0224 mà migration chưa chạy, hoặc chèn tay): tạo khách
  với tài khoản mới cho đúng mã workspace đó (bước WORKSPACE nhận workspace đã có), hoặc chuyển vào tài khoản có sẵn.
- «Module lệch thuê bao»: module bật mà chưa có thuê bao ⇒ «Mở thuê bao còn thiếu»; có thuê bao mà module tắt ⇒ bật module
  ở trang workspace.
- Gộp hai tài khoản trùng khách: mở từng tài khoản thừa → «Chuyển sang tài khoản khác». Máy chỉ gợi ý (cùng từ đầu tên),
  không bao giờ tự gộp.
- **Khách kích hoạt rồi mà `/login` vẫn báo sai mật khẩu, gõ «mã tổ chức» thì vào được** = tài khoản tạo TRƯỚC bản vá
  08/10/2026, chưa có dòng chỉ mục đăng nhập. Ops `identity-reconcile` (arg rỗng = mọi tổ chức, hoặc `<mã>`): CHẠY THỬ, chỉ đọc —
  đếm tài khoản đủ điều kiện (đang bật · email chuẩn · có mật khẩu) đã có / THIẾU / LỆCH dòng chỉ mục; phần mã hoá liệt kê từng
  chỗ (email / SĐT đã che). Rồi `--apply` (hoặc `<mã> --apply`): ghi bù qua đúng đường ghi của ứng dụng, idempotent, nhật ký nền
  tảng `IDENTITY_RECONCILE` nguồn SCRIPT; đọc lại sau khi ghi, còn thiếu ⇒ mã thoát 1. Một lượt kích hoạt / đặt lại mật khẩu
  qua liên kết cũng tự ghi lại dòng của đúng tài khoản ấy.

## Vận hành

- Nhật ký: mọi thao tác ghi `platform_audit_log` (`ACCOUNT_*`, `WORKSPACE_ACCOUNT_SET`, `PRODUCT_*`, `COST_ENTRY_*`,
  `STATEMENT_FINALIZE`, `PROVISIONING_RUN`).
- Đo trên production (chỉ đọc): `db-query` `select status, count(*) from platform_provisioning_jobs group by 1`;
  `select account_type, billing_mode, count(*) from platform_accounts group by 1,2`.

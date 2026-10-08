# Bảo mật đa tenant của control plane

## 1. Cô lập dữ liệu nghiệp vụ

SILO: một workspace một CSDL, `getDb()` chọn theo ngữ cảnh máy chủ (claim `org` trong JWT đã ký hoặc `withOrganization`).
Đổi ID trên URL / form không đổi được workspace. Các bài tấn công đã có: `tests/tenant-attack.test.ts`,
`tests/ai-sales-isolation.test.ts`, `tests/platform-isolation*.test.ts`.

## 2. Control plane

- Mọi loader / thao tác xuyên tài khoản (`lib/saas/console.ts`) hỏi `platformOperatorDenial` TRƯỚC — trang, server action,
  và lõi đều kiểm (ẩn menu không phải bảo mật).
- Quyền vận hành = `platform:operate` của người thuộc workspace NHÀ (nơi control plane sống). `account_type = INTERNAL`
  KHÔNG cấp quyền: bài kiểm đặt tài khoản của một workspace khách thành INTERNAL và gán `platform:operate` cho admin của
  nó — vẫn bị từ chối; người nhà vai trò CS cũng bị từ chối.
- Cổng khách (`lib/saas/portal.ts`) và SDK (`lib/saas/sdk.ts`) lấy workspace từ phiên / ngữ cảnh máy chủ; không hàm nào
  nhận mã workspace từ trình duyệt.
- Sổ dùng: tài khoản + thuê bao của dòng do máy chủ tra từ workspace.
- Job cấp phát không lưu bí mật (mật khẩu quản trị ngẫu nhiên, không lưu, không trả); quản trị kích hoạt bằng liên kết
  dùng một lần (`createResetLinkAsOperator`, có nhật ký). «Gửi lại liên kết kích hoạt» (`resendActivationAsOperator`) chỉ khi
  quản trị CHƯA kích hoạt, người nhận do máy chủ tra, liên kết cũ bị thu hồi, CSDL chỉ giữ băm.
- Bảng `platform_*` mới bị xoá ở CSDL workspace mỗi lần mở (`db/migrate.ts`), khai trong `CONTROL_PLANE_TABLES`.

## 3. Danh tính — hiện trạng và giới hạn

Một người thuộc hai workspace = hai dòng `users` ở hai CSDL, hai mật khẩu; `platform_identities` chỉ là chỉ mục để đăng
nhập không cần mã workspace — ghi ngay khi tài khoản dùng được bằng mật khẩu (`IDENTITY.md` §1b), mật khẩu vẫn kiểm trong
CSDL workspace; Google / Facebook chỉ khớp email của dòng đã từng dùng để đăng nhập. Không có chuyển workspace trong phiên. Hợp nhất danh tính (một User toàn nền tảng + Membership)
là Phase 3 của `PLAN.md`: phải giữ nguyên tính chất "JWT `org = B`, `sub` của A ⇒ tra trong CSDL B ⇒ không thấy ⇒ từ chối".

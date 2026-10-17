# 06 — Rà soát bảo mật, kiểm thử thực tế cô lập, checklist Meta cho chủ shop

Đi kèm PR K3 + K8 (nhánh `claude/meta-app-review-audit`). Bối cảnh và kịch bản video: [05](05-kiem-toan-ho-so-17-10.md).

## 1. Rà soát thay đổi K3 / K8 — có ảnh hưởng gì không

| Phần chạm | Ảnh hưởng | Căn cứ |
|---|---|---|
| AI Sales Agent (bot, hộp thư, gửi tin, đơn) | **Không** — không tệp nào của `lib/sales-chatbot/*` đổi | `git diff --stat origin/main` |
| Khách đang dùng | **Không đổi gì tới khi người vận hành đặt cờ** — mặc định vẫn ĐÓNG, luật đọc cờ giữ nguyên | `testDirectConnectGate` |
| Tenant khác | Cờ dạng danh sách so khớp mã CHÍNH XÁC; mở cho cửa hàng demo không mở cho cửa hàng khác; quản trị cửa hàng (kể cả mang khoá `platform:operate`) không tự mở được | `testDirectConnectWrite` |
| `/platform` | Thêm một lượt đọc `platform_settings` (đọc hỏng ⇒ coi như ĐÓNG) và một công tắc | build đạt |
| Chính sách 1.2 | Đổi chữ trang công khai; KHÔNG bắt người dùng đồng ý lại (phiên bản chỉ được ghi lúc đăng ký mới) | `testLegalRegisters` |
| Luật cô lập nền tảng | Lõi mới khai ở `LOI_VAN_HANH`, hỏi `platformOperatorDenial` trước mọi lượt đọc | `testPlatformIsolationStatic` |

Bài kiểm đã chạy riêng (không chạy cả bộ): `testDirectConnectGate`, `testDirectConnectWrite`, `testLegalRegisters`, sáu bài
`testMessenger*`, `testRepoIntegrity`, `testPlatformIsolationStatic`, `testTenantAttack`, `testActionRefreshOnce`,
`testErpFormNames`, `testLoadingUxContract`, `testSaasShell`, `testPublicSiteSource`, `testChotDonBrand`, `testChannelsOverview`,
`testPlatformDiagnosticsOrg`, `testShellGateRedirects`, `testPlatformUi` — đều đạt. `testPlatformHardening` không chạy ở máy
Windows (đỏ giả do PGlite), CI chạy trên Linux.

## 2. Rà soát bảo mật luồng Messenger (đọc mã, 17/10/2026)

| Mắt xích | Hiện trạng | Kết luận |
|---|---|---|
| Bắt đầu OAuth `/api/connect/messenger/start` | Qua `apiGuard("settings:manage")`; `state` ngẫu nhiên 24 byte, ký trong cookie `httpOnly`, `sameSite=lax`, giới hạn đường dẫn, có hạn; redirect URI dựng từ host trong danh sách cho phép (`appOriginForHost`) | Đạt |
| Callback | `state` phải khớp cookie VÀ cùng tổ chức VÀ cùng người bấm; cookie bị xoá ngay; đổi `code` ở máy chủ | Đạt |
| Danh sách page chờ chọn | JWE mã hoá, gắn tổ chức + người, hết hạn 10 phút | Đạt |
| Page đã thuộc cửa hàng khác | Bị bỏ khi nối, page còn lại vẫn nối | Đạt (`testMessengerMultiPage`) |
| Token page | Mã hoá trong CSDL của cửa hàng; mọi lời gọi Graph kèm `appsecret_proof` | Đạt |
| Webhook | Trần kích thước (413) → chữ ký HMAC-SHA256 so sánh thời gian hằng (401) → mới `JSON.parse`; định tuyến theo MÃ PAGE, page lạ bị bỏ; chống trùng theo `mid`; xử lý nặng chạy sau khi trả 200 | Đạt |
| Cờ nối thẳng | Chỉ người vận hành ở tổ chức nhà; bắt buộc lý do; nhật ký `FLAG_SET` | Đạt |
| Ghi chú | Route `/start` KHÔNG bị cờ chặn (cờ chỉ quyết vẽ nút) — quản trị cửa hàng nào gõ thẳng URL vẫn vào được hộp thoại Facebook. Không lộ dữ liệu: Meta chỉ cấp quyền cho người có vai trò trong app tới khi duyệt. Giữ nguyên, không sửa trong PR này | Chấp nhận được |

## 3. Kiểm thử thực tế — môi trường cô lập

**Chọn môi trường.** Webhook Meta chỉ gọi tới MỘT Callback URL công khai (production). Máy làm việc không nhận được webhook, mở
đường hầm ra Internet là thêm dịch vụ ngoài (cần chủ shop duyệt — AGENTS.md §7); `ai-staging` chạy nhánh khác, không phải mã sẽ
deploy. ⇒ **Cô lập bằng TENANT trên production**: một cửa hàng demo riêng (cơ sở dữ liệu riêng), một page thử riêng, cờ mở đúng
cửa hàng đó. Không cửa hàng khách nào, không page bán hàng thật nào tham gia.

**Điều kiện trước (đều phải ĐẠT):**
- [ ] PR đã gộp + deploy; `/api/health` trả đúng commit.
- [ ] Cửa hàng demo `meta-review-demo` (05 §7): module AI bán hàng bật, chế độ AI tự trả lời, còn hạn mức AI, 2–3 sản phẩm khớp bài viết thử.
- [ ] Page thử công khai, KHÔNG nối Pancake, có một bài viết nêu tên + giá sản phẩm.
- [ ] Tài khoản Facebook bấm kết nối có vai trò Admin / Developer / Tester trong app `1794152675112502`.
- [ ] Cờ «Chỉ các cửa hàng được liệt kê» = `meta-review-demo`.

**Chạy:** đúng 8 bước S1–S8 ở [05 §6.2](05-kiem-toan-ho-so-17-10.md). Ghi lại mốc giờ từng bước để đối chiếu log.

**Bằng chứng giữ lại (không token, không mật khẩu):** dòng log `[messenger-connect] … reason=OK`; ảnh khối webhook «đã đăng ký đủ»;
ảnh hộp thư có tin khách + AI + nhân viên; ảnh Messenger phía khách; không có `messenger_webhook_rejected` trong khung giờ thử.

**Dừng / hoàn tác ngay nếu có gì sai** (mỗi bước một thao tác, không cần deploy):
1. `/platform` → cờ → **Đóng** (có nhật ký).
2. Cửa hàng demo → Messenger → **Gỡ** page (huỷ webhook ở Facebook).
3. Nặng nhất: `/platform/org/meta-review-demo` → đình chỉ cửa hàng demo.

## 4. Checklist thao tác Meta của chủ shop

Không huỷ hồ sơ đang xét · không tạo app mới · không «Submit» lại khi đang In review.

**Ngay bây giờ (không phụ thuộc PR):**
- [ ] O1 · App Review → Requests → mở yêu cầu → xem video đã nộp cho từng quyền (có hộp thoại Facebook Login hiện tên app? có thao tác dùng quyền trong ChotDonTuDong? hay chỉ màn hình Meta Developer?).
- [ ] O2 · Ghi tên quyền thứ 5 trong hồ sơ.
- [ ] O4 · Facebook Login (for Business) → Settings → Valid OAuth Redirect URIs có `https://app.chotdontudong.com/api/connect/messenger/callback`.
- [ ] O6 · App roles → Roles: tài khoản Facebook sẽ quay video là Admin / Developer / Tester.
- [ ] App settings → Basic: Privacy Policy URL `https://vnxcommerce.com/chinh-sach-bao-mat` · User data deletion `…/chinh-sach-bao-mat#xoa-du-lieu` · icon · category · contact email.

**Sau khi PR deploy:**
- [ ] O3 · ERP `/platform` → «App Messenger riêng» = `1794152675112502`, «Nối page dùng app» = App Messenger riêng (đừng quay khung này).
- [ ] Kiểm thử §3 ở trên (S1–S8).
- [ ] O5 · Use case Messenger → Permissions and features: cả 4 quyền có lượt gọi API thành công (Meta có thể đếm trễ tới 24 giờ).
- [ ] Quay 4 video A–D (05 §2), phụ đề tiếng Anh.
- [ ] Tạo tài khoản người duyệt trong cửa hàng demo; điền 04 §3 vào form Meta khi được sửa.

**Khi Meta hỏi thêm / trả hồ sơ về:**
- [ ] Tải 4 video vào đúng 4 quyền; dán 04 §1–§4.
- [ ] Nếu quyền thứ 5 là `business_management` / `instagram_*`: bỏ khỏi hồ sơ (05 §5).
- [ ] Resubmit. Giữ nguyên cửa hàng demo, page thử, tài khoản người duyệt tới khi có kết quả.

**Khi Meta duyệt:** `/platform` → cờ → «Mở cho mọi cửa hàng» (một lượt, có nhật ký) — đó là ngày MM-META-01.

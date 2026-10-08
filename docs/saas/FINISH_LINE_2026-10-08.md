# Finish line Chốt Đơn Tự Động — kiểm Admin + Khách như người dùng thật (08/10/2026)

*Sứ mệnh `saas-finish-line` · R1 · chạy song song với Tech Lead Delivery Pipeline (integration controller duy nhất). Đo trên bản
build của `origin/main` `c360b7c6` chạy cục bộ (PGlite, host `app.chotdon.test`, đăng ký `open`), trình duyệt Chrome headless
riêng ở 1366×768 và 390×844. Mọi cửa hàng, tài khoản, liên kết trong tài liệu là dữ liệu giả. Ảnh chụp chỉ để trên máy người đo,
KHÔNG vào kho (kho PUBLIC). Tài liệu này KHÔNG lặp lại `SHELL_AUDIT_2026-10-08.md` (16 phát hiện vỏ khách): nó đo lại những gì
còn mở sau #670 / #671, thêm phần ADMIN chưa ai kiểm, và ghi những gì đã sửa trong PR này.*

Mức độ: **P0** chặn khách trả tiền / sai dữ liệu · **P1** khách hoặc người vận hành bị lạc · **P2** đánh bóng.

## 0. Kết luận đầu tiên

| | Mức sẵn sàng | Căn cứ |
|---|---|---|
| **ADMIN** | **~70 %** | 15 việc của North Star: 11 làm được không sửa CSDL; 2 làm được nhưng phải mở 3–4 màn; 2 chưa có (xem §1). Một **P0** ở mép admin → khách: tài khoản do admin tạo **không đăng nhập được bằng email + mật khẩu** (§1.4) |
| **KHÁCH** | **~60 %** | 14 việc của North Star: 9 làm được; 3 bị chặn bởi Meta (nhận Messenger · AI trả lời · chốt đơn thật — đều cần Page được cấp quyền, `meta-messenger-access` BLOCKED); 2 làm được nhưng khách mới bị lạc (đã sửa trong PR này). Sau PR: ~70 % |

Con số là ước lượng theo số việc làm được / tổng việc, không phải số đo thống kê; dùng để xếp thứ tự, không để báo cáo.

### Top 10 việc chặn (blocker)

| # | Mức | Việc | Ai sửa |
|---|---|---|---|
| 1 | P0 | **Khách do admin tạo không đăng nhập được bằng email + mật khẩu** — chỉ mục danh tính (`recordIdentity`) chỉ ghi ở `lib/auth/login.ts` (sau khi đăng nhập thành công) và `lib/onboarding/quick.ts` (tự đăng ký); `lib/platform/provision.ts:99-106` tạo quản trị trong CSDL tổ chức mà không ghi chỉ mục, đường đặt mật khẩu `/reset/<mã>/<token>` cũng không. Kết quả đo: kích hoạt xong → `/login` báo «Email / số điện thoại hoặc mật khẩu không đúng.»; mở «Đăng nhập bằng mã tổ chức» và gõ `fl-shop` thì vào được (1,2 giây tới `h1`). Khách không biết «mã tổ chức» là gì | **Tech Lead** (lõi cấp phát + danh tính; chồng với `saas-c-shared-identity`) — vá: ghi `recordIdentity("EMAIL", email, orgCode, userId)` ngay sau khi chèn quản trị trong `provisionOrganization`, VÀ trong action đặt mật khẩu qua liên kết (nếu chưa có) |
| 2 | P0 | Meta chưa cấp quyền Page — khách không nối Facebook được (`meta-messenger-access`, BLOCKED, cần chủ shop ở App Dashboard) | Chủ shop |
| 3 | P1 | Sau kích hoạt, khách rơi về `/login` của host Chốt Đơn nhưng trang đăng nhập mang **thương hiệu VNXcommerce** («Hệ thống quản trị bán hàng», ba gạch đầu dòng của ERP: «Tự động từ đơn tới kho», «Thấy lãi thật») | Tech Lead / `saas-l1` (login page theo `hostBrand`) |
| 4 | P1 | Admin không thấy «khách này có chạy không» ở một màn: danh sách khách không có cột Messenger / AI / đăng nhập cuối; phải mở `/platform/customers/<mã>` rồi `/platform/org/<mã>` (3 màn) | Sản phẩm + kỹ thuật (§1.2) |
| 5 | P1 | Không có nút «gửi lại lời mời / tạo lại liên kết kích hoạt» cho quản trị khách: liên kết dùng một lần, hết hạn 24 giờ, in ĐÚNG MỘT LẦN trong khung kết quả của form; đóng trang là mất. Đường vòng: `/settings/users` của tổ chức ấy → «Gửi liên kết đặt lại» (admin phải vào ngữ cảnh tổ chức) | Tech Lead (action `resendActivationAction` ở `lib/actions/saas.ts`) |
| 6 | P1 | Form «Tạo khách mới»: nút «Tạo khách…» đứng CẠNH ô lý do ở ĐẦU khung, mờ cho tới khi gõ lý do ≥ 5 ký tự; các ô thật (tên, mã, gói, sản phẩm, email quản trị) nằm DƯỚI nút. Người mới đọc là «nút bị khoá, không biết vì sao» (B3). Chung cho mọi `ConfirmWithReason` có `children` | Kỹ thuật (R1, `components/platform/pilot-ops.tsx`) — ngoài phạm vi claim của PR này |
| 7 | P1 | Khách mới (AI Sales) vẫn thấy «webhook · token · ERP · API · TEST · Field» (8 từ cấm) ở `/ai/sales-chatbot`; «webhook · module · ERP · API» ở `/settings/users`; «webhook · API» ở `/settings/plan` (chip tính năng «API · webhook» của gói) | `saas-l1-followup` (A1) — không đụng trong PR này để không chồng |
| 8 | P1 | `/settings/users` trong vỏ: **786** phần tử bấm < 32 px, trang cao 4.296 px ở 390 px (F-09) | Chủ shop quyết (đổi vai trò) + kỹ thuật |
| 9 | P2 | `/platform/customers` «Doanh thu kỳ» in `—` cho khách gói Dùng thử và ghi «1 khách có gói không niêm yết giá» — đúng luật 42 nhưng người vận hành đọc là lỗi; cần một dòng «dùng thử tới ngày …» | Sản phẩm |
| 10 | P2 | Admin: `/platform` cuộn 5.600 px, khung Webhook Meta đứng TRÊN bảng tổ chức & sức khoẻ; việc hằng ngày (ai đang lỗi) nằm dưới nếp gấp | Sản phẩm (§1.1) |

### Top 10 quick win (R1, đã làm trong PR này trừ chỗ ghi «chưa»)

| # | Việc | Trạng thái |
|---|---|---|
| 1 | F-04 AI Sales tự cuộn xuống đáy trên điện thoại (`scrollY 7.522 / 8.879`) — cuộn KHUNG TIN thay vì `scrollIntoView` | ✅ `components/sales-chat/chat-panel.tsx` |
| 2 | F-07 bảng «AI đã sẵn sàng…»: «Hỏng» → «Cần làm» (cam, không đỏ), «Lưu ý» → «Nên làm», «Đạt» → «Xong»; link tồn kho `/inventory` → `/inventory/receipts`; dòng kênh thôi nói «webhook», dẫn vào Kênh kết nối; link qua `shellAllows`; khi «Chưa sẵn sàng» có lối nhắn hỗ trợ (Zalo / email từ `lib/constants/company.ts`) | ✅ `lib/sales-chatbot/readiness-shared.ts`, `app/(dashboard)/ai/sales-chatbot/page.tsx` |
| 3 | F-11 `/automations` và mọi đường lạ ra «404 · This page could not be found.» tiếng Anh, không lối về — thêm `app/not-found.tsx` tiếng Việt, tên sản phẩm theo host, nút về trang chính | ✅ |
| 4 | F-12 `/settings/ai-balance` khi cờ tắt in «không có quyền xem» — nay «Số dư AI chưa mở cho cửa hàng của bạn» + nút Xem gói | ✅ |
| 5 | F-15 Tổng quan: «Kênh kết nối» là chữ đậm không bấm được — thành link | ✅ |
| 6 | F-15 Kênh trống: «Nối ở Cài đặt → Kết nối» (mục không tồn tại trong vỏ) — thành link thẳng tới trang Kết nối | ✅ |
| 7 | F-03 Hộp thư rỗng của cửa hàng chưa nối kênh: «Không có hội thoại nào ở bộ lọc này» → «Chưa có tin khách vì cửa hàng chưa nối kênh bán hàng» + nút Kết nối Facebook (chỉ khi chưa có page nào và không lọc gì) | ✅ |
| 8 | F-10 tiêu đề theo menu vỏ: Hội thoại (thay «Hộp thư khách»), AI Sales (thay «Chatbot bán hàng»), bỏ nhãn nhỏ «AI» | ✅ hai trang trong phạm vi; Sản phẩm / Nhân viên / Gói **chưa** (ngoài claim) |
| 9 | F-05 Hướng dẫn: 4/13 bài dẫn vào trang vỏ chặn, chữ «Hệ thống → Người dùng», «Mời nhân viên vào ERP» — thêm trường `audience` (ERP · CHOTDON · ALL), 7 bài viết cho vỏ gọi đúng tên menu (Kênh kết nối · Hội thoại · AI Sales · Sản phẩm · Nhân viên · Gói dịch vụ), bài ERP ẩn trong vỏ, mọi link của bài vỏ phải qua `salesAgentPathAllowed` (bài kiểm khoá), FAQ lọc cùng luật, **tầng liên hệ** (Zalo · email · gọi) ở cuối `/help` | ✅ `lib/constants/help-guides.ts`, `app/(dashboard)/help/page.tsx`, `tests/help-guides.test.ts` |
| 10 | F-16 `/customers` in «0.0%» khi mẫu số 0 (`pct` thay vì `pctOrNull`), ngưỡng màu `>= 10` viết cứng | ❌ chưa — ngoài claim (`app/(dashboard)/customers/page.tsx`), giao `saas-lowtech-ux` |

## 1. ADMIN — ma trận chấp nhận

Luồng: LOGIN ADMIN → CUSTOMERS → CREATE CUSTOMER → ACCOUNT → WORKSPACE → PRODUCT → PLAN → PROVISION → INVITE → CUSTOMER
ACTIVATES → CONNECTION STATUS → USAGE → BILLING → HEALTH → SUPPORT. Đo bằng tài khoản quản trị tổ chức nhà (`platform:operate`).

| Bước | Màn | UI rõ | CTA đúng | Đang tải | Thành công | Thất bại | Chạy lại | Trạng thái rỗng | Dữ liệu thật | Quyền | Rò tổ chức khác | Điện thoại | Ghi chú |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Đăng nhập admin | `/login` | ✓ | ✓ | ✓ | ✓ 1,1 s | ✓ câu chung | — | — | ✓ | ✓ | — | ✓ | |
| Danh sách khách | `/platform/customers` | ◐ | ✓ | ✓ `loading.tsx` | ✓ | — | — | ✓ «Chưa có tài khoản nào» | ✓ (0 ₫ / — phân biệt) | ✓ `platform:operate` + tổ chức nhà | ✓ | ◐ bảng 920 px cuộn ngang | Thiếu cột kênh / AI / đăng nhập cuối (blocker 4) |
| Tạo khách | form cùng trang | ◐ | ✗ nút mờ không lý do (blocker 6) | ✓ spinner | ✓ «Đã tạo khách.» + liên kết | ✓ câu nghiệp vụ (`validateRequest`) | ✓ «Chạy lại» ở trang khách khi job FAILED | — | ✓ | ✓ | ✓ | ◐ | Job idempotent theo khoá (`platform_provisioning_jobs.idempotency_key`); khoá sinh ở client mỗi lần mount ⇒ bấm hai lần trong một lượt mở trang không tạo đôi, mở lại trang thì tạo khách MỚI nếu đổi mã (mã workspace trùng ⇒ `provisionOrganization` idempotent, không tạo CSDL thứ hai) |
| Tài khoản / workspace / sản phẩm / gói | cùng form | ✓ | ✓ | ✓ | ✓ | ✓ gói không phủ sản phẩm ⇒ từ chối | — | — | ✓ | ✓ | ✓ | ◐ | Mặc định tick đúng «Chốt Đơn Tự Động», thương hiệu phải chọn tay «Chốt Đơn» (mặc định trống ⇒ khách KHÔNG vào vỏ Chốt Đơn — dễ quên) |
| Cấp phát | job | ✓ | — | ✓ | ✓ 5 bước DONE | ✓ `lastError` + bước hỏng | ✓ | ✓ «Chưa có job nào» | ✓ | ✓ | ✓ | ✓ | |
| Mời quản trị | liên kết kích hoạt | ◐ | ◐ | — | ✓ in một lần | — | ✗ không gửi lại được (blocker 5) | — | ✓ | ✓ | ✓ | ✓ | |
| Khách kích hoạt | `/reset/<mã>/<token>` | ✓ | ✓ | ✓ | ✓ «Đã đổi mật khẩu» | ✓ | — | — | ✓ | ✓ | ✓ | ✓ | Sau đó **không đăng nhập được** (blocker 1); trang đăng nhập mang thương hiệu VNX (blocker 3) |
| Trạng thái kết nối | `/platform/org/<mã>` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ nút kiểm tra lại | ✓ | ✓ | ✓ | ✓ | ◐ 5.610 px | Đủ, nhưng là màn thứ ba |
| Dùng | `/platform/customers/<mã>` | ✓ | — | ✓ | ✓ `—` khi chưa đo | — | — | ✓ | ✓ | ✓ | ✓ | ◐ | |
| Thu phí | cùng trang + `/platform/saas` | ✓ | ✓ chốt kỳ có lý do | ✓ | ✓ | ✓ | — | ✓ «Chưa chốt kỳ nào» | ✓ | ✓ | ✓ | ◐ | Giá V1 chờ chủ shop (`saas-d-pricing-overage`) |
| Sức khoẻ | `/platform` + `/platform/org/<mã>` | ◐ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ `—` ≠ 0 | ✓ | ✓ | ◐ | Khung Webhook Meta trên cùng (blocker 10) |
| Hỗ trợ | `/platform/org/<mã>` | ✓ | ✓ đình chỉ · tạm dừng luật · tắt kết nối, có lý do | ✓ | ✓ | ✓ | — | — | ✓ | ✓ | ✓ | ◐ | Khoá / mở / gia hạn / nâng gói: có (thuê bao Tạm dừng · Tiếp tục · Huỷ; gói qua «Thuê thêm sản phẩm…»); gia hạn tay chưa có nút riêng — đi đường hoá đơn / VietQR |
| Rò tổ chức | URL `/platform/customers/<mã lạ>` | ✓ 404 nội bộ | | | | | | | | ✓ | ✓ khách mở `/platform*` ⇒ về hộp thư «ngoài gói» | | Thử từ tài khoản khách: `/platform`, `/platform/customers/<mã khách khác>`, `/reports` đều về hộp thư kèm câu; không trang nào trả dữ liệu |

### 1.1 Admin home (`/platform`)

Trả lời được: số tổ chức, tổ chức có vấn đề, đình chỉ, tạm dừng luật, đăng ký đang mở/đóng, AI nền tảng bật/tắt, top chi phí AI,
khoá bí mật, mã mời. **Không trả lời ngay**: bao nhiêu khách dùng thử / trả tiền / sắp hết hạn, khách nào lỗi Messenger, khách nào
AI hỏng, khách nào sắp hết lượt — những ô này nằm ở `/platform/customers` (cờ cảnh báo: lỗ gộp · quá hạn · cấp phát hỏng · chi phí
chưa biết) và `/platform/org/<mã>` (Messenger, AI), không gộp. Không có số giả: ô chưa đo in `—` đúng luật 42. Khung Webhook Meta
(cấu hình một lần) chiếm màn đầu — nên chuyển xuống cuối, đưa «Tổ chức & sức khoẻ» + «Cần xử lý» lên trên.

### 1.2 Danh sách khách

Có: tên, loại (nội bộ / ngoài), sản phẩm · gói, doanh thu kỳ, chi phí, biên gộp, số hội thoại, tình trạng thuê bao, job hỏng.
**Thiếu để «không mở 5 màn»**: Messenger đã nối? (có ở `/platform/org`), AI đang chạy / hỏng? (có ở `/platform/org`), đăng nhập
cuối (có ở `/platform` cột Pilot · dùng), sắp hết lượt (có ở `/settings/plan` của tổ chức). Dữ liệu đều đã có sẵn ở các hàm hiện hành
(`listOrgSupportSummaries`, `getPlatformHealth`, `readAiCustomerUsage`) — việc là gộp vào `loadCustomersConsole` + 3 cột, không
cần bảng mới. Thao tác nhanh trên dòng: hiện chỉ có «mở khách»; nên có «Sức khoẻ», «Gửi lại lời mời», «Tạm dừng» khi an toàn.

### 1.3 Chi tiết khách

Có đủ 12 khối của A3 (tổng quan · tài khoản · workspace · sản phẩm · thuê bao · dùng · kênh (số page) · bảng kê · chi phí · triển khai ·
job · nhật ký) **trừ** AI health và order health (ở `/platform/org/<mã>`). Câu «Khách này hiện có hoạt động bình thường không?» trả
lời được trong ~30 giây nếu đã biết mở `/platform/org` — người mới không biết.

### 1.4 Tạo khách — không sửa CSDL, không dòng lệnh, không mã tổ chức tay

Đạt: form → job 5 bước có vết → liên kết kích hoạt. Idempotent (khoá), có tiến độ (job + bước), có lỗi, chạy lại được, không tạo
trùng CSDL. **Nhưng** bước «khách kích hoạt → đăng nhập» hỏng (blocker 1): đo 2/2 lượt trên hai host (`app.chotdon.test`,
`localhost`) đều «sai mật khẩu» cho tới khi gõ mã tổ chức. Đây là lỗ ở mép admin → khách, không phải ở form.

## 2. KHÁCH — đo lại sau #670 / #671 (trước PR này)

| Đường | 1366 | 390 | Ghi chú |
|---|---|---|---|
| Đăng nhập vỏ (có mã tổ chức) → `h1` | 1,2 s | 1,2 s | F-01 ĐÃ hết (trước: ≥ 15 s trang trắng) |
| `/settings/plan` | «Gói Dùng thử», đồng hồ khách AI 0/100, hoá đơn 0 ₫ | OK | F-02 ĐÃ hết; còn chip «API · Webhook» |
| `/ai/sales-chatbot` | 6.396 px | **scrollY 7.522 / 8.879** | F-04 còn → sửa trong PR |
| `/automations` | `h1 = 404` tiếng Anh | như vậy | F-11 → sửa |
| `/settings/ai-balance` | `h1 = null` (404 dashboard) | như vậy | F-12 → sửa |
| `/settings/users` | 786 ô < 32 px | 4.296 px | F-09 còn (chủ shop quyết) |
| `/help` | 29 ô < 32 px, chữ «module · ERP · TEST» | 5.393 px | F-05 → sửa |
| Hộp thư rỗng | «Không có hội thoại nào ở bộ lọc này» | như vậy | F-03 → sửa |
| Tràn ngang | 0/21 | 0/17 | giữ |

Ba việc của North Star khách **không đo được** trên máy này vì cần Meta cấp quyền Page: nhận Messenger · AI trả lời khách thật ·
xác nhận / tạo đơn từ hội thoại thật. Chúng đã có bài kiểm ở mức mã (`tests/saas-l3-inbox.test.ts`, golden v2) và đang chờ
`meta-messenger-access`.

### 2.1 Đo lại SAU khi vá (cùng máy, cùng cửa hàng giả, build của nhánh này)

| Đường | Trước | Sau |
|---|---|---|
| `/ai/sales-chatbot` 390 px, `scrollY` lúc mở | 7.522 / 8.879 px | **0** / 9.013 px |
| `/ai/sales-chatbot` chữ cấm nhìn thấy | webhook · token · ERP · API · TEST · Field · **Hỏng** | webhook · token · ERP · API · TEST · Field (phần còn lại thuộc A1 `saas-l1-followup`) |
| `/automations` | `h1 = 404` (tiếng Anh, không vỏ) | `h1 = Không có trang này`, nút về trang chính |
| `/settings/ai-balance` (cờ tắt) | `h1 = null`, «không có quyền xem» | `h1 = Số dư AI`, «chưa mở cho cửa hàng của bạn» + Xem gói |
| `/help` | 29 ô bấm < 32 px · chữ «module · ERP · TEST» · 4 bài dẫn vào trang vỏ chặn | 22 ô · 0 chữ cấm · 9 bài (7 viết cho vỏ + 2 chung), 0 link bị chặn, có tầng liên hệ |
| Hộp thư rỗng (chưa nối kênh) | «Không có hội thoại nào ở bộ lọc này.» | «Chưa có tin khách vì cửa hàng chưa nối kênh bán hàng» + nút Kết nối Facebook |
| Tiêu đề Hội thoại / AI Sales | «Hộp thư khách» · «Chatbot bán hàng» | «Hội thoại» · «AI Sales» (đúng menu) |
| Tràn ngang | 0/21 · 0/17 | 0/21 · 0/17 |
| Đăng nhập vỏ → `h1` | 1,2 s | 1,2–2,6 s (cùng máy đang chạy bài kiểm, không phải số hiệu năng) |

Lỗi console duy nhất ở cả hai lượt: một tài nguyên 404 (biểu tượng / service worker của host thử — không có trên host `chotdon.test`
cục bộ), không phải lỗi trang.

## 3. Đã sửa trong PR này (SAFE TO FIX NOW)

Xem bảng Quick win §0. Nguyên tắc: không đổi luật nghiệp vụ, không chạm `lib/auth` · `lib/platform` · `db/` · thu phí; mọi link mới đi
qua `shellAllows` / `salesAgentPathAllowed`; chữ mới không có từ trong danh sách cấm (`HELP_CENTER.md` §6). Bài kiểm:
`tests/help-guides.test.ts` thêm 4b (bài vỏ chỉ dẫn vào trang vỏ mở được · bài ERP ẩn trong vỏ · mỗi mục menu vỏ có ít nhất một bài ·
FAQ hai phía · `/help` có tầng liên hệ).

## 4. HANDOFF cho Tech Lead (core / rủi ro cao / ngoài claim)

1. **[P0] Ghi chỉ mục danh tính khi cấp phát quản trị** (blocker 1). Vùng: `lib/platform/provision.ts` (sau `odb.insert(schema.users)`),
   và action đặt mật khẩu qua liên kết (`/reset/[org]/[token]`). Kiểm: tạo khách qua job → đăng nhập `/login` KHÔNG gõ mã ⇒ vào.
   Chồng `saas-c-shared-identity` — nếu Identity V2 sắp thay chỉ mục thì vẫn nên vá một dòng ngay, vì mọi khách do admin tạo hôm nay
   đều kẹt.
2. **[P1] Gửi lại lời mời / tạo lại liên kết kích hoạt** từ `/platform/customers/<mã>` (blocker 5): action mới trong `lib/actions/saas.ts`
   gọi lại đúng hàm tạo liên kết của job, có lý do, ghi nhật ký nền tảng.
3. **[P1] Trang đăng nhập theo thương hiệu host** (blocker 3): `app/login` đọc `hostBrand()`; host Chốt Đơn không in «VNXcommerce ·
   Hệ thống quản trị bán hàng» và ba lợi ích của ERP.
4. **[P1] `ConfirmWithReason` có `children`**: đưa ô lý do + nút xuống DƯỚI các ô nhập, hoặc nút luôn bật và hộp thoại hỏi lý do
   (`components/platform/pilot-ops.tsx`). Ảnh hưởng mọi form vận hành.
5. **[P1] Danh sách khách**: 3 cột Messenger · AI · đăng nhập cuối + thao tác nhanh (§1.2) — `lib/saas/console.ts`,
   `app/(dashboard)/platform/customers/page.tsx`.
6. **[P2] Tiêu đề theo menu vỏ** cho Sản phẩm / Nhân viên / Gói (F-10, ngoài claim) và F-16 (`pctOrNull` ở `/customers`).
7. **[P2] `lib/saas/visibility.ts::CUSTOMER_AI_STATE_HINT.NEEDS_SETUP`** nói «liên hệ hỗ trợ» mà không có kênh — PR này đặt lối liên
   hệ ngay dưới bảng sẵn sàng; câu gốc vẫn nên trỏ tới `/help`.

## 5. PRODUCT DECISION (chủ shop)

- Thêm mục «Đơn hàng» / «Hiệu quả» / «Tự động hoá» vào menu vỏ (hiện khoá 8 mục, F-11).
- Vai trò rút gọn trong vỏ (Chủ shop · Nhân viên bán hàng · Chỉ xem) thay ma trận 776 ô (F-09) — đổi quyền phải hỏi (AGENTS §7).
- Gói Dùng thử: in «dùng thử tới ngày …» thay `—` ở doanh thu kỳ (blocker 9) — liên quan bảng giá V1 (`saas-d-pricing-overage`).
- Mặc định thương hiệu khi admin tạo khách chỉ chọn Chốt Đơn: nên tự `chotdon` (hiện trống ⇒ khách rơi vào vỏ ERP).

## 6. META EXTERNAL

`meta-messenger-access` — không có workaround đúng chính sách; mọi việc «nhận tin · AI trả lời · chốt đơn thật» đứng sau nó.

## 7. Cách đo lại

1. Cây riêng từ `origin/main`, `npm ci`, `npm run build`.
2. `DATABASE_URL=pglite://./data/pglite-fl ADMIN_EMAIL=… ADMIN_PASSWORD=… AUTH_SECRET=… PLATFORM_SECRETS_KEY=… npx tsx --tsconfig tsconfig.json scripts/seed-admin.ts`
3. `… CHOTDON_DOMAIN=chotdon.test CHOTDON_APP_URL=http://app.chotdon.test:3321 PLATFORM_SIGNUP_MODE=open npx next start -p 3321`
4. Chrome headless (playwright-core) với `--host-resolver-rules="MAP app.chotdon.test 127.0.0.1"`; đăng nhập bằng `page.evaluate(() => form.submit)`
   (form là Server Action). Tạo khách ở `/platform/customers` (gõ lý do TRƯỚC khi bấm «Tạo khách…»), lấy liên kết `/reset/<mã>/<token>`
   trong khung kết quả, mở ở host Chốt Đơn, đặt mật khẩu, rồi đăng nhập — có và không có mã tổ chức.
5. Mỗi đường đo: đích sau chuyển hướng · `h1` · tràn ngang · số phần tử bấm < 32 px · `scrollY` lúc mở · chữ trong danh sách cấm.

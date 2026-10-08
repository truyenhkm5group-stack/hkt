# Finish line — Round 2: chấp nhận production (08/10/2026, chiều)

*Sứ mệnh `saas-finish-line-r2` · R1 · theo lệnh LAUNCH SPRINT §7 của Tech Lead (phiên `code-erp-e5`). Production = `aa4b69ce`
(deploy run 37781964748). Hai persona: **Platform Admin** và **External Paying Customer**. Đo ở hai nơi:*
- *Cục bộ: cây mới từ `origin/main` `5c781cd5` (= production + #684), PGlite, host `app.chotdon.test`, Chrome headless riêng, 1366×768 và 390×844 — có đăng nhập, có tạo khách.*
- *Production thật: CHỈ trang công khai, chỉ đọc, không đăng nhập, không gửi form (13 đường × 2 khổ). Phần có đăng nhập trên production là ops `saas-acceptance` của Tech Lead.*

*Mọi cửa hàng, tài khoản, liên kết trong tài liệu là dữ liệu giả. Ảnh chụp chỉ ở máy người đo (kho PUBLIC). Chấm theo
`docs/saas/LAUNCH_GATE.md` §0: ✅ PROD = 1 · 🟡 CODE (đo cục bộ trên đúng bản production) = 0,5 · 🔧 WIP = 0 · ❌ = 0 · ⛔ Meta không tính nội bộ.*

## 0. Kết luận

| | Điểm | Ghi chú |
|---|---|---|
| **ADMIN** (A1–A10) | **6,0 / 10 = 60 %** | 🟡 ×10 (tất cả đo được cục bộ, chưa mục nào ✅ PROD vì chưa đăng nhập production); A7 · A8 · A10 đang 🔧 (#683) nhưng ĐÃ có đường đọc ở `/platform/org/<mã>` nên chấm 🟡 theo bằng chứng, trừ A10 (🔧) |
| **KHÁCH** (C1–C19, bỏ C6 Meta) | **8,5 / 18 = 47 %** | 🟡 ×17 đo cục bộ; C8 · C10 · C12–C17 (nhận tin · AI trả lời · đơn) KHÔNG tái hiện được trên máy này (cần kênh thật) ⇒ giữ 🟡 theo bằng chứng mã của Launch Gate |
| **BẢO MẬT** (S1–S4) | 2,5 / 4 | giữ nguyên bảng Launch Gate; S1 kiểm thêm 5 đường từ khách (§3) |
| **P0 nội bộ** | **0** | P0 C2 (đăng nhập email) ĐÃ hết — đo 3/3 lượt, hai host, 1,1–1,5 giây |
| **P1** | 3 (§4) | #682 default thương hiệu (Tech Lead đang làm, xác nhận lại bằng số), thương hiệu VNX ngay sau đặt mật khẩu trên host Chốt Đơn (MỚI), ma trận 786 ô ở Nhân viên (cũ) |

**Đích Round 2 (Admin ≥ 90 %, Khách ≥ 90 %) chưa đạt** theo cách chấm của Launch Gate, và KHÔNG đạt được bằng kiểm cục bộ: mỗi
mục chỉ lên 1,0 khi kiểm trên production có đăng nhập (ops `saas-acceptance`). Về chất lượng, phía khách đã hết P0 và các P1 của
Round 1 đã lên production.

## 1. ADMIN — từng mục Launch Gate

| # | Mục | Chấm | Bằng chứng (cục bộ, `5c781cd5`) |
|---|---|---|---|
| A1 | Tạo khách không CSDL / script | 🟡 | Form «Tạo khách mới» → job 5 bước `ACCOUNT → WORKSPACE → ADMIN → SUBSCRIPTIONS → BILLING` DONE, 10,4 giây; không sửa CSDL. Nút «Tạo khách…» vẫn mờ tới khi gõ lý do (P1 cũ, #682 có thể chạm) |
| A2 | Tài khoản / quản trị được cấp | 🟡 | Job ADMIN:DONE «tạo chu@…test — kích hoạt bằng liên kết dùng một lần»; nhật ký `PASSWORD_RESET_LINK` |
| A3 | Gán sản phẩm Chốt Đơn | 🟡 | Mặc định tick đúng «Chốt Đơn Tự Động»; thuê bao `chotdon` mở ngay trong job (SUBSCRIPTIONS:DONE (chotdon)) |
| A4 | Gán gói / thuê bao | 🟡 | Gói `trial`; BILLING:DONE «ghim giá **v1-2026-10** · dùng thử 7 ngày tới hết 14/10/2026» ⇒ khách mới ghim V1 (trả lời câu hỏi của Launch Gate). Danh sách khách in «gói không niêm yết giá» và «Doanh thu kỳ —» cho gói dùng thử (P2 cũ) |
| A5 | Gửi / gửi lại lời mời | 🟡 | Trang khách: «Chưa kích hoạt — liên kết còn hạn · hết hạn lúc 21:22 09/10»; nút «Gửi lại liên kết kích hoạt» → hộp xác nhận nói rõ liên kết cũ hết hiệu lực → liên kết mới hiện MỘT lần trong ô chỉ đọc có nút sao chép; nhật ký ghi `PASSWORD_RESET_LINK … Gửi lại liên kết kích hoạt: <lý do>`; mở lại liên kết CŨ ⇒ «Không mở được liên kết» |
| A6 | Thấy trạng thái cấp phát | 🟡 | Khối «Job cấp phát»: từng bước, lần chạy, người yêu cầu, nút Chạy lại khi FAILED |
| A7 | Sức khoẻ Messenger / kênh | 🟡 | Có ở `/platform/org/<mã>` (Kết nối · chẩn đoán); chưa ở danh sách (#683) |
| A8 | Sức khoẻ AI | 🟡 | Có ở `/platform/org/<mã>` («AI của workspace», nguồn, khoá); chưa ở danh sách (#683) |
| A9 | Gói / mức dùng | 🟡 | Chi tiết khách: 7 dòng dùng kỳ (Khách AI · hội thoại · tin · đơn AI · lượt gọi · chi phí AI) với nguồn `EVENT_LEDGER` / `DAILY_SNAPSHOT` / `AI_LEDGER` và «—» khi chưa có ngày chụp (đúng luật 42) |
| A10 | Nhận ra khách có vấn đề | 🔧 | Danh sách chỉ có cờ «Lỗ gộp · quá hạn · cấp phát hỏng · chi phí chưa biết»; mức HEALTHY / NEEDS ATTENTION / CRITICAL là #683 |

Số liệu thêm cho admin: `/platform` 1,5 giây, `/platform/customers` 0,8–1,0 giây, chi tiết khách 1,0 giây, `/platform/org/<mã>` 1,0 giây
(máy cục bộ, không phải số hiệu năng). Ô «Thuê bao sống · 0 dùng thử» trong khi hai khách đang ở gói «Dùng thử» (thuê bao `ACTIVE`
gói `trial`, không phải trạng thái `TRIAL`) — P2, chữ gây hiểu nhầm.

## 2. KHÁCH — từng mục Launch Gate

| # | Mục | Chấm | Bằng chứng |
|---|---|---|---|
| C1 | Kích hoạt | 🟡 | `/reset/<mã>/<token>` trên host Chốt Đơn: tên cửa hàng, email, hai ô mật khẩu, «Đã đổi mật khẩu»; liên kết dùng một lần (mở lại ⇒ từ chối) |
| C2 | Đăng nhập email + mật khẩu | 🟡 (**P0 đã hết**) | KHÔNG gõ mã tổ chức: host Chốt Đơn 1,3 s và 1,5 s · host chính 1,1 s; vào thẳng vỏ `data-shell="sales-agent"`, `h1 = Hội thoại`. Round 1 cùng kịch bản: «sai mật khẩu» 2/2 |
| C3 | Vỏ không lộ nội bộ | 🟡 | Khoá AI / model / USD: không thấy ở 21 đường. Còn chữ kỹ thuật ở AI Sales (webhook · token · ERP · API · TEST · Field), Nhân viên (webhook · module · ERP · API), Gói (webhook · API — chip tính năng), Kết nối (connector…), Thiết lập (module · ERP) — PR này sửa chip tính năng; phần còn lại `saas-l1-followup` |
| C4 | Hướng dẫn bước tiếp theo | 🟡 | Hộp thư rỗng: «Chưa có tin khách vì cửa hàng chưa nối kênh» + nút Kết nối Facebook; `/help` 9 bài cho vỏ, 0 chữ cấm, tầng liên hệ; `/automations` ⇒ «Không có trang này»; Số dư AI cờ tắt ⇒ câu rõ (tất cả = #680 đã production) |
| C5 | Thiết lập sản phẩm | 🟡 | `/products` «Tạo sản phẩm» · «Nhập từ tệp»; `/inventory/receipts` mở được trong vỏ |
| C6 | Nối Facebook | ⛔ | Meta — `/ai/channels` hiện «Kết nối Facebook của nền tảng đang được bảo trì» khi app chưa khai (cục bộ) |
| C7 | Hộp thư mở được | 🟡 | `/` ⇒ `/ai/sales-chatbot/inbox` 0,7–3,3 s (390 px lượt đầu 3,3 s khi máy đang chạy bài kiểm) |
| C8–C17 | Tin · nhân viên trả lời · AI · tiếp quản · đơn · xác nhận · OMS · không trùng | 🟡 | KHÔNG tái hiện được cục bộ (không có kênh thật, không khoá AI) — giữ chấm theo bằng chứng mã của Launch Gate; ops `saas-acceptance` (chat web → AI → đơn → OMS) là bằng chứng production |
| C18 | Đồng hồ dùng / hạn mức | 🟡 | Trang Gói: «Khách AI tháng này 0 / 100 · Fanpage 0 / 1 · Người dùng 1 / 2»; chi tiết khách phía admin cùng số |
| C19 | Điện thoại | 🟡 | 17/17 đường 390 px: 0 tràn ngang; AI Sales `scrollY = 0` (Round 1: 7.522); thanh dưới 4 mục + Thêm. Còn: Nhân viên 786 ô < 32 px, cao 4.296 px (P1 cũ) |

## 3. Production công khai (chỉ đọc, 13 đường × 2 khổ) + cô lập

| Đường | Kết quả |
|---|---|
| `chotdontudong.com/` | 200, h1 «Không bỏ lỡ tin nhắn nào…», 14.337 px (390: 24.187 px), 0 tràn, 0 lỗi console |
| `/pricing` (cả hai host) | 200, h1 «Bảng giá», `chotdontudong.com/pricing` ⇒ 302 về `app.` |
| `/dieu-khoan-su-dung` · `/chinh-sach-bao-mat` | 200; văn bản pháp lý có chữ «module», «token · API · Gemini» — chấp nhận được trong văn bản pháp lý (khai nhà cung cấp AI), không phải lỗi UI |
| `app.chotdontudong.com/login` | 200, thương hiệu Chốt Đơn đúng (logo, «Nhân viên bán hàng AI», chân trang «một sản phẩm của VNXcommerce»), Google / Facebook / email, «Tạo miễn phí» |
| `/start` | 200, hiển thị (KHÔNG gửi): «Chỉ cần AI bán hàng» chọn sẵn, 7 ngành, 390 px gọn. `PLATFORM_SIGNUP_MODE=open` (LOW đã biết) |
| `/khong-co-trang-nay` · `/automations` · `/ai/sales-chatbot/inbox` · `/platform/customers` (chưa đăng nhập) | 307 ⇒ `/login?next=…` — không lộ gì |
| `/chat` | 200 «Chưa mở chat» (host không gắn cửa hàng) |
| `/reset/abc/def` | 200 «Không mở được liên kết» (không lộ lý do cụ thể) |
| `erp.vnxcommerce.com/login` | 200 (thương hiệu VNX) |
| Lỗi 5xx / pageerror | 0 / 26 lượt |

**Cô lập (S1, từ tài khoản khách B cục bộ):** `/platform`, `/platform/customers/<mã khách A>`, `/settings/modules`, `/products/performance`,
`/reports` ⇒ về Hội thoại kèm «ngoài gói»; không trang nào trả dữ liệu của tổ chức khác. CI tenant-attack vẫn là bằng chứng chính.

## 4. Phát hiện

| # | Mức | Persona · tuyến | Tái hiện | Mong đợi | Thực tế | Bằng chứng |
|---|---|---|---|---|---|---|
| R2-1 | **P1** (mới) | Khách · `/reset/<mã>/<token>` → `/login?reason=password-changed` trên host Chốt Đơn | Đặt mật khẩu qua liên kết kích hoạt trên `app.chotdon.test` (cục bộ) | Trang đăng nhập mang thương hiệu Chốt Đơn | Trang mang **VNXcommerce · HỆ THỐNG QUẢN TRỊ BÁN HÀNG** + ba lợi ích của ERP; tải lại trang thì đúng Chốt Đơn. `curl` cùng URL (cả production `app.chotdontudong.com/login?reason=password-changed`) trả HTML Chốt Đơn ⇒ lỗi nằm ở lượt dựng SAU `redirect()` của server action (`lib/actions/password-reset.ts:31`): `app/login/page.tsx:87` đọc `hostBrand()` từ header do middleware đặt, lượt dựng trong POST action có vẻ không mang header ấy ⇒ rơi về `vnx` | Ảnh `r2b-after-activate.png`; Round 1 cũng thấy (ghi là blocker 3 nhưng gán nhầm cho trang đăng nhập) |
| R2-2 | P1 (xác nhận #682) | Admin · Tạo khách | Để «Thương hiệu (mặc định)», chỉ tick Chốt Đơn | Khách vào vỏ Chốt Đơn | Khách vào **vỏ ERP** (`h1 = Bắt đầu`), liên kết kích hoạt mang host `localhost` (APP_URL) thay vì host Chốt Đơn | `r2-admin-result.json`: `loginNoOrg_*.h1 = "Bắt đầu"`; r2b với BRAND=chotdon ⇒ `shell = sales-agent` |
| R2-3 | P1 (cũ) | Khách · `/settings/users` 390 px | Mở Nhân viên | Danh sách người + mời | 786 ô < 32 px, 4.296 px (chủ shop quyết vai trò rút gọn) | đo lại giống Round 1 |
| R2-4 | P2 | Admin · `/platform/customers` | Hai khách gói «Dùng thử» | Ô «Thuê bao sống» nói 2 dùng thử | «0 dùng thử» (đếm trạng thái `TRIAL`, thuê bao ở `ACTIVE` gói `trial`) | text dump |
| R2-5 | P2 | Admin · `/platform/customers` | Khách gói trial | Doanh thu kỳ «dùng thử tới 14/10» | «—» + «2 khách có gói không niêm yết giá» | như Round 1 blocker 9 |
| R2-6 | P2 | Khách · `/settings/plan` | Xem gói | Chữ khách hiểu | Chip «API · Webhook» | sửa trong PR này (`lib/pricing/features.ts`) |
| R2-7 | P2 | Khách · Sản phẩm / Nhân viên / Gói | Mở từ menu | Tiêu đề = tên menu | «Sản phẩm & tồn kho · Kho», «Người dùng · Hệ thống», «Gói & thanh toán · Hệ thống» | sửa trong PR này |
| R2-8 | P2 | ERP · `/customers` | Kỳ chưa có đơn | «—» | «0.0%» + màu theo ngưỡng `>= 10` viết cứng | sửa trong PR này (luật 42 · 38) |

Không phát hiện P0 nội bộ. Không lỗi 5xx, không pageerror ở cả cục bộ (42 lượt) lẫn production công khai (26 lượt); một lỗi console
404 tài nguyên trên host thử cục bộ (biểu tượng), không phải lỗi trang.

## 5. Sửa trong PR này (R1, ngoài danh sách tệp Tech Lead giữ)

- Tiêu đề theo menu vỏ: Sản phẩm · Gói dịch vụ (`app/(dashboard)/products/page.tsx`, `settings/plan/page.tsx` — chỉ đổi
  `eyebrow` / `title` khi `isSalesAgentUser`). Trang Nhân viên để cho sứ mệnh `saas-shell-polish` của Tech Lead (cùng tệp với
  việc gỡ chữ kỹ thuật), tránh va chạm.
- `/customers`: tỷ lệ hoàn dùng `pctOrNull` + `formatPercent` (mẫu số 0 ⇒ «—»), bỏ ngưỡng màu `>= 10`.
- Nhãn tính năng gói: «API» ⇒ «Kết nối phần mềm khác (API)», «Webhook» ⇒ «Tự báo sự kiện sang phần mềm khác» (`lib/pricing/features.ts`).

## 6. Handoff Tech Lead

1. **R2-1** thương hiệu sau `redirect()` của server action trên host Chốt Đơn (`app/login/page.tsx` · `lib/platform/host-brand.ts` ·
   middleware) — vùng auth/middleware, không sửa ở đây. Cách kiểm: đặt mật khẩu trên host Chốt Đơn ⇒ trang đăng nhập hiện ra phải có
   «Nhân viên bán hàng AI», không «Hệ thống quản trị bán hàng». Có thể cùng mẫu với các `redirect()` khác sau action (đăng ký, đăng xuất).
2. #682: xác nhận bằng số ở R2-2; thêm: liên kết kích hoạt phải mang host theo thương hiệu (hiện `localhost`/APP_URL khi brand trống).
3. #683: A7 · A8 · A10 — không thêm gì mới.
4. R2-4 (ô «dùng thử») và R2-5 (doanh thu gói trial) — nằm trong `app/(dashboard)/platform/customers/*` (#683 đang giữ), ghi để gộp.

## 7. Cách đo lại

Như Round 1 §7, thêm: tạo khách KHÔNG chọn thương hiệu (R2-2) và CÓ chọn «Chốt Đơn»; từ trang khách bấm «Gửi lại liên kết kích hoạt»,
mở liên kết CŨ (phải bị từ chối) rồi liên kết MỚI; đăng nhập KHÔNG mở «Đăng nhập bằng mã tổ chức» trên cả hai host.

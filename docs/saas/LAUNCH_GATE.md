# Launch Gate — khách trả tiền ĐẦU TIÊN của Chốt Đơn Tự Động

> Nguồn sự thật DUY NHẤT cho câu hỏi «đã bán được cho khách trả tiền đầu tiên chưa». Mở ngày 08/10/2026 khi chủ shop chuyển
> MASTER MISSION sang LAUNCH SPRINT. Integration Lead cập nhật sau mỗi lượt deploy — mỗi dòng phải trỏ tới BẰNG CHỨNG (PR, run,
> lượt smoke, ops), không trỏ tới ý định. Phạm vi bị ĐÓNG BĂNG: chỉ làm việc cải thiện kích hoạt · độ tin cậy · độ đúng của đơn ·
> thời gian tới giá trị · sẵn sàng thu tiền, cho tới khi cổng ĐẠT (Product Opportunity Backlog giữ phần còn lại).

## 0. Cách chấm

| Ký hiệu | Nghĩa | Tính vào % |
|---|---|---|
| ✅ PROD | Đã kiểm trên PRODUCTION, có bằng chứng | 1 |
| 🟡 CODE | Có mã + bài kiểm, CHƯA kiểm trên production | 0,5 |
| 🔧 WIP | Đang có PR / nhánh làm | 0 |
| ❌ THIẾU | Chưa ai làm | 0 |
| ⛔ NGOÀI | Chờ bên ngoài (Meta) | 0, nhưng không tính vào «nội bộ» |

Cổng ĐẠT khi: 0 P0 · P1 quan trọng đã xử lý · Admin ≥ 90 % · Khách ≥ 90 % · smoke production xanh. Chỉ còn Meta ⇒
**READY PENDING META**. Meta duyệt + smoke bằng tài khoản / Page KHÔNG có vai trò trong app ⇒ **READY FOR FIRST PAYING CUSTOMER**.

## 1. ADMIN

| # | Mục | Trạng thái | Bằng chứng / việc còn lại |
|---|---|---|---|
| A1 | Tạo khách không cần CSDL / script | 🟡 CODE | Form «Tạo khách mới» + job cấp phát (`lib/saas/provisioning.ts`); Finish Line đo 11/15 việc admin làm được. Nút khoá không nói vì sao (FINISH_LINE #6) — P1 |
| A2 | Tài khoản / quản trị khách được cấp | 🟡 CODE | `lib/platform/provision.ts`; P0 danh tính (A–I) đang sửa |
| A3 | Gán sản phẩm Chốt Đơn | 🟡 CODE | Thuê bao sản phẩm theo module (#670 đã lên production cho đường tự đăng ký; đường admin cần kiểm lại) |
| A4 | Gán gói / thuê bao | 🟡 CODE | Kiểm chỉ đọc đang chạy: khách mới ghim V1 hay legacy |
| A5 | Gửi / gửi lại lời mời | 🔧 WIP | `fix/identity-email-login` (nút gửi lại + trạng thái lời mời) |
| A6 | Thấy trạng thái cấp phát | 🟡 CODE | Trang chi tiết khách đọc job |
| A7 | Thấy sức khoẻ Messenger / kênh | 🔧 WIP | `feat/customer-health` |
| A8 | Thấy sức khoẻ AI | 🔧 WIP | `feat/customer-health` (hôm nay chỉ ở `/platform/org/<mã>`) |
| A9 | Thấy gói / mức dùng | 🟡 CODE | Danh sách khách có gói; mức dùng ở chi tiết |
| A10 | Nhận ra khách có vấn đề | 🔧 WIP | `feat/customer-health` (HEALTHY / NEEDS ATTENTION / CRITICAL từ dữ liệu thật) |

## 2. KHÁCH

| # | Mục | Trạng thái | Bằng chứng / việc còn lại |
|---|---|---|---|
| C1 | Kích hoạt (đặt mật khẩu) | 🟡 CODE | Liên kết `/reset/<mã>/<token>` |
| C2 | Đăng nhập email + mật khẩu | 🔧 WIP **P0** | Khách do admin tạo chỉ vào được bằng mã tổ chức — `fix/identity-email-login` |
| C3 | Vỏ không lộ nội bộ | 🟡 CODE | #669 (khoá AI / model / USD) đã lên production; còn chữ «webhook · API» ở `/settings/users`, chip gói (FINISH_LINE #7) |
| C4 | Hướng dẫn bước tiếp theo | 🔧 WIP | `claude/saas-finish-line` (trạng thái rỗng · Hướng dẫn · 404) đang tích hợp |
| C5 | Thiết lập sản phẩm | 🟡 CODE | Nhập sản phẩm / mẫu ngành |
| C6 | Nối Facebook | ⛔ NGOÀI | Meta chưa cấp quyền Page — `docs/meta-app-review/HUONG_DAN_CHU_SHOP.md`. Kênh thay thế lúc chờ: Pancake · chat web · Zalo |
| C7 | Hộp thư mở được | 🟡 CODE | F-01 trang trắng sau đăng nhập đã hết (#671, production) |
| C8 | Tin khách vào hộp thư | 🟡 CODE | Pancake / chat web; Meta trực tiếp chờ duyệt |
| C9 | Nhân viên trả lời | 🟡 CODE | `sendStaffReplyCore`; #661 / #666 câu mẫu + sản phẩm |
| C10 | AI trả lời | 🟡 CODE | Bot HSLC chạy thật hằng ngày (bằng chứng vận hành, không phải smoke khách mới) |
| C11 | Tiếp quản / trả lại AI | 🟡 CODE | #633 |
| C12 | Tạo đơn nháp từ hội thoại | 🟡 CODE | Golden v2 (#664) |
| C13 | SKU / SL / SĐT / địa chỉ đúng | 🟡 CODE | Golden v2: SKU 29/29 · SL 34/34 · SĐT 28/29 · địa chỉ 87/87 |
| C14 | Dữ liệu mơ hồ ⇒ cần người kiểm | 🟡 CODE | #675 (xã chưa ghép / khách huỷ ⇒ cờ cần kiểm) |
| C15 | Xác nhận tay | 🟡 CODE | #675 nút nhanh Xác nhận / Huỷ |
| C16 | Đơn hợp lệ vào OMS | 🟡 CODE | Đơn ERP |
| C17 | Không đơn trùng | 🟡 CODE | Golden v2: đơn trùng 0/30 |
| C18 | Đồng hồ dùng / hạn mức đúng | 🟡 CODE | AI_CUSTOMER (0228); kiểm trên khách thử |
| C19 | Luồng chính dùng được trên điện thoại | 🟡 CODE | Kiểm vỏ 390 px (SHELL_AUDIT); `/settings/users` 786 phần tử nhỏ — P1 |

## 3. BẢO MẬT

| # | Mục | Trạng thái | Bằng chứng |
|---|---|---|---|
| S1 | Cô lập tổ chức | 🟡 CODE | tenant-attack (247 mặt bằng), ai-sales-isolation 26 đòn × 2 chiều — CI mỗi PR |
| S2 | Bí mật ẩn | 🟡 CODE | lá chắn connectors (chỉ service giải mã), ops-log-leak |
| S3 | Token page mã hoá | 🟡 CODE | AES-256-GCM `lib/connectors/secrets.ts` |
| S4 | Không lộ chi phí / nhà cung cấp cho khách | ✅ PROD | #669 lên production 08/10 (deploy 3a28e83e) |

## 4. Kiểm được khi Meta duyệt (smoke tài khoản NGOÀI)

OAuth → tìm Page → nối → subscribe → khách nhắn Messenger → hộp thư nhận → AI trả lời → đơn nháp → tạo đơn. Bằng tài khoản Facebook
/ Page KHÔNG có vai trò trong app. Chỉ khi đạt mới ghi META DIRECT sẵn sàng production.

## 5. Tài khoản kiểm thử production (bắt buộc cho smoke tất định)

| Tài khoản | Trạng thái |
|---|---|
| 1 người vận hành nền tảng (kiểm thử) | ❌ chưa có — tạo tài khoản có quyền người vận hành là quyết định quyền (AGENTS §7) |
| 1 khách EXTERNAL kiểm thử + 1 workspace kiểm thử | ❌ tạo sau khi P0 danh tính lên production, bằng đúng đường admin |
| 1 Page Facebook kiểm thử | ⛔ dùng Page có vai trò trong app trong lúc chờ Meta |

Không dùng dữ liệu khách thật theo cách phá huỷ.

## 6. Phân loại việc đang chạy (WIP)

| Việc | Loại |
|---|---|
| Tích hợp Finish Line (`claude/saas-finish-line`) | LAUNCH BLOCKER |
| P0 danh tính email + gửi lại lời mời (`fix/identity-email-login`) | LAUNCH BLOCKER |
| Sức khoẻ khách (`feat/customer-health`) | LAUNCH SUPPORT |
| Luật chốt đơn 08/10 (#675) | LAUNCH SUPPORT (đã gộp) |
| Chuyển giá legacy → V1 (#676) | POST-LAUNCH (đã duyệt; không chặn nếu khách mới ghim V1 đúng) |
| HSLC trả trước (#674) · HSLC SKU / giá sỉ (#677) | CUSTOMER-SPECIFIC |
| Xoá cửa hàng tự đăng ký cũ (#673) | CUSTOMER-SPECIFIC (dọn dữ liệu theo quyết định chủ shop) |
| Meta App Review | EXTERNAL BLOCKED |
| Worker /tech một nút (#631) | POST-LAUNCH (CRITICAL — chủ shop gộp) |

## 7. Nhật ký cập nhật

| Lúc | Thay đổi |
|---|---|
| 08/10/2026 | Mở cổng. Readiness (🟡 = 0,5): Admin 3/10 (30 %) · Khách 8/19 (42 %; 8/18 = 44 % nếu bỏ mục Meta) · Bảo mật 2,5/4 · Tổng 13,5/33 = 41 %. Đã kiểm production thật: 1/33. P0 còn: C2 đăng nhập email. NOT READY |

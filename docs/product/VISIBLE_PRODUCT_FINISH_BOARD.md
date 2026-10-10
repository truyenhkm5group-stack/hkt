# VISIBLE PRODUCT FINISH BOARD — bảng hoàn tất theo thứ chủ shop NHÌN THẤY

*Lập 10/10/2026 theo lệnh chủ shop. Ngắn có chủ đích. Đây là bảng KPI chính; số PR đã gộp không còn là KPI chính.*

## Definition of Done (từ 10/10/2026)

REQUIREMENT → CODE → TEST → MERGE → DEPLOY → **MỞ TRANG THẬT TRÊN PRODUCTION** → VERIFY → **ẢNH TRƯỚC / SAU** (cùng trang, cùng khổ màn hình).
Logic không nhìn thấy được ⇒ bằng chứng production (chạy ops) thay cho ảnh. Audit · tài liệu · bài kiểm · đã gộp · đã deploy mà chưa mở trang
**≠ DONE**. «Đã kiểm kê 207/207 trang» không phải bằng chứng hoàn tất.

**STATUS:** `NOT_STARTED` · `PARTIAL` · `PR_READY` · `DEPLOYED_NOT_VERIFIED` · `PRODUCTION_VERIFIED` · `DONE`.
Bề mặt đã có ảnh trước / sau trên production: **Inbox** (V2-A + V2-B) · **Cấu hình AI Sales** · **Sản phẩm (phía ERP)** — production `6487e6526d04`, 10/10/2026. Các dòng còn lại chưa có
ảnh ⇒ chưa dòng nào khác PRODUCTION_VERIFIED. Logic đã có run ops (vd `saas-acceptance` PASS 7/7, run 37935922309: tạo khách · kích hoạt ·
đăng nhập · vỏ · chat → AI → đơn) chỉ nâng phần logic; phần nhìn thấy vẫn «chưa có ảnh» ⇒ tối đa `DEPLOYED_NOT_VERIFIED`. Cột PR chỉ ghi
PR đã gộp; «đã deploy» chưa được xác nhận bằng cách mở trang nên ghi `—` ở cột SHA.

**Ảnh:** ảnh chụp workspace khách thật (HSLC) có tên · SĐT · địa chỉ khách ⇒ **KHÔNG đưa vào kho** (kho PUBLIC). Bảng ghi SỐ ĐO cùng tên
tệp ảnh giữ ngoài kho (`.playwright-mcp/<tên>.png` trên máy Tech Lead); chỉ ảnh của workspace thử / dữ liệu mẫu mới được đưa vào
`docs/product/evidence/<bề-mặt>/<before|after>-<khổ>.png`. Khổ chuẩn: 1366×768 · 1440×900 · 390×844.

## Bằng chứng production

| Bề mặt | Production | Đo trước → sau | Ảnh (ngoài kho) |
|---|---|---|---|
| Inbox V2-A — mật độ | `d307dec424c5` (#748) | Dòng hội thoại đầu tiên ở y=502 → **172**; số dòng thấy được: 1366×768 **3 → 10** · 1440×900 **4 → 12** · 390×844 **4 → 11**; cao một dòng 87 → 56 px; không cuộn ngang ở cả ba khổ | `inbox-before-*` · `inbox-after-*` |
| Inbox V2-A — chưa đọc lên đầu | `d307dec424c5` | **PASS.** Trang đầu toàn tin chưa đọc (≈2,1k chưa đọc) nên không tự chứng minh; tìm «Ngân» (9 hội thoại) rồi mở hội thoại chưa đọc MỚI NHẤT (11 giờ) ⇒ tải lại nó đứng SAU các hội thoại chưa đọc 3–4 ngày. «Chờ trả lời» cố ý xếp khách chờ lâu nhất trước (`inboxOrderBy`) | `inbox-after-unread-first-proof-1366x768` |
| Inbox V2-A — lọc gọn | `d307dec424c5` | **PASS.** Tìm kiếm + 4 nút nhanh (Chưa đọc 2,1k · Chờ trả lời · Cần người · Của tôi) + «Lọc ▾»; bảng lọc nâng cao mở được ở 390 (trạng thái · kênh · AI/người · nhân viên · SĐT · level) | `inbox-after-1366x768` · `inbox-after-filter-popover-390x844` |
| Inbox V2-B — «ĐƠN ĐANG CHỐT» | `e21f0ec35b25` (#753) | Trước: cột phải chỉ có khách + lịch sử + danh sách đơn. Sau: khung đơn đầu cột phải — SKU · biến thể · SL × giá · tiền hàng · phí ship («0 ₫ nếu đúng khu vực») · tổng · tên · SĐT · địa chỉ · tỉnh · xã · 5 ô kiểm (SĐT/Địa chỉ/SKU/SL OK · Giá CẦN KIỂM vì miễn ship có điều kiện, lý do in ngay dưới) + trạng thái «ĐÃ XÁC NHẬN». 390: mở bằng nút «Khách, đơn và ghi chú», không cuộn ngang | `inbox-v2b-before-*` · `inbox-v2b-after-*` |
| Cấu hình AI Sales | `6487e6526d04` (#756 #768) | Trước: trang mở đầu bằng thẻ đồng bộ đơn, không câu «bot có đang chạy không», dài 8.097 px. Sau: ô «**Đang chạy** — Bot đang trả lời khách · đang nhận tin từ Fanpage, Trang chat» + MỘT nút «Mở hộp thư»; 4 nhóm cài đặt; không tên hãng / model / USD; dài **5.483 px**. 390: trước 622 px tràn ngang → **382 px** (#768) | `ai-settings-before-*` · `ai-settings-after-1366x768` · `ai-settings-after-390x844-fixed` |
| Sản phẩm (phía ERP) | `6487e6526d04` (#757) | «0 kho» → «Chưa khai kho — tồn tính chung theo phiếu kho»; «1.62 tỷ» → «**1,62 tỷ**»; «8.808 sản phẩm» → «8.808 **đơn vị hàng**»; giá bán 120.000 / 150.000 / 250.000 / 350.000 ₫ và giá vốn giữ nguyên | `products-before-*` · `products-after-1366x768` |
| Hộp thư — không thoái lui | `6487e6526d04` | 11 dòng thấy được ở 1366, 4 nút nhanh, khung «ĐƠN ĐANG CHỐT» đọc lại đơn 0,9 s (cửa sổ Chrome thử ẩn ⇒ IntersectionObserver không chạy — không phải lỗi) | — |
| Hành trình khách (ops) | `6487e6526d04` | `saas-acceptance --apply --prep --e2e --e2e-ops` **PASS 8/8** (run 38035198098): đăng nhập · vỏ · sản phẩm · chat → AI → đơn · nhân viên trả lời / tiếp quản · cờ cần kiểm · xác nhận tay → CONFIRMED · không trùng đơn · đồng hồ khách AI | — |

## Thứ tự ưu tiên
1 Inbox · 2 onboarding / dùng lần đầu · 3 cấu hình AI Sales · 4 xác nhận đơn / sự thật đơn · 5 sản phẩm / SKU · 6 quản lý khách (platform) ·
7 giá / mức dùng / thanh toán · 8 nhân viên / tài khoản · 9 website công khai · 10 ERP lưu lượng cao.

## Chuẩn một bề mặt sản phẩm
Thứ bậc rõ · người ít rành máy đọc hiểu · một nút chính · không chữ kỹ thuật · không lộ thông tin nội bộ · có trạng thái đang tải / rỗng / lỗi ·
dùng được trên điện thoại (390) · đủ ở 1366×768 · không cuộn ngang · nhất quán với các trang khác · nhanh · số liệu đúng · không nút chết ·
không điều khiển trùng lặp.

## Hai hành trình
- **Khách:** trang chủ → đăng ký → vào app → nối Messenger → thêm sản phẩm → bật AI → nhận tin ở Inbox → xác nhận đơn → xem mức dùng.
- **Admin:** đăng nhập /platform → tạo khách → gói / thuê bao → xem sức khoẻ → xử lý sự cố → xem thanh toán / mức dùng.

Cột: **Y/c** yêu cầu chủ shop · **Hiện tại** đang chạy (PR) · **Thiếu** · **Đổi nhìn thấy** · **PR** · **SHA** production · **Trước / Sau** ảnh.

## PUBLIC

| Bề mặt | Y/c | Hiện tại | Thiếu | Đổi nhìn thấy | PR | SHA | Trước | Sau | STATUS |
|---|---|---|---|---|---|---|---|---|---|
| chotdontudong.com landing | Nói đúng sản phẩm, một CTA rõ | #706 sửa claim, bỏ Pancake-chính, bỏ «Chi phí AI hiện rõ» | CTA đăng ký chờ D2 (`PLATFORM_SIGNUP_MODE`); chưa đối chiếu ảnh | Landing 1366 + 390, CTA chính | #706 | — | chưa có | chưa có | PARTIAL |
| Bảng giá | Giá V1 rõ, số ngày dùng thử đúng | PRICING_V1 (#627); 7 vs 14 ngày chờ D17 | Chưa mở trang giá | Trang giá đúng 7/14 | — | — | chưa có | chưa có | NOT_STARTED |
| Đăng ký / đăng nhập / quên mật khẩu | Không trang trắng, đúng thương hiệu | #700; saas-acceptance 7/7 chứng minh logic | Ảnh 3 màn | 3 màn ở 390 | #700 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |

## ADMIN (/platform)

| Bề mặt | Y/c | Hiện tại | Thiếu | Đổi nhìn thấy | PR | SHA | Trước | Sau | STATUS |
|---|---|---|---|---|---|---|---|---|---|
| Dashboard | Việc hằng ngày lên đầu | #714 (tổ chức & sức khoẻ, công tắc khẩn lên đầu) | «9 nút không tên» chưa xác nhận trên DOM | Dashboard trước / sau | #714 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Danh sách khách | Biết «khách này có chạy không» < 30 giây | #683 (Messenger · AI · đăng nhập · đơn · hạn mức) | Ảnh | Cột sức khoẻ | #683 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Chi tiết khách | Chẩn đoán 8 loại sự cố | #692; O2–O5 · O7 · O8 chưa chứng minh phát hiện | Ảnh; drill | Khối sự cố | #692 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Tạo khách | Đúng mặc định, nút không khoá im lặng | #682; logic PASS 7/7 (run 37935922309) | Ảnh form | Form trước / sau | #682 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Gói / thuê bao | Gói đang bán, «còn N ngày» | #682; MM-BILL-00 | Ảnh | Khối gói | #682 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Sức khoẻ / chẩn đoán | Tự xử lý sự cố | #692 #710 (9 tổ chức × 8 tín hiệu tính được) | Ảnh | Bảng tín hiệu | #692 #710 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Thanh toán / mức dùng | Doanh thu · biên Số dư AI | mission ai-balance-economics | Ảnh; D4 chặn giao dịch thật | Bảng trước / sau | — | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |

## CUSTOMER (app khách)

| Bề mặt | Y/c | Hiện tại | Thiếu | Đổi nhìn thấy | PR | SHA | Trước | Sau | STATUS |
|---|---|---|---|---|---|---|---|---|---|
| Trang chủ / dashboard | Một việc nên làm tiếp | Vỏ 8 mục; #743 bỏ chữ kỹ thuật | Ảnh | Trước / sau | #743 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Onboarding / dùng lần đầu | Tự cài xong không cần hỏi | #752: danh sách 9 bước ở «Tổng quan», khách vỏ chưa xong 9/9 mở «/» về đó (nghiệm thu bước C xác nhận đường chuyển hướng, run 38035198098) | Ảnh: danh sách chỉ hiện với khách vỏ — trên production chỉ workspace thử là vỏ và nó không có đường đăng nhập cho người ⇒ chờ chủ shop chọn cách | Danh sách 9 bước 1366 + 390 | #752 | `6487e6526d04` | có (HSLC «Tổng quan», ngoài kho) | chưa có | DEPLOYED_NOT_VERIFIED |
| Nối Messenger | Nói đúng «sắp mở» / nối thẳng | #712 (cờ); Meta chưa cấp quyền Page | Phụ thuộc Meta | Trang kết nối | #712 | — | chưa có | chưa có | PARTIAL |
| Inbox | Lọc gọn, chưa đọc lên đầu, mật độ, bong bóng, câu nhanh; khung tóm tắt đơn, trạng thái trường, xác nhận | V2-A (lọc gọn · chưa đọc lên đầu · mật độ · bề mặt · bong bóng · câu nhanh) + V2-B (khung «ĐƠN ĐANG CHỐT» · trạng thái từng trường · nút xác nhận) | Nhiều đơn mở trong một hội thoại · ghi lại sau lỗi · địa chỉ có cấu trúc (chuyển sang «Xác nhận đơn / sự thật đơn») | Xem «Bằng chứng production» | #748 #753 | `e21f0ec35b25` | có (ngoài kho) | có (ngoài kho) | PRODUCTION_VERIFIED |
| Cài chatbot | Câu mẫu dễ dùng; người ít rành máy cài được | #756 ô trạng thái gộp + một nút chính, 4 nhóm cài đặt, nguồn AI / model chỉ ở workspace nhà; #768 không tràn ngang 390 | Ô FAQ / chính sách / khuyến mãi có cấu trúc (cần đổi prompt — việc riêng) | Xem «Bằng chứng production» | #756 #768 | `6487e6526d04` | có (ngoài kho) | có (ngoài kho) | PRODUCTION_VERIFIED |
| Sản phẩm / SKU | «Thêm mẫu mã»; giá vốn chưa biết ≠ 0; khách vỏ thấy danh sách gọn | #757: phía ERP «Chưa khai kho — tồn tính chung theo phiếu kho» · «1,62 tỷ» · «8.808 đơn vị hàng», giá bán / giá vốn / tồn HSLC giữ nguyên; số gọn dùng dấu phẩy toàn ứng dụng | Ảnh danh sách gọn của khách vỏ (cùng lý do Onboarding) | Trang sản phẩm 1366 | #757 | `6487e6526d04` | có (ngoài kho) | có — phía ERP (ngoài kho) | PARTIAL |
| Đơn hàng | Đơn đúng sự thật, xác nhận được | #725 #731 | Ảnh; E2E UI chờ D19 | Chi tiết đơn | #725 #731 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Nhân viên | Chỉ vai trò bán hàng hợp lệ | #735 #741 | Ảnh; D10 | Trang nhân viên | #735 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Mức dùng / hạn mức | Hiểu «còn bao nhiêu» | mission ai-balance-v1 + MM-BILL-00 | Ảnh | Khối mức dùng | — | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Trợ giúp / hướng dẫn | Chỉ hướng dẫn kênh đang chạy | #712 | Ảnh | Trang trợ giúp | #712 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Tài khoản / cài đặt | Không chữ kỹ thuật | #743 | Ảnh | Cài đặt | #743 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |

## ERP LƯU LƯỢNG CAO

| Bề mặt | Y/c | Hiện tại | Thiếu | Đổi nhìn thấy | PR | SHA | Trước | Sau | STATUS |
|---|---|---|---|---|---|---|---|---|---|
| Đơn hàng | Số thật, không bộ đếm Pancake | #715 #722 #731 | Ảnh | Danh sách đơn | #722 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Khách | Giao thành công theo ĐVVC | #715 #722 | Ảnh | Danh sách + chi tiết | #715 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Vận chuyển | COD 0 không điền sai | #717 | Ảnh | Form sửa đơn VTP | #717 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Tồn kho | — | Chưa có yêu cầu nhìn thấy | Chưa lập yêu cầu | — | — | — | chưa có | chưa có | NOT_STARTED |
| Lương | — | /payroll không tràn ngang 390 (#708) | Ảnh | /payroll 390 | #708 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Marketing / báo cáo | Ước tính ≠ số đo | #166 (thang bậc tỷ lệ GTC) | Ảnh | Báo cáo | — | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| /work | Nhanh | #734 (chậm 3,1–4,7 s từ ef9b302a); #738 giữ ấm 3 nguồn | Chưa đo lại bằng trình duyệt | Số đo + ảnh | #734 #738 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |

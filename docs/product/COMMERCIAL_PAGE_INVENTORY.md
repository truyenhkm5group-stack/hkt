# Kiểm kê trang thương mại — Commercial Perfection Sweep (08/10/2026)

*Phase A — CHỈ ĐỌC. Nguồn: `git ls-files app` trên `origin/main` b3a8d74e (207 `page.tsx`), bề mặt / module / quyền / cổng vỏ đọc bằng chính hàm của mã (`moduleOfPath`, `salesAgentPathAllowed`, `NAV_MODULES`, `SALES_AGENT_NAV`); harness Playwright (Chrome headless riêng) quét 163 route tĩnh bằng persona admin nhà ở 1366 px trên dữ liệu demo (10 sản phẩm · 1.126 đơn), 23 route trọng điểm ở 390 + 1920 px, vỏ khách Chốt Đơn 21 + 17 route (tài khoản khách thật do admin tạo), production chỉ trang công khai (GET). Điểm 0–100 chỉ ghi khi NGƯỜI đã xem (Round 1–2 + sweep); còn lại `UNKNOWN` — không bịa điểm. Ảnh chụp ở máy người đo, không vào kho.*

**Tổng 207 trang** · PUBLIC 13 · CUSTOMER+ERP (vỏ Chốt Đơn mở) 37 · ERP 135 · ADMIN 8 · INTERNAL (/tech) 14 · **đã audit (máy hoặc người) 207** (175 harness + 32 trang động đọc mã 09/10) · **đã chấm điểm bởi người 39**.

Ưu tiên: P0 = trang khách trả tiền / công khai / admin · P1 = ERP lưu lượng cao (menu chính) · P2 = ERP trên menu · P3 = chi tiết / nội bộ /tech.

| Route | Bề mặt | Persona | Module | Tiêu đề | Ưu tiên | Mở được | Lối vào | Quyền | Mobile | Audit | Vấn đề | Điểm | Owner | Fix PR | Prod ✓ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| /chat | PUBLIC | A Visitor | - | Chat với shop | P0 | công khai — prod ✓ | link/URL | - | cao | prod công khai | — | UNKNOWN | — | — | ✓ công khai |
| /chat/embed | PUBLIC | A Visitor | - | Chat với shop | P0 | ✓ 200 | link/URL | - | cao | máy (harness) | thiếu h1 | UNKNOWN | — | — | — |
| /chinh-sach-bao-mat | PUBLIC | A Visitor | - | — | P0 | công khai — prod ✓ | link/URL | - | cao | người + máy | LEGAL REVIEW: «token · API · Gemini» (khai nhà cung cấp) | 80 | — | — | ✓ công khai |
| /dieu-khoan-su-dung | PUBLIC | A Visitor | - | — | P0 | công khai — prod ✓ | link/URL | - | cao | người + máy | LEGAL REVIEW: có «module», định dạng dài | 80 | — | — | ✓ công khai |
| /gioi-thieu | PUBLIC | A Visitor | - | — | P0 | công khai — prod ✓ | link/URL | - | cao | người + máy | C1 copy Pancake bắt buộc · claim tuyệt đối · «Chi phí AI hiện rõ»; H1 tốt, 0 tràn, 0 ảnh thiếu alt | 78 | PR A (sweep) | — | ✓ công khai |
| /join/[org]/[token] | PUBLIC | A Visitor | - | — | P0 | động — chưa quét | chi tiết | - | cao | prod công khai | — | UNKNOWN | — | — | — |
| /login | PUBLIC | A Visitor | - | — | P0 | công khai — prod ✓ | link/URL | đăng nhập | cao | người + máy | đúng thương hiệu host; VNX sau redirect() của action (saas-shell-polish) | 86 | saas-shell-polish | — | ✓ công khai |
| /login/chon-cua-hang | PUBLIC | A Visitor | - | — | P0 | ✓ 200 | link/URL | - | cao | máy (harness) | — | UNKNOWN | — | — | — |
| /module-disabled | PUBLIC | A Visitor | - | — | P0 | ✓ 200 | link/URL | đăng nhập | cao | máy (harness) | — | UNKNOWN | saas-shell-polish | — | — |
| /pricing | PUBLIC | A Visitor | - | — | P0 | công khai — prod ✓ | link/URL | - | cao | người + máy | giá đọc từ máy giá, đồng bộ; chip «API · Webhook» (PR r2 sửa) | 88 | saas-finish-line-r2 (5cab7e96) | — | ✓ công khai |
| /print/production/[id] | PUBLIC | A Visitor | - | — | P0 | động — chưa quét | chi tiết | planning:view | cao | prod công khai | — | UNKNOWN | — | — | — |
| /reset/[org]/[token] | PUBLIC | A Visitor | - | — | P0 | động — chưa quét | chi tiết | - | cao | người + máy | rõ, một lần; sau đặt mật khẩu rơi vào trang VNX (saas-shell-polish) | 84 | saas-shell-polish | — | — |
| /start | PUBLIC | A Visitor | - | — | P0 | công khai — prod ✓ | link/URL | - | cao | người + máy | một màn, 390 px gọn; mode open — đồng bộ với CTA | 85 | — | — | ✓ công khai |
| /ai/channels | CUSTOMER+ERP | B/C/D Khách + E/F | ai_sales | Kênh kết nối | P0 | ✓ 200 | menu | ai_sales:view | cao | người + máy | module tắt ở nhà (đúng); rỗng có CTA; Meta chờ | 86 | — | — | — |
| /ai/overview | CUSTOMER+ERP | B/C/D Khách + E/F | ai_sales | Tổng quan | P0 | ✓ 200 | menu | ai_sales:view | cao | người + máy | module tắt ở nhà (đúng); 8 ô rõ, «—» đúng luật 42 | 88 | — | — | — |
| /ai/sales-chatbot | CUSTOMER+ERP | B/C/D Khách + E/F | ai_sales | Chatbot bán hàng | P0 | ✓ 200 | menu | ai_sales:view | cao | người + máy | module tắt ở nhà (đúng); chữ kỹ thuật webhook·token·ERP·API·TEST·Field (saas-shell-polish); «AI đã sẵn sàng» ok | 74 | saas-shell-polish | — | — |
| /ai/sales-chatbot/cockpit | CUSTOMER+ERP | B/C/D Khách + E/F | ai_sales | AI bán hàng — sống hay chết | P0 | ✓ 200 | menu | ai_sales:view | cao | máy (harness) | module tắt ở nhà (đúng) | UNKNOWN | saas-shell-polish | — | — |
| /ai/sales-chatbot/conversations | CUSTOMER+ERP | B/C/D Khách + E/F | ai_sales | Hội thoại theo chỉ số | P0 | ✓ 200 | link/URL | ai_sales:view | cao | máy (harness) | module tắt ở nhà (đúng) | UNKNOWN | saas-shell-polish | — | — |
| /ai/sales-chatbot/conversations/[id] | CUSTOMER+ERP | B/C/D Khách + E/F | ai_sales | Xem lại hội thoại | P0 | động — chưa quét | chi tiết | ai_sales:view | cao | người (đọc mã 09/10) | mã sự kiện thô, nhánh thử nghiệm hiện cho khách | UNKNOWN | saas-shell-polish | #725 | — |
| /ai/sales-chatbot/copilot | CUSTOMER+ERP | B/C/D Khách + E/F | ai_sales | Gợi ý Copilot | P0 | ✓ 200 | link/URL | ai_sales:view | cao | máy (harness) | module tắt ở nhà (đúng) | UNKNOWN | saas-shell-polish | — | — |
| /ai/sales-chatbot/inbox | CUSTOMER+ERP | B/C/D Khách + E/F | ai_sales | Hộp thư khách | P0 | ✓ 200 | menu | ai_sales:view | cao | người + máy | module tắt ở nhà (đúng); rỗng có CTA; bộ lọc chiếm ~214 px; 26 ô bấm nhỏ; INBOX_V2 chờ | 82 | saas-shell-polish | — | — |
| /ai/sales-chatbot/messenger | CUSTOMER+ERP | B/C/D Khách + E/F | ai_sales | Messenger trực tiếp | P0 | ✓ 200 | link/URL | ai_sales:view | cao | máy (harness) | module tắt ở nhà (đúng) | UNKNOWN | saas-shell-polish | — | — |
| /ai/sales-chatbot/performance | CUSTOMER+ERP | B/C/D Khách + E/F | ai_sales | Hiệu quả AI bán hàng | P0 | ✓ 200 | menu | ai_sales:view | cao | máy (harness) | module tắt ở nhà (đúng) | UNKNOWN | saas-shell-polish | — | — |
| /ai/sales-chatbot/quality | CUSTOMER+ERP | B/C/D Khách + E/F | ai_sales | Rà lỗi AI | P0 | ✓ 200 | link/URL | ai_sales:view | cao | máy (harness) | module tắt ở nhà (đúng) | UNKNOWN | saas-shell-polish | — | — |
| /ai/sales-chatbot/quick-replies | CUSTOMER+ERP | B/C/D Khách + E/F | ai_sales | Câu trả lời mẫu | P0 | ✓ 200 | link/URL | ai_sales:view | cao | máy (harness) | module tắt ở nhà (đúng) | UNKNOWN | saas-shell-polish | — | — |
| /ai/sales-chatbot/replay | CUSTOMER+ERP | B/C/D Khách + E/F | ai_sales | Phát lại hội thoại cũ | P0 | ✓ 200 | link/URL | ai_sales:view | cao | máy (harness) | module tắt ở nhà (đúng) | UNKNOWN | saas-shell-polish | — | — |
| /billing-locked | CUSTOMER+ERP | B/C/D Khách + E/F | core | Chỉ xem — quá hạn thanh toán | P0 | ✓ 200 | link/URL | đăng nhập | cao | máy (harness) | — | UNKNOWN | — | — | — |
| /customers | CUSTOMER+ERP | B/C/D Khách + E/F | customers | Khách hàng | P0 | ✓ 200 | menu | customers:view | cao | người + máy | «0.0%» mẫu số 0 (PR r2 sửa) | 82 | saas-finish-line-r2 (5cab7e96) | — | — |
| /customers/[id] | CUSTOMER+ERP | B/C/D Khách + E/F | customers | Hồ sơ khách hàng | P0 | động — chưa quét | menu | customers:view | cao | người (đọc mã 09/10) | bộ đếm Pancake nâng «Thành công» (#715); dòng / JSON / Điểm thưởng Pancake ở tổ chức không Pancake | UNKNOWN | — | #715 · #725 | — |
| /customers/new | CUSTOMER+ERP | B/C/D Khách + E/F | customers | Tạo khách hàng | P0 | ✓ 200 | link/URL | customers:view | cao | máy (harness) | thiếu h1 | UNKNOWN | — | — | — |
| /help | CUSTOMER+ERP | B/C/D Khách + E/F | core | Hướng dẫn sử dụng | P0 | ✓ 200 | link/URL | đăng nhập | cao | người + máy | 9 bài vỏ, tầng liên hệ (#680) | 88 | — | — | — |
| /inventory/receipts | CUSTOMER+ERP | B/C/D Khách + E/F | inventory | Nhập hàng & kiểm kê | P0 | ✓ 200 | menu | products:view | cao | người + máy | «ERP» trong chữ | 84 | — | — | — |
| /orders | CUSTOMER+ERP | B/C/D Khách + E/F | orders | Đơn hàng | P0 | ✓ 200 | menu | orders:read | cao | người + máy | 4 ô 0 trước việc chính ở 390; không nói đơn từ hội thoại | 80 | — | — | — |
| /orders/[id] | CUSTOMER+ERP | B/C/D Khách + E/F | orders | — | P0 | động — chưa quét | menu | orders:read | cao | người (đọc mã 09/10) | «Thu hộ / Phí sàn / Trả trước 0 ₫» ở đơn tay; chỉ dẫn Pancake; giá vốn chưa biết 0 ₫ (#716) | UNKNOWN | — | #715 · #716 · #725 | — |
| /orders/[id]/edit | CUSTOMER+ERP | B/C/D Khách + E/F | orders | Sửa đơn hàng | P0 | động — chưa quét | chi tiết | orders:read | cao | người (đọc mã 09/10) | ghi chú cuối form chỉ tới lối phiếu xuất đã bỏ | UNKNOWN | — | #725 | — |
| /orders/new | CUSTOMER+ERP | B/C/D Khách + E/F | orders | Tạo đơn hàng | P0 | ✓ 200 | link/URL | orders:read | cao | máy (harness) | thiếu h1 | UNKNOWN | — | — | — |
| /products | CUSTOMER+ERP | B/C/D Khách + E/F | products | Sản phẩm & tồn kho | P0 | chưa quét | menu | products:view | cao | người + máy | HTTP null; thiếu h1; tiêu đề vỏ (PR r2); cột ERP ĐÃ XUẤT/GTC với khách; 25 ô nhỏ | 80 | saas-finish-line-r2 (5cab7e96) | — | — |
| /products/[id] | CUSTOMER+ERP | B/C/D Khách + E/F | products | Chi tiết sản phẩm | P0 | động — chưa quét | menu | products:view | cao | người (đọc mã 09/10) | mở bằng mã ⇒ ma trận + ghi chú rỗng; giá vốn chưa biết 0 ₫ (#716) | UNKNOWN | — | #716 · #725 | — |
| /products/import | CUSTOMER+ERP | B/C/D Khách + E/F | products | Nhập sản phẩm từ tệp | P0 | ✓ 200 | link/URL | products:view | cao | máy (harness) | thiếu h1 | UNKNOWN | — | — | — |
| /products/new | CUSTOMER+ERP | B/C/D Khách + E/F | products | Tạo sản phẩm | P0 | ✓ 200 | link/URL | products:view | cao | máy (harness) | thiếu h1 | UNKNOWN | — | — | — |
| /settings/ai-balance | CUSTOMER+ERP | B/C/D Khách + E/F | core | Số dư AI | P0 | ✓ 200 | link/URL | settings:manage | cao | người + máy | cờ tắt có câu rõ (#680) | 86 | — | — | — |
| /settings/branding | CUSTOMER+ERP | B/C/D Khách + E/F | core | Thương hiệu | P0 | ✓ 200 | link/URL | settings:manage | cao | máy (harness) | — | UNKNOWN | — | — | — |
| /settings/connections | CUSTOMER+ERP | B/C/D Khách + E/F | core | Kết nối theo tổ chức | P0 | ✓ 200 | menu | - | cao | người + máy | «16 connector» · Viettel Post lộ với khách Chốt Đơn (F-06, saas-shell-polish) | 62 | saas-shell-polish | — | — |
| /settings/data-export | CUSTOMER+ERP | B/C/D Khách + E/F | core | Xuất dữ liệu | P0 | ✓ 200 | menu | settings:manage | cao | máy (harness) | — | UNKNOWN | — | — | — |
| /settings/notifications | CUSTOMER+ERP | B/C/D Khách + E/F | core | Thông báo nhóm | P0 | ✓ 200 | menu | - | cao | máy (harness) | — | UNKNOWN | — | — | — |
| /settings/plan | CUSTOMER+ERP | B/C/D Khách + E/F | core | Gói & thanh toán | P0 | ✓ 200 | menu | settings:manage | cao | người + máy | đồng hồ rõ; chip API/Webhook (PR r2); tiêu đề vỏ (PR r2) | 84 | saas-finish-line-r2 (5cab7e96) | — | — |
| /settings/profile | CUSTOMER+ERP | B/C/D Khách + E/F | core | Tài khoản của tôi | P0 | ✓ 200 | link/URL | đăng nhập | cao | người + máy | «Cài ERP lên màn hình chính» với khách Chốt Đơn | 85 | — | — | — |
| /settings/shop | CUSTOMER+ERP | B/C/D Khách + E/F | core | Cài đặt | P0 | ✓ 200 | menu | đăng nhập | cao | người + máy | ngắn, rõ | 90 | — | — | — |
| /settings/users | CUSTOMER+ERP | B/C/D Khách + E/F | core | Người dùng | P0 | ✓ 200 | menu | users:manage | cao | người + máy | 786 ô bấm < 32 px; 786 ô < 32 px · 4.296 px ở 390 · «webhook·module·ERP·API» — C1 cho khách Chốt Đơn | 55 | saas-shell-polish | — | — |
| /setup | CUSTOMER+ERP | B/C/D Khách + E/F | core | Thiết lập & xuất bản | P0 | ✓ 200 | menu | - | cao | người + máy | «ERP», tên module nội bộ, link /p bị chặn (F-15) | 66 | saas-shell-polish | — | — |
| /platform | ADMIN | F Platform admin | core | Vận hành nền tảng | P0 | ✓ 200 | menu | platform:operate | thấp | người + máy | 9 nút không tên · cao 6.223 px; cao 6.223 px; khung Webhook Meta trên cùng; 6.223 px; 9 nút không tên; việc hằng ngày dưới nếp gấp | 70 | — | — | — |
| /platform/ai-balance | ADMIN | F Platform admin | core | Số dư AI · vận hành | P0 | ✓ 200 | link/URL | platform:operate | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /platform/customers | ADMIN | F Platform admin | core | Khách hàng SaaS | P0 | ✓ 200 | menu | platform:operate | thấp | người + máy | 13 ô nhập không nhãn; thiếu cột Messenger/AI/đăng nhập cuối (#683); nút «Tạo khách…» mờ không lý do; 13 ô không nhãn; «0 dùng thử» sai | 72 | #683 | — | — |
| /platform/customers/[code] | ADMIN | F Platform admin | core | Khách hàng | P0 | động — chưa quét | menu | platform:operate | thấp | người + máy | đủ 12 khối trừ AI/đơn (ở /platform/org); gửi lại kích hoạt tốt | 80 | #683 | — | — |
| /platform/org/[code] | ADMIN | F Platform admin | core | Sức khoẻ tổ chức | P0 | động — chưa quét | chi tiết | platform:operate | thấp | người + máy | 5.610 px; Gemini/OpenAI/Anthropic/Field — admin chấp nhận; cần nhảy mục | 74 | — | — | — |
| /platform/products | ADMIN | F Platform admin | core | Sản phẩm SaaS | P0 | ✓ 200 | menu | platform:operate | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /platform/products/[key] | ADMIN | F Platform admin | core | Sản phẩm | P0 | động — chưa quét | menu | platform:operate | thấp | người (đọc mã 09/10) | bảng không cuộn ngang, thiếu trạng thái rỗng (C2); chi phí phân bổ chưa biết = 0 trong biên (bàn giao) | UNKNOWN | — | — | — |
| /platform/saas | ADMIN | F Platform admin | core | Kinh tế nền tảng | P0 | ✓ 200 | menu | platform:operate | thấp | người + máy | bảng 1.180 px cuộn ngang; thuật ngữ MRR/NRR có tooltip | 80 | — | — | — |
| / | ERP | E Nội bộ VNX | core | — | P1 | ✓ 200 | menu | dashboard:view | vừa | người + máy | ERP nhà: tổng quan; khách Chốt Đơn chuyển về hộp thư | 84 | — | — | — |
| /ads | ERP | E Nội bộ VNX | marketing | Quảng cáo | P1 | ✓ 200 | menu | expenses:view | vừa | máy (harness) | 83 ô bấm < 32 px | UNKNOWN | — | — | — |
| /alerts | ERP | E Nội bộ VNX | alerts | Cần xử lý | P1 | ✓ 200 | menu | alerts:view | vừa | người + máy | 23 nút không tên · 11 ô không nhãn; 23 nút không tên · 11 ô không nhãn | 66 | — | — | — |
| /cod | ERP | E Nội bộ VNX | finance | Đối soát COD | P1 | ✓ 200 | menu | cod:view | vừa | người + máy | 51 ô bấm < 32 px; 3.7 s tải; 3,7 s · 51 ô nhỏ · 12 cột | 76 | — | — | — |
| /cs | ERP | E Nội bộ VNX | customer_care | CSKH | P1 | ✓ 200 | menu | cs:view | vừa | máy (harness) | — | UNKNOWN | — | — | — |
| /expenses | ERP | E Nội bộ VNX | finance | Chi phí vận hành | P1 | ✓ 200 | menu | expenses:view | vừa | máy (harness) | — | UNKNOWN | — | — | — |
| /inventory | ERP | E Nội bộ VNX | inventory | Nhật ký kho | P1 | ✓ 200 | menu | products:view | vừa | máy (harness) | — | UNKNOWN | — | — | — |
| /payroll | ERP | E Nội bộ VNX | payroll | Lương & hoa hồng | P1 | ✓ 200 | menu | đăng nhập | vừa | người + máy | tràn ngang 390; tràn ngang ở 390 px | 70 | — | — | — |
| /reports/returns | ERP | E Nội bộ VNX | returns | Tỷ lệ giao thành công theo mã hàng | P1 | ✓ 200 | menu | reports:returns | vừa | máy (harness) | 93 ô bấm < 32 px; cao 5.262 px; 2.6 s tải | UNKNOWN | — | — | — |
| /returns | ERP | E Nội bộ VNX | returns | — | P1 | ✓ 200 | menu | returns:view | vừa | máy (harness) | — | UNKNOWN | — | — | — |
| /shipments | ERP | E Nội bộ VNX | logistics | Vận đơn & care | P1 | ✓ 200 | menu | shipments:view | vừa | người + máy | 83 ô bấm < 32 px; 83 ô nhỏ, 12 nút kích thước khác nhau | 78 | — | — | — |
| /work | ERP | E Nội bộ VNX | work | Việc của tôi | P1 | ✓ 200 | menu | work:view | vừa | máy (harness) | 1.9 s tải | UNKNOWN | — | — | — |
| /work/today | ERP | E Nội bộ VNX | work | Hôm nay | P1 | ✓ 200 | link/URL | work:department | vừa | máy (harness) | — | UNKNOWN | — | — | — |
| /appointments | ERP | E Nội bộ VNX | appointments | Lịch hẹn | P2 | ✓ 200 | menu | appointments:view | thấp | máy (harness) | module tắt ở nhà (đúng) | UNKNOWN | — | — | — |
| /approvals | ERP | E Nội bộ VNX | core | Duyệt | P2 | ✓ 200 | menu | approvals:decide | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /audit | ERP | E Nội bộ VNX | core | Nhật ký hệ thống | P2 | ✓ 200 | menu | audit:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /bank | ERP | E Nội bộ VNX | finance | Sổ ngân hàng | P2 | ✓ 200 | menu | bank:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /chatbot | ERP | E Nội bộ VNX | connector_pancake | Bot chat bán hàng | P2 | ✓ 200 | menu | cs:config | thấp | người + máy | 4.6 s tải; 4,5 s tải | 72 | — | — | — |
| /cockpit | ERP | E Nội bộ VNX | core | Cần anh quyết | P2 | ✓ 200 | menu | dashboard:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /customers/receivables | ERP | E Nội bộ VNX | customers | Công nợ khách hàng | P2 | ✓ 200 | menu | customers:view | thấp | máy (harness) | thiếu h1 | UNKNOWN | — | — | — |
| /customers/reorder | ERP | E Nội bộ VNX | customers | Nhắc mua lại | P2 | ✓ 200 | menu | customers:view | thấp | máy (harness) | thiếu h1 | UNKNOWN | — | — | — |
| /data-quality | ERP | E Nội bộ VNX | core | Chất lượng dữ liệu | P2 | ✓ 200 | menu | dashboard:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /departments | ERP | E Nội bộ VNX | core | Bản đồ phòng ban & AI | P2 | ✓ 200 | menu | dashboard:view | thấp | người + máy | 205 ô bấm < 32 px; 205 ô nhỏ | 74 | — | — | — |
| /field-jobs | ERP | E Nội bộ VNX | field_jobs | Phiếu công việc | P2 | ✓ 200 | menu | field_jobs:view | thấp | máy (harness) | module tắt ở nhà (đúng) | UNKNOWN | — | — | — |
| /field-jobs/[id] | ERP | E Nội bộ VNX | field_jobs | Phiếu công việc | P2 | động — chưa quét | menu | field_jobs:view | thấp | người (đọc mã 09/10) | tiền tự định dạng; ô chỉ có chữ mờ | UNKNOWN | — | #721 | — |
| /finance | ERP | E Nội bộ VNX | finance | Tổng quan tài chính | P2 | ✓ 200 | menu | bank:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /finance-ops | ERP | E Nội bộ VNX | finance | Hàng đợi tác vụ tài chính | P2 | ✓ 200 | menu | bank:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /ideas | ERP | E Nội bộ VNX | marketing | Ý tưởng marketing | P2 | ✓ 200 | menu | ideas:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /ideas/[id] | ERP | E Nội bộ VNX | marketing | Ý tưởng marketing | P2 | động — chưa quét | menu | ideas:view | thấp | người (đọc mã 09/10) | đầu trang không xuống dòng; «người đăng» theo email (luật 34, bàn giao) | UNKNOWN | — | #721 · #726 | — |
| /integrations | ERP | E Nội bộ VNX | integrations | Kết nối dữ liệu | P2 | ✓ 200 | menu | integrations:view | thấp | máy (harness) | cao 6.120 px | UNKNOWN | — | — | — |
| /inventory/decisions | ERP | E Nội bộ VNX | purchasing | Quyết định vốn tồn kho | P2 | ✓ 200 | menu | planning:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /inventory/lots | ERP | E Nội bộ VNX | lots | Lô & hạn dùng | P2 | ✓ 200 | menu | lots:view | thấp | máy (harness) | module tắt ở nhà (đúng) | UNKNOWN | — | — | — |
| /inventory/packing | ERP | E Nội bộ VNX | inventory | Đóng gói theo lượt | P2 | ✓ 200 | menu | products:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /inventory/planning | ERP | E Nội bộ VNX | production | Kế hoạch đặt hàng sản xuất | P2 | ✓ 200 | menu | planning:view | thấp | máy (harness) | 99 ô bấm < 32 px; cao 6.553 px | UNKNOWN | — | — | — |
| /inventory/returns | ERP | E Nội bộ VNX | returns | Kiểm đếm hàng hoàn · kho | P2 | ✓ 200 | menu | products:view | thấp | người + máy | 501 ô bấm < 32 px; cao 5.065 px; 501 ô nhỏ · 5.065 px | 68 | — | — | — |
| /inventory/shortage | ERP | E Nội bộ VNX | purchasing | Thiếu hàng giao đơn | P2 | ✓ 200 | menu | planning:view | thấp | máy (harness) | 7 nút không tên | UNKNOWN | — | — | — |
| /inventory/workshop | ERP | E Nội bộ VNX | production | Đặt xưởng & thanh toán | P2 | ✓ 200 | menu | planning:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /inventory/workshop/[id] | ERP | E Nội bộ VNX | production | Lô đặt xưởng | P2 | động — chưa quét | menu | planning:view | thấp | người (đọc mã 09/10) | 36 ô nhập không tên (Field) | UNKNOWN | — | #726 | — |
| /landing | ERP | E Nội bộ VNX | sales_channels | — | P2 | ✓ 200 | menu | landing:view | thấp | máy (harness) | 5 ô không nhãn | UNKNOWN | — | — | — |
| /marketing/creatives | ERP | E Nội bộ VNX | marketing | Thư viện Media | P2 | ✓ 200 | menu | ideas:view | thấp | máy (harness) | 53 ô bấm < 32 px | UNKNOWN | — | — | — |
| /marketing/fanpages | ERP | E Nội bộ VNX | marketing | Fanpage & quy kết marketer | P2 | ✓ 200 | menu | reports:nominal | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /marketing/topics | ERP | E Nội bộ VNX | production | Topic gửi sản xuất | P2 | ✓ 200 | menu | đăng nhập | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /marketing/video-scale | ERP | E Nội bộ VNX | marketing | Video Scale | P2 | ✓ 200 | menu | ideas:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /models | ERP | E Nội bộ VNX | production | Vòng đời mẫu | P2 | ✓ 200 | menu | models:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /models/[id] | ERP | E Nội bộ VNX | production | Vòng đời mẫu | P2 | động — chưa quét | menu | models:view | thấp | người (đọc mã 09/10) | ô chọn / lý do không tên; chữ lỗi thô trong gợi ý | UNKNOWN | — | #726 | — |
| /orders/self-delivery | ERP | E Nội bộ VNX | orders | Danh sách tự giao | P2 | ✓ 200 | menu | orders:read | thấp | máy (harness) | thiếu h1 | UNKNOWN | — | — | — |
| /outreach | ERP | E Nội bộ VNX | marketing | Chăm sóc & bán chéo | P2 | ✓ 200 | menu | outreach:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /production | ERP | E Nội bộ VNX | production | Topic sản xuất | P2 | ✓ 200 | menu | planning:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /products/performance | ERP | E Nội bộ VNX | products | Hiệu quả mẫu mã | P2 | ✓ 200 | menu | reports:returns | thấp | máy (harness) | 78 ô bấm < 32 px | UNKNOWN | — | — | — |
| /products/price-lists | ERP | E Nội bộ VNX | products | Bảng giá sỉ | P2 | ✓ 200 | menu | products:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /products/price-lists/[id] | ERP | E Nội bộ VNX | products | Bảng giá | P2 | động — chưa quét | menu | products:view | thấp | người (đọc mã 09/10) | tiền tự định dạng; mã mẫu mã thô khi đã xoá (C3) | UNKNOWN | — | — | — |
| /real-estate | ERP | E Nội bộ VNX | real_estate | Bảng hàng BĐS | P2 | ✓ 200 | menu | real_estate:view | thấp | máy (harness) | module tắt ở nhà (đúng) | UNKNOWN | — | — | — |
| /reports | ERP | E Nội bộ VNX | finance | Báo cáo lợi nhuận | P2 | ✓ 200 | menu | đăng nhập | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /reports/cashflow | ERP | E Nội bộ VNX | finance | Dòng tiền | P2 | ✓ 200 | menu | reports:cash | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /settings/advanced | ERP | E Nội bộ VNX | core | Tuỳ biến nâng cao | P2 | ✓ 200 | menu | đăng nhập | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /settings/ai-builder | ERP | E Nội bộ VNX | core | AI dựng cấu hình | P2 | ✓ 200 | menu | metadata:manage | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /settings/data-model | ERP | E Nội bộ VNX | core | Mô hình dữ liệu | P2 | ✓ 200 | menu | metadata:manage | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /settings/export | ERP | E Nội bộ VNX | core | Xuất cấu hình | P2 | ✓ 200 | menu | metadata:manage | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /settings/forms | ERP | E Nội bộ VNX | core | Form nhập liệu | P2 | ✓ 200 | menu | metadata:manage | thấp | máy (harness) | 4 ô không nhãn | UNKNOWN | — | — | — |
| /settings/lists | ERP | E Nội bộ VNX | core | Danh sách | P2 | ✓ 200 | menu | metadata:manage | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /settings/modules | ERP | E Nội bộ VNX | core | Module của tổ chức | P2 | ✓ 200 | menu | modules:manage | thấp | người + máy | 194 ô bấm < 32 px; 194 ô nhỏ | 72 | — | — | — |
| /settings/objects | ERP | E Nội bộ VNX | core | Đối tượng tuỳ biến | P2 | ✓ 200 | menu | metadata:manage | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /settings/pages | ERP | E Nội bộ VNX | core | Trang tuỳ biến | P2 | ✓ 200 | menu | metadata:manage | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /settings/pages/[id] | ERP | E Nội bộ VNX | core | Trang tuỳ biến | P2 | động — chưa quét | menu | metadata:manage | thấp | người (đọc mã 09/10) | «%» lẻ ⇒ 500 | UNKNOWN | — | #721 | — |
| /settings/statuses | ERP | E Nội bộ VNX | core | Trạng thái | P2 | ✓ 200 | menu | metadata:manage | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /settings/templates | ERP | E Nội bộ VNX | core | Mẫu cấu hình | P2 | ✓ 200 | menu | metadata:manage | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /settings/templates/[key] | ERP | E Nội bộ VNX | core | Xem trước mẫu | P2 | động — chưa quét | menu | metadata:manage | thấp | người (đọc mã 09/10) | «%» lẻ ⇒ 500; chữ lỗi thô khi cài mẫu | UNKNOWN | — | #721 | — |
| /settings/workflows | ERP | E Nội bộ VNX | core | Luật tự động | P2 | ✓ 200 | menu | workflow:manage | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /settings/workflows/[id] | ERP | E Nội bộ VNX | core | Luật tự động | P2 | động — chưa quét | menu | workflow:manage | thấp | người (đọc mã 09/10) | «%» lẻ ⇒ 500; 18 ô trong Row không tên | UNKNOWN | — | #721 · #726 | — |
| /shipments/[id] | ERP | E Nội bộ VNX | logistics | — | P2 | động — chưa quét | menu | shipments:view | thấp | người (đọc mã 09/10) | C0 form «Sửa đơn VTP» điền sẵn COD sai; «Đẩy lại» không cổng quyền; «Đã thu 0 ₫» chưa xác minh | UNKNOWN | — | #717 | — |
| /stays | ERP | E Nội bộ VNX | stays | Lịch phòng | P2 | ✓ 200 | menu | stays:view | thấp | máy (harness) | module tắt ở nhà (đúng) | UNKNOWN | — | — | — |
| /warranty | ERP | E Nội bộ VNX | warranty | Bảo hành | P2 | ✓ 200 | menu | warranty:view | thấp | máy (harness) | module tắt ở nhà (đúng) | UNKNOWN | — | — | — |
| /wholesale/dashboard | ERP | E Nội bộ VNX | wholesale_leads | Hiệu quả khách sỉ | P2 | ✓ 200 | menu | wholesale:view | thấp | máy (harness) | module tắt ở nhà (đúng) | UNKNOWN | — | — | — |
| /wholesale/lead-hunter | ERP | E Nội bộ VNX | wholesale_leads | Săn khách sỉ | P2 | ✓ 200 | menu | wholesale:scan | thấp | máy (harness) | module tắt ở nhà (đúng) | UNKNOWN | — | — | — |
| /wholesale/leads | ERP | E Nội bộ VNX | wholesale_leads | Khách sỉ tiềm năng | P2 | ✓ 200 | menu | wholesale:view | thấp | máy (harness) | module tắt ở nhà (đúng) | UNKNOWN | — | — | — |
| /wholesale/leads/[id] | ERP | E Nội bộ VNX | wholesale_leads | Lead khách sỉ | P2 | động — chưa quét | menu | wholesale:view | thấp | người (đọc mã 09/10) | mã Google / loại / khoá trường thô; 13 ô không tên | UNKNOWN | — | #721 · #726 | — |
| /wholesale/mobile | ERP | E Nội bộ VNX | wholesale_leads | Gọi khách sỉ | P2 | ✓ 200 | menu | wholesale:view | thấp | máy (harness) | module tắt ở nhà (đúng) | UNKNOWN | — | — | — |
| /wholesale/outreach | ERP | E Nội bộ VNX | wholesale_leads | Hàng đợi liên hệ sỉ | P2 | ✓ 200 | menu | wholesale:work | thấp | máy (harness) | module tắt ở nhà (đúng) | UNKNOWN | — | — | — |
| /ads/daily | ERP | E Nội bộ VNX | marketing | Hiệu quả theo ngày | P3 | ✓ 200 | link/URL | expenses:view | thấp | máy (harness) | 66 ô bấm < 32 px; 2.0 s tải | UNKNOWN | — | — | — |
| /ads/post-resolver | ERP | E Nội bộ VNX | marketing | Ad → Bài viết | P3 | ✓ 200 | link/URL | expenses:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /chatbot/ad-bots | ERP | E Nội bộ VNX | connector_pancake | Bot riêng theo quảng cáo | P3 | ✓ 200 | link/URL | cs:config | thấp | người + máy | 4.5 s tải; 4,5 s tải | 72 | — | — | — |
| /customers/retention | ERP | E Nội bộ VNX | customers | Giữ chân khách | P3 | ✓ 200 | link/URL | customers:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /import-vtp | ERP | E Nội bộ VNX | logistics | Bổ sung danh sách vận đơn | P3 | ✓ 200 | link/URL | cod:write | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /import-vtp/[batchId] | ERP | E Nội bộ VNX | logistics | Chi tiết lần nhập tệp VTP | P3 | động — chưa quét | chi tiết | cod:write | thấp | người (đọc mã 09/10) | tệp hỏng in 9 ô «0» chưa đo; chữ lỗi thô | UNKNOWN | — | #721 | — |
| /inventory/planning/orders | ERP | E Nội bộ VNX | production | Bảng đặt hàng sản xuất | P3 | ✓ 200 | link/URL | planning:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /inventory/planning/orders/[id] | ERP | E Nội bộ VNX | production | — | P3 | động — chưa quét | chi tiết | planning:view | thấp | người (đọc mã 09/10) | phiếu sản xuất tràn 390 px; nút xoá nháp không tên | UNKNOWN | — | #721 · #726 | — |
| /inventory/planning/orders/[id]/edit | ERP | E Nội bộ VNX | production | — | P3 | động — chưa quét | chi tiết | planning:write | thấp | người (đọc mã 09/10) | giá vốn trống = 0 ⇒ bỏ qua duyệt PURCHASING_LARGE (Tech Lead quyết, xếp hàng) | UNKNOWN | — | — | — |
| /inventory/planning/orders/new | ERP | E Nội bộ VNX | production | Bảng chốt đặt hàng | P3 | ✓ 200 | link/URL | planning:write | thấp | máy (harness) | thiếu h1 | UNKNOWN | — | — | — |
| /inventory/purchasing | ERP | E Nội bộ VNX | purchasing | Mua hàng & xưởng | P3 | ✓ 200 | link/URL | planning:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /marketing/topics/new | ERP | E Nội bộ VNX | production | Mở topic sản xuất | P3 | ✓ 200 | link/URL | đăng nhập | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /my-payslip | ERP | E Nội bộ VNX | payroll | Phiếu lương của tôi | P3 | ✓ 200 | link/URL | đăng nhập | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /o/[object] | ERP | E Nội bộ VNX | apps | Ứng dụng tuỳ biến | P3 | động — chưa quét | chi tiết | records:view | thấp | người (đọc mã 09/10) | — | UNKNOWN | — | — | — |
| /o/[object]/[id] | ERP | E Nội bộ VNX | apps | Chi tiết bản ghi | P3 | động — chưa quét | chi tiết | records:view | thấp | người (đọc mã 09/10) | mã thô trong dòng thời gian (C3) | UNKNOWN | — | — | — |
| /o/[object]/new | ERP | E Nội bộ VNX | apps | Tạo bản ghi | P3 | động — chưa quét | chi tiết | records:write | thấp | người (đọc mã 09/10) | gửi định nghĩa trường bị chặn quyền xuống client (bàn giao) | UNKNOWN | — | — | — |
| /operations | ERP | E Nội bộ VNX | logistics | Điều hành hằng ngày | P3 | ✓ 200 | link/URL | dashboard:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /operations/dwell | ERP | E Nội bộ VNX | logistics | Vận đơn đứng yên quá lâu | P3 | ✓ 200 | link/URL | shipments:view | thấp | máy (harness) | 86 ô bấm < 32 px; cao 5.141 px | UNKNOWN | — | — | — |
| /operations/fulfillment | ERP | E Nội bộ VNX | logistics | Nút thắt trước khi rời kho | P3 | ✓ 200 | link/URL | dashboard:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /operations/preship | ERP | E Nội bộ VNX | logistics | Soát đơn trước khi gửi | P3 | ✓ 200 | link/URL | orders:read | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /orders/carrier-labels | ERP | E Nội bộ VNX | orders | Nhãn in vận đơn | P3 | ✓ 200 | link/URL | shipments:manage | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /orders/shipping-routes | ERP | E Nội bộ VNX | orders | Cấu hình tuyến giao | P3 | ✓ 200 | link/URL | orders:read | thấp | máy (harness) | thiếu h1 | UNKNOWN | — | — | — |
| /orders/verify | ERP | E Nội bộ VNX | orders | Đơn cần xác minh trước khi giao | P3 | ✓ 200 | link/URL | orders:read | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /outreach/broadcast | ERP | E Nội bộ VNX | marketing | Gửi tin hàng loạt | P3 | ✓ 200 | link/URL | outreach:view | thấp | máy (harness) | 6 ô không nhãn | UNKNOWN | — | — | — |
| /p/[slug] | ERP | E Nội bộ VNX | core | — | P3 | động — chưa quét | chi tiết | đăng nhập | thấp | người (đọc mã 09/10) | — | UNKNOWN | — | — | — |
| /payroll/adjustments | ERP | E Nội bộ VNX | payroll | Đầu vào & điều chỉnh lương | P3 | ✓ 200 | link/URL | đăng nhập | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /payroll/assignments | ERP | E Nội bộ VNX | payroll | Phân công & gán chính sách | P3 | ✓ 200 | link/URL | đăng nhập | thấp | máy (harness) | 5 ô không nhãn | UNKNOWN | — | — | — |
| /payroll/autopilot | ERP | E Nội bộ VNX | payroll | Trả lương tự động | P3 | ✓ 200 | link/URL | đăng nhập | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /payroll/migration | ERP | E Nội bộ VNX | payroll | Xem trước chuyển đổi lương | P3 | ✓ 200 | link/URL | đăng nhập | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /payroll/payslip | ERP | E Nội bộ VNX | payroll | Phiếu lương | P3 | ✓ 200 | link/URL | đăng nhập | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /payroll/policies | ERP | E Nội bộ VNX | payroll | Chính sách lương | P3 | ✓ 200 | link/URL | đăng nhập | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /payroll/runs | ERP | E Nội bộ VNX | payroll | Lịch sử kỳ lương | P3 | ✓ 200 | link/URL | đăng nhập | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /payroll/settings | ERP | E Nội bộ VNX | payroll | Cấu hình lương | P3 | ✓ 200 | link/URL | đăng nhập | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /production/models/[id] | ERP | E Nội bộ VNX | production | Bàn sản xuất của mẫu | P3 | động — chưa quét | chi tiết | planning:view | thấp | người (đọc mã 09/10) | dòng giá trống thành 0 ₫ (bàn giao cùng lệnh đặt xưởng); ô bảng chi phí không tên | UNKNOWN | — | — | — |
| /production/topics/[id] | ERP | E Nội bộ VNX | production | Topic sản xuất | P3 | động — chưa quét | chi tiết | đăng nhập | thấp | người (đọc mã 09/10) | đầu trang không xuống dòng; 7 ô không tên; chữ lỗi thô | UNKNOWN | — | #721 · #726 | — |
| /production/topics/new | ERP | E Nội bộ VNX | production | — | P3 | ✓ 200 | link/URL | - | thấp | máy (harness) | thiếu h1; lỗi console/JS | UNKNOWN | — | — | — |
| /products/reserved | ERP | E Nội bộ VNX | products | Đơn chờ xuất | P3 | ✓ 200 | link/URL | products:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /reports/funnel | ERP | E Nội bộ VNX | finance | Phễu bán hàng | P3 | ✓ 200 | link/URL | reports:returns | thấp | máy (harness) | 59 ô bấm < 32 px; 1.7 s tải | UNKNOWN | — | — | — |
| /reports/scenario | ERP | E Nội bộ VNX | finance | Mô phỏng kịch bản | P3 | ✓ 200 | link/URL | reports:nominal | thấp | máy (harness) | 1.6 s tải | UNKNOWN | — | — | — |
| /reports/stock-wait | ERP | E Nội bộ VNX | logistics | — | P3 | ✓ 200 | link/URL | - | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /reports/target | ERP | E Nội bộ VNX | finance | Kế hoạch mục tiêu lợi nhuận | P3 | ✓ 200 | link/URL | reports:nominal | thấp | máy (harness) | 2.6 s tải | UNKNOWN | — | — | — |
| /settings/pages/[id]/builder | ERP | E Nội bộ VNX | core | Trình dựng trang | P3 | động — chưa quét | chi tiết | metadata:manage | thấp | người (đọc mã 09/10) | «%» lẻ ⇒ 500 | UNKNOWN | — | #721 | — |
| /settings/pages/[id]/preview | ERP | E Nội bộ VNX | core | — | P3 | động — chưa quét | chi tiết | metadata:manage | thấp | người (đọc mã 09/10) | mã module thô (C3) | UNKNOWN | — | — | — |
| /settings/pages/new | ERP | E Nội bộ VNX | core | Trang tuỳ biến mới | P3 | ✓ 200 | link/URL | metadata:manage | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /settings/workflows/new | ERP | E Nội bộ VNX | core | Luật tự động mới | P3 | ✓ 200 | link/URL | workflow:manage | thấp | máy (harness) | 4 ô không nhãn | UNKNOWN | — | — | — |
| /shipments/stock-wait | ERP | E Nội bộ VNX | logistics | Chờ hàng & giao thành công | P3 | ✓ 200 | link/URL | shipments:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /wholesale/mobile/history | ERP | E Nội bộ VNX | wholesale_leads | Lịch sử gọi | P3 | ✓ 200 | link/URL | wholesale:view | thấp | máy (harness) | module tắt ở nhà (đúng) | UNKNOWN | — | — | — |
| /wholesale/mobile/lead/[id] | ERP | E Nội bộ VNX | wholesale_leads | Gọi khách | P3 | động — chưa quét | chi tiết | wholesale:view | thấp | người (đọc mã 09/10) | ghi chú / ngày hẹn không tên; nút «Đang lưu…» kẹt khi lỗi mạng (C3) | UNKNOWN | — | #726 | — |
| /wholesale/mobile/next | ERP | E Nội bộ VNX | wholesale_leads | Khách tiếp theo | P3 | ✓ 200 | link/URL | wholesale:view | thấp | máy (harness) | module tắt ở nhà (đúng) | UNKNOWN | — | — | — |
| /wholesale/mobile/queue | ERP | E Nội bộ VNX | wholesale_leads | Danh sách gọi | P3 | ✓ 200 | link/URL | wholesale:view | thấp | máy (harness) | module tắt ở nhà (đúng) | UNKNOWN | — | — | — |
| /wholesale/settings | ERP | E Nội bộ VNX | wholesale_leads | Cấu hình săn khách sỉ | P3 | ✓ 200 | link/URL | wholesale:config | thấp | máy (harness) | module tắt ở nhà (đúng) | UNKNOWN | — | — | — |
| /work/all | ERP | E Nội bộ VNX | work | Tất cả công việc | P3 | ✓ 200 | link/URL | work:all | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /work/department | ERP | E Nội bộ VNX | work | Công việc theo phòng ban | P3 | ✓ 200 | link/URL | work:department | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /work/okr | ERP | E Nội bộ VNX | work | Mục tiêu · OKR & BSC | P3 | ✓ 200 | link/URL | okr:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /work/performance | ERP | E Nội bộ VNX | work | Hiệu suất | P3 | ✓ 200 | link/URL | performance:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /work/review | ERP | E Nội bộ VNX | work | Kỳ review | P3 | ✓ 200 | link/URL | performance:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /work/settings | ERP | E Nội bộ VNX | work | Cấu hình công việc | P3 | ✓ 200 | link/URL | work:admin | thấp | người + máy | 24 nút không tên · 19 ô không nhãn · cao 8.803 px; 57 ô bấm < 32 px; cao 8.803 px; 8.803 px · 24 nút không tên · 19 ô không nhãn · 57 ô nhỏ | 58 | — | — | — |
| /tech | INTERNAL | E Tech | tech | Phòng Tech AI | P3 | ✓ 200 | menu | tech:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /tech/agents | INTERNAL | E Tech | tech | Sổ agent AI | P3 | ✓ 200 | link/URL | tech:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /tech/cto | INTERNAL | E Tech | tech | AI CTO | P3 | ✓ 200 | link/URL | tech:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /tech/deployments | INTERNAL | E Tech | tech | Deploy | P3 | ✓ 200 | link/URL | tech:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /tech/goals | INTERNAL | E Tech | tech | Mục tiêu · Phòng Tech AI | P3 | ✓ 200 | link/URL | tech:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /tech/goals/[id] | INTERNAL | E Tech | tech | Mục tiêu · Phòng Tech AI | P3 | động — chưa quét | chi tiết | tech:view | thấp | người (đọc mã 09/10) | — | UNKNOWN | — | — | — |
| /tech/incidents | INTERNAL | E Tech | tech | Sự cố | P3 | ✓ 200 | link/URL | tech:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /tech/incidents/[id] | INTERNAL | E Tech | tech | Chi tiết sự cố | P3 | động — chưa quét | chi tiết | tech:view | thấp | người (đọc mã 09/10) | mã nguồn / tác nhân thô (C3) | UNKNOWN | — | — | — |
| /tech/missions | INTERNAL | E Tech | tech | Sứ mệnh · Phòng Tech AI | P3 | ✓ 200 | link/URL | tech:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /tech/missions/[id] | INTERNAL | E Tech | tech | Sứ mệnh · Phòng Tech AI | P3 | động — chưa quét | chi tiết | tech:view | thấp | người (đọc mã 09/10) | — | UNKNOWN | — | — | — |
| /tech/needs-owner | INTERNAL | E Tech | tech | Cần chủ shop · Phòng Tech AI | P3 | ✓ 200 | link/URL | tech:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /tech/tasks | INTERNAL | E Tech | tech | Hàng đợi việc Tech | P3 | ✓ 200 | link/URL | tech:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |
| /tech/tasks/[id] | INTERNAL | E Tech | tech | Chi tiết việc Tech | P3 | động — chưa quét | chi tiết | tech:view | thấp | người (đọc mã 09/10) | mã duyệt thô, chữ 10,5 px (C3) | UNKNOWN | — | — | — |
| /tech/workers | INTERNAL | E Tech | tech | Worker · Phòng Tech AI | P3 | ✓ 200 | link/URL | tech:view | thấp | máy (harness) | — | UNKNOWN | — | — | — |

# Bảng chất lượng thương mại — Commercial Perfection Sweep (08/10/2026, Phase A chỉ đọc)

*Đi cùng `COMMERCIAL_PAGE_INVENTORY.md` (207 trang). Đo trên `origin/main` b3a8d74e chạy cục bộ (PGlite + dữ liệu demo, host
`app.chotdon.test`), vỏ khách bằng tài khoản khách do admin tạo, production CHỈ trang công khai bằng GET. Không sửa mã nào trong
phase này. Mức: **C0** chặn thương mại · **C1** tác động cao · **C2** đánh bóng · **C3** li ti. Điểm trang chỉ khi người đã xem; chưa
đủ bằng chứng ⇒ UNKNOWN.*

## 0. Bảng điều khiển

| Chỉ số | Giá trị |
|---|---|
| TỔNG TRANG | 207 (13 công khai · 37 vỏ khách · 135 ERP · 8 admin · 14 /tech) |
| ĐÃ AUDIT (máy hoặc người) | 175 (163 route tĩnh qua harness 1366 px · 23 ở 390 + 1920 · 21 vỏ khách ×2 khổ · 7 công khai production) |
| ĐÃ CHẤM ĐIỂM (người) | 39 |
| ĐÃ SỬA | 12 việc R1 (#680, production) · 3 việc R2 (`claude/saas-finish-line-r2`) · PR C lỗi thân thiện (`claude/error-boundary-than-thien`) · PR A trang chủ (`claude/trang-chu-su-that-thuong-mai`) · PR G a11y + bố cục ERP (`claude/erp-a11y-bo-cuc`) — bốn nhánh chờ gộp |
| ĐÃ KIỂM PRODUCTION | 7 trang công khai; phần có đăng nhập chờ ops `saas-acceptance` (#690) |
| ĐIỂM TB (39 trang đã chấm) | 77 |
| C0 MỞ | **0** (không lỗi hành động, công thức, rò tổ chức, tiền sai trong phạm vi đã đo) |
| C1 MỞ | 14 → **6** sau 4 nhánh trên (còn: #4 chế độ đăng ký · #5 Nhân viên · #6/#7 saas-shell-polish · #8 #683 · #10 /platform · #13 hiệu năng) |

Harness 1366 px / 163 route: 0 lỗi 5xx · 0 trang trắng · 0 tràn ngang · 0 request hỏng · 0 ảnh thiếu alt · 11 trang thiếu `h1` ·
1 lỗi JS (`/production/topics/new` React #310 ở lượt quét đầu; **0/5 lượt tái hiện** — chuyển hướng sang `/marketing/topics/new` sạch; theo dõi, không sửa mò) · 3 trang > 3,5 s. 390 px / 23 route: 1 tràn ngang
(`/payroll`). Vỏ khách 21 + 17: 0 tràn, 0 lỗi, 1 trang 786 ô bấm nhỏ.

## 1. Top 20 C0 / C1

| # | Mức | Bề mặt | Vấn đề | Bằng chứng | Sửa ở | Trạng thái |
|---|---|---|---|---|---|---|
| 1 | C1 | Công khai | Trang chủ nói kết nối fanpage **qua Pancake** như đường chính: «Dán mã trang và mã truy cập Pancake, chép đường dẫn nhận tin vào Pancake» + FAQ «Fanpage của shop kết nối qua Pancake» | `app/gioi-thieu/page.tsx:294`, `:310` | PR A | **ĐÃ SỬA** `claude/trang-chu-su-that-thuong-mai` e17a9224 — chờ gộp |
| 2 | C1 | Công khai | Claim tuyệt đối: H1 «Không bỏ lỡ tin nhắn nào. Không để lọt đơn hàng nào.», «không bao giờ báo bừa», H3 «Không sót tin nào», «đơn vào thẳng hệ thống» | `:893`, `:549`, mục «Mười việc» | PR A | **ĐÃ SỬA** (cùng nhánh) — câu bảo vệ được |
| 3 | C1 | Công khai | «Chi phí AI hiện rõ — tính sẵn chi phí AI trên mỗi đơn chốt» trái định hướng không lộ kinh tế model; khách thấy «khách AI / hạn mức» chứ không thấy chi phí AI | `:256` | PR A | **ĐÃ SỬA** (cùng nhánh) |
| 4 | C1 | Công khai | «Dùng thử miễn phí 7 ngày» + CTA `/start` phụ thuộc `PLATFORM_SIGNUP_MODE=open`; nếu chuyển invite-only thì 9 CTA thành lời hứa chết | prod text: 9 link → /start | PR A (CTA theo chế độ đăng ký đọc từ máy chủ) | cần chủ shop quyết chế độ |
| 5 | C1 | Vỏ khách | `/settings/users` với khách Chốt Đơn: ma trận quyền 786 ô < 32 px, cao 4.296 px ở 390, chữ «webhook · module · ERP · API» | harness + R1/R2 | saas-shell-polish (chữ) + quyết định vai trò rút gọn (chủ shop) | BLOCKED (quyết định) |
| 6 | C1 | Vỏ khách | Sau đặt mật khẩu trên host Chốt Đơn, trang đăng nhập dựng với thương hiệu VNX (tải lại thì đúng) — lượt dựng sau `redirect()` của server action không mang header thương hiệu | R2-1 | saas-shell-polish | WIP (Tech Lead) |
| 7 | C1 | Vỏ khách | Chữ kỹ thuật ở AI Sales (webhook·token·ERP·API·TEST·Field), Kết nối («16 connector», Viettel Post), Thiết lập (module, ERP, link /p chặn), Tài khoản («Cài ERP lên màn hình chính») | R1 §5, R2 C3 | saas-shell-polish | WIP (Tech Lead) |
| 8 | C1 | Admin | Danh sách khách không trả lời «khách này có chạy không»: thiếu Messenger · AI · đăng nhập cuối · sức khoẻ; «Thuê bao sống · 0 dùng thử» sai nghĩa; 13 ô nhập không nhãn | harness + R2 | #683 | WIP (Tech Lead) |
| 9 | C1 | Admin | Form «Tạo khách…» mờ cho tới khi gõ lý do, ô lý do đứng TRÊN các ô nhập (mọi `ConfirmWithReason` có `children`); thương hiệu mặc định trống ⇒ khách rơi vào vỏ ERP | R1 #6, R2-2 | #682 + `components/platform/pilot-ops.tsx` | WIP (#682) / READY (bố cục) |
| 10 | C1 | Admin | `/platform` 6.223 px, khung Webhook Meta (cấu hình một lần) đứng trên bảng tổ chức & sức khoẻ; 9 nút không tên | harness | PR F | READY |
| 11 | C1 | ERP + khách | Error boundary dashboard in nguyên `error.message` + «kiểm tra DATABASE_URL và xem log server» cho mọi người dùng, kể cả khách Chốt Đơn; không có `error.tsx` cho vỏ / gốc | `app/(dashboard)/error.tsx:20` | PR C | **ĐÃ SỬA** `claude/error-boundary-than-thien` 9f5adec3 + `app/error.tsx` gốc — chờ gộp |
| 12 | C1 | ERP | 11 trang «không có `h1`». **Gốc chung (đào sâu):** đó là trang dành cho cửa hàng tự tạo đơn — tổ chức nhà mở ra thì rơi vào màn «Không tìm thấy dữ liệu» của dashboard, mà màn này dùng `h2`. Một chỗ sửa, không phải 11. `/chat/embed` là ô chat nhúng (không cần h1) | harness + ảnh | PR G | **ĐÃ SỬA** `claude/erp-a11y-bo-cuc` |
| 13 | C1 | ERP | Trang chậm: `/chatbot` 4,6 s · `/chatbot/ad-bots` 4,5 s · `/cod` 3,7 s · `/reports/returns` 2,6 s · `/reports/target` 2,6 s (demo 1.126 đơn, máy cục bộ) | harness | PR G (đo trước) | cần đo production |
| 14 | C1 | ERP | `/work/settings`: 24 **công tắc** không tên + 19 ô số trong bảng không tên; `/alerts`: 11 ô số có `Label` không nối `htmlFor` (23 «nút không tên» là checkbox Radix nằm TRONG `<label>` — có tên, báo nhầm của harness); `/inventory/shortage`: 7 nút sao chép chỉ có biểu tượng | `a11y-dump` (DOM thật) | PR G | **ĐÃ SỬA** (cùng nhánh); chiều cao 8.803 px còn lại (C2) |
| 15 | C1 | ERP | `/payroll` tràn ngang ở 390 px — gốc: cụm nút đầu trang «Xuất CSV · Tính & chụp ảnh kỳ · Thêm nhân sự» rộng 418 px không xuống dòng | harness 390 + đo phần tử | PR G | **ĐÃ SỬA** (cùng nhánh) |
| 16 | C2 | Toàn hệ | Chữ nhỏ: 147× `text-[10px]`, 318× `10.5px`, 993× `11px`, 415× `11.5px` trong app/ + components/; computed: 9,5 px ×51, 10 px ×39, 10,5 px ×134, 11 px ×399 trên 15 trang mẫu | grep + sampler | PR B | READY (token) |
| 17 | C2 | Toàn hệ | 17 chiều cao nút khác nhau (16·40·32·28·20·36·21·23·19·29·24…), 26 line-height, 3 chiều cao ô nhập (36/32/28) | sampler | PR B | READY |
| 18 | C2 | Toàn hệ | Tiền: 1.050 chỗ `formatVND` nhưng 68 chỗ in «…đ» tay, 15 chỗ `toLocaleString + ₫`, 15 chỗ «…K» | grep | PR B/E | READY |
| 19 | — | ERP | ~~Ngày ISO in thẳng 7 chỗ~~ — **báo nhầm** (đào sâu 09/10): cả 7 là giá trị ô chọn ngày, tên tệp CSV, khoá nhóm — không phải chữ hiển thị. `dueDate` ở sửa đơn đặt xưởng: ghi `new Date("YYYY-MM-DD")` và đọc lại theo ngày UTC ⇒ khứ hồi khớp, không lệch ngày | grep + đọc mã | — | ĐÓNG |
| 20 | C2 | ERP | Ô bấm nhỏ: `/inventory/returns` 501 · `/departments` 205 · `/settings/modules` 194 · `/inventory/planning` 99 · `/reports/returns` 93 · `/shipments` 83 · `/ads` 83 | harness | PR G | READY |

## 2. Theo bề mặt

### Website công khai (chotdontudong.com · app.chotdontudong.com/pricing)
- Giá: trang chủ và `/pricing` ĐỀU đọc từ máy giá (`getPublicPricing`) ⇒ không lệch (299K · 790K · 1.490K · 2.990K; `/pricing` thêm Enterprise 5.990K, vượt 59K/49K/39K mỗi 100 khách AI, +99K/fanpage, +49K/người). Điều khoản 1.1: hoàn 100% lần đầu trong 7 ngày · giữ dữ liệu 90 ngày · báo đổi giá 30 ngày — khớp `SERVICE_COMMITMENTS`.
- Các vấn đề #1–#4 ở trên. Thêm: Điều khoản có chữ «module»; Chính sách có «token · API · Gemini» (khai nhà cung cấp — LEGAL REVIEW, không tự sửa).
- Tốt: 0 ảnh thiếu alt, 0 nút không tên, 0 tràn ngang ở 390, H1/H2 rõ, liên hệ Zalo/điện thoại ở mọi khối.

### App khách (vỏ Chốt Đơn)
- Hết P0; các P1 ở #5–#7. Thanh menu 8 mục (Tổng quan · Hội thoại · AI Sales · Sản phẩm · Kênh kết nối · Nhân viên · Gói dịch vụ · Cài đặt) khác ưu tiên của sweep (Hộp thư · Đơn hàng · Sản phẩm · AI · Kênh · Báo cáo · Gói · Trợ giúp): **Đơn hàng · Báo cáo · Trợ giúp không có mục** — quyết định chủ shop (bài kiểm khoá số 8).
- Hộp thư: bộ lọc chiếm ~214 px cột trái; 26 ô bấm < 32 px; thanh điều khiển AI ~130 px (INBOX_V2 §2). Chưa đo hiệu năng với 1.000 hội thoại (`saas-inbox-perf`).

### Admin
- #8–#10; chi tiết khách đủ 12 khối trừ AI / đơn (ở `/platform/org`). Gửi lại kích hoạt, job cấp phát, nhật ký: tốt.

### ERP (nội bộ VNX)
- #11–#15, #19–#20. Không lỗi chức năng phát hiện qua harness; các trang báo cáo nặng cần đo production (demo không đại diện).

### Thiết kế hệ thống / chữ / sao chép
- Phông: 1 họ (Plus Jakarta, tốt). Kích thước 17 giá trị; trọng số 5 (ổn); radius 4 giá trị (4 · 10 · pill · 0) ổn.
- Tương phản: **UNKNOWN** — màu là `oklch()`, bộ đo của harness chưa đọc được; cần bộ đo khác.
- Sao chép: 0 nút «OK/Submit»; 1 chỗ «đang xây dựng»; thuật ngữ kỹ thuật còn ở 9 trang vỏ (saas-shell-polish).

### Logic / công thức
- Sổ chỉ số đã có: `docs/metrics-contract.md`, `lib/constants/metric-catalog.ts` (luật 37), `ORDER_OUTCOME` một công thức. Sweep KHÔNG phát hiện hai trang cùng tên chỉ số khác công thức trong phạm vi đã đo (Tổng quan vỏ đọc lại hàm Hiệu quả AI; danh sách khách admin đọc `loadCustomersConsole`). Lỗi còn lại đã ghi: `/customers` «0.0%» (PR r2), ô «0 dùng thử» (#683).
- Tiền / ngày: §1 #18–#19.

## 3. Sẵn sàng sửa ngay (không chồng Launch Sprint)

*Cập nhật 09/10/2026 00:30: PR A · PR C · PR G đã làm (xem §1). `/platform` (PR F) bị `#682` chạm `app/(dashboard)/platform/page.tsx` ⇒ chờ #682 lên production rồi làm. `/platform` «9 nút `outline` bị khoá không có chữ» — **chưa xác nhận**: ba form giá gói (`components/billing/operator-billing.tsx`, `components/pricing/operator-pricing.tsx`) đều có nhãn («Đổi giá…», «Đơn giá mua thêm…», «Lưu cấu hình gói…»); cần đo lại trên DOM của bản có #682 trước khi sửa.*
PR A (website: #1–#4, copy + CTA theo chế độ đăng ký) · PR B (token chữ nhỏ, chiều cao nút/ô nhập, tiền «đ») · PR C (error boundary thân thiện + `error.tsx` cho vỏ) · PR F (bố cục `/platform`, nút không tên) · PR G (`/payroll` 390, h1 cho 11 form, `/work/settings`, `/alerts`, ngày ISO).

## 4. Bị chặn bởi PR / sứ mệnh đang chạy
#682 (tạo khách, thương hiệu, `ConfirmWithReason`?) · #683 (danh sách / chi tiết khách) · saas-shell-polish (login brand, chữ kỹ thuật vỏ, Nhân viên) · #690 (`lib/auth`, `saas-nav`, `saas-shell.test`) · ops-signals (`lib/sales-chatbot/*`, `db/`) · LEGAL (điều khoản / chính sách).

## 5. Ba lô PR đầu
1. **PR A — Sự thật thương mại trang chủ**: bỏ Pancake khỏi bước «Kết nối fanpage» và FAQ (Facebook trực tiếp là đường chính, Pancake/Zalo/chat web là lựa chọn), đổi claim tuyệt đối sang câu bảo vệ được, thay «Chi phí AI hiện rõ» bằng «Biết AI dùng bao nhiêu lượt, chốt bao nhiêu đơn», CTA đọc chế độ đăng ký từ máy chủ (open ⇒ «Dùng thử miễn phí 7 ngày», invite ⇒ «Đăng ký dùng thử» → form liên hệ/Zalo). Tệp: `app/gioi-thieu/page.tsx` (+ `lib/onboarding/signup-mode.ts` chỉ đọc). Bài kiểm: không chuỗi «Pancake» trong bước nối fanpage; không câu «không bao giờ / không … nào» trong H1/H3; CTA theo mode.
2. **PR C — Lỗi thân thiện**: `app/(dashboard)/error.tsx` ba câu (chuyện gì · ảnh hưởng · làm gì) + «Chi tiết kỹ thuật» gập; `app/error.tsx` gốc theo thương hiệu host; không `error.message` thô cho khách (`customerFacing`). Bài kiểm: nguồn không in `DATABASE_URL`.
3. **PR B — Token chữ**: thêm ba bậc chữ nhỏ hợp lệ (12 · 13 · 14) vào `docs/design-system.md`, cấm `text-[10px]`/`10.5px` ở trang khách bằng bài kiểm quét mã (không mass-refactor; sửa dần ở trang vỏ trước: hộp thư, AI Sales, Gói).

## 6. Mismatch giữa ba miền
| Mục | chotdontudong.com | app.chotdontudong.com | erp.vnxcommerce.com |
|---|---|---|---|
| Thương hiệu | Chốt Đơn | Chốt Đơn (login đúng; sau reset ⇒ VNX, #6) | VNX |
| Giá / dùng thử | 7 ngày, 4 gói | 7 ngày, 5 gói (thêm Enterprise) | không in |
| Cách nối Facebook | «qua Pancake» (#1) | Kênh kết nối: nối thẳng Facebook (Meta chờ), Pancake, Zalo, chat web | Pancake |
| Điều khoản / chính sách | có | link về chotdontudong.com | — |
| Hỗ trợ | Zalo 0886 833 448 | `/help` tầng liên hệ (#680) | menu tài khoản → Hướng dẫn |

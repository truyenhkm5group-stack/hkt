# Bảng chất lượng thương mại — Commercial Perfection Sweep (08/10/2026, Phase A chỉ đọc)

*Đi cùng `COMMERCIAL_PAGE_INVENTORY.md` (207 trang). Đo trên `origin/main` b3a8d74e chạy cục bộ (PGlite + dữ liệu demo, host
`app.chotdon.test`), vỏ khách bằng tài khoản khách do admin tạo, production CHỈ trang công khai bằng GET. Không sửa mã nào trong
phase này. Mức: **C0** chặn thương mại · **C1** tác động cao · **C2** đánh bóng · **C3** li ti. Điểm trang chỉ khi người đã xem; chưa
đủ bằng chứng ⇒ UNKNOWN.*

## 0. Bảng điều khiển

| Chỉ số | Giá trị |
|---|---|
| TỔNG TRANG | 207 (13 công khai · 37 vỏ khách · 135 ERP · 8 admin · 14 /tech) |
| ĐÃ AUDIT (máy hoặc người) | **207 / 207** — 175 qua harness (163 route tĩnh 1366 px · 23 ở 390 + 1920 · 21 vỏ khách ×2 khổ · 7 công khai production) + **32 trang động đọc mã** (09/10, mục 7) |
| ĐÃ CHẤM ĐIỂM (người) | 39 |
| ĐÃ SỬA (main, 09/10 cuối ngày) | Commercial Sweep: #705 · #706 · #708 · #712 · #714 · #718 · #721 · #725 · #726 · tài liệu 5676a312. Từ bàn giao của sweep: #715 · #716 · #717 · #719. Cùng đợt, đóng C1 của bảng này: #682 · #683 · #700. Trước đó: #680 R1 · #713 R2 |
| ĐÃ KIỂM PRODUCTION | 7 trang công khai; phần có đăng nhập chờ ops `saas-acceptance` (#690) |
| ĐIỂM TB (39 trang đã chấm) | 77 |
| C0 MỞ | **0** — lượt kiểm trang động tìm ra 1 C0 (form «Sửa đơn VTP» điền sẵn COD của đơn khi vận đơn COD 0 ⇒ gửi COD sai sang Viettel Post) ⇒ **ĐÃ SỬA #717**. 0 rò tổ chức trên 207 trang |
| C1 MỞ | **3**: #7 chữ kỹ thuật còn sót ở vỏ (đang sửa — `shell-copy-brand-r3`) · #4 chế độ đăng ký (quyết định chủ shop) · #13 hiệu năng (chỉ đo được trên production). Mọi C1 khác đã gộp — xem mục 8 |

Harness 1366 px / 163 route: 0 lỗi 5xx · 0 trang trắng · 0 tràn ngang · 0 request hỏng · 0 ảnh thiếu alt · 11 trang thiếu `h1` ·
1 lỗi JS (`/production/topics/new` React #310 ở lượt quét đầu; **0/5 lượt tái hiện** — chuyển hướng sang `/marketing/topics/new` sạch; theo dõi, không sửa mò) · 3 trang > 3,5 s. 390 px / 23 route: 1 tràn ngang
(`/payroll`). Vỏ khách 21 + 17: 0 tràn, 0 lỗi, 1 trang 786 ô bấm nhỏ.

## 1. Top 20 C0 / C1

| # | Mức | Bề mặt | Vấn đề | Bằng chứng | Sửa ở | Trạng thái |
|---|---|---|---|---|---|---|
| 1 | C1 | Công khai | Trang chủ nói kết nối fanpage **qua Pancake** như đường chính: «Dán mã trang và mã truy cập Pancake, chép đường dẫn nhận tin vào Pancake» + FAQ «Fanpage của shop kết nối qua Pancake» | `app/gioi-thieu/page.tsx:294`, `:310` | PR A | **ĐÃ SỬA #706** — review #706 lật chẩn đoán: Pancake LÀ lối chính hôm nay (Meta chưa duyệt quyền Page); trang chủ giữ Pancake, thêm Zalo OA / ô chat web, nối thẳng Facebook «sắp mở». Trong app: #712 (Hướng dẫn, hộp thư, ba nút nối thẳng sau cờ `meta.direct-connect.open`) |
| 2 | C1 | Công khai | Claim tuyệt đối: H1 «Không bỏ lỡ tin nhắn nào. Không để lọt đơn hàng nào.», «không bao giờ báo bừa», H3 «Không sót tin nào», «đơn vào thẳng hệ thống» | `:893`, `:549`, mục «Mười việc» | PR A | **ĐÃ SỬA #706** |
| 3 | C1 | Công khai | «Chi phí AI hiện rõ — tính sẵn chi phí AI trên mỗi đơn chốt» trái định hướng không lộ kinh tế model; khách thấy «khách AI / hạn mức» chứ không thấy chi phí AI | `:256` | PR A | **ĐÃ SỬA #706** |
| 4 | C1 | Công khai | «Dùng thử miễn phí 7 ngày» + CTA `/start` phụ thuộc `PLATFORM_SIGNUP_MODE=open`; nếu chuyển invite-only thì 9 CTA thành lời hứa chết | prod text: 9 link → /start | PR A (CTA theo chế độ đăng ký đọc từ máy chủ) | **MỞ — QUYẾT ĐỊNH CHỦ SHOP.** Hôm nay `PLATFORM_SIGNUP_MODE=open` ⇒ 9 CTA đúng; chỉ thành lỗi nếu chuyển sang chỉ-mời mà CTA không đổi theo |
| 5 | C1 | Vỏ khách | `/settings/users` với khách Chốt Đơn: ma trận quyền 786 ô < 32 px, cao 4.296 px ở 390, chữ «webhook · module · ERP · API» | harness + R1/R2 | saas-shell-polish (chữ) + quyết định vai trò rút gọn (chủ shop) | **ĐÃ SỬA #700** — vỏ ẩn ma trận «Vai trò hệ thống & quyền» (~780 ô nhỏ), Vai trò tuỳ chỉnh, Chức danh; bỏ cột Phòng ban · Quyền & phạm vi. Bộ vai trò rút gọn cho vỏ: tuỳ chọn, không còn chặn |
| 6 | C1 | Vỏ khách | Sau đặt mật khẩu trên host Chốt Đơn, trang đăng nhập dựng với thương hiệu VNX (tải lại thì đúng) — lượt dựng sau `redirect()` của server action không mang header thương hiệu | R2-1 | saas-shell-polish | **ĐÃ SỬA #700** (/login sau đặt mật khẩu đúng thương hiệu host) |
| 7 | C1 | Vỏ khách | Chữ kỹ thuật ở AI Sales (webhook·token·ERP·API·TEST·Field), Kết nối («16 connector», Viettel Post), Thiết lập (module, ERP, link /p chặn), Tài khoản («Cài ERP lên màn hình chính») | R1 §5, R2 C3 | saas-shell-polish | **MỘT PHẦN #700**; chữ kỹ thuật còn sót (AI Sales · Kết nối · Thiết lập) đang sửa ở sứ mệnh `shell-copy-brand-r3` (Tech Lead, RUNNING 09/10) |
| 8 | C1 | Admin | Danh sách khách không trả lời «khách này có chạy không»: thiếu Messenger · AI · đăng nhập cuối · sức khoẻ; «Thuê bao sống · 0 dùng thử» sai nghĩa; 13 ô nhập không nhãn | harness + R2 | #683 | **ĐÃ SỬA #683** |
| 9 | C1 | Admin | Form «Tạo khách…» mờ cho tới khi gõ lý do, ô lý do đứng TRÊN các ô nhập (mọi `ConfirmWithReason` có `children`); thương hiệu mặc định trống ⇒ khách rơi vào vỏ ERP | R1 #6, R2-2 | #682 + `components/platform/pilot-ops.tsx` | **ĐÃ SỬA #682** (thương hiệu Chốt Đơn tự đặt, chỉ gói đang bán, nút không khoá im lặng) |
| 10 | C1 | Admin | `/platform` 6.223 px, khung Webhook Meta (cấu hình một lần) đứng trên bảng tổ chức & sức khoẻ; 9 nút không tên | harness | PR F | **ĐÃ SỬA #714** (khung Webhook Meta xuống dưới phần việc hằng ngày); «9 nút không tên» chưa xác nhận |
| 11 | C1 | ERP + khách | Error boundary dashboard in nguyên `error.message` + «kiểm tra DATABASE_URL và xem log server» cho mọi người dùng, kể cả khách Chốt Đơn; không có `error.tsx` cho vỏ / gốc | `app/(dashboard)/error.tsx:20` | PR C | **ĐÃ SỬA #705** (+ câu LOW «Dữ liệu đã lưu trước đó vẫn an toàn» ở #718) |
| 12 | C1 | ERP | 11 trang «không có `h1`». **Gốc chung (đào sâu):** đó là trang dành cho cửa hàng tự tạo đơn — tổ chức nhà mở ra thì rơi vào màn «Không tìm thấy dữ liệu» của dashboard, mà màn này dùng `h2`. Một chỗ sửa, không phải 11. `/chat/embed` là ô chat nhúng (không cần h1) | harness + ảnh | PR G | **ĐÃ SỬA #708** |
| 13 | C1 | ERP | Trang chậm: `/chatbot` 4,6 s · `/chatbot/ad-bots` 4,5 s · `/cod` 3,7 s · `/reports/returns` 2,6 s · `/reports/target` 2,6 s (demo 1.126 đơn, máy cục bộ) | harness | PR G (đo trước) | **MỞ — CHỈ ĐO ĐƯỢC TRÊN PRODUCTION** (số cục bộ là PGlite + demo 1.126 đơn; sứ mệnh `saas-inbox-perf` cùng tinh thần «đo trước») |
| 14 | C1 | ERP | `/work/settings`: 24 **công tắc** không tên + 19 ô số trong bảng không tên; `/alerts`: 11 ô số có `Label` không nối `htmlFor` (23 «nút không tên» là checkbox Radix nằm TRONG `<label>` — có tên, báo nhầm của harness); `/inventory/shortage`: 7 nút sao chép chỉ có biểu tượng | `a11y-dump` (DOM thật) | PR G | **ĐÃ SỬA #708** |
| 15 | C1 | ERP | `/payroll` tràn ngang ở 390 px — gốc: cụm nút đầu trang «Xuất CSV · Tính & chụp ảnh kỳ · Thêm nhân sự» rộng 418 px không xuống dòng | harness 390 + đo phần tử | PR G | **ĐÃ SỬA #708** |
| 16 | C2 | Toàn hệ | Chữ nhỏ: 147× `text-[10px]`, 318× `10.5px`, 993× `11px`, 415× `11.5px` trong app/ + components/; computed: 9,5 px ×51, 10 px ×39, 10,5 px ×134, 11 px ×399 trên 15 trang mẫu | grep + sampler | PR B | **MỘT PHẦN #718** — token 12·13·14 (`docs/design-system.md` mục 10) + bài chốt 0 chữ < 11 px trên 80 tệp CHỈ thuộc vỏ; trang dùng chung với ERP (Sản phẩm, Đơn, Khách, Phiếu nhập) cần quyết định mật độ riêng |
| 17 | C2 | Toàn hệ | 17 chiều cao nút khác nhau (16·40·32·28·20·36·21·23·19·29·24…), 26 line-height, 3 chiều cao ô nhập (36/32/28) | sampler | PR B | MỞ · C2 backlog (cần token chiều cao nút / ô nhập, không sửa lẻ) |
| 18 | C2 | Toàn hệ | Tiền: 1.050 chỗ `formatVND` nhưng 68 chỗ in «…đ» tay, 15 chỗ `toLocaleString + ₫`, 15 chỗ «…K» | grep | PR B/E | **MỘT PHẦN #721** (phiếu việc hiện trường); bảng giá sỉ còn tự định dạng — thuộc phạm vi `products/` của worker giá vốn |
| 19 | — | ERP | ~~Ngày ISO in thẳng 7 chỗ~~ — **báo nhầm** (đào sâu 09/10): cả 7 là giá trị ô chọn ngày, tên tệp CSV, khoá nhóm — không phải chữ hiển thị. `dueDate` ở sửa đơn đặt xưởng: ghi `new Date("YYYY-MM-DD")` và đọc lại theo ngày UTC ⇒ khứ hồi khớp, không lệch ngày | grep + đọc mã | — | ĐÓNG |
| 20 | C2 | ERP | Ô bấm nhỏ: `/inventory/returns` 501 · `/departments` 205 · `/settings/modules` 194 · `/inventory/planning` 99 · `/reports/returns` 93 · `/shipments` 83 · `/ads` 83 | harness | PR G | MỞ · C2 backlog |

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

*Đóng 09/10/2026 cuối ngày: mọi lô A · B · C · F · G đã gộp (#706 · #718 · #705 · #714 · #708). Việc còn lại xem mục 8.*

## 4. Bị chặn bởi PR / sứ mệnh đang chạy

*Đóng 09/10/2026 cuối ngày: #682 · #683 · saas-shell-polish (#700) đã gộp. Không còn mục nào của bảng bị chặn bởi PR đang mở.*

## 5. Ba lô PR đầu
1. **PR A — Sự thật thương mại trang chủ**: bỏ Pancake khỏi bước «Kết nối fanpage» và FAQ (Facebook trực tiếp là đường chính, Pancake/Zalo/chat web là lựa chọn), đổi claim tuyệt đối sang câu bảo vệ được, thay «Chi phí AI hiện rõ» bằng «Biết AI dùng bao nhiêu lượt, chốt bao nhiêu đơn», CTA đọc chế độ đăng ký từ máy chủ (open ⇒ «Dùng thử miễn phí 7 ngày», invite ⇒ «Đăng ký dùng thử» → form liên hệ/Zalo). Tệp: `app/gioi-thieu/page.tsx` (+ `lib/onboarding/signup-mode.ts` chỉ đọc). Bài kiểm: không chuỗi «Pancake» trong bước nối fanpage; không câu «không bao giờ / không … nào» trong H1/H3; CTA theo mode.
2. **PR C — Lỗi thân thiện**: `app/(dashboard)/error.tsx` ba câu (chuyện gì · ảnh hưởng · làm gì) + «Chi tiết kỹ thuật» gập; `app/error.tsx` gốc theo thương hiệu host; không `error.message` thô cho khách (`customerFacing`). Bài kiểm: nguồn không in `DATABASE_URL`.
3. **PR B — Token chữ**: thêm ba bậc chữ nhỏ hợp lệ (12 · 13 · 14) vào `docs/design-system.md`, cấm `text-[10px]`/`10.5px` ở trang khách bằng bài kiểm quét mã (không mass-refactor; sửa dần ở trang vỏ trước: hộp thư, AI Sales, Gói).

## 6. Mismatch giữa ba miền
| Mục | chotdontudong.com | app.chotdontudong.com | erp.vnxcommerce.com |
|---|---|---|---|
| Thương hiệu | Chốt Đơn | Chốt Đơn (login đúng; sau reset ⇒ VNX, #6) | VNX |
| Giá / dùng thử | 7 ngày, 4 gói | 7 ngày, 5 gói (thêm Enterprise) | không in |
| Cách nối Facebook | Pancake là lối chính + Zalo OA / ô chat web; nối thẳng Facebook «sắp mở» (#706) | Hướng dẫn + hộp thư chỉ Pancake / Zalo / chat web; nút nối thẳng thành «Nối thẳng Facebook — sắp mở» cho khách, người vận hành thấy nút thật (cờ `meta.direct-connect.open`, #712) | Pancake |
| Điều khoản / chính sách | có | link về chotdontudong.com | — |
| Hỗ trợ | Zalo 0886 833 448 | `/help` tầng liên hệ (#680) | menu tài khoản → Hướng dẫn |

## 7. Kiểm trang động — 32 trang còn lại (09/10/2026, đọc mã)

Các trang `[id]` / `[key]` / `[slug]` không quét được bằng harness (cần mã thật). Ba lượt đọc mã độc lập, mỗi phát hiện C0/C1
được đọc lại tận dòng trước khi ghi vào đây. Kết quả chung: **mọi lượt đọc đi qua `getDb()` của phiên + cổng quyền; id là khoá
`text` nên mã sai ra 404 chứ không vỡ ép kiểu; 0 rò tổ chức; `/p/[slug]` chỉ đọc trang đã xuất bản, sau `requireUser`.**

| Phát hiện | Mức | Trang | Đi đâu |
|---|---|---|---|
| Form «Sửa đơn VTP» điền sẵn `cod: s.codAmount \|\| s.order?.cod` + địa chỉ chỉ phần đường ⇒ gửi COD sai sang VTP và ghi đè `codAmount` | C0 | /shipments/[id] | **#717** (worker Tech Lead) |
| Thành công / Hoàn của khách lấy `max(bộ đếm Pancake, ORDER_OUTCOME)`; cảnh báo rủi ro đọc bộ đếm Pancake | C1 | /customers/[id], /orders/[id] | **#715** |
| Giá vốn chưa biết `\|\| 0` / `coalesce(…,0)` ⇒ «Giá vốn 0 ₫», lãi gộp = doanh thu | C1 | /orders/[id], /products/[id] | **#716** |
| Đơn tay / bot ở tổ chức không Pancake: «Thu hộ / Phí sàn / Trả trước 0 ₫», chỉ dẫn + bộ đếm + JSON Pancake; mã sự kiện thô ở xem lại hội thoại; `/products/<mã>` ma trận + ghi chú rỗng | C1 | /orders/[id], /customers/[id], /ai/sales-chatbot/conversations/[id], /products/[id] | **#725** |
| Lệnh đặt xưởng `unitCost` mặc định 0 ⇒ cổng duyệt PURCHASING_LARGE nhận amount 0; dòng giá trống ở bảng chi phí mẫu thành 0 ₫ | C1 | /inventory/planning/orders/[id]/edit, /production/models/[id] | **#719** |
| «%» lẻ trên đường dẫn ⇒ `decodeURIComponent` ném ⇒ 500 | C3→sửa | 4 trang /settings/…/[id] | **#721** |
| Mã Google / loại thông tin / khoá trường thô, «0 đánh giá» | C2 | /wholesale/leads/[id] | **#721** |
| Phiếu sản xuất tràn ngang 390 px; đầu trang không xuống dòng; lượt nhập VTP hỏng in 9 ô «0» | C2 | /inventory/planning/orders/[id], /ideas/[id], /production/topics/[id], /import-vtp/[batchId] | **#721** |
| 80+ ô nhập không tên (lô xưởng 36, khách sỉ, topic, mẫu, luật tự động 18…) | C2 | 8 tệp form | **#726** |
| `/o/[object]/new` gửi định nghĩa trường bị chặn quyền xuống client | C2 | /o/[object]/new | sổ P2 Tech Lead (lib/objects) |
| Ý tưởng xác định «người đăng» bằng email, không `users.id` (luật 34); shipments `generateMetadata` đọc trước kiểm quyền | C3 | /ideas/[id], /shipments/[id] | sổ P2 Tech Lead / #717 |
| Còn mở, nhỏ: chữ lỗi thô (mẫu, cài mẫu, topic, lượt nhập VTP), bảng không cuộn ngang ở vài trang ERP, chữ 10–10,5 px ở trang ERP dày, mã thô ở /tech | C2–C3 | nhiều | backlog đánh bóng |

## 8. Bàn giao cuối Round 2 — 09/10/2026 (đối chiếu với `origin/main` 50293da6)

Trạng thái phiên sweep: **WAITING_FOR_NEXT_PRODUCTION_ROUND**. Không còn nhánh nào của sweep đang chờ; mọi việc dưới đây đã
có chủ.

### 8.1 C0 còn lại — **0**
C0 duy nhất của cả sweep (form «Sửa đơn VTP» điền sẵn COD của đơn cho vận đơn COD 0) đã sửa ở #717. Không có hồi quy C0 nào
được thấy khi đối chiếu. 0 rò tổ chức trên 207 trang.

### 8.2 C1 còn lại — **3**
| # | Việc | Vì sao còn mở | Ai |
|---|---|---|---|
| 7 | Chữ kỹ thuật còn sót ở vỏ Chốt Đơn (AI Sales · Kết nối · Thiết lập) | #700 sửa phần lớn; phần còn lại đang làm | Tech Lead — sứ mệnh `shell-copy-brand-r3` (RUNNING) |
| 4 | CTA «Dùng thử» trỏ `/start` | đúng khi `PLATFORM_SIGNUP_MODE=open` (hôm nay); chỉ sai nếu đổi sang chỉ-mời | chủ shop quyết chế độ ⇒ Tech Lead nối CTA theo chế độ |
| 13 | `/chatbot` 4,6 s · `/chatbot/ad-bots` 4,5 s · `/cod` 3,7 s · `/reports/returns` · `/reports/target` 2,6 s | số đo cục bộ (PGlite + demo), chưa đo production — không sửa mò | Tech Lead đo trên production rồi mới quyết |

### 8.3 Quyết định của chủ shop
1. Chế độ đăng ký công khai (`open` hay chỉ-mời) — quyết xong thì CTA trang chủ theo đó (#4).
2. Ngày mở nối thẳng Facebook: khi Meta duyệt quyền Page (MM-META-01), đặt cờ nền tảng `meta.direct-connect.open` = `true`
   (hoặc danh sách mã workspace để thử trước). **Hiện CHƯA có đường bấm để bật cờ** — Tech Lead đã ghi sổ.
3. Mật độ cho trang dùng chung ERP ↔ vỏ (Sản phẩm, Đơn, Khách, Phiếu nhập còn chữ 10–10,5 px): giữ bảng dày cho ERP hay có
   bố cục riêng cho vỏ trên điện thoại.
4. (Tuỳ chọn, không chặn) bộ vai trò rút gọn cho nhân viên cửa hàng ở vỏ.
5. LEGAL REVIEW: câu chữ «token · API · Gemini» ở Chính sách bảo mật, «module» ở Điều khoản — chờ luật sư, sweep không viết lại.

### 8.4 Việc chỉ làm được trên production
1. Đo hiệu năng #13 (thời gian dựng thật của 5 trang trên, cùng dữ liệu thật).
2. Lượt nghiệm thu có đăng nhập ở vỏ khách (ops `saas-acceptance`): xác nhận #700 (thương hiệu sau đặt mật khẩu, chữ kỹ
   thuật), #712 (khách thấy «Nối thẳng Facebook — sắp mở», người vận hành thấy nút thật), #718 (không chữ < 11 px ở hộp thư).
3. Mở bằng mã thật trên một tổ chức KHÔNG Pancake (HSLC): `/orders/<đơn tay>` không còn «Thu hộ / Phí sàn / Trả trước 0 ₫»
   (#725), `/customers/<id>` không còn dòng Pancake, `/ai/sales-chatbot/conversations/<id>` in tên sự kiện tiếng Việt.
   32 trang động của mục 7 mới được kiểm bằng ĐỌC MÃ, chưa dựng bằng trình duyệt.
4. `/shipments/<id>` với vận đơn COD 0: form «Sửa đơn VTP» điền 0 và đòi xác nhận khi đổi COD (#717).

### 8.5 Việc của Tech Lead (đã có trong sổ hoặc cần ghi sổ)
| Mức | Việc | Nơi |
|---|---|---|
| C2 | `/o/[object]/new` gửi định nghĩa + lựa chọn quan hệ của trường bị `viewPermission` chặn xuống client (trang `[id]` có lọc) | `app/(dashboard)/o/[object]/new/page.tsx:27-44`, `lib/objects` |
| C3 | Ý tưởng xác định «người đăng» bằng email (`idea.createdBy === user.email`), không `users.id` (luật 34) | `app/(dashboard)/ideas/[id]/page.tsx:25` |
| — | Đường bật cờ `meta.direct-connect.open` cho người vận hành | /platform hoặc ops `set-setting` cho `platform_settings` |
| C2 | Chữ lỗi thô hiện cho người dùng: gợi ý ở Model 360, cài mẫu, chứng cứ topic sản xuất, lượt nhập VTP | `app/(dashboard)/models/[id]/blocks.tsx:115`, `components/blueprints/install-panel.tsx:197`, `lib/actions/production-topics.ts:127` (lưu `e.message` vào chứng cứ), `import-vtp/[batchId]` |
| C2 | Bảng không cuộn ngang ở 390 px; trạng thái rỗng thiếu | `/platform/products/[key]`, Model 360, thanh toán vải lô xưởng, báo giá phiếu việc |
| C2 | Bảng giá sỉ tự định dạng tiền + mã mẫu mã thô khi đã xoá | `products/price-lists/[id]/page.tsx:35` |
| C2 | Token chiều cao nút / ô nhập (#17), ô bấm nhỏ ở bảng ERP dày (#20) | toàn hệ |
| C3 | `/orders/[id]/edit` mở được bằng URL cho đơn đã hoàn / hãng đang giữ (lõi vẫn chặn lưu); `toInt` nhận «1.5» thành 15 | `lib/records/order-create.ts:897`, `orders/manual-order-form.tsx:41` |
| C3 | Mã thô ở /tech (tác nhân «undefined», approvalStatus, source) | `tech/incidents/[id]`, `tech/tasks/[id]` |

Mọi mục C2/C3 ở trên là đánh bóng — không cái nào chặn bán hàng.

# Bản audit toàn hệ thống 13/09/2026 — đo production, sửa tận gốc, một lần deploy

*Vai trò: principal ERP engineer · production auditor · release integrator · UI/UX owner.*
*Nguyên tắc: không tin implementation cũ vì "đã merge / test xanh / đã deploy"; mọi kết luận phải có số đo
production (ops `db-query`, chỉ đọc) hoặc kiểm chứng trình duyệt thật.*

## 0. Mốc

| | |
|---|---|
| Production trước audit | `d70171d5` (deploy #34751228382, 10:12 UTC) |
| `origin/main` lúc bắt đầu | `2251ab5` (chỉ thêm docs so với bản đang chạy) |
| Nhánh audit | `claude/audit-fable-2026-09-13`, worktree riêng, tạo từ `origin/main` |
| Kiểm thử nền | typecheck sạch · lint sạch · `npm test` "TẤT CẢ KIỂM THỬ ĐẠT" trên `2251ab5` |

## 1. Ảnh chụp KPI production TRƯỚC (ops `kpi-snapshot`, 10:39 UTC)

| | |
|---|---:|
| Tổng đơn | 2.698 |
| Giao thành công / hoàn / hoàn theo luật | 488 / 979 / 0 |
| Đang giao / chưa rõ / chưa gửi / huỷ | 331 / 13 / 228 / 659 |
| GTC % | 33,3 |
| Tiền lên đơn / GTC / thực nhận có chứng từ / COD đang chờ | 1.044.235.498 / 260.601.999 / 218.215.000 / 40.866.999 |
| Vận đơn / sự kiện vận đơn / việc đang mở / hoàn chờ kiểm | 2.108 / 31.769 / 453 / 619 |

## 2. Bằng chứng production dẫn tới từng quyết định sửa

### 2.1 Care vận đơn (`shipment_care`, 182 đợt đang mở)

| Trạng thái ĐVVC (xấp xỉ) | Đã rời kho | Kiện | Có đợt đang mở |
|---|---|---:|---:|
| Chờ xử lý (mã 102, chưa lấy hàng) | không | 106 | **106** — máy mở cho hàng còn trong kho |
| Chờ xử lý (đã lấy hàng, đang chờ quyết định ở bưu cục) | có | 48 | **6** — 42 kiện thật sự cần người lại không vào hàng đợi |
| Tồn (506/507) | có | 17 | 11 |
| Chờ phát lại | có | 29 | 29 |

Thêm: 16 đợt `WAITING_*` không có hẹn theo dõi (biến mất khỏi "Cần care" vĩnh viễn); 76 đợt lịch sử
`care_outcome NULL` vẫn `active`; 7 RESOLVED + 6 CANCELLED vẫn `active = true` (migration 0075);
`care_business_actions` và `carrier_action_requests` **0 dòng** — bốn quyết định nghiệp vụ và lệnh ĐVVC
chưa từng được dùng; 0 đợt RESCUED_DIRECT trên kiện đã hoàn (lỗi 501 chiều hoàn chưa kịp phát nổ).

### 2.2 TL GTC ước tính — khoảng cách giữa `stage` và `ORDER_OUTCOME` (cohort 30 ngày theo ngày ĐVVC nhận)

| Mã | Đơn | GTC (outcome) | Hỏng (outcome) | Đang giao | `stage = DELIVERED` nhưng outcome ≠ DELIVERED |
|---|---:|---:|---:|---:|---:|
| Q002 | 799 | 189 | 512 | 91 | **134** |
| Q003 | 525 | 180 | 205 | 135 | **40** |
| Q004 | 96 | 8 | 3 | 84 | 9 |
| Q005 | 21 | 0 | 0 | 20 | 0 |

Mã 501 "Phát thành công": 119 kiện từng mang mã, 119 `stage = DELIVERED`, chỉ **87** là giao thành công
theo ORDER_OUTCOME (27% là 501 chiều hoàn). Mô hình dự báo cũ học nhãn từ `stage` nên lạc quan có hệ thống.
Độ chín: DELIVERED p50 2,8 ngày · p95 5,7 ngày; RETURNED p50 7,0 · p95 **13,1** ngày ⇒ cửa sổ chín 14 ngày.

### 2.3 CSKH và hàng hoàn

`cs_cases` kind `DELIVERY_FAILED`: OPEN 236 (không ai giữ) + OPEN 4 (Bot) + IN_PROGRESS 99 (Bot) + DONE 21.
Màn CSKH đã lọc đúng theo miền (không hiện), nhưng dữ liệu vẫn sống ở bảng CSKH và bot "không nhắn được"
không tới hàng đợi nào. Hàng hoàn: 619 kiện chờ kho (hai định nghĩa trùng nhau), 986 theo định nghĩa của
hàng đợi nhận (gồm RETURNING), 0 kiện đóng không chứng từ, **0 dòng `return_inspections`** — trạm kiểm chưa
từng được dùng.

### 2.4 Tài chính

`bank_transactions` từ file nhập không có tài khoản: 80 dòng; trùng `bank_ref` sau chuẩn hoá: 0; khoản chi
sinh từ sao kê (tiền tố `MB `): 21 (11 SHIPPING + 1 RETURN_FEE thuộc thẩm quyền nguồn khác); vận đơn bị
ghi `cod_collected = cod_amount` từ dòng bảng kê `cod = 0` (đo chặt): **0** — lỗi đường ghi có thật nhưng
chưa làm hỏng dữ liệu.

### 2.5 Quyền

7 tài khoản đang hoạt động, tất cả `data_scope = ALL`, tất cả đã có phòng ban.

### 2.6 Lợi nhuận production TRƯỚC (ops `profit-verify`, 11:06 UTC — cùng hàm giao diện gọi)

| Kỳ | Doanh số POS | DT giao TC | Giá vốn | Vận chuyển | Quảng cáo | Vận hành | Cố định | Rủi ro TK | LN ròng | QC/POS % | QC/DT GTC % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Trọn tháng 9 | 343.311.998 | 46.608.499 | 32.650.855 | 13.847.529 | 74.909.714 | 6.800.000 | 2.100.000 | 3.265.086 | 17.997.481 | 21,8 | 160,7 |
| Tuần 1 (01–07) | 265.358.998 | 41.618.499 | 25.390.388 | 10.708.654 | 43.108.818 | 6.800.000 | 1.150.000 | 2.539.039 | 24.758.997 | 16,2 | 103,6 |
| Tuần 2 (08–14) | 77.953.000 | 4.990.000 | 7.520.343 | 3.136.589 | 31.800.896 | 0 | 950.000 | 752.035 | −6.300.337 | 40,8 | 637,3 |

Năm phép kiểm của script (phân bổ ≤ trọn tháng, không Infinity/NaN) đều đạt. Con số "rủi ro tồn kho"
KHÁC 0 ở cả ba kỳ — phần "Risk = 0 hàng loạt" mà đề bài nghi ngờ đã được bản `c7ab0a9` sửa từ trước;
phần còn sai là giá vốn rơi về 0 âm thầm khi thiếu đơn giá (mục 5.4 dưới).

### 2.7 Hiệu năng TRƯỚC (`scripts/bench-reports.ts --scale=4`, PGlite, cùng máy — chỉ để so trước/sau)

| Trang | lạnh (ms) | ấm (ms) |
|---|---:|---:|
| Tổng quan | 2.416 | 0,1 |
| Vận đơn | 2.110 | 65,9 |
| Chất lượng dữ liệu | 2.056 | 0,1 |
| Quảng cáo | 1.984 | 11,2 |
| Sản phẩm & tồn kho | 1.675 | 384,8 |
| Báo cáo lợi nhuận | 874 | 0,1 |
| Tỷ lệ giao thành công / theo mẫu mã | 521 / 472 | 70,4 / 79,0 |

## 3. Ưu tiên 0 — tiêu đề cột dính (root cause và hợp đồng chung)

**Root cause (đo bằng Chromium trên trang tái hiện tối giản):** mọi khung bao bảng đều `overflow-x: auto`
để cuộn ngang. Theo đặc tả CSS Overflow, một phần tử đã cuộn ngang thì `overflow-y` không thể là `visible`
nữa — nó thành khung cuộn hai chiều và là **scrollport** của `position: sticky`. Hệ quả với luật cũ
`th { position: sticky; top: 3.5rem }`:

| Đo | Kết quả |
|---|---|
| lúc tải, `th` so với dòng 1 | `th` 412→450px, dòng 1 394→428px — tiêu đề bị đẩy xuống 56px, đè lên dòng 1–2 |
| cuộn trang 320px | `th` trôi cùng bảng (92px), không dính dưới thanh tiêu đề |

Nghĩa là "mốc dưới thanh tiêu đề ứng dụng" không bao giờ có tác dụng với bảng cuộn ngang; nó chỉ tạo ra
đúng hai triệu chứng chủ shop thấy: *đè dữ liệu* (bảng ngắn, mốc 3.5rem) và *không dính* (cuộn trang).

**Hợp đồng chung** (`lib/constants/table-ux.ts`, `app/globals.css`, `components/ui/table.tsx`):
- ba biến CSS ở `:root`: `--app-header-height` (thanh tiêu đề đọc nó), `--table-head-top` (mặc định 0),
  `--table-max-height` (một khung nhìn trừ thanh tiêu đề và chỗ cho phân trang, sàn 20rem);
- khung bảng luôn là `TABLE_SCROLL` (cuộn hai chiều, có trần chiều cao); tiêu đề dính ở mốc 0 của chính
  khung; bảng ngắn hơn trần không có thanh cuộn, trang cuộn bình thường; không `overscroll-contain`;
- nền tiêu đề đặc (`bg-table-head`), đường kẻ dưới bằng `box-shadow` (border của ô dính bị bỏ lại khi
  cuộn với `border-collapse`); `z-10` < thanh tiêu đề `z-20` < portal `z-50`;
- thanh hành động hàng loạt (`STICKY_TOOLBAR`) dính dưới thanh tiêu đề để thao tác luôn gần dữ liệu;
- hộp thoại: KHÔNG bọc `<Table>` bằng khung cuộn thứ hai (hai scrollport ⇒ tiêu đề lại trôi); trần
  chiều cao truyền qua `containerClassName`.

**Đã migrate:** `DataTable` (bỏ ngưỡng "12 dòng"), 99 chỗ `<Table>` (qua primitive), và các bảng thô:
workbench care, care-report, rescue-report, reason-group-table, reason-section, receive-queue,
campaign-mapping, role-matrix, receipt-dialog, bank-import-dialog, work/today panels, inspection-station.

**Kiểm chứng trình duyệt (Playwright, Chromium, dev server + dữ liệu demo, 1440×900, zoom 90/100/110%):**
22 màn hình — mọi `th` `position: sticky; top: 0`, không đè dòng đầu, nền đặc `oklch(0.972 0.004 250)`;
cuộn 200–300px trong khung thì tiêu đề vẫn ở mốc 0 và cột tiêu đề/thân lệch 0px sau khi cuộn ngang
150px; thanh "Đã chọn" nằm trên tiêu đề; menu dòng mở ra không bị cắt và nằm trên tiêu đề
(elementFromPoint trả về menu); phân trang sang trang 2 hoạt động. Ảnh chụp lưu ở thư mục QA của phiên.

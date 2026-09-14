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

## 4. Thẻ điểm các release gần đây (review lại implementation của các model trước)

Thang: GOOD (giữ nguyên) · NEEDS_FIX (đúng hướng, có lỗi phải sửa) · INCOMPLETE (mới có nửa) · WRONG
(sai luật, đã làm lại) · REPLACE (bỏ đường cũ).

| Workstream | Trạng thái | Ý định | Bằng chứng production / mã | Vấn đề | Đã sửa trong bản này |
|---|---|---|---|---|---|
| Shipment Care / VTP lifecycle (`b043fe0`, `ee8c8f8`, `4b9a2bc`) | **WRONG → sửa** | Cần care = WAITING_PROCESSING ∪ WAITING_REDELIVERY; ĐVVC mở/đóng ca | 106/106 ca mở cho hàng CHƯA rời kho, 6/48 ca cho hàng đang chờ ở bưu cục; lifecycle đọc mã 501 không phân biệt chiều; RESOLVED/CANCELLED vẫn `active` | hai định nghĩa "cần care" (tháp ≠ vòng đời); 501 chiều hoàn = "cứu được"; từ chối điều kiện vẫn ghi quyết định; WAITING không hẹn biến mất; hai nghĩa "đã đóng" | một luật vào care (`lib/care/entry.ts`) dùng chung tháp + vòng đời; đóng theo chặng leg-aware; đối chiếu độ phủ 10 phút/lần; migration 0076 sửa cờ; hộp thoại Duyệt hoàn / Đổi; SLA đọc từ sổ; quy kết qua ASSIGN event |
| Rescue performance / PIC (`56f6853`) | **NEEDS_FIX → sửa** | Tỷ lệ cứu = cứu được / (cứu được + thất bại), pending ngoài mẫu số | 6 ca chốt (5 thất bại, 1 cứu) đều có người; 106 PENDING + 76 NULL bị lọc mất theo `outcome_at` | thẻ "chưa có kết quả" luôn 0 khi có kỳ; "được giao trong kỳ" lấy owner hiện tại; RETURNING/huỷ trước lấy hàng tính là thất bại | đếm pending tính đến cuối kỳ; chỉ mã cuối mới chốt; huỷ trước lấy hàng = ngoài điều kiện care; báo cáo nhân sự khoá theo `users.id` |
| Return reason report (`c22b5bf`, `7308ada`) | **GOOD** | taxonomy 40 lý do, theo mã hàng, người ghi đè suy luận | 603 vận đơn hoàn 90 ngày, 100% có mốc kết quả; 26/40 lý do chỉ có khi người ghi (test khoá) | thiếu `key` trên Fragment (cảnh báo console) | sửa key; bảng dùng hợp đồng dính |
| Product/SKU shipment filters (`619dac3`) | **GOOD** | lọc vận đơn theo mã hàng qua quan hệ thật | join qua `order_items → product_variants` | facet care đếm cả đợt đã đóng | facet chỉ đợt đang mở |
| Projected GTC (`575cc77`, `f3767a4`, `1ac6a9a`, `a08b292`) | **WRONG → làm lại V3** | một hợp đồng, xác suất từ lịch sử, cùng số trên hai trang | 134/799 đơn Q002 `stage=DELIVERED` nhưng outcome ≠ DELIVERED; 27% sự kiện 501 là chiều hoàn; backtest in-sample và rò rỉ trạng thái cuối; profit tab vẫn POS × (1−r) | nhãn học từ `stage` (vi phạm luật 2); đơn chưa mô hình hoá bị coi P=0; huỷ nằm trong mẫu số; không cửa sổ chín | V3: nhãn và cohort theo ORDER_OUTCOME; cửa sổ chín p95 (14 ngày); backtest tách thời gian (bias, Brier, calibration, độ phủ) + mức tin cậy hiện trên cả hai trang; mẫu số trừ phần "ngoài ước tính"; DT GTC ƯT theo từng đơn |
| Profit / CPQC / rủi ro tồn kho (`c7ab0a9`, `dcaed9d`, `c23b16c`, `d70171d`) | **NEEDS_FIX → sửa** | hai tỷ lệ CPQC, rủi ro theo giá vốn hàng bán ra | production rủi ro TK ≠ 0 ở cả 3 kỳ (đã đúng); giá vốn rơi về 0 âm thầm; hai mẫu số CPQC/DT GTC trên cùng tab | ngưỡng màu hard-code hai bộ khác nhau; 40% mặc định thay chỗ "chưa đo được"; `failedToReturnRate` chết vẫn chạy 2,9 s | một helper `adsRatios`; cờ `cogsKnown`/`purchaseCostKnown` hiện "—"; nguồn `unmeasured`; một bộ ngưỡng; xoá hàm chết |
| Finance truth / Bank / SePay (`release-2026-09-12-finance`) | **NEEDS_FIX → sửa** | sao kê không tạo chi phí; mối nối là đối chiếu | webhook SePay: chữ ký/idempotency/đa tài khoản đúng; nhưng đường "nhập sao kê → chi phí" vẫn sống (21 khoản chi `MB `, 12 thuộc thẩm quyền nguồn khác); 80 dòng nhập file không tài khoản; bảng kê `cod=0` ghi `cod_collected = cod_amount` (chưa gây hại: 0 kiện) | trần mối nối chỉ một phía; xoá chi phí để lại mối nối mồ côi; UNCLASSIFIED tính vào "kinh doanh" | gỡ dialog + action; `cost_source='BANK_IMPORT'`, từ chối nhóm nguồn khác; trần hai phía + transaction; chuẩn hoá `bank_ref`, không đè số tiền im lặng, bắt chọn tài khoản; UNCLASSIFIED thành khoang riêng; tạo khoản chi cũng qua duyệt hai người |
| Work OS / OKR / BSC (`b3f5d98`…`dc65681`) | **GOOD (nền) · NEEDS_FIX (giao việc)** | hàng đợi là phép chiếu; assignment có một sự thật | 19 luật khoá bằng test; nhưng `assignWork` ghi overlay `work_items.assignee_id` trong khi CS_CLAIM ghi `cs_cases.assignee_user_id`; Bot ERP thành "người" trong tải phòng ban | hai người phụ trách cho một ca; KR mặc định UP; objective tạo ra đã ACTIVE; lead hai nguồn sự thật | giao việc đi qua miền sở hữu (`lib/work/assign.ts`); bot = máy; hướng KR từ sổ chỉ số; DRAFT mặc định; một lead |
| Roles / positions / scopes (`efd4610`, `a6716d4`) | **GOOD · một lỗi HIGH** | ba chiều không suy ra nhau | chức danh không vào quyền (test quét mã); scope CHECK ở CSDL; nhưng phạm vi CSKH khớp cột TÊN bằng EMAIL ⇒ SELF/ASSIGNED thấy 0 dòng; WORK khai scope mà không ai áp | fallback `ALL`; mutation không kiểm scope | khớp bằng `users.id`; fallback `SELF`; `rowInScope` cho mutation; WORK áp ở ranh giới phép chiếu |
| CSKH workqueue (`release-2026-09-12-cskh-workqueue`) | **NEEDS_FIX → sửa** | logistics ra khỏi CSKH | màn CSKH lọc đúng miền; nhưng 339 dòng DELIVERY_FAILED vẫn sống trong `cs_cases`, 236 "bot không nhắn được" không tới hàng đợi nào; dialog lưu xoá người phụ trách | server nhận loại logistics từ người; facet theo chữ | bàn care hiện cờ bot; enum loại/trạng thái cho người; sự kiện STATUS/ASSIGN từ dialog; facet theo `assignee_user_id` |
| Inventory returns (`return-item-inspection`) | **WRONG ở đường đếm nhanh** | hàng hoàn chỉ vào tồn theo số đếm thật | 0 dòng `return_inspections` (chưa dùng); nhưng đường "cả kiện" chia số đếm theo tỷ lệ; vận đơn chiều về ghi 0 im lặng; phiếu tái nhập tay gạch kiện theo FIFO | ba định nghĩa "chờ kho" | chỉ đếm khi một mẫu mã, còn lại bắt "kiểm từng món"; phiếu tay chỉ đóng kiện được chỉ tên; một vị ngữ `IS_RETURN_AWAITING_WAREHOUSE`; `pendingItems` null khi chưa rõ |
| Attribution identity (`a0178b6`) | **GOOD** | quy kết bằng khoá tài khoản | `care_case_events` 63 ASSIGN đều có `actor_id`/`next_owner_id` | vài báo cáo cũ còn khoá theo chữ | care-report theo `users.id` |
| AI copilot (`handoff-ai-copilot`) | **GOOD** | tool có quyền, ghi phải xác nhận | HMAC token theo (user, tool, input), re-check quyền, audit | tool ghi care chỉ cần `shipments:view` | nâng lên `shipments:manage` |
| Perf / UI shell (`erp-ui-redesign-opus5`, `ec6fc9d`) | **NEEDS_FIX (sticky) → sửa** | bảng dùng được, tiêu đề dính | 22 màn hình; lỗi đè dữ liệu/không dính do scrollport | `Select` item-aligned (menu bay y=6787); ngày in theo UTC; tăng chi phí tô xanh | hợp đồng dính (mục 3); popper mặc định; `formatDate`; `goodWhen` |
| Bảo mật route | **NEEDS_FIX → sửa** | server-side authoritative | webhook VTP mở toang khi thiếu secret; `?secret=` trên URL; GET chạy job; không chặn dò mật khẩu | | 503 khi thiếu secret (prod); so bí mật hằng thời gian; POST-only + `fix/apply` cần `settings:manage`; chặn dò 5 lần/15 phút |

## 5. Những phần của bản trước LÀM TỐT (giữ nguyên, có bằng chứng)

- `ORDER_OUTCOME` một công thức, bảng dẫn xuất có phiên bản + guard cũ (`return-rate.ts` 213–257, 340–357).
- Webhook SePay: HMAC trên byte gốc, cửa sổ 300 s, UNIQUE ở CSDL, gửi lại không nhân đôi (test đồng thời).
- Webhook VTP/Pancake: 200 nhanh, xử lý trong `after()`, dedupe theo mã+trạng thái+mốc ĐVVC.
- Lời từ chối của VTP đi thẳng ra màn hình (`tuChoiNghiepVu`, `IntegrationError.carrier`); endpoint/payload
  `order/UpdateOrder` đúng tài liệu; bulk xét điều kiện trước, kết quả từng kiện, audit.
- Ràng buộc "một đợt care đang mở" ở CSDL (`shipment_care_active_uidx`), không ở `if`.
- Cost engine một đường (`getOperatingCost`/`getRecognizedCosts`), test quét mã nguồn chặn cộng tay.
- Phân trang có tie-breaker ở mọi danh sách; memo key mang đủ tham số; `sql.raw` chỉ hằng compile-time.
- Access: chức danh không vào quyền (test quét mã), vai trò tuỳ chỉnh không cấp `users:manage`, scope CHECK.
- Kỳ review FINAL đóng băng ảnh chụp; phân việc thuần, chạy thử mặc định; leo thang tính lúc đọc.
- Hàng hoàn: mapping theo định danh (`legBaseCode`), AMBIGUOUS/UNRESOLVED là giá trị hợp lệ, đường
  kiểm từng món đúng luật 10.

## 6. Kết quả sau khi sửa — đo trên cùng máy, cùng dữ liệu

### 6.1 Hiệu năng (bench scale 4, tải lạnh / ấm, ms) — trước → sau

| Trang | Trước | Sau | Ghi chú |
|---|---:|---:|---|
| Tổng quan | 2.416 / 0,1 | 2.364 / 0,1 | |
| Vận đơn | 2.110 / 65,9 | 2.024 / 42,5 | facet care chỉ đợt đang mở |
| Quảng cáo | 1.984 / 11,2 | 2.447 / 11,6 | +0,46 s tải lạnh cho V3 + thử ngược (memo 10 phút) |
| Tỷ lệ giao thành công | 521 / 70,4 | 925 / 67,8 | bản gộp đầu tiên 7.033 ms — đã sửa (`taiKho()` tải cohort một lần) |
| GTC theo mẫu mã | 472 / 79,0 | 944 / 79,5 | như trên |
| Báo cáo lợi nhuận | 874 / 0,1 | 839 / 0,1 | |
| Sản phẩm & tồn kho | 1.675 / 384,8 | 1.652 / 392,7 | chưa tối ưu (P1 dưới) |

### 6.2 Kiểm thử

`npm run typecheck` · `npm run lint` · `npm test` ("TẤT CẢ KIỂM THỬ ĐẠT") · `npm run build` — chạy trên
bản gộp và chạy lại trên checkout SẠCH theo SHA ứng viên (AGENTS mục 9). Kiểm thử mới / mở rộng:

| Tệp | Khoá gì |
|---|---|
| `tests/care-os.test.ts` (viết lại, 60 assertion) | 102 chưa rời kho không mở ca; 501 chiều hoàn = RESCUE_FAILED; từ chối điều kiện không ghi gì; WAITING không hẹn = tới hạn; đóng ⇔ inactive; reopen; đối chiếu 48→48 / đóng 106; pending tính đến cuối kỳ; huỷ trước lấy hàng = ngoài care |
| `tests/care-states.test.ts` | luật vào care, ánh xạ leg-aware |
| `tests/projected-delivery.test.ts` (mới, 388 dòng) | nhãn/cohort theo ORDER_OUTCOME; cửa sổ chín; ngoài ước tính rời mẫu số; DT/giá vốn theo từng đơn; tổng hai trang cùng số; thử ngược tách thời gian; một hàm ba tỷ lệ QC; một bộ ngưỡng |
| `tests/reporting-parity.test.ts` | parity với đơn ĐANG GIAO và dòng RETURNED_BY_RULE |
| `tests/return-inspection.test.ts` (+3 khối) | nhiều mẫu mã bị từ chối (đơn lẻ + hàng loạt); đếm vượt bị chặn; chiều về cộng đúng mẫu mã và đóng chiều đi; phiếu tay chỉ đóng kiện được chỉ tên |
| `tests/scope-enforcement.test.ts` | phạm vi CSKH khớp bằng `users.id`; `rowInScope` từ chối identifier lạ; WORK áp ở phép chiếu |
| `tests/work-os.test.ts` | giao việc đi qua miền sở hữu (không overlay); bot không phải người |
| `tests/org-membership.test.ts` | một lead, drift `MULTIPLE_LEAD_ROWS` |
| `tests/cs-workqueue.test.ts` | bot không đổi `open`/`unassigned`; enum loại/trạng thái cho người |
| `tests/bank-ledger.test.ts`, `finance-truth.test.ts`, `finance-cockpit.test.ts`, `finance-invariants.test.ts` | `cost_source='BANK_IMPORT'` + từ chối nhóm nguồn khác; trần mối nối hai phía; chuẩn hoá `bank_ref`, không đè số tiền; UNCLASSIFIED ngoài "kinh doanh"; quét mã: không tệp `app/`/`lib/actions` nào import đường nhập sao kê → chi phí |
| `tests/sync-fixtures.test.ts` | bảng kê dòng chỉ cước không ghi `cod_collected` |
| `tests/login-throttle.test.ts` (mới) | chặn dò mật khẩu theo email và IP; so bí mật hằng thời gian |
| `tests/migration-upgrade-path.test.ts` | 75 → 76 migration |

Migration mới: **`0076_care_active_invariant`** — sửa cờ `active` cho đợt RESOLVED/CANCELLED (không backfill người, không đoán kết quả).

## 7. Còn lại (P1, không làm trong bản này — có lý do)

1. **`carrier_handoff_at` vật chất hoá** (`shipments` + chỉ mục): mốc "ngày ĐVVC nhận" hiện là
   `coalesce(picked_up_at, min(events))` tương quan, không dùng chỉ mục được; mọi báo cáo theo cohort
   gửi hàng quét toàn bảng (ấm ~70–80 ms ở scale 4, tuyến tính theo số vận đơn). Cần migration + job
   backfill có báo cáo chạy thử (luật 35) — để riêng một release.
2. **Trang Sản phẩm & tồn kho ấm 390 ms**: `listProducts` join ba truy vấn con theo trang, chưa memo.
3. **`formatVND(null)` / `formatPercent(null)` in `0 ₫` / `0.0%`** (`lib/format.ts`): vi phạm luật
   "NULL là chưa biết" ở tầng helper. Không đổi trong bản này vì hàng trăm chỗ gọi truyền `null` cho
   tổng rỗng hợp lệ; cần rà từng chỗ.
4. **Ngưỡng màu hard-code** ở `/returns`, `/customers`, `expenses/columns` (ROAS 3/1,5), coverage
   0,8/0,5 — luật 38 đòi đọc `metric_targets`; đã gom về một bộ hằng ở phần lợi nhuận/GTC, phần còn
   lại chờ chủ shop khai đích.
5. **Bot giao hụt vẫn ghi `cs_cases`** (miền giao vận): đã hiện cờ trên bàn care; chuyển hẳn kết luận
   của bot sang `care_case_events` là việc của release CSKH kế tiếp.
6. **Phiếu tái nhập ở `/inventory/receipts`** chưa có ô chọn vận đơn cho từng dòng (dialog đang bỏ
   `shipmentId`): phiếu vẫn cộng tồn đúng số đếm nhưng không đóng kiện nào — đường đóng kiện là trạm
   `/inventory/returns`. Cần bộ chọn vận đơn trong dialog.
7. **Đường nhập sao kê MB → chi phí** chỉ còn ở script/ops (`import-bank-ledger`); nên gỡ hẳn sau khi
   chủ shop xác nhận không dùng.
8. **Duyệt hoàn / Đổi** ở bàn care đã có hộp thoại nhưng `care_business_actions` production = 0: cần
   chủ shop cho đội dùng thật một tuần rồi đo lại tỷ lệ cứu.

## 8. UNKNOWN / UNATTRIBUTED / INSUFFICIENT_DATA còn hiện trên màn hình (đúng chủ đích)

- 76 đợt care lịch sử `care_outcome NULL` — không quy kết, không vào tỷ lệ cứu (luật 35).
- Tỷ lệ cứu đơn: mới 6 ca chốt ⇒ mức tin cậy thấp; pending 106 hiện riêng.
- TL GTC ước tính: trạng thái chưa đủ 10 mẫu ⇒ "chưa đo được", đơn ở trạng thái đó là "ngoài ước
  tính" và rời mẫu số; mức tin cậy của thử ngược in cạnh số (HIGH/MEDIUM/LOW/INSUFFICIENT_DATA).
- Giá vốn chưa biết ⇒ "—" kèm số sản phẩm không có đơn giá, không phải 0.
- Kiểm đếm hàng hoàn: kiện chưa lần được đơn ⇒ "chưa rõ hàng", không đếm 0 món.
- Dòng tiền chưa phân loại: khoang riêng, in "còn N dòng / X ₫ chưa phân loại" cạnh headline.

## 9. Sau deploy — đo lại trên production (13:00–13:07 UTC, SHA `77b46e5`)

| Phép đo | Trước | Sau |
|---|---|---|
| `/api/health` commit | `d70171d5` | `77b46e5e9bae` (branch main) |
| Deploy run | #34751228382 | **#34757906537** thành công (gate + build + SSH + HTTPS) |
| Migration | 0075 | **0076_care_active_invariant** |
| Smoke | 50/50, 0 chậm | 50/50, 0 lỗi, 1 chậm lúc nguội (`/data-quality?issue=unlinked-shipment` 3,7 s) |
| KPI đơn | 2.698 đơn · GTC 488 · hoàn 979 · 33,3% | 2.709 · 492 · 988 · 33,2% (ORDER_OUTCOME không đổi — chỉ có đơn mới) |
| Care: Chờ xử lý CHƯA rời kho | 106/106 ca (sai) | 106 → **0** ca (đóng NOT_CARE_CONDITION, không quy kết) |
| Care: Chờ xử lý ĐÃ rời kho | 6/48 ca | **46/46** ca (RECONCILE, `opened_at` = mốc ĐVVC) |
| Care: Tồn 506/507 | 11/17 | **17/17** |
| Care: Chờ phát lại | 29/29 | 26/26 |
| Hợp cần care (đã rời kho) | — | **89 kiện · 34 có người · 55 chưa ai nhận** |
| Bất biến đóng ⇔ inactive | 13 vi phạm | **0** |
| Rescued nhưng kiện đã hoàn | 0 | 0 (lỗi 501 chiều hoàn đã chặn trước khi phát nổ) |
| Kết cục care | 5 thất bại · 1 cứu | 8 thất bại (7 có người) · 2 cứu (2 có người) · 49 PENDING · 72 lịch sử NULL |
| WAITING không hẹn | 16 | 15 (nay hiện là "tới hạn" trong Cần care) |
| Bảng kê `cod=0` ghi tiền | 0 | 0 |
| Webhook sau deploy | — | Pancake 10 gói, VTP 1 gói, 0 lỗi (đóng cửa khi thiếu secret không ảnh hưởng vì secret có sẵn) |
| Kết nối | — | Pancake ✓ · VTP token ✓ · Facebook ✓ · AI ✓ · SePay không giao dịch 24h (đối chiếu định kỳ SUCCESS) |

### 9.1 Parity Q002–Q005, cohort 30 ngày theo ngày ĐVVC nhận, nhãn ORDER_OUTCOME (nguồn duy nhất của cả hai trang)

| Mã | Đã gửi | Giao TC | Không TC | Đang giao | Huỷ | `stage=DELIVERED` (cũ) | GTC thực tế % |
|---|---:|---:|---:|---:|---:|---:|---:|
| Q002 | 771 | 184 | 493 | 94 | 8 | 300 | 27,2 |
| Q003 | 594 | 207 | 230 | 157 | 5 | 244 | 47,4 |
| Q004 | 96 | 8 | 4 | 84 | 1 | 9 | 66,7 (mẫu 12) |
| Q005 | 25 | 0 | 0 | 25 | 2 | 0 | chưa có kết quả |

Cột `stage=DELIVERED` cho thấy độ lệch mà V2 từng tính là "giao được": Q002 300 so với 184 thật.
Đang giao tách theo trạng thái ĐVVC (mô hình cân riêng): Q002 chờ xử lý 26 · chờ phát lại 13 · tồn 7;
Q003 chờ xử lý 14 · chờ phát lại 11 · tồn 8 (+53 mã 102 chưa rời kho, ngoài care nhưng trong dự báo
với P(chờ lấy hàng)); Q004 39 đang đóng bảng kê.

### 9.2 Lợi nhuận danh nghĩa (profit-verify, cùng hàm giao diện gọi) — thay đổi CÓ CHỦ ĐÍCH

| Kỳ | LN ròng trước | LN ròng sau | Vì sao |
|---|---:|---:|---|
| Trọn tháng 9 | +17.997.481 | **−55.607.676** | trước: DT ước tính = POS 343 tr × (1 − 40% mặc định) ≈ 206 tr; sau: DT giao thật 48,6 tr + đơn đang giao × P(trạng thái) + đơn chưa gửi × P(chưa gửi) ≈ 56 tr — đúng với GTC thực tế 27–47% theo mã |
| Tuần 1 | +24.758.997 | −28.953.755 | như trên |
| Tuần 2 | −6.300.337 | −26.653.922 | như trên |

Giá vốn (32,7 → 14,3 tr) và cước (13,8 → 10,8 tr) cũng đi theo từng đơn thay vì × (1 − r). Năm phép
kiểm của script vẫn đạt. Con số cũ là giả định 60% giao được; con số mới là điều dữ liệu nói.

### 9.3 CSKH · Work · Hàng hoàn · Tài chính

- `cs_cases` DELIVERY_FAILED: 237 OPEN không ai giữ (bot không nhắn được) — **76** trong số đó nay
  nằm trên kiện có ca care đang mở và hiện cờ "bot không nhắn được"; 99 IN_PROGRESS bot. Case người:
  86 mở, chưa case nào có `assignee_user_id` (chưa ai nhận).
- Work: 7 phòng ban, 11 thành viên; **MANAGEMENT có 2 dòng LEAD** (drift `MULTIPLE_LEAD_ROWS` nay
  được báo — chủ shop cần chọn một); 38 dòng overlay `assignee_id` cũ trên việc chiếu (bị bỏ qua
  đúng luật mới, không xoá); 0 objective ACTIVE thiếu KR. 7 tài khoản, tất cả `ALL`, đủ phòng ban.
- Hàng hoàn: "chờ kho nhận" theo vị ngữ mới **870** (trước 619 — nay tính cả vận đơn chiều về),
  0 kiện đóng không chứng từ, 0 phiếu kiểm (trạm chưa được dùng).
- Ngân hàng: 0 giao dịch 24h, 0 chưa phân loại, 80 dòng nhập file không tài khoản (P1), 0 tài khoản
  chưa xác nhận.

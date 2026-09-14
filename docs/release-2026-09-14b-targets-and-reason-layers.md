# Bản phát hành 14/09/2026 (đợt 2) — Mục tiêu GTC cấu hình được · Lý do hoàn tách hai lớp

> Nối tiếp `docs/release-2026-09-14-return-intelligence-v3.md`. Bản trước dựng tầng quyết định của
> `/reports/returns`; bản này gỡ hai chỗ mà bản trước **để lại cho chủ shop một ngõ cụt**.

## 1. Vì sao có bản này

Hai thứ đã đo được trên production sau lượt triển khai trước:

| Đo | Con số | Nghĩa |
|---|---|---|
| `metric_targets` có đích cho GTC | **0 dòng** | Bảng "Rủi ro theo mã hàng" hiện "chưa đặt đích" vĩnh viễn |
| Ô chọn chỉ số ở màn Cấu hình | **14 khoá** (`METRIC_CATALOG`) | `delivery_success_rate` nằm ở sổ KIA, nên **không có ô nào để chọn nó** |
| Đường dẫn "đặt đích ở đây" | `/okr/targets` | **Tuyến không tồn tại** — bấm vào ra 404 |
| `shipment_return_reasons` | **0 dòng** | 100% lý do suy từ CHỮ của ĐVVC |
| Chữ gốc ĐVVC sau khi người xác nhận | **không lưu** | Ghi đè xong là mất đường kiểm chứng |

Nói gọn: chủ shop **không có cách nào** đặt mục tiêu GTC mà không sửa mã nguồn, và cách xếp nhóm lý
do cũng vậy.

## 2. Đã sửa gì

### 2.1 Mục tiêu chỉ số (`metric_targets`)

- Ô chọn chỉ số đọc **sổ gộp** `TARGETABLE_METRICS` (28 khoá của cả hai sổ) thay vì một sổ.
- Thêm tầng **`PRODUCT`** (migration `0084`, chỉ nới ràng buộc `CHECK`, không đụng một dòng dữ liệu).
  `scope_ref` = `products.custom_id`, **cố ý không khoá ngoại** để đích sống sót khi mã bị ẩn/đổi tên.
- `PRODUCT` là **trục riêng**, không phải tầng hẹp hơn `USER`: chủ thể NGƯỜI không mang mã hàng nên
  mọi đích của mã bị loại khỏi phép chấm một con người (có kiểm thử).
- Chỉ mở cho chỉ số khai `productGrain` — hiện là `delivery_success_rate` và `return_rate`, hai chỉ
  số mà **tử số và mẫu số đều đếm trên đúng tập đơn của mã**.
- Server action kiểm mã hàng **có thật** trong danh mục. Gõ nhầm trước đây không báo lỗi ở đâu cả.
- Thêm ô **Ngưỡng cảnh báo / Ngưỡng báo động / Kỳ áp dụng** — ba cột đã có trong bảng từ `0077`
  nhưng chưa có đường nhập.
- Hai đường dẫn chết `/okr/targets` → `/work/settings#muc-tieu-chi-so`.

**Chưa có mục tiêu thì mọi thứ vẫn chạy**: GTC thực tế, GTC ước tính và **xếp hạng** đều hoạt động;
chỉ riêng nhãn đạt/không đạt là không kết luận, và màn hình nói rõ "Chưa đặt mục tiêu".

### 2.2 Lý do hoàn — ba lớp, ranh giới rõ

| Lớp | Là gì | Có được sửa không |
|---|---|---|
| `raw_reason` (migration `0085`) | Chữ ĐVVC ghi, **nguyên văn** | Không bao giờ |
| `reason` | Danh mục để đếm | Người xác nhận đè được, có nhật ký |
| nhóm | Cách shop nhìn | **Sửa bất cứ lúc nào**, suy lúc ĐỌC |

Đổi cách xếp nhóm = sửa **một dòng `settings`**. Báo cáo xếp lại ngay, kể cả ca ghi từ tháng trước,
và **không một dòng lịch sử nào bị viết lại**.

**Hai lý do bị ghim**: `UNKNOWN` (chưa ai hỏi) và `OTHER` (có chứng từ nhưng không khớp danh mục)
không kéo sang nhóm quy lỗi được — chặn ở lược đồ đầu vào, ở server action, **và** trong
`effectiveGroupOf` (nên sửa tay `settings` cũng không lách được).

### 2.3 Drilldown ba tầng

`NHÓM LÝ DO → MÃ HÀNG → VẬN ĐƠN`, ba tham số URL riêng (`group` / `reason` / `pcode`) để nút Lùi đi
ngược đúng từng tầng. Cả ba tầng đứng trên **cùng một tập ca**, nên tổng tầng giữa không thể lệch số
dòng tầng dưới.

## 3. Đối chiếu số liệu trên production (14/09/2026)

Ba đường đi tới cùng một câu hỏi. Đường thứ ba **viết lại luật từ `docs/business-rules/ORDER_OUTCOME.md`**
và đọc thẳng `shipment_events` — không import một dòng nào của `lib/queries/*`.

| Mã | Đã gửi | Giao TC | Hoàn | Đang chạy | GTC |
|---|---|---|---|---|---|
| Q001 | 71 = 71 | 33 = 33 | 38 = 38 | 0 = 0 | 46,5% = 46,5% |
| Q002 | 1.113 / 1.112 | **274 = 274** | **771 = 771** | 68 / 67 | 26,2% = 26,2% |
| Q003 | 467 = 467 | **195 = 195** | **226 = 226** | 46 = 46 | 46,3% = 46,3% |
| Q004 | 65 = 65 | **13 = 13** | **10 = 10** | 42 = 42 | 56,5% = 56,5% |

**Giao thành công, hoàn và GTC khớp TUYỆT ĐỐI trên cả bốn mã.**

Chênh 1 đơn ở Q002 (`đã gửi` và `đang chạy`) là đơn mà máy tính kết quả xếp `AWAITING_PICKUP`
(ĐVVC đã biết kiện nhưng chưa có chứng từ cầm hàng) còn câu SQL đối chứng gộp vào `đang chạy` —
**máy tính kết quả CHẶT HƠN**, đúng hướng đặc tả mục 6.

### 3.1 Một vòng lặp đã ghi lại để không ai lặp lại

Bản đầu của câu SQL đối chứng **thiếu hai luật của đặc tả mục 5** (vận đơn chiều hoàn · doanh thu bị
sửa sau khi giao) và lệch 5 đơn so với máy tính kết quả. Bổ sung đúng hai luật ấy ⇒ lệch về **0**.
Bài học: khi hai đường lệch nhau, **đường viết vội thường là đường sai** — đi tìm luật còn thiếu
trước khi nghi ngờ máy tính kết quả.

### 3.2 Trường hợp biên, đo riêng

| Trường hợp | Q001 | Q002 | Q003 | Q004 |
|---|---|---|---|---|
| Có vận đơn chiều hoàn (`1P1`) | 12 | 219 | 32 | 1 |
| Doanh thu bị sửa sau khi giao | 0 | 96 | 15 | 1 |
| Chưa có chứng từ bàn giao (ngoài mẫu KPI) | 12 | 9 | 59 | 31 |
| Huỷ / shop huỷ lấy (ngoài mẫu KPI) | 0 | 0 | 0 | 0 |

## 4. Phép kiểm mới

- `scripts/returns-parity.ts` + thao tác ops `returns-parity` — **phép kiểm duy nhất đứng TRÊN tầng
  render**: tải thật `/reports/returns` bằng phiên hợp lệ rồi **bóc số từ HTML**, so với máy tính kết
  quả và với SQL độc lập. Lý do tồn tại: ngày 14/09 một hàm bị truyền qua ranh giới client, cả khối
  lý do hoàn biến mất mà trang vẫn trả HTTP 200 — không phép kiểm nào dưới tầng render thấy được.
- `testProductTargetGuard` · `testReasonGroupContract` · `testReasonRegroupAndThreeLevelDrilldown`.
- Bài đường nâng cấp kiểm `0084` và `0085` trên **trạng thái production thật**.

## 5. Việc cần chủ shop quyết

1. **Mục tiêu GTC**: đặt một mức chung cho cả shop ở *Công việc → Cấu hình → Mục tiêu chỉ số*, và
   mức riêng cho mã nào có đặc thù (mã mới ra mắt chẳng hạn). ERP **cố ý không đặt sẵn con số nào**.
2. **Ghi lý do hoàn khi xử lý ca**: `shipment_return_reasons` vẫn 0 dòng, nên mọi lý do "vải xấu",
   "chật", "không giống mẫu" đang ở 0 vì **chưa ai ghi**, không phải vì không có ca nào.

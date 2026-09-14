# Smart Logistics Freshness + Daily Operations — báo cáo đo đạc

Ngày đo: **11/09/2026** · production `erp.vnxcommerce.com` · truy vấn chỉ đọc qua ops `db-query`.

Tài liệu này ghi **số đo**, không ghi ý định. Mỗi thay đổi trong đợt này đều đứng trên một con số
đo được trước khi sửa, và con số đó nằm ở đây để người sau kiểm lại được.

---

## 1. Lần tra cứu API KHÔNG phải là độ tươi

Đếm `shipment_events` theo nguồn:

| Nguồn | Sự kiện | Vận đơn | Nhận trong 24h | Trong 1h |
|---|---:|---:|---:|---:|
| `PANCAKE` | 22.773 | 1.630 | 1.287 | 71 |
| `VTP_WEBHOOK` | 2.713 | 624 | 1.134 | 139 |
| `VTP_IMPORT` | 1.626 | — | 0 | 0 |
| `VTP_POLL` | **0** | **0** | 0 | 0 |

`sync_runs` nói thẳng lý do: *"Tài khoản API Viettel Post không thấy bất kỳ vận đơn nào trong 10 vận
đơn vừa tra (lượt thứ 548 liên tiếp). Vận đơn do Pancake tạo thuộc tài khoản khác."*

**Hệ quả.** Bản đầu của bộ đo độ tươi (commit `c592f64`) dùng `shipments.last_vtp_sync_at`. Con số
đó chỉ nói *"ta có gọi API"*, không nói *"ta có biết kiện hàng đang ở đâu"* — và với `VTP_POLL` thì
nó chưa bao giờ mang về một tin nào. Đã thay bằng tuổi tính từ **sự kiện ĐVVC gần nhất**.

**Việc của chủ shop (chưa làm được từ phía ERP):** trỏ ERP về đúng tài khoản Viettel Post mà Pancake
đang dùng, hoặc đăng ký webhook cho tài khoản đó. Trước khi việc đó xong, `WEBHOOK_ONLY` chỉ là cách
thôi lãng phí request, không phải cách lấy lại dữ liệu.

## 2. Phân bố độ tươi thật (554 kiện đang chạy)

Tuổi kể từ sự kiện ĐVVC gần nhất: `<6h` 158 · `6–24h` 214 · `1–3 ngày` 114 · `>3 ngày` 68.

| Chặng | Kiện | Tuổi TB | Ngưỡng nghiêm trọng | Quá ngưỡng |
|---|---:|---:|---:|---:|
| PENDING | 110 | 14,9h | 96h | 0 |
| IN_TRANSIT | 172 | 20,8h | 96h | 1 |
| OUT_FOR_DELIVERY | 67 | 22,8h | 48h | 10 |
| DELIVERY_FAILED | 31 | 36,2h | 48h | 7 |
| RETURNING | 170 | 46,3h | 168h | 0 |

Ngưỡng đi theo **chặng** vì im lặng ở mỗi chặng có nghĩa khác nhau: chờ lấy hàng ba ngày là chậm
nhưng bình thường; đang đi giao mà im ba ngày nghĩa là ERP không biết hàng đã tới tay khách chưa —
và đó là tiền.

## 3. Bộ dò việc đang BỎ SÓT, không phải đang spam

Đếm việc đang mở gắn với vận đơn:

| Loại | Việc | Vận đơn | Việc/kiện |
|---|---:|---:|---:|
| `SHIPMENT_FAILED` | 17 | 17 | 1,00 |
| `COD_OVERDUE` | 11 | 11 | 1,00 |
| `SHIPMENT_STALE` | 6 | 6 | 1,00 |

Không có trùng lặp. Vấn đề ngược lại: luật vận đơn treo chỉ thấy **6** kiện trong khi **182** kiện
thật sự im quá ngưỡng của chặng. Nguyên nhân: luật cũ so `coalesce(vtp_status_date, updated_at)`, mà
`updated_at` bị chạm bởi **mọi** lần ghi vào dòng vận đơn (nhập bảng kê COD, ghép đợt tiền, đối
soát). Một kiện im năm ngày mà hôm qua có người nhập bảng kê thì trông như vừa mới cập nhật.

**Nhưng không đổ cả 182 vào hàng đợi.** Chỉ mức **nghiêm trọng** mới sinh việc: **18 kiện /
9.558.000đ COD**. 164 kiện còn lại vẫn được đo đầy đủ ở tháp điều khiển và dải độ tươi.

> Đo không có nghĩa là phải sinh việc. Một danh sách không ai làm hết được thì cũng không ai mở lần
> thứ hai — và khi đó cả 18 việc thật cũng mất luôn.

## 4. Số thao tác cho MỘT cuộc gọi khách giao hụt

Đếm trên giao diện trước khi sửa:

| Bước | Màn hình |
|---|---|
| 1 | `/shipments` — tìm kiện trong bảng 554 dòng |
| 2 | `/shipments/[id]` — xem trạng thái và ghi chú bưu tá |
| 3 | quay lại — lấy số điện thoại nếu trang chi tiết không có |
| 4 | `/orders/[id]` — xem khách đặt gì |
| 5 | `/customers/[id]` — xem khách đã mua mấy lần |
| 6 | tab Pancake — tìm hội thoại |

**Sáu lần chuyển màn hình cho một cuộc gọi**, mỗi lần là một lần chờ tải, và không có chỗ nào ghi
lại kết quả cuộc gọi.

Sau khi sửa: **một lần mở ngăn kéo** (bấm mã vận đơn trong rổ) — số điện thoại bấm gọi được, COD,
hành trình ĐVVC, số lần giao hụt, khách đặt gì, khách đã mua mấy lần, ai đã chăm trước đó, và ô ghi
nhận việc vừa làm. Danh sách phía sau không mất chỗ: đóng ngăn kéo là vẫn ở đúng dòng vừa đọc.

## 5. Ranh giới KHÔNG được vượt (khoá bằng bài kiểm)

| Ranh giới | Khoá ở đâu |
|---|---|
| Im lặng KHÔNG bao giờ suy ra kết quả đơn | `tests/logistics-freshness.test.ts` — lớp đo không được nhắc `ORDER_OUTCOME` hay bất kỳ giá trị kết quả nào, và không được ghi |
| Không có tin ⇒ `CRITICAL_STALE`, không phải `FRESH` | cùng bài kiểm — trả `FRESH` cho dữ liệu trống là biến "không biết gì" thành "mọi thứ ổn" |
| Mỗi kiện đúng một rổ | `tests/delivery-tower.test.ts` |
| Rổ tổng hợp không được cộng vào tổng | cùng bài kiểm |
| Kiện chớm cũ được đo nhưng KHÔNG sinh việc | cùng bài kiểm (đã xác nhận ĐỎ khi bỏ ranh giới) |
| Độ tươi đo từ sự kiện ĐVVC, không từ `updated_at` | cùng bài kiểm, soi mã nguồn `lib/alerts/rules.ts` |
| Tiền không bao giờ là chứng cứ giao vận | `tests/contract-order-outcome.test.ts` (đã có từ trước) |

## 6. Hiệu quả chăm sóc: đo TỪ HÔM NAY

Cohort bắt đầu từ lần ghi nhận chăm sóc đầu tiên trong bảng `care_actions`. **Cố ý không dựng lại
quá khứ**: dữ liệu cũ không mang actor — không biết ai đã gọi, gọi lúc nào, hay có gọi không. Chia
nhóm bằng phỏng đoán rồi gọi kết quả là "hiệu quả chăm sóc" là bịa một con số rồi dán nhãn khoa học
lên nó.

Và ngay cả khi đủ mẫu, con số vẫn là **quan sát, không phải nhân quả**: người CSKH chọn gọi ai, và
họ thường chọn đơn to, khách quen, đơn còn cứu được. Cảnh báo đó hiện **cạnh** con số trên màn hình,
không nằm trong tài liệu này.

## 7. Còn nợ

| Việc | Ai làm | Ghi chú |
|---|---|---|
| Trỏ ERP về đúng tài khoản VTP mà Pancake dùng | Chủ shop | Trước khi xong, ERP chỉ biết vị trí hàng qua webhook |
| Swap 0 MB trên VPS | Chủ shop | Rủi ro OOM khi build trên máy chủ |
| Direct VTP Fulfillment | **PENDING** — chưa mở, theo đúng yêu cầu |
| Sáu báo cáo đường nguội còn trên mục tiêu | ERP | Đã ghi ở `docs/erp-performance-p0-5-report.md` |

---

## 8. Đo lại SAU khi lên production (deploy #214 `9d9cf18` và #215 `a3ae7c3`)

Không dừng ở "deploy xanh". Dưới đây là số đo lấy từ production sau khi mã chạy thật.

### 8.1 Deploy

| | #214 | #215 |
|---|---|---|
| Migration | 56/56 đã áp (`0055`, `0056` vào) | 56/56 |
| Smoke | 38/38 đạt · 0 lỗi · 0 chậm (267s) | **39/39** đạt · 0 lỗi · 0 chậm (253s) |
| `/shipments` (đã có tháp) | 142ms | 142ms |
| `/shipments?bucket=CARE_TODAY` | chưa phủ | **84ms** |
| `/operations` | 112ms | 91ms |

Mục tiêu §14 của tháp điều khiển là **dưới 1 giây**. Đo được 84–142ms.

### 8.2 Khả năng tra cứu sau backfill

| Trạng thái | Vận đơn | Đang chạy |
|---|---:|---:|
| `WEBHOOK_ONLY` | 488 | 488 |
| `UNKNOWN_CAPABILITY` | 1.488 | 88 |

488 kiện đang chạy đã rời khỏi vòng tra cứu API — đúng những kiện mà API chưa bao giờ trả về gì.
88 kiện còn lại sẽ được thử tối đa 3 lần rồi kết luận, theo từng vận đơn.

### 8.3 Dân số tháp điều khiển

| Chặng | Kiện | COD |
|---|---:|---:|
| RETURNED (về shop, chưa đếm) | 484 | 259.477.000đ |
| RETURNING | 174 | 94.699.500đ |
| IN_TRANSIT | 160 | 85.783.000đ |
| PENDING | 110 | 65.475.999đ |
| OUT_FOR_DELIVERY | 72 | 37.911.000đ |
| DELIVERY_FAILED | 37 | 20.138.999đ |
| PICKED_UP | 1 | 524.000đ |

### 8.4 MỘT PHÁT HIỆN PHẢI GHI RA: mã lý do của ĐVVC hiện KHÔNG có

`vtp_reason_code` **NULL trên toàn bộ** vận đơn đang theo dõi — kể cả 37 kiện giao hụt. Nghĩa là
nhánh *"mã lý do là chứng từ, đứng trên ghi chú bưu tá"* của bộ xếp rổ **hôm nay chưa chạy lần nào**.

Nhánh đó vẫn giữ, vì nó đúng và sẽ chạy khi webhook mang mã lý do về. Nhưng ghi lại ở đây để không
ai tưởng nó đang gánh việc.

Phần gánh việc thật là ghi chú bưu tá, và nó KHÔNG rỗng — 37 kiện giao hụt chia được:

| Đọc từ ghi chú | Kiện | Rổ |
|---|---:|---|
| có chữ "hẹn" | 20 | Chờ giao lại |
| "không liên lạc / nghe máy / thuê bao" | 13 | Khách không nghe máy |
| còn lại | 4 | Giao thất bại |
| ghi chú rỗng | **0** | — |

Ba rổ đều có hàng thật. Không có rổ nào là tính năng chết.

### 8.5 Bộ dò việc sau khi đổi sang sự kiện ĐVVC

| Loại | Đang mở | Tạo mới 2h qua | Tự đóng 2h qua |
|---|---:|---:|---:|
| `SHIPMENT_FAILED` | 24 | 9 | 3 |
| `SHIPMENT_RETURNING` | 8 | 7 | 0 |
| `SHIPMENT_STALE` | **10** (trước: 6) | 5 | 1 |

Vòng tự đóng chạy đúng: có mốc ĐVVC mới thì kiện rời danh sách ứng viên và việc đóng với nhãn
`AUTO` — không ai phải dọn tay, và "đội xử lý được bao nhiêu việc" vẫn đếm được vì `AUTO` không bị
lẫn với việc do người đóng.

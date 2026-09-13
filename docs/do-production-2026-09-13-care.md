# Đo production trước khi sửa — 13/09/2026, ops run #697 (db-query CHỈ ĐỌC)

## 1. Bốn vận đơn trong ảnh chủ shop gửi

| MVĐ | ERP stage | Mã VTP | Tên trạng thái VTP | Có mốc lấy | Số sự kiện |
|---|---|---|---|---|---|
| PKE1517655128 | DELIVERY_FAILED | 506 | Tồn - Khách hàng nghỉ, không có nhà | có | 15 |
| PKE1517655137 | DELIVERY_FAILED | *(rỗng)* | Chờ phát lại | có | 17 |
| PKE1517664544 | DELIVERY_FAILED | 506 | Tồn - Khách hàng nghỉ, không có nhà | có | 15 |
| PKE1517664551 | DELIVERY_FAILED | *(rỗng)* | Chờ phát lại | có | 15 |

**Hai tình huống khác hẳn nhau đang mang CÙNG một nhãn.** "Chờ phát lại" là bưu tá sẽ quay lại —
việc của shop là nhắc khách. "Tồn - Khách hàng nghỉ" là đã vướng, chưa hẹn được lần sau — việc của
shop là gọi xin lịch. ERP in cả hai là "Giao thất bại".

Hai vận đơn "Chờ phát lại" **không có mã**: chỉ có chữ. Nên luật đọc chữ không phải thứ phụ trợ —
với nhóm này nó là căn cứ DUY NHẤT.

## 2. Phân bố trạng thái thô của vận đơn chưa kết thúc (18 nhóm)

| ERP stage | Chữ VTP | Mã | Số VĐ |
|---|---|---|---|
| PENDING | Đơn hàng chờ xử lý | 102 | **169** |
| RETURNING | Đang chuyển hoàn | | 79 |
| PENDING | Chờ xử lý | | **56** |
| DELIVERY_FAILED | Chờ phát lại | | **39** |
| OUT_FOR_DELIVERY | Đang giao hàng | | 36 |
| IN_TRANSIT | Đang vận chuyển | | 29 |
| PENDING | Giao cho Bưu tá đi nhận | 104 | 12 |
| RETURNING | Tồn - Thông báo chuyển hoàn bưu cục gốc | 505 | 12 |
| DELIVERY_FAILED | Tồn - Khách hàng nghỉ, không có nhà | 506 | 11 |
| RETURNING | Chuyển hoàn bưu cục gốc | 502 | 9 |
| OUT_FOR_DELIVERY | Giao bưu tá đi phát | 500 | 6 |
| PENDING | *(rỗng)* | | 5 |
| IN_TRANSIT | Đóng bảng kê đi | 300 | 2 |
| IN_TRANSIT | Nhận bảng kê đến | 400 | 2 |
| RETURNING | Đã duyệt hoàn | | 1 |
| OUT_FOR_DELIVERY | Phát tiếp | | 1 |
| PICKED_UP | Sửa phiếu gủi | 202 | 1 |
| OUT_FOR_DELIVERY | Giao cho bưu cục | 500 | 1 |

**10/18 nhóm không có mã** — chỉ có chữ.

## 3. "Chờ xử lý" / "Chờ phát lại" đang được ERP xếp vào đâu

| Nhóm thô | ERP stage | Số VĐ | Trong đó ĐÃ có bằng chứng lấy hàng |
|---|---|---|---|
| CHỜ PHÁT LẠI | DELIVERY_FAILED | 39 | **38** |
| CHỜ XỬ LÝ | PENDING | 225 | **56** |
| TỒN/EXCEPTION | RETURNING | 12 | 12 |
| TỒN/EXCEPTION | DELIVERY_FAILED | 11 | 11 |

## 4. Vận đơn PENDING mà đã có bằng chứng lấy hàng

| PENDING & có dấu vết ĐVVC | có `picked_up_at` | có sự kiện sau mốc lấy |
|---|---|---|
| 242 | 56 | 56 |

**56 gói hàng đã rời kho nhưng ERP xếp là "chưa lấy hàng".** Chúng không hiện trong hàng đợi
chăm sóc (tháp giao vận chỉ xét `stage`), và chúng không được tính là đang đi.

**PHÁT HIỆN LÀM ĐỔI THIẾT KẾ:** 169/225 vận đơn "chờ xử lý" mang mã **102** — mã thuộc dải 1xx
(tạo đơn / điều phối lấy hàng), tức PHẦN LỚN "chờ xử lý" là TRƯỚC khi lấy hàng. Nhưng 56 cái thì
SAU. Nên "chờ xử lý" **không kết luận được** đã lấy hàng hay chưa: nó là trạng thái MƠ HỒ.

Hệ quả: chỉ số "Đã gửi" KHÔNG được suy việc đã cầm hàng từ trạng thái con này. Nó phải đọc
CHỨNG TỪ: `picked_up_at`, hoặc một sự kiện hành trình sau mốc lấy. Đoán theo trạng thái sẽ thổi
169 gói hàng còn nằm trong kho vào cột "đang đi tới khách".

## 5–6. Lệnh gửi sang ĐVVC (`carrier_action_requests`)

    0 dòng. Bảng RỖNG.

Không một lệnh "Phát tiếp" nào từng được ghi — kể cả lệnh thất bại. Nghĩa là lỗi HTTP 400 chủ shop
thấy xảy ra **trước khi** ERP kịp ghi dòng nào, hoặc đường bấm trên màn hình không đi qua bảng này.
Nội dung lỗi thật của Viettel Post vì thế **chưa từng được lưu ở đâu** — đó là thứ phải sửa trước,
không phải đoán payload.

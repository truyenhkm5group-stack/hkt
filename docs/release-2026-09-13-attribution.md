# Phase 3.1 — Quy kết có danh tính, và danh mục chỉ số có thẩm quyền

*13/09/2026*

## 1. Đo trước khi sửa

Số đọc bằng `db-query` chỉ đọc trên production, **trước** khi có migration 0073:

| Miền | Tổng | Có `user_id` | Chỉ có chữ | Chưa ai nhận |
|---|---:|---:|---:|---:|
| `shipment_care` (ca care) | 70 | 1 | 0 | 69 |
| `care_case_events` | 96 | **96 (100%)** | 0 | 0 |
| `cs_cases` | 785 | *(chưa có cột)* | 187 | 598 |
| `return_inspections` | **0** | 0 | 0 | 0 |
| `work_item_events` | 78 | **78 (100%)** | 0 | 0 |
| `notifications` | 5 789 | 6 người đóng · 0 người nhận | — | — |

Tổ chức: 7 tài khoản hoạt động · 13 lượt thành viên phòng ban · 10 chức danh · 12 ảnh chụp hiệu suất.

## 2. Phát hiện làm đổi thiết kế

Đề bài giả định có một kho tên gõ tay cần ánh xạ về tài khoản. **Không có.**

`cs_cases` có **đúng một** chuỗi khác rỗng trong ô Phụ trách, và chuỗi đó là `Bot ERP` (187 dòng,
khớp 0 tài khoản). 598 dòng còn lại để trống.

> Chưa một case nào từng được giao cho một người thật.

Hai hệ quả:

1. **Không dựng máy ánh xạ tên → tài khoản.** Nó sẽ là mã nguồn, có kiểm thử, có màn hình chạy
   thử — cho một bài toán không tồn tại. Luật "map historical record chỉ khi deterministic" được
   giữ nguyên ở dạng mạnh nhất có thể: *không map gì cả, vì không có gì để map*.
2. **Cách ghép cũ không những yếu — nó SAI.** `salesMetrics` ghép theo tên đã chuẩn hoá, nên nó
   đang dựng một "người" tên Bot ERP với 187 case và chấm điểm cho nó, trong khi số người thật
   được đo là 0.

## 3. Đã làm gì

### Danh tính thật (migration 0073)

`cs_cases.assignee_user_id` · `cs_cases.created_by_user_id` ·
`return_inspections.received_by_user_id` / `inspected_by_user_id` ·
`return_inspection_items.inspected_by_user_id` ·
`care_case_events.previous_owner_id` / `next_owner_id` ·
`performance_snapshots.source_version`.

Mọi cột **NULLABLE, không mặc định, không backfill**. `NULL` = *chưa nối được về một tài khoản*,
không phải *không có ai*. Đặt mặc định hay đoán một khoá từ tên sẽ biến một lỗ hổng dữ liệu thành
một lời khẳng định sai về việc ai đã làm việc gì — và sau đó không ai phân biệt được nữa.

Cột CHỮ cũ **giữ nguyên**, làm ảnh chụp tên. Tên do **máy chủ** đọc từ `users`; nơi gọi không gửi
tên lên được.

### Kiểu `Actor` bắt trình biên dịch canh cho

`lib/constants/actor.ts` — `{ id: string | null; label: string }`, `id` **bắt buộc**. Đổi
`actor: string` → `actor: Actor` trong dịch vụ kiểm hàng hoàn làm `tsc` đỏ ở **đúng mọi đường ghi**
(5 chỗ trong mã nguồn, 5 tệp kiểm thử). Một đường ghi mới không thể quên phần danh tính — nó không
biên dịch được. `id: null` hợp lệ và có nghĩa: MÁY làm.

### Bốn phòng, một kiểu khoá

Trước: Kinh doanh ghép theo TÊN, Kho theo EMAIL, Giao vận và Kế toán theo KHOÁ — ba mức "có thể
nhầm người" trong cùng một bảng, và người đọc không có cách nào biết ô nào đáng tin hơn ô nào.
Nay cả bốn đi bằng `users.id`.

Cái giá phải trả, và nó được nói thẳng trên màn hình: dòng cũ không có khoá thì không vào thẻ điểm.

### Sổ chỉ số có thẩm quyền

`lib/constants/metric-catalog.ts` — 14 chỉ số, mỗi chỉ số khai đủ 12 trường. `DEPT_METRIC_KEYS` và
`DEPT_LINKAGE` nay **dẫn xuất** từ sổ thay vì là bản chép thứ hai.

Hai chỉ số khai `UNAVAILABLE` kèm lý do cụ thể tới mức sửa được:

- **Độ chính xác tồn kho** — chưa có quy trình kiểm kê định kỳ, nên không có mẫu số.
- **Đóng góp sau chi phí quảng cáo (mức người)** — `ad_spends.marketer_id` trỏ tới nhân sự bảng
  LƯƠNG chứ không phải `users.id` (hai sổ danh tính khác nhau), và `orders` không có cột quy đơn
  về chiến dịch.

Khoá chỉ số **giữ nguyên dạng đang chạy** (`care_sla`, `sales_followup_sla`…) vì
`performance_snapshots.metric_key` đã lưu chúng trên production. Đổi khoá cho "đẹp" là làm mồ côi
toàn bộ ảnh chụp cũ.

### Đích ba tầng (bảng `metric_targets`)

Công ty → phòng ban → chức danh, tầng hẹp đè tầng rộng. Mỗi đích có người đặt, **lý do bắt buộc**,
và mốc hiệu lực. Đích chỉ áp cho kỳ kết thúc sau `effective_from` — không chấm lại kỳ đã chốt.

ERP **không đặt sẵn đích nào**. Bảng bắt đầu rỗng và ở rỗng cho tới khi chủ shop điền; chưa có đích
thì màn hình hiện thực tế và không kết luận đạt/không đạt.

Điều này gỡ luôn một thứ đã nằm sẵn trong màn hình: màu đỏ/xanh trước đây bám vào hai con số 90 và
60 ghi cứng trong JSX — tức là ERP tự đặt chuẩn thay chủ shop, ở một chỗ không ai nhìn thấy.

### Phân biệt LÀM KÉM với CHƯA ĐỦ DỮ LIỆU

`metricTrust` → `TRUSTED` · `WEAK` · `UNKNOWN` · `UNAVAILABLE`.
KR → `MetricState` với `DATA_INSUFFICIENT` tách hẳn khỏi `UNKNOWN`.

Hai thứ này dẫn tới hai hành động khác nhau: `DATA_INSUFFICIENT` là *"đợi thêm vài tuần, đường ống
đang chạy đúng"*, `UNKNOWN` là *"đi lấy dữ liệu"*. Gộp lại thì cả hai đều thành "hỏng".

Mọi hàm đọc chỉ số OKR nay **bắt buộc** khai `sample` (có thể `null` cho tiền/số dư). Đổi kiểu làm
`tsc` đỏ ở đủ 14 hàm.

### Đổi nguồn là một phiên bản riêng

`METRIC_SOURCE_VERSION = 2`, tách khỏi `METRIC_DEFINITION_VERSION`. Kỳ trước gom case nối bằng tên
gõ tay, kỳ này chỉ gom case nối bằng khoá — **hai tập dòng khác nhau**. Số tụt xuống không nói
người đó làm kém đi, nó nói phép đo vừa hẹp lại. Màn hình xu hướng in *"đổi nguồn giữa hai kỳ"*
thay vì vẽ một mũi tên đi xuống.

### Ba màn hình

- `/work/settings` — đặt đích, và bảng **độ phủ quy kết** đếm trên chính dữ liệu.
- `/work/performance` — mỗi ô mang Thực tế · Đích · Mẫu · Độ tin cậy · Lý do; xu hướng đọc từ ảnh chụp.
- `/work/review` — khối *"Kỳ này nói về cá nhân được tới đâu"* đặt **trước** bảng số, vì thứ tự đọc
  quyết định kết luận. Không xếp hạng ai, không gắn nhãn "yếu" cho ai.

Cột **"là máy"** tách riêng khỏi "chỉ có chữ" lẫn "chưa ai nhận": việc đã được chạm, chỉ là chạm
bởi một job. Gộp vào nhóm người thì báo cáo nói có người đang làm trong khi con số thật là 0.

## 4. Kết quả trung thực sau bản này

| Phòng | Mức dùng được | Vì sao |
|---|---|---|
| Giao vận | **WEAK** | thao tác nối bằng khoá 100%, nhưng chỉ 1/70 ca care có người nhận ⇒ mẫu quá bé |
| Kinh doanh | **UNKNOWN** | chưa case nào được giao cho người thật |
| Kho | **UNKNOWN** | chưa có phiếu kiểm hoàn nào — và KHÔNG tạo phiếu giả để có KPI |
| Kế toán | **WEAK** | nối bằng khoá, mẫu còn nhỏ |
| Marketing | **UNAVAILABLE** | chưa có nguồn ở độ mịn người |

Đây là câu trả lời đúng về trạng thái hôm nay, không phải một lỗ hổng cần lấp. Đường ống quy kết
đã sẵn sàng; thứ còn thiếu là **công việc được làm trong ERP**, và đó là việc của người dùng chứ
không phải của mã nguồn.

## 5. Chủ shop cần làm gì

Không bắt buộc gì để bản này an toàn. Muốn thẻ điểm bắt đầu có số thì theo thứ tự:

1. **Giao case CSKH cho người thật** ở `/cs` (ô Phụ trách nay là danh sách tài khoản, không còn gõ tay).
2. **Nhận ca care** ở `/shipments` — 69/70 ca đang chưa ai nhận.
3. **Lập phiếu kiểm hàng hoàn** ở `/inventory/returns` khi hàng về kho.
4. Khi mỗi phòng có khoảng 20 quan sát, vào `/work/settings` → *Đích của chỉ số* để đặt chuẩn.

Trước bước 4, màn hình hiện số thực tế và không chấm đạt/không đạt — đúng như thiết kế.

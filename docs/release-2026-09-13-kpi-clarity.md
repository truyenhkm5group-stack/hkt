# Rõ nghĩa chỉ số vận đơn + báo cáo lý do hoàn theo taxonomy của shop

*13/09/2026*

## 1. Cái bẫy đã sửa: bảng nói "Đã gửi" nhưng lọc theo ngày tạo đơn

Bảng hiệu quả theo mã hàng có cột đầu tiên tên **Đã gửi**, rồi tách ra Giao thành công /
Không thành công / Đang giao. Người đọc thấy chữ đó và tin rằng đang xem lô hàng gửi trong kỳ.
Thực tế bộ lọc chạy trên `orders.inserted_at` — **ngày tạo đơn**.

Đo production trước khi sửa:

| | |
|---|---:|
| vận đơn có CẢ hai mốc | 1.411 |
| rơi vào **hai ngày khác nhau** | **1.038 (73,6%)** |
| lệch trung bình | 4,5 ngày |
| lệch lớn nhất | 26 ngày |

Hai cách lọc chọn ra hai tập gần như khác hẳn nhau. Đây không phải khác biệt lý thuyết.

**Sửa:** cohort mặc định đổi sang `carrier_handoff_at`, và màn hình in thẳng
*"Đang lọc theo: Ngày ĐVVC tiếp nhận"* ngay dưới bộ lọc, kèm ô chọn để đổi mốc.

### Bản này đổi con số đi bao nhiêu — đo thật trên production

Cửa sổ **7 ngày qua**:

| | |
|---|---:|
| cohort theo ngày tạo đơn (bản cũ) | **197** |
| cohort theo ngày ĐVVC tiếp nhận (bản này) | **461** |
| nằm trong cả hai | 197 |
| không có chứng cứ tiếp nhận ⇒ ngoài cohort | 15 |

Bảng cũ đang hiện 197 kiện trong khi cohort thật của câu hỏi "gửi trong 7 ngày qua" là 461.
**57% lô hàng không xuất hiện.** 264 kiện đó là đơn chốt từ trước rồi mới gửi đi tuần này —
đúng thứ chủ shop muốn nhìn khi mở bảng.

Chỉ 15 kiện thiếu chứng cứ tiếp nhận và bị loại; nếu lấy `created_at` lấp vào thì 15 kiện chưa
ai lấy sẽ nằm trong "đã gửi".

## 2. `picked_up_at` không đủ phủ — và không được lấp bằng ngày tạo

| | |
|---|---:|
| tổng vận đơn | 2.103 |
| có `picked_up_at` | 1.417 |
| **đã rời kho mà KHÔNG có mốc** | **494** |
| có sự kiện ĐVVC | 2.072 |

Lọc thẳng theo `picked_up_at` sẽ âm thầm đánh rơi 494 kiện. Nên mốc đi theo hai bậc, **cả hai
đều là chứng từ ĐVVC**: mốc lấy hàng → sự kiện ĐVVC đầu tiên.

**Và không có bậc thứ ba.** `shipments.created_at` cố ý không được dùng: nó là lúc người bán bấm
nút tạo vận đơn, không phải lúc ĐVVC cầm hàng. Thiếu chứng cứ ⇒ `NULL` ⇒ kiện nằm ngoài cohort,
và số kiện rơi ra được in ra. Một con số thiếu mà *biết* là thiếu thì dùng được; một con số đầy
đủ giả thì không.

## 3. Chỉ số "Dự kiến (tính cả chờ phát lại)" — đã gỡ khỏi bảng

Công thức cũ nhân số kiện chờ phát lại với `p` = tỷ lệ kiện từng phát hỏng rồi thành hoàn, học
từ lịch sử. Đo `p` trên production: 173 kiện từng phát hỏng · 67 thành hoàn · 38 giao được · 50
còn treo ⇒ `p ≈ 63,8%` trên mẫu 105 kiện đã ngã ngũ.

Con số có thật, nhưng nó là tỷ lệ **của cả shop** áp cho **từng mã hàng**: mã Q004 có 1 kiện chờ
phát lại thì nhận 63,8% của toàn shop, không phải tỷ lệ của chính nó. Bảng in nó cạnh một con số
đếm thật, cùng cỡ chữ, cùng màu — người đọc không có cách nào biết cột nào là ước tính.

**Gỡ khỏi bảng.** Hàm `failedToReturnRate()` và trường `expectedSuccessRate` giữ nguyên; trang
Kịch bản dùng chúng đúng chỗ, ở đó nó được gọi tên là giả định và có ô chỉnh tay.

## 4. Taxonomy lý do hoàn: 40 lý do, 6 nhóm — và ai là nguồn

Chép đúng bảng Excel chủ shop đang dùng. Điểm quyết định về **nguồn**:

> "Vải xấu", "Chật", "Không giống mẫu", "Vải nóng" — Viettel Post không bao giờ nói những câu
> này. ĐVVC không biết vải nóng hay dày. Đây là lý do do **người của shop** hỏi khách rồi ghi.

**26/40 lý do chỉ có khi người ghi.** Điều này được khoá bằng kiểm thử: không một mã lý do ĐVVC
nào và không một luật đọc chữ nào được phép ánh xạ tới một lý do cần người. Nếu ngày mai ai đó
thêm luật `"..." → "Vải xấu"`, bộ kiểm thử đỏ ngay.

Nhóm **Chưa xác định được** đứng riêng, không nằm trong "Lý do khác": *lý do khác* nghĩa là đã
hỏi và biết, chỉ không thuộc nhóm nào; *chưa xác định được* nghĩa là chưa ai hỏi.

## 5. "Tỷ lệ cứu đơn" — ba lối ra, chỉ một là con số

| trạng thái | khi nào | hiện gì |
|---|---|---|
| `NO_CASES` | không ca nào mang lý do đó | `—` |
| `NOT_TRACKED` | có ca, nhưng chưa ca nào được ghi thao tác của người | *"chưa theo dõi"* |
| `MEASURED` | có ghi thao tác | tỷ lệ thật, kể cả 0% |

**0% và "chưa theo dõi" dẫn tới hai kết luận trái ngược**: 0% nói đội chăm sóc đã làm mà không
cứu được ca nào; "chưa theo dõi" nói ERP chưa ghi lại việc họ làm. In nhầm cái đầu là vu oan cho
một đội ngũ bằng một lỗ hổng dữ liệu.

Bảng Excel của shop cũng để cột này bằng 0 ở **mọi** dòng trong 454 ca — dấu hiệu rõ rằng ở đó
nó cũng chưa được theo dõi.

## 6. Tỷ trọng tính trên mẫu số nào

`số đơn của lý do ÷ tổng đơn hoàn ĐÃ XÁC ĐỊNH ĐƯỢC LÝ DO`, cộng lại đúng 100%.

Lấy tổng đơn hoàn làm mẫu số thì mọi tỷ trọng bị kéo xuống bởi phần chưa ai hỏi — "vải xấu 12%"
trong khi trong số ca đã biết thì nó chiếm 40%. Phần chưa biết báo riêng bằng **độ phủ**, đặt
ngay trên bảng chứ không ở chân trang.

## 7. Mốc của báo cáo lý do hoàn: ngày kết quả cuối

Câu hỏi là *"tháng này xử lý xong bao nhiêu ca hoàn, vì sao"*, và một ca đóng hôm nay có thể là
đơn của tháng trước. Mặc định `OUTCOME` = `delivered_at` → `returned_at` → `vtp_status_date`.

Không rơi về `updated_at`: cột đó bị chạm bởi mọi lần đồng bộ, nên "ngày xử lý" của một ca từ
tháng trước sẽ nhảy sang hôm nay chỉ vì job chạy.

## 8. Đối chiếu production (cohort = ngày gửi, 30 ngày)

| Mã | Đã gửi | Giao TC | Không TC | Đang giao | GTC% (đã kết thúc) |
|---|---:|---:|---:|---:|---:|
| Q002 | 794 | 184 | 504 | 99 | 26,7% |
| Q003 | 525 | 176 | 200 | 144 | 46,8% |
| Q004 | 96 | 6 | 1 | 88 | 85,7% *(mẫu 7 — bảng hiện cờ `/7`)* |
| X001 | 24 | 8 | 16 | 0 | 33,3% |
| Q005 | 21 | 0 | 0 | 20 | *chưa có kết quả* |
| Q001 | 2 | 0 | 2 | 0 | 0% |

Q004 là ví dụ đúng của vấn đề mẫu bé: 85,7% đứng trên **7** vận đơn đã kết thúc trong khi 88
kiện còn đang đi. Bảng in kèm `/7` để con số đó không bị đọc như một kết luận về mã hàng.

**Lý do hoàn, 90 ngày, theo ngày kết quả cuối:** 603 vận đơn hoàn · **603 có mốc kết quả cuối
(100%, không kiện nào rơi khỏi kỳ)** · 128 có chữ lý do từ ĐVVC (21,2%) · **0 do người ghi**.

**Đơn nhiều mã hàng:** 34/2.385 = 1,43%.

## 9. Việc chủ shop cần làm

Báo cáo sẽ **gần như rỗng** cho tới khi có người ghi lý do — đó là sự thật về dữ liệu hôm nay,
không phải lỗi. Bảng Excel 454 dòng của shop đang sống ngoài ERP.

1. Ở `/shipments`, kiện hoàn có nút **Lý do hoàn** → chọn nhóm → chọn lý do chi tiết.
2. Mỗi lý do ghi vào là một dòng báo cáo. Ghi đủ vài chục ca thì tỷ trọng bắt đầu có nghĩa.
3. Muốn khôi phục 454 dòng lịch sử: cần tệp gốc có mã vận đơn (hoặc mã đơn) để đối chiếu bằng
   định danh mạnh. **Chưa làm trong bản này** — không có tệp thì không có gì để đối chiếu, và
   khớp bằng số điện thoại là cách chắc chắn gán nhầm lý do cho đơn khác.

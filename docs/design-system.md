# Ngôn ngữ thiết kế VNXcommerce ERP

Tài liệu này là **luật trình bày**. Nghiệp vụ nằm ở `docs/business-rules/ORDER_OUTCOME.md`; kiến
trúc nằm ở `docs/CONVENTIONS.md`. Ở đây chỉ nói: một màn hình ERP trông như thế nào và vì sao.

Mục tiêu của cả hệ thống gói trong một câu: **nhân viên mở trang lên là biết ngay mình cần làm gì
tiếp theo**, không phải đọc và lọc một đống dữ liệu.

---

## 1. Ba lớp bề mặt, không nhiều hơn

| Token | Dùng cho |
| --- | --- |
| `--surface-sunken` | nền chìm: vùng trống, khung trạng thái rỗng |
| `--surface` (= `--card`) | mặt phẳng làm việc: thẻ, khối, bảng |
| `--surface-raised` (= `--popover`) | thứ nổi lên trên: popover, ngăn kéo, hộp thoại, menu |

Đường kẻ **bên trong** một khối dùng `--hairline` (nhạt); viền **bao quanh** khối dùng `--border`
(đậm hơn). Hai thứ này khác nhau — dùng lẫn thì khối mất ranh giới, và nền tối là nơi lộ ra đầu
tiên.

Đổ bóng chỉ có hai mức: `--shadow-card` cho mặt phẳng làm việc, `--shadow-raised` cho thứ đang nổi
lên. Không tự chế mức thứ ba.

## 2. Ba bậc chỉ số — kích thước nói ra thứ tự quan trọng

Mười thẻ bằng nhau nghĩa là **không thẻ nào quan trọng**, và mắt không biết đọc từ đâu.

| Bậc | Thành phần | Dùng cho | Số lượng |
| --- | --- | --- | --- |
| 1 | `<MetricCard size="lg">` | con số DẪN DẮT cả trang | tối đa 3 |
| 2 | `<MetricCard>` | thứ cần quyết hôm nay | tối đa 4 |
| 3 | `<StatStrip>` | tỷ lệ, số nền, thứ theo dõi định kỳ | gom vào MỘT dải |

Xếp bậc theo **câu hỏi người dùng đang hỏi**, không theo thứ tự truy vấn trả về. Trang Đối soát
COD hỏi một dây chuyền — phải trả → đã trả → còn thiếu — nên đúng ba số đó là bậc một.

Khi cần bỏ bớt: đừng xoá con số, hãy **hạ bậc** nó.

## 3. Mọi con số phải bấm được

Một chỉ số không kiểm chứng được là một chỉ số vô dụng: chủ shop thấy số lạ mà không có đường nào
soi lại thì lần sau không tin nó nữa.

- Truyền `href` cho `MetricCard` / `StatTile`. **Không** tự bọc `<Link>` bên ngoài — bọc tay thì
  thẻ mất viền tiêu điểm bàn phím và mỗi trang bọc một kiểu.
- Đường dẫn phải mở đúng **tập dữ liệu đã sinh ra con số đó**, và phải **mang theo kỳ đang xem**.
  Thẻ nói tháng 9 mà trang mở ra nói 30 ngày gần nhất là kiểu sai tệ nhất: trông vẫn hợp lý.
- Drill-down tốt nhất là **ngay trên trang hiện tại** (đổi bộ lọc), không phải nhảy sang trang khác.

`tests/drilldown-contract.test.ts` khoá cả ba điều này ở mức mã nguồn cho trang Tổng quan.

## 4. Chữ giải thích nằm trong ⓘ, không nằm trên màn hình

Màn hình chỉ giữ: **nhãn → số → trạng thái → hành động**.

- Một câu ngắn nói khối này là gì → `description`.
- Định nghĩa, cách tính, quy ước nghiệp vụ, cảnh báo → `hint` (hiện trong `<InfoHint>`).
- Ngoại lệ **duy nhất**: chữ trong `EmptyState`. Giải thích một màn hình trống chính là việc của
  nó — nói rõ vì sao trống và làm gì tiếp theo.

Thử thế này: đoạn văn đó đọc một lần là thuộc? Vậy nó không được chiếm chỗ mọi lần mở trang.

## 5. Bảng

Bảng là mặt bằng chính của ERP, nên nó được ưu tiên hơn cái đẹp.

- Tiêu đề cột **dính** khi cuộn (`DataTable` tự lo). Bảng dài mà mất hàng tiêu đề thì người đọc
  phải cuộn ngược lên chỉ để biết cột đang đọc là cột gì.
- Trần chiều cao chỉ đặt khi bảng **thực sự dài** (> 12 dòng) — bảng ngắn không sinh thanh cuộn
  lồng nhau vô cớ. Thanh phân trang nằm ngoài vùng cuộn nên luôn thấy được.
- Số căn phải và dùng lớp `.numeric` (chữ số đều bề ngang, so sánh theo cột mới thẳng hàng).
- Bảng rộng luôn nằm trong khung `overflow-x-auto`; **thân trang không bao giờ được trượt ngang**.
- Dòng bấm được thì phải có `rowHref` — đừng bắt người dùng đoán chỗ nào bấm được.

## 6. Trạng thái: bốn chiều, không được trộn

Trạng thái đơn / trạng thái vận đơn / trạng thái tiền / kết quả đơn là **bốn chiều khác nhau**.
Luôn dùng các nhãn dùng chung trong `components/status-badge.tsx`; không trang nào được tự vẽ lại.
`tests/ui-consistency.test.ts` chặn việc vẽ tay ở mức mã nguồn.

`NULL` là **CHƯA BIẾT**, không phải 0, và nhãn phải đọc ra được điều đó.

## 7. Chờ đợi và phản hồi

- Mở **trang khác** → khung xương (`loading.tsx`). Khung xương phải **giống hình trang thật**,
  đúng cả thứ tự khối — sai hình thì lúc dữ liệu về cả trang giật một nhịp, còn hại hơn không có.
- Đổi **kỳ / bộ lọc trên cùng trang** → giữ số cũ, làm mờ đi (`StaleWhileRefreshing`). Không bao
  giờ nháy về màn hình trắng hay về số 0.
- Hành động trên một dòng → vá **tại chỗ** dòng đó, không tải lại trang, không cuộn. Kết quả phải
  hiện ra ngay chỗ vừa bấm.
- Không dùng vòng xoay toàn trang.

## 8. Điều hướng

- Menu xếp theo **luồng công việc thật**, không theo mô-đun kỹ thuật.
- Nhóm menu gập được và máy nhớ, nhưng **mặc định mở hết**: gập là lựa chọn của người dùng, không
  phải thứ giấu sẵn bắt họ tốn thêm một cú bấm. Nhóm chứa trang đang xem luôn mở.
- Trang đã làm xong **phải có lối vào**. Trang cố ý không nằm trong menu phải khai lý do trong
  `INTENTIONALLY_UNLINKED` (`tests/ui-consistency.test.ts`) — một tính năng không có lối vào thì
  với người dùng nó không tồn tại.

## 9. Màu

Cam thương hiệu (`--brand`) dùng **tiết chế**: mục menu đang mở, nút hành động chính, nhấn mạnh
một con số. Nó không phải màu trang trí.

Màu mang nghĩa, không mang cảm xúc: `success` = đã xong / tiền đã về, `warning` = cần người xử lý,
`destructive` = hỏng hoặc mất tiền, `muted` = chưa có dữ liệu. Một trạng thái **chưa biết** không
bao giờ được tô như một trạng thái xấu.

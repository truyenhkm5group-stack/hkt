# Vận hành hoá — báo cáo tổng kết

Ngày 10/09/2026. Mọi con số đo **trên production**, không phải fixture.

---

## 1. Kết quả đo được

```
[smoke] 23/25 đạt · 0 lỗi ứng dụng · 0 sai quyền · 0 chậm · 0 QUÁ HẠN

  /                       185ms      (đầu phiên: QUÁ HẠN 60 giây)
  /customers/retention     79ms      (đầu phiên: 2.368ms)
  /orders                 109ms      /cod                    124ms
  /shipments              199ms      /reports                115ms
  /inventory               84ms      /alerts                 137ms
  /ads                    141ms      /data-quality            89ms
```

Không trang nào bị kéo chậm lại. Hai màn hình "chưa kiểm" là do trần ngân sách 300 giây của cả lượt,
không phải lỗi.

## 2. Việc đã làm, theo thứ tự giá trị

### 2.1 Màn hình Ý tưởng marketing — nguyên nhân "chưa dùng được" không phải thiếu tính năng

`deleteIdea`, `addIdeaImages`, `deleteIdeaImage` đã viết đủ, có kiểm quyền, có ghi nhật ký — và
**không nút nào gọi tới**. Marketer đăng nhầm một ảnh là chịu; quản lý bảo "thêm ảnh góc khác" thì
không thêm được. `ideasWaitingReview()` cũng không nơi nào gọi, nên ý tưởng đăng xong nằm im và quản
lý chỉ biết nếu tự nhớ mở trang.

Nay: thêm / xoá từng ảnh ngay trên trang chi tiết · xoá ý tưởng có xác nhận hai bước · số ý tưởng
chờ duyệt hiện trên trang **Cần xử lý**, nơi người vận hành thật sự nhìn.

Hàm thu nhỏ ảnh tách sang `lib/ideas/shrink-image.ts` để hai màn hình dùng chung — chép sang bản thứ
hai thì sớm muộn hai bên thu nhỏ theo hai kích thước khác nhau, và không ai phát hiện vì cả hai đều
"chạy được".

### 2.2 Đối soát ngân hàng — đường ống dùng được ngay khi có dữ liệu

```
NHẬP → PHÂN LOẠI → GỢI Ý ĐỐI KHỚP → NGƯỜI DUYỆT → ĐÃ ĐỐI SOÁT
```

| Mức | Nghĩa | Được tự nối? |
| --- | --- | --- |
| `EXACT` | mã chứng từ nằm trong nội dung chuyển khoản **và** tiền khớp | ✅ |
| `HIGH_CONFIDENCE` | tiền khớp, ngày trong 3 ngày, **chỉ một** ứng viên | ❌ đề xuất |
| `AMBIGUOUS` | nhiều ứng viên | ❌ bắt buộc người xem |
| `UNMATCHED` | không ứng viên nào | ❌ |

Luật không nới: **không nối bằng số tiền đơn độc khi có nhiều ứng viên**. Trả lương nhiều người cùng
mức, trả xưởng nhiều đợt cùng giá là chuyện thường ngày; chọn đại rồi đánh dấu "đã đối soát" tạo ra
sổ sai mà *trông như* đã kiểm.

Thêm hai luật khi dựng giao diện:

- **Tiền VÀO chỉ đối với bảng kê COD, tiền RA đối với ba nguồn chi.** Một khoản chi 5 triệu trùng số
  với một đợt COD về 5 triệu là bình thường, và nối nhầm hai chiều tiền là sai nặng nhất.
- **Nút GỠ liên kết.** Nối nhầm là chuyện có thật; không có đường gỡ thì cách sửa duy nhất là xoá
  một giao dịch tiền THẬT khỏi sổ.

### 2.3 Sổ ngân hàng rỗng — không bịa dữ liệu

Production có **0 giao dịch**. Không tạo dòng giả để "thử": sổ tiền là chỗ cuối cùng được phép có dữ
liệu bịa, và một dòng giả lọt vào sẽ đi thẳng vào đối soát rồi vào lợi nhuận.

Thay vào đó: trạng thái rỗng nói thẳng **"Chưa có giao dịch ngân hàng · Nhập sao kê để bắt đầu đối
soát"** kèm nút, thay vì bốn thẻ 0đ đọc ra thành "tháng này không thu chi gì". Đường ống kiểm bằng
fixture mang đúng hình dạng sao kê MB Bank thật (`tests/bank-pipeline.test.ts`), khoá cả điều quan
trọng nhất: **chạy gợi ý KHÔNG được tự ghi dòng nào** — nối là việc của hành động có người bấm.

### 2.4 `/customers/retention` 2.368ms → 79ms

Bốn truy vấn `await` **nối tiếp**, mỗi truy vấn dựng lại `ORDER_FACTS` từ đầu — tính kết quả đơn cho
toàn bộ đơn hàng bốn lần, xếp hàng chờ nhau.

- Ba truy vấn tóm tắt chạy **một lượt**; tổng thời gian nay bằng truy vấn chậm nhất.
- Cohort tách sang `getRetentionCohorts()` sau ranh giới Suspense riêng, đệm 10 phút. Nó nặng nhất
  **và** là phần người dùng cuộn xuống mới thấy — bắt lượt tải đầu chờ nó xong là bắt mọi người trả
  giá cho một bảng phần lớn không ai mở. Cohort theo THÁNG nên TTL dài đúng bản chất dữ liệu.

Luật giữ chân không đổi một chữ: mua lại vẫn đếm trên **đơn giao thành công**, tháng chưa tới vẫn để
trống chứ không phải 0.

### 2.5 Vận đơn 1:N — người vận hành nhìn thấy được chuỗi lần gửi

Mô hình đã vào CSDL và vào mọi đường tiền, nhưng `attemptNo` / `direction` **không xuất hiện ở bất kỳ
đâu** trong giao diện. Nặng hơn: trang chi tiết đơn lấy `order.shipment` — quan hệ `one(...)`, tức
MỘT dòng bất kỳ. Đơn gửi lại hiện "đang giao" mà giấu mất hai lần trước, dù chúng vẫn còn nguyên
trong sổ. Đúng thứ đã được dặn không làm: gộp thành một trạng thái gây mất lịch sử.

Nay mỗi lần gửi là một khối riêng có số thứ tự · chiều · mốc tạo · trạng thái · COD · hành trình.
Danh sách vận đơn hiện "lần N" — **chỉ khi khác lần đầu**, vì gắn nhãn "lần 1 · chiều đi" cho mọi
dòng chỉ làm loãng bảng mà không thêm thông tin nào.

### 2.6 Hàng đợi công việc và Orders — kiểm rồi, KHÔNG cần dựng lại

| Yêu cầu | Hiện trạng |
| --- | --- |
| tổng đếm đúng, `loaded != total` | ✅ `exactTotal` + `hasMore` |
| ưu tiên · SLA · đội · người nhận | ✅ |
| tác động tiền | ✅ `financialImpact` |
| chống trùng | ✅ `dedupeKey` theo từng luật |
| tự đóng khi điều kiện hết | ✅ |
| thao tác nhanh ngay trên dòng | ✅ nhận · bắt đầu · bỏ qua · xong · giao việc |
| tìm theo mã đơn / mã vận đơn / SĐT / khách | ✅ và cả SKU, tên hàng |

Báo đúng hiện trạng thay vì tạo việc: hai màn hình này đã đạt mục tiêu "xử lý trong một màn hình".

## 3. Lá chắn mới — lần thứ BẢY của cùng một lỗi thiết kế

`tests/action-wiring.test.ts`: mọi Server Action phải có nơi gọi, hoặc khai nợ **kèm lý do**.

Đây là loại lỗi **không bài kiểm nào bắt được bằng cách chạy** — mã đúng, kiểm thử đơn vị xanh, không
ai lỗi. Nó chỉ lộ ra khi có người thật đi tìm một cái nút không tồn tại.

Nó bắt ngay **4 ca** khi vừa viết xong, trong đó có đúng hai cái cần cho đối soát ngân hàng
(`linkBankTransaction`, `unlinkBankTransaction`).

Hiện: **96 action · 2 khai nợ có lý do · 0 treo**.

Sáu lần trước cùng hình dạng: job không có lịch · phép nối không canh grain · lá chắn chi phí canh
sáu tệp · ranh giới ghi canh 15 tệp · khung xương canh 21 tuyến · lớp tăng tốc nối 2/25 tệp.

## 4. Giữ nguyên, cố ý

- **Ba hạng giá vốn** `VERIFIED` / `RECONSTRUCTED` / `UNVERIFIED` và bảng độ phủ năm thành phần —
  không gộp thành một điểm tin cậy bí ẩn.
- **Không thay `recognized_cogs`** khi chưa có chứng từ mạnh hơn. Dựng lại sẽ đưa 368 đơn về 0đ và
  thổi lợi nhuận lịch sử lên 58 triệu.
- **Hiệu năng các trang đã đạt mục tiêu: đóng băng.** Không tối ưu thêm theo cảm tính.

## 5. Còn nợ, nói rõ

| Việc | Vì sao chưa làm |
| --- | --- |
| Học quy tắc từ phân loại đã xác nhận | Cần dữ liệu thật để biết mẫu nào đáng học; sổ đang trống |
| Màn hình cấu hình luật CSKH (`saveCsRules`) | Shop đang dùng luật mặc định, chưa yêu cầu đổi |
| Ô ghi chú trên bảng đơn landing (`setLandingNote`) | Cột và hành động đã có, chưa có ô nhập |
| Ba nhóm phê duyệt chưa nối | Chưa có Server Action tương ứng — xem `docs/second-approval-policy.md` |

Cả bốn đều **được in ra ở mỗi lần chạy kiểm thử**, không nằm im trong tài liệu.

## 6. Việc của chủ shop, không phải của mã

- **Nhập sao kê MB Bank** — cả trang Ngân hàng và bảng độ phủ chưa nói được gì cho tới lúc đó.
- **453 kiện hoàn chờ kiểm đếm** — trạm đếm đã sẵn sàng (bắn mã, một chạm, hàng loạt).
- **368 đơn giá vốn suy ngược (58 triệu)** — nhập phiếu nhập cũ với NGÀY NHẬP THẬT thì căn cứ tự
  chuyển sang "có chứng từ", không cần đụng mã và không đơn nào bị sửa số.

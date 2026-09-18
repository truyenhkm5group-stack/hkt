# Bản 18/09/2026 — Ba kết quả xử lý vận đơn: Đã hoàn · Phát tiếp · Xử lý sau

Chủ shop chốt: người trực vận đơn mỗi ngày chỉ phải trả lời ĐÚNG MỘT câu hỏi cho mỗi kiện —
*"kiện này thôi rồi, đi tiếp, hay để lát nữa?"*. Trang `/shipments` được hoàn thiện quanh câu hỏi đó.

## 1. Vì sao phải sửa

Ba việc đó đã tồn tại trong mã từ bản 13/09 (`care_business_actions`, bốn quyết định nghiệp vụ) nhưng
nằm sau **hai lớp**: mở popover "Xử lý" → đọc một danh sách bốn mục mang tên kế toán ("Duyệt hoàn",
"Theo dõi tiếp"). Người trực phải dịch từ việc mình vừa làm sang tên trong menu, vài chục lần một buổi.

Panel chi tiết thì **chỉ tra cứu được**: nó đọc `getShipmentQuickView`, nên không có trạng thái care,
không có người phụ trách, không có hạn, không có kết quả đã quyết, và không có mã Viettel Post thật
(mã vận đơn chỉ sao chép được, không bấm sang ĐVVC được). Muốn xử lý thì phải đóng panel, tìm lại
dòng, thao tác ở ngoài.

## 2. KHÔNG có migration, KHÔNG có cột mới, KHÔNG có bảng mới

Đây là quyết định kiến trúc quan trọng nhất của bản này.

Ba kết quả là một **LỚP NGÔN NGỮ** (`lib/constants/care-resolution.ts`), không phải một chiều dữ liệu
mới. Mỗi kết quả trỏ về ĐÚNG MỘT `BusinessAction` đã có:

| Nút trên màn hình | `BusinessAction` đã có | Có gửi lệnh ĐVVC |
| --- | --- | --- |
| **Đã hoàn** | `APPROVE_RETURN` | có (`approve-return`) |
| **Phát tiếp** | `REQUEST_REDELIVERY` | có (`redeliver`) |
| **Xử lý sau** | `CONTINUE_MONITORING` | không |

"Kết quả hiện tại" là một **PHÉP ĐỌC** trên `care_business_actions` (dòng mới nhất của ĐÚNG đợt đang
mở), chứ không phải một cột `resolution_action` song song. Thêm cột như vậy là tự nhận lấy câu hỏi
*"hai chỗ lệch nhau thì tin chỗ nào"*, và mọi đường ghi sau này (AI, job, thao tác hàng loạt) đều phải
nhớ cập nhật cả hai — lần quên đầu tiên thì màn hình nói sai mà không ai biết.

`EXCHANGE` (Đổi) **cố ý** không nằm trong ba nút: nó cần một vận đơn thay thế đã tồn tại nên nó là một
quy trình, không phải một cú bấm. `resolutionOf("EXCHANGE")` trả `null`, và bộ lọc KHÔNG xếp nó vào rổ
"chưa quyết định" — nó đã được quyết, chỉ là không thuộc ba rổ này.

## 3. Ba chiều vẫn là ba chiều

| Chiều | Nguồn | Ai sửa được |
| --- | --- | --- |
| Gói hàng ở đâu | `shipments.stage` / `carrierSubstate` | **không ai** — chứng từ ĐVVC |
| Đội đang ở đâu | `shipment_care.care_status` | người, theo `CARE_TRANSITIONS` |
| Đội quyết gì | `care_business_actions` (mới ở bản này: hiện ra thành ba nút) | người |

Nhân viên bấm **"Đã hoàn" KHÔNG làm vận đơn thành hoàn**: `shipments.stage` không đổi một ký tự,
`ORDER_OUTCOME` không đổi, tồn kho không tăng. `tests/care-resolution.test.ts` mục 8 so nguyên dòng
`shipments` trước và sau cú bấm.

## 4. Đã làm gì

**Hàng đợi (`workbench.tsx`)** — ba nút đứng TRÊN CÙNG ô "Care · kết quả xử lý", là thứ đầu tiên mắt
chạm tới. "Phát tiếp" bấm là chạy; "Đã hoàn" mở bảng chọn lý do (máy chủ bắt buộc — suy lý do hoàn từ
chứng từ ĐVVC chỉ phủ ~22% vận đơn); "Xử lý sau" mở bảng chọn giờ hẹn. Dấu ▾ mở bảng note cho "Phát
tiếp". Hai hàng chip lọc mới: **Kết quả** (chưa quyết định · ba kết quả) và **Hẹn** (quá hẹn · hôm nay ·
ngày mai · xa hơn · chưa hẹn), sống trên URL như mọi bộ lọc khác.

**Panel (`care-drawer.tsx`)** — dựng lại thành bàn xử lý: đầu panel dính, thân cuộn riêng; lưới dữ kiện
(COD · lần phát hụt · tuổi tin ĐVVC · lần gửi thứ · hạn · trạng thái xử lý · người phụ trách); khối
**XỬ LÝ CASE** với ba nút + mẫu note + ô tự do; hành trình ĐVVC tô theo loại sự kiện và tách được tên
/ SĐT bưu tá thành nút gọi; **nhật ký xử lý** gộp ba nguồn (quyết định · thao tác care · việc đã chăm)
trên một trục thời gian.

**Mã vận đơn bấm được** → `https://viettelpost.vn/thong-tin-don-hang?...` mở tab mới. Địa chỉ dựng bằng
`getViettelPostTrackingUrl` — cùng hàm mà bảng và trang chi tiết dùng, không có chuỗi địa chỉ thứ hai.
Chưa có mã Viettel Post thì KHÔNG vẽ liên kết (mã Pancake tra ra "không tìm thấy").

**Đi lần lượt** — ‹ n/N ›, phím `J`/`K` đi kiện, `1`·`2`·`3` mở ba kết quả, `N` nhảy vào ô note (mọi
phím tắt bị chặn khi con trỏ đang ở ô nhập). Ô ☑ "Ghi nhận xong tự chuyển kiện kế" nhớ theo máy.
**Ghi LỖI thì không chuyển** — chuyển đi là giấu mất lỗi.

**Mẫu note cấu hình được** — `settings.care.resolutionNotes`, sửa ngay tại chỗ dùng, cần
`shipments:manage`. Mỗi lượt ghi chỉ gửi MỘT kết quả, để hai người sửa hai rổ khác nhau không đè nhau.

## 5. Lỗi đã sửa kèm theo

`CareWorkbenchView` giữ danh sách trong `useState(() => …)` — hàm khởi tạo chỉ chạy MỘT LẦN. Panel ghi
xong gọi `router.refresh()`, máy chủ gửi `initial` mới, nhưng bảng vẫn giữ ảnh chụp lúc mở trang: đổi
kết quả trong panel, đóng panel, dòng ngoài bảng y như cũ cho tới khi bấm F5. Đã thêm hiệu ứng đồng bộ
theo danh tính `initial` — thao tác ngay trên bảng vẫn vá dòng bằng `CareState` máy chủ trả về nên
không bị nuốt.

## 6. Đã kiểm

`tests/care-resolution.test.ts` (mới, chạy trong `npm test`): ba nút phủ đúng ba quyết định · hẹn xem
lại là hàm thuần và "cuối buổi" neo vào giờ làm việc · ghi rồi đọc lại ra đúng kết quả + note + giờ
hẹn · "Xử lý sau" không giờ bị từ chối · "Đã hoàn" không lý do bị từ chối · **quyết định của người
KHÔNG chạm chứng từ ĐVVC** · **webhook ĐVVC ập tới sau đó KHÔNG xoá quyết định và không xoá note** ·
sổ chỉ thêm, đủ ai/lúc nào/trước-sau/lý do · đóng ca rồi vẫn đọc lại được kết quả · kiện `WEBHOOK_ONLY`
đi đường LÀM TAY CÓ GHI VẾT chứ không gọi API.

`tests/care-filters.test.ts` mở rộng: hai chiều lọc mới đi qua CHÍNH vị từ chung, nên tính chất "số
trên chip = số dòng bảng" được chứng minh cho chúng bằng cùng một vòng lặp (364 cặp).

Chạy thật trên bản dựng production với PGlite + Chromium: bấm "Xử lý sau" ngoài bảng → chọn 1 giờ →
ghi note → **tải lại trang** ⇒ nút vẫn đang chọn, note vẫn trên dòng, giờ hẹn vẫn còn, lọc
`?ketqua=FOLLOW_UP_LATER` và `?hen=today` ra đúng kiện, panel in đúng dòng "Chọn: Xử lý sau" trong nhật
ký. Không một lỗi JavaScript nào.

## 7. Còn lại / rủi ro

- **Hai nút "Đã hoàn" và "Phát tiếp" GỬI LỆNH sang ĐVVC**, nên chúng bị khoá khi kiện đang ở trạng thái
  ĐVVC không nhận lệnh (đã giao · đã hoàn · đã huỷ · chưa có mã VTP), hoặc khi ERP chưa khai tài khoản
  API Viettel Post. Nút vẫn HIỆN nhưng khoá, kèm lý do trong tooltip — biến mất thì người dùng tưởng
  màn hình hỏng. Luật điều kiện KHÔNG bị nới ở bản này.
- **"Xử lý sau" đẩy ca sang `WAITING_REDELIVERY`**, nên kiện rời tab "Cần care" và sang tab "Đang chờ
  kết quả" cho tới giờ hẹn — đúng vòng đời đang chạy, không phải lỗi.
- `recordBusinessAction` **cố ý KHÔNG** ghi vào `care_actions`: bảng đó đo VIỆC CHĂM SÓC THẬT (luật 56,
  57) và một quyết định không phải một cuộc gọi. Note của quyết định nằm ở `care_business_actions`,
  `care_case_events` và `shipment_care.last_note`, và panel in đủ cả ba.

# Bản 18–19/09/2026 — Ba kết quả care: Đã hoàn · Phát tiếp · Xử lý sau

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

## 2. CARE DECISION ≠ VTP COMMAND (sửa 19/09/2026)

Đây là điểm kiến trúc quan trọng nhất, và **bản đầu tiên đã làm sai**.

Bản đầu ánh xạ ba nút về `BusinessAction` (`APPROVE_RETURN` / `REQUEST_REDELIVERY` /
`CONTINUE_MONITORING`) để khỏi phải thêm bảng. Hai trong ba hành động ấy **gửi một lệnh sang Viettel
Post**, nên đường ghi của chúng từ chối khi ĐVVC không nhận lệnh. Hệ quả: **năng lực API của ERP
quyết định xem NHÂN VIÊN có ghi nhận được việc mình vừa làm hay không** — thiếu
`VIETTELPOST_API_KEY`, API lỗi, kiện chưa có mã vận đơn, kiện đã kết thúc, kiện đi hãng khác: cả năm
tình huống đều khoá mất một phép đo về CON NGƯỜI.

Chủ shop chốt: ba lựa chọn này **trước hết là KẾT QUẢ CÔNG VIỆC CARE**, và phải ghi được LUÔN LUÔN.

Bản này tách hẳn hai thứ:

| | Kết quả care | Lệnh gửi ĐVVC |
| --- | --- | --- |
| Trên màn hình | khối **KẾT QUẢ CARE** | khối **THAO TÁC VIETTEL POST** |
| Giá trị | `CARE_RETURN` · `CARE_CONTINUE_DELIVERY` · `CARE_FOLLOW_UP` | `redeliver` · `approve-return` … |
| Sổ | `care_decisions` (mới, chỉ thêm) | `carrier_action_requests` + `care_business_actions` |
| Server Action | `recordCareDecision` | `requestCarrierAction` / `recordBusinessAction` |
| Gọi API ĐVVC | **không bao giờ** | có |
| Có bị khoá không | **không bao giờ** | có — kèm lý do trong tooltip |

**Migration `0103_care_decisions`** — chỉ cộng thêm một bảng, không sửa cột nào đang có, không
backfill một dòng nào. `care_business_actions` giữ NGUYÊN nghĩa cũ của nó và vẫn tra được ở nhật ký
vận đơn; ép ba nút vào bảng ấy chỉ để tránh một migration là dùng sai nghĩa một cấu trúc có sẵn.

Khoá mang tiền tố `CARE_` có chủ đích: một lập trình viên sáu tháng sau đọc `decision = 'RETURNED'`
trong CSDL sẽ tin rằng kiện đã hoàn thật. `tests/care-resolution.test.ts` khoá luôn điều đó —
`careDecisionOf("RETURNED")` và `careDecisionOf("APPROVE_RETURN")` đều phải trả `null`.

"Kết quả hiện tại" vẫn là một **PHÉP ĐỌC** (dòng `care_decisions` mới nhất của ĐÚNG đợt đang mở),
không phải một cột `resolution_action` song song trên `shipment_care`: một cột thứ hai giữ cùng một
sự thật là tự nhận lấy câu hỏi *"hai chỗ lệch nhau thì tin chỗ nào"*.

## 3. Ba chiều vẫn là ba chiều

| Chiều | Nguồn | Ai sửa được |
| --- | --- | --- |
| Gói hàng ở đâu | `shipments.stage` / `carrierSubstate` | **không ai** — chứng từ ĐVVC |
| Đội đang ở đâu | `shipment_care.care_status` | người, theo `CARE_TRANSITIONS` |
| Đội quyết gì | `care_decisions` (mới ở bản này) | người |
| Đội đã gửi lệnh gì sang ĐVVC | `care_business_actions` + `carrier_action_requests` | người, khi đủ điều kiện |

Nhân viên bấm **"Đã hoàn" KHÔNG làm vận đơn thành hoàn**: `shipments.stage` không đổi một ký tự,
`ORDER_OUTCOME` không đổi, tồn kho không tăng. `tests/care-resolution.test.ts` (CASE E) so nguyên dòng
`shipments` trước và sau cú bấm, và (CASE D) khẳng định `carrier_action_requests` vẫn rỗng.

## 4. Đã làm gì

**Hàng đợi (`workbench.tsx`)** — ba nút đứng TRÊN CÙNG ô "Care · kết quả xử lý", là thứ đầu tiên mắt
chạm tới, và **không điều kiện ĐVVC nào khoá được chúng**. "Phát tiếp" bấm là chạy; "Đã hoàn" mở bảng
chọn lý do (suy lý do hoàn từ chứng từ ĐVVC chỉ phủ ~22% vận đơn — đây là lý do NGHIỆP VỤ, không phải
lý do kỹ thuật); "Xử lý sau" mở bảng chọn giờ hẹn. Dấu ▾ mở bảng note cho "Phát tiếp". Hai hàng chip
lọc mới: **Kết quả** (chưa quyết định · ba kết quả) và **Hẹn** (quá hẹn · hôm nay · ngày mai · xa hơn ·
chưa hẹn), sống trên URL như mọi bộ lọc khác.

**Panel (`care-drawer.tsx`)** — dựng lại thành bàn xử lý: đầu panel dính, thân cuộn riêng; lưới dữ kiện
(COD · lần phát hụt · tuổi tin ĐVVC · lần gửi thứ · hạn · trạng thái xử lý · người phụ trách); khối
**KẾT QUẢ CARE** (ba nút + mẫu note + ô tự do, không bao giờ khoá); khối **THAO TÁC VIETTEL POST**
đứng RIÊNG ngay dưới, với "Yêu cầu phát lại trên VTP" / "Duyệt hoàn trên VTP" — khối này ĐƯỢC PHÉP
khoá và in nguyên văn lý do; hành trình ĐVVC tô theo loại sự kiện và tách được tên / SĐT bưu tá thành
nút gọi; **nhật ký xử lý** gộp bốn nguồn (kết quả care · lệnh gửi ĐVVC · thao tác care · việc đã chăm)
trên một trục thời gian, mỗi dòng kết quả care in kèm **ảnh chụp chiều ĐVVC lúc bấm**.

Mỗi dòng `care_decisions` lưu `carrier_stage_at_decision` + `carrier_substate_at_decision`. Đó là
bằng chứng đọc lại được sau nhiều tháng rằng hai chiều là hai chiều: một dòng "Đã hoàn" ghi lúc ĐVVC
còn đang báo "Tồn - khách nghỉ" nói thẳng ra là ERP không suy chiều nọ từ chiều kia.

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

## 6. Đã kiểm (bổ sung CASE A–H ngày 19/09)

`tests/care-resolution.test.ts` chạy **toàn bộ khối CSDL trong trạng thái ERP CHƯA KHAI TÀI KHOẢN
API** (`setViettelPostClientForTests(null)`), cố ý:

| | Tình huống | Khẳng định |
| --- | --- | --- |
| A | chưa khai `VIETTELPOST_API_KEY` | cả ba kết quả vẫn ghi được |
| B | kiện KHÔNG có mã vận đơn | vẫn ghi được cả ba |
| C | ĐVVC đã kết thúc (đã hoàn) | vẫn ghi được |
| D | chọn "Phát tiếp" | `carrier_action_requests` vẫn RỖNG — không một lệnh nào |
| E | chọn "Đã hoàn" | `shipments` (stage · vtp_status · is_final · cod_status) không đổi một ký tự |
| F | webhook ĐVVC chạy sau đó | quyết định + note còn nguyên, sổ không mất dòng nào |
| G | lệnh gửi ĐVVC THẤT BẠI | kết quả care trước đó còn nguyên |
| H | tải lại trang | kết quả + note + giờ hẹn còn nguyên |

Kèm theo: hẹn xem lại là hàm thuần và "cuối buổi" neo vào giờ làm việc · "Xử lý sau" không giờ và
"Đã hoàn" không lý do đều bị từ chối **và không ghi một dòng nào** · khoá `CARE_*` không đọc nhầm
được thành trạng thái ĐVVC · ghi kết quả trên ca đã đóng được nhưng KHÔNG tự mở lại ca.

`tests/care-filters.test.ts` mở rộng: hai chiều lọc mới đi qua CHÍNH vị từ chung, nên tính chất "số
trên chip = số dòng bảng" được chứng minh cho chúng bằng cùng một vòng lặp (364 cặp).

Chạy thật trên bản dựng production với PGlite + Chromium, **trong một ERP không có một biến môi trường
Viettel Post nào**: ba nút care không bị khoá ở cả bảng lẫn panel · "Phát tiếp" một cú bấm, tải lại
vẫn còn · "Đã hoàn" + lý do + note trong panel, tải lại vẫn còn · cột "VTP báo" vẫn in "Tồn - Khách
hàng nghỉ" (KHÔNG thành "đã hoàn") · hai nút trong khối "Thao tác Viettel Post" bị khoá đúng như phải
thế · lọc `?ketqua=CARE_RETURN` ra đúng kiện · nhật ký in "Chọn: Phát tiếp" kèm "VTP lúc đó". Không
một lỗi JavaScript nào.

### Quả bom hẹn giờ đã gỡ kèm (luật 50)

`tests/care-reopen.test.ts` gieo một bản sao đợt care với `openedAt = gio(20)` rồi so với
`REOPEN_GUARD_LIVE_AT` — một hằng số NGÀY CỐ ĐỊNH (18/09/2026 04:10Z). Cửa sổ trượt theo đồng hồ thật
quét qua một mốc đứng yên: bài kiểm **xanh ngày 18/09 và ĐỎ ngày 19/09**, và vì workflow deploy chạy
`npm test` trước khi đụng máy chủ nên nó chặn MỌI lần deploy. Mốc nay dựng TỪ CHÍNH
`REOPEN_GUARD_LIVE_AT`, và kỳ đọc được nới để luôn phủ được nó — hôm nay là thứ mấy cũng vậy.

## 7. Còn lại / rủi ro

- **Không nút kết quả care nào bị khoá vì ĐVVC nữa.** Chỉ khối "Thao tác Viettel Post" mới khoá, và
  nó khoá theo điều kiện THẬT (`shipments.tracking_capability` + `vtpConfigured()` do máy chủ gửi
  xuống, không phải một hằng số lạc quan trên màn hình).
- **Quyền**: ba nút cần `shipments:manage` (CS và LEADER đã có). Tài khoản chỉ-xem thấy khối kết quả
  ở dạng chữ, không bấm được — đây là quyền, không phải năng lực API.
- **"Xử lý sau" đẩy ca sang `WAITING_REDELIVERY`**, nên kiện rời tab "Cần care" và sang tab "Đang chờ
  kết quả" cho tới giờ hẹn — đúng vòng đời đang chạy, không phải lỗi.
- `recordBusinessAction` **cố ý KHÔNG** ghi vào `care_actions`: bảng đó đo VIỆC CHĂM SÓC THẬT (luật 56,
  57) và một quyết định không phải một cuộc gọi. Note của quyết định nằm ở `care_business_actions`,
  `care_case_events` và `shipment_care.last_note`, và panel in đủ cả ba.

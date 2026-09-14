# Hệ vận hành đo được theo ngày — báo cáo kiểm và dựng

Ngày 10/09/2026. Mọi con số đo **trên production**, không phải fixture.

---

## 1. Kiểm trước, dựng sau — và phần lớn đã có sẵn

Việc đầu tiên là đi tìm xem ERP đã có gì, để không dựng lại thứ đang chạy tốt. Kết quả:

**Hàng đợi việc đã trưởng thành, KHÔNG dựng lại.** `lib/constants/action-queue.ts` đã có 22 loại
việc · đội phụ trách từng loại · hạn xử lý từng loại · trọng số còn-cứu-được kèm lý do tiếng Việt ·
hành động khuyến nghị · điểm ưu tiên **giải thích được từng phần** (`caseScoreBreakdown` trả ra sáu
thành phần, `scoreExplanation` nói yếu tố nào đẩy việc lên cao nhất). Nghĩa là các mục "điểm ưu
tiên", "việc gì / ai làm", "năng suất đội", "khung SLA" của đặc tả **đã xong từ trước**.

**Thứ thiếu là lớp KHÂU.** `lib/queries/sales-funnel.ts` chỉ có 5 bước (tạo · xác nhận · rời kho ·
giao · mua lại) và không có tuổi việc, hạn xử lý, tiền, hay chủ trách nhiệm cho từng bước. Không có
module nào trả lời được "đang kẹt ở khâu nào và chỗ đó treo bao nhiêu tiền".

Nên phần dựng mới chỉ có ba tệp, và cả ba đều **bắc cầu** sang máy móc đã có thay vì đẻ luật thứ hai.

## 2. Đo được gì trên production

Việc đang mở, theo loại — cột tiền là giá trị đơn hoặc COD có thật:

```
ORDER_PENDING                 237 việc   108.669.000đ   237 trễ hạn   cũ nhất 134 giờ
ORDER_CONFIRMED_STALE         203 việc   106.134.999đ   203 trễ hạn   cũ nhất 146 giờ
ORDER_ADDRESS_NOT_NORMALIZED   90 việc    43.782.000đ    90 trễ hạn   cũ nhất 307 giờ
SHIPMENT_RETURNING             99 việc    42.842.500đ     0 trễ hạn   cũ nhất 166 giờ
ORDER_INCOMPLETE               87 việc    13.972.000đ    61 trễ hạn   cũ nhất 334 giờ
CUSTOMER_RECOVERY              19 việc    10.731.500đ     2 trễ hạn
SHIPMENT_FAILED                19 việc     9.782.000đ     6 trễ hạn
RETURN_PENDING_INSPECTION      16 việc     7.285.000đ    16 trễ hạn   cũ nhất 846 giờ
COD_OVERDUE                    11 việc     5.120.000đ     9 trễ hạn   cũ nhất 671 giờ
SHIPMENT_STALE                  5 việc     2.545.000đ     5 trễ hạn
RISKY_ORDER                     3 việc     1.872.000đ     3 trễ hạn
CANCELLED_BUT_SHIPPING          2 việc     1.043.000đ     2 trễ hạn
CS_CASE                       364 việc             0đ   338 trễ hạn
STOCK_LOW / ADS_BILLING / DATA_ERROR / ADS_ANOMALY  18 việc, không tra được tiền
────────────────────────────────────────────────────────────────────
1.173 việc đang mở · ~353.700.000đ đang treo
```

Ba khâu đầu của dòng chảy giữ **258 triệu**, tức **73% toàn bộ tiền đang treo** — và cả ba đều là
việc của CSKH và kho, không phải của giao vận. Đó là câu trả lời cho "đang kẹt ở đâu": không phải
ngoài đường, mà **trước khi hàng rời kho**.

## 3. Phát hiện quan trọng nhất: chưa có ca nào chứng minh được là có người xử lý

Bộ ước lượng tiền thu hồi cần một tỷ lệ đo từ lịch sử. Truy vấn đầu tiên cho ra:

```
ORDER_PENDING         62 ca đã đóng →  3 về đích  (4,8%)
ORDER_INCOMPLETE      28 ca đã đóng →  0 về đích  (0%)
ORDER_CONFIRMED_STALE  4 ca         →  2 về đích
RISKY_ORDER            2 ca         →  0 về đích
```

Nhìn qua thì đủ mẫu để nói "đơn mới chưa xử lý: cứu được 4,8%". Nhưng hỏi thêm một câu — *ai đóng
những ca đó* — thì lộ ra:

```
cả 96 ca đều mang resolution = 'UNKNOWN'
```

Tức là **đóng từ trước khi có cột ghi nguồn gốc**. Không một ca nào chứng minh được là có người
ngồi làm. Lấy chúng làm mẫu là đo *"đơn từng bị cảnh báo thì kết cục ra sao"* rồi dán lên đó cái
nhãn *"xử lý thì thu về được bao nhiêu"* — hai câu hoàn toàn khác nhau, và câu thứ hai là câu chủ
shop dùng để quyết định có nên cắt người sang làm việc đó không.

Nên bộ ước lượng lọc `resolution = 'MANUAL'`, và hôm nay nó trả về **không ước tính nào**. Màn hình
nói thẳng: *"Chưa ca nào được người bấm đóng, nên chưa đo được xử lý thì thu về bao nhiêu. Mỗi lần
bấm XONG một việc là góp một mẫu."*

Đây không phải một thiếu sót phải xin lỗi. Đây là vòng phản hồi: hệ tự bật lên khi người vận hành
bắt đầu dùng nó, và cho tới lúc đó nó không nói dối.

## 4. Đã dựng

**`lib/constants/operating-funnel.ts`** — sổ đăng ký 16 khâu. Mỗi khâu khai: đội chủ · loại việc
thuộc về nó · **tiền ở khâu này nghĩa là gì** · đường tra ngược · ghi chú nguồn dữ liệu. Không khai
lại hành động, hạn xử lý hay trọng số — những thứ đó đã có một chỗ duy nhất trong sổ hàng đợi.

**`lib/queries/stage-health.ts`** — một câu SQL duy nhất cho cả bảng điều khiển: tồn đọng, năm mốc
tuổi, trễ hạn (biểu thức sinh từ chính `CASE_SLA_HOURS`, không gõ lại số giờ), tiền treo, việc chưa
ai nhận — gom theo khâu và theo đội. Cộng thêm bảng ghi công 7 ngày.

**`lib/queries/impact.ts`** — bộ ước lượng, tách bạch bốn con số ở §3 của
`docs/operating-funnel-metric-contract.md`.

**`/operations`** — màn hình xếp đúng theo bốn câu: A đang kẹt ở đâu · B việc nào làm ngay · C ai
phụ trách · D thu về bao nhiêu.

**`tests/operating-funnel.test.ts`** — lá chắn. Đã bắt hai lỗi ngay khi vừa viết xong.

## 5. Lá chắn bắt được gì ngay lần đầu

Bản đầu của sổ đăng ký khai `ORDER_CONFIRMATION_STALE` ở **cả** khâu "Chờ xác nhận" lẫn "Chờ bàn
giao", và `CUSTOMER_RECOVERY` ở **cả** "Hoàn về" lẫn "Mua lại". Hậu quả nếu để nguyên: 106 triệu và
10,7 triệu bị cộng **hai lần** vào tổng "đang treo" — con số to gấp rưỡi sự thật, im lặng, không lỗi.

Bài kiểm được thử ngược để chắc chắn nó thật sự đỏ:

```
AssertionError: một loại việc khai ở nhiều khâu ⇒ tiền của nó bị cộng nhiều lần vào tổng đang treo
  actual: [ 'CUSTOMER_RECOVERY ở RETURNING và REPEAT' ]
```

Lá chắn thứ hai — `tests/shipment-join-grain.test.ts`, dựng từ sự cố Phase 2 — cũng chặn tệp mới và
bắt phải khai lý do. Grain ở đây là VIỆC chứ không phải đơn, nên miễn trừ là đúng, nhưng nó buộc
phải nói ra thay vì im lặng đi qua.

## 6. Khâu chưa đo được, nói thẳng

| Khâu | Tình trạng | Vì sao |
| --- | --- | --- |
| Khách nhắn / tiềm năng | nguồn thiếu một phần | Có 613 case CSKH nhưng **không có mốc phản hồi đầu tiên** cho từng lead ⇒ tỷ lệ và tốc độ phản hồi chưa đo được |
| Tiền đã về | nguồn thiếu một phần | Sổ ngân hàng **0 giao dịch** ⇒ chỉ đối chiếu được với bảng kê ĐVVC, chưa có số dư thật đối ứng |
| Sản xuất / nhập hàng | chưa có nguồn | **0 lệnh sản xuất** trong CSDL |
| Tồn kho & vốn | nguồn thiếu một phần | Chỉ **2 phiếu nhập** ⇒ phần lớn mẫu mã chưa biết tồn |
| Giao thành công | chưa có luật phát hiện | Là khâu đích, không có việc tồn đọng — hiện "chưa đo được" thay vì "đang khoẻ" |

Cả năm đều **giữ nguyên hợp đồng** để ngày có nguồn là cắm vào chạy, không phải sửa mã.

## 7. Một chênh lệch cần chủ shop biết

Hàng đợi hiện **16 việc** "hàng hoàn về · chưa tái nhập kho", trong khi kho đang có **471 kiện** chờ
kiểm đếm. Luật phát hiện chỉ mở việc cho kiện đã được ghi nhận ĐÃ VỀ TỚI NƠI, còn phần lớn kiện vẫn
đang ở trạng thái ĐVVC báo hoàn. Con số 16 không sai theo định nghĩa của nó, nhưng nó **không phải**
con số nói lên khối lượng việc của kho. Trạm đếm ở `/inventory/returns` mới là chỗ thấy đủ 471 kiện.

Chưa sửa vì sửa luật phát hiện sẽ đổi số việc của cả hệ; cần chủ shop chốt là muốn mỗi kiện chờ đếm
thành một việc trong hàng đợi hay giữ nguyên như hiện tại.

## 8. Không làm, cố ý

- **Không** đẻ luật phát hiện thứ hai cho từng khâu — sẽ tạo hai con số cho cùng một chuyện.
- **Không** dùng `RECOVERABILITY` để nhân ra tiền thu hồi — đó là trọng số xếp thứ tự, không phải
  tỷ lệ đo được.
- **Không** mở Direct VTP Fulfillment. Không đổi luật kết quả đơn. Không tự động điều chỉnh quảng
  cáo. Không tự tái nhập hàng hoàn. Không ép đối soát ngân hàng.
- **Không** đụng vào hiệu năng các trang đã đạt mục tiêu.

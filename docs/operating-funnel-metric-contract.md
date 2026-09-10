# Hợp đồng đo lường phễu vận hành

Mã: `lib/constants/operating-funnel.ts` · `lib/queries/stage-health.ts` · `lib/queries/impact.ts`
Lá chắn: `tests/operating-funnel.test.ts` · Màn hình: `/operations`

---

## 1. Bốn câu, và trường nào trả lời câu nào

Một khâu chỉ dùng được để điều hành khi trả lời đủ bốn câu. Thiếu một ô là thấy tắc mà không biết
gọi ai, hoặc biết gọi ai mà không biết bấm vào đâu để xem.

| Câu | Trường | Nguồn |
| --- | --- | --- |
| **A. Đang kẹt ở đâu?** | `backlog` · `aging` · `oldestHours` · `breached` | việc đang mở trong `notifications` |
| **B. Việc nào làm ngay?** | `exceptions[]` xếp theo tiền · `nextAction` | `CASE_ACTION` của sổ hàng đợi |
| **C. Ai phụ trách?** | `team` của khâu · `byTeam` theo từng loại việc | `CASE_TEAM` |
| **D. Thu về bao nhiêu?** | `impact.moneyAtRisk` · `impact.estimatedRecoverable` | đơn / vận đơn · lịch sử ca có người đóng |

## 2. Luật nền

**Phễu KHÔNG có luật phát hiện riêng.** Nó gom lại chính những việc mà hàng đợi đã phát hiện, đã
chống trùng, đã tự đóng khi điều kiện hết. Viết một câu đếm riêng cho mỗi ô sẽ tạo ra hai con số
cho cùng một chuyện, và sáu tháng sau không ai biết cái nào đúng.

**Một loại việc thuộc ĐÚNG MỘT khâu.** Khai ở hai khâu thì tiền của nó cộng hai lần vào tổng. Bản
đầu của sổ đăng ký mắc đúng lỗi này hai chỗ (`ORDER_CONFIRMATION_STALE`, `CUSTOMER_RECOVERY`);
`tests/operating-funnel.test.ts` nay chặn ở mức mã nguồn.

**Loại việc cắt ngang không bị nhét vào một khâu.** `DATA_ERROR` làm lệch mọi khâu;
`PROFITABILITY_ALERT` là cảnh báo mức kinh doanh. Cả hai khai ở `NGOAI_PHEU` kèm lý do, không im
lặng biến mất.

**Khâu không có nguồn ⇒ `DATA_UNAVAILABLE`, KHÔNG phải "đang khoẻ".** Đo từ chính CSDL, không khai
sẵn: 0 lệnh sản xuất ⇒ khâu Sản xuất chưa đo được; sổ ngân hàng trống ⇒ khâu Tiền đã về ở mức
"nguồn thiếu một phần".

## 3. Tiền: sự thật và ước tính không bao giờ là một số

```
moneyAtRisk          SỰ THẬT   tổng giá trị đơn / COD trong các việc đang mở. Không nhân hệ số nào.
estimatedRecoverable ƯỚC TÍNH  moneyAtRisk × tỷ lệ cứu được ĐO TỪ LỊCH SỬ. null = CHƯA ĐO ĐƯỢC.
unestimatedAtRisk    SỰ THẬT   phần tiền nằm ở loại việc chưa có cách đo. Nói ra, không giấu.
recoveredValue       SỰ THẬT   phần đã VỀ ĐÍCH của các việc người đã đóng, đọc từ kết quả đơn.
```

Hai dòng riêng trên màn hình, luôn luôn. Gộp lại sẽ tạo ra một con số trông như tiền thật mà không
ai truy được nguồn — và người ta sẽ ra quyết định trên nó.

### Tỷ lệ cứu được đo từ đâu

**Không** lấy `RECOVERABILITY` của sổ hàng đợi: trọng số đó dùng để XẾP THỨ TỰ việc, do người viết
ước lượng. Nhân tiền thật với một hệ số phỏng đoán ra một con số phỏng đoán mang hình dạng tiền thật.

Thay vào đó, đếm lịch sử với ba bộ lọc, mỗi cái chặn một cách đo sai:

| Bộ lọc | Chặn cái gì |
| --- | --- |
| `resolution = 'MANUAL'` | Chỉ ca CÓ NGƯỜI xử lý. Ca tự đóng đo chuyện khác: đơn tự đi tiếp. |
| việc còn mở bị loại | Kết quả chưa ngã ngũ, đưa vào mẫu thì kéo tỷ lệ xuống giả tạo. |
| đơn còn đang đi bị loại | Chưa thuộc về bên nào; xếp vào "không cứu được" là kết tội sớm. |

Dưới `CO_MAU_TOI_THIEU = 20` mẫu thì **không ước tính**, và nói rõ vì sao. Chỉ hiện "353tr đang
treo" là đúng và đủ.

`RECOVERY_MEASURABLE` chỉ khai loại việc mà "cứu được" có MỘT nghĩa duy nhất, đo được: việc gắn với
một đơn, và cứu được nghĩa là đơn đó vẫn giao thành công. Loại có nghĩa ngược lại bị loại tường minh
— `CANCELLED_BUT_SHIPPING` cứu được nghĩa là CHẶN được kiện hàng, dùng chung định nghĩa "giao thành
công" ở đó sẽ đo ngược hoàn toàn.

## 4. Mười sáu khâu

| # | Khâu | Đội | Loại việc | Tiền ở đây nghĩa là |
| --- | --- | --- | --- | --- |
| 1 | Quảng cáo · kéo khách | Quảng cáo | `ADS_BILLING` `ADS_ANOMALY` | tiền ĐÃ CHI, phần đang chi sai |
| 2 | Khách nhắn / tiềm năng | CSKH | `CS_CASE` | chưa quy ra tiền được |
| 3 | Đơn đã lên | CSKH | `NEW_ORDER_UNPROCESSED` `ORDER_INCOMPLETE` | giá trị ĐÃ LÊN ĐƠN |
| 4 | Chờ xác nhận | CSKH | `ORDER_ADDRESS_NOT_NORMALIZED` | tiền chưa chắc, còn cứu bằng một cuộc gọi |
| 5 | Soát rủi ro trước gửi | CSKH | `RISKY_ORDER` | gửi nhầm là mất hàng lẫn hai chiều cước |
| 6 | Chờ bàn giao ĐVVC | Kho | `ORDER_CONFIRMATION_STALE` | doanh thu BỊ CHẶN trước khi rời kho |
| 7 | Đã bàn giao ĐVVC | Dữ liệu | `ORPHAN_SHIPMENT` `AMBIGUOUS_ORDER_SHIPMENT_MAPPING` | COD trên đường |
| 8 | Đang giao / giao hụt | Giao vận | `DELIVERY_FAILED` `DELIVERY_STALE` `CANCELLED_BUT_SHIPPING` | COD ĐANG RỦI RO |
| 9 | Giao thành công | Giao vận | — | doanh thu ĐÃ GHI NHẬN |
| 10 | Hoàn về | Giao vận | `RETURNING` | doanh thu ĐÃ MẤT + cước hai chiều |
| 11 | COD chờ về | Kế toán | `COD_OVERDUE` | TIỀN MẶT chưa về tài khoản |
| 12 | Tiền đã về | Kế toán | — | tiền mặt ĐÃ VỀ, có chứng từ |
| 13 | Hàng hoàn chờ kiểm đếm | Kho | `RETURN_RECEIVED_PENDING_INSPECTION` | giá vốn NẰM NGOÀI SỔ |
| 14 | Tồn kho & vốn | Kho | `LOW_STOCK_RISK` `STOCKOUT_RISK` | vốn nằm trong hàng |
| 15 | Sản xuất / nhập hàng | Sản xuất | — | vốn đã cam kết với xưởng |
| 16 | Mua lại / chăm sóc | CSKH | `CUSTOMER_RECOVERY` | doanh thu ĐÃ NHẬN của khách cũ |

Khâu 7 do **đội dữ liệu** chứ không phải giao vận: kiện hàng là của giao vận, nhưng việc tồn đọng ở
đó chỉ có một loại — không biết vận đơn nào thuộc đơn nào — và người sửa được là đội dữ liệu.

`byTeam` cộng theo `CASE_TEAM` của **từng loại việc**, không theo đội chủ khâu: khâu "Đang giao" do
giao vận trông, nhưng ai gọi ĐVVC thu hồi kiện của đơn đã huỷ mới là người xử lý.

## 5. Mốc tuổi việc

`dưới 2 giờ · 2–6 giờ · 6–24 giờ · 1–3 ngày · trên 3 ngày` — một thang dùng chung cho mọi khâu. Mốc
cuối hứng vô hạn nên không việc nào rơi ra ngoài. Hạn xử lý (SLA) là chuyện khác và vẫn của
`CASE_SLA_HOURS`: mốc tuổi nói việc để bao lâu, hạn nói bao lâu thì gọi là trễ.

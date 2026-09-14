# P0.5 — DỌN DẸP ĐỐI SOÁT DỮ LIỆU · 08/09/2026

## 1. TRƯỚC → SAU

| | Trước | Sau |
|---|---|---|
| **NGHIÊM TRỌNG** | **0** | **0** |
| **Cảnh báo** | **432** | **50** |

| Luật | Trước | Sau | Vì sao đổi |
|---|---|---|---|
| `SHIPMENT_WITHOUT_ORDER` | 264 | **13** | 250 vận đơn chiều hoàn + 1 gói TEST vốn hợp lệ, thôi đếm như sự cố |
| `SHIPMENT_STATE_DRIFT` | 70 | **0** | **đã sửa** — dựng lại ảnh chụp từ lịch sử sự kiện |
| `ORDER_SHIPMENT_CONFLICT` | 73 | **13** | 62 ca là hình mẫu giao-một-phần hợp lệ, không phải mâu thuẫn |
| `AMBIGUOUS_ORDER_SHIPMENT_MAPPING` | 12 | 12 | giữ nguyên — **cố ý không ép ghép** |
| `COD_OVERDUE_UNPAID` | 11 | 11 | giữ nguyên — vấn đề tài chính, phải nhìn thấy |
| `STALE_SHIPMENT` | 2 | **1** | loại gói tin TEST của ĐVVC |

Con số giảm **không phải** do nới lỏng: 312/382 cảnh báo biến mất là những dòng **vốn đã đúng** mà
luật đếm nhầm; 70 dòng còn lại được **sửa thật** bằng cách dựng lại từ chứng từ gốc.

## 2. Vận đơn mồ côi — phân loại đủ 264

| Nhóm | Số | Kết luận |
|---|---|---|
| **C** · vận đơn **chiều hoàn** hợp lệ (`order_reference` trỏ đúng vận đơn gốc) | **250** | đúng quy ước — dòng riêng, không có đơn |
| **C** · chứng từ chép tay lịch sử tháng 8 | **13** | carrier evidence thật, đơn chưa xác định được |
| **E** · gói tin **TEST** của Viettel Post (`123456789101112`) | **1** | không phải gói hàng thật |
| **A/B** · ghép được bằng bằng chứng chắc chắn | **0** | — |
| **D** · không giải thích được | **0** | — |

**Không tự động ghép ca nào**, vì không có ca nào đủ bằng chứng chắc chắn. **Không xoá dòng nào** —
kể cả gói TEST: nó vẫn là dữ liệu ĐVVC đã gửi, chỉ thôi bị đếm như sự cố. Xoá được nếu chủ shop
muốn, nhưng đó là thao tác không hoàn tác được nên để chủ shop quyết.

## 3. Xung đột Pancake ↔ ĐVVC — 73 → 13

70/73 là *"Pancake HOÀN vs vận đơn GIAO"*, trong đó **62 có vận đơn chiều hoàn** và **60 có tiền
thực thu < 50.000đ**. Đó là **hình mẫu giao một phần**: Viettel Post ghi *"Giao thành công"* cho
**chiều đi**, hàng quay về theo vận đơn hoàn, còn Pancake ghi **kết quả cuối** là hoàn.

Hai bên nói về **hai việc khác nhau và cả hai đều đúng**; `ORDER_OUTCOME` đã kết luận HOÀN nhờ chính
vận đơn hoàn đó. Gọi là "xung đột" vừa sai vừa **chôn vùi** những ca xung đột thật.

**13 ca còn lại là xung đột thật**, cần người xem:

| Pancake | Vận đơn | Số | Mã |
|---|---|---|---|
| RETURNED | DELIVERED | 8 | `PKE1494430194`, `PKE1494430805`, `PKE1494431184`, `PKE1494431187`, `PKE1495364258`, `PKE1495364330`, `PKE1507577782`, `PKE1510203454` |
| DELIVERED | RETURNING | 2 | `PKE1507585179`, `PKE1508898018` |
| CANCELLED | DELIVERED | 1 | `PKE1496867951` |
| CANCELLED | IN_TRANSIT | 1 | `PKE1515019056` |
| CANCELLED | OUT_FOR_DELIVERY | 1 | `PKE1512538663` |

Tám ca đầu: Pancake nói hoàn nhưng **không có vận đơn chiều hoàn** — hoặc nhân viên bấm nhầm trên
Pancake, hoặc hàng về mà chưa tạo vận đơn hoàn. Ba ca `CANCELLED` là đơn huỷ trên Pancake nhưng gói
hàng **vẫn đang đi hoặc đã giao** — đáng xem nhất vì có thể mất hàng hoặc mất tiền.

ERP **không tự sửa** nhóm nào: máy không biết bên nào đúng, và ERP không ghi ngược lại Pancake.

## 4. Lệch ảnh chụp — 70 → 0, đã sửa

Sửa bằng `repairReconciliation` (chỉ 3 luật xác định được phép tự sửa), có nhật ký:

```
reconcile.repair · 2026-09-08 14:48:24
  before {"drifted": 70, "mislabelledCod": 0}
  after  {"stateRebuilt": 70, "codLabelFixed": 0}
  reason "Chỉ sửa theo nguồn sự thật của chính chiều đó; lệch giữa tiền và
          giao hàng chỉ báo cáo, không tự sửa."
```

Kiểm chứng: chạy thử canonical sau đó báo **`changed: 0`** — ảnh chụp khớp lịch sử sự kiện hoàn
toàn. **Không sửa một dòng chứng từ gốc nào**; chỉ dựng lại ảnh chụp từ chúng.

Còn **9 vận đơn** ghi "đã giao" mà lịch sử **không có chứng từ nào** — không tự sửa được, và đúng
là không nên: không có gì để dựng lại. Chúng đã mang kết quả `UNKNOWN`.

## 5. Nhập nhằng — giữ nguyên 12, **0 nhóm cần chủ shop**

Đã phân loại ở mục 10n của báo cáo phát hành: **5 nhóm** nhập nhằng danh tính nhưng **tổng hợp xác
định** — mọi cách ghép hợp lệ đều cho cùng kết quả nghiệp vụ. **Không nhóm nào** mà cách ghép khác
nhau làm đổi kết quả. Vì vậy **không đẩy việc nào sang chủ shop**, và cũng **không ép ghép**.

## 6. Vận đơn treo — 2 → 1

Còn `PKE1506703388` (đơn 2652, `OUT_FOR_DELIVERY`, tin cuối **28/08**, 11 sự kiện). Đã thử làm mới:
API Viettel Post **không đọc được** vận đơn của tài khoản này (đã chứng minh ở mục 10f/10k), webhook
thì chỉ đẩy khi có sự kiện mới. **Không có đường nào lấy thêm tin** — giữ nguyên, không suy đoán, và
tuyệt đối không dùng COD để kết luận.

## 7. COD quá hạn — 11 ca, hai bản chất khác nhau

| Nhóm | Số | Tiền khai | Xử lý |
|---|---|---|---|
| **Không có mã vận đơn** (9 đơn tranh chấp) | 9 | 4.566.000đ | kết quả đơn đã là `UNKNOWN`; `cod-settlement` xếp `CHUA_GIAO` nên **không** vào số "Viettel Post phải trả" — không có nợ ảo |
| **Có mã, quá hạn thật** | 2 | 554.000đ | `PKE1505846920` (524.000đ) · `PKE1505846925` (30.000đ), giao 03/09 — việc của tài chính |

**Không đổi kết quả logistics của ca nào.** Chín ca đầu mang `cod_status = COLLECTED` do mapper cũ
bịa; ERP không hạ trạng thái tiền (quy ước chỉ nâng), nhưng chúng đã bị loại khỏi mọi con số phải
thu.

## 8. KPI — trước → sau

| | Trước P0.5 | Sau P0.5 | Nguyên nhân |
|---|---|---|---|
| `DELIVERED` | 416 | **404** | 70 vận đơn dựng lại từ chứng từ: 17 rời `DELIVERED` |
| `RETURNED` | 784 | **780** | dịch chuyển trong nhóm hoàn |
| `IN_TRANSIT` | 292 | **308** | các vận đơn thật ra vẫn đang đi |
| `UNKNOWN` | 13 | **13** | không đổi |
| `NOT_SHIPPED` | 156 | **156** | không đổi |
| `CANCELLED` | 293 | **293** | không đổi |
| **Tỷ lệ GTC** | 34,67% | **34,12%** | |

Tổng đơn không đổi (**1.954** cả hai lần) — không đơn nào biến mất.

Toàn bộ thay đổi KPI đến từ **một nguyên nhân duy nhất**: ảnh chụp trạng thái được dựng lại đúng
theo chứng từ ĐVVC. **Không con số nào đổi để giảm cảnh báo** — các luật bị sửa nghĩa (mồ côi, xung
đột, treo) **không** ghi vào dữ liệu, chúng chỉ thôi đếm nhầm.

## 9. Cảnh báo còn lại — 50, đều có lý do

| Luật | Số | Lý do giữ lại |
|---|---|---|
| `SHIPMENT_WITHOUT_ORDER` | 13 | chứng từ ĐVVC thật, đơn chưa xác định — **không được đoán** |
| `ORDER_SHIPMENT_CONFLICT` | 13 | xung đột thật, cần người xem; ERP không ghi ngược Pancake |
| `AMBIGUOUS_ORDER_SHIPMENT_MAPPING` | 12 | nhập nhằng thật, tổng hợp vẫn xác định |
| `COD_OVERDUE_UNPAID` | 11 | 9 chưa chứng minh được đã giao + 2 quá hạn thật |
| `STALE_SHIPMENT` | 1 | ĐVVC ngừng báo, không có đường lấy thêm tin |

## 10. Cổng ra P0.5

| Điều kiện | |
|---|---|
| 0 NGHIÊM TRỌNG | ✔ |
| Lệch xác định đã sửa | ✔ 70 → 0, `changed: 0` |
| Vận đơn mồ côi đã phân loại | ✔ 264/264 |
| Xung đột thật đã hiểu | ✔ 13 ca, có mã cụ thể |
| Nhập nhằng không bị ép ghép | ✔ 12 giữ nguyên |
| Cảnh báo còn lại có lý do | ✔ cả 50 |
| Không hồi quy bất biến | ✔ **16/16**, `npm test` đạt |

**P0.5 ĐẠT.**

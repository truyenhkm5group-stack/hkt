# Hợp đồng ghi nhận GIÁ VỐN (COGS)

Ngày 09/09/2026. Viết ra vì giá vốn vừa được đưa vào lớp tăng tốc — và **việc tăng tốc tuyệt đối
không được đổi cách xác định giá vốn**, chỉ đổi *lúc nào* nó được tính.

Nguồn sự thật: `ORDER_COGS` trong `lib/queries/cogs.ts`. Tài liệu này mô tả lại nó, không định nghĩa
thay.

---

## 1. Phương pháp tính đang dùng

Giá vốn một đơn = tổng trên từng dòng hàng của `số lượng × đơn giá vốn`, trong đó **đơn giá vốn** lấy
theo thứ tự ưu tiên, lấy được cái nào thì dừng:

| # | Nguồn | Điều kiện |
| --- | --- | --- |
| 1 | **Giá trên phiếu nhập GẦN NHẤT của mẫu mã** | `unit_cost > 0`, xếp theo `received_at desc`, rồi `created_at desc`, lấy 1 |
| 2 | Giá vốn Pancake ghi trên chính dòng hàng | `order_items.unit_cost <> 0` |
| 3 | Giá nhập gần nhất lưu ở mẫu mã | `product_variants.last_imported_price` |
| 4 | `0` | khi cả ba trên đều không có |

Nói gọn: **giá phiếu nhập gần nhất** (*latest applicable receipt*). Không phải bình quân gia quyền,
không phải theo lô, không phải FIFO.

## 2. Tính chất quan trọng nhất — và nó gây bất ngờ

> **"Gần nhất" tính theo THỜI ĐIỂM HIỆN TẠI, không phải theo ngày lên đơn.**

Hệ quả: nhập một phiếu mới hôm nay sẽ **đổi giá vốn của MỌI đơn lịch sử** có mẫu mã đó — kể cả đơn
của tháng trước đã chốt sổ.

Đây là hành vi **hiện hữu**, không phải lỗi mới sinh ra. Nhưng nó có hai hệ quả phải nói rõ:

1. **Lợi nhuận của kỳ đã qua có thể đổi** khi kho nhập hàng mới. Ai chốt số cuối tháng rồi in ra sẽ
   thấy con số khác nếu in lại sau một lần nhập hàng.
2. **Giá vốn đã vật chất hoá phải bị coi là cũ ngay khi có phiếu nhập mới** — nếu không, kết quả đơn
   đúng mà giá vốn cũ, và lợi nhuận sai một cách im lặng.

Điểm 2 đã được xử lý (mục 4). Điểm 1 là **quyết định nghiệp vụ đang bỏ ngỏ**: nếu chủ shop muốn giá
vốn của một đơn được *đóng băng* tại thời điểm giao hàng, đó là đổi phương pháp tính — phải quyết
riêng, và **không được lồng vào một lượt tăng tốc**.

## 3. Việc tăng tốc đổi gì và KHÔNG đổi gì

| | |
| --- | --- |
| **Đổi** | *lúc nào* giá vốn được tính: trước đây tính lại trong mọi báo cáo, mỗi lần mở trang; nay tính một lần và lưu vào `canonical_order_outcome.cogs`. |
| **KHÔNG đổi** | thứ tự bốn nguồn ở mục 1, cách chọn "phiếu gần nhất", cách nhân số lượng, cách cộng dòng hàng, cách xử lý `0`. |

Bằng chứng: bộ vật chất hoá **dùng lại chính biểu thức `ORDER_COGS`** đã import — không chép công
thức. Hai bên khớp theo cấu trúc, không nhờ ai nhớ đồng bộ.

Nhánh dự phòng: `ORDER_COGS_FAST` = `coalesce(bảng, tính trực tiếp)`. Bảng trống, thiếu dòng, hay
mang phiên bản luật cũ ⇒ tự tính lại. **Chậm chứ không sai.**

## 4. Khi nào giá vốn đã lưu bị coi là cũ

`rematerializeStale()` nhặt đơn ra khi:

| Đầu vào đổi | Vì sao ảnh hưởng giá vốn |
| --- | --- |
| **Phiếu nhập kho mới / sửa giá phiếu** (`stock_receipts.updated_at`) | đổi "phiếu gần nhất" của mẫu mã ⇒ đổi giá vốn của mọi đơn có mẫu mã đó |
| **Dòng hàng của đơn đổi** (`orders.updated_at`) | số lượng, mẫu mã, hay giá vốn Pancake đổi |
| Đơn / vận đơn / sự kiện ĐVVC / dòng bảng kê đổi | (thuộc phần kết quả đơn) |
| `logic_version` khác phiên bản hiện tại | luật đã đổi |

Điểm đáng chú ý: một phiếu nhập ảnh hưởng **nhiều đơn lịch sử**, nên chiến lược làm cũ ở đây đi theo
**mẫu mã**, không theo đơn lẻ — và vẫn xác định, chạy lại được, có trần mỗi lượt.

## 5. Kiểm chứng

- `tests/canonical-outcome.test.ts`: **0 dòng lệch giá vốn** giữa bảng và biểu thức chuẩn.
- `scripts/outcome-parity.ts`: đối chiếu **toàn bộ dân số production**, kiểm cả kết quả đơn lẫn giá
  vốn; lệch một dòng là thoát mã lỗi và in dòng lệch để tìm nguyên nhân — **không** sửa dữ liệu cho
  khớp.
- `tests/metric-shape-consistency.test.ts`: sáu con số tiền của `getFinancialTruth` tính lại theo
  cách nội tuyến cũ, khớp 6/6.

## 6. ĐÃ CHỐT: giá vốn của kỳ đã ghi nhận không đổi nữa

Cột `canonical_order_outcome.recognized_cogs` ghi **một lần** lúc đơn được ghi nhận giao thành công,
rồi không đổi. Báo cáo lợi nhuận đã giao đọc cột đó; đơn chưa giao vẫn dùng giá vốn hiện tại và đó là
**ước tính**.

Bốn tình huống được khoá bằng kiểm thử (`tests/cogs-recognition.test.ts`):

| | |
| --- | --- |
| Đơn giao 10/08 giá 200.000, ngày 01/09 nhập lô 250.000 | giá vốn tháng 8 **vẫn 200.000** |
| Đơn chưa giao | giá vốn ghi nhận là **CHƯA CÓ** (`NULL`), không phải 0 |
| Dựng lại bảng nhiều lần | con số đã chốt **y nguyên** |
| Chạy lại báo cáo sau khi nhập hàng | lợi nhuận kỳ cũ **không đổi** |

## 6b. Điều đo được trên production, và vì sao KHÔNG dựng lại lịch sử

Quét toàn bộ 407 đơn đã giao:

```
MATCHED          39
DRIFTED         368      ← giá vốn hôm nay khác giá vốn lúc giao
UNVERIFIABLE    368      ← và cả 368 đơn đó đều KHÔNG có phiếu nhập tại thời điểm giao
TOTAL_COGS_NOW   64.509.000đ
TOTAL_COGS_THEN   6.460.000đ
DELTA            58.049.000đ
```

Điều tra tiếp: shop có **đúng 2 phiếu nhập**, cả hai ngày **03/09/2026**, nhập vào ERP 04/09 — trong
khi đơn giao sớm nhất từ **22/01/2026**. Và **0/2.495 dòng hàng** có giá vốn Pancake, **0/37 mẫu mã**
có giá nhập.

Nên đây **không phải** chuyện "giá đổi vì nhập lô mới". Đây là chuyện **toàn bộ giá vốn lịch sử đang
được suy ngược từ hai phiếu của tháng 9**.

**Vì thế cố ý KHÔNG dựng lại lịch sử theo "giá vốn tại ngày giao".** Làm vậy sẽ đưa 368 đơn về **0đ**
và thổi lợi nhuận lịch sử lên **58 triệu** — sai nặng hơn hiện tại, và sai theo hướng dễ chịu, đúng
kiểu sai nguy hiểm nhất.

Thay vào đó: **giữ nguyên con số hiện tại** (KPI không đổi) và **gắn nhãn** `RECEIPT_AFTER`, kèm luật
đối soát `COGS_BASIS_UNVERIFIED` hiện trong Trung tâm điều khiển. Chủ shop nhìn thấy đúng phần lợi
nhuận đang dựa trên phỏng đoán, thay vì tin nhầm là đã kiểm chứng.

Cách sửa thật, nếu muốn: **nhập phiếu nhập cũ với ngày nhập THẬT**. Có chứng từ thì căn cứ tự chuyển
sang `RECEIPT_BEFORE`, không cần đụng mã.

## 6c. Bản P0.4 đã lên production nhưng KHÔNG chạy suốt một ngày

Ghi lại vì đây là loại hỏng khó thấy nhất: mã đúng, kiểm thử xanh, deploy xanh — và tính năng vẫn
không hoạt động.

Truy vấn thẳng vào bảng ngày 10/09/2026, sau khi P0.4 đã chạy trên production hơn một ngày:

```
can_cu            n     gia_von_da_chot   trong_do_da_giao
(chưa ghi nhận)   2433  (rỗng)            407
```

**Cả 2.433 dòng có `recognized_cogs` và `cogs_basis` đều NULL, gồm cả 407 đơn đã giao.** Đường đọc
`coalesce(recognized_cogs, cogs)` vì thế luôn rơi về `cogs` — giá vốn HIỆN TẠI. Một phiếu nhập mới
vẫn viết lại được lợi nhuận kỳ đã qua, đúng thứ P0.4 sinh ra để chặn.

### Ba lớp lẽ ra phải bắt được, cả ba đều im

1. **Bộ dò dòng cũ** nhận biết qua `logic_version`, mà P0.4 cố ý KHÔNG tăng phiên bản — tăng thì cả
   2.433 đơn thành cũ cùng lúc và trang chủ quay lại mức 60 giây ngay sau deploy. Quyết định đó đúng,
   nhưng thiếu bước thay thế: một điều kiện làm cũ riêng cho cột mới.
2. **`outcome-parity --apply`** gọi đúng bộ dò đó, nên nó báo "dựng lại 0 đơn" và không điền gì.
3. **Báo cáo độ phủ** chỉ đối chiếu `outcome` và `cogs`, nên in `MATCHED 2433 · MISMATCHED 0 ·
   FALLBACK_RATE 0%` — xanh hoàn toàn — trong khi ba cột mới rỗng sạch.

> **Bài học:** một cột được THÊM VÀO mà không ai đối chiếu thì im lặng rỗng, và mọi báo cáo độ phủ
> vẫn xanh. Độ phủ phải đo cả cột mới, không chỉ cột cũ.

### Đã vá và đã kiểm chứng

- Điều kiện làm cũ mới: đơn `DELIVERED` mà `recognized_cogs` còn NULL. Tự tắt sau một lượt.
- `outcome-parity` nay in và **thoát mã lỗi** khi `COGS_NOT_FROZEN > 0`.
- Ghi vào `lib/constants/canonical-outcome.ts`: thêm cột mà luật không đổi thì giữ nguyên phiên bản
  và thêm điều kiện làm cũ riêng — đừng mặc định tăng phiên bản, và cũng đừng quên bước thay thế.

Đo lại sau khi vá:

```
lượt 1: dựng lại 580 đơn · còn 0
DELIVERED           407
COGS_FROZEN         407
COGS_NOT_FROZEN       0
BASIS_MISSING         0
BASIS_RECEIPT_AFTER 368
```

KPI trước / sau: **không đổi một con số nào** (2.433 đơn · 407 giao thành công · GTC 32,4% · doanh
thu lên đơn 1.069.391.498đ · thực nhận có chứng từ 212.052.000đ).

## 7. Việc còn bỏ ngỏ (cần chủ shop quyết, không phải việc kỹ thuật)

1. ~~Giá vốn có nên đóng băng tại thời điểm giao hàng không?~~ **ĐÃ CHỐT: có** — xem mục 6.
2. ~~Đơn không tra được giá vốn đang tính 0.~~ **ĐÃ CHỐT 11/09/2026** — xem mục 8.

## 8. ĐÃ CHỐT 11/09/2026: tạm tính khi chưa có phiếu, chốt lại ĐÚNG MỘT LẦN, rồi đóng băng

Chủ shop quyết ba điều, và `rematerializeOutcomes()` (`lib/queries/canonical-outcome.ts`) là nơi
duy nhất thực hiện chúng:

1. **Đơn đã giao không được giữ giá vốn 0 chỉ vì phiếu nhập đến sau.** Chưa có phiếu tại thời điểm
   giao thì dùng giá vốn **tạm tính có thể bảo vệ được**, theo thứ tự mạnh → yếu.
2. **Khi xuất hiện chứng từ kho mạnh hơn, chốt lại đúng MỘT lần, có nhật ký, rồi đóng băng hẳn.**
3. **Chỉ là 0 khi thực sự miễn phí.** Dữ liệu hiện không có cách khai "miễn phí", nên 0 không bao
   giờ tự sinh: không có nguồn nào ⇒ `recognized_cogs = NULL` (CHƯA BIẾT).

### Căn cứ và độ mạnh (`cogs_basis`)

| Hạng | `cogs_basis` | Nguồn của từng dòng hàng | Chất lượng hiện ra |
| --- | --- | --- | --- |
| 3 | `RECEIPT_BEFORE` | phiếu nhập gần nhất **trước hoặc đúng** ngày giao | Có chứng từ |
| 2 | `RECEIPT_AFTER` | phiếu nhập **sớm nhất sau** ngày giao (gần ngày giao nhất) | Tạm tính / suy ngược |
| 1 | `PROVISIONAL` | giá vốn Pancake trên dòng hàng → giá nhập lưu ở mẫu mã (≠ 0) | Tạm tính / suy ngược |
| 0 | `NONE` | không có gì ⇒ `recognized_cogs = NULL` | Chưa xác minh |

Căn cứ của **cả đơn** là hạng **yếu nhất** trong các dòng hàng (một món có phiếu, một món chỉ có giá
Pancake ⇒ cả đơn là `PROVISIONAL`). Khác `ORDER_COGS` (cột `cogs`, ước tính "sống" theo phiếu gần
nhất tính tới hôm nay): giá vốn ghi nhận ưu tiên phiếu **trước ngày giao**, nên nhập lô mới sau này
không làm số đã ghi nhận trôi.

### Luật chốt lại (`trued_up_at`, `trued_up_from`, `trued_up_from_basis`)

Chốt lại xảy ra khi **cả bốn** điều đúng, và chỉ xảy ra **một lần** cho mỗi dòng:

- chưa từng chốt lại (`trued_up_at IS NULL`);
- dòng **đã từng được ghi nhận** (`cogs_basis` khác NULL) — lần ghi nhận đầu tiên không phải chốt lại;
- căn cứ mới là **chứng từ kho** (hạng ≥ 2);
- căn cứ mới **mạnh hơn** căn cứ đang chốt.

Mỗi lần chốt lại ghi một dòng `audit_logs` (`COGS_TRUE_UP`, entity `ORDER`) với `before/after`, và
hiện ở dòng thời gian của đơn. Sau đó **không đổi nữa**, kể cả khi sau này có chứng từ còn mạnh hơn.

Hệ quả cần nhớ:

| Tình huống | Kết quả |
| --- | --- |
| Đơn giao, không nguồn nào; tháng sau nhập phiếu | NULL → giá phiếu (`RECEIPT_AFTER`), 1 nhật ký; sau đó đóng băng |
| Đơn giao với giá Pancake 90K; sau đó nhập phiếu ngày cũ 100K | 90K → 100K (`RECEIPT_BEFORE`), 1 nhật ký; phiếu 110K sau đó **không** đổi |
| Đơn đang suy ngược từ lô tháng 8; nhập thêm lô tháng 10 | cùng hạng ⇒ **không** chốt lại, không tiêu quyền |
| Đơn chưa giao | vẫn NULL, không căn cứ |

`NONE` là **kết luận**, không phải việc dở: bộ dò dòng cũ nhìn `cogs_basis IS NULL`, không nhìn con
số, nên đơn CHƯA BIẾT không bị dựng lại vô hạn. Báo cáo vẫn đọc `coalesce(recognized_cogs, cogs)`
⇒ nhóm CHƯA BIẾT hiện 0 và **được nêu** (`missingCogsOrders`, luật `COGS_BASIS_UNVERIFIED` nay gồm
cả `PROVISIONAL` và `NONE`).

Migration `0059_cogs_true_up`: thêm ba cột, mở rộng ràng buộc `cogs_basis`, và đưa
`recognized_cogs = 0` của dòng `NONE` về NULL (tổng báo cáo không đổi vì đường đọc rơi về `cogs`).
Kiểm thử: `tests/cogs-recognition.test.ts` khối "QUYẾT ĐỊNH CHỦ SHOP 11/09/2026".

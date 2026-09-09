# Hợp đồng phân bổ chi phí — Báo cáo lợi nhuận

## Vấn đề gốc

Báo cáo lợi nhuận lọc **doanh thu** theo khoảng ngày người dùng chọn, nhưng **chi phí** thì cộng
NGUYÊN khoản nếu `occurred_at` rơi vào khoảng đó:

```sql
sum(expenses.amount) WHERE occurred_at BETWEEN from AND to   -- SAI
```

Tiền thuê mặt bằng 2.000.000đ/tháng ghi ngày 01/09:

| Khoảng xem | Trước | Đúng phải là |
|---|---|---|
| 01/09 – 30/09 | 2.000.000đ | 2.000.000đ |
| **01/09 – 07/09** | **2.000.000đ** ❌ | **466.667đ** |
| **08/09 – 14/09** | **0đ** ❌ | **466.666đ** |

Doanh thu 7 ngày trừ chi phí cả tháng — lợi nhuận tuần thành vô nghĩa.

## Nguyên tắc

**Mọi thành phần của báo cáo lợi nhuận phải dùng CÙNG một khoảng thời gian.**

Và: **không phân bổ đều mọi khoản.** Bản chất từng loại chi phí khác nhau — đoán bừa một phương
pháp cho tất cả cũng sai như cộng nguyên khoản.

## Bốn phương pháp phân bổ

| Phương pháp | Khi nào | Cách tính |
|---|---|---|
| **`EVENT_DATE`** | chi phí phát sinh một lần: sửa chữa, phí lẻ, khoản nhập tay | ghi **trọn** vào ngày phát sinh; báo cáo không chứa ngày đó ⇒ **0** |
| **`PERIOD_PRORATA`** | khoản có kỳ hiệu lực: thuê mặt bằng, phần mềm thuê bao, máy chủ, lương cố định | chia theo **số ngày chồng lấn** giữa khoảng báo cáo và kỳ hiệu lực |
| **`ORDER_ATTRIBUTED`** | cước, phí hoàn, giá vốn | ghi theo mốc của **chính đơn đó**, KHÔNG chia theo tháng |
| **`ACTUAL_DATED_SPEND`** | chi phí quảng cáo (có số thực chi từng ngày) | cộng đúng số ngày trong khoảng, KHÔNG chia đều từ tổng tháng |

## Công thức `PERIOD_PRORATA`

Tính bằng **hiệu của hai số luỹ kế**, không nhân trực tiếp phân số:

```
phân bổ(từ, đến) = luỹ_kế(đến) − luỹ_kế(từ − 1 ngày)

luỹ_kế(d) = 0                              nếu d trước đầu kỳ
          = trọn khoản                      nếu d từ cuối kỳ trở đi
          = round(khoản × số_ngày(đầu_kỳ..d) ÷ tổng_ngày_kỳ)
```

**Vì sao không nhân phân số trực tiếp:** làm tròn từng khoảng riêng thì 7/30 + 23/30 có thể lệch
một đồng, và hai báo cáo liền nhau cộng lại không bằng tổng khoản. Hiệu hai số luỹ kế thì các phần
tự triệt tiêu — cộng 30 ngày lẻ vẫn đúng **chính xác** 2.000.000đ.

## Quy ước ngày

- Tính **cả hai đầu** (inclusive): 01/09 → 07/09 là **7 ngày**.
- Phần NGÀY lấy theo **lịch Việt Nam**, không phải UTC. `2026-09-01T00:00+07:00` chính là
  `2026-08-31T17:00Z`; đọc theo UTC sẽ ra 31/08 và tháng 9 hoá thành 31 ngày — kiểm thử bắt được
  đúng lỗi này khi viết bản đầu.
- Độ dài tháng 28/29/30/31 ngày đều đúng vì đếm ngày thật, không dùng hằng số.

## Một chỗ tính duy nhất

| | |
|---|---|
| TypeScript | `lib/constants/cost-allocation.ts::allocateExpenseToRange` |
| SQL | `lib/queries/cost-allocation.ts::allocatedExpenseAmount` / `expenseInRange` |

Hai bản **bắt buộc cho cùng con số**; `tests/cost-allocation.test.ts` khoá điều đó bằng cách chạy
song song cả hai trên cùng dữ liệu.

Dùng chung bởi: `lib/queries/profit-nominal.ts` (lợi nhuận danh nghĩa) và `lib/queries/profit-cash.ts`
(dòng tiền thực). Hai trang **không được** tự tính khác nhau.

## Điều kiện lọc cũng phải đổi

Không chỉ phép cộng — **điều kiện lọc** cũng sai ở bản cũ. Khoản theo kỳ phải lọt vào báo cáo khi
**kỳ có chồng lấn**, không phải khi `occurred_at` nằm trong khoảng:

```
khoản một lần  → occurred_at trong khoảng
khoản theo kỳ  → period_start ≤ đến  AND  period_end ≥ từ
```

Thiếu bước này thì khoản thuê ghi ngày 01/09 biến mất khỏi mọi tuần trừ tuần đầu.

## Schema

`expenses` được bổ sung (migration `0036`, không phá dữ liệu cũ):

| Cột | Ý nghĩa |
|---|---|
| `period_start` / `period_end` | kỳ hiệu lực, chỉ dùng với `PERIOD_PRORATA` |
| `allocation_method` | mặc định `EVENT_DATE` — **mọi dòng cũ giữ nguyên hành vi** |
| `needs_allocation_review` | khoản theo kỳ chưa khai kỳ, cần chủ shop điền |

Hai ràng buộc `CHECK`: phương pháp phải nằm trong danh sách, và `PERIOD_PRORATA` **bắt buộc** có kỳ
hợp lệ (`period_end >= period_start`).

## Khoản cũ: đánh dấu, KHÔNG đoán kỳ

Các khoản thuộc nhóm **thuê mặt bằng / lương / phần mềm** mà chưa khai kỳ được đánh dấu
`needs_allocation_review = true`. **Không tự suy ra kỳ** — đoán kỳ là bịa chứng từ, và một khoản
phần mềm có thể là tháng, quý hay năm.

Hệ quả: con số lịch sử của các khoản đó **không bị viết lại lặng lẽ**. Chúng vẫn tính theo
`EVENT_DATE` cho tới khi chủ shop khai kỳ thật.

Trên production hiện có **5 khoản `SOFTWARE`** (9.270.000đ) thuộc diện này. Không có khoản `RENT`
hay `SALARY` nào.

## Chi phí cố định từ giả định — vốn đã đúng

`fixedCostMonthly` trong bộ giả định lợi nhuận **đã** chia theo kỳ sẵn qua `periodMonths()`
(số ngày ÷ 30,44). Không đụng tới, chỉ ghi lại ở đây để không ai "sửa" nhầm lần nữa.

## Hai tỷ lệ quảng cáo

| Chỉ số | Công thức | Mẫu số |
|---|---|---|
| **QC / Doanh số POS** | chi quảng cáo ÷ doanh số POS × 100% | `salesAfterDiscount` — doanh số **đã chốt** trên Pancake |
| **QC / DT giao thành công** | chi quảng cáo ÷ doanh thu giao thành công × 100% | `actualRevenue` — doanh thu theo `ORDER_OUTCOME` |

Cả hai dùng **đúng khoảng báo cáo đang chọn**. Mẫu số ≠ nhau và **không được thay thế cho nhau**:
doanh số POS là tiền đã lên đơn, doanh thu giao thành công là tiền thực sự tới tay khách.

**Mẫu số bằng 0 ⇒ trả `null`**, màn hình hiện "—", không bao giờ hiện vô cực.

## Kiểm thử bắt buộc

`tests/cost-allocation.test.ts` khoá:

1. cả tháng ⇒ trọn khoản;
2. tuần 01–07 ⇒ 7/30, và **phải nhỏ hơn 500.000đ** (chặn hồi quy "cộng nguyên tháng");
3. tuần 08–14 ⇒ 7 ngày;
4. hai khoảng liền nhau cộng lại = **đúng** trọn khoản; cộng cả 30 ngày lẻ vẫn đúng;
5. kỳ vắt qua hai tháng ⇒ mỗi tháng chỉ nhận phần chồng lấn, cộng lại đúng tổng;
6. khoản một lần chỉ xuất hiện ở đúng kỳ chứa ngày phát sinh;
9. tháng Hai năm nhuận 29 ngày, năm thường 28 ngày;
+ bản SQL cho **cùng** con số với bản TypeScript ở mọi ca trên;
+ khoản theo kỳ **vẫn lọt** vào tuần cuối tháng dù ghi ngày 01/09.

---

# Phần 2 — Phân bổ chi phí SUY RA TỪ GIẢ ĐỊNH (bổ sung 09/09/2026)

Phần 1 ở trên chỉ giải quyết **khoản chi có chứng từ** trong bảng `expenses`. Báo cáo lợi nhuận còn
có những chi phí **ước tính** suy ra từ bộ giả định, và chúng có đúng cùng một loại bug — chỉ khác
trục.

## Căn cứ phân bổ (cost driver) của từng khoản

Mỗi chi phí phải khai rõ **đi theo cái gì** trước khi nhân. Không khai driver thì sớm muộn cũng có
người nhân nhầm cơ sở.

| Chi phí | Driver | Cơ sở nhân |
|---|---|---|
| Chi phí vận hành đã nhập (bảng Chi phí) | `TIME` → rồi chia theo doanh số | phân bổ theo kỳ (Phần 1), sau đó chia cho các mã theo tỷ trọng doanh số POS |
| Chi phí cố định / tháng (giả định) | `TIME` | `fixedCostMonthly × số tháng của kỳ` |
| Đóng hàng, nhân viên vận đơn | `PER_ORDER` | số đơn gửi đi của chính mã |
| **Dự phòng rủi ro tồn kho** | **`PER_UNIT_SOLD`** | **giá vốn hàng BÁN RA trong kỳ** |
| Dự trù thuế | `PCT_REVENUE` | DT giao thành công ước tính |
| Chi phí khác (phí thẻ ngoại tệ) | `PCT_ADS` | chi phí quảng cáo |
| Giá vốn, cước, phí hoàn | `DIRECT` | gắn thẳng vào đơn / vận đơn |

## Bug rủi ro tồn kho (chủ shop nêu 09/09/2026)

Bản cũ: `rủi ro = % × giá trị hàng NHẬP trong kỳ`.

Mã Q002 nhập 200.000.000đ, dự phòng 10% = 20.000.000đ. Xem báo cáo **một tuần**, tuần đó chỉ bán
100/1.000 đơn của lô:

| Khoảng xem | Bản cũ | Đúng phải là |
|---|---|---|
| Cả vòng đời lô (bán hết 1.000 đơn) | 20.000.000đ | 20.000.000đ |
| **Tuần bán 100/1.000 đơn** | **20.000.000đ** ❌ | **2.000.000đ** |
| **Tuần sau, không nhập gì** | **0đ** ❌ | **2.000.000đ** |

Cùng một mã, cùng một tốc độ bán, hai tuần liền nhau cho hai kết luận trái ngược: tuần nhập hàng thì
mã "lỗ nặng, cần dừng", tuần sau thì "lãi tốt, cần đẩy mạnh". **Báo cáo sai thì quyết định sai.**

Đây là **đúng hình dạng bug tiền thuê mặt bằng** ở Phần 1, chỉ khác trục: ở đó một sự kiện *ghi sổ*
bị ném trọn vào kỳ chứa nó; ở đây một sự kiện *nhập kho* bị ném trọn vào kỳ chứa nó.

## Nguyên tắc

**Dự phòng rủi ro là dự phòng TRÊN HÀNG, được giải phóng vào lãi lỗ THEO HÀNG RA KHỎI KHO** — giống
hệt giá vốn.

```
rủi ro ghi vào kỳ = % × giá vốn hàng bán ra trong kỳ
```

**Tỷ lệ giữ nguyên ý nghĩa chủ shop đã chốt** (10% giá trị lô hàng cuối cùng sẽ mất vì lỗi / xả /
thất thoát). Chỉ đổi **thời điểm ghi nhận**: bán hết lô thì Σ mọi kỳ = `% × giá vốn cả lô` = **đúng
bằng con số cũ**. Tổng vòng đời không đổi, chỉ hết nhảy bậc theo ngày nhập hàng.

## Phần rủi ro CÒN TREO phải lộ ra

Chuyển sang ghi theo hàng bán mà không hiện phần còn lại thì rủi ro **hàng ế** biến mất khỏi màn
hình — và báo cáo lại sai theo hướng ngược lại: **lạc quan giả**.

```
rủi ro còn treo = % × giá trị hàng CÒN TRONG KHO
```

Con số này là **memo**, **KHÔNG trừ** vào lợi nhuận kỳ. Nó dùng đúng định nghĩa tồn của Sổ kho
(`lib/queries/stock.ts`), và **bỏ hẳn** mẫu mã chưa có phiếu nhập nào: ở đó "nhập = 0" là *thiếu dữ
liệu*, không phải *nhập 0 cái*.

Dự phòng là **ước tính**. Hàng hỏng / xả lỗ **thực tế** phải vào sổ bằng phiếu kho `ADJUSTMENT` +
khoản chi thật — không được để dự phòng đứng thay chứng từ.

## Hai bảng, hai cơ sở, mỗi bảng nhất quán với chính nó

| Bảng | Trừ tiền hàng bằng | ⇒ Trừ rủi ro bằng |
|---|---|---|
| Lợi nhuận danh nghĩa (bảng chính) | giá vốn hàng bán ra | `inventoryRisk` = % × giá vốn hàng bán |
| Lợi nhuận theo tổng giá trị hàng nhập | **trọn** giá trị hàng nhập trong kỳ | `inventoryRiskOnPurchase` = % × giá trị hàng nhập |

Bảng thứ hai **cố ý** giữ cơ sở cũ: nó đã trừ trọn giá trị lô thì phải trừ trọn phần rủi ro đi kèm.
Dùng lẫn hai cơ sở giữa hai bảng mới là sai.

## Chia một tổng cho nhiều mã: Σ phải BẰNG ĐÚNG tổng

`Math.round(total × w / W)` từng dòng là cách ai cũng viết, và Σ các dòng gần như không bao giờ bằng
`total`. Bảng chi tiết cộng lại không khớp dòng tổng ⇒ chủ shop mất niềm tin vào cả báo cáo.

`distributeProportionally()` dùng **largest remainder**: phần nguyên trước, phần dư phát cho các dòng
có phần lẻ lớn nhất. Σ **chắc chắn** = total. Dùng cho: CP vận hành đã nhập, CP cố định (cả ở báo cáo
lợi nhuận lẫn ở bảng lương).

## Cảnh báo đếm hai lần chi phí cố định

Giả định `fixedCostMonthly` và các khoản `RENT` / `SALARY` / `SOFTWARE` nhập ở bảng Chi phí là **hai
nguồn cho cùng một loại chi phí**. Khai cả hai ⇒ mặt bằng bị trừ hai lần ⇒ lợi nhuận thấp giả.

ERP **không tự bỏ bên nào** — chọn nguồn nào là quyết định của chủ shop. Khi phát hiện chồng lấn,
trang Báo cáo lợi nhuận hiện banner cảnh báo kèm số tiền của cả hai nguồn (`fixedCostOverlap`).

## MỘT con số chi phí vận hành cho MỌI màn hình

Bộ máy phân bổ ở Phần 1 ban đầu chỉ được áp cho **hai** file. Năm nơi khác vẫn tự cộng
`sum(expenses.amount) WHERE occurred_at BETWEEN …`, nên cùng một chỉ số "chi phí vận hành trong kỳ"
cho tới bốn con số khác nhau — và bảng **lương / hoa hồng marketer** nằm trong số đó.

Đã chuyển sang bộ máy chung:

| File | Màn hình |
|---|---|
| `lib/queries/profit-nominal.ts` | Báo cáo lợi nhuận (danh nghĩa) |
| `lib/queries/profit-cash.ts` | Dòng tiền thực |
| `lib/queries/payroll.ts` | **Lương & hoa hồng marketer** |
| `lib/queries/dashboard.ts` | Bảng điều khiển |
| `lib/queries/financial-truth.ts` | Sự thật tài chính |
| `lib/queries/reports.ts` | Báo cáo tổng hợp + **biểu đồ theo ngày** |

Cố ý **giữ nguyên** cách cộng thô ở hai chỗ:

- `lib/queries/cashflow.ts` — nhịp chi 60 ngày là **tiền mặt thực chi**, tiền ra khi trả thì đúng là
  ngày trả, không chia theo kỳ hiệu lực.
- `lib/queries/expenses.ts::listExpenses` — trang Chi phí là **sổ chi**, tổng phải cộng đúng bằng các
  dòng đang liệt kê. Thẻ tổng hiện thêm số **"phân bổ vào kỳ"** để chủ shop thấy con số mà các báo
  cáo dùng, thay vì tự hỏi vì sao hai trang lệch nhau.

### Biểu đồ theo ngày

`allocatedExpenseByDay()` rải khoản theo kỳ ra từng ngày. Trước đây tiền thuê cả tháng dựng thành
**một cột duy nhất** ở ngày ghi sổ, mọi ngày khác chi phí bằng 0 — nhìn biểu đồ đó sẽ kết luận
"ngày 01 lỗ nặng, các ngày sau lãi đều", cả hai đều sai.

## Kiểm thử bắt buộc (bổ sung)

`tests/cost-allocation.test.ts`:

- tuần bán 1/10 lô chỉ gánh **1/10** dự phòng, và **phải nhỏ hơn 1/5** dự phòng cả lô (chặn hồi quy);
- cộng dự phòng của cả 10 tuần bán hết lô = **đúng** dự phòng cả lô (đổi thời điểm, không đổi tổng);
- kỳ không bán được gì ⇒ dự phòng ghi vào kỳ = **0**;
- giá vốn âm ⇒ 0, tỷ lệ bị kẹp trong [0, 100];
- `distributeProportionally`: chia cho 7 mã và cho 313 mã đều cộng lại **đúng** tổng — kèm assertion
  chứng minh cách làm tròn từng dòng kiểu cũ **không** khớp;
- rải theo ngày: mọi ngày trong kỳ thuê đều có chi phí, hai ngày bất kỳ chênh nhau ≤ 1đ, cộng 30 ngày
  = đúng tổng đã phân bổ;
- **ranh giới ở mức mã nguồn**: sáu file báo cáo không được chứa `sum(expenses.amount)` và bắt buộc
  phải dùng `allocatedExpenseSum` / `allocatedExpenseByDay`. Bug này đã bị sửa một lần rồi tái sinh ở
  năm trang khác vì mỗi trang tự chép lại phép cộng thô — lời hứa trong tài liệu không chặn được ai.

`tests/consistency.test.ts` (khối 8): cùng một kỳ, chi phí vận hành phải **bằng nhau** ở Bảng điều
khiển · Sự thật tài chính · Báo cáo lợi nhuận · Dòng tiền, và số của **một tuần phải nhỏ hơn** số của
cả tháng.

`tests/sync-fixtures.test.ts` (khối 8): `inventoryRisk` phải bằng `% × expectedCogs`; mã có nhập hàng
mà chưa bán được gì phải có `inventoryRisk = 0` nhưng `inventoryRiskOnPurchase > 0`; Σ phần phân bổ
CP vận hành / CP cố định của các mã phải **bằng đúng** tổng của kỳ.

---

# Phần 3 — Hợp đồng đầy đủ theo từng loại chi phí (chốt 09/09/2026)

## Bảy cách ghi nhận

Bốn giá trị đầu lưu được ở `expenses.allocation_method` (có ràng buộc `CHECK`); ba giá trị sau mô tả
chi phí **không** nằm ở bảng Chi phí. Khai ở `lib/constants/cost-allocation.ts::RECOGNITION_METHODS`.

| Phương pháp | Trường ngày | Lưu ở CSDL | Dùng cho |
|---|---|---|---|
| `EVENT_DATE` | `expenses.occurred_at` | ✓ | chi phí một lần |
| `PERIOD_PRORATA` | `expenses.period_start … period_end` | ✓ | thuê mặt bằng, phần mềm, **lương cố định** |
| `DAILY_RATE` | khoảng của báo cáo | — | giả định `fixedCostMonthly` × số tháng |
| `ORDER_ATTRIBUTED` | `orders.inserted_at` | ✓ | đóng hàng, NV vận đơn, **hoa hồng theo đơn** |
| `SHIPMENT_ATTRIBUTED` | mốc kết thúc của chính vận đơn | — | cước gửi, phí hoàn |
| `ACTUAL_DATED_SPEND` | `ad_spends.spend_date` | ✓ | chi phí quảng cáo |
| `INVENTORY_RISK_BY_COGS` | kỳ bán hàng (giá vốn hàng bán) | — | dự phòng rủi ro tồn kho |

## Hợp đồng từng loại chi phí

| Chi phí | Nguồn sự thật | Cách ghi nhận | Trường ngày | Chiều gắn | Chính sách trùng nguồn |
|---|---|---|---|---|---|
| Giá vốn hàng bán | phiếu kho | `ORDER_ATTRIBUTED` | `orders.inserted_at` | đơn → mẫu mã | khoản `PURCHASE` gõ tay **bị loại** khỏi CP vận hành |
| Dự phòng rủi ro tồn kho | giả định × giá vốn bán | `INVENTORY_RISK_BY_COGS` | kỳ bán hàng | mã hàng | phần chưa bán hiện riêng, **không** trừ |
| Cước vận chuyển | vận đơn / bảng kê ĐVVC | `SHIPMENT_ATTRIBUTED` | mốc vận đơn | đơn | khoản `SHIPPING` gõ tay **bị loại** |
| Phí hoàn | vận đơn / bảng kê ĐVVC | `SHIPMENT_ATTRIBUTED` | mốc vận đơn | đơn | khoản `RETURN_FEE` gõ tay **bị loại** |
| Quảng cáo | tài khoản QC (`ad_spends`) | `ACTUAL_DATED_SPEND` | `spend_date` | mã hàng / marketer | khoản `ADS` gõ tay **bị loại** |
| **Lương cố định** | bảng Chi phí | `PERIOD_PRORATA` | kỳ hiệu lực | toàn shop → mã theo doanh số | trùng với giả định cố định ⇒ cảnh báo |
| **Hoa hồng** | bảng Chi phí | `ORDER_ATTRIBUTED` | ngày phát sinh | marketer / mã | **không** prorate theo ngày |
| Mặt bằng · điện nước | bảng Chi phí | `PERIOD_PRORATA` | kỳ hiệu lực | toàn shop | trùng với giả định cố định ⇒ cảnh báo |
| Phần mềm | bảng Chi phí | `PERIOD_PRORATA` | kỳ hiệu lực | toàn shop | gói năm phải khai kỳ 12 tháng |
| Đóng gói | bảng Chi phí | `EVENT_DATE` / `ORDER_ATTRIBUTED` | `occurred_at` | đơn | trùng với giả định đóng hàng/đơn ⇒ cảnh báo |
| Chi phí vận hành khác | bảng Chi phí | `EVENT_DATE` | `occurred_at` | toàn shop | — |

`lib/constants/cost-sources.ts::COST_AUTHORITY` là bản mã hoá của cột "Nguồn sự thật";
`EXPENSE_CATEGORIES_NOT_OWNED` là bản mã hoá của cột "bị loại".

## Lương ≠ hoa hồng

Gộp hai thứ này thành một dòng "Lương & hoa hồng" là sai từ gốc, vì **bản chất phân bổ ngược nhau**:

- **Lương cố định** đi theo THỜI GIAN. 9 triệu/tháng, lọc 7/30 ngày ⇒ `9tr × 7/30 = 2,1tr`.
- **Hoa hồng** đi theo ĐƠN. Ghi vào đúng kỳ phát sinh đơn; chia đều theo ngày là **bịa**, vì một
  tuần bán gấp ba tuần khác thì hoa hồng cũng gấp ba, không bằng nhau.

ERP **không tự đổi** basis POS ↔ Delivered của hoa hồng: hợp đồng hiện tại chọn basis nào thì giữ
nguyên basis đó. Điều duy nhất được đảm bảo là **cùng một kỳ báo cáo ⇒ cùng một tập đơn ⇒ cùng một
con số hoa hồng**.

Bảng Chi phí hiện chỉ có MỘT nhóm `SALARY` gộp cả hai. Khi không phân biệt được, ERP **không đoán** —
nó nêu ra bằng luật `COMMISSION_BASIS_NEEDS_REVIEW`. Dữ liệu mới đi qua Sổ ngân hàng thì đã tách sẵn
hai nhóm `PAYROLL_SALARY` và `PAYROLL_COMMISSION`.

## Vì sao lương thuộc `EXPENSES` chứ không phải `PAYROLL`

Module Lương **tính ra** số phải trả nhưng KHÔNG ghi khoản chi nào vào lợi nhuận — nó đọc lợi nhuận
từ báo cáo để chia. Đường duy nhất đưa tiền lương vào lãi lỗ hôm nay là khoản `SALARY` ở bảng Chi phí.

Đặt thẩm quyền cho `PAYROLL` rồi loại `SALARY` khỏi bảng Chi phí sẽ làm **lương biến mất khỏi lợi
nhuận** — sai nặng hơn hẳn cái nó định sửa. Khi module Lương thực sự ghi khoản chi thì đổi
`COST_AUTHORITY.SALARY` cùng lúc với việc loại `SALARY` ra.

## Luật chất lượng dữ liệu chi phí

`lib/queries/cost-quality.ts`, hiện ngay trên Báo cáo lợi nhuận (không giấu ở trang khác — người
đang nhìn con số chính là người cần biết nó có vấn đề gì):

| Luật | Khi nào bật | ERP làm gì |
|---|---|---|
| `DUPLICATE_COST_SOURCE` | giả định đang bật **và** có chứng từ cùng loại trong kỳ | cảnh báo, **không** tự bỏ bên nào |
| `EXCLUDED_BY_AUTHORITY` | có khoản gõ tay thuộc nhóm nguồn khác sở hữu | nói rõ khoản đó không vào lợi nhuận và vì sao |
| `COMMISSION_BASIS_NEEDS_REVIEW` | khoản `SALARY` để `EVENT_DATE`, không khai kỳ | yêu cầu chủ shop phân định, **không đoán** |
| `PERIOD_COST_WITHOUT_PERIOD` | `needs_allocation_review = true` | yêu cầu khai kỳ hiệu lực |

Không luật nào xoá hay sửa dữ liệu.

## Sổ ngân hàng — tiền thật, và ranh giới với lợi nhuận

`bank_transactions` ghi **mọi** giao dịch của tài khoản, kể cả tiền vào và các khoản không ảnh hưởng
lãi lỗ, để sổ khớp số dư ngân hàng. Mỗi dòng được gán một **nhóm kế toán**
(`lib/constants/bank.ts::BANK_GROUP_SPEC`) và chính nhóm đó — không phải dấu của số tiền — quyết
định giao dịch đi vào báo cáo nào.

Chỉ nhóm mà **bảng Chi phí có thẩm quyền** mới đẩy được sang lợi nhuận. Quảng cáo, tiền hàng, cước,
phí hoàn, doanh thu đều bị chặn ở tầng hợp đồng, kèm câu trả lời hiện thẳng trên giao diện. Chống
đẩy trùng bằng mã tham chiếu `MB <mã GD>`.

Ba thứ dễ sai nhất, đều có kiểm thử (`tests/bank-ledger.test.ts`):

1. **Giờ** — sao kê ghi giờ Việt Nam; đọc như UTC thì giao dịch 23:30 ngày cuối tháng nhảy sang kỳ sau.
2. **Nhập lại chồng lấn** — khoá tự nhiên là mã giao dịch ngân hàng; tải lại không nhân đôi dòng tiền
   và **không xoá nhãn** người dùng đã gán.
3. **Chuyển nội bộ / trả nợ gốc** — tiền ra thật nhưng không phải dòng tiền kinh doanh, phải loại
   khỏi tổng, nếu không cùng một đồng vừa là tiền ra vừa là tiền vào.

## Kiểm thử liên module (fixture chuẩn của hợp đồng)

`tests/consistency.test.ts` khối 8 dựng đúng fixture trong yêu cầu — thuê **3.000.000đ**, tháng
**30 ngày** — rồi lọc **7 ngày** và bắt mọi nơi trả **700.000đ**:

| Module | Tháng | 7 ngày |
|---|---|---|
| Báo cáo lợi nhuận | 3.000.000 | 700.000 |
| Bảng điều khiển | 3.000.000 | 700.000 |
| Sự thật tài chính | 3.000.000 | 700.000 |
| Dòng tiền thực | 3.000.000 | — |
| Báo cáo tổng hợp | 3.000.000 | 700.000 |
| Biểu đồ theo ngày (cộng các cột) | 3.000.000 | 700.000 |
| Phân bổ xuống từng mã (Σ) | 3.000.000 | 700.000 |
| Bảng lương (nền chi phí) | — | 700.000 |

Thêm hai chốt chặn hồi quy: **không cột ngày nào** được vượt 200.000đ (chặn "ôm cả khoản thuê vào
một ngày"), và **cả 7 ngày** đều phải có chi phí.

---

# Phần 4 — Thẩm quyền chi phí, chuyển giao an toàn, ranh giới tiền ↔ chi phí (chốt 09/09/2026)

## Vấn đề của Phần 3

Phần 3 chốt "mỗi loại chi phí có đúng một nguồn". Nhưng chuyển thẩm quyền từ nguồn A sang nguồn B là
việc **nguy hiểm**: nếu B chưa thật sự cung cấp được số mà A đã bị loại, khoản đó thành **0**.

Và 0 nhìn giống một con số hợp lệ. Lương biến mất khỏi lợi nhuận **nguy hiểm hơn** lương bị trừ hai
lần: trừ hai lần thì lợi nhuận thấp bất thường (dễ nghi), mất hẳn thì lợi nhuận cao đẹp (không ai nghi).

## Sổ đăng ký thẩm quyền — `lib/constants/cost-authority.ts`

Mỗi thành phần chi phí khai đủ sáu điều:

| Trường | Ý nghĩa |
|---|---|
| `source` | nguồn có thẩm quyền |
| `recognitionMethod` | cách ghi nhận vào kỳ |
| `dateBasis` | trường ngày quyết định khoản thuộc kỳ nào |
| `fallback` | lùi về đâu khi nguồn chính chưa đủ |
| `duplicatePolicy` | làm gì với dữ liệu của nguồn khác |
| `coverageRequirement` | điều kiện để nguồn chính thật sự cầm quyền |

### Ba chính sách trùng nguồn — cố ý KHÔNG gộp làm một

| Chính sách | Nhóm | Cách xử lý |
|---|---|---|
| `EXCLUDE_OTHER_SOURCES` | `ADS`, `PURCHASE` | loại hẳn khoản gõ tay |
| `ALLOW_WITH_EVIDENCE` | `SHIPPING`, `RETURN_FEE` | chỉ nhận khoản khai `MANUAL_ADJUSTMENT` kèm lý do |
| `NONE` | mặt bằng, phần mềm, vận hành khác | không có nguồn cạnh tranh |

`ALLOW_WITH_EVIDENCE` ra đời vì **loại sạch cả nhóm là làm mất tiền thật**: đền bù kiện vỡ, phí ngoại
lệ, cước chuyến gom hàng không gắn được vận đơn nào đều là chi phí có thật. Nhận hết thì trừ hai lần;
loại hết thì mất tiền. Nên chỉ nhận khoản **nói được vì sao nó không nằm trong cước theo vận đơn** —
CSDL bắt buộc có lý do (`expenses_adjustment_reason_check`).

## Chuyển giao lương an toàn — `lib/queries/payroll-cost.ts`

`getRecognizedPayrollCost(period)` trả về: `fixedSalary`, `commission`, `totalPayrollCost`,
`recognitionPeriod`, `allocationBasis`, `coverage`, `reasons`.

```
nếu coverage == COMPLETE:
    lương ghi nhận = bảng Lương (lương cứng chia theo ngày)
    bỏ qua khoản "Lương" ở bảng Chi phí   + cảnh báo DUPLICATE_PAYROLL_EXPENSE_SOURCE
ngược lại:
    lương ghi nhận = khoản chi ở bảng Chi phí   (KHÔNG BAO GIỜ để thành 0)
    cảnh báo PAYROLL_COST_COVERAGE_INCOMPLETE   (không lùi im lặng)
```

Mặc định `mode = LEGACY_EXPENSES`: hành vi **không đổi** so với trước. Bật `PAYROLL` là quyết định
tường minh của chủ shop, và chỉ nên bật **sau khi** đã ngừng ghi lương vào bảng Chi phí.

### Lương cứng chia theo SỐ NGÀY THẬT của từng tháng

`prorateMonthlyAmount()`: 9.000.000đ/tháng, xem 7 ngày của tháng 30 ngày ⇒ **2.100.000đ**. Cộng đủ một
tháng luôn ra đúng khoản tháng. Tháng 2 có 28 ngày thì một ngày của tháng 2 đắt hơn một ngày của
tháng 4 — đúng như hợp đồng lao động tính theo tháng, không phải "tháng bình quân 30,44 ngày".

Hằng số 30,44 (`periodMonths`) vẫn dùng cho **chi phí cố định ước tính**, nơi không có hợp đồng nào để
bám vào. Hai chỗ khác nhau vì bản chất khác nhau, không phải vì quên đồng bộ.

### Vì sao hoa hồng CHƯA thể do bảng Lương ghi nhận

Cả bốn cơ sở tính hoa hồng của ERP đều là **% của LỢI NHUẬN**. Muốn coi hoa hồng là chi phí nằm trong
lợi nhuận thì phải biết lợi nhuận trước — mà lợi nhuận lại cần biết chi phí. **Vòng tròn.**

Hai lối thoát, cả hai đều là quyết định của chủ shop:

1. chốt một cơ sở **không** dẫn xuất từ lợi nhuận (vd % doanh thu thuần), hoặc
2. coi hoa hồng là **phân phối lợi nhuận** sau khi đã có lợi nhuận, không phải chi phí.

Trước khi chốt, ERP **không đoán**: hoa hồng giữ đường cũ và bật `COMMISSION_BASIS_NEEDS_REVIEW`.
Đây cũng là lý do `payroll-cost.ts` **không gọi** `getPayrollReport` — gọi vào là đệ quy vô hạn.

## Một đường duy nhất — `lib/queries/cost-engine.ts`

Sáu báo cáo (Lợi nhuận, Dòng tiền, Bảng điều khiển, Sự thật tài chính, Báo cáo tổng hợp, Bảng lương)
**không còn tự cộng chi phí**; tất cả gọi `getOperatingCost()` / `getRecognizedCosts()`.

Kiểm thử chặn ở mức mã nguồn: không file nào được chứa `sum(expenses.amount)` hay danh sách nhóm bị
loại gõ tay.

### Phạm vi — nói thẳng điều CHƯA làm

Engine là nguồn **duy nhất** cho khối vận hành theo kỳ. Các thành phần còn lại được engine đọc từ
**chứng từ thật** để mọi trang cùng nhìn một con số — nhưng Báo cáo lợi nhuận danh nghĩa vẫn **ước
tính** giá vốn và cước theo tỷ lệ giao thành công dự kiến. Hai con số đó khác nhau vì **ước tính khác
thực tế**, KHÔNG phải vì trừ hai lần. Hợp nhất hẳn hai cơ sở đó là việc riêng, **chưa làm**.

## Sổ ngân hàng: TIỀN không phải CHI PHÍ

Trước đây có nút "đẩy sang bảng Chi phí" tạo khoản chi mới từ một dòng tiền. **Đã bỏ.** Nó biến "tiền
đã đi ra" thành "chi phí của kỳ chứa ngày trả tiền" — lương tháng 9 trả ngày 05/10 sẽ thành chi phí
tháng 10, vừa sai kỳ vừa trùng với khoản đã ghi nhận.

```
SỔ NGÂN HÀNG  = sự thật về TIỀN   (đã vào/ra, theo ngày ngân hàng ghi)
PROFIT ENGINE = sự thật về CHI PHÍ (theo kỳ hưởng lợi ích, theo nguồn có thẩm quyền)
```

Nhóm kế toán nay **chỉ** quyết định `BankCashClass`: `BUSINESS_INFLOW`, `BUSINESS_OUTFLOW`,
`INTERNAL_TRANSFER`, `CAPITAL`, `OWNER`, `TAX`, `OTHER`, `UNCLASSIFIED`. Không nhóm nào mang ảnh
hưởng lãi lỗ — kiểm thử chặn ở mức kiểu dữ liệu.

Nối tiền với chứng từ là **đối chiếu** (`bank_transactions.linked_type` / `linked_id`), tới khoản chi,
đợt COD, phiếu nhập hoặc chi tiêu QC **đã có**. Chứng từ phải tồn tại thật mới nối được.

## Luật chất lượng dữ liệu (bổ sung)

| Luật | Khi nào bật |
|---|---|
| `PAYROLL_COST_COVERAGE_INCOMPLETE` | bảng Lương chưa đủ điều kiện, đang dùng nguồn dự phòng |
| `DUPLICATE_PAYROLL_EXPENSE_SOURCE` | bảng Lương cầm quyền nhưng vẫn còn khoản "Lương" ở bảng Chi phí |
| `DUPLICATE_LOGISTICS_COST_SOURCE` | khoản cước / phí hoàn gõ tay không khai là điều chỉnh |
| `COMMISSION_BASIS_NEEDS_REVIEW` | chưa chốt cơ sở ghi nhận hoa hồng |

Tất cả hiện **ngay trên Báo cáo lợi nhuận**. Không luật nào xoá hay sửa dữ liệu.

## Năm kiểm thử chống trừ hai lần — `tests/cost-double-count.test.ts`

| # | Tình huống | Kỳ vọng |
|---|---|---|
| 1 | cước vận đơn 20.000 + khoản chi `SHIPPING` 20.000 | **20.000**, không phải 40.000 |
| 1b | thêm khoản `MANUAL_ADJUSTMENT` 150.000 có lý do | **170.000** — tiền thật không bị vứt |
| 2 | phí hoàn vận đơn 25.000 + khoản chi `RETURN_FEE` 25.000 | **25.000** |
| 3 | lương bảng Lương 9.000.000 + khoản chi 9.000.000, coverage COMPLETE | **9.000.000**, không phải 18.000.000 |
| 4 | cùng dữ liệu, coverage INCOMPLETE | dùng nguồn dự phòng, lương **khác 0**, có cảnh báo |
| 5 | 9.000.000/tháng, xem 7 ngày của tháng 30 ngày | **2.100.000** |

Kèm bất biến: tổng engine bằng tổng các thành phần, và mỗi đồng thuộc **đúng một** thành phần.

## Migration

`0044_cost_authority.sql` — viết tay, **không** dùng `db:generate` (chuỗi snapshot của kho đứt ở
0032 nên bản sinh tự động dựng lại cả những thay đổi 0033–0043 đã áp, chạy lên production sẽ lỗi).

Tương thích ngược: chỉ **thêm** cột có giá trị mặc định. Mọi dòng cũ nhận `cost_source = 'MANUAL'` và
`linked_type` rỗng — đúng hành vi hiện tại, không viết lại lịch sử. Ràng buộc `CHECK` thêm **sau** khi
cột đã có mặc định nên không dòng nào vi phạm.

Toàn bộ chuỗi 0000 đến 0044 được dựng lại từ **CSDL trống** ở mỗi lần `npm test` (`tests/setup-env.ts`
xoá và tạo mới), nên migration được kiểm chứng thật chứ không chỉ đọc bằng mắt.

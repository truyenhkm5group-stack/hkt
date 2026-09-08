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

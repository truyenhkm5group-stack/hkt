# Buồng lái tài chính — thiết kế & ranh giới

Nhánh `claude/finance-cockpit-v2`. Tài liệu này ghi **vì sao**, không lặp lại **cái gì** (mã nguồn đã
nói). Đọc kèm `AGENTS.md` mục 8 (độ tin cậy KPI), mục 14–18 (chi phí, nguồn, thẩm quyền) và
`docs/business-rules/ORDER_OUTCOME.md`.

---

## 1. Vấn đề

Nhóm Tiền có sáu trang và không trang nào trả lời được câu hỏi đầu tiên của chủ shop mỗi sáng:
**còn bao nhiêu tiền, và đang nằm ở đâu.**

| Trang | Trả lời được | Không trả lời được |
|---|---|---|
| Sổ ngân hàng | "Từng giao dịch là gì" | "Cộng lại còn bao nhiêu" |
| Đối soát COD | "Đơn nào chưa trả tiền" | "Tổng tiền đang kẹt ở đâu" |
| Chi phí | "Đã ghi khoản nào" | "Khoản nào đang tăng" |
| Lợi nhuận | "Lãi bao nhiêu" | "Sao tài khoản không dày lên tương ứng" |
| Dòng tiền | "Kỳ tới thu hơn chi bao nhiêu" | "Kỳ vừa rồi đã vào ra thế nào" |

Mỗi trang đúng việc của nó. Cộng lại vẫn không thành một câu trả lời.

## 2. Phát hiện mở khoá cả nhóm việc

`bank_transactions.balance_after` — **số dư luỹ kế do chính ngân hàng ghi sau mỗi giao dịch** — đã
được `lib/integrations/bank/sepay-ingest.ts` lưu từ lâu. **Không một truy vấn hay màn hình nào đọc
nó.** Cả sổ ngân hàng chỉ cộng `amount`, nên trả lời được "kỳ này quay vòng bao nhiêu" mà vẫn không
trả lời được "còn bao nhiêu".

Vì thế `lib/queries/cashflow.ts` mở đầu bằng câu *"ERP KHÔNG có số dư ngân hàng"*. Câu đó **đúng vào
lúc viết và nay đã lỗi thời**. Chú thích trong tệp đó chưa sửa — nó thuộc phần dự phóng, và phần dự
phóng không đổi.

## 3. Ba mức chắc chắn của một số dư — luật trung tâm

Đây là quyết định thiết kế quan trọng nhất của cả nhóm việc.

| Mức | Nghĩa | Cách tính |
|---|---|---|
| `CONFIRMED` | Ngân hàng ghi | Giao dịch mới nhất của tài khoản CÓ `balance_after` |
| `DERIVED` | ERP cộng thêm | Mốc `balance_after` gần nhất + các giao dịch phát sinh sau đó |
| `UNKNOWN` | **Chưa biết** | Tài khoản chưa bao giờ có `balance_after` ⇒ **không hiện số** |

**Cách sai duy nhất mà cả nhóm việc này tồn tại để chặn:** cộng `sum(amount)` từ 0 rồi gọi đó là số
dư. Phép cộng đó cho ra một con số trông hoàn hảo và sai hàng trăm triệu, vì nó giả định tài khoản
mở ra với 0đ **và** ERP thấy đủ mọi giao dịch kể từ đó. Với một sổ nhập từ sao kê tải tay thì cả hai
đều sai.

`tests/cash-position.test.ts` khoá điều này bằng một ca cụ thể: tài khoản có 8.000.000đ đi qua mà
chưa có mốc số dư nào ⇒ phải trả `null`, và assertion `notEqual(balance, 8_000_000)` chặn đúng phép
cộng dồn đó.

Hệ quả: **tổng tiền là tổng của phần BIẾT ĐƯỢC**, kèm cờ `complete` và số tài khoản chưa biết. Một
con số kèm mức độ đầy đủ (AGENTS.md mục 8.11), không phải một con số trần.

## 4. Bất biến chuỗi số dư — phép kiểm chưa ai làm

`db/schema.ts` gọi đây là *"mỏ neo đối chiếu mạnh nhất của cả sổ"* và cũng chưa có ai kiểm:

```
balance_after[i] − balance_after[i−1] = amount[i]
```

Đứt chuỗi = thiếu giao dịch. Bước không khớp = trùng giao dịch. Nay được kiểm ở hai nơi:

- **theo từng tài khoản** (`cash-position.ts`, cột `chainBreaks`) — hiện ngay cạnh số dư;
- **theo từng kỳ** (`cashflow-statement.ts`, `integrityGap`) — `đầu kỳ + phát sinh − cuối kỳ`.

**Dấu của `integrityGap` nói ra loại hỏng**, nên nó được khoá bằng kiểm thử chứ không chỉ khoá độ lớn:

- **DƯƠNG** — ERP cộng được *nhiều hơn* mức ngân hàng thật sự đổi ⇒ thiếu một khoản tiền **RA**,
  hoặc thừa một dòng tiền vào (nhập sao kê hai lần).
- **ÂM** — chiều ngược lại.

Lẫn hai chiều này thì người đi tìm nguyên nhân sẽ lục sai nửa sổ.

## 5. Lợi nhuận ≠ tiền: bảng KHÔNG ép cho khớp

Một bảng đối chiếu kế toán đầy đủ cần số dư đầu/cuối kỳ của mọi khoản phải thu, phải trả, tồn kho và
tài sản. ERP có bốn khoản đầu, **không** có phần còn lại: không sổ công nợ phải trả nhà cung cấp,
không khấu hao, và sổ ngân hàng chỉ đầy đủ từ ngày bắt đầu nối SePay.

Nên bảng cộng những khoản **giải thích được** rồi để phần còn lại đứng riêng ở dòng *"chưa giải thích
được"*, kèm lý do cụ thể.

> Một dòng dư 30 triệu có nhãn trung thực hữu ích hơn một bảng khớp 0đ nhờ một khoản "điều chỉnh
> khác" do máy tự nhồi vào — bảng khớp kiểu đó là cách hợp pháp hoá mọi sai sót về sau: từ đó trở đi
> mọi lỗi mới cũng lặng lẽ chảy vào đúng cái khoản ấy.

Các khoản **đo bằng BIẾN ĐỘNG, không bằng mức tồn**. Lấy "COD chưa về" ở cuối kỳ rồi trừ thẳng vào
lợi nhuận là trừ cả phần đã treo từ các kỳ trước; thứ làm tiền kỳ này khác lợi nhuận kỳ này là phần
**tăng thêm trong kỳ**.

## 6. Hai cơ sở đo, không bao giờ cộng với nhau

Chủ đề xuyên suốt cả module:

| | Cơ sở | Nguồn | Dùng ở |
|---|---|---|---|
| **Chi phí ghi nhận** | Kỳ hưởng lợi ích, đã phân bổ theo ngày chồng lấn | `cost-engine` | Bảng theo nhóm, lợi nhuận |
| **Tiền đã ra** | Ngày ngân hàng ghi | Sao kê | Biểu đồ theo ngày, top đối tác |

Một khoản thuê năm trả một lần nằm gọn trong một ngày ở cơ sở thứ hai và rải đều 365 ngày ở cơ sở
thứ nhất. **Cả hai đều đúng.** Vẽ chúng trên cùng một trục rồi cộng lại là sai.

Biểu đồ theo ngày **cố ý** dùng tiền thật: một đường "chi phí đã phân bổ theo ngày" thì *phẳng theo
thiết kế* (tiền thuê chia đều mỗi ngày) nên không phát hiện được gì; đường tiền thật có đỉnh, và đỉnh
là thứ cần nhìn.

Cùng lý do, trang Chi phí có hai tab ra **hai con số khác nhau một cách có chủ đích**: `danh-sach` là
SỔ GHI (đủ mọi khoản đã gõ — lọc bớt thì người vừa nhập thấy khoản của mình biến mất), `bao-cao` là
BÁO CÁO (chỉ con số thật sự vào lợi nhuận).

## 7. Không tạo nguồn sự thật thứ hai

`finance-overview.ts` **không tính lại con số nào**. Nó gọi các engine đã có thẩm quyền rồi xếp theo
thứ tự đọc:

| Khối | Engine |
|---|---|
| Kết quả đơn, doanh thu, lợi nhuận | `getFinancialTruth` → `ORDER_OUTCOME` |
| Chi phí vận hành | `getRecognizedCosts` (AGENTS.md mục 18) |
| COD | `codSettlementSummary` |
| Số dư | `getCashPosition` |
| Dòng tiền | `getCashflowStatement` |

Nhờ vậy mọi số trên Tổng quan **luôn khớp** với trang gốc của nó. Cảnh báo của cost-engine được **lấy
lại nguyên văn** (kể cả `severity`), không tự đánh giá lại.

### Suy ra, không gõ tay

`CASHFLOW_SECTIONS` ánh xạ `cashClass → khoang` rồi **suy** danh sách nhóm ra từ đó. Khai lại danh
sách là tạo nguồn sự thật thứ hai: thêm một nhóm mới ở `lib/constants/bank.ts` mà quên bên này thì
nhóm đó lặng lẽ rơi khỏi báo cáo — **tiền thật biến mất khỏi màn hình, và tổng vẫn trông hợp lý**.

`tests/finance-cockpit.test.ts` canh **cả bề mặt**: duyệt toàn bộ `BANK_GROUPS`, mỗi nhóm phải thuộc
đúng **một** khoang. Đây là bài học đã lặp lại tám lần trong kho mã này (xem `tests/smoke-coverage.test.ts`):
lá chắn canh whitelist chỉ canh được những gì có người nhớ thêm vào.

## 8. Hiệu năng

Đo bằng `npm run bench` (PGlite, scale 1 = quy mô production 09/2026, scale 10 = shop lớn gấp 10).
Toàn văn: `docs/perf/finance-cockpit-scale1.json`, `docs/perf/finance-cockpit-scale10.json`.

| Báo cáo | Lạnh ×1 | Lạnh ×10 | Ấm | Số câu | Payload |
|---|---|---|---|---|---|
| Tiền hiện có | **5,4 ms** | **33 ms** | 0 ms | **1** | 0,9 kB |
| Dòng tiền THẬT | **8,2 ms** | **33 ms** | 0 ms | 4 | 2,9 kB |
| Báo cáo chi phí | 106 ms | 684 ms | 0 ms | 27 | 3,4 kB |
| Lợi nhuận ≠ tiền | 143 ms | 1.164 ms | 0 ms | 20 | 2,1 kB |
| **Tổng quan tài chính** (gộp 5 engine) | 355 ms | 2.214 ms | **0 ms** | 35 | 13,7 kB |
| *So sánh:* Tổng quan (Dashboard) — đã có trước | 392 ms | **6.271 ms** | 0 ms | 62 | 7,3 kB |

Hai điều đáng đọc trong bảng trên:

- **Hai truy vấn mới chạm sổ ngân hàng là hai truy vấn nhanh nhất của cả nhóm**, và chúng **tăng
  dưới tuyến tính**: dữ liệu gấp 10 thì thời gian chỉ gấp ~6 và **số câu không đổi** (1 và 4).
- Trang Tổng quan tài chính gộp năm engine mà ở scale 10 vẫn **nhanh hơn 2,8 lần** trang Tổng quan
  đã có (2.214 ms so với 6.271 ms), với **35 câu so với 62**.

### 8.1 Hai phép sửa hiệu năng trước/sau

**(a) Bảng đối chiếu lợi nhuận ≠ tiền — sai hình dạng truy vấn.** Bản đầu đo được **381 ms /
2.841 ms DB**, chậm hơn cả trang Tổng quan gộp năm engine. Nguyên nhân đã ghi sẵn ở
`return-rate.ts::OUTCOME_FENCE`: Postgres nội tuyến trọn `ORDER_OUTCOME` vào **từng** cột gộp, nên
mỗi đơn bị tính kết quả bốn lần, nhân hai lượt gọi. Cách sửa: bảng dẫn xuất có rào `offset 0`, và
gộp hai mốc vào **một** lượt quét.

| | Trước | Sau | |
|---|---|---|---|
| Tường | 381,4 ms | **142,6 ms** | **−63 %** |
| Thời gian CSDL | 2.841 ms | **779 ms** | **−73 %** |

Đây là đổi **hình dạng** truy vấn, không đổi công thức — `tests/finance-cockpit.test.ts` khoá đẳng
thức `lợi nhuận + giải thích được + chưa giải thích được = tiền thật`, nên lệch một đồng là đỏ.

**(b) Dự phóng dòng tiền — thiếu hẳn lớp đệm.** Phép đo scale 10 cho **1.978 ms lạnh / 2.035 ms
ẤM**. Ấm bằng lạnh nghĩa là **không có đệm nào cả**: mọi lượt mở trang đều trả đủ giá, kể cả khi hai
người mở cách nhau một giây. Mọi báo cáo nặng khác đều đã có `memo`; hàm này bị bỏ sót từ đầu.

| `getCashflow()` ×10 | Trước | Sau |
|---|---|---|
| Lạnh | 1.978 ms | 1.924 ms |
| **Ấm** | **2.035 ms** | **0 ms** |

Không đổi một con số nào — chỉ thêm `memo("cashflow-forecast", 90_000, …)`. Đây là lỗi **có sẵn**
trong tab mà nhóm việc này tiếp quản, nên sửa luôn.

### 8.2 Nguyên tắc đã áp dụng

- Gộp ở CSDL, không kéo giao dịch về máy chủ rồi cộng bằng TypeScript.
- Sáu phép đếm ngoại lệ gộp vào **một** câu: bể kết nối chỉ có 5, và trang này còn gọi bốn engine
  song song.
- Mọi báo cáo có `memo` riêng (60–90 s) ⇒ lượt mở thứ hai **0 ms** ở cả hai scale.
- Mỗi tab chỉ chạy truy vấn của **chính nó**: mở tab dự phóng không trả giá cho báo cáo tiền thật.
- Số dư `DERIVED` tính bằng một `distinct on` + một phép cộng, không quét lại cả bảng.
- Biểu đồ theo ngày vẽ bằng CSS, **không** nạp thư viện đồ thị cho một chuỗi không cần tương tác.

### 8.3 Ghi chú trung thực về chính phép đo

`scripts/bench/seed.ts` trước đây **không** sinh `bank_accounts` / `bank_transactions`, nên mọi phép
đo chạm sổ ngân hàng đều "nhanh vì rỗng" — một con số vô nghĩa. Đã bổ sung: 724 giao dịch ở scale 1,
7.240 ở scale 10, với **chuỗi số dư liền mạch thật** (sinh số dư ngẫu nhiên sẽ tạo hàng nghìn chỗ
"sổ đứt" giả và phép đo lại đo một nhánh mà production không đi).

Việc sinh số dư này sai **hai lần** trước khi đúng, cả hai đều là tràn kiểu `integer` ở scale 10 do
quy tắc sinh có kỳ vọng khác 0 (trôi tới −2,1 tỷ, rồi +2,15 tỷ). Cách chữa: lái chiều giao dịch theo
khoảng cách tới một mức mục tiêu, đúng như một tài khoản vận hành thật — dao động quanh một mức chứ
không trôi một chiều.

PGlite là Postgres biên dịch sang WebAssembly, chạy một luồng: **con số tuyệt đối không bằng con số
trên Postgres 16 của VPS**. Thứ so sánh được là tỷ lệ giữa các trang, số câu truy vấn, và trước/sau
trên cùng một máy.

## 9. Ranh giới đã giữ

Không chạm: `db/schema.ts`, migration, ingestion SePay / webhook ngân hàng, CSKH, `lib/actions/*`
(module này **chỉ đọc**), công thức `ORDER_OUTCOME`, `cost-engine`, `cod-settlement`, và nội dung dự
phóng dòng tiền (chỉ **đổi chỗ** vào một tab, giữ nguyên công thức).

### Phụ thuộc backend — chưa có, KHÔNG tự tạo schema thay thế

Ba câu hỏi trong đề bài **không** trả lời được với dữ liệu hiện có. Đã khai rõ thay vì dựng một bảng
riêng để lấp:

| Cần | Vì sao chưa có | Ảnh hưởng |
|---|---|---|
| **Chi phí đã trả / chưa trả** (`paid` vs `accrued`) | `expenses` không có mốc thanh toán. `bank_transactions.linked_id` là **đối chiếu**, không phải ghi nhận — và không phải khoản chi nào cũng có dòng tiền tương ứng | Tổng quan hiện *"khoản chi gõ tay chưa nối với dòng tiền nào"* như một ngoại lệ mức thấp, **không** gọi đó là "chưa trả" |
| **Ngân sách / budget** | Không có bảng ngân sách | Báo cáo chi phí so **kỳ trước**, không so ngân sách. Khối budget/actual **không** dựng |
| **Lương đã trả** | Lương ở `settings` JSON, không có bản ghi thanh toán | Không dựng ngoại lệ "payroll chưa paid". Cảnh báo lương lấy lại từ cost-engine |

Giao diện adapter khi backend sẵn sàng: thêm trường vào `FinanceException` (đã có `amount: number | null`
cho *chưa đo được*) và một thành phần mới trong `ExpenseReport` — **không** cần đổi cấu trúc hiện tại.

## 10. Cổng chất lượng

`npm run typecheck` · `npm run lint` · `npm test` (**TẤT CẢ KIỂM THỬ ĐẠT**) · `npm run build` — sạch.

Hai bộ kiểm thử mới, đăng ký trong `tests/sync-fixtures.test.ts`:

- `tests/cash-position.test.ts` — ba mức chắc chắn · chưa biết là `null` không phải 0 · tài khoản
  ngừng dùng ngoài tổng · chuỗi số dư đứt bị nêu · số dư tại một mốc.
- `tests/finance-cockpit.test.ts` — 24/24 nhóm kế toán thuộc đúng một khoang · đẳng thức đầu/cuối kỳ
  khớp **và vỡ đúng lúc** (xoá một giao dịch ⇒ `integrityGap` phải bằng đúng khoản đó, đúng dấu) ·
  chuyển nội bộ không thổi phồng tiền vào/ra · bảng lợi nhuận ≠ tiền không ép khớp · mỗi ngoại lệ có
  hậu quả và lối xử lý.

Ba lá chắn sẵn có đã bắt lỗi thật trong lúc làm và đều được sửa **đúng cách** (không nới lá chắn):

1. `tests/cost-allocation.test.ts` — chú thích của tệp mới trích nguyên văn chuỗi bị cấm
   `not in ('ADS','PURCHASE')`. Lá chắn quét văn bản nguồn, đúng như thiết kế của nó ⇒ viết lại chú
   thích, đồng thời **suy** `NON_EXPENSE_GROUPS` ra từ phép phân khoang thay vì gõ tay.
2. `tests/loading-ux-contract.test.ts` — `/reports/cashflow` nay nhận `searchParams` nên thành tuyến
   nặng ⇒ **đã thêm** `loading.tsx` dựng đúng hình dạng trang.
3. `tests/smoke-coverage.test.ts` — `/finance` vào thanh điều hướng ⇒ **đã thêm** vào
   `scripts/smoke.ts`.

Một lỗi tự bắt bằng kiểm thử: `ORDER_OUTCOME_FAST` / `PRIMARY_ATTEMPT` sinh ra tên đầy đủ
`"orders"."id"`, nên truy vấn thô **không được đặt bí danh** cho hai bảng đó (`from orders o` làm
Postgres báo thiếu bảng). `cod-settlement.ts` nối hai bảng này không bí danh vì cùng lý do.

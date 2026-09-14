# Hợp đồng SỰ THẬT TÀI CHÍNH & MỐI NỐI

> Mã nguồn khoá hợp đồng này: `lib/constants/finance-truth.ts`,
> `lib/queries/finance-linkage.ts` (đọc), `lib/finance/linkage.ts` (ghi),
> `lib/queries/finance-ledger.ts` (sổ hợp nhất).
> Kiểm thử: `tests/finance-truth.test.ts` — chạy trong `npm test`.
> Đọc kèm: `docs/business-rules/ORDER_OUTCOME.md`, `docs/profit-cost-allocation-contract.md`,
> `AGENTS.md` mục 15–18.

---

## 1. Vấn đề hợp đồng này giải quyết

Chủ shop hỏi mỗi tháng một câu mà ERP chưa trả lời được:

> **"Báo lãi 40 triệu mà tài khoản có 6 triệu. Tiền đi đâu?"**

Không trả lời được không phải vì thiếu dữ liệu. Dữ liệu có đủ: sao kê realtime từ SePay, bảng kê
Viettel Post, bảng chi phí, bảng lương, kết quả từng đơn. Vấn đề là **năm cuốn sổ không nói chuyện
được với nhau**, và mỗi lần ai đó cố ghép chúng lại thì cách nhanh nhất luôn là cách sai: coi tiền
ra là chi phí, coi tiền vào là doanh thu.

Sai kiểu đó không làm báo cáo đỏ. Nó chỉ làm lợi nhuận lệch vài phần trăm, và mọi người vẫn tin.

## 2. Năm cuốn sổ — mỗi cuốn một nguồn có thẩm quyền

| Sổ | Nguồn có thẩm quyền | Hạt | Trả lời được | **KHÔNG bao giờ trả lời** |
|---|---|---|---|---|
| **TIỀN MẶT** | `bank_transactions` (sao kê + SePay) | một giao dịch ngân hàng | đồng nào vào/ra, ngày nào, số dư bao nhiêu | chi phí kỳ · doanh thu · đơn nào đã giao |
| **CHI PHÍ** | `lib/queries/cost-engine.ts::getRecognizedCosts` | một thành phần chi phí của một kỳ | kỳ này hưởng lợi ích từ bao nhiêu chi phí | tiền đã đi ra chưa · ra ngày nào |
| **ĐỐI SOÁT ĐVVC** | `cod_statement_lines` / `cod_batches` | một dòng bảng kê của một vận đơn | ĐVVC chốt trả bao nhiêu, trừ cước bao nhiêu | đơn có giao thành công không |
| **NGHĨA VỤ LƯƠNG** | `lib/queries/payroll-cost.ts` | một kỳ lương | kỳ này nợ nhân sự bao nhiêu | đã trả chưa |
| **KẾT QUẢ ĐƠN** | `lib/queries/return-rate.ts::ORDER_OUTCOME` | một đơn hàng | đơn tới tay khách / quay về / huỷ | tiền đã về tài khoản chưa |

**Lệch nhau giữa các sổ là bình thường và KHÔNG được trộn.** Lương tháng 9 trả ngày 05/10 là TIỀN
của tháng 10 và CHI PHÍ của tháng 9. Hàng giao ngày 20/09 là DOANH THU tháng 9 và TIỀN của tuần sau,
khi Viettel Post chuyển bảng kê.

## 3. Ba điều cấm

1. **Mọi tiền ra là chi phí.** Sai. Trả nợ gốc, mua tài sản, rút vốn, chuyển sang tài khoản khác của
   chính mình đều là tiền ra mà không phải chi phí. Và ngay cả khi đúng là chi phí, sinh một khoản
   chi từ dòng sao kê thì cùng một đồng bị trừ hai lần — lần thứ hai còn rơi sai kỳ.
2. **Mọi tiền vào là doanh thu.** Sai. Góp vốn, giải ngân vay, chuyển nội bộ đều là tiền vào mà
   không bán được gì. Và **tiền COD Viettel Post trả về là tiền của doanh thu ĐÃ ghi khi đơn giao
   thành công** — cộng lần nữa là đếm đôi doanh thu.
3. **Tiền chứng minh đã giao hàng.** Sai, và đây là lỗi nặng nhất kho mã này từng mắc
   (`docs/erp-data-truth-audit.md` F1/F2). Chiều logistics chỉ kết luận bằng chứng từ ĐVVC.

## 4. Phân loại dòng tiền — taxonomy hiện có, KHÔNG dựng cái mới

Yêu cầu ban đầu nêu chín nhóm (`UNCLASSIFIED`, `OPERATING_EXPENSE`, `COD_SETTLEMENT`, `PAYROLL`,
`INTERNAL_TRANSFER`, `OWNER_FUNDING`, `LOAN`, `SUPPLIER/PURCHASE`, `OTHER`). Kho mã **đã có** một bộ
chi tiết hơn ở `lib/constants/bank.ts::BANK_GROUPS` (25 nhóm) và bộ đó được giữ nguyên — đổi sang
tên thô hơn sẽ mất thông tin đã phân loại và mất luôn phần “ai có thẩm quyền ghi nhận khoản này”.

| Nhóm trong yêu cầu | Nhóm thật trong ERP |
|---|---|
| UNCLASSIFIED | `UNCLASSIFIED` |
| OPERATING_EXPENSE | `RENT_UTILITIES` · `SOFTWARE` · `PACKAGING` · `BANK_FEE` · `LOAN_INTEREST` · `OTHER_EXPENSE` · `TAX` |
| COD_SETTLEMENT | `COD_SETTLEMENT` |
| PAYROLL | `PAYROLL_SALARY` · `PAYROLL_COMMISSION` |
| INTERNAL_TRANSFER | `INTERNAL_TRANSFER` |
| OWNER_FUNDING | `CAPITAL_IN` · `OWNER_DRAW` |
| LOAN | `LOAN_IN` · `LOAN_PRINCIPAL` · `LOAN_INTEREST` |
| SUPPLIER / PURCHASE | `PURCHASE` · `SUPPLIER_DEPOSIT` |
| OTHER | `OTHER_INCOME` · `ASSET_PURCHASE` · `NOT_BUSINESS` · `SALES_REVENUE` · `ADS_SPEND` · `SHIPPING_FEE` · `RETURN_FEE` |

**Nhóm kế toán chỉ quyết định LOẠI DÒNG TIỀN** (`BankCashClass`). Nó không tạo chi phí, không tạo
doanh thu. Cố ý không có loại "chi phí" trong `BANK_CASH_CLASSES`.

## 5. Mối nối: `bank_transaction_links`

### 5.1 Vì sao cần bảng mới

`bank_transactions.linked_type` / `linked_id` chỉ chứa được **một** mối nối và **không mang số
tiền**. Ba tình huống thường ngày vì thế không diễn tả được:

* một khoản chi 20 triệu trả làm ba lần → ba dòng tiền, mỗi dòng một phần;
* một chuyển khoản 30 triệu trả hai phiếu 20 + 10 → một dòng tiền, hai chứng từ;
* trả một phần → "đã trả chưa" không phải câu hỏi đúng/sai mà là **một con số**.

Đây là lần **duy nhất** phiên này thêm bảng. Mọi thứ khác tái dùng schema đang có.

### 5.2 Hình dạng

Migration: `drizzle/0068_bank_transaction_links.sql`. (Bản đầu của nhánh đánh số 0067; khi gộp thì
`0067_cs_workqueue` đã lên production trước nên migration này được dời sang 0068 — số đã áp lên máy
chủ thật thì không bao giờ được dùng lại.)


| Cột | Nghĩa |
|---|---|
| `txn_id` | dòng tiền (FK, `ON DELETE cascade`) |
| `target_type` | `EXPENSE` · `COD_BATCH` · `STOCK_RECEIPT` · `AD_SPEND` · `PAYROLL_PERIOD` · `BANK_TRANSACTION` |
| `target_id` | mã chứng từ; với `PAYROLL_PERIOD` là tháng `YYYY-MM` |
| `amount` | phần số tiền **của dòng tiền này** dành cho chứng từ kia, luôn DƯƠNG |
| `confidence` | `EXACT` · `HIGH_CONFIDENCE` · `MANUAL` |
| `method` | `IDENTIFIER_MATCH` · `AMOUNT_DATE_MATCH` · `MANUAL` · `TRANSFER_PAIR` |
| `confirmed_by` / `confirmed_at` | ai khẳng định, lúc nào. **Không bao giờ rỗng** |
| lịch sử | `audit_logs` (`BANK_LINK` / `BANK_UNLINK` / `BANK_AUTO_LINK`) |

Hai loại đích mới giải quyết hai lỗ hổng cụ thể:

* `PAYROLL_PERIOD` — bảng Lương là **cấu hình**, không phải bảng dữ liệu, nên không có `id` để nối.
  Khoá tự nhiên của một kỳ lương là tháng của nó. Nhờ vậy trả lời được "lương tháng 9 đã trả chưa"
  mà không phải dựng thêm một phân hệ tài chính thứ hai.
* `BANK_TRANSACTION` — chân kia của một lần **chuyển nội bộ**. Tiền rời tài khoản A và vào tài khoản
  B là HAI dòng sao kê của MỘT sự kiện.

### 5.3 Bốn luật của tầng ghi (`lib/finance/linkage.ts::createLink`)

1. **Không nối vượt số tiền thật** — tổng phân bổ ≤ `abs(amount)`. Vượt = cùng một đồng đánh dấu hai
   nghĩa vụ đã trả.
2. **Chứng từ phải có thật** — nối tới mã không tồn tại làm nghĩa vụ kia biến mất khỏi danh sách
   "chưa trả".
3. **Chuyển nội bộ ghép đối xứng, hai chân ngược chiều** — cùng chiều là khai khống một lần chuyển
   tiền; ghép một chiều thì chân còn lại vẫn thổi phồng dòng tiền. `createLink` tự tạo chân đối ứng,
   `removeLink` tự gỡ nó.
4. **Luôn có người chịu trách nhiệm** — `confirmed_by` không rỗng.

### 5.4 Tự động tới đâu

**Chỉ mức `EXACT` được máy tự nối** — nghĩa là nội dung chuyển khoản **chứa mã chứng từ** và số tiền
khớp chính xác. Đó không phải phỏng đoán. `HIGH_CONFIDENCE` (tiền + ngày khớp, một ứng viên duy
nhất) là **đề xuất**, người bấm. `AMBIGUOUS` và `UNMATCHED` **không tồn tại** ở tầng lưu trữ: một
mối nối đã ghi là một khẳng định, mà nhập nhằng thì theo định nghĩa không khẳng định được.

Không nới luật này. Một mối nối sai đánh dấu chứng từ "đã trả" trong khi tiền thật đi chỗ khác — hai
sổ cùng lúc mất tin cậy.

### 5.5 `linked_type` / `linked_id` sau hợp đồng này

Là **ảnh chụp mối nối chính** (mối nối có số tiền lớn nhất), không còn là nguồn sự thật. Được ghi bởi
đúng một hàm `syncPrimaryLink`, và `tests/finance-truth.test.ts` nhóm 7 khoá bất biến "ảnh chụp luôn
trỏ vào một mối nối có thật". Giữ lại để màn hình và bộ lọc hiện có chạy y nguyên.

## 6. Sổ hợp nhất (`lib/queries/finance-ledger.ts`)

Ba cửa, không cửa nào tự cộng lại thứ đã có nguồn:

* **`getCashLedger(period)`** — tiền vào / ra / ròng (cả thô lẫn đã loại chuyển nội bộ), phân loại vs
  chưa phân loại, chia theo `BankCashClass`, số dư từng tài khoản, độ phủ mối nối.
* **`getObligationLedger(period)`** — ba cặp *nghĩa vụ ↔ đã trả*: chi phí, COD, lương.
* **`getCashProfitBridge(period)`** — cầu nối từ **lợi nhuận ước tính** xuống **dòng tiền kinh doanh
  ròng**, nêu tên từng khoản chênh.

### Hai quy ước không thương lượng

* **`null` là CHƯA BIẾT, không phải 0.** Tài khoản chưa có số dư luỹ kế → `balance = null`. Kỳ chưa
  có giao dịch nào → `hasData = false` và nói thẳng "thiếu dữ liệu", không hiện 0đ.
* **Không ép khớp.** Cầu nối có dòng `unexplained` hiện nguyên phần chênh không giải thích được. Bịa
  một dòng "điều chỉnh khác" để tổng bằng nhau là biến công cụ chẩn đoán thành công cụ trấn an.

## 7. Cạm bẫy kỹ thuật đã phát hiện và khoá

**Trong DANH SÁCH CỘT, drizzle dựng cột KHÔNG kèm tên bảng.** `${bankAccounts.id}` ra đúng chữ
`"id"`. Đặt vào một truy vấn con tương quan mà bảng bên trong cũng có cột `id` (mọi bảng của kho mã
này đều có), chữ đó bám vào bảng bên trong: điều kiện thành `t.bank_account_id = t.id`, **không bao
giờ đúng, không báo lỗi**, và báo cáo hiện 0 / "chưa biết" một cách hoàn toàn thuyết phục.

Dựng lại được bằng `.toSQL()` ngày 12/09/2026. Ở `where` drizzle CÓ kèm tên bảng nên chỗ đó an toàn
— chỉ danh sách cột mới dính.

Luật: trong truy vấn con tương quan nằm ở danh sách cột, **viết nguyên `"bảng"."cột"`**, không nội
suy cột drizzle. Đã sửa `lib/queries/finance-ledger.ts` và `lib/queries/profit-cash.ts`
(`shipmentsLinked` trước đó luôn bằng 0).

Còn hai chỗ mang đúng hình dạng đó ở module ngoài phạm vi phiên này, **chưa sửa**, nêu ở mục 9.

## 8. Kiểm thử khoá hợp đồng (`tests/finance-truth.test.ts`)

| Nhóm | Khoá điều gì |
|---|---|
| 0 | luật phân bổ thuần · chỉ MỘT mức được tự nối · nhập nhằng không lưu được |
| 1 | một dòng tiền **không** thành chi phí + dòng tiền + doanh thu ba lần |
| 2 | tiền COD ĐVVC về **không** sinh doanh thu lần hai |
| 3 | chuyển nội bộ triệt tiêu về 0 · hai chân cùng chiều bị từ chối · tổng thô vẫn khớp sao kê |
| 4–5 | trả một phần (8/20) · một khoản chi ba dòng tiền cùng phủ |
| 6 | một dòng tiền phủ hai nghĩa vụ · nối vượt bị chặn · chứng từ ma bị chặn |
| 7 | ảnh chụp mối nối chính luôn khớp bảng nối |
| 8 | sao kê nhập tay + webhook SePay hội tụ, mối nối sống sót, không nhân đôi |
| 9 | nghĩa vụ lương ≠ tiền lương đã trả · kỳ lương phải đúng dạng `YYYY-MM` |
| 10 | cầu nối lợi nhuận → tiền mặt, luôn kèm giới hạn |
| 11 | số dư chưa biết ≠ 0 |
| 12 | gỡ mối nối trả sổ về đúng trạng thái, gỡ cả chân đối ứng |

## 9. Nhập nhằng còn lại — CHƯA giải quyết, cố ý

1. **Hoa hồng chưa chốt được cơ sở.** Cả bốn cơ sở hiện có đều là % của LỢI NHUẬN, nên hoa hồng
   không thể đồng thời là chi phí nằm trong lợi nhuận. Giữ nguyên `COMMISSION_BASIS_NEEDS_REVIEW`.
   **Quyết định của chủ shop, không phải của ERP.**
2. **Gợi ý đối khớp chưa biết phân bổ từng phần.** `getMatchOverview` chỉ gợi ý cho dòng tiền **chưa
   có mối nối nào**. Chia một chuyển khoản cho nhiều chứng từ vẫn là thao tác tay — cố ý: máy đoán
   cách chia một khoản tiền là chỗ sai đắt nhất có thể có.
3. **Chưa có giao diện cho nhiều mối nối.** Tầng dịch vụ xong và có kiểm thử; màn hình Sổ ngân hàng
   vẫn hiện một mối nối mỗi dòng. Server Action gỡ-từng-mối **cố ý chưa thêm** — mã không nút nào
   bấm được là thứ `tests/action-wiring.test.ts` sinh ra để chặn.
4. **`PAYROLL_PERIOD` không kiểm chứng được kỳ có tồn tại.** Bảng Lương là cấu hình; "có thật" ở đây
   chỉ nghĩa là đúng dạng `YYYY-MM`. Nêu thẳng thay vì giả vờ đã kiểm.
5. **Hai chỗ còn mang cạm bẫy mục 7, ngoài phạm vi phiên này:** `lib/queries/ideas.ts`
   (`comments` / `lastCommentAt`) và `lib/queries/products.ts` (`ERP_STOCK_SUB`). Cần đối chiếu
   production trước khi sửa vì con số có thể đang được đọc như thật.
6. **Cầu nối chưa phủ giá vốn theo dòng tiền.** Tiền trả xưởng và giá vốn hàng bán rơi vào hai kỳ
   khác nhau; phần chênh đó hiện đang nằm trong `unexplained` thay vì có dòng riêng.

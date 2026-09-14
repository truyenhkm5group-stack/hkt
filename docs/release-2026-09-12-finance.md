# Biên bản phát hành — Ba nhánh tài chính, 12/09/2026

| | |
|---|---|
| Production TRƯỚC | `27cd63e` (deploy #240) · migration cuối `0067_cs_workqueue` · 67/67 đã áp |
| Production SAU | `f280faa` (deploy #241) · migration cuối `0068_bank_transaction_links` · 68/68 đã áp |
| Nhánh tích hợp | `release/finance-integration-2026-09-12`, dựng MỚI từ `origin/main` 27cd63e |
| Bỏ | 0 commit |

---

## 1. Va chạm số migration — việc đầu tiên phải xử lý

`claude/finance-truth-linkage-v2` tách ra từ `8c1e954` và đánh số `0067_bank_transaction_links`.
Trong lúc đó bản CSKH gộp trước và **`0067_cs_workqueue` đã lên production** (đo được trước khi
chạm vào bất cứ thứ gì: `cs_case_events` có, `cs_cases.follow_up_at` có, 67/67 migration đã áp,
`bank_transaction_links` chưa có).

Gộp nguyên trạng thì drizzle — chạy theo `_journal.json` — thấy mục `0067` đã áp và **bỏ qua vĩnh
viễn** migration còn lại. Không lỗi, không cảnh báo: bảng đơn giản không bao giờ tồn tại, và trang
tài chính đổ ở truy vấn đầu tiên trên production.

Đã dời sang `0068_bank_transaction_links`, mốc `when` muộn hơn. **Không sửa, không xoá, không đụng**
migration đã production.

Và vì bài kiểm hiện có chỉ canh mốc `when` tăng dần chứ không dựng lại được tình huống này, thêm
`tests/migration-upgrade-path.test.ts`: chép `drizzle/` sang thư mục tạm, cắt sổ tới `0067`, chèn dữ
liệu kiểu cũ, rồi áp tiếp và kiểm ba điều — áp thêm ĐÚNG 1 migration, mối nối cũ chuyển nguyên vẹn
kèm đúng người xác nhận, chạy lại không đẻ dòng thứ hai.

**Kết quả thật trên production:** 67 → 68 migration, `bank_transaction_links` có, **13 mối nối kiểu
cũ chuyển sang đúng 13 dòng** — khớp tuyệt đối với 13 dòng `linked_type <> ''` đo trước khi deploy.

## 2. Thứ tự tích hợp và việc hợp nhất

Gộp theo đúng thứ tự Truth → Operations → Cockpit, để hai nhánh sau dùng lại sự thật của nhánh đầu
thay vì tự dựng.

### 2.1 Chuyển nội bộ: gán nhãn không phải là ghép cặp

Nhánh Operations chỉ gán nhãn `INTERNAL_TRANSFER` cho cả hai vế. Tổng khi đó đã đúng, nhưng sổ vẫn
không biết hai dòng là MỘT sự kiện: không đối chiếu được vế nào thiếu, và một dòng gán nhãn nhầm
nằm im mãi. Thêm `confirmInternalTransferPair` — ghép TRƯỚC qua `createLink` (nơi kiểm hai chân phải
ngược chiều và tự tạo chân đối ứng), gán nhãn SAU.

### 2.2 Ba chỗ trùng: một con số, một cách tính

Sau khi gộp, ba câu hỏi về tiền có HAI lời giải mỗi câu — cả sáu đều đúng theo cách riêng, và đó
chính là vấn đề.

| Câu hỏi | Giữ | Gỡ |
|---|---|---|
| Số dư còn bao nhiêu | `cash-position.ts` (ba mức CONFIRMED/DERIVED/UNKNOWN + kiểm chuỗi số dư) | phần tự đọc `balance_after` trong `finance-ledger.ts` |
| Vì sao lợi nhuận ≠ tiền | `profit-cash-bridge.ts` (có `known` từng dòng) | cầu nối trong `finance-ledger.ts` — gỡ HẲN |
| Tiền vào/ra trong kỳ | cả hai, nhưng có bài kiểm ép khớp từng đồng | — |

`finance-ledger.ts` còn lại đúng phần không ai khác làm: nghĩa vụ đã phát sinh được tiền thật phủ
tới đâu, độ phủ mối nối, tình trạng ghép cặp chuyển nội bộ.

### 2.3 Hai lỗi bắt được TRONG lúc gộp — không nhánh nào tự thấy

**"Tiền kinh doanh" đang gồm cả tiền vay.** `getCashflowStatement` tính headline bằng "mọi khoang
trừ EXCLUDED", nên `FINANCING` lọt vào: bơm 100 triệu vốn + giải ngân 50 triệu thì "tiền vào kinh
doanh" nhảy thêm 150 triệu. Nhánh tự mâu thuẫn — chính bài kiểm của nó khẳng định "vay tiền về
KHÔNG được nằm trong vận hành" ngay dưới dòng cộng 20 triệu vay vào `moneyIn`. Headline nay =
khoang `OPERATING`. Bắt được bởi bài đối chiếu chéo, ngay lần chạy đầu.

**"Khoản chi đã trả chưa" đọc ảnh chụp thay vì bảng nối.** `linked_type/linked_id` nay chỉ giữ mối
nối LỚN NHẤT. Một chuyển khoản 30 triệu trả hai hoá đơn 20 + 10 thì hoá đơn 10 nằm mãi trong hàng
đợi "chưa có tiền" dù tiền đã ra đủ — vô hiệu hoá chính tính năng vừa thêm. Sửa ở cả
`finance-overview.ts` và `finance-ops.ts`.

## 3. Cổng phát hành

Chạy trên bản checkout SẠCH tại đúng SHA ứng viên `f280faa`: toàn vẹn kho mã · typecheck · lint ·
**156 nhóm kiểm thử ĐẠT** · build. Cộng hai đường migration: dựng mới (0 → 68) và nâng cấp từ trạng
thái production (67 → 68).

`tests/finance-invariants.test.ts` — mười bất biến + đối chiếu chéo ba màn hình tiền + đường hoàn
tác. Bài này là cổng của BẢN GỘP: chỗ hỏng của một bản gộp không nằm trong nhánh nào cả, nó nằm ở
chỗ hai nhánh cùng chạm một con số.

## 4. Đo trên production sau deploy

| | |
|---|---|
| Smoke | 42/42 đạt · 0 lỗi ứng dụng · 0 sai quyền (chạy hai lần) |
| `/finance` | 133 ms · `/finance-ops` 63 ms · `/bank` 46 ms · `/reports/cashflow` 111–121 ms |
| Đối chiếu kết quả đơn | 2643/2643 khớp · 0 lệch · 0 dùng lớp dự phòng · giá vốn đông cứng 446/446 |
| SePay | phát lại gói tin thật: 83 dòng trước = 83 dòng sau, tổng ròng không đổi một đồng · 0 mã bút toán có hai dòng |
| Phân loại | 83/83 giao dịch đã phân loại (0 chưa phân loại) |
| Mối nối | 13 dòng, khớp đúng 13 mối nối kiểu cũ |
| Số dư | **0/83 dòng có `balance_after`** ⇒ số dư = CHƯA BIẾT trên mọi tài khoản |

### KPI parity (37 phút giữa hai ảnh chụp, có sự kiện thật xen vào)

| | trước | sau | ghi chú |
|---|---|---|---|
| tổng đơn | 2643 | 2643 | — |
| giao thành công | 445 | 446 | +1 |
| hoàn | 983 | 985 | +2 |
| đang giao | 267 | 264 | −3 = đúng 1 giao + 2 hoàn |
| huỷ / chưa gửi / chưa rõ | 656 / 279 / 13 | 656 / 279 / 13 | không đổi |
| tỷ lệ GTC | 31,2% | 31,2% | không đổi |
| thực nhận có chứng từ | 212.052.000 | 212.052.000 | **không đổi** |
| giao TC (tiền) | 236.673.000 | 237.072.000 | +399.000 |
| COD đang chờ | 23.125.000 | 23.524.000 | +399.000 — đúng bằng đơn vừa giao |
| sự kiện vận đơn | 29.078 | 29.089 | +11 |

Mọi thay đổi khép kín trong chiều LOGISTICS và giải thích được bằng 11 sự kiện Viettel Post đến
trong khoảng đó: ba đơn rời trạng thái "đang giao", và tiền của đơn vừa giao xuất hiện đồng thời ở
"giao thành công" và "COD đang chờ" với đúng cùng một con số. Không KPI nào đổi vì bản phát hành:
`thuc_nhan_co_chung_tu` — con số nhạy nhất với một bản tài chính — đứng yên, và đối chiếu kết quả
đơn 2643/2643 khớp chứng minh luật kết quả đơn không bị chạm.

## 5. Còn lại cho chủ shop quyết định

1. **Số dư ngân hàng chưa dùng được.** 0/83 giao dịch có số dư luỹ kế: SePay không lấy được
   `accumulated` của MB (migration `0064` đã ghi lại chuyện này). Buồng lái vì thế hiện "Chưa biết"
   thay vì một con số — đúng thiết kế, nhưng nghĩa là tính năng số dư còn TRỐNG cho tới khi có
   nguồn. Cần chủ shop chọn: đổi nguồn realtime, hay nhập một mốc số dư tay để `DERIVED` chạy được.
2. **5 vế chuyển nội bộ chưa ghép đôi.** Đã gán nhãn nên không thổi phồng dòng tiền, nhưng chưa
   thành cặp. Hàng đợi tác vụ tài chính nay nêu chúng ra và ghép được bằng một cú bấm.
3. **Hoa hồng chưa chốt được cơ sở** — cả bốn cơ sở hiện có đều là % của LỢI NHUẬN nên hoa hồng
   không thể đồng thời là chi phí nằm trong lợi nhuận. `COMMISSION_BASIS_NEEDS_REVIEW` vẫn bật.
4. **`/ads` chậm 6,6–7,6 giây** trên production. KHÔNG do bản này (0/63 tệp thay đổi thuộc quảng
   cáo) và không chặn deploy, nhưng là việc thật cần một vòng riêng.
5. **Chưa có giao diện cho nhiều mối nối trên một dòng tiền.** Tầng dịch vụ xong và có kiểm thử;
   màn hình Sổ ngân hàng vẫn hiện một mối nối mỗi dòng.
6. **Hai chỗ mang cạm bẫy "cột không kèm tên bảng"** (`lib/queries/ideas.ts`,
   `lib/queries/products.ts::ERP_STOCK_SUB`) — ngoài phạm vi vòng này, cần đối chiếu production
   trước khi sửa vì con số có thể đang được đọc như thật. Chi tiết ở
   `docs/finance-truth-contract.md` mục 7 và 9.

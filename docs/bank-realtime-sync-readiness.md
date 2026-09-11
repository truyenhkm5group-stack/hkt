# Sổ ngân hàng thời gian thực — đặc tả sẵn sàng (BANK REALTIME SYNC READINESS)

Trạng thái: **ĐANG CHỜ CHỦ SHOP DUYỆT.** Chưa triển khai production. Tài liệu này là đặc tả để duyệt,
không phải mô tả cái đã có.

Ngày lập: 11/09/2026. Tài khoản trong phạm vi: **MB Bank 9972165264** (chủ tài khoản HO KHAC TRUYEN,
`Mã số thuế` trống trên sao kê ⇒ **tài khoản cá nhân**, không phải tài khoản doanh nghiệp).

---

## 0. Số liệu nền đo được trước khi thiết kế

| Đo cái gì | Giá trị | Nguồn |
|---|---|---|
| `bank_transactions` trên production | **0 dòng** | `db-query` 11/09/2026 11:24 UTC |
| Commit production | `9dd6823cee55` | `/api/health` |
| Sao kê mẫu 11/06–11/09/2026 | 80 giao dịch · vào 223.156.587₫ · ra 223.088.321₫ | tệp MB gốc |
| Tần suất | ~27 giao dịch/tháng | 80 giao dịch / 3 tháng |

**Sổ đang rỗng** nên mọi thay đổi lược đồ ở tài liệu này chạy trên bảng trống — rủi ro mất dữ liệu
bằng không *tại thời điểm này*. Đặc tả vẫn phải đúng cho trường hợp sổ đã có lịch sử, vì bước đầu
tiên của kế hoạch chính là nhập lịch sử vào.

---

## 1. Luật bất di bất dịch của sổ này

Bốn luật dưới đây suy ra thẳng từ `AGENTS.md` mục 8 và `docs/business-rules/ORDER_OUTCOME.md`.
Thiết kế nào vi phạm một trong bốn luật là thiết kế sai, không phải đánh đổi.

1. **MỘT giao dịch ngân hàng = MỘT dòng canonical.** Đường vào (file / webhook / API) là *nguồn gốc*
   (`provenance`), **không bao giờ** là *danh tính*. Bật realtime không được đẻ thêm dòng cho giao
   dịch đã có.
2. **KHÔNG silent merge, KHÔNG silent correction.** Hai dòng trông giống nhau mà ngân hàng cho hai mã
   khác nhau thì ERP **không được tự gộp** — có thể đó là hai lần chuyển thật. Ngược lại, cùng một mã
   mà hai nguồn báo hai số tiền thì ERP **không được tự chọn** — đó là mâu thuẫn phải nêu ra.
3. **Nhãn của người là bất khả xâm phạm.** `accounting_group`, `note`, `classified_by`, `rule_id`,
   `linked_type/linked_id` là quyết định của con người. Không đường vào nào được ghi đè.
4. **NULL là CHƯA BIẾT.** Không có số dư luỹ kế thì để `NULL`, không điền 0. Không có giao dịch trong
   kỳ thì là "chưa nhập", không phải "0₫".

---

## 2. Danh tính canonical của một giao dịch

### 2.1 Khoá chính: mã giao dịch của ngân hàng

Đây là điểm khiến toàn bộ kiến trúc chạy được **mà gần như không phải làm gì thêm**:

| Đường vào | Trường mang mã ngân hàng | Ví dụ thật |
|---|---|---|
| Sao kê MB (.csv/.xlsx) | cột `Số bút toán` / `Transaction No` | `FT26217021601512` |
| Webhook SePay | `referenceCode` | `FT26217021601512` |
| API SePay v2 | `reference_number` | `FT26217021601512` |

Ba đường cho **cùng một chuỗi**. `bank_transactions.bank_ref` đã có `uniqueIndex("bank_txn_ref_idx")`,
và luồng nhập file đã dùng `onConflictDoUpdate` trên khoá đó. Nghĩa là **cơ chế chống trùng đã tồn tại
và đã được kiểm thử** — việc còn lại là cho hai đường mới đi qua đúng cửa ấy.

Bắt buộc: **một hàm chuẩn hoá duy nhất** `normalizeBankRef()` (viết hoa, bỏ khoảng trắng và ký tự
lạ), dùng chung cả ba đường. Lệch một dấu cách là ra hai dòng canonical, và không ai nhìn ra.

### 2.2 Khoá dự phòng khi không có mã ngân hàng

Giữ nguyên cơ chế đang chạy: `NOREF:<ngày>:<giờ>:<số tiền>:<40 ký tự đầu nội dung>`
(`bankRefFor()` trong `lib/integrations/bank/statement.ts`). Đã có kiểm thử khoá.

### 2.3 Khoá giao hàng (delivery) — KHÁC danh tính kinh tế

SePay gửi lại tối đa **7 lần trong 5 giờ** khi endpoint lỗi, và cho phép gửi lại tay. Tài liệu của họ
nói thẳng: *"Check the `id` field before processing, as same transaction may trigger multiple webhooks"*.

Nên lưu thêm `provider_txn_id` = `id` của SePay. Nó nhận diện **lần gửi**, không nhận diện **giao
dịch**. Dùng nó ở tầng `webhook_events` (đã có `dedupe_key` UNIQUE) để lần gửi lại rẻ tiền, chứ không
dùng làm khoá của sổ.

### 2.4 Lưới an toàn tổng hợp: `match_key`

Chủ shop yêu cầu dedup theo *reference + account + amount + timestamp*. Cách đúng để dùng bộ tổng hợp
này là **PHÁT HIỆN, không phải GỘP**:

```
match_key = sha1( account_chuẩn_hoá | amount | date_trunc('minute', txn_at) )
```

- Không UNIQUE. Chỉ có index thường.
- Hai dòng cùng `match_key` nhưng khác `bank_ref` ⇒ sinh phát hiện **`BANK_DUPLICATE_SUSPECT`**,
  hiện cả hai dòng, **để người quyết định**.
- Vì sao không tự gộp: hai lần chuyển 1.000.000₫ cho cùng một người trong cùng một phút là chuyện có
  thật. Tự gộp là **xoá tiền thật**. Còn nếu quả thật là một giao dịch vào bằng hai mã thì đó là lỗi
  tích hợp nghiêm trọng — phải để người nhìn thấy, không phải để máy giấu đi.

---

## 3. Ba đường vào và quyền ghi của từng đường

### 3.1 Thứ bậc thẩm quyền

```
SAO KÊ FILE  >  API RECONCILIATION  >  WEBHOOK
(chứng từ)      (truy vấn có thẩm quyền)  (thông báo)
```

Cùng hình dạng với luật đã có ở `AGENTS.md` mục 3.6 (*"Dữ liệu Viettel Post ưu tiên hơn Pancake.
Import chỉ NÂNG `cod_status`, không hạ"*). Sao kê là **chứng từ ngân hàng phát hành**; webhook chỉ là
thông báo realtime và có thể thiếu, trễ, hoặc bị cắt gọn.

### 3.2 Bảng quyền ghi

| Trường | FILE_IMPORT | WEBHOOK | API_RECONCILIATION |
|---|---|---|---|
| Tạo dòng mới | ✅ | ✅ *(chỉ sau mốc cắt, xem 4.3)* | ✅ |
| `amount`, `txn_at` | ✅ ghi đè | chỉ khi dòng vừa được tạo | chỉ khi dòng vừa được tạo |
| `description`, `counterparty` | ✅ ghi đè | chỉ khi đang rỗng | chỉ khi đang rỗng |
| `balance_after` | ✅ ghi đè | điền nếu đang `NULL` | điền nếu đang `NULL` |
| `account` | ✅ ghi đè | điền nếu đang rỗng | ✅ ghi đè |
| `seen_sources` | append | append | append |
| `accounting_group`, `note`, `classified_by`, `rule_id`, `linked_*` | ❌ **không bao giờ** | ❌ **không bao giờ** | ❌ **không bao giờ** |

Hàng cuối là luật số 3 ở mục 1, và nó đã được kiểm thử: `tests/bank-ledger.test.ts` khối 6 khẳng định
nhập lại sao kê không xoá phân loại người dùng đã làm.

### 3.3 Mâu thuẫn

Cùng `bank_ref` nhưng khác `amount` hoặc khác `txn_at` quá 5 phút ⇒ **giữ nguyên giá trị của nguồn có
thẩm quyền cao hơn**, ghi phát hiện `BANK_SOURCE_CONFLICT` kèm **cả hai giá trị và cả hai nguồn**.
Không ghi đè im lặng, không "sửa cho khớp".

---

## 4. Bốn lớp khoá để bật realtime KHÔNG đụng vào lịch sử

Đây là yêu cầu gắt nhất của chủ shop. Bốn lớp, độc lập nhau, mỗi lớp đủ để chặn một mình:

**Lớp 1 — cùng khoá tự nhiên.** Webhook ghi bằng `bank_ref` y như file. Giai đoạn chồng lấn là
`ON CONFLICT DO UPDATE`, không phải `INSERT`. Đây là lớp cấu trúc, không phụ thuộc cấu hình.

**Lớp 2 — mệnh đề `set` hẹp.** Câu upsert của webhook chỉ liệt kê `last_seen_source`, `seen_sources`,
`balance_after` (khi `NULL`), `raw_payload`, `updated_at`. Các cột lịch sử **không có mặt trong câu
lệnh**, nên không thể bị đổi kể cả khi logic phía trên sai.

**Lớp 3 — mốc cắt (watermark).** `sync_state['bank.realtime_from']` = thời điểm bật realtime. Gói tin
có `transaction_date` **trước** mốc này được lưu vào `webhook_events` với trạng thái
`SKIPPED_BEFORE_CUTOVER` nhưng **không ghi vào sổ**. Chặn kịch bản nhà cung cấp phát lại lịch sử ngay
khi vừa kết nối — kịch bản này có thật và là cách phổ biến nhất làm hỏng một sổ đã đối chiếu xong.

**Lớp 4 — bất biến chuỗi số dư (đây là lớp phát hiện, chạy liên tục).**

```
Sắp theo (txn_at, bank_ref):
    balance_after[i] − balance_after[i−1]  PHẢI BẰNG  amount[i]
```

Đứt chuỗi = thiếu giao dịch. Bước không khớp = thừa/trùng giao dịch. Đây chính là phép thử đã bắt
được lỗi `37₫` của trình xuất CSV MB: đọc thẳng thì mỗi dòng lệch 37₫ và **không ai nhìn ra bằng
mắt**, nhưng chuỗi số dư thì vỡ ngay. Đưa nó thành một luật chất lượng dữ liệu chạy thường trực
(`BANK_BALANCE_CHAIN_BROKEN`) là cách duy nhất để sổ này tự tố cáo khi nó sai.

---

## 5. Sơ đồ luồng

```
                    ┌──────────────────── MB Bank 9972165264 ────────────────────┐
                    │                                                             │
        (1) REALTIME│                    (2) ĐỐI CHIẾU          (3) DỰ PHÒNG      │
                    ▼                            ▼                      ▼
            ┌───────────────┐          ┌──────────────────┐   ┌──────────────────┐
            │  SePay        │          │  SePay API v2    │   │ Sao kê .xlsx/.csv│
            │  webhook      │          │  /transactions   │   │ tải tay từ IB    │
            │  (push)       │          │  (pull, hằng đêm)│   │ (người tải)      │
            └───────┬───────┘          └─────────┬────────┘   └─────────┬────────┘
                    │                            │                      │
     POST /api/webhooks/sepay/[secret]           │                      │
                    │                            │                      │
                    ▼                            │                      │
        ┌───────────────────────┐                │                      │
        │  webhook_events       │                │                      │
        │  dedupe_key UNIQUE    │  ← gửi lại 7 lần/5h không nhân đôi    │
        │  trả HTTP 200 < 1s    │                │                      │
        └───────────┬───────────┘                │                      │
                    │                            │                      │
                    │   ┌────────────────────────┘                      │
                    │   │   ┌───────────────────────────────────────────┘
                    ▼   ▼   ▼
        ╔═══════════════════════════════════════════════════════╗
        ║   normalizeBankRef()  →  MỘT CỬA GHI DUY NHẤT         ║
        ║   upsertBankTransactions(rows, {source, authority})    ║
        ║   · ON CONFLICT (bank_ref) DO UPDATE                   ║
        ║   · mệnh đề set theo bảng quyền ghi ở mục 3.2          ║
        ║   · nhãn người dùng không nằm trong câu lệnh           ║
        ╚═══════════════════════════╤═══════════════════════════╝
                                    ▼
                    ┌───────────────────────────────┐
                    │   bank_transactions           │
                    │   MỘT dòng canonical / GD     │
                    │   + provenance đầy đủ         │
                    └───────────────┬───────────────┘
                                    ▼
              ┌─────────────────────────────────────────┐
              │  Luật chất lượng chạy thường trực:      │
              │  · BANK_BALANCE_CHAIN_BROKEN            │
              │  · BANK_DUPLICATE_SUSPECT               │
              │  · BANK_SOURCE_CONFLICT                 │
              │  · BANK_WEBHOOK_GAP (webhook_success=0) │
              └─────────────────────────────────────────┘
```

**Vai trò từng đường, nói một câu:**

- **Webhook = đường realtime.** Biết tiền vào/ra trong vài giây. Không được tin là đầy đủ.
- **API = đường sửa chữa và đối chiếu.** Chạy hằng đêm, quét lại khoảng 7 ngày gần nhất, bù các gói
  tin đã mất. Đây là đường chữa lành, không phải đường chính.
- **File = đường dự phòng và phục hồi.** Giữ nguyên, không bỏ. Là chứng từ có thẩm quyền cao nhất, và
  là phương án duy nhất còn chạy được khi nhà cung cấp trung gian ngừng dịch vụ.

---

## 6. So sánh nhà cung cấp

Phạm vi xét: **chỉ kết nối chính thống**. Đã loại ngay từ đầu mọi giải pháp đăng nhập hộ / screen
scraping / thư viện không chính thức — chúng đòi mật khẩu internet banking của chủ shop, vi phạm điều
khoản sử dụng của ngân hàng, và kho mã này đã có tiền lệ loại bỏ đúng loại đó (tự đăng nhập
viettelpost.vn, `AGENTS.md` mục 5).

| Tiêu chí | **SePay** | **MB Open API (trực tiếp)** | **ApiPay** | Casso |
|---|---|---|---|---|
| Độ chính thống với MB | Đối tác Open Banking **chính thức** của MB; nối bằng OTP MB gửi | Chính ngân hàng | Tự mô tả "kết nối trực tiếp hệ thống ngân hàng" | MB **không** có API chính thức ⇒ dùng **screen scraping** |
| Hợp với tài khoản **cá nhân** | ✅ có (cá nhân & doanh nghiệp) | ⚠️ chương trình hướng doanh nghiệp | ❓ không nêu rõ | — |
| Tiền vào **và** tiền ra | ✅ chọn "Cả hai" khi tạo webhook; `transferType` = `in`/`out` | ✅ | ❓ tài liệu không nêu tiền ra | ✅ |
| Webhook realtime | ✅ | ✅ | ✅ | ✅ |
| API truy vấn lịch sử | ✅ `GET userapi.sepay.vn/v2/transactions`, lọc khoảng ngày, phân trang | ✅ | ❓ | ✅ |
| Mã giao dịch gốc của ngân hàng | ✅ `reference_number` = đúng `Số bút toán` của MB | ✅ | ❓ | ✅ |
| Số dư luỹ kế | ✅ `accumulated` (có ở cả webhook lẫn API v2) | ✅ | ❓ | ❓ |
| Bảo mật webhook | API Key header, HMAC-SHA256, OAuth2, IP whitelist (6 IPv4 + 2 IPv6) | Hợp đồng ngân hàng | "mã hoá dữ liệu, webhook bảo mật" | — |
| Retry | ✅ 7 lần, giãn theo Fibonacci, tối đa 5 giờ; gửi lại tay được | tuỳ hợp đồng | ❓ | ❓ |
| Sandbox | ✅ `userapi-sandbox.sepay.vn` + **Mock Transaction API** tạo được cả `credit` lẫn `debit` để thử webhook | ❓ | ❌ "tính năng đang được phát triển" | ❓ |
| Rate limit | 3 req/s/IP, trả 429 + `Retry-After`, có `X-RateLimit-*` | tuỳ hợp đồng | ❓ | 2 req/s |
| Chi phí | **Miễn phí** 50 GD/tháng; Startup 120K₫/tháng cho 180 GD | thương lượng | không công bố | không công bố |
| **Kết luận** | **ĐỀ XUẤT** | Xét lại khi lên tài khoản doanh nghiệp | Chưa đủ chín | **LOẠI** (scraping) |

### Vì sao SePay

1. **Đối tác chính thức của MB** — đúng ràng buộc "không dùng giải pháp không chính thống".
2. **Nhận cả tiền ra.** Đây là tiêu chí loại bỏ khắc nghiệt nhất: phần lớn dịch vụ cổng thanh toán chỉ
   bắt tiền vào, mà sổ ngân hàng của ERP cần **cả hai chiều** thì mới khớp được số dư.
3. **`reference_number` trùng `Số bút toán` của MB** — ba đường vào hội tụ vào đúng một khoá tự nhiên
   mà không cần bảng ánh xạ nào.
4. **Có `accumulated`** — nuôi được bất biến chuỗi số dư ở mục 4 lớp 4.
5. **Có sandbox + mock cả hai chiều** — dựng và kiểm thử toàn bộ đường webhook mà **không chạm** vào
   tài khoản thật lẫn dữ liệu production. Đúng yêu cầu "không triển khai production cho tới khi duyệt".
6. **Miễn phí ở mức dùng thật của shop** (~27 GD/tháng so với hạn mức 50).

### Rủi ro của SePay, nói thẳng

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| **Bên thứ ba đọc được toàn bộ giao dịch** — kể cả tên đối tác, số tiền, nội dung | **Cao — cần chủ shop chấp nhận có ý thức** | Không có cách kỹ thuật nào loại bỏ. Đây là đánh đổi của mọi dịch vụ open banking trung gian. Đường duy nhất tránh được là MB Open API trực tiếp (cần tài khoản doanh nghiệp). |
| Nhà cung cấp ngừng dịch vụ / MB cắt kết nối | Trung bình | Đường nhập file **giữ nguyên vĩnh viễn** làm phương án phục hồi. Sổ không bao giờ phụ thuộc một nguồn. |
| Webhook mất gói | Trung bình | API đối chiếu hằng đêm bù lại; `webhook_success` của SePay cho biết gói nào họ gửi hỏng. |
| Hạn mức 50 GD/tháng bị vượt khi shop lớn lên | Thấp | 120K₫/tháng lên 180 GD. Cảnh báo khi chạm 80% hạn mức. |
| Token SePay lộ | Trung bình | Chỉ nằm ở `.env` VPS / GitHub Secrets (`AGENTS.md` mục 5). Webhook xác thực bằng secret trong URL + API key header, giống webhook Viettel Post đang chạy. |

---

## 7. Thay đổi lược đồ

Tất cả **chỉ THÊM cột có giá trị mặc định**. Không đổi kiểu, không xoá, không đổi tên. `bank_ref`
UNIQUE giữ nguyên.

```sql
ALTER TABLE bank_transactions
  ADD COLUMN provider          text    NOT NULL DEFAULT '',      -- '' | 'SEPAY' | 'MB_STATEMENT'
  ADD COLUMN provider_txn_id   text    NOT NULL DEFAULT '',      -- id của nhà cung cấp (khoá GIAO HÀNG)
  ADD COLUMN last_seen_source  text    NOT NULL DEFAULT '',      -- đường vào xác nhận gần nhất
  ADD COLUMN seen_sources      jsonb   NOT NULL DEFAULT '[]',    -- [{source, provider, at}] — provenance đầy đủ
  ADD COLUMN balance_after     integer,                          -- NULL = CHƯA BIẾT (luật 4 mục 1)
  ADD COLUMN match_key         text    NOT NULL DEFAULT '',      -- lưới an toàn, KHÔNG unique
  ADD COLUMN raw_payload       jsonb;                            -- bằng chứng gốc của webhook/API

-- `source` giữ nguyên ý nghĩa: ĐƯỜNG VÀO ĐÃ TẠO DÒNG, bất biến sau khi tạo.
ALTER TABLE bank_transactions DROP CONSTRAINT bank_txn_source_check;
ALTER TABLE bank_transactions ADD CONSTRAINT bank_txn_source_check
  CHECK (source IN ('IMPORT', 'MANUAL', 'WEBHOOK', 'API'));

CREATE INDEX        bank_txn_match_idx    ON bank_transactions (match_key);
CREATE UNIQUE INDEX bank_txn_provider_idx ON bank_transactions (provider, provider_txn_id)
  WHERE provider_txn_id <> '';

-- Backfill cho dòng đã có (hiện tại production có 0 dòng, nhưng câu lệnh phải đúng cho mọi lúc):
UPDATE bank_transactions
   SET last_seen_source = source,
       seen_sources     = jsonb_build_array(jsonb_build_object('source', source, 'at', created_at))
 WHERE last_seen_source = '';
```

Không đụng tới `bank_rules`, `expenses`, hay bất kỳ bảng nào khác.

**Cách sinh migration** (`AGENTS.md` mục 4): sửa `db/schema.ts` rồi `npm run db:generate`. **Không**
sửa tay migration đã có. Migration mới phải có mốc muộn hơn mọi mốc hiện có —
`tests/repo-integrity.test.ts` khoá điều này ở mức mã nguồn.

---

## 8. Kế hoạch chuyển đổi không mất dữ liệu

Sáu bước. Mỗi bước có **điều kiện dừng** riêng; không đạt thì không đi tiếp.

| # | Bước | Chạm production? | Điều kiện đi tiếp |
|---|---|---|---|
| 0 | **Nhập lịch sử bằng file** — chủ shop nhập sao kê 11/06–11/09 qua giao diện | ✅ ghi dữ liệu | 80 dòng · vào 223.156.587 · ra 223.088.321 · `2.154 + vào − ra = 70.420` |
| 1 | **Migration cộng cột** — additive, backfill `seen_sources` từ `source` | ✅ đổi lược đồ | `count(*)` và tổng tiền vào/ra **không đổi một đồng** so với bước 0 |
| 2 | **Dựng đường webhook trên sandbox** — route `/api/webhooks/sepay/[secret]`, dùng Mock Transaction API tạo cả `credit` lẫn `debit` | ❌ **không** | Gửi lại cùng một gói 3 lần ⇒ vẫn đúng 1 dòng; nhãn gán tay không đổi |
| 3 | **Dựng đường API đối chiếu** — job hằng đêm quét lại 7 ngày | ❌ **không** | Xoá thử 1 dòng trên bản sao ⇒ job bù lại đúng dòng đó, không đụng dòng khác |
| 4 | **Bật realtime** — đặt `bank.realtime_from` = **lúc bật**, nối tài khoản MB bằng OTP | ✅ | Chuỗi số dư liền mạch qua mốc cắt; số dòng của giai đoạn TRƯỚC mốc **không đổi một dòng** |
| 5 | **Chạy song song 2 tuần** — realtime chạy, vẫn nhập sao kê cuối kỳ để đối chiếu | ✅ | Nhập chồng lấn **không đẻ dòng mới nào**; nếu có, dừng và điều tra |

**Điểm không thể quay lui duy nhất là bước 1** (migration). Nó chỉ cộng cột có mặc định nên an toàn,
nhưng vẫn phải chạy `backup` trước (ops action đã có: `pg_dump` vào `/root/backups`).

**Bước 4 có thể tắt đi bất cứ lúc nào** mà sổ vẫn đúng: gỡ webhook ở SePay, sổ lập tức quay về mô hình
nhập file, và toàn bộ dòng do webhook tạo vẫn ở nguyên đó với provenance ghi rõ chúng từ đâu tới.

---

## 9. Việc chỉ chủ shop làm được

1. **Duyệt SePay làm nhà cung cấp** — kèm việc chấp nhận rằng một bên thứ ba đọc được toàn bộ lịch sử
   giao dịch của tài khoản (mục 6, bảng rủi ro, dòng đầu).
2. **Đăng ký tài khoản SePay và bấm nối MB bằng OTP** — OTP gửi về máy chủ shop, không ai làm thay được.
3. **Quyết có chuyển tài khoản ERP sang tài khoản doanh nghiệp hay không** — nếu có, mở được đường MB
   Open API trực tiếp và bỏ hẳn trung gian.

---

## 10. Nguồn

- SePay — kết nối MB: <https://docs.sepay.vn/ket-noi-mb-api.html>
- SePay — lập trình webhook: <https://docs.sepay.vn/lap-trinh-webhooks.html>
- SePay — tích hợp webhook (retry, bảo mật): <https://docs.sepay.vn/tich-hop-webhooks.html>
- SePay — API v2: <https://developer.sepay.vn/en/sepay-api/v2/bat-dau-nhanh>
- SePay — Mock Transaction (sandbox): <https://developer.sepay.vn/en/bankhub/api/api-giao-dich/gia-lap-giao-dich>
- SePay — bảng giá: <https://sepay.vn/bang-gia.html>
- Casso — API ngân hàng (nêu rõ dùng screen scraping): <https://casso.vn/api-ngan-hang/>
- ApiPay — Open Banking: <https://apipay.vn/open-banking>

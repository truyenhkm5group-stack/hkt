# Bản phát hành 13/09/2026 — CSKH vận hành · đối soát hàng hoàn · siết luồng làm việc

Nhánh: `claude/cskh-returns-ops-next` · nền: `origin/main` @ `3b2c8bb` (đã hợp nhất bản của phiên
song song về tháp giao vận và phiên bản luật kết quả đơn v3).

Đọc kèm: `AGENTS.md` (luật), `docs/business-rules/ORDER_OUTCOME.md` (kết quả đơn).

---

## 0. Hai thứ BỊ CHẶN, nói trước

### 0.1 Bảng tính "Bản sao của Hàng hoàn HMT" — KHÔNG đọc được trong môi trường agent

Tệp **không có** trong máy chạy phiên này, và `docs.google.com` bị chính sách mạng của môi trường
chặn ở tầng proxy:

```
curl: (56) CONNECT tunnel failed, response 403
recentRelayFailures: { kind: "connect_rejected", host: "docs.google.com:443" }   (đo trong phiên)
```

Cùng một bức tường mà phiên trước đã gặp (commit `44a924b`). Không đọc được nguồn thì **không**
được đoán ánh xạ cột: việc này đi thẳng vào tồn kho, và một cột đọc nhầm là một lô hàng vào kho
bằng con số không ai đếm.

**Đã làm gì thay vào đó:** dựng TOÀN BỘ bộ máy đối soát, kiểm thử đầy đủ, và một lệnh chạy nhận
đường dẫn tệp cục bộ — không cần mạng, không cần Google API:

```bash
npm run returns:hmt -- --file '/duong/dan/Ban sao cua Hang hoan HMT.xlsx'          # chạy thử
npm run returns:hmt -- --file '/duong/dan/Ban sao cua Hang hoan HMT.xlsx' --apply  # ghi
```

Lượt chạy thử in ra **bản kiểm đếm nguồn** (số dòng · mã vận đơn khác nhau · ô trống · mã 1P1 ·
phân bố màu/size) để đối chiếu bằng mắt với tệp mở trong Excel, rồi mới tới bảng phân loại. Đúng
quy trình mục 17 và 31 của yêu cầu — chỉ thiếu đúng cái tệp.

**Cách mở khoá (một trong hai):** đặt tệp `.xlsx` vào máy chạy lệnh, HOẶC mở chính sách mạng cho
`docs.google.com` rồi đưa đường dẫn xuất CSV công khai.

### 0.2 Production — không đo được, không deploy được từ phiên này

`erp.vnxcommerce.com` cũng bị chặn ở cùng tầng proxy (403 CONNECT), và không có `DATABASE_URL` của
production trong môi trường. Nên **mọi mục "đo production" của bản này để trống**: không có số
trước/sau thật, không chạy `db-query`, không xác minh `/api/health`.

Những con số production trích trong mã nguồn và tài liệu dưới đây là **số của phiên trước** (đo
13/09/2026), được dẫn lại làm bối cảnh và ghi rõ nguồn — không phải số đo mới.

Cổng phát hành đã chạy đủ trên bản checkout SẠCH; phần còn lại là một lượt deploy từ máy có mạng.

---

## 1. Đối soát sổ hàng hoàn viết tay ↔ ERP (một lần)

### Hợp đồng khớp — chặt hơn "mã vận đơn + SKU khớp"

Chủ shop chốt: *mã vận đơn khớp + mẫu mã khớp ⇒ kho đã nhận đúng hàng hoàn*. Bốn vế được siết:

1. mã vận đơn lần ra **ĐÚNG MỘT** kiện trong ERP (so trên cả `vtp_order_number` lẫn
   `tracking_code`, ở dạng đã chuẩn hoá);
2. dòng chữ sản phẩm lần ra **ĐÚNG MỘT** mẫu mã trong danh mục;
3. mẫu mã đó **có trong danh sách hàng kỳ vọng của chính kiện đó**;
4. số dòng của cặp (kiện · mẫu mã) **không vượt** số kỳ vọng còn lại.

Vế 3 là vế một phép khớp lỏng hay bỏ qua: mã có thật và mẫu mã có thật vẫn không chứng minh được
món này nằm trong kiện kia.

### Chín trạng thái, đúng một trạng thái được ghi

`MATCHED` · `ALREADY_RECEIVED` · `AMBIGUOUS_TRACKING` · `AMBIGUOUS_SKU` · `SKU_MISMATCH` ·
`QUANTITY_CONFLICT` · `UNMATCHED_TRACKING` · `DUPLICATE_SOURCE_ROW` · `CONFLICT`.

Chỉ `MATCHED` ghi vào ERP, và ràng buộc `hmt_return_rec_written_check` chặn ở CSDL — không tin vào
kỷ luật của mã nguồn.

Hai tình huống không có ô riêng trong danh sách của chủ shop được xếp vào ô gần đúng nhất **kèm lý
do nguyên văn**, chứ không lặng lẽ thành `MATCHED`: kiện lần ra nhiều đơn ⇒ `AMBIGUOUS_SKU` (nhiều
danh sách hàng kỳ vọng); kiện không lần ra đơn nào ⇒ `SKU_MISMATCH` (không có danh sách để đối
chiếu).

### Ô mã vận đơn trống: chỉ kế thừa khi TỆP nói ra bằng cấu trúc

Chỉ kế thừa khi ô mã được **GỘP DỌC** (`!merges` trong xlsx). Mọi ô trống khác là
`AMBIGUOUS_TRACKING`. Đọc CSV thì mất thông tin ô gộp nên mất luôn quyền suy ra từ nó — không có
cờ nào bật lại được.

Đã kiểm end-to-end trên một tệp `.xlsx` dựng riêng có ô gộp thật: 2 ô trống → 1 kế thừa hợp lệ, 1
không suy được.

### Ghi nhận đã về ≠ cộng tồn

Lượt ghi duy nhất đi qua `markReturnsArrived` → trạng thái `RECEIVED` (chờ đếm). **Tồn kho không
đổi một món nào**; kiện đi tiếp vào hàng đợi đếm và người kho vẫn phải mở ra đếm (AGENTS.md mục
10). Kiểm thử đo tổng `stock_receipt_items` trước/sau và khoá bằng khẳng định.

### 1P1 là bằng chứng, không phải rác

Trong KPI của lần bán gốc, vận đơn chiều về là dòng riêng (mục 7). Trong bối cảnh hàng về kho thì
chính nó là kiện chở hàng hoàn — mã **không** bị cắt đuôi, và nó khớp vào đúng kiện chiều về chứ
không đè lên vận đơn gốc. Kiểm thử khoá cả `shipmentId` của dòng khớp.

### Phép "alias" duy nhất được phép

Chuẩn hoá **chính tả**: thường hoá · bỏ dấu · gộp khoảng trắng — áp cho CẢ HAI phía. Không bảng
đồng nghĩa ("Đỏ" không tự thành "Red"). Hai mẫu mã của danh mục gập về cùng một khoá ⇒ **MƠ HỒ**,
không phải một lựa chọn.

### Chống ghi trùng

`idempotency_key` bám vào **nội dung dòng** (bảng tính · sheet · mã vận đơn · dòng chữ sản phẩm ·
lần xuất hiện thứ mấy), không bám vào số dòng — chèn một dòng ở đầu tệp không biến cả lượt chạy lại
thành một lượt ghi mới. Đã chạy thật qua CLI: lượt hai ghi **0 kiện, 0 dòng chứng cứ mới, 6 dòng bỏ
qua**.

### Tệp

`lib/constants/hmt-returns.ts` · `lib/returns/product-text.ts` · `lib/returns/sku-resolver.ts` ·
`lib/returns/hmt-workbook.ts` · `lib/returns/hmt-reconcile.ts` · `lib/returns/hmt-provenance.ts` ·
`scripts/hmt-return-reconcile.ts` · `drizzle/0080_hmt_return_reconciliation.sql` ·
`tests/hmt-return-reconcile.test.ts`.

---

## 2. Vòng đời `ORDER_NOT_CREATED`

Thêm bậc chứng cứ thứ ba: **`SHIPMENT_CREATED`** — có vận đơn gửi tới chính SĐT của case, tạo SAU
khi case đủ thông tin.

Đọc `shipments.receiver_phone` (chứng từ ĐVVC), **không** đọc vận đơn của `cs_cases.order_id`: cột
đó trỏ tới lần mua TRƯỚC. Đo của phiên trước (13/09): 25/29 case có `order_id`, và số case mà
`order_id` trỏ tới đơn tạo SAU là **0** — đóng theo nó là dọn sạch hàng đợi mà không case nào có
đơn thật. Vận đơn CŨ (tạo trước mốc đủ thông tin) vẫn không đóng được case; kiểm thử khoá riêng
trường hợp đó.

**Sửa cả nơi sinh:** `lib/cs/chat-detect.ts` gọi chính vị từ của máy đối chiếu
(`stillPendingOrderNotCreated`) ngay trước khi ghi. Một luật, hai nơi đọc — `dedupe_key` mang NGÀY
nên nếu không hỏi lại thì mỗi lượt quét đẻ ra đúng những case lượt đối chiếu vừa đóng.

Đây cũng là chỗ chặn cuộc đua máy-quét ↔ người-lên-đơn: vị từ chạy tại thời điểm GHI. Kiểm thử dựng
lại đúng thứ tự đó.

---

## 3. `/cs?view=theo-khach` — hàng đợi hành động

- **Việc nên làm tiếp**: sáu bậc xác định (`getCustomerNextAction`), mỗi bậc kèm câu căn cứ và trỏ
  tới một case có thật. Không gọi mô hình; không sinh case mới.
- **Nút trên dòng cha** nói rõ nó chạm vào cái gì. "Nhận việc"/"Hẹn lại" áp cho toàn bộ case đang
  mở; **"Đã xử lý" chỉ hiện khi khách còn đúng một việc**.
- **Bung ra** thấy đủ từng việc và làm được ở đó; đóng một case không đóng những case còn lại.
- **Bấm hàng loạt** chỉ ba việc (nhận · gán · hẹn lại) — `CS_BULK_ACTIONS`, chặn ở cả lược đồ đầu
  vào lẫn lúc tính. Thanh hành động nói cả hai con số: *"3 khách · 11 việc đang mở"*.
- **Phạm vi dữ liệu** lọc bằng MỘT truy vấn cho cả danh sách (không 200 lượt `rowInScope`), và phần
  ngoài phạm vi được nói thẳng trong thông báo.

### Hạn · ưu tiên (`lib/constants/cs-next-action.ts`, thuần, không đọc `Date.now()` ngầm)

- Hạn = **cái hẹn** nếu có, không thì `created_at + CS_CASE_SLA_HOURS`; case đã đóng ⇒ `null` (in
  "—", không in 0). Nhãn: *"Quá hạn 2 ngày"*.
- Bốn mức hạn thành một bộ lọc, đếm bằng CHÍNH mệnh đề mà bộ lọc dùng.
- **Một lỗi thiết kế bị kiểm thử bắt và đã sửa:** bản đầu cộng thẳng `+100` cho case quá hạn, khiến
  một case *tư vấn size quá hạn 20 ngày* (35 + 100) xếp trên một *khiếu nại mới mở* (90) — đúng cái
  bẫy "cũ nhất trước", chỉ đi vào bằng cờ quá hạn. Nay phần thưởng của hạn **tỷ lệ với mức nghiêm
  trọng**: quá hạn khuếch đại vị trí trong hạng, không nhấc vượt hạng.

### Khối lượng việc theo người

Để **chia lại việc trong ca**, không để thưởng/phạt (mục 24, 27): không cột xếp hạng, không điểm
tổng, trung vị chưa đủ mẫu in "—". Ba rổ "không phải người" (máy · tên gõ tay chưa nối · chưa ai
nhận) đứng riêng.

---

## 4. Tương phản: dòng bung và ô chọn

Hai lỗi ở chế độ tối, cả hai thuộc **hợp đồng dùng chung**:

1. **Khối bung không phân biệt được với dòng cha.** `bg-muted/30` ở 30% alpha gần trùng nền thẻ
   (`oklch(0.192 …)`). Nay: hai biến khai tường minh cho cả hai chế độ (`--row-nested`,
   `--row-selected`) + bốn lớp dùng chung. **Bốn dấu hiệu**, không phải một: nền khác · thụt vào
   kèm đường dọc · đường kẻ giữa dòng con · hover riêng. Kiểm thử đo bằng số: chênh lệch độ sáng so
   với nền thẻ ≥ 0.03 ở cả hai chế độ.
2. **Mọi lựa chọn trong ô chọn cùng một màu.** `<select>` gốc cho `<option>` kế thừa nền của chính
   nó. Không có cách nào tô từng `<option>` mà đúng trên mọi hệ điều hành. `components/status-select.tsx`
   dựng menu bằng DOM của trang và phân biệt bằng **ba** thứ: chấm màu · màu chữ ngữ nghĩa · nhãn.
   Nền đặc chỉ ở nút bấm. Màu chữ và chấm **rút ra** từ bộ lớp đang có — không có bảng màu thứ hai.

Dùng ở cả bàn care lẫn bảng CSKH. Màu trạng thái CSKH nay theo đúng từ vựng của bàn care.

---

## 5. Chất lượng dữ liệu: 8 → 15 mục

`cs-stale-order-not-created` · `cs-duplicate-actionable-customer` · `return-tracking-not-found` ·
`return-sku-unresolved` · `return-qty-mismatch` · `return-duplicate-receipt` ·
`return-received-without-expected-item`.

Hai mục CSKH đọc bằng **chính máy đối chiếu** ở chế độ chạy thử, không viết lại ba bậc chứng cứ lần
thứ hai. Con số báo ra là phần máy KHÔNG tự đóng được — đó mới là việc của người.
"Một khách chiếm nhiều dòng" đếm số **dòng thừa**, không đếm số nhóm.

Hai mục hàng hoàn là lỗi nội tại của ERP, không phụ thuộc sổ nào: một kiện có nhiều phiếu tái nhập
(tồn ảo) và kiện đã nhận mà không lần ra dòng hàng nào.

---

## 6. `/inventory/returns` — nguồn thứ ba hiện ra

Bàn nhận hàng hoàn có bốn nguồn: chứng từ ĐVVC · vòng đời ERP · **sổ viết tay** · thao tác tay.
Nguồn thứ ba trước đây không có chỗ trên màn hình. Khối mới hiện lượt đối soát gần nhất và — quan
trọng hơn — **phần không khớp**. Chưa chạy lượt nào thì khối không hiện.

---

## 7. Hiệu năng — đo được, không phải cảm nhận

`npm run bench:cs` (mới), đo bằng đúng lớp instrument sẵn có (`ERP_PERF_PROBE=1`):

| khách | case | câu truy vấn (hàng đợi) | thời gian | câu (khối lượng việc) |
|---|---|---|---|---|
| 10 | 20 | **3** | 26 ms | 1 |
| 100 | 300 | **3** | 19 ms | 1 |
| 400 | 1 200 | **3** | 17 ms | 1 |

Số câu là **hằng số**, không phải hàm của số dòng — kể cả khi hàng đợi từ 57 khách lên 400. Phân
trang và xếp thứ tự nằm ở SQL (dùng chính `CS_CASE_SLA_HOURS` và `CS_KIND_SEVERITY` nội suy vào,
không gõ lại thang điểm lần thứ hai); xếp chính xác trong trang dùng đúng hàm mà giao diện dùng để
tô màu.

> PGlite là Postgres biên dịch sang WASM, một luồng — con số tuyệt đối không bằng VPS. Thứ so được
> là **số câu** và độ tăng theo quy mô.

---

## 8. Cổng phát hành

Chạy trên bản checkout **SẠCH** theo đúng SHA ứng viên (`git worktree add --detach`), sau khi đã
hợp nhất `origin/main` mới nhất:

| bước | kết quả |
|---|---|
| `npm ci` | sạch |
| `npm run typecheck` | sạch |
| `npm run lint` | sạch |
| `npm test` | **TẤT CẢ KIỂM THỬ ĐẠT** |
| `npm run build` | ✓ Compiled successfully |
| `tests/repo-integrity.test.ts` | 915 tệp · 2896 import · mọi đích đến đã vào kho |
| `tests/migration-upgrade-path.test.ts` | 79 → 80 migration (+1), dữ liệu nghiệp vụ nguyên vẹn |

Migration mới: **0080** `hmt_return_reconciliation` — CHỈ cộng thêm một bảng, không đổi kiểu, không
xoá cột, không đụng `return_inspections` / `shipments` / `stock_receipts`.

**Chưa chạy được:** QA trình duyệt (không có mạng tới bản chạy thật để đối chiếu, và không dựng
được phiên đăng nhập trong môi trường này) và mọi phép đo production.

---

## 9. Còn lại cho lượt sau

| việc | vì sao chưa làm |
|---|---|
| Chạy đối soát HMT trên dữ liệu thật | không có tệp, mạng chặn `docs.google.com` (mục 0.1) |
| Đo production trước/sau | không có mạng tới `erp.vnxcommerce.com`, không có `DATABASE_URL` |
| Deploy | như trên — cần chạy từ máy có mạng, trên đúng SHA đã qua cổng |
| QA trình duyệt ở 90% / 100% / 110% | cần bản chạy có phiên đăng nhập |
| Bộ lọc đầy đủ của `/inventory/returns` (mục 21 của yêu cầu) | mới thêm chiều **nguồn gốc**; các chiều lọc còn lại (màu, size, tuổi, loại hoàn) là một bản riêng — nhồi vào bản này thì phần đã làm không được rà kỹ |

# Bản phát hành 14/09/2026 — Sao chép nhanh cho CSKH · đóng P1 Data Foundation · đối soát HMT

SHA: `3454fff` · deploy **#265** · production trước: `8b66e18` (deploy #264)

Đọc kèm: `AGENTS.md` (mục 0–3 · 9), `lib/constants/carrier-handoff.ts`,
`docs/release-2026-09-13-p1-data-foundation.md`, `docs/release-2026-09-13-cskh-returns-ops.md`.

---

## 0. Trạng thái đầu phiên — đo, không giả định

Yêu cầu mở đầu bằng "không dùng SHA/branch cũ làm base". Đo trước khi làm gì:

| thứ | giá trị |
|---|---|
| `origin/main` | `8b66e18` |
| production `/api/health` | cùng `8b66e18` (deploy #264, thành công) |
| migration đang chạy | **80** (`0080_hmt_return_reconciliation` đã áp) |
| cây làm việc | sạch, nhánh `claude/nifty-keller-5hnbeb` trùng `origin/main` |
| deploy đang chạy | không có |

`3b2c8bb` (bản P1 carrier handoff) đã nằm trong lịch sử của `8b66e18`; không có gì để quay lại.

**Mạng của phiên này**: `erp.vnxcommerce.com` và `docs.google.com` đều bị chặn ở tầng proxy
(403 CONNECT). Khác phiên trước, lần này **mọi phép đo production đều chạy được** qua thao tác ops
`db-query` (Actions → "Vận hành ERP trên VPS"), tức đúng cơ chế mà `AGENTS.md` mục 4 chỉ định.
Không con số nào trong tài liệu này là số dẫn lại của phiên trước.

---

## 1. P1 — ngữ nghĩa carrier handoff trên bản chạy thật

Đo lúc 14/09/2026 02:56 UTC, `canonical_order_outcome` (phiên bản luật 3):

| kết quả | số đơn |
|---|---|
| RETURNED | 995 |
| CANCELLED | 659 |
| DELIVERED | 492 |
| NOT_SHIPPED | 262 |
| IN_TRANSIT | 205 |
| **AWAITING_PICKUP** | **106** |
| UNKNOWN | 13 |

`AWAITING_PICKUP` **có mặt thật** trên production, ở đúng phiên bản luật hiện hành.

### 1.1 Chứng cứ, không phải nhãn

Với **cả 106** kiện `AWAITING_PICKUP`, sự kiện ĐVVC gần nhất đều mang chặng `PENDING`:

| mã | tên trạng thái | chặng | số kiện |
|---|---|---|---|
| 104 | Giao cho Bưu tá đi nhận | PENDING | 86 |
| 102 | Đơn hàng chờ xử lý | PENDING | 20 |

Không kiện nào có một dòng nói ĐVVC đã cầm hàng. Đây là bằng chứng ngữ nghĩa, không phải lời khai:
nếu `carrier_handoff_at` bị gán bừa thì ở đây phải xuất hiện chặng `PICKED_UP` trở đi.

### 1.2 Bậc chứng cứ trên toàn bộ 2.108 vận đơn

| bậc | số kiện |
|---|---|
| `PICKUP_SNAPSHOT` (mốc lấy hàng trên vận đơn) | 1.163 |
| `CARRIER_DOCUMENT` (webhook · tệp · tra API) | 794 |
| `MANUAL_DOCUMENT` (chép tay từ trang VTP) | 9 |
| `NONE` — **ngoài cohort** | 142 |

### 1.3 Tuổi của lô `AWAITING_PICKUP`

Theo **ngày lên đơn** (`orders.inserted_at`): 24–48h: 12 · 48–72h: 14 · **> 96h: 80**.
Theo ngày tạo dòng vận đơn: <24h: 1 · 24–48h: 54 · 72–96h: 11 · >96h: 40.

**COD treo: 61.451.999 ₫.** 80/106 kiện đã quá 4 ngày mà bưu tá chưa tới lấy — đây là việc vận
hành, không phải việc mã nguồn, và nay nó nhìn thấy được.

---

## 2. "ĐÃ GỬI" (Eligible Sent) — một danh sách, khai đúng một chỗ

### 2.1 Hợp đồng

> **Đã gửi = vận đơn đã có bằng chứng ĐVVC nhận hàng.**

Cố ý KHÔNG gồm: đang đóng gói · chờ ĐVVC tới lấy · lấy hàng không thành công · shop huỷ lấy ·
đã tạo mã vận đơn mà chưa bàn giao.

Khai ở `lib/constants/returns.ts`:

| hằng số | dùng để |
|---|---|
| `ELIGIBLE_SENT_OUTCOMES` | bốn kết quả tính là đã gửi |
| `ELIGIBLE_SENT_SQL` | cùng danh sách, dạng `in (...)` — **sinh ra từ mảng**, không chép tay |
| `ELIGIBLE_SENT_HINT` | câu tooltip cho mọi cột mang tên "Đã gửi" |

### 2.2 Vì sao phải hoisted

Trước bản này danh sách được gõ **nguyên văn ở bốn chỗ**:

| tệp | chỗ |
|---|---|
| `lib/queries/return-rate.ts` | `IS_SHIPPED` |
| `lib/queries/return-rate.ts` | cột `shipped` của bảng theo mẫu mã |
| `lib/queries/return-rate.ts` | cột `shipped` của dòng tổng hợp |
| `lib/queries/reports.ts` | vị ngữ `shipped` của báo cáo lợi nhuận |

Bốn bản sao **đang** đồng ý với nhau. Nhưng thêm một kết quả mới là một lượt sửa bốn chỗ — và cả
lớp lỗi P1 sinh ra từ đúng chuyện đó: sửa ba, quên một, không có gì đỏ lên.

`tests/contract-order-outcome.test.ts` nay quét `git ls-files` trên `lib` · `app` · `components` ·
`scripts` và đỏ nếu tệp nào gõ lại danh sách ấy.

### 2.3 Số đo cohort

2.108 vận đơn · **1.966 có chứng từ bàn giao (Đã gửi)** · **142 nằm ngoài cohort**.

142 kiện rơi ra đều chưa từng được ĐVVC cầm. Báo cáo kỳ cũ giảm số "Đã gửi" **không phải hồi quy**:
trước đây chúng được đếm trong khi chưa bao giờ rời kho. Không sửa số để giống báo cáo cũ.

---

## 3. P1 — 266 dòng mồ côi trong bảng dẫn xuất

### 3.1 Triệu chứng

`select outcome, logic_version, count(*) from canonical_order_outcome group by 1,2` ra **2.998 dòng
cho 2.732 đơn**, và 266 dòng vẫn mang `logic_version = 2` trong khi luật đã ở 3 từ 13/09.

### 3.2 Nguyên nhân gốc

Khoá duy nhất là `(order_id, coalesce(shipment_id,''))`, sinh từ phép chiếu
`orders LEFT JOIN shipments`. Đơn **chưa** có vận đơn rồi **sau đó** có ⇒ phép chiếu thôi sinh ra
cặp `(đơn, NULL)`: lượt upsert ghi một dòng MỚI cho `(đơn, vận đơn)`, còn dòng cũ nằm lại vĩnh
viễn. Bộ chọn "dòng cũ" cũng chạy trên chính phép chiếu ấy, nên **nó không bao giờ nhìn thấy dòng
mồ côi** — không có đường nào để nó được dựng lại.

Đo: cả 266 dòng đều `shipment_id IS NULL`, đều thuộc nhóm "đơn giờ đã có vận đơn", đọng từ
09/09/2026.

### 3.3 Hai hệ quả — cái thứ hai mới là cái đau

* `outcomeCoverage()` báo "còn 266 dòng luật cũ" **mãi mãi**. Một cảnh báo không bao giờ xanh được
  là một cảnh báo người ta học cách bỏ qua.
* Mọi truy vấn đọc **thẳng** bảng (thay vì đi qua phép nối) đếm 266 đơn ấy **hai lần**.

Báo cáo đang chạy **không sai**: `ORDER_OUTCOME_FAST` ghép đúng cặp khoá nên dòng mồ côi không bao
giờ được đọc. Đây là dọn nợ, không phải vá số liệu.

### 3.4 Cách sửa, và vì sao nó an toàn

`rematerializeStale()` thêm một điều kiện chọn đơn đang mang dòng mồ côi;
`rematerializeOutcomes()` dọn chúng trong cùng giao dịch với lượt upsert.

**Chỉ dọn dòng KHÔNG mang ghi nhận đã chốt** (`recognized_at` · `cogs_basis` · `trued_up_at` đều
rỗng). Kỳ đã chốt là bất biến (`AGENTS.md` mục 21): một dòng mồ côi CÓ giá vốn đã đóng băng thì giữ
nguyên và vẫn hiện ở `outcomeCoverage()` — thà một con số lạ còn hơn một lượt xoá im lặng.

Đo **trước khi viết dòng nào**: cả 266 dòng đều `NOT_SHIPPED`, và 0 dòng có `recognized_at` /
`recognized_cogs` / `cogs_basis` / `trued_up_at`. Lượt dọn đầu tiên không đụng vào một đồng giá vốn
nào. `tests/canonical-outcome.test.ts` dựng lại đúng tình huống đó và khoá cả hai chiều.

---

## 4. P1 — ảnh chụp KPI không nhìn thấy `AWAITING_PICKUP`

`scripts/kpi-snapshot.ts` là công cụ dùng để chứng minh "deploy không làm đổi sự thật nghiệp vụ".
Nó ra đời trước `AWAITING_PICKUP` nên không có ô cho kết quả đó.

Ảnh chụp **trước deploy** (production, script cũ) tự nó là bằng chứng:

```
tong: 2732
giao_thanh_cong 493 · hoan 1002 · hoan_theo_luat 0 · dang_giao 197
chua_ro 13 · chua_gui 262 · huy 659
```

Cộng các phần: **2.626**. Tổng: **2.732**. **Thiếu đúng 106** — chính là lô `AWAITING_PICKUP`.

Mỗi con số riêng lẻ vẫn đúng, nên không có gì đỏ lên. Bản này thêm ô `cho_dvvc_lay`, **và** thêm bất
biến `tổng = tổng các phần` **ném lỗi** chứ không cảnh báo: lần sau thêm một kết quả mà quên ô thì
ảnh chụp đỏ ngay, không im lặng đếm thiếu.

---

## 5. Sao chép nhanh SĐT / mã vận đơn cho CSKH

### 5.1 Vấn đề

CSKH đọc số trên màn hình rồi gõ lại sang Pancake và sang trang Viettel Post cả ngày. Sai một chữ
số ở mã vận đơn thì tra ra đơn của người khác.

### 5.2 Một nút, không phải nút thứ hai

`components/misc.tsx::CopyButton` đã tồn tại. Nó được **nâng cấp**, không nhân bản:

| thêm | vì sao |
|---|---|
| `what` — danh từ của giá trị | nhãn trợ năng, tooltip và lời báo cùng nói một câu ("Sao chép SĐT"). Mười nút "Sao chép" giống hệt nhau trên một trang thì không nút nào dùng được bằng trình đọc màn hình. |
| `e.preventDefault()` | nút nằm trong thẻ liên kết thì chặn nổi bọt thôi chưa đủ |
| đường lui `document.execCommand` | `navigator.clipboard` KHÔNG tồn tại ngoài ngữ cảnh bảo mật |
| báo lỗi khi cả hai hỏng | không im lặng giả vờ đã chép |
| `focus-visible:opacity-100` | nút mờ mà không có trạng thái focus thì người dùng bàn phím không biết mình đang ở đâu |

Mười hai chỗ gọi sẵn có (`/shipments` · vận đơn chi tiết · đơn hàng · bàn care · hàng đợi theo
khách) hưởng luôn, mỗi chỗ thêm đúng một từ.

**Chép GIÁ TRỊ, không chép thứ đang vẽ**: `value` là chuỗi chuẩn lấy từ CSDL (`"0981234567"`),
không phải chữ trong ô. Và vì `value` bằng đúng biểu thức được render, nút chép **không thể** là
đường vòng để lấy dữ liệu màn hình không cho xem — bài kiểm khoá chính bất biến đó.

### 5.3 Đơn nhiều lần gửi: liệt kê, không chọn hộ

`loadCaseShipments` trả về **cả danh sách** thay vì `limit 1`:

* lần gửi **đang chạy** vẫn đứng đầu, vẫn là thứ quyết định phân miền (nghĩa cũ không đổi);
* các mã khác nằm sau nút `+N`, mỗi mã kèm trạng thái riêng và nút chép riêng.

Chọn im lặng là cách một mã đã huỷ bị dán sang ĐVVC rồi báo khách "không tra ra đơn".

**Và kiện đã kết thúc nay cũng hiện mã.** Đo production: 598 case có đơn kèm vận đơn, nhưng chỉ
**294** case có lần gửi đang chạy. Hơn 300 case còn lại có mã vận đơn thật mà màn hình cũ không
hiện một ký tự nào — đúng những case phải gọi ĐVVC nhiều nhất.

Phép nối này được khai vào `MIEN_TRU` của `tests/shipment-join-grain.test.ts` kèm lý do: grain trả
về vẫn là CASE, phép nhân dòng là cố ý và được gộp lại ngay trong TypeScript, không cộng tiền và
không đếm đơn. **Không** được thêm `PRIMARY_ATTEMPT` vào đây — làm thế là quay lại đúng hành vi vừa
bị sửa.

---

## 6. QA trình duyệt — chạy TRƯỚC deploy

Bài học của bản 13/09 (`docs/release-2026-09-13-cskh-returns-ops.md` mục 10: ba lượt deploy vì QA
chạy sau lượt đầu) được áp dụng: bản dựng production tại chỗ (`next build` + `next start` trên
PGlite có dữ liệu mẫu), lái Chromium bằng Playwright, **trước** khi bấm deploy.

**3 trang × 3 mức phóng (90% · 100% · 110%) × 2 chế độ màu = 18 ảnh.**
0 lỗi console · 0 lỗi HTTP · 0 trang tràn ngang.

> Chế độ tối phải đặt bằng lớp `.dark` thật. `next-themes` ở kho này dùng `attribute="class"` +
> `defaultTheme="light"`, nên chỉ đặt `prefers-color-scheme: dark` trong Playwright là **chụp nhầm
> ảnh sáng rồi tưởng đã kiểm chế độ tối**. Lượt đầu của phiên này đúng là như vậy, và phải chụp lại.

Hành vi đo được trên trình duyệt thật, không suy đoán:

| kiểm | kết quả |
|---|---|
| số nút trên `/cs?view=theo-case` | 24 "Sao chép SĐT" · 24 "Sao chép mã vận đơn" · 24 "Sao chép mã đơn" |
| chép SĐT | hiện `0969708674` → clipboard `0969708674` (bằng đúng chuỗi đang hiện) |
| số 0 đầu | còn nguyên |
| chép mã vận đơn | hiện `85464594427` → clipboard `85464594427` |
| bấm nút có điều hướng dòng không | **không** — URL không đổi |
| phản hồi | "Đã sao chép SĐT" hiện ra |
| bàn phím | focus vào nút, Enter → chép được |
| nút `+N` | có, mở ra danh sách "Các lần gửi khác của đơn" |
| chiều cao dòng | 157px — nút chép không đẩy dòng ra |

---

## 7. Đối soát HMT — bộ máy đã nối xong, còn MỘT bước của chủ shop

### 7.1 Đã có gì

Bộ máy đối soát (`lib/returns/hmt-reconcile.ts` · `hmt-workbook.ts` · `sku-resolver.ts` ·
`scripts/hmt-return-reconcile.ts` · bảng `hmt_return_reconciliation`) đã **có sẵn trên production**
từ bản 13/09, migration 0080 đã áp.

Bản này thêm thao tác ops **`returns-hmt`**: máy chủ tự tải bảng tính, chạy đối soát (**mặc định
CHẠY THỬ**), rồi xoá tệp tạm — kể cả khi lệnh hỏng giữa chừng (`trap`). Tệp KHÔNG vào kho mã và
KHÔNG ở lại máy chủ.

Đã chạy thử đường đi (lần chạy #758): lệnh tới được VPS, chạy đúng nhánh, và dừng đúng chỗ với
thông báo rõ. Cơ chế đã thông; chỉ thiếu đầu vào.

### 7.2 Còn thiếu gì, và vì sao không tự làm

Đường dẫn tải bảng tính lấy từ **biến kho mã `HMT_WORKBOOK_URL`**, cố ý KHÔNG lấy từ ô `arg`.

Kho mã này **PUBLIC** (`AGENTS.md` mục 5). Ô `arg` hiện công khai trên trang của mỗi lần chạy, và
in một đường dẫn dạng "ai có link cũng xem được" vào đó là **công bố nó vĩnh viễn** — xoá lần chạy
cũng không rút lại được. Bảng tính hàng hoàn chứa mã vận đơn của khách thật. Đó là một quyết định
công bố dữ liệu, và nó thuộc về chủ shop, không thuộc về một lượt tự động hoá.

**Một thao tác, một lần:**

> GitHub → repo `hkt` → **Settings → Secrets and variables → Actions → tab Variables →
> New repository variable**
> · Name: `HMT_WORKBOOK_URL`
> · Value: đường dẫn **tải** `.xlsx`, dạng
> `https://docs.google.com/spreadsheets/d/<id>/export?format=xlsx`
> (bảng tính phải ở chế độ ai-có-link-cũng-xem-được — máy chủ tải bằng một lượt gọi không đăng nhập)

Sau đó: Actions → "Vận hành ERP trên VPS" → `returns-hmt`, ô `arg` **để trống** ⇒ chạy thử và in
đủ bảng kiểm đếm nguồn + bảng phân loại + ví dụ từng nhóm lỗi. Chỉ khi hai bảng đó đúng mới chạy
lại với `arg = --apply`.

### 7.3 Nền đối soát — đo sẵn để đọc kết quả chạy thử

| thứ | số đo (14/09/2026) |
|---|---|
| kiện `stage = RETURNED` | **870** |
| trong đó **chưa** ghi nhận về kho | **870** (không kiện nào đã ghi nhận) |
| vận đơn chiều về đứng riêng (`order_id` NULL) | 251 |
| dòng đã có trong `hmt_return_reconciliation` | **0** |
| phiếu kiểm hoàn đã có | **0** |
| mẫu mã | 90 · 90 có SKU · 84 có màu · 88 có size |
| **SKU khác nhau** | **62** trên 90 mẫu mã ⇒ **28 mẫu mã trùng SKU** |

Dạng dữ liệu khớp đúng dạng mô tả trong yêu cầu: sản phẩm mang `custom_id` `Q001` · `Q002` · `Q004`,
mẫu mã mang `color` (`Đỏ` · `Đen`) và `size` (`M` · `L` · `XL` · `2XL`), SKU dạng `002 DO L`. Nên
chuỗi `Đầm Q002 / Màu: Đỏ / Size: L` phân giải được tới **một** mẫu mã qua bộ ba (mã sản phẩm ·
màu · size) — đúng như hợp đồng đòi, không chỉ khớp `Q002`.

**28 mẫu mã trùng SKU là rủi ro đã biết**: dòng bảng tính trỏ vào một trong số đó sẽ ra
`AMBIGUOUS_SKU` và **không** được ghi. Đó là hành vi đúng — con số "chưa biết" tăng lên còn hơn ghi
nhầm mẫu mã.

Mã vận đơn: 2.095/2.108 có `vtp_order_number`, 2.094 chứa chữ `P`, chỉ 1 mã toàn số. Bộ tra cứu
khớp trên **cả** `vtp_order_number` lẫn `tracking_code`, gập bỏ dấu cách/gạch ở cả hai phía, và
**KHÔNG cắt hậu tố `1P1`** — vận đơn chiều về là kiện riêng (`AGENTS.md` mục 7), và trong bối cảnh
hàng về kho thì chính nó là kiện chở hàng hoàn.

### 7.4 Ranh giới sẽ không bị vượt khi chạy

* Lượt ghi duy nhất là **kiện đã về tới kho**. **Tồn kho không đổi một món nào.**
* Kiện đi tiếp vào hàng đợi ĐẾM ở `/inventory/returns`; người kho vẫn phải mở ra đếm và lập phiếu
  `RETURN` thì hàng mới vào tồn (`AGENTS.md` mục 10).
* Chỉ dòng `MATCHED` được ghi. `AMBIGUOUS_*` · `SKU_MISMATCH` · `QUANTITY_CONFLICT` ·
  `UNMATCHED_TRACKING` · `CONFLICT` **không** được ghi — ràng buộc `hmt_return_rec_written_check`
  chặn ở mức CSDL, không chỉ ở mức mã.
* Chống ghi trùng bám vào **nội dung dòng** (`idempotency_key`), không bám vào số dòng: chèn một
  dòng ở đầu tệp không biến cả lượt chạy lại thành một lượt ghi mới.

---

## 8. Cổng — chạy trên bản checkout SẠCH đúng SHA ứng viên

`git worktree add --detach ../wt-gate 3454fff` rồi chạy đủ (`AGENTS.md` mục 9):

| bước | kết quả |
|---|---|
| `npm ci` | sạch |
| `tests/repo-integrity.test.ts` | 930 tệp · 2.952 import · mọi đích đến đã vào kho |
| sổ migration | **0 mục mới** — bản này KHÔNG cần migration |
| `npx tsc --noEmit` | sạch |
| `npx eslint --max-warnings=0` | sạch |
| `npm test` | **TẤT CẢ KIỂM THỬ ĐẠT** |
| `npm run build` | Compiled successfully |

Hai cảnh báo `migration-number-decreasing` (0041 · 0042) đã có sẵn trên `origin/main` từ trước,
không phải nợ của bản này.

Kiểm thử thêm/sửa: `tests/cs-workqueue.test.ts` (khối 14 — 10 điểm của hợp đồng sao chép),
`tests/canonical-outcome.test.ts` (dòng mồ côi, cả chiều dọn lẫn chiều GIỮ LẠI),
`tests/contract-order-outcome.test.ts` (danh sách "đã gửi" chỉ còn một chỗ khai),
`tests/shipment-join-grain.test.ts` (khai miễn trừ kèm lý do).

---

## 9. Sau deploy — đo trên bản chạy thật

Deploy **#265** thành công lúc 02:48:12 UTC (14,6 phút). Bước "Kiểm tra HTTPS từ bên ngoài" của
chính workflow xác nhận `/api/health` trả `{"ok":true,"commit":"3454fff90e6f","branch":"main"}` —
**bản đang chạy đúng bằng bản đã qua cổng**, không phải "còn thở là được".

### 9.1 Hàng đợi CSKH — kiểm trên HTML THẬT của production

`smoke` (bản mới, có bảng `EXPECT`): **51/51 tuyến đạt · 0 lỗi ứng dụng · 0 sai quyền · 0 chậm ·
0 chưa kiểm**, cả lượt 214s.

Ba tuyến đi qua hợp đồng mới, tức HTML trả về từ máy chủ thật có chứa đúng các nhãn ấy:

| tuyến | dấu hiệu bắt buộc | kết quả |
|---|---|---|
| `/cs` | `aria-label="Sao chép SĐT"` | ✓ SUCCESS 514kB (94ms) |
| `/cs?view=theo-case` | `aria-label="Sao chép SĐT"` **và** `aria-label="Sao chép mã vận đơn"` | ✓ SUCCESS 574kB (87ms) |
| `/shipments` | `aria-label="Sao chép mã vận đơn"` | ✓ SUCCESS 1368kB (54ms) |

Môi trường của phiên này không mở được trình duyệt tới `erp.vnxcommerce.com`, nên đây là cách
kiểm "nút có thật trên bản chạy thật hay không" — và nó mạnh hơn một lần nhìn bằng mắt, vì từ nay
nó chạy lại được.

### 9.2 Đối chiếu KPI trước / sau

| | trước (02:32 UTC, script cũ) | sau (02:57 UTC, script mới) |
|---|---|---|
| tổng đơn | 2.732 | 2.736 |
| giao thành công | 493 | 494 |
| hoàn | 1.002 | 1.006 |
| đang giao | 197 | 192 |
| **chờ ĐVVC lấy** | **(không có ô — 106 đơn vô hình)** | **106** |
| chưa rõ | 13 | 13 |
| chưa gửi | 262 | 266 |
| huỷ | 659 | 659 |
| **cộng các phần** | **2.626 ≠ 2.732** | **2.736 = 2.736** ✓ |

Các ô nhúc nhích vài đơn là dữ liệu sống chạy trong 25 phút giữa hai lượt đo (4 đơn mới vào, vài
kiện đi tiếp), không phải công thức đổi. Tiền đi cùng chiều và cùng lượng: lên đơn +1.023.000đ,
giao thành công +499.000đ, COD chờ +499.000đ, thực nhận có chứng từ **y nguyên** 218.215.000đ.

Điểm đáng kể nhất: **bất biến `tổng = tổng các phần` KHÔNG ném lỗi** — đây là lần đầu ảnh chụp KPI
cộng đủ.

### 9.3 Dòng mồ côi đã sạch, và giá vốn đã chốt không bị đụng

| | trước | sau |
|---|---|---|
| dòng mồ côi | **266** | **0** |
| trong đó mang ghi nhận đã chốt (phải giữ lại) | 0 | 0 |
| dòng mang `logic_version` cũ | 266 | **0** |
| dòng bảng dẫn xuất / đơn khác nhau | 2.998 / 2.732 (đếm đôi 266) | **2.735 / 2.735** (khớp đúng) |

Bộ lập lịch (`outcome-materialize`, 5 phút một lượt) tự dọn — không cần một lệnh xoá tay nào trên
production.

**Giá vốn đã chốt còn nguyên**: 497 dòng có căn cứ, 488 dòng có số, tổng **77.802.000đ**. Kỳ đã
chốt bất biến, đo chứ không tin (`AGENTS.md` mục 21).

(2.737 đơn / 2.735 dòng: hai đơn vừa vào chưa tới lượt vật chất hoá — bình thường, lượt sau là hết.)

### 9.4 Cohort "Đã gửi" KHÔNG xê dịch một kiện nào

| | trước deploy | sau deploy |
|---|---|---|
| tổng vận đơn | 2.108 | 2.108 |
| **có chứng từ bàn giao (Đã gửi)** | **1.966** | **1.966** |
| ngoài cohort | 142 | 142 |

Bản này gom bốn bản sao của danh sách "đã gửi" về một chỗ. Nếu việc gom làm lệch dù một kiện thì
con số ở đây đã đổi. Nó không đổi.

---

## 10. Còn lại cho lượt sau

| việc | vì sao chưa làm |
|---|---|
| Chạy đối soát HMT trên tệp thật | thiếu biến `HMT_WORKBOOK_URL` — một thao tác của chủ shop (mục 7.2) |
| Giục ĐVVC lấy 80 kiện `AWAITING_PICKUP` quá 4 ngày (61,4 triệu COD treo) | việc vận hành, không phải việc mã nguồn |
| Đưa kịch bản QA trình duyệt vào kho mã | cần Playwright làm phụ thuộc phát triển — một quyết định riêng, không nhét kèm |

---

## 11. P1 DATA FOUNDATION — ĐÓNG

| điều kiện | bằng chứng |
|---|---|
| `carrier_handoff_at` chỉ từ chứng cứ ĐVVC thật sự cầm hàng | 106/106 kiện `AWAITING_PICKUP` có sự kiện gần nhất mang chặng `PENDING`; `CARRIER_HANDOFF_STAGES` không chứa `PENDING`/`CANCELLED` (mục 1.1) |
| `AWAITING_PICKUP` tách khỏi `IN_TRANSIT` trên bản chạy thật | 106 đơn, phiên bản luật 3, hiện ở cả bảng dẫn xuất lẫn ảnh chụp KPI (mục 1 · 9.2) |
| kết cục cuối không đổi ngoài chứng cứ | `DELIVERED` / `RETURNED` chỉ nhúc nhích theo dữ liệu sống; cohort "Đã gửi" 1.966 → 1.966 (mục 9.2 · 9.4) |
| "Đã gửi" có MỘT hợp đồng, mọi báo cáo dùng lại | `ELIGIBLE_SENT_OUTCOMES`; contract test quét `git ls-files` chặn gõ lại (mục 2) |
| bảng dẫn xuất không còn nợ | 0 dòng mồ côi, 0 dòng luật cũ, số dòng = số đơn (mục 9.3) |
| công cụ đối chiếu nhìn thấy đủ | ảnh chụp KPI có ô `cho_dvvc_lay` + bất biến tổng-bằng-tổng-các-phần (mục 4 · 9.2) |

**Không còn báo cáo nào dùng định nghĩa "Đã gửi" cũ.** Bốn chỗ gõ tay đã gom về một hằng số, và
bài kiểm nguồn chặn đường quay lại. **P1 = CLOSED.**

Việc duy nhất còn treo thuộc về ĐỐI SOÁT HMT (mục 7.2), không thuộc P1: nó cần một biến kho mã do
chủ shop khai, và đó là một quyết định công bố dữ liệu chứ không phải một bước kỹ thuật.

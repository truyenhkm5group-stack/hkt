# Bản phát hành 16/09/2026 — Viettel Post là nguồn sự thật cho `/shipments`

Audit trước khi sửa: `docs/audit-vtp-source-of-truth-2026-09-16.md`.
Migration: `0099_vtp_source_of_truth` (chỉ cộng thêm, không backfill).
Kiểm thử: `tests/vtp-source-of-truth.test.ts` + phần 0099 trong `tests/migration-upgrade-path.test.ts`.

---

## 0. Điều quan trọng nhất phải hiểu trước khi sửa tiếp

**Phần lớn hạ tầng đã đúng từ trước và bản này KHÔNG động vào nó.** Cụ thể, những thứ sau ĐÃ CÓ,
đừng viết lại:

* webhook có xác thực, lưu gói tin thô, chống trùng theo mốc ĐVVC, trả 200 ngay (`after()`);
* `shipment_events` là sổ append-only có `occurred_at` (mốc ĐVVC) tách khỏi `created_at` (mốc ERP);
* trạng thái hiện tại **được TÍNH RA từ lịch sử** (`deriveShipmentState`), sự kiện đến muộn không
  kéo lùi, và chỉ `materializeShipmentState()` được ghi `shipments.stage`;
* một bộ dịch duy nhất (`resolveVtpStatus`), cờ chiều đi/chiều hoàn (`leg_type`);
* care (`shipment_care`) và KPI (`ORDER_OUTCOME`) đã tách hẳn khỏi chiều ĐVVC;
* vận đơn `…1P1` là dòng riêng, vẫn được sync đầy đủ;
* nhập tệp XLSX/CSV đã có lõi dùng chung với luồng Gmail, đã idempotent, đã không hạ trạng thái.

Bản này bịt **năm lỗ** mà audit tìm được.

---

## 1. Chữ gốc của ĐVVC không bao giờ bị nuốt nữa

**Lỗ:** `deriveShipmentState()` lọc bỏ mọi sự kiện không dịch được — đúng, vì không đủ căn cứ thì
không được kết luận. Nhưng hệ quả là ảnh chụp trên màn hình giữ nguyên câu CŨ và **không có một
dấu hiệu nào**. Người trực đọc một trạng thái cũ và tưởng đó là tin mới nhất. Đường nhập tệp còn
tệ hơn: `applyVtpOrderList` có `if (… mapped.stage === "UNKNOWN") continue`, tức chữ gốc biến mất
hoàn toàn — không sự kiện, không dòng sổ, không con số nào.

**Sửa:**

| Thêm | Ở đâu | Làm gì |
|---|---|---|
| `shipments.vtp_raw_status_code / _name / _at / _mapped` | migration 0099 | lời khai THÔ, ghi ở MỌI lượt nạp theo mốc ĐVVC, độc lập với việc dịch được hay không |
| `vtp_status_registry` | bảng mới | mỗi câu ĐVVC từng nói = một dòng: mã, chữ nguyên văn, số lần, lần đầu / lần cuối, nguồn, một mẫu gói tin thô |
| `ghiLoiKhaiTho()` | `viettelpost/state.ts` | mới hơn thì thắng, theo mốc ĐVVC — gói tin đến muộn không kéo lùi |
| `ghiSoTrangThai()` | `viettelpost/registry.ts` | idempotent, cộng dồn bộ đếm, dịch lại mỗi lần gặp |

Ba chỗ hiển thị: banner tím trên `/shipments/[id]`, nhãn tím trong cột "Đồng bộ VTP" của danh sách,
và khối "trạng thái ERP chưa dịch được" trên `/integrations` (kèm **câu chữ** để biết dán gì vào
`VTP_STATUS`, và **lần đầu gặp** để phân biệt mã mới hôm nay với mã đã quen từ tháng trước).

**Ranh giới:** bốn cột `vtp_raw_*` và bảng sổ **không tham gia một phép tính nghiệp vụ nào** —
không `ORDER_OUTCOME`, không sổ kho, không tiền. Việc dịch vẫn chỉ có một chỗ. Cách sửa một mã lạ
vẫn là bổ sung vào `lib/constants/viettelpost.ts::VTP_STATUS`, **không** sửa dòng trong sổ.

## 2. Ảnh chụp nói rõ nguồn nào quyết định nó

`deriveShipmentState()` vẫn luôn tính ra `decidedBy` rồi **vứt đi**. Nay nó được ghi vào
`shipments.vtp_sync_source`, và `same` trong `materializeShipmentState()` có nó trong phép so —
nếu không thì dòng cũ (nguồn `NULL`) sẽ không bao giờ được điền.

Hiện ở: mô tả trang chi tiết (`nguồn: Webhook / Đối chiếu API / Nhập tệp / Người tra tay`) và cột
"Đồng bộ VTP" của danh sách.

## 3. Đối chiếu có lịch riêng cho từng kiện, theo ĐỘ NÓNG

**Lỗ:** bộ đối chiếu xếp hàng bằng `last_vtp_sync_at asc` — một kiện ĐANG ĐI GIAO (kết quả phải có
trong ngày) đứng ngang hàng với một kiện CHỜ LẤY HÀNG (chậm ba ngày là bình thường). Với trần 300
kiện mỗi lượt, kiện nóng chờ hết lượt của kiện nguội.

**Sửa:** `lib/constants/vtp-reconcile.ts` — hàm THUẦN, không đọc/ghi CSDL, chạy hai lần ra cùng kết
quả (có kiểm thử):

| Nhóm | Nhịp | Trạng thái con |
|---|---|---|
| NÓNG | 5 phút | đang đi giao · chờ phát lại · chờ xử lý · tồn · **chưa rõ** |
| ẤM | 30 phút | đã lấy hàng · đang vận chuyển · đang chuyển hoàn |
| NGUỘI | 4 giờ | chờ lấy hàng · lấy hàng thất bại |
| KHÔNG XẾP HÀNG | — | `is_final = true` |

*"Chưa rõ" là NÓNG, không phải nguội*: kiện ERP không đọc được trạng thái là kiện ERP KHÔNG BIẾT
GÌ — lấy sự thiếu hiểu biết của mình làm bằng chứng rằng không có gì đáng lo là đúng thứ luật
"CHƯA BIẾT không được in thành 0" cấm.

*Chỉ cờ `is_final` mới đưa kiện ra khỏi hàng đợi*, không phải trạng thái con: một kiện mang trạng
thái con `DELIVERED` mà `is_final` vẫn `false` là MÂU THUẪN trong chính dữ liệu của ERP, và mâu
thuẫn thì phải đi hỏi lại. (Nếu trả `null` cho nó thì nó bị đọc là "chưa xếp lịch" và nằm mãi ở
đầu hàng đợi — hỏi lại ở mọi lượt, mãi mãi.)

Lỗi lượt hỏi ⇒ **lùi dần** (nhân đôi, trần 24 giờ) và ghi `vtp_last_error`; lượt thành công **reset**
bộ đếm và xoá câu lỗi. Ba cột mới: `vtp_next_sync_at` · `vtp_sync_attempts` · `vtp_last_error`.

**Vì sao 5 phút chứ không 2:** bộ lập lịch gọi `vtp-tracking` mỗi 10 phút, nên nhịp 2 phút chỉ tồn
tại trên giấy. Muốn nhanh hơn phải hạ `SYNC_VTP_EVERY_MINUTES` — đổi lịch scheduler là việc phải
hỏi chủ shop (AGENTS.md §7), nên bản này **không** đổi.

## 4. Nhập tệp có bước CHẠY THỬ, và có cửa vào từ `/shipments`

Mở rộng trang `/import-vtp` đã có, **không** dựng trang thứ hai.

* `previewVtpOrderListFile()` — CHỈ ĐỌC, dùng lại đúng `detectVtpFile` + `matchVtpOrderList` mà
  đường ghi dùng, nên con số hai bước không thể lệch nhau vì hai luật khác nhau.
* Tám phán quyết, và **bốn trong số đó không phải lỗi**: `SAME` · `DUPLICATE_ROW` · `OLDER`
  (ERP cố ý không hạ trạng thái) · `UNKNOWN_STATUS` (chữ gốc vẫn vào sổ). Gộp chúng thành một
  nhãn "bỏ qua" là mời người dùng đọc một sự cố thành chuyện bình thường.
* `vtp_import_batches` — một dòng cho MỖI lượt, **kể cả chạy thử**: tên tệp, **checksum SHA-256 của
  nội dung** (Viettel Post đặt tên theo khoảng ngày nên cùng tên ≠ cùng nội dung), ai, lúc nào,
  bao nhiêu dòng, đổi bao nhiêu. Ghi trong `runVtpDataFileImport` chứ không trong server action, vì
  luồng Gmail không đi qua server action.
* Xem trước lần thứ hai ⇒ màn hình **nói thẳng** "tệp này đã được ghi lúc …", thay vì để người dùng
  ghi mù lần nữa.
* Nút "Nhập trạng thái từ tệp VTP" trên `/shipments` — đường cứu phải ở ngay chỗ người ta phát hiện
  ra vấn đề, không nằm ở chiều tiền.

## 5. Nhật ký một vận đơn: bốn chiều, không bao giờ trộn

`lib/queries/shipment-timeline.ts` + `lib/constants/shipment-timeline.ts` +
`components/shipment-activity-log.tsx`, hiện ở `/shipments/[id]`.

Gộp sáu bảng đang cùng kể chuyện về một kiện (`shipment_events`, `care_case_events`,
`care_business_actions`, `care_actions`, `carrier_action_requests`, `shipment_care`) và gắn nhãn
**CHIỀU** cho từng mốc:

```
CARRIER — Viettel Post nói. CHỨNG TỪ. Chỉ chiều này quyết định kiện hàng ở đâu.
HUMAN   — người của shop làm. Không cú bấm nào làm gói hàng di chuyển.
SYSTEM  — máy làm (đối chiếu, nhập tệp, mở/chốt ca, vỡ hạn).
DERIVED — ERP SUY RA (kết quả đơn theo luật tiền). Đứng CẠNH chứng từ, không đứng thay.
```

Mỗi mốc mang **CẢ HAI** mốc thời gian: lúc việc xảy ra (mốc ĐVVC) và lúc ERP biết. Khoảng cách
giữa chúng là thứ duy nhất nói được webhook có rơi hay không — nén thành một ô là xoá bằng chứng.

**Điều tuyệt đối không được làm:** một dòng `HUMAN` hay `DERIVED` không bao giờ sửa một dòng
`CARRIER`. Viettel Post ghi "Phát thành công" thì nhật ký chứng từ mãi mãi ghi "Phát thành công",
kể cả khi luật COD của shop kết luận đơn này là hoàn — kết luận ấy là một dòng `KPI_OUTCOME`
riêng, ở chiều `DERIVED`. Có kiểm thử khoá cả hai mặt: dòng nhật ký và bản ghi trong CSDL.

Kèm khối đo thời gian phản ứng tính **từ nhật ký** (không đọc cột đã lưu): tới lúc giao việc · tới
thao tác đầu · tới lúc chốt ca · số lần gọi / nhắn / liên hệ ĐVVC · hạn phản hồi đầu. `null` là
CHƯA XẢY RA và in ra dấu gạch, không in thành "0 phút". Vỡ hạn tính LÚC ĐỌC và **không bị xoá** khi
ca được xử lý muộn.

---

## 6. Những gì bản này KHÔNG sửa được, và vì sao

**Tài khoản API vẫn mù.** Vận đơn do Pancake tạo thuộc tài khoản Viettel Post khác; `VTP_POLL` vẫn
sinh 0 sự kiện cho chúng. Nhịp đối chiếu mới chỉ giúp **những vận đơn tra được** (`API_TRACKABLE`)
được hỏi đúng lúc; với `WEBHOOK_ONLY` thì webhook + nhập tệp vẫn là toàn bộ nguồn tin.

Điều kiện để hết mù (đã ghi ở `docs/vtp-capability-matrix.md`): trỏ
`VIETTELPOST_USERNAME / PASSWORD` về **tài khoản Viettel Post mà Pancake đang dùng** (cùng mã khách
hàng). Khi đó `tracking_capability` tự chuyển `API_TRACKABLE` và vận đơn tự vào lại vòng đối chiếu
— **không phải sửa một dòng mã nào**. Đây là quyết định của chủ shop (AGENTS.md §7), không phải
việc của một phiên làm việc.

**Nhịp scheduler giữ nguyên 10 phút.** Nhóm NÓNG khai 5 phút nhưng thực tế bị chặn ở 10 phút. Đổi
`SYNC_VTP_EVERY_MINUTES` phải hỏi chủ shop.

**Không backfill.** `vtp_raw_*` của vận đơn cũ để `NULL` = CHƯA BIẾT ĐVVC nói gì lần cuối. Suy
ngược từ `vtp_status_name` là bịa ra một lời khai với mốc thời gian không có thật (AGENTS.md mục
35). Chúng tự được điền ở lượt nạp tiếp theo.

---

# PHẦN II — ĐO TRÊN PRODUCTION SAU KHI PHÁT HÀNH (16/09/2026)

Deploy run #317, commit `3932a83`, hoàn tất 03:59:36Z. Mọi con số dưới đây lấy bằng ops `db-query`
(chỉ đọc) và ops `smoke` trên máy chủ thật.

## 1. Migration

| | trước | sau |
|---|---|---|
| migration đã áp | **96** (tới `0095`) | **100** (`0096`–`0099`) |

Deploy này mang theo **bốn** migration: ba của phiên lương (đã vào `main` từ trước, chưa deploy) và
`0099` của bản này. Đường nâng cấp đó đã được `tests/migration-upgrade-path.test.ts` chứng minh từ
một mốc CÒN CŨ HƠN production hiện tại.

Xác minh bằng chính lược đồ, không tin exit code: 8 cột `vtp_*` đúng kiểu và mặc định
(`vtp_raw_mapped` NOT NULL default true, `vtp_sync_attempts` NOT NULL default 0), hai bảng mới
(`vtp_status_registry` 18 cột, `vtp_import_batches` 20 cột), sáu chỉ mục.

## 2. Nhịp đối chiếu theo độ nóng — chạy đúng trên production

Sáu vận đơn thật, 15 phút sau deploy:

| chặng | mã | VTP lúc | ERP nhận | trễ | hỏi lại |
|---|---|---|---|---|---|
| DELIVERED | 501 | 04:03:23 | 04:03:59 | 37s | `NULL` — rời hàng đợi |
| DELIVERY_FAILED | 506 | 04:01:00 | 04:01:40 | 41s | +5′ (NÓNG) |
| RETURNING | 505 | 03:56:46 | 03:57:24 | 38s | +30′ (ẤM) |
| RETURNING | 502 | 03:55:37 | 03:56:13 | 37s | +30′ (ẤM) |
| DELIVERY_FAILED | 506 | 03:55:32 | 03:56:09 | 37s | +5′ (NÓNG) |
| DELIVERY_FAILED | 506 | 03:54:10 | 03:54:45 | 36s | +5′ (NÓNG) |

**Độ trễ thật VTP → ERP: 36–41 giây.** Đây là con số để nói "gần thời gian thực", không phải
"thời gian thực".

## 3. Tài khoản API: chẩn đoán dứt điểm

`vtp-capability --limit=30 --all` (chạy thử, không ghi):

```
tài khoản: ok=true · tên=HM******HMT shop · SĐT=******3448 · kho=33
tổng dò 30 · API đọc được 0 · API không thấy 30 · lỗi quyền 0 · lỗi khác 0
```

Token **hợp lệ** (đăng nhập được, liệt kê được 33 kho) nhưng `getOrderDetailV3` trả "không tồn tại"
cho **cả 30/30** mã vận đơn. Không phải lỗi xác thực, không phải giới hạn tần suất, không phải lỗi
mạng — **vận đơn do Pancake tạo thuộc một tài khoản Viettel Post khác.**

Phân loại toàn bảng: `API_TRACKABLE` **0** · `WEBHOOK_ONLY` **2.138** · `UNKNOWN_CAPABILITY` 13.

Hệ quả đã kiểm chứng: một lượt `vtp-tracking` báo *"Đã kiểm tra 0 vận đơn · 381 vận đơn đang chạy
chỉ nhận webhook — ngoài phạm vi tài khoản API"* ⇒ **0 lệnh gọi API lãng phí**.

## 4. Nhật ký vận đơn — một ca thật, 36 mốc

```
10/09 11:16  VTP        Nhận từ bưu tá - Bưu cục gốc      → PICKED_UP
11/09 01:41  VTP        Giao bưu tá đi phát               → OUT_FOR_DELIVERY
12/09 07:23  VTP        Tồn - Khách hàng nghỉ, không nhà  → DELIVERY_FAILED
12/09 07:23  HỆ THỐNG   mở ca chăm sóc
12/09 07:23  TỆP VTP    "Chờ phát lại"   ← ERP chỉ BIẾT lúc 13/09 03:50
13/09 03:54  NGƯỜI      Truyền HK · gọi khách, nói chuyện được
14/09 01:58  VTP        Thành công - Phát thành công      → DELIVERED
14/09 01:59  HỆ THỐNG   ca chốt · RESCUED_DIRECT
```

Mốc 12/09 07:23 ERP chỉ biết **20 giờ sau**, và biết **qua nhập tệp** — tức một gói webhook đã rơi
và được tệp vá lại. Nén hai mốc thành một là xoá mất chính bằng chứng đó.

Đo được từ nhật ký: tới thao tác đầu **20h31′** · tới lúc chốt **42h35′** ⇒ vỡ hạn phản hồi đầu, và
vỡ hạn đó **vẫn nằm trong lịch sử** dù ca sau đó được cứu.

Dòng nguồn `PANCAKE` mang `normalized_stage` **NULL** ⇒ không được quyền kết luận chặng, đúng thiết kế.

## 5. Luật tiền không sửa một chữ nào của ĐVVC

| kiểm | kết quả |
|---|---|
| 108 kiện mã 501 | `vtp_status_name` chỉ có **một** giá trị: "Thành công - Phát thành công" |
| **28 kiện mã 501 mà COD ≤ 100.000đ** | vẫn nguyên văn "Thành công - Phát thành công" |
| kiện 501 có tên khác | **0** |
| 267 vận đơn `…1P1` | **267/267 có sự kiện** · **0** gắn vào đơn gốc · RETURNED 251 / RETURNING 16 |

## 6. Một lỗi của bản này, tìm ra bằng chính production

Chạy thử lại đúng tệp vừa được ghi bốn phút trước, màn hình xem trước vẫn báo "18 dòng sẽ cập nhật"
trong khi đường ghi sẽ bỏ qua cả 18. Hai nguồn sai, đã sửa và khoá bằng kiểm thử:

* bộ chống trùng chỉ nhìn TRONG CÙNG MỘT TỆP nên mù với mọi lần nhập trước đó;
* CÙNG MỐC nhưng KHÁC CHẶNG bị đọc thành "mới hơn ERP", trong khi đường ghi gọi đó là
  `sameTimeConflict` và dừng lại cho người đối chiếu.

## 7. Một quả bom hẹn giờ KHÔNG thuộc bản này, đã tháo

`tests/order-duplicate.test.ts` ghim `NOW = 2026-09-15T10:00:00Z` rồi gieo dữ liệu tương đối so với
mốc ĐÓ, trong khi truy vấn lọc theo `now() - 48 giờ` thật. CI lúc 03:45Z còn xanh; 04:25Z đã đỏ, và
sau đó đỏ vĩnh viễn — tức **chặn mọi lần deploy**. Đã xác minh không phải do bản này (cất riêng thay
đổi của phiên rồi chạy lại vẫn đỏ) và đã sửa cho mốc chạy theo đồng hồ thật.

## 8. Mức đảm bảo — nói đúng, không nói quá

| nhóm | cơ chế | mức đảm bảo |
|---|---|---|
| tất cả vận đơn | webhook VTP | **gần thời gian thực**, đo được 36–41 giây, **khi** VTP gửi |
| `API_TRACKABLE` (hiện **0**) | webhook + đối chiếu định kỳ | gần thời gian thực + tự vá khi webhook rơi |
| `WEBHOOK_ONLY` (hiện **2.138**) | webhook + nhập tệp tay | webhook là nguồn chính; **không có** cơ chế tự vá |

Viettel Post **không cam kết** gửi đủ webhook — ca ở mục 4 là một bằng chứng gói tin đã rơi. Nên
**không được ghi "realtime 100%"** ở bất kỳ đâu. Với 2.138 vận đơn `WEBHOOK_ONLY`, đường vá duy nhất
hôm nay là nhập tệp tay, và đó là lý do bước chạy thử phải nói đúng sự thật.

---

# PHẦN III — VẬN HÀNH AN TOÀN ĐƯỢC VỚI MÔ HÌNH CHỈ-WEBHOOK (16/09/2026, chiều)

Phần I dựng nền: chữ gốc của ĐVVC không bị nuốt, ảnh chụp nói rõ nguồn, đối chiếu có lịch riêng,
nhập tệp có bước chạy thử, nhật ký bốn chiều. Phần II đo lại nền đó trên production và chốt một
chẩn đoán: **tài khoản API không đọc được 2.139/2.151 vận đơn của shop** — không phải lỗi token,
không phải giới hạn tần suất, mà là PHẠM VI TÀI KHOẢN.

Phần III trả lời câu hỏi tiếp theo: *sống với điều đó thì vận hành thế nào cho an toàn.*

## 1. Điều duy nhất phải hiểu trước khi đọc tiếp

**ERP không thể tự phát hiện một gói tin webhook CHƯA TỪNG TỚI.**

Sự vắng mặt của một gói tin không để lại dấu vết nào trong chính hệ thống đã không nhận được nó.
Không có truy vấn nào, không có cảnh báo nào, không có mức độ khéo léo nào trong mã nguồn ERP thay
đổi được điều đó. Chỗ hụt **chỉ lộ ra khi một nguồn ĐỘC LẬP nói lại cùng một sự việc** — và hôm nay
nguồn độc lập duy nhất là tệp "Danh sách vận đơn" tải tay từ viettelpost.vn.

Mọi thứ trong Phần III đều là hệ quả của câu trên.

## 2. Mỗi lần nhập tệp để lại một PHÉP ĐO

`lib/constants/webhook-gap.ts` · bảng `vtp_webhook_gaps` · migration `0100`

Trước bản này, nhập tệp chỉ vá dữ liệu rồi quên. Nay mỗi dòng tệp ghép được về một vận đơn ERP đã
biết đều đi qua `measureWebhookGap()` — hàm THUẦN, ba câu trả lời, và **hai trong số đó KHÔNG phải
lỗi của webhook**:

| Phán quyết | Nghĩa |
|---|---|
| `ERP_ALREADY_AHEAD` | ERP đã biết bằng hoặc mới hơn — webhook làm đúng việc |
| `TOO_FRESH` | Sự kiện quá mới (< 120 phút), gói tin có thể đang trên đường |
| *khoảng hụt* | ĐVVC ghi nhận từ lâu mà tới lúc nhập ERP vẫn chưa hề biết |

**Vì sao ngưỡng là 120 phút:** độ trễ THẬT của webhook Viettel Post đo được trên production là
**36–41 giây** (sáu kiện, 16/09). 120 phút là hơn 150 lần con số đó — đủ rộng để không một gói tin
bình thường nào bị kết tội, đủ hẹp để bắt mọi lần rơi thật (những lần rơi quan sát được tính bằng
chục giờ).

**Ca thật đã ghi lại được:** ĐVVC ghi "Chờ phát lại" lúc 12/09 07:23, ERP chỉ biết lúc 13/09 03:50 —
và biết QUA TỆP, không qua webhook. Khoảng hụt 20 giờ, trước bản này không có chỗ nào ghi lại.

Ba quyết định đáng nói:

- **Khoá duy nhất (vận đơn, mốc ĐVVC, câu chữ).** Nhập lại một tệp cũ KHÔNG đẻ ra lần rơi thứ hai.
  Đếm hai lần thì con số càng nhập càng sai — đúng chiều ngược với mục đích của phép đo.
- **Tỷ lệ khớp trả `null` khi mẫu < 30.** "1/1 hụt" không phải "webhook rơi 100%".
- **Dòng đo GOM LẠI và ghi SAU vòng lặp**, cố ý KHÔNG trong transaction đang vá vận đơn. Một lệnh
  lỗi bên trong transaction làm Postgres huỷ cả giao dịch, và `try/catch` không cứu được điều đó —
  nó chỉ giấu đi. Mất một dòng đo là mất một phép đo; mất một lượt vá là mất trạng thái một kiện hàng.

## 3. Hàng đợi "VTP cần đối chiếu" — `/shipments?view=reconcile`

Nó hỏi một câu **khác hẳn** hàng đợi care. Care hỏi *"kiện này có cần gọi khách không"*; đây hỏi
*"ERP có đang tin một điều không còn đúng không"*. Một kiện giao thành công từ hôm qua không cần
care, nhưng nếu ERP vẫn ghi "đang vận chuyển" thì nó cần đối chiếu.

Sáu lý do, xếp theo **độ chắc chắn của bằng chứng** (số nhỏ đứng trước):

1. Lỗi đối chiếu THẬT — mạng, phiên, quyền
2. ĐVVC nói câu ERP chưa dịch được
3. Dữ liệu tự mâu thuẫn
4. Webhook đã rơi gói tin (7 ngày gần nhất)
5. Đội đang care mà ĐVVC không nhúc nhích (> 24 giờ)
6. Im lặng quá ngưỡng của chặng

Im lặng đứng **cuối** vì nó là bằng chứng yếu nhất: phần lớn kiện im lặng thật sự không có gì xảy
ra, và để nó lên đầu sẽ chôn năm loại trên dưới hàng trăm dòng không đáng làm.

Bốn quyết định thiết kế:

- **Một kiện nhiều lý do là MỘT dòng.** Người trực mở viettelpost.vn đúng một lần cho một mã.
- **Ba lý do cuối chỉ có nghĩa với kiện ĐANG CHẠY.** "Im lặng" với một kiện đã giao xong là chuyện
  hoàn toàn bình thường. Ba lý do đầu vẫn là việc dù kiện đã chốt — chúng nói ERP đang KHÔNG HIỂU.
- **Mâu thuẫn đi cả hai chiều**: cờ "đã kết thúc" bật mà chặng đang chạy, VÀ chặng đã chốt mà cờ
  còn tắt (mục 48). Không gọi tên vế thứ hai thì kiện nằm mãi ở hàng đợi và không bao giờ rời ra.
- **KHÔNG có nút "đánh dấu xong".** Mỗi dòng là PHÉP CHIẾU (mục 19): nó rời hàng đợi khi ĐIỀU KIỆN
  sinh ra nó hết. Một nút đánh dấu cho phép giấu một kiện mà ERP vẫn đang nói sai về nó — đúng thứ
  hàng đợi này sinh ra để chặn. Thay vào đó là hai đường ra thật: chép mã sang viettelpost.vn, và
  nhập tệp về vá.

Hàng đợi **không gọi Viettel Post một câu nào** — nó dựng từ dữ liệu đã có, vì nó tồn tại chính vì
ERP không hỏi được.

### Đo ngay sau khi phát hành (production, 16/09 07:30Z)

| Lý do | Số kiện |
|---|---:|
| Lỗi đối chiếu (thật) | 0 |
| ĐVVC nói câu chưa dịch được | 0 |
| Dữ liệu tự mâu thuẫn | 0 |
| Đội care mà ĐVVC không nhúc nhích | 3 |
| Im lặng quá ngưỡng của chặng | 22 |
| **Tổng kiện cần đối chiếu** | **~25 / 2.157 kiện có mã (1,2%)** |

Con số này là bằng chứng cho quyết định dùng ngưỡng **`critical`** chứ không phải `stale`: ngưỡng
`stale` từng đếm được 182 kiện, và một danh sách 182 dòng không ai làm hết được thì cũng không ai mở
lần thứ hai.

## 4. Một lỗi của chính bản này, tìm ra bằng cách đo production

Bản đầu của hàng đợi xếp **18 kiện** ở HẠNG MỘT dưới nhãn "Lỗi đối chiếu". Đo lại thì cả 18 đều mang
**đúng một câu**:

> *"Tài khoản API Viettel Post không thấy vận đơn này (vận đơn do Pancake tạo thuộc tài khoản khác)"*

Đó không phải lỗi. Đó là **phán quyết PHẠM VI TÀI KHOẢN** — một sự thật cố định của 2.139/2.151
kiện mà ERP đã biết và đã thôi hỏi từ lâu, và nó đã có nhà riêng ở cột `tracking_capability`.
17/18 kiện còn đang dò dở (`vtp_sync_attempts = 2`) nên sẽ tự chuyển sang `WEBHOOK_ONLY`, trong khi
câu lỗi thì nằm lại vĩnh viễn.

Người trực mở hàng đợi, thấy dòng đầu tiên nói "API không đọc được kiện này", và **không có gì để
làm**. Một hàng đợi mà dòng đầu tiên không làm được gì là hàng đợi không ai mở lần thứ hai — tức là
nó phá đúng công dụng của chính nó.

Đã sửa: câu phán quyết ấy bị loại khỏi nhóm "lỗi đối chiếu" (`CAPABILITY_SCOPE_ERROR` +
`laLoiPhamViTaiKhoan()`), và có bài kiểm khoá lại cả hai chiều — phán quyết phạm vi bị loại, lỗi
mạng THẬT vẫn nổi lên.

## 5. Sức khoẻ webhook: bốn câu hỏi, không một ô "OK"

Trang Kết nối dữ liệu nay tách riêng bốn thứ, vì mỗi cái sửa ở một chỗ khác nhau:

| Câu hỏi | Sửa ở đâu |
|---|---|
| Có đang nhận không (15 phút · 1 giờ · 24 giờ) | cấu hình chuyển tiếp ở Pancake / Viettel Post |
| Nhận rồi có đọc được không | bảng mã trạng thái, mã nguồn xử lý |
| Có đúng thứ tự không | không phải lỗi; cao bất thường = đường truyền dồn ứ |
| Có rơi gói nào không | nhập tệp để vá, và nhập dày hơn |

**Nền so sánh lấy theo ĐÚNG KHUNG GIỜ ĐÓ, trung vị 14 ngày.** Shop không nhận đơn lúc 3 giờ sáng,
nên im lặng lúc 3 giờ sáng là bình thường còn im lặng lúc 10 giờ sáng thì không. Một ngưỡng phẳng sẽ
hoặc hét mỗi đêm, hoặc câm cả ngày. Trung vị chứ không phải trung bình: một ngày bão đơn kéo trung
bình lên và làm mọi giờ bình thường trông như đang hụt.

**Dưới 5 ngày nền ⇒ `UNKNOWN`, KHÔNG phải `HEALTHY`.** Lấy sự thiếu hiểu biết của mình làm bằng
chứng rằng không có gì đáng lo là biến CHƯA BIẾT thành 0 (mục 48).

## 6. Sổ lần nhập đọc lại được — `/import-vtp` và `/import-vtp/<id>`

`vtp_import_batches` đã ghi từ Phần I nhưng **chưa màn hình nào mở nó** — một cuốn sổ không ai mở
được thì tương đương không có sổ. Nay có danh sách 25 lượt gần nhất và trang chi tiết trả lời đúng
câu nó sinh ra để trả lời: *con số này tới từ lần nhập nào, ai bấm, tệp nào, và lần ấy thấy gì.*

Kèm theo: những khoảng hụt webhook mà CHÍNH lượt đó tìm ra (đây là lý do dòng sổ phải được **lập
TRƯỚC khi ghi** — lập sau thì các dòng ấy mồ côi), và các lượt khác mang **cùng checksum nội dung**
(không cùng tên: Viettel Post đặt tên tệp theo khoảng ngày).

**"Chưa đo" in riêng khỏi "đo rồi và không thấy gì".** Lượt chạy trước khi phép đo tồn tại giữ ba
con số ở 0, và in nó thành "không có khoảng hụt nào" là bịa một kết luận.

## 7. Ngưỡng im lặng sửa được, đặt ngay cạnh hậu quả

Ô chỉnh ngưỡng nằm **ngay dưới hàng đợi** chứ không ở một trang cấu hình riêng, vì người duy nhất
biết ngưỡng đang đúng hay sai là người vừa nhìn hàng đợi: thấy 300 kiện thì ngưỡng quá chặt, thấy 0
kiện suốt tuần trong khi webhook vẫn rơi thì ngưỡng quá lỏng.

Đây là đồng hồ **ĐO IM LẶNG** — khác hẳn đồng hồ **TUỔI CHẶNG** (`DWELL_SLA`, trang Tồn đọng). Giá
của việc thiếu cái sau đã đo được: 106 kiện chưa bao giờ rời kho, 61.451.999đ COD, mà **0/106** im
lặng quá ngưỡng — vì ĐVVC vẫn đều đặn gửi "phân công bưu tá" nên đồng hồ im lặng cứ bị đặt lại.

Ghi đè là **THƯA** ở `settings` (lưu cả bảng thì sửa mặc định trong mã sẽ không bao giờ tới được
production nữa), ba mốc phải **tăng dần**, và bộ sai thứ tự bị bỏ **nguyên cả chặng** — sửa hộ một ô
là đoán ý người nhập, và con số đoán ra sẽ đứng trên màn hình như thể có ai đó đã chọn nó.

## 8. Kiểm tra quyền tra cứu VTP — nút trên trang Kết nối dữ liệu

Câu chủ shop cần trả lời NGAY sau khi dán một credential mới. Không có nút này thì cách duy nhất để
biết là đợi bộ đối chiếu chạy — và nếu nó vẫn mù thì **không có gì nói ra cả**, vì "API không thấy
vận đơn nào" là một kết quả im lặng.

Ba điều nó KHÔNG làm:

1. **Không ghi gì** — không đổi `tracking_capability`, không đổi credential, không tạo sự kiện.
2. **Không in secret** — danh tính tài khoản in ở dạng đã che, đủ để trả lời "có phải cùng tài khoản
   với Pancake không", không đủ để dùng lại. Kho mã này PUBLIC.
3. **Không tạo hàng nghìn lượt gọi** — mẫu tối đa 20 kiện. Câu hỏi là NHỊ PHÂN nên 20 đã trả lời dứt
   khoát; dò cả 2.139 kiện để biết điều mà 20 kiện đã nói là tự gây một cơn bão request vô ích.

Kết luận phân biệt **ba** tình huống, vì cách sửa của mỗi cái là một việc khác: không gọi được API
(credential/mạng) · gọi được nhưng 0/n thấy (phạm vi tài khoản) · thấy được (bật lại đối chiếu API).
Gộp cả ba thành "kết nối thất bại" là đẩy người đọc đi sửa nhầm chỗ.

## 9. Kiểm kê 31 vận đơn `UNKNOWN_CAPABILITY` (production, 16/09 07:24Z)

| Nhóm | n | Đã dò | Có mã VTP | Từng có chứng từ ĐVVC | Kết luận |
|---|---:|---:|---|---|---|
| `RETURNING`, tạo 16/09, nguồn `VTP_IMPORT` | 17 | 2/3 lần | có | có | **Đúng luật** — chưa tới ngưỡng `CAPABILITY_PROBE_LIMIT`, lượt dò sau sẽ tự xếp thành `WEBHOOK_ONLY` |
| `DELIVERED`, Pancake nói "Đã nhận", tạo 04/09 | 9 | 0 | **không** | **không** | Không có mã ⇒ không tra được ở đâu cả |
| `RETURNED`, Pancake nói "Đã hoàn", tạo 04/09 | 4 | 0 | **không** | **không** | như trên |
| `RETURNED`, tạo 16/09 | 1 | 0 | có | có | chưa dò lần nào |

**13 kiện ở hai nhóm giữa là phát hiện đáng nói.** Chúng không có mã vận đơn, **chưa bao giờ** có
một sự kiện Viettel Post nào (webhook lẫn nhập tệp), và không có chứng từ bảng kê. Chặng
`DELIVERED` / `RETURNED` của chúng đến **hoàn toàn từ Pancake**.

Đây là `TRUE_UNKNOWN` theo mục 45: **không chứng cứ nào tồn tại**, nên GIỮ NGUYÊN. `UNKNOWN_CAPABILITY`
là câu trả lời ĐÚNG cho chúng — không phải `WEBHOOK_ONLY` (không có mã thì webhook cũng không tới
được), không phải `API_TRACKABLE`. Và ba màn hình đều xử lý đúng mà không cần sửa gì:

- hàng đợi đối chiếu **loại** chúng (không có mã thì không tra được ở đâu — đó là lỗ hổng dữ liệu,
  thuộc hàng đợi care);
- bảng năng lực tra cứu ở trang Kết nối dữ liệu **loại** chúng (chỉ đếm kiện chưa kết thúc có mã);
- `ORDER_OUTCOME` **không** kết luận chúng là giao thành công, vì không có mã cuối của ĐVVC và không
  có chứng từ tiền (mục 2 — không bao giờ coi `stage = 'DELIVERED'` hay Pancake "Đã nhận" là giao
  thành công).

## 10. Sổ đăng ký trạng thái ĐVVC (production, 16/09 07:27Z)

**20 trạng thái, tất cả đều đã dịch được. Không một mã lạ nào.**

Sổ giữ cả hai không gian khoá: mã số từ webhook (`102` · `501` · `502` · `505` · `506` · `507` ·
`500` · `400` · `300` · `202`) và khoá chữ đã bỏ dấu từ tệp nhập (`text:giao thanh cong` 571 lần ·
`text:da tra` 367 · `text:dang chuyen hoan` 75 · `text:dang van chuyen` 65 · …). Mốc "lần đầu gặp"
đều là 16/09 — đúng như thiết kế: sổ **bắt đầu đếm từ khi nó tồn tại**, không backfill.

Một chi tiết đáng giữ: mã `202` mang câu chữ *"Sửa phiếu gủi"* — Viettel Post gõ sai chính tả trong
chính hệ thống của họ. Sổ giữ **nguyên văn**, không sửa hộ. Đó là điểm của một sổ quan sát.

## 11. Nhật ký vận đơn trên 24 kiện thật (production, 16/09 07:29Z)

Ba kiện mới nhất của **mỗi** chặng trong tám chặng:

| Chặng | Mốc chứng từ ĐVVC | Đợt care | Mốc care | Có lời khai thô |
|---|---:|---:|---:|---:|
| `CANCELLED` | 260 | 3 | 6 | 0 |
| `DELIVERED` | 63 | 3 | 7 | 3 |
| `DELIVERY_FAILED` | 62 | 3 | 5 | 3 |
| `IN_TRANSIT` | 71 | 0 | 0 | 3 |
| `OUT_FOR_DELIVERY` | 82 | 1 | 2 | 2 |
| `PENDING` | 49 | 3 | 7 | 0 |
| `RETURNED` | 5 | 0 | 0 | 0 |
| `RETURNING` | 71 | 2 | 3 | 3 |

Mọi chặng đều có chứng từ ĐVVC thật; sáu trong tám chặng có cả chiều người (care). `vtp_raw_*` có
mặt ở 14/24 kiện — đúng như thiết kế: cột lời khai thô **chỉ điền từ lượt nạp sau khi 0099 chạy**,
KHÔNG backfill, vì suy ngược một lời khai từ tên trạng thái là bịa ra một câu ĐVVC chưa từng nói.

## 12. Những gì bản này KHÔNG làm, và vì sao

- **Không đổi một credential nào.** Chưa có credential đúng thì không có gì để đổi. Yêu cầu chính
  xác nằm ở mục 13 dưới đây.
- **Không tăng nhịp hỏi API cho 2.139 kiện `WEBHOOK_ONLY`.** Tài khoản hiện tại không đọc được
  chúng; hỏi dày hơn chỉ là hỏi cùng một câu hỏi vô ích nhiều lần hơn.
- **Không xoá, không hạ trạng thái, không backfill** một dòng dữ liệu production nào.
- **Không tự lấy token từ trình duyệt, Pancake hay bất kỳ đâu.**
- **Không dựng lại `capability` cho 31 kiện `UNKNOWN_CAPABILITY`.** 18 kiện sẽ tự xếp đúng ở lượt dò
  sau; 13 kiện còn lại không có mã nên không có gì để dò — và ép chúng thành `WEBHOOK_ONLY` là
  khẳng định một điều không chứng minh được.
- **Không kiểm tra giao diện bằng MẮT trên production.** Lá chắn `smoke` mở thật cả ba màn hình mới
  bằng một phiên đăng nhập hợp lệ trên dữ liệu thật và báo **67/67 đạt · 0 lỗi ứng dụng** (16/09
  08:11Z) — tức chúng dựng được, truy vấn chạy được, không màn nào vượt ngưỡng 2 giây. Nhưng smoke
  đo *"trang có dựng được không"*, **không** đo *"trang có trông đúng không"*: một cột lệch, một
  nhãn khó đọc, một nút đặt sai chỗ đều lọt qua nó. Nhìn bằng mắt vẫn là việc đầu tiên của chủ shop.

## 13. Cần gì để bật `API_TRACKABLE` — yêu cầu chính xác

Khi có credential đúng, **không phải sửa một dòng mã nào**: mỗi vận đơn tự khai năng lực của nó và
lượt dò sau sẽ tự xếp lại. Bốn thứ cần:

1. **Loại credential:** tài khoản API đối tác Viettel Post — `VIETTELPOST_USERNAME`,
   `VIETTELPOST_PASSWORD`, và `VIETTELPOST_API_KEY` (nếu tài khoản dùng khoá riêng).
2. **Tài khoản nào:** **đúng tài khoản Viettel Post mà Pancake đang dùng để tạo vận đơn.** Đây là
   điểm mấu chốt — tài khoản ERP đang dùng đăng nhập được và đọc được 33 kho, nhưng nó không nhìn
   thấy vận đơn nào của shop vì những vận đơn đó thuộc tài khoản khác. Cách kiểm tra nhanh: mã khách
   hàng của tài khoản khai trong Pancake (Cấu hình → Giao vận → Đối tác vận chuyển → VTP) phải TRÙNG
   với mã khách hàng nút "Kiểm tra quyền tra cứu VTP" in ra.
3. **Thử bằng mã nào:** bất kỳ mã vận đơn nào đang chạy của shop — nút kiểm tra tự lấy 20 mã mới
   nhất. Không cần chọn tay.
4. **Nhập ở đâu:** ERP **không có ô nhập credential trên giao diện** (cố ý — secret không đi qua
   trình duyệt). Chúng nằm ở tệp `.env` trên VPS, hoặc ở GitHub Actions Secrets rồi deploy lại.

Sau khi đổi: bấm **Kiểm tra quyền tra cứu VTP** trên trang Kết nối dữ liệu. Nếu nó báo đọc được,
chạy ops `vtp-capability` với `--all --apply` để xếp lại năng lực cho toàn bộ vận đơn — bộ đối chiếu
sẽ tự bắt đầu hỏi API cho những kiện đã xếp được.

## 14. Lá chắn smoke phủ luôn ba màn hình mới

Lượt smoke ngay sau khi phát hành báo 65/65 đạt — nhưng **không tuyến nào trong danh sách chạm tới
ba màn hình vừa thêm**, nên con số đó không nói gì về chúng. Đã bổ sung:

- `/shipments?view=reconcile` vào danh sách tĩnh — tuyến nặng nhất của module (quét toàn bộ kiện có
  mã VTP rồi chạy sáu vị ngữ) và là tuyến duy nhất đọc `vtp_webhook_gaps`;
- `/import-vtp/<id>` **phân giải lúc chạy** từ lần nhập gần nhất, cùng lý do đã ghi cho
  `/shipments/[id]`: không mã nào gõ cứng được mà vẫn đúng sau một tuần.

Chưa có lần nhập nào ⇒ bỏ qua im lặng, không làm đỏ lần deploy: đây là lá chắn hiệu năng, không
phải bài kiểm dữ liệu.

Kết quả lượt sau khi bổ sung (16/09 08:11Z): **67/67 đạt · 0 lỗi ứng dụng · 0 sai quyền**, và không
màn hình mới nào nằm trong danh sách 16 màn chậm.

## 15. Mức đảm bảo — nói đúng, không nói quá

| Điều | Mức | Căn cứ |
|---|---|---|
| Migration 0100 đã áp trên production | **ĐO ĐƯỢC** | 101 migration, bảng + 3 cột có mặt, 16/09 07:24Z |
| Sổ khoảng hụt bắt đầu RỖNG, không backfill | **ĐO ĐƯỢC** | `count(*) = 0` ngay sau deploy |
| Phép đo khoảng hụt chạy đúng trên đường nhập tệp | **KIỂM THỬ** | khối 11, `tests/vtp-source-of-truth.test.ts` (PGlite) |
| Nhập lại tệp cũ không đếm hai lần | **KIỂM THỬ** | khối 11, khoá duy nhất |
| Hàng đợi đối chiếu ra ~25 kiện / 2.157 | **ĐO ĐƯỢC** | SQL dựng lại đúng luật, 16/09 07:30Z |
| Phán quyết phạm vi tài khoản bị loại khỏi "lỗi" | **KIỂM THỬ** | khối 13, cả hai chiều |
| 20 trạng thái ĐVVC, 0 mã lạ | **ĐO ĐƯỢC** | `vtp_status_registry`, 16/09 07:27Z |
| 13 kiện không mã, không chứng từ ĐVVC nào | **ĐO ĐƯỢC** | 16/09 07:26Z và 07:28Z |
| Tỷ lệ khớp webhook thật sự là bao nhiêu | **CHƯA BIẾT** | mẫu = 0; chỉ lớn lên khi có người nhập tệp sau khi 0100 chạy |
| Ba màn hình mới dựng được trên production, < 2s | **ĐO ĐƯỢC** | smoke 67/67 đạt · 0 lỗi ứng dụng · `/import-vtp/<id>` 88ms, 16/09 08:11Z |
| Ba màn hình mới TRÔNG đúng | **CHƯA KIỂM** | smoke đo "dựng được", không đo "trông đúng"; phiên này không mở được trình duyệt |

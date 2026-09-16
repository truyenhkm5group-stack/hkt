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

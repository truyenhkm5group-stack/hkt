# Hợp đồng lớp QUAN SÁT LÝ DO HOÀN

*Ngày 14/09/2026. Bổ sung cho `docs/business-rules/ORDER_OUTCOME.md` — tệp đó trả lời **đơn này có
hoàn không**, tệp này trả lời câu SAU đó: **vì sao**.*

Lớp này KHÔNG được định nghĩa lại "hoàn". Tập vận đơn hoàn do `ORDER_OUTCOME` quyết định và truyền
vào. Viết lại điều kiện hoàn ở đây là tạo ra bộ số thứ hai cho cùng một câu hỏi.

---

## 1. Vấn đề đã đo được

Đo trên production 14/09/2026:

| Nguồn | Trạng thái trước bản này |
|---|---|
| `shipment_return_reasons` (người xác nhận) | **0 dòng** |
| `shipments.vtp_reason_code` (mã lý do ĐVVC) | **NULL trên toàn bộ vận đơn** |
| Phiếu kiểm hàng hoàn của kho | không có ghi chú nào |
| Phiếu đổi trả Pancake | không có dòng nào mang trạng thái |
| Chữ trạng thái ĐVVC | nguồn DUY NHẤT đang chạy |

Nghĩa là 100% lý do hoàn trên báo cáo suy từ chữ trạng thái Viettel Post, suy LẠI TỪ ĐẦU ở mỗi lượt
mở trang, và chữ ấy không được lưu ở đâu như một quan sát có nguồn và có mốc. Mọi lý do KHÔNG PHẢI
của ĐVVC — khách nhắn qua chat, nhân viên gọi hỏi, kho mở kiện ra xem — có thật trong CSDL nhưng
không có đường nào vào báo cáo.

---

## 2. Hình dạng: một dòng cho một lần ai đó NÓI

```
chữ gốc   →   lý do chuẩn hoá   →   nhóm lý do
(bất biến)      (suy khi đọc)       (suy khi đọc)
```

`return_reason_observations` là bảng **CHỈ THÊM**. Một dòng = một lần một nguồn nói ra điều gì về
vì sao kiện hoàn: chữ nguyên văn, nguồn, mốc thời gian, kiện/đơn liên quan, người ghi (bằng
`users.id` — AGENTS.md mục 34).

Dòng ấy KHÔNG BAO GIỜ bị sửa. Phân loại và nhóm được suy lúc **ĐỌC**, nên đổi cách xếp nhóm về sau
là đổi một bảng tra, không phải chạy `UPDATE` lên lịch sử.

Hai bảng, hai câu hỏi khác nhau, không thay được cho nhau:

| Bảng | Trả lời | Hình dạng |
|---|---|---|
| `shipment_return_reasons` | "giờ shop kết luận thế nào" | một kiện MỘT dòng, đè lên được |
| `return_reason_observations` | "ai đã nói gì, lúc nào" | chỉ thêm, không bao giờ sửa |

---

## 3. Tám nguồn, và ranh giới thẩm quyền

`lib/constants/return-reason-source.ts`. Mỗi nguồn khai ba điều: thứ hạng, người hay máy, và **có
được kết luận lỗi shop hay không**.

| Nguồn | Hạng | Người? | Kết luận lỗi shop? |
|---|---|---|---|
| `HUMAN_CONFIRMED` | 100 | ✓ | ✓ |
| `WAREHOUSE_INSPECTION` | 80 | ✓ | ✓ |
| `CARE_NOTE` | 60 | ✓ | ✓ |
| `CS_NOTE` | 55 | ✓ | ✓ |
| `CARRIER_CODE` | 40 | ✗ | ✗ |
| `CARRIER_TEXT` | 30 | ✗ | ✗ |
| `PANCAKE_RETURN` | 25 | ✗ | ✗ |
| `PANCAKE_ORDER_NOTE` | 10 | ✗ | ✗ |

**Luật không thương lượng.** Viettel Post và Pancake là hai hệ NGOÀI shop: họ thấy kiện đi tới đâu,
không thấy vải dày hay mỏng. Một bưu tá gõ *"khách không hài lòng về sản phẩm"* là một QUAN SÁT về
điều khách nói — không phải shop đã xác minh vải xấu. Chữ ấy xếp vào `CUSTOMER_REFUSED` (khách từ
chối), KHÔNG BAO GIỜ vào `QUALITY_*`.

Khi chữ của nguồn ngoài shop khớp một lý do chỉ-người-mới-biết, ca ấy rơi về `UNKNOWN` **kèm cờ
`blockedBySource`** — không bị bỏ qua im lặng, vì bỏ qua thì nó trông y hệt kiện chưa ai nói gì.

Khoá ở mã nguồn: `tests/kpi-clarity.test.ts` (mức bảng luật) và
`tests/return-reason-observation.test.ts` (mức hàm).

---

## 4. Ba trạng thái độ phủ, không hai

| Trạng thái | Nghĩa | VIỆC PHẢI LÀM |
|---|---|---|
| `CLASSIFIED` | xếp được vào danh mục | không phải việc |
| `RAW_ONLY` | CÓ chữ thật, chưa xếp được | mở chữ ra đọc rồi chọn lý do — làm được ngay hôm nay |
| `NO_EVIDENCE` | chưa ai nói một chữ nào | phải ĐI HỎI: gọi khách, hoặc để kho ghi lúc mở kiện |

Gộp hai cái sau thành "chưa xác định" xoá mất khác biệt giữa *"đã có người nói, ta chưa đọc"* và
*"chưa ai nói gì"* — hai việc đi tới hai đội khác nhau, và việc dễ làm nhất biến mất trong một con
số trông như bế tắc.

Màn hình `/reports/returns` hiện đủ ba ô kèm câu việc-phải-làm. Độ phủ dưới 2/3 thì hiện thêm cảnh
báo: **một nhóm lý do hiện 0 KHÔNG có nghĩa là không có trường hợp nào** — ca của nhóm đó có thể
đang nằm trong phần chưa xác định.

---

## 5. Chữ nào được ghi thành quan sát

`dangGhiQuanSat(text, source, vtpCode)` — **`source` bắt buộc**, cố ý.

Luật GIỮ KHI CÓ CĂN CỨ (không phải "giữ mọi thứ trừ vài câu bước đi"):

1. xếp được ngay ⇒ đúng là một lý do;
2. mang dấu hiệu ngoại lệ của ĐVVC (`Tồn - …`) ⇒ họ đang khai một ngoại lệ, dù ta chưa đọc được;
3. do NGƯỜI của shop gõ ⇒ không ai gõ tay một bước đi vào ô ghi chú;
4. có mã lý do có cấu trúc.

Bộ lọc bước đi (`RETURN_STEP_NOT_REASON`) đứng TRƯỚC tất cả.

**Vì sao đảo chiều.** Bản nháp giữ mọi chuỗi dài hơn 5 ký tự trừ ba câu bước đi đã biết. Trên dữ
liệu thật, hành trình một kiện có hàng chục dòng và gần hết là bước đi — KHÔNG câu nào khớp ba mẫu
ấy. Để nguyên thì mỗi bước đi thành một dòng "có chứng từ, chưa xếp được", và màn hình bảo nhân
viên đi đọc hàng nghìn ca không có gì để đọc. Một hàng đợi toàn việc giả là hàng đợi bị bỏ, kéo
theo cả những việc thật nằm cùng chỗ.

---

## 6. Chọn quan sát khi một kiện có nhiều

Ba bước, tách bạch:

1. chọn quan sát hạng cao nhất **trong số những cái XẾP ĐƯỢC** (bằng hạng ⇒ muộn hơn thắng);
2. không cái nào xếp được ⇒ **kết luận cũ Ở LẠI**;
3. chỉ khi chỗ đó thật sự trống, quan sát thô mới lên tiếng ⇒ `RAW_ONLY`.

**Vì sao bước 2 tồn tại.** Đo được: 98/103 ghi chú chăm sóc kiện không xếp được ("đã gọi lần 2",
"khách hẹn chiều mai") — đúng và bình thường, vì ghi chú chăm sóc nói về TIẾN TRÌNH, không phải
nguyên nhân. Mà ghi chú chăm sóc xếp hạng CAO HƠN chữ ĐVVC. Cho hạng cao ghi đè vô điều kiện thì
một kiện mà Viettel Post đã nói rõ *"Khách hàng nghỉ, không có nhà"* bị câu *"đã gọi lần 2"* đè lên
và rơi về chưa xác định — tức là **thêm dữ liệu vào lại làm GIẢM độ phủ**, và không ai đi tìm lỗi
đó vì con số vẫn ra và vẫn trông hợp lý.

Thẩm quyền vẫn là thẩm quyền: quan sát của NGƯỜI mà xếp được vẫn đè lên chữ ĐVVC. Điều bị chặn là
thẩm quyền cao dùng để **XOÁ**, chứ không phải để **NÓI**.

Bất biến này khoá ở `tests/return-reason-observation.test.ts` (ca `rro-4`).

---

## 7. Ba đường ghi, MỘT cửa

| Đường | Khi nào | Nguồn ghi ra |
|---|---|---|
| Webhook Viettel Post (`lib/integrations/viettelpost/sync.ts`) | gói tin mang lý do/ghi chú | `CARRIER_TEXT` |
| Người xử lý bấm (`lib/actions/return-reason.ts`) | bàn care · danh sách vận đơn · chi tiết vận đơn | `HUMAN_CONFIRMED` |
| Lượt rút từ dữ liệu cũ (`scripts/return-reason-backfill.ts`) | chạy tay, có chạy thử | bảy nguồn |

Cả ba đi qua `ghiQuanSat()` trong `lib/returns/reason-observe.ts`. **Khoá chống trùng dựng ở đúng
một chỗ** — hai đường dựng khoá hai kiểu thì cùng một sự kiện nằm hai dòng, và mọi phép đếm độ phủ
nói quá lên mà không ai thấy, vì cả hai dòng đều trông hợp lệ. Có kiểm thử quét mã nguồn.

Khoá là NỘI DUNG: `kiện · nguồn · mốc · vân tay chữ`. Viettel Post thử lại webhook tối đa 5 lần, và
lượt rút chạy lại sau khi bổ sung nguồn mới — cả hai đều phải là không-thao-tác.

Đường ghi tay **không có nhánh nào nhận lý do dạng chữ tự do**: lý do chọn từ danh mục đóng, ghi
chú chi tiết vẫn có nhưng là bối cảnh cho người đọc, không phải đầu vào của phép đếm (cùng ranh
giới mà AGENTS.md mục 46 đã dựng).

Lỗi ghi quan sát bị nuốt có chủ đích ở đường webhook: Viettel Post đòi HTTP 200 trong dưới một
giây, và mất một dòng ghi chú không phải mất một vận đơn.

---

## 8. Backfill

`scripts/return-reason-backfill.ts`, chạy qua ops `reason-backfill`.

- **Mặc định CHẠY THỬ.** Bản chạy thử in ra đúng những gì sẽ ghi, theo từng nguồn — nên nó vừa là
  bản kiểm kê nguồn dữ liệu vừa là bản xem trước.
- `--apply` mới ghi; chạy lại bao nhiêu lần cũng được.
- **KHÔNG nằm trong migration.** Migration chạy một lần, im lặng, không xem trước được và không
  chạy lại được. Migration `0087` chỉ tạo bảng rỗng.

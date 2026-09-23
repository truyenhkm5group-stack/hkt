# Ma trận năng lực Viettel Post cho vận hành care (audit 11/09/2026)

Nguồn: tài liệu API đối tác Viettel Post v2 (`partner.viettelpost.vn/v2`) mà ERP đang gọi
(`lib/integrations/viettelpost/client.ts`), và đo trên production: **tài khoản API của ERP đọc được
0/565 vận đơn đang chạy** (`tracking_capability = WEBHOOK_ONLY`). Không giả định API tồn tại: mỗi
dòng ghi bằng chứng.

---

## ⚠ SỬA MỘT KẾT LUẬN SAI — 23/09/2026

Bản 11/09 viết rằng *"vận đơn do Pancake tạo thuộc tài khoản Viettel Post khác"*. **Đó là một SUY
ĐOÁN từ con số 0/565, không phải một điều đã đo.** Nó được chép lại vào bốn tệp mã nguồn và ba báo
cáo, rồi dùng như sự thật — và nó đã đẩy chủ shop đi tìm một tài khoản không tồn tại.

Đo lại ngày 23/09/2026, cùng tài khoản đang khai trong `.env`:

| Phép đo | Kết quả |
|---|---|
| `user/info` | **OK** — HMT shop · 0886833448 · `userId 18757294` |
| `user/listInventory` | **OK** — 34 kho |
| Webhook Viettel Post gửi tới ERP | `ORDER_NUMBER: PKE1525978709` — chính VTP gọi vận đơn bằng mã đó |
| `order/getOrderDetailV3` với ĐÚNG mã đó | `data: []` |
| `order/order-filter` 14 ngày, cả 34 kho | `data: []` |
| `order/list-data-push-his` | `HTTP 403 Forbidden` |
| **viettelpost.vn (web), cùng tài khoản** | **THẤY ĐỦ** — 598 đơn trong 17–23/09, mã vận đơn `PKE1528446444…` |

Chủ shop xác nhận đây đúng là tài khoản Viettel Post họ dùng hằng ngày. Nên kết luận đúng, hẹp hơn
hẳn kết luận cũ:

> **Cùng một tài khoản: WEB thấy đủ vận đơn, API đối tác trả rỗng cho mọi đường đọc đơn.**
> Vì sao thì **CHƯA BIẾT** — đó là câu hỏi đang chờ Viettel Post trả lời, không phải một sự thật đã
> chứng minh về quyền sở hữu tài khoản.

Giả thuyết còn sống (chưa cái nào được xác nhận): API đối tác chỉ trả về đơn do CHÍNH tư cách đối
tác đó tạo, trong khi đơn ở đây do Pancake tạo hộ; hoặc tài khoản chưa được bật quyền đọc đơn ở
tầng API. Cả hai đều chỉ Viettel Post trả lời được.

**Cho tới khi có câu trả lời, mọi dòng trong ma trận dưới đây vẫn đúng về HÀNH VI** — lệnh gửi lên
bị từ chối, ERP rơi về `MANUAL_REQUIRED`, và người trực làm tay trên web rồi bấm "Đã làm tay". Chỉ
phần NGUYÊN NHÂN là bị sửa.

**Không tự động hoá đường web** (`AGENTS.md` mục 5: hướng tự đăng nhập viettelpost.vn đã bị loại bỏ).

*Ba báo cáo có ngày tháng (`audit-vtp-source-of-truth-2026-09-16.md`,
`release-2026-09-16-vtp-source-of-truth.md`, `smart-logistics-freshness-report.md`) giữ nguyên câu
chữ cũ: chúng là biên bản của điều người ta TIN vào thời điểm đó, và viết lại quá khứ thì lần sau
không ai học được gì từ nó.*

---

Mã nguồn: `lib/care/carrier-capabilities.ts` (ma trận tĩnh + hàm `carrierCapabilityFor` trả trạng
thái theo credential × kiện × chặng). Tạo vận đơn trực tiếp (Direct VTP shipment creation) **vẫn
PENDING**, không nằm trong ma trận.

## Trạng thái

| Trạng thái | Nghĩa |
|---|---|
| `SUPPORTED` | API có, credential sở hữu kiện, chặng cho phép ⇒ gửi thẳng, có vòng đời PENDING → SENT → ACKNOWLEDGED → SUCCESS/FAILED |
| `PERMISSION_MISSING` | API có nhưng tài khoản không sở hữu kiện (WEBHOOK_ONLY) hoặc chưa cấu hình ⇒ `MANUAL_REQUIRED`, làm tay trên web, ERP ghi vết |
| `UNKNOWN` | API có, chưa dò xong năng lực với kiện (UNKNOWN_CAPABILITY) ⇒ thử gửi; lỗi quyền ⇒ `UNSUPPORTED` cho lần đó |
| `WEB_ONLY` | Viettel Post không có API cho việc này — chỉ web / bưu cục |
| `UNSUPPORTED` | Viettel Post không nhận ở chặng này |

## Hành động có API

| Hành động | API | Chặng cho phép | Bằng chứng | Production hôm nay |
|---|---|---|---|---|
| Phát tiếp (`redeliver`) | `order/UpdateOrder` TYPE 3 | DELIVERY_FAILED · OUT_FOR_DELIVERY · IN_TRANSIT · PICKED_UP | tài liệu v2; chưa có lần gọi thật thành công | PERMISSION_MISSING (565/565) |
| Duyệt hoàn (`approve-return`) | `order/UpdateOrder` TYPE 2 | như trên | tài liệu v2 | PERMISSION_MISSING |
| Gửi lại (`resend`) | `order/UpdateOrder` TYPE 5 | RETURNING · RETURNED · CANCELLED · DELIVERY_FAILED | tài liệu v2 | PERMISSION_MISSING |
| Duyệt đơn (`approve`) | `order/UpdateOrder` TYPE 1 | PENDING | tài liệu v2 | PERMISSION_MISSING |
| Huỷ (`cancel`) | `order/UpdateOrder` TYPE 4 | chưa kết thúc, không phải đang đi phát | tài liệu v2 | PERMISSION_MISSING |
| Sửa người nhận / SĐT / địa chỉ / COD / ghi chú (`edit`) | `order/edit` | chưa kết thúc (thực tế: trước khi đi phát) | tài liệu v2 | PERMISSION_MISSING |
| Xoá đơn đã huỷ | `order/UpdateOrder` TYPE 11 | — | tài liệu v2 | **không đưa vào ERP**: xoá là hành động phá huỷ, không có nhu cầu vận hành |

## Việc vận hành hay cần mà KHÔNG có API (`WEB_ONLY`)

| Việc | Cách làm |
|---|---|
| Đổi giờ / ngày phát | gọi bưu cục / app Viettel Post; UpdateOrder không có tham số hẹn giờ |
| Khiếu nại / tra soát kiện | viettelpost.vn hoặc tổng đài 1900 8095; không có API tạo khiếu nại |
| Giao một phần / đổi tiền thu hộ sau khi đã phát | chỉ bưu cục; `order/edit` chỉ trước khi phát |
| Đổi địa chỉ khi kiện đã đi phát | gọi bưu cục; `order/edit` từ chối đơn đã đi phát |

## Điều kiện để chuyển từ PERMISSION_MISSING sang SUPPORTED

Trỏ `VIETTELPOST_USERNAME / PASSWORD` (hoặc API key) về **tài khoản Viettel Post mà Pancake đang
dùng để tạo vận đơn** (cùng mã khách hàng). Khi đó `syncViettelPostShipments` tra được kiện ⇒
`tracking_capability = API_TRACKABLE` ⇒ ma trận tự chuyển, không cần sửa mã. Cho tới lúc đó, mọi
thao tác đi qua `MANUAL_REQUIRED → MANUAL_DONE` và vẫn có nhật ký.

## Vòng đời yêu cầu (`carrier_action_requests`)

`PENDING → SENT → ACKNOWLEDGED → SUCCESS | FAILED | UNSUPPORTED`, riêng `MANUAL_REQUIRED → MANUAL_DONE`.
`SUCCESS` chỉ khi sự kiện hành trình xác nhận (`settleCarrierRequests`, chặng khớp
`CARRIER_ACTION_CONFIRM_STAGES` và xảy ra sau lúc gửi). Idempotent theo kiện + hành động + nội dung
+ ngày. Retry hữu hạn (3 lần) chỉ cho lỗi tạm thời (mạng / 5xx); lỗi quyền là dứt khoát. Lưu
`raw_request`, `response`, `attempts`, người gửi, các mốc, và mỗi bước một sự kiện case + audit.

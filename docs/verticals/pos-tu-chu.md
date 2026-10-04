# POS tự chủ — shop không cần Pancake POS để đẩy đơn sang hãng vận chuyển

Quyết định của chủ shop (04/10/2026): phần mềm bán cho shop khác phải chạy được **không cần mua Pancake**. Phần chat
(Messenger trực tiếp, hộp thư người, Zalo OA) do chương trình AI Sales làm (`docs/productization/`). Tài liệu này là
phần **POS**: đơn tạo trong ERP tự tạo vận đơn ở hãng, theo dõi hành trình, in nhãn, huỷ. Chủ shop đã duyệt nối **mọi**
hãng vận chuyển (AGENTS.md mục 7). Thứ tự: **Viettel Post trước**, rồi GHN, GHTK, J&T.

## P1 — Viettel Post của tổ chức (kết nối `viettelpost-carrier`)

### Cách bật (quản trị shop tự làm)

1. Cài đặt → Kết nối → nhóm «Vận chuyển» → «Viettel Post của tổ chức (tạo vận đơn)». Nhập tài khoản và mật khẩu
   viettelpost.vn của shop, tên / SĐT / địa chỉ lấy hàng, và ghi chú mặc định nếu muốn. Bấm Lưu → Kiểm tra → Bật.
   - «Kiểm tra» chỉ làm hai việc: đăng nhập (Login → ownerconnect) và đọc danh sách kho lấy hàng. Không tạo đơn nào.
2. Để hành trình tự về, bật thêm webhook «Viettel Post của tổ chức» (khung ngay trên trang Kết nối). Chép URL, dán vào
   tài khoản Viettel Post. Hai kết nối bổ sung nhau, không thay nhau.
3. Trên đơn «Đã xác nhận»: khung «Vận chuyển & COD» → «Tạo vận đơn Viettel Post».
   1. Nhập cân nặng (lấy sẵn từ cân mẫu mã × số lượng nếu đã khai) và tiền thu hộ. Mặc định là số khách **còn phải trả**
      theo chứng từ thanh toán.
   2. Bấm «Tính cước». Hãng trả bảng dịch vụ **và địa chỉ nhận mà hãng đọc được**. Hãng đọc sai xã thì sửa đơn, đừng tạo.
   3. Chọn dịch vụ, bấm «Tạo vận đơn». Sau đó có «In nhãn Viettel Post» và «Huỷ vận đơn» (khi hãng chưa lấy hàng).

### Luật

- **Một lần gửi không bao giờ thành hai vận đơn.**
  - ERP giữ chỗ (một dòng `shipments`) trong một giao dịch có khoá theo đơn, **trước** khi gọi hãng.
  - Mã ERP gửi đi (`ERP<mã đơn>-<lần gửi>`) kèm `CHECK_UNIQUE: true`, nên chính hãng cũng chặn trùng.
  - Client **không tự gửi lại** lệnh tạo.
  - Hãng từ chối thì bỏ chỗ giữ. Đứt mạng giữa chừng thì chỗ giữ ở trạng thái **UNKNOWN** và chặn tạo mới. Người tra
    trên viettelpost.vn, rồi chờ webhook hoặc bấm «Bỏ lượt tạo».
- **Logistics ≠ tiền** (ORDER_OUTCOME.md).
  - Lõi không ghi `shipments.stage` (`SHIPMENT_STAGE_WRITERS`).
  - Huỷ thành công ở hãng chỉ ghi `raw.carrierCancel` (hãng đã nhận lệnh). Chặng «Đã huỷ» về theo webhook 107.
  - Tiền thu hộ đi theo chứng từ riêng.
- **Đơn đã gửi không sửa lặng lẽ.** Còn lần gửi giữ đơn thì không sửa / huỷ đơn ở ERP. Muốn sửa phải huỷ vận đơn trước.
- **Thu hộ không cộng cước hai lần.** `ORDER_PAYMENT = 3` (thu tiền hàng, không thu cước) khi có thu hộ, `1` khi không.
  Phí ship khách trả đã nằm trong số tiền đơn; cước hãng do shop trả.
- **Không lộ mật khẩu.**
  - Địa chỉ API là hằng số (`VTP_PARTNER_API`), không theo chuyển hướng.
  - Mọi câu lỗi đã che mật khẩu / token. Token chỉ sống trong một lượt bấm, không ghi vào CSDL.
  - Client chặn bằng chủ của kết nối trước khi gọi mạng.

### Nguồn tên trường

Tài liệu chính thức `partner2.viettelpost.vn/document` (đọc 04/10/2026):

| Việc | API |
|---|---|
| Tạo đơn bằng địa chỉ chi tiết | `order/createOrderNlp` |
| Tra cước bằng địa chỉ chi tiết | `order/getPriceAllNlp` |
| Huỷ | `order/UpdateOrder` `TYPE 4`, chỉ khi `ORDER_STATUS < 200` |
| Lấy mã in | `order/printing-code` |
| Mẫu link in | `digitalize.viettelpost.vn/DigitalizePrint/report.do?type=1&bill=<mã>` |

Dùng biến thể «địa chỉ chi tiết»: hãng tự đọc địa chỉ dạng chữ, nên ERP không phải giữ bộ mã tỉnh / xã của hãng, và
không phải sửa khi địa giới đổi.

### Chưa kiểm trên tài khoản thật

- Toàn bộ luồng mới chạy với máy chủ giả dựng đúng mẫu phản hồi trong tài liệu (`tests/carrier-vtp.test.ts`). **Lượt tạo
  đơn đầu tiên trên tài khoản thật là HUMAN GATE**: tạo thật sẽ gọi bưu tá tới lấy hàng. Nên tạo một đơn rồi huỷ ngay, hoặc
  dùng tài khoản thử `partnerdev.viettelpost.vn`.
- Tài liệu liệt kê thêm các mẫu in `type=2`, `a6_1`, `100`, `1001` và ba khổ A5 / A6 / A7, nhưng không ghép rõ mẫu nào là
  khổ nào. ERP chỉ dùng `type=1` (mẫu tài liệu dùng làm ví dụ). Khổ khác chờ kiểm trên máy in thật.

## P2 — Tạo và in vận đơn hàng loạt từ danh sách đơn

Danh sách đơn có ô chọn khi tổ chức tạo đơn tay, người xem có quyền `shipments:manage`, và kết nối
«viettelpost-carrier» đang bật. Chọn đơn rồi dùng một trong hai nút:

- **«Tạo vận đơn Viettel Post (n)».**
  1. ERP tra bảng cước bằng đơn **đầu tiên tạo được**. Người bấm chọn **một** dịch vụ dùng chung.
  2. Máy chủ tạo **tuần tự**, đi qua đúng `createVtpShipmentCore`. Giữ chỗ, `CHECK_UNIQUE` và không tự gửi lại: mọi
     luật P1 giữ nguyên.
  3. Mỗi đơn dùng mặc định của chính nó: cân = cân mẫu mã × số lượng, thu hộ = số khách còn phải trả, ghi chú mặc định
     của tổ chức.
  4. Đơn thiếu cân, chưa «Đã xác nhận», đang có lần gửi giữ đơn, hoặc bị hãng từ chối thì **bỏ qua riêng đơn đó, có
     lý do**. Không đoán cân, không dừng cả lượt.
  - Trần 50 đơn một lượt.
- **«In nhãn Viettel Post».** Một mã in (`printing-code`) cho mọi lần gửi do ERP tạo còn in được của các đơn đã chọn,
  tối đa 100 vận đơn. Lần gửi đã có lệnh huỷ không in.

## Lõi chung cho mọi hãng (`lib/carriers/engine.ts`)

Từ P3, mọi luật ở P1 và P2 nằm ở **một lõi**. Mỗi hãng chỉ là một adapter (`lib/carriers/adapters/*`) khai bốn việc nói
chuyện với hãng: tính cước, tạo, huỷ, in. Mỗi việc trả đúng ba khả năng:

- **OK** — hãng nhận.
- **REJECTED** — hãng trả lời và từ chối ⇒ bỏ chỗ giữ.
- **UNKNOWN** — không có câu trả lời đọc được ⇒ giữ chỗ, người quyết.

Thêm hãng = thêm một adapter vào `lib/carriers/registry.ts`, lõi không đổi.

`shipments.raw.carrierCreate` ghi kèm **hãng** (dòng của P1 không có ⇒ Viettel Post) và **bản nháp đã gửi**. Nhờ vậy:

- **«Thử lại»** chỉ có ở hãng mà gửi lại cùng mã là an toàn (GHN: `client_order_code` trả lại đúng đơn đã tạo).
- **Viettel Post** chặn mã trùng nhưng không trả mã cũ, nên lượt không rõ kết quả vẫn phải tra rồi «Bỏ lượt tạo».

## P3 — GHN của tổ chức (kết nối `ghn-carrier`)

### Cách bật

1. Cài đặt → Kết nối → nhóm «Vận chuyển» → «GHN của tổ chức (tạo vận đơn)».
   - Nhập Token API (developer.ghn.vn → Quản lý token → bấm con mắt, nhập OTP) và ShopId.
   - Tuỳ chọn: chế độ cho xem hàng (`CHOXEMHANGKHONGTHU` mặc định), ghi chú mặc định.
   - Lưu → Kiểm tra → Bật. «Kiểm tra» chỉ đọc danh sách shop của token và đòi ShopId đã khai nằm trong đó.
2. Khung «GHN của tổ chức — webhook trạng thái»: chép URL, dán vào developer.ghn.vn → Cấu hình webhook → tab Đơn hàng.
   Thay đổi có hiệu lực sau khoảng 15 phút.
3. Trên đơn «Đã xác nhận»: «Tạo vận đơn GHN».
   - Có thêm hai ô **Tỉnh / thành** và **Xã / phường** theo địa giới mới. Ô xã gợi ý từ danh mục chính thức của GHN.

### Luật riêng của GHN

- **Địa giới mới (tỉnh + xã, `is_new_to_address: true`).** Tên phải là tên chuẩn của danh mục GHN.
  - ERP so khớp tên trên đơn với `name` + `extension_names`: bỏ dấu, bỏ tiền tố «Phường / Xã / TP.».
  - Ô đã gõ thì **chỉ** dùng đúng tên đó. Ô trống mới đọc từ địa chỉ.
  - Không khớp **duy nhất** ⇒ báo để người chọn, không đoán. Tên phường cũ (trước sáp nhập) sẽ không khớp, và đó là đúng.
- **Thu hộ và phí.**
  - Cước do shop trả (`payment_type_id = 1`). Thu hộ = số khách còn phải trả.
  - Không tự mua bảo hiểm (`insurance_value = 0`). Gói quy ước 20×15×10 cm; GHN cân / đo lại khi lấy hàng.
- **Người gửi** = hồ sơ shop trên GHN theo ShopId. ERP không khai lại.
- **Huỷ** chỉ khi GHN chưa lấy hàng. Chặng «Đã huỷ» về theo webhook `cancel`.
- **Webhook theo tổ chức** (token HMAC trong đường dẫn).
  - Chống trùng theo `OrderCode + Type + Time`.
  - Khớp vận đơn theo mã GHN hoặc mã ERP của lần gửi (gói `create` có thể tới trước khi lõi kịp ghi mã).
  - Đơn GHN tạo ngoài ERP: chỉ lưu gói, không dựng vận đơn mồ côi.
  - `CODAmount` là số GHN **định** thu, không phải số thực thu (ORDER_OUTCOME mục 8). Không ghi vào `cod_collected`.
- **Kết quả đơn.** Mã cuối của GHN là chứng từ — chủ shop chốt 04/10/2026, `docs/business-rules/ORDER_OUTCOME.md` mục
  4.1.
  - Bảng mã: `lib/constants/carrier-status.ts`.
  - `exception` không kết luận.
  - `lost / damage / scrap` = hoàn, hàng không về kho.

### Những chỗ hệ thống chưa nối cho GHN (nói thẳng)

- **Chăm sóc vận đơn** (ca care, hàng đợi đối chiếu ĐVVC) vẫn chỉ chạy cho Viettel Post. Kiện GHN có trong cảnh báo
  «im lặng» và độ tươi giao vận, nhưng chưa tự mở ca chăm sóc.
- **Đối soát COD của GHN** (gói `cod` / `CODTransferDate`) chưa thành chứng từ tiền. Tiền thật vẫn theo chứng từ thanh toán.

## P3b — GHTK của tổ chức (kết nối `ghtk-carrier`)

### Cách bật

1. Cài đặt → Kết nối → nhóm «Vận chuyển» → «GHTK của tổ chức (tạo vận đơn)».
   - Nhập Token API (khachhang.giaohangtietkiem.vn → Thông tin shop → Cấu hình API) và mã shop (`X-Client-Source`).
   - Khai nơi lấy hàng: tên, SĐT, địa chỉ, tỉnh, xã (địa giới mới).
   - Lưu → Kiểm tra → Bật. «Kiểm tra» chỉ đọc danh sách kho lấy hàng của shop trên GHTK.
2. Khung «GHTK của tổ chức — webhook trạng thái»: chép URL, dán vào web khách hàng GHTK. Không thấy ô webhook thì gửi URL
   cho hỗ trợ GHTK khai giúp.
3. Trên đơn «Đã xác nhận»: «Tạo vận đơn GHTK». Hai ô **Tỉnh / thành** và **Xã / phường** là bắt buộc.

### Luật riêng của GHTK

- **Địa giới mới.** Tài liệu Đăng đơn ver 1.5 (đọc 04/10/2026) khai `province` + `ward` bắt buộc, `district` không bắt
  buộc. ERP không gửi huyện.
  - GHTK không công bố danh mục tỉnh / xã qua API. ERP gửi đúng tên người xác nhận, không tự sửa; tên sai thì GHTK từ chối.
  - Tài liệu đòi `street` hoặc `hamlet`. ERP không tách tên đường nên gửi `hamlet = «Khác»`, địa chỉ chi tiết ở `address`.
- **Chống trùng.** `order.id` = mã ERP của lần gửi. Gửi lại cùng mã ⇒ GHTK trả `ORDER_ID_EXIST` kèm mã đơn đã có.
  - Lõi coi đó là đơn của chính lần gửi này, nên «Thử lại» an toàn như GHN.
- **Cân và cước.** Cân tính bằng gam (`weight_option = gram`). Cước shop trả (`is_freeship = 1`). Thu hộ = số khách còn
  phải trả. Bảng cước hỏi hai cách chở (đường bộ / bay), cách nào GHTK nói không phục vụ thì không hiện.
- **Nhãn in là tệp PDF sau token.** ERP chuyển tiếp qua `/api/carriers/label` (cần đăng nhập + quyền vận đơn). Mã phải
  là của một lần gửi ERP tạo bằng GHTK. Token không bao giờ ra trình duyệt.
  - GHTK in một đơn mỗi lượt. In hàng loạt mở trang `/orders/carrier-labels` liệt kê từng nhãn.
- **Huỷ** theo mã GHTK, chỉ khi GHTK chưa lấy hàng (tài liệu: trạng thái 1 · 2 · 12). Chặng «Đã huỷ» về theo webhook `-1`.
- **Webhook theo tổ chức** (token HMAC trong đường dẫn). Thân form-urlencoded.
  - Chống trùng theo `label_id + status_id + action_time`.
  - Mốc `action_time` giữ dấu «+» của múi giờ (mẫu tài liệu gửi «+» trần).
  - Mã «shipper báo» (45 · 49 · 123 · 127 · 128 · 410) chưa khai trong bảng ⇒ lưu, không kết luận.
  - `pick_money` là số GHTK định thu, không phải số thực thu. `return_part_package = 1` vào ghi chú sự kiện.

### Chưa kiểm trên tài khoản thật

- Lượt tạo đơn thật đầu tiên là HUMAN GATE: đơn vị cân của từng dòng hàng khi `weight_option = gram`, và việc GHTK có cần
  `X-Client-Source` cho shop tự tích hợp hay không, chỉ trả lời được trên tài khoản thật.
- Chăm sóc vận đơn và đối soát COD chưa nối cho GHTK (giống GHN).

## P4 — Shop đến từ Pancake: «Chuyển hẳn sang ERP» và «huỷ vận đơn ≠ huỷ đơn»

Hai quyết định của chủ shop ngày 04/10/2026, đặc tả ở `docs/business-rules/ORDER_OUTCOME.md` mục 11.3 và 11.5.

- **Chuyển hẳn sang ERP.** Đường chuyển: nối «Pancake POS của tổ chức» → đồng bộ một lần (khách, sản phẩm, đơn cũ) → tắt
  kết nối → trang Đơn hàng → «Chuyển hẳn sang ERP».
  - Trước nút này, CSDL có đơn Pancake đã nhập khiến **mọi đơn tạo trong ERP đứng ngoài** doanh thu, lợi nhuận và marketer.
  - Bấm một lần (quyền cấu hình, có nhật ký): đơn ERP vào mọi báo cáo, đơn Pancake giữ nguyên làm lịch sử.
  - Chỉ bấm được khi đã tắt đồng bộ đơn. Tổ chức nhà không bao giờ bấm được.
- **Huỷ vận đơn ≠ huỷ đơn.** Đơn ERP còn sống mà lần gửi mới nhất bị hãng huỷ, chưa gửi lại ⇒ kết quả **«Chưa gửi»**, không
  phải «Đã huỷ». Tạo lần gửi mới ⇒ theo lần gửi mới; người huỷ đơn ⇒ «Đã huỷ».

## P5 — Nhân viên tạo đơn ngay trong khung chat

Người bán đang chat với khách thì tạo đơn tại chỗ, không chép sang trang Đơn hàng.

- **Lối bấm hôm nay:** AI → Chatbot bán hàng → «Hội thoại gần đây» → «Tạo đơn» trên từng dòng (cần `orders:write`; khung
  thử không có nút). Hộp thư M8 sẽ gắn cùng form (`components/orders/chat-order-form.tsx`, props `{ conversationId,
  defaults?, onCreated? }`) cạnh khung tin nhắn.
- **Một đường tạo đơn.** Lõi `lib/records/chat-order.ts` gọi đúng `createManualOrderCore` (cổng tổ chức, quyền, zod, khách /
  mẫu mã có thật, một giao dịch, nhật ký) rồi gắn đơn về hội thoại: `orders.sales_conversation_id` + `origin = ERP_FORM`.
- **Đơn của người là đơn của người.** Sự kiện hội thoại `order.confirmed` / `order.drafted` mang `actorKind = HUMAN` và khoá
  tài khoản người bấm. Màn «Hiệu quả» so AI với người đọc đúng hai cột này.
- **Một lượt bấm, một đơn.** Form sinh một khoá mỗi lần mở; bấm hai lần hay mạng gửi lại thì nhận lại đúng đơn đã tạo.
- **Khách theo SĐT.** Chưa chọn khách ⇒ tìm theo SĐT. Đã có ⇒ dùng lại, KHÔNG sửa tên / địa chỉ đang lưu (mục 3.12). Chưa có
  ⇒ tạo mới nếu người bấm có `customers:write`. Tên / địa chỉ của lần mua này vào người nhận của đơn.
- **Cảnh báo, không chặn.** Hội thoại đã có đơn còn sống (bot chốt hay người tạo) ⇒ form liệt kê để người kiểm trước.

## Kế tiếp

- **J&T.** Cần shop đăng ký đối tác trên open.jtexpress.vn (xét duyệt 1–3 ngày, xin chạy thật từng API, mã khách hàng
  lấy ở bưu cục). Đây là HUMAN GATE.

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

## Kế tiếp

- **P3.** GHN, GHTK, J&T: mỗi hãng một kết nối PER_ORG cùng hình dạng (kiểm tra · tính cước · tạo · huỷ · in), kèm
  webhook trạng thái theo tổ chức.
- **P4.** Nhập dữ liệu từ Pancake (khách, sản phẩm, đơn cũ) để shop chuyển sang trong một buổi.
- **P5.** Nhân viên tạo đơn ngay trong khung chat. Đi đường người (`createManualOrderCore`, `origin = ERP_FORM`) và gắn
  `sales_conversation_id`. Gắn vào màn hộp thư M8 khi phiên giữ M8 để sẵn khe.

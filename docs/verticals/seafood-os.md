# Seafood OS: ngành hải sản trên lõi chung

> Vertical SaaS Factory: một lõi dùng chung cho mọi ngành, mỗi ngành chỉ thêm phần riêng. Tệp này là bản đồ của ngành
> hải sản. Mỗi bước có tài liệu riêng.

## Chuỗi nghiệp vụ và chỗ của nó trong ERP

| Bước | Ở đâu | Trạng thái |
|---|---|---|
| **Tìm khách sỉ mới** (nhà hàng, quán, khách sạn) | Săn khách sỉ — Google Places, chấm điểm, hàng đợi liên hệ (`docs/verticals/wholesale-lead-hunter.md`) | Đã có (0197) |
| Khách nhắn Facebook / web, **AI tư vấn** | Chatbot bán hàng (`lib/sales-chatbot`), kết nối fanpage qua Pancake | Đã có |
| **Báo giá** lẻ / sỉ theo bậc | Bảng giá sỉ (`docs/verticals/price-lists-receivables.md`) và công tắc «Báo giá theo bảng giá sỉ» của bot | S1 + S4 |
| Báo giá **theo kg, cân lại khi đóng hàng** | Chưa có. Số lượng kho và dòng đơn hiện là số nguyên | S2, xem mục cuối |
| **Đơn** | Đơn tạo tay. Bot lên đơn nháp, chốt khi khách xác nhận; hạn mức nợ chặn lượt chốt | Đã có + S1 |
| **Giao hàng** | Phiếu giao có ký nhận (ORDER_OUTCOME.md mục 11) | Đã có |
| **Công nợ**, khách sỉ | Công nợ đọc từ phiếu thu, thu nợ gộp, tuổi nợ | S1 |
| **Chăm sóc lại** | Nhắc mua lại theo nhịp mua thật của từng khách, sổ liên hệ (`docs/verticals/reorder-reminders.md`) | S3 |
| Nhập hàng từ ghe / nhà cung cấp | Module Mua hàng | Đã có |
| Thu phí thuê bao của chính shop | Thu phí nền tảng (`docs/platform/billing.md`) | Bước 1 |

## Mẫu ngành `seafood-commerce`

Mẫu ngành chọn được khi đăng ký ở `/start` (loại hình «Hải sản (lẻ + sỉ)») hoặc cài sau ở Cài đặt → Mẫu ngành.

- **Module:** lõi, việc, khách, sản phẩm, đơn, kho, mua hàng, chatbot bán hàng, săn khách sỉ (từ bản mẫu 1.1.0). Không bật «Vận chuyển» và «CSKH», vì hai
  module này dựng trên connector chỉ dành cho tổ chức nhà.
- **Trường riêng của sản phẩm:** dạng hàng (tươi sống, ướp đá, đông lạnh, khô, chế biến), cỡ, đơn vị bán, vùng / nguồn
  hàng, bảo quản.
- **Trường riêng của khách:** loại khách (lẻ, quán ăn, đại lý, CTV) và giờ nhận hàng.
- **Vai trò:** bán hàng, kho, kế toán công nợ.
- **Luật thông báo:** đơn chốt báo nhóm kho, đơn huỷ báo nhóm kho. Cả hai ở trạng thái NHÁP + CHẠY THỬ (luật 23).
- **Không khai** chu kỳ mua lại, hạn mức hay giá mặc định nào. Mỗi shop tự quyết (luật 38).

## Chatbot báo giá sỉ (S4)

Cấu hình bot có công tắc `wholesalePricing`, **mặc định TẮT**.

- **TẮT:** hành vi như trước. Bot chỉ có giá lẻ và chuyển nhân viên với mọi câu hỏi sỉ.
- **BẬT:**
  - `get_current_price` nhận thêm `quantity` và trả về đơn giá theo `quoteUnitPrice`. Hàm này dùng chung với form đơn tay:
    lấy bảng của khách nếu bot đã nhận ra khách, không thì bảng mặc định, cuối cùng là giá lẻ. Kết quả kèm các bậc
    «mua từ».
  - `calculate_cart`, đơn nháp và bước chốt đơn tính bằng cùng đơn giá đó.
  - Bot không tự giảm ngoài bảng. Khách đòi giá thấp hơn bảng thì bot chuyển nhân viên.
  - **Giá lẻ không bao giờ được báo như giá sỉ** (chủ shop HSLC 08/10/2026). `quoteUnitPrice` lùi về giá lẻ khi số lượng
    chưa tới bậc hay mẫu mã không có trong bảng — đúng cho tính tiền, nhưng AI từng đọc `price` ấy rồi báo nó như giá sỉ.
    Nên `get_current_price` trả thêm `price_source` (`CUSTOMER_LIST` · `DEFAULT_LIST` · `RETAIL`) và khối `wholesale`
    (`available`, `from_quantity`, `note` — hàm thuần `wholesaleQuoteView`): chưa tới bậc ⇒ bot nói «giá sỉ áp từ N trở
    lên»; mẫu mã chưa có trong bảng nào ⇒ không báo giá, chuyển nhân viên «Khách sỉ — <món>, chưa có giá sỉ». Bảng giá sỉ
    trống thì công tắc BẬT cũng không có gì để báo — chủ shop phải lập bảng ở Sản phẩm → Bảng giá sỉ trước.
  - Đo đang có gì ở một tổ chức khách (quy cách, giá lẻ, bảng giá sỉ + bậc, câu mẫu, hai công tắc) bằng ops `org-catalog`
    (chỉ đọc, kết quả mã hoá; `scripts/org-catalog.ts`).
- Hạn mức nợ áp cho bot y như cho người, vì cùng đi qua `createOrderAsAgent`.

## S2 — bán theo cân (chưa làm)

Hàng tươi bán theo cân thật: khách đặt «2kg tôm», lúc đóng hàng cân được 2,15kg. Muốn hỗ trợ đúng cần:

1. Đơn vị bán `KG` cho mẫu mã. Số lượng lưu bằng **gam** (số nguyên, khỏi đổi kiểu 26 cột số lượng), giá lưu theo kg.
   Thành tiền = làm tròn(gam × giá/kg ÷ 1000).
2. Hàm tính tiền đơn tay cần biết đơn vị của từng dòng. Mọi màn hình in số lượng phải định dạng theo đơn vị.
3. Thêm bước «Cân lại» trên đơn đã chốt, trước khi xác nhận giao. Bước này sửa số gam thực tế và tính lại tiền, có nhật ký.

Phạm vi chạm khá rộng: sổ kho, phiếu nhập, đơn, chatbot. Vì vậy cần một khách pilot bán hàng tươi theo cân xác nhận
quy trình trước khi làm. HSLC hiện bán hàng đóng gói (mẫu thực phẩm, chủ shop chốt 30/09/2026).

**Quy cách lẻ không cần S2.** Khách mua 0,5kg (HSLC 08/10/2026) là một MẪU MÃ riêng («0,5kg») với giá riêng — chủ shop
thêm ở Sản phẩm → sửa sản phẩm → thêm mẫu mã (SKU mới, quy cách «0,5kg», giá lẻ, khối lượng 500 g). Gói thực phẩm của bot
(`FOOD_PACK.describeLine`) dặn: số lượng không khớp một quy cách (1,5kg, «nửa ký») thì GHÉP từ các quy cách đang bán, không
tự chia / nhân giá; không ghép được thì nói các quy cách shop đang bán.

# Nhân viên bán hàng AI — Báo cáo chất lượng V1 (15/09/2026)

Nấc chạy: **SHADOW** · `AI_ALLOW_CUSTOMER_SEND=false` · `AI_ALLOW_ORDER_CREATE=false` · bộ lập lịch TẮT.
Không tin nào tới khách, không đơn nào được tạo, không chạm CSDL production.

Mô hình thật: `erp:openai` — ECONOMY `gpt-5.6-luna`, STRONG `gpt-5.6-terra` (dùng lại tầng AI có sẵn
của ERP, không dựng tích hợp thứ hai).

## 1. Ba mẻ đo, và vì sao có ba

| | mẻ | ảnh | đo được |
|---|---|---|---|
| ① | run 34971478023 | 0ae05eb | nền: leo nấc 0%, nhưng **0/18** câu trả lời nêu được một con số tiền |
| ② | run 34974208223 | 4744dcb | sau ba bản sửa: **11/11** lượt hỏi giá nghe được một con số — nhưng con số ĐẶT SAI VAI |
| ③ | run 34976255255 | 8a96ea4 | sau bản sửa cách đọc tiền: **12/12**, ba con số cộng được với nhau |

Mẻ ② không phải một lần chạy thừa: chính nó lộ ra lỗi báo giá sai 25.000đ mà mẻ ① không thể thấy
(mẻ ① chưa báo giá bao giờ). Mỗi mẻ 18 hội thoại · ~15 lượt gọi mô hình — chi phí không đáng kể, và
KHÔNG mẻ nào chạm tới khách.

## 2. Số đo mẻ cuối (run 34976255255 · 18 hội thoại · 41–49 giây)

**Định tuyến mô hình — mục tiêu < 15–20%, đạt 0%**

| | trước (13/09) | mẻ cuối |
|---|---|---|
| lượt đi lên mô hình MẠNH | **48 %** | **0 %** (18/18 không leo) |
| lượt gọi hỏng lược đồ | mọi lượt ECONOMY | **0** |
| lượt gọi mô hình | 25 | 16, đều hợp lệ |
| kết quả dùng được | 1/18 | 14/18 (4 còn lại là chuyển người ĐÚNG) |

Nguyên nhân gốc của 48% không nằm ở lời dặn hay ở bộ định tuyến: lược đồ `UNDERSTANDING_SCHEMA` từ
chối `null` (mô hình gửi `"productText": null`, đúng cách JSON diễn đạt "trống"), nên mọi lượt
ECONOMY hỏng → leo STRONG → hỏng nốt → cả dây chuyền rơi về chuyển người. Tức là trả tiền gấp đôi
để nhận về con số không.

**An toàn — đọc lại từ CSDL, không phải khẳng định suông**

| | |
|---|---|
| gợi ý đã gửi cho khách | **0** ✓ |
| lượt gọi công cụ lên đơn | **0** ✓ |
| hội thoại có đơn | **0** ✓ |
| chặn cứng lúc chạy | gửi tin ✓ CẤM · tạo đơn ✓ CẤM |
| cờ an toàn trên 18 câu (giả định chặt nhất) | **0** ✓ |
| bản mô hình viết bị lưới chặn lúc sinh | 1 |

**Chín chiều chất lượng — và khai thẳng chiều nào máy không chấm được**

| chiều | ai chấm | mẻ cuối |
|---|---|---|
| Có TRẢ LỜI câu khách hỏi không | MÁY | **12/12** lượt hỏi giá nghe được một con số |
| Có đẩy hội thoại đi tiếp không | MÁY | 14/18 |
| Không bịa điều ERP không bảo đảm | MÁY | 0 cờ |
| Chuyển người đúng lúc, đúng loại | MÁY | 3 thiếu dữ liệu · 1 máy bí · 14 không chuyển |
| Hiểu đúng ý định | NGƯỜI | CHƯA CHẤM |
| Bóc đúng thực thể | NGƯỜI | CHƯA CHẤM |
| Nhận đúng sản phẩm | NGƯỜI | CHƯA CHẤM |
| Chọn đúng việc phải làm | NGƯỜI | CHƯA CHẤM |
| Tự nhiên, đúng giọng shop | NGƯỜI | CHƯA CHẤM |

Năm chiều "NGƯỜI" không có nguồn sự thật nào trong ERP. Máy **không** tự cho điểm, và tuyệt đối
không lấy chính mô hình đang đo làm giám khảo — nó sẽ chấm cao đúng những chỗ nó sai giống nhau.

**Chi phí: CHƯA BIẾT.** Chưa khai đơn giá cho `gpt-5.6-luna` / `gpt-5.6-terra`, nên mọi tổng chi
phí là `null`. KHÔNG ghi 0đ — y hệt luật tiền của ERP. Token đo được: 3.618 vào · 1.336 ra cho 15
lượt; độ trễ trung vị ~2,7 giây, cao nhất 4,3 giây.

**Phân loại chuyển người — năm loại, năm người khác nhau phải đi làm**

| loại | mẻ cuối | ai phải làm |
|---|---|---|
| ERP thiếu dữ liệu (`SIZE_DATA_MISSING`) | 3 | **chủ shop** khai bảng số đo |
| Máy bí (`LOW_CONFIDENCE`) | 1 | sửa luật / lời dặn |
| Đúng việc của người | 0 | — |
| Chốt an toàn nổ đúng | 0 | — |
| Hạ tầng hỏng | 0 | — |

"Tỷ lệ chuyển người 4/18" gộp lại là một con số không sửa được gì. Tách ra thì thấy: **3 trong 4 là
việc của chủ shop**, chỉ **1/18 (5,5%)** là chỗ AI còn yếu.

## 3. Bốn bản sửa, và cách mỗi bản được tìm ra

1. **Khách hỏi giá thì được nghe giá — ở MỌI giai đoạn.** Luật "trả lời trước, đẩy bước sau" chỉ có
   ở hai giai đoạn đầu, nên khách hỏi giá lúc hội thoại đang chọn size thì câu hỏi rơi mất.
2. **Giá báo được TRƯỚC khi khách chọn size.** `pricing.get` chỉ nhận `variantId`, nên máy bắt khách
   trả lời trước khi được trả lời. Nay nhận cả `productId` — nhưng CHỈ khi mọi mẫu mã cùng một đơn
   giá; lệch giá thì `ambiguous` và giá vẫn là CHƯA BIẾT.
3. **Lưới soi bản mô hình viết dùng chung sổ cờ an toàn.** Mô hình đã thay hẳn một tin nhắn: việc
   được giao là hỏi khách xem mẫu nào, nó viết ra câu xin chiều cao / vòng ngực — đúng thứ mẫu câu
   vừa được sửa để thôi hứa. Lời dặn không giữ được điều đó; cái lưới giữ.
4. **Ba con số trong câu báo giá phải cộng được với nhau.** "giá 524.000 ₫, phí ship 25.000 ₫" —
   cả hai đều do máy chủ tính nên lưới soi tiền không thấy gì sai, nhưng 524.000 ĐÃ GỒM ship, nên
   khách đọc ra 549.000. Cái sai nằm ở QUAN HỆ giữa các con số, không ở bản thân chúng.

## 4. Mười hai ca đại diện

Chọn để **PHỦ** không gian (mỗi hành động · mỗi loại chuyển người · ca có cờ an toàn · ca nguồn
TEST · ca máy thấy khó nhất), không chọn để đẹp. Nhãn tốt / tạm được / kém là việc của NGƯỜI ở
`/ai/review` — bản in đầy đủ nằm ở mục ⑧ của run 34976255255.

Ba ca đáng đọc nhất:

| khách | máy | đọc |
|---|---|---|
| "bn vậy" | "Dạ Đầm Q004 giá 499.000 ₫, phí ship 25.000 ₫, tổng 524.000 ₫ ạ. … Chị lấy size nào…" | mẻ ① đọc câu này thành "đòi gặp người" và chuyển người; nay hiểu đúng là hỏi giá |
| "80kg mặc vừa ko" (nguồn TEST) | "Dạ em chào chị ạ. Chị đang xem mẫu nào…" | mô hình đã viết ra câu xin số đo; **lưới chặn**, rơi về câu mẫu |
| "Mẫu này có size nào?" | "Dạ chị chờ em một chút, em nhờ bạn phụ trách…" | ERP chưa có bảng số đo ⇒ chuyển người, KHÔNG đoán một size trên cơ thể người thật |

## 5. Kết luận cổng COPILOT

**READY_FOR_COPILOT = YES** — cho nấc **COPILOT** (máy soạn, NGƯỜI bấm gửi, mỗi tin một phiếu duyệt
có người ký), trên page WIN. **KHÔNG** cho nấc AUTO.

Vì sao YES: mọi chốt máy đo được đều xanh — 0 tin gửi, 0 đơn, 0 cờ an toàn, 0 lượt leo nấc mô hình
mạnh, 12/12 câu hỏi giá được trả lời bằng con số đúng và cộng được. Năm chiều còn lại chưa ai chấm
— và nấc COPILOT chính là nấc dựng ra cho đúng tình huống ấy: người đọc từng tin trước khi gửi.

Ba việc phải biết trước khi bật (KHÔNG phải việc của mã nguồn):

1. **Bảng số đo chưa khai** (`settings["ai.sizeRules"]`) ⇒ ~17% lượt chuyển người vì thiếu dữ liệu.
   Khai xong thì con số ấy về gần 0.
2. **Đơn giá mô hình chưa khai** ⇒ chi phí mỗi lượt là CHƯA BIẾT. Cần khai trước khi kết luận
   COPILOT đắt hay rẻ.
3. **Chưa lượt nào được người chấm.** Ba mươi lượt COPILOT đầu nên được chấm ở `/ai/review` — màn
   hình nay có kết luận chung (gửi được nguyên văn / sửa nhẹ / không gửi được) và lý do theo danh
   sách đóng, mỗi lý do khai luôn ai phải đi sửa.

`AI_ALLOW_CUSTOMER_SEND` vẫn là `false` ở mức môi trường. Bật nấc COPILOT ở bản nhân sự KHÔNG làm
tin nào đi ra cho tới khi chủ shop tự lật công tắc đó.

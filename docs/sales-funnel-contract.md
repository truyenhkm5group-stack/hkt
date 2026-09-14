# Hợp đồng phễu bán hàng ERP

Kèm `docs/business-rules/ORDER_OUTCOME.md` — bước cuối của phễu **phải** dùng lại công thức kết quả
đơn ở đó, không được tự viết điều kiện.

## Kết luận trước, giải thích sau

Kế hoạch đề nghị phễu bảy bước:

> Lead / Hội thoại → Đã liên hệ → Đủ điều kiện → Đặt hàng → Xác nhận → Giao thành công → Mua lại

**ERP chỉ chứng minh được năm bước.** Hai bước **Đã liên hệ** và **Đủ điều kiện** KHÔNG có nguồn dữ
liệu nào trong kho mã này. Bịa ra chúng bằng cách suy từ đơn hàng là dựng số liệu, nên không làm.

## Năm bước đo được

| # | Bước | Nguồn sự thật | Grain |
|---|---|---|---|
| 1 | **Đơn được tạo** | `orders` — mỗi đơn Pancake là một dòng | đơn |
| 2 | **Đã xác nhận** | `orders.stage` ∉ `NEW`/`WAITING`, mốc từ `order_status_history` | đơn |
| 3 | **Đã rời kho** | `SHIPMENT_LEFT_WAREHOUSE` — mốc lấy hàng / trạng thái vận đơn dựng từ sự kiện Viettel Post | vận đơn |
| 4 | **Giao thành công** | `ORDER_OUTCOME = 'DELIVERED'` | đơn × vận đơn |
| 5 | **Mua lại** | khách có đơn thứ hai trở lên, tính theo `orders.customer_id` | khách |

Bước 3 CỐ Ý dùng `SHIPMENT_LEFT_WAREHOUSE` chứ không dùng trạng thái Pancake: Pancake nói "đã gửi"
khi người bán bấm nút, còn hàng rời kho là một sự kiện của Viettel Post.

Bước 4 CỐ Ý dùng `ORDER_OUTCOME` chứ không dùng `shipments.stage = 'DELIVERED'`: Viettel Post ghi
"giao thành công" cho cả chiều hoàn và cả đơn giao một phần.

## Hai bước KHÔNG đo được, và vì sao

### "Đã liên hệ" — ĐÃ CÓ NGUỒN từ 12/09/2026 (mục này từng SAI)

> **SỬA LẠI.** Bản trước của tài liệu này viết *"ERP không đồng bộ hội thoại Pancake"* và kết luận bước
> "đã liên hệ" là không đo được. **Câu đó sai.** Job `cs-chat` VẪN đọc hội thoại Pancake và tới 50 tin
> nhắn mỗi hội thoại, 15 phút một lần — nó chỉ **không lưu lại**. Thậm chí nó đã tính sẵn lúc khách cho
> SĐT và lúc khách cho địa chỉ rồi ném đi.
>
> Từ 12/09/2026 bằng chứng đó được giữ ở bảng `conversation_funnel` (migration `0065`), nên bước "đã
> liên hệ" đo được — dưới tên đúng của nó: **"đã được trả lời"** (`first_shop_reply_at`, tin của shop gửi
> SAU tin đầu của khách). Đặc tả: `docs/revenue-conversion-contract.md`.

`orders.conversation_id` vẫn chỉ tồn tại **sau khi đơn đã được tạo**, nên nó vẫn không phải bằng chứng
của việc liên hệ — mốc phản hồi lấy từ chính tin nhắn, không từ đơn.

Điều kiện để công bố tỷ lệ chuyển hội thoại → đơn (xem `docs/revenue-conversion-contract.md` §3): kỳ phải
nằm trong khoảng đã quét, mẫu ≥ 20 hội thoại, và phép ghép đơn phải chắc chắn. Ngoài ba điều kiện đó thì
tỷ lệ vẫn là số bịa — cửa sổ quét 48 giờ và trần 200 hội thoại mỗi page làm mẫu vừa lệch vừa bị cắt.

### "Đủ điều kiện" — VẪN không đo được, và đã được khai chính thức

Pancake không có bước "qualified". `orders.stage` đi thẳng từ mới sang đã xác nhận. Không suy ra được
từ bất cứ trường nào.

Điều này **không đổi** sau khi có dữ liệu hội thoại: mọi căn cứ nghĩ ra được đều là (a) đổi tên chính
mốc "đã có SĐT / địa chỉ" — nhân đôi một sự thật rồi gọi là hai bước, hoặc (b) tìm từ khoá trong câu
chữ — đúng loại suy diễn đã dựng ra 181 case sai.

Nên nó được **khai** ở `UNMEASURABLE_STAGES` (`lib/constants/conversion.ts`) kèm lý do và hiện thành một
dòng "KHÔNG ĐO ĐƯỢC" trên màn hình; `tests/conversion-funnel.test.ts` khẳng định nó không bao giờ có số.

## Ai làm bước nào — độ phủ phải hiện ra

Bốn trường người phụ trách trong `orders`, và chúng **không thay thế được cho nhau**:

| Trường | Nghĩa | Dùng cho |
|---|---|---|
| `seller_name` | người bán / chốt đơn | hiệu suất bán |
| `care_name` | người chăm sóc | hiệu suất CSKH |
| `marketer_name` | người chạy quảng cáo | báo cáo marketer |
| `creator_name` | người tạo đơn trên hệ thống | truy vết thao tác |
| `order_status_history.editor_name` | người đổi trạng thái, kèm mốc thời gian | **ai xác nhận đơn, lúc nào** |

`editor_name` là trường **duy nhất** có kèm mốc thời gian, nên nó là nguồn duy nhất trả lời được
"đơn này ai xác nhận và mất bao lâu".

**Luật: mỗi chỉ số hiệu suất nhân sự phải kèm ĐỘ PHỦ** — bao nhiêu phần trăm đơn trong kỳ có trường
đó. Trường trống không được gộp vào một người nào; nó vào nhóm **"Chưa gán"** hiện tường minh.
Không có độ phủ thì một người xử lý 10 đơn trong tổng 100 đơn có gán trông y hệt người xử lý 10 đơn
trong tổng 1.000 đơn.

## Đo trên kỳ nào

Phễu tính theo **kỳ tạo đơn** (`orders.inserted_at`), không phải theo ngày xảy ra từng bước. Đơn tạo
ngày 01 mà giao ngày 05 vẫn thuộc kỳ ngày 01.

Lý do: phễu trả lời "trong số đơn phát sinh kỳ này, bao nhiêu đi tới cuối". Nếu mỗi bước đếm theo
ngày riêng thì bước sau có thể lớn hơn bước trước — một phễu phình ra ở giữa, vô nghĩa.

**Hệ quả phải chấp nhận:** kỳ vừa kết thúc luôn có tỷ lệ giao thành công thấp giả tạo vì đơn cuối kỳ
chưa kịp giao xong. ERP hiện thêm số đơn **chưa kết thúc** của kỳ để người đọc biết phần nào còn
đang chạy, thay vì lặng lẽ tính chúng là thất bại.

## Cấm

1. Không suy "đã liên hệ" hoặc "đủ điều kiện" từ bất kỳ trường nào.
2. Không dùng trạng thái Pancake làm bằng chứng giao thành công.
3. Không chia đều đơn "chưa gán" cho các nhân viên để tổng đẹp.
4. Không đánh giá nhân sự chỉ bằng số lượng — phải kèm giá trị giao thành công và tỷ lệ hoàn.
5. Không hiện tỷ lệ chuyển đổi khi độ phủ dưới ngưỡng mà không kèm cảnh báo độ phủ.

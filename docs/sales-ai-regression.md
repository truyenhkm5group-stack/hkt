# Bộ ca hồi quy nhân sự bán hàng

```
npm run ai:regression                    # ca dựng sẵn + ca người soát đã bấm thêm
npm run ai:regression -- --seed-only     # chỉ ca dựng sẵn, KHÔNG chạm CSDL
npm run ai:regression -- --case=<khoá>   # một ca, in đủ từng lượt của dây chuyền
npm run ai:regression -- --json          # cho máy đọc
```

Mã thoát `0` khi mọi ca đạt, `1` khi có ca trượt.

## 1. Vì sao nó tồn tại

Bộ kiểm thử sẵn có khoá từng **hàm**: bóc ý định, quyết định, xác nhận có ngữ cảnh. Nhưng cái hỏng
trong bán hàng qua chat hiếm khi là một hàm — nó là một **dây chuyền** đi sai ở lượt thứ hai.

Bằng chứng, lấy từ chính lượt chạy đầu tiên của bộ ca này (19/09/2026):

| Câu của khách | Máy hiểu ra | Hậu quả |
|---|---|---|
| `vâng` (sau khi đã chốt "đỏ đô / XL") | khách **đổi sang màu Vàng** | mẫu mã đã chốt bị xoá, hội thoại lùi lại |
| `mặc size gì em` | khách **chọn size "G"** | không mẫu mã nào khớp, hội thoại đứng |
| `Lấy cho chị màu đỏ đô size XL` | chỉ là chọn mẫu mã, **không phải ý muốn mua** | máy hỏi lại đúng cái màu khách vừa nói |
| `Hàng bị lỗi, tôi muốn trả lại` | **không hiểu khách muốn gì** | ca khiếu nại nằm nhầm ô trong mọi báo cáo |

Không hàm nào trong bốn dòng trên sai. `normalize()` bỏ dấu đúng như nó được viết ra để làm; phép
khớp từ khoá khớp đúng những gì được khai. Chỉ khi ghép lại thành một cuộc hội thoại nhiều lượt thì
hậu quả mới hiện ra.

## 2. Một ca gồm những gì

```
input     messages[]      tin của khách, mốc là SỐ PHÚT kể từ tin đầu
          priorState      trạng thái hội thoại TRƯỚC tin đầu
          priorStage
          toolResults     kết quả từng công cụ ERP, ĐÃ CHỤP
          context         ai đang cầm việc · đã có đơn chưa · tồn có biết không
expected  intents · stage · action · handoff · handoffReason
          state           size · màu · SĐT · số lượng · ý muốn mua · đã khoá mẫu mã
          replyMustContain / replyMustNotContain
```

Ba điều quyết định toàn bộ thiết kế:

**Ca chụp cả kết quả công cụ ERP.** Chạy lại một ca không được phép hỏi CSDL: tồn kho hôm nay khác
hôm ghi ca. Một ca đỏ vì kho vừa bán hết hàng là một ca người ta đi gia hạn con số thay vì đọc thông
điệp — đúng thứ AGENTS.md mục 50 cấm.

**Mốc trong ca là tương đối.** `minutesFromStart`, và đồng hồ do trình chạy cấp. Ghim một ngày tuyệt
đối rồi gieo dữ liệu quanh nó là quả bom hẹn giờ đã nổ hai lần trong kho mã này.

**Kỳ vọng không khai thì không kiểm.** `null` = người soát chưa quyết chiều ấy. Ép khai đủ mười hai
chiều thì người ta khai bừa cho xong, và một ca khai bừa luôn xanh nên không ai đọc lại nó nữa.

## 3. Chạy lại bằng ĐÚNG dây chuyền đang phục vụ khách

`lib/ai-workforce/agents/sales/regression.ts` gọi đúng bốn hàm mà `runSalesTask` gọi —
`understandByRule` → `applyUnderstanding` → `checkContextualConfirmation` → `decide` — rồi dựng câu
bằng `renderTemplate`. Không viết lại một bước nào. Khác duy nhất là công cụ ERP đọc từ ảnh chụp.

Viết một bản mô phỏng riêng cho phép chạy lại sẽ làm bộ ca đo một dây chuyền **khác** dây chuyền
đang chạy thật — và đó đúng là thứ nó sinh ra để ngăn.

**Không gọi mô hình.** Bậc luật là bậc tất định: cùng đầu vào ra cùng đầu ra, hôm nay và sáu tháng
nữa. Một bộ ca gọi mô hình thì mỗi lần chạy ra một kết quả hơi khác, và người đọc sẽ học cách bỏ qua
nó. Thứ bộ ca này đo là **nghiệp vụ** — giữ đúng mẫu mã qua nhiều lượt, chuyển người đúng lúc, không
hứa thứ chưa biết — và cả ba đều nằm ở bậc luật. Mô hình vẫn được đo, nhưng ở `/ai/review`, nơi có
cả câu chữ và có người chấm.

## 4. Chín ca dựng sẵn

Đi theo kho mã (`lib/constants/sales-regression-seed.ts`), chạy với CSDL rỗng, trên máy bất kỳ,
trong khoảng 25 ms.

| | Tình huống | Điều phải giữ |
|---|---|---|
| A | hỏi giá | ba con số đúng vai: tiền hàng · phí ship · **tổng**. Thiếu vế tiền hàng thì khách tự cộng ra một số thứ tư |
| B | hỏi size, **có** bảng số đo | phải trả lời được, không đẩy sang người |
| C | hỏi size, **không có** bảng | `SIZE_DATA_MISSING` + chuyển người, và câu trả lời không được chứa một size nào |
| D | chốt mẫu mã rồi nhắn `vâng` | size · màu · ý muốn mua · mẫu mã đều còn nguyên |
| E | đổi mẫu mã giữa chừng | lựa chọn **mới** thắng, lựa chọn cũ biến mất |
| F | khách chỉ gửi số điện thoại | là tiến triển của cuộc bán, không phải hội thoại mới |
| G | khiếu nại đòi trả hàng | chuyển người, lý do `COMPLAINT` |
| H | mẫu chưa biết là mẫu nào | không báo giá, không hứa còn hàng |
| I | `Lấy cho chị …` | là câu **mua**; đã nói rồi thì không được hỏi lại |

Mỗi kỳ vọng viết theo **đặc tả**, không theo mã. Đó là cả giá trị của bộ ca: sửa một kỳ vọng cho
khớp với thứ mã đang làm là làm ca ấy thôi đo bất cứ điều gì.

## 5. Thêm ca từ màn hình soát

`/ai/<mã lượt chạy>` → mục 12 → **Thêm vào bộ hồi quy**. Form khai kỳ vọng rồi lưu vào
`sales_regression_cases`; lượt chạy `npm run ai:regression` kế tiếp đọc chúng cùng với ca dựng sẵn.

**Form không điền sẵn kết quả thật.** Kỳ vọng phải là thứ *đáng lẽ* máy phải làm, không phải thứ máy
*đã* làm. Điền sẵn rồi để người soát bấm Lưu là biến bộ hồi quy thành cái máy chụp ảnh hành vi hiện
tại — nó sẽ xanh mãi mãi, kể cả khi hành vi ấy sai.

Bấm lại trên cùng một lượt là **cập nhật** (khoá duy nhất `case_key = review-<mã lượt chạy>`), không
đẻ ca thứ hai. Hai ca trùng làm mọi tỷ lệ đọc từ bộ hồi quy lệch đi, và lệch âm thầm.

Tắt một ca bằng `active = false`, không xoá: một ca sai cũng là một quyết định đã có người đưa ra.

## 6. Đọc báo cáo

```
tổng 10 · ĐẠT 9 · TRƯỢT 1 · lỗi dây chuyền 0 · 24 ms

gom theo loại:
    1 × Chuyển người sai lúc (hoặc không chuyển khi phải chuyển) [RULES]
```

Chín loại thất bại, mỗi loại khai luôn **ai phải đi sửa** — `MODEL` · `RULES` · `DATA` · `SYSTEM`.
Một bảng lỗi không nói ai đi sửa là bảng không ai mở lần thứ hai.

`ERROR` (dây chuyền ném) đếm **riêng** khỏi mọi loại còn lại: "không đo được" khác hẳn "đo được và
ra sai", và gộp chúng làm người đọc đi sửa nhầm chỗ.

Không đọc được ca trong CSDL thì trình chạy **nói ra**, không im lặng coi như có 0 ca — hai điều ấy
khác nhau, và gộp lại thì một lượt chạy thiếu mất nửa bộ ca vẫn báo "tất cả đạt".

## 7. Ranh giới

Bộ ca này **không** gọi mạng, **không** gọi mô hình, **không** ghi CSDL, và **không** gửi gì cho
khách. Nó chạy được khi không có CSDL nào — vì nó phải chạy được **trước** khi đẩy mã, trên máy của
người viết, chứ không phải chỉ trên bản chạy thử.

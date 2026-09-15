# Nấc TRỢ LÝ bán hàng — sổ tay thí điểm

**Máy soạn → nhân viên đọc, sửa nếu cần → nhân viên bấm gửi.** Không có đường nào cho máy tự gửi.

## 1. Ba công tắc, và ai mở được cái nào

| Công tắc | Nghĩa | Ở đâu | Ai mở được |
|---|---|---|---|
| `AI_ALLOW_AUTO_SEND` | MÁY tự nhắn khách | ghim `"false"` trong `docker-compose.staging.yml` | **không ai** — phải sửa tệp, commit, qua cổng kiểm thử, dựng lại |
| `AI_ALLOW_HUMAN_APPROVED_SEND` | NHÂN VIÊN bấm gửi | `.env.staging` | thao tác ops `ai-staging-copilot` |
| `AI_ALLOW_ORDER_CREATE` | tạo / chốt đơn trên POS | ghim `"false"` | **không ai** (giai đoạn này) |

Tên cũ `AI_ALLOW_CUSTOMER_SEND` sau bản tách **chỉ còn nghĩa "nhân viên bấm gửi"**. Nó không bao giờ
mở được đường máy tự gửi, kể cả khi ai đó bật nó lên vì quen tay.

## 2. Sáu cửa cho một lần gửi

Một câu do AI soạn chỉ tới được khách khi **cả sáu** cùng đúng:

1. có phiên đăng nhập (`requireUser`) — job nền không có phiên nên không đi qua được cửa này;
2. có quyền `ai:send` (quyền RIÊNG, tách khỏi `ai:view` và khỏi `ai:manage`);
3. nấc quyền hạn thật trong `ai_agents` ≥ `COPILOT` — đọc lại từ CSDL, không nhận từ nơi gọi;
4. `page_id` có tên trong `settings["ai.copilotPages"]`;
5. câu gợi ý còn hiệu lực: chưa quá 30 phút **và** chưa có tin khách nào mới hơn;
6. chưa ai kết thúc câu ấy — ràng buộc duy nhất ở CSDL, nên hai tab cùng bấm chỉ ra một tin.

Cửa 6 nằm ở CSDL chứ không ở tầng ứng dụng vì hai lượt bấm song song đều đọc thấy "chưa gửi" trước
khi lượt nào kịp ghi. Và dòng sổ được ghi **trước** khi gọi Pancake: ghi sau thì tiến trình chết
đúng khe giữa hai bước là tin đã đi mà sổ không có dòng nào.

## 3. Bật thí điểm cho MỘT page

Chạy workflow **Vận hành ERP trên VPS** trên nhánh `claude/ai-workforce-sales-v1`:

```
action = ai-staging-copilot
arg    = --page=1117899664739453 --on
```

Thao tác này đặt ba thứ rồi **đọc lại từ bản đang chạy** để in ra: nấc `COPILOT` cho nhân sự
`sales`, danh sách page `["1117899664739453"]`, và `AI_ALLOW_HUMAN_APPROVED_SEND=true`. Nó cũng ghi
đè `AI_ALLOW_AUTO_SEND=false` một lần nữa — thừa, và cố ý thừa.

Tắt: `arg = --off` (danh sách page về rỗng, nấc về `SHADOW`, công tắc người-bấm về false).

Mở hàng đợi: `http://127.0.0.1:3100/ai/copilot` qua tunnel SSH.

## 4. Nhân viên làm gì trên hàng đợi

| Nút | Ghi lại gì |
|---|---|
| **Gửi nguyên văn** | `SEND` · câu máy soạn = câu gửi · khoảng cách sửa 0 |
| **Sửa & gửi** | `EDIT_SEND` · lưu **cả hai** câu + khoảng cách sửa |
| **Từ chối** | `REJECT` + một trong 11 lý do (một cú bấm) · **không gửi gì** |
| **Soạn lại** | `REGENERATE` · xếp việc cho dây chuyền đọc lại · **không gửi gì** |
| **Tự nhận việc** | `TAKEOVER` · máy im lặng tới khi chính người ấy trả lại |

Mọi dòng mang `users.id` của người bấm. Tên hiển thị do **máy chủ** đọc từ phiên, không nhận từ
client — client gửi tên khác với khoá thì dòng dữ liệu nói một đằng còn quy kết một nẻo.

## 5. Đọc số

`/ai/copilot` in ở đầu trang: gợi ý đã soạn · gửi nguyên văn · sửa rồi gửi · từ chối · **tỷ lệ dùng
được** · thời gian soát trung vị · số tin **thật sự** đã rời khỏi ERP (đọc từ sổ thao tác, không suy
từ cờ nào).

Hai con số quan trọng nhất của đợt thí điểm:

- **Tỷ lệ dùng được** = (gửi nguyên văn + sửa rồi gửi) / (tổng số lượt đã quyết định).
- **Tỷ lệ phải sửa đáng kể** — ngưỡng 20% ký tự. Đổi một dấu chấm **không** tính; viết lại nửa câu
  thì tính. Đếm "có sửa hay không" sẽ nói sai về chất lượng theo hướng bi quan.

Mẫu số rỗng ⇒ in `—`, không in `0%`.

## 6. Ba điều đã biết trước, để không ai ngạc nhiên giữa đợt

1. **Chưa có bảng số đo cho Q004.** Khách hỏi "50kg mặc size gì" ⇒ máy **chuyển người**, không đoán.
   Trên mẻ đo gần nhất việc này chiếm 3/18 lượt. Khai `settings["ai.sizeRules"]` thì con số ấy về
   gần 0.
2. **Chưa khai đơn giá mô hình** ⇒ chi phí mỗi lượt là `CHƯA BIẾT`. Không ghi `0 ₫`.
3. **Bộ đếm "hỏi mãi một thứ" tăng khi máy SOẠN, không phải khi người GỬI.** Một câu bị từ chối vẫn
   được tính là đã hỏi, nên máy chuyển người sớm hơn thực tế một chút. Sai về phía an toàn, và ghi
   ra đây để không ai đọc nhầm con số.

## 7. Đợt thí điểm 20–50 lượt

Thứ tự đề nghị:

1. Bật cho đúng page WIN (mục 3). Kiểm lại đầu trang `/ai/copilot`: nấc **Trợ lý** · MÁY tự gửi
   **CẤM** · NHÂN VIÊN bấm gửi **được phép** · page đúng một mã.
2. Một nhân viên trực, xử lý **20–50 lượt khách nhắn** bằng năm nút trên.
3. Không gửi hàng loạt. Mỗi tin là một cú bấm của một người đã đọc.
4. Cuối đợt đọc lại sáu con số ở mục 5, và mở `/ai/review` chấm tay ~30 lượt: chỉ ở đó mới có
   những chiều máy **không** tự chấm được (hiểu đúng ý, đúng sản phẩm, giọng có tự nhiên không).

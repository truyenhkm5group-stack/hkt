# Nối hội thoại Pancake vào nhân sự AI — hướng dẫn cấu hình

> Trạng thái: **nấc chạy ngầm (SHADOW)**. Làm xong toàn bộ hướng dẫn này thì ERP đọc được tin nhắn
> thật của khách và soạn gợi ý cho nhân viên — **không câu nào được gửi cho khách**.

## 0. Điều phải biết trước: đường webhook CHƯA ĐƯỢC KIỂM CHỨNG

Tài liệu Pancake trong kho mã (`docs/API-PANCAKE-VIETTELPOST.md`) liệt kê **bốn** loại webhook của
Pancake POS: `orders` · `customers` · `products` · `variations_warehouses`. **Không có loại nào cho
tin nhắn.** Trong phiên làm việc này mọi tên miền tài liệu của Pancake (`pages.fm`,
`docs.pancake.biz`, `developer.pancake.biz`) đều bị chặn ở lớp mạng, nên không xác minh được.

Hệ quả, và cách đã xử lý:

| | Đường ĐỌC BÙ QUA API | Đường WEBHOOK |
|---|---|---|
| Mức tin cậy | **ĐÃ KIỂM CHỨNG** — `PancakePagesClient` đang chạy thật trong job `cs-chat` | **CHƯA KIỂM CHỨNG** |
| Tên trường | Lấy từ mã đang chạy | Suy đoán, khai rõ trong `lib/constants/sales-ingest.ts` |
| Khi không nhận dạng được | không xảy ra | Gói tin vẫn được **lưu nguyên văn**, ghi chẩn đoán, KHÔNG đoán bừa |

**Vì thế: bật đường đọc bù trước (mục 2), webhook sau (mục 3).** Bộ chuẩn hoá không bao giờ đoán —
thiếu một trong ba khoá bắt buộc thì nó từ chối và ghi lại *thiếu khoá nào* + *gói tin thật sự có
khoá gì*, đủ để hoàn thiện ánh xạ trong vài phút khi có một mẫu thật.

## 1. Chuẩn bị

| Việc | Ở đâu | Ghi chú |
|---|---|---|
| Lấy access token Pancake | pancake.vn → Cài đặt → Công cụ (Tools) → API / Access token | Token của NGƯỜI có quyền trên các page bán hàng |
| Đặt `PANCAKE_ACCESS_TOKEN` | `.env` trên VPS | Đã có sẵn nếu job `cs-chat` đang chạy |
| Kiểm tra kết nối | ERP → Kết nối dữ liệu → thẻ **Pancake Pages (chat)** → *Kiểm tra kết nối* | Phải liệt kê được các page |

## 2. Bật đường đọc bù (làm trước)

1. ERP → **Kết nối dữ liệu** → thẻ *Pancake Pages (chat)* → bấm **Nạp hội thoại cho nhân sự AI**.
   (Job `ai-sales-ingest`, đọc 6 giờ gần nhất.)
2. Mở **Nhân sự AI → Soát & chấm tay**. Phải thấy các lượt khách nhắn kèm câu gợi ý của máy.
3. Kiểm tra hai con số ở khối *Đo trực tiếp*:
   - **Gửi cho khách = 0** — đây là phép thử thường trực của nấc chạy ngầm.
   - **Lỗi = 0**.

Muốn chạy định kỳ: bỏ dấu chú thích dòng `ai-sales-ingest` trong `scripts/scheduler.mjs`.
Đang để chú thích một cách có chủ ý — đổi lịch chạy là việc phải hỏi chủ shop (AGENTS.md §7).

## 3. Bật webhook hội thoại (sau khi mục 2 chạy ổn)

### 3.1 Sinh bí mật

```bash
openssl rand -hex 24
```

Chuỗi 48 ký tự hex. Đặt vào `.env` trên VPS:

```
PANCAKE_CHAT_WEBHOOK_SECRET="<chuỗi vừa sinh>"
```

Rồi khởi động lại ERP. **Để trống = webhook trả 401** (đóng, không phải mở toang).

### 3.2 URL webhook

```
https://<tên miền ERP>/api/webhooks/pancake-chat/<PANCAKE_CHAT_WEBHOOK_SECRET>
```

URL đầy đủ hiện sẵn (kèm nút sao chép) ở **Kết nối dữ liệu → Webhook → Pancake — hội thoại**.

Đường này **tách hẳn** khỏi webhook đơn hàng `/api/webhooks/pancake/<secret>` một cách có chủ ý:
luồng đơn hàng đang nuôi mọi báo cáo doanh thu và không được phép hỏng vì một tính năng mới.

### 3.3 Khai trên Pancake

Khai cho **page bán hàng** (page mà khách nhắn tin tới), chọn sự kiện **tin nhắn mới**.
Đường dẫn menu chính xác tuỳ bản Pancake — nếu không tìm thấy mục webhook cho hội thoại thì **rất
có thể Pancake không hỗ trợ**, và đường đọc bù ở mục 2 là cách duy nhất. Điều đó không sao: chống
trùng nằm ở tầng dữ liệu nên hai đường chạy song song hay chỉ một đường đều an toàn.

### 3.4 Kiểm chứng đã đăng ký được

```bash
curl -s "https://<tên miền>/api/webhooks/pancake-chat/<bí mật>" | jq
# → {"ok":true,"message":"Webhook hội thoại Pancake sẵn sàng..."}

curl -s "https://<tên miền>/api/webhooks/pancake-chat/sai-bi-mat" -o /dev/null -w "%{http_code}\n"
# → 401
```

### 3.5 Gửi một tin thật để thử

1. Nhắn **một tin từ tài khoản Facebook cá nhân** vào page bán hàng (đừng dùng hội thoại của khách thật).
2. Trong vòng vài giây, kiểm tra theo thứ tự:

| Nơi kiểm tra | Mong đợi |
|---|---|
| Kết nối dữ liệu → *Webhook đã nhận* | Một dòng nguồn **Pancake — hội thoại**, trạng thái `PROCESSED` |
| Nhân sự AI → Soát & chấm tay | Một lượt mới: tin khách + câu máy gợi ý |
| Nhân sự AI → thẻ *Gửi cho khách* | Vẫn **0** |
| Facebook Messenger | Khách **không** nhận được tin nào |

Bằng SQL (ops `db-query`, mỗi lần một câu):

```sql
select source, event_type, status, delivery_count, received_at, error
from webhook_events where source = 'PANCAKE_CHAT' order by received_at desc limit 5;

select external_id, direction, sender_type, ingest_source, left(text, 40) as doan_dau, sent_at
from sales_messages order by created_at desc limit 10;

-- PHẢI luôn bằng 0 ở nấc chạy ngầm
select count(*) from sales_suggestions where sent;
```

### 3.6 Nếu gói tin bị đánh dấu không nhận dạng được

Phản hồi của webhook có `"recognized": false`, và sổ lỗi ghi rõ thiếu khoá nào:

```sql
select scope, message, detail, created_at from ai_errors where scope = 'WEBHOOK' order by created_at desc limit 5;
```

Trường `detail.seenKeys` liệt kê các khoá **thật sự có** trong gói tin. Gửi phần đó (gói tin đã che
nội dung) cho người phát triển là đủ để hoàn thiện ánh xạ. Gói tin vẫn nằm nguyên trong
`webhook_events.payload`, không mất.

Công cụ hỗ trợ, che token và nội dung tin nhắn trước khi in:

```bash
npx tsx scripts/pancake-chat-probe.ts
```

## 4. Webhook và đọc bù chạy song song có sao không

Không. Chống trùng nằm ở **tầng dữ liệu**, hai lớp:

1. Khoá duy nhất `sales_messages(conversation_id, external_id)` — bắt được khi hai đường dùng cùng mã tin nhắn.
2. **Vân tay nội dung** (chiều gửi + mốc tới giây + nội dung) — bắt được cả khi hai đường đánh mã
   *khác nhau*, và lần đó được ghi vào `ai_errors` để ánh xạ được sửa cho đúng.

Khách nhắn lại đúng câu cũ ở thời điểm khác vẫn là hai tin thật — mốc thời gian nằm trong vân tay
chính vì lý do đó.

## 5. Nên bật đường nào cho shop

| Tình huống | Khuyến nghị |
|---|---|
| Pancake **không** có webhook hội thoại | Chỉ bật đọc bù, lịch 5–10 phút |
| Pancake **có** webhook hội thoại | Bật cả hai: webhook cho tức thì, đọc bù để vá gói tin rơi |
| Đang thử lần đầu | Chỉ đọc bù, chạy tay từ trang Kết nối dữ liệu |

## 6. Tắt khẩn cấp

| Mức | Lệnh | Tác dụng |
|---|---|---|
| 1 | `set-setting ai.config '{"enabled":false}'` | Dừng toàn bộ nhân sự AI ngay; tin nhắn vẫn được ghi |
| 2 | `set-setting ai.config '{"ingestEnabled":false}'` | Ngừng nạp hội thoại mới |
| 3 | Xoá `PANCAKE_CHAT_WEBHOOK_SECRET` khỏi `.env`, khởi động lại | Webhook trả 401 |

Không mức nào làm mất dữ liệu đã nạp.

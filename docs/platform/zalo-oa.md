# Zalo OA — kênh chat của chatbot bán hàng

Chủ shop chốt 04/10/2026: khách **không dùng Pancake** vẫn phải dùng được chatbot bán hàng. Zalo OA là kênh thứ hai sau
fanpage, đi vào **cùng** bộ máy (`chatTurn`, kênh `ZALO`): giá / tồn đọc từ ERP, khoá AI của shop, đơn ghi vào ERP, chuyển
nhân viên.

## Mô hình: app Zalo của chính shop

Mỗi shop tạo **một ứng dụng Zalo của mình** (developers.zalo.me) và liên kết với OA của mình. Nền tảng **không** có app Zalo
chung nào phải duyệt, nên không có cửa phê duyệt nào của Zalo chặn việc mở cho khách mới.

| Ô | Lấy ở đâu | Dùng làm gì |
|---|---|---|
| App ID | Thông tin ứng dụng | Làm mới token · thành phần của chữ ký webhook |
| OA ID | Trang OA | Chặn tin của OA khác; so với OA của token khi Kiểm tra |
| App Secret | Thông tin ứng dụng | Header `secret_key` khi làm mới token |
| OA Secret Key | Mục Webhook của app | Kiểm chữ ký từng gói tin — **khác** App Secret |
| Refresh token | API Explorer (OA Access Token) | Máy tự làm mới; dùng **một lần** |

## Bốn sự thật vận hành

1. **Chữ ký trên thân THÔ.** `X-ZEvent-Signature: mac=<hex>`, `mac = SHA256(app_id + body + timestamp + OA Secret Key)`.
   Parse rồi dump lại JSON là sai chữ ký.
2. **Refresh token dùng một lần.** Mỗi lần làm mới, Zalo cấp cặp mới và huỷ cặp cũ. Máy lưu cặp mới **ngay trong cùng giao
   dịch** (`rotateOrgConnectionSecrets`, khoá tư vấn theo tổ chức + kết nối), kể cả khi lượt «Kiểm tra» sau đó hỏng. Hai
   luồng cùng thấy token hết hạn ⇒ luồng sau đọc lại và dùng token mới, không làm mới lần hai.
3. **Cửa sổ 48 giờ.** Tin tư vấn miễn phí trong 48 giờ từ tương tác cuối của khách; 48 giờ – 7 ngày Zalo **tính phí**; quá 7
   ngày API từ chối. Bot **chỉ gửi trong 48 giờ** và kiểm cửa sổ **trước** khi gọi AI. Bản này không có nhắc khách tự động
   trên Zalo.
4. **Tin của chính OA tới lại qua webhook** (`oa_send_*`). Đúng mã tin bot vừa gửi, hoặc trùng nguyên văn trong 10 phút ⇒
   tiếng vọng của bot. Còn lại là **nhân viên** trả lời trong OA Manager ⇒ bot nhường hội thoại 30 phút.

## Cài đặt

1. Cài đặt → Kết nối → «Zalo OA»: nhập năm ô → Lưu → **Kiểm tra** (làm mới token, đọc thông tin OA, không gửi tin cho ai) → Bật.
2. Trang Chatbot bán hàng → khối «Zalo OA»: chép URL webhook (mang token của tổ chức — giữ kín).
3. Zalo Developers → Webhook: dán URL, bật sự kiện «Người dùng gửi tin nhắn» và «OA gửi tin nhắn».

## Chưa làm ở bản này

- Ảnh của câu trả lời mẫu chưa gửi qua Zalo (cần tải ảnh lên Zalo trước) — phần chữ vẫn đi, ghi chú tin nói rõ.
- Không có nhắc khách im lặng (follow-up) trên Zalo — đúng loại tin dễ rơi vào vùng tính phí.
- Tin rơi lúc máy khởi động lại được xử lý bù ở webhook kế tiếp của cùng tổ chức (`sweepStaleZaloThreads`), chưa có lượt quét
  theo lịch.

Mã: `lib/integrations/zalo/` · `lib/sales-chatbot/zalo.ts` · `app/api/webhooks/zalo-oa/[token]/route.ts` · bài kiểm
`tests/zalo-oa.test.ts`.

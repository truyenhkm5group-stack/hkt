# Meta App Review — Messenger trực tiếp (đợt đầu)

Bộ tài liệu để chủ nền tảng nộp App Review cho app Facebook của nền tảng (cùng app «Đăng nhập bằng Facebook», khai ở VPS bằng
`FACEBOOK_LOGIN_APP_ID` / `FACEBOOK_LOGIN_APP_SECRET`). Không ghi app id, app secret, token hay mật khẩu nào vào kho — kho PUBLIC.

## Vì sao cần (đo production 06/10/2026)

```
[messenger-connect] org=hslc-hmt-shop reason=PERMISSION_NOT_GRANTED granted=public_profile declined=- missing=pages_show_list,pages_messaging,pages_manage_metadata accounts=0
```

Hộp thoại Facebook chỉ cấp `public_profile`: các quyền page không hề được hỏi. Có hai khả năng, sửa ở hai chỗ khác nhau, và từ
bản này ERP tự tách được bằng vai trò của người bấm trong app (`GET /{app-id}/roles`):

| Lý do ERP in ra | Nghĩa | Ai sửa |
|---|---|---|
| `PERMISSION_NOT_IN_APP` | Người bấm CÓ vai trò (admin / developer / tester) mà vẫn không được cấp ⇒ quyền chưa được THÊM vào app (use case Messenger chưa thêm / chưa tuỳ chỉnh) | Chủ nền tảng — App Dashboard → Use cases |
| `PERMISSION_NEEDS_APP_REVIEW` | Người bấm KHÔNG có vai trò ⇒ cần Advanced Access | Chủ nền tảng — App Review (bộ tài liệu này) |
| `PERMISSION_NOT_GRANTED` | Thiếu quyền nhưng không đọc được vai trò — không đoán | Chủ nền tảng kiểm cả hai chỗ trên |

Đủ bảng lý do (7 lý do + hướng xử lý) ở [02-kiem-thu-va-webhook.md §4](02-kiem-thu-va-webhook.md#4-chẩn-đoán-trên-erp--bảng-lý-do).

## Mục lục

1. [01-quyen-va-dieu-kien.md](01-quyen-va-dieu-kien.md) — use case, checklist 4 quyền, Standard vs Advanced, quyền KHÔNG nộp
   đợt đầu, điều kiện tiên quyết (Business Verification, Live, Privacy Policy, Data deletion) và **việc cần làm** với trang
   chính sách.
2. [02-kiem-thu-va-webhook.md](02-kiem-thu-va-webhook.md) — luồng thử trên ERP từng bước, tài khoản / page thử, cách webhook
   xác minh (đọc từ mã), bảng chẩn đoán.
3. [03-screencast-va-bang-chung.md](03-screencast-va-bang-chung.md) — kịch bản quay màn hình theo từng quyền, bằng chứng / log
   cần giữ.
4. [04-reviewer-instructions-en.md](04-reviewer-instructions-en.md) — đoạn tiếng Anh dán thẳng vào các ô của Meta.

## Thứ tự làm

1. Điều kiện tiên quyết (01 §4) — Business Verification có thể mất vài ngày, làm TRƯỚC.
2. Thêm use case + 4 quyền vào app (01 §1). Kết nối thử bằng tài khoản có vai trò ⇒ ERP phải hết `PERMISSION_NOT_IN_APP`.
3. Chạy luồng thử (02 §1) với page thử, quay màn hình (03).
4. Điền form bằng đoạn tiếng Anh (04) và nộp — **ONE OWNER ACTION** dưới đây.

## ONE OWNER ACTION — nộp App Review (chỉ chủ nền tảng bấm; agent KHÔNG tự nộp)

Điều kiện trước khi bấm: Business Verification = Verified; Privacy Policy URL + Data deletion đã khai; luồng thử 02 §1 chạy
được bằng tài khoản tester; có video MP4 theo 03.

1. Mở **developers.facebook.com** → **My Apps** → chọn app đăng nhập của nền tảng.
2. Cột trái **Use cases** → dòng **Engage with customers on Messenger from Meta** → **Customize**.
3. Mục **Permissions**: bảo đảm `pages_show_list`, `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement` đều đã
   **Added** (nút «Add» nếu chưa). KHÔNG thêm `business_management` / `instagram_*` vào đợt này (01 §3) — hộp thoại kết nối cũng không xin chúng nữa.
4. Cùng trang, mục **Configure webhooks**: Callback URL + Verify token lấy ở ERP `/ai/sales-chatbot/messenger` (tổ chức nhà,
   khối «Người vận hành nền tảng») → **Verify and save** → bật các trường `messages`, `messaging_postbacks`,
   `message_echoes`, `feed`.
5. Cột trái **App settings → Basic**: kiểm Privacy Policy URL, User data deletion, App icon, Category (01 §4) → **Save changes**.
6. Cột trái **App Review → Requests** (hoặc **Review → App Review**) → **New request** / **Edit request**.
7. Với từng quyền trong 4 quyền: chọn **Request advanced access**, dán đoạn «How will your app use this permission» tương ứng
   ở [04](04-reviewer-instructions-en.md#2-per-permission-usage), tải video đã quay (03), tích các ô cam kết.
8. Ô **Reviewer instructions**: dán [04 §3](04-reviewer-instructions-en.md#3-reviewer-instructions), điền tài khoản đăng nhập
   ERP cho reviewer **ngay trong form Meta** (không ghi vào kho).
9. Ô **Data handling questions**: trả lời theo [04 §4](04-reviewer-instructions-en.md#4-data-handling-answers).
10. **Submit for review**. Sau khi Meta duyệt: **App settings → Basic / thanh trên cùng → App Mode: Live** (nếu chưa Live).
11. Kiểm lại: một tài khoản KHÔNG có vai trò trong app kết nối page ở ERP ⇒ chẩn đoán «Đủ quyền, có page nhắn tin được» và
    khối «Webhook theo page» báo «Webhook đã đăng ký đủ».

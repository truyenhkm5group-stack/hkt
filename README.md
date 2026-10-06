# Sổ điều phối kỹ thuật (ai-control/registry)

Nhánh này KHÔNG chứa mã. Nó là sổ đăng ký dùng chung của mọi phiên Claude Code làm việc trên kho:
sứ mệnh nào đang giữ vùng nào, số migration nào đã có người lấy, ai đang cầm khoá gộp/deploy.

Ghi bằng `npm run ai -- claim | heartbeat | close | lease | migration reserve` — không sửa tay.
Đặc tả: docs/ai-tech-room/delivery-v2.md. Sổ là LỜI KHAI; git/GitHub là SỰ THẬT (`npm run ai -- board`).

# Cầu nối mở PR chạy qua Environment `agent-identity`

*20/09/2026. Đi sau `docs/agent-pr-bridge.md` mục 4.*

Tệp này **không có mã**. Nó tồn tại để nhánh proof có một commit khác `main` — `POST /pulls`
trả 422 cho một nhánh không có commit nào khác nhánh đích, nên một phép chứng minh "cầu nối mở
được PR" cần đúng một thay đổi thật để mở PR **về**.

## Ba phép, và vì sao phải là ba

| | Phép | Trả lời câu gì |
|---|---|---|
| **A** | dispatch từ nhánh ≠ `main` | Environment có chặn **trước khi job chạy** không |
| **B** | dispatch từ `main` | cầu nối có còn chạy được sau khi secret rời khỏi mức kho không |
| **C** | đọc lại PR bằng credential **khác** | tác giả có thật sự là bot, hay chỉ trông như vậy |

Thiếu **A** thì "chạy được" không nói gì về an toàn. Thiếu **B** thì hàng rào có thể chỉ đang
chặn tất cả. Thiếu **C** thì "đã mở bằng bot" và "trông như đã mở bằng bot" nhìn giống hệt nhau —
bài học mà bộ chứng minh danh tính đã phải trả giá để rút ra.

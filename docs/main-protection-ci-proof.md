# PR proof — chỉ để đo TÊN CHECK thật trên `pull_request`

*19/09/2026. Đi kèm `docs/main-protection.md` và `.github/rulesets/main-protection.json`.*

## Vì sao tồn tại

Ruleset khoá `main` khai một **required status check** bằng TÊN. Gõ sai tên thì cái check bắt
buộc không bao giờ khớp lượt chạy nào — và hậu quả không phải một lỗi đọc được, mà là **mọi PR
treo vô hạn** với vẻ ngoài "CI hỏng". Người đi sửa sẽ soi workflow, soi runner, soi test; chỗ hỏng
thì nằm ở một chuỗi trong tệp JSON mà không ai mở.

`ci.yml` đã chạy trên `push: main`, nên tên check đã đọc được **ở nhánh đó**. Nhưng ruleset chặn
ở `pull_request`, và cho tới PR này **chưa có một lượt CI nào chạy trên sự kiện `pull_request`**
(`total_count: 0`). Đọc tên ở một sự kiện rồi áp cho sự kiện khác là ĐOÁN, và đây đúng là chỗ
không được đoán.

Nên: mở một PR thật, để nó chạy thật, rồi đọc tên check ra từ chính PR đó.

## PR này KHÔNG làm gì khác

- Không đổi luật nghiệp vụ, không đụng `ORDER_OUTCOME`, không đụng báo cáo nào.
- Không migration, không đổi lược đồ.
- Không deploy.
- Thêm đúng một tệp tài liệu — chính là tệp bạn đang đọc.

## KHÔNG merge

PR này chỉ có một việc: làm cho một lượt CI chạy trên `pull_request` để tên check hiện ra. Việc đó
xong ngay khi lượt chạy xong. Merge nó vào `main` là đẩy một tệp tài liệu về một PR đã hết nhiệm
vụ vào lịch sử nhánh chính, để đổi lấy đúng con số không.

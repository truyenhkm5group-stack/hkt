# Hướng dẫn sử dụng trong ứng dụng (`/help`)

Khách thuê theo tháng không có người ngồi cạnh chỉ cho. Trang `/help` (lối vào: ảnh đại diện góc trên → «Hướng dẫn sử
dụng») in các bài từng bước cho những việc thường làm, và câu hỏi thường gặp.

## Mỗi người chỉ thấy bài của mình

Bài khai ở `lib/constants/help-guides.ts`. Trang lọc bằng `helpGuideVisible()`:

- **Quyền**: `permission` (cổng đầu của trang) và `alsoRequires` (quyền trang đòi thêm, ví dụ tạo đơn tay cần
  `orders:write`, thiếu thì trang 404).
- **Module**: trang chính của bài phải thuộc module đang bật (`hrefVisible`).
- **Tổ chức khách**: bài `tenantOnly` (đơn tạo tay, bảng giá sỉ, công nợ, nhắc mua lại) không hiện ở tổ chức nhà — ở đó
  đơn đồng bộ từ Pancake nên các trang ấy đóng.

## Chống lỗi thời

`tests/help-guides.test.ts` đỏ khi:

1. Một đường dẫn trong bài không còn `page.tsx`.
2. Quyền khai ở bài khác quyền trang đó đòi (`requirePermission` / `requireResource`).
3. Một tên nút / tên ô đặt trong «…» không còn xuất hiện nguyên văn trong `app/`, `components/` hay nhãn ở
   `lib/constants/`.

Máy KHÔNG kiểm được câu mô tả hành vi (tiền thu nợ trừ vào đơn nào trước, khi nào đơn bị chặn vì vượt hạn mức). Đổi
luật nghiệp vụ nào có bài hướng dẫn nói về nó thì sửa bài trong CÙNG commit.

## Viết bài mới

- Mỗi câu phải đúng với mã hôm nay — kiểm nhãn nút, tên menu (nhóm «Hệ thống», không phải «Cài đặt»), quyền.
- Tên nút / tên ô đặt trong «…» để bài kiểm khoá được.
- Không hứa thứ ERP chưa làm (ví dụ: số lượng trên đơn là số NGUYÊN — không viết «bán 1,5 kg»).

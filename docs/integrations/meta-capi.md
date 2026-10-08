# Sự kiện mua hàng gửi Meta khi chốt đơn

Chủ shop HSLC chốt ngày 08/10/2026: gửi sự kiện **khi chốt đơn**, không đợi giao.

## Hoạt động thế nào

- Mỗi đơn chốt trong một hội thoại **Messenger** được gửi thành **một** sự kiện `Purchase` vào dataset Meta của chính shop.
  Sự kiện mang mã page, mã khách Messenger (PSID), giá trị đơn (VND) và mã đơn.
- Nguồn của «đã chốt» là sự kiện `order.confirmed` mà mọi đường chốt đơn tay đều ghi: bot chốt, máy ghi đơn từ hội thoại,
  nhân viên bấm, tự xác nhận đơn đủ thông tin.
- Job `meta-capi-org` chạy mỗi 10 phút. Lỗi của Meta không bao giờ chạm tới đơn hàng.
- Mỗi đơn chỉ gửi một lần. Lượt gửi lại mang cùng `event_id`, nên Meta tự bỏ bản trùng.
- Sổ `meta_conversion_events` ghi trạng thái từng đơn: đã gửi, chờ, lỗi (thử lại lùi dần tới 6 giờ), hoặc không gửi kèm
  lý do.

## Đơn không được gửi

| Lý do | Ý nghĩa |
|---|---|
| `NOT_FROM_CHAT` | Đơn lên tay / POS, không gắn với hội thoại |
| `NOT_MESSENGER` | Hội thoại Zalo, chat web, Instagram |
| `NO_PSID` | Không đọc được mã khách Messenger của hội thoại |
| `NO_VALUE` | Đơn chưa có giá trị |
| `CANCELLED_BEFORE_SEND` | Đơn huỷ trước lượt gửi |
| `TOO_OLD` | Quá 7 ngày, Meta không nhận |

## Giới hạn cần biết

- Gửi lúc chốt nên **đơn hoàn về sau vẫn được Meta đếm là lượt mua**. Meta không có lệnh huỷ sự kiện.
- Chỉ đơn chốt từ khi bật kết nối, lùi tối đa 7 ngày, mới được gửi.

## Bật cho một shop

1. Trình quản lý sự kiện → tạo hoặc chọn **dataset**, ghi lại «Mã tập dữ liệu».
2. Cài đặt doanh nghiệp → Tập dữ liệu → dataset đó → **Tài sản được kết nối** → thêm **fanpage bán hàng**.
3. Cài đặt doanh nghiệp → Người dùng hệ thống → gán dataset (quyền quản lý) → **Tạo mã token**.
4. ERP → Cài đặt → Kết nối dữ liệu → «Sự kiện chuyển đổi Meta (gửi đơn chốt)» → nhập mã dataset + token → **Kiểm tra** → **Bật**.
   Bước kiểm tra chỉ đọc dataset, không gửi sự kiện thử.
5. Sau 10–20 phút: Trình quản lý sự kiện → dataset → **Tổng quan** thấy sự kiện `Purchase` nguồn «Tin nhắn doanh nghiệp».

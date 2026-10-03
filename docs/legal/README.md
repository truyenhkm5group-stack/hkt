# Văn bản pháp lý cho khách thuê ERP — BẢN NHÁP

> **TRẠNG THÁI: NHÁP, CHƯA CÓ HIỆU LỰC.** Hai văn bản trong thư mục này do kỹ thuật soạn từ cách hệ thống THỰC SỰ vận
> hành hôm nay, để chủ nền tảng và luật sư có một bản đúng sự thật mà sửa — không phải văn bản pháp lý đã duyệt.
> Chưa trang nào hiện chúng cho khách, và `/start` chưa đòi khách đồng ý.

| Tệp | Nội dung |
|---|---|
| `terms-of-service.md` | Điều khoản sử dụng dịch vụ (khách thuê ↔ nền tảng) |
| `privacy-policy.md` | Chính sách bảo vệ dữ liệu cá nhân (dữ liệu của khách thuê VÀ của khách hàng cuối mà khách thuê nhập vào) |

## Đã công bố

- **Chính sách quyền riêng tư — phiên bản 1.0, hiệu lực 03/10/2026**: `https://vnxcommerce.com/chinh-sach-bao-mat`
  (`app/chinh-sach-bao-mat/page.tsx`). Google / Facebook đòi link này để mở đăng nhập bằng tài khoản của họ.
  - Thông tin pháp nhân do chủ nền tảng cung cấp, khai ở `lib/constants/company.ts`.
  - Các chỗ trống `[…]` của bản nháp được điền bằng điều hệ thống ĐANG làm: máy chủ VNPT tại Việt Nam, sao lưu Google
    Drive đã mã hoá, xoay vòng 7 ngày / 4 tuần, không tự xoá khi ngừng thuê.
  - Mốc «xoá trong 30 ngày kể từ khi xác minh yêu cầu» là đề xuất của kỹ thuật, chủ nền tảng đổi được.
  - Thời hạn trả lời yêu cầu và báo sự cố ghi «theo thời hạn pháp luật quy định» — chờ luật sư điền số cụ thể.
- **Điều khoản sử dụng**: vẫn là NHÁP, chưa công bố.

Còn phải nhờ luật sư rà bản 1.0; sửa thì tăng `PRIVACY_POLICY.version` trong `lib/constants/company.ts`.

## Việc chủ nền tảng phải làm trước khi dùng

1. Điền mọi chỗ `[…]`: tên pháp nhân, mã số thuế, địa chỉ, người đại diện, email / số điện thoại hỗ trợ.
2. Nhờ luật sư rà — đặc biệt: căn cứ pháp lý về dữ liệu cá nhân (Luật Bảo vệ dữ liệu cá nhân và văn bản hướng dẫn hiện
   hành), giới hạn trách nhiệm, luật áp dụng / nơi giải quyết tranh chấp, hoá đơn VAT.
3. Chốt các con số kinh doanh đang để trống: thời gian giữ dữ liệu sau khi ngừng thuê, thời hạn hoàn tiền.
4. Báo kỹ thuật khi văn bản đã duyệt. Khi đó mới làm phần cơ chế: trang công khai `/terms`, `/privacy`; ô đồng ý ở
   `/start` ghi lại **phiên bản** văn bản + thời điểm + người đồng ý vào sổ của nền tảng; đổi phiên bản thì quản trị
   của khách phải đồng ý lại ở lần đăng nhập kế tiếp.

## Nguyên tắc khi sửa

Mỗi câu cam kết phải là điều hệ thống ĐANG làm được. Ví dụ đúng hôm nay: dữ liệu mỗi tổ chức nằm ở một CSDL riêng;
quá hạn thanh toán chỉ chuyển sang chỉ xem, không xoá dữ liệu; sao lưu hằng ngày. Ví dụ CHƯA làm được, không được
hứa: cam kết thời gian hoạt động (SLA) bằng con số, xuất toàn bộ dữ liệu tự phục vụ ở mọi module, xoá dữ liệu tự động
theo lịch. Hứa điều chưa làm được biến văn bản thành bằng chứng chống lại chính mình.

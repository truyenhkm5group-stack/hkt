/**
 * Thông tin pháp nhân của nền tảng — chủ nền tảng cung cấp 03/10/2026. Dùng ở văn bản pháp lý công khai
 * (`/chinh-sach-bao-mat`) và chân trang. MỘT chỗ khai: đổi địa chỉ / email hỗ trợ thì sửa ở đây.
 */
export const COMPANY = {
  name: "Công ty cổ phần VNXcommerce",
  taxCode: "0109872760",
  address: "Tầng 3, Tòa nhà Gold Season, Số 47, đường Nguyễn Tuân, Phường Thanh Xuân, TP Hà Nội",
  email: "support@vnxcommerce.com",
  phone: "0886 833 448",
  phoneHref: "+84886833448",
} as const;

/** Phiên bản + ngày hiệu lực của Chính sách quyền riêng tư đang công bố. Sửa nội dung trang ⇒ tăng phiên bản. */
export const PRIVACY_POLICY = { version: "1.1", effective: "04/10/2026", path: "/chinh-sach-bao-mat" } as const;

/**
 * Điều khoản sử dụng đang công bố (`/dieu-khoan-su-dung`). Sửa nội dung trang ⇒ tăng phiên bản. Phiên bản người đăng ký
 * đã đồng ý được ghi vào nhật ký `ORG_ONBOARDED` của tổ chức (lib/onboarding/service.ts).
 */
export const TERMS_OF_SERVICE = { version: "1.0", effective: "04/10/2026", path: "/dieu-khoan-su-dung" } as const;

/** Con số kinh doanh mà Điều khoản cam kết — MỘT chỗ khai, trang công khai đọc từ đây. */
export const SERVICE_COMMITMENTS = {
  /** Lần thanh toán ĐẦU TIÊN của một tổ chức được hoàn 100% nếu yêu cầu trong bấy nhiêu ngày kể từ ngày tiền về. */
  firstPaymentRefundDays: 7,
  /** Sau khi hết hạn (chỉ xem), dữ liệu được giữ ÍT NHẤT bấy nhiêu ngày trước khi nền tảng được phép xoá. */
  retainAfterExpiryDays: 90,
  /** Báo trước bấy nhiêu ngày (email quản trị) trước khi xoá dữ liệu của tổ chức đã hết hạn. */
  deletionNoticeDays: 15,
  /** Báo trước bấy nhiêu ngày khi đổi giá gói; giá mới áp từ kỳ gia hạn sau. */
  priceChangeNoticeDays: 30,
  /** Báo trước bấy nhiêu ngày khi sửa Điều khoản. */
  termsChangeNoticeDays: 15,
} as const;

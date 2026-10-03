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
export const PRIVACY_POLICY = { version: "1.0", effective: "03/10/2026", path: "/chinh-sach-bao-mat" } as const;

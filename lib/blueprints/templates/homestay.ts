/**
 * MẪU «HOMESTAY / CĂN HỘ CHO THUÊ NGẮN NGÀY» (docs/verticals/homestay.md) — homestay, căn hộ dịch vụ, villa bán phòng qua Airbnb /
 * Booking / Agoda và khách đặt trực tiếp, kể cả đơn vị vận hành hộ nhiều chủ nhà.
 *
 * Mẫu chỉ là CẤU HÌNH. Phần làm nên ngành là module `stays` (0198): lịch phòng gộp mọi kênh bằng lịch .ics, cảnh báo trùng phòng,
 * nhận / trả / dọn phòng hôm nay, báo cáo chủ nhà. KHÔNG có đơn hàng, kho hay vận chuyển.
 *
 * KHÔNG khai giá phòng / tỷ lệ chia chủ nhà mặc định nào — đó là quyết định kinh doanh của từng hợp đồng (luật 38).
 */
import type { Blueprint } from "@/lib/blueprints/types";

export const HOMESTAY_BLUEPRINT: Blueprint = {
  format: "erp-blueprint",
  formatVersion: 1,
  key: "homestay",
  version: "1.0.0",
  name: "Homestay / căn hộ cho thuê ngắn ngày",
  description: "Homestay, căn hộ dịch vụ, villa bán phòng trên Airbnb / Booking / Agoda và cho khách đặt trực tiếp: một lịch phòng gộp mọi kênh, báo trùng phòng, khách nhận / trả / dọn phòng hôm nay, báo cáo theo chủ nhà.",
  industry: "Lưu trú ngắn ngày",
  modules: ["core", "work", "customers", "customer_care", "finance", "stays"],
  roles: [
    {
      key: "le_tan",
      label: "Lễ tân / quản lý đặt phòng",
      description: "Giữ lịch phòng: nhập lịch kênh, đặt phòng cho khách trực tiếp, xử lý trùng phòng, đón / tiễn khách.",
      base: "CS",
      permissions: ["dashboard:view", "stays:view", "stays:write", "customers:view", "customers:write", "cs:view", "cs:manage", "work:view", "work:manage"],
      defaultScope: "ALL",
    },
    {
      key: "buong_phong",
      label: "Buồng phòng",
      description: "Xem phòng nào trả hôm nay / ngày mai và đánh dấu dọn xong. Không xem doanh thu chủ nhà ngoài lịch phòng.",
      base: "VIEWER",
      permissions: ["dashboard:view", "stays:view", "stays:write", "work:view", "work:manage"],
      defaultScope: "ALL",
    },
  ],
  fields: [
    {
      objectKey: "customer",
      key: "quoc_tich",
      label: "Khách trong / ngoài nước",
      type: "select",
      listable: true,
      filterable: true,
      options: [
        { value: "trong_nuoc", label: "Trong nước" },
        { value: "nuoc_ngoai", label: "Nước ngoài" },
      ],
      helpText: "Khách nước ngoài cần khai báo tạm trú theo quy định — lễ tân biết để làm.",
    },
    {
      objectKey: "customer",
      key: "danh_gia_khach",
      label: "Đánh giá khách",
      type: "status",
      filterable: true,
      options: [
        { value: "tot", label: "Tốt", color: "emerald" },
        { value: "can_luu_y", label: "Cần lưu ý", color: "amber" },
        { value: "khong_nhan_lai", label: "Không nhận lại", color: "slate" },
      ],
    },
    { objectKey: "customer", key: "so_thich_luu_tru", label: "Sở thích / lưu ý khi ở", type: "textarea", validation: { maxLength: 500 }, helpText: "Giờ nhận sớm, gối thêm, dị ứng, mang thú cưng… — lần sau khách đặt là biết." },
  ],
  forms: [
    {
      objectKey: "customer",
      formKey: "profile",
      publish: true,
      schema: {
        version: 1,
        sections: [
          {
            key: "luu_tru",
            label: "Lưu trú",
            fields: [
              { ref: "custom:quoc_tich", visible: true, readOnly: false, required: false },
              { ref: "custom:danh_gia_khach", visible: true, readOnly: false, required: false },
              { ref: "custom:so_thich_luu_tru", visible: true, readOnly: false, required: false },
            ],
          },
        ],
      },
    },
  ],
  listViews: [
    {
      objectKey: "customer",
      listKey: "default",
      publish: true,
      schema: {
        version: 1,
        columns: [
          { ref: "system:name", visible: true },
          { ref: "system:phone", visible: true },
          { ref: "custom:quoc_tich", visible: true },
          { ref: "custom:danh_gia_khach", visible: true },
        ],
        defaultSort: { ref: "system:name", dir: "asc" },
        defaultFilters: [],
      },
    },
  ],
  pages: [
    {
      slug: "khach-luu-tru",
      name: "Khách lưu trú",
      moduleKey: "customers",
      requiredPermission: "customers:view",
      nav: { enabled: true, label: "Khách lưu trú", zone: "SALES", order: 10 },
      publish: true,
      schema: {
        version: 1,
        sections: [
          {
            key: "khach",
            title: "Khách",
            blocks: [
              { id: "huong_dan", type: "text", span: 12, config: { heading: "Lịch phòng ở mục «Lịch phòng»", body: "Khách nhận / trả / dọn phòng hôm nay, trùng phòng và báo cáo chủ nhà nằm ở mục Lịch phòng. Trang này giữ hồ sơ khách: trong / ngoài nước, đánh giá, sở thích khi ở." } },
              { id: "bang_khach", type: "table", span: 12, title: "Khách lưu trú", config: { source: "customer", columns: ["system:name", "system:phone", "custom:quoc_tich", "custom:danh_gia_khach"], pageSize: 20, rowLink: true } },
            ],
          },
        ],
      },
    },
  ],
  workflows: [
    {
      key: "khach_can_luu_y",
      name: "Khách bị đánh giá «Cần lưu ý» ⇒ việc cho lễ tân",
      description: "Khi đánh giá của một khách chuyển sang «Cần lưu ý» (hư hỏng đồ, ồn, vi phạm nội quy…), tạo việc cho phòng Kinh doanh (lễ tân) ghi rõ sự việc để lần sau lễ tân biết. Sinh ở NHÁP + CHẠY THỬ — bật khi đã xem lượt chạy thử.",
      trigger: { kind: "custom_status", objectKey: "customer", fieldKey: "danh_gia_khach", to: ["can_luu_y"] },
      actions: [{ kind: "create_task", title: "Ghi rõ sự việc của khách cần lưu ý", summary: "Ghi sự việc, ảnh hư hỏng (nếu có), chi phí phát sinh vào hồ sơ khách.", departmentCode: "SALES", priority: "NORMAL", dueInHours: 48 }],
      gate: null,
    },
  ],
  ai: {
    businessProfile:
      "Đơn vị cho thuê lưu trú ngắn ngày (homestay, căn hộ dịch vụ, villa), bán phòng theo ĐÊM trên nhiều kênh cùng lúc: Airbnb, Booking.com, Agoda và khách đặt trực tiếp. Lịch các kênh gộp về ERP bằng tệp lịch .ics; hai lượt cùng giữ một phòng một đêm là TRÙNG PHÒNG phải xử lý ngay. Giữa hai lượt khách phải dọn phòng. Có thể vận hành hộ nhiều chủ nhà và báo cáo theo chủ nhà.",
    glossary: [
      { term: "Đêm", meaning: "Đơn vị bán: khách nhận phòng chiều ngày A, trả phòng sáng ngày B ⇒ B − A đêm." },
      { term: "Trùng phòng", meaning: "Hai lượt đặt cùng giữ một phòng trong ít nhất một đêm — thường do hai kênh bán cùng lúc." },
      { term: "Lịch .ics", meaning: "Tệp lịch chuẩn mà Airbnb / Booking / Agoda xuất và nhập để khoá ngày giữa các kênh." },
      { term: "Lấp đầy", meaning: "Đêm đã bán chia đêm còn bán được (trừ đêm khoá) trong kỳ." },
    ],
  },
};

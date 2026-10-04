/**
 * MẪU «DỊCH VỤ TẠI NHÀ» (docs/verticals/home-service.md) — sửa chữa điện nước / điện lạnh, vệ sinh máy lạnh / sofa, lắp đặt, bảo
 * trì định kỳ: điều phối nhận yêu cầu, báo giá, hẹn thợ; thợ làm tại nhà khách, chụp ảnh trước / sau, khách ký nghiệm thu, thu
 * tiền theo đợt; bảo hành dịch vụ.
 *
 * Mẫu chỉ là CẤU HÌNH. Phần làm nên ngành là module `field_jobs` (0200). KHÔNG khai bảng giá dịch vụ hay số tháng bảo hành mặc
 * định nào — mỗi việc một báo giá, bảo hành là cam kết của từng shop (luật 38).
 */
import type { Blueprint } from "@/lib/blueprints/types";

export const HOME_SERVICE_BLUEPRINT: Blueprint = {
  format: "erp-blueprint",
  formatVersion: 1,
  key: "home-service",
  version: "1.0.0",
  name: "Dịch vụ tại nhà",
  description: "Sửa chữa, vệ sinh, lắp đặt, bảo trì tại nhà khách: báo giá theo dòng, hẹn thợ không chồng giờ, ảnh trước / sau, khách ký nghiệm thu, thu tiền theo đợt, bảo hành dịch vụ và lượt quay lại bảo hành.",
  industry: "Dịch vụ tại nhà",
  modules: ["core", "work", "customers", "customer_care", "finance", "field_jobs"],
  roles: [
    {
      key: "dieu_phoi",
      label: "Điều phối",
      description: "Nhận yêu cầu, lập báo giá, hẹn thợ, theo phiếu tới lúc nghiệm thu và thu đủ tiền.",
      base: "CS",
      permissions: ["dashboard:view", "field_jobs:view", "field_jobs:write", "customers:view", "customers:write", "cs:view", "cs:manage", "work:view", "work:manage"],
      defaultScope: "ALL",
    },
    {
      key: "ky_thuat_vien",
      label: "Kỹ thuật viên",
      description: "Xem «Việc của tôi», bắt đầu việc, chụp ảnh trước / sau, ghi phát sinh, nhận khách ký nghiệm thu và thu tiền tại chỗ.",
      base: "VIEWER",
      permissions: ["dashboard:view", "field_jobs:view", "field_jobs:write", "customers:view", "work:view", "work:manage"],
      defaultScope: "ALL",
    },
  ],
  fields: [
    {
      objectKey: "customer",
      key: "loai_nha",
      label: "Loại nhà",
      type: "select",
      listable: true,
      filterable: true,
      options: [
        { value: "nha_rieng", label: "Nhà riêng" },
        { value: "chung_cu", label: "Chung cư" },
        { value: "van_phong", label: "Văn phòng" },
        { value: "cua_hang", label: "Cửa hàng / quán" },
      ],
    },
    { objectKey: "customer", key: "luu_y_tiep_can", label: "Lưu ý khi tới", type: "textarea", validation: { maxLength: 500 }, helpText: "Giờ được làm, gửi xe, thang máy, chó dữ… — thợ đọc trước khi đi." },
    {
      objectKey: "customer",
      key: "goi_dich_vu",
      label: "Gói dịch vụ",
      type: "status",
      filterable: true,
      options: [
        { value: "goi_le", label: "Gọi lẻ" },
        { value: "bao_tri_dinh_ky", label: "Bảo trì định kỳ", color: "emerald" },
        { value: "ngung", label: "Ngừng", color: "slate" },
      ],
    },
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
            key: "tai_nha",
            label: "Làm tại nhà",
            fields: [
              { ref: "custom:loai_nha", visible: true, readOnly: false, required: false },
              { ref: "custom:luu_y_tiep_can", visible: true, readOnly: false, required: false },
              { ref: "custom:goi_dich_vu", visible: true, readOnly: false, required: false },
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
          { ref: "custom:loai_nha", visible: true },
          { ref: "custom:goi_dich_vu", visible: true },
        ],
        defaultSort: { ref: "system:name", dir: "asc" },
        defaultFilters: [],
      },
    },
  ],
  pages: [
    {
      slug: "khach-dich-vu-tai-nha",
      name: "Khách dịch vụ",
      moduleKey: "customers",
      requiredPermission: "customers:view",
      nav: { enabled: true, label: "Khách dịch vụ", zone: "SALES", order: 10 },
      publish: true,
      schema: {
        version: 1,
        sections: [
          {
            key: "khach",
            title: "Khách",
            blocks: [
              { id: "huong_dan", type: "text", span: 12, config: { heading: "Phiếu việc ở mục «Phiếu công việc»", body: "Báo giá, lịch thợ, ảnh trước / sau, nghiệm thu và tiền thu theo đợt nằm ở mục Phiếu công việc. Trang này giữ hồ sơ khách: loại nhà, lưu ý khi tới, gói dịch vụ." } },
              { id: "bang_khach", type: "table", span: 12, title: "Khách dịch vụ", config: { source: "customer", columns: ["system:name", "system:phone", "custom:loai_nha", "custom:goi_dich_vu"], pageSize: 20, rowLink: true } },
            ],
          },
        ],
      },
    },
  ],
  workflows: [
    {
      key: "khach_bao_tri_dinh_ky",
      name: "Khách chuyển sang bảo trì định kỳ ⇒ việc lên lịch",
      description: "Khi gói dịch vụ của một khách chuyển sang «Bảo trì định kỳ», tạo việc cho điều phối thống nhất chu kỳ và lên phiếu lượt đầu. Sinh ở NHÁP + CHẠY THỬ — bật khi đã xem lượt chạy thử.",
      trigger: { kind: "custom_status", objectKey: "customer", fieldKey: "goi_dich_vu", to: ["bao_tri_dinh_ky"] },
      actions: [{ kind: "create_task", title: "Lên lịch bảo trì định kỳ cho khách", summary: "Thống nhất chu kỳ với khách, lập phiếu công việc cho lượt kế tiếp.", departmentCode: "SALES", priority: "NORMAL", dueInHours: 48 }],
      gate: null,
    },
  ],
  ai: {
    businessProfile:
      "Đơn vị dịch vụ tại nhà (sửa chữa điện nước / điện lạnh, vệ sinh, lắp đặt, bảo trì): nhận yêu cầu của khách, báo giá theo từng dòng việc / vật tư, hẹn kỹ thuật viên tới nhà, chụp ảnh trước / sau, khách ký nghiệm thu, thu tiền theo đợt (cọc, nghiệm thu). Có bảo hành dịch vụ theo tháng; khách báo lại sự cố trong hạn ⇒ mở lượt bảo hành.",
    glossary: [
      { term: "Phiếu công việc", meaning: "Một việc tại nhà khách: báo giá, thợ, giờ hẹn, ảnh, nghiệm thu, tiền thu." },
      { term: "Phát sinh", meaning: "Việc / vật tư thêm khi tới nơi — ghi thêm dòng báo giá trước khi nghiệm thu." },
      { term: "Nghiệm thu", meaning: "Khách xác nhận việc xong — ghi tên người ký; từ đây phiếu không sửa nữa và hạn bảo hành bắt đầu." },
      { term: "Lượt bảo hành", meaning: "Phiếu mới trỏ về phiếu gốc khi khách báo lại sự cố." },
    ],
  },
};

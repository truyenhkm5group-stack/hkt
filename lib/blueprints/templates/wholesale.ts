/**
 * MẪU «BÁN SỈ / PHÂN PHỐI» — khách là đại lý, cho nợ theo hạn mức; mua thành phẩm về kho, KHÔNG sản xuất, KHÔNG quảng
 * cáo. Chứng minh: field hạn mức công nợ trên khách, trang công nợ, luật "quá hạn ⇒ việc cho Kế toán".
 *
 * Không ngưỡng nghiệp vụ nào của VNX (COD, hoàn < 50K…) — đơn sỉ thanh toán theo công nợ, và `vnx-specific-rules.md`
 * mục 3 nói rõ luật kết quả đơn COD in số SAI cho tổ chức bán buôn.
 */
import type { Blueprint } from "@/lib/blueprints/types";

export const WHOLESALE_BLUEPRINT: Blueprint = {
  format: "erp-blueprint",
  formatVersion: 1,
  key: "wholesale",
  version: "1.0.0",
  name: "Bán sỉ / phân phối",
  description: "Đại lý và cửa hàng mua theo đơn số lượng lớn, trả sau theo hạn mức công nợ. Hàng thành phẩm mua từ nhà cung cấp về kho — không sản xuất, không chạy quảng cáo.",
  industry: "Bán buôn",
  modules: ["core", "work", "customers", "customer_care", "products", "orders", "inventory", "purchasing", "finance"],
  roles: [
    {
      key: "ke_toan_cong_no",
      label: "Kế toán công nợ",
      description: "Theo dõi hạn mức và tình trạng công nợ của khách sỉ; xem đơn và sổ ngân hàng, không sửa cấu hình.",
      base: "ACCOUNTANT",
      permissions: ["customers:view", "orders:read", "bank:view"],
      defaultScope: "ALL",
    },
  ],
  fields: [
    { objectKey: "customer", key: "han_muc_cong_no", label: "Hạn mức công nợ", type: "currency", validation: { min: 0 }, filterable: true, helpText: "Tổng tiền khách được nợ cùng lúc. Để trống = chưa khai hạn mức (không phải 0)." },
    { objectKey: "customer", key: "so_ngay_no", label: "Số ngày được nợ", type: "number", validation: { min: 0, max: 365 } },
    {
      objectKey: "customer",
      key: "tinh_trang_cong_no",
      label: "Tình trạng công nợ",
      type: "status",
      filterable: true,
      options: [
        { value: "trong_han", label: "Trong hạn", color: "emerald" },
        { value: "sap_den_han", label: "Sắp đến hạn", color: "amber" },
        { value: "qua_han", label: "Quá hạn", color: "rose" },
        { value: "tam_khoa", label: "Tạm khoá bán nợ", color: "slate" },
      ],
    },
    { objectKey: "customer", key: "ma_so_thue", label: "Mã số thuế", type: "text", validation: { maxLength: 20 } },
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
            key: "cong_no",
            label: "Công nợ & thông tin sỉ",
            fields: [
              { ref: "custom:han_muc_cong_no", visible: true, readOnly: false, required: false },
              { ref: "custom:so_ngay_no", visible: true, readOnly: false, required: false },
              { ref: "custom:tinh_trang_cong_no", visible: true, readOnly: false, required: false },
              { ref: "custom:ma_so_thue", visible: true, readOnly: false, required: false },
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
          { ref: "system:province", visible: true },
          { ref: "custom:han_muc_cong_no", visible: true },
          { ref: "custom:tinh_trang_cong_no", visible: true },
          { ref: "system:order_count", visible: true },
          { ref: "system:purchased_amount", visible: true },
        ],
        defaultSort: { ref: "custom:han_muc_cong_no", dir: "desc" },
        defaultFilters: [],
      },
    },
  ],
  pages: [
    {
      slug: "cong-no-khach-hang",
      name: "Công nợ khách hàng",
      moduleKey: "customers",
      requiredPermission: "customers:view",
      nav: { enabled: true, label: "Công nợ khách", zone: "FINANCE", order: 10 },
      publish: true,
      schema: {
        version: 1,
        sections: [
          {
            key: "tong_quan",
            title: "Bán hàng 30 ngày",
            blocks: [
              { id: "doanh_thu", type: "kpi", span: 4, title: "Doanh thu lên đơn", config: { metric: "booked_revenue", period: "30d" } },
              { id: "don_theo_ngay", type: "chart", span: 8, title: "Đơn theo ngày", config: { series: "orders_by_day", kind: "bar", period: "30d" } },
            ],
          },
          {
            key: "cong_no",
            title: "Công nợ theo khách",
            blocks: [
              {
                id: "kanban_cong_no",
                type: "kanban",
                span: 12,
                title: "Tình trạng công nợ",
                config: { objectKey: "customer", statusField: "custom:tinh_trang_cong_no", cardFields: ["custom:han_muc_cong_no", "system:phone"], allowMove: true },
              },
              {
                id: "bang_khach_si",
                type: "table",
                span: 12,
                title: "Khách sỉ",
                config: { source: "customer", columns: ["system:name", "system:phone", "custom:han_muc_cong_no", "custom:so_ngay_no", "custom:tinh_trang_cong_no"], pageSize: 20, rowLink: true },
              },
            ],
          },
        ],
      },
    },
  ],
  workflows: [
    {
      key: "nhac_cong_no_qua_han",
      name: "Khách quá hạn công nợ ⇒ việc cho Kế toán",
      description: "Khi tình trạng công nợ của một khách chuyển sang «Quá hạn», tạo việc nhắc thanh toán cho phòng Kế toán. Sinh ở NHÁP + CHẠY THỬ — bật khi đã xem lượt chạy thử.",
      trigger: { kind: "custom_status", objectKey: "customer", fieldKey: "tinh_trang_cong_no", to: ["qua_han"] },
      actions: [
        { kind: "create_task", title: "Nhắc khách thanh toán công nợ quá hạn", summary: "Gọi khách, chốt ngày trả; cân nhắc chuyển «Tạm khoá bán nợ» nếu chưa trả.", departmentCode: "FINANCE", priority: "HIGH", dueInHours: 24 },
        { kind: "notify", message: "Có khách vừa chuyển sang «Quá hạn» công nợ — việc nhắc thanh toán đã vào hàng đợi Kế toán." },
      ],
      gate: null,
    },
  ],
  integrations: [{ connectorKey: "connector_bank", reason: "Đối chiếu tiền khách sỉ chuyển khoản với sổ ngân hàng. Chỉ là gợi ý — tổ chức tự kết nối ở trang Kết nối dữ liệu, mẫu không cấu hình thông tin đăng nhập nào." }],
  ai: {
    businessProfile: "Doanh nghiệp bán sỉ / phân phối. Khách là đại lý và cửa hàng, mua theo đơn số lượng lớn và trả sau theo hạn mức công nợ, số ngày nợ khai trên từng khách. Hàng là thành phẩm mua từ nhà cung cấp về kho; không tự sản xuất, không chạy quảng cáo trực tuyến.",
    glossary: [
      { term: "Hạn mức công nợ", meaning: "Tổng tiền tối đa một khách được nợ cùng lúc; để trống nghĩa là chưa khai, không phải 0." },
      { term: "Quá hạn", meaning: "Khách có khoản nợ đã vượt số ngày được nợ — tình trạng do người đặt trên hồ sơ khách." },
      { term: "Đại lý", meaning: "Khách mua để bán lại, thường mua lặp lại theo tuần hoặc tháng." },
    ],
  },
};

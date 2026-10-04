/**
 * MẪU «THỜI TRANG BÁN ONLINE» — tổng quát hoá từ hồ sơ của tổ chức nhà, TRỪ mọi thứ chỉ đúng với nó
 * (`docs/platform/vnx-specific-rules.md`): không luật COD / ngưỡng hoàn (`RETURN_RULE`, `ORDER_OUTCOME` là của gói
 * ngành + tổ chức nhà, không của mẫu), không connector (credential của tổ chức nhà), không phòng Tech, không tên
 * shop / fanpage / tài khoản quảng cáo, không mã hàng dạng riêng, không số giả định lợi nhuận.
 *
 * Chứng minh: field size / màu / chất liệu trên sản phẩm, trang Tổng quan bán hàng, luật "hàng hoàn chờ kiểm ⇒ việc
 * cho Kho". Module khác hẳn hai mẫu kia: có sản xuất, marketing, CSKH, kênh bán, lương, cảnh báo.
 */
import type { Blueprint } from "@/lib/blueprints/types";

export const FASHION_COMMERCE_BLUEPRINT: Blueprint = {
  format: "erp-blueprint",
  formatVersion: 1,
  key: "fashion-commerce",
  version: "1.0.0",
  name: "Thời trang bán online",
  description: "Shop thời trang tự đặt xưởng may, bán qua quảng cáo và tin nhắn, giao qua đơn vị vận chuyển. Có mẫu mã theo size / màu, kiểm hàng hoàn tại kho, CSKH, lương và cảnh báo vận hành.",
  industry: "Thời trang",
  modules: ["core", "work", "customers", "products", "orders", "inventory", "purchasing", "production", "logistics", "returns", "customer_care", "sales_channels", "marketing", "finance", "payroll", "alerts"],
  roles: [
    {
      key: "nhan_vien_kho",
      label: "Nhân viên kho",
      description: "Đóng gói, xuất hàng, nhận và kiểm hàng hoàn — không xem tài chính.",
      base: "WAREHOUSE",
      permissions: ["products:view", "inventory:write", "returns:view", "shipments:view"],
      defaultScope: "ALL",
    },
  ],
  fields: [
    {
      objectKey: "product",
      key: "kich_co",
      label: "Kích cỡ",
      type: "multi_select",
      filterable: true,
      options: ["XS", "S", "M", "L", "XL", "XXL", "FREESIZE"].map((v) => ({ value: v.toLowerCase(), label: v })),
    },
    {
      objectKey: "product",
      key: "mau_sac",
      label: "Màu sắc",
      type: "multi_select",
      filterable: true,
      options: [
        { value: "den", label: "Đen" },
        { value: "trang", label: "Trắng" },
        { value: "be", label: "Be" },
        { value: "do", label: "Đỏ" },
        { value: "xanh", label: "Xanh" },
        { value: "hong", label: "Hồng" },
      ],
    },
    { objectKey: "product", key: "chat_lieu", label: "Chất liệu", type: "text", validation: { maxLength: 120 } },
    {
      objectKey: "return",
      key: "kiem_hang",
      label: "Kiểm hàng hoàn",
      type: "status",
      filterable: true,
      options: [
        { value: "cho_kiem", label: "Chờ kiểm", color: "amber" },
        { value: "dat", label: "Đạt — nhập lại", color: "emerald" },
        { value: "loi", label: "Lỗi — không nhập lại", color: "rose" },
      ],
      transitions: { cho_kiem: ["dat", "loi"] },
    },
    {
      objectKey: "customer",
      key: "size_thuong_mac",
      label: "Size thường mặc",
      type: "select",
      options: ["S", "M", "L", "XL", "XXL"].map((v) => ({ value: v.toLowerCase(), label: v })),
    },
  ],
  forms: [
    {
      objectKey: "customer",
      formKey: "profile",
      publish: true,
      schema: { version: 1, sections: [{ key: "so_do", label: "Số đo & sở thích", fields: [{ ref: "custom:size_thuong_mac", visible: true, readOnly: false, required: false }] }] },
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
          { ref: "custom:size_thuong_mac", visible: true },
          { ref: "system:order_count", visible: true },
          { ref: "system:purchased_amount", visible: true },
          { ref: "system:last_order_at", visible: true },
        ],
        defaultSort: { ref: "system:last_order_at", dir: "desc" },
        defaultFilters: [],
      },
    },
  ],
  pages: [
    {
      slug: "tong-quan-ban-hang",
      name: "Tổng quan bán hàng",
      moduleKey: "orders",
      requiredPermission: "orders:read",
      nav: { enabled: true, label: "Tổng quan bán hàng", zone: "SALES", order: 5 },
      publish: true,
      schema: {
        version: 1,
        sections: [
          {
            key: "chi_so",
            title: "Chỉ số",
            blocks: [
              { id: "don_hom_nay", type: "kpi", span: 3, title: "Đơn hôm nay", config: { metric: "orders_today", period: "today" } },
              { id: "doanh_thu_30", type: "kpi", span: 3, title: "Doanh thu lên đơn 30 ngày", config: { metric: "booked_revenue", period: "30d" } },
              { id: "ty_le_hoan", type: "kpi", span: 3, title: "Tỷ lệ hoàn 30 ngày", config: { metric: "return_rate", period: "30d" } },
              { id: "giao_thanh_cong", type: "kpi", span: 3, title: "Đơn giao thành công 30 ngày", config: { metric: "delivered_orders", period: "30d" } },
            ],
          },
          { key: "xu_huong", title: "Xu hướng", blocks: [{ id: "doanh_thu_theo_ngay", type: "chart", span: 12, title: "Doanh thu lên đơn theo ngày", config: { series: "booked_revenue_by_day", kind: "line", period: "30d" } }] },
          { key: "don", title: "Đơn hàng", blocks: [{ id: "bang_don", type: "table", span: 12, title: "Đơn mới", config: { source: "order", columns: ["system:id", "system:customer_name", "system:stage", "system:total", "system:inserted_at"], pageSize: 20, rowLink: true } }] },
        ],
      },
    },
  ],
  workflows: [
    {
      key: "hang_hoan_cho_kiem",
      name: "Hàng hoàn chờ kiểm ⇒ việc cho Kho",
      description: "Phiếu hoàn chuyển «Chờ kiểm» ⇒ tạo việc kiểm hàng cho Kho. Hàng hoàn chỉ về tồn khi kho lập phiếu nhập với số đếm thật — luật này chỉ nhắc việc, không đổi tồn.",
      trigger: { kind: "custom_status", objectKey: "return", fieldKey: "kiem_hang", to: ["cho_kiem"] },
      actions: [{ kind: "create_task", title: "Kiểm hàng hoàn: đếm, soi lỗi, quyết định nhập lại", departmentCode: "WAREHOUSE", priority: "NORMAL", dueInHours: 24 }],
      gate: null,
    },
  ],
  settings: [
    {
      key: "care.notePresets",
      value: {
        presets: [
          { id: "bp-no-answer", kind: "CALLED_NO_ANSWER", text: "Gọi hai lần không nghe máy, đã nhắn tin hẹn giao lại." },
          { id: "bp-reschedule", kind: "RESCHEDULED", text: "Khách hẹn nhận lại, đã báo đơn vị vận chuyển phát lại." },
          { id: "bp-exchange", kind: "MESSAGED", text: "Khách muốn đổi size / màu — đã nhắn hướng dẫn đổi hàng." },
          { id: "bp-refused", kind: "CUSTOMER_REFUSED", text: "Khách xác nhận không nhận hàng nữa." },
        ],
      },
    },
  ],
  // Gợi ý kết nối THEO TỔ CHỨC (F3) — thứ shop khách tự khai được ở /settings/connections. Module connector của nhà
  // (`connector_meta`, `connector_messaging`) là credential môi trường của VNX: gợi ý chúng là gợi ý thứ shop không bật được.
  // Nguồn đơn / vận chuyển cụ thể (POS, ĐVVC) KHÔNG nêu tên ở mẫu (tests/blueprints: mẫu không mang tên nhà cung cấp của VNX) —
  // màn Kết nối liệt kê chúng cho shop tự chọn.
  integrations: [
    { connectorKey: "meta-ads-org", reason: "Chi tiêu quảng cáo Facebook bằng token System User của shop — hiệu quả quảng cáo theo mã hàng." },
    { connectorKey: "lark-webhook", reason: "Gửi cảnh báo vận hành ra nhóm chat của đội. Mẫu không cấu hình URL hay token nào." },
  ],
  ai: {
    businessProfile: "Shop thời trang bán online: tự thiết kế và đặt xưởng may, bán qua quảng cáo mạng xã hội và tin nhắn, giao qua đơn vị vận chuyển. Sản phẩm có biến thể size / màu; hàng hoàn được kho kiểm trước khi nhập lại. Kết quả giao hàng và tiền thu được đối chiếu theo chứng từ của đơn vị vận chuyển, không theo trạng thái trên sàn.",
    glossary: [
      { term: "Mẫu", meaning: "Một thiết kế sản phẩm, có thể nhiều màu / size; đi từ thử thị trường tới đặt xưởng." },
      { term: "Hàng hoàn", meaning: "Kiện giao không thành công quay về kho; chỉ về tồn sau khi kho kiểm và lập phiếu nhập." },
      { term: "Đặt xưởng", meaning: "Đơn đặt may gửi xưởng gia công theo size / màu / số lượng." },
    ],
  },
};

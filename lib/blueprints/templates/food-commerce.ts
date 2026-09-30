/**
 * MẪU «THỰC PHẨM ĐÓNG GÓI BÁN ONLINE» (0180 · hành trình tự phục vụ) — shop bán thực phẩm / đặc sản / hải sản chế biến ĐÃ
 * ĐÓNG GÓI, giá cố định theo gói: khách · sản phẩm · đơn · kho · giao vận · CSKH · chatbot AI bán hàng.
 *
 * KHÔNG mang sản phẩm, giá, khách hay bí mật của bất kỳ shop nào (mẫu là DỮ LIỆU CẤU HÌNH — backup-recovery.md §1): danh
 * mục của shop đi vào bằng «Nhập từ tệp» ở /products/import. KHÔNG có logic cân ký lẻ / hàng tươi theo khối lượng — hàng
 * đóng gói giá cố định: tiền đơn = đơn giá × số lượng − chiết khấu + phí ship (lib/constants/manual-orders.ts). HSD / số
 * lô theo phiếu nhập KHÔNG có ở đây (đổi lược đồ kho — phase riêng); hướng dẫn bảo quản / sử dụng là field của SẢN PHẨM.
 *
 * GIỮ HÀNG KHÔNG PHẢI MỘT HÀNH ĐỘNG CỦA LUẬT: đơn «Đã xác nhận» tự trừ vào cột KHẢ DỤNG của sổ kho cho tới khi xuất
 * (AGENTS.md mục 3.10), huỷ đơn thì tự nhả. Hai luật dựng sẵn chỉ BÁO — ở NHÁP + CHẠY THỬ (luật 23: mẫu không tự kích
 * hoạt); nối kênh nhóm chat và bật chạy thật ở Cài đặt → Thông báo nhóm.
 */
import type { Blueprint } from "@/lib/blueprints/types";

export const FOOD_COMMERCE_BLUEPRINT: Blueprint = {
  format: "erp-blueprint",
  formatVersion: 1,
  key: "food-commerce",
  version: "1.0.0",
  name: "Thực phẩm đóng gói bán online",
  description: "Shop bán thực phẩm / đặc sản / hải sản chế biến đã đóng gói, giá cố định theo gói. Khách, sản phẩm có quy cách & hướng dẫn bảo quản, đơn, kho giữ hàng khi chốt, giao vận, CSKH và chatbot AI bán hàng. Không có sản xuất, quảng cáo, lương.",
  industry: "Thực phẩm đóng gói",
  modules: ["core", "work", "customers", "customer_care", "products", "orders", "inventory", "logistics", "ai_sales"],
  roles: [
    {
      key: "ban_hang",
      label: "Nhân viên bán hàng",
      description: "Chốt đơn với khách: tạo / sửa khách và đơn, xem sản phẩm & tồn, đọc hội thoại chatbot. Không sửa cấu hình, không nhập kho.",
      base: "VIEWER",
      permissions: ["dashboard:view", "orders:read", "orders:write", "customers:view", "customers:write", "products:view", "work:view", "work:manage", "ai_sales:view"],
      defaultScope: "ALL",
    },
    {
      key: "kho",
      label: "Nhân viên kho",
      description: "Nhập hàng, kiểm kê, xuất kho theo đơn đã chốt. Xem đơn để đóng gói; không sửa đơn, không xem hội thoại khách.",
      base: "WAREHOUSE",
      permissions: ["dashboard:view", "orders:read", "products:view", "inventory:write", "work:view", "work:manage"],
      defaultScope: "ALL",
    },
    {
      key: "cskh",
      label: "Nhân viên CSKH",
      description: "Trả lời khách, nhận ca chuyển từ chatbot, cập nhật thông tin khách, xử lý case sau bán.",
      base: "CS",
      permissions: ["dashboard:view", "orders:read", "customers:view", "customers:write", "cs:view", "cs:manage", "ai_sales:view", "work:view", "work:manage"],
      defaultScope: "ALL",
    },
  ],
  fields: [
    { objectKey: "product", key: "package_size", label: "Quy cách đóng gói", type: "text", listable: true, filterable: true, validation: { maxLength: 60 }, helpText: "Vd «10 cái», «1kg», «250g», «1 lít» — đúng như in trên bao bì." },
    { objectKey: "product", key: "net_weight", label: "Khối lượng tịnh", type: "text", validation: { maxLength: 60 }, helpText: "Khối lượng / thể tích tịnh in trên nhãn, nếu khác quy cách." },
    { objectKey: "product", key: "selling_unit", label: "Đơn vị bán", type: "text", listable: true, validation: { maxLength: 30 }, helpText: "Vd «gói», «hộp», «chai», «túi»." },
    { objectKey: "product", key: "food_category", label: "Nhóm thực phẩm", type: "text", listable: true, filterable: true, validation: { maxLength: 60 }, helpText: "Vd «Chả», «Nem», «Ruốc», «Nước mắm» — nhóm để lọc và để chatbot gợi ý." },
    { objectKey: "product", key: "storage_instruction", label: "Hướng dẫn bảo quản", type: "textarea", validation: { maxLength: 500 }, helpText: "Vd «Ngăn đá −18°C, dùng trong 3 tháng». Chatbot đọc ô này khi khách hỏi cách bảo quản." },
    { objectKey: "product", key: "usage_instruction", label: "Hướng dẫn sử dụng", type: "textarea", validation: { maxLength: 500 }, helpText: "Vd «Rã đông ngăn mát 2 giờ, chiên ngập dầu lửa vừa»." },
    {
      objectKey: "customer",
      key: "kenh_lien_he",
      label: "Kênh liên hệ ưa dùng",
      type: "select",
      filterable: true,
      options: [
        { value: "dien_thoai", label: "Điện thoại" },
        { value: "zalo", label: "Zalo" },
        { value: "messenger", label: "Messenger" },
        { value: "chat_web", label: "Chat trên web" },
      ],
    },
  ],
  forms: [
    {
      objectKey: "customer",
      formKey: "profile",
      publish: true,
      schema: { version: 1, sections: [{ key: "lien_he", label: "Liên hệ", fields: [{ ref: "custom:kenh_lien_he", visible: true, readOnly: false, required: false }] }] },
    },
  ],
  listViews: [
    {
      objectKey: "order",
      listKey: "default",
      publish: true,
      schema: {
        version: 1,
        columns: [
          { ref: "system:id", visible: true },
          { ref: "system:customer_name", visible: true },
          { ref: "system:stage", visible: true },
          { ref: "system:total", visible: true },
          { ref: "system:inserted_at", visible: true },
        ],
        defaultSort: { ref: "system:inserted_at", dir: "desc" },
        defaultFilters: [],
      },
    },
  ],
  pages: [
    {
      slug: "tong-quan",
      name: "Tổng quan",
      moduleKey: "orders",
      requiredPermission: "orders:read",
      nav: { enabled: true, label: "Tổng quan bán hàng", zone: "SALES", order: 1 },
      publish: true,
      schema: {
        version: 1,
        sections: [
          {
            key: "hom_nay",
            title: "Hôm nay",
            blocks: [
              { id: "don_hom_nay", type: "kpi", span: 3, title: "Đơn lên hôm nay", config: { metric: "orders_today", period: "today" } },
              { id: "doanh_thu_7", type: "kpi", span: 3, title: "Doanh thu lên đơn 7 ngày", config: { metric: "booked_revenue", period: "7d" } },
              { id: "ton_kha_dung", type: "kpi", span: 3, title: "Tồn khả dụng", config: { metric: "available_stock", period: "all" } },
              { id: "don_theo_trang_thai", type: "chart", span: 3, title: "Đơn theo trạng thái", config: { series: "orders_by_stage", kind: "pie", period: "30d" } },
            ],
          },
          {
            key: "don_moi",
            title: "Đơn mới nhất",
            blocks: [{ id: "bang_don", type: "table", span: 12, title: "Đơn mới nhất", config: { source: "order", columns: ["system:id", "system:customer_name", "system:stage", "system:total"], pageSize: 20, rowLink: true } }],
          },
        ],
      },
    },
    {
      slug: "bao-cao-ban-hang",
      name: "Báo cáo bán hàng",
      moduleKey: "orders",
      requiredPermission: "orders:read",
      nav: { enabled: true, label: "Báo cáo bán hàng", zone: "SALES", order: 20 },
      publish: true,
      schema: {
        version: 1,
        sections: [
          {
            key: "xu_huong",
            title: "30 ngày gần đây",
            blocks: [
              { id: "don_theo_ngay", type: "chart", span: 6, title: "Đơn lên theo ngày", config: { series: "orders_by_day", kind: "bar", period: "30d" } },
              { id: "doanh_thu_theo_ngay", type: "chart", span: 6, title: "Doanh thu lên đơn theo ngày", config: { series: "booked_revenue_by_day", kind: "line", period: "30d" } },
            ],
          },
        ],
      },
    },
  ],
  workflows: [
    {
      key: "bao_nhom_don_xac_nhan",
      name: "Đơn chốt ⇒ báo nhóm vận hành",
      description: "Đơn chuyển «Đã xác nhận» (hàng tự được GIỮ ở cột khả dụng của kho) ⇒ báo cho đội vận hành đóng gói. Mẫu chỉ báo trong ERP; nối nhóm Lark / Telegram ở Cài đặt → Thông báo nhóm.",
      trigger: { kind: "event", event: "order.confirmed" },
      actions: [{ kind: "notify", message: "Đơn vừa chốt — đóng gói và giao" }],
    },
    {
      key: "bao_nhom_don_huy",
      name: "Đơn huỷ ⇒ báo nhóm vận hành",
      description: "Đơn đã chốt bị huỷ (hàng tự được NHẢ khỏi cột khả dụng) ⇒ báo đội vận hành dừng đóng gói / giao.",
      trigger: { kind: "event", event: "order.cancelled" },
      conditions: { field: "system:payload.wasConfirmed", op: "eq", value: true },
      actions: [{ kind: "notify", message: "Đơn đã chốt vừa bị huỷ — không đóng / không giao" }],
    },
  ],
  ai: {
    businessProfile: "Shop bán thực phẩm / đặc sản / hải sản chế biến ĐÃ ĐÓNG GÓI, giá cố định theo gói. Khách đặt qua chat / điện thoại, shop giao tận nơi và thu tiền khi giao (COD). Tiền đơn = đơn giá × số lượng − chiết khấu + phí ship. Hàng cần bảo quản lạnh — hướng dẫn nằm ở từng sản phẩm.",
    glossary: [
      { term: "Quy cách", meaning: "Cỡ gói bán: «10 cái», «1kg», «250g», «1 lít» — field «Quy cách đóng gói» của sản phẩm." },
      { term: "Chốt đơn", meaning: "Khách xác nhận mua ⇒ đơn «Đã xác nhận», hàng được giữ ở cột khả dụng, nhóm vận hành nhận tin." },
      { term: "COD", meaning: "Tiền thu khi giao = tiền hàng sau chiết khấu + phí ship." },
    ],
  },
};

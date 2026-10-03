/**
 * MẪU «NHÀ HÀNG / QUÁN ĂN» (docs/verticals/restaurant.md) — quán ăn, nhà hàng, quán cà phê nhận ĐẶT BÀN, bán TẠI BÀN /
 * MANG VỀ / GIAO HÀNG, và nhận khách qua chat.
 *
 * Mẫu chỉ là CẤU HÌNH trên module có sẵn — không module mới:
 *  · Thực đơn = module Sản phẩm (món, giá, nhóm món). Gọi món = đơn tạo tay, field «Hình thức» tách tại bàn / mang về / giao.
 *  · Đặt bàn = module Lịch hẹn (0190) + chatbot đặt lịch theo SỨC CHỨA (lib/constants/booking.ts): shop khai «số khách phục
 *    vụ cùng lúc» = số bàn nhận đặt trước; bot chỉ mời giờ còn bàn, chờ khách xác nhận mới giữ chỗ.
 *  · Chatbot bán hàng (0180): khách hỏi món / giá, đặt bàn, gọi món giao tận nơi.
 *
 * CHƯA có (cần khách thử thật trước khi dựng): sơ đồ bàn + gọi món tại bàn theo từng bàn, màn hình bếp, tách / gộp hoá đơn,
 * định lượng nguyên liệu theo món. KHÔNG khai giá / món / số bàn mặc định nào — quyết định của từng quán (luật 38).
 */
import type { Blueprint } from "@/lib/blueprints/types";

export const RESTAURANT_BLUEPRINT: Blueprint = {
  format: "erp-blueprint",
  formatVersion: 1,
  key: "restaurant",
  version: "1.0.0",
  name: "Nhà hàng / quán ăn",
  description: "Nhà hàng, quán ăn, quán cà phê: thực đơn theo nhóm món, đơn tại bàn / mang về / giao hàng, đặt bàn theo số bàn còn trống, chatbot nhận đặt bàn và gọi món, nhắc khách quen quay lại.",
  industry: "Nhà hàng / quán ăn",
  modules: ["core", "work", "customers", "products", "orders", "inventory", "appointments", "ai_sales"],
  roles: [
    {
      key: "thu_ngan",
      label: "Thu ngân / phục vụ",
      description: "Lên đơn tại bàn / mang về / giao, nhận và xếp đặt bàn, ghi khách tới, trả lời khách nhắn tin.",
      base: "CS",
      permissions: ["dashboard:view", "appointments:view", "appointments:write", "customers:view", "customers:write", "orders:read", "orders:write", "products:view", "ai_sales:view", "work:view", "work:manage"],
      defaultScope: "ALL",
    },
    {
      key: "bep",
      label: "Bếp",
      description: "Xem đơn để nấu và thực đơn. Không xem doanh thu, không sửa giá, không sửa đơn.",
      base: "VIEWER",
      permissions: ["dashboard:view", "orders:read", "products:view", "work:view", "work:manage"],
      defaultScope: "ALL",
    },
  ],
  fields: [
    {
      objectKey: "product",
      key: "nhom_mon",
      label: "Nhóm món",
      type: "select",
      listable: true,
      filterable: true,
      options: [
        { value: "khai_vi", label: "Khai vị" },
        { value: "mon_chinh", label: "Món chính" },
        { value: "lau_nuong", label: "Lẩu / nướng" },
        { value: "com_mi", label: "Cơm / mì / bún" },
        { value: "do_uong", label: "Đồ uống" },
        { value: "trang_mieng", label: "Tráng miệng" },
        { value: "combo", label: "Combo / set" },
        { value: "dat_ban", label: "Đặt bàn (không bán)" },
      ],
    },
    { objectKey: "product", key: "khau_phan", label: "Khẩu phần", type: "text", listable: true, validation: { maxLength: 60 }, helpText: "Ví dụ «2–3 người», «1 phần», «nồi lớn» — chatbot đọc để tư vấn." },
    {
      objectKey: "order",
      key: "hinh_thuc",
      label: "Hình thức",
      type: "select",
      listable: true,
      filterable: true,
      options: [
        { value: "tai_ban", label: "Tại bàn" },
        { value: "mang_ve", label: "Mang về" },
        { value: "giao_hang", label: "Giao hàng" },
      ],
    },
    { objectKey: "order", key: "so_ban", label: "Số bàn", type: "text", listable: true, validation: { maxLength: 20 }, helpText: "Chỉ đơn tại bàn." },
    { objectKey: "customer", key: "di_ung_kieng", label: "Dị ứng / kiêng", type: "textarea", validation: { maxLength: 500 }, helpText: "Dị ứng hải sản, đậu phộng, ăn chay… — bếp và phục vụ phải biết." },
    { objectKey: "customer", key: "mon_hay_goi", label: "Món hay gọi", type: "textarea", validation: { maxLength: 500 } },
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
            key: "khau_vi",
            label: "Khẩu vị & lưu ý",
            fields: [
              { ref: "custom:di_ung_kieng", visible: true, readOnly: false, required: false },
              { ref: "custom:mon_hay_goi", visible: true, readOnly: false, required: false },
            ],
          },
        ],
      },
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
          { ref: "custom:hinh_thuc", visible: true },
          { ref: "custom:so_ban", visible: true },
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
      slug: "tong-quan-quan",
      name: "Tổng quan quán",
      moduleKey: "orders",
      requiredPermission: "orders:read",
      nav: { enabled: true, label: "Tổng quan quán", zone: "SALES", order: 1 },
      publish: true,
      schema: {
        version: 1,
        sections: [
          {
            key: "ban_hang",
            title: "Bán hàng",
            blocks: [
              { id: "don_hom_nay", type: "kpi", span: 4, title: "Đơn hôm nay", config: { metric: "orders_today", period: "today" } },
              { id: "doanh_thu_7", type: "kpi", span: 4, title: "Doanh thu lên đơn 7 ngày", config: { metric: "booked_revenue", period: "7d" } },
              { id: "doanh_thu_theo_ngay", type: "chart", span: 4, title: "Doanh thu theo ngày", config: { series: "booked_revenue_by_day", kind: "line", period: "30d" } },
            ],
          },
        ],
      },
    },
  ],
  workflows: [
    {
      key: "bao_bep_don_moi",
      name: "Đơn chốt ⇒ báo bếp",
      description: "Đơn chuyển «Đã xác nhận» ⇒ báo trong ERP để bếp chuẩn bị. Mẫu chỉ báo trong ERP (NHÁP + CHẠY THỬ); quán bật thật và nối nhóm chat bếp nếu muốn.",
      trigger: { kind: "event", event: "order.confirmed" },
      actions: [{ kind: "notify", message: "Đơn mới đã chốt — bếp chuẩn bị món" }],
    },
  ],
  ai: {
    businessProfile:
      "Quán ăn / nhà hàng bán món theo THỰC ĐƠN (sản phẩm có nhóm món, khẩu phần, giá), phục vụ tại bàn, mang về và giao hàng. Nhận ĐẶT BÀN theo giờ: số bàn nhận đặt trước có hạn, bot chỉ hứa giờ còn bàn. Khách dị ứng / kiêng món phải được ghi lại để bếp biết.",
    glossary: [
      { term: "Đặt bàn", meaning: "Một lịch hẹn của module Lịch hẹn: khách, giờ tới, ghi chú số người. Sức chứa = số bàn nhận đặt trước." },
      { term: "Hình thức", meaning: "Tại bàn / mang về / giao hàng — field của đơn." },
      { term: "Khẩu phần", meaning: "Món đủ cho mấy người ăn — dùng để tư vấn gọi món." },
    ],
  },
};

/**
 * MẪU «HẢI SẢN — BÁN LẺ + BÁN SỈ» (Seafood OS · docs/verticals/seafood-os.md) — shop hải sản tươi / đông lạnh / khô bán cho
 * khách lẻ qua chat và cho quán ăn, nhà hàng, đại lý mua sỉ trả chậm.
 *
 * Mẫu chỉ là CẤU HÌNH: không mang sản phẩm, giá, khách hay bí mật của shop nào. Những thứ làm nên Seafood OS là tính năng
 * LÕI đã có cho mọi tổ chức tạo đơn tay — mẫu chỉ bật đúng module và đặt tên đúng ngôn ngữ của ngành:
 *  · Bảng giá sỉ theo nhóm khách + bậc số lượng (Sản phẩm → Bảng giá sỉ, 0188) — chatbot báo được giá sỉ khi chủ shop BẬT.
 *  · Hạn mức nợ chặn lượt chốt đơn, công nợ đọc từ phiếu thu, thu nợ gộp (Khách hàng → Công nợ, 0188).
 *  · Nhắc mua lại theo nhịp mua thật của từng khách + sổ liên hệ (Khách hàng → Nhắc mua lại, 0189).
 *  · Nhập hàng từ ghe / nhà cung cấp (module Mua hàng), giữ hàng khi chốt, chatbot bán hàng.
 *
 * KHÔNG bật «Vận chuyển» và «CSKH» — cùng lý do với mẫu thực phẩm: hai module ấy dựng trên connector chỉ-nhà. KHÔNG khai
 * chu kỳ mua lại hay hạn mức mặc định nào: đó là quyết định kinh doanh của từng shop (luật 38).
 */
import type { Blueprint } from "@/lib/blueprints/types";

export const SEAFOOD_COMMERCE_BLUEPRINT: Blueprint = {
  format: "erp-blueprint",
  formatVersion: 1,
  key: "seafood-commerce",
  version: "1.1.0",
  name: "Hải sản — bán lẻ + bán sỉ",
  description: "Shop hải sản tươi, đông lạnh, khô bán cho khách lẻ qua chat và cho quán ăn / nhà hàng / đại lý mua sỉ trả chậm. Bảng giá sỉ theo nhóm khách, hạn mức và công nợ, nhắc khách mua lại theo nhịp, nhập hàng từ nhà cung cấp, chatbot bán hàng.",
  industry: "Hải sản",
  // 1.1.0: thêm «Săn khách sỉ» (0197) — tìm nhà hàng / quán / khách sạn làm khách sỉ mới; module TẮT được ở /settings/modules.
  modules: ["core", "work", "customers", "products", "orders", "inventory", "purchasing", "ai_sales", "wholesale_leads"],
  roles: [
    {
      key: "ban_hang",
      label: "Nhân viên bán hàng",
      description: "Tư vấn, báo giá, chốt đơn, gọi khách đến hạn mua lại, ghi liên hệ. Không sửa bảng giá, không nhập kho.",
      base: "VIEWER",
      permissions: ["dashboard:view", "orders:read", "orders:write", "customers:view", "customers:write", "products:view", "work:view", "work:manage", "ai_sales:view", "wholesale:view", "wholesale:work"],
      defaultScope: "ALL",
    },
    {
      key: "kho",
      label: "Nhân viên kho",
      description: "Nhập hàng từ ghe / nhà cung cấp, kiểm kê, xuất theo đơn đã chốt. Xem đơn để đóng gói; không sửa đơn, không xem công nợ.",
      base: "WAREHOUSE",
      permissions: ["dashboard:view", "orders:read", "products:view", "inventory:write", "work:view", "work:manage"],
      defaultScope: "ALL",
    },
    {
      key: "ke_toan_cong_no",
      label: "Kế toán công nợ",
      description: "Theo dõi công nợ khách sỉ, ghi thu nợ (phiếu thu theo đơn), đặt hạn mức và số ngày được nợ của khách.",
      base: "ACCOUNTANT",
      permissions: ["dashboard:view", "orders:read", "orders:write", "customers:view", "customers:write", "products:view"],
      defaultScope: "ALL",
    },
  ],
  fields: [
    {
      objectKey: "product",
      key: "dang_hang",
      label: "Dạng hàng",
      type: "select",
      listable: true,
      filterable: true,
      options: [
        { value: "tuoi_song", label: "Tươi sống" },
        { value: "uop_da", label: "Tươi ướp đá" },
        { value: "dong_lanh", label: "Đông lạnh" },
        { value: "kho", label: "Khô" },
        { value: "che_bien", label: "Chế biến sẵn" },
      ],
    },
    { objectKey: "product", key: "co_size", label: "Cỡ / size", type: "text", listable: true, validation: { maxLength: 60 }, helpText: "Vd «10–12 con/kg», «loại 1», «size L» — đúng cách shop gọi tên cỡ hàng." },
    { objectKey: "product", key: "don_vi_ban", label: "Đơn vị bán", type: "text", listable: true, validation: { maxLength: 30 }, helpText: "Vd «kg», «khay 500g», «con», «túi 1kg». Giá lẻ và giá sỉ của mẫu mã là giá cho MỘT đơn vị này." },
    { objectKey: "product", key: "vung_nguon", label: "Vùng / nguồn hàng", type: "text", filterable: true, validation: { maxLength: 80 }, helpText: "Vd «Cô Tô», «Phú Quốc», «ghe anh Tư» — chatbot đọc ô này khi khách hỏi hàng ở đâu." },
    { objectKey: "product", key: "bao_quan", label: "Bảo quản & chế biến", type: "textarea", validation: { maxLength: 500 }, helpText: "Vd «Ngăn đá −18°C, dùng trong 3 tháng; rã đông ngăn mát 4 giờ»." },
    {
      objectKey: "customer",
      key: "loai_khach",
      label: "Loại khách",
      type: "select",
      filterable: true,
      listable: true,
      options: [
        { value: "le", label: "Khách lẻ" },
        { value: "quan_an", label: "Quán ăn / nhà hàng" },
        { value: "dai_ly", label: "Đại lý / mua sỉ" },
        { value: "ctv", label: "Cộng tác viên" },
      ],
      helpText: "Chỉ để lọc và gọi tên. Giá sỉ, hạn mức và số ngày được nợ đặt ở «Điều khoản bán» trên trang khách.",
    },
    { objectKey: "customer", key: "gio_nhan_hang", label: "Giờ nhận hàng", type: "text", validation: { maxLength: 80 }, helpText: "Vd «trước 9h sáng», «sau 14h» — quán ăn thường chỉ nhận hàng một khung giờ." },
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
            key: "mua_hang",
            label: "Mua hàng",
            fields: [
              { ref: "custom:loai_khach", visible: true, readOnly: false, required: false },
              { ref: "custom:gio_nhan_hang", visible: true, readOnly: false, required: false },
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
      slug: "tong-quan-hai-san",
      name: "Tổng quan bán hàng",
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
            key: "xu_huong",
            title: "30 ngày gần đây",
            blocks: [
              { id: "don_theo_ngay", type: "chart", span: 6, title: "Đơn lên theo ngày", config: { series: "orders_by_day", kind: "bar", period: "30d" } },
              { id: "doanh_thu_theo_ngay", type: "chart", span: 6, title: "Doanh thu lên đơn theo ngày", config: { series: "booked_revenue_by_day", kind: "line", period: "30d" } },
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
  ],
  workflows: [
    {
      key: "bao_nhom_don_xac_nhan",
      name: "Đơn chốt ⇒ báo nhóm kho",
      description: "Đơn chuyển «Đã xác nhận» (hàng tự được GIỮ ở cột khả dụng) ⇒ báo kho chuẩn bị, cân, đóng thùng đá. Mẫu chỉ báo trong ERP; nối nhóm Lark / Telegram ở Cài đặt → Thông báo nhóm.",
      trigger: { kind: "event", event: "order.confirmed" },
      actions: [{ kind: "notify", message: "Đơn vừa chốt — chuẩn bị hàng, đóng đá và giao" }],
    },
    {
      key: "bao_nhom_don_huy",
      name: "Đơn huỷ ⇒ báo nhóm kho",
      description: "Đơn đã chốt bị huỷ (hàng tự được NHẢ khỏi cột khả dụng) ⇒ báo kho dừng chuẩn bị / giao.",
      trigger: { kind: "event", event: "order.cancelled" },
      conditions: { field: "system:payload.wasConfirmed", op: "eq", value: true },
      actions: [{ kind: "notify", message: "Đơn đã chốt vừa bị huỷ — không chuẩn bị / không giao" }],
    },
  ],
  ai: {
    businessProfile:
      "Shop hải sản bán hai kiểu: khách LẺ đặt qua chat / điện thoại, trả tiền khi nhận; khách SỈ (quán ăn, nhà hàng, đại lý) mua số lượng lớn theo bảng giá riêng và có thể nợ theo hạn mức. Giá lẻ là giá của mẫu mã; giá sỉ nằm ở Bảng giá sỉ theo bậc «mua từ». Công nợ tính từ phiếu thu của từng đơn. Hàng tươi cần giao nhanh, giữ lạnh — hướng dẫn bảo quản nằm ở từng sản phẩm.",
    glossary: [
      { term: "Bảng giá sỉ", meaning: "Giá theo nhóm khách + bậc số lượng (Sản phẩm → Bảng giá sỉ). Khách chưa gán bảng dùng bảng mặc định, rồi tới giá lẻ." },
      { term: "Công nợ", meaning: "Số phải trả của đơn đã chốt / đã giao trừ các phiếu thu còn hiệu lực. Phải thu = đơn đã giao." },
      { term: "Hạn mức nợ", meaning: "Dư nợ tối đa của một khách; vượt thì không chốt được đơn mới cho tới khi thu nợ hoặc nâng hạn mức." },
      { term: "Nhắc mua lại", meaning: "Khách tới lúc mua lại theo nhịp mua của chính họ (Khách hàng → Nhắc mua lại)." },
      { term: "Dạng hàng", meaning: "Tươi sống · tươi ướp đá · đông lạnh · khô · chế biến sẵn." },
    ],
  },
};

/**
 * MẪU «GIA DỤNG / ĐIỆN MÁY NHỎ» (docs/verticals/household.md) — bán online đồ gia dụng, điện máy nhỏ, đồ công nghệ: giao qua
 * đơn vị vận chuyển, hàng cồng kềnh / dễ vỡ, và BẢO HÀNH theo serial sau bán.
 *
 * Mẫu chỉ là CẤU HÌNH. Phần làm nên ngành là module `warranty` (0196): phiếu bảo hành theo serial, tra theo SĐT / serial, ca
 * bảo hành sửa / đổi / hoàn tiền / trả nhà cung cấp, «còn bảo hành» tính lúc đọc. Chuỗi đơn → vận chuyển → hoàn hàng dùng lại
 * đúng các module của ngành bán online COD.
 *
 * KHÔNG khai số tháng bảo hành mặc định nào — mỗi sản phẩm / hãng một khác (luật 38). Field «Bảo hành (tháng)» chỉ để gợi ý
 * người lập phiếu.
 */
import type { Blueprint } from "@/lib/blueprints/types";

export const HOUSEHOLD_BLUEPRINT: Blueprint = {
  format: "erp-blueprint",
  formatVersion: 1,
  key: "household",
  version: "1.0.0",
  name: "Gia dụng / điện máy nhỏ",
  description: "Bán online gia dụng, điện máy nhỏ, đồ công nghệ: đơn và vận chuyển, hàng cồng kềnh / dễ vỡ, hoàn hàng, chăm sóc khách, và bảo hành theo serial — tra theo SĐT / serial, biết ngay còn hay hết bảo hành.",
  industry: "Gia dụng / điện máy nhỏ",
  modules: ["core", "work", "customers", "products", "orders", "inventory", "logistics", "returns", "customer_care", "finance", "warranty"],
  roles: [
    {
      key: "cskh_bao_hanh",
      label: "CSKH & bảo hành",
      description: "Nhận cuộc gọi khách báo lỗi, tra phiếu theo SĐT / serial, lập phiếu, mở và theo ca bảo hành, chăm sóc đơn.",
      base: "CS",
      permissions: ["dashboard:view", "warranty:view", "warranty:write", "customers:view", "customers:write", "orders:read", "products:view", "cs:view", "cs:manage", "work:view", "work:manage"],
      defaultScope: "ALL",
    },
    {
      key: "ky_thuat",
      label: "Kỹ thuật",
      description: "Nhận ca bảo hành, ghi cách xử lý và chi phí. Không xem doanh thu, không sửa đơn.",
      base: "VIEWER",
      permissions: ["dashboard:view", "warranty:view", "warranty:write", "customers:view", "products:view", "work:view", "work:manage"],
      defaultScope: "ALL",
    },
  ],
  fields: [
    {
      objectKey: "product",
      key: "nhom_hang",
      label: "Nhóm hàng",
      type: "select",
      listable: true,
      filterable: true,
      options: [
        { value: "nha_bep", label: "Nhà bếp" },
        { value: "dien_may_nho", label: "Điện máy nhỏ" },
        { value: "ve_sinh", label: "Vệ sinh / giặt là" },
        { value: "cong_nghe", label: "Đồ công nghệ" },
        { value: "noi_that", label: "Nội thất / trang trí" },
        { value: "phu_kien", label: "Phụ kiện" },
      ],
    },
    { objectKey: "product", key: "bao_hanh_thang", label: "Bảo hành (tháng)", type: "number", listable: true, validation: { min: 0, max: 120 }, helpText: "Gợi ý cho người lập phiếu bảo hành. Để trống = hàng không bảo hành." },
    { objectKey: "product", key: "hang_cong_kenh", label: "Hàng cồng kềnh", type: "boolean", filterable: true, helpText: "Đóng gói / phí ship riêng — kho và chăm sóc đơn cần biết." },
    { objectKey: "product", key: "de_vo", label: "Dễ vỡ", type: "boolean", filterable: true },
    { objectKey: "customer", key: "dia_chi_lap_dat", label: "Địa chỉ lắp đặt", type: "textarea", validation: { maxLength: 500 }, helpText: "Khi khác địa chỉ nhận hàng." },
  ],
  forms: [
    {
      objectKey: "customer",
      formKey: "profile",
      publish: true,
      schema: { version: 1, sections: [{ key: "lap_dat", label: "Lắp đặt", fields: [{ ref: "custom:dia_chi_lap_dat", visible: true, readOnly: false, required: false }] }] },
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
      slug: "tong-quan-gia-dung",
      name: "Tổng quan bán hàng",
      moduleKey: "orders",
      requiredPermission: "orders:read",
      nav: { enabled: true, label: "Tổng quan bán hàng", zone: "SALES", order: 1 },
      publish: true,
      schema: {
        version: 1,
        sections: [
          {
            key: "ban_hang",
            title: "Bán hàng",
            blocks: [
              { id: "don_hom_nay", type: "kpi", span: 4, title: "Đơn lên hôm nay", config: { metric: "orders_today", period: "today" } },
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
      key: "nhac_lap_phieu_bao_hanh",
      name: "Đơn chốt ⇒ nhắc lập phiếu bảo hành",
      description: "Đơn chuyển «Đã xác nhận» ⇒ nhắc CSKH: hàng có bảo hành thì lập phiếu (serial, ngày mua, số tháng) để khách gọi báo lỗi là tra được ngay. Mẫu chỉ báo trong ERP (NHÁP + CHẠY THỬ).",
      trigger: { kind: "event", event: "order.confirmed" },
      actions: [{ kind: "notify", message: "Đơn vừa chốt — hàng có bảo hành thì lập phiếu bảo hành kèm serial" }],
    },
  ],
  ai: {
    businessProfile:
      "Shop bán online gia dụng / điện máy nhỏ / đồ công nghệ: giao qua đơn vị vận chuyển, có hàng cồng kềnh và dễ vỡ. Sau bán có BẢO HÀNH theo phiếu: mỗi phiếu gắn khách, sản phẩm, serial (nếu có), ngày mua và số tháng — còn hay hết bảo hành tính từ hạn. Khách báo lỗi ⇒ mở ca bảo hành, kỹ thuật xử lý (sửa / đổi / hoàn tiền / gửi nhà cung cấp).",
    glossary: [
      { term: "Phiếu bảo hành", meaning: "Lời hứa bảo hành cho MỘT sản phẩm của MỘT khách: serial, ngày mua, số tháng ⇒ hạn." },
      { term: "Ca bảo hành", meaning: "Một lần khách báo lỗi trên một phiếu — mở, xử lý, đóng với cách xử lý hoặc từ chối có lý do." },
      { term: "Ngoài hạn", meaning: "Ca mở sau ngày hết hạn của phiếu — shop vẫn xử lý được nhưng có thể thu tiền khách." },
    ],
  },
};

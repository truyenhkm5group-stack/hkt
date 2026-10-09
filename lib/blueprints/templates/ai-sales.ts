/**
 * MẪU «CHỈ CẦN AI BÁN HÀNG» (docs/productization/MIGRATION_PLAN.md M7) — shop bán qua mạng xã hội chỉ muốn chatbot AI tư vấn,
 * báo giá, chốt đơn; KHÔNG muốn một ERP đầy đủ. Bật đúng phần bot cần đứng lên: khách · sản phẩm (giá) · đơn · kho (để bot
 * không hứa còn hàng khi không biết) · AI bán hàng. Không giao vận, không tài chính, không quảng cáo, không lương — menu gọn.
 *
 * Không mang luật ngành nào: field là thứ MỌI shop bán qua chat cần cho bot đọc (điểm bán chính, câu hỏi thường gặp của sản
 * phẩm) và kênh khách hay liên hệ. Lời nhắc của bot nhận gói `generic` (lib/sales-chatbot/packs.ts) — không ví dụ của ngành
 * nào. Luật dựng sẵn chỉ BÁO và nằm ở NHÁP (luật 23: mẫu không tự kích hoạt). Bật thêm module bất cứ lúc nào ở Module.
 */
import type { Blueprint } from "@/lib/blueprints/types";

export const AI_SALES_BLUEPRINT: Blueprint = {
  format: "erp-blueprint",
  formatVersion: 1,
  key: "ai-sales",
  // 1.1.0 (09/10/2026): vai trò `ban_hang` thêm `ai_sales:reply` — chủ shop duyệt; thay đổi DUY NHẤT so với 1.0.0. Tổ chức đã cài
  // nhận qua ops `ban-hang-reply-upgrade` (lib/blueprints/ban-hang-reply.ts, so ba chiều của bộ cài).
  version: "1.1.0",
  name: "Chỉ cần AI bán hàng",
  description: "Chatbot AI trả lời khách trên fanpage / Messenger / website 24/7: tư vấn, báo giá đúng giá shop, lấy SĐT, chốt và lên đơn, chuyển nhân viên khi cần. Kèm đúng phần bot cần: khách, sản phẩm, đơn, kho. Không giao vận, tài chính, quảng cáo hay lương — cần thì bật ở Module của tổ chức.",
  industry: null,
  modules: ["core", "customers", "products", "orders", "inventory", "ai_sales"],
  roles: [
    {
      key: "ban_hang",
      label: "Nhân viên bán hàng",
      description: "Nhận khách bot chuyển sang, đọc hội thoại bot đã chat, tạo / sửa khách và đơn, xem sản phẩm & tồn. Không sửa cấu hình bot.",
      base: "VIEWER",
      permissions: ["dashboard:view", "orders:read", "orders:write", "customers:view", "customers:write", "products:view", "ai_sales:view", "ai_sales:reply"],
      defaultScope: "ALL",
    },
  ],
  fields: [
    { objectKey: "product", key: "diem_ban_chinh", label: "Điểm bán chính", type: "textarea", validation: { maxLength: 500 }, helpText: "2–3 ý khách hay hỏi nhất: chất liệu / công dụng / xuất xứ / bảo hành. Bật ô này cho bot đọc ở cấu hình Chatbot bán hàng." },
    { objectKey: "product", key: "cau_hoi_thuong_gap", label: "Câu hỏi thường gặp", type: "textarea", validation: { maxLength: 800 }, helpText: "Hỏi – đáp ngắn về RIÊNG sản phẩm này (cách dùng, kích cỡ, đổi trả). Giá và tồn KHÔNG ghi ở đây — bot luôn đọc giá / tồn từ ERP." },
    {
      objectKey: "customer",
      key: "kenh_lien_he",
      label: "Kênh liên hệ ưa dùng",
      type: "select",
      filterable: true,
      options: [
        { value: "messenger", label: "Messenger / Fanpage" },
        { value: "zalo", label: "Zalo" },
        { value: "chat_web", label: "Chat trên website" },
        { value: "dien_thoai", label: "Điện thoại" },
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
              { id: "don_hom_nay", type: "kpi", span: 4, title: "Đơn lên hôm nay", config: { metric: "orders_today", period: "today" } },
              { id: "doanh_thu_7", type: "kpi", span: 4, title: "Doanh thu lên đơn 7 ngày", config: { metric: "booked_revenue", period: "7d" } },
              { id: "don_theo_trang_thai", type: "chart", span: 4, title: "Đơn theo trạng thái", config: { series: "orders_by_stage", kind: "pie", period: "30d" } },
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
      name: "Đơn chốt ⇒ báo nhóm",
      description: "Đơn chuyển «Đã xác nhận» (bot chốt hoặc nhân viên chốt) ⇒ báo cho người đóng gói / giao. Mẫu chỉ báo trong ERP; nối nhóm Lark / Telegram / Zalo ở Cài đặt → Thông báo nhóm.",
      trigger: { kind: "event", event: "order.confirmed" },
      actions: [{ kind: "notify", message: "Đơn vừa chốt — đóng gói và giao" }],
    },
  ],
  ai: {
    businessProfile: "Shop bán hàng online: khách nhắn tin qua fanpage, Messenger hoặc website để hỏi giá, được tư vấn và đặt hàng ngay trong cuộc chat; shop giao tận nơi.",
    glossary: [
      { term: "Chốt đơn", meaning: "Khách xác nhận mua ⇒ đơn «Đã xác nhận», hàng được giữ ở cột khả dụng của kho, nhóm nhận tin." },
      { term: "Chuyển nhân viên", meaning: "Câu hỏi bot không trả lời được bằng dữ liệu của shop ⇒ hội thoại sang người, bot im lặng chờ." },
    ],
  },
};

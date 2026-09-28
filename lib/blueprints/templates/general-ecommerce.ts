/**
 * MẪU «TMĐT CHUNG» — bán lẻ online giao qua đơn vị vận chuyển: khách · sản phẩm · đơn · kho · giao vận · tài chính.
 * Chứng minh: trang đơn theo trạng thái, nhãn trạng thái đơn của tổ chức, luật "đơn lớn ⇒ cần duyệt ⇒ việc".
 *
 * Ngưỡng "đơn lớn" trong luật là GỢI Ý của mẫu và luật sinh ở NHÁP — tổ chức đặt con số của mình trước khi bật
 * (luật 38: ngưỡng là quyết định kinh doanh). Không luật COD / hoàn nào của VNX ở đây.
 */
import type { Blueprint } from "@/lib/blueprints/types";

export const GENERAL_ECOMMERCE_BLUEPRINT: Blueprint = {
  format: "erp-blueprint",
  formatVersion: 1,
  key: "general-ecommerce",
  version: "1.0.0",
  name: "Thương mại điện tử (chung)",
  description: "Bán lẻ online nhiều ngành hàng, giao qua đơn vị vận chuyển. Quản lý khách, sản phẩm, đơn, kho, giao vận và tiền — chưa có sản xuất, quảng cáo hay lương.",
  industry: "Thương mại điện tử",
  modules: ["core", "work", "customers", "products", "orders", "inventory", "logistics", "finance"],
  fields: [
    {
      objectKey: "order",
      key: "trang_thai_duyet",
      label: "Duyệt đơn",
      type: "status",
      filterable: true,
      options: [
        { value: "moi", label: "Mới" },
        { value: "can_duyet", label: "Cần duyệt", color: "amber" },
        { value: "da_duyet", label: "Đã duyệt", color: "emerald" },
        { value: "tu_choi", label: "Từ chối", color: "rose" },
      ],
      transitions: { moi: ["can_duyet", "da_duyet"], can_duyet: ["da_duyet", "tu_choi"], tu_choi: ["can_duyet"] },
    },
    { objectKey: "order", key: "ghi_chu_goi_qua", label: "Ghi chú gói quà", type: "textarea", validation: { maxLength: 500 } },
    {
      objectKey: "customer",
      key: "phan_khuc",
      label: "Phân khúc khách",
      type: "select",
      filterable: true,
      options: [
        { value: "moi", label: "Khách mới" },
        { value: "than_thiet", label: "Thân thiết" },
        { value: "vip", label: "VIP" },
      ],
    },
    { objectKey: "customer", key: "ngay_sinh", label: "Ngày sinh", type: "date" },
  ],
  statuses: [
    {
      objectKey: "order",
      field: "stage",
      options: [
        { value: "NEW", label: "Chờ xác nhận", position: 0, active: true },
        { value: "CONFIRMED", label: "Đã xác nhận", position: 1, active: true },
        { value: "DELETED", label: "Đã xoá", position: 12, active: false },
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
            key: "cham_soc",
            label: "Chăm sóc khách",
            fields: [
              { ref: "custom:phan_khuc", visible: true, readOnly: false, required: false },
              { ref: "custom:ngay_sinh", visible: true, readOnly: false, required: false },
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
          { ref: "custom:trang_thai_duyet", visible: true },
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
      slug: "don-theo-trang-thai",
      name: "Đơn theo trạng thái",
      moduleKey: "orders",
      requiredPermission: "orders:read",
      nav: { enabled: true, label: "Đơn theo trạng thái", zone: "SALES", order: 10 },
      publish: true,
      schema: {
        version: 1,
        sections: [
          {
            key: "hom_nay",
            title: "Hôm nay",
            blocks: [
              { id: "don_hom_nay", type: "kpi", span: 3, title: "Đơn hôm nay", config: { metric: "orders_today", period: "today" } },
              { id: "doanh_thu_30", type: "kpi", span: 3, title: "Doanh thu lên đơn 30 ngày", config: { metric: "booked_revenue", period: "30d" } },
              { id: "don_theo_trang_thai", type: "chart", span: 6, title: "Đơn theo trạng thái", config: { series: "orders_by_stage", kind: "pie", period: "30d" } },
            ],
          },
          {
            key: "duyet",
            title: "Duyệt đơn",
            blocks: [
              {
                id: "kanban_duyet",
                type: "kanban",
                span: 12,
                title: "Đơn theo bước duyệt",
                config: { objectKey: "order", statusField: "custom:trang_thai_duyet", cardFields: ["system:customer_name", "system:total"], allowMove: true },
              },
              { id: "bang_don", type: "table", span: 12, title: "Đơn mới nhất", config: { source: "order", columns: ["system:id", "system:customer_name", "system:stage", "custom:trang_thai_duyet", "system:total"], pageSize: 20, rowLink: true } },
            ],
          },
        ],
      },
    },
  ],
  workflows: [
    {
      key: "don_lon_can_duyet",
      name: "Đơn lớn cần duyệt ⇒ người duyệt ⇒ việc",
      description: "Đơn chuyển «Cần duyệt» và giá trị từ 5.000.000 ₫ ⇒ xin duyệt, được duyệt thì tạo việc cho phòng Kinh doanh. Ngưỡng là gợi ý của mẫu — sửa theo quyết định của tổ chức trước khi bật.",
      trigger: { kind: "custom_status", objectKey: "order", fieldKey: "trang_thai_duyet", to: ["can_duyet"] },
      conditions: { field: "system:total", op: "gte", value: 5_000_000 },
      actions: [{ kind: "create_task", title: "Duyệt đơn giá trị lớn", summary: "Gọi xác nhận khách, kiểm tồn, rồi chuyển «Đã duyệt» hoặc «Từ chối».", departmentCode: "SALES", priority: "HIGH", dueInHours: 4 }],
      gate: { kind: "approval", reason: "Đơn giá trị lớn cần trưởng nhóm bán hàng duyệt trước khi giao việc" },
    },
  ],
  settings: [
    {
      key: "care.notePresets",
      value: {
        presets: [
          { id: "bp-no-answer", kind: "CALLED_NO_ANSWER", text: "Gọi hai lần không nghe máy, đã nhắn tin hẹn giao lại." },
          { id: "bp-reschedule", kind: "RESCHEDULED", text: "Khách hẹn nhận lại, đã báo đơn vị vận chuyển phát lại." },
          { id: "bp-address", kind: "ADDRESS_FIXED", text: "Khách đổi địa chỉ / số điện thoại nhận, đã cập nhật cho đơn vị vận chuyển." },
          { id: "bp-refused", kind: "CUSTOMER_REFUSED", text: "Khách xác nhận không nhận hàng nữa." },
        ],
      },
    },
  ],
  integrations: [{ connectorKey: "connector_messaging", reason: "Gửi cảnh báo và bản tin ra nhóm chat của đội. Chỉ là gợi ý — tổ chức tự khai kênh, mẫu không cấu hình URL hay token nào." }],
  ai: {
    businessProfile: "Cửa hàng bán lẻ online nhiều ngành hàng. Đơn đến từ website / sàn / tin nhắn, giao qua đơn vị vận chuyển; khách có thể thanh toán trước hoặc khi nhận. Đơn giá trị lớn qua một bước duyệt nội bộ trước khi đóng gói.",
    glossary: [
      { term: "Duyệt đơn", meaning: "Bước nội bộ xác nhận đơn giá trị lớn (Mới → Cần duyệt → Đã duyệt / Từ chối) — khác trạng thái vận chuyển của đơn." },
      { term: "Phân khúc khách", meaning: "Nhãn do người đặt: Khách mới, Thân thiết, VIP." },
    ],
  },
};

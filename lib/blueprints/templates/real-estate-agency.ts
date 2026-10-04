/**
 * MẪU «SÀN / ĐẠI LÝ BẤT ĐỘNG SẢN» (docs/verticals/real-estate.md) — sàn phân phối căn hộ / đất nền của chủ đầu tư cho đội sale.
 *
 * Mẫu chỉ là CẤU HÌNH. Phần làm nên ngành là module `real_estate` (0201): bảng hàng chung, giữ chỗ có hạn không cho hai sale giữ
 * trùng, cọc, ký bán, chủ đầu tư khoá căn. KHÔNG khai số giờ giữ chỗ, mức cọc hay tỷ lệ hoa hồng mặc định nào — đó là chính sách
 * của từng dự án / sàn (luật 38); hoa hồng nhiều tầng là phase riêng (luật 16).
 */
import type { Blueprint } from "@/lib/blueprints/types";

export const REAL_ESTATE_AGENCY_BLUEPRINT: Blueprint = {
  format: "erp-blueprint",
  formatVersion: 1,
  key: "real-estate-agency",
  version: "1.0.0",
  name: "Sàn / đại lý bất động sản",
  description: "Sàn phân phối căn hộ / đất nền: bảng hàng chung theo dự án, giữ chỗ có hạn không cho hai sale giữ trùng một căn, cọc, ký bán, chủ đầu tư khoá căn; khách tiềm năng theo giai đoạn.",
  industry: "Bất động sản",
  modules: ["core", "work", "customers", "customer_care", "finance", "real_estate"],
  roles: [
    {
      key: "sale_bds",
      label: "Sale bất động sản",
      description: "Xem bảng hàng, giữ chỗ cho khách của mình, chuyển giữ chỗ thành cọc, chăm khách tiềm năng.",
      base: "CS",
      permissions: ["dashboard:view", "real_estate:view", "real_estate:hold", "customers:view", "customers:write", "work:view", "work:manage"],
      defaultScope: "ALL",
    },
    {
      key: "quan_ly_san",
      label: "Quản lý sàn",
      description: "Tạo dự án, nhập căn, khoá căn theo chủ đầu tư, nhả giữ chỗ quá hạn của sale, xử lý hoàn / bỏ cọc, xác nhận ký bán.",
      base: "MANAGER",
      permissions: ["dashboard:view", "real_estate:view", "real_estate:hold", "real_estate:manage", "customers:view", "customers:write", "work:view", "work:manage"],
      defaultScope: "ALL",
    },
  ],
  fields: [
    {
      objectKey: "customer",
      key: "giai_doan_mua",
      label: "Giai đoạn khách",
      type: "status",
      filterable: true,
      options: [
        { value: "moi", label: "Mới" },
        { value: "da_tu_van", label: "Đã tư vấn" },
        { value: "da_xem_nha", label: "Đã xem nhà mẫu / dự án", color: "amber" },
        { value: "da_coc", label: "Đã cọc", color: "emerald" },
        { value: "ngung", label: "Ngừng quan tâm", color: "slate" },
      ],
    },
    { objectKey: "customer", key: "ngan_sach", label: "Ngân sách dự kiến", type: "currency", validation: { min: 0 }, filterable: true },
    { objectKey: "customer", key: "nhu_cau", label: "Nhu cầu", type: "textarea", validation: { maxLength: 500 }, helpText: "Loại căn, số phòng ngủ, hướng, để ở hay đầu tư, vay ngân hàng…" },
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
            key: "nhu_cau_mua",
            label: "Nhu cầu mua",
            fields: [
              { ref: "custom:giai_doan_mua", visible: true, readOnly: false, required: false },
              { ref: "custom:ngan_sach", visible: true, readOnly: false, required: false },
              { ref: "custom:nhu_cau", visible: true, readOnly: false, required: false },
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
          { ref: "custom:giai_doan_mua", visible: true },
          { ref: "custom:ngan_sach", visible: true },
        ],
        defaultSort: { ref: "system:name", dir: "asc" },
        defaultFilters: [],
      },
    },
  ],
  pages: [
    {
      slug: "khach-bat-dong-san",
      name: "Khách tiềm năng",
      moduleKey: "customers",
      requiredPermission: "customers:view",
      nav: { enabled: true, label: "Khách tiềm năng", zone: "SALES", order: 10 },
      publish: true,
      schema: {
        version: 1,
        sections: [
          {
            key: "khach",
            title: "Khách theo giai đoạn",
            blocks: [
              { id: "huong_dan", type: "text", span: 12, config: { heading: "Bảng hàng ở mục «Bảng hàng BĐS»", body: "Giữ chỗ, cọc, ký bán và trạng thái từng căn nằm ở mục Bảng hàng BĐS. Trang này giữ khách tiềm năng theo giai đoạn: mới, đã tư vấn, đã xem nhà mẫu, đã cọc." } },
              { id: "kanban_khach", type: "kanban", span: 12, title: "Giai đoạn khách", config: { objectKey: "customer", statusField: "custom:giai_doan_mua", cardFields: ["system:phone", "custom:ngan_sach"], allowMove: true } },
            ],
          },
        ],
      },
    },
  ],
  workflows: [
    {
      key: "khach_da_xem_nha",
      name: "Khách đã xem nhà mẫu ⇒ việc chốt trong 48 giờ",
      description: "Khi khách chuyển sang «Đã xem nhà mẫu / dự án», tạo việc cho phòng Kinh doanh gọi lại chốt căn trong 48 giờ — khách nguội rất nhanh sau buổi xem. Sinh ở NHÁP + CHẠY THỬ — bật khi đã xem lượt chạy thử.",
      trigger: { kind: "custom_status", objectKey: "customer", fieldKey: "giai_doan_mua", to: ["da_xem_nha"] },
      actions: [{ kind: "create_task", title: "Gọi lại khách vừa xem nhà mẫu", summary: "Hỏi cảm nhận, gửi bảng giá căn phù hợp, đề xuất giữ chỗ.", departmentCode: "SALES", priority: "HIGH", dueInHours: 48 }],
      gate: null,
    },
  ],
  ai: {
    businessProfile:
      "Sàn / đại lý phân phối bất động sản (căn hộ, đất nền) của chủ đầu tư cho nhiều sale cùng lúc. Mỗi căn bán đúng một lần: sale giữ chỗ có hạn cho khách, khách cọc, rồi ký hợp đồng mua bán. Hai sale không được giữ trùng một căn. Chủ đầu tư có thể khoá / rút căn khỏi bảng hàng.",
    glossary: [
      { term: "Bảng hàng", meaning: "Danh sách căn của một dự án kèm trạng thái: còn trống, đang giữ chỗ, đã cọc, đã bán, chủ đầu tư khoá." },
      { term: "Giữ chỗ", meaning: "Sale giữ một căn cho khách trong số giờ dự án cho phép; quá hạn tự trở về còn trống." },
      { term: "Cọc", meaning: "Khách đặt tiền giữ căn; hoàn cọc hoặc khách bỏ cọc thì căn trở lại còn trống." },
    ],
  },
};

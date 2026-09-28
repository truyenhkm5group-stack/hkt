/**
 * MẪU «SẢN XUẤT» — xưởng tự sản xuất: sản phẩm · sản xuất · kho · mua hàng + ứng dụng tuỳ biến. KHÔNG khách, đơn,
 * marketing hay tài chính. Chứng minh: đối tượng tuỳ biến `x_work_center` (chuyền sản xuất) có field trạng thái, field
 * quan hệ từ sản phẩm và lệnh sản xuất tới chuyền, kanban sản phẩm theo giai đoạn sản xuất, luật "chuyền vào bảo trì ⇒
 * việc cho phòng Sản xuất".
 *
 * GIỚI HẠN ĐÃ BIẾT: khối trang (Phase 4) chưa có nguồn danh sách cho `production_order` hay đối tượng `x_…` (bước nối
 * trang ↔ đối tượng tuỳ biến của phase-6-contracts mục 7 chưa làm), nên kanban đứng trên SẢN PHẨM theo giai đoạn sản
 * xuất; chuyền và lệnh xem ở `/o/x_work_center` và màn Sản xuất. Khi sổ nguồn có đối tượng tuỳ biến, nâng mẫu lên phiên
 * bản mới thêm kanban chuyền — bộ cài cập nhật trang nếu tổ chức chưa sửa nó.
 */
import type { Blueprint } from "@/lib/blueprints/types";

export const MANUFACTURING_BLUEPRINT: Blueprint = {
  format: "erp-blueprint",
  formatVersion: 1,
  key: "manufacturing",
  version: "1.0.0",
  name: "Xưởng sản xuất",
  description: "Xưởng tự may / lắp ráp theo chuyền: sản phẩm đi qua các giai đoạn sản xuất, mua nguyên liệu về kho, theo dõi công suất và bảo trì từng chuyền. Không bán lẻ, không quảng cáo.",
  industry: "Sản xuất",
  modules: ["core", "work", "products", "inventory", "purchasing", "production", "apps"],
  objects: [
    {
      key: "x_work_center",
      label: "Chuyền sản xuất",
      labelPlural: "Chuyền sản xuất",
      icon: "wrench",
      moduleKey: "production",
      titleLabel: "Tên chuyền",
      description: "Một chuyền / tổ sản xuất: công suất, tình trạng, tổ trưởng.",
    },
  ],
  fields: [
    { objectKey: "x_work_center", key: "cong_suat_ngay", label: "Công suất / ngày", type: "number", validation: { min: 0 }, helpText: "Số sản phẩm chuyền làm được một ngày. Để trống = chưa đo (không phải 0)." },
    {
      objectKey: "x_work_center",
      key: "tinh_trang",
      label: "Tình trạng",
      type: "status",
      filterable: true,
      options: [
        { value: "hoat_dong", label: "Đang chạy", color: "emerald" },
        { value: "bao_tri", label: "Bảo trì", color: "amber" },
        { value: "tam_dung", label: "Tạm dừng", color: "slate" },
      ],
      transitions: { hoat_dong: ["bao_tri", "tam_dung"], bao_tri: ["hoat_dong", "tam_dung"], tam_dung: ["hoat_dong"] },
    },
    { objectKey: "x_work_center", key: "to_truong", label: "Tổ trưởng", type: "user" },
    {
      objectKey: "product",
      key: "giai_doan_sx",
      label: "Giai đoạn sản xuất",
      type: "status",
      filterable: true,
      options: [
        { value: "thiet_ke", label: "Thiết kế" },
        { value: "lam_mau", label: "Làm mẫu", color: "amber" },
        { value: "san_xuat", label: "Sản xuất hàng loạt", color: "emerald" },
        { value: "ngung", label: "Ngừng", color: "slate" },
      ],
      transitions: { thiet_ke: ["lam_mau", "ngung"], lam_mau: ["san_xuat", "thiet_ke", "ngung"], san_xuat: ["ngung"], ngung: ["thiet_ke"] },
    },
    { objectKey: "product", key: "dinh_muc_ngay", label: "Định mức / ngày", type: "number", validation: { min: 0 } },
    { objectKey: "product", key: "chuyen_mac_dinh", label: "Chuyền mặc định", type: "relation", relation: { objectKey: "x_work_center" } },
    { objectKey: "production_order", key: "chuyen_san_xuat", label: "Chuyền sản xuất", type: "relation", relation: { objectKey: "x_work_center" } },
  ],
  forms: [
    {
      objectKey: "x_work_center",
      formKey: "create",
      publish: true,
      schema: {
        version: 1,
        sections: [
          {
            key: "chuyen",
            label: "Chuyền",
            fields: [
              { ref: "system:title", visible: true, readOnly: false, required: true },
              { ref: "system:owner", visible: true, readOnly: false, required: false },
              { ref: "custom:cong_suat_ngay", visible: true, readOnly: false, required: false },
              { ref: "custom:tinh_trang", visible: true, readOnly: false, required: false },
              { ref: "custom:to_truong", visible: true, readOnly: false, required: false },
            ],
          },
        ],
      },
    },
  ],
  listViews: [
    {
      objectKey: "x_work_center",
      listKey: "default",
      publish: true,
      schema: {
        version: 1,
        columns: [
          { ref: "system:title", visible: true },
          { ref: "custom:tinh_trang", visible: true },
          { ref: "custom:cong_suat_ngay", visible: true },
          { ref: "system:owner", visible: true },
          { ref: "system:updated_at", visible: true },
        ],
        defaultSort: { ref: "system:title", dir: "asc" },
        defaultFilters: [],
      },
    },
  ],
  pages: [
    {
      slug: "ke-hoach-san-xuat",
      name: "Kế hoạch sản xuất",
      moduleKey: "production",
      requiredPermission: "products:view",
      nav: { enabled: true, label: "Kế hoạch sản xuất", zone: "PRODUCTION", order: 5 },
      publish: true,
      schema: {
        version: 1,
        sections: [
          {
            key: "tong_quan",
            title: "Tổng quan",
            blocks: [
              { id: "ton_kha_dung", type: "kpi", span: 4, title: "Tồn khả dụng", config: { metric: "available_stock" } },
              { id: "huong_dan", type: "text", span: 8, config: { heading: "Chuyền sản xuất", body: "Công suất và tình trạng từng chuyền ở mục Chuyền sản xuất (menu Sản xuất). Chuyền chuyển «Bảo trì» sẽ sinh việc cho phòng Sản xuất khi luật được bật." } },
            ],
          },
          {
            key: "giai_doan",
            title: "Sản phẩm theo giai đoạn",
            blocks: [
              { id: "kanban_giai_doan", type: "kanban", span: 12, title: "Giai đoạn sản xuất", config: { objectKey: "product", statusField: "custom:giai_doan_sx", cardFields: ["system:custom_id", "custom:dinh_muc_ngay"], allowMove: true } },
              { id: "bang_san_pham", type: "table", span: 12, title: "Sản phẩm", config: { source: "product", columns: ["system:name", "system:custom_id", "custom:giai_doan_sx", "custom:dinh_muc_ngay"], pageSize: 20, rowLink: true } },
            ],
          },
        ],
      },
    },
  ],
  workflows: [
    {
      key: "chuyen_bao_tri",
      name: "Chuyền vào bảo trì ⇒ việc cho phòng Sản xuất",
      description: "Chuyền chuyển «Bảo trì» ⇒ tạo việc lên lịch sửa và dời kế hoạch cho phòng Sản xuất. Sinh ở NHÁP + CHẠY THỬ.",
      trigger: { kind: "custom_status", objectKey: "x_work_center", fieldKey: "tinh_trang", to: ["bao_tri"] },
      actions: [{ kind: "create_task", title: "Lên lịch bảo trì chuyền và dời kế hoạch sản xuất", departmentCode: "PRODUCTION", priority: "HIGH", dueInHours: 8 }],
      gate: null,
    },
  ],
  ai: {
    businessProfile: "Xưởng sản xuất theo chuyền. Sản phẩm đi qua các giai đoạn thiết kế → làm mẫu → sản xuất hàng loạt; nguyên liệu mua từ nhà cung cấp về kho. Mỗi chuyền có công suất ngày, tổ trưởng và tình trạng (đang chạy, bảo trì, tạm dừng). Không bán lẻ trực tiếp, không chạy quảng cáo.",
    glossary: [
      { term: "Chuyền", meaning: "Một tổ / dây chuyền sản xuất; bản ghi của đối tượng Chuyền sản xuất." },
      { term: "Định mức", meaning: "Số sản phẩm một chuyền làm được trong một ngày cho một mã hàng." },
      { term: "Lệnh sản xuất", meaning: "Đơn đặt làm một số lượng sản phẩm, gắn với một chuyền." },
    ],
  },
};

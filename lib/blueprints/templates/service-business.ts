/**
 * MẪU «DOANH NGHIỆP DỊCH VỤ» — bán dịch vụ theo hợp đồng / dự án: khách · CSKH · tài chính + ứng dụng tuỳ biến. KHÔNG
 * sản phẩm, đơn, kho hay vận chuyển. Chứng minh: hai đối tượng tuỳ biến `x_contract` và `x_project` cùng quan hệ tới
 * khách (một-nhiều), dự án ↔ hợp đồng một-một, hợp đồng ↔ dự án nhiều-nhiều; luật "hợp đồng mới > ngưỡng ⇒ trưởng phòng
 * duyệt ⇒ việc" ở NHÁP.
 *
 * Ngưỡng 20.000.000 ₫ là GỢI Ý của mẫu (luật 38: ngưỡng là quyết định kinh doanh) — mô tả luật nói tổ chức đặt lại
 * trước khi bật.
 */
import type { Blueprint } from "@/lib/blueprints/types";

export const SERVICE_BUSINESS_BLUEPRINT: Blueprint = {
  format: "erp-blueprint",
  formatVersion: 1,
  key: "service-business",
  version: "1.0.0",
  name: "Doanh nghiệp dịch vụ",
  description: "Công ty dịch vụ (bảo trì, thi công, tư vấn…) ký hợp đồng với khách rồi triển khai thành dự án. Theo dõi khách, hợp đồng, dự án, tiền — không bán hàng hoá, không kho.",
  industry: "Dịch vụ",
  modules: ["core", "work", "customers", "customer_care", "finance", "apps"],
  objects: [
    { key: "x_contract", label: "Hợp đồng", labelPlural: "Hợp đồng", icon: "file-text", moduleKey: "customers", titleLabel: "Số hợp đồng", description: "Hợp đồng dịch vụ ký với khách." },
    { key: "x_project", label: "Dự án", labelPlural: "Dự án", icon: "briefcase", moduleKey: "apps", titleLabel: "Tên dự án", description: "Một lượt triển khai theo hợp đồng." },
  ],
  fields: [
    { objectKey: "customer", key: "linh_vuc", label: "Lĩnh vực", type: "select", filterable: true, options: [{ value: "ca_nhan", label: "Cá nhân" }, { value: "doanh_nghiep", label: "Doanh nghiệp" }, { value: "to_chuc", label: "Tổ chức / cơ quan" }] },
    {
      objectKey: "customer",
      key: "giai_doan_kh",
      label: "Giai đoạn khách",
      type: "status",
      filterable: true,
      options: [
        { value: "tiem_nang", label: "Tiềm năng" },
        { value: "dang_phuc_vu", label: "Đang phục vụ", color: "emerald" },
        { value: "tam_dung", label: "Tạm dừng", color: "slate" },
      ],
    },
    { objectKey: "x_contract", key: "khach_hang", label: "Khách hàng", type: "relation", relation: { objectKey: "customer" }, filterable: true },
    { objectKey: "x_contract", key: "gia_tri", label: "Giá trị hợp đồng", type: "currency", validation: { min: 0 }, filterable: true },
    {
      objectKey: "x_contract",
      key: "trang_thai",
      label: "Trạng thái hợp đồng",
      type: "status",
      filterable: true,
      options: [
        { value: "nhap", label: "Nháp" },
        { value: "cho_duyet", label: "Chờ duyệt", color: "amber" },
        { value: "hieu_luc", label: "Hiệu lực", color: "emerald" },
        { value: "ket_thuc", label: "Kết thúc", color: "slate" },
      ],
      transitions: { nhap: ["cho_duyet"], cho_duyet: ["hieu_luc", "nhap"], hieu_luc: ["ket_thuc"] },
    },
    { objectKey: "x_contract", key: "ngay_het_han", label: "Ngày hết hạn", type: "date" },
    { objectKey: "x_contract", key: "du_an", label: "Dự án thuộc hợp đồng", type: "relation_many", relation: { objectKey: "x_project" } },
    { objectKey: "x_project", key: "khach_hang", label: "Khách hàng", type: "relation", relation: { objectKey: "customer" }, filterable: true },
    { objectKey: "x_project", key: "hop_dong_chinh", label: "Hợp đồng chính", type: "relation", relation: { objectKey: "x_contract", unique: true }, helpText: "Mỗi hợp đồng có tối đa MỘT dự án chính." },
    { objectKey: "x_project", key: "tien_do", label: "Tiến độ", type: "select", filterable: true, options: [{ value: "chua_bat_dau", label: "Chưa bắt đầu" }, { value: "dang_lam", label: "Đang làm" }, { value: "xong", label: "Xong" }] },
    { objectKey: "x_project", key: "han_chot", label: "Hạn chót", type: "date" },
  ],
  forms: [
    {
      objectKey: "x_contract",
      formKey: "create",
      publish: true,
      schema: {
        version: 1,
        sections: [
          {
            key: "hop_dong",
            label: "Hợp đồng",
            fields: [
              { ref: "system:title", visible: true, readOnly: false, required: true },
              { ref: "custom:khach_hang", visible: true, readOnly: false, required: true },
              { ref: "custom:gia_tri", visible: true, readOnly: false, required: false },
              { ref: "custom:trang_thai", visible: true, readOnly: false, required: false },
              { ref: "custom:ngay_het_han", visible: true, readOnly: false, required: false },
              { ref: "system:owner", visible: true, readOnly: false, required: false },
            ],
          },
        ],
      },
    },
    {
      objectKey: "customer",
      formKey: "profile",
      publish: true,
      schema: {
        version: 1,
        sections: [
          {
            key: "dich_vu",
            label: "Thông tin dịch vụ",
            fields: [
              { ref: "custom:linh_vuc", visible: true, readOnly: false, required: false },
              { ref: "custom:giai_doan_kh", visible: true, readOnly: false, required: false },
            ],
          },
        ],
      },
    },
  ],
  listViews: [
    {
      objectKey: "x_contract",
      listKey: "default",
      publish: true,
      schema: {
        version: 1,
        columns: [
          { ref: "system:title", visible: true },
          { ref: "custom:khach_hang", visible: true },
          { ref: "custom:gia_tri", visible: true },
          { ref: "custom:trang_thai", visible: true },
          { ref: "custom:ngay_het_han", visible: true },
        ],
        defaultSort: { ref: "system:created_at", dir: "desc" },
        defaultFilters: [],
      },
    },
    {
      objectKey: "x_project",
      listKey: "default",
      publish: true,
      schema: {
        version: 1,
        columns: [
          { ref: "system:title", visible: true },
          { ref: "custom:khach_hang", visible: true },
          { ref: "custom:tien_do", visible: true },
          { ref: "custom:han_chot", visible: true },
          { ref: "system:owner", visible: true },
        ],
        defaultSort: { ref: "system:updated_at", dir: "desc" },
        defaultFilters: [],
      },
    },
  ],
  pages: [
    {
      slug: "khach-hang-dich-vu",
      name: "Khách hàng dịch vụ",
      moduleKey: "customers",
      requiredPermission: "customers:view",
      nav: { enabled: true, label: "Khách hàng dịch vụ", zone: "SALES", order: 10 },
      publish: true,
      schema: {
        version: 1,
        sections: [
          {
            key: "khach",
            title: "Khách theo giai đoạn",
            blocks: [
              { id: "huong_dan", type: "text", span: 12, config: { heading: "Hợp đồng và dự án", body: "Mỗi khách xem hợp đồng và dự án trỏ tới mình ở trang chi tiết khách. Hợp đồng mới từ 20.000.000 ₫ đi qua bước duyệt khi luật được bật." } },
              { id: "kanban_khach", type: "kanban", span: 12, title: "Giai đoạn khách", config: { objectKey: "customer", statusField: "custom:giai_doan_kh", cardFields: ["system:phone", "custom:linh_vuc"], allowMove: true } },
              { id: "bang_khach", type: "table", span: 12, title: "Khách hàng", config: { source: "customer", columns: ["system:name", "system:phone", "custom:linh_vuc", "custom:giai_doan_kh"], pageSize: 20, rowLink: true } },
            ],
          },
        ],
      },
    },
  ],
  workflows: [
    {
      key: "hop_dong_lon_can_duyet",
      name: "Hợp đồng lớn ⇒ trưởng phòng duyệt ⇒ việc",
      description: "Hợp đồng mới có giá trị từ 20.000.000 ₫ ⇒ xin duyệt, được duyệt thì tạo việc chuẩn bị triển khai cho phòng Kinh doanh. Ngưỡng là gợi ý của mẫu — sửa theo quyết định của tổ chức trước khi bật.",
      trigger: { kind: "event", event: "custom_record.created", objectKey: "x_contract" },
      conditions: { field: "custom:gia_tri", op: "gte", value: 20_000_000 },
      actions: [{ kind: "create_task", title: "Chuẩn bị triển khai hợp đồng giá trị lớn", summary: "Rà điều khoản, lập dự án, phân người phụ trách.", departmentCode: "SALES", priority: "HIGH", dueInHours: 24 }],
      gate: { kind: "approval", reason: "Hợp đồng giá trị lớn cần trưởng phòng duyệt trước khi triển khai" },
    },
  ],
  integrations: [{ connectorKey: "connector_bank", reason: "Đối chiếu tiền khách thanh toán theo hợp đồng với sổ ngân hàng. Chỉ là gợi ý — mẫu không cấu hình thông tin đăng nhập nào." }],
  ai: {
    businessProfile: "Doanh nghiệp dịch vụ làm theo hợp đồng: ký hợp đồng với khách (cá nhân, doanh nghiệp, cơ quan), mỗi hợp đồng triển khai thành một hoặc nhiều dự án có hạn chót và tiến độ. Không bán hàng hoá, không có kho hay vận chuyển. Hợp đồng giá trị lớn qua một bước duyệt nội bộ.",
    glossary: [
      { term: "Hợp đồng", meaning: "Bản ghi của đối tượng Hợp đồng: khách, giá trị, trạng thái, ngày hết hạn." },
      { term: "Dự án", meaning: "Một lượt triển khai; mỗi dự án có tối đa một hợp đồng chính." },
      { term: "Giai đoạn khách", meaning: "Tiềm năng, đang phục vụ hoặc tạm dừng — do người đặt." },
    ],
  },
};

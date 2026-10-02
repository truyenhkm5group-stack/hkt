/**
 * MẪU «SPA / LÀM ĐẸP» (docs/verticals/appointments.md) — spa, salon, nail, thẩm mỹ: bán DỊCH VỤ theo lịch hẹn và LIỆU TRÌNH
 * N buổi trả trước, kèm sản phẩm bán lẻ (mỹ phẩm).
 *
 * Mẫu chỉ là CẤU HÌNH, không mang dịch vụ / giá / khách của shop nào. Phần làm nên ngành là module LÕI `appointments`
 * (0190): lịch theo kỹ thuật viên chặn trùng giờ, khách tới / làm xong / không tới, liệu trình tự trừ buổi khi làm xong.
 * Dịch vụ là mẫu mã của module Sản phẩm (tên, giá); khách mua gói bằng một đơn tạo tay rồi lễ tân mở liệu trình. Cùng nhắc
 * mua lại (0189) và bảng giá (0188) với mọi ngành tạo đơn tay.
 *
 * KHÔNG khai thời lượng / giá / số buổi mặc định nào — quyết định của từng tiệm (luật 38).
 */
import type { Blueprint } from "@/lib/blueprints/types";

export const SPA_BEAUTY_BLUEPRINT: Blueprint = {
  format: "erp-blueprint",
  formatVersion: 1,
  key: "spa-beauty",
  version: "1.0.0",
  name: "Spa / làm đẹp",
  description: "Spa, salon, nail, thẩm mỹ: đặt lịch theo kỹ thuật viên (chặn trùng giờ), liệu trình nhiều buổi trả trước tự trừ buổi, khách tới / không tới, bán kèm mỹ phẩm, nhắc khách quay lại.",
  industry: "Spa / làm đẹp",
  modules: ["core", "work", "customers", "products", "orders", "inventory", "appointments"],
  roles: [
    {
      key: "le_tan",
      label: "Lễ tân",
      description: "Đặt / đổi / huỷ lịch, ghi khách tới, mở liệu trình sau khi khách trả tiền gói, lên đơn bán dịch vụ / mỹ phẩm, gọi khách quay lại.",
      base: "CS",
      permissions: ["dashboard:view", "appointments:view", "appointments:write", "customers:view", "customers:write", "orders:read", "orders:write", "products:view", "work:view", "work:manage"],
      defaultScope: "ALL",
    },
    {
      key: "ky_thuat_vien",
      label: "Kỹ thuật viên",
      description: "Xem lịch của mình và hồ sơ khách (dị ứng, ghi chú), ghi làm xong. Không xem doanh thu, không sửa giá.",
      base: "VIEWER",
      permissions: ["dashboard:view", "appointments:view", "appointments:write", "customers:view", "products:view", "work:view", "work:manage"],
      defaultScope: "ALL",
    },
  ],
  fields: [
    {
      objectKey: "product",
      key: "loai_dich_vu",
      label: "Nhóm dịch vụ",
      type: "select",
      listable: true,
      filterable: true,
      options: [
        { value: "da", label: "Chăm sóc da" },
        { value: "massage", label: "Massage / body" },
        { value: "toc", label: "Tóc" },
        { value: "mong", label: "Móng" },
        { value: "tham_my", label: "Thẩm mỹ / công nghệ cao" },
        { value: "ban_le", label: "Sản phẩm bán lẻ" },
      ],
    },
    { objectKey: "product", key: "thoi_luong_phut", label: "Thời lượng (phút)", type: "number", listable: true, validation: { min: 5, max: 720 }, helpText: "Thời lượng một buổi — gợi ý khi đặt lịch. Sản phẩm bán lẻ để trống." },
    { objectKey: "customer", key: "tinh_trang_da", label: "Tình trạng da / tóc", type: "textarea", validation: { maxLength: 500 }, helpText: "Ghi theo lần soi da / tư vấn gần nhất — kỹ thuật viên đọc trước khi làm." },
    { objectKey: "customer", key: "di_ung_luu_y", label: "Dị ứng / lưu ý", type: "textarea", validation: { maxLength: 500 }, helpText: "Dị ứng mỹ phẩm, bệnh nền, đang mang thai… — điều kỹ thuật viên PHẢI biết." },
    {
      objectKey: "customer",
      key: "nguon_khach",
      label: "Khách biết tới tiệm qua",
      type: "select",
      filterable: true,
      options: [
        { value: "facebook", label: "Facebook / Instagram" },
        { value: "tiktok", label: "TikTok" },
        { value: "gioi_thieu", label: "Người quen giới thiệu" },
        { value: "di_ngang", label: "Đi ngang qua" },
        { value: "khac", label: "Khác" },
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
            key: "tu_van",
            label: "Tư vấn & lưu ý",
            fields: [
              { ref: "custom:tinh_trang_da", visible: true, readOnly: false, required: false },
              { ref: "custom:di_ung_luu_y", visible: true, readOnly: false, required: false },
              { ref: "custom:nguon_khach", visible: true, readOnly: false, required: false },
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
      slug: "tong-quan-tiem",
      name: "Tổng quan tiệm",
      moduleKey: "orders",
      requiredPermission: "orders:read",
      nav: { enabled: true, label: "Tổng quan tiệm", zone: "SALES", order: 1 },
      publish: true,
      schema: {
        version: 1,
        sections: [
          {
            key: "doanh_thu",
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
      key: "nhac_mo_lieu_trinh",
      name: "Đơn chốt ⇒ nhắc lễ tân mở liệu trình",
      description: "Đơn chuyển «Đã xác nhận» ⇒ nhắc lễ tân: nếu khách mua GÓI, mở liệu trình đúng số buổi ở trang khách để lịch tự trừ buổi. Mẫu chỉ báo trong ERP (NHÁP + CHẠY THỬ).",
      trigger: { kind: "event", event: "order.confirmed" },
      actions: [{ kind: "notify", message: "Đơn vừa chốt — nếu là gói nhiều buổi, mở liệu trình cho khách" }],
    },
  ],
  ai: {
    businessProfile:
      "Tiệm spa / làm đẹp bán DỊCH VỤ theo lịch hẹn và liệu trình nhiều buổi trả trước, kèm mỹ phẩm bán lẻ. Mỗi lịch có khách, dịch vụ, kỹ thuật viên, giờ; một kỹ thuật viên không nhận hai lịch trùng giờ. Liệu trình trừ buổi khi lịch gắn gói được ghi «đã làm xong». Khách quay lại theo nhịp — danh sách nhắc mua lại có sẵn.",
    glossary: [
      { term: "Liệu trình", meaning: "Gói N buổi khách trả trước; số buổi đã làm / đang giữ chỗ đếm từ lịch hẹn gắn gói." },
      { term: "Kỹ thuật viên", meaning: "Người làm dịch vụ — tài khoản trong ERP; lịch xếp theo người." },
      { term: "Khách không tới", meaning: "Lịch đã đặt mà khách không đến — không trừ buổi liệu trình." },
    ],
  },
};

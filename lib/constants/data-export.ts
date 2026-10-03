/**
 * ═══════════ XUẤT DỮ LIỆU CỦA TỔ CHỨC — SỔ KHAI, CLIENT-SAFE (docs/platform/data-export.md) ═══════════
 *
 * «Dữ liệu là của khách thuê» chỉ đúng khi khách tự lấy nó ra được, lúc nào cũng được — kể cả khi gói đã quá hạn (chế độ
 * chỉ xem vẫn cho mọi lượt ĐỌC). Mỗi loại khai: module sở hữu (module tắt ⇒ loại ấy không hiện, route trả 403) và nơi tải.
 * Đơn hàng / sản phẩm dùng lại route xuất SẴN CÓ của trang danh sách (một bộ cột, không chép lần hai).
 *
 * Quyền: `settings:manage` (quản trị tổ chức) — tệp mang tên, SĐT, địa chỉ của khách hàng; không thêm khoá quyền mới.
 */
import type { ModuleKey } from "@/lib/constants/platform-modules";

export const DATA_EXPORT_KINDS = ["customers", "appointments", "packages", "payments"] as const;
export type DataExportKind = (typeof DATA_EXPORT_KINDS)[number];

export type DataExportEntry = { key: string; label: string; description: string; module: ModuleKey; href: string };

export const DATA_EXPORT_ENTRIES: readonly DataExportEntry[] = [
  { key: "customers", label: "Khách hàng", description: "Tên, số điện thoại, email, địa chỉ, thẻ, số đơn, tổng đã mua.", module: "customers", href: "/api/export/data/customers" },
  { key: "orders", label: "Đơn hàng", description: "Toàn bộ đơn (mọi kỳ): khách, hàng, tiền, trạng thái.", module: "orders", href: "/api/export/orders?period=all" },
  { key: "products", label: "Sản phẩm & tồn kho", description: "Mẫu mã, giá bán, giá vốn, tồn.", module: "products", href: "/api/export/products" },
  { key: "payments", label: "Phiếu thu / hoàn tiền", description: "Mọi khoản thu nợ và hoàn tiền gắn với đơn, kể cả phiếu đã huỷ (có lý do).", module: "orders", href: "/api/export/data/payments" },
  { key: "appointments", label: "Lịch hẹn", description: "Mọi lịch: khách, dịch vụ, kỹ thuật viên, giờ, trạng thái, lý do huỷ.", module: "appointments", href: "/api/export/data/appointments" },
  { key: "packages", label: "Liệu trình", description: "Gói buổi của khách: tổng buổi, đã làm, đang giữ chỗ, còn đặt được.", module: "appointments", href: "/api/export/data/packages" },
];

/** Module của một loại xuất qua route chung `/api/export/data/<loại>`. */
export function dataExportModule(kind: DataExportKind): ModuleKey {
  return DATA_EXPORT_ENTRIES.find((e) => e.key === kind)!.module;
}

/** Một ô CSV — ô có dấu phẩy / nháy / xuống dòng / chấm phẩy thì bọc nháy. `null` ⇒ ô trống (CHƯA BIẾT, không phải 0). */
export function csvCellOf(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Tệp CSV có BOM UTF-8 — Excel trên Windows mới đọc đúng tiếng Việt. */
export function csvDocument(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return `\uFEFF${[header, ...rows].map((r) => r.map(csvCellOf).join(",")).join("\r\n")}\r\n`;
}

/**
 * ═══════════ ĐỐI TƯỢNG TUỲ BIẾN — HẰNG SỐ DÙNG CHUNG (Phase 6) — THUẦN, CLIENT-SAFE ═══════════
 *
 * Tập biểu tượng là tập ĐÓNG (docs/platform/phase-6-contracts.md mục 1): khoá ở đây, hình ở
 * `components/objects/object-icon.tsx` (TypeScript đòi bảng hình phủ ĐỦ khoá). Không nhận tên biểu tượng tự do —
 * một chuỗi lạ phải chọn giữa vẽ sai và vỡ giao diện.
 */
export const CUSTOM_OBJECT_ICONS = [
  "box",
  "file-text",
  "clipboard",
  "briefcase",
  "building",
  "hard-hat",
  "car",
  "truck",
  "wrench",
  "store",
  "home",
  "users",
  "calendar",
  "tag",
  "folder",
  "star",
] as const;
export type CustomObjectIcon = (typeof CUSTOM_OBJECT_ICONS)[number];

export const CUSTOM_OBJECT_ICON_LABEL: Record<CustomObjectIcon, string> = {
  box: "Hộp",
  "file-text": "Tài liệu",
  clipboard: "Phiếu",
  briefcase: "Cặp hồ sơ",
  building: "Toà nhà",
  "hard-hat": "Công trình",
  car: "Xe",
  truck: "Xe tải",
  wrench: "Bảo trì",
  store: "Cửa hàng",
  home: "Nhà",
  users: "Nhóm người",
  calendar: "Lịch",
  tag: "Nhãn",
  folder: "Thư mục",
  star: "Ngôi sao",
};

export function isCustomObjectIcon(x: unknown): x is CustomObjectIcon {
  return typeof x === "string" && (CUSTOM_OBJECT_ICONS as readonly string[]).includes(x);
}

/** Trần số đối tượng tuỳ biến của một tổ chức (kể cả đã lưu trữ — khoá không dùng lại được). */
export const CUSTOM_OBJECT_MAX = 100;

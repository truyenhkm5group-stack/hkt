/**
 * ═══════════ CỔNG «NỐI THẲNG FACEBOOK» CHO KHÁCH — HÀM THUẦN, CLIENT-SAFE ═══════════
 *
 * App Facebook của nền tảng CHƯA được Meta cấp quyền Page (pages_messaging · pages_show_list — sứ mệnh meta-messenger-access,
 * BLOCKED_EXTERNAL): khách bấm «Kết nối Facebook» hôm nay sẽ gặp lỗi quyền ngay (review #706, 09/10/2026). Tech Lead quyết
 * (uỷ quyền «chọn khuyến nghị» của chủ shop):
 *  · KHÁCH thấy một ô tắt «Nối thẳng Facebook — sắp mở»; «Fanpage qua Pancake» là lối chính.
 *  · Người vận hành nền tảng (`platform:operate` ở tổ chức nhà — `platformOperatorDenial`, đọc qua `can()` có sẵn) vẫn thấy nút thật.
 *  · Mở bằng MỘT cờ nền tảng đọc ở máy chủ: `platform_settings['meta.direct-connect.open']`. Vắng mặt / đọc hỏng ⇒ ĐÓNG.
 *    Giá trị `true` ⇒ mở cho mọi khách (ngày MM-META-01 PASS). Giá trị là danh sách mã workspace ⇒ chỉ mở cho các workspace
 *    đó (để đội thử bằng Page có vai trò trong app, vd `hs-thien-nga-test`, mà không mở cho khách thật). Không cần deploy.
 * Không xoá mã, không đổi route `/api/connect/messenger/*` — cổng chỉ quyết có VẼ nút hay không.
 */
export const DIRECT_CONNECT_OPEN_KEY = "meta.direct-connect.open";

/** Nhãn ô tắt khách thấy khi cổng đóng. */
export const DIRECT_CONNECT_SOON_LABEL = "Nối thẳng Facebook — sắp mở";

/** Giá trị cờ đã chuẩn hoá: `true` = mọi workspace · danh sách mã = chỉ các workspace đó · `false` = đóng. */
export type DirectConnectOpen = boolean | readonly string[];

/** Chuẩn hoá giá trị jsonb đọc từ CSDL. Mọi thứ lạ (chuỗi, số, object) ⇒ ĐÓNG — hỏng về phía hẹp. */
export function parseDirectConnectOpen(raw: unknown): DirectConnectOpen {
  if (raw === true) return true;
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string" && x.length > 0);
  return false;
}

/** Người này có được thấy nút nối thẳng Facebook THẬT không. */
export function directConnectAllowed(input: { operator: boolean; open: DirectConnectOpen; orgCode: string | null | undefined }): boolean {
  if (input.operator) return true;
  if (input.open === true) return true;
  if (Array.isArray(input.open) && input.orgCode) return input.open.includes(input.orgCode);
  return false;
}

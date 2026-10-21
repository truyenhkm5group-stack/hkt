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
 *    đó (để đội thử bằng Page có vai trò trong app, vd `hs-thien-nga-test`, hay cửa hàng cho người duyệt Meta App Review, mà
 *    không mở cho khách thật). Không cần deploy. Đường ghi DUY NHẤT: `/platform` → `setDirectConnectOpen` (có nhật ký, 17/10/2026).
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

/** Ba lựa chọn người vận hành đặt cho cờ — `ORGS` là cách DUY NHẤT mở cho cửa hàng người duyệt Meta trước khi Meta duyệt. */
export const DIRECT_CONNECT_MODES = ["CLOSED", "ORGS", "ALL"] as const;
export type DirectConnectMode = (typeof DIRECT_CONNECT_MODES)[number];
export const DIRECT_CONNECT_MODE_LABEL: Record<DirectConnectMode, string> = {
  CLOSED: "Đóng — khách thấy «sắp mở»",
  ORGS: "Chỉ các cửa hàng được liệt kê",
  ALL: "Mở cho mọi cửa hàng",
};
/** Trần số mã trong danh sách: danh sách này dành cho cửa hàng thử / người duyệt, không phải đường mở dần cho khách. */
export const DIRECT_CONNECT_MAX_ORGS = 10;

export function directConnectModeOf(open: DirectConnectOpen): DirectConnectMode {
  if (open === true) return "ALL";
  return Array.isArray(open) && open.length ? "ORGS" : "CLOSED";
}

/**
 * Ô chữ «mã cửa hàng» ⇒ danh sách mã. Tách theo dấu phẩy / khoảng trắng / xuống dòng, bỏ trùng. KHÔNG tự hạ chữ hoa: mã workspace
 * là chữ thường và so khớp CHÍNH XÁC (`directConnectAllowed`), nên một mã gõ hoa là mã sai — báo ra thay vì sửa hộ.
 */
export function parseOrgCodeList(text: string): { codes: string[]; invalid: string[] } {
  const ok = (c: string) => /^[a-z0-9][a-z0-9-]{1,62}$/.test(c);
  const parts = [...new Set(text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
  return { codes: parts.filter(ok), invalid: parts.filter((c) => !ok(c)) };
}

/**
 * CÂU CHỮ KHI CỔNG MỞ — một chỗ cho mọi nơi khách đọc về nối thẳng Facebook (trang giới thiệu công khai, Hướng dẫn, Kênh kết nối).
 * Cổng đóng ⇒ mỗi nơi giữ nguyên câu «sắp mở» của mình (bài kiểm câu chữ đọc thẳng câu đó); cổng mở ⇒ đọc câu ở đây. Ai được
 * xem câu «mở» do `directConnectAllowed` quyết (đăng nhập: `directConnectFor`; trang công khai: `directConnectPublic` — cùng luật,
 * không có nhánh thứ hai). Pancake vẫn là MỘT lựa chọn, không bị gạch đi: shop đang chạy qua Pancake không phải đổi gì.
 */
export const DIRECT_CONNECT_OPEN_COPY = {
  channelsHint: " Hoặc nối thẳng Facebook (không qua Pancake): bấm «Kết nối Facebook Page» ngay bên dưới.",
  helpStep: "Nối thẳng Facebook (không qua Pancake): mở Kênh kết nối, bấm «Kết nối Facebook Page», đăng nhập tài khoản quản trị page, giữ BẬT mọi quyền và chọn page.",
  siteStep: "Fanpage nối thẳng Facebook bằng một nút «Kết nối Facebook Page», hoặc qua Pancake (dán mã trang và mã truy cập ở trang Kết nối). Không dùng fanpage thì gắn ô chat lên website hoặc nối Zalo OA.",
  siteFaq: "Một fanpage Facebook — nối thẳng bằng một nút hoặc qua Pancake — hoặc ô chat trên website / Zalo OA. Mỗi gói có sẵn hạn mức AI hằng tháng — không phải tự mua tài khoản AI.",
} as const;

/** Người này có được thấy nút nối thẳng Facebook THẬT không. */
export function directConnectAllowed(input: { operator: boolean; open: DirectConnectOpen; orgCode: string | null | undefined }): boolean {
  if (input.operator) return true;
  if (input.open === true) return true;
  if (Array.isArray(input.open) && input.orgCode) return input.open.includes(input.orgCode);
  return false;
}

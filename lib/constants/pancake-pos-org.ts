/**
 * ═══════════ PANCAKE POS CỦA TỔ CHỨC KHÁCH — HẰNG SỐ VÀ HÀM THUẦN (docs/verticals/fashion-cod.md · F1) ═══════════
 *
 * Kết nối «pancake-pos-org» (lib/connectors/registry.ts): API key + mã shop Pancake POS CỦA CHÍNH tổ chức. Tệp THUẦN, không
 * đọc CSDL, không đọc biến môi trường — dùng chung cho hàm kiểm tra kết nối (lib/connectors/testers.ts), client
 * (lib/integrations/pancake/client.ts) và lớp nối đồng bộ (lib/integrations/pancake/org.ts).
 *
 * Bật kết nối ⇒ Pancake là NGUỒN đơn / khách / sản phẩm của tổ chức (`orgHasSyncedSource`): ERP thôi tạo tay, chatbot ERP
 * thôi lên đơn — cùng luật «một lần mua không hai bản» của tổ chức nhà.
 */

export const PANCAKE_POS_ORG_CONNECTOR = "pancake-pos-org";

/**
 * Địa chỉ API Pancake POS cho kết nối của tổ chức — HẰNG SỐ trong mã: người dùng chỉ nhập khoá và mã shop, không nhập URL,
 * nên không có đường nào đưa khoá của họ đi chỗ khác. (`PANCAKE_BASE_URL` là cấu hình của tổ chức nhà, không dùng ở đây.)
 */
export const PANCAKE_POS_API = "https://pos.pages.fm/api/v1";

/** Khoá API Pancake POS: chữ, số, gạch — sai dạng ⇒ không gọi mạng. */
export const PANCAKE_POS_API_KEY_PATTERN = /^[A-Za-z0-9_-]{16,200}$/;

/** Mã shop Pancake POS: số. */
export const PANCAKE_POS_SHOP_ID_PATTERN = /^[0-9]{1,20}$/;

/** Lượt đồng bộ ĐẦU TIÊN (chưa có đơn Pancake nào trong ERP của tổ chức) kéo lùi bấy nhiêu ngày đơn. */
export const PANCAKE_POS_ORG_FIRST_RUN_DAYS = 30;
export const PANCAKE_POS_ORG_MAX_DAYS = 365;

/** Đường dẫn webhook của tổ chức (token «<mã tổ chức>.<chữ ký>» do máy chủ cấp — lib/platform/webhooks.ts). */
export function pancakeOrgWebhookPath(token: string): string {
  return `/api/webhooks/pancake-org/${token}`;
}

/** Che khoá trong mọi câu lỗi / thông báo. */
export function maskPancakeKey(text: string, apiKey: string): string {
  return apiKey && apiKey.length >= 8 ? text.split(apiKey).join("***") : text;
}

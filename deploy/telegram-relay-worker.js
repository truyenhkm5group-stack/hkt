/**
 * RELAY TELEGRAM CHO ERP — Cloudflare Worker (01/10/2026).
 *
 * Vì sao: máy chủ ERP ở Việt Nam bị nhà mạng chặn api.telegram.org từng lúc (ETIMEDOUT), nên tin «đơn mới» của tổ chức
 * khách không tới nhóm Telegram. Worker này chạy trên mạng Cloudflare (ngoài Việt Nam) và CHỈ chuyển tiếp ba lời gọi Bot API
 * mà ERP dùng: getMe · getUpdates · sendMessage. Không lưu, không ghi log nội dung, không nhận đường dẫn nào khác.
 *
 * Cài (chủ nền tảng, ~5 phút, gói miễn phí đủ dùng):
 *   1. dash.cloudflare.com → Workers & Pages → Create → Worker «erp-telegram-relay» → Edit code → dán tệp này → Deploy.
 *   2. (Nên) Settings → Domains & Routes → Custom domain, vd `tg.vnxcommerce.com` (workers.dev cũng được).
 *   3. GitHub → Settings → Secrets and variables → Actions → Variables → `TELEGRAM_API_BASE` = `https://tg.vnxcommerce.com`.
 *   4. Chạy workflow «Deploy ERP to VPS». Kiểm: Cài đặt → Kết nối → Telegram → Kiểm tra.
 * Gỡ: xoá Variable rồi deploy lại — ERP đi thẳng api.telegram.org như cũ.
 */
const ALLOWED = /^\/bot\d{5,16}:[A-Za-z0-9_-]{30,64}\/(getMe|getUpdates|sendMessage)$/;

const relay = {
  async fetch(request) {
    const url = new URL(request.url);
    if (!ALLOWED.test(url.pathname) || !["GET", "POST"].includes(request.method)) return new Response("not found", { status: 404 });
    const init = { method: request.method, headers: { "content-type": request.headers.get("content-type") || "application/json" }, redirect: "manual" };
    if (request.method === "POST") init.body = await request.text();
    const res = await fetch(`https://api.telegram.org${url.pathname}${url.search}`, init);
    return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") || "application/json" } });
  },
};

export default relay;

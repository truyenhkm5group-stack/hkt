/**
 * ═══════════ Ô CHAT NHÚNG WEBSITE CỦA SHOP (docs/platform/quick-start.md §9) ═══════════
 *
 * Shop dán MỘT dòng vào website của mình:
 *
 *   <script src="https://<slug>.<miền ERP>/chat/widget.js" async></script>
 *
 * Tệp script tự đọc địa chỉ của chính nó (`document.currentScript.src`) để biết ERP của shop nào — không có mã tổ chức nào do
 * website gửi lên, và trang trong khung (`/chat/embed`) lấy tổ chức từ HOST như trang `/chat` (chỉ tổ chức ĐÃ XUẤT BẢN, bot
 * đang bật). Script chỉ vẽ một nút tròn + một khung iframe; mọi lượt chat đi qua đúng đường của trang chat công khai.
 *
 * Tuỳ chọn trên thẻ script (đọc ở trình duyệt, kiểm chặt — giá trị lạ ⇒ mặc định):
 *   data-color="#2563eb"   màu nút (chỉ mã hex)
 *   data-position="left"   nút ở góc trái (mặc định góc phải)
 *   data-label="Chat với shop"   chữ gợi ý cạnh nút (tối đa 40 ký tự, chỉ hiện dạng chữ — textContent, không HTML)
 */

export const WIDGET_SCRIPT_PATH = "/chat/widget.js";
export const WIDGET_EMBED_PATH = "/chat/embed";

/** Thẻ script shop dán vào website. `publicOrigin` = gốc tên miền con đã xuất bản (vd `https://hslc.erp.vnxcommerce.com`). */
export function widgetSnippet(publicOrigin: string): string {
  return `<script src="${publicOrigin.replace(/\/+$/, "")}${WIDGET_SCRIPT_PATH}" async></script>`;
}

/**
 * Nội dung `widget.js`. Không phụ thuộc tổ chức (cùng một tệp cho mọi shop — đệm được), không gọi API nào, không đặt cookie
 * trên website của shop. Chạy hai lần trên cùng trang ⇒ lần sau không làm gì.
 */
export function widgetScript(): string {
  return `(function () {
  "use strict";
  if (window.__vnxChatWidget) return;
  window.__vnxChatWidget = true;
  var me = document.currentScript;
  if (!me || !me.src) return;
  var origin;
  try { origin = new URL(me.src).origin; } catch (e) { return; }
  var color = /^#[0-9a-fA-F]{3,8}$/.test(me.getAttribute("data-color") || "") ? me.getAttribute("data-color") : "#2563eb";
  var left = me.getAttribute("data-position") === "left";
  var label = (me.getAttribute("data-label") || "").slice(0, 40);
  var side = left ? "left" : "right";

  var root = document.createElement("div");
  root.setAttribute("data-vnx-chat", "");
  root.style.cssText = "position:fixed;bottom:16px;" + side + ":16px;z-index:2147483000;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;";

  var panel = document.createElement("div");
  panel.style.cssText = "display:none;position:absolute;bottom:72px;" + side + ":0;width:min(380px,calc(100vw - 32px));height:min(600px,calc(100vh - 104px));border-radius:16px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.25);background:#fff;";
  var frame = null;

  var btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("aria-label", label || "Chat với shop");
  btn.setAttribute("aria-expanded", "false");
  btn.style.cssText = "width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;background:" + color + ";color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;";
  var ICON_CHAT = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var ICON_CLOSE = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  btn.innerHTML = ICON_CHAT;

  var tip = null;
  if (label) {
    tip = document.createElement("div");
    tip.textContent = label;
    tip.style.cssText = "position:absolute;bottom:14px;" + side + ":68px;white-space:nowrap;background:#fff;color:#111;padding:6px 10px;border-radius:10px;font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.15);";
  }

  function setOpen(open) {
    if (open && !frame) {
      frame = document.createElement("iframe");
      frame.src = origin + "${WIDGET_EMBED_PATH}";
      frame.title = label || "Chat với shop";
      frame.setAttribute("allow", "clipboard-write");
      frame.style.cssText = "width:100%;height:100%;border:0;display:block;";
      panel.appendChild(frame);
    }
    panel.style.display = open ? "block" : "none";
    btn.innerHTML = open ? ICON_CLOSE : ICON_CHAT;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (tip) tip.style.display = open ? "none" : "block";
  }

  btn.addEventListener("click", function () { setOpen(panel.style.display === "none"); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && panel.style.display !== "none") setOpen(false); });

  root.appendChild(panel);
  if (tip) root.appendChild(tip);
  root.appendChild(btn);
  (document.body || document.documentElement).appendChild(root);
})();
`;
}

/** Tệp cho host không có chat (tổ chức chưa xuất bản / bot tắt): không vẽ gì, không gây lỗi trên website của shop. */
export function widgetDisabledScript(reason: string): string {
  return `/* VNXcommerce chat: ${reason.replace(/\*\//g, "")} */\n`;
}

/*
 * Gửi một lần chụp về ERP. Chỉ chạy khi content.js chuyển một cú bấm của người dùng tới. Đọc địa chỉ ERP + token từ
 * chrome.storage.local (không dùng bộ nhớ đồng bộ của Chrome — token không đi theo tài khoản Google sang máy khác). Không đọc cookie nào, không gửi
 * cookie nào: `credentials: "omit"`.
 */
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "vnx-sourcing:capture") return false;
  if (!sender.tab || !/^https:\/\/detail\.1688\.com\/offer\//.test(sender.tab.url || "")) {
    sendResponse({ ok: false, error: "Chỉ gửi được từ trang chi tiết detail.1688.com." });
    return false;
  }
  (async () => {
    const { erpBase, token } = await chrome.storage.local.get(["erpBase", "token"]);
    if (!erpBase || !token) {
      sendResponse({ ok: false, error: "Chưa cài đặt địa chỉ ERP / token — bấm biểu tượng tiện ích ⇒ Cài đặt." });
      return;
    }
    const origin = new URL(erpBase).origin;
    if (!(await chrome.permissions.contains({ origins: [origin + "/*"] }))) {
      sendResponse({ ok: false, error: "Chưa cho phép tiện ích gửi tới " + origin + " — mở Cài đặt, bấm «Lưu» lại và chọn «Cho phép»." });
      return;
    }
    try {
      const r = await fetch(origin + "/api/sourcing/capture", {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ offerId: msg.offerId, pageUrl: msg.pageUrl, picks: msg.picks }),
      });
      let body = null;
      try {
        body = await r.json();
      } catch {
        body = null;
      }
      if (!r.ok || !body || !body.ok) {
        sendResponse({ ok: false, error: (body && body.error) || "ERP trả lỗi HTTP " + r.status + "." });
        return;
      }
      sendResponse({ ...body, offerUrl: body.offerPath ? origin + body.offerPath : null });
    } catch (e) {
      sendResponse({ ok: false, error: "Không kết nối được ERP (" + origin + "): " + (e && e.message ? e.message : String(e)) });
    }
  })();
  return true;
});

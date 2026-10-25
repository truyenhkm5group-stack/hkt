/*
 * Cài đặt: địa chỉ ERP + token. Bấm «Lưu» ⇒ Chrome hỏi quyền gửi tới ĐÚNG địa chỉ ERP đó (quyền tuỳ chọn, xin theo từng địa chỉ —
 * tiện ích không có sẵn quyền gửi đi đâu cả). Token lưu ở chrome.storage.local của máy này.
 */
const $ = (id) => document.getElementById(id);
const TOKEN_RE = /^vnxs1\.[a-z0-9][a-z0-9-]{0,62}\.[A-Za-z0-9_-]{43}$/;

function say(text, ok) {
  $("msg").textContent = text;
  $("msg").style.color = ok ? "#16a34a" : "#e4393c";
}

chrome.storage.local.get(["erpBase", "token"]).then(({ erpBase, token }) => {
  if (erpBase) $("erpBase").value = erpBase;
  if (token) $("token").value = token;
});

$("save").addEventListener("click", async () => {
  let origin;
  try {
    const u = new URL($("erpBase").value.trim());
    if (u.protocol !== "https:" && u.hostname !== "localhost") throw new Error("ERP phải là https://");
    origin = u.origin;
  } catch (e) {
    say("Địa chỉ ERP không hợp lệ: " + (e && e.message ? e.message : e), false);
    return;
  }
  const token = $("token").value.trim();
  if (!TOKEN_RE.test(token)) {
    say("Token không đúng dạng — chép lại nguyên token từ ERP (bắt đầu bằng «vnxs1.»).", false);
    return;
  }
  const granted = await chrome.permissions.request({ origins: [origin + "/*"] });
  if (!granted) {
    say("Chưa cho phép gửi tới " + origin + " — bấm «Lưu» lại và chọn «Cho phép».", false);
    return;
  }
  await chrome.storage.local.set({ erpBase: origin, token });
  say("Đã lưu. Mở một trang detail.1688.com/offer/… và bấm «Lưu mẫu vào ERP».", true);
});

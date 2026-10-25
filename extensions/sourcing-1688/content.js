/*
 * Nút «Lưu mẫu vào ERP» trên detail.1688.com/offer/*. Chỉ chạy khi NGƯỜI bấm: không tự quét trang, không mở trang khác, không
 * lặp, không vượt CAPTCHA. Không đọc chữ hiển thị trên trang — dữ liệu lấy từ main-world.js (window.context, danh sách cho phép).
 * Không đọc / gửi cookie: việc gửi do background.js làm bằng token ERP của người dùng.
 */
(() => {
  if (document.getElementById("vnx-sourcing-save")) return;
  const offerId = (location.pathname.match(/^\/offer\/(\d{6,20})\.html/) || [])[1];
  if (!offerId) return;

  const box = document.createElement("div");
  box.id = "vnx-sourcing-save";
  box.style.cssText =
    "position:fixed;right:20px;bottom:20px;z-index:2147483647;font:14px/1.4 system-ui,sans-serif;display:flex;flex-direction:column;align-items:flex-end;gap:8px;max-width:360px";
  const status = document.createElement("div");
  status.style.cssText = "display:none;background:#fff;color:#111;border:1px solid #ddd;border-radius:8px;padding:10px 12px;box-shadow:0 4px 16px rgba(0,0,0,.15)";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Lưu mẫu vào ERP";
  btn.style.cssText = "background:#e4393c;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-weight:600;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.2)";
  box.append(status, btn);
  document.documentElement.append(box);

  function show(lines, kind) {
    status.style.display = "block";
    status.style.borderColor = kind === "error" ? "#e4393c" : kind === "ok" ? "#16a34a" : "#ddd";
    status.replaceChildren();
    for (const l of lines) {
      const row = document.createElement("div");
      if (l.href) {
        const a = document.createElement("a");
        a.href = l.href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = l.text;
        a.style.color = "#2563eb";
        row.append(a);
      } else {
        row.textContent = l.text;
        if (l.muted) row.style.color = "#666";
      }
      status.append(row);
    }
  }

  function readPageData() {
    return new Promise((resolve) => {
      const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
      const timer = setTimeout(() => {
        window.removeEventListener("vnx-sourcing:response", onRes);
        resolve(null);
      }, 3000);
      function onRes(ev) {
        let d = null;
        try {
          d = JSON.parse(ev.detail);
        } catch {
          return;
        }
        if (!d || d.nonce !== nonce) return;
        clearTimeout(timer);
        window.removeEventListener("vnx-sourcing:response", onRes);
        resolve(d);
      }
      window.addEventListener("vnx-sourcing:response", onRes);
      window.dispatchEvent(new CustomEvent("vnx-sourcing:request", { detail: { nonce } }));
    });
  }

  let busy = false;
  btn.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    btn.style.opacity = "0.6";
    show([{ text: "Đang đọc dữ liệu trang…" }]);
    try {
      const data = await readPageData();
      if (!data || !data.found) {
        show([{ text: "Không đọc được dữ liệu gốc của trang (window.context) — tải lại trang rồi bấm lại. Tiện ích không lấy chữ hiển thị thay thế." }], "error");
        return;
      }
      show([{ text: "Đang gửi về ERP…" }]);
      const res = await chrome.runtime.sendMessage({ type: "vnx-sourcing:capture", offerId, pageUrl: location.origin + location.pathname, picks: data.picks });
      if (!res || !res.ok) {
        show([{ text: (res && res.error) || "Không gửi được về ERP." }], "error");
        return;
      }
      const lines = [{ text: res.message || "Đã lưu." }];
      if (!res.hasPrice) lines.push({ text: "Chưa có giá chi tiết — giá về Việt Nam CHƯA BIẾT.", muted: true });
      for (const f of res.flags || []) lines.push({ text: "• " + f.label, muted: true });
      if (res.offerUrl) lines.push({ text: "Mở mẫu trong ERP", href: res.offerUrl });
      show(lines, "ok");
    } catch (e) {
      show([{ text: "Lỗi tiện ích: " + (e && e.message ? e.message : String(e)) }], "error");
    } finally {
      busy = false;
      btn.disabled = false;
      btn.style.opacity = "1";
    }
  });
})();

/*
 * Service worker của VNXcommerce ERP (docs/platform/pwa.md): CHỈ nhận thông báo đẩy và mở đúng trang khi bấm.
 * Cố ý KHÔNG chặn `fetch` / không lưu đệm: ERP là dữ liệu sống, một trang cũ trong đệm là một con số sai.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "VNXcommerce ERP";
  const options = {
    body: data.body || "",
    icon: "/brand/vnx/icon-192.png",
    badge: "/brand/vnx/icon-192.png",
    data: { href: typeof data.href === "string" && data.href.startsWith("/") ? data.href : "/" },
    lang: "vi",
  };
  if (data.tag) options.tag = data.tag;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const href = (event.notification.data && event.notification.data.href) || "/";
  const target = new URL(href, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin && "focus" in w) {
          await w.focus();
          if ("navigate" in w) await w.navigate(target);
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});

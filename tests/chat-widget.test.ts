/**
 * Ô CHAT NHÚNG WEBSITE (lib/sales-chatbot/widget.ts) — không gọi mạng, không trình duyệt thật: script chạy trong `vm` với DOM
 * GIẢ tối thiểu.
 *
 *  1. Mã nhúng đúng một thẻ script trỏ về tên miền con của shop.
 *  2. Script: khung trỏ ĐÚNG `<gốc của chính script>/chat/embed` (không nhận địa chỉ nào từ website); màu chỉ nhận mã hex
 *     (giá trị lạ ⇒ mặc định, không chèn được CSS); chữ cạnh nút đi qua `textContent` (không HTML); chạy hai lần ⇒ một nút;
 *     iframe chỉ tạo khi khách bấm mở.
 *  3. Caddy: CHỈ `/chat/embed` của tên miền con được nằm trong khung trang khác; mọi đường khác giữ SAMEORIGIN.
 *  4. Middleware mở đúng hai đường mới theo khớp ĐÚNG TỪNG CHỮ; cookie khách chat dùng được trong khung (none + partitioned).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { WIDGET_EMBED_PATH, WIDGET_SCRIPT_PATH, widgetDisabledScript, widgetScript, widgetSnippet } from "@/lib/sales-chatbot/widget";

type FakeEl = {
  tag: string;
  style: { cssText: string; display?: string };
  attrs: Record<string, string>;
  children: FakeEl[];
  innerHTML: string;
  textContent: string;
  src?: string;
  title?: string;
  type?: string;
  listeners: Record<string, (e?: unknown) => void>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  appendChild(c: FakeEl): void;
  addEventListener(t: string, f: (e?: unknown) => void): void;
};

function el(tag: string): FakeEl {
  const e: FakeEl = {
    tag,
    style: { cssText: "" },
    attrs: {},
    children: [],
    innerHTML: "",
    textContent: "",
    listeners: {},
    setAttribute(k, v) {
      e.attrs[k] = v;
    },
    getAttribute(k) {
      return e.attrs[k] ?? null;
    },
    appendChild(c) {
      e.children.push(c);
    },
    addEventListener(t, f) {
      e.listeners[t] = f;
    },
  };
  // `style.display = "x"` cũng phải đọc lại được qua cssText ban đầu ⇒ mô phỏng: cssText chứa display:none.
  Object.defineProperty(e.style, "display", {
    get() {
      return /display:none/.test(e.style.cssText) ? "none" : "block";
    },
    set(v: string) {
      e.style.cssText = e.style.cssText.replace(/display:[a-z]+;?/, "") + `display:${v};`;
    },
  });
  return e;
}

function run(attrs: Record<string, string>, times = 1) {
  const body = el("body");
  const docListeners: Record<string, (e: unknown) => void> = {};
  const me = el("script");
  me.src = "https://hslc.erp.vnxcommerce.com/chat/widget.js";
  Object.assign(me.attrs, attrs);
  const win: Record<string, unknown> = {};
  const ctx = vm.createContext({
    window: win,
    URL,
    document: { currentScript: me, body, documentElement: body, createElement: (t: string) => el(t), addEventListener: (t: string, f: (e: unknown) => void) => (docListeners[t] = f) },
  });
  for (let i = 0; i < times; i++) vm.runInContext(widgetScript(), ctx);
  return { body, docListeners };
}

const find = (root: FakeEl, tag: string): FakeEl[] => [...(root.tag === tag ? [root] : []), ...root.children.flatMap((c) => find(c, tag))];

export function testChatWidget() {
  // 1. Mã nhúng
  assert.equal(widgetSnippet("https://hslc.erp.vnxcommerce.com/"), '<script src="https://hslc.erp.vnxcommerce.com/chat/widget.js" async></script>');
  assert.equal(WIDGET_SCRIPT_PATH, "/chat/widget.js");
  assert.ok(widgetDisabledScript("bot tắt */ alert(1) /*").startsWith("/*") && !widgetDisabledScript("x */ y").includes("x */"), "script rỗng không bị phá chú thích");

  // 2. Script trong DOM giả
  const { body, docListeners } = run({ "data-color": "red;background:url(javascript:alert(1))", "data-label": "<img src=x onerror=alert(1)>Hỏi giá" }, 2);
  assert.equal(body.children.length, 1, "chạy hai lần ⇒ một nút");
  const root = body.children[0];
  const btn = find(root, "button")[0];
  assert.ok(btn.style.cssText.includes("background:#2563eb"), "màu lạ ⇒ mặc định, không chèn được CSS");
  const tip = root.children.find((c) => c.tag === "div" && c.textContent);
  assert.ok(tip && tip.textContent.startsWith("<img") && tip.innerHTML === "", "chữ cạnh nút là textContent, không HTML");
  assert.equal(find(root, "iframe").length, 0, "chưa bấm ⇒ chưa tải khung");
  btn.listeners.click();
  const frame = find(root, "iframe")[0];
  assert.equal(frame?.src, `https://hslc.erp.vnxcommerce.com${WIDGET_EMBED_PATH}`, "khung trỏ ĐÚNG gốc của chính script");
  assert.equal(btn.attrs["aria-expanded"], "true");
  docListeners.keydown({ key: "Escape" });
  assert.equal(btn.attrs["aria-expanded"], "false", "Esc đóng khung");
  btn.listeners.click();
  assert.equal(find(root, "iframe").length, 1, "mở lại không tạo khung thứ hai (giữ hội thoại)");
  const ok = run({ "data-color": "#e11d48", "data-position": "left" });
  const btn2 = find(ok.body.children[0], "button")[0];
  assert.ok(btn2.style.cssText.includes("background:#e11d48") && ok.body.children[0].style.cssText.includes("left:16px"), "màu hex + góc trái nhận được");
  assert.ok(!/cookie|localStorage|fetch\(|XMLHttpRequest/.test(widgetScript()), "script không đặt cookie / không gọi API trên website của shop");

  // 3. Caddy: chỉ /chat/embed được nằm trong khung
  const caddy = readFileSync("deploy/Caddyfile", "utf8");
  const tenant = caddy.slice(caddy.indexOf("*.{$ERP_DOMAIN} {"), caddy.indexOf("{$SITE_DOMAIN:"));
  assert.match(tenant, /@chatEmbed path \/chat\/embed\n\s*header @chatEmbed Content-Security-Policy "frame-ancestors \*"/, "khung chỉ cho đúng /chat/embed");
  assert.match(tenant, /@notChatEmbed not path \/chat\/embed\n\s*header @notChatEmbed X-Frame-Options SAMEORIGIN/, "mọi đường khác của tên miền con giữ SAMEORIGIN");
  assert.equal((caddy.match(/frame-ancestors/g) ?? []).length, 1, "không khối nào khác mở khung");
  const others = caddy.replace(tenant, "");
  assert.ok((others.match(/X-Frame-Options SAMEORIGIN/g) ?? []).length >= 2, "miền ERP chính + trang giới thiệu giữ nguyên SAMEORIGIN");

  // 4. Middleware + cookie
  const mw = readFileSync("middleware.ts", "utf8");
  assert.match(mw, /const PUBLIC_EXACT = \["\/chat", WIDGET_EMBED_PATH, WIDGET_SCRIPT_PATH,/, "hai đường mới mở theo khớp ĐÚNG TỪNG CHỮ, không theo tiền tố");
  const action = readFileSync("lib/actions/public-chat.ts", "utf8");
  assert.match(action, /sameSite: prod \? "none" : "lax", secure: prod, partitioned: prod/, "cookie khách chat dùng được trong khung bên thứ ba, khoá theo website nhúng");
  console.log("✓ Ô chat nhúng website: một dòng script, khung trỏ đúng tên miền con của shop, màu / chữ không chèn được mã, chạy hai lần một nút, Caddy chỉ mở khung cho /chat/embed, cookie khách dùng được trong khung (partitioned)");
}

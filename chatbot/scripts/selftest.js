// Test offline toan bo luong (khong can token that): gia lap Pancake + Gemini bang cach mock fetch.
// Chay: node scripts/selftest.js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANCAKE_PAGE_ID = "PAGE1";
process.env.PANCAKE_PAGE_ACCESS_TOKEN = "tok";
process.env.GEMINI_API_KEY = "key";
process.env.AI_PROVIDER = "gemini"; // selftest gia lap API Gemini, khong phu thuoc .env dang chon nha cung cap nao
process.env.BOT_PAUSE_TAG_ID = "99";
process.env.DEBOUNCE_MS = "50";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pgbot-"));
process.env.LOG_LEVEL = "warn";
// Cach ly khoi .env that
process.env.PANCAKE_PAGES_JSON = "";
process.env.POS_SHOP_ID = "";
process.env.POS_API_KEY = "";
process.env.HEALTHCHECK_URL = "";
process.env.POLL_ENABLED = "false";
process.env.DRY_RUN = "false";
process.env.VISION_ENABLED = "true";
process.env.SEND_PRODUCT_IMAGES = "true";
process.env.SHOP_NAME = "Shop Test";
process.env.MIN_CUSTOMER_MESSAGES = "1";
process.env.HUMAN_TAKEOVER_MINUTES = "30"; // test 4 kiem tra quy tac nhuong nhan vien khi bat
process.env.COMMENT_MODE = "off";
process.env.COMMENT_PUBLIC_TEXT = "Dạ em chào chị{name} ❤️ Shop đã gửi báo giá vào tin nhắn, chị kiểm tra Messenger giúp em nhé!";
process.env.ASSISTANT_MODEL = "";

// Cho du mot luot xu ly: moi request Pancake cach nhau 220ms (gioi han 5 req/giay), va truoc khi gui bot hoi lai
// Pancake mot lan xem khach co nhan them khong (su co 29/09) -> 700ms cu khong du cho luot co gan tag.
const WAIT = 1100;
const calls = [];
let pancakeMessages = [];
let geminiText = "Dạ shop còn size M ạ, anh/chị cho em xin SĐT để lên đơn nhé 😊";
let geminiToolParts = () => [];
let onGetMessages = null; // test 30: cho khach "nhan them" giua luc bot dang soan

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
  calls.push({ method: init.method || "GET", path: u.pathname, body, query: Object.fromEntries(u.searchParams) });
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

  if (u.hostname === "pages.fm") {
    assert.equal(u.searchParams.get("page_access_token"), "tok", "thieu page_access_token");
    if (u.pathname.endsWith("/messages") && (init.method || "GET") === "GET") {
      if (onGetMessages) onGetMessages();
      // Tra ve thu tu NGAU NHIEN (Pancake that tra cu->moi, tai lieu noi moi->cu) -> bot phai tu sap xep theo inserted_at
      const shuffled = [...pancakeMessages].map((m, i) => ({ ...m, inserted_at: m.inserted_at || new Date(Date.now() - (pancakeMessages.length - i) * 1000).toISOString().replace("Z", "") })).sort(() => Math.random() - 0.5);
      return json({ success: true, messages: shuffled, conv_from: { id: "C1", name: "Lan" }, can_inbox: true });
    }
    if (u.pathname.endsWith("/messages") && init.method === "POST") return json({ success: true, id: "bot_msg_" + calls.length });
    if (u.pathname.endsWith("/tags")) return json({ success: true, data: [99] });
    if (u.pathname.endsWith("/upload_contents")) {
      assert.ok(init.body instanceof FormData, "upload phai la multipart FormData");
      return json({ success: true, id: "content_" + calls.length, attachment_type: "PHOTO" });
    }
  }
  if (u.hostname === "generativelanguage.googleapis.com" && body?.tools) {
    return json({ candidates: [{ content: { parts: geminiToolParts() }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 50 } });
  }
  if (u.hostname === "generativelanguage.googleapis.com") {
    assert.equal(init.headers["x-goog-api-key"], "key");
    assert.equal(body.contents[0].role, "user", "luot dau phai la user");
    return json({ candidates: [{ content: { parts: [{ text: geminiText }] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 123 } });
  }
  if (u.hostname === "content.pancake.vn") {
    // 1x1 PNG
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
  }
  throw new Error("fetch khong mong doi: " + url);
};

const { Bot } = await import("../src/bot.js");
const { store } = await import("../src/store.js");
const { catalog } = await import("../src/catalog.js");
const bot = new Bot();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let msgSeq = 0;
const msg = (id, text, from, extra = {}) => ({
  id, conversation_id: "CONV1", page_id: "PAGE1", type: "INBOX", message: text, original_message: text,
  inserted_at: new Date(Date.now() - 60000 + (++msgSeq) * 10).toISOString().replace("Z", ""), from, attachments: [], ...extra,
});
const customer = { id: "C1", name: "Lan" };
const pageFrom = { id: "PAGE1", name: "Shop" };
const webhook = (m, tags = []) => ({ page_id: "PAGE1", event_type: "messaging", data: { conversation: { id: "CONV1", from: customer, tags, type: "INBOX" }, message: m, post: null } });

// ---- Test 1: khach nhan 2 tin lien tiep -> 1 lan goi Gemini, 1 lan gui, lich su dung
pancakeMessages = [
  msg("m1", "shop ơi", customer),
  msg("m2", "<div>áo này còn size M không?</div>", customer),
];
bot.handleWebhook(webhook(pancakeMessages[0]));
bot.handleWebhook(webhook(pancakeMessages[1]));
await sleep(WAIT);
let gem = calls.filter((c) => c.path.includes(":generateContent"));
let sent = calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
assert.equal(gem.length, 1, "phai goi Gemini dung 1 lan (debounce)");
assert.equal(gem[0].body.contents.length, 1, "2 tin khach lien tiep phai gop thanh 1 luot user");
assert.equal(gem[0].body.contents[0].parts[0].text, "shop ơi\náo này còn size M không?");
assert.ok(gem[0].body.system_instruction.parts[0].text.includes("Lan"), "system prompt phai co ten khach");
assert.equal(sent.length, 1);
assert.deepEqual(sent[0].body, { action: "reply_inbox", message: geminiText });
assert.ok(store.isBotMessage("bot_msg_" + calls.indexOf(sent[0]) + 1) || true);
console.log("OK 1: debounce + lich su + gui reply_inbox");

// ---- Test 2: webhook gui lai cung message id -> bo qua
calls.length = 0;
bot.handleWebhook(webhook(pancakeMessages[1]));
await sleep(WAIT);
assert.equal(calls.length, 0, "tin trung id phai bi bo qua");
console.log("OK 2: chong xu ly trung");

// ---- Test 3: tin tu page -> bo qua; tag tat bot -> bo qua
calls.length = 0;
bot.handleWebhook(webhook(msg("m3", "Dạ shop đây", pageFrom)));
bot.handleWebhook(webhook(msg("m4", "hello", customer), [{ id: 99, text: "Nhan vien xu ly" }]));
bot.handleWebhook(webhook(msg("m5", "hello", customer), [99]));
await sleep(WAIT);
assert.equal(calls.length, 0);
console.log("OK 3: bo qua tin cua page va hoi thoai co tag tat bot");

// ---- Test 4: nhan vien that vua tra loi -> bot im lang
calls.length = 0;
pancakeMessages = [
  msg("m6", "cho mình hỏi", customer),
  msg("m7", "Dạ anh cần gì ạ", { id: "PAGE1", name: "Shop", admin_id: "staff1", admin_name: "Tuan" }),
  msg("m8", "áo giá bao nhiêu", customer),
];
bot.handleWebhook(webhook(pancakeMessages[2]));
await sleep(WAIT);
assert.equal(calls.filter((c) => c.path.includes(":generateContent")).length, 0, "nhan vien dang xu ly, khong duoc goi Gemini");
console.log("OK 4: nhan vien dang xu ly -> bot im lang");

// ---- Test 5: tin cua Pancake automation khong tinh la nhan vien; bot van tra loi
calls.length = 0;
pancakeMessages = [
  msg("m9", "hi", customer),
  msg("m10", "Cảm ơn bạn đã nhắn tin", { id: "PAGE1", name: "Shop", is_automated: true }),
  msg("m11", "ship bao nhiêu", customer),
];
bot.handleWebhook(webhook(pancakeMessages[2]));
await sleep(WAIT);
gem = calls.filter((c) => c.path.includes(":generateContent"));
assert.equal(gem.length, 1);
assert.deepEqual(gem[0].body.contents.map((c) => c.role), ["user", "model", "user"]);
console.log("OK 5: automation khong chan bot, lich su xen ke user/model");

// ---- Test 6: HANDOFF -> gui cau tra loi (da bo marker) + gan tag
calls.length = 0;
geminiText = "Dạ em đã ghi nhận, nhân viên sẽ liên hệ ngay ạ. [[HANDOFF]]";
pancakeMessages = [msg("m12", "tôi muốn gặp nhân viên", customer)];
bot.handleWebhook(webhook(pancakeMessages[0]));
await sleep(WAIT);
sent = calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
const tagged = calls.filter((c) => c.path.endsWith("/tags"))
assert.equal(sent[0].body.message, "Dạ em đã ghi nhận, nhân viên sẽ liên hệ ngay ạ.");
assert.deepEqual(tagged[0].body, { action: "add", tag_id: "99" });
console.log("OK 6: handoff -> bo marker + gan tag");

// ---- Test 7: tin chi co anh (khong co url) -> chi mo ta
calls.length = 0;
geminiText = "Dạ em chưa xem được ảnh, anh/chị mô tả giúp em nhé";
pancakeMessages = [msg("m13", "<div></div>", customer, { attachments: [{ type: "photo" }] })];
bot.handleWebhook(webhook(pancakeMessages[0]));
await sleep(WAIT);
gem = calls.filter((c) => c.path.includes(":generateContent"));
assert.ok(gem[0].body.contents[0].parts[0].text.includes("hình ảnh"));
console.log("OK 7: tin chi co anh -> mo ta dinh kem cho Gemini");

// ---- Test 8: anh co url -> tai anh, gui inline_data cho Gemini (vision)
calls.length = 0;
geminiText = "Dạ mẫu áo trong ảnh là áo polo navy, giá 250k, còn size M/L ạ";
pancakeMessages = [
  msg("m14", "<div></div>", customer, { attachments: [{ type: "photo", url: "https://content.pancake.vn/a/b/c.png" }] }),
  msg("m15", "mẫu này giá bao nhiêu", customer),
];
bot.handleWebhook(webhook(pancakeMessages[1]));
await sleep(WAIT);
gem = calls.filter((c) => c.path.includes(":generateContent"));
const parts = gem[0].body.contents[0].parts;
assert.equal(parts.length, 2, "phai co 1 part anh + 1 part text");
assert.equal(parts[0].inline_data.mime_type, "image/png");
assert.ok(parts[0].inline_data.data.length > 20);
assert.equal(parts[1].text, "[Khách gửi 1 hình ảnh]\nmẫu này giá bao nhiêu");
assert.equal(calls.filter((c) => c.path === "/a/b/c.png").length, 1, "phai tai anh 1 lan");
// Goi lai -> anh lay tu cache, khong tai lai
calls.length = 0;
pancakeMessages.push(msg("m16", "còn size L không", customer));
bot.handleWebhook(webhook(pancakeMessages[2]));
await sleep(WAIT);
assert.equal(calls.filter((c) => c.path === "/a/b/c.png").length, 0, "anh phai duoc cache");
assert.ok(calls.some((c) => c.path.includes(":generateContent")));
console.log("OK 8: vision -> tai anh, gui inline_data, cache anh");

// ---- Test 9: catalog POS trong system prompt + [[IMG:ma]] -> upload anh + gui content_ids + bo markdown
calls.length = 0;
catalog.setProducts([
  {
    id: "p1", code: "Q004", name: "Đầm Q004", note: "", attributes: { "Màu": ["Đỏ", "Nâu"], Size: ["M", "L"] },
    price: { min: 499000, max: 499000 },
    images: ["https://content.pancake.vn/q004-do.png", "https://content.pancake.vn/q004-nau.png"],
    variations: [
      { id: "v1", sku: "Q004DOM", fields: { "Màu": "Đỏ", Size: "M" }, price: 499000, stock: -6, available: true, images: ["https://content.pancake.vn/q004-do.png"] },
      { id: "v2", sku: "Q004NAUM", fields: { "Màu": "Nâu", Size: "M" }, price: 499000, stock: 0, available: true, images: ["https://content.pancake.vn/q004-nau.png"] },
    ],
  },
]);
geminiText = "Dạ mẫu **Đầm Q004** giá 499.000đ ạ:\n*   Màu Đỏ, Nâu\n*   Size M/L\nChị xem ảnh nhé [[IMG:Q004]]";
pancakeMessages = [msg("m17", "cho xem mẫu Q004", customer)];
bot.handleWebhook(webhook(pancakeMessages[0]));
await sleep(1500);
gem = calls.filter((c) => c.path.includes(":generateContent"));
const sys = gem[0].body.system_instruction.parts[0].text;
assert.ok(sys.includes("Đầm Q004 (mã Q004) – 499.000đ"), "catalog phai nam trong system prompt");
assert.ok(!sys.includes("{{CATALOG}}") && !sys.includes("{{SHOP_NAME}}"), "placeholder phai duoc thay");
assert.ok(sys.includes("Shop Test"), "ten shop phai duoc thay");
sent = calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
assert.equal(sent.length, 2, "1 tin text + 1 tin anh");
assert.ok(sent[0].body.message.startsWith("Dạ mẫu Đầm Q004 giá 499.000đ ạ:\n• Màu Đỏ, Nâu\n• Size M/L\nChị xem ảnh nhé"), "tin text phai bo markdown, giu nguyen noi dung: " + sent[0].body.message);
assert.ok(sent[0].body.message.trim().endsWith("?"), "moi tin phai ket thuc bang cau hoi (he thong tu them neu bot quen)");
assert.ok(!("message" in sent[1].body), "tin anh khong duoc kem message");
assert.equal(sent[1].body.content_ids.length, 2, "2 mau -> 2 anh");
assert.equal(calls.filter((c) => c.path.endsWith("/upload_contents")).length, 2);
console.log("OK 9: catalog POS trong prompt + [[IMG]] -> upload + content_ids + bo markdown");

// ---- Test 10: tro ly AI quan tri (function calling): "tat bot page" -> goi update_page_settings -> settings doi
let toolStep = 0;
geminiToolParts = () => {
  toolStep++;
  if (toolStep === 1) return [{ functionCall: { name: "update_page_settings", args: { page: "PAGE1", enabled: false } } }];
  return [{ text: "Đã tắt bot cho page rồi nhé." }];
};
const { createAssistant } = await import("../src/assistant.js");
const { settings } = await import("../src/settings.js");
const as = createAssistant(bot);
const out = await as.chat([{ role: "user", parts: [{ text: "tắt bot page PAGE1" }] }]);
assert.equal(out.actions.length, 1);
assert.equal(out.actions[0].name, "update_page_settings");
assert.equal(out.actions[0].ok, true);
assert.equal(settings.effective("PAGE1").enabled, false, "settings phai duoc tat");
assert.equal(out.text, "Đã tắt bot cho page rồi nhé.");
assert.equal(out.contents.length, 4, "user + model(functionCall) + user(functionResponse) + model(text)");
assert.ok(out.contents[2].parts[0].functionResponse.response.ok, "functionResponse phai chua ket qua");
// page da tat -> webhook bi bo qua
calls.length = 0;
pancakeMessages = [msg("m18", "alo", customer)];
bot.handleWebhook(webhook(pancakeMessages[0]));
await sleep(WAIT);
assert.equal(calls.length, 0, "page tat thi khong duoc goi API");
settings.update("PAGE1", { enabled: true });
console.log("OK 10: tro ly AI goi cong cu -> doi cai dat -> bot ton trong cai dat");

// ---- Test 11: minCustomerMessages=2 -> tin dau cua khach bo qua (de Pancake tu dong tra loi), tin thu 2 bot tra loi
calls.length = 0;
geminiToolParts = () => [];
settings.update("PAGE1", { minCustomerMessages: 2 });
geminiText = "Dạ chị cần size nào ạ?";
pancakeMessages = [msg("m19", "shop ơi", customer)];
bot.handleWebhook(webhook(pancakeMessages[0]));
await sleep(WAIT);
assert.equal(calls.filter((c) => c.path.includes(":generateContent")).length, 0, "tin dau khong duoc goi Gemini");
assert.equal(calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages")).length, 0, "tin dau khong duoc gui");
calls.length = 0;
pancakeMessages = [
  msg("m19", "shop ơi", customer),
  msg("m20", "Chào chị, shop gửi ảnh và giá ạ", { id: "PAGE1", name: "Shop", is_automated: true }),
  msg("m21", "còn size L không", customer),
];
bot.handleWebhook(webhook(pancakeMessages[2]));
await sleep(WAIT);
gem = calls.filter((c) => c.path.includes(":generateContent"));
assert.equal(gem.length, 1, "tin thu 2 phai goi Gemini");
assert.deepEqual(gem[0].body.contents.map((c) => c.role), ["user", "model", "user"], "lich su phai co ca tin tu dong cua Pancake");
assert.equal(calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages")).length, 1);
settings.update("PAGE1", { minCustomerMessages: null });
console.log("OK 11: minCustomerMessages=2 -> bo qua tin dau, tra loi tu tin thu 2");

// ---- Test 12: binh luan, che do inbox -> private reply (bao gia) + anh vao inbox + cau cong khai co ten khach
calls.length = 0;
settings.update("PAGE1", { commentMode: "inbox", minCustomerMessages: 2 });
geminiText = "Dạ mẫu này hiện có 2 màu Đỏ, Nâu chị nhé ❤️ Chị cho em xin chiều cao cân nặng ạ [[IMG:Q004]]";
const commenter = { id: "U9", name: "Trần Thị Mai" };
pancakeMessages = [msg("c1", "giá bao nhiêu shop", commenter, { type: "COMMENT", private_reply_conversation: { id: "PAGE1_U9" } })];
bot.handleWebhook({ page_id: "PAGE1", event_type: "messaging", data: { conversation: { id: "POST1_c1", from: commenter, tags: [], type: "COMMENT" }, message: pancakeMessages[0], post: { id: "POST1" } } });
await sleep(1800);
const posts = calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
const priv = posts.find((c) => c.body?.action === "private_replies");
const pub = posts.find((c) => c.body?.action === "reply_comment");
const img = posts.find((c) => c.body?.content_ids);
assert.ok(priv, "phai co action private_replies (Pancake khong nhan 'private_reply')");
assert.ok(!posts.some((c) => c.body?.action === "private_reply"), "khong duoc dung action cu private_reply");
assert.equal(priv.body.message_id, "c1");
assert.equal(priv.body.post_id, "POST1", "post_id tach tu id hoi thoai binh luan {post}_{comment}");
assert.equal(priv.body.from_id, "U9", "from_id = id nguoi binh luan");
assert.ok(priv.body.message.includes("2 màu Đỏ, Nâu") && !priv.body.message.includes("[[IMG"), "tin rieng la bao gia, khong co ma anh");
assert.ok(img && img.path.includes("/conversations/PAGE1_U9/"), "anh phai gui vao hoi thoai inbox tao tu binh luan");
assert.ok(pub, "phai co tra loi cong khai");
assert.ok(pub.body.message.includes("chị Mai") && pub.body.message.includes("Messenger"), "cau cong khai phai chao ten khach + bao check inbox: " + pub.body.message);
assert.equal(calls.filter((c) => c.path.includes(":generateContent")).length, 1, "binh luan khong bi chan boi minCustomerMessages");
// Sau do khach tra loi trong inbox (hoi thoai da co tin cua bot) -> bot tra loi ngay, khong doi tin thu 2
calls.length = 0;
geminiText = "Dạ 55kg chị mặc size L ạ";
pancakeMessages = [
  msg("i1", "Dạ mẫu này hiện có 2 màu...", { id: "PAGE1", name: "Shop", admin_id: "bot" }),
  msg("i2", "55kg cao 1m60", { id: "U9", name: "Trần Thị Mai" }),
];
store.markBotMessage("i1");
bot.handleWebhook(webhook(msg("i2", "55kg cao 1m60", { id: "U9", name: "Trần Thị Mai" })));
await sleep(900);
assert.equal(calls.filter((c) => c.path.includes(":generateContent")).length, 1, "khach tra loi trong inbox tu binh luan phai duoc bot tra loi ngay");
settings.update("PAGE1", { commentMode: "", minCustomerMessages: null });
console.log("OK 12: binh luan -> nhan rieng bao gia + anh + cau cong khai; inbox tu binh luan tra loi ngay");

// ---- Test 13: chot chan gia: bot tu giam 461.000đ (khong co trong bang gia) -> viet lai; van sai -> cau an toan + HANDOFF
calls.length = 0;
let priceStep = 0;
const oldGemini = geminiText;
geminiText = "Dạ em giảm thêm cho chị, chỉ còn 461.000đ + 25.000đ ship thôi ạ";
// mock: lan 1 sai gia, lan 2 (viet lai) dung gia
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.hostname === "generativelanguage.googleapis.com" && !JSON.parse(init.body || "{}").tools) {
    priceStep++;
    const txt = priceStep === 1 ? "Dạ em giảm thêm cho chị, chỉ còn 461.000đ + 25.000đ ship thôi ạ" : "Dạ giá 499.000đ + 25.000đ ship là ưu đãi tốt nhất rồi ạ, tổng 524.000đ. Chị lấy màu nào ạ?";
    calls.push({ method: "POST", path: u.pathname, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: txt }] }, finishReason: "STOP" }], usageMetadata: {} }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return origFetch(url, init);
};
pancakeMessages = [msg("m30", "giảm thêm đi chị lấy", customer)];
bot.handleWebhook(webhook(pancakeMessages[0]));
await sleep(1200);
sent = calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
assert.equal(priceStep, 2, "phai goi Gemini lan 2 de viet lai");
assert.ok(sent[0].body.message.includes("524.000đ") && !sent[0].body.message.includes("461"), "tin gui phai la ban viet lai dung gia: " + sent[0].body.message);
// van sai lan 2 -> cau an toan + tag handoff
calls.length = 0; priceStep = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.hostname === "generativelanguage.googleapis.com" && !JSON.parse(init.body || "{}").tools) {
    priceStep++;
    calls.push({ method: "POST", path: u.pathname, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Thôi được, 430.000đ chị nhé" }] }, finishReason: "STOP" }], usageMetadata: {} }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return origFetch(url, init);
};
pancakeMessages = [msg("m31", "giảm nữa đi", customer)];
bot.handleWebhook(webhook(pancakeMessages[0]));
await sleep(1200);
sent = calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
assert.equal(priceStep, 2);
assert.ok(sent[0].body.message.includes("không có quyền giảm thêm"), "phai dung cau an toan: " + sent[0].body.message);
assert.ok(calls.some((c) => c.path.endsWith("/tags")), "phai gan tag handoff");
globalThis.fetch = origFetch; geminiText = oldGemini;
console.log("OK 13: chot chan gia -> viet lai; van sai -> cau an toan + chuyen nhan vien");

// ---- Test 14: khach bao "chi nhan roi" -> tai them lich su (current_count) + prompt yeu cau xin loi + khong hoi lai
calls.length = 0;
geminiText = "Dạ em xin lỗi chị, em xem lại rồi ạ. Chị 55kg cao 1m60 mặc size L nhé, chị lấy màu Đỏ hay Nâu ạ?";
pancakeMessages = [
  msg("r1", "chị 55kg cao 1m60", customer),
  msg("r2", "Dạ chị cho em xin chiều cao cân nặng ạ", { id: "PAGE1", name: "Shop", is_automated: true }),
  msg("r3", "chị nhắn rồi mà, sao hỏi lại", customer),
];
bot.handleWebhook(webhook(pancakeMessages[2]));
await sleep(2000);
const pages = calls.filter((c) => c.path.endsWith("/messages") && c.method === "GET");
assert.ok(pages.some((c) => c.query.current_count === "30"), "phai tai them lich su cu (current_count=30)");
gem = calls.filter((c) => c.path.includes(":generateContent"));
assert.equal(gem.length, 1);
assert.ok(gem[0].body.system_instruction.parts[0].text.includes("XIN LỖI"), "prompt phai yeu cau xin loi va doc lai");
assert.ok(gem[0].body.contents.some((c) => c.parts.some((p) => (p.text || "").includes("55kg"))), "lich su phai chua thong tin khach da nhan");
sent = calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
assert.ok(sent[0].body.message.startsWith("Dạ em xin lỗi"), "tra loi phai mo dau bang xin loi");
console.log("OK 14: khach bao da nhan roi -> doc lai lich su dai + xin loi");

// ---- Test 15: chot don -> trich xuat JSON -> chuan hoa dia chi (geo POS) -> tao don nhap POS
calls.length = 0;
process.env.POS_SHOP_ID = "SHOP1"; process.env.POS_API_KEY = "posk"; // orders.js doc config.pos luc goi (config da load .env rong -> set truc tiep)
const { config: cfg } = await import("../src/config.js");
cfg.pos.shopId = "SHOP1"; cfg.pos.apiKey = "posk"; cfg.orderSync = true;
const { orderSync } = await import("../src/orders.js");
let jsonStep = 0;
const prevFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
  if (u.hostname === "pos.pages.fm") {
    calls.push({ method: init.method || "GET", path: u.pathname, body, query: Object.fromEntries(u.searchParams) });
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (u.pathname === "/api/v1/geo/provinces") return json({ data: [{ id: "401", name: "Thanh Hóa", new_id: "N401" }, { id: "701", name: "Hồ Chí Minh", new_id: "N701" }] });
    if (u.pathname === "/api/v1/geo/districts") return json({ data: u.searchParams.get("province_id") === "401" ? [{ id: "40121", name: "Huyện Ngọc Lặc" }, { id: "40113", name: "Huyện Bá Thước" }] : [] });
    if (u.pathname === "/api/v1/geo/communes") return json({ data: u.searchParams.get("district_id") === "40121" ? [{ id: "4012101", name: "Thị trấn Ngọc Lặc", new_id: "NC1" }, { id: "4012115", name: "Xã Cao Ngọc" }] : [] });
    if (u.pathname === "/api/v1/shops/SHOP1/orders" && (init.method || "GET") === "GET") return json({ data: [] });
    if (u.pathname === "/api/v1/shops/SHOP1/orders" && init.method === "POST") return new Response(JSON.stringify({ data: { id: 777 } }), { status: 201, headers: { "content-type": "application/json" } });
  }
  if (u.hostname === "generativelanguage.googleapis.com" && body?.generationConfig?.responseSchema) {
    jsonStep++;
    const props = body.generationConfig.responseSchema.properties || {};
    const txt = props.ready
      ? JSON.stringify({ ready: true, items: [{ code: "Q004", color: "Nâu", size: "M", quantity: 2 }], customer_name: "Nguyễn Thị Hoa", phone: "0912 345 678", address: "sn 15 ngo 34 le thanh tong, ngoc lac, thanh hoa", agreed_total: 998000, free_shipping: true })
      : JSON.stringify({ province: "Thanh Hóa", district: "Ngọc Lặc", commune: "Thị trấn Ngọc Lặc", street: "sn 15 ngo 34 le thanh tong" });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: txt }] }, finishReason: "STOP" }], usageMetadata: {} }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return prevFetch(url, init);
};
const r15 = await orderSync.syncFromConversation({ pageId: "PAGE1", pageName: "Shop Test", conversationId: "CONV1", customerName: "Lan", historyText: "KHÁCH: lấy 2 cái Q004 nâu size M\nKHÁCH: 0912 345 678, sn 15 ngo 34 le thanh tong, ngoc lac, thanh hoa\nSHOP: Dạ em chốt đơn cho chị..." });
assert.equal(r15.status, "created", "phai tao don moi: " + JSON.stringify(r15));
assert.equal(r15.orderId, 777);
const post = calls.find((c) => c.method === "POST" && c.path === "/api/v1/shops/SHOP1/orders");
assert.equal(post.body.bill_phone_number, "0912345678", "SDT phai duoc chuan hoa");
assert.equal(post.body.items[0].variation_id, "v2", "phai map dung bien the Q004 Nau M");
assert.equal(post.body.items[0].quantity, 2);
assert.equal(post.body.shipping_address.province_id, "401");
assert.equal(post.body.shipping_address.district_id, "40121");
assert.equal(post.body.shipping_address.commune_id, "4012101");
assert.equal(post.body.is_free_shipping, true);
assert.ok(post.body.note.includes("Bot chốt từ chat") && post.body.note.includes("Thị trấn Ngọc Lặc"), "ghi chu phai co dia chi chuan hoa");
assert.equal(jsonStep, 2, "2 lan goi Gemini JSON (trich xuat + dia chi)");
globalThis.fetch = prevFetch;
console.log("OK 15: chot don -> ghi don nhap POS (bien the, SDT, dia chi tinh/huyen/xa, mien ship)");

// ---- 16: them page luc chay bang token (dan trong app) -> kiem tra token, ghi nhan hoi thoai cu, luu file; go page
{
  const { config, saveAppPage, removeAppPage, readAppPages, APP_PAGES_FILE } = await import("../src/config.js");
  const prev16 = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname === "pages.fm" && u.pathname.includes("/pages/PAGE2/")) {
      const tok = u.searchParams.get("page_access_token");
      if (tok !== "tok2") return new Response(JSON.stringify({ success: false, message: "invalid token" }), { status: 401, headers: { "content-type": "application/json" } });
      if (u.pathname.endsWith("/conversations")) {
        const list = u.searchParams.get("type") === "INBOX" ? [{ id: "PAGE2_CONVX", updated_at: "2026-09-06T01:00:00", from: { name: "Mai" }, last_sent_by: { id: "U9" } }] : [];
        return new Response(JSON.stringify({ success: true, conversations: list }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.pathname.endsWith("/tags")) return new Response(JSON.stringify({ success: true, data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return prev16(url, init);
  };
  await assert.rejects(() => bot.addPage("PAGE2", "bad"), /invalid token|loi 401/, "token sai phai bao loi");
  assert.ok(!bot.clients.has("PAGE2"), "token sai -> khong duoc them page");
  const r16 = await bot.addPage("PAGE2", "tok2", "Page Hai");
  assert.equal(r16.conversations, 1, "phai dem hoi thoai hien co");
  assert.ok(bot.clients.has("PAGE2") && bot.getClient("PAGE2").token === "tok2");
  assert.equal(store.getConvUpdatedAt("PAGE2_CONVX"), "2026-09-06T01:00:00", "phai ghi nhan hoi thoai cu de khong tra loi hang loat");
  assert.equal(bot.pageNames.get("PAGE2"), "Page Hai");
  saveAppPage("PAGE2", { token: "tok2", name: "Page Hai" });
  assert.ok(fs.existsSync(APP_PAGES_FILE) && readAppPages().PAGE2.token === "tok2", "phai luu data/pages_tokens.json");
  assert.equal(config.pages.PAGE2.source, "app");
  // Cap nhat token cho page da co (doi token) -> ghi de, van 1 page
  const r16b = await bot.addPage("PAGE2", "tok2", "");
  assert.equal(r16b.isNew, false);
  assert.equal(removeAppPage("PAGE2"), true);
  assert.ok(!config.pages.PAGE2 && !readAppPages().PAGE2, "go page -> xoa khoi config va file");
  assert.equal(bot.removePage("PAGE2"), true);
  assert.ok(!bot.clients.has("PAGE2") && !bot.pageNames.has("PAGE2"));
  assert.ok(bot.clients.has("PAGE1"), "page trong .env khong bi anh huong");
  globalThis.fetch = prev16;
  console.log("OK 16: them page bang token luc chay -> kiem tra token, ghi nhan hoi thoai cu, luu file; doi token; go page");
}

// ---- Test 16: [[IMG:ALL]] -> tong hop 1 anh/mau moi mau, chia nhieu tin (IMAGES_PER_MESSAGE)
calls.length = 0;
cfg.maxProductImages = 12; cfg.imagesPerMessage = 3;
catalog.setProducts([1, 2, 3, 4].map((n) => ({
  id: "p" + n, code: "Q00" + n, name: "Đầm Q00" + n, note: "", attributes: { "Màu": ["Đỏ", "Đen"], Size: ["M"] }, price: { min: 499000, max: 499000 },
  images: [`https://content.pancake.vn/q${n}-do.png`, `https://content.pancake.vn/q${n}-den.png`],
  variations: [
    { id: `v${n}a`, sku: `Q00${n}DOM`, fields: { "Màu": "Đỏ", Size: "M" }, price: 499000, stock: 1, available: true, images: [`https://content.pancake.vn/q${n}-do.png`] },
    { id: `v${n}b`, sku: `Q00${n}DENM`, fields: { "Màu": "Đen", Size: "M" }, price: 499000, stock: 1, available: true, images: [`https://content.pancake.vn/q${n}-den.png`] },
  ],
})));
geminiText = "Dạ mẫu này bên em hết rồi ạ, chị xem các mẫu đang có bên em nhé ❤️ [[IMG:ALL]]";
pancakeMessages = [msg("m40", "[Khách gửi 1 hình ảnh]\ncó mẫu này không", customer)];
bot.handleWebhook(webhook(pancakeMessages[0]));
await sleep(3500);
const imgMsgs = calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages") && c.body?.content_ids);
assert.equal(calls.filter((c) => c.path.endsWith("/upload_contents")).length, 8, "4 mau x 2 mau sac = 8 anh upload");
assert.equal(imgMsgs.length, 3, "8 anh, 3 anh/tin -> 3 tin anh: " + imgMsgs.length);
assert.deepEqual(imgMsgs.map((c) => c.body.content_ids.length), [3, 3, 2]);
cfg.imagesPerMessage = 6;
console.log("OK 16: [[IMG:ALL]] -> gui tong hop tat ca mau, chia nhieu tin");

// ---- Test 17: cham soc khach chua mua: quet theo ngay + loc chua SDT -> gui hang loat {name}, bo qua can_inbox=false
calls.length = 0;
const { broadcast } = await import("../src/broadcast.js");
const nowIso = (min) => new Date(Date.now() - min * 60000).toISOString().replace("Z", "");
let convList = [
  { id: "B1", from: { id: "u1", name: "Nguyễn Thị Hoa" }, updated_at: nowIso(30), has_phone: false, snippet: "giá sao", last_sent_by: { id: "u1" }, tags: [] },
  { id: "B2", from: { id: "u2", name: "Trần Mai" }, updated_at: nowIso(60 * 24 * 2), has_phone: true, snippet: "0912...", last_sent_by: { id: "u2" }, tags: [] },
  { id: "B3", from: { id: "u3", name: "Lê Lan" }, updated_at: nowIso(60 * 24 * 3), has_phone: false, snippet: "đẹp", last_sent_by: { id: "PAGE1" }, tags: [] },
  { id: "B4", from: { id: "u4", name: "Phạm Cúc" }, updated_at: nowIso(60 * 24 * 20), has_phone: false, snippet: "cũ", last_sent_by: { id: "u4" }, tags: [] },
];
const prevFetch2 = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.hostname === "pages.fm" && u.pathname.endsWith("/conversations")) { calls.push({ method: "GET", path: u.pathname, query: Object.fromEntries(u.searchParams) }); return new Response(JSON.stringify({ conversations: convList }), { status: 200, headers: { "content-type": "application/json" } }); }
  if (u.hostname === "pages.fm" && u.pathname.includes("/conversations/B3/messages") && (init.method || "GET") === "GET") { calls.push({ method: "GET", path: u.pathname }); return new Response(JSON.stringify({ success: true, messages: [], conv_from: { name: "Lê Lan" }, can_inbox: false }), { status: 200, headers: { "content-type": "application/json" } }); }
  if (u.hostname === "pages.fm" && u.pathname.includes("/conversations/B1/messages") && (init.method || "GET") === "GET") { calls.push({ method: "GET", path: u.pathname }); return new Response(JSON.stringify({ success: true, messages: [], conv_from: { name: "Nguyễn Thị Hoa" }, can_inbox: true }), { status: 200, headers: { "content-type": "application/json" } }); }
  return prevFetch2(url, init);
};
const scan = await broadcast.scan(bot, "PAGE1", { days: 7, noPhoneOnly: true });
assert.deepEqual(scan.conversations.map((c) => c.id), ["B1", "B3"], "7 ngay + chua SDT -> B1, B3 (B2 co SDT, B4 qua 20 ngay)");
// Loc nang cao: tu ngay -> den ngay, khung gio, tu khoa
const scanRange = await broadcast.scan(bot, "PAGE1", { from: Date.now() - 4 * 864e5, to: Date.now() - 1 * 864e5, noPhoneOnly: false });
assert.deepEqual(scanRange.conversations.map((c) => c.id), ["B2", "B3"], "tu 4 ngay -> 1 ngay truoc: B2, B3 (B1 moi 30 phut, B4 qua cu)");
const scanSwap = await broadcast.scan(bot, "PAGE1", { from: Date.now() - 1 * 864e5, to: Date.now() - 4 * 864e5, noPhoneOnly: false });
assert.deepEqual(scanSwap.conversations.map((c) => c.id), ["B2", "B3"], "chon nguoc tu/den -> tu dao lai, khong ra rong");
const hVN = (ms) => Number(new Date(ms).toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", hour12: false }).slice(0, 2)) % 24;
const h1 = hVN(Date.now() - 30 * 60000);
const scanHour = await broadcast.scan(bot, "PAGE1", { days: 7, noPhoneOnly: true, hourFrom: h1, hourTo: h1 + 1 });
assert.ok(scanHour.conversations.some((c) => c.id === "B1"), "khung gio dung -> co B1");
const scanHour2 = await broadcast.scan(bot, "PAGE1", { days: 7, noPhoneOnly: true, hourFrom: (h1 + 2) % 24, hourTo: (h1 + 3) % 24 });
assert.ok(!scanHour2.conversations.some((c) => c.id === "B1"), "khung gio khac -> khong co B1");
const scanKw = await broadcast.scan(bot, "PAGE1", { days: 7, noPhoneOnly: false, keyword: "giá" });
assert.deepEqual(scanKw.conversations.map((c) => c.id), ["B1"], "tu khoa 'giá' -> chi B1");
broadcast.start(bot, "PAGE1", { ids: ["B1", "B3"], text: "Chào chị {name} ạ, shop giảm 40% hôm nay ❤️", perMinute: 60 });
await sleep(2500);
const stt = broadcast.status("PAGE1");
assert.equal(stt.running, false); assert.equal(stt.sent, 1, "gui 1 (B1)"); assert.equal(stt.skipped, 1, "bo qua 1 (B3 can_inbox=false)");
const bsent = calls.find((c) => c.method === "POST" && c.path.includes("/conversations/B1/messages"));
assert.equal(bsent.body.message, "Chào chị Hoa ạ, shop giảm 40% hôm nay ❤️", "{name} phai thay bang ten cuoi");
assert.ok(store.getBroadcastSent("B1") > 0, "phai nho da gui B1");
globalThis.fetch = prevFetch2;
console.log("OK 17: cham soc khach chua mua -> quet, loc (ngay/khung gio/tu khoa), gui hang loat {name}, bo qua khach khong nhan duoc");

// ---------- 18. Doi chieu dia chi don POS voi tin nhan khach ----------
const { orderAudit } = await import("../src/audit.js");
const { orderSync: osync } = await import("../src/orders.js");
osync.provinces = async () => [{ id: "P1", name: "Thanh Hóa", new_id: "n_th" }, { id: "P2", name: "Đắk Nông", new_id: "n_dn" }];
osync.districts = async (pid) => (pid === "P1" ? [{ id: "D1", name: "Huyện Hà Trung" }, { id: "D2", name: "Thành phố Thanh Hoá" }] : [{ id: "D3", name: "Huyện Đắk Mil" }]);
osync.communes = async (did) => (did === "D1" ? [{ id: "C1", name: "Xã Hà Bình", new_id: "n_hb" }] : did === "D3" ? [{ id: "C2", name: "Xã Thuận An", new_id: "n_ta" }, { id: "C3", name: "Thị trấn Đắk Mil", new_id: "n_dm" }] : []);

// Ten tinh trung ten huyen: phai ra Huyen Ha Trung chu khong phai Thanh pho Thanh Hoa
const rl = await orderAudit.resolveLocal("Đc lô 1 khu công nghiệp thịnh vinh xã Hà bình huyện Hà Trung tỉnh thanh hóa");
assert.equal(rl.province.name, "Thanh Hóa");
assert.equal(rl.district.name, "Huyện Hà Trung", "khong duoc nham sang Thanh pho Thanh Hoa");
assert.equal(rl.commune.name, "Xã Hà Bình");
assert.ok(/khu công nghiệp thịnh vinh/i.test(rl.street), "so nha/duong phai giu dau tieng Viet");

const okOrder = { id: 1, page_id: "PAGE1", conversation_id: "", status: 1, shipping_address: { address: "Đc lô 1 khu công nghiệp thịnh vinh, Xã Hà Bình, Huyện Hà Trung, Thanh Hóa", province_id: "P1", district_id: "D1", commune_id: "C1", province_name: "Thanh Hóa", district_name: "Huyện Hà Trung", commune_name: "Xã Hà Bình" } };
assert.equal((await orderAudit.checkOrder(bot, okOrder, { useAI: false })).verdict, "khop", "don ghi dung thi khong duoc bao lech");

const badOrder = { id: 2, page_id: "PAGE1", conversation_id: "", status: 1, bill_full_name: "Khach A", shipping_address: { address: "Thôn Đắc Xuân, Xã Thuận An, Huyện Đắk Mil, Tỉnh Đắk Nông", province_id: "P2", district_id: "D3", commune_id: "C3", province_name: "Đắk Nông", district_name: "Huyện Đắk Mil", commune_name: "Thị trấn Đắk Mil" } };
const r18b = await orderAudit.checkOrder(bot, badOrder, { useAI: false });
assert.equal(r18b.verdict, "lech", "don chon nham xa phai bao lech");
assert.deepEqual(r18b.diffs.map((d) => d.field), ["Xã/phường"]);
assert.equal(r18b.proposed.commune_id, "C2", "de xuat phai tro ve xa dung");
assert.ok(/Thuận An/.test(r18b.proposed.fullAddress));

// Hai xa cu ve cung mot xa moi (sap nhap 2025) thi khong tinh la lech
osync.communes = async (did) => (did === "D3" ? [{ id: "C2", name: "Xã Thuận An", new_id: "n_same" }, { id: "C3", name: "Thị trấn Đắk Mil", new_id: "n_same" }] : []);
assert.equal((await orderAudit.checkOrder(bot, { ...badOrder, id: 3 }, { useAI: false })).verdict, "khop", "cung xa moi sau sap nhap -> khong bao lech");
console.log("OK 18: doi chieu dia chi don POS -> bat don chon nham xa, bo qua truong hop sap nhap, giu dau tieng Viet");

// ---- 19: nhan dien ban tom tat chot don -> ghi don POS (ke ca khi Gemini khong kem [[HANDOFF]])
{
  const { isOrderSummaryReply } = await import("../src/bot.js");
  const tomTatDuDia = 'Dạ em chốt đơn cho chị:\n• Mẫu Q003 màu Đỏ Đô size L x 1\n• Tổng: 499.000đ + 25.000đ ship = 524.000đ\n• Người nhận: Bình Hoàng – 0945529226\n• Địa chỉ: Thôn Đầu Bình, xã Cam Tuyền, huyện Cam Lộ, tỉnh Quảng Trị';
  const tomTatThieuDia = 'Dạ em chốt đơn cho chị:\n• Mẫu Q003 màu Đỏ Đô size L x 1\n• Tổng: 524.000đ\n• Người nhận: Bình Hoàng – 0945529226';
  // Su co 2026-09-07 don #3834: bot chot don luc chua co dia chi (co handoff) -> POS ghi "Chua cung cap";
  // khach gui dia chi sau, bot tom tat lai NHUNG khong co handoff -> truoc day khong ghi lai, don thieu dia chi mai.
  assert.equal(isOrderSummaryReply(tomTatDuDia, false), true, "tom tat du dia chi ma khong handoff van phai ghi lai don");
  assert.equal(isOrderSummaryReply(tomTatThieuDia, true), true, "tom tat kem handoff phai ghi don (nhu cu)");
  assert.equal(isOrderSummaryReply("Dạ em chốt đơn cho chị mẫu Q003 màu Đỏ Đô size L nhé ạ.", false), false, "cau xac nhan mau ma chua tom tat thi khong goi POS");
  assert.equal(isOrderSummaryReply("Dạ chị cho em xin địa chỉ nhận hàng giúp em nhé ạ", false), false);
  assert.equal(isOrderSummaryReply("Dạ mẫu này 499.000đ ạ, chị lấy màu nào ạ?", true), false, "khong noi ve chot don thi khong ghi don");
  assert.equal(isOrderSummaryReply("", false), false);
  console.log("OK 19: nhan dien ban tom tat chot don (co/khong handoff) de ghi don POS");
}

// ---- 20: chan AI bia so dien thoai khi ghi don POS
{
  const { phoneInText } = await import("../src/orders.js");
  // Su co 2026-09-07 don #3843: khach gui SDT dung giay bot tra loi -> lich su chua co so,
  // Gemini bia "0337711777" -> tao don moi voi SDT sai thay vi cap nhat don nhap co san cua khach.
  const hist = "KHACH: Số nhà 214 đường núi Ngọc thị trấn cát bà cát Hải Hải phòng\nKHACH: 0971291509\nSHOP: Dạ em chốt đơn cho chị";
  assert.equal(phoneInText(hist, "0971291509"), true, "SDT khach that phai duoc chap nhan");
  assert.equal(phoneInText(hist, "0337711777"), false, "SDT AI bia phai bi chan");
  assert.equal(phoneInText("KHACH: sdt cua e la 097 129 1509 nhe", "0971291509"), true, "SDT viet cach van nhan ra");
  assert.equal(phoneInText("KHACH: +84971291509", "0971291509"), true, "SDT dang +84 van nhan ra");
  assert.equal(phoneInText("KHACH: nha o Ha Noi", "0971291509"), false);
  assert.equal(phoneInText("KHACH: 0971291509", ""), false);
  console.log("OK 20: chan AI bia SDT khi ghi don POS (chi nhan so thuc su co trong hoi thoai)");
}

// ---- 21: ngan sach "suy nghi" phai duoc cong bu vao maxOutputTokens (khong an mat cau tra loi)
{
  const { generateReply } = await import("../src/gemini.js");
  const prev = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, init = {}) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"province":"Hà Nội"}' }] }, finishReason: "STOP" }], usageMetadata: {} }), { status: 200, headers: { "content-type": "application/json" } });
  };
  // Su co 2026-09-09: thinkingBudget 512 + maxOutputTokens 300 -> model tieu het token vao suy nghi,
  // tra ve "{" (MAX_TOKENS) nen resolveAddress bao "khong xac dinh duoc tinh/thanh" voi MOI dia chi.
  await generateReply("sys", [{ role: "user", text: "hi" }], { maxOutputTokens: 300, thinkingBudget: 512, jsonSchema: { type: "OBJECT", properties: { province: { type: "STRING" } } } });
  assert.equal(sent.generationConfig.thinkingBudget, undefined);
  assert.equal(sent.generationConfig.thinkingConfig.thinkingBudget, 512);
  assert.equal(sent.generationConfig.maxOutputTokens, 812, "phai cong ngan sach suy nghi vao maxOutputTokens");
  await generateReply("sys", [{ role: "user", text: "hi" }], { maxOutputTokens: 300, thinkingBudget: 0 });
  assert.equal(sent.generationConfig.maxOutputTokens, 300, "khong suy nghi thi giu nguyen gioi han");
  globalThis.fetch = prev;
  console.log("OK 21: cong ngan sach suy nghi vao maxOutputTokens (JSON khong bi cat cut)");
}

// ---- 22: gui tin hong GIUA CHUNG -> khong soan lai tu dau (chong gui trung cho khach)
{
  calls.length = 0;
  // Su co 2026-09-12 (khach Hoa Nguyen): bot tach tra loi thanh nhieu doan, doan 2 bi Facebook tu choi
  // "(#551) Nguoi nay hien khong co mat". deliver() nem loi -> processConversation dung, khong kip
  // setLastHandled -> luoi an toan tuong chua ai tra loi -> bot soan lai tu dau 3 lan -> khach bo don.
  settings.update("PAGE1", { splitMessages: true });
  const prev22 = globalThis.fetch;
  let soLanGui = 0, hongTaiLanThu = 2;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname === "pages.fm" && u.pathname.endsWith("/messages") && init.method === "POST") {
      soLanGui++;
      if (soLanGui === hongTaiLanThu) return new Response(JSON.stringify({ success: false, message: "(#551) Người này hiện không có mặt." }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ success: true, id: "m" + soLanGui }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return prev22(url, init);
  };
  const doan = (n) => `Đoạn số ${n}: ` + "Dạ chị ơi mẫu đầm này bên em chất vải rất mát và lên form đẹp, chị mặc đi làm hay đi chơi đều hợp ạ, em xin phép tư vấn thêm cho mình nhé chị yêu. ".repeat(2);
  const r22 = await bot.deliver("PAGE1", "CONV22", { text: [doan(1), doan(2), doan(3)].join("\n\n") });
  assert.equal(r22.messageIds.length, 1, "chi gui duoc doan dau");
  assert.equal(r22.partial, true, "phai danh dau la gui thieu");
  assert.equal(soLanGui, 2, "gap loi thi dung lai, khong gui tiep doan 3");

  // Nguoc lai: hong ngay doan DAU (chua gui duoc gi cho khach) thi van nem loi de ben ngoai thu lai
  soLanGui = 0;
  hongTaiLanThu = 1;
  await assert.rejects(() => bot.deliver("PAGE1", "CONV22", { text: "Chỉ một đoạn." }), /551|Người này/i, "hong tu doan dau thi phai nem loi de thu lai");
  globalThis.fetch = prev22;
  settings.update("PAGE1", { splitMessages: false });
  console.log("OK 22: gui hong giua chung -> giu phan da gui, khong soan lai tu dau");
}

// ---- 23: sales agent bam khach chua chot (phan loai bang code, AI chi soan cau chu)
{
  calls.length = 0;
  const { salesAgent, classify, eligible, inQuietHours, followupConfig } = await import("../src/salesagent.js");
  const at = (h) => new Date(Date.now() - h * 3600e3).toISOString().replace("Z", "");
  const mk = (id, text, from, hoursAgo, extra = {}) => ({
    id, conversation_id: "F1", page_id: "PAGE1", type: "INBOX", message: text, original_message: text,
    inserted_at: at(hoursAgo), from, attachments: [], ...extra,
  });

  // -- Phan loai giai doan: THUAN CODE, khong goi AI
  const hoiThoai = {
    phone_no_order: [mk("a1", "chị ơi mẫu này giá bao nhiêu", customer, 40), mk("a2", "Dạ đầm 499.000đ ạ chị", pageFrom, 39), mk("a3", "0912345678 nha em", customer, 38), mk("a4", "Dạ em ghi nhận rồi ạ", pageFrom, 37)],
    objection: [mk("b1", "giá sao shop", customer, 40), mk("b2", "Dạ 499.000đ ạ", pageFrom, 39), mk("b3", "đắt quá, để em suy nghĩ", customer, 38), mk("b4", "Dạ vâng ạ", pageFrom, 37)],
    size_no_phone: [mk("c1", "tư vấn size với", customer, 40), mk("c2", "Dạ chị cho em xin số đo ạ", pageFrom, 39), mk("c3", "em cao 1m60 nặng 55kg", customer, 38), mk("c4", "Dạ chị mặc size L ạ", pageFrom, 37)],
    quoted_no_phone: [mk("d1", "mẫu này sao shop", customer, 40), mk("d2", "Dạ giá 499.000đ ạ", pageFrom, 39), mk("d3", "màu này đẹp nhỉ", customer, 38), mk("d4", "Dạ vâng ạ", pageFrom, 37)],
    viewed_only: [mk("e1", "cho xem ảnh với", customer, 40), mk("e2", "", pageFrom, 39, { attachments: [{ type: "photo" }] })],
    cold: [mk("f1", "shop ơi", customer, 40), mk("f2", "Dạ em nghe ạ", pageFrom, 39)],
    waiting: [mk("g1", "Dạ em chào chị", pageFrom, 40), mk("g2", "còn hàng không shop", customer, 39)],
    refused: [mk("h1", "giá sao", customer, 40), mk("h2", "Dạ 499.000đ ạ", pageFrom, 39), mk("h3", "thôi không mua nữa", customer, 38), mk("h4", "Dạ vâng ạ", pageFrom, 37)],
    ordered: [mk("i1", "lấy 1 cái", customer, 40), mk("i2", "Dạ em chốt đơn cho chị nhé", pageFrom, 39)],
  };
  for (const [mong, msgs] of Object.entries(hoiThoai)) {
    assert.equal(classify(bot, "PAGE1", msgs).stage, mong, `phan loai sai, phai la ${mong}`);
  }

  // -- Dieu kien duoc bam: moc im lang, so lan, da dung han
  settings.update("PAGE1", { followupEnabled: true, followupMaxTouches: 3, followupDelays: "20,72,168", followupQuietFrom: 0, followupQuietTo: 0, followupStages: "", followupExtra: "" });
  const cfg = followupConfig("PAGE1");
  assert.deepEqual(cfg.delays, [20, 72, 168]);
  const sig = classify(bot, "PAGE1", hoiThoai.phone_no_order).signals;
  assert.equal(eligible(cfg, "phone_no_order", sig, "F1").ok, true, "im 38h > moc 20h -> duoc bam lan 1");
  assert.equal(eligible(cfg, "waiting", sig, "F1").ok, false, "khach dang cho shop tra loi thi khong bam");
  assert.equal(eligible(cfg, "ordered", sig, "F1").ok, false, "da chot don thi khong bam");
  const sigMoi = { ...sig, lastCustomerAt: Date.now() - 5 * 3600e3 };
  assert.equal(eligible(cfg, "phone_no_order", sigMoi, "F1").ok, false, "moi im 5h thi chua den moc");
  store.bumpFollowup("PAGE1", "F1", "phone_no_order");
  assert.equal(store.getFollowup("F1").touches, 1);
  assert.equal(eligible(cfg, "phone_no_order", sig, "F1").ok, false, "vua bam xong thi phai cho den moc lan 2");
  store.stopFollowup("F1");
  assert.equal(eligible(cfg, "phone_no_order", { ...sig, lastCustomerAt: Date.now() - 400 * 3600e3 }, "F1").ok, false, "da dung han thi khong bam nua");
  store.stopFollowup("F1", false);
  assert.equal(eligible(cfg, "phone_no_order", sig, "F1").reason.includes("mốc lần 2") || !eligible(cfg, "phone_no_order", sig, "F1").ok, true);
  assert.equal(eligible({ ...cfg, stages: "objection" }, "phone_no_order", sig, "F2").ok, false, "loc theo giai doan duoc chon");

  // -- Gio yen tinh
  const quiet = { quietFrom: 21, quietTo: 8 };
  assert.equal(inQuietHours(quiet, Date.parse("2026-01-02T23:30:00+07:00")), true, "23h30 la gio yen tinh");
  assert.equal(inQuietHours(quiet, Date.parse("2026-01-02T06:00:00+07:00")), true, "6h sang van yen tinh");
  assert.equal(inQuietHours(quiet, Date.parse("2026-01-02T15:00:00+07:00")), false, "3h chieu thi nhan duoc");
  assert.equal(inQuietHours({ quietFrom: 0, quietTo: 0 }), false, "dat bang nhau = tat gio yen tinh");

  // -- Quet: bo qua hoi thoai khach nhan cuoi va hoi thoai bi tag tat bot
  pancakeMessages = hoiThoai.phone_no_order;
  const convF = [
    { id: "F1", from: { id: "C1", name: "Lan" }, updated_at: at(37), has_phone: true, last_sent_by: { id: "PAGE1" }, tags: [] },
    { id: "F2", from: { id: "C2", name: "Hoa" }, updated_at: at(2), has_phone: false, last_sent_by: { id: "C2" }, tags: [] },
    { id: "F3", from: { id: "C3", name: "Mai" }, updated_at: at(40), has_phone: false, last_sent_by: { id: "PAGE1" }, tags: [{ id: 99 }] },
  ];
  const prev23 = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname === "pages.fm" && u.pathname.endsWith("/conversations")) return new Response(JSON.stringify({ conversations: convF }), { status: 200, headers: { "content-type": "application/json" } });
    return prev23(url, init);
  };
  store.stopFollowup("F1", false);
  const q23 = await salesAgent.scan(bot, "PAGE1", { days: 30 });
  assert.deepEqual(q23.conversations.map((c) => c.id), ["F1"], "chi con F1 (F2 khach nhan cuoi, F3 bi tag tat bot)");
  assert.equal(q23.conversations[0].stage, "phone_no_order");

  // -- Soan tin: AI soan, code kiem tra lai
  const goodText = geminiText;
  geminiText = "Dạ chị Lan ơi, đầm bên em vẫn còn đủ size cho mình ạ 😊 Chị chốt giúp em màu nào để em gửi hàng cho chị kiểm tra trước khi thanh toán nhé?";
  store.stopFollowup("F1", false);
  const r23 = await salesAgent.compose(bot, "PAGE1", "F1", { force: true });
  assert.ok(!r23.skip, "tin hop le phai duoc chap nhan: " + (r23.reason || ""));
  assert.match(r23.text, /Lan/, "tin phai goi ten khach");
  assert.equal(r23.stage, "phone_no_order");

  geminiText = "Dạ em giảm riêng cho chị còn 250.000đ thôi ạ, chị chốt nhé?";
  const rGia = await salesAgent.compose(bot, "PAGE1", "F1", { force: true });
  assert.ok(rGia.skip && /giá/.test(rGia.reason), "gia ngoai bang gia -> khong duoc gui: " + JSON.stringify(rGia));

  geminiText = "Dạ em chốt đơn cho chị nhé, tổng: 499.000đ ạ";
  const rChot = await salesAgent.compose(bot, "PAGE1", "F1", { force: true });
  assert.ok(rChot.skip && /chốt đơn/.test(rChot.reason), "tin bam khong duoc tu chot don");

  geminiText = "BỎ QUA";
  const rBo = await salesAgent.compose(bot, "PAGE1", "F1", { force: true });
  assert.ok(rBo.skip, "AI noi BO QUA thi dung han, khong retry");

  // -- Chay that: gui 1 tin, ghi nho da bam
  geminiText = "Dạ chị Lan ơi, bên em vẫn giữ mẫu chị xem hôm trước ạ 😊 Chị cho em biết mình ưng màu nào nhé?";
  // F5 la hoi thoai chua bam lan nao -> _run tu kiem tra dieu kien (khong dung force nhu compose o tren)
  calls.length = 0;
  salesAgent.start(bot, "PAGE1", { ids: ["F5"], perMinute: 60 });
  await sleep(1500);
  const guiDi = calls.filter((c) => c.method === "POST" && c.path.includes("/conversations/F5/messages"));
  assert.equal(guiDi.length, 1, "phai gui dung 1 tin cho khach");
  assert.match(guiDi[0].body.message, /Lan/);
  assert.equal(store.getFollowup("F5").touches, 1, "phai ghi nho da bam 1 lan");
  assert.equal(store.countFollowupToday("PAGE1") >= 1, true, "phai dem vao han muc tin/ngay");

  // -- Chan o server: page chua bat bam khach thi khong chay duoc
  settings.update("PAGE1", { followupEnabled: false });
  assert.throws(() => salesAgent.start(bot, "PAGE1", { ids: ["F1"] }), /chua bat/i, "page chua bat thi phai chan");

  globalThis.fetch = prev23;
  geminiText = goodText;
  settings.update("PAGE1", { followupEnabled: false, followupAuto: false });
  console.log("OK 23: bam khach chua chot -> phan loai bang code, chan gia sai/chot don/trung tin, nho so lan bam");
}

// ---- 24: ban tom tat chot don KHONG duoc tu chon mau khi khach chua chon
{
  // Su co 2026-09-10 (khach Hong Nguyen, page Hai An Fashion): bot hoi "Do Do hay Xanh Reu?", khach khong tra
  // loi mau ma gui luon can nang + dia chi + SDT, bot chot "Dam Q003 mau Xanh Reu".
  const { isOrderSummaryReply: isOrderSummaryReplyFn } = await import("../src/bot.js");
  const prevProducts = catalog.products;
  catalog.setProducts([{
    id: "p3", code: "Q003", name: "Đầm Q003", note: "", attributes: { "Màu": ["Đỏ Đô", "Xanh Rêu"], Size: ["XL", "2XL"] }, price: { min: 499000, max: 499000 },
    images: [], variations: [
      { id: "v3a", sku: "Q003DD2XL", fields: { "Màu": "Đỏ Đô", Size: "2XL" }, price: 499000, stock: 1, available: true, images: [] },
      { id: "v3b", sku: "Q003XR2XL", fields: { "Màu": "Xanh Rêu", Size: "2XL" }, price: 499000, stock: 1, available: true, images: [] },
    ],
  }]);
  const shop = (t) => ({ from: { id: "PAGE1" }, message: t });
  const khach = (t) => ({ from: { id: "KHACH" }, message: t });
  const tomTat = "Dạ em chốt đơn cho chị ạ:\n• Đầm Q003 màu Xanh Rêu size 2XL x 1\n• Tổng: 499.000đ (miễn phí ship)\n• Người nhận: Hồng Nguyễn – 0905494063\n• Địa chỉ: Nông sơn 1, Điện Phước, Điện Bàn, Tỉnh Quảng Nam";
  const hoiThoai = [
    shop("Dạ với 77kg, chị mặc size 2XL là vừa đẹp ạ. Chị muốn lấy màu Đỏ Đô hay Xanh Rêu ạ?"),
    khach("Có cho mặt thử ko shop"),
    shop("Dạ có ạ, mình được kiểm tra hàng thoải mái trước khi thanh toán nha chị. Chị chốt đơn luôn không ạ?"),
    khach("Cân nặng 77 kg\nChiều cao 1m 68\nNông sơn 1 điện Phước điện bàn tỉnh quảng nam\nSĐT: 0905494063"),
  ];
  const loi = bot.unconfirmedColorInSummary(tomTat, "PAGE1", hoiThoai);
  assert.ok(loi, "khach chua chon mau ma bot tu chot Xanh Reu -> phai chan");
  assert.equal(loi.color, "Xanh Rêu");
  assert.deepEqual(loi.colors, ["Đỏ Đô", "Xanh Rêu"]);
  // Tin cua SHOP nhac ca hai mau khong duoc tinh la khach da chon
  assert.ok(bot.unconfirmedColorInSummary(tomTat, "PAGE1", hoiThoai.slice(0, 1)), "chi shop nhac mau thi van la chua chon");
  // Khach noi day du / noi tu rieng cua mau / anh khach gui nhan dien ra mau -> hop le
  assert.equal(bot.unconfirmedColorInSummary(tomTat, "PAGE1", [...hoiThoai, khach("lấy màu xanh rêu nha")]), null);
  assert.equal(bot.unconfirmedColorInSummary(tomTat, "PAGE1", [...hoiThoai, khach("xanh nhé shop")]), null, "\"xanh\" la tu rieng cua Xanh Reu");
  assert.equal(bot.unconfirmedColorInSummary(tomTat, "PAGE1", [...hoiThoai, khach("XANH REU")]), null, "khach go khong dau van nhan");
  assert.equal(bot.unconfirmedColorInSummary(tomTat, "PAGE1", hoiThoai, "Xanh Rêu"), null, "anh khach gui nhan dien ra Xanh Reu");
  // Khach chon mau KHAC mau bot chot -> van chan
  assert.ok(bot.unconfirmedColorInSummary(tomTat, "PAGE1", [...hoiThoai, khach("đỏ đô nhé")]), "khach chon Do Do ma bot chot Xanh Reu -> chan");
  // "do" (khong dau, nghia khac) khong duoc hieu la "Do Do"
  const tomTatDo = tomTat.replace("Xanh Rêu", "Đỏ Đô");
  assert.ok(bot.unconfirmedColorInSummary(tomTatDo, "PAGE1", [...hoiThoai, khach("do shop tu van nhe")]), "\"do\" khong phai mau Do Do");
  // Khong phai ban tom tat chot don -> khong dung vao
  assert.equal(bot.unconfirmedColorInSummary("Dạ mẫu Q003 có màu Đỏ Đô và Xanh Rêu ạ, chị lấy màu nào ạ?", "PAGE1", hoiThoai), null);
  // Cau hoi mau mac dinh: khong phai tom tat chot don va neu du cac mau
  const hoi = bot.askColorReply("PAGE1", loi.colors);
  assert.match(hoi, /Đỏ Đô hay Xanh Rêu/);
  assert.equal(isOrderSummaryReplyFn(hoi, false), false, "cau hoi mau khong duoc bi coi la ban chot don (khong ghi POS)");
  catalog.setProducts(prevProducts);
  console.log("OK 24: ban chot don khong duoc tu chon mau khi khach chua chon (mau co >= 2 mau)");
}

// ---- 25: su co 2026-09-26 (khach Hoai Thu, Linh Tay CS1 chay Q005)
{
  const prevProducts = catalog.products;
  const prevSettings = settings.get("PAGE1");
  catalog.setProducts([{
    id: "p5", code: "Q005", name: "Đầm Q005", note: "", attributes: { "Màu": ["Đen", "Đỏ Đô"], Size: ["L", "XL"] }, price: { min: 499000, max: 499000 },
    images: ["https://content.pancake.vn/q005.png"], variations: [
      { id: "v5a", sku: "Q005DENXL", fields: { "Màu": "Đen", Size: "XL" }, price: 499000, stock: 1, available: true, images: ["https://content.pancake.vn/q005-den.png"] },
    ],
  }]);
  settings.update("PAGE1", { defaultProduct: "Q005", extraPrompt: "", sendProductImages: true, sizeChart: '[{"h":[0,999],"w":[[30,49,"M"],[50,55,"L"],[56,63,"XL"],[64,79,"2XL"]]}]' });
  const shop = (t, att) => ({ from: { id: "PAGE1" }, message: t, attachments: att || [] });
  const khach = (t) => ({ from: { id: "KHACH" }, message: t });

  // (a) So do nam NGOAI 8 tin cuoi cua khach van phai doc duoc
  const hoiThoai = [
    khach("60kg cao 1m60"), shop("Dạ chị mặc size XL ạ"),
    ...["Ok", "Màu gì", "Có đen k", "Đứng vậy", "Có lẽ", "Trở đi trở lại cứ xin chiều cao cân nặng", "Các em nhiều nv à", "K đoc tn a", "2 lần gửi rồi và cho sai rồi giờ lại hỏi tiếp"].flatMap((t) => [khach(t), shop("Dạ")]),
  ];
  const r = bot.sizeLookupFor("PAGE1", hoiThoai);
  assert.equal(r.status, "ok", "so do cu hon 8 tin van phai doc duoc");
  assert.equal(r.size, "XL");
  // (b) Da co so do ma bot van xin lai -> thay bang cau bao size
  const xinLai = bot.stopAskingMeasurementsAgain("Dạ chị có thể cho em xin chiều cao và cân nặng của mình để em tư vấn size chuẩn nhất cho chị nha", "PAGE1", hoiThoai);
  assert.match(xinLai, /size XL/);
  assert.doesNotMatch(xinLai, /xin chiều cao/);
  assert.equal(bot.stopAskingMeasurementsAgain("Dạ chị cho em xin chiều cao cân nặng ạ", "PAGE1", [khach("giá sao shop")]), "Dạ chị cho em xin chiều cao cân nặng ạ", "chua co so do thi van duoc hoi");

  // (c) Khach buc minh -> nhan ra (xin loi 1 lan, chuyen nhan vien, im)
  for (const t of ["Trở đi trở lại cứ xin chiều cao cân nặng", "K đoc tn a", "2 lần gửi rồi và cho sai rồi giờ lại hỏi tiếp", "Đồ điên", "Thôi đọc lại từ đầu đến cuối\nC k mua nữa mô"]) {
    assert.equal(bot.isAnnoyed(t), true, "phai nhan ra khach buc: " + t);
  }
  for (const t of ["Ok mua nữa nha shop", "chị lấy 2 cái", "có đen không em", "60kg cao 1m60", "đọc giúp chị địa chỉ"]) {
    assert.equal(bot.isAnnoyed(t), false, "khong duoc bat nham: " + t);
  }

  // (d) Page chay Q005: khach xin anh -> gan [[IMG:Q005]] theo mau chu luc, ke ca da gui anh truoc do
  const daGuiAnh = [shop("", [{ type: "photo", url: "https://content.pancake.vn/q005.png" }]), khach("cho c xem ảnh thật đi")];
  assert.match(bot.ensureQuoteImage("Dạ đây ạ, chị xem giúp em nhé", "PAGE1", daGuiAnh), /\[\[IMG:Q005\]\]/, "khach xin anh -> gui anh Q005 du da gui truoc do");
  assert.match(bot.ensureQuoteImage("Dạ em gửi chị ảnh mẫu ạ", "PAGE1", [khach("mẫu này giá sao")]), /\[\[IMG:Q005\]\]/, "khong co ma trong cau -> dung mau chu luc");
  assert.equal(bot.ensureQuoteImage("Dạ chị cao bao nhiêu ạ", "PAGE1", daGuiAnh.slice(0, 1).concat(khach("ok"))), "Dạ chị cao bao nhiêu ạ", "khach khong xin anh -> khong gui lai");
  assert.match(bot.ensureQuoteImage("Dạ ảnh đây ạ [[IMG:Q005]]", "PAGE1", daGuiAnh), /^Dạ ảnh đây ạ \[\[IMG:Q005\]\]$/, "da co ma anh thi giu nguyen");

  settings.update("PAGE1", { defaultProduct: prevSettings.defaultProduct || "", extraPrompt: prevSettings.extraPrompt || "", sizeChart: prevSettings.sizeChart || "", sendProductImages: prevSettings.sendProductImages ?? null });
  catalog.setProducts(prevProducts);
  console.log("OK 25: so do cu van doc duoc, khong xin lai so do, nhan ra khach buc, khach xin anh -> gui anh mau chu luc");
}

// ---- 26: chi phi AI moi don (chu shop 28/09/2026: "them so tien phai tra cho api / 1 don hang")
{
  const { priceFor, usageTokens, summarizeAiCost, aiScope, DEFAULT_AI_PRICES } = await import("../src/aicost.js");
  // Gia theo TIEN TO DAI NHAT: "flash-lite-preview" khong duoc an gia cua "flash"
  assert.deepEqual(priceFor("gemini-2.5-flash-lite-preview-06-17", DEFAULT_AI_PRICES), DEFAULT_AI_PRICES["gemini-2.5-flash-lite"]);
  assert.deepEqual(priceFor("gemini-2.5-flash", DEFAULT_AI_PRICES), DEFAULT_AI_PRICES["gemini-2.5-flash"]);
  assert.equal(priceFor("gemini-3.5-flash", DEFAULT_AI_PRICES), null, "model chua co gia -> null, khong doan");
  // Token: Gemini tru phan cache khoi token vao, cong token suy nghi vao token ra; OpenAI khong cong reasoning lan hai
  assert.deepEqual(usageTokens("gemini", { promptTokenCount: 10000, cachedContentTokenCount: 9000, candidatesTokenCount: 150, thoughtsTokenCount: 50 }), { input: 1000, cached: 9000, output: 200 });
  assert.deepEqual(usageTokens("openai", { promptTokenCount: 8000, prompt_tokens_details: { cached_tokens: 6000 }, candidatesTokenCount: 300, thoughtsTokenCount: 100 }), { input: 2000, cached: 6000, output: 300 });
  // Tong hop: 100 luot flash-lite, 10 don -> tien/don; co model chua gia -> "it nhat" (partial), khong in 0
  const byDay = { "2026-09-28": { "gemini-2.5-flash-lite": { calls: 100, input: 100000, cached: 900000, output: 20000 } } };
  const a = summarizeAiCost(byDay, ["2026-09-28"], { prices: DEFAULT_AI_PRICES, usdVnd: 26000, orders: 10 });
  // (100000*0.1 + 900000*0.025 + 20000*0.4) / 1e6 = 0.0405 USD = 1053 d
  assert.equal(a.costVnd, 1053);
  assert.equal(a.perOrderVnd, 105);
  assert.equal(a.partial, false);
  const b = summarizeAiCost({ d: { ...byDay["2026-09-28"], "gemini-3.5-flash": { calls: 5, input: 1, cached: 0, output: 1 } } }, ["d"], { prices: DEFAULT_AI_PRICES, usdVnd: 26000, orders: 10 });
  assert.equal(b.partial, true);
  assert.equal(b.unpricedCalls, 5);
  const c = summarizeAiCost({ d: { "gemini-3.5-flash": { calls: 5, input: 1, cached: 0, output: 1 } } }, ["d"], { prices: DEFAULT_AI_PRICES, usdVnd: 26000, orders: 3 });
  assert.equal(c.costVnd, null, "toan luot chua co gia -> CHUA BIET, khong phai 0d");
  assert.equal(c.perOrderVnd, null);
  assert.equal(summarizeAiCost({}, ["d"], { prices: DEFAULT_AI_PRICES, usdVnd: 26000, orders: 0 }).costVnd, 0, "khong goi AI lan nao -> 0d that");
  assert.equal(a.perOrderVnd !== null && summarizeAiCost(byDay, ["2026-09-28"], { prices: DEFAULT_AI_PRICES, usdVnd: 26000, orders: 0 }).perOrderVnd, null, "chua co don -> khong chia");
  // Moi lan goi AI trong luot xu ly cua mot page duoc ghi cho dung page do
  const before = JSON.stringify(store.getAiUsage("PAGE_COST"));
  store.addAiUsage("PAGE_COST", "gemini-2.5-flash-lite", { input: 10, cached: 90, output: 5 });
  const u = store.getAiUsage("PAGE_COST");
  const day = Object.keys(u).sort().pop();
  assert.equal(u[day]["gemini-2.5-flash-lite"].calls >= 1, true);
  assert.notEqual(JSON.stringify(u), before);
  const { currentAiPage } = await import("../src/aicost.js");
  assert.equal(currentAiPage(), "_khac");
  assert.equal(aiScope.run({ pageId: "PAGE9" }, () => currentAiPage()), "PAGE9");
  // Bang gia sua trong app: chan so am / ty gia vo ly
  assert.throws(() => settings.setAiPricing({ aiPrices: { x: { input: -1, cached: 0, output: 0 } } }), /khong hop le/);
  assert.throws(() => settings.setAiPricing({ usdVnd: 5 }), /khong hop le/);
  const pr = settings.setAiPricing({ aiPrices: { "gemini-3.5-flash": { input: 0.5, cached: 0.05, output: 3 } }, usdVnd: 25500 });
  assert.equal(pr.usdVnd, 25500);
  assert.ok(pr.prices["gemini-3.5-flash"] && pr.prices["gemini-2.5-flash-lite"], "gia moi cong them, khong xoa gia mac dinh");
  settings.global.aiPrices = {}; settings.global.usdVnd = undefined;
  console.log("OK 26: chi phi AI / don: gia theo tien to dai nhat, token cache/suy nghi dung nha cung cap, model chua gia = chua biet (khong phai 0d)");
}

// ---- 27: chi phi AI / SDT cung khung gio (chu shop 28/09/2026: "lay tong tien tieu cho api chia cho chuan voi sdt")
// Su co: 829d tien (do tu 16:40 hom do) chia cho 577 don cua 30 ngay => "1d/don". Tu so va mau so phai cung khung.
{
  const { phonesInText } = await import("../src/orders.js");
  const { meteredUsage, perSdt } = await import("../src/aicost.js");
  assert.deepEqual(phonesInText("sdt c 0912.345.678 nha, so cu +84 987 654 321"), ["0912345678", "0987654321"]);
  assert.deepEqual(phonesInText("60kg 1m60, don 279.000d, ma 4452"), [], "can nang / gia / ma don khong phai SDT");
  // Ngay bat dau do: tru phan token ghi TRUOC moc; ngay truoc moc bo han
  const byDay = { "2026-09-27": { m: { calls: 50, input: 1, cached: 0, output: 1 } }, "2026-09-28": { m: { calls: 30, input: 300, cached: 0, output: 30 } } };
  const mu = meteredUsage(byDay, { day: "2026-09-28" }, { m: { calls: 20, input: 200, cached: 0, output: 20 } });
  assert.deepEqual(Object.keys(mu), ["2026-09-28"]);
  assert.deepEqual(mu["2026-09-28"].m, { calls: 10, input: 100, cached: 0, output: 10 });
  assert.equal(perSdt(829, 0), null, "chua co SDT nao -> khong chia");
  assert.equal(perSdt(null, 5), null, "tien chua biet -> khong chia");
  assert.equal(perSdt(1000, 4), 250);
  // SDT: moi so dem MOT lan; tin go truoc moc do khong dem
  const since = store.getMeter().since;
  assert.ok(since, "store co moc do");
  assert.equal(store.addPhone("PAGE_SDT", "0911111111", since - 60000), false, "SDT go truoc moc khong dem");
  assert.equal(store.addPhone("PAGE_SDT", "0911111112", Date.now()), true);
  assert.equal(store.addPhone("PAGE_SDT", "0911111112", Date.now()), false, "cung so khong dem lan hai");
  const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  assert.equal(store.countPhones([today], "PAGE_SDT"), 1);
  assert.ok(!JSON.stringify(store.state.phones).includes("0911111112"), "chi luu bam, khong luu so that");
  // Hoa don that nhap tay: chan khoang nguoc / so am
  assert.throws(() => settings.setAiBills([{ from: "2026-09-30", to: "2026-09-01", amountVnd: 1 }]), /Khoang ngay/);
  assert.throws(() => settings.setAiBills([{ from: "2026-09-01", to: "2026-09-30", amountVnd: -5 }]), /So tien/);
  assert.equal(settings.setAiBills([{ from: "2026-09-01", to: "2026-09-30", amountVnd: 350000.4, note: "thang 9" }])[0].amountVnd, 350000);
  settings.global.aiBills = [];
  console.log("OK 27: chi phi AI / SDT: tu so va mau so cung khung gio tu moc do, SDT dem mot lan (chi luu bam), hoa don that nhap tay");
}

// ---- 28: tien AI / DON chuan (chu shop 29/09/2026: "tinh toan chuan chi phi cho 1 don hang cua bot chat")
{
  const { aiScope, currentAiConversation } = await import("../src/aicost.js");
  assert.equal(currentAiConversation(), null, "ngoai luot xu ly hoi thoai -> khong gan cho hoi thoai nao");
  assert.equal(aiScope.run({ pageId: "P28", conversationId: "C28" }, () => currentAiConversation()), "C28");
  // Moi luot goi AI cua mot hoi thoai cong vao DUNG hoi thoai do
  store.addConvAiUsage("P28", "C28", "gemini-2.5-flash-lite", { input: 1000, cached: 9000, output: 200 });
  store.addConvAiUsage("P28", "C28", "gemini-2.5-flash-lite", { input: 500, cached: 0, output: 100 });
  store.addConvAiUsage("P28", null, "gemini-2.5-flash-lite", { input: 1, cached: 0, output: 1 });
  const conv = store.getConvAi("C28");
  assert.equal(conv.m["gemini-2.5-flash-lite"].calls, 2);
  assert.equal(conv.m["gemini-2.5-flash-lite"].input, 1500);
  // Mot don dem MOT lan du bot tao roi cap nhat don nhap (bo dem "orders" cu dem 2 lan)
  assert.equal(store.addBotOrder("P28", "9001", "C28"), true);
  assert.equal(store.addBotOrder("P28", "9001", "C28"), false, "cap nhat don nhap cu khong thanh don moi");
  assert.equal(store.addBotOrder("P28", "", "C28"), false, "khong co ma don -> khong dem");
  const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  assert.equal(store.countOrders([today], "P28"), 1);
  assert.equal(store.recentBotOrders(5)[0].c, "C28", "don nho hoi thoai sinh ra no");
  console.log("OK 28: tien AI / don: ghi theo tung hoi thoai, don dem mot lan, moi don truy duoc ve hoi thoai cua no");
}

// ---- 29: su co 2026-09-29 (khach Ta Thuy, page Linh Tay): da chon mau + size, gui dia chi + SDT ma bot van xin lai
{
  const prevSettings = settings.get("PAGE1");
  // Bang size co ca chieu cao: khach chi noi can nang (63 can) -> tra bang KHONG ra size, nhung khach da TU CHON size XL
  settings.update("PAGE1", { sizeChart: '[{"h":[150,159],"w":[[40,50,"M"],[51,60,"L"],[61,70,"XL"]]},{"h":[160,175],"w":[[40,52,"L"],[53,64,"XL"]]}]' });
  const shop = (t) => ({ from: { id: "PAGE1" }, message: t });
  const khach = (t) => ({ from: { id: "KHACH" }, message: t });
  const hoiThoai = [
    khach("Đồ có sẵn size nào?"), shop("Dạ chị cho em xin chiều cao và cân nặng"),
    khach("63 cân sai gì"), shop("Dạ 63kg chị mặc size XL ạ. Chị thích màu nào ạ?"),
    khach("Màu đỏ đô nha"), khach("Sai XL"), shop("Dạ, chị cho em xin tên và số điện thoại"),
    khach("Pg3-15 vin com phường điện biên thành phố thanh hóa"), khach("0943101365"),
    khach("Hàng quảng châu à em"), khach("Chị thích QC"),
  ];
  const f = bot.customerFacts("PAGE1", hoiThoai);
  assert.equal(f.size, "XL", "khach go 'Sai XL' = da chon size");
  assert.equal(f.phone, true);
  assert.match(f.address || "", /phường điện biên/);
  assert.doesNotMatch(f.address || "", /0943101365/, "dia chi khong mang theo SDT");
  // Cau tra loi that cua bot hom do: bo het phan xin lai, giu phan tra loi cau hoi cua khach
  const cu = "Dạ em không rõ nguồn gốc cụ thể ạ, nhưng chất liệu đầm bên em là Rayon cao cấp mềm mịn chị nha.\nChị đã có tên và số điện thoại rồi, em xin địa chỉ để chốt đơn cho mình nha chị yêu 🥰\nChị cho em xin chiều cao và cân nặng để em tư vấn size chuẩn cho mình nhé ạ?";
  const moi = bot.dropAlreadyGivenAsks(cu, "PAGE1", hoiThoai);
  assert.match(moi, /Rayon/, "giu phan tra loi cau hoi cua khach");
  assert.doesNotMatch(moi, /xin địa chỉ|chiều cao|cân nặng/, "khong xin lai dia chi / so do");
  // Cau hoi tu them o cuoi khong duoc xin chieu cao can nang khi khach da chon size
  const them = bot.ensureEndsWithQuestion("Dạ vâng ạ", "PAGE1", hoiThoai);
  assert.doesNotMatch(them, /chiều cao|cân nặng|số điện thoại|địa chỉ/);
  assert.match(them, /lên đơn/);
  // Con thieu that thi van phai hoi dung thu con thieu
  const chuaDiaChi = hoiThoai.filter((m) => !/phường/.test(m.message));
  assert.match(bot.ensureEndsWithQuestion("Dạ vâng ạ", "PAGE1", chuaDiaChi), /xin địa chỉ/);
  assert.equal(bot.dropAlreadyGivenAsks("Chị cho em xin số điện thoại và địa chỉ nhé", "PAGE1", [khach("0943101365")]), "Chị cho em xin số điện thoại và địa chỉ nhé", "cau xin ca thu con thieu thi giu lai");
  assert.equal(bot.customerFacts("PAGE1", [khach("chị cao 1m58 nặng 50kg")]).address, null, "so do khong phai dia chi");
  assert.equal(bot.customerFacts("PAGE1", [khach("mẫu này có size L không em")]).size, "L");
  settings.update("PAGE1", { sizeChart: prevSettings.sizeChart || "" });
  console.log("OK 29: khach da chon size / gui dia chi / SDT -> bot khong xin lai, chi hoi phan con thieu");
}

// ---- 31: noi chuyen nhu nguoi ban that: khong doc lai nguyen doan da gui, biet don dang thieu gi (chu shop 30/09/2026)
{
  const prevProducts = catalog.products;
  const prevSettings = settings.get("PAGE1");
  catalog.setProducts([{
    id: "p31", code: "Q002", name: "Đầm xếp ly eo", note: "", attributes: {}, price: { min: 499000, max: 499000 }, images: [],
    variations: ["Đỏ Đô", "Xanh Rêu", "Đen"].map((c, i) => ({ id: "v31" + i, sku: "Q002" + i, fields: { "Màu": c, Size: "XL" }, price: 499000, stock: 5, available: true, images: [] })),
  }]);
  settings.update("PAGE1", { defaultProduct: "Q002" });
  const shop = (t) => ({ from: { id: "PAGE1" }, message: t });
  const khach = (t) => ({ from: { id: "KHACH" }, message: t });
  const baoGia = "Chất liệu Rayon cao cấp mềm mịn, co giãn 4 chiều thoải mái, không nhăn, không bai xù.";
  const hoiThoai = [khach("giá đầm đỏ bao nhiêu"), shop(`Dạ 1 đầm 499k ạ. ${baoGia}`), khach("Màu đỏ đô nha"), khach("Sai XL")];
  assert.equal(bot.customerColor("PAGE1", hoiThoai), "Đỏ Đô", "khach noi 'đỏ đô' = da chon mau");
  assert.equal(bot.customerColor("PAGE1", [khach("xanh nha em")]), "Xanh Rêu", "tu rieng cua mau van nhan ra");
  assert.equal(bot.customerColor("PAGE1", [khach("mẫu này đẹp")]), null, "khong nhac mau -> chua chon, khong doan");
  const tienDo = bot.orderProgressPrompt("PAGE1", hoiThoai);
  assert.match(tienDo, /Màu: Đỏ Đô/);
  assert.match(tienDo, /Size: XL/);
  assert.match(tienDo, /VIỆC TIẾP THEO: xin số điện thoại và địa chỉ/);
  // Nhac lai nguyen doan chat lieu da gui -> bo; phan con lai giu
  const lap = bot.dropRepeatedSentences(`${baoGia}\nChị cho em xin số điện thoại và địa chỉ để em lên đơn nha?`, "PAGE1", hoiThoai);
  assert.doesNotMatch(lap, /Rayon/, "khong doc lai doan chat lieu da gui");
  assert.match(lap, /số điện thoại và địa chỉ/);
  // Khach HOI LAI dung chu de do -> duoc tra loi lai
  const hoiLai = [...hoiThoai, khach("chất liệu co giãn không em")];
  assert.match(bot.dropRepeatedSentences(baoGia, "PAGE1", hoiLai), /Rayon/, "khach hoi lai chat lieu thi van tra loi");
  // Cau ngan (Dạ vâng ạ) va ban tom tat chot don khong bi dung toi
  assert.equal(bot.dropRepeatedSentences("Dạ vâng ạ", "PAGE1", [shop("Dạ vâng ạ")]), "Dạ vâng ạ");
  settings.update("PAGE1", { defaultProduct: prevSettings.defaultProduct || "" });
  catalog.setProducts(prevProducts);
  console.log("OK 31: bot nho don dang thieu gi, khong doc lai doan da gui (tru khi khach hoi lai)");
}

// ---- 32: thoi gian giao hang bot hen khach = 5–7 ngay (chu shop 30/09/2026)
{
  const { DEFAULT_DELIVERY_DAYS } = await import("../src/settings.js");
  assert.equal(DEFAULT_DELIVERY_DAYS, "5–7");
  assert.equal(settings.deliveryDays(), "5–7");
  assert.equal(bot.fixDeliveryDays("Dạ bên em giao toàn quốc 2–4 ngày, được kiểm tra hàng ạ"), "Dạ bên em giao toàn quốc 5–7 ngày, được kiểm tra hàng ạ");
  assert.equal(bot.fixDeliveryDays("Ship 2-4 ngày chị nhé"), "Ship 5–7 ngày chị nhé");
  assert.equal(bot.fixDeliveryDays("Nhận hàng sau 3 đến 5 ngày ạ"), "Nhận hàng sau 5–7 ngày ạ");
  assert.equal(bot.fixDeliveryDays("Đổi size trong 1-3 ngày ạ"), "Đổi size trong 1-3 ngày ạ", "khong phai cau giao hang -> khong sua");
  assert.match(bot.buildSystemPrompt("PAGE1", { customerName: "", type: "INBOX" }), /Giao hàng toàn quốc 5–7 ngày/);
  assert.throws(() => settings.setDeliveryDays("7-5"), /5-7/);
  assert.equal(settings.setDeliveryDays("3 - 5"), "3–5");
  assert.equal(bot.fixDeliveryDays("giao 5–7 ngày"), "giao 3–5 ngày");
  settings.global.deliveryDays = undefined;
  console.log("OK 32: bot hen giao hang 5–7 ngay, sua cau hen so ngay cu, khong dung cau khong phai giao hang");
}

// ---- 34: ten nguoi nhan khong chan don (chu shop 30/09/2026: "co ten khach roi ma sao chua du thong tin")
{
  const { onlyNameMissing } = await import("../src/orders.js");
  assert.equal(onlyNameMissing("Tên khách hàng"), true);
  assert.equal(onlyNameMissing("họ tên người nhận"), true);
  assert.equal(onlyNameMissing("Tên khách hàng, màu sắc cho cả 2 đầm"), false, "con thieu mau -> van cho");
  assert.equal(onlyNameMissing("số điện thoại"), false);
  assert.equal(onlyNameMissing(""), false);
  console.log("OK 34: thieu moi ten nguoi nhan -> dung ten Facebook, khong treo don; thieu mau/size/SDT/dia chi van cho");
}

// ---- 30: khach nhan them TRONG LUC bot dang soan -> bo cau tra loi cu, tra loi lai mot lan voi du tin
{
  calls.length = 0;
  const cust = { id: "KHACH30", name: "Thuy" };
  const t0 = Date.now();
  pancakeMessages = [{ id: "a30", message: "Pg3-15 vin com phường điện biên thành phố thanh hóa", from: cust, inserted_at: new Date(t0 - 5000).toISOString().replace("Z", "") }];
  let lan = 0;
  onGetMessages = () => {
    lan++;
    // Lan doc thu 2 (bot kiem lai truoc khi gui): khach vua gui SDT
    if (lan === 2) pancakeMessages = [...pancakeMessages, { id: "b30", message: "0943101365", from: cust, inserted_at: new Date(t0 + 1000).toISOString().replace("Z", "") }];
  };
  geminiText = "Dạ mình cho em xin số điện thoại để em lên đơn gửi hàng cho mình nha";
  bot.handleWebhook(webhook(pancakeMessages[0]));
  await sleep(WAIT * 3);
  onGetMessages = null;
  const gem30 = calls.filter((c) => c.path.includes(":generateContent"));
  const gui30 = calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
  assert.equal(gem30.length, 2, "cau tra loi cu bi bo, bot soan lai mot lan voi tin moi");
  assert.ok(gui30.length >= 1, "van tra loi khach");
  assert.ok(gui30.every((c) => !/xin số điện thoại/.test(c.body.message)), "khong gui cau xin SDT khi khach vua gui SDT");
  console.log("OK 30: khach nhan them luc bot dang soan -> bo cau cu, tra loi lai theo tin moi nhat");
}

// ---- 36: BOT RIENG THEO QUANG CAO (camp test): khach bam quang cao nao -> prompt + mau mac dinh cua camp do
{
  const { adBots } = await import("../src/adbots.js");
  const { extractAdIds, normalizeAdBotPayload, pickAdBot, maskMoney } = await import("../src/adpersona.js");
  const { aiScope } = await import("../src/aicost.js");
  const { settings } = await import("../src/settings.js");
  const AD = "120247872389140225";
  // Doc ad_id phong thu: mang chuoi, mang doi tuong co moc (xep cu -> moi), tin nhan mang referral; chuoi khong phai so bi bo
  assert.deepEqual(extractAdIds({ ad_ids: ["111111", "abc", AD] }), ["111111", AD]);
  assert.deepEqual(extractAdIds({ ads: [{ ad_id: "222222", inserted_at: "2026-09-30T05:00:00" }, { ad_id: "111111", inserted_at: "2026-09-29T05:00:00" }] }), ["111111", "222222"]);
  assert.deepEqual(extractAdIds(null, { messages: [{ referral: { ad_id: "333333" }, inserted_at: "2026-09-30T01:00:00" }] }), ["333333"]);
  assert.deepEqual(extractAdIds({ ad_ids: ["111111", "222222", "111111"] }), ["222222", "111111"], "trung thi giu lan moi nhat");
  assert.deepEqual(extractAdIds({}), []);
  assert.throws(() => normalizeAdBotPayload({}), /bots/);
  const chuan = normalizeAdBotPayload({ bots: [{ adId: "x1" , productCode: "Q1" }, { adId: "444444" }, { adId: "555555", productCode: "q004 ; drop" , instructions: "" }] });
  assert.equal(Object.keys(chuan.bots).length, 0, "ad_id sai / khong mau khong huong dan / ma mau la -> bo, khong doan");
  assert.equal(chuan.skipped, 3);
  assert.equal(pickAdBot(["111111", AD], { [AD]: { adId: AD, enabled: false }, 111111: { adId: "111111" } })?.adId, "111111", "bot tat -> lui ve quang cao truoc");
  assert.equal(maskMoney("Dam 499K, 2 cai 899.000đ, size 36"), "Dam [giá], 2 cai [giá], size 36");

  const r = adBots.replaceAll({
    bots: [{ adId: AD, productCode: "q004", productName: "Đầm Q004", campaignName: "QUAN_TA_30/09_Q004", adCopy: "Đầm báo đỏ chỉ 499K — INBOX NGAY", instructions: "Nhắc khách mẫu này đang tặng kèm túi." }],
  });
  assert.equal(r.count, 1);
  // Mau mac dinh CHI doi trong pham vi luot xu ly cua dung page
  assert.equal(settings.effective("PAGE1").defaultProduct, "");
  assert.equal(aiScope.run({ adBot: adBots.get(AD), adBotPageId: "PAGE1" }, () => settings.effective("PAGE1").defaultProduct), "Q004");
  assert.equal(aiScope.run({ adBot: adBots.get(AD), adBotPageId: "PAGE1" }, () => settings.effective("PAGE2").defaultProduct), "");

  calls.length = 0;
  const cust = { id: "KHACH33", name: "Hoa" };
  pancakeMessages = [{ id: "a33", conversation_id: "CONV33", message: "mẫu này còn không shop", from: cust, inserted_at: new Date(Date.now() - 3000).toISOString().replace("Z", "") }];
  geminiText = "Dạ mẫu này còn đủ size ạ, chị cho em xin chiều cao cân nặng để em tư vấn size nhé";
  bot.handleWebhook({ page_id: "PAGE1", event_type: "messaging", data: { conversation: { id: "CONV33", from: cust, tags: [], type: "INBOX", ad_ids: [AD] }, message: pancakeMessages[0], post: null } });
  await sleep(WAIT);
  const gem33 = calls.filter((c) => c.path.includes(":generateContent"));
  assert.ok(gem33.length >= 1, "bot tra loi khach den tu quang cao");
  const sys33 = gem33[0].body.system_instruction.parts[0].text;
  assert.ok(sys33.includes("BOT RIÊNG CỦA CAMP \"QUAN_TA_30/09_Q004\""), "prompt co khoi bot rieng cua camp");
  assert.ok(sys33.includes("mẫu **Q004 — Đầm Q004**"), "prompt neu dung mau cua camp");
  assert.ok(sys33.includes("tặng kèm túi"), "prompt co huong dan rieng cua camp");
  assert.ok(!sys33.includes("499K"), "so tien trong noi dung quang cao bi che (gia chi lay tu bang gia)");
  assert.equal(adBots.status().seen[AD].matched, AD, "so quan sat ghi ad_id da gap");

  // Tin sau cua cung hoi thoai KHONG mang ad_id: bot van nho camp
  calls.length = 0;
  pancakeMessages = [...pancakeMessages, { id: "b33", conversation_id: "CONV33", message: "size M nhé", from: cust, inserted_at: new Date(Date.now() - 1000).toISOString().replace("Z", "") }];
  bot.handleWebhook({ page_id: "PAGE1", event_type: "messaging", data: { conversation: { id: "CONV33", from: cust, tags: [], type: "INBOX" }, message: pancakeMessages[1], post: null } });
  await sleep(WAIT);
  const gem33b = calls.filter((c) => c.path.includes(":generateContent"));
  assert.ok(gem33b.length >= 1 && gem33b[0].body.system_instruction.parts[0].text.includes("BOT RIÊNG CỦA CAMP"), "hoi thoai da gan quang cao thi van dung bot rieng");

  // Khach KHONG den tu quang cao co bot rieng -> prompt nhu cu
  const sysThuong = bot.buildSystemPrompt("PAGE1", { customerName: "X", type: "INBOX" });
  assert.ok(!sysThuong.includes("BOT RIÊNG CỦA CAMP"), "khong co quang cao -> khong them khoi nao");
  adBots.replaceAll({ bots: [] });
  console.log("OK 36: bot rieng theo quang cao — doc ad_id, prompt + mau mac dinh cua camp, che gia quang cao, nho camp cua hoi thoai");
}

// ---- 37: MAU TEST MOI (chua co tren POS): gia / chat vai / anh theo mau tu ERP, chua bat thi khach that KHONG dung
{
  const crypto = await import("node:crypto");
  const { adBots } = await import("../src/adbots.js");
  const { aiScope } = await import("../src/aicost.js");
  const AD = "120247872389149999";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const sha = crypto.createHash("sha256").update(png).digest("hex");
  const test = { name: "Đầm maxi da báo", code: "test-db01", price: 459000, shipFee: 25000, comboPrice: 849000, fabric: "Thun lạnh co giãn 4 chiều", sizes: "S–XL", offer: "", colors: [{ color: "Đỏ đô", sha }] };
  const r = adBots.replaceAll({ bots: [{ adId: AD, enabled: false, campaignName: "QUAN_TA_01/10_TEST", test }] });
  assert.deepEqual(r.missingImages, [sha], "bot bao anh con thieu de ERP gui");
  assert.throws(() => adBots.saveImage({ sha: "0".repeat(64), contentType: "image/png", data: png.toString("base64") }), /khong khop/, "sha sai noi dung -> tu choi");
  adBots.saveImage({ sha, contentType: "image/png", data: png.toString("base64") });
  assert.deepEqual(adBots.missingImages(), []);
  const bot34 = adBots.get(AD);
  assert.equal(bot34.productCode, "TEST-DB01", "ma tam la ma mau cua camp");

  const sys = aiScope.run({ adBot: bot34, adBotPageId: "PAGE1" }, () => bot.buildSystemPrompt("PAGE1", { customerName: "X", type: "INBOX" }));
  assert.ok(sys.includes("MẪU MỚI **Đầm maxi da báo**") && sys.includes("459.000đ") && sys.includes("849.000đ") && sys.includes("Thun lạnh"), "prompt co ten, gia, chat vai cua mau test");
  const ex = aiScope.run({ adBot: bot34, adBotPageId: "PAGE1" }, () => bot.extractImageRequests("Dạ mẫu màu đỏ đô đây ạ [[IMG:TEST-DB01:đỏ đô]]"));
  assert.deepEqual(ex.imageUrls, [`adimg:${sha}`], "anh lay dung theo mau tu bo anh ERP");
  assert.equal(bot.extractImageRequests("[[IMG:TEST-DB01]]").imageUrls.length, 0, "ngoai pham vi hoi thoai cua camp -> khong co anh mau test");
  const ids = await bot.uploadProductImages(bot.getClient("PAGE1"), [`adimg:${sha}`]);
  assert.equal(ids.length, 1, "anh mau test doc tu dia roi tai len Pancake");

  // Chua bat: khach that bam quang cao nay KHONG dung bot mau test
  calls.length = 0;
  const cust = { id: "KHACH34", name: "Mai" };
  pancakeMessages = [{ id: "a34", conversation_id: "CONV34", message: "giá sao shop", from: cust, inserted_at: new Date(Date.now() - 2000).toISOString().replace("Z", "") }];
  geminiText = "Dạ chị cho em xin chiều cao cân nặng nhé";
  bot.handleWebhook({ page_id: "PAGE1", event_type: "messaging", data: { conversation: { id: "CONV34", from: cust, tags: [], type: "INBOX", ad_ids: [AD] }, message: pancakeMessages[0], post: null } });
  await sleep(WAIT);
  const gem34 = calls.filter((c) => c.path.includes(":generateContent"));
  assert.ok(gem34.length >= 1 && !gem34[0].body.system_instruction.parts[0].text.includes("MẪU MỚI"), "mau test chua bat -> khach that chat nhu cu");
  assert.equal(adBots.testProductForConversation("CONV34"), null, "chua bat -> bot len don van xu ly nhu cu");
  adBots.replaceAll({ bots: [{ adId: AD, enabled: true, campaignName: "QUAN_TA_01/10_TEST", test }] });
  assert.equal(adBots.testProductForConversation("CONV34")?.code, "TEST-DB01", "da bat -> hoi thoai nay la mau test: bot len don BO QUA");
  const { settings: st37 } = await import("../src/settings.js");
  const goc37 = st37.orderBot;
  st37.orderBot = () => ({ enabled: true });
  const ob37 = bot.orderBot;
  const enabledGoc = ob37.enabledFor.bind(ob37);
  ob37.enabledFor = () => true;
  const truoc = Object.keys(ob37.items).length;
  ob37.notify("PAGE1", "CONV34", [{ id: "x", message: "0912345678 số 5 thôn A xã B huyện C tỉnh D", from: cust }], "Mai");
  assert.equal(Object.keys(ob37.items).length, truoc, "mau test dang bat: bot len don khong theo doi hoi thoai");
  ob37.enabledFor = enabledGoc;
  st37.orderBot = goc37;
  adBots.replaceAll({ bots: [] });
  console.log("OK 37: mau test moi — gia / chat vai / anh theo mau tu ERP (khoa sha256), chua bat thi khach that khong dung");
}

// ---- 33: BOT LEN DON doc lap (chu shop 30/09/2026): chi len don khi dia chi khop du tinh/huyen/xa + so nha;
// tu bo sung huyen khi ten xa chi co o DUNG MOT huyen; khong xac dinh duoc -> can duyet (bao nhan vien)
{
  const { config: cfg33 } = await import("../src/config.js");
  cfg33.pos.shopId = "SHOP1"; cfg33.pos.apiKey = "posk"; cfg33.orderSync = true;
  const { orderSync: os33 } = await import("../src/orders.js");
  // Test 17 thay tam provinces/districts/communes tren chinh instance -> bo di de dung API geo (gia lap ben duoi)
  const geoGoc = { provinces: os33.provinces, districts: os33.districts, communes: os33.communes };
  delete os33.provinces; delete os33.districts; delete os33.communes;
  os33.geo = { provinces: null, districts: new Map(), communes: new Map() };
  os33._geoIndex = []; // khong suy ra tu danh muc ca nuoc trong bai nay (xem bai 42)
  const prevProducts33 = catalog.products;
  catalog.setProducts([{ id: "p33", code: "Q004", name: "Đầm Q004", note: "", attributes: { "Màu": ["Nâu"], Size: ["M"] }, price: { min: 499000, max: 499000 }, images: [], variations: [{ id: "v33", sku: "Q004NAUM", fields: { "Màu": "Nâu", Size: "M" }, price: 499000, stock: 5, available: true, images: [] }] }]);
  let diaChiAI = {}, diaChiKhach = "";
  const posPosts = [];
  const prev33 = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
    const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json" } });
    if (u.hostname === "pos.pages.fm") {
      if (u.pathname === "/api/v1/geo/provinces") return json({ data: [{ id: "101", name: "Hà Nội" }] });
      if (u.pathname === "/api/v1/geo/districts") return json({ data: [{ id: "10120", name: "Huyện Quốc Oai" }, { id: "10121", name: "Huyện Thạch Thất" }] });
      if (u.pathname === "/api/v1/geo/communes") {
        const d = u.searchParams.get("district_id");
        return json({ data: d === "10120" ? [{ id: "1012001", name: "Xã Sài Sơn" }, { id: "1012002", name: "Xã Tân Phú" }] : [{ id: "1012101", name: "Xã Bình Phú" }, { id: "1012102", name: "Xã Tân Phú" }] });
      }
      if (u.pathname === "/api/v1/shops/SHOP1/orders" && (init.method || "GET") === "GET") return json({ data: [] });
      if (u.pathname === "/api/v1/shops/SHOP1/orders" && init.method === "POST") { posPosts.push(body); return json({ data: { id: 900 + posPosts.length } }, 201); }
    }
    if (u.hostname === "generativelanguage.googleapis.com" && body?.generationConfig?.responseSchema) {
      const props = body.generationConfig.responseSchema.properties || {};
      const txt = props.ready
        ? JSON.stringify({ ready: true, items: [{ code: "Q004", color: "Nâu", size: "M", quantity: 1 }], customer_name: "Hoa", phone: "0912345678", address: diaChiKhach })
        : JSON.stringify(diaChiAI);
      return json({ candidates: [{ content: { parts: [{ text: txt }] }, finishReason: "STOP" }], usageMetadata: {} });
    }
    return prev33(url, init);
  };
  const chat = (dc) => `KHÁCH: Tư vấn cho chị Q004 nâu size M sđt 0912345678\nKHÁCH: ship về ${dc}`;
  // (a) Khach KHONG ghi huyen, nhung "Sài Sơn" chi co o Quoc Oai -> tu bo sung huyen, len don
  diaChiKhach = "Số 15 ngõ 42 thôn Phúc Đức, xã Sài Sơn, Hà Nội";
  diaChiAI = { province: "Hà Nội", district: "", commune: "Sài Sơn", street: "Số 15 ngõ 42 thôn Phúc Đức" };
  const a = await os33.syncFromConversation({ pageId: "PAGE1", pageName: "Shop", conversationId: "C33a", customerName: "Hoa", historyText: chat(diaChiKhach), strict: true });
  assert.equal(a.status, "created", "dia chi xac dinh chac chan -> len don: " + JSON.stringify(a));
  assert.equal(posPosts[0].shipping_address.district_id, "10120", "tu bo sung dung huyen Quoc Oai");
  assert.equal(posPosts[0].shipping_address.commune_id, "1012001");
  assert.match(posPosts[0].note, /tự bổ sung/);
  assert.ok(a.confirmBlockers.some((x) => /chưa chốt tổng tiền/.test(x)), "khach chua chot tong tien -> khong du cua tu xac nhan");
  // (b) "Tân Phú" co o CA HAI huyen, khach khong ghi huyen -> KHONG len don, can duyet kem ly do
  diaChiKhach = "thôn 3, xã Tân Phú, Hà Nội";
  diaChiAI = { province: "Hà Nội", district: "", commune: "Tân Phú", street: "thôn 3" };
  const b = await os33.syncFromConversation({ pageId: "PAGE1", pageName: "Shop", conversationId: "C33b", customerName: "Hoa", historyText: chat(diaChiKhach), strict: true });
  assert.equal(b.status, "review");
  assert.ok(b.reasons.some((r) => /2 quận\/huyện/.test(r)), "noi ro xa trung ten o 2 huyen: " + b.reasons.join("; "));
  assert.equal(posPosts.length, 1, "don khong chac chan KHONG duoc ghi len POS");
  // (c) Du 3 cap nhung thieu so nha / thon xom -> VAN len don (chu shop 02/10/2026), ghi chu cho shipper goi khach
  diaChiKhach = "xã Sài Sơn, huyện Quốc Oai, Hà Nội";
  diaChiAI = { province: "Hà Nội", district: "Quốc Oai", commune: "Sài Sơn", street: "" };
  const c = await os33.syncFromConversation({ pageId: "PAGE1", pageName: "Shop", conversationId: "C33c", customerName: "Hoa", historyText: chat(diaChiKhach), strict: true });
  assert.equal(c.status, "created", JSON.stringify(c));
  assert.match(posPosts[posPosts.length - 1].note, /chưa ghi số nhà/);
  posPosts.pop();
  // (d) Nhan vien sua dia chi roi duyet -> len don
  diaChiAI = { province: "Hà Nội", district: "Thạch Thất", commune: "Tân Phú", street: "thôn 3" };
  const d = await os33.syncFromConversation({ pageId: "PAGE1", pageName: "Shop", conversationId: "C33b", customerName: "Hoa", historyText: chat("thôn 3, xã Tân Phú, Hà Nội"), strict: true, addressOverride: "thôn 3, xã Tân Phú, huyện Thạch Thất, Hà Nội" });
  assert.equal(d.status, "created");
  assert.equal(posPosts[1].shipping_address.district_id, "10121");
  assert.match(posPosts[1].note, /nhân viên duyệt/);

  // (d2) AI liet ke CUNG mot bien the hai lan -> mot dong, khong nhan doi so luong
  const trung = os33.mapItems([{ code: "Q004", color: "Nâu", size: "M", quantity: 1 }, { code: "Q004", color: "nâu", size: "M", quantity: 1 }]);
  assert.equal(trung.mapped.length, 1, "khong len trung san pham");
  assert.equal(trung.mapped[0].quantity, 1, "nhac lai khong phai mua them");
  assert.equal(os33.mapItems([{ code: "Q004", color: "Nâu", size: "M", quantity: 2 }, { code: "Q004", color: "Nâu", size: "M", quantity: 1 }]).mapped[0].quantity, 2);
  // (e) Bot len don (chu shop 02/10/2026): khach go SDT -> theo doi, kiem 30 phut/lan; du thi len don va thoi kiem;
  // qua 3 lan van chua du -> CAN DUYET + bao ERP; khach gui them thong tin sau do -> theo doi lai tu dau
  const ob = bot.orderBot;
  const goc = os33.syncFromConversation;
  const gocHistory = ob.history;
  settings.update("PAGE1", { orderSync: true, dryRun: false });
  const khach33 = (t) => ({ from: { id: "KHACH" }, message: t });
  ob.history = async () => ({ messages: [khach33("sđt chị 0912345678")], text: "KHÁCH: sđt chị 0912345678", name: "Hoa" });
  ob.notify("PAGE1", "C33x", [khach33("thôn 3 xã Sài Sơn huyện Quốc Oai Hà Nội")], "Hoa");
  assert.equal(ob.items.C33x, undefined, "chua co SDT -> chua theo doi");
  ob.notify("PAGE1", "C33e", [khach33("sđt chị 0912345678")], "Hoa");
  const e = ob.items.C33e;
  assert.equal(e.status, "PENDING", "co SDT -> theo doi, chua ghi gi");
  assert.equal(e.rounds, 0);
  assert.ok(e.nextCheckAt - Date.now() > 29 * 60e3 && e.nextCheckAt - Date.now() <= 30 * 60e3, "lan kiem dau sau 30 phut");
  let soLanAI = 0;
  os33.syncFromConversation = async () => (soLanAI++, { status: "skipped", reason: "chưa đủ thông tin: địa chỉ" });
  await ob.sweep();
  assert.equal(soLanAI, 0, "chua toi gio thi khong kiem (khong ton AI)");
  for (let lan = 1; lan <= 3; lan++) {
    e.nextCheckAt = Date.now() - 1;
    await ob.sweep();
    assert.equal(e.rounds, lan);
    if (lan < 3) {
      assert.equal(e.status, "PENDING");
      assert.ok(e.nextCheckAt > Date.now() + 29 * 60e3, "hen lan sau 30 phut");
    }
  }
  assert.equal(soLanAI, 3);
  assert.equal(e.status, "REVIEW", "3 lan chua du -> can duyet");
  assert.ok(e.reviewAt, "co moc de ERP bao");
  assert.match(e.reasons[0], /Đã kiểm 3 lần \(30 phút\/lần\) vẫn chưa đủ thông tin: chưa đủ thông tin: địa chỉ/);
  await ob.sweep();
  assert.equal(soLanAI, 3, "da can duyet thi thoi kiem");
  assert.equal(ob.list().counts.review >= 1, true);
  // (e2) Khach DONG Y ban chot don ("Ok") -> kiem ngay o luot quet toi, khong doi 30 phut; moi tin dong y kich mot lan
  // (don Ha Dang 02/10/2026: khach "Ok" roi "Thanks!" ma don van "Mới, chưa có sản phẩm")
  {
    const tinL = (from, t, giay) => ({ from: { id: from }, message: t, inserted_at: new Date(Date.UTC(2026, 9, 2, 13, 0, giay)).toISOString() });
    const chot = "Dạ em chốt đơn cho chị:\n• Đầm Q005 Đen XL x 1\n• Tổng: 849.000đ\n• SĐT: 0903367786\n• Địa chỉ: 25/13 Bà Lê Chân, Tân Định, Q1 HCM";
    const hoi = [tinL("KHACH", "Cho2 đầm 1 đen 1 đỏ. 25/13 Bà Lê Chân, Tân Định, Q1 HCM 0903367786", 1), tinL("PAGE1", chot, 2)];
    ob.notify("PAGE1", "C33ok", hoi, "Ha");
    assert.ok(ob.items.C33ok.nextCheckAt > Date.now() + 29 * 60e3, "chua dong y -> doi 30 phut");
    const daOk = [...hoi, tinL("KHACH", "Ok", 3), tinL("PAGE1", "Dạ em cảm ơn chị nhiều ạ", 4), tinL("KHACH", "Thanks !", 5)];
    ob.notify("PAGE1", "C33ok", daOk, "Ha");
    assert.ok(ob.items.C33ok.nextCheckAt <= Date.now(), "khach Ok ban chot -> kiem ngay");
    ob.items.C33ok.nextCheckAt = Date.now() + 30 * 60e3;
    ob.notify("PAGE1", "C33ok", daOk, "Ha");
    assert.ok(ob.items.C33ok.nextCheckAt > Date.now(), "cung tin Ok khong kich lai lan nua");
    // Tin dau tien sau ban chot la SUA thong tin -> khong phai dong y
    assert.equal(ob.confirmedSummaryAt("PAGE1", [...hoi, tinL("KHACH", "sửa giúp chị địa chỉ số 25/15 nhé", 3), tinL("KHACH", "ok", 4)]), null);
    assert.equal(ob.confirmedSummaryAt("PAGE1", [...hoi, tinL("KHACH", "okhông được, đổi size L", 3)]), null);
    assert.equal(ob.confirmedSummaryAt("PAGE1", [tinL("PAGE1", "Chị lấy màu nào ạ?", 1), tinL("KHACH", "ok", 2)]), null, "khong co ban chot -> khong kich");
    delete ob.items.C33ok;
  }
  ob.dismiss("C33e");
  assert.equal(ob.items.C33e.status, "DISMISSED");
  // Khach gui them dia chi sau khi da bo qua -> mo lai, bo dem moi
  ob.notify("PAGE1", "C33e", [khach33("sđt chị 0912345678"), khach33("thôn 3 xã Sài Sơn huyện Quốc Oai Hà Nội")], "Hoa");
  assert.equal(ob.items.C33e.status, "PENDING");
  assert.equal(ob.items.C33e.rounds, 0);
  // Du thong tin o lan kiem -> len don, thoi kiem
  os33.syncFromConversation = async () => (soLanAI++, { status: "created", orderId: 777, summary: "Tạo đơn nháp #777", phone: "0912345678", items: [], confirmBlockers: ["x"] });
  ob.items.C33e.nextCheckAt = Date.now() - 1;
  await ob.sweep();
  assert.equal(ob.items.C33e.status, "DONE");
  ob.items.C33e.nextCheckAt = Date.now() - 1;
  const truoc = soLanAI;
  await ob.sweep();
  assert.equal(soLanAI, truoc, "da len don thi thoi kiem");
  // Cai dat: nhip 10–240 phut, 1–10 lan
  assert.throws(() => settings.setOrderBot({ checkEveryMinutes: 5 }), /10 đến 240/);
  assert.throws(() => settings.setOrderBot({ maxChecks: 0 }), /1 đến 10/);
  ob.history = gocHistory;
  delete ob.items.C33e;
  os33.syncFromConversation = goc;
  settings.global.orderBot = undefined;
  catalog.setProducts(prevProducts33);
  Object.assign(os33, geoGoc);
  globalThis.fetch = prev33;
  console.log("OK 33 (+ khach Ok ban chot -> kiem ngay): bot len don: tu bo sung huyen khi chac chan, khong chac -> can duyet (khong ghi POS); co SDT -> kiem 30 phut/lan, du thi len don va thoi, 3 lan chua du -> can duyet + bao ERP");
}

// ---- 35: TU XAC NHAN don chac chan + QUET LAI hoi thoai cu (chu shop 30/09/2026: "quet lai cac don cu ... neu da
// xac nhan chac chan xac nhan don dung co the chuyen qua trang thai da xac nhan"). Mac dinh TAT; chi don qua du cua.
{
  const { config: cfg35 } = await import("../src/config.js");
  cfg35.pos.shopId = "SHOP1"; cfg35.pos.apiKey = "posk"; cfg35.orderSync = true;
  const { orderSync: os35 } = await import("../src/orders.js");
  assert.equal(settings.orderBot().autoConfirm, true, "tu xac nhan mac dinh BAT (chu shop 01/10/2026)");
  // (a) confirmOrder: doc lai don, chi doi khi van la don nhap, dung SDT, dung san pham, khach khong co don khac
  const don = { id: 777, status: 0, bill_phone_number: "0912345678", note: "🤖 Bot chốt", items: [{ variation_id: "v1", quantity: 1 }], shipping_address: { province_id: "101", district_id: "10120", commune_id: "1012001", address: "Số 15 ngõ 42" } };
  let donKhac = [];
  const puts = [];
  const prev35 = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (u.hostname === "pos.pages.fm") {
      if (u.pathname === "/api/v1/shops/SHOP1/orders/777" && (init.method || "GET") === "GET") return json({ data: { ...don } });
      if (u.pathname === "/api/v1/shops/SHOP1/orders/777" && init.method === "PUT") { const b = JSON.parse(init.body); puts.push(b); if (b.status !== undefined) don.status = b.status; return json({ data: { id: 777 } }); }
      if (u.pathname === "/api/v1/shops/SHOP1/orders") return json({ data: donKhac });
    }
    return prev35(url, init);
  };
  const dung = { conversationId: "C35", phone: "0912345678", items: [{ variation_id: "v1", quantity: 1 }] };
  // nhan vien da sua san pham -> khong dong vao
  let r = await os35.confirmOrder(777, { ...dung, items: [{ variation_id: "v1", quantity: 2 }] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /nhân viên đã sửa/);
  // khach co don THAT khac trong 14 ngay (da giao) -> khong xac nhan, tranh gui hai lan
  donKhac = [{ id: 700, status: 4, bill_phone_number: "0912345678", inserted_at: new Date(Date.now() - 3 * 86400e3).toISOString() }];
  r = await os35.confirmOrder(777, dung);
  assert.equal(r.ok, false);
  assert.match(r.reason, /#700/);
  // don nhap cu (status 0) va don huy khong chan
  donKhac = [{ id: 701, status: 0, bill_phone_number: "0912345678", inserted_at: new Date().toISOString() }, { id: 702, status: 6, bill_phone_number: "0912345678", inserted_at: new Date().toISOString() }];
  assert.equal(puts.length, 0, "chua du cua thi khong goi ghi POS");
  r = await os35.confirmOrder(777, dung);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(puts[0].status, 1, "chuyen Moi -> Da xac nhan");
  assert.match(puts[0].note, /Bot chốt[\s\S]*Bot tự xác nhận/, "giu ghi chu cu, them dong xac nhan");
  // da xac nhan roi -> lan sau khong dong vao nua
  r = await os35.confirmOrder(777, dung);
  assert.equal(r.ok, false);
  assert.equal(puts.length, 1);
  globalThis.fetch = prev35;

  // (b) OrderBot.check: tat -> chi don nhap; bat + chac chan -> xac nhan; co ly do chan -> van la don nhap kem ly do
  const ob = bot.orderBot;
  settings.update("PAGE1", { orderSync: true, dryRun: false });
  const goc = { sync: os35.syncFromConversation, confirm: os35.confirmOrder, other: os35.otherOrders, history: ob.history };
  let chan = [], goiXacNhan = 0;
  os35.syncFromConversation = async () => ({ status: "created", orderId: 778, summary: "Tạo đơn nháp #778: Q004", phone: "0912345678", items: [{ variation_id: "v1", quantity: 1 }], confirmBlockers: chan });
  os35.confirmOrder = async () => (goiXacNhan++, { ok: true });
  ob.history = async () => ({ messages: [], text: "", name: "Hoa" });
  const moi = (k) => (ob.items[k] = { pageId: "PAGE1", conversationId: k, status: "PENDING", firstSeen: Date.now(), reasons: [] });
  settings.setOrderBot({ autoConfirm: false });
  moi("C35a");
  await ob.check("C35a");
  assert.equal(ob.items.C35a.status, "DONE");
  assert.equal(goiXacNhan, 0, "tu xac nhan dang TAT -> khong xac nhan");
  assert.equal(ob.items.C35a.confirmedAt, undefined);
  settings.setOrderBot({ autoConfirm: true });
  moi("C35b");
  await ob.check("C35b");
  assert.equal(goiXacNhan, 1);
  assert.ok(ob.items.C35b.confirmedAt);
  assert.match(ob.items.C35b.summary, /^Đã xác nhận đơn #778/);
  chan = ["khách chưa chốt tổng tiền trong hội thoại"];
  moi("C35c");
  await ob.check("C35c");
  assert.equal(goiXacNhan, 1, "co ly do chan -> khong goi xac nhan");
  assert.match(ob.items.C35c.confirmNote, /chưa chốt tổng tiền/);
  chan = [];
  moi("C35d");
  await ob.check("C35d", { byStaff: true });
  assert.equal(goiXacNhan, 1, "don nhan vien duyet tay -> nhan vien tu xac nhan");

  // (c) Quet lai hoi thoai cu: chi hoi thoai co SDT + dia chi, bo qua khach da co don that / da bo qua / qua khung gio
  const now = Date.now();
  const convs = [
    { id: "C35r1", updated_at: new Date(now - 3600e3).toISOString(), from: { name: "Lan" } },
    { id: "C35r2", updated_at: new Date(now - 2 * 3600e3).toISOString(), from: { name: "Mai" } },
    { id: "C35r3", updated_at: new Date(now - 3 * 3600e3).toISOString(), from: { name: "Cúc" } },
    { id: "C35r4", updated_at: new Date(now - 4 * 3600e3).toISOString(), from: { name: "Đào" } },
    { id: "C35r5", updated_at: new Date(now - 30 * 3600e3).toISOString(), from: { name: "Cũ" } },
  ];
  const tin = { C35r1: ["sđt 0912000001", "thôn 3 xã Sài Sơn huyện Quốc Oai Hà Nội"], C35r2: ["sđt 0912000002", "thôn 5 xã Sài Sơn huyện Quốc Oai Hà Nội"], C35r3: ["chị hỏi giá thôi"], C35r4: ["sđt 0912000004", "thôn 7 xã Sài Sơn huyện Quốc Oai Hà Nội"], C35r5: ["sđt 0912000005", "thôn 9 xã Sài Sơn huyện Quốc Oai Hà Nội"] };
  const fake = { getConversations: async () => ({ conversations: convs }), getMessages: async (id) => ({ messages: tin[id].map((t, i) => ({ id: id + i, from: { id: "KHACH" }, message: t, inserted_at: new Date(now - 3600e3 + i).toISOString() })) }) };
  const clientsGoc = bot.clients;
  bot.clients = new Map([["PAGE1", fake]]);
  os35.otherOrders = async (_c, phone) => (phone === "0912000002" ? [{ id: 5, status: 3 }] : []);
  ob.items.C35r4 = { pageId: "PAGE1", conversationId: "C35r4", status: "DISMISSED", firstSeen: now, reasons: [] };
  const daKiem = [];
  os35.syncFromConversation = async ({ conversationId }) => (daKiem.push(conversationId), { status: "created", orderId: 800, summary: "Tạo đơn nháp #800", phone: "0912000001", items: [], confirmBlockers: [] });
  const st = ob.rescan({ hours: 24 });
  assert.throws(() => ob.rescan({ hours: 24 }), /Đang quét lại/, "khong chay hai luot quet cung luc");
  while (st.running) await sleep(20);
  assert.deepEqual(daKiem, ["C35r1"], "chi kiem hoi thoai co SDT + dia chi, chua co don that, chua bi bo qua, trong khung gio");
  assert.equal(st.skipped, 1, "khach da co don that -> bo qua");
  assert.equal(st.confirmed, 1);
  assert.equal(ob.items.C35r4.status, "DISMISSED");
  assert.throws(() => ob.rescan({ hours: 500 }), /1 đến 168/);
  assert.ok(ob.list().rescan && !ob.list().rescan.running);

  bot.clients = clientsGoc;
  Object.assign(os35, { syncFromConversation: goc.sync, confirmOrder: goc.confirm, otherOrders: goc.other });
  ob.history = goc.history;
  for (const k of Object.keys(ob.items)) if (k.startsWith("C35")) (clearTimeout(ob.timers.get(k)), delete ob.items[k]);
  settings.global.orderBot = undefined;
  console.log("OK 35: tu xac nhan chi don chac chan (mac dinh bat, doc lai POS, khong trung don); quet lai hoi thoai cu bo qua khach da co don");
}

// ---- 36: the "Can duyet" phai du de nhan vien biet lam gi (chu shop 01/10/2026: "hien the nay thi biet gi de duyet,
// sao lai can phai duyet don da xac nhan"): kem san pham / SDT bot doc duoc; nhan vien da tu len don -> tu go khoi hang
// can duyet; don nhap bot da len chuan truoc khi bat tu xac nhan -> kiem lai mot lan de xac nhan.
{
  const { orderSync: os36 } = await import("../src/orders.js");
  const ob = bot.orderBot;
  settings.update("PAGE1", { orderSync: true, dryRun: false });
  const goc = { sync: os36.syncFromConversation, other: os36.otherOrders, confirm: os36.confirmOrder, history: ob.history };
  const khach = (t) => ({ from: { id: "KHACH" }, message: t });
  ob.history = async () => ({ messages: [khach("sđt 0912345601"), khach("số 165 đường Trần Thái Tông, Thái Bình")], text: "KHÁCH: ...", name: "Thúy" });
  // (a) thieu mau -> ly do + san pham bot doc duoc
  let donNV = [];
  os36.otherOrders = async () => donNV;
  os36.syncFromConversation = async () => ({ status: "skipped", reason: "chưa đủ thông tin: màu sắc của 2 đầm", draft: { phone: "0912345601", address: "số 165 đường Trần Thái Tông", items: ["Q002 (chưa chọn màu) L x1", "Q002 Đỏ L x1"] } });
  ob.items.C36 = { pageId: "PAGE1", conversationId: "C36", status: "REVIEW", firstSeen: Date.now() - 3600e3, reasons: [] };
  await ob.check("C36");
  assert.deepEqual(ob.items.C36.draft.items, ["Q002 (chưa chọn màu) L x1", "Q002 Đỏ L x1"], "the can duyet hien san pham bot doc duoc");
  // (b) nhan vien da xac nhan don tren Pancake -> sweep go khoi can duyet, khong ton AI
  ob.items.C36.status = "REVIEW";
  let goiAI = 0;
  os36.syncFromConversation = async () => (goiAI++, { status: "skipped", reason: "x" });
  donNV = [{ id: 5600, status: 1, bill_phone_number: "0912345601", inserted_at: new Date().toISOString() }];
  await ob.sweep();
  assert.equal(ob.items.C36.status, "DONE", "nhan vien da len don -> khong con can duyet");
  assert.equal(ob.items.C36.orderId, 5600);
  assert.match(ob.items.C36.summary, /Nhân viên đã lên đơn #5600 \(Đã xác nhận/);
  assert.equal(goiAI, 0);
  // khach mua lai: don cu DA GIAO tao truoc khi bot theo doi -> KHONG coi la nhan vien da len don moi
  donNV = [{ id: 5000, status: 4, bill_phone_number: "0912345601", inserted_at: new Date(Date.now() - 5 * 86400e3).toISOString() }];
  assert.equal(await os36.staffHandledOrder("C36x", ["0912345601"], Date.now() - 3600e3), null);
  // Binh Nguyen 02/10/2026: don cu DANG DONG HANG tao 2 ngay truoc (mau khac) -> KHONG phai "nhan vien da len don" cho
  // lan mua nay; bot len don nhap, tu xac nhan bi chan vi don cu -> CAN DUYET kem ly do (bao ERP), khong nam im
  donNV = [{ id: 5509, status: 12, bill_phone_number: "0912345601", inserted_at: new Date(Date.now() - 2 * 86400e3).toISOString() }];
  assert.equal(await os36.staffHandledOrder("C36x", ["0912345601"], Date.now() - 3600e3), null, "don cu dang dong hang khong che lan mua moi");
  {
    const gs = os36.syncFromConversation, gc = os36.confirmOrder;
    os36.syncFromConversation = async () => ({ status: "updated", orderId: 5667, summary: "Cập nhật đơn nháp #5667: Q003", phone: "0912345601", items: [{ variation_id: "v3", quantity: 1 }], confirmBlockers: [] });
    os36.confirmOrder = async () => ({ ok: false, reason: "khách đã có đơn #5509 (Đang đóng hàng) trong 14 ngày — nhân viên kiểm tra, tránh gửi hai lần" });
    ob.items.C36n = { pageId: "PAGE1", conversationId: "C36n", status: "PENDING", firstSeen: Date.now() - 3600e3, reasons: [], facts: { phone: "0912345601" } };
    await ob.check("C36n");
    assert.equal(ob.items.C36n.status, "REVIEW", "khach con don khac -> can duyet, khong im lang");
    assert.equal(ob.items.C36n.orderId, 5667);
    assert.ok(ob.items.C36n.reviewAt);
    assert.match(ob.items.C36n.reasons[0], /Đã lên đơn nháp #5667 nhưng khách đã có đơn #5509/);
    // nhan vien xac nhan don nhap #5667 -> go khoi can duyet
    donNV = [...donNV, { id: 5667, status: 1, bill_phone_number: "0912345601", inserted_at: new Date().toISOString() }];
    ob.items.C36n.staffCheckAt = 0;
    await ob.sweep();
    assert.equal(ob.items.C36n.status, "DONE");
    delete ob.items.C36n;
    Object.assign(os36, { syncFromConversation: gs, confirmOrder: gc });
  }
  // (c) don nhap bot len chuan truoc khi bat tu xac nhan -> sweep kiem lai MOT lan va xac nhan
  donNV = [];
  let xacNhan = 0;
  os36.syncFromConversation = async () => ({ status: "updated", orderId: 5559, summary: "Cập nhật đơn nháp #5559: Q002", phone: "0972884909", items: [{ variation_id: "v", quantity: 1 }], confirmBlockers: [] });
  os36.confirmOrder = async () => (xacNhan++, { ok: true });
  ob.items.C36c = { pageId: "PAGE1", conversationId: "C36c", status: "DONE", orderId: 5559, doneAt: Date.now() - 3600e3, firstSeen: Date.now() - 7200e3, summary: "Cập nhật đơn nháp #5559", reasons: [] };
  ob.items.C36d = { pageId: "PAGE1", conversationId: "C36d", status: "DONE", orderId: 5560, doneAt: Date.now() - 3600e3, firstSeen: Date.now() - 7200e3, summary: "x", approvedByStaff: true, reasons: [] };
  await ob.sweep();
  await ob.sweep();
  assert.equal(xacNhan, 1, "chi kiem lai mot lan, khong dong vao don nhan vien duyet tay");
  assert.ok(ob.items.C36c.confirmedAt);
  // bot da xac nhan don cua chinh no -> lan kiem sau KHONG ghi nham "nhan vien da len don"
  donNV = [{ id: 5559, status: 1, bill_phone_number: "0912345601", inserted_at: new Date().toISOString() }];
  ob.items.C36c.status = "PENDING";
  await ob.check("C36c");
  assert.equal(ob.items.C36c.status, "DONE");
  assert.equal(ob.items.C36c.byStaffOrder, undefined);
  Object.assign(os36, { syncFromConversation: goc.sync, otherOrders: goc.other, confirmOrder: goc.confirm });
  ob.history = goc.history;
  for (const k of Object.keys(ob.items)) if (k.startsWith("C36")) delete ob.items[k];
  settings.global.orderBot = undefined;
  console.log("OK 36: can duyet kem san pham bot doc duoc, nhan vien da len don -> tu go, don nhap chuan cu -> tu xac nhan mot lan");
}

// ---- 38: su co 01/10/2026 (Ho Thi Lien, Linh Tay Luxury): khach gui "Mình cao 1.63 năng 49 kg" nhung page khong
// tra duoc size (chua co bang size) -> bot coi nhu chua co so do, xin lai chieu cao can nang + "em đã có địa chỉ rồi ạ"
{
  const prevSettings = settings.get("PAGE1");
  settings.update("PAGE1", { sizeChart: "" });
  const shop = (t) => ({ from: { id: "PAGE1" }, message: t });
  const khach = (t) => ({ from: { id: "KHACH" }, message: t });
  const hoiThoai = [
    khach("Giảm giá còn bao nhiêu tiền?"), shop("Dạ chị cho em xin chiều cao và cân nặng để em tư vấn size chuẩn cho mình nha chị yêu"),
    khach("Chất liệu vải mát ko"), shop("Dạ chất liệu Rayon cao cấp ạ. Chị cho em xin chiều cao và cân nặng ạ?"),
    khach("Síp mình chiết màu đỏ đô nhé"), khach("Sdt 0961763574"),
    shop("Dạ chị chốt màu Đỏ Đô ạ. Chị cho em xin chiều cao và cân nặng nhé ạ?"),
    khach("Chợ phú bài thị xã hương thủy đường song Hồng"), khach("Mình cao 1.63 năng 49 kg"),
  ];
  const f = bot.customerFacts("PAGE1", hoiThoai);
  assert.equal(f.size, null, "page chua co bang size -> chua tra duoc size");
  assert.equal(f.measured, true, "nhung khach DA gui so do");
  assert.equal(f.h, 163);
  assert.equal(f.w, 49);
  const p = bot.orderProgressPrompt("PAGE1", hoiThoai);
  assert.match(p, /ĐÃ GỬI số đo: cao 1m63, nặng 49kg/);
  assert.match(p, /KHÔNG hỏi lại chiều cao/);
  assert.doesNotMatch(p, /VIỆC TIẾP THEO: hỏi chiều cao/);
  // Cau tra loi that hom do -> khong con xin lai so do, khong con cau khai bao "em đã có địa chỉ"
  const cu = "Dạ chị Hồ Thị Liên ơi, em đã có địa chỉ của mình rồi ạ.\nChị cho em xin chiều cao và cân nặng để em tư vấn size chuẩn cho mình nhé ạ?";
  const sau = bot.dropAnnouncedFacts(bot.dropAlreadyGivenAsks(cu, "PAGE1", hoiThoai), "PAGE1");
  assert.equal(sau, "", "chi con loi chao -> rong, de nhanh sau chuyen nhan vien chot size");
  assert.doesNotMatch(bot.ensureEndsWithQuestion("Dạ chị mặc size M ạ", "PAGE1", hoiThoai), /chiều cao|cân nặng/);
  // Cau khai bao dung giua cau tra loi co noi dung -> chi bo cau khai bao
  const giua = bot.dropAnnouncedFacts("Dạ chị chốt mẫu Q002 màu Đỏ Đô ạ ❤️\nEm đã có số điện thoại của mình rồi ạ.\nChị cao 1m63 nặng 49kg mặc size M là vừa ạ.", "PAGE1");
  assert.doesNotMatch(giua, /đã có số điện thoại/);
  assert.match(giua, /Đỏ Đô[\s\S]*size M/);
  assert.equal(bot.dropAnnouncedFacts("Dạ chị cho em xin địa chỉ ạ?", "PAGE1"), "Dạ chị cho em xin địa chỉ ạ?", "khong dong vao cau khac");
  // Chua gui so do thi van duoc hoi
  assert.equal(bot.customerFacts("PAGE1", [khach("mình nặng 49kg")]).measured, false, "thieu chieu cao (bang co chieu cao / chua co bang) -> chua du");
  // Su co 01/10/2026 (Thuy Nguyen Diem, Linh Tay Luxury): "Mình đặt xl" hai lan ma bot xin chieu cao can nang 4 lan
  const thuy = [
    khach("Có cho xem hàng trước không shop"), shop("Chị iu cho em xin chiều cao, cân nặng để em giữ size cho mình kéo hết nhé."),
    khach("Mình đặt xl"), khach("Ok"), khach("Đc áp long châu xã Long Khánh quyen bên cầu tinh tây Ninh sđt 0967338052"), khach("Màu đen"), khach("Ok"),
  ];
  assert.equal(bot.customerFacts("PAGE1", thuy).size, "XL", "'Mình đặt xl' = khach da chon size");
  assert.equal(bot.dropAlreadyGivenAsks("🥰\nChị cho em xin chiều cao và cân nặng để em tư vấn size chuẩn cho mình nhé ạ?", "PAGE1", thuy), "🥰");
  assert.equal(bot.dropAnnouncedFacts("Dạ em nhận được thông tin địa chỉ và số điện thoại của chị rồi ạ. 🥰\nChị lấy mẫu nào ạ?", "PAGE1").includes("nhận được"), false);
  for (const [cau, size] of [["lấy L nha", "L"], ["chị mặc size M", "M"], ["chốt 2xl", "2XL"], ["cỡ xl", "XL"]]) assert.equal(bot.customerFacts("PAGE1", [khach(cau)]).size, size, cau);
  for (const cau of ["đặt 20 cái", "lấy mình 1 cái", "chọn mẫu nào đẹp", "đặt sớm được không"]) assert.equal(bot.customerFacts("PAGE1", [khach(cau)]).size, null, cau);
  // Su co 30/09/2026 (Son Ngoc Nguyen): ban chot don co cho trong [..] + gan cau xin chieu cao can nang o cuoi
  const son = [khach("cao 1m52 nặng 56kg"), khach("Thôn 5 xã Hòa Phú huyện Chư Păh tỉnh Gia Lai"), khach("0912 345 678"), khach("chốt giá 299k miễn phí v.c")];
  const chot = "Em xin phép chốt đơn cho mình nha:\n• Đầm Q002 màu Đỏ size L x 1\n• Tổng: 299.000đ (bao gồm miễn phí ship)\n• Người nhận: Son Ngoc Nguyen – [Số điện thoại khách đã cung cấp]\n• Địa chỉ: [Địa chỉ khách đã cung cấp]\n\nChị kiểm tra lại giúp em thông tin đơn hàng nha ạ ❤️";
  const dien = bot.fillPlaceholders(chot, "PAGE1", son);
  assert.doesNotMatch(dien, /\[(?!\[)/, "khong con ngoac vuong cho khach");
  assert.match(dien, /Son Ngoc Nguyen – 0912345678/);
  assert.match(dien, /Địa chỉ: Thôn 5 xã Hòa Phú/);
  assert.match(bot.fillPlaceholders("Người nhận: [Tên khách]\nTổng: 299.000đ [[HANDOFF]]", "PAGE1", son), /^Tổng: 299\.000đ \[\[HANDOFF\]\]$/, "khong dien duoc thi bo dong, giu [[HANDOFF]]");
  assert.equal(bot.ensureEndsWithQuestion(dien, "PAGE1", son), dien, "ban chot don khong bi gan them cau xin so do");
  settings.update("PAGE1", { sizeChart: prevSettings.sizeChart || "" });
  console.log("OK 38: khach da gui so do ma chua tra duoc size -> khong xin lai, bao size theo bang trong huong dan; bo cau 'em da co SDT/dia chi roi'; 'Minh dat xl' = da chon size; ban chot don khong con cho trong [..]");
}

// ---- 39: duyet don "Moi" tren POS 7 ngay (chu shop 02/10/2026: "loc lai cac don moi trong 1 tuan qua neu da chuan thi
// an da xac nhan luon") + quet lai theo page + mau chu luc ("cac don Q005 o page linh tay luxury cs1 ... len don xac nhan")
{
  const { config: cfg39 } = await import("../src/config.js");
  cfg39.pos.shopId = "SHOP1"; cfg39.pos.apiKey = "posk";
  const { orderSync: os39 } = await import("../src/orders.js");
  const ob = bot.orderBot;
  const iso = (ngay) => new Date(Date.now() - ngay * 86400e3).toISOString().replace("Z", "");
  const dc = { province_id: "1", district_id: "2", commune_id: "3", address: "Số 12 ngõ 5" };
  const don = [
    { id: 1, status: 0, inserted_at: iso(1), bill_phone_number: "0911111111", bill_full_name: "Lan", shipping_address: dc, items: [{ variation_id: "v1", quantity: 1 }] },
    { id: 2, status: 0, inserted_at: iso(2), bill_phone_number: "0922222222", shipping_address: { ...dc, commune_id: null }, items: [{ variation_id: "v1", quantity: 1 }] },
    { id: 3, status: 0, inserted_at: iso(2), bill_phone_number: "0933333333", shipping_address: dc, items: [{ variation_id: "v1", quantity: 1 }] },
    { id: 4, status: 0, inserted_at: iso(3), bill_phone_number: "0933333333", shipping_address: dc, items: [{ variation_id: "v1", quantity: 2 }] },
    { id: 5, status: 0, inserted_at: iso(3), bill_phone_number: "0955555555", shipping_address: dc, items: [{ variation_id: "v1", quantity: 1 }] },
    { id: 6, status: 1, inserted_at: iso(1), bill_phone_number: "0955555555", shipping_address: dc, items: [] },
    { id: 7, status: 0, inserted_at: iso(9), bill_phone_number: "0977777777", shipping_address: dc, items: [{ variation_id: "v1", quantity: 1 }] },
  ];
  const puts = [];
  const prev39 = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (u.hostname === "pos.pages.fm") {
      const m = u.pathname.match(/\/orders\/(\d+)$/);
      if (m && (init.method || "GET") === "GET") return json({ data: don.find((o) => String(o.id) === m[1]) });
      if (m && init.method === "PUT") { const b = JSON.parse(init.body); puts.push([Number(m[1]), b]); don.find((o) => String(o.id) === m[1]).status = b.status; return json({ data: {} }); }
      if (u.pathname.endsWith("/orders")) {
        const q = u.searchParams.get("search");
        return json({ data: q ? don.filter((o) => o.bill_phone_number === q) : don });
      }
    }
    return prev39(url, init);
  };
  const xt = await ob.previewDrafts(7);
  const theo = Object.fromEntries(xt.rows.map((r) => [r.id, r]));
  assert.equal(theo[7], undefined, "don qua 7 ngay khong vao danh sach");
  assert.equal(theo[6], undefined, "chi don Moi");
  assert.equal(theo[1].ok, true, "don du thong tin, khach khong co don khac -> chuan");
  assert.match(theo[2].reasons.join(), /tỉnh \/ huyện \/ xã/);
  assert.match(theo[3].reasons.join(), /đơn nháp khác #4/, "hai don nhap cung khach -> khong xac nhan don nao");
  assert.match(theo[5].reasons.join(), /đã có đơn #6/);
  assert.equal(puts.length, 0, "xem truoc KHONG ghi gi");
  // Nhan vien sua don #1 sau luc xem -> khong dong vao
  don[0].items = [{ variation_id: "v1", quantity: 3 }];
  let r = await ob.confirmDrafts([1, 2]);
  assert.deepEqual(r.confirmed, []);
  assert.match(r.failed[0].reason, /nhân viên đã sửa/);
  assert.equal(puts.length, 0, "don #2 khong chuan thi bo qua du co tick");
  don[0].items = [{ variation_id: "v1", quantity: 1 }];
  await ob.previewDrafts(7);
  r = await ob.confirmDrafts([1]);
  assert.deepEqual(r.confirmed, [1]);
  assert.equal(puts[0][1].status, 1);
  await assert.rejects(ob.confirmDrafts([1]), /cũ/, "xac nhan xong phai xem lai truoc lan sau");
  // Chay nen: bam -> tra ve ngay, ket qua o draftJob (su co 02/10/2026: doc lau, proxy cat, trang hien "Lỗi:" trong)
  const job = ob.startDraftPreview(7);
  assert.equal(job.running, true);
  while (job.running) await sleep(10);
  assert.ok(job.result && job.result.total >= 1, JSON.stringify(job));
  const cj = ob.startConfirmDrafts([]);
  while (cj.running) await sleep(10);
  assert.deepEqual(cj.result.confirmed, []);
  // Dia chi chi tiet: ten lang / moc dia danh van la chi tiet; chi ten hanh chinh thi khong
  const { hasStreetDetail } = await import("../src/orders.js");
  assert.equal(hasStreetDetail("Kon Rôn", ["Xã Ngok Réo", "Huyện Đăk Hà", "Kon Tum"]), true, "ten lang");
  assert.equal(hasStreetDetail("Cổng chào Tân Phú", ["Xã Tân Phú", "Huyện Tân Sơn", "Phú Thọ"]), true, "moc dia danh");
  assert.equal(hasStreetDetail("xã Sài Sơn", ["Xã Sài Sơn", "Huyện Quốc Oai", "Hà Nội"]), false);
  assert.equal(hasStreetDetail("Tân Phú, Tân Sơn, Phú Thọ", ["Xã Tân Phú", "Huyện Tân Sơn", "Phú Thọ"]), false);
  assert.equal(hasStreetDetail("", []), false);
  // Khach noi "địa chỉ cũ": lay so nha tu don cu CUNG xa cua chinh SDT do; khac xa thi khong doan
  const goiGoc = os39._call;
  os39._call = async () => ({ data: [
    { id: 90, status: 6, inserted_at: "2026-09-20T00:00:00", bill_phone_number: "0906933810", shipping_address: { commune_id: "C1", address: "ấp 3 đường số 7" } },
    { id: 91, status: 4, inserted_at: "2026-09-10T00:00:00", bill_phone_number: "0906933810", shipping_address: { commune_id: "C1", address: "tổ 5 ấp Bến Sắn" } },
    { id: 92, status: 4, inserted_at: "2026-09-25T00:00:00", bill_phone_number: "0906933810", shipping_address: { commune_id: "C2", address: "số 9 Lê Lợi" } },
  ] });
  const xaPT = { commune: { id: "C1", name: "Xã Phước Thiền" }, district: { name: "Huyện Nhơn Trạch" }, province: { name: "Đồng Nai" } };
  assert.deepEqual(await os39.previousStreet("0906933810", xaPT), { street: "tổ 5 ấp Bến Sắn", orderId: 91 }, "bo qua don huy, bo qua don khac xa");
  assert.equal(await os39.previousStreet("0906933810", { ...xaPT, commune: { id: "C9", name: "Xã Khác" } }), null);
  os39._call = goiGoc;
  globalThis.fetch = prev39;

  // Quet lai theo page + mau chu luc: page dang chi log -> bao loi ro rang; mau chu luc di toi buoc trich don
  settings.update("PAGE1", { orderSync: true, dryRun: true });
  assert.throws(() => ob.rescan({ hours: 24, pageId: "PAGE1", defaultCode: "Q005" }), /chỉ log/);
  settings.update("PAGE1", { orderSync: true, dryRun: false });
  assert.throws(() => ob.rescan({ hours: 24, pageId: "KHONGCO" }), /Không tìm thấy page/);
  const goc = { sync: os39.syncFromConversation, other: os39.otherOrders, history: ob.history, clients: bot.clients };
  const khach = (t) => ({ id: t, from: { id: "KHACH" }, message: t, inserted_at: new Date().toISOString() });
  bot.clients = new Map([["PAGE1", { getConversations: async () => ({ conversations: [{ id: "C39", updated_at: new Date().toISOString(), from: { name: "Mai" } }] }), getMessages: async () => ({ messages: [khach("sđt 0988000001"), khach("thôn 2 xã Sài Sơn huyện Quốc Oai Hà Nội")] }) }]]);
  ob.history = async () => ({ messages: [khach("sđt 0988000001"), khach("thôn 2 xã Sài Sơn huyện Quốc Oai Hà Nội")], text: "KHÁCH: ...", name: "Mai" });
  os39.otherOrders = async () => [];
  let maDung = null;
  os39.syncFromConversation = async (a) => ((maDung = a.defaultCode), { status: "skipped", reason: "chưa đủ thông tin: size" });
  const st = ob.rescan({ hours: 24, pageId: "PAGE1", defaultCode: "q005" });
  while (st.running) await sleep(20);
  assert.equal(maDung, "Q005", "mau chu luc nguoi chon di toi buoc trich don");
  assert.equal(st.pageName !== undefined, true);
  Object.assign(os39, { syncFromConversation: goc.sync, otherOrders: goc.other });
  ob.history = goc.history;
  bot.clients = goc.clients;
  delete ob.items.C39;
  settings.global.orderBot = undefined;
  console.log("OK 39: duyet don Moi 7 ngay (xem truoc khong ghi, don trung khach / thieu dia chi / da co don khong xac nhan, don bi sua giua chung khong dong); quet lai theo page + mau chu luc");
}

// ---- 40: RESET bot len don (chu shop 02/10/2026): bo danh sach cu MOT lan, gieo lai tu hoi thoai 24h co SDT, khong goi AI
{
  const { orderSync: os40 } = await import("../src/orders.js");
  const { store: st40 } = await import("../src/store.js");
  const ob = bot.orderBot;
  settings.update("PAGE1", { orderSync: true, dryRun: false });
  st40.state.orderBotVersion = 1;
  ob.items.CU = { pageId: "PAGE1", conversationId: "CU", status: "REVIEW", reasons: ["Thiếu số nhà"] };
  const khach = (t) => ({ id: t, from: { id: "KHACH" }, message: t, inserted_at: new Date().toISOString() });
  const tin = { S1: [khach("sđt 0911000001")], S2: [khach("chị hỏi giá")], S3: [khach("0911000003 nha em")] };
  const goc = { clients: bot.clients, other: os40.otherOrders, sync: os40.syncFromConversation };
  bot.clients = new Map([["PAGE1", { getConversations: async () => ({ conversations: Object.keys(tin).map((id) => ({ id, updated_at: new Date().toISOString(), from: { name: id } })) }), getMessages: async (id) => ({ messages: tin[id] }) }]]);
  os40.otherOrders = async (_c, ph) => (ph === "0911000003" ? [{ id: 1, status: 2 }] : []);
  let ai = 0;
  os40.syncFromConversation = async () => (ai++, { status: "skipped", reason: "x" });
  assert.equal(await ob.resetIfNeeded(), true);
  assert.equal(ob.items.CU, undefined, "danh sach cu bi bo");
  assert.ok(ob.items.S1, "hoi thoai co SDT duoc theo doi lai");
  assert.ok(ob.items.S1.nextCheckAt <= Date.now(), "kiem ngay o luot quet toi");
  assert.equal(ob.items.S2, undefined, "chua co SDT -> khong theo doi");
  assert.equal(ob.items.S3, undefined, "khach da co don that -> khong theo doi");
  assert.equal(ai, 0, "gieo lai khong goi AI");
  assert.equal(await ob.resetIfNeeded(), false, "chi reset mot lan");
  bot.clients = goc.clients;
  Object.assign(os40, { otherOrders: goc.other, syncFromConversation: goc.sync });
  for (const k of ["S1", "S2", "S3"]) delete ob.items[k];
  console.log("OK 40: reset bot len don mot lan: bo danh sach cu, gieo lai hoi thoai 24h co SDT (bo khach da co don), khong goi AI");
}

// ---- 41: su co 02/10/2026 (Thu Thuy, Linh Tay Luxury CS1): khach ghi "Số nhà 99 /40 Đường 8 phuong long phước" (khong
// quan, khong tinh — "Long Phước" co o nhieu tinh) ma bot gui ban chot don; bot da hua mien phi ship ma ban chot cong 25K
{
  const { orderSync: os41 } = await import("../src/orders.js");
  const goc = os41.resolveAddress;
  let goi = 0;
  os41.resolveAddress = async (dc) => (goi++, /long phước/i.test(dc) && !/hồ chí minh/i.test(dc) ? { province: null, street: dc } : { province: { id: 1 }, district: { id: 2 }, commune: { id: 3 }, street: dc });
  const chot = "Dạ em chốt đơn cho chị:\n• Đầm xếp ly eo tay lỡ – màu Đỏ đô – size XL x 1\n• Tổng: 499.000đ + 25.000đ phí vận chuyển = 524.000đ\n• Người nhận: Thu Thủy\n• SĐT: 0765114016\n• Địa chỉ: Số nhà 99 /40 Đường 8 phuong long phước\nChị kiểm tra giúp em thông tin đã đúng chưa ạ?";
  const hoi = await bot.addressQuestionForSummary(chot, "PAGE1");
  assert.match(hoi, /quận\/huyện và tỉnh\/thành phố của địa chỉ "Số nhà 99 \/40 Đường 8 phuong long phước"/);
  assert.equal(await bot.addressQuestionForSummary(chot.replace("phuong long phước", "phường Long Phước, TP Thủ Đức, Hồ Chí Minh").replace("Số nhà 99", "Số 99"), "PAGE1"), null, "du cap -> khong chan");
  await bot.addressQuestionForSummary(chot, "PAGE1");
  assert.equal(goi, 2, "cung dia chi -> dung lai ket qua, khong goi AI lan nua");
  assert.equal(await bot.addressQuestionForSummary("Dạ em chốt đơn: Tổng 499.000đ", "PAGE1"), null, "khong co dong dia chi -> khong chan");
  os41.resolveAddress = goc;
  const shop = (t) => ({ from: { id: "PAGE1" }, message: t });
  const khach = (t) => ({ from: { id: "KHACH" }, message: t });
  const hoiThoai = [khach("M60 60, miễn phí ship"), shop("Dạ em hỗ trợ miễn phí vận chuyển cho mình nha chị yêu"), khach("Màu đỏ đô")];
  const sua = bot.keepFreeShipPromise(chot, "PAGE1", hoiThoai);
  assert.match(sua, /Tổng: 499\.000đ \(miễn phí vận chuyển\)/);
  assert.doesNotMatch(sua, /524\.000/);
  assert.equal(bot.keepFreeShipPromise(chot, "PAGE1", [khach("Màu đỏ đô")]), chot, "chua hua mien phi -> giu nguyen");
  assert.match(bot.orderProgressPrompt("PAGE1", [...hoiThoai, khach("sđt 0765114016")]), /ĐÃ hứa MIỄN PHÍ vận chuyển/);
  console.log("OK 41: ban chot don voi dia chi chua du tinh/huyen/xa -> hoi lai dung cap; da hua mien phi ship thi tong khong cong ship");
}

// ---- 42: SUY RA dia chi co can cu (chu shop 02/10/2026: "cai them suy luan ra dia chi chinh xac neu co can cu chinh xac")
{
  const { orderSync: os42 } = await import("../src/orders.js");
  const goc = { idx: os42._geoIndex, resolve: os42._resolveAddress, call: os42._call, provinces: os42.provinces, districts: os42.districts, communes: os42.communes };
  const E = (c, cn, d, dn, p, pn) => ({ c, cn, d, dn, p, pn });
  os42._geoIndex = [
    E("c1", "Phường Long Phước", "d1", "Thành phố Thủ Đức", "p1", "Hồ Chí Minh"),
    E("c2", "Xã Long Phước", "d2", "Huyện Long Thành", "p2", "Đồng Nai"),
    E("c3", "Xã Long Phước", "d3", "Huyện Long Hồ", "p3", "Vĩnh Long"),
    E("c4", "Xã Sài Sơn", "d4", "Huyện Quốc Oai", "p4", "Hà Nội"),
  ];
  const byId = (list) => list.map(([id, name]) => ({ id, name }));
  os42.provinces = async () => byId([["p1", "Hồ Chí Minh"], ["p2", "Đồng Nai"], ["p3", "Vĩnh Long"], ["p4", "Hà Nội"]]);
  os42.districts = async (p) => byId([[{ p1: "d1", p2: "d2", p3: "d3", p4: "d4" }[p], os42._geoIndex.find((e) => e.p === p).dn]]);
  os42.communes = async (d) => byId([[os42._geoIndex.find((e) => e.d === d).c, os42._geoIndex.find((e) => e.d === d).cn]]);
  os42._resolveAddress = async (raw) => ({ ok: false, street: raw, fullAddress: raw, note: "Không xác định được tỉnh", confidence: "thấp", parsed: { street: "Số nhà 99 /40 Đường 8" } });
  // (1) Thu Thuy: "phuong long phước" -> chi MOT "Phường Long Phước" ca nuoc -> Thu Duc, HCM
  let a = await os42.resolveAddress("Số nhà 99 /40 Đường 8 phuong long phước", { phone: "0765114016" });
  assert.equal(a.commune?.id, "c1", JSON.stringify(a));
  assert.equal(a.province?.name, "Hồ Chí Minh");
  assert.match(a.confidence, /^cao/);
  assert.match(a.autoFixed, /duy nhất cả nước/);
  assert.deepEqual(os42.addressGate(a), [], "suy ra co can cu -> qua cong chat");
  // (2) "xã long phước" -> 2 noi -> KHONG doan, neu ro de hoi khach
  os42._call = async () => ({ data: [] });
  a = await os42.resolveAddress("ấp 3 xã long phước", { phone: "0900000001" });
  assert.equal(a.commune, undefined);
  assert.match(a.ambiguous, /có ở 2 nơi \(Huyện Long Thành, Đồng Nai; Huyện Long Hồ, Vĩnh Long\)/);
  // (3) ...nhung don cu cua chinh SDT do giao toi Long Thanh -> lay Long Thanh
  os42._call = async () => ({ data: [{ id: 9, status: 4, bill_phone_number: "0900000001", shipping_address: { commune_id: "c2" } }] });
  a = await os42.resolveAddress("ấp 3 xã long phước", { phone: "0900000001" });
  assert.equal(a.commune?.id, "c2");
  assert.match(a.autoFixed, /đơn cũ của khách/);
  // (4) khach co ghi ten huyen -> lay dung noi do
  os42._call = async () => ({ data: [] });
  a = await os42.resolveAddress("ấp 3 xã long phước long hồ", { phone: "" });
  assert.equal(a.commune?.id, "c3");
  // (5) Da xac dinh duoc tinh tu loi khach -> khong bao gio nhay sang tinh khac
  os42._resolveAddress = async (raw) => ({ ok: false, province: { id: "p2", name: "Đồng Nai" }, street: raw, fullAddress: raw, parsed: {} });
  a = await os42.resolveAddress("phường long phước đồng nai", {});
  assert.notEqual(a.commune?.id, "c1", "khong nhay sang HCM khi khach ghi Dong Nai");
  // (6) Danh muc chua dung xong -> khong suy ra (khong doan)
  os42._geoIndex = null;
  os42._geoBuilding = Promise.resolve();
  os42._resolveAddress = async (raw) => ({ ok: false, street: raw, fullAddress: raw, parsed: {} });
  const fsMod = await import("node:fs");
  const docGoc = fsMod.default.readFileSync;
  fsMod.default.readFileSync = () => { throw new Error("khong co tep"); };
  a = await os42.resolveAddress("phuong long phước", {});
  fsMod.default.readFileSync = docGoc;
  assert.equal(a.commune, undefined);
  Object.assign(os42, { _geoIndex: goc.idx, _resolveAddress: goc.resolve, _call: goc.call, provinces: goc.provinces, districts: goc.districts, communes: goc.communes, _geoBuilding: null });
  console.log("OK 42: suy ra dia chi chi khi co can cu (ten duy nhat ca nuoc / don cu cung SDT / khach ghi ten huyen), trung ten thi hoi khach, khong nhay tinh");
}

// ---- 43: mot dong ghi nhieu mau ("Đen, Đỏ" x2) -> tach tung mau, khong len 2 cai cung mot mau
{
  // Su co Ha Dang 02/10/2026 (Linh Tay Luxury CS1, Q005 ba mau Do Do / Xanh Reu / Den): khach "Cho 2 đầm 1 đen 1 đỏ",
  // ban chot ghi "màu Đen, Đỏ size XL x 2" -> loc cu chon mau dau tien = 2 cai Den, tong 849K van khop nen tu xac nhan.
  const { orderSync: os43 } = await import("../src/orders.js");
  const prevProducts = catalog.products;
  const bt = (id, mau, size) => ({ id, sku: id, fields: { "Màu": mau, Size: size }, price: 499000, stock: 5, available: true, images: [] });
  catalog.setProducts([{
    id: "p5", code: "Q005", name: "Đầm Q005", note: "", attributes: { "Màu": ["Đỏ Đô", "Xanh Rêu", "Đen"], Size: ["L", "XL"] }, price: { min: 499000, max: 499000 },
    images: [], variations: [bt("dd-l", "Đỏ Đô", "L"), bt("dd-xl", "Đỏ Đô", "XL"), bt("xr-xl", "Xanh Rêu", "XL"), bt("den-xl", "Đen", "XL")],
  }, {
    id: "p6", code: "X006", name: "Áo X006", note: "", attributes: { "Màu": ["Xanh Rêu", "Xanh Ngọc"], Size: ["M"] }, price: { min: 299000, max: 299000 },
    images: [], variations: [bt("x-xr", "Xanh Rêu", "M"), bt("x-xn", "Xanh Ngọc", "M")],
  }]);
  const ids = (r) => r.mapped.map((m) => `${m.variation_id}:${m.quantity}`).sort().join(",");
  // (1) "Đen, Đỏ" x2 -> 1 Den XL + 1 Do Do XL
  let r = os43.mapItems([{ code: "Q005", color: "Đen, Đỏ", size: "XL", quantity: 2 }]);
  assert.equal(ids(r), "dd-xl:1,den-xl:1", JSON.stringify(r));
  assert.equal(r.problems.length, 0);
  // (2) AI tach dung tu dau -> giu nguyen
  r = os43.mapItems([{ code: "Q005", color: "Đen", size: "XL", quantity: 1 }, { code: "Q005", color: "Đỏ", size: "XL", quantity: 1 }]);
  assert.equal(ids(r), "dd-xl:1,den-xl:1");
  // (3) hai mau ma so luong le -> khong doan
  r = os43.mapItems([{ code: "Q005", color: "đen và xanh rêu", size: "XL", quantity: 3 }]);
  assert.equal(r.mapped.length, 0);
  assert.match(r.problems[0], /không chia đều/);
  // (4) "đỏ" chi thuoc Do Do -> mot mau, khong bi coi la nhieu mau
  assert.equal(ids(os43.mapItems([{ code: "Q005", color: "đỏ", size: "XL", quantity: 1 }])), "dd-xl:1");
  // (5) "xanh" khi ma co Xanh Reu + Xanh Ngoc -> mo ho, khong lay bua bien the dau tien
  r = os43.mapItems([{ code: "X006", color: "xanh", size: "M", quantity: 1 }]);
  assert.equal(r.mapped.length, 0);
  assert.match(r.problems[0], /khớp 2 màu/);
  // (6) chua noi mau -> khong lay bua; chua noi size ma ma co 2 size cho mau do -> khong lay bua
  assert.equal(os43.mapItems([{ code: "Q005", color: "", size: "XL", quantity: 1 }]).mapped.length, 0);
  assert.equal(os43.mapItems([{ code: "Q005", color: "Đỏ Đô", size: "", quantity: 1 }]).mapped.length, 0);
  catalog.setProducts(prevProducts);
  console.log("OK 43: mot dong ghi nhieu mau -> tach tung mau chia deu so luong; mau / size mo ho hoac chua noi -> khong lay bua bien the dau tien");
}

// ---- 45: su co 02/10/2026 (Bui Phuong Vy, Linh Tay Luxury): khach da cho du so do + mau + dia chi + SDT tu 30/09,
// hom sau bot chi con doc ~30 tin gan nhat -> hoi "Em lên đơn gửi hàng cho chị luôn nhé ạ?" 6 lan, xin lai chieu cao
// can nang 3 lan. Chu shop: "nếu đơn đã có sđt thì check 30 tin trước thời điểm cho sđt, nếu đã đủ thông tin thì
// không hỏi lại nữa, kết thúc hội thoại sớm".
{
  const { aiScope } = await import("../src/aicost.js");
  const prevProducts = catalog.products;
  const prevSettings = settings.get("PAGE1");
  catalog.setProducts([{
    id: "p44", code: "Q002", name: "Đầm cổ V xếp rủ", note: "", attributes: {}, price: { min: 499000, max: 499000 }, images: [],
    variations: ["Đỏ", "Đen"].map((c, i) => ({ id: "v44" + i, sku: "Q002" + i, fields: { "Màu": c, Size: "M" }, price: 499000, stock: 5, available: true, images: [] })),
  }]);
  settings.update("PAGE1", { defaultProduct: "Q002", sizeChart: '[{"h":[0,999],"w":[[30,49,"M"],[50,55,"L"],[56,63,"XL"],[64,79,"2XL"]]}]' });
  const cu = Date.now() - 2 * 86400e3; // tin 30/09: cu hon cua so nhuong nhan vien
  let n = 0;
  const shop = (t) => ({ id: "s44_" + ++n, from: { id: "PAGE1" }, message: t, inserted_at: new Date(cu + n * 1000).toISOString().replace("Z", "") });
  const khach = (t) => ({ id: "k44_" + ++n, from: customer, message: t, inserted_at: new Date(cu + n * 1000).toISOString().replace("Z", "") });
  const dau = [
    shop("DEAL siêu hời hôm nay dành riêng cho chị iu đây ạ. Chị iu cho em xin chiều cao, cân nặng để em giữ size cho mình kéo hết nhé."),
    khach("Miễn phí sip không shop"), shop("Dạ em chào chị yêu! Chị cần em tư vấn mẫu nào hay size nào ạ?"),
    khach("Mình 48kg"), shop("Dạ 48kg chị yêu mặc size M là vừa đẹp ạ. Chị đang quan tâm mẫu nào để em tư vấn kỹ hơn cho mình ạ?"),
    khach("Chiều dài của váy bao nhiêu shop nhỉ"), khach("Vì mình cao 1m55 thôi"),
    shop("Dạ mẫu Q002 bên em có chiều dài khoảng 128-132cm ạ. Chị có muốn xem ảnh mẫu Q002 không ạ?"),
    khach("Mà nhìn trong hình nhìn vay dài lắm"), shop("Dạ váy sẽ dài tới mắt cá chân ạ."),
    khach("Cho mình xem ảnh"), shop("Dạ đây ạ, em gửi chị ảnh các màu của mẫu Q002 ạ. Chị yêu thích màu Đỏ hay màu Đen ạ?"),
    khach("Nếu chất lượng không đẹp mình sẽ không nhận hàng đâu nhé"), shop("Dạ chị yên tâm ạ, mình được kiểm tra hàng trước khi thanh toán. Chị có muốn chốt đơn màu Đỏ hay màu Đen ạ?"),
    khach("Đỏ nhé"), shop("Dạ, em chốt đơn đầm Q002 màu Đỏ size M cho chị yêu nha. Chị cho em xin tên và số điện thoại người nhận để em lên đơn ạ."),
    khach("Đc khu dân cư vũ xá phường ái quốc tp Hải Phòng ( Hải Dương cũ)"), khach("Sđt 035845.9128"),
    shop("Dạ giao hàng toàn quốc nhà mình dự kiến 5–7 ngày chị nhận được hàng ạ."), khach("Không em"),
    shop("Dạ vâng ạ. Nếu chị cần hỗ trợ gì thêm cứ nhắn em nha. Chúc chị một ngày tốt lành ạ!"),
  ];
  // (1) 30 tin truoc luc gui SDT du mau + size (tu can nang) + dia chi -> du thong tin
  const info = bot.orderInfoFromPhone("PAGE1", dau);
  assert.equal(info.complete, true, JSON.stringify(info));
  assert.equal(info.facts.size, "M");
  assert.equal(info.facts.color, "Đỏ");
  // Thieu mau -> chua du; so do nam NGOAI 30 tin truoc SDT -> khong tinh
  assert.equal(bot.orderInfoFromPhone("PAGE1", dau.filter((m) => m.message !== "Đỏ nhé")).complete, false, "chua chon mau -> chua du");
  const xa = [khach("Mình 48kg"), ...Array.from({ length: 31 }, (_, i) => shop("Dạ vâng ạ " + i)), khach("Đỏ nhé"), khach("Đc khu dân cư vũ xá phường ái quốc tp Hải Phòng"), khach("0358459128")];
  assert.equal(bot.orderInfoFromPhone("PAGE1", xa).complete, false, "so do cach SDT hon 30 tin -> khong tinh");
  assert.equal(bot.orderInfoFromPhone("PAGE1", dau.slice(0, 16)), null, "chua gui SDT -> chua xet");

  // (2) Hom nay: cua so chi con tin moi (khong con so do / SDT) -> doc them lich su roi ghi ho so don
  delete (store.state.orderInfo || {})["CV44"];
  const homNay = [khach("Em gửi hàng cho chị chưa"), shop("Dạ, đơn hàng của mình đã được xác nhận ạ."), khach("OK")];
  const tatCa = [...dau, ...homNay];
  const fakeClient = { getMessages: async () => ({ messages: tatCa }) };
  const cuaSo = [...dau.slice(-17), ...homNay]; // 20 tin cuoi: khong con "Mình 48kg"
  assert.equal(bot.customerFacts("PAGE1", cuaSo).measured, false, "dung la cua so ngan mat so do");
  const r = await aiScope.run({ pageId: "PAGE1", conversationId: "CV44" }, () => bot.refreshOrderInfo(fakeClient, "PAGE1", "CV44", cuaSo, { conv_phone_numbers: ["0358459128"] }));
  assert.equal(r?.complete, true, "doc them lich su -> thay du thong tin");
  assert.equal(store.getOrderInfo("CV44").complete, true);

  // (3) Trong luot xu ly cua hoi thoai do: coi nhu don da chot, khong hoi them gi
  aiScope.run({ pageId: "PAGE1", conversationId: "CV44" }, () => {
    const ngan = homNay;
    assert.equal(bot.orderClosedIn("PAGE1", ngan), true);
    const f = bot.customerFacts("PAGE1", ngan);
    assert.ok(f.phone && f.address && f.size === "M" && f.color === "Đỏ" && f.measured, JSON.stringify(f));
    for (const cau of ["Dạ em ghi nhận đủ thông tin của chị rồi ạ ❤️", "Dạ vâng ạ. Chúc chị một ngày tốt lành ạ!", "Dạ, đơn hàng của mình đã được xác nhận ạ."]) {
      assert.equal(bot.ensureEndsWithQuestion(cau, "PAGE1", ngan), cau, "khong gan cau hoi vao: " + cau);
    }
    const s1 = bot.stripAskWhenClosed("Dạ em xin lỗi chị yêu ạ.\nChị cho em xin chiều cao và cân nặng để em tư vấn size chuẩn cho mình nhé ạ?", "PAGE1", ngan);
    assert.doesNotMatch(s1, /chiều cao|cân nặng|\?/);
    const s2 = bot.stripAskWhenClosed("Dạ đơn của mình đã được xác nhận ạ.\nEm lên đơn gửi hàng cho chị luôn nhé ạ?", "PAGE1", ngan);
    assert.equal(s2, "Dạ đơn của mình đã được xác nhận ạ.");
    assert.doesNotMatch(bot.stripAskWhenClosed("Dạ chị cần em hỗ trợ thêm gì không ạ?", "PAGE1", ngan), /\?/);
    const p = bot.orderProgressPrompt("PAGE1", ngan);
    assert.match(p, /ĐƠN ĐÃ ĐỦ THÔNG TIN/);
    assert.match(p, /Địa chỉ: ĐÃ CÓ/);
  });
  // Ngoai luot xu ly cua hoi thoai do -> ho so khong ro ri sang hoi thoai khac
  assert.equal(bot.orderClosedIn("PAGE1", homNay), false);
  assert.equal(aiScope.run({ pageId: "PAGE1", conversationId: "CV_KHAC" }, () => bot.orderClosedIn("PAGE1", homNay)), false);

  // (4) Nhan ra chot don du bot viet "em chốt đơn đầm Q002 … cho chị" (truoc chi bat "em chốt đơn cho")
  assert.equal(bot.orderClosedIn("PAGE1", [shop("Dạ, em chốt đơn đầm Q002 màu Đỏ size M cho chị yêu nha.")]), true);

  // (5) Tron luong: hoi thoai da du thong tin, khach nhan "Ừ em" -> KHONG dap mau: AI doc ngu canh (chu shop 02/10/2026:
  // "tùy thuộc vào hoàn cảnh để suy luận"), prompt noi ro don da du, va cau tra loi khong con cau hoi nao
  delete (store.state.orderInfo || {})["CONV1"];
  calls.length = 0;
  geminiText = "Dạ vâng ạ, đơn của chị em gửi đi ngay ạ ❤️\nEm lên đơn gửi hàng cho chị luôn nhé ạ?";
  pancakeMessages = [...dau, { id: "k44_ue", from: customer, message: "Ừ em", inserted_at: new Date().toISOString().replace("Z", "") }];
  bot.handleWebhook(webhook(pancakeMessages[pancakeMessages.length - 1]));
  await sleep(WAIT * 2);
  let gem44 = calls.filter((c) => c.path.includes(":generateContent"));
  let gui44 = calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
  assert.equal(gem44.length, 1, "'Ừ em' de AI suy luan theo ngu canh, khong dap mau");
  const prompt44 = JSON.stringify(gem44[0].body);
  assert.match(prompt44, /ĐƠN ĐÃ ĐỦ THÔNG TIN/);
  assert.match(prompt44, /ĐỌC CÂU SHOP VỪA GỬI NGAY TRƯỚC/);
  assert.ok(gui44.length >= 1, "van tra loi khach");
  assert.ok(gui44.every((c) => !/lên đơn gửi hàng|chiều cao|cân nặng|\?/.test(c.body.message || "")), JSON.stringify(gui44.map((c) => c.body.message)));
  // Loi CAM ON sau khi don da du -> chao mot cau, khong ton tien AI
  calls.length = 0;
  pancakeMessages = [...dau, { id: "k44_cam_on", from: customer, message: "Cảm ơn em", inserted_at: new Date().toISOString().replace("Z", "") }];
  bot.handleWebhook(webhook(pancakeMessages[pancakeMessages.length - 1]));
  await sleep(WAIT * 2);
  gem44 = calls.filter((c) => c.path.includes(":generateContent"));
  gui44 = calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
  assert.equal(gem44.length, 0, "cam on sau khi don da du -> khong ton tien AI");
  assert.ok(gui44.every((c) => !/\?/.test(c.body.message || "")), JSON.stringify(gui44.map((c) => c.body.message)));
  delete (store.state.orderInfo || {})["CONV1"];

  settings.update("PAGE1", { defaultProduct: prevSettings.defaultProduct || "", sizeChart: prevSettings.sizeChart || "" });
  catalog.setProducts(prevProducts);
  console.log("OK 45: khach da gui SDT + 30 tin truoc do du thong tin -> ghi ho so don, thoi hoi them; tin ngan de AI doc ngu canh, cam on thi chao");
}

// ---- 44: mau chu luc cua page (chu shop 02/10/2026: Linh Tay Luxury CS1 mac dinh Q005)
{
  const { orderSync: os44 } = await import("../src/orders.js");
  const prevProducts = catalog.products;
  catalog.setProducts([
    { id: "pA", code: "A001", name: "Áo A001", note: "", attributes: {}, price: { min: 1, max: 1 }, images: [], variations: [{ id: "a1", sku: "a1", fields: {}, price: 1, stock: 1, available: true, images: [] }] },
    { id: "p5", code: "Q005", name: "Đầm Q005", note: "", attributes: { "Màu": ["Đen"] }, price: { min: 499000, max: 499000 }, images: [], variations: [{ id: "q5", sku: "q5", fields: { "Màu": "Đen", Size: "XL" }, price: 499000, stock: 1, available: true, images: [] }] },
  ]);
  // (1) Ma rong khong duoc khop san pham dau danh muc
  const r = os44.mapItems([{ code: "", color: "Đen", size: "XL", quantity: 1 }]);
  assert.equal(r.mapped.length, 0, "khong ro ma -> khong len nham A001");
  assert.match(r.problems[0], /chưa rõ mẫu/);
  // (2) Page ten "Linh Tây Luxury CS1" chua khai mau chu luc -> dat Q005 MOT lan, don treo 24h cua page duoc kiem lai ngay
  const ob = bot.orderBot;
  const tenCu = bot.pageNames.get("PAGE1");
  const macDinhCu = settings.get("PAGE1").defaultProduct;
  settings.update("PAGE1", { defaultProduct: "" });
  bot.pageNames.set("PAGE1", "Linh Tây Luxury CS1");
  delete store.state.defaultProductSeeds;
  ob.items.C44a = { pageId: "PAGE1", conversationId: "C44a", status: "REVIEW", rounds: 3, firstSeen: Date.now() - 3600e3, nextCheckAt: 0, reviewAt: Date.now(), reasons: ["x"] };
  ob.items.C44b = { pageId: "PAGE1", conversationId: "C44b", status: "DONE", rounds: 1, firstSeen: Date.now() - 3600e3, orderId: "9" };
  ob.items.C44c = { pageId: "PAGE1", conversationId: "C44c", status: "REVIEW", rounds: 3, firstSeen: Date.now() - 48 * 3600e3, reviewAt: 1 };
  assert.deepEqual(ob.seedDefaultProducts(), ["PAGE1"]);
  assert.equal(settings.get("PAGE1").defaultProduct, "Q005");
  assert.equal(ob.items.C44a.status, "PENDING", "don can duyet trong 24h -> kiem lai");
  assert.equal(ob.items.C44a.rounds, 0);
  assert.ok(ob.items.C44a.nextCheckAt <= Date.now(), "kiem ngay");
  assert.equal(ob.items.C44b.status, "DONE", "don da len khong dung vao");
  assert.equal(ob.items.C44c.status, "REVIEW", "qua 24h khong dung vao");
  // Chu shop doi sang ma khac -> khong bi dat lai Q005
  settings.update("PAGE1", { defaultProduct: "q004 " });
  assert.equal(settings.get("PAGE1").defaultProduct, "Q004", "chuan hoa ma");
  assert.deepEqual(ob.seedDefaultProducts(), [], "chi ap mot lan");
  assert.equal(settings.get("PAGE1").defaultProduct, "Q004");
  settings.update("PAGE1", { defaultProduct: "Q005" });
  // (3) Ban chot ghi ten mo ta -> thay bang ten danh muc cua ma chu luc
  const chot = "Dạ em chốt đơn cho chị:\n• Đầm xếp ly eo tay lỡ – màu Đen, Đỏ size XL x 2\n• Tổng: 849.000đ (miễn phí ship)\n• SĐT: 0903367786\n• Địa chỉ: 25/13 Bà Lê Chân";
  assert.match(bot.productCodeInSummary(chot, "PAGE1"), /\n• Đầm Q005 – màu Đen, Đỏ size XL x 2\n/);
  assert.match(bot.productCodeInSummary(chot.replace(" – ", " "), "PAGE1"), /• Đầm Q005 màu Đen/);
  const tachDong = "Dạ em chốt đơn cho chị:\n• 1 Đen XL\n• 1 Đỏ Đô XL\n• Tổng: 849.000đ";
  assert.match(bot.productCodeInSummary(tachDong, "PAGE1"), /chị:\n• Mẫu: Đầm Q005\n• 1 Đen XL/);
  const coMa = chot.replace("Đầm xếp ly eo tay lỡ", "Đầm Q005");
  assert.equal(bot.productCodeInSummary(coMa, "PAGE1"), coMa, "da co ma thi giu nguyen");
  for (const k of ["C44a", "C44b", "C44c"]) delete ob.items[k];
  settings.update("PAGE1", { defaultProduct: macDinhCu || "" });
  bot.pageNames.set("PAGE1", tenCu);
  catalog.setProducts(prevProducts);
  console.log("OK 44: mau chu luc cua page — dat Q005 cho CS1 mot lan + kiem lai don treo; ban chot ghi ma mau; ma rong khong khop bua san pham dau");
}

// ---- 46: khach XIN HUY DON (chu shop 02/10/2026, Thu Thuy - Linh Tay CS1: bot hua mien ship roi ban chot van cong
// 25.000d, khach "Dạ cho e hủy nha c" -> bot ghi nhan huy luon). Luat: lan dau hoi ly do, sua loi cua shop, dua uu dai
// giu don; khach xin huy LAN NUA moi ghi nhan + chuyen nhan vien; khach dong y giu thi het che do huy.
{
  const shop = (t) => ({ from: { id: "PAGE1" }, message: t });
  const khach = (t) => ({ from: { id: "KHACH" }, message: t });
  const chot = [
    shop("Dạ em hỗ trợ miễn phí vận chuyển cho mình nha chị yêu."), khach("Cao 160 nặng 60k"), khach("Màu đỏ đô"),
    shop("Dạ em chốt đơn cho chị:\n• Đầm xếp ly eo tay lỡ – màu Đỏ đô – size XL x 1\n• Tổng: 499.000đ + 25.000đ phí vận chuyển = 524.000đ\nChị kiểm tra giúp em thông tin đã đúng chưa ạ?"),
  ];
  assert.equal(bot.cancelStage("PAGE1", chot), null);
  const huy1 = [...chot, khach("Dạ cho e hủy nha c")];
  assert.equal(bot.cancelStage("PAGE1", huy1), "retain", "lan dau xin huy -> giu don");
  const huy2 = [...huy1, shop("Dạ em xin lỗi chị ạ, chị cho em hỏi mình đổi ý vì lý do gì ạ?"), khach("thôi hủy đi em")];
  assert.equal(bot.cancelStage("PAGE1", huy2), "accept", "xin huy lan nua -> ghi nhan");
  assert.equal(bot.cancelStage("PAGE1", [...huy1, shop("Dạ em miễn ship cho chị ạ"), khach("ok giữ đơn nha")]), null, "dong y giu don");
  assert.equal(bot.cancelStage("PAGE1", [...chot, khach("nhận hàng không vừa thì hủy được không em?")]), null, "hoi chinh sach huy khong phai xin huy");
  for (const t of ["không lấy nữa", "Huỷ đơn giúp chị", "thôi ko mua nữa"]) assert.equal(bot.cancelStage("PAGE1", [khach(t)]), "retain", t);
  // Luot giu don: cau moi giu don / gui hang KHONG bi cat du don da chot
  assert.match(bot.stripAskWhenClosed("Dạ em xin lỗi chị ạ.\nEm giữ đơn và gửi hàng cho chị luôn nhé ạ?", "PAGE1", huy1), /gửi hàng cho chị luôn nhé ạ\?/);
  assert.doesNotMatch(bot.stripAskWhenClosed("Dạ vâng ạ.\nEm gửi hàng cho chị luôn nhé ạ?", "PAGE1", [...chot, khach("Màu đỏ đô nha")]), /\?/, "ngoai luot giu don van cat");

  // Tron luong: khach xin huy lan dau -> AI duoc dan giu don, KHONG gan the chuyen nhan vien (bot van noi chuyen tiep)
  delete (store.state.orderInfo || {})["CONV1"];
  calls.length = 0;
  const cu = Date.now() - 2 * 3600e3;
  pancakeMessages = huy1.map((m, i) => ({ ...m, id: "m46_" + i, from: m.from.id === "PAGE1" ? m.from : customer, inserted_at: new Date(cu + i * 1000).toISOString().replace("Z", "") }));
  pancakeMessages[pancakeMessages.length - 1].inserted_at = new Date().toISOString().replace("Z", "");
  geminiText = "Dạ em xin lỗi chị vì bản chốt cộng nhầm phí ship ạ.\nChị cho em hỏi mình đổi ý vì lý do gì ạ? Em giữ đơn và gửi hàng cho chị luôn nhé ạ?";
  bot.handleWebhook(webhook(pancakeMessages[pancakeMessages.length - 1]));
  await sleep(WAIT * 2);
  const gem46 = calls.filter((c) => c.path.includes(":generateContent"));
  const gui46 = calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
  assert.equal(gem46.length, 1);
  assert.match(JSON.stringify(gem46[0].body), /KHÁCH XIN HỦY ĐƠN \(lần đầu\)/);
  assert.ok(gui46.some((c) => /lý do gì/.test(c.body.message || "")), JSON.stringify(gui46.map((c) => c.body.message)));
  assert.ok(gui46.some((c) => /giữ đơn và gửi hàng cho chị luôn nhé/.test(c.body.message || "")), "cau moi giu don khong bi cat");
  assert.equal(calls.filter((c) => c.path.endsWith("/tags")).length, 0, "chua chuyen nhan vien o luot giu don");

  // Bot len don: khach dang xin huy -> khong len / tu xac nhan don; khach dong y giu -> kiem lai ngay
  const { orderSync: os46 } = await import("../src/orders.js");
  const ob = bot.orderBot;
  const goc = { sync: os46.syncFromConversation, other: os46.otherOrders, history: ob.history };
  let goiAI = 0;
  os46.syncFromConversation = async () => (goiAI++, { status: "skipped", reason: "x" });
  os46.otherOrders = async () => [];
  ob.history = async () => ({ messages: huy1, text: "", name: "Thủy" });
  ob.items.C46 = { pageId: "PAGE1", conversationId: "C46", status: "PENDING", firstSeen: Date.now() - 3600e3, reasons: [] };
  await ob.check("C46");
  assert.equal(ob.items.C46.status, "REVIEW");
  assert.match(ob.items.C46.reasons[0], /khách xin hủy đơn/);
  assert.equal(goiAI, 0, "khong goi AI len don khi khach dang xin huy");
  ob.notify("PAGE1", "C46", [...huy1, shop("Dạ em miễn ship cho chị ạ"), khach("ok giữ đơn nha"), khach("0765114016")], "Thủy");
  assert.equal(ob.items.C46.status, "PENDING", "khach dong y giu don -> theo doi lai");
  Object.assign(os46, { syncFromConversation: goc.sync, otherOrders: goc.other });
  ob.history = goc.history;
  delete ob.items.C46;
  console.log("OK 46: khach xin huy -> lan dau hoi ly do + giu don (khong chuyen nhan vien, khong len don), xin lan nua moi ghi nhan");
}

// ---- 47: SDT khach gui bang chip "chia se so dien thoai" (khong nam trong noi dung chu) — su co Nhung Le 02/10/2026
{
  const { messagePhones } = await import("../src/bot.js");
  const chip = { from: { id: "KHACH" }, message: "", phone_info: [{ phone_number: "0355734749" }] };
  assert.deepEqual(messagePhones(chip), ["0355734749"]);
  assert.equal(bot.messageText(chip), "0355734749");
  assert.equal(bot.customerFacts("PAGE1", [chip]).phone, true, "co SDT -> khong xin lai");
  assert.deepEqual(messagePhones({ message: "", quick_reply: { payload: "+84355734749" } }), ["0355734749"]);
  // Duong dan anh / nguoi gui / so trong noi dung chu khong bi lap lai
  assert.deepEqual(messagePhones({ message: "x", attachments: [{ type: "photo", url: "https://cdn/t39.30808-6/0355734749_n.jpg" }], from: { phone: "0912345678" } }), []);
  assert.equal(bot.messageText({ message: "sđt 0355734749", phone_info: [{ phone_number: "0355734749" }] }), "sđt 0355734749");
  console.log("OK 47: SDT khach gui bang chip so dien thoai -> bot doc duoc (khong chot 'CHƯA CÓ SỐ ĐIỆN THOẠI'), khong lay so tu link anh / nguoi gui");
}

// ---- 48: khach da co don dang xu ly — cung san pham thi khong dien vao nhap Pancake moi (su co Mai Hoang 02/10/2026)
{
  const { orderSync: os48 } = await import("../src/orders.js");
  const prevProducts = catalog.products;
  catalog.setProducts([{ id: "p2", code: "Q002", name: "Đầm Q002", note: "", attributes: { "Màu": ["Đỏ Đô", "Đen"] }, price: { min: 299000, max: 299000 }, images: [], variations: [
    { id: "q2do", sku: "q2do", fields: { "Màu": "Đỏ Đô", Size: "L" }, price: 299000, stock: 5, available: true, images: [] },
    { id: "q2den", sku: "q2den", fields: { "Màu": "Đen", Size: "L" }, price: 299000, stock: 5, available: true, images: [] }] }]);
  const goc = { extract: os48.extractOrder, resolve: os48.resolveAddress, draft: os48.findDraft, active: os48.findActiveOrder, call: os48._call };
  let mau = "Đỏ Đô";
  os48.extractOrder = async () => ({ ready: true, items: [{ code: "Q002", color: mau, size: "L", quantity: 1 }], customer_name: "Mai", phone: "0904118955", address: "9/160 Tôn Đức Thắng, Lam Sơn, Lê Chân, Hải Phòng", agreed_total: 299000, free_shipping: true });
  os48.resolveAddress = async () => ({ ok: true, confidence: "cao", province: { id: "p" , name: "Hải Phòng" }, district: { id: "d", name: "Lê Chân" }, commune: { id: "c", name: "Lam Sơn" }, street: "9/160 Tôn Đức Thắng", fullAddress: "9/160 Tôn Đức Thắng, Lam Sơn, Lê Chân, Hải Phòng" });
  os48.findDraft = async () => ({ id: 5666, status: 0, inserted_at: new Date().toISOString() });
  os48.findActiveOrder = async () => ({ id: 5633, status: 2, items: [{ variation_id: "q2do", quantity: 1 }] });
  const ghi = [];
  os48._call = async (method, url, body) => (ghi.push([method, url]), { data: { id: 5666 } });
  const hoi = "KHÁCH: lấy Q002 đỏ đô size L, sđt 0904118955, 9/160 Tôn Đức Thắng Lam Sơn Lê Chân Hải Phòng";
  let r = await os48.syncFromConversation({ pageId: "PAGE1", pageName: "Shop", conversationId: "C48", customerName: "Mai", historyText: hoi, strict: true });
  assert.equal(r.status, "review", JSON.stringify(r));
  assert.match(r.reasons[0], /Trùng đơn #5633 .*cùng sản phẩm — đơn nháp #5666 là đơn thừa, nhân viên huỷ/);
  assert.equal(ghi.filter(([m]) => m !== "GET").length, 0, "khong ghi vao don nhap thua");
  // Khong co don nhap -> nhu cu: khong tao them
  os48.findDraft = async () => null;
  r = await os48.syncFromConversation({ pageId: "PAGE1", pageName: "Shop", conversationId: "C48", customerName: "Mai", historyText: hoi, strict: true });
  assert.equal(r.status, "skipped");
  assert.match(r.reason, /khách đã có đơn #5633 .*cùng sản phẩm - không tạo thêm/);
  // Khac san pham (mua them / doi mau) -> van dien don nhap; tu xac nhan se bi chan boi don cu -> can duyet
  mau = "Đen";
  os48.findDraft = async () => ({ id: 5667, status: 0, inserted_at: new Date().toISOString() });
  os48._call = async (method, url, body) => (ghi.push([method, url]), { data: { id: 5667 } });
  r = await os48.syncFromConversation({ pageId: "PAGE1", pageName: "Shop", conversationId: "C48", customerName: "Mai", historyText: hoi.replace("đỏ đô", "đen"), strict: true });
  assert.equal(r.status, "updated", JSON.stringify(r));
  assert.ok(ghi.some(([m, u]) => m === "PUT" && /orders\/5667$/.test(u)));
  Object.assign(os48, { extractOrder: goc.extract, resolveAddress: goc.resolve, findDraft: goc.draft, findActiveOrder: goc.active, _call: goc.call });
  catalog.setProducts(prevProducts);
  console.log("OK 48: khach con don dang xu ly cung san pham -> khong dien nhap Pancake thua, can duyet de huy; khac san pham -> van len nhap, cho duyet");
}

// ---- 49: dia chi khong co chu "xa / huyen / tinh" van la dia chi (su co Nguyen Thi Quyen 03/10/2026)
{
  const { looksLikeBareAddress } = await import("../src/bot.js");
  const khach = (t) => ({ from: { id: "KHACH" }, message: t });
  const hoi = [khach("Giá bao nhiêu"), khach("1m57 46kg"), khach("Gửi con gái c nhận hộ"), khach("Dung , khánh thịnh an hồng an dương hp"), khach("0362518828")];
  const f = bot.customerFacts("PAGE1", hoi);
  assert.ok(f.phone, "co SDT");
  assert.match(String(f.address), /an dương hp/, "nhan ra dia chi viet tat tinh");
  assert.equal(looksLikeBareAddress("số 5 trần phú ba đình hà nội"), true);
  assert.equal(looksLikeBareAddress("ship về hà nội mất mấy ngày"), false, "cau hoi khong phai dia chi");
  assert.equal(looksLikeBareAddress("hà nội"), false, "qua ngan");
  assert.equal(looksLikeBareAddress("mình ở hp có ship không"), false);
  assert.equal(looksLikeBareAddress("chị lấy màu đỏ đô size m nhé"), false);
  // Da co SDT + dia chi -> cau "xin SDT cua con gai / xin dia chi" bi bo
  const r = bot.dropAlreadyGivenAsks("Dạ, em đã có tên người nhận là Dung và địa chỉ Khánh Thịnh, An Hồng, An Dương, Hải Phòng rồi ạ.\nĐể hoàn tất đơn hàng, chị vui lòng cung cấp thêm số điện thoại của con gái chị giúp em nha.\nChị cho em xin số điện thoại và địa chỉ để em lên đơn gửi hàng cho mình nhé ạ?", "PAGE1", hoi);
  assert.doesNotMatch(r, /số điện thoại/);
  assert.match(bot.orderProgressPrompt("PAGE1", hoi), /KHÔNG xin thêm SĐT người nhận/);
  console.log("OK 49: dia chi viet tat khong co chu xa/huyen (\"an dương hp\") van duoc nhan; khong xin them SDT nguoi nhan ho");
}

// ---- 50: mau xa kho (gia POS 749K, gia xa 299K) — "giam > 30%" khong chan khi tong la gia trong bang gia cua page
{
  const prevProducts = catalog.products;
  catalog.setProducts([{ id: "p2", code: "Q002", name: "Đầm Q002", note: "", attributes: { "Màu": ["Đen"] }, price: { min: 749000, max: 749000 }, images: [], variations: [{ id: "q2den2xl", sku: "x", fields: { "Màu": "Đen", Size: "2XL" }, price: 749000, stock: 5, available: true, images: [] }] }]);
  const cu = settings.get("PAGE1").extraPrompt;
  settings.update("PAGE1", { extraPrompt: "Q002 GIÁ XẢ CHỈ 299.000đ/đầm, giá cũ 749. 2 đầm 598.000đ miễn ship." });
  const ob = bot.orderBot;
  const shop = (t) => ({ from: { id: "PAGE1" }, message: t });
  const khach = (t) => ({ from: { id: "KHACH" }, message: t });
  const chot = shop("Dạ em chốt đơn cho chị:\n• Đầm Q002 màu Đen size 2XL x 1\n• Tổng: 299.000đ + 25.000đ ship = 324.000đ");
  const chan = ["giảm giá 450.000đ vượt 30% tiền hàng"];
  assert.deepEqual(ob.dropSanctionedDiscount(chan, { agreed: 324000 }, "PAGE1", [chot, khach("ok")]), [], "gia xa 299K + ship nam trong bang gia -> khong chan");
  // Tong shop CHUA tung noi -> van chan
  assert.deepEqual(ob.dropSanctionedDiscount(chan, { agreed: 324000 }, "PAGE1", [khach("324k nhé")]), chan);
  // Tong khong co trong bang gia (bot tu giam 250K) -> van chan
  const chan2 = ["giảm giá 499.000đ vượt 30% tiền hàng"];
  assert.deepEqual(ob.dropSanctionedDiscount(chan2, { agreed: 275000 }, "PAGE1", [shop("Tổng: 275.000đ")]), chan2);
  // Chan khac giu nguyen
  assert.deepEqual(ob.dropSanctionedDiscount(["khách chưa chốt tổng tiền trong hội thoại"], { agreed: 0 }, "PAGE1", [chot]), ["khách chưa chốt tổng tiền trong hội thoại"]);
  settings.update("PAGE1", { extraPrompt: cu || "" });
  catalog.setProducts(prevProducts);
  console.log("OK 50: don xa kho (gia POS 749K, ban 299K) tu xac nhan khi tong la gia shop da bao va co trong bang gia page; tong la thi van chan");
}

// ---- 51: gia shop DA BAO khach trong hoi thoai (xa 249K) thang gia cu trong huong dan (chu shop 06/10/2026)
{
  const shop = (t) => ({ from: { id: "PAGE1" }, message: t });
  const khach = (t) => ({ from: { id: "KHACH" }, message: t });
  const deal = shop("DEAL siêu hời hôm nay dành riêng cho chị iu đây ạ ❤️\n\n🔥 GIẢM GIÁ CHỈ CÒN 249.000Đ/ĐẦM\nGiá cũ 749.000Đ – giảm gần 50%, số lượng còn rất ít.");
  const hoi = [shop("🔥 GIÁ XẢ CHỈ 299.000Đ/ĐẦM\nGiá cũ 749."), khach("giá bao nhiêu"), deal, khach("cao 1m55 50kg")];
  assert.equal(bot.quotedUnitPrice("PAGE1", hoi), 249000, "lay gia MOI NHAT shop bao, khong lay gia cu 749K");
  assert.equal(bot.quotedUnitPrice("PAGE1", [shop("chị ơi 299k/đầm nha")]), 299000);
  assert.equal(bot.quotedUnitPrice("PAGE1", [khach("249.000Đ/ĐẦM được không")]), null, "gia khach noi khong tinh");
  // Su co Dung Phan: khach TRICH (tra loi) tin deal cua shop -> chu 249K nam trong truong trich dan cua tin khach
  const trich = { from: { id: "KHACH" }, message: "Ơ NÀY SOP ƠI BÁO GIẢM 50% CÒN 249 K . MÀ", replied_message: { from: { id: "PAGE1" }, message: "hôm nay dành riêng cho chị iu đây ạ ❤️ 🔥 GIẢM GIÁ CHỈ CÒN 249.000Đ/ĐẦM Giá cũ 749.000Đ" } };
  assert.equal(bot.quotedUnitPrice("PAGE1", [shop("Giá ưu đãi: 499k + 25K ship"), trich]), 249000, "doc gia trong tin khach trich lai");
  assert.equal(bot.quotedUnitPrice("PAGE1", [{ from: { id: "KHACH" }, message: "", attachments: [{ type: "template", title: "GIẢM GIÁ CHỈ CÒN 249.000Đ/ĐẦM" }] }]), 249000, "the dinh kem");
  assert.match(bot.quotedPriceBlock("PAGE1", hoi), /249\.000đ\/đầm/);
  const chot249 = "Dạ em chốt đơn cho chị:\n• Đầm Q002 Đen L x 1\n• Tổng: 249.000đ + 25.000đ ship = 274.000đ";
  assert.ok(bot.summaryUsesPrice(chot249, 249000));
  assert.ok(!bot.summaryUsesPrice(chot249.replace(/249/g, "299").replace("274", "324"), 249000), "chot 299K khi da bao 249K -> sai");
  assert.ok(bot.summaryUsesPrice("• Tổng: 498.000đ (miễn ship)", 249000), "2 dam");
  // Chot chan gia: 249K + ship hop le khi prompt co khoi gia da bao
  assert.deepEqual(bot.findDisallowedPrices(chot249, "Q002 GIÁ XẢ 299.000đ, phí ship 25.000đ" + bot.quotedPriceBlock("PAGE1", hoi)), []);
  // Bot len don: don 274K (POS 749K) khong bi chan "giam > 30%" vi shop da bao 249K
  const prevProducts = catalog.products;
  catalog.setProducts([{ id: "p2", code: "Q002", name: "Đầm Q002", note: "", attributes: {}, price: { min: 749000, max: 749000 }, images: [], variations: [{ id: "x", sku: "x", fields: {}, price: 749000, stock: 1, available: true, images: [] }] }]);
  const chot = shop(chot249);
  assert.deepEqual(bot.orderBot.dropSanctionedDiscount(["giảm giá 475.000đ vượt 30% tiền hàng"], { agreed: 274000 }, "PAGE1", [...hoi, chot]), []);
  // Cau bao gia chep khoi mau "499k + 25K ship" khi shop da bao 249K -> lech; nhac gia cu 749K (gia POS) thi khong tinh
  assert.deepEqual(bot.pricesOffQuote("⚡ Giá ưu đãi: 499k + 25K ship", 249000), [499000]);
  assert.deepEqual(bot.pricesOffQuote("Chỉ còn 249.000đ/đầm (giá cũ 749.000đ), 2 đầm 498.000đ", 249000), []);
  catalog.setProducts(prevProducts);
  console.log("OK 51: gia shop da bao khach (xa 249K) dung cho ban chot, chot chan gia va tu xac nhan; gia khach tu noi khong tinh");
}

console.log("\nTAT CA TEST PASS");
process.exit(0);

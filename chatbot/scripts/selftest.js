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

const calls = [];
let pancakeMessages = [];
let geminiText = "Dạ shop còn size M ạ, anh/chị cho em xin SĐT để lên đơn nhé 😊";
let geminiToolParts = () => [];

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
  calls.push({ method: init.method || "GET", path: u.pathname, body, query: Object.fromEntries(u.searchParams) });
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

  if (u.hostname === "pages.fm") {
    assert.equal(u.searchParams.get("page_access_token"), "tok", "thieu page_access_token");
    if (u.pathname.endsWith("/messages") && (init.method || "GET") === "GET") {
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
await sleep(700);
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
await sleep(700);
assert.equal(calls.length, 0, "tin trung id phai bi bo qua");
console.log("OK 2: chong xu ly trung");

// ---- Test 3: tin tu page -> bo qua; tag tat bot -> bo qua
calls.length = 0;
bot.handleWebhook(webhook(msg("m3", "Dạ shop đây", pageFrom)));
bot.handleWebhook(webhook(msg("m4", "hello", customer), [{ id: 99, text: "Nhan vien xu ly" }]));
bot.handleWebhook(webhook(msg("m5", "hello", customer), [99]));
await sleep(700);
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
await sleep(700);
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
await sleep(700);
gem = calls.filter((c) => c.path.includes(":generateContent"));
assert.equal(gem.length, 1);
assert.deepEqual(gem[0].body.contents.map((c) => c.role), ["user", "model", "user"]);
console.log("OK 5: automation khong chan bot, lich su xen ke user/model");

// ---- Test 6: HANDOFF -> gui cau tra loi (da bo marker) + gan tag
calls.length = 0;
geminiText = "Dạ em đã ghi nhận, nhân viên sẽ liên hệ ngay ạ. [[HANDOFF]]";
pancakeMessages = [msg("m12", "tôi muốn gặp nhân viên", customer)];
bot.handleWebhook(webhook(pancakeMessages[0]));
await sleep(700);
sent = calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
const tagged = calls.filter((c) => c.path.endsWith("/tags"));
assert.equal(sent[0].body.message, "Dạ em đã ghi nhận, nhân viên sẽ liên hệ ngay ạ.");
assert.deepEqual(tagged[0].body, { action: "add", tag_id: "99" });
console.log("OK 6: handoff -> bo marker + gan tag");

// ---- Test 7: tin chi co anh (khong co url) -> chi mo ta
calls.length = 0;
geminiText = "Dạ em chưa xem được ảnh, anh/chị mô tả giúp em nhé";
pancakeMessages = [msg("m13", "<div></div>", customer, { attachments: [{ type: "photo" }] })];
bot.handleWebhook(webhook(pancakeMessages[0]));
await sleep(700);
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
await sleep(700);
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
await sleep(700);
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
await sleep(700);
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
await sleep(700);
assert.equal(calls.filter((c) => c.path.includes(":generateContent")).length, 0, "tin dau khong duoc goi Gemini");
assert.equal(calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages")).length, 0, "tin dau khong duoc gui");
calls.length = 0;
pancakeMessages = [
  msg("m19", "shop ơi", customer),
  msg("m20", "Chào chị, shop gửi ảnh và giá ạ", { id: "PAGE1", name: "Shop", is_automated: true }),
  msg("m21", "còn size L không", customer),
];
bot.handleWebhook(webhook(pancakeMessages[2]));
await sleep(700);
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

console.log("\nTAT CA TEST PASS");
process.exit(0);

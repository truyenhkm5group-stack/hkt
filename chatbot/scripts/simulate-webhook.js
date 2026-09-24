// Gia lap Pancake goi webhook vao server dang chay (npm start) de test luong xu ly.
// Dung: node scripts/simulate-webhook.js <conversation_id> "noi dung khach nhan" [message_id]
// conversation_id phai la hoi thoai THAT (lay tu `npm run test:pancake`) vi bot se goi API lay lich su.
// Nen bat DRY_RUN=true trong .env khi test de bot khong gui tin that.
import { config } from "../src/config.js";

const [conversationId, text, messageId] = process.argv.slice(2);
if (!conversationId || !text) {
  console.error('Dung: node scripts/simulate-webhook.js <conversation_id> "noi dung" [message_id]');
  process.exit(1);
}
// Page: PAGE_ID=... env, hoac suy tu id hoi thoai (Facebook: "<page_id>_<psid>"), hoac page dau tien
const prefix = conversationId.split("_")[0];
const pageId = process.env.PAGE_ID || (config.pages[prefix] ? prefix : Object.keys(config.pages)[0]);
if (!pageId) {
  console.error("Chua cau hinh page nao trong .env");
  process.exit(1);
}
console.log("Gia lap webhook cho page", pageId, config.pages[pageId]?.name || "");

const payload = {
  page_id: pageId,
  event_type: "messaging",
  data: {
    conversation: { id: conversationId, from: { id: "sim_customer", name: "Khach test" }, tags: [], type: "INBOX" },
    message: {
      id: messageId || "sim_" + Date.now(),
      conversation_id: conversationId,
      page_id: pageId,
      message: text,
      original_message: text,
      type: "INBOX",
      inserted_at: new Date().toISOString(),
      from: { id: "sim_customer", name: "Khach test" },
      attachments: [],
    },
    post: null,
  },
};

const url = new URL(`http://localhost:${config.port}${config.webhookPath}`);
if (config.webhookSecret) url.searchParams.set("secret", config.webhookSecret);
const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
console.log("Server tra ve:", res.status, await res.text());
console.log("Xem log cua server de thay cau tra loi cua bot.");

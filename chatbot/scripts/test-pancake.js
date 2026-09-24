// Kiem tra token Pancake: in tag, nhan vien, 5 hoi thoai moi nhat va tin nhan cua hoi thoai dau
import { config, assertConfig } from "../src/config.js";
import { PancakeClient } from "../src/pancake.js";
import { stripHtml, sortChrono } from "../src/util.js";

assertConfig({ needGemini: false });

for (const [pageId, page] of Object.entries(config.pages)) {
  const c = new PancakeClient(pageId, page.token);
  console.log(`\n########## PAGE ${pageId} ${page.name || ""} ##########`);

  try {
    const tags = await c.getTags();
    console.log("\n== Tags (dung id cho BOT_PAUSE_TAG_ID) ==");
    for (const t of tags.tags || tags.data || []) console.log(` - id=${t.id}  ${t.text}`);
  } catch (e) {
    console.log("Khong lay duoc tags:", e.message);
  }

  try {
    const users = await c.getUsers();
    console.log("\n== Nhan vien (dung id cho BOT_SENDER_ID neu muon) ==");
    for (const u of users.users || users.data || []) console.log(` - id=${u.id || u.user_id}  ${u.name || u.user?.name || ""}`);
  } catch (e) {
    console.log("Khong lay duoc users:", e.message);
  }

  const convs = await c.getConversations({ type: "INBOX", order_by: "updated_at" });
  const list = (convs.conversations || []).slice(0, 5);
  console.log(`\n== ${list.length} hoi thoai INBOX moi nhat ==`);
  for (const cv of list) {
    const who = String(cv.last_sent_by?.id) === String(pageId) ? "page" : "khach";
    console.log(` - ${cv.id} | ${cv.from?.name} | cuoi: ${who} | ${cv.updated_at} | tags=${(cv.tags || []).map((t) => t?.id).join(",")}`);
    console.log(`     "${(cv.snippet || "").slice(0, 80)}"`);
  }

  if (list[0]) {
    const m = await c.getMessages(list[0].id);
    const msgs = sortChrono(m.messages).slice(-8);
    console.log(`\n== 8 tin gan nhat cua "${m.conv_from?.name}" (can_inbox=${m.can_inbox}) ==`);
    for (const x of msgs) {
      const fromPage = String(x.from?.id) === String(pageId) || x.from?.admin_id || x.from?.uid;
      const tag = fromPage ? `PAGE${x.from?.admin_name ? "/" + x.from.admin_name : ""}${x.from?.is_automated ? "/auto" : ""}${x.from?.ai_generated ? "/ai" : ""}` : "KHACH";
      console.log(` [${x.inserted_at}] ${tag}: ${stripHtml(x.original_message || x.message).slice(0, 100) || "(dinh kem " + (x.attachments?.length || 0) + ")"}`);
    }
  }
}

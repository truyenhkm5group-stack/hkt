import { Bot } from "../src/bot.js";
import { settings } from "../src/settings.js";
import { log } from "../src/logger.js";
import { sleep } from "../src/util.js";

async function main() {
  console.log("=== BẮT ĐẦU QUÉT & TỰ ĐỘNG KHÔI PHỤC TRẢ LỜI CÁC TIN NHẮN CHƯA REP ===");
  const bot = new Bot();

  let totalReplied = 0;

  for (const [pageId, client] of bot.clients) {
    const eff = settings.effective(pageId);
    if (!eff.enabled) {
      console.log(`[PAGE ${pageId}] Đã bị tắt trong cài đặt -> Bỏ qua.`);
      continue;
    }

    const pageName = bot.pageNames.get(pageId) || pageId;
    console.log(`\n==================================================`);
    console.log(`Đang kiểm tra Page: ${pageName} (ID: ${pageId})...`);
    console.log(`==================================================`);

    try {
      const data = await client.getConversations({ type: "INBOX", order_by: "updated_at" });
      const convs = data.conversations || [];
      console.log(`Tổng số hội thoại gần đây: ${convs.length}`);

      for (const conv of convs) {
        const lastSentBy = String(conv.last_sent_by?.id || "");
        
        if (lastSentBy !== pageId) {
          const custName = conv.from?.name || "Khách hàng";
          console.log(`\n---> [CẦN REP] Page ${pageName} | Khách: ${custName} (ID: ${conv.id}) | Snippet: ${(conv.snippet || "").slice(0, 60)}`);

          if (bot.isPaused(conv.tags, pageId)) {
            console.log(`   [BỎ QUA] Hội thoại có thẻ BOT OFF.`);
            continue;
          }

          try {
            await bot.processConversation({
              pageId,
              conversationId: conv.id,
              type: "INBOX",
              customerName: custName,
              tags: conv.tags,
              force: true,
            });
            totalReplied++;
            console.log(`   ✅ Đã xử lý & gửi câu trả lời AI thành công!`);
            await sleep(1500);
          } catch (err) {
            console.error(`   ❌ Lỗi trả lời hội thoại ${conv.id}:`, err.message);
          }
        }
      }
    } catch (e) {
      console.error(`Lỗi lấy danh sách hội thoại cho page ${pageName}:`, e.message);
    }
  }

  console.log(`\n==================================================`);
  console.log(`🎉 HOÀN THÀNH: Đã quét và gửi trả lời cho ${totalReplied} hội thoại chưa rep!`);
  console.log(`==================================================`);
  process.exit(0);
}

main().catch(err => {
  console.error("Lỗi chương trình:", err);
  process.exit(1);
});

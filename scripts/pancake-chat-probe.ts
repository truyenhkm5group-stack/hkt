/**
 * DÒ HÌNH DẠNG DỮ LIỆU HỘI THOẠI PANCAKE — để hoàn thiện ánh xạ webhook mà KHÔNG phải đoán.
 *
 *   npx tsx scripts/pancake-chat-probe.ts            # đọc qua Pages API (đường đã kiểm chứng)
 *   npx tsx scripts/pancake-chat-probe.ts --keys     # chỉ in TÊN KHOÁ, không in nội dung
 *
 * In ra TÊN KHOÁ của hội thoại và tin nhắn thật, kèm kết quả chạy thử bộ chuẩn hoá webhook trên
 * chính dữ liệu đó. Token và nội dung tin nhắn của khách được CHE — kho mã này là PUBLIC và ảnh
 * chụp màn hình của script hay được dán vào chỗ khác.
 */
import "dotenv/config";
import { env } from "@/lib/env";
import { getPancakePagesClient } from "@/lib/integrations/pancake/pages";
import { normalizeChatWebhook } from "@/lib/ai/agents/sales/ingest";
import { CHAT_FIELD_MAP } from "@/lib/constants/sales-ingest";

const keysOnly = process.argv.includes("--keys");

/** Che nội dung: giữ độ dài và vài ký tự đầu để còn nhận ra kiểu dữ liệu. */
function mask(value: unknown): unknown {
  if (typeof value === "string") return value.length <= 3 ? value : `${value.slice(0, 3)}…(${value.length} ký tự)`;
  if (Array.isArray(value)) return `[${value.length} phần tử]`;
  if (value && typeof value === "object") return `{${Object.keys(value).join(", ")}}`;
  return value;
}

async function main() {
  if (!env.pancake.pagesAccessToken) throw new Error("Chưa cấu hình PANCAKE_ACCESS_TOKEN");
  const client = getPancakePagesClient();
  const pages = await client.listPages();
  console.log(`\nCÓ ${pages.length} PAGE:`);
  for (const page of pages) console.log(`  ${page.id} · ${page.name} · nền tảng: ${page.platform || "(không khai)"}`);
  if (!pages.length) return;

  const until = new Date();
  const since = new Date(until.getTime() - 24 * 3_600_000);
  const page = pages[0];
  const conversations = await client.listConversations(page.id, since, until, 3);
  console.log(`\nHỘI THOẠI 24 GIỜ QUA TRÊN PAGE ${page.id}: ${conversations.length}`);
  if (!conversations.length) return;

  const conversation = conversations[0];
  console.log("\nKHOÁ CỦA MỘT HỘI THOẠI THẬT:");
  for (const [key, value] of Object.entries(conversation.raw)) {
    console.log(`  ${key}: ${keysOnly ? typeof value : JSON.stringify(mask(value))}`);
  }

  const messages = await client.listMessages(page.id, conversation.id, conversation.customerId, 3);
  console.log(`\nTIN NHẮN ĐỌC ĐƯỢC: ${messages.length}`);
  for (const message of messages) {
    console.log(
      `  mã=${message.id} · từ page=${message.fromPage} · tên=${mask(message.fromName)} · mốc=${message.insertedAt?.toISOString() ?? "(không có)"} · đính kèm=${message.hasAttachment} · chữ=${mask(message.text)}`,
    );
  }

  // Chạy thử bộ chuẩn hoá webhook trên một gói tin DỰNG theo hình dạng Pages API. Nếu webhook thật
  // của Pancake có hình dạng khác, đây là chỗ nhìn thấy điều đó ngay.
  const sample = {
    page_id: page.id,
    conversation_id: conversation.id,
    message: { id: messages[0]?.id ?? "", message: "(nội dung đã che)", inserted_at: messages[0]?.insertedAt?.toISOString() },
    conversation: { customer: { id: conversation.customerId, name: conversation.customerName } },
  };
  const normalized = normalizeChatWebhook(sample);
  console.log("\nCHẠY THỬ BỘ CHUẨN HOÁ WEBHOOK TRÊN HÌNH DẠNG NÀY:");
  console.log(normalized.ok ? "  ✓ nhận dạng được" : `  ✗ từ chối: ${normalized.reason} · thiếu ${normalized.missing.join(", ")}`);

  console.log("\nBẢN KHAI ÁNH XẠ HIỆN TẠI (lib/constants/sales-ingest.ts):");
  for (const [field, map] of Object.entries(CHAT_FIELD_MAP)) {
    console.log(`  ${field.padEnd(16)} ${map.confidence.padEnd(11)} khoá: ${map.keys.join(" | ")}`);
  }
  console.log(
    "\nGỬI LẠI CHO NGƯỜI PHÁT TRIỂN: phần 'KHOÁ CỦA MỘT HỘI THOẠI THẬT' và một gói tin webhook thật\n" +
      "(đã che nội dung) là đủ để hoàn thiện các ánh xạ đang ở mức UNVERIFIED.",
  );
}

main().catch((error) => {
  console.error("Lỗi:", error instanceof Error ? error.message : error);
  process.exit(1);
});

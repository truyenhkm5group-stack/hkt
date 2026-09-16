/**
 * NẤC QUYỀN HẠN THẬT SỰ CÓ HIỆU LỰC — in cả BỐN thứ cùng lúc, cạnh nhau.
 *
 *   npx tsx scripts/ai-effective-mode.ts
 *
 * VÌ SAO CÓ TỆP NÀY. Thao tác `ai-staging-copilot` trước đây "đọc lại" nấc quyền hạn bằng một câu
 * psql trên cột `ai_agents.mode`. Câu ấy in ra `COPILOT` và mọi người tin là đã bật — trong khi mã
 * đang chạy tính ra `SHADOW`, vì `effectiveMode()` còn đi qua một ghi đè ở `settings` và một TRẦN
 * trong hằng số. Một phép đọc lại nhìn vào ô dữ liệu thô chứ không vào KẾT QUẢ PHÉP TÍNH là một
 * phép đọc lại có thể nói dối, và nó đã nói dối.
 *
 * Nên tệp này in đủ chuỗi suy luận, để chỗ lệch tự lộ ra:
 *   cột CSDL  →  ghi đè trong settings  →  mặc định môi trường  →  TRẦN  →  nấc CÓ HIỆU LỰC
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { aiEnv, getAiSettings } from "@/lib/ai-workforce/config";
import { getAgent } from "@/lib/ai-workforce/registry";
import { MAX_ALLOWED_MODE } from "@/lib/constants/ai";

async function main() {
  const db = await getDb();
  const settings = await getAiSettings();
  const row = await db.query.aiAgents.findFirst({ where: eq(schema.aiAgents.key, "sales") });
  const agent = await getAgent("sales", settings, db);

  console.log("───────── NẤC QUYỀN HẠN: TỪNG BƯỚC MỘT ─────────");
  console.log(`  cột ai_agents.mode     : ${row?.mode ?? "(chưa có dòng)"}${row?.enabled === false ? "  (dòng đang TẮT)" : ""}`);
  console.log(`  ghi đè settings.modes  : ${settings.modes.sales ?? "(không có)"}`);
  console.log(`  mặc định môi trường    : ${aiEnv.defaultMode}`);
  console.log(`  TRẦN (MAX_ALLOWED_MODE): ${MAX_ALLOWED_MODE}`);
  console.log(`  nền tảng AI bật        : ${settings.enabled ? "có" : "KHÔNG — mọi nấc thành OFF"}`);
  console.log("  ─────────────────────────────────────────────");
  console.log(`  ⇒ NẤC CÓ HIỆU LỰC      : ${agent?.mode ?? "(chưa đăng ký)"}`);
  console.log("");
  console.log(`  MÁY tự gửi   : ${settings.hardLimits.allowAutoSend ? "!!! CHO PHÉP !!!" : "CẤM"}`);
  console.log(`  NGƯỜI bấm gửi: ${settings.hardLimits.allowHumanApprovedSend ? "được phép" : "CẤM"}`);
  console.log(`  tạo đơn      : ${settings.hardLimits.allowOrderCreate ? "!!! CHO PHÉP !!!" : "CẤM"}`);

  // Một dòng KẾT LUẬN, để không ai phải tự suy từ năm dòng ở trên.
  if (row?.mode && agent?.mode && row.mode !== agent.mode) {
    console.log("");
    console.log(`✗ LỆCH: CSDL ghi "${row.mode}" nhưng mã đang chạy tính ra "${agent.mode}". Cột dữ liệu KHÔNG phải nấc đang chạy.`);
    process.exit(1);
  }
  console.log("");
  console.log("✓ cột CSDL và nấc có hiệu lực KHỚP nhau.");
}

main().catch((e) => {
  console.error("Lỗi:", e instanceof Error ? e.message : e);
  process.exit(1);
});

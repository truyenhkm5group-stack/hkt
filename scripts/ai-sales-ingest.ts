/**
 * NẠP TAY MỘT LƯỢT HỘI THOẠI PANCAKE CHO NHÂN SỰ BÁN HÀNG AI — dùng cho lần chạy thử đầu tiên.
 *
 *   npx tsx scripts/ai-sales-ingest.ts --page=<PAGE_ID> --hours=24 --max=20
 *   npx tsx scripts/ai-sales-ingest.ts --page=<PAGE_ID> --hours=24 --max=20 --dry-run
 *
 * Vì sao có script riêng thay vì bật lịch chạy: lần đầu cắm vào dữ liệu thật, thứ cần là MỘT lượt
 * nhỏ, xem được hết bằng mắt, dừng lại được. Nạp cả tài khoản rồi mới phát hiện ánh xạ sai thì phải
 * dọn hàng nghìn dòng; nạp 20 hội thoại thì đọc hết trong mười phút.
 *
 * --dry-run: CHỈ đọc và in ra những gì sẽ nạp, không ghi một dòng nào.
 *
 * Script này KHÔNG BAO GIỜ gửi tin cho khách. Nó không import cổng gửi tin, và cổng ấy tự nó cũng
 * từ chối khi `AI_ALLOW_CUSTOMER_SEND` khác `"true"`. Cuối lượt, script ĐỌC LẠI CSDL để chứng minh
 * số tin đã gửi vẫn bằng 0 — khẳng định suông thì không có giá trị gì.
 */
import "dotenv/config";
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ensureMigrated } from "@/db/migrate";
import { aiEnv, getAiSettings } from "@/lib/ai-workforce/config";
import { ensureAgents, getAgent } from "@/lib/ai-workforce/registry";
import { relinkHumanReplies, syncSalesConversations } from "@/lib/ai-workforce/agents/sales/ingest";
import { drainSalesTasks } from "@/lib/ai-workforce/agents/sales/pipeline";
import { getPancakePagesClient } from "@/lib/integrations/pancake/pages";

function arg(name: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : "";
}

function num(name: string, fallback: number): number {
  const value = Number(arg(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const pageId = arg("page");
  const hours = num("hours", 24);
  const max = num("max", 20);

  await ensureMigrated();
  const db = await getDb();
  await ensureAgents(db);

  const settings = await getAiSettings();
  const agent = await getAgent("sales", settings, db);

  console.log("\n───────── CẤU HÌNH ĐANG CHẠY ─────────");
  console.log(`  Nấc quyền hạn      : ${agent?.mode ?? "(chưa đăng ký)"}`);
  console.log(`  Nền tảng AI        : ${settings.enabled ? "bật" : "TẮT"} · nạp hội thoại: ${settings.ingestEnabled ? "bật" : "TẮT"}`);
  console.log(`  Gọi mô hình        : ${settings.modelCallsEnabled ? "bật" : "TẮT (chỉ chạy nấc luật)"}`);
  console.log(`  Nhà cung cấp       : ${aiEnv.provider} · mô hình rẻ: ${aiEnv.economyModel || "(chưa khai)"} · mô hình mạnh: ${aiEnv.strongModel || "(chưa khai)"}`);
  console.log(`  CHẶN CỨNG MÁY gửi  : ${settings.hardLimits.allowAutoSend ? "!!! CHO PHÉP !!!" : "CẤM"}`);
  console.log(`  CHẶN CỨNG NGƯỜI gửi: ${settings.hardLimits.allowHumanApprovedSend ? "!!! CHO PHÉP !!!" : "CẤM"}`);
  console.log(`  CHẶN CỨNG lên đơn  : ${settings.hardLimits.allowOrderCreate ? "!!! CHO PHÉP !!!" : "CẤM"}`);
  console.log(`  Bảng giá           : ${settings.pricingVersion || "(chưa khai — chi phí sẽ là CHƯA BIẾT)"}`);

  // Không bao giờ in token. Chỉ in ĐỘ DÀI, đủ để biết có cấu hình hay chưa.
  const userTokenLen = aiEnv.apiKey ? aiEnv.apiKey.length : 0;
  console.log(`  Khoá mô hình       : ${userTokenLen ? `đã cấu hình (${userTokenLen} ký tự)` : "chưa cấu hình"}`);

  // Lượt NẠP DỮ LIỆU không bao giờ được chạy trên một môi trường mà MÁY tự gửi được: nạp xong là
  // dây chuyền chạy, và nếu máy tự gửi thì lượt nạp đầu tiên đã nhắn cho khách thật.
  if (settings.hardLimits.allowAutoSend) {
    console.error("\n✗ DỪNG: AI_ALLOW_AUTO_SEND đang là true. Lượt nạp dữ liệu không được chạy khi máy tự gửi được.");
    process.exit(1);
  }

  const client = getPancakePagesClient();
  const pages = await client.listPages();
  console.log(`\n───────── PAGE ĐỌC ĐƯỢC (${pages.length}) ─────────`);
  for (const page of pages) console.log(`  ${page.id} · ${page.name}${page.platform ? ` · ${page.platform}` : ""}`);

  if (!pageId) {
    console.log("\nChưa chọn page. Chạy lại với --page=<PAGE_ID> ở trên.");
    process.exit(0);
  }

  if (dryRun) {
    const until = new Date();
    const since = new Date(until.getTime() - hours * 3_600_000);
    const list = await client.listConversations(pageId, since, until, max);
    console.log(`\n───────── CHẠY THỬ: ${list.length} hội thoại trong ${hours} giờ qua (KHÔNG ghi gì) ─────────`);
    for (const c of list.slice(0, max)) {
      console.log(`  ${c.id} · ${c.customerName || "(chưa rõ tên)"} · cập nhật ${c.updatedAt?.toISOString() ?? "?"} · ${c.phones.length} SĐT`);
    }
    process.exit(0);
  }

  console.log(`\n───────── NẠP THẬT: page ${pageId} · ${hours} giờ · tối đa ${max} hội thoại ─────────`);
  const ingested = await syncSalesConversations({ pageId, hours, limit: max, maxConversations: max });
  console.log(`  Hội thoại chạm tới : ${ingested.conversations}`);
  console.log(`  Tin nhắn ghi mới   : ${ingested.messages}`);
  console.log(`  Việc tạo cho AI    : ${ingested.events}`);
  console.log(`  Bỏ qua (khách chưa nhắn): ${ingested.skippedNoCustomer ?? 0}  — không tính vào trần ${max}`);
  if (ingested.errors?.length) for (const e of ingested.errors) console.log(`  ⚠ ${e}`);

  const ran = await drainSalesTasks(max * 5, db);
  console.log(`  Lượt chạy AI       : ${"ran" in ran ? ran.ran : 0}`);

  // PHẢI chạy SAU khi máy đã sinh gợi ý. Nạp theo lô ghi hết lịch sử trước rồi mới chạy máy, nên
  // lúc từng tin của nhân viên được ghi thì chưa có gợi ý nào để nối vào — không có bước này thì
  // cột "câu nhân viên thật" vĩnh viễn rỗng và nấc SHADOW không so sánh được với ai.
  const noiLai = await relinkHumanReplies({ pageId }, db);
  console.log(`  Nối câu nhân viên  : ${noiLai.linked} gợi ý có câu người (${noiLai.updated} dòng đổi)`);

  // ───────── CHỨNG MINH, KHÔNG KHẲNG ĐỊNH ─────────
  const since = new Date(Date.now() - 3_600_000);
  const [sent] = await db.select({ n: sql<number>`count(*)` }).from(schema.salesSuggestions).where(eq(schema.salesSuggestions.sent, true));
  const [agentMsgs] = await db.select({ n: sql<number>`count(*)` }).from(schema.salesMessages).where(eq(schema.salesMessages.fromAgent, true));
  const [orders] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.salesConversations)
    .where(sql`${schema.salesConversations.orderId} is not null`);
  const [runs] = await db
    .select({
      n: sql<number>`count(*)`,
      handed: sql<number>`count(*) filter (where ${schema.aiRuns.status} = 'HANDED_OFF')`,
      failed: sql<number>`count(*) filter (where ${schema.aiRuns.status} = 'FAILED')`,
      unpriced: sql<number>`count(*) filter (where ${schema.aiRuns.costVnd} is null)`,
    })
    .from(schema.aiRuns)
    .where(and(gte(schema.aiRuns.startedAt, since), eq(schema.aiRuns.subjectType, "CONVERSATION")));

  console.log("\n───────── KIỂM CHỨNG TRÊN CHÍNH CSDL ─────────");
  console.log(`  Gợi ý đã GỬI cho khách   : ${Number(sent?.n ?? 0)}   ${Number(sent?.n ?? 0) === 0 ? "✓" : "✗ PHẢI BẰNG 0"}`);
  console.log(`  Tin do AI gửi            : ${Number(agentMsgs?.n ?? 0)}   ${Number(agentMsgs?.n ?? 0) === 0 ? "✓" : "✗ PHẢI BẰNG 0"}`);
  console.log(`  Hội thoại đã lên đơn     : ${Number(orders?.n ?? 0)}   ${Number(orders?.n ?? 0) === 0 ? "✓" : "✗ PHẢI BẰNG 0"}`);
  console.log(`  Lượt chạy 1 giờ qua      : ${Number(runs?.n ?? 0)} · chuyển người ${Number(runs?.handed ?? 0)} · lỗi ${Number(runs?.failed ?? 0)} · chưa khai giá ${Number(runs?.unpriced ?? 0)}`);
  console.log("\nMở màn hình soát: /ai/review");

  const clean = Number(sent?.n ?? 0) === 0 && Number(agentMsgs?.n ?? 0) === 0 && Number(orders?.n ?? 0) === 0;
  process.exit(clean ? 0 : 1);
}

main().catch((error) => {
  console.error("Lỗi:", error instanceof Error ? error.message : error);
  process.exit(1);
});

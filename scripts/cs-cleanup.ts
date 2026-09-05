/**
 * Xoá các case CSKH tự tạo nhầm từ ghi chú tự động (bot Pancake) và thông báo đi kèm, rồi quét lại.
 *   npx tsx scripts/cs-cleanup.ts
 */
import "dotenv/config";
import { and, eq, gte, ilike, inArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { detectCsCases } from "@/lib/cs/detect";
import { syncPancakeChatCases } from "@/lib/cs/chat-detect";

async function main() {
  const db = await getDb();
  const bad = await db
    .select({ id: schema.csCases.id })
    .from(schema.csCases)
    .where(and(eq(schema.csCases.source, "PANCAKE_NOTE"), ilike(schema.csCases.detail, "%BOT ĐÃ TỰ ĐỘNG%")));
  const ids = bad.map((b) => b.id);
  if (ids.length) {
    await db.delete(schema.notifications).where(and(eq(schema.notifications.kind, "CS_CASE"), inArray(schema.notifications.entityId, ids)));
    await db.delete(schema.csCases).where(inArray(schema.csCases.id, ids));
  }
  const again = await detectCsCases();
  console.log(`Đã xoá ${ids.length} case từ ghi chú bot · quét lại: ${again.created} case mới`);

  // Case tự tạo từ chat (chưa ai nhận, chưa xử lý) trong 14 ngày → xoá rồi quét lại bằng logic mới (bỏ câu hỏi trước mua)
  const chatAuto = await db
    .select({ id: schema.csCases.id })
    .from(schema.csCases)
    .where(and(eq(schema.csCases.source, "PANCAKE_CHAT"), eq(schema.csCases.createdBy, "pancake-chat"), eq(schema.csCases.status, "OPEN"), or(sql`${schema.csCases.assignee} is null`, eq(schema.csCases.assignee, "")), gte(schema.csCases.createdAt, new Date(Date.now() - 14 * 86_400_000))));
  const chatIds = chatAuto.map((c) => c.id);
  if (chatIds.length) {
    await db.delete(schema.notifications).where(and(eq(schema.notifications.kind, "CS_CASE"), inArray(schema.notifications.entityId, chatIds)));
    await db.delete(schema.csCases).where(inArray(schema.csCases.id, chatIds));
  }
  let rescan = "bỏ qua (chưa có PANCAKE_ACCESS_TOKEN)";
  try {
    const r = await syncPancakeChatCases({ hours: 24 * 7 });
    rescan = `${r.scanned} hội thoại · ${r.created} case hợp lệ`;
  } catch (e) {
    rescan = `lỗi: ${e instanceof Error ? e.message : String(e)}`;
  }
  console.log(`Đã xoá ${chatIds.length} case tự tạo từ chat · quét lại 7 ngày: ${rescan}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });

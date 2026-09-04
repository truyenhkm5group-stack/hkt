/**
 * Xoá các case CSKH tự tạo nhầm từ ghi chú tự động (bot Pancake) và thông báo đi kèm, rồi quét lại.
 *   npx tsx scripts/cs-cleanup.ts
 */
import "dotenv/config";
import { and, eq, ilike, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { detectCsCases } from "@/lib/cs/detect";

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
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });

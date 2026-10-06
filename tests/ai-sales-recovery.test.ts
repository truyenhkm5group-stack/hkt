import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { DEAD_AI_DOWN_NOTE } from "@/lib/sales-chatbot/inbound-retry";
import { classifyMissedConversation, findMissedConversations } from "@/lib/sales-chatbot/recovery";

/**
 * ═══════════ CỨU HỘI THOẠI BỊ BỎ SÓT TRONG SỰ CỐ AI (P1 sau sự cố P0 06/10/2026) ═══════════
 *
 * Bốn lớp, không gửi gì: đã có đơn · nhân viên đã trả lời · máy tự thử lại (tin AI hỏng còn trong 30 phút — người đừng nhắn
 * trùng) · cần nhân viên (khách chờ quá 30 phút). Hội thoại bot ĐÃ trả lời sau tin khách cuối không bao giờ vào danh sách.
 * Mốc đi theo đồng hồ thật (luật 50/65).
 */

const ORG = "ai-recovery";
const now = new Date();
const ago = (min: number) => new Date(now.getTime() - min * 60_000);

function testPure() {
  const f = (p: Partial<Parameters<typeof classifyMissedConversation>[0]> = {}) => ({ lastCustomerAt: ago(10), orderAfter: false, pageReplyAfter: false, deadAiDown: false, ...p });
  assert.equal(classifyMissedConversation(f({ orderAfter: true, pageReplyAfter: true }), now), "HAS_ORDER", "đã có đơn thắng mọi lớp khác");
  assert.equal(classifyMissedConversation(f({ pageReplyAfter: true, deadAiDown: true }), now), "STAFF_HANDLED", "nhân viên đã trả lời ⇒ không phải việc của máy");
  assert.equal(classifyMissedConversation(f({ deadAiDown: true }), now), "AI_SAFE_RESUME", "tin AI hỏng còn trong 30 phút ⇒ máy tự thử lại");
  assert.equal(classifyMissedConversation(f({ deadAiDown: true, lastCustomerAt: ago(45) }), now), "HUMAN_REVIEW", "quá 30 phút ⇒ bot không tự nhắn vào hội thoại đã nguội");
  assert.equal(classifyMissedConversation(f(), now), "HUMAN_REVIEW");
  console.log("✓ Cứu hội thoại bỏ sót (thuần): đơn > nhân viên > máy thử lại (≤ 30 phút) > cần người");
}

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, code));
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

async function testRealOrg() {
  await withOrganization(ORG, async () => {
    const db = await getDb();
    const t = schema.salesChatInbound;
    const P = "page-r";
    let n = 0;
    const cust = (thread: string, min: number, status = "DONE", note: string | null = null) => ({ pageId: P, threadId: thread, messageId: `rc-${++n}`, text: `tin ${thread}`, customerName: `Khách ${thread}`, status, note, createdAt: ago(min), processedAt: ago(min) });
    const out = (thread: string, min: number, note: "BOT_SENT" | "PAGE_REPLY") => ({ pageId: P, threadId: thread, messageId: `${note === "BOT_SENT" ? "bot-out" : "staff-out"}:${++n}`, text: "dạ", status: "DONE", note, createdAt: ago(min), processedAt: ago(min) });
    await db.insert(t).values([
      cust("answered", 50), out("answered", 49.8, "BOT_SENT"), // bot đã trả lời ⇒ KHÔNG vào danh sách
      cust("staff", 120), out("staff", 100, "PAGE_REPLY"),
      cust("fresh", 10, "DEAD", DEAD_AI_DOWN_NOTE),
      cust("cold", 90, "DEAD", DEAD_AI_DOWN_NOTE),
      cust("order", 200, "DEAD", DEAD_AI_DOWN_NOTE),
      { ...cust("history", 30), importedAt: ago(1) }, // tin nhập lịch sử không bao giờ là việc của bot
    ]);
    const c = schema.salesChatConversations;
    const [conv] = await db.insert(c).values({ channel: "FANPAGE", visitorKey: `${P}:order`, pageId: P, threadId: "order", status: "HANDOFF" }).returning({ id: c.id });
    await db.insert(schema.orders).values({ id: "rc-order-1", insertedAt: ago(150), origin: "AI_ORDER_SYNC", salesConversationId: conv.id, stage: "NEW" } as typeof schema.orders.$inferInsert);

    const missed = await findMissedConversations(ago(24 * 60), now, now);
    const by = Object.fromEntries(missed.map((m) => [m.threadId, m.cls]));
    assert.equal(by.answered, undefined, "bot đã trả lời sau tin khách cuối ⇒ không phải hội thoại bị bỏ sót");
    assert.equal(by.history, undefined, "tin nhập lịch sử không vào danh sách");
    assert.equal(by.staff, "STAFF_HANDLED");
    assert.equal(by.fresh, "AI_SAFE_RESUME");
    assert.equal(by.cold, "HUMAN_REVIEW");
    assert.equal(by.order, "HAS_ORDER");
    const before = Number((await db.select({ id: t.id }).from(t)).length);
    await findMissedConversations(ago(24 * 60), now, now);
    assert.equal((await db.select({ id: t.id }).from(t)).length, before, "chỉ đọc — không ghi dòng nào");
  });
  console.log("✓ Cứu hội thoại bỏ sót (CSDL thật): bot đã trả lời / tin lịch sử bị loại · đơn · nhân viên · máy thử lại · cần người · chỉ đọc");
}

export async function testAiSalesRecovery() {
  testPure();
  await cleanupOrg(ORG);
  await provisionOrganization({ code: ORG, name: "Shop cứu hội thoại", plan: "trial", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: "chu@ai-recovery.local", name: "Chủ shop", password: "CuuHoiThoai@2026!" }, source: "TEST", actor: null });
  try {
    await testRealOrg();
  } finally {
    await cleanupOrg(ORG);
  }
}

/**
 * ═══════════ VÌ SAO KHÁCH KHÔNG MUA (lib/sales-chatbot/lost-reasons-shared.ts) ═══════════
 *
 * Khoá: từ khoá CÓ DẤU — «không đặt nữa» không thành «chê giá» dù bỏ dấu «đặt» = «đắt»; khách gõ không dấu vẫn bắt được với
 * từ không mơ hồ; lý do cụ thể thắng lý do chung; hội thoại còn trong khung 24 giờ là CHƯA NGÃ NGŨ, không phải «mất»; chuyển
 * người mà không thấy đơn là nhóm riêng; mọi hội thoại rơi vào đúng một ô; drill-down mở đúng tập hội thoại của một lý do.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { resolvePermissions } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { recordConversationEvent } from "@/lib/sales-chatbot/events";
import { listDrillConversations } from "@/lib/sales-chatbot/experiment-report";
import { drillHref, parseDrillFilter } from "@/lib/sales-chatbot/experiment-shared";
import { loadLostReasons } from "@/lib/sales-chatbot/lost-reasons";
import { classifyDeclineText, LOST_SILENCE_MS, lostReasonOf, lostReport } from "@/lib/sales-chatbot/lost-reasons-shared";

const ORG = "ly-do-mat-khach";

function testPure() {
  const c = (t: string) => classifyDeclineText(t).code;
  assert.equal(c("Khách chê đắt quá"), "PRICE_TOO_HIGH");
  assert.equal(c("khach che dat qua"), "OTHER", "không dấu «dat» là đắt hay đặt? — không đoán");
  assert.equal(c("Khách nói không đặt nữa"), "OTHER", "«đặt» không phải «đắt»");
  assert.equal(c("Khách ngại phí ship 40k"), "SHIPPING_COST");
  assert.equal(c("phi ship cao qua"), "SHIPPING_COST", "khách gõ không dấu, từ không mơ hồ ⇒ vẫn bắt");
  assert.equal(c("Ship đắt quá nên thôi"), "SHIPPING_COST", "lý do cụ thể (ship) thắng lý do chung (đắt)");
  assert.equal(c("Hết size L rồi"), "SIZE_UNAVAILABLE");
  assert.equal(c("Khách để cuối tháng mua"), "CUSTOMER_DELAYED");
  assert.equal(c("Đã mua bên khác rồi"), "BOUGHT_ELSEWHERE");
  assert.equal(c("Không thích màu này"), "PRODUCT_NOT_SUITABLE");
  assert.equal(c("Khách từ chối"), "OTHER");
  assert.equal(classifyDeclineText("chê giá").evidence, "chê giá", "bằng chứng = từ khoá khớp");

  const now = new Date("2026-10-05T10:00:00Z");
  const old = new Date(now.getTime() - LOST_SILENCE_MS - 1);
  const fresh = new Date(now.getTime() - LOST_SILENCE_MS + 60_000);
  const base = { ordered: false, declinedReason: null, handedOff: false, quoted: false, lastCustomerAt: old };
  assert.equal(lostReasonOf({ ...base, ordered: true }, now), null, "có đơn ⇒ không phải mất");
  assert.equal(lostReasonOf({ ...base, lastCustomerAt: fresh }, now), null, "còn trong khung 24 giờ ⇒ CHƯA NGÃ NGŨ");
  assert.deepEqual(lostReasonOf({ ...base, lastCustomerAt: fresh, declinedReason: "chê đắt" }, now), { code: "PRICE_TOO_HIGH", basis: "DECLINED_MATCHED", evidence: "đắt" }, "từ chối rõ ⇒ ngã ngũ ngay");
  assert.equal(lostReasonOf({ ...base, declinedReason: "không lấy" }, now)?.basis, "DECLINED_UNMATCHED");
  assert.equal(lostReasonOf({ ...base, handedOff: true, quoted: true }, now)?.code, "HANDED_TO_HUMAN", "chuyển người mà không thấy đơn ⇒ nhóm riêng, không phải «im lặng»");
  assert.equal(lostReasonOf({ ...base, quoted: true }, now)?.code, "NO_RESPONSE_AFTER_PRICE");
  assert.deepEqual(lostReasonOf(base, now), { code: "NO_RESPONSE", basis: "SILENCE", evidence: null });

  const r = lostReport([{ ordered: true, reason: null }, { ordered: false, reason: null }, { ordered: false, reason: "PRICE_TOO_HIGH" }, { ordered: false, reason: "PRICE_TOO_HIGH" }, { ordered: false, reason: "NO_RESPONSE" }]);
  assert.deepEqual([r.conversations, r.ordered, r.open, r.lost], [5, 1, 1, 3]);
  assert.equal(r.ordered + r.open + r.rows.reduce((n, x) => n + x.count, 0), r.conversations, "mọi hội thoại rơi vào đúng một ô");
  assert.deepEqual(r.rows.map((x) => [x.code, x.count]), [["PRICE_TOO_HIGH", 2], ["NO_RESPONSE", 1]]);
  assert.equal(lostReport([]).rows.length, 0);

  assert.equal(parseDrillFilter({ lost: "PRICE_TOO_HIGH" }).lost, "PRICE_TOO_HIGH");
  assert.equal(parseDrillFilter({ lost: "DROP TABLE" }).lost, null, "giá trị lạ bị bỏ");
  assert.ok(drillHref({ days: 30, lost: "SHIPPING_COST" }).endsWith("lost=SHIPPING_COST"));
  console.log("✓ Vì sao khách không mua · thuần: từ khoá có dấu («đặt» ≠ «đắt»), không dấu chỉ với từ không mơ hồ · lý do cụ thể thắng lý do chung · trong 24 giờ = chưa ngã ngũ, từ chối rõ = ngã ngũ ngay · chuyển người không thấy đơn là nhóm riêng · mọi hội thoại đúng một ô · bộ lọc drill-down bỏ giá trị lạ");
}

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

async function testRealOrg() {
  await withOrganization(ORG, async () => {
    const db = await getDb();
    const u = await db.query.users.findFirst({ where: eq(schema.users.email, `chu@${ORG}.local`) });
    assert.ok(u);
    const admin = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: resolvePermissions("ADMIN", null), scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false }, modules: [...(await getEnabledModules(ORG))] } as unknown as SessionUser;
    // Mốc đi theo đồng hồ thật, cùng nhịp với `now()` của phép đọc (luật 50): «30 giờ trước» luôn trong kỳ 7 ngày VÀ quá khung 24 giờ.
    const now = new Date();
    const ago = (h: number) => new Date(now.getTime() - h * 3_600_000);
    const conv = async () => (await db.insert(schema.salesChatConversations).values({ channel: "FANPAGE" }).returning({ id: schema.salesChatConversations.id }))[0].id;
    const decline = await conv();
    await recordConversationEvent(decline, { type: "message.received", actorKind: "CUSTOMER", occurredAt: ago(1), key: "msg:1" });
    await recordConversationEvent(decline, { type: "quote.given", actorKind: "AI", occurredAt: ago(1), key: "quote:1" });
    await recordConversationEvent(decline, { type: "conversation.declined", actorKind: "CUSTOMER", occurredAt: ago(1), payload: { reason: "Khách chê phí ship cao" }, key: "declined:0" });
    const silent = await conv();
    await recordConversationEvent(silent, { type: "message.received", actorKind: "CUSTOMER", occurredAt: ago(30), key: "msg:1" });
    await recordConversationEvent(silent, { type: "quote.given", actorKind: "AI", occurredAt: ago(30), key: "quote:1" });
    const open = await conv();
    await recordConversationEvent(open, { type: "message.received", actorKind: "CUSTOMER", occurredAt: ago(2), key: "msg:1" });
    const bought = await conv();
    await recordConversationEvent(bought, { type: "message.received", actorKind: "CUSTOMER", occurredAt: ago(40), key: "msg:1" });
    await recordConversationEvent(bought, { type: "order.confirmed", actorKind: "CUSTOMER", occurredAt: ago(39), orderId: "erp-ldmk-1", key: "confirm:erp-ldmk-1" });
    const [test] = await db.insert(schema.salesChatConversations).values({ channel: "TEST" }).returning({ id: schema.salesChatConversations.id });
    await recordConversationEvent(test.id, { type: "message.received", actorKind: "CUSTOMER", occurredAt: ago(30), key: "msg:1" });

    const r = await loadLostReasons({ days: 7 });
    assert.deepEqual([r.conversations, r.ordered, r.open, r.lost], [4, 1, 1, 2], `khung thử loại: ${JSON.stringify(r)}`);
    assert.deepEqual(r.rows.map((x) => [x.code, x.count]).sort(), [["NO_RESPONSE_AFTER_PRICE", 1], ["SHIPPING_COST", 1]]);
    assert.deepEqual(r.idsByReason.SHIPPING_COST, [decline]);
    const drill = await listDrillConversations(admin, { days: 7, cohort: null, reason: null, arm: null, confirmed: false, lost: "NO_RESPONSE_AFTER_PRICE" });
    assert.ok("ok" in drill && drill.rows.map((x) => x.id).join() === silent, JSON.stringify(drill));
    const none = await listDrillConversations(admin, { days: 7, cohort: null, reason: null, arm: null, confirmed: false, lost: "OUT_OF_STOCK" });
    assert.ok("ok" in none && none.rows.length === 0, "lý do không có hội thoại nào ⇒ danh sách rỗng, không phải mọi hội thoại");
  });
  console.log("✓ Vì sao khách không mua · tổ chức thật: từ chối rõ (phí ship) · im lặng sau báo giá · còn trong 24 giờ = chưa ngã ngũ · có đơn · khung thử loại · drill-down mở đúng hội thoại của một lý do, lý do rỗng ⇒ danh sách rỗng");
}

export async function testLostReasons() {
  testPure();
  await cleanupOrg(ORG);
  await provisionOrganization({ code: ORG, name: "Shop lý do mất khách", plan: "trial", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `chu@${ORG}.local`, name: "Chủ shop", password: "LyDoMatKhach@2026!" }, source: "TEST", actor: null });
  try {
    await testRealOrg();
  } finally {
    await cleanupOrg(ORG);
  }
}

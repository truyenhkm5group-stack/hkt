/**
 * ═══════════ RÀ LỖI AI TRÊN HỘI THOẠI THẬT (lib/sales-chatbot/quality-shared.ts · quality.ts) ═══════════
 *
 * Khoá:
 *  · giá trong câu bot có căn cứ khi nằm trong giá bảng / phí ship / số công cụ trả / số đã nói trước — không thì cờ, MỘT lần;
 *  · tin của nhân viên («[Shop đã nhắn]») KHÔNG BAO GIỜ bị cờ, nhưng số họ nói là căn cứ khi bot nhắc lại;
 *  · công cụ lỗi ⇒ cờ; khách gửi lại y nguyên câu đã hỏi SAU khi bot trả lời ⇒ cờ; «dạ», «ok» không tính;
 *  · trên CSDL thật: hàng đợi chỉ quét hội thoại bot trả lời trong kỳ (khung thử loại), quyết định rà ghi `users.id` + tên do
 *    máy chủ đọc, rà lại SỬA dòng cũ, người không có quyền / phát hiện không còn / hội thoại khung thử ⇒ từ chối, không ghi.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiBlock } from "@/lib/ai/provider";
import { resolvePermissions } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { recordConversationEvent } from "@/lib/sales-chatbot/events";
import { loadQualityQueue, reviewQualityFindingCore } from "@/lib/sales-chatbot/quality";
import { scanConversation, type ScanMessage } from "@/lib/sales-chatbot/quality-shared";
import { DEFAULT_SALES_CHATBOT_CONFIG } from "@/lib/sales-chatbot/config";
import { loadReadiness } from "@/lib/sales-chatbot/readiness";
import { assessReadiness } from "@/lib/sales-chatbot/readiness-shared";

const ORG = "ra-loi-ai";
const T0 = new Date("2026-10-05T03:00:00Z");
const msg = (seq: number, role: "user" | "assistant", content: AiBlock[]): ScanMessage => ({ seq, role, content, at: new Date(T0.getTime() + seq * 60_000) });
const say = (seq: number, role: "user" | "assistant", text: string) => msg(seq, role, [{ type: "text", text }]);

function testPure() {
  const catalog = new Set([350_000, 30_000]);
  const tool = (seq: number, content: string, isError = false): ScanMessage => msg(seq, "user", [{ type: "tool_result", toolUseId: "t1", content, isError }]);
  const callTool = (seq: number): ScanMessage => msg(seq, "assistant", [{ type: "tool_use", id: "t1", name: "calculate_cart", input: {} }]);
  const f = scanConversation(
    [
      say(1, "user", "Váy hoa giá bao nhiêu shop?"),
      say(2, "assistant", "Dạ váy hoa giá 350.000đ ạ, ship 30k."),
      callTool(3),
      tool(4, '{"total":730000}'),
      say(5, "assistant", "Dạ 2 váy + ship tổng 730.000đ ạ."),
      say(6, "assistant", "Hôm nay shop giảm còn 299k cho chị ạ."),
      say(7, "assistant", "Dạ vâng, giá 299k chị nhé."),
      say(8, "assistant", "[Shop đã nhắn] Chị lấy 2 cái em để 650k nhé"),
      say(9, "assistant", "Dạ đúng rồi ạ, 650.000đ cho 2 váy."),
    ],
    catalog,
  );
  const prices = f.filter((x) => x.kind === "PRICE_UNGROUNDED");
  assert.deepEqual(prices.map((x) => [x.seq, x.amounts]), [[6, [299_000]]], `chỉ câu «giảm còn 299k» là không căn cứ; nhắc lại không cờ lần hai; số nhân viên nói là căn cứ: ${JSON.stringify(prices)}`);
  assert.ok(!f.some((x) => x.seq === 8), "tin nhân viên không bao giờ bị cờ");

  const t = scanConversation([callTool(1), tool(2, "Không tìm thấy mẫu mã", true), say(3, "assistant", "Dạ chị chờ em chút ạ")], catalog);
  assert.deepEqual(t.map((x) => [x.kind, x.seq]), [["TOOL_ERROR", 2]]);
  assert.match(t[0].evidence, /calculate_cart/, "bằng chứng nêu tên công cụ");

  const rep = scanConversation([say(1, "user", "Áo này có size XL không ạ?"), say(2, "assistant", "Dạ áo đẹp lắm ạ"), say(3, "user", "áo này có size XL không ạ"), say(4, "user", "ok"), say(5, "assistant", "Dạ"), say(6, "user", "ok")], catalog);
  assert.deepEqual(rep.map((x) => [x.kind, x.seq]), [["REPEATED_QUESTION", 3]], "hỏi lại y nguyên sau khi bot trả lời ⇒ cờ; «ok» quá ngắn ⇒ không");
  const noBot = scanConversation([say(1, "user", "Áo này có size XL không ạ?"), say(2, "user", "Áo này có size XL không ạ?")], catalog);
  assert.equal(noBot.length, 0, "khách gửi hai lần liền khi bot CHƯA trả lời ⇒ không phải bot trả lời sai");
  assert.match(scanConversation([say(1, "assistant", "Gọi em 0912345678 giá 999k")], catalog)[0].evidence, /••••678/, "bằng chứng che SĐT");
  // Sẵn sàng tự trả lời: một mục HỎNG ⇒ chưa sẵn sàng; chỉ còn lưu ý ⇒ sẵn sàng còn lưu ý; đủ ⇒ sẵn sàng.
  const good = { botEnabled: true, aiReady: true, aiReason: null, pricedVariants: 12, sellWithoutStockCheck: false, stockReceipts: 3, notifyGroupOnHandoff: true, realConversations30d: 40, testDrafts30d: 2, replayRuns30d: 1, confirmedPriceErrors7d: 0 };
  assert.equal(assessReadiness(good).verdict, "READY");
  assert.equal(assessReadiness({ ...good, replayRuns30d: 0 }).verdict, "READY_WITH_WARNINGS");
  assert.equal(assessReadiness({ ...good, pricedVariants: 0 }).verdict, "NOT_READY", "không có giá nào ⇒ bot không có gì để báo");
  assert.equal(assessReadiness({ ...good, aiReady: false, aiReason: "Hết credit" }).checks.find((c) => c.key === "AI_READY")?.detail, "Hết credit", "nói đúng lý do khoá AI hỏng");
  assert.equal(assessReadiness({ ...good, sellWithoutStockCheck: true, stockReceipts: 0 }).checks.find((c) => c.key === "STOCK")?.status, "WARN", "bán không kiểm tồn là lựa chọn của shop — lưu ý, không phải hỏng");
  assert.equal(assessReadiness({ ...good, confirmedPriceErrors7d: 2 }).verdict, "READY_WITH_WARNINGS");
  console.log("✓ Rà lỗi AI · thuần: giá có căn cứ (bảng · ship · công cụ · đã nói) ⇒ không cờ, bịa ⇒ cờ MỘT lần · tin nhân viên không bị cờ nhưng là căn cứ · công cụ lỗi nêu tên · hỏi lại y nguyên sau khi bot trả lời ⇒ cờ, «ok» / chưa ai trả lời ⇒ không · bằng chứng che SĐT");
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
    const base = { id: u.id, email: u.email, name: u.name, scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false }, modules: [...(await getEnabledModules(ORG))] };
    const admin = { ...base, role: "ADMIN", permissions: resolvePermissions("ADMIN", null) } as unknown as SessionUser;
    const viewer = { ...base, role: "VIEWER", permissions: ["ai_sales:view"] } as unknown as SessionUser;
    await db.insert(schema.productVariants).values({ id: "erp-rla-var", productId: (await db.insert(schema.products).values({ id: "erp-rla-p", name: "Váy hoa", raw: { origin: "ERP_MANUAL" } }).returning({ id: schema.products.id }))[0].id, sku: "VH-M", retailPrice: 350_000 });
    const now = new Date();
    const mk = async (channel: string) => (await db.insert(schema.salesChatConversations).values({ channel }).returning({ id: schema.salesChatConversations.id }))[0].id;
    const put = (conv: string, seq: number, role: string, text: string) => db.insert(schema.salesChatMessages).values({ conversationId: conv, seq, role, content: [{ type: "text", text }] });
    const real = await mk("FANPAGE");
    await put(real, 1, "user", "Váy hoa bao nhiêu?");
    await put(real, 2, "assistant", "Dạ 350.000đ ạ");
    await put(real, 3, "assistant", "Hôm nay giảm còn 290k ạ");
    await recordConversationEvent(real, { type: "ai.replied", actorKind: "AI", occurredAt: now, payload: { mode: "AI" }, key: "reply:1" });
    const test = await mk("TEST");
    await put(test, 1, "assistant", "Giá 123k ạ");
    await recordConversationEvent(test, { type: "ai.replied", actorKind: "AI", occurredAt: now, payload: { mode: "AI" }, key: "reply:1" });

    const q = await loadQualityQueue(admin, { days: 1 });
    assert.ok("ok" in q, JSON.stringify(q));
    assert.equal(q.value.conversationsScanned, 1, "khung thử không quét");
    assert.deepEqual(q.value.items.map((i) => [i.conversationId, i.seq, i.kind, i.status]), [[real, 3, "PRICE_UNGROUNDED", "OPEN"]]);

    const fail = await reviewQualityFindingCore(viewer, { conversationId: real, seq: 3, kind: "PRICE_UNGROUNDED", status: "CONFIRMED" });
    assert.ok("error" in fail, "chỉ xem ⇒ không rà được");
    assert.ok("error" in (await reviewQualityFindingCore(admin, { conversationId: real, seq: 2, kind: "PRICE_UNGROUNDED", status: "CONFIRMED" })), "tin không có phát hiện ⇒ không ghi được «đã rà»");
    assert.ok("error" in (await reviewQualityFindingCore(admin, { conversationId: test, seq: 1, kind: "PRICE_UNGROUNDED", status: "CONFIRMED" })), "khung thử ⇒ không có");
    assert.ok("error" in (await reviewQualityFindingCore(admin, { conversationId: real, seq: 3, kind: "PRICE_UNGROUNDED", status: "OPEN" })), "trạng thái lạ ⇒ từ chối");
    assert.equal((await db.select().from(schema.salesAiReviews)).length, 0, "bốn lượt bị từ chối không ghi dòng nào");

    assert.ok("ok" in (await reviewQualityFindingCore(admin, { conversationId: real, seq: 3, kind: "PRICE_UNGROUNDED", status: "CONFIRMED", note: "giảm giá không có trong chính sách" })));
    assert.ok("ok" in (await reviewQualityFindingCore(admin, { conversationId: real, seq: 3, kind: "PRICE_UNGROUNDED", status: "DISMISSED", note: "chủ shop cho giảm hôm nay" })));
    const rows = await db.select().from(schema.salesAiReviews);
    assert.ok(rows.length === 1 && rows[0].status === "DISMISSED" && rows[0].reviewerUserId === u.id && rows[0].reviewerName === u.name, `rà lại sửa dòng cũ, người rà là khoá tài khoản + tên máy chủ đọc: ${JSON.stringify(rows)}`);
    const q2 = await loadQualityQueue(admin, { days: 1 });
    assert.ok("ok" in q2 && q2.value.open === 0 && q2.value.dismissed === 1 && q2.value.items[0].note === "chủ shop cho giảm hôm nay");
    assert.equal((await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "SALES_AI_REVIEW"))).length, 2, "mỗi lượt rà một dòng nhật ký");

    // Sẵn sàng tự trả lời trên dữ liệu thật: bot tắt ⇒ chưa sẵn sàng; bật + AI dùng được ⇒ còn lưu ý (chưa phiếu nhập, chưa
    // báo nhóm, chưa thử, chưa phát lại); một lỗi giá ĐÃ XÁC NHẬN hiện ra đúng số.
    const off = await loadReadiness(DEFAULT_SALES_CHATBOT_CONFIG, { ready: true, reason: null });
    assert.equal(off.verdict, "NOT_READY");
    const on = await loadReadiness({ ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: true }, { ready: true, reason: null });
    const st = Object.fromEntries(on.checks.map((c) => [c.key, c.status]));
    assert.deepEqual(st, { BOT_ENABLED: "PASS", AI_READY: "PASS", PRICES: "PASS", STOCK: "WARN", HANDOFF: "WARN", CHANNEL: "WARN", TEST_ORDER: "WARN", REPLAY: "WARN", PRICE_ERRORS: "PASS" }, JSON.stringify(on.checks));
    assert.equal(on.verdict, "READY_WITH_WARNINGS");
    assert.ok("ok" in (await reviewQualityFindingCore(admin, { conversationId: real, seq: 3, kind: "PRICE_UNGROUNDED", status: "CONFIRMED" })));
    assert.equal((await loadReadiness({ ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: true }, { ready: true, reason: null })).checks.find((c) => c.key === "PRICE_ERRORS")?.label, "1 lỗi giá đã xác nhận (7 ngày)");
  });
  console.log("✓ Rà lỗi AI · tổ chức thật: quét hội thoại bot trả lời trong kỳ (khung thử loại) · chỉ xem / tin không có phát hiện / khung thử / trạng thái lạ ⇒ từ chối, không ghi · rà lại sửa dòng cũ, người rà mang users.id + tên máy chủ đọc · nhật ký mỗi lượt · bảng sẵn sàng tự trả lời đọc số thật (bot tắt ⇒ chưa sẵn sàng; lỗi giá đã xác nhận hiện đúng số)");
}

export async function testAiQuality() {
  testPure();
  await cleanupOrg(ORG);
  await provisionOrganization({ code: ORG, name: "Shop rà lỗi AI", plan: "trial", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `chu@${ORG}.local`, name: "Chủ shop", password: "RaLoiAi@2026!" }, source: "TEST", actor: null });
  try {
    await testRealOrg();
  } finally {
    await cleanupOrg(ORG);
  }
}

/**
 * CHẾ ĐỘ VẬN HÀNH CỦA BOT BÁN HÀNG (lib/sales-chatbot/operating-mode*.ts · docs/productization/19_HSLC_PILOT.md).
 *
 *  1. THUẦN — mặc định TỰ ĐỘNG (không đổi hành vi shop nào); chia nhánh tất định và đúng tỷ lệ trên nhiều hội thoại; nhánh
 *     đã GHIM giữ nguyên khi đổi tỷ lệ, đổi khoá thử nghiệm thì chia lại; đọc cấu hình bẩn rơi về mặc định; độ giống
 *     (nguyên văn · sửa nhẹ · khác hẳn) và phán quyết.
 *  2. TỔ CHỨC THẬT `om-shop` + Pancake giả + provider giả, đi ĐÚNG `processFanpageThread`:
 *     · QUAN SÁT: không gọi AI, không gửi gì, tin khách đánh dấu bỏ qua có lý do;
 *     · COPILOT: gọi AI một lượt ở hội thoại bóng, KHÔNG gửi tin nào, lưu gợi ý; câu thật của page tới sau ⇒ chấm độ giống;
 *       không hội thoại bóng nào còn lại, 0 đơn;
 *     · THỬ NGHIỆM 0% AI ⇒ nhánh NGƯỜI được ghim, bot im; 100% AI ⇒ nhánh AI trả lời — và hội thoại đã ghim NGƯỜI vẫn là
 *       người sau khi đổi tỷ lệ (khoá cũ);
 *     · TỰ ĐỘNG: trả lời như cũ.
 *     · Người chỉ xem không đổi được chế độ; đổi chế độ có nhật ký.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiBlock, AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";
import type { SessionUser } from "@/lib/auth/session";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { setSalesChatProviderForTests } from "@/lib/sales-chatbot/engine";
import { COPILOT_NOTE, OBSERVE_HUMAN_ARM_NOTE, OBSERVE_NOTE, PAGE_REPLY, parsePancakeWebhook, processFanpageThread, receiveFanpageEvent } from "@/lib/sales-chatbot/fanpage";
import { loadCopilotView, loadModeConfig, saveModeConfig, scoreCopilotSuggestions } from "@/lib/sales-chatbot/operating-mode";
import { armFor, copilotVerdict, DEFAULT_MODE_CONFIG, parseModeConfig, readPinnedArm, replyGate, similarity } from "@/lib/sales-chatbot/operating-mode-shared";
import { setSettingJson } from "@/lib/settings";

const ORG = "om-shop";
const PAGE = "5566778899";
const PAGE_TOKEN = "pancake_page_token_om_0123456789abcdef";

function testPure() {
  const cfg = DEFAULT_MODE_CONFIG;
  assert.equal(cfg.mode, "AUTOPILOT", "mặc định TỰ ĐỘNG — shop chưa đổi chế độ không thấy gì khác");
  assert.deepEqual(replyGate(cfg, "k1"), { mode: "AUTOPILOT", arm: null, experimentKey: null, pinNow: false });
  assert.equal(replyGate({ ...cfg, mode: "OBSERVE" }, "k1").mode, "OBSERVE");
  assert.equal(replyGate({ ...cfg, mode: "COPILOT" }, "k1").mode, "COPILOT");
  assert.deepEqual(parseModeConfig({ mode: "LUNG_TUNG", aiSharePct: 300, experimentKey: "KHÔNG HỢP LỆ" }), { ...DEFAULT_MODE_CONFIG }, "cấu hình bẩn ⇒ mặc định, không đoán");

  // Chia nhánh: tất định + gần đúng tỷ lệ trên nhiều hội thoại.
  const exp = { ...cfg, mode: "EXPERIMENT" as const, aiSharePct: 30, experimentKey: "e-test" };
  const keys = Array.from({ length: 2000 }, (_, i) => `page:thread-${i}`);
  const ai = keys.filter((k) => replyGate(exp, k).arm === "AI").length;
  assert.ok(ai > 2000 * 0.26 && ai < 2000 * 0.34, `30% ± 4 điểm — thực tế ${ai}/2000`);
  assert.deepEqual(keys.slice(0, 50).map((k) => replyGate(exp, k).arm), keys.slice(0, 50).map((k) => replyGate(exp, k).arm), "tất định");
  assert.equal(keys.filter((k) => replyGate({ ...exp, aiSharePct: 0 }, k).arm === "AI").length, 0);
  assert.equal(keys.filter((k) => replyGate({ ...exp, aiSharePct: 100 }, k).arm === "HUMAN").length, 0);
  const g = replyGate(exp, "page:t-x");
  assert.equal(g.pinNow, true, "lượt đầu ⇒ ghim");
  assert.equal(g.mode, g.arm === "AI" ? "AUTOPILOT" : "OBSERVE");
  // Đã ghim NGƯỜI với khoá hiện tại ⇒ đổi tỷ lệ lên 100% vẫn là NGƯỜI; khoá khác (thử nghiệm mới) ⇒ chia lại.
  const pinned = { key: "e-test", arm: "HUMAN" as const, at: "x" };
  assert.deepEqual(replyGate({ ...exp, aiSharePct: 100 }, "page:t-x", pinned), { mode: "OBSERVE", arm: "HUMAN", experimentKey: "e-test", pinNow: false });
  assert.equal(replyGate({ ...exp, aiSharePct: 100, experimentKey: "e-moi" }, "page:t-x", pinned).arm, "AI");
  assert.equal(armFor("e-test", "page:t-x", 30), armFor("e-test", "page:t-x", 30));
  assert.deepEqual(readPinnedArm({ experiment: { key: "e1", arm: "AI", at: "t" } }), { key: "e1", arm: "AI", at: "t" });
  assert.equal(readPinnedArm({ experiment: { key: "e1", arm: "ROBOT" } }), null);

  assert.equal(similarity("Dạ chả mực 250.000đ/kg ạ", "Dạ chả mực 250.000đ/kg ạ"), 1);
  assert.ok(similarity("Dạ chả mực 250.000đ/kg ạ", "dạ chả mực 250.000 đ/kg ạ!") >= 0.9, "khác dấu câu / hoa thường ⇒ gần như nguyên văn");
  assert.ok(similarity("Dạ chả mực 250.000đ/kg ạ, chị lấy mấy kg?", "Dạ chả mực 250k/kg chị nhé, chị lấy bao nhiêu ạ") < 0.9);
  assert.ok(similarity("Dạ chả mực 250.000đ/kg ạ", "Shop hết hàng rồi chị ơi, tuần sau có") < 0.5);
  assert.equal(copilotVerdict(0.95), "SAME");
  assert.equal(copilotVerdict(0.6), "EDITED");
  assert.equal(copilotVerdict(0.1), "DIFFERENT");
  assert.equal(copilotVerdict(null), "NO_REPLY");
  console.log("  ✓ chế độ vận hành (thuần): mặc định tự động, chia nhánh tất định đúng tỷ lệ, ghim nhánh, độ giống");
}

function fakePancake() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const body = url.includes("/conversations?") ? { success: true, conversations: [{ id: "c1" }] } : init?.method === "POST" ? { success: true, id: `m-bot-${Math.random().toString(36).slice(2, 8)}` } : { success: true, messages: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, calls, sent: () => calls.filter((c) => c.init?.method === "POST" && c.url.includes("/messages")) };
}

function fakeProvider(onCall: () => void): AiProvider {
  return {
    name: "fake",
    model: "claude-sonnet-5",
    schemaDialect: "anthropic",
    async complete(req: AiRequest): Promise<AiResponse> {
      onCall();
      void req;
      const content: AiBlock[] = [{ type: "text", text: "Dạ chả mực 250.000đ/kg ạ" }];
      return { content, stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
    },
  };
}

async function cleanup() {
  const pdb = await getPlatformDb();
  await pdb.delete(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, ORG));
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [ORG]));
  invalidateOrganizations();
  invalidateCapabilities();
}

export async function testSalesOperatingMode() {
  testPure();
  await cleanup();
  await provisionOrganization({ code: ORG, name: "Shop chế độ", plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "CheDo@123456" }, source: "TEST", actor: null });
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-che-do-0123456789abcdefghijklmnopqrstuvwxyz";
  let aiCalls = 0;
  setSalesChatProviderForTests(() => fakeProvider(() => (aiCalls += 1)));
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin: SessionUser = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false } };
      const viewer: SessionUser = { ...admin, id: "om-viewer", role: "VIEWER", permissions: ["ai_sales:view"] };
      await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, connectorKey: "anthropic-byok", enabled: true, shippingFee: 30_000 });
      const pancake = fakePancake();
      assert.ok("ok" in (await saveConnection(admin, { connectorKey: "pancake-fanpage", settings: { pageId: PAGE }, secrets: { pageAccessToken: PAGE_TOKEN } })));
      assert.ok("ok" in (await testOrgConnection(admin, "pancake-fanpage", { tester: { fetch: pancake.fetch } })));
      assert.ok("ok" in (await setConnectionStatus(admin, "pancake-fanpage", "ACTIVE")));
      const ev = (id: string, text: string, thread: string, from: Record<string, unknown> = { id: `cust-${thread}`, name: "Khách" }) =>
        parsePancakeWebhook({ event_type: "messaging", page_id: PAGE, data: { conversation: { id: thread, type: "INBOX" }, message: { id, type: "INBOX", message: text, from } } })!;
      const later = () => new Date(Date.now() + 5 * 60_000);
      const inbound = async (thread: string) => db.select().from(schema.salesChatInbound).where(and(eq(schema.salesChatInbound.pageId, PAGE), eq(schema.salesChatInbound.threadId, thread)));
      const sentTo = (thread: string) => pancake.sent().filter((c) => c.url.includes(`/conversations/${thread}/messages`)).length;

      assert.ok("error" in (await saveModeConfig(viewer, { mode: "OBSERVE" })), "người chỉ xem không đổi được chế độ");
      assert.equal((await loadModeConfig()).mode, "AUTOPILOT");

      // ── QUAN SÁT ──
      assert.ok("ok" in (await saveModeConfig(admin, { mode: "OBSERVE" })));
      const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "SALES_BOT_MODE_SET"));
      assert.equal(audits.length, 1, "đổi chế độ có nhật ký");
      await receiveFanpageEvent(ev("o1", "Chả mực bao nhiêu?", "t-obs"));
      const before = aiCalls;
      const r1 = await processFanpageThread(PAGE, "t-obs", { fetch: pancake.fetch, now: later });
      assert.equal(r1.skipped, OBSERVE_NOTE, JSON.stringify(r1));
      assert.equal(aiCalls, before, "quan sát ⇒ không gọi AI (không tốn tiền)");
      assert.equal(sentTo("t-obs"), 0, "quan sát ⇒ không gửi gì");
      assert.ok((await inbound("t-obs")).every((r) => r.status === "SKIPPED" && r.note === OBSERVE_NOTE));

      // ── COPILOT ──
      assert.ok("ok" in (await saveModeConfig(admin, { mode: "COPILOT" })));
      await receiveFanpageEvent(ev("p1", "Chả mực bao nhiêu?", "t-cop"));
      const r2 = await processFanpageThread(PAGE, "t-cop", { fetch: pancake.fetch, now: later });
      assert.equal(r2.skipped, COPILOT_NOTE, JSON.stringify(r2));
      assert.equal(aiCalls, before + 1, "copilot ⇒ đúng MỘT lượt AI");
      assert.equal(sentTo("t-cop"), 0, "copilot ⇒ không gửi tin nào cho khách");
      const sugg = await db.select().from(schema.salesCopilotSuggestions);
      assert.equal(sugg.length, 1);
      assert.equal(sugg[0].suggestion, "Dạ chả mực 250.000đ/kg ạ");
      assert.equal(sugg[0].scoredAt, null, "chưa có câu thật ⇒ chưa chấm");
      // Câu thật của nhân viên tới SAU gợi ý (Pancake báo tin page) ⇒ chấm.
      await db.insert(schema.salesChatInbound).values({ pageId: PAGE, threadId: "t-cop", messageId: "staff-1", text: "dạ chả mực 250.000đ/kg ạ!", status: "DONE", processedAt: new Date(), note: PAGE_REPLY, createdAt: new Date(sugg[0].createdAt.getTime() + 60_000) });
      assert.equal(await scoreCopilotSuggestions(new Date()), 1);
      const [scored] = await db.select().from(schema.salesCopilotSuggestions);
      assert.equal(scored.verdict, "SAME");
      assert.ok((scored.similarity ?? 0) >= 0.9);
      const tempLeft = await db.select({ n: sql<number>`count(*)::int` }).from(schema.salesChatConversations).where(like(schema.salesChatConversations.createdBy, "copilot:%"));
      assert.equal(Number(tempLeft[0].n), 0, "hội thoại bóng bị xoá");
      assert.equal((await db.select().from(schema.orders)).length, 0, "copilot không tạo đơn");
      const view = await loadCopilotView(viewer);
      assert.ok("ok" in view && view.stats.byVerdict.SAME === 1);

      // ── THỬ NGHIỆM ──
      assert.ok("ok" in (await saveModeConfig(admin, { mode: "EXPERIMENT", aiSharePct: 0 })));
      const key1 = (await loadModeConfig()).experimentKey;
      assert.notEqual(key1, DEFAULT_MODE_CONFIG.experimentKey, "bắt đầu thử nghiệm ⇒ khoá mới");
      await receiveFanpageEvent(ev("x1", "Còn hàng không?", "t-exp"));
      const r3 = await processFanpageThread(PAGE, "t-exp", { fetch: pancake.fetch, now: later });
      assert.equal(r3.skipped, OBSERVE_HUMAN_ARM_NOTE, JSON.stringify(r3));
      const [convExp] = await db.select({ state: schema.salesChatConversations.state }).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.threadId, "t-exp"));
      assert.deepEqual([readPinnedArm(convExp.state)?.arm, readPinnedArm(convExp.state)?.key], ["HUMAN", key1], "nhánh NGƯỜI được ghim với khoá thử nghiệm");
      // Đổi tỷ lệ lên 100% (giữ khoá) ⇒ hội thoại đã ghim vẫn là NGƯỜI; hội thoại MỚI vào nhánh AI và được bot trả lời.
      assert.ok("ok" in (await saveModeConfig(admin, { mode: "EXPERIMENT", aiSharePct: 100 })));
      assert.equal((await loadModeConfig()).experimentKey, key1, "đổi tỷ lệ không đổi khoá");
      await receiveFanpageEvent(ev("x2", "Ship bao lâu?", "t-exp"));
      const r4 = await processFanpageThread(PAGE, "t-exp", { fetch: pancake.fetch, now: () => new Date(Date.now() + 10 * 60_000) });
      assert.equal(r4.skipped, OBSERVE_HUMAN_ARM_NOTE, "nhánh đã ghim giữ nguyên");
      await receiveFanpageEvent(ev("y1", "Chả mực bao nhiêu?", "t-exp-ai"));
      const r5 = await processFanpageThread(PAGE, "t-exp-ai", { fetch: pancake.fetch, now: later });
      assert.ok(r5.replies >= 1 && !r5.error, JSON.stringify(r5));
      assert.ok(sentTo("t-exp-ai") >= 1, "nhánh AI ⇒ bot trả lời");
      const arms = await loadCopilotView(viewer);
      assert.ok("ok" in arms && arms.arms?.ai === 1 && arms.arms.human === 1, JSON.stringify("ok" in arms ? arms.arms : arms));

      // ── TỰ ĐỘNG ──
      assert.ok("ok" in (await saveModeConfig(admin, { mode: "AUTOPILOT" })));
      await receiveFanpageEvent(ev("z1", "Chả mực bao nhiêu?", "t-auto"));
      const r6 = await processFanpageThread(PAGE, "t-auto", { fetch: pancake.fetch, now: later });
      assert.ok(r6.replies >= 1 && !r6.skipped, JSON.stringify(r6));
    });
    console.log("  ✓ chế độ vận hành (tổ chức thật): quan sát im + 0 AI, copilot 1 AI + 0 tin gửi + chấm câu thật, thử nghiệm ghim nhánh, tự động như cũ");
  } finally {
    setSalesChatProviderForTests(null);
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    await cleanup();
  }
}

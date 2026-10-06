import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiProvider, AiResponse } from "@/lib/ai/provider";
import { resolvePermissions } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { AI_DOWN_HANDOFF_REASON, setSalesChatProviderForTests } from "@/lib/sales-chatbot/engine";
import { parsePancakeWebhook, processFanpageThread, receiveFanpageEvent } from "@/lib/sales-chatbot/fanpage";
import {
  ALREADY_REPLIED_NOTE,
  backoffMinutes,
  DEAD_AI_DOWN_NOTE,
  DEAD_SEND_NOTE_PREFIX,
  dueForClaim,
  INBOUND_MAX_ATTEMPTS,
  releaseWithBackoff,
  requeueAiDownDeadLetters,
  requeueDecision,
} from "@/lib/sales-chatbot/inbound-retry";
import { setSettingJson } from "@/lib/settings";

/**
 * ═══════════ TIN KHÁCH: THỬ LẠI · DEAD-LETTER · KHÔNG TRẢ LỜI TRÙNG (sau sự cố P0 06/10/2026) ═══════════
 *
 * Chạy ĐƯỜNG THẬT của bot fanpage (receiveFanpageEvent → processFanpageThread → engine → reply_inbox) với Pancake giả và
 * provider AI giả. Ba điều phải đúng: (1) AI hỏng ⇒ tin vào DEAD, KHÔNG gửi gì; provider hồi phục ⇒ thử lại và trả lời ĐÚNG
 * MỘT lần; (2) tiến trình chết sau khi gửi ⇒ lượt giành lại KHÔNG gọi AI, KHÔNG gửi lần hai — nhưng khách nhắn trong lúc bot
 * soạn câu trước vẫn được trả lời; (3) gửi hỏng ⇒ DEAD, không tự gửi lại. Mốc đi theo đồng hồ thật (luật 50/65).
 */

const ORG = "ai-retry";
const ADMIN_EMAIL = "chu@ai-retry.local";
const PAGE = "5566778899";
const PAGE_TOKEN = "pancake_page_token_retry_0123456789abcdef";

function testPure() {
  assert.deepEqual([1, 2, 3].map(backoffMinutes), [2, 4, 8], "lùi dần 2 · 4 · 8 phút");
  const now = new Date();
  const m = (min: number) => new Date(now.getTime() - min * 60_000);
  const row = (p: Partial<{ attempts: number; createdAt: Date; nextAttemptAt: Date | null }> = {}) => ({ attempts: 1, createdAt: m(5), nextAttemptAt: m(1), ...p });
  assert.deepEqual(requeueDecision(row(), now, m(0.5), m(4)), { ok: true });
  assert.equal(requeueDecision(row({ attempts: INBOUND_MAX_ATTEMPTS }), now, m(0.5), m(4)).ok, false, "hết lượt ⇒ nằm lại DEAD");
  assert.equal(requeueDecision(row({ createdAt: m(31) }), now, m(0.5), m(4)).ok, false, "quá 30 phút ⇒ hội thoại đã nguội, để người");
  assert.equal(requeueDecision(row({ nextAttemptAt: new Date(now.getTime() + 60_000) }), now, m(0.5), m(4)).ok, false, "chưa tới mốc lùi dần");
  assert.equal(requeueDecision(row(), now, null, m(4)).ok, false, "chưa biết provider hồi phục ⇒ không đốt lượt");
  assert.equal(requeueDecision(row(), now, m(10), m(4)).ok, false, "lượt thành công cuối TRƯỚC lúc hỏng ⇒ provider chưa hồi phục");
  console.log("✓ Thử lại tin khách (thuần): lùi dần 2·4·8 · tối đa 3 lượt · cửa sổ 30 phút · chỉ khi provider đã có lượt thành công sau lúc hỏng");
}

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, code));
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, code));
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

async function adminOf(): Promise<SessionUser> {
  const db = await getDb();
  const u = await db.query.users.findFirst({ where: eq(schema.users.email, ADMIN_EMAIL) });
  assert.ok(u);
  const org = await findOrganization(ORG);
  return { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: resolvePermissions("ADMIN", null), scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: org?.name ?? ORG, isHome: false }, modules: [...(await getEnabledModules(ORG))] };
}

/** Provider giả: `mode` đổi được giữa chừng — hỏng như 06/10, hoặc trả lời một câu. Đếm số lượt gọi. */
function switchableProvider() {
  const st = { mode: "CREDIT" as "CREDIT" | "OK", calls: 0 };
  const provider: AiProvider = {
    name: "fake",
    model: "claude-sonnet-5",
    schemaDialect: "anthropic",
    async complete(): Promise<AiResponse> {
      st.calls += 1;
      if (st.mode === "CREDIT") throw new Error("Gemini trả lỗi HTTP 429: Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.");
      return { content: [{ type: "text", text: "Dạ chả cá thu bên em 280k/kg ạ, anh/chị lấy mấy ký ạ?" }], stopReason: "end_turn", usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
    },
  };
  return { st, provider };
}

async function testRealOrg() {
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-thu-lai-0123456789abcdefghijklmnopqrstuvwxyz";
  const { st, provider } = switchableProvider();
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const admin = await adminOf();
      await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: true });
      const posts: string[] = [];
      let sendFails = false;
      const pancakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        let body: unknown = { success: true };
        if (url.includes("/conversations?")) body = { success: true, conversations: [{ id: "c1" }] };
        else if (init?.method === "POST") {
          if (sendFails) body = { success: false, message: "Pancake không nhận tin: conversation_id not found" };
          else {
            posts.push(String(init.body));
            body = { success: true, id: `m-bot-${posts.length}` };
          }
        }
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      const savedFp = await saveConnection(admin, { connectorKey: "pancake-fanpage", settings: { pageId: PAGE }, secrets: { pageAccessToken: PAGE_TOKEN } });
      assert.ok("ok" in savedFp, JSON.stringify(savedFp));
      assert.ok("ok" in (await testOrgConnection(admin, "pancake-fanpage", { tester: { fetch: pancakeFetch } })));
      assert.ok("ok" in (await setConnectionStatus(admin, "pancake-fanpage", "ACTIVE")));
      setSalesChatProviderForTests(() => provider);
      const t = schema.salesChatInbound;
      const cv = schema.salesChatConversations;
      const ev = (id: string, text: string, thread: string) => parsePancakeWebhook({ event_type: "messaging", page_id: PAGE, data: { conversation: { id: thread, type: "INBOX" }, message: { id, type: "INBOX", message: text, from: { id: `cust-${thread}`, name: "Chị Hoa" } } } })!;
      const later = (sec: number) => () => new Date(Date.now() + sec * 1000);
      const rowOf = async (messageId: string) => (await db.select().from(t).where(eq(t.messageId, messageId)))[0];

      // 1 · AI HẾT TIỀN ⇒ tin vào DEAD, KHÔNG gửi gì, hội thoại chuyển người.
      assert.ok((await receiveFanpageEvent(ev("r-m1", "Chả cá thu bao nhiêu em?", "r-t1"))).queued);
      const r1 = await processFanpageThread(PAGE, "r-t1", { fetch: pancakeFetch, now: later(31) });
      assert.equal(r1.processed, 1, JSON.stringify(r1));
      assert.equal(posts.length, 0, "AI hỏng ⇒ không câu nào tới khách");
      const dead = await rowOf("r-m1");
      assert.equal(dead.status, "DEAD", "tin bot không trả lời được nằm ở DEAD, không chốt DONE lẫn với tin đã xử lý");
      assert.equal(dead.note, DEAD_AI_DOWN_NOTE);
      assert.equal(dead.attempts, 1);
      assert.ok(dead.lastError && /prepayment|billing/i.test(dead.lastError), "giữ câu lỗi gốc cho người vận hành");
      assert.ok(dead.nextAttemptAt && dead.nextAttemptAt.getTime() > Date.now(), "hẹn mốc lùi dần");
      const conv = (await db.select().from(cv).where(eq(cv.threadId, "r-t1")))[0];
      assert.equal(conv.status, "HANDOFF");
      assert.equal(conv.handoffReason, AI_DOWN_HANDOFF_REASON);

      // 2 · Provider CHƯA hồi phục ⇒ không thử lại (không đốt lượt).
      const at3 = new Date(Date.now() + 3 * 60_000);
      const no = await requeueAiDownDeadLetters(AI_DOWN_HANDOFF_REASON, null, at3);
      assert.equal(no.requeued.length, 0);
      assert.equal((await rowOf("r-m1")).status, "DEAD");

      // 3 · Provider HỒI PHỤC ⇒ trả tin về hàng chờ, mở lại hội thoại, trả lời ĐÚNG MỘT lần.
      st.mode = "OK";
      const yes = await requeueAiDownDeadLetters(AI_DOWN_HANDOFF_REASON, new Date(at3.getTime() - 30_000), at3);
      assert.deepEqual(yes.requeued, [{ pageId: PAGE, threadId: "r-t1" }], JSON.stringify(yes));
      assert.equal((await rowOf("r-m1")).status, "PENDING");
      assert.equal((await db.select().from(cv).where(eq(cv.id, conv.id)))[0].status, "OPEN");
      const r2 = await processFanpageThread(PAGE, "r-t1", { fetch: pancakeFetch, catchUp: true, now: () => at3 });
      assert.ok(r2.replies >= 1 && !r2.error, JSON.stringify(r2));
      assert.equal(posts.length, 1, "thử lại thành công ⇒ khách nhận ĐÚNG MỘT câu");
      assert.equal((await rowOf("r-m1")).status, "DONE");
      const again = await requeueAiDownDeadLetters(AI_DOWN_HANDOFF_REASON, at3, new Date(at3.getTime() + 60_000));
      assert.equal(again.requeued.length, 0, "đã xử lý xong ⇒ không thử lại nữa");

      // 4 · TIẾN TRÌNH CHẾT SAU KHI GỬI: tin còn PENDING với lượt giành quá hạn, câu bot đã gửi SAU mốc giành ⇒ không gọi AI,
      //     không gửi lần hai.
      const t0 = Date.now() - 10 * 60_000;
      await db.insert(t).values({ pageId: PAGE, threadId: "r-t2", messageId: "r-m2", text: "Ship về Hà Đông bao lâu?", status: "PENDING", claimId: "luot-da-chet", claimedAt: new Date(t0 + 60_000), createdAt: new Date(t0) });
      await db.insert(t).values({ pageId: PAGE, threadId: "r-t2", messageId: "bot-out:da-gui", text: "dạ 1-2 ngày ạ", status: "DONE", processedAt: new Date(t0 + 90_000), note: "BOT_SENT", createdAt: new Date(t0 + 90_000) });
      const callsBefore = st.calls;
      const postsBefore = posts.length;
      const r3 = await processFanpageThread(PAGE, "r-t2", { fetch: pancakeFetch, catchUp: true });
      assert.equal(r3.skipped, ALREADY_REPLIED_NOTE, JSON.stringify(r3));
      assert.equal(st.calls, callsBefore, "không gọi AI lần hai");
      assert.equal(posts.length, postsBefore, "không gửi câu thứ hai cho khách");
      assert.equal((await rowOf("r-m2")).status, "DONE");

      // 4b · REVIEW #607: lượt chết đã trả lời M1, khách gửi M2 rồi lượt sau giành CHUNG M1 + M2 ⇒ M1 chốt không gọi AI, M2
      //      VẪN được trả lời (trước bản sửa: M2 bị đánh dấu «đã trả lời» và khách không bao giờ nhận câu nào).
      const t2 = Date.now() - 10 * 60_000;
      await db.insert(t).values({ pageId: PAGE, threadId: "r-t6", messageId: "r-m7", text: "Có giao Hải Phòng không?", status: "PENDING", claimId: "luot-chet-2", claimedAt: new Date(t2 + 60_000), createdAt: new Date(t2) });
      await db.insert(t).values({ pageId: PAGE, threadId: "r-t6", messageId: "bot-out:da-gui-2", text: "dạ có ạ", status: "DONE", processedAt: new Date(t2 + 90_000), note: "BOT_SENT", createdAt: new Date(t2 + 90_000) });
      await db.insert(t).values({ pageId: PAGE, threadId: "r-t6", messageId: "r-m8", text: "Vậy lấy chị 1 ký", status: "PENDING", createdAt: new Date(t2 + 170_000) });
      const postsB = posts.length;
      const r3b = await processFanpageThread(PAGE, "r-t6", { fetch: pancakeFetch, catchUp: true });
      assert.equal((await rowOf("r-m7")).note, ALREADY_REPLIED_NOTE, "M1 (lượt chết đã trả lời) chốt không gọi AI");
      assert.equal((await rowOf("r-m8")).status, "DONE", JSON.stringify(r3b));
      assert.notEqual((await rowOf("r-m8")).note, ALREADY_REPLIED_NOTE, "M2 KHÔNG bị nuốt");
      assert.equal(posts.length, postsB + 1, "M2 được trả lời đúng MỘT câu");

      // 5 · KHÁCH NHẮN TRONG LÚC BOT SOẠN CÂU TRƯỚC: câu bot (trả lời tin trước) tới SAU tin mới — tin mới KHÔNG bị nuốt.
      const t1 = Date.now() - 2 * 60_000;
      await db.insert(t).values({ pageId: PAGE, threadId: "r-t1", messageId: "r-m3", text: "Cho chị 2 ký nhé", status: "PENDING", createdAt: new Date(t1) });
      await db.insert(t).values({ pageId: PAGE, threadId: "r-t1", messageId: "bot-out:cau-truoc", text: "dạ", status: "DONE", processedAt: new Date(t1 + 5_000), note: "BOT_SENT", createdAt: new Date(t1 + 5_000) });
      const r4 = await processFanpageThread(PAGE, "r-t1", { fetch: pancakeFetch, catchUp: true });
      assert.notEqual(r4.skipped, ALREADY_REPLIED_NOTE, "không lượt quá hạn ⇒ luật chống trùng KHÔNG áp");
      assert.ok(r4.replies >= 1, JSON.stringify(r4));

      // 6 · GỬI HỎNG ⇒ DEAD (không tự gửi lại — lời gọi gửi có thể đã tới nơi); bộ thử lại không đụng tới.
      sendFails = true;
      assert.ok((await receiveFanpageEvent(ev("r-m4", "Alo shop", "r-t3"))).queued);
      const r5 = await processFanpageThread(PAGE, "r-t3", { fetch: pancakeFetch, now: later(31) });
      assert.ok(r5.error, JSON.stringify(r5));
      const ds = await rowOf("r-m4");
      assert.equal(ds.status, "DEAD");
      assert.ok(ds.note?.startsWith(DEAD_SEND_NOTE_PREFIX), ds.note ?? "");
      const rs = await requeueAiDownDeadLetters(AI_DOWN_HANDOFF_REASON, new Date(Date.now() + 10 * 60_000), new Date(Date.now() + 10 * 60_000));
      assert.equal(rs.requeued.length, 0, "gửi hỏng không bao giờ được tự gửi lại");
      sendFails = false;

      // 7 · NHÂN VIÊN ĐÃ NHẬN hội thoại AI hỏng ⇒ không thử lại.
      st.mode = "CREDIT";
      assert.ok((await receiveFanpageEvent(ev("r-m5", "Còn hàng không?", "r-t4"))).queued);
      await processFanpageThread(PAGE, "r-t4", { fetch: pancakeFetch, now: later(31) });
      assert.equal((await rowOf("r-m5")).status, "DEAD");
      await db.update(cv).set({ handoffReason: "Nhân viên đang trả lời trên fanpage" }).where(eq(cv.threadId, "r-t4"));
      st.mode = "OK";
      const staff = await requeueAiDownDeadLetters(AI_DOWN_HANDOFF_REASON, new Date(Date.now() + 2.5 * 60_000), new Date(Date.now() + 3 * 60_000));
      assert.equal(staff.requeued.length, 0, JSON.stringify(staff));
      assert.equal((await rowOf("r-m5")).status, "DEAD", "người đã nhận ⇒ tin nằm lại cho người");

      // 8 · LÙI DẦN có hiệu lực ở đường giành; hết lượt ⇒ DEAD.
      await db.insert(t).values({ pageId: PAGE, threadId: "r-t5", messageId: "r-m6", text: "x", status: "PENDING", claimId: "c-x", claimedAt: new Date(), createdAt: new Date() });
      for (let i = 0; i < INBOUND_MAX_ATTEMPTS; i++) {
        await db.update(t).set({ claimId: "c-x" }).where(eq(t.messageId, "r-m6"));
        await releaseWithBackoff(db, [(await rowOf("r-m6")).id], "c-x", "Không mở được hội thoại", new Date());
        if (i === 0) {
          const due = await db.select({ id: t.id }).from(t).where(and(eq(t.messageId, "r-m6"), dueForClaim(new Date())));
          assert.equal(due.length, 0, "chưa tới mốc lùi dần ⇒ không giành được");
          const dueLater = await db.select({ id: t.id }).from(t).where(and(eq(t.messageId, "r-m6"), dueForClaim(new Date(Date.now() + 3 * 60_000))));
          assert.equal(dueLater.length, 1, "qua mốc ⇒ giành được");
        }
      }
      const exhausted = await rowOf("r-m6");
      assert.equal(exhausted.attempts, INBOUND_MAX_ATTEMPTS);
      assert.equal(exhausted.status, "DEAD", "hết lượt ⇒ DEAD, không nằm PENDING mãi");
      const n = Number((await db.select({ n: sql<number>`count(*)` }).from(t).where(eq(t.status, "DEAD")))[0].n);
      assert.ok(n >= 3);
    });
  } finally {
    setSalesChatProviderForTests(null);
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
  }
  console.log("✓ Thử lại tin khách (đường fanpage thật): AI hỏng ⇒ DEAD, không gửi · hồi phục ⇒ đúng MỘT câu · chết sau khi gửi ⇒ không gửi lại · tin mới lúc bot soạn vẫn được trả lời · gửi hỏng không tự gửi lại · người đã nhận ⇒ không thử lại · lùi dần");
}

export async function testAiSalesRetry() {
  testPure();
  await cleanupOrg(ORG);
  await provisionOrganization({ code: ORG, name: "Shop thử lại", plan: "trial", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: ADMIN_EMAIL, name: "Chủ shop", password: "ThuLai@2026!" }, source: "TEST", actor: null });
  try {
    await testRealOrg();
  } finally {
    await cleanupOrg(ORG);
  }
}

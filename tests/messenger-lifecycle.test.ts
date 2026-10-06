/**
 * ═══════════ VÒNG ĐỜI PAGE META + LỊCH SỬ HỘI THOẠI TRỰC TIẾP (gap analysis lát B) ═══════════
 *
 * Khoá:
 *  · THUẦN `planGraphConversation`: luồng = PSID của khách (đúng mã luồng webhook ghi), tin chủ kênh ⇒ PAGE, còn lại ⇒ KHÁCH, tin
 *    quá mới không ghi, tin page rỗng bỏ, tin khách rỗng ⇒ dòng giữ chỗ, ảnh https giữ lại, thứ tự cũ → mới.
 *  · `/me/accounts` PHÂN TRANG bằng con trỏ `after` (không theo URL `next` — URL đó chứa token): 150 page qua hai lời gọi.
 *  · Gỡ MỘT page ⇒ `DELETE /{page}/subscribed_apps` ở Meta TRƯỚC khi gỡ phía ERP; page kia vẫn bật.
 *  · Lượt nhập lịch sử (tổ chức thật, Graph giả): tin vào sổ với dấu lịch sử (`imported_at`, khách `HISTORY`, page `PAGE_REPLY`),
 *    tin đã có (cùng `mid` webhook / bot đã ghi) bỏ qua, tin quá mới không nhập, hội thoại mới mang dấu của lượt nhập, nhập lại
 *    0 tin mới, một dòng `sync_runs`, chỉ người quản lý chatbot bấm được, 0 lời gọi Pancake.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq, isNotNull } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { listChannelPages } from "@/lib/connectors/service";
import { pagesFromCode } from "@/lib/integrations/messenger/graph";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { HISTORY_CREATED_BY, HISTORY_NOTE } from "@/lib/sales-chatbot/history-shared";
import { connectMessengerPages, disconnectMessengerPage } from "@/lib/sales-chatbot/messenger";
import { runMessengerHistory, startMessengerHistory } from "@/lib/sales-chatbot/messenger-history";
import { MESSENGER_HISTORY_JOB, planGraphConversation } from "@/lib/sales-chatbot/messenger-history-shared";

const ORG = "vong-doi-page";
const APP_ID = "777000999000";
const APP_SECRET = "app-secret-lifecycle-test-0123456789a";
const PAGE_A = "5069708192";
const PAGE_B = "5069708193";
const TOKEN = (p: string) => `EAAGpagetoken_${p}_0123456789abcdef`;
const ENV_KEYS = ["FACEBOOK_LOGIN_APP_ID", "FACEBOOK_LOGIN_APP_SECRET", "FACEBOOK_MESSENGER_APP_ID", "FACEBOOK_MESSENGER_APP_SECRET", "PLATFORM_SECRETS_KEY"] as const;
const H = 3_600_000;

function testPure() {
  const now = Date.parse("2026-10-06T10:00:00Z");
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString().replace("Z", "+0000");
  const conv = {
    id: "t_1",
    updated_time: iso(H),
    participants: { data: [{ id: "12345678901", name: "Chị Hoa" }, { id: PAGE_A, name: "Shop" }] },
    messages: {
      data: [
        { id: "m_new", message: "Còn hàng không?", from: { id: "12345678901" }, created_time: iso(10 * 60_000) },
        { id: "m_3", message: "", from: { id: PAGE_A }, created_time: iso(2 * H) },
        { id: "m_2", message: "Dạ 350k ạ", from: { id: PAGE_A }, created_time: iso(3 * H) },
        { id: "m_1b", message: "", from: { id: "12345678901" }, created_time: iso(3.5 * H), attachments: { data: [{ image_data: { url: "https://scontent.example/x.jpg" } }] } },
        { id: "m_1", message: "", from: { id: "12345678901" }, created_time: iso(4 * H) },
      ],
    },
  };
  const plan = planGraphConversation(conv, PAGE_A, { nowMs: now, freshMs: H, mediaOnlyText: "[giữ chỗ]", imageMark: "[Ảnh]" });
  assert.ok(plan && plan.threadId === "12345678901" && plan.name === "Chị Hoa" && plan.fresh === 1, JSON.stringify(plan));
  assert.deepEqual(plan.rows.map((r) => [r.messageId, r.side, r.text]), [["m_1", "CUSTOMER", "[giữ chỗ]"], ["m_1b", "CUSTOMER", ""], ["m_2", "PAGE", "Dạ 350k ạ"]], "cũ → mới; tin page rỗng bỏ; tin khách rỗng ⇒ giữ chỗ; ảnh giữ lại");
  assert.deepEqual(plan.rows[1].imageUrls, ["https://scontent.example/x.jpg"]);
  assert.equal(planGraphConversation({ participants: { data: [{ id: PAGE_A }] } }, PAGE_A, { nowMs: now, freshMs: H, mediaOnlyText: "", imageMark: "" }), null, "không có khách ⇒ bỏ");
}

type Call = { url: string; method: string };
function fakeGraph(opts: { conversations?: Record<string, unknown>[] } = {}) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const u = new URL(url);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (u.host !== "graph.facebook.com") return json({ success: false }, 500);
    if (u.pathname.endsWith("/oauth/access_token")) return json({ access_token: "LONG_USER_TOKEN_lifecycle" });
    if (u.pathname.endsWith("/me/accounts")) {
      const second = u.searchParams.get("after") === "CURSOR_2";
      const mk = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: String(6000000000 + from + i), name: `Page ${from + i}`, access_token: `EAAGtok${from + i}xxxxxxxxxx`, tasks: ["MESSAGING"] }));
      return second ? json({ data: mk(100, 50), paging: { cursors: { after: "CURSOR_3" } } }) : json({ data: mk(0, 100), paging: { cursors: { after: "CURSOR_2" }, next: `https://graph.facebook.com/v21.0/me/accounts?after=CURSOR_2&access_token=LONG_USER_TOKEN_lifecycle` } });
    }
    if (u.pathname.endsWith("/subscribed_apps")) return json({ success: true });
    if (u.pathname.endsWith("/conversations")) return json({ data: opts.conversations ?? [] });
    for (const p of [PAGE_A, PAGE_B]) {
      if (u.pathname.endsWith(`/${p}`)) return json({ id: p });
      if (u.pathname.endsWith("/me") && u.searchParams.get("access_token") === TOKEN(p)) return json({ id: p, name: `Shop ${p}` });
    }
    return json({ error: { message: `không có ${u.pathname}`, code: 100 } }, 400);
  }) as typeof fetch;
  return { fetch: f, calls };
}

async function testPagination() {
  const g = fakeGraph();
  const r = await pagesFromCode({ appId: APP_ID, appSecret: APP_SECRET }, "CODE", "https://erp.test/api/connect/messenger/callback", g.fetch);
  assert.ok("pages" in r && r.pages.length === 150, `150 page qua hai trang: ${"pages" in r ? r.pages.length : JSON.stringify(r)}`);
  const acc = g.calls.filter((c) => c.url.includes("/me/accounts"));
  assert.equal(acc.length, 2, "dừng khi trang không còn `next`");
  assert.ok(new URL(acc[1].url).searchParams.get("after") === "CURSOR_2" && acc.every((c) => c.url.includes("appsecret_proof=")), "trang sau dựng bằng con trỏ `after` của ta, kèm appsecret_proof");
}

async function cleanup() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, ORG));
  await pdb.delete(schema.platformMessengerPages).where(eq(schema.platformMessengerPages.orgCode, ORG));
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

async function testDb() {
  await provisionOrganization({ code: ORG, name: ORG, plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "VongDoi@12345" }, source: "TEST", actor: null });
  const enabled = [...(await getEnabledModules(ORG))];
  await withOrganization(ORG, async () => {
    const db = await getDb();
    const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
    assert.ok(u);
    const admin = { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: ["settings:manage", "ai_sales:manage", "ai_sales:view"], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false }, modules: enabled } as unknown as SessionUser;
    const viewer = { ...admin, id: "vd-viewer", role: "VIEWER", permissions: ["ai_sales:view"] } as unknown as SessionUser;
    const now = new Date();
    const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString().replace("Z", "+0000");
    const PSID = "22233344455";
    const g = fakeGraph({
      conversations: [
        {
          id: "t_a",
          updated_time: iso(2 * H),
          participants: { data: [{ id: PSID, name: "Chị Mai" }, { id: PAGE_A, name: "Shop A" }] },
          messages: {
            data: [
              { id: "m_fresh", message: "Shop ơi", from: { id: PSID }, created_time: iso(5 * 60_000) },
              { id: "m_bot", message: "Dạ shop chào chị", from: { id: PAGE_A }, created_time: iso(2 * H) },
              { id: "m_cust", message: "Áo này còn size M không?", from: { id: PSID }, created_time: iso(3 * H) },
            ],
          },
        },
      ],
    });
    const conn = await connectMessengerPages(admin, [PAGE_A, PAGE_B].map((p) => ({ id: p, name: `Shop ${p}`, token: TOKEN(p), canMessage: true })), { fetch: g.fetch });
    assert.ok("ok" in conn && conn.connected.length === 2, JSON.stringify(conn));

    // ── Lịch sử ──
    const t = schema.salesChatInbound;
    // Tin bot webhook / Send API đã ghi trước (cùng mã tin Meta) ⇒ lượt nhập phải bỏ qua, không thành tin thứ hai.
    await db.insert(t).values({ pageId: PAGE_A, threadId: PSID, messageId: "m_bot", text: "Dạ shop chào chị", status: "DONE", note: "BOT_SENT", createdAt: new Date(now.getTime() - 2 * H) });
    const denied = await startMessengerHistory(viewer);
    assert.ok("error" in denied && denied.error.includes("ai_sales:manage"));
    assert.ok("ok" in (await startMessengerHistory(admin)));
    const run = await runMessengerHistory({ trigger: "MANUAL", actor: admin.email }, { fetch: g.fetch });
    assert.equal(run.status, "DONE", JSON.stringify(run));
    const pageA = run.pages.find((p) => p.pageId === PAGE_A);
    assert.ok(pageA && pageA.conversations === 1 && pageA.inserted === 1 && pageA.duplicates === 1 && pageA.fresh === 1, `1 tin mới · 1 đã có · 1 quá mới: ${JSON.stringify(pageA)}`);
    const rows = await db.select().from(t).where(and(eq(t.threadId, PSID), isNotNull(t.importedAt)));
    assert.ok(rows.length === 1 && rows[0].messageId === "m_cust" && rows[0].note === HISTORY_NOTE && rows[0].status === "DONE", JSON.stringify(rows));
    assert.equal((await db.select().from(t).where(eq(t.messageId, "m_fresh"))).length, 0, "tin quá mới không nhập — việc của webhook / bot");
    const conv = (await db.select().from(schema.salesChatConversations).where(and(eq(schema.salesChatConversations.pageId, PAGE_A), eq(schema.salesChatConversations.threadId, PSID))))[0];
    assert.ok(conv && conv.historyUntil && conv.historyImportedAt, "hội thoại mang mốc lịch sử");
    assert.ok(conv.createdBy === HISTORY_CREATED_BY || conv.createdBy === null, String(conv.createdBy));
    const again = await runMessengerHistory({ trigger: "MANUAL", actor: admin.email }, { fetch: g.fetch });
    assert.equal(again.pages.reduce((n, p) => n + p.inserted, 0), 0, "nhập lại ⇒ 0 tin mới");
    const runs = await db.select().from(schema.syncRuns).where(eq(schema.syncRuns.job, MESSENGER_HISTORY_JOB));
    assert.equal(runs.length, 2, "mỗi lượt một dòng sync_runs");
    assert.ok(g.calls.every((c) => new URL(c.url).host === "graph.facebook.com"), "không một lời gọi Pancake");

    // ── Gỡ MỘT page ⇒ gỡ đăng ký webhook ở Meta trước; page kia vẫn bật ──
    const before = g.calls.length;
    const off = await disconnectMessengerPage(admin, PAGE_B, { fetch: g.fetch });
    assert.ok("ok" in off && !off.message.includes("Chưa gỡ được"), JSON.stringify(off));
    const del = g.calls.slice(before).filter((c) => c.method === "DELETE" && c.url.includes(`/${PAGE_B}/subscribed_apps`));
    assert.equal(del.length, 1, "DELETE subscribed_apps cho đúng page bị gỡ");
    const pages = await listChannelPages("facebook-messenger");
    assert.deepEqual(pages.map((p) => [p.pageId, p.status]).sort(), [[PAGE_A, "ACTIVE"], [PAGE_B, "DISABLED"]]);
  });
}

export async function testMessengerLifecycle() {
  testPure();
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.FACEBOOK_LOGIN_APP_ID = APP_ID;
  process.env.FACEBOOK_LOGIN_APP_SECRET = APP_SECRET;
  // Kênh Messenger ưu tiên app Messenger riêng khi đủ cặp — bài này đo đường của app đăng nhập, nên gỡ cặp kia (khôi phục ở finally).
  delete process.env.FACEBOOK_MESSENGER_APP_ID;
  delete process.env.FACEBOOK_MESSENGER_APP_SECRET;
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-vong-doi-0123456789abcdefghijklmnopqrstuvwxyz";
  try {
    await testPagination();
    await cleanup();
    await testDb();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await cleanup();
  }
  console.log("✓ Vòng đời page Meta + lịch sử trực tiếp: hội thoại Graph ⇒ luồng PSID, cũ → mới, tin quá mới không ghi; /me/accounts phân trang bằng con trỏ của ta (150 page); gỡ một page ⇒ DELETE subscribed_apps trước, page kia vẫn bật; nhập lịch sử ghi dấu HISTORY, tin đã có bỏ qua, nhập lại 0 tin, sync_runs, chỉ người quản lý bấm được, 0 lời gọi Pancake");
}

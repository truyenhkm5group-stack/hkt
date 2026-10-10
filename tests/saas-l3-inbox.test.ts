/**
 * ═══════════ HỘP THƯ HỢP NHẤT + SONG SONG PANCAKE / META TRỰC TIẾP (sứ mệnh saas-l3-inbox · 0233) ═══════════
 *
 * Khoá — gọi ĐƯỜNG THẬT (webhook Pancake giả + Graph giả + AI giả đếm lượt, tổ chức THẬT), không regex mã nguồn:
 *  · THUẦN: đường canonical (`transportOwnerOf` / `routeVerdict`) — page chưa có dòng ⇒ luật cũ (Pancake thắng), có dòng ⇒ đúng
 *    đường đó, đường đó không chạy ⇒ không đường nào kích AI; số phút nhường; lọc ảnh đại diện; nhãn nguồn.
 *  · BACKFILL 0233 trên CSDL nâng cấp (PGlite, sổ cắt trước 0233): page Pancake (kể cả page nối CẢ HAI đường) ⇒ PANCAKE_WEBHOOK,
 *    page chỉ Messenger ⇒ META_DIRECT, page đã gỡ ⇒ không dòng; đường kích AI TRƯỚC và SAU backfill giống hệt từng page; chạy lại
 *    không nhân dòng.
 *  · Tổ chức Pancake (kiểu HSLC): cùng tin, trước và sau backfill ⇒ cùng kết quả (nhận · 1 lượt trả lời · 1 tin gửi qua Pancake).
 *  · Page mới nối Meta trực tiếp ⇒ META_DIRECT (nguồn CONNECT, nhật ký).
 *  · Cùng một tin khách tới qua CẢ HAI webhook ⇒ 1 dòng, số lượt AI + dòng sổ AI + tin gửi = đúng một tin đi một đường.
 *  · Chuyển đường giữa chừng: bản mắc kẹt bị thay, AI trả lời ĐÚNG MỘT lần; bản đã xử lý ⇒ bản thứ hai không ghi.
 *  · Đường không canonical (đường chính không chạy) ⇒ tin LƯU cho người, 0 lượt AI.
 *  · Người trả lời từ hộp thư ERP · Pancake · Hộp thư Meta ⇒ AI nhường, cho CẢ HAI chế độ.
 *  · Số phút nhường cấu hình theo workspace (quyền, trần, nhật ký) — đồng hồ đi đúng số mới.
 *  · Hộp thư: thẻ AI / Người (điều kiện SQL ≡ `aiHoldOf` trên một ma trận dòng) · Đã chốt / Chưa chốt phủ kín · SỐ chưa đọc · nhãn
 *    nguồn · ảnh đại diện (Graph `profile_pic`, lỗi quyền ⇒ chữ cái, không lộ token) · lọc page.
 *  · Cô lập tổ chức. Gỡ Meta trực tiếp của page mà Pancake đang chạy ⇒ đường chính về Pancake (hệ quả tường minh, có nhật ký).
 * Mốc thời gian đều tương đối với đồng hồ thật lúc chạy (luật 50).
 */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";
import type { SessionUser } from "@/lib/auth/session";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { aiHoldOf, AI_DOWN_HANDOFF_REASON, cooldownUntilFrom, FANPAGE_STAFF_REASON, HUMAN_COOLDOWN_MINUTES, normalizeCooldownMinutes } from "@/lib/sales-chatbot/ai-hold-shared";
import {
  dedupeText,
  DUPLICATE_SOURCE_REASON,
  listPageRoutes,
  loadTransportFacts,
  MESSENGER_OWNS_PAGE_REASON,
  NON_CANONICAL_NOTE,
  PANCAKE_OWNS_PAGE_REASON,
  ROUTE_SWITCH_NOTE,
  routeVerdict,
  setPageConnectionModeCore,
  setTransportFactsForTests,
  transportOwnerOf,
  type ConnectionMode,
  type TransportFacts,
} from "@/lib/sales-chatbot/channel-ownership";
import { controlBarStatus } from "@/lib/sales-chatbot/ai-status-shared";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { humanCooldownMinutes, setHumanCooldownMinutesCore } from "@/lib/sales-chatbot/conversation-control";
import { setSalesChatProviderForTests } from "@/lib/sales-chatbot/engine";
import { catchUpFanpage, parsePancakeWebhook, processFanpageThread, receiveFanpageEvent, type FanpageEvent } from "@/lib/sales-chatbot/fanpage";
import { inboxSourceOf, listInbox, loadInboxThread, sendStaffReplyCore } from "@/lib/sales-chatbot/inbox";
import { INBOX_FILTERS, safeAvatarUrl, unreadBadge } from "@/lib/sales-chatbot/inbox-shared";
import { classifyInboxState, inboxHandlingFrom, type InboxStateInput } from "@/lib/sales-chatbot/inbox-states";
import { OPERATING_MODE_SETTING_KEY } from "@/lib/sales-chatbot/operating-mode-shared";
import { connectMessengerPage, disconnectMessengerPage, processMessengerThread, receiveMessengerEvent, refreshMessengerProfile } from "@/lib/sales-chatbot/messenger";

const ORG = "l3-hop-thu";
const ORG_B = "l3-hop-thu-khac";
const APP_ID = "777000333444";
const APP_SECRET = "app-secret-l3-inbox-test-0123456789abcd";
const PAGE_M = "4059687213";
const PAGE_TOKEN = "EAAGpagetoken_l3inbox_0123456789abcdef";
const PAGE_P = "9988776655";
const PANCAKE_TOKEN = "pancake_page_token_l3_0123456789abcdef";
/** App mà Pancake dùng để gửi tin lên Facebook — tiếng vọng của câu nhân viên gõ trên Pancake mang mã app này (không phải bot). */
const PANCAKE_APP_ID = "1122334455";
const META_INBOX_APP_ID = "263902037430900";
const ENV_KEYS = ["FACEBOOK_LOGIN_APP_ID", "FACEBOOK_LOGIN_APP_SECRET", "FACEBOOK_MESSENGER_APP_ID", "FACEBOOK_MESSENGER_APP_SECRET", "PLATFORM_SECRETS_KEY"] as const;
const MIN = 60_000;
const AVATAR = "https://platform-lookaside.fbsbx.com/platform/profilepic/?psid=4100000000901&width=1024&hash=AbCdEf";
/** PSID mà Graph TỪ CHỐI đọc hồ sơ (app chưa có quyền) — câu lỗi cố tình chứa token để kiểm che. */
const DENIED_PSID = "4100000000902";

// ─────────────────────────── Thuần ───────────────────────────

function testPure() {
  const facts = (o: Partial<TransportFacts> = {}): TransportFacts => ({ pancake: { active: true, pageId: "P" }, messenger: { active: true, pageIds: ["P", "M"] }, ...o });
  // Không dòng canonical ⇒ luật cũ: cả hai cùng bật ⇒ PANCAKE.
  assert.equal(transportOwnerOf(facts(), "P"), "PANCAKE");
  assert.equal(transportOwnerOf(facts(), "M"), "MESSENGER");
  assert.equal(transportOwnerOf(facts(), "X"), null);
  // Có dòng ⇒ đúng đường đó, kể cả khi đường kia cũng bật.
  assert.equal(transportOwnerOf(facts({ modes: { P: "META_DIRECT" } }), "P"), "MESSENGER", "page Meta trực tiếp thắng Pancake khi đã lưu");
  assert.equal(transportOwnerOf(facts({ modes: { P: "PANCAKE_WEBHOOK" } }), "P"), "PANCAKE");
  // Đường chính đã lưu không chạy ⇒ KHÔNG đường nào (không tự đổi đường).
  assert.equal(transportOwnerOf(facts({ modes: { M: "PANCAKE_WEBHOOK" } }), "M"), null);
  assert.equal(routeVerdict(facts({ modes: { M: "PANCAKE_WEBHOOK" } }), "M", "MESSENGER"), "CANONICAL_DOWN");
  assert.equal(routeVerdict(facts({ modes: { P: "META_DIRECT" } }), "P", "PANCAKE"), "OTHER_OWNS");
  assert.equal(routeVerdict(facts({ modes: { P: "META_DIRECT" } }), "P", "MESSENGER"), "CANONICAL");
  // Số phút nhường: chưa khai / sai / ngoài trần ⇒ mặc định cũ.
  assert.equal(HUMAN_COOLDOWN_MINUTES, 30, "mặc định GIỮ NGUYÊN ngưỡng cũ");
  for (const bad of [undefined, null, "", "abc", 0, -5, 1.5, 1441, 10_000]) assert.equal(normalizeCooldownMinutes(bad), 30, `«${String(bad)}» ⇒ mặc định`);
  assert.equal(normalizeCooldownMinutes(45), 45);
  assert.equal(normalizeCooldownMinutes("90"), 90);
  const t0 = new Date();
  assert.equal(cooldownUntilFrom(t0).getTime(), t0.getTime() + 30 * MIN);
  assert.equal(cooldownUntilFrom(t0, 45).getTime(), t0.getTime() + 45 * MIN);
  // Ảnh đại diện: https, không mang khoá trong URL.
  assert.equal(safeAvatarUrl(AVATAR), AVATAR);
  assert.equal(safeAvatarUrl("http://x.test/a.jpg"), null);
  assert.equal(safeAvatarUrl("https://x.test/a.jpg?access_token=EAAG123"), null);
  assert.equal(safeAvatarUrl("https://x.test/a.jpg?token=abc"), null);
  assert.equal(safeAvatarUrl(42), null);
  assert.equal(unreadBadge(3), "3");
  assert.equal(unreadBadge(100), "99+");
  assert.equal(dedupeText("  Áo   này\n còn không? "), "Áo này còn không?");
  // Nhãn nguồn: đường đã ghi thắng; dòng cũ ⇒ đường canonical của page.
  const f = facts({ modes: { P: "META_DIRECT" } });
  assert.equal(inboxSourceOf({ channel: "FANPAGE", pageId: "P", transport: "PANCAKE" }, f), "PANCAKE");
  assert.equal(inboxSourceOf({ channel: "FANPAGE", pageId: "P", transport: null }, f), "DIRECT");
  assert.equal(inboxSourceOf({ channel: "FANPAGE", pageId: "Q", transport: null }, f), "PANCAKE");
  assert.equal(inboxSourceOf({ channel: "ZALO", pageId: "oa", transport: null }, f), "ZALO");
  assert.equal(inboxSourceOf({ channel: "WEB", pageId: null, transport: null }, null), "WEB");
  // Pancake mang PSID người gửi ⇒ khoá khử trùng; tin phía page không mang.
  const pk = parsePancakeWebhook({ event_type: "messaging", page_id: "P", data: { conversation: { id: "P_4100", type: "INBOX", from_psid: "4100" }, message: { id: "m1", type: "INBOX", message: "Chào shop", from: { id: "4100", name: "Lan" } } } });
  assert.equal(pk?.senderId, "4100");
  const pk2 = parsePancakeWebhook({ event_type: "messaging", page_id: "P", data: { conversation: { id: "P_4100", type: "INBOX" }, message: { id: "m2", type: "INBOX", message: "Chào shop", from: { id: "4101", name: "Lan" } } } });
  assert.equal(pk2?.senderId, "4101", "thiếu from_psid ⇒ mã người gửi của tin");
  assert.ok(INBOX_FILTERS.includes("AI") && INBOX_FILTERS.includes("HUMAN") && INBOX_FILTERS.includes("ORDERED") && INBOX_FILTERS.includes("NOT_ORDERED"));
  // AI gợi ý (bot soạn, NGƯỜI gửi) thuộc nhóm NGƯỜI trên hộp thư — quyết định sản phẩm 07/10/2026: nhân viên không bỏ sót khách.
  // Phân loại đọc từ `classifyInboxState` (inbox-states.ts, chủ shop 10/10/2026) thay cho `inboxHandlingOf(aiHold)` cũ.
  const tNow = new Date();
  const copilot = { control: { mode: "COPILOT", byUserId: "u1", byName: "Lan", at: tNow.toISOString(), reason: null } };
  const human = { control: { mode: "HUMAN", byUserId: "u1", byName: "Lan", at: tNow.toISOString(), reason: null } };
  const cv = (over: Partial<InboxStateInput>): InboxStateInput => ({ status: "OPEN", handoffReason: null, state: {}, updatedAt: tNow, humanCooldownUntil: null, lastCustomerAt: null, lastBotAt: null, lastStaffAt: null, staffSeenAt: null, historyUntil: null, pageReplyAfterCustomer: false, orderUnderReview: false, ...over });
  const hd = (over: Partial<InboxStateInput>, org = false) => inboxHandlingFrom(classifyInboxState(cv(over), tNow, org));
  assert.equal(hd({}), "AI");
  assert.equal(hd({ state: copilot }), "COPILOT", "hội thoại AI gợi ý ⇒ nhóm người");
  assert.equal(hd({}, true), "COPILOT", "tổ chức ở chế độ Copilot ⇒ nhóm người");
  assert.equal(hd({ status: "HANDOFF", handoffReason: FANPAGE_STAFF_REASON, humanCooldownUntil: new Date(tNow.getTime() + 60_000), state: copilot }, true), "HUMAN", "nhường thắng AI gợi ý");
  assert.equal(hd({ state: human }), "HUMAN");
  assert.equal(hd({ status: "HANDOFF", handoffReason: "Khách đòi gặp người" }), "WAITING", "AI xin người, chưa ai cầm ⇒ chờ người (không phải «Người đang xử lý»)");
  // Câu trạng thái nói ĐÚNG số phút nhường workspace đã khai; thiếu ⇒ mặc định.
  const bar = (cooldownMinutes?: number) =>
    controlBarStatus({ hold: { state: "AI_ACTIVE", cause: null, until: null, serverNow: new Date().toISOString() }, blocks: [], mode: "AUTO", handoffReason: null, control: null, lapsed: false, formatAt: (s) => s, cooldownMinutes }).text;
  assert.match(bar(45), /nhường 45 phút/);
  assert.match(bar(), new RegExp(`nhường ${HUMAN_COOLDOWN_MINUTES} phút`));
}

// ─────────────────────────── Backfill 0233 trên CSDL nâng cấp ───────────────────────────

async function testBackfillUpgrade() {
  const goc = path.join(process.cwd(), "drizzle");
  type Entry = { idx: number; tag: string; when: number };
  const so = JSON.parse(readFileSync(path.join(goc, "meta/_journal.json"), "utf8")) as { entries: Entry[] };
  const mine = so.entries.find((e) => e.tag.endsWith("_saas_l3_inbox_routes"));
  assert.ok(mine, "sổ migration có mục saas_l3_inbox_routes");
  const tmp = mkdtempSync(path.join(tmpdir(), "l3-backfill-"));
  const thuMucSo = path.join(tmp, "drizzle");
  const soFile = path.join(thuMucSo, "meta/_journal.json");
  cpSync(goc, thuMucSo, { recursive: true });
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = new PGlite(path.join(tmp, "db"));
  const db = drizzle(client) as never;
  try {
    writeFileSync(soFile, JSON.stringify({ ...so, entries: so.entries.filter((e) => e.idx < mine.idx) }, null, 2) + "\n");
    await migrate(db, { migrationsFolder: thuMucSo });
    // Trạng thái production hôm nay: page 111 nối CẢ HAI đường (Pancake đang thắng), 222 chỉ Messenger, 333 đã gỡ, 999 page của
    // hàng kết nối Messenger đơn cũ (trước 0220), Instagram 333 của hàng cũ đã có hàng riêng (DISABLED) ⇒ không được hồi sinh.
    await client.query(`insert into org_connections (id, org_code, connector_key, status, settings, last_test_ok) values ('c1', 'shop', 'pancake-fanpage', 'ACTIVE', '{"pageId":" 111 "}', true), ('c2', 'shop', 'facebook-messenger', 'ACTIVE', '{"pageId":"999","igAccountId":"333"}', true)`);
    await client.query(`insert into org_channel_pages (id, org_code, connector_key, page_id, status) values ('p1', 'shop', 'facebook-messenger', '111', 'ACTIVE'), ('p2', 'shop', 'facebook-messenger', '222', 'ACTIVE'), ('p3', 'shop', 'facebook-messenger', '333', 'DISABLED')`);
    await client.query(`insert into sales_chat_inbound (id, page_id, thread_id, message_id, text) values ('i1', '111', 't1', 'old-1', 'tin cũ')`);
    writeFileSync(soFile, JSON.stringify(so, null, 2) + "\n");
    await migrate(db, { migrationsFolder: thuMucSo });
    const rows = (await client.query<{ page_id: string; mode: string; source: string; reason: string; set_by_user_id: string | null }>(`select page_id, mode, source, reason, set_by_user_id from channel_page_modes order by page_id`)).rows;
    const modes: Record<string, ConnectionMode> = Object.fromEntries(rows.map((r) => [r.page_id, r.mode as ConnectionMode]));
    assert.deepEqual(modes, { "111": "PANCAKE_WEBHOOK", "222": "META_DIRECT", "999": "META_DIRECT" }, `backfill chép ĐÚNG đường hôm nay: ${JSON.stringify(rows)}`);
    assert.ok(rows.every((r) => r.source === "BACKFILL" && r.set_by_user_id === null && r.reason.startsWith("0233:")), "nguồn BACKFILL, của MÁY, có lý do");
    // Trước / sau: đường kích AI của TỪNG page không đổi (page Pancake — kiểu HSLC — giữ Pancake).
    const legacy: TransportFacts = { pancake: { active: true, pageId: "111" }, messenger: { active: true, pageIds: ["111", "222", "999"] } };
    for (const id of ["111", "222", "999", "333", "444"]) assert.equal(transportOwnerOf({ ...legacy, modes }, id), transportOwnerOf(legacy, id), `page ${id}: đường trước = đường sau backfill`);
    // Chạy lại câu backfill (idempotent) ⇒ không nhân dòng, không đổi đường.
    const stmts = readFileSync(path.join(goc, `${mine.tag}.sql`), "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.startsWith('INSERT INTO "channel_page_modes"'));
    assert.equal(stmts.length, 3, "ba câu backfill: Pancake · page Messenger · hàng kết nối cũ");
    for (const s of stmts) await client.query(s);
    assert.equal((await client.query<{ n: number }>(`select count(*)::int as n from channel_page_modes`)).rows[0]?.n, 3);
    // Cột mới của hàng chờ: dòng cũ NULL (không backfill), CHECK chặn đường lạ.
    const old = (await client.query<{ transport: string | null; sender_id: string | null }>(`select transport, sender_id from sales_chat_inbound where id = 'i1'`)).rows[0];
    assert.ok(old && old.transport === null && old.sender_id === null, "dòng cũ giữ NULL");
    await assert.rejects(client.query(`insert into sales_chat_inbound (id, page_id, thread_id, message_id, text, transport) values ('i2', '1', 't', 'x', 'y', 'ZALO')`), "đường ngoài tập đóng bị CSDL từ chối");
    await assert.rejects(client.query(`insert into channel_page_modes (id, page_id, mode, source, reason) values ('m9', '555', 'BOTH', 'MANUAL', 'x')`), "chế độ ngoài tập đóng bị từ chối");
    return { stmts };
  } finally {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ─────────────────────────── Đường thật ───────────────────────────

type Call = { url: string; init?: RequestInit };
function fakeGraph(): { fetch: typeof fetch; calls: Call[]; sends: (from: number) => Call[] } {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    const u = new URL(url);
    if (u.searchParams.get("fields") === "profile_pic") {
      if (u.pathname.endsWith(`/${DENIED_PSID}`)) return json({ error: { message: `(#230) Requires pages_messaging permission token ${PAGE_TOKEN}`, code: 230 } }, 400);
      return json({ profile_pic: AVATAR, id: u.pathname.split("/").pop() });
    }
    if (u.pathname.endsWith(`/${PAGE_M}/subscribed_apps`)) return json({ success: true });
    if (u.pathname.endsWith(`/${PAGE_M}`)) return json({ id: PAGE_M });
    if (u.pathname.endsWith("/me") && u.searchParams.get("access_token") === PAGE_TOKEN) return json({ id: PAGE_M, name: "Shop L3" });
    if (u.pathname.endsWith("/me/messages")) return json({ recipient_id: "x", message_id: `m.out.${calls.length}` });
    return json({ error: { message: `không có ${u.pathname}`, code: 100 } }, 400);
  }) as typeof fetch;
  return { fetch: f, calls, sends: (from) => calls.slice(from).filter((c) => c.url.includes("/me/messages")) };
}

function fakePancake(): { fetch: typeof fetch; calls: Call[]; sends: (from: number) => Call[] } {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const body = url.includes("/conversations?") ? { success: true, conversations: [{ id: "c1" }] } : init?.method === "POST" ? { success: true, id: `p-out-${calls.length}` } : { success: true, messages: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, calls, sends: (from) => calls.slice(from).filter((c) => c.init?.method === "POST" && c.url.includes("/messages")) };
}

let aiCalls = 0;
function fakeBot(): AiProvider {
  return {
    name: "fake",
    model: "claude-sonnet-5",
    schemaDialect: "anthropic",
    async complete(req: AiRequest): Promise<AiResponse> {
      aiCalls += 1;
      return { content: [{ type: "text", text: req.tools.length ? "Dạ size M còn hàng ạ, chị lấy mấy cái ạ?" : "NONE" }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
    },
  };
}

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, code));
  await pdb.delete(schema.platformMessengerPages).where(eq(schema.platformMessengerPages.orgCode, code));
  await pdb.delete(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, code));
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

async function testFlow(backfillStmts: readonly string[]) {
  const modules = ["customers", "products", "orders", "inventory", "ai_sales"];
  await provisionOrganization({ code: ORG, name: ORG, plan: "starter", modules, admin: { email: `admin@${ORG}.local`, name: "QT", password: "HopThuL3@12345" }, source: "TEST", actor: null });
  await provisionOrganization({ code: ORG_B, name: ORG_B, plan: "starter", modules, admin: { email: `admin@${ORG_B}.local`, name: "QT B", password: "HopThuL3@12345" }, source: "TEST", actor: null });
  const enabled = [...(await getEnabledModules(ORG))];
  const g = fakeGraph();
  const pancake = fakePancake();
  setSalesChatProviderForTests(() => fakeBot());
  const aConvIds: string[] = [];
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const pdb = await getPlatformDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const base = { email: u.email, scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false }, modules: enabled };
      const admin = { ...base, id: u.id, name: "QT", role: "ADMIN", permissions: ["settings:manage", "ai_sales:manage", "ai_sales:view", "ai_sales:reply"] } as unknown as SessionUser;
      const [s1] = await db.insert(schema.users).values({ email: `lan@${ORG}.local`, name: "Lan CSKH", passwordHash: "x", role: "CS" }).returning({ id: schema.users.id });
      const lan = { ...base, id: s1.id, name: "Lan CSKH", role: "CS", permissions: ["ai_sales:view", "ai_sales:reply"] } as unknown as SessionUser;
      const viewer = { ...base, id: "l3-viewer", name: "Xem", role: "VIEWER", permissions: ["ai_sales:view"] } as unknown as SessionUser;
      const c = schema.salesChatConversations;
      const t = schema.salesChatInbound;
      const modesT = schema.channelPageModes;

      // ═══ B1. Page MỚI nối Meta trực tiếp ⇒ META_DIRECT (nguồn CONNECT, người nối, nhật ký) ═══
      const conn = await connectMessengerPage(admin, { id: PAGE_M, name: "Shop L3", token: PAGE_TOKEN, canMessage: true }, { fetch: g.fetch });
      assert.ok("ok" in conn, JSON.stringify(conn));
      const rowM = (await db.select().from(modesT).where(eq(modesT.pageId, PAGE_M)))[0];
      assert.ok(rowM && rowM.mode === "META_DIRECT" && rowM.source === "CONNECT" && rowM.setByUserId === admin.id, `page mới ưu tiên Meta trực tiếp: ${JSON.stringify(rowM)}`);
      const audConnect = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "SALES_CHANNEL_MODE_SET"), eq(schema.auditLogs.entityId, PAGE_M)));
      assert.ok(audConnect.length === 1 && audConnect[0].userId === admin.id, "nhật ký đặt đường khi nối");

      // Pancake cho PAGE_P — kiểu HSLC: chưa có dòng canonical nào (page có trước 0233).
      assert.ok("ok" in (await saveConnection(admin, { connectorKey: "pancake-fanpage", settings: { pageId: PAGE_P }, secrets: { pageAccessToken: PANCAKE_TOKEN } })));
      assert.ok("ok" in (await testOrgConnection(admin, "pancake-fanpage", { tester: { fetch: pancake.fetch } })));
      assert.ok("ok" in (await setConnectionStatus(admin, "pancake-fanpage", "ACTIVE")));
      const cfg = JSON.stringify({ ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: true });
      await db.insert(schema.settings).values({ key: SALES_CHATBOT_SETTING_KEY, value: cfg }).onConflictDoUpdate({ target: schema.settings.key, set: { value: cfg } });

      const at = (ms: number) => () => new Date(Date.now() + ms);
      const mev = (psid: string, mid: string, text: string, extra: Record<string, unknown> = {}) => ({ platform: "MESSENGER" as const, pageId: PAGE_M, psid, mid, text, imageUrls: [], isEcho: false, appId: null, at: null, ...extra });
      const pev = (page: string, thread: string, mid: string, text: string, o: Partial<FanpageEvent> = {}): FanpageEvent => ({ pageId: page, threadId: thread, messageId: mid, text, customerName: o.fromPage ? "" : "Chị Hoa", fromPage: false, humanStaff: false, inbox: true, comment: null, imageUrls: [], ...o });
      const convOf = async (page: string, thread: string) => (await db.select().from(c).where(and(eq(c.channel, "FANPAGE"), eq(c.pageId, page), eq(c.threadId, thread))).limit(1))[0];
      const usageRows = async () => (await pdb.select({ id: schema.platformAiUsage.id }).from(schema.platformAiUsage).where(and(eq(schema.platformAiUsage.orgCode, ORG), eq(schema.platformAiUsage.feature, "sales_chatbot")))).length;
      const countText = async (page: string, text: string) => (await db.select({ id: t.id }).from(t).where(and(eq(t.pageId, page), eq(t.text, text)))).length;
      const holdOf = async (id: string) => {
        const r = await loadInboxThread(lan, id);
        assert.ok(r.ok, JSON.stringify(r));
        return r.thread.aiHold.state;
      };
      const setPancakePage = (pageId: string) => db.update(schema.orgConnections).set({ settings: { pageId } }).where(eq(schema.orgConnections.connectorKey, "pancake-fanpage"));

      // ═══ A. Pancake (kiểu HSLC): cùng tin, TRƯỚC và SAU backfill ⇒ cùng kết quả ═══
      const runPancake = async (thread: string, mid: string) => {
        const r = await receiveFanpageEvent(pev(PAGE_P, thread, mid, "Chả mực bao nhiêu shop?"));
        const m0 = pancake.calls.length;
        const ai0 = aiCalls;
        const u0 = await usageRows();
        const p = await processFanpageThread(PAGE_P, thread, { fetch: pancake.fetch, now: at(31_000) });
        return { queued: r.queued, reason: r.reason, replies: p.replies, skipped: p.skipped, sends: pancake.sends(m0).length, ai: aiCalls - ai0, usage: (await usageRows()) - u0 };
      };
      assert.equal((await loadTransportFacts()).modes?.[PAGE_P], undefined, "trước backfill: page Pancake chưa có dòng");
      const before = await runPancake("p-truoc", "pt.1");
      for (const s of backfillStmts) await db.execute(sql.raw(s));
      const rowP = (await db.select().from(modesT).where(eq(modesT.pageId, PAGE_P)))[0];
      assert.ok(rowP && rowP.mode === "PANCAKE_WEBHOOK" && rowP.source === "BACKFILL", `backfill: page Pancake ⇒ PANCAKE_WEBHOOK: ${JSON.stringify(rowP)}`);
      assert.equal((await db.select().from(modesT).where(eq(modesT.pageId, PAGE_M)))[0]?.source, "CONNECT", "backfill không đè dòng đã có");
      const after = await runPancake("p-sau", "ps.1");
      assert.ok(before.queued && before.replies >= 1 && before.sends >= 1, `Pancake trước backfill chạy: ${JSON.stringify(before)}`);
      assert.deepEqual(after, before, "Pancake SAU backfill = TRƯỚC backfill (nhận · số trả lời · số tin gửi · số lượt AI)");
      aConvIds.push((await convOf(PAGE_P, "p-sau")).id);
      // A2. Đọc đường canonical HỎNG ⇒ Pancake chạy như trước 0233 (không gãy đường đang chạy thật) — khoá nhánh `.catch`.
      setTransportFactsForTests(() => Promise.reject(new Error("đọc kết nối hỏng")));
      try {
        assert.deepEqual(await runPancake("p-hong", "ph.1"), before, "đọc hỏng ⇒ Pancake nhận + trả lời như thường");
      } finally {
        setTransportFactsForTests(null);
      }

      // Đường đơn (một tin, một đường) — mốc so cho «AI một lần, usage một lần».
      const s0 = "4100000000100";
      assert.ok((await receiveMessengerEvent(mev(s0, "s0.1", "Áo sơ mi còn size L không?"))).queued);
      const [ai0, us0, gs0] = [aiCalls, await usageRows(), g.calls.length];
      const p0 = await processMessengerThread(PAGE_M, s0, { fetch: g.fetch, now: at(31_000) });
      const single = { ai: aiCalls - ai0, usage: (await usageRows()) - us0, sends: g.sends(gs0).length };
      assert.ok(p0.replies >= 1 && single.ai >= 1 && single.usage >= 1 && single.sends >= 1, `đường đơn: ${JSON.stringify({ p0, single })}`);

      // ═══ C1. CÙNG MỘT TIN qua CẢ HAI webhook (page nối hai đường, đường chính Meta trực tiếp) ⇒ 1 dòng, AI một lần ═══
      await setPancakePage(PAGE_M);
      const s1p = "4100000000101";
      const T1 = "Cho chị hỏi váy hoa còn không em?";
      const pThread1 = `${PAGE_M}_${s1p}`;
      const viaPancake = await receiveFanpageEvent(pev(PAGE_M, pThread1, "pk.1", T1, { senderId: s1p }));
      assert.deepEqual(viaPancake, { queued: false, reason: MESSENGER_OWNS_PAGE_REASON }, "đường Pancake nhường page Meta trực tiếp");
      const viaMeta = await receiveMessengerEvent(mev(s1p, "m.1", T1));
      assert.equal(viaMeta.queued, true);
      const [ai1, us1, gs1, ps1] = [aiCalls, await usageRows(), g.calls.length, pancake.calls.length];
      const pp1 = await processFanpageThread(PAGE_M, pThread1, { fetch: pancake.fetch, now: at(31_000) });
      assert.equal(pp1.skipped, MESSENGER_OWNS_PAGE_REASON);
      await processMessengerThread(PAGE_M, s1p, { fetch: g.fetch, now: at(31_000) });
      assert.equal(await countText(PAGE_M, T1), 1, "MỘT dòng cho một tin khách");
      assert.deepEqual({ ai: aiCalls - ai1, usage: (await usageRows()) - us1, sends: g.sends(gs1).length }, single, "AI một lần · sổ AI một dòng-lượt · một tin gửi — như một tin đi một đường");
      assert.equal(pancake.sends(ps1).length, 0, "không gửi gì qua Pancake");
      assert.equal(await convOf(PAGE_M, pThread1), undefined, "không mở hội thoại thứ hai cho đường Pancake");
      // Tin phía page qua Pancake cũng nhường (tiếng vọng Meta mới là nguồn).
      assert.equal((await receiveFanpageEvent(pev(PAGE_M, pThread1, "pk.staff", "Dạ còn ạ", { fromPage: true, humanStaff: true }))).reason, MESSENGER_OWNS_PAGE_REASON);

      // ═══ C2. Chuyển đường GIỮA CHỪNG: bản Meta còn chờ (mắc kẹt) ⇒ bản Pancake thay, AI trả lời ĐÚNG MỘT lần ═══
      const s2 = "4100000000102";
      const T2 = "Đầm này có màu đen không shop?";
      assert.ok((await receiveMessengerEvent(mev(s2, "m.2", T2))).queued);
      const denied = await setPageConnectionModeCore(viewer, PAGE_M, "PANCAKE_WEBHOOK", "thử");
      assert.ok(!denied.ok && denied.error.includes("ai_sales:manage"), "chỉ xem không chuyển được đường");
      assert.ok(!(await setPageConnectionModeCore(admin, PAGE_M, "PANCAKE_WEBHOOK", "")).ok, "thiếu lý do ⇒ từ chối");
      const sw = await setPageConnectionModeCore(admin, PAGE_M, "PANCAKE_WEBHOOK", "Chuyển về Pancake để thử");
      assert.ok(sw.ok && sw.changed && sw.from === "META_DIRECT", JSON.stringify(sw));
      const audSw = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "SALES_CHANNEL_MODE_SET"), eq(schema.auditLogs.entityId, PAGE_M), eq(schema.auditLogs.userId, admin.id)));
      assert.ok(audSw.some((a) => JSON.stringify(a.detail).includes("Chuyển về Pancake để thử")), "nhật ký chuyển đường mang lý do");
      // Đổi đường ⇒ tin CHỜ (chưa ai giành) của đường cũ bị gác NGAY — không PENDING mãi, không bị trả lời ngược khi chuyển lại.
      const stranded = (await db.select().from(t).where(eq(t.messageId, "m.2")))[0];
      assert.ok(stranded.status === "SKIPPED" && stranded.note === ROUTE_SWITCH_NOTE && stranded.claimId === null, `tin chờ của đường cũ bị gác lúc đổi đường: ${JSON.stringify({ s: stranded.status, n: stranded.note })}`);
      const pThread2 = `${PAGE_M}_${s2}`;
      assert.ok((await receiveFanpageEvent(pev(PAGE_M, pThread2, "pk.2", T2, { senderId: s2 }))).queued, "bản của đường chính MỚI được ghi (bản bị gác chưa ai trả lời — không phải «đã có»)");
      const [ai2, us2] = [aiCalls, await usageRows()];
      const pm2 = await processMessengerThread(PAGE_M, s2, { fetch: g.fetch, now: at(31_000) });
      assert.equal(pm2.skipped, PANCAKE_OWNS_PAGE_REASON, "đường Meta nay nhường");
      const pp2 = await processFanpageThread(PAGE_M, pThread2, { fetch: pancake.fetch, now: at(31_000) });
      assert.ok(pp2.replies >= 1, JSON.stringify(pp2));
      assert.deepEqual({ ai: aiCalls - ai2, usage: (await usageRows()) - us2 }, { ai: before.ai, usage: before.usage }, "AI trả lời đúng MỘT lần sau khi chuyển đường (như một tin Pancake đi một đường)");

      // ═══ C3. Bản đường kia ĐÃ XỬ LÝ ⇒ bản thứ hai (đường vừa thành chính) không ghi, không gọi AI ═══
      const s3 = "4100000000103";
      const T3 = "Ship về Hà Nội mấy ngày em?";
      const pThread3 = `${PAGE_M}_${s3}`;
      assert.ok((await receiveFanpageEvent(pev(PAGE_M, pThread3, "pk.3", T3, { senderId: s3 }))).queued);
      assert.ok((await processFanpageThread(PAGE_M, pThread3, { fetch: pancake.fetch, now: at(31_000) })).replies >= 1);
      assert.ok((await setPageConnectionModeCore(admin, PAGE_M, "META_DIRECT", "Quay lại Meta trực tiếp")).ok);
      const ai3 = aiCalls;
      assert.deepEqual(await receiveMessengerEvent(mev(s3, "m.3", T3)), { queued: false, reason: DUPLICATE_SOURCE_REASON }, "bản thứ hai của tin đã trả lời ⇒ không ghi");
      await processMessengerThread(PAGE_M, s3, { fetch: g.fetch, now: at(31_000) });
      assert.equal(aiCalls, ai3, "0 lượt AI cho bản sao");
      assert.equal(await countText(PAGE_M, T3), 1);
      // Khách nhắn CÙNG một chữ hai lần qua MỘT đường ⇒ vẫn là hai tin (không khử nhầm).
      const s4 = "4100000000104";
      await receiveMessengerEvent(mev(s4, "m.4a", "Dạ"));
      await receiveMessengerEvent(mev(s4, "m.4b", "Dạ"));
      assert.equal((await db.select({ id: t.id }).from(t).where(and(eq(t.threadId, s4), eq(t.text, "Dạ")))).length, 2, "hai tin thật, hai dòng");

      // ═══ C4. Tin của đường cũ ĐANG được một lượt AI giành lúc đổi đường ⇒ không gác (lượt đó tự chốt); bản của đường mới ⇒ «đã có» ═══
      const s6 = "4100000000106";
      const T6 = "Váy này có size XL không shop?";
      assert.ok((await receiveMessengerEvent(mev(s6, "m.6", T6))).queued);
      await db.update(t).set({ claimId: "luot-dang-chay", claimedAt: new Date() }).where(eq(t.messageId, "m.6"));
      assert.ok((await setPageConnectionModeCore(admin, PAGE_M, "PANCAKE_WEBHOOK", "Đổi đường lúc bot đang trả lời")).ok);
      const claimed = (await db.select().from(t).where(eq(t.messageId, "m.6")))[0];
      assert.ok(claimed.status === "PENDING" && claimed.claimId === "luot-dang-chay", `tin đang được giành KHÔNG bị gác: ${JSON.stringify({ s: claimed.status, n: claimed.note })}`);
      const ai6 = aiCalls;
      assert.deepEqual(await receiveFanpageEvent(pev(PAGE_M, `${PAGE_M}_${s6}`, "pk.6", T6, { senderId: s6 })), { queued: false, reason: DUPLICATE_SOURCE_REASON }, "bản đường mới của tin đang được trả lời ⇒ không ghi (không trả lời đôi)");
      assert.equal(aiCalls, ai6, "0 lượt AI cho bản của đường mới");
      await db.update(t).set({ status: "DONE", claimId: null, claimedAt: null, processedAt: new Date() }).where(eq(t.messageId, "m.6"));
      assert.ok((await setPageConnectionModeCore(admin, PAGE_M, "META_DIRECT", "Về lại Meta trực tiếp")).ok);

      // ═══ D. Đường chính KHÔNG chạy ⇒ đường kia lưu tin cho người, 0 lượt AI; khung đường báo ═══
      await db.update(schema.orgChannelPages).set({ status: "DISABLED" }).where(eq(schema.orgChannelPages.pageId, PAGE_M));
      const s5 = "4100000000105";
      const pThread5 = `${PAGE_M}_${s5}`;
      const down = await receiveFanpageEvent(pev(PAGE_M, pThread5, "pk.5", "Shop ơi còn hàng không?", { senderId: s5 }));
      assert.deepEqual(down, { queued: false, reason: NON_CANONICAL_NOTE });
      const downRow = (await db.select().from(t).where(eq(t.messageId, "pk.5")))[0];
      assert.ok(downRow && downRow.status === "SKIPPED" && downRow.note === NON_CANONICAL_NOTE && downRow.transport === "PANCAKE", "tin lưu cho người, không vào hàng chờ AI");
      const [ai5, ps5] = [aiCalls, pancake.calls.length];
      const pp5 = await processFanpageThread(PAGE_M, pThread5, { fetch: pancake.fetch, now: at(31_000) });
      assert.ok(pp5.skipped === NON_CANONICAL_NOTE && aiCalls === ai5 && pancake.sends(ps5).length === 0, `đường phụ 0 lượt AI, 0 tin gửi: ${JSON.stringify(pp5)}`);
      const conv5 = await convOf(PAGE_M, pThread5);
      assert.ok(conv5, "người vẫn thấy hội thoại ở hộp thư");
      const routes = await listPageRoutes();
      const rM = routes.find((r) => r.pageId === PAGE_M);
      assert.ok(rM && rM.owner === null && rM.mode === "META_DIRECT" && rM.warning?.includes("chưa chạy"), `khung đường báo đường chính không chạy: ${JSON.stringify(rM)}`);
      assert.ok(!(await setPageConnectionModeCore(admin, PAGE_P, "META_DIRECT", "Chuyển thử sang đường chưa nối")).ok, "không chuyển sang đường chưa nối (AI sẽ im)");
      await db.update(schema.orgChannelPages).set({ status: "ACTIVE" }).where(eq(schema.orgChannelPages.pageId, PAGE_M));

      // ═══ E. Người trả lời từ BA nguồn ⇒ AI nhường — chế độ META_DIRECT (PAGE_M, Pancake cũng đang nối page) ═══
      const openM = async (psid: string) => {
        await receiveMessengerEvent(mev(psid, `${psid}.0`, "Áo này còn size M không?"));
        const m0 = g.calls.length;
        assert.ok((await processMessengerThread(PAGE_M, psid, { fetch: g.fetch, now: at(31_000) })).replies >= 1 && g.sends(m0).length >= 1);
        return (await convOf(PAGE_M, psid)).id;
      };
      const silentAfter = async (id: string, next: () => Promise<unknown>, process: () => Promise<{ replies: number }>) => {
        assert.equal(await holdOf(id), "HUMAN_COOLDOWN");
        await next();
        const a0 = aiCalls;
        const r = await process();
        assert.ok(r.replies === 0 && aiCalls === a0, `AI không chen khi người đang xử lý: ${JSON.stringify(r)}`);
      };
      // E1. hộp thư Chốt Đơn (ERP) — đi đúng đường Meta, không qua Pancake.
      const sE1 = "4100000000201";
      const cE1 = await openM(sE1);
      const [gE1, pE1] = [g.calls.length, pancake.calls.length];
      assert.ok((await sendStaffReplyCore(lan, cE1, { text: "Dạ em kiểm kho rồi báo chị", requestKey: "req-l3-e1" }, { fetch: g.fetch })).ok);
      assert.ok(g.sends(gE1).length === 1 && pancake.sends(pE1).length === 0, "tin nhân viên ở page Meta trực tiếp đi Send API, không đi Pancake");
      await silentAfter(cE1, () => receiveMessengerEvent(mev(sE1, "e1.2", "Còn không em?")), () => processMessengerThread(PAGE_M, sE1, { fetch: g.fetch, now: at(5 * MIN) }));
      // E2. Hộp thư Meta Business Suite (tiếng vọng app khác).
      const sE2 = "4100000000202";
      const cE2 = await openM(sE2);
      assert.match((await receiveMessengerEvent(mev(sE2, "e2.staff", "Dạ chị đợi em chút", { isEcho: true, appId: META_INBOX_APP_ID }))).reason, /bot nhường/);
      await silentAfter(cE2, () => receiveMessengerEvent(mev(sE2, "e2.2", "Shop ơi?")), () => processMessengerThread(PAGE_M, sE2, { fetch: g.fetch, now: at(5 * MIN) }));
      // E3. Nhân viên gõ trên Pancake: gói của Pancake bị đường Pancake bỏ qua, tiếng vọng Meta (app của Pancake) báo người.
      const sE3 = "4100000000203";
      const cE3 = await openM(sE3);
      assert.equal((await receiveFanpageEvent(pev(PAGE_M, `${PAGE_M}_${sE3}`, "e3.pk", "Dạ em gửi ảnh chị xem", { fromPage: true, humanStaff: true }))).reason, MESSENGER_OWNS_PAGE_REASON);
      assert.match((await receiveMessengerEvent(mev(sE3, "e3.echo", "Dạ em gửi ảnh chị xem", { isEcho: true, appId: PANCAKE_APP_ID }))).reason, /bot nhường/);
      await silentAfter(cE3, () => receiveMessengerEvent(mev(sE3, "e3.2", "Ok em")), () => processMessengerThread(PAGE_M, sE3, { fetch: g.fetch, now: at(5 * MIN) }));

      // ═══ E'. BA nguồn — chế độ PANCAKE_WEBHOOK (PAGE_P) ═══
      await setPancakePage(PAGE_P);
      const openP = async (thread: string) => {
        await receiveFanpageEvent(pev(PAGE_P, thread, `${thread}.0`, "Chả mực còn không shop?"));
        const m0 = pancake.calls.length;
        assert.ok((await processFanpageThread(PAGE_P, thread, { fetch: pancake.fetch, now: at(31_000) })).replies >= 1 && pancake.sends(m0).length >= 1);
        return (await convOf(PAGE_P, thread)).id;
      };
      const procP = (thread: string) => () => processFanpageThread(PAGE_P, thread, { fetch: pancake.fetch, now: at(5 * MIN) });
      // E4. hộp thư ERP — đi Pancake.
      const cE4 = await openP("p-e4");
      const [gE4, pE4] = [g.calls.length, pancake.calls.length];
      assert.ok((await sendStaffReplyCore(lan, cE4, { text: "Dạ em báo giá chị nhé", requestKey: "req-l3-e4" }, { fetch: pancake.fetch })).ok);
      assert.ok(pancake.sends(pE4).length === 1 && g.sends(gE4).length === 0, "tin nhân viên ở page Pancake đi Pancake");
      await silentAfter(cE4, () => receiveFanpageEvent(pev(PAGE_P, "p-e4", "e4.2", "Bao nhiêu em?")), procP("p-e4"));
      // E5. Nhân viên gõ trên Pancake (có uid).
      const cE5 = await openP("p-e5");
      assert.match((await receiveFanpageEvent(pev(PAGE_P, "p-e5", "e5.staff", "Dạ em kiểm hàng", { fromPage: true, humanStaff: true }))).reason, /bot nhường/);
      await silentAfter(cE5, () => receiveFanpageEvent(pev(PAGE_P, "p-e5", "e5.2", "Nhanh nha em")), procP("p-e5"));
      // E6. Hộp thư Meta: Pancake nhận câu của page KHÔNG uid giữa lúc bot đang trò chuyện ⇒ người.
      const cE6 = await openP("p-e6");
      assert.match((await receiveFanpageEvent(pev(PAGE_P, "p-e6", "e6.meta", "Dạ chị cho em xin địa chỉ", { fromPage: true, humanStaff: false }))).reason, /bot nhường/);
      await silentAfter(cE6, () => receiveFanpageEvent(pev(PAGE_P, "p-e6", "e6.2", "Số 5 Lê Lợi")), procP("p-e6"));

      // ═══ F. Số phút nhường CẤU HÌNH ĐƯỢC theo workspace ═══
      assert.equal(await humanCooldownMinutes(), 30, "chưa khai ⇒ 30 phút như cũ");
      assert.ok(!(await setHumanCooldownMinutesCore(viewer, 45)).ok, "chỉ xem không đổi được");
      for (const bad of [0, 1441, 1.5, "abc"]) assert.ok(!(await setHumanCooldownMinutesCore(admin, bad)).ok, `«${String(bad)}» bị từ chối`);
      const setF = await setHumanCooldownMinutesCore(admin, 45);
      assert.ok(setF.ok && setF.changed && setF.minutes === 45, JSON.stringify(setF));
      assert.equal(await humanCooldownMinutes(), 45);
      const audF = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "SALES_CHAT_COOLDOWN_SET"));
      assert.ok(audF.length === 1 && audF[0].userId === admin.id && JSON.stringify(audF[0].detail).includes('"to":45'), "nhật ký trước → sau");
      const cF = await openP("p-f");
      const TF = new Date();
      assert.match((await receiveFanpageEvent(pev(PAGE_P, "p-f", "f.staff", "Dạ em đây", { fromPage: true, humanStaff: true }), TF)).reason, /bot nhường/);
      assert.equal((await db.select().from(c).where(eq(c.id, cF)))[0].humanCooldownUntil?.getTime(), TF.getTime() + 45 * MIN, "mốc hết nhường = giờ gửi + 45 phút");
      await receiveFanpageEvent(pev(PAGE_P, "p-f", "f.2", "Còn không em?"));
      let aF = aiCalls;
      const pF31 = await processFanpageThread(PAGE_P, "p-f", { fetch: pancake.fetch, now: () => new Date(TF.getTime() + 31 * MIN) });
      assert.ok(pF31.replies === 0 && aiCalls === aF, `31 phút < 45 ⇒ vẫn nhường: ${JSON.stringify(pF31)}`);
      await receiveFanpageEvent(pev(PAGE_P, "p-f", "f.3", "Shop ơi?"));
      aF = aiCalls;
      const pF46 = await processFanpageThread(PAGE_P, "p-f", { fetch: pancake.fetch, now: () => new Date(TF.getTime() + 46 * MIN) });
      assert.ok(pF46.replies >= 1 && aiCalls > aF, `hết 45 phút ⇒ AI trả lời lại: ${JSON.stringify(pF46)}`);
      assert.ok((await setHumanCooldownMinutesCore(admin, 30)).ok);

      // ═══ G. Hộp thư: thẻ AI / Người ≡ aiHoldOf · Đã chốt / Chưa chốt · SỐ chưa đọc · nguồn · ảnh đại diện · lọc page ═══
      const now = new Date();
      const ago = (ms: number) => new Date(now.getTime() - ms);
      const matrix: { name: string; v: Partial<typeof c.$inferInsert> }[] = [
        { name: "AI tự trả lời", v: { status: "OPEN" } },
        { name: "nhường còn hạn", v: { status: "HANDOFF", handoffReason: FANPAGE_STAFF_REASON, humanCooldownUntil: new Date(now.getTime() + 10 * MIN) } },
        { name: "nhường hết hạn (chưa dọn)", v: { status: "HANDOFF", handoffReason: FANPAGE_STAFF_REASON, humanCooldownUntil: ago(MIN) } },
        { name: "nhường cũ không mốc — còn hạn", v: { status: "HANDOFF", handoffReason: FANPAGE_STAFF_REASON, updatedAt: ago(10 * MIN) } },
        { name: "nhường cũ không mốc — hết hạn", v: { status: "HANDOFF", handoffReason: FANPAGE_STAFF_REASON, updatedAt: ago(40 * MIN) } },
        { name: "AI hỏng — còn hạn", v: { status: "HANDOFF", handoffReason: AI_DOWN_HANDOFF_REASON, updatedAt: ago(10 * MIN) } },
        { name: "AI hỏng — hết hạn", v: { status: "HANDOFF", handoffReason: AI_DOWN_HANDOFF_REASON, updatedAt: ago(40 * MIN) } },
        { name: "cần người (lý do khác)", v: { status: "HANDOFF", handoffReason: "Khách đòi gặp người" } },
        { name: "cần người (không lý do)", v: { status: "HANDOFF", handoffReason: null } },
        { name: "tiếp quản", v: { status: "OPEN", state: { control: { mode: "HUMAN", byUserId: lan.id, byName: "Lan", at: now.toISOString(), reason: null } } } },
        { name: "AI gợi ý", v: { status: "OPEN", state: { control: { mode: "COPILOT", byUserId: lan.id, byName: "Lan", at: now.toISOString(), reason: null } } } },
        { name: "đã chốt (đơn ERP)", v: { status: "OPEN", orderId: "erp-l3-don-1" } },
        { name: "đã chốt (level)", v: { status: "OPEN", customerLevel: "ORDERED" } },
        { name: "đơn nháp", v: { status: "OPEN", draftOrderId: "nhap-l3-1" } },
      ];
      const ids: Record<string, string> = {};
      for (const m of matrix) {
        const [r] = await db.insert(c).values({ channel: "WEB", lastCustomerAt: ago(2 * MIN), ...m.v }).returning({ id: c.id });
        ids[m.name] = r.id;
      }
      const all = await listInbox(admin, { limit: 500 }, now);
      assert.ok(all.ok, JSON.stringify(all));
      const human = await listInbox(admin, { filter: "HUMAN", limit: 500 }, now);
      const aiF = await listInbox(admin, { filter: "AI", limit: 500 }, now);
      const ordered = await listInbox(admin, { filter: "ORDERED", limit: 500 }, now);
      const notOrdered = await listInbox(admin, { filter: "NOT_ORDERED", limit: 500 }, now);
      assert.ok(human.ok && aiF.ok && ordered.ok && notOrdered.ok);
      const waitingN = all.rows.filter((r) => r.handling === "WAITING").length;
      assert.equal(all.counts.AI + all.counts.HUMAN + waitingN, all.counts.ALL, "AI + Người + Chờ người (AI dừng, chưa ai cầm) phủ kín");
      assert.equal(all.counts.ORDERED + all.counts.NOT_ORDERED, all.counts.ALL, "Đã chốt + Chưa chốt phủ kín");
      const humanIds = new Set(human.rows.map((r) => r.id));
      const dbRows = await db.select().from(c).where(inArray(c.id, all.rows.map((r) => r.id)));
      const byId = new Map(dbRows.map((r) => [r.id, r]));
      for (const r of all.rows) {
        const d = byId.get(r.id)!;
        const st = aiHoldOf(d, now).state;
        assert.equal(r.aiHold, st, `trạng thái AI của hàng = aiHoldOf (${r.id})`);
        const cls = classifyInboxState({ ...d, pageReplyAfterCustomer: false, orderUnderReview: false }, now, false);
        assert.equal(r.handling, inboxHandlingFrom(cls), `huy hiệu = classifyInboxState (${r.id})`);
        assert.equal(humanIds.has(r.id), cls.humanHandling !== null, `thẻ «Người đang xử lý» ≡ huy hiệu cho ${matrix.find((m) => ids[m.name] === r.id)?.name ?? r.id}: ${r.handling}`);
      }
      // Chủ shop 10/10/2026 (mục B3, SỬA ma trận cũ): «Người đang xử lý» = tiếp quản · AI nhường · AI gợi ý. AI xin người / AI hỏng mà
      // chưa ai cầm là «Cần người» (chờ người), KHÔNG phải «Người đang xử lý» — bản cũ gộp chúng vào nhóm người.
      const expectHuman = ["nhường còn hạn", "nhường cũ không mốc — còn hạn", "tiếp quản", "AI gợi ý"];
      const expectWaiting = ["AI hỏng — còn hạn", "cần người (lý do khác)", "cần người (không lý do)"];
      for (const m of matrix) {
        assert.equal(humanIds.has(ids[m.name]), expectHuman.includes(m.name), `ma trận Người: «${m.name}»`);
        assert.equal(all.rows.find((r) => r.id === ids[m.name])?.handling === "WAITING", expectWaiting.includes(m.name), `ma trận Chờ người: «${m.name}»`);
      }
      const cp = all.rows.find((r) => r.id === ids["AI gợi ý"]);
      assert.ok(cp && cp.aiHold === "AI_ACTIVE" && cp.handling === "COPILOT", "AI gợi ý: đường xử lý KHÔNG đổi (bot vẫn soạn gợi ý), hộp thư xếp vào nhóm người");
      // Cả tổ chức ở chế độ Copilot ⇒ không hội thoại nào ở nhóm «AI đang trả lời» (bot không gửi gì cho ai).
      const copilotMode = JSON.stringify({ mode: "COPILOT", aiSharePct: 50 });
      await db.insert(schema.settings).values({ key: OPERATING_MODE_SETTING_KEY, value: copilotMode }).onConflictDoUpdate({ target: schema.settings.key, set: { value: copilotMode } });
      const orgCp = await listInbox(admin, { limit: 500 }, now);
      assert.ok(orgCp.ok && orgCp.counts.AI === 0 && orgCp.counts.HUMAN === orgCp.counts.ALL && orgCp.rows.every((r) => r.handling !== "AI"), `tổ chức Copilot ⇒ mọi hội thoại thuộc nhóm người: ${JSON.stringify(orgCp.ok ? orgCp.counts : orgCp)}`);
      await db.delete(schema.settings).where(eq(schema.settings.key, OPERATING_MODE_SETTING_KEY));
      assert.ok(ordered.rows.every((r) => r.closed) && notOrdered.rows.every((r) => !r.closed));
      const orderedIds = new Set(ordered.rows.map((r) => r.id));
      assert.ok(orderedIds.has(ids["đã chốt (đơn ERP)"]) && orderedIds.has(ids["đã chốt (level)"]) && !orderedIds.has(ids["đơn nháp"]), "đơn nháp KHÔNG là đã chốt");
      assert.ok(all.rows.find((r) => r.id === ids["đơn nháp"])?.hasOrder, "đơn nháp vẫn là «có đơn»");
      // SỐ chưa đọc: ba tin khách chưa ai mở ⇒ 3; mở ⇒ 0; thêm một ⇒ 1.
      const sU = "4100000000901";
      for (const [i, txt] of ["Chào shop", "Áo còn không", "Giá sao ạ"].entries()) await receiveMessengerEvent(mev(sU, `u.${i}`, txt));
      const convU = (await convOf(PAGE_M, sU)).id;
      const rowU = async () => {
        const l = await listInbox(admin, { page: PAGE_M, limit: 500 });
        assert.ok(l.ok);
        return l.rows.find((r) => r.id === convU)!;
      };
      let ru = await rowU();
      assert.ok(ru.unread && ru.unreadCount === 3 && ru.source === "DIRECT" && ru.pageId === PAGE_M, `ba tin chưa đọc: ${JSON.stringify({ u: ru.unread, n: ru.unreadCount, s: ru.source })}`);
      assert.ok((await loadInboxThread(lan, convU)).ok);
      ru = await rowU();
      assert.ok(!ru.unread && ru.unreadCount === 0, "mở hội thoại ⇒ 0");
      await receiveMessengerEvent(mev(sU, "u.3", "Shop ơi"));
      assert.equal((await rowU()).unreadCount, 1);
      // Nguồn của hội thoại Pancake.
      const pRow = all.rows.find((r) => r.id === cE4);
      assert.ok(pRow && pRow.source === "PANCAKE", "hội thoại Pancake mang nhãn Pancake");
      // Lọc page.
      const onlyP = await listInbox(admin, { page: PAGE_P, limit: 500 });
      assert.ok(onlyP.ok && onlyP.rows.length > 0 && onlyP.rows.every((r) => r.pageId === PAGE_P));
      // Ảnh đại diện: Graph `profile_pic` ⇒ ảnh thật; đọc lại trong hạn ⇒ không gọi Graph; app không có quyền ⇒ chữ cái, không lộ token.
      assert.equal(ru.avatarUrl, null, "chưa đọc hồ sơ ⇒ chữ cái");
      assert.equal(await refreshMessengerProfile(PAGE_M, sU, { fetch: g.fetch }), "FETCHED");
      assert.equal((await rowU()).avatarUrl, AVATAR);
      const gAv = g.calls.length;
      assert.equal(await refreshMessengerProfile(PAGE_M, sU, { fetch: g.fetch }), "FRESH");
      assert.equal(g.calls.length, gAv, "còn hạn ⇒ không gọi Graph lần hai");
      await receiveMessengerEvent(mev(DENIED_PSID, "dn.1", "Hello"));
      assert.equal(await refreshMessengerProfile(PAGE_M, DENIED_PSID, { fetch: g.fetch }), "FAILED");
      const deniedConv = await convOf(PAGE_M, DENIED_PSID);
      const prof = (deniedConv.state as { messengerProfile?: { pic: unknown; error: unknown } }).messengerProfile;
      assert.ok(prof && prof.pic === null && typeof prof.error === "string" && !String(prof.error).includes(PAGE_TOKEN), `lỗi quyền ghi lại, đã che token: ${JSON.stringify(prof)}`);
      const thDenied = await loadInboxThread(lan, deniedConv.id);
      assert.ok(thDenied.ok && thDenied.thread.avatarUrl === null);
      // Ảnh Pancake trong dữ liệu hội thoại; URL mang khoá ⇒ không dùng.
      await db.update(c).set({ state: sql`${c.state} || ${JSON.stringify({ pancakeAvatarUrl: "https://content.pancake.vn/avatar/abc.jpg" })}::jsonb` }).where(eq(c.id, cE4));
      await db.update(c).set({ state: sql`${c.state} || ${JSON.stringify({ pancakeAvatarUrl: "https://pages.fm/avatar?page_access_token=x&access_token=y" })}::jsonb` }).where(eq(c.id, cE5));
      const avatars = await listInbox(admin, { page: PAGE_P, limit: 500 });
      assert.ok(avatars.ok);
      assert.equal(avatars.rows.find((r) => r.id === cE4)?.avatarUrl, "https://content.pancake.vn/avatar/abc.jpg");
      assert.equal(avatars.rows.find((r) => r.id === cE5)?.avatarUrl, null, "URL mang khoá ⇒ chữ cái");
      aConvIds.push(convU, cE1);

      // ═══ I0. Gỡ Meta trực tiếp khi KHÔNG còn đường nào chạy page ⇒ bỏ dòng canonical (về luật mặc định), có nhật ký ═══
      // Dòng META_DIRECT ở lại thì nối Pancake sau đó AI im: đường chính trỏ vào đường đã gỡ. (Pancake lúc này nối PAGE_P.)
      assert.ok("ok" in (await disconnectMessengerPage(admin, PAGE_M, { fetch: g.fetch })));
      assert.equal((await db.select().from(modesT).where(eq(modesT.pageId, PAGE_M))).length, 0, "không còn đường nào ⇒ bỏ dòng canonical");
      const audClear = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "SALES_CHANNEL_MODE_SET"), eq(schema.auditLogs.entityId, PAGE_M)));
      assert.ok(audClear.some((a) => a.userId === admin.id && JSON.stringify(a.detail).includes("DISCONNECT_META_NO_ROUTE")), "nhật ký bỏ dòng");
      await setPancakePage(PAGE_M);
      assert.equal(transportOwnerOf(await loadTransportFacts(), PAGE_M), "PANCAKE", "nối Pancake sau đó ⇒ Pancake chạy page ngay, AI không im");
      // Nối lại Meta (Pancake về PAGE_P) để khối I kiểm nhánh «Pancake đang chạy page».
      await setPancakePage(PAGE_P);
      const reconn = await connectMessengerPage(admin, { id: PAGE_M, name: "Shop L3", token: PAGE_TOKEN, canMessage: true }, { fetch: g.fetch });
      assert.ok("ok" in reconn, JSON.stringify(reconn));
      assert.equal((await db.select().from(modesT).where(eq(modesT.pageId, PAGE_M)))[0]?.mode, "META_DIRECT");

      // ═══ I. Gỡ Meta trực tiếp của page Pancake đang chạy ⇒ đường chính về Pancake (hệ quả tường minh, nhật ký) ═══
      await setPancakePage(PAGE_M);
      const off = await disconnectMessengerPage(admin, PAGE_M, { fetch: g.fetch });
      assert.ok("ok" in off && off.message.includes("Pancake"), JSON.stringify(off));
      const rowOff = (await db.select().from(modesT).where(eq(modesT.pageId, PAGE_M)))[0];
      assert.ok(rowOff.mode === "PANCAKE_WEBHOOK" && rowOff.source === "MANUAL" && rowOff.setByUserId === admin.id, JSON.stringify(rowOff));
      assert.equal(transportOwnerOf(await loadTransportFacts(), PAGE_M), "PANCAKE");

      // ═══ J. Lượt QUÉT LẠI của Pancake không trả lời bù tin khách TRƯỚC mốc người đổi đường chính (lúc đó Meta giữ page) ═══
      const switchedAt = rowOff.updatedAt.getTime();
      const isoAt = (ms: number) => new Date(ms).toISOString().replace("Z", "");
      const cuMsgs: Record<string, Record<string, unknown>[]> = {
        "cu-truoc": [{ id: "cu-truoc.1", message: "Shop ơi áo này còn không?", from: { id: "cust-cu-truoc" }, inserted_at: isoAt(switchedAt - 4 * MIN) }],
        "cu-sau": [{ id: "cu-sau.1", message: "Cho em hỏi giá váy hoa", from: { id: "cust-cu-sau" }, inserted_at: isoAt(switchedAt + 2 * MIN) }],
      };
      const cuCalls: Call[] = [];
      const cuFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        cuCalls.push({ url, init });
        const thread = /\/conversations\/([^/?]+)\/messages/.exec(url)?.[1];
        const list = Object.entries(cuMsgs).map(([id, ms]) => {
          const last = ms[ms.length - 1];
          return { id, updated_at: last.inserted_at, snippet: last.message, last_sent_by: { id: (last.from as { id: string }).id }, from: { name: `Khách ${id}` } };
        });
        const body = init?.method === "POST" ? { success: true, id: `cu-out-${cuCalls.length}` } : url.includes("/conversations?") ? { success: true, conversations: list } : thread ? { success: true, messages: cuMsgs[decodeURIComponent(thread)] ?? [] } : { success: true };
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      const cu = await catchUpFanpage({ fetch: cuFetch, now: () => new Date(switchedAt + 5 * MIN) });
      const postsTo = (thread: string) => cuCalls.filter((x) => x.init?.method === "POST" && x.url.includes(`/conversations/${thread}/messages`)).length;
      assert.ok(postsTo("cu-sau") >= 1, `tin SAU mốc đổi đường ⇒ vẫn trả lời bù: ${JSON.stringify(cu)}`);
      assert.equal(postsTo("cu-truoc"), 0, `tin TRƯỚC mốc đổi đường ⇒ không trả lời bù qua đường mới: ${JSON.stringify(cu)}`);
      assert.equal((await db.select({ id: t.id }).from(t).where(eq(t.messageId, "cu-truoc.1"))).length, 0, "không nhận tin cũ vào hàng chờ");
    });

    // ═══ H. Cô lập tổ chức ═══
    const enabledB = [...(await getEnabledModules(ORG_B))];
    await withOrganization(ORG_B, async () => {
      const db = await getDb();
      const ub = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG_B}.local`) });
      assert.ok(ub);
      const adminB = { id: ub.id, email: ub.email, name: "QT B", role: "ADMIN", scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG_B, name: ORG_B, isHome: false }, modules: enabledB, permissions: ["ai_sales:manage", "ai_sales:view", "ai_sales:reply"] } as unknown as SessionUser;
      for (const f of ["ALL", "AI", "HUMAN", "ORDERED", "NOT_ORDERED", "UNREAD"] as const) {
        const l = await listInbox(adminB, { filter: f, limit: 500 });
        assert.ok(l.ok && !l.rows.some((r) => aConvIds.includes(r.id)), `tổ chức B (lọc ${f}) không thấy hội thoại của A`);
      }
      assert.deepEqual(await listPageRoutes(), [], "B không thấy page của A");
      const grab = await setPageConnectionModeCore(adminB, PAGE_P, "PANCAKE_WEBHOOK", "Thử chiếm page của A");
      assert.ok(!grab.ok, "B không đặt được đường cho page của A");
      assert.equal((await db.select().from(schema.channelPageModes)).length, 0);
      assert.equal(await humanCooldownMinutes(), 30, "số phút nhường của A không lan sang B");
    });
    await withOrganization(ORG, async () => {
      const db = await getDb();
      assert.equal((await db.select().from(schema.channelPageModes).where(eq(schema.channelPageModes.pageId, PAGE_P)))[0]?.mode, "PANCAKE_WEBHOOK", "đường của A không đổi");
    });
  } finally {
    setSalesChatProviderForTests(null);
  }
}

export async function testSaasL3Inbox() {
  testPure();
  const { stmts } = await testBackfillUpgrade();
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.FACEBOOK_LOGIN_APP_ID = APP_ID;
  process.env.FACEBOOK_LOGIN_APP_SECRET = APP_SECRET;
  delete process.env.FACEBOOK_MESSENGER_APP_ID;
  delete process.env.FACEBOOK_MESSENGER_APP_SECRET;
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-hop-thu-l3-0123456789abcdefghijklmnopqrstuvwxyz";
  try {
    await cleanupOrg(ORG);
    await cleanupOrg(ORG_B);
    await testFlow(stmts);
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await cleanupOrg(ORG);
    await cleanupOrg(ORG_B);
  }
  console.log(
    "✓ Hộp thư hợp nhất + song song Pancake/Meta: đường canonical lưu theo page (backfill 0233 giữ ĐÚNG đường hôm nay — page Pancake trước = sau, chạy lại không nhân dòng); page mới nối Meta ⇒ META_DIRECT; cùng tin hai webhook ⇒ 1 dòng, AI/sổ AI/tin gửi như một đường; chuyển đường giữa chừng ⇒ AI đúng một lần; đường phụ lưu cho người, 0 AI; người trả lời từ ERP · Pancake · Hộp thư Meta ⇒ AI nhường ở cả hai chế độ; số phút nhường cấu hình theo workspace; thẻ AI/Người ≡ huy hiệu trên ma trận 14 dòng (AI gợi ý thuộc nhóm người, cả hội thoại lẫn chế độ tổ chức); đổi đường ⇒ tin chờ đường cũ bị gác, tin đang giành không trả lời đôi, quét lại không trả lời bù tin trước mốc đổi; đọc đường hỏng ⇒ Pancake chạy như cũ; gỡ đường cuối ⇒ bỏ dòng canonical; Đã chốt/Chưa chốt phủ kín; số chưa đọc; ảnh đại diện Graph (lỗi quyền ⇒ chữ cái, không lộ token); cô lập tổ chức",
  );
}

if (process.argv[1] && /saas-l3-inbox.test.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testSaasL3Inbox)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}

/**
 * ═══════════ MESSENGER TRỰC TIẾP: TOKEN HỎNG ⇒ CẦN NỐI LẠI (graph-errors.ts · messenger-health.ts · slice 3) ═══════════
 *
 * Khoá:
 *  · THUẦN: 190 / 102 ⇒ TOKEN; 200–299 / 10 ⇒ PERMISSION; 10·2018278 ⇒ WINDOW (KHÔNG phải mất quyền); 551 ⇒ RECIPIENT; 4 · 613
 *    ⇒ RATE_LIMIT; chỉ TOKEN / PERMISSION là «cần nối lại».
 *  · Graph giả trả 190 khi bot gửi: kết nối ACTIVE ⇒ DRAFT kèm câu lỗi + việc phải làm, MỘT chuông + một tin hộp thư cho người
 *    cấu hình được kết nối, nhật ký mang nhãn máy; lỗi thứ hai KHÔNG báo lại; token không lọt vào câu lỗi / chuông.
 *  · Lỗi ngoài 24 giờ ⇒ kết nối vẫn ACTIVE, không báo ai.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { classifyGraphError, needsReconnect } from "@/lib/integrations/messenger/graph-errors";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { connectMessengerPage, sendMessengerPageText } from "@/lib/sales-chatbot/messenger";
import { messengerWebhookLog, summarizeMessengerWebhook } from "@/lib/sales-chatbot/messenger-observability";

const ORG = "msg-suc-khoe";
const APP_ID = "777000555666";
const APP_SECRET = "app-secret-health-test-0123456789abc";
const PAGE = "3049586172";
const PAGE_TOKEN = "EAAGpagetoken_health_0123456789abcdef";
const ENV_KEYS = ["FACEBOOK_LOGIN_APP_ID", "FACEBOOK_LOGIN_APP_SECRET", "PLATFORM_SECRETS_KEY"] as const;

function testPure() {
  assert.equal(classifyGraphError(190, 460), "TOKEN", "đổi mật khẩu");
  assert.equal(classifyGraphError(190, null), "TOKEN");
  assert.equal(classifyGraphError(102), "TOKEN");
  assert.equal(classifyGraphError(230), "PERMISSION", "thiếu pages_messaging");
  assert.equal(classifyGraphError(200), "PERMISSION");
  assert.equal(classifyGraphError(10), "PERMISSION");
  assert.equal(classifyGraphError(10, 2018278), "WINDOW", "ngoài 24 giờ KHÔNG phải mất quyền");
  assert.equal(classifyGraphError(100, 2018109), "WINDOW");
  assert.equal(classifyGraphError(551), "RECIPIENT");
  assert.equal(classifyGraphError(100, 2018001), "RECIPIENT");
  assert.equal(classifyGraphError(613), "RATE_LIMIT");
  assert.equal(classifyGraphError(4), "RATE_LIMIT");
  assert.equal(classifyGraphError(100), "OTHER");
  assert.equal(classifyGraphError(null), "OTHER", "mạng hỏng không phải token hỏng");
  assert.deepEqual((["TOKEN", "PERMISSION", "WINDOW", "RECIPIENT", "RATE_LIMIT", "OTHER"] as const).filter(needsReconnect), ["TOKEN", "PERMISSION"]);

  // Quan sát webhook: gói bình thường không ghi log; page lạ / sự kiện trùng ⇒ MỘT tóm tắt chỉ có số đếm + mã page.
  assert.equal(summarizeMessengerWebhook([{ pageId: "1", outcome: "QUEUED" }, { pageId: "1", outcome: "IGNORED" }]), null);
  assert.deepEqual(summarizeMessengerWebhook([{ pageId: "9", outcome: "UNKNOWN_PAGE" }, { pageId: "9", outcome: "UNKNOWN_PAGE" }, { pageId: "1", outcome: "DUPLICATE" }, { pageId: "1", outcome: "QUEUED" }]), { events: 4, queued: 1, duplicates: 1, ignored: 0, unknownPages: ["9"] });
  const logged: string[] = [];
  const orig = console.warn;
  console.warn = (s: unknown) => void logged.push(String(s));
  try {
    messengerWebhookLog("messenger_process_failed", { org: "shop", pageId: "1", error: "x".repeat(1000) });
  } finally {
    console.warn = orig;
  }
  const line = JSON.parse(logged[0]) as { evt: string; error: string };
  assert.ok(line.evt === "messenger_process_failed" && line.error.length === 300, "một dòng JSON, câu lỗi cắt ≤ 300 ký tự");
  const route = readFileSync("app/api/webhooks/messenger/route.ts", "utf8");
  assert.ok(!/messengerWebhookLog\([^)]*\b(ev\.text|ev\.psid|psid|text)\b/.test(route), "log của webhook không mang nội dung tin / PSID");
}

function fakeGraph(mode: { send: "OK" | "TOKEN" | "WINDOW" }) {
  const f = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (u.pathname.endsWith(`/${PAGE}/subscribed_apps`)) return json({ success: true });
    if (u.pathname.endsWith(`/${PAGE}`)) return json({ id: PAGE });
    if (u.pathname.endsWith("/me") && u.searchParams.get("access_token") === PAGE_TOKEN) return json({ id: PAGE, name: "Shop Sức Khoẻ" });
    if (u.pathname.endsWith("/me/messages")) {
      if (mode.send === "TOKEN") return json({ error: { message: `Error validating access token: The session has been invalidated because the user changed their password. token=${PAGE_TOKEN}`, type: "OAuthException", code: 190, error_subcode: 460 } }, 400);
      if (mode.send === "WINDOW") return json({ error: { message: "This message is sent outside of allowed window.", type: "OAuthException", code: 10, error_subcode: 2018278 } }, 400);
      return json({ recipient_id: "x", message_id: "m.ok.1" });
    }
    return json({ error: { message: "không có", code: 100 } }, 400);
  }) as typeof fetch;
  return f;
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

async function testFlow() {
  await provisionOrganization({ code: ORG, name: ORG, plan: "starter", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "SucKhoe@12345" }, source: "TEST", actor: null });
  const enabled = [...(await getEnabledModules(ORG))];
  await withOrganization(ORG, async () => {
    const db = await getDb();
    const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
    assert.ok(u);
    const admin = { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: ["settings:manage", "ai_sales:manage", "ai_sales:view"], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false }, modules: enabled } as unknown as SessionUser;
    const mode: { send: "OK" | "TOKEN" | "WINDOW" } = { send: "OK" };
    const f = fakeGraph(mode);
    const conn = await connectMessengerPage(admin, { id: PAGE, name: "Shop Sức Khoẻ", token: PAGE_TOKEN, canMessage: true }, { fetch: f });
    assert.ok("ok" in conn, JSON.stringify(conn));
    const oc = schema.orgConnections;
    const status = async () => (await db.select({ status: oc.status, msg: oc.lastTestMessage, ok: oc.lastTestOk }).from(oc).where(eq(oc.connectorKey, "facebook-messenger")))[0];
    const bells = async () => db.select().from(schema.notifications).where(eq(schema.notifications.entityId, "facebook-messenger"));
    const inbox = async () => db.select().from(schema.userMessages).where(eq(schema.userMessages.kind, "CONNECTION_BROKEN"));

    // Ngoài 24 giờ ⇒ chỉ tin này hỏng; kết nối vẫn bật, không báo ai.
    mode.send = "WINDOW";
    const w = await sendMessengerPageText(PAGE, "psid-1", "Chào chị", { fetch: f });
    assert.ok(!w.ok && w.error.includes("24 giờ"), JSON.stringify(w));
    assert.equal((await status()).status, "ACTIVE");
    assert.equal((await bells()).length, 0);

    // Token bị thu hồi ⇒ cần nối lại.
    mode.send = "TOKEN";
    const t1 = await sendMessengerPageText(PAGE, "psid-1", "Chào chị", { fetch: f });
    assert.ok(!t1.ok && t1.error.includes("Đổi page") && !t1.error.includes(PAGE_TOKEN), `câu lỗi nói việc phải làm, không lộ token: ${JSON.stringify(t1)}`);
    const s1 = await status();
    assert.ok(s1.status === "DRAFT" && s1.ok === false && (s1.msg ?? "").includes("Đổi page") && !(s1.msg ?? "").includes(PAGE_TOKEN), JSON.stringify(s1));
    const b1 = await bells();
    assert.ok(b1.length === 1 && b1[0].severity === "critical" && b1[0].href === "/ai/sales-chatbot/messenger" && !b1[0].body.includes(PAGE_TOKEN), JSON.stringify(b1));
    const m1 = await inbox();
    assert.ok(m1.length === 1 && m1[0].userId === u.id, "người cấu hình được kết nối nhận tin hộp thư");
    const aud = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "ORG_CONNECTION_AUTO_DRAFT"), eq(schema.auditLogs.entityId, "facebook-messenger")));
    assert.ok(aud.length === 1 && aud[0].userId === null && aud[0].actorKind === "SYSTEM", JSON.stringify(aud));

    // Lần gửi sau: kết nối đã về Nháp ⇒ không gọi Meta, không báo lại.
    const t2 = await sendMessengerPageText(PAGE, "psid-1", "Chào chị", { fetch: f });
    assert.ok(!t2.ok);
    assert.equal((await bells()).length, 1, "không báo lại");
    assert.equal((await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "ORG_CONNECTION_AUTO_DRAFT"))).length, 1);
  });
}

export async function testMessengerHealth() {
  testPure();
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.FACEBOOK_LOGIN_APP_ID = APP_ID;
  process.env.FACEBOOK_LOGIN_APP_SECRET = APP_SECRET;
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-suc-khoe-0123456789abcdefghijklmnopqrstuvwxyz";
  try {
    await cleanup();
    await testFlow();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await cleanup();
  }
  console.log("✓ Messenger trực tiếp — token hỏng: lỗi Graph phân sáu loại (ngoài 24 giờ / khách chặn / chạm trần KHÔNG phải mất quyền); 190 ⇒ kết nối về Nháp kèm việc phải làm, MỘT chuông + tin hộp thư cho người cấu hình, nhật ký nhãn máy, không báo lại, token không lọt vào câu lỗi");
}

if (process.argv[1] && /messenger-health\.test\.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testMessengerHealth)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}

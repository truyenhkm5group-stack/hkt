/**
 * ═══════════ PANCAKE POS CỦA TỔ CHỨC KHÁCH (kết nối «pancake-pos-org» · job `pancake-org` · F1 Fashion COD) ═══════════
 *
 *  1. THUẦN — sổ connector khai PER_ORG / module Đơn hàng / webhook URL_SECRET; hàm kiểm tra kết nối: sai dạng ⇒ 0 request,
 *     khoá đúng nhưng sai shop ⇒ KHÔNG đạt và nói shop nào khoá thấy, khoá bị từ chối ⇒ không đạt, câu kết quả không bao giờ
 *     mang khoá, chỉ gọi pos.pages.fm.
 *  2. TỔ CHỨC THẬT `pk-shop`: chưa bật ⇒ job bỏ qua có lý do, 0 request · lưu → kiểm tra → bật · Pancake thành NGUỒN đơn /
 *     khách / sản phẩm (cổng tạo tay đóng) · job kéo sản phẩm + đơn VÀO CSDL CỦA TỔ CHỨC bằng ĐÚNG bộ đồng bộ của nhà ·
 *     tổ chức nhà không đổi một dòng · webhook: token sai ⇒ 401, token của tổ chức chưa bật kết nối ⇒ 409, token của nhà
 *     không có · gói tin đơn xử lý bằng client của chính tổ chức.
 *  3. CÔ LẬP — client của tổ chức A dùng trong ngữ cảnh khác ⇒ NÉM trước khi gửi; getter của nhà vẫn ném cho tổ chức khách.
 *
 * Không gọi mạng thật (luật 65): `fetch` là bản giả, trả lại nguyên trạng trong finally. Khoá là chuỗi BỊA.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { findConnector } from "@/lib/connectors/registry";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { testPancakePosOrg } from "@/lib/connectors/testers";
import { maskPancakeKey, PANCAKE_POS_API } from "@/lib/constants/pancake-pos-org";
import { getPancakeClient, PancakeClient, withPancakeClient } from "@/lib/integrations/pancake/client";
import { processPancakeWebhook, storeWebhook } from "@/lib/integrations/pancake/webhook";
import { getEnabledModules, invalidateCapabilities, orgHasSyncedSource } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { isConnectorUnavailable } from "@/lib/platform/credentials";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { WEBHOOK_BINDINGS, webhookUrlToken } from "@/lib/platform/webhooks";
import { manualOrderOrgGate } from "@/lib/records/order-create";
import { runJob } from "@/lib/sync/jobs";
import { POST as orgWebhookPost } from "@/app/api/webhooks/pancake-org/[token]/[[...event]]/route";

const ORG = "pk-shop";
const KEY = "pkFakeApiKeyForTests0123456789abcdef";
const SHOP = "777001";
const ORDER_ID = "880001";
const ORG_SECRETS_KEY = "khoa-kiem-thu-pancake-pos-org-0123456789abcdefghijklmnopqrstu";

async function cleanupOrg() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

type Seen = { url: string };

/** Pancake POS giả: khoá đúng ⇒ danh sách shop / sản phẩm / một đơn; khoá sai ⇒ `success:false` (có dội lại khoá). */
function fakePancake(seen: Seen[]): typeof fetch {
  const products = JSON.parse(readFileSync("tests/fixtures-pancake-products.json", "utf8")) as { data: unknown[] };
  const orderFixture = JSON.parse(readFileSync("tests/fixtures-pancake-order.json", "utf8")) as { data: Record<string, unknown> };
  const order = { ...orderFixture.data, id: Number(ORDER_ID), system_id: Number(ORDER_ID), inserted_at: new Date().toISOString().slice(0, 19), updated_at: new Date().toISOString().slice(0, 19) };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const list = (data: unknown[]) => json({ success: true, data, page_number: 1, page_size: 100, total_entries: data.length, total_pages: 1 });
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    seen.push({ url: url.href });
    if (url.origin !== new URL(PANCAKE_POS_API).origin) return json({ success: false, message: "sai máy chủ" }, 400);
    const key = url.searchParams.get("api_key") ?? "";
    if (key !== KEY) return json({ success: false, message: `api_key ${key} invalid`, error_code: 101 });
    const path = url.pathname.replace(/^\/api\/v1\//, "");
    if (path === "shops") return json({ success: true, shops: [{ id: Number(SHOP), name: "Shop thời trang thử" }, { id: 2, name: "Shop khác" }] });
    if (!path.startsWith(`shops/${SHOP}/`)) return json({ success: false, message: "không có shop này" });
    const rest = path.slice(`shops/${SHOP}/`.length);
    if (rest === "products") return list(products.data);
    if (rest === "orders") return list([order]);
    if (rest === `orders/${ORDER_ID}`) return json({ success: true, data: order });
    return list([]);
  }) as typeof fetch;
}

function testPure() {
  const spec = findConnector("pancake-pos-org");
  assert.ok(spec, "sổ connector có «pancake-pos-org»");
  assert.equal(spec.tenancy, "PER_ORG");
  assert.equal(spec.module, "orders", "thuộc module Đơn hàng, không phải connector_pancake (credential của nhà)");
  assert.equal(spec.webhook?.tenantResolution, "URL_SECRET");
  assert.equal(spec.webhook?.binding, "PANCAKE_POS_ORG");
  assert.equal(WEBHOOK_BINDINGS.PANCAKE_POS_ORG.mode, "URL_SECRET");
  assert.ok(spec.consumers.length > 0, "khai luồng đọc kết nối lúc chạy");
  assert.equal(maskPancakeKey(`lỗi ở ?api_key=${KEY}&x=1`, KEY), "lỗi ở ?api_key=***&x=1");
  // Nút «Đồng bộ ngay» đi qua job thuộc module Đơn hàng (bảng nút khớp job — pilot-products khoá).
  assert.ok(readFileSync("lib/platform-ui/module-visibility.ts", "utf8").includes('"pancake-org": ["orders"]'));
}

async function testTester() {
  const seen: Seen[] = [];
  const f = fakePancake(seen) as (i: string, init: RequestInit) => Promise<Response>;
  const ok = await testPancakePosOrg({ secrets: { apiKey: KEY }, settings: { shopId: SHOP } }, { fetch: f });
  assert.ok(ok.ok, ok.message);
  assert.match(ok.message, /Shop thời trang thử/);
  assert.ok(seen.every((s) => s.url.startsWith(`${PANCAKE_POS_API}/shops`)), "chỉ hỏi danh sách shop ở pos.pages.fm");
  const sai = await testPancakePosOrg({ secrets: { apiKey: KEY }, settings: { shopId: "999" } }, { fetch: f });
  assert.ok(!sai.ok && /không có shop 999/.test(sai.message) && /777001/.test(sai.message), sai.message);
  const wrongKey = "pkWrongKeyEchoedBack0123456789abcdef";
  const tuChoi = await testPancakePosOrg({ secrets: { apiKey: wrongKey }, settings: { shopId: SHOP } }, { fetch: f });
  assert.ok(!tuChoi.ok && /không nhận khoá/.test(tuChoi.message), tuChoi.message);
  assert.ok(!tuChoi.message.includes(wrongKey) && !ok.message.includes(KEY) && !sai.message.includes(KEY), "khoá không bao giờ nằm trong câu kết quả");
  const truoc = seen.length;
  assert.ok(!(await testPancakePosOrg({ secrets: { apiKey: "ngan" }, settings: { shopId: SHOP } }, { fetch: f })).ok);
  assert.ok(!(await testPancakePosOrg({ secrets: { apiKey: KEY }, settings: { shopId: "abc" } }, { fetch: f })).ok);
  assert.equal(seen.length, truoc, "sai dạng ⇒ 0 request");
}

export async function testPancakePosOrgSync() {
  testPure();
  await testTester();
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Thời trang thử POS", plan: "standard", modules: ["customers", "products", "orders", "inventory"], admin: { email: `admin@${ORG}.local`, name: "QT shop", password: "ThoiTrang@123" }, source: "TEST", actor: null });
  const home = await getHomeOrganization();
  const homeOrders = async () => withOrganization(home.code, async () => Number((await (await getDb()).select({ n: sql<number>`count(*)::int` }).from(schema.orders).where(eq(schema.orders.id, ORDER_ID)))[0].n));
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  const savedFetch = globalThis.fetch;
  const seen: Seen[] = [];
  process.env.PLATFORM_SECRETS_KEY = ORG_SECRETS_KEY;
  globalThis.fetch = fakePancake(seen);
  try {
    // ── Chưa bật ⇒ bỏ qua có lý do, 0 request; cổng tạo tay vẫn mở ──
    const bo = (await runJob("pancake-org", { trigger: "MANUAL", actor: "pk-test", org: ORG })) as { skipped?: string };
    assert.equal(bo.skipped, "NO_ACTIVE_CONNECTION", JSON.stringify(bo));
    assert.equal(seen.length, 0);
    assert.equal(await withOrganization(ORG, () => orgHasSyncedSource("orders")), false, "chưa bật kết nối ⇒ chưa có nguồn đồng bộ");
    const nha = (await runJob("pancake-org", { trigger: "MANUAL", actor: "pk-test", org: home.code })) as { skipped?: string };
    assert.equal(nha.skipped, "HOME_USES_ENV");

    // Webhook: token sai ⇒ 401; token đúng nhưng kết nối chưa bật ⇒ 409, không ghi gói nào.
    const tok = webhookUrlToken("PANCAKE_POS_ORG", ORG);
    assert.ok(tok);
    const post = (token: string, body: unknown) =>
      orgWebhookPost(new Request(`http://erp.test/api/webhooks/pancake-org/${token}/orders`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as never, { params: Promise.resolve({ token, event: ["orders"] }) });
    assert.equal((await post(`${ORG}.chuky-sai`, { id: 1 })).status, 401);
    assert.equal((await post("khong-co-dau-cham", { id: 1 })).status, 401);
    assert.equal((await post(tok, { id: Number(ORDER_ID) })).status, 409, "kết nối chưa bật ⇒ 409");
    await withOrganization(ORG, async () => assert.equal((await (await getDb()).select().from(schema.webhookEvents)).length, 0, "409 ⇒ không ghi gói nào"));

    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin: SessionUser = { id: u.id, email: u.email, name: "QT shop", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Thời trang thử POS", isHome: false }, modules: [...(await getEnabledModules(ORG))] };
      assert.ok("ok" in (await saveConnection(admin, { connectorKey: "pancake-pos-org", settings: { shopId: SHOP }, secrets: { apiKey: KEY } })));
      assert.ok("error" in (await setConnectionStatus(admin, "pancake-pos-org", "ACTIVE")), "chưa kiểm tra ⇒ không bật được");
      const t = await testOrgConnection(admin, "pancake-pos-org", { tester: { fetch: fakePancake(seen) as (i: string, init: RequestInit) => Promise<Response> } });
      assert.ok("ok" in t, JSON.stringify(t));
      assert.ok("ok" in (await setConnectionStatus(admin, "pancake-pos-org", "ACTIVE")));
      // Pancake thành NGUỒN: cổng tạo tay đóng — cùng luật với nhà.
      assert.equal(await orgHasSyncedSource("orders"), true);
      assert.equal(await orgHasSyncedSource("customers"), true);
      const gate = await manualOrderOrgGate();
      assert.ok(!gate.allowed && gate.code === "NOT_SUPPORTED", JSON.stringify(gate));
    });

    // ── Đồng bộ: sản phẩm + đơn vào CSDL của tổ chức ──
    seen.length = 0;
    await runJob("pancake-org", { trigger: "MANUAL", actor: "pk-test", org: ORG });
    assert.ok(seen.length > 0 && seen.every((s) => s.url.startsWith(PANCAKE_POS_API)), "chỉ gọi pos.pages.fm");
    assert.ok(seen.every((s) => new URL(s.url).searchParams.get("api_key") === KEY), "mọi request mang khoá của CHÍNH tổ chức");
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const o = await db.query.orders.findFirst({ where: eq(schema.orders.id, ORDER_ID) });
      assert.ok(o, "đơn Pancake của tổ chức đã vào CSDL của tổ chức");
      assert.ok((await db.select().from(schema.products)).length >= 1, "sản phẩm đã vào");
      const runs = await db.select().from(schema.syncRuns);
      assert.ok(runs.some((r) => r.source === "PANCAKE"), "mỗi lượt có dòng sync_runs trong CSDL của tổ chức");
      assert.ok(!JSON.stringify(runs).includes(KEY), "khoá không nằm trong sync_runs");
      assert.ok(!JSON.stringify(await db.select().from(schema.orgConnections)).includes(KEY), "khoá chỉ ở dạng mã hoá");
    });
    assert.equal(await homeOrders(), 0, "CSDL của nhà không có đơn của tổ chức khách");

    // ── Gói webhook xử lý bằng client của chính tổ chức (ĐÚNG bộ xử lý của nhà) ──
    seen.length = 0;
    await withOrganization(ORG, async () => {
      const stored = await storeWebhook("PANCAKE", "orders", ORDER_ID, { id: Number(ORDER_ID) }, {}, { dedupeKey: `pk-test:${Date.now()}`, occurredAt: new Date() });
      const client = getPancakeClientForTest();
      const outcome = await withPancakeClient(client, () => processPancakeWebhook(stored.id));
      assert.notEqual(outcome.result, "failed", JSON.stringify(outcome));
    });
    assert.ok(seen.some((s) => s.url.includes(`orders/${ORDER_ID}`)), "webhook tải lại đơn qua API bằng khoá của tổ chức");

    // ── Cô lập ──
    const clientA = PancakeClient.fromOrgConnection({ organization: ORG, apiKey: KEY, shopId: SHOP });
    seen.length = 0;
    await withOrganization(home.code, async () => {
      await assert.rejects(clientA.getShops(), (e: unknown) => e instanceof Error && /CREDENTIAL_OWNER_MISMATCH|chủ|owner/i.test(`${(e as { code?: string }).code ?? ""} ${e.message}`), "client của tổ chức khách dùng ở nhà ⇒ NÉM");
    });
    assert.equal(seen.length, 0, "ném TRƯỚC khi một request rời máy");
    await withOrganization(ORG, async () => {
      assert.throws(() => getPancakeClient(), (e: unknown) => isConnectorUnavailable(e), "getter của nhà vẫn ném cho tổ chức khách (không có ghi đè)");
    });
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    await cleanupOrg();
  }
  console.log("  ✓ Pancake POS của tổ chức: PER_ORG thuộc module Đơn hàng; kiểm tra đòi đúng shop, không mang khoá; chưa bật ⇒ bỏ qua 0 request, webhook 401 / 409; bật ⇒ Pancake là nguồn (tạo tay đóng); đồng bộ vào CSDL của tổ chức bằng bộ đồng bộ của nhà, nhà không đổi; client của khách dùng nơi khác ⇒ ném trước khi gửi");
}

function getPancakeClientForTest() {
  return PancakeClient.fromOrgConnection({ organization: ORG, apiKey: KEY, shopId: SHOP });
}

/**
 * «VÀO VIỆC NGAY» trên trang Bắt đầu (lib/onboarding/go-live.ts) — tổ chức THẬT trên PGlite, Pancake GIẢ (luật 65).
 *
 *  · Ô chỉ hiện khi có module «AI bán hàng» và người xem có quyền; người không quyền không kết nối được (lõi chặn).
 *  · Kết nối một nút = Lưu → Kiểm tra → Bật. Kiểm tra HỎNG ⇒ dừng, kết nối KHÔNG bật. Đạt ⇒ ACTIVE + URL webhook.
 *  · Bật bot một nút đi qua đúng `saveSalesChatbotConfig`: AI dùng chung chưa sẵn sàng ⇒ từ chối nói rõ lý do; sẵn sàng
 *    (nền tảng bật + gói có credit) ⇒ bật.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { invalidateAiControl } from "@/lib/ai-usage/control";
import type { SessionUser } from "@/lib/auth/session";
import { loadGoLive, quickConnectFanpage, quickEnableBot } from "@/lib/onboarding/go-live";
import { loadTransportFacts, transportOwnerOf } from "@/lib/sales-chatbot/channel-ownership";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";

const GL_ORG = "gl-shop";
const PAGE = "1122334455";
const TOKEN = "pancake_page_token_gl_0123456789";
const ENV_KEYS = ["PLATFORM_SECRETS_KEY", "PLATFORM_AI_ENABLED", "PLATFORM_AI_API_KEY", "PLATFORM_AI_PROVIDER", "PLATFORM_AI_MODEL"] as const;

function fakePancake(ok: boolean): typeof fetch {
  return (async () => new Response(JSON.stringify(ok ? { success: true, conversations: [] } : { success: false, message: "Token hết hạn" }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
}

async function cleanup() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, GL_ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, GL_ORG));
  rmSync(organizationDatabaseUrl({ code: GL_ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  invalidateOrganizations();
  invalidateCapabilities();
  invalidateAiControl();
}

export async function testGoLive() {
  await cleanup();
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-vao-viec-ngay-0123456789abcdefghijklmnopqrstuvwxyz";
  for (const k of ENV_KEYS.slice(1)) delete process.env[k];
  try {
    await provisionOrganization({ code: GL_ORG, name: "Vào việc ngay", plan: "starter", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${GL_ORG}.local`, name: "QT", password: "VaoViec@12345" }, source: "TEST", actor: null });
    await withOrganization(GL_ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${GL_ORG}.local`) });
      assert.ok(u);
      const modules = [...(await getEnabledModules(GL_ORG))];
      const admin: SessionUser = { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: ["settings:manage", "ai_sales:manage"], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: GL_ORG, name: "Vào việc ngay", isHome: false }, modules };
      const viewer: SessionUser = { ...admin, id: "gl-viewer", role: "VIEWER", permissions: ["dashboard:view"] };

      // Ô hiện cho quản trị, không cho người xem.
      const v0 = await loadGoLive(admin);
      assert.ok(v0.show && v0.canConnect && v0.canBot && v0.fanpage?.status === "NOT_CONFIGURED", JSON.stringify(v0));
      // KHÔNG BẮT BUỘC PANCAKE: chưa nối gì ⇒ chưa có lối (màn hình cho chọn, khuyên nối thẳng Facebook), mốc đầu tiên.
      assert.ok(v0.path === null && v0.stage === "ACCOUNT_CREATED" && !v0.messenger.connected && v0.messagesReceived === 0, JSON.stringify({ path: v0.path, stage: v0.stage }));
      assert.ok(v0.bot.usesPlatformAi && !v0.bot.aiReady && v0.bot.aiReason?.includes("chưa bật AI dùng chung"), "mặc định AI dùng chung; nền tảng chưa bật ⇒ nói rõ");
      assert.equal((await loadGoLive(viewer)).show, false, "không quyền ⇒ không vẽ ô");
      assert.ok("error" in (await quickConnectFanpage(viewer, { pageId: PAGE, pageAccessToken: TOKEN }, { tester: { fetch: fakePancake(true) } })), "không quyền ⇒ lõi chặn");

      // Kiểm tra hỏng ⇒ dừng, không bật.
      assert.ok("error" in (await quickConnectFanpage(admin, { pageId: "", pageAccessToken: TOKEN })), "thiếu Page ID");
      const bad = await quickConnectFanpage(admin, { pageId: PAGE, pageAccessToken: TOKEN }, { tester: { fetch: fakePancake(false) } });
      assert.ok("error" in bad && bad.error.includes("kiểm tra chưa đạt") && bad.error.includes("Token hết hạn"), JSON.stringify(bad));
      assert.notEqual((await loadGoLive(admin)).fanpage?.status, "ACTIVE", "kiểm tra hỏng ⇒ kết nối KHÔNG bật");

      // Đạt ⇒ Lưu → Kiểm tra → Bật trong một lượt, có URL webhook.
      const good = await quickConnectFanpage(admin, { pageId: PAGE, pageAccessToken: TOKEN }, { tester: { fetch: fakePancake(true) } });
      assert.ok("ok" in good, JSON.stringify(good));
      const v1 = await loadGoLive(admin);
      assert.equal(v1.fanpage?.status, "ACTIVE");
      assert.equal(v1.fanpage?.pageId, PAGE);
      assert.ok(v1.fanpage?.webhookUrl?.includes(`/api/webhooks/pancake/fanpage/${GL_ORG}.`), v1.fanpage?.webhookUrl ?? "thiếu URL");
      assert.ok(v1.path === "PANCAKE" && v1.stage === "CHANNEL_CONNECTED", JSON.stringify({ path: v1.path, stage: v1.stage }));
      // Tin khách vào hàng chờ (kể cả khi bot đang tắt) ⇒ «đã nhận tin»; tiếng vọng của bot / tin của page không tính.
      await db.insert(schema.salesChatInbound).values([
        { pageId: PAGE, threadId: "t1", messageId: "gl-m1", text: "Shop ơi" },
        { pageId: PAGE, threadId: "t1", messageId: "gl-m2", text: "Dạ", note: "BOT_SENT" },
      ]);
      const vr = await loadGoLive(admin);
      assert.ok(vr.messagesReceived === 1 && vr.stage === "MESSAGING_READY", JSON.stringify({ n: vr.messagesReceived, stage: vr.stage }));

      // MỘT PAGE — MỘT ĐƯỜNG: Messenger trực tiếp bật cho CÙNG page đang chạy qua Pancake ⇒ Pancake thắng, màn hình nói rõ.
      const oc = schema.orgConnections;
      await db.insert(oc).values({ orgCode: GL_ORG, connectorKey: "facebook-messenger", status: "ACTIVE", settings: { pageId: PAGE, pageName: "Shop GL" }, lastTestOk: true });
      const vd = await loadGoLive(admin);
      assert.ok(vd.path === "PANCAKE" && vd.messenger.connected && vd.messenger.mutedByPancake, JSON.stringify({ path: vd.path, m: vd.messenger }));
      assert.equal(transportOwnerOf(await loadTransportFacts(), PAGE), "PANCAKE");
      // Page đã nối thẳng Facebook ⇒ nút nối nhanh Pancake từ chối page đó, không mở đường thứ hai.
      await db.update(oc).set({ settings: { pageId: "9988776655", pageName: "Page khác" } }).where(eq(oc.connectorKey, "facebook-messenger"));
      const dual = await quickConnectFanpage(admin, { pageId: "9988776655", pageAccessToken: TOKEN }, { tester: { fetch: fakePancake(true) } });
      assert.ok("error" in dual && dual.error.includes("MỘT đường"), JSON.stringify(dual));
      assert.equal((await loadGoLive(admin)).fanpage?.pageId, PAGE, "lượt bị từ chối không đổi kết nối Pancake đang chạy");
      await db.delete(oc).where(eq(oc.connectorKey, "facebook-messenger"));

      // Bật bot: AI dùng chung chưa sẵn sàng ⇒ từ chối; nền tảng bật + gói Khởi đầu có credit ⇒ bật.
      const noAi = await quickEnableBot(admin);
      assert.ok("error" in noAi && noAi.error.includes("Chưa bật được bot"), JSON.stringify(noAi));
      process.env.PLATFORM_AI_ENABLED = "1";
      process.env.PLATFORM_AI_API_KEY = "khoa-ai-nen-tang-gia-gl";
      process.env.PLATFORM_AI_PROVIDER = "gemini";
      const v2 = await loadGoLive(admin);
      assert.ok(v2.bot.aiReady, JSON.stringify(v2.bot));
      const on = await quickEnableBot(admin);
      assert.ok("ok" in on, JSON.stringify(on));
      assert.ok((await loadGoLive(admin)).bot.enabled, "bot đã bật");
      assert.ok("ok" in (await quickEnableBot(admin)), "bấm lại ⇒ vẫn ổn, không đổi gì");
    });
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await cleanup();
  }
  console.log("✓ Vào việc ngay: KHÔNG bắt buộc Pancake — lối suy từ kết nối thật (chưa nối ⇒ cho chọn), mốc onboarding, tin khách đếm cả khi bot tắt; một page một đường (Pancake thắng, nối nhanh Pancake từ chối page đã nối thẳng Facebook); ô chỉ hiện cho người có quyền; kết nối fanpage một nút (Lưu → Kiểm tra → Bật), kiểm tra hỏng ⇒ không bật; có URL webhook; bật bot qua đúng lõi — AI dùng chung chưa sẵn sàng ⇒ từ chối nói rõ, sẵn sàng ⇒ bật");
}

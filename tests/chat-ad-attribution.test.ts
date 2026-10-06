/**
 * QUẢNG CÁO DẪN KHÁCH VÀO HỘI THOẠI ⇒ ĐƠN BOT MANG `orders.ad_id` (0225 · phương án A, chủ shop HSLC chốt 06/10/2026).
 *
 * Phần THUẦN: bộ đọc Pancake (mọi khuôn đã biết: `ad_clicks` chuỗi / object, `ads`, `ad_id` ở hội thoại / tin) và Messenger
 * (`message.referral` · `postback.referral` · `referral` đứng riêng, CHỈ `source = ADS`) · chuỗi rác ⇒ không phải mã · tin page /
 * tiếng vọng KHÔNG mang quảng cáo của khách · cửa sổ quy kết (biên, setting sai ⇒ mặc định).
 *
 * Phần TỔ CHỨC THẬT `chat-ad-attr`: hội thoại có QC trong cửa sổ ⇒ đơn bot (công cụ `create_draft_order`) mang `ad_id` và hiện
 * ở dòng chiến dịch của bảng /ads qua `ORDER_CAMPAIGN_ID` · ngoài cửa sổ ⇒ NULL (setting nới cửa sổ ⇒ có) · không có QC ⇒ NULL ·
 * QC mới hơn thay QC cũ, gói tin cũ tới muộn KHÔNG đè · sửa đơn KHÔNG đổi `ad_id`.
 *
 * Mốc đi theo ĐỒNG HỒ THẬT (AGENTS.md mục 50): mọi mốc của phần tổ chức thật dựng từ `new Date()` lúc chạy.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { resolvePermissions } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { clearMemo } from "@/lib/cache";
import { CHAT_AD_ATTRIBUTION_DEFAULT_WINDOW_DAYS, CHAT_AD_ATTRIBUTION_SETTING_KEY, chatAdForOrder, parseChatAttributionWindowDays } from "@/lib/constants/chat-ad-attribution";
import { parseMessengerWebhook } from "@/lib/integrations/messenger/graph";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { ORDER_CAMPAIGN_ID } from "@/lib/queries/ads-attribution-link";
import { getAdsDecision } from "@/lib/queries/ads-decision";
import { createProductCore } from "@/lib/records/product-create";
import { chatOrderAdId, recordConversationAd } from "@/lib/sales-chatbot/ad-referral";
import { adReferralFromMessenger, adReferralFromPancake } from "@/lib/sales-chatbot/ad-referral-shared";
import { DEFAULT_SALES_CHATBOT_CONFIG } from "@/lib/sales-chatbot/config";
import { conversationFor, parsePancakeWebhook } from "@/lib/sales-chatbot/fanpage";
import { executeTool, type ChatState, type ToolContext } from "@/lib/sales-chatbot/tools";
import { resolvePeriod } from "@/lib/search-params";
import { setSettingJson } from "@/lib/settings";

const ORG = "chat-ad-attr";
const ADMIN_EMAIL = "chu@chat-ad-attr.local";
const PAGE = "5550001112";

// ─────────────────────────── 1 · THUẦN ───────────────────────────

function pancake(conversation: Record<string, unknown>, message: Record<string, unknown> = {}) {
  return { event_type: "messaging", page_id: PAGE, data: { conversation: { id: `${PAGE}_9001`, type: "INBOX", ...conversation }, message: { id: "m-1", message: "Chả cá bao nhiêu ạ", from: { id: "khach-1", name: "Lan" }, ...message } } };
}

function testPure() {
  // Pancake — `ad_clicks` mảng CHUỖI, không mốc ⇒ phần tử cuối.
  assert.deepEqual(adReferralFromPancake(pancake({ ad_clicks: ["120200000000001", "120200000000002"] })), { adId: "120200000000002", clickedAt: null, source: "PANCAKE" });
  // `ad_clicks` mảng OBJECT có mốc ⇒ mốc MỚI NHẤT thắng, kể cả khi đứng trước; ISO không múi giờ là UTC.
  const clicks = adReferralFromPancake(pancake({ ad_clicks: [{ ad_id: "120200000000003", inserted_at: "2026-10-05T09:00:00" }, { id: "120200000000004", inserted_at: "2026-10-04T09:00:00" }] }));
  assert.equal(clicks?.adId, "120200000000003", "mốc mới nhất thắng, không phải phần tử cuối");
  assert.equal(clicks?.clickedAt?.toISOString(), "2026-10-05T09:00:00.000Z", "ISO không múi giờ của Pancake là UTC");
  // `ads` mảng object (ad_id + time dạng số giây).
  const ads = adReferralFromPancake(pancake({ ads: [{ ad_id: "120200000000005", time: 1_791_000_000 }, { ad_id: "120200000000006", time: 1_791_000_100 }] }));
  assert.equal(ads?.adId, "120200000000006");
  assert.equal(ads?.clickedAt?.getTime(), 1_791_000_100_000, "mốc dạng giây ⇒ mili giây");
  // `ad_id` đơn lẻ ở hội thoại, rồi ở tin.
  assert.equal(adReferralFromPancake(pancake({ ad_id: "120200000000007" }))?.adId, "120200000000007");
  assert.equal(adReferralFromPancake(pancake({}, { ad_id: 120200000000008 }))?.adId, "120200000000008", "mã dạng số vẫn đọc được");
  // Chuỗi rác ⇒ không phải mã quảng cáo Meta.
  assert.equal(adReferralFromPancake(pancake({ ad_clicks: ["abc", "12", { ad_id: "x-1" }], ad_id: "camp_hslc" })), null, "chuỗi lạ / quá ngắn không phải mã");
  assert.equal(adReferralFromPancake(pancake({})), null, "không có trường quảng cáo ⇒ null, không phải mã rỗng");
  assert.equal(adReferralFromPancake({ ...pancake({ ad_id: "120200000000009" }), event_type: "comment" }), null, "chỉ đọc gói messaging");
  // Tin PHÍA PAGE (page / nhân viên có admin_id / uid) KHÔNG mang quảng cáo của khách.
  assert.equal(adReferralFromPancake(pancake({ ad_id: "120200000000010" }, { from: { id: PAGE } })), null, "tin của page");
  assert.equal(adReferralFromPancake(pancake({ ad_id: "120200000000010" }, { from: { id: "nv-1", admin_id: "a-1" } })), null, "tin nhân viên");
  // parsePancakeWebhook mang mã cho tin khách, không mang cho tin page.
  assert.equal(parsePancakeWebhook(pancake({ ad_id: "120200000000011" }))?.adReferral?.adId, "120200000000011");
  const pageEv = parsePancakeWebhook(pancake({ ad_id: "120200000000011" }, { from: { id: PAGE }, message: "Dạ shop chào chị" }));
  assert.equal(pageEv?.fromPage, true);
  assert.equal(pageEv?.adReferral ?? null, null, "tin page không mang mã quảng cáo");

  // Messenger — ba chỗ đặt referral, chỉ `source = ADS`.
  const ts = 1_791_000_000_000;
  const base = { sender: { id: "6000000000001" }, recipient: { id: PAGE }, timestamp: ts };
  assert.deepEqual(adReferralFromMessenger({ ...base, message: { mid: "m.1", text: "Giá sao ạ", referral: { source: "ADS", type: "OPEN_THREAD", ad_id: "120200000000020" } } }), { adId: "120200000000020", clickedAt: new Date(ts), source: "MESSENGER" });
  assert.equal(adReferralFromMessenger({ ...base, postback: { title: "Bắt đầu", referral: { source: "ADS", ad_id: "120200000000021" } } })?.adId, "120200000000021");
  assert.equal(adReferralFromMessenger({ ...base, referral: { source: "ADS", type: "OPEN_THREAD", ad_id: "120200000000022" } })?.adId, "120200000000022");
  assert.equal(adReferralFromMessenger({ ...base, referral: { source: "SHORTLINK", ref: "x", ad_id: "120200000000023" } }), null, "không phải quảng cáo");
  assert.equal(adReferralFromMessenger({ ...base, referral: { source: "ADS", ad_id: "khong-phai-ma" } }), null, "mã rác");
  assert.equal(adReferralFromMessenger({ ...base, message: { mid: "m.2", text: "x", is_echo: true, referral: { source: "ADS", ad_id: "120200000000024" } } }), null, "tiếng vọng");
  // parseMessengerWebhook: tin mang referral ⇒ adReferral; referral đứng riêng ⇒ sự kiện CHỈ quảng cáo; tiếng vọng ⇒ không.
  const evs = parseMessengerWebhook({
    object: "page",
    entry: [
      {
        id: PAGE,
        messaging: [
          { ...base, message: { mid: "m.10", text: "Giá sao ạ", referral: { source: "ADS", ad_id: "120200000000030" } } },
          { ...base, timestamp: ts + 1, referral: { source: "ADS", type: "OPEN_THREAD", ad_id: "120200000000031" } },
          { sender: { id: PAGE }, recipient: { id: "6000000000001" }, timestamp: ts + 2, message: { mid: "m.11", text: "Dạ", is_echo: true, referral: { source: "ADS", ad_id: "120200000000032" } } },
          { ...base, timestamp: ts + 3, message: { mid: "m.12", sticker_id: 369239263222822, referral: { source: "ADS", ad_id: "120200000000033" } } },
        ],
      },
    ],
  });
  assert.equal(evs.find((e) => e.mid === "m.10")?.adReferral?.adId, "120200000000030");
  assert.equal(evs.find((e) => e.mid === "m.10")?.referralOnly ?? false, false, "tin có chữ vẫn là tin cho bot");
  const only = evs.filter((e) => e.referralOnly);
  assert.deepEqual(
    only.map((e) => e.adReferral?.adId),
    ["120200000000031", "120200000000033"],
    "referral đứng riêng + tin không chữ kèm referral ⇒ bản ghi quảng cáo, không thành tin nhắn",
  );
  assert.ok(only.every((e) => e.text === "" && !e.isEcho));
  assert.equal(evs.find((e) => e.mid === "m.11")?.adReferral ?? null, null, "tiếng vọng không mang quảng cáo");

  // Cửa sổ quy kết: biên đóng ở cả hai đầu, mốc SAU đơn ⇒ không, setting sai ⇒ mặc định.
  const order = new Date("2026-10-06T10:00:00Z");
  const days = CHAT_AD_ATTRIBUTION_DEFAULT_WINDOW_DAYS;
  const seen = (ms: number) => ({ adId: "120200000000040", adSeenAt: new Date(order.getTime() - ms) });
  assert.equal(chatAdForOrder(seen(days * 86_400_000), order, days), "120200000000040", "đúng biên cửa sổ vẫn tính");
  assert.equal(chatAdForOrder(seen(days * 86_400_000 + 1), order, days), null, "quá cửa sổ một mili giây ⇒ không");
  assert.equal(chatAdForOrder(seen(-1), order, days), null, "lượt bấm SAU mốc tạo đơn ⇒ không");
  assert.equal(chatAdForOrder({ adId: null, adSeenAt: order }, order, days), null);
  assert.equal(parseChatAttributionWindowDays(null), days);
  assert.equal(parseChatAttributionWindowDays("abc"), days);
  assert.equal(parseChatAttributionWindowDays(0), days);
  assert.equal(parseChatAttributionWindowDays(2.5), days);
  assert.equal(parseChatAttributionWindowDays(28), 28);
  assert.equal(parseChatAttributionWindowDays("14"), 14);
}

// ─────────────────────────── 2 · TỔ CHỨC THẬT ───────────────────────────

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

async function adminOf(): Promise<SessionUser> {
  const db = await getDb();
  const u = await db.query.users.findFirst({ where: eq(schema.users.email, ADMIN_EMAIL) });
  assert.ok(u);
  const org = await findOrganization(ORG);
  return { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: resolvePermissions("ADMIN", null), scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: org?.name ?? ORG, isHome: false }, modules: [...(await getEnabledModules(ORG))] };
}

async function testRealOrg() {
  await withOrganization(ORG, async () => {
    const db = await getDb();
    const admin = await adminOf();
    const p = await createProductCore(admin, { name: "Chả cá thu", code: "CA-THU", unit: "kg", retailPrice: 300_000, cost: null, variants: [{ sku: "CA-THU", size: "", color: "", retailPrice: 300_000, cost: null, selling: true }] });
    assert.ok(p.ok, JSON.stringify(p));
    const v = await db.query.productVariants.findFirst({ where: eq(schema.productVariants.productId, p.id) });
    assert.ok(v);
    await db.insert(schema.fbAds).values({ id: "120200000000102", name: "Mẩu chả cá", campaignId: "cad-camp-1", campaignName: "CHẢ CÁ - test chiến dịch", fetchedAt: new Date() }).onConflictDoNothing();

    const now = new Date();
    const ago = (h: number) => new Date(now.getTime() - h * 3_600_000);
    const agent = { name: "Bot bán hàng (thử)", source: "tests/chat-ad-attribution.test.ts" };
    const botOrder = async (threadId: string, phone: string): Promise<{ orderId: string; state: ChatState; convId: string }> => {
      const conv = await conversationFor(PAGE, threadId);
      assert.ok(conv);
      const ctx: ToolContext = { conversationId: conv.id, channel: "FANPAGE", config: { ...DEFAULT_SALES_CHATBOT_CONFIG }, state: {}, lastUserText: "", agent, now: new Date() };
      const c1 = await executeTool("create_customer", { name: "Nguyễn Thị Lan", phone, address: "12 Hàng Bạc, Hoàn Kiếm, Hà Nội" }, ctx);
      assert.ok(!c1.isError, c1.content);
      const c2 = await executeTool("create_draft_order", { items: [{ variant_id: v.id, quantity: 1 }] }, { ...ctx, state: c1.state });
      assert.ok(!c2.isError, c2.content);
      const orderId = c2.state.draft?.orderId;
      assert.ok(orderId, "đơn bot thật phải có mã đơn");
      return { orderId, state: c2.state, convId: conv.id };
    };
    const adOf = async (id: string) => (await db.select({ adId: schema.orders.adId }).from(schema.orders).where(eq(schema.orders.id, id)).limit(1))[0]?.adId ?? null;

    // ── QC mới hơn thay QC cũ; gói tin CŨ tới muộn không đè ──
    const t1 = await conversationFor(PAGE, `${PAGE}_t1`);
    assert.ok(t1);
    assert.equal(await recordConversationAd(t1.id, { adId: "120200000000101", clickedAt: ago(30), source: "PANCAKE" }, now), true);
    assert.equal(await recordConversationAd(t1.id, { adId: "120200000000101", clickedAt: null, source: "PANCAKE" }, now), false, "cùng mã, gói KHÔNG có mốc bấm (danh sách cộng dồn) ⇒ không làm mới mốc");
    assert.equal(await recordConversationAd(t1.id, { adId: "120200000000101", clickedAt: ago(31), source: "PANCAKE" }, now), false, "cùng mã, mốc bấm CŨ hơn ⇒ không ghi");
    assert.equal(await recordConversationAd(t1.id, { adId: "120200000000101", clickedAt: ago(29), source: "PANCAKE" }, now), true, "cùng mã, khách BẤM LẠI (mốc bấm thật mới hơn) ⇒ làm mới mốc");
    assert.equal(await recordConversationAd(t1.id, { adId: "120200000000102", clickedAt: ago(2), source: "MESSENGER" }, now), true, "mã MỚI hơn thay mã cũ");
    assert.equal(await recordConversationAd(t1.id, { adId: "120200000000103", clickedAt: ago(72), source: "PANCAKE" }, now), false, "gói tin cũ tới muộn không đè mã mới");
    const [saved] = await db.select({ adId: schema.salesChatConversations.adId, src: schema.salesChatConversations.adSource }).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, t1.id));
    assert.deepEqual(saved, { adId: "120200000000102", src: "MESSENGER" });

    // ── Trong cửa sổ ⇒ đơn bot mang ad_id, và hiện ở dòng chiến dịch của bảng /ads ──
    const inWin = await botOrder(`${PAGE}_t1`, "0911000001");
    assert.equal(await adOf(inWin.orderId), "120200000000102", "đơn bot mang mã quảng cáo của hội thoại");
    const [camp] = await db.select({ campaign: ORDER_CAMPAIGN_ID }).from(schema.orders).where(eq(schema.orders.id, inWin.orderId));
    assert.equal(camp?.campaign, "cad-camp-1", "ORDER_CAMPAIGN_ID nối đơn bot về chiến dịch qua sổ mẩu");
    // Bảng chỉ đếm đơn đã xác nhận — đưa đơn lên «Đã xác nhận» như nhân viên làm, rồi đọc bảng chiến dịch.
    await db.update(schema.orders).set({ stage: "CONFIRMED" }).where(eq(schema.orders.id, inWin.orderId));
    clearMemo();
    const decision = await getAdsDecision(resolvePeriod({}, "month"), "campaign");
    const row = decision.rows.find((r) => r.key === "cad-camp-1");
    assert.equal(row?.bookedOrders, 1, "đơn bot hiện ở dòng chiến dịch, không còn «0 đơn chốt»");
    assert.equal(decision.confidence.erpOrdersWithAd, 1, "độ phủ mã quảng cáo từ hội thoại đếm được đơn ERP mang mã");
    assert.equal(decision.confidence.erpRecordedNoTraceOrders, 0, "đơn ERP đã mang mã không còn ở nhóm «không dấu vết»");

    // ── Sửa đơn KHÔNG đổi ad_id, kể cả khi hội thoại đã có mã mới hơn ──
    await recordConversationAd(inWin.convId, { adId: "120200000000104", clickedAt: ago(1), source: "PANCAKE" }, now);
    const upd = await executeTool("update_draft_order", { items: [{ variant_id: v.id, quantity: 2 }] }, { conversationId: inWin.convId, channel: "FANPAGE", config: { ...DEFAULT_SALES_CHATBOT_CONFIG }, state: inWin.state, lastUserText: "", agent, now: new Date() });
    assert.ok(!upd.isError, upd.content);
    assert.equal(await adOf(inWin.orderId), "120200000000102", "lượt sửa đơn không đọc lại quảng cáo");

    // ── Ngoài cửa sổ ⇒ NULL; nới cửa sổ bằng setting ⇒ có ──
    const t2 = await conversationFor(PAGE, `${PAGE}_t2`);
    assert.ok(t2);
    await recordConversationAd(t2.id, { adId: "120200000000105", clickedAt: ago(CHAT_AD_ATTRIBUTION_DEFAULT_WINDOW_DAYS * 24 + 1), source: "PANCAKE" }, now);
    const outWin = await botOrder(`${PAGE}_t2`, "0911000002");
    assert.equal(await adOf(outWin.orderId), null, "lượt bấm ngoài cửa sổ ⇒ đơn không mang mã");
    await setSettingJson(CHAT_AD_ATTRIBUTION_SETTING_KEY, CHAT_AD_ATTRIBUTION_DEFAULT_WINDOW_DAYS + 1);
    assert.equal(await chatOrderAdId(t2.id, new Date()), "120200000000105", "chủ shop nới cửa sổ ⇒ lượt bấm ấy vào cửa sổ");
    await setSettingJson(CHAT_AD_ATTRIBUTION_SETTING_KEY, null);

    // ── Hội thoại không có QC ⇒ NULL ──
    const none = await botOrder(`${PAGE}_t3`, "0911000003");
    assert.equal(await adOf(none.orderId), null, "không có quảng cáo ⇒ NULL, không đoán");
  });
  console.log("✓ Quảng cáo dẫn khách vào hội thoại: Pancake (ad_clicks / ads / ad_id) + Messenger (referral ADS, cả sự kiện đứng riêng) · rác & tin page ⇒ không · mã mới thay mã cũ, gói cũ không đè · đơn bot trong cửa sổ mang ad_id và hiện ở dòng chiến dịch qua ORDER_CAMPAIGN_ID · ngoài cửa sổ / không QC ⇒ NULL · sửa đơn không đổi ad_id");
}

export async function testChatAdAttribution() {
  testPure();
  await cleanupOrg(ORG);
  await provisionOrganization({ code: ORG, name: "Shop quảng cáo hội thoại", plan: "trial", modules: ["customers", "products", "orders", "inventory", "ai_sales", "marketing"], admin: { email: ADMIN_EMAIL, name: "Chủ shop", password: "QuangCao@2026!" }, source: "TEST", actor: null });
  try {
    await testRealOrg();
  } finally {
    await cleanupOrg(ORG);
  }
}

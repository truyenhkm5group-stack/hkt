import { can, type SessionUser } from "@/lib/auth/session";
import { CONNECTIONS_PERMISSION, saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import type { TesterDeps } from "@/lib/connectors/testers";
import { canUseModule } from "@/lib/platform/capabilities";
import { loadSalesChatbotConfig, readJsonSetting } from "@/lib/sales-chatbot/engine";
import { FANPAGE_CONNECTOR, fanpageSetupView, PAGE_REPLY, type FanpageSetupView } from "@/lib/sales-chatbot/fanpage";
import { SALES_CHATBOT_MANAGE, saveSalesChatbotConfig } from "@/lib/sales-chatbot/settings";
import { and, count, eq, inArray, ne, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { anyChannelConnected, firstValueSteps, firstValueSummary, goLivePathOf, onboardingStage, type ChannelFacts, type FirstValueFacts, type FirstValueStep, type FirstValueSummary, type GoLivePath, type OnboardingStage } from "@/lib/onboarding/go-live-shared";
import { PUBLISH_PERMISSION, publicationOf, type Publication } from "@/lib/platform/publish";
import { loadChannelsOverview } from "@/lib/channels/overview";
import { aiControlOf, channelHealth } from "@/lib/channels/overview-shared";
import { directConnectFor } from "@/lib/channels/direct-connect";
import { availableStockExpr, stockKnownExpr, variantReceiptsSubquery, variantSalesSubquery } from "@/lib/queries/stock";
import { productCreateGate } from "@/lib/records/product-create";
import { SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { messengerView, type MessengerView } from "@/lib/sales-chatbot/messenger";
import { zaloSetupView, type ZaloSetupView } from "@/lib/sales-chatbot/zalo";
import { loadTransportFacts, transportOwnerOf } from "@/lib/sales-chatbot/channel-ownership";
import { CUSTOMER_AI_STATE_HINT } from "@/lib/saas/visibility";
import { loadChatbotAiView } from "@/lib/saas/visibility-loaders";

/**
 * ═══════════ «VÀO VIỆC NGAY» — KẾT NỐI FANPAGE + BẬT CHATBOT TỪ TRANG BẮT ĐẦU (docs/platform/quick-start.md §6) ═══════════
 *
 * Trước: Cài đặt → Kết nối → «Fanpage qua Pancake» → nhập → Lưu → Kiểm tra → Bật → sang trang Chatbot chép URL webhook →
 * chọn khoá AI → Bật bot. Sau: MỘT ô trên trang «Bắt đầu» — dán Page ID + token, MỘT nút làm cả Lưu → Kiểm tra → Bật, hiện
 * URL webhook kèm nút chép; rồi MỘT nút bật bot.
 *
 * Không có đường thứ hai: mọi bước gọi ĐÚNG lõi đang có (`saveConnection` · `testOrgConnection` · `setConnectionStatus` ·
 * `saveSalesChatbotConfig`) — quyền, mã hoá bí mật, nhật ký, kiểm khoá AI trước khi bật đều nằm ở đó. Kiểm tra hỏng ⇒ DỪNG,
 * không bật kết nối (kết nối giữ nháp, câu lỗi của bộ kiểm trả nguyên cho người bấm).
 *
 * Bước dán URL webhook vào Pancake vẫn là việc tay: chưa có API công khai đã kiểm nào của Pancake để ERP tự đăng ký webhook.
 *
 * KHÔNG BẮT BUỘC PANCAKE (05/10/2026, lệnh chủ shop): ô này không còn mở đầu bằng Pancake. Shop chọn cách quản lý tin nhắn —
 * nối thẳng Facebook (khuyên dùng: đăng nhập Facebook → chọn page, không webhook) · đang dùng Pancake · phần mềm khác — và
 * chỉ thấy bước của lối mình chọn (`go-live-shared.ts`). Lối đang dùng suy từ kết nối thật, không lưu lựa chọn.
 */

export type GoLiveView = {
  /** Có module «AI bán hàng» VÀ người xem có quyền làm ít nhất một trong hai việc — không ⇒ không vẽ ô. */
  show: boolean;
  canConnect: boolean;
  canBot: boolean;
  /** Lối shop đang dùng, SUY RA từ kết nối thật (`goLivePathOf`); `null` = chưa nối gì ⇒ màn hình cho chọn, khuyên nối thẳng. */
  path: GoLivePath | null;
  fanpage: FanpageSetupView | null;
  /** Nối thẳng Facebook (Messenger + Instagram) — `appReady = false` khi nền tảng chưa cấu hình app Facebook. */
  messenger: { appReady: boolean; connected: boolean; pageName: string | null; /** Số Facebook page đang nối thẳng (không tính Instagram). */ pageCount: number; mutedByPancake: boolean };
  zalo: { connected: boolean };
  /** Ô chat trên website đã xuất bản. */
  webChat: boolean;
  /** Tin khách THẬT đã nhận qua mọi kênh (hàng chờ nhận tin + chat web; tiếng vọng của bot / tin của page không tính) — bước «nhận tin đầu tiên» xong khi > 0. */
  messagesReceived: number;
  stage: OnboardingStage;
  /**
   * Ô chỉ dựng cho workspace KHÁCH (nhà ⇒ `off`), nên phần AI nói bằng trạng thái của khách (lib/saas/visibility.ts): sẵn sàng hay
   * chưa + MỘT câu khách — không nguồn AI (dùng chung / khoá riêng), không câu gốc của nền tảng (tên biến, USD, tên khoá).
   */
  bot: { enabled: boolean; aiReady: boolean; aiReason: string | null };
};

/**
 * Kênh nào của cửa hàng đang NỐI — MỘT định nghĩa cho ô «Vào việc ngay», bước onboarding «đã nối kênh» (`onboardingStage`) và
 * trạng thái rỗng «chưa nối kênh» của hộp thư: Fanpage qua Pancake đang bật · Facebook nối thẳng có page · Zalo OA đang bật ·
 * ô chat web đã xuất bản. Hai màn hình hỏi cùng một câu thì đọc cùng một hàm, không mỗi nơi một danh sách kênh.
 */
export function channelFactsOf(v: { fanpage: Pick<FanpageSetupView, "status">; messenger: Pick<MessengerView, "status" | "page">; zalo: Pick<ZaloSetupView, "status">; pub: Pick<Publication, "state"> }): ChannelFacts {
  return { pancake: v.fanpage.status === "ACTIVE", messenger: v.messenger.status === "ACTIVE" && v.messenger.page !== null, zalo: v.zalo.status === "ACTIVE", webChat: v.pub.state === "PUBLISHED" };
}

/**
 * Đọc `channelFactsOf` cho tổ chức NGỮ CẢNH (mã tổ chức của phiên). Chỉ đọc, và chỉ trả BỐN CỜ: URL nhận tin mang mã của hai
 * view Pancake / Zalo không rời hàm này — người gọi (vd hộp thư của nhân viên chỉ có `ai_sales:view`) không bao giờ cầm được nó.
 */
export async function loadChannelFacts(orgCode: string): Promise<ChannelFacts> {
  const [fanpage, messenger, zalo, pub] = await Promise.all([fanpageSetupView(orgCode), messengerView(), zaloSetupView(orgCode), publicationOf(orgCode)]);
  return channelFactsOf({ fanpage, messenger, zalo, pub });
}

export async function loadGoLive(user: SessionUser): Promise<GoLiveView> {
  const orgCode = user.organization?.code ?? null;
  const canConnect = can(user, CONNECTIONS_PERMISSION);
  const canBot = can(user, SALES_CHATBOT_MANAGE);
  const off: GoLiveView = {
    show: false,
    canConnect,
    canBot,
    path: null,
    fanpage: null,
    messenger: { appReady: false, connected: false, pageName: null, pageCount: 0, mutedByPancake: false },
    zalo: { connected: false },
    webChat: false,
    messagesReceived: 0,
    stage: "ACCOUNT_CREATED",
    bot: { enabled: false, aiReady: false, aiReason: null },
  };
  if (!orgCode || user.organization?.isHome || !(canConnect || canBot) || !(await canUseModule("ai_sales"))) return off;
  const [fanpage, cfg, messenger, zalo, pub] = await Promise.all([fanpageSetupView(orgCode), loadSalesChatbotConfig(), messengerView(), zaloSetupView(orgCode), publicationOf(orgCode)]);
  // CÙNG loader với trang Chatbot (lib/saas/visibility-loaders.ts): nguồn AI dùng chung lẫn khoá riêng đều đọc thật (trước đây
  // khoá riêng luôn coi là sẵn sàng), và «hết lượt» tách khỏi «cần cấu hình» bằng đúng một luật.
  const ai = await loadChatbotAiView(user, cfg, { manage: false });
  const aiReady = ai.aiReady;
  const aiReason = aiReady ? null : ai.audience === "CUSTOMER" ? CUSTOMER_AI_STATE_HINT[ai.aiState] : CUSTOMER_AI_STATE_HINT.NEEDS_SETUP;
  const db = await getDb();
  const e = schema.salesConversationEvents;
  const v = schema.productVariants;
  // Tin khách đã nhận: hàng chờ của MỌI kênh nhắn (Pancake · Messenger · Instagram · Zalo — có cả khi bot đang tắt) + chat web
  // (không qua hàng chờ, đọc ở sổ sự kiện). Tiếng vọng của bot / tin của page không phải tin khách.
  const t = schema.salesChatInbound;
  const [[inbound], [web], [priced], [drafts]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(t).where(sql`coalesce(${t.note}, '') not in ('BOT_SENT', ${PAGE_REPLY})`),
    db.select({ n: sql<number>`count(*)::int` }).from(e).where(and(eq(e.channel, "WEB"), eq(e.type, "message.received"))),
    db.select({ n: sql<number>`count(*)::int` }).from(v).where(and(eq(v.isRemoved, false), sql`${v.retailPrice} > 0`)),
    db.select({ n: sql<number>`count(*)::int` }).from(e).where(and(eq(e.channel, "TEST"), eq(e.type, "order.drafted"))),
  ]);
  const channels = channelFactsOf({ fanpage, messenger, zalo, pub });
  const messagesReceived = Number(inbound?.n ?? 0) + Number(web?.n ?? 0);
  const { stage } = onboardingStage({ ...channels, messagesReceived, pricedVariants: Number(priced?.n ?? 0), aiReady, testDrafts: Number(drafts?.n ?? 0), botEnabled: cfg.enabled });
  return {
    show: true,
    canConnect,
    canBot,
    path: goLivePathOf(channels),
    fanpage,
    messenger: { appReady: messenger.appReady, connected: channels.messenger, pageName: messenger.page?.name ?? null, pageCount: messenger.pages.filter((p) => p.status === "ACTIVE" && p.kind === "PAGE").length, mutedByPancake: messenger.mutedByPancake },
    zalo: { connected: channels.zalo },
    webChat: channels.webChat,
    messagesReceived,
    stage,
    bot: { enabled: cfg.enabled, aiReady, aiReason },
  };
}

/** Lưu → Kiểm tra → Bật kết nối «Fanpage qua Pancake» trong MỘT lượt bấm. */
export async function quickConnectFanpage(user: SessionUser, raw: { pageId?: unknown; pageAccessToken?: unknown }, deps: { tester?: TesterDeps } = {}): Promise<{ ok: true; message: string } | { error: string }> {
  if (!(await canUseModule("ai_sales"))) return { error: "Module AI bán hàng chưa bật — bật ở Cài đặt → Module." };
  const pageId = typeof raw.pageId === "string" ? raw.pageId.trim() : "";
  const token = typeof raw.pageAccessToken === "string" ? raw.pageAccessToken.trim() : "";
  if (!pageId || !token) return { error: "Nhập Page ID và page access token (Pancake → Cài đặt page → Công cụ)." };
  // MỘT PAGE — MỘT ĐƯỜNG (channel-ownership.ts): page đã nối thẳng Facebook ⇒ không nối thêm qua Pancake.
  if (transportOwnerOf(await loadTransportFacts(), pageId) === "MESSENGER") return { error: "Page này đang nối thẳng với Facebook (Messenger trực tiếp). Mỗi page chỉ nhận tin qua MỘT đường — gỡ Messenger trực tiếp trước nếu muốn chuyển sang Pancake." };
  const saved = await saveConnection(user, { connectorKey: FANPAGE_CONNECTOR, settings: { pageId }, secrets: { pageAccessToken: token } });
  if ("error" in saved) return saved;
  const tested = await testOrgConnection(user, FANPAGE_CONNECTOR, deps.tester ? { tester: deps.tester } : {});
  if ("error" in tested) return { error: `Đã lưu nhưng kiểm tra chưa đạt: ${tested.error}` };
  const on = await setConnectionStatus(user, FANPAGE_CONNECTOR, "ACTIVE");
  if ("error" in on) return on;
  return { ok: true, message: "Đã kết nối fanpage. Bước cuối: dán URL webhook bên dưới vào Pancake." };
}

/** Bật chatbot với cấu hình hiện tại (mặc định AI dùng chung) — lõi kiểm khoá AI trước khi bật. */
export async function quickEnableBot(user: SessionUser): Promise<{ ok: true; message: string } | { error: string }> {
  const cfg = await loadSalesChatbotConfig();
  if (cfg.enabled) return { ok: true, message: "Chatbot đang bật." };
  const r = await saveSalesChatbotConfig(user, { ...cfg, enabled: true });
  return r.ok ? { ok: true, message: r.message } : { error: r.error };
}

// ─────────────────────────── «GIÁ TRỊ ĐẦU TIÊN» — CHÍN BƯỚC CỦA VỎ CHỐT ĐƠN (luật ở go-live-shared.ts) ───────────────────────────

export type FirstValueView = { show: boolean; steps: FirstValueStep[] } & FirstValueSummary;

const iso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const issueText = (i: { title: string; action: string } | null): string | null => (i ? `${i.title.replace(/[.\s]+$/, "")}. ${i.action}` : null);

/**
 * Gom SỰ THẬT cho chín bước từ đúng các hàm đang có — CHỈ ĐỌC, không ghi gì:
 *  · kênh đã nối = `loadChannelFacts` (cùng định nghĩa với hộp thư rỗng và mốc onboarding);
 *  · Page = `loadChannelsOverview` + `channelHealth` / `aiControlOf` của màn Kênh kết nối (câu lỗi là câu khách của màn đó);
 *  · AI = `loadChatbotAiView` (cùng loader với trang AI Sales và ô «Vào việc ngay»);
 *  · tồn khả dụng = công thức sổ kho (`stockKnownExpr` / `availableStockExpr` — cùng công thức bot dùng khi kiểm tồn);
 *  · nhắn thử / AI trả lời thử / đơn thử = sổ sự kiện hội thoại, kênh Khung thử (cùng sổ mà bảng «AI đã sẵn sàng» đọc);
 *  · đơn thật tạo trong ứng dụng = nhật ký `ORDER_MANUAL_CREATE` (đường tạo đơn tay / bot duy nhất ghi nó).
 * Không hiện cho tổ chức nhà, khi chức năng AI bán hàng tắt, hoặc khi người xem không nối kênh được lẫn không cấu hình bot được.
 */
export async function loadFirstValue(user: SessionUser, now: Date = new Date()): Promise<FirstValueView> {
  const hidden: FirstValueView = { show: false, steps: [], done: 0, total: 0, allDone: false, next: null };
  const orgCode = user.organization?.code ?? null;
  const canConnect = can(user, CONNECTIONS_PERMISSION);
  const canBot = can(user, SALES_CHATBOT_MANAGE);
  if (!orgCode || user.organization?.isHome || !(canConnect || canBot) || !(await canUseModule("ai_sales"))) return hidden;
  const on = (m: string) => !user.modules || user.modules.includes(m);

  const db = await getDb();
  const v = schema.productVariants;
  const e = schema.salesConversationEvents;
  const priced = and(eq(v.isRemoved, false), sql`${v.retailPrice} > 0`);
  const sales = variantSalesSubquery(db);
  const receipts = variantReceiptsSubquery(db);
  const known = stockKnownExpr(receipts);
  const ORDER_EVENTS = ["order.drafted", "order.confirmed"];

  const [channels, overview, cfg, rawCfg, pub, directConnect, productGate, productRows, pricedRows, stockRows, testRows, realBotRows, manualRows] = await Promise.all([
    loadChannelFacts(orgCode),
    loadChannelsOverview({ operator: false }, now),
    loadSalesChatbotConfig(),
    readJsonSetting(SALES_CHATBOT_SETTING_KEY),
    publicationOf(orgCode),
    directConnectFor(user),
    productCreateGate(user),
    on("products") ? db.select({ n: count() }).from(schema.products) : Promise.resolve(null),
    db.select({ n: count() }).from(v).where(priced),
    db
      .select({
        known: sql<number>`(count(*) filter (where ${known}))::int`,
        sellable: sql<number>`(count(*) filter (where ${known} and ${availableStockExpr(sales, receipts)} > 0))::int`,
      })
      .from(v)
      .leftJoin(sales, eq(sales.variantId, v.id))
      .leftJoin(receipts, eq(receipts.variantId, v.id))
      .where(priced),
    db
      .select({ type: e.type, n: sql<number>`count(*)::int`, first: sql<string | Date | null>`min(${e.occurredAt})` })
      .from(e)
      .where(and(eq(e.channel, "TEST"), or(eq(e.type, "message.received"), and(eq(e.type, "ai.replied"), eq(e.actorKind, "AI")), inArray(e.type, ORDER_EVENTS))))
      .groupBy(e.type),
    db.select({ n: count() }).from(e).where(and(ne(e.channel, "TEST"), inArray(e.type, ORDER_EVENTS))),
    db.select({ n: count() }).from(schema.auditLogs).where(eq(schema.auditLogs.action, "ORDER_MANUAL_CREATE")),
  ]);
  const ai = await loadChatbotAiView(user, cfg, { manage: false });

  // Kênh: chưa nối được kênh nào mà đã có lần thử hỏng ⇒ lý do của màn Kênh kết nối (câu khách, không thuật ngữ).
  const rows = overview.rows.map((row) => ({ row, health: channelHealth(row, row.webhook, overview.appReady) }));
  // Kết nối kiểm tra HỎNG thì còn ở nháp, và `channelHealth` xét «chưa bật» TRƯỚC «kiểm tra không đạt» — với khách, lý do thật là
  // lần kiểm tra, nên hỏi lại ĐÚNG hàm đó như thể kết nối đã bật để lấy câu «không đạt» của chính màn Kênh kết nối.
  const testFailure = (row: (typeof overview.rows)[number]) =>
    row.pancake?.lastTestOk === false
      ? channelHealth({ ...row, owner: "PANCAKE", pancake: { ...row.pancake, status: "ACTIVE" } }, null, overview.appReady).issue
      : row.zalo?.lastTestOk === false
        ? channelHealth({ ...row, owner: "ZALO", zalo: { ...row.zalo, status: "ACTIVE" } }, null, overview.appReady).issue
        : null;
  const failedAttempt = rows.map(({ row, health }) => testFailure(row) ?? (health.level === "DISCONNECTED" && row.direct !== null && row.direct.status !== "DISABLED" ? health.issue : null)).find((x) => x !== null) ?? null;
  const live = rows.filter(({ row }) => row.owner !== null);
  const usable = live.filter(({ row, health }) => health.level !== "DISCONNECTED" && aiControlOf(row).on !== false);
  const broken = live.find(({ health }) => health.level === "DISCONNECTED");

  const byType = new Map(testRows.map((r) => [r.type, { n: Number(r.n ?? 0), first: iso(r.first) }]));
  const drafted = byType.get("order.drafted");
  const confirmed = byType.get("order.confirmed");
  const firstOrderAt = [drafted?.first, confirmed?.first].filter((x): x is string => Boolean(x)).sort()[0] ?? null;

  const facts: FirstValueFacts = {
    channels,
    channelProblem: anyChannelConnected(channels) ? null : issueText(failedAttempt),
    directConnect,
    pages: { ready: usable.length, problem: issueText(broken?.health.issue ?? null), aiOff: live.filter(({ row }) => aiControlOf(row).on === false).length },
    products: productRows ? Number(productRows[0]?.n ?? 0) : null,
    canImportProducts: productGate.allowed,
    pricedVariants: Number(pricedRows[0]?.n ?? 0),
    stockKnownVariants: Number(stockRows[0]?.known ?? 0),
    sellableVariants: Number(stockRows[0]?.sellable ?? 0),
    sellWithoutStockCheck: cfg.sellWithoutStockCheck,
    policySet: cfg.shippingFee !== null || cfg.freeShipping.enabled || cfg.extraInstructions.trim().length > 0 || Object.values(cfg.policies).some((p) => p.trim().length > 0),
    aiReady: ai.aiReady,
    aiProblem: ai.aiReady ? null : ai.audience === "CUSTOMER" ? CUSTOMER_AI_STATE_HINT[ai.aiState] : CUSTOMER_AI_STATE_HINT.NEEDS_SETUP,
    aiFix: ai.audience === "CUSTOMER" && ai.aiState === "OUT_OF_QUOTA" ? "PLAN" : "CONFIG",
    configSaved: rawCfg !== null,
    botName: cfg.botName,
    testMessages: byType.get("message.received")?.n ?? 0,
    testReplies: byType.get("ai.replied")?.n ?? 0,
    testOrders: Math.max(drafted?.n ?? 0, confirmed?.n ?? 0),
    // Một đơn bot lên trên kênh thật ghi CẢ sự kiện lẫn nhật ký tạo đơn ⇒ lấy số lớn hơn, không cộng hai lần.
    realOrders: Math.max(Number(realBotRows[0]?.n ?? 0), Number(manualRows[0]?.n ?? 0)),
    botEnabled: cfg.enabled,
    published: pub.state === "UNTRACKED" ? null : pub.state === "PUBLISHED",
    canConnect,
    canBot,
    canPublish: can(user, PUBLISH_PERMISSION),
    firstAt: { testMessage: byType.get("message.received")?.first ?? null, testReply: byType.get("ai.replied")?.first ?? null, testOrder: firstOrderAt },
  };
  const steps = firstValueSteps(facts);
  return { show: true, steps, ...firstValueSummary(steps) };
}

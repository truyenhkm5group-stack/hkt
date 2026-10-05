import { platformChatAi } from "@/lib/ai-builder/provider";
import { can, type SessionUser } from "@/lib/auth/session";
import { CONNECTIONS_PERMISSION, saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import type { TesterDeps } from "@/lib/connectors/testers";
import { canUseModule } from "@/lib/platform/capabilities";
import { loadSalesChatbotConfig } from "@/lib/sales-chatbot/engine";
import { FANPAGE_CONNECTOR, fanpageSetupView, PAGE_REPLY, type FanpageSetupView } from "@/lib/sales-chatbot/fanpage";
import { SALES_CHATBOT_MANAGE, saveSalesChatbotConfig } from "@/lib/sales-chatbot/settings";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { goLivePathOf, onboardingStage, type GoLivePath, type OnboardingStage } from "@/lib/onboarding/go-live-shared";
import { publicationOf } from "@/lib/platform/publish";
import { messengerView } from "@/lib/sales-chatbot/messenger";
import { zaloSetupView } from "@/lib/sales-chatbot/zalo";
import { loadTransportFacts, transportOwnerOf } from "@/lib/sales-chatbot/channel-ownership";

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
  messenger: { appReady: boolean; connected: boolean; pageName: string | null; mutedByPancake: boolean };
  zalo: { connected: boolean };
  /** Ô chat trên website đã xuất bản. */
  webChat: boolean;
  /** Tin khách THẬT đã nhận qua mọi kênh (hàng chờ nhận tin + chat web; tiếng vọng của bot / tin của page không tính) — bước «nhận tin đầu tiên» xong khi > 0. */
  messagesReceived: number;
  stage: OnboardingStage;
  bot: { enabled: boolean; usesPlatformAi: boolean; aiReady: boolean; aiReason: string | null };
};

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
    messenger: { appReady: false, connected: false, pageName: null, mutedByPancake: false },
    zalo: { connected: false },
    webChat: false,
    messagesReceived: 0,
    stage: "ACCOUNT_CREATED",
    bot: { enabled: false, usesPlatformAi: false, aiReady: false, aiReason: null },
  };
  if (!orgCode || user.organization?.isHome || !(canConnect || canBot) || !(await canUseModule("ai_sales"))) return off;
  const [fanpage, cfg, messenger, zalo, pub] = await Promise.all([fanpageSetupView(orgCode), loadSalesChatbotConfig(), messengerView(), zaloSetupView(orgCode), publicationOf(orgCode)]);
  const usesPlatformAi = cfg.connectorKey === "platform";
  const plat = usesPlatformAi ? await platformChatAi(orgCode) : null;
  const aiReady = plat ? plat.ok : true;
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
  const channels = { pancake: fanpage.status === "ACTIVE", messenger: messenger.status === "ACTIVE" && messenger.page !== null, zalo: zalo.status === "ACTIVE", webChat: pub.state === "PUBLISHED" };
  const messagesReceived = Number(inbound?.n ?? 0) + Number(web?.n ?? 0);
  const { stage } = onboardingStage({ ...channels, messagesReceived, pricedVariants: Number(priced?.n ?? 0), aiReady, testDrafts: Number(drafts?.n ?? 0), botEnabled: cfg.enabled });
  return {
    show: true,
    canConnect,
    canBot,
    path: goLivePathOf(channels),
    fanpage,
    messenger: { appReady: messenger.appReady, connected: channels.messenger, pageName: messenger.page?.name ?? null, mutedByPancake: messenger.mutedByPancake },
    zalo: { connected: channels.zalo },
    webChat: channels.webChat,
    messagesReceived,
    stage,
    bot: { enabled: cfg.enabled, usesPlatformAi, aiReady, aiReason: plat && !plat.ok ? plat.reason : null },
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

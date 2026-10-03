import { platformChatAi } from "@/lib/ai-builder/provider";
import { can, type SessionUser } from "@/lib/auth/session";
import { CONNECTIONS_PERMISSION, saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import type { TesterDeps } from "@/lib/connectors/testers";
import { canUseModule } from "@/lib/platform/capabilities";
import { loadSalesChatbotConfig } from "@/lib/sales-chatbot/engine";
import { FANPAGE_CONNECTOR, fanpageSetupView, type FanpageSetupView } from "@/lib/sales-chatbot/fanpage";
import { SALES_CHATBOT_MANAGE, saveSalesChatbotConfig } from "@/lib/sales-chatbot/settings";

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
 */

export type GoLiveView = {
  /** Có module «AI bán hàng» VÀ người xem có quyền làm ít nhất một trong hai việc — không ⇒ không vẽ ô. */
  show: boolean;
  canConnect: boolean;
  canBot: boolean;
  fanpage: FanpageSetupView | null;
  bot: { enabled: boolean; usesPlatformAi: boolean; aiReady: boolean; aiReason: string | null };
};

export async function loadGoLive(user: SessionUser): Promise<GoLiveView> {
  const orgCode = user.organization?.code ?? null;
  const canConnect = can(user, CONNECTIONS_PERMISSION);
  const canBot = can(user, SALES_CHATBOT_MANAGE);
  const off: GoLiveView = { show: false, canConnect, canBot, fanpage: null, bot: { enabled: false, usesPlatformAi: false, aiReady: false, aiReason: null } };
  if (!orgCode || user.organization?.isHome || !(canConnect || canBot) || !(await canUseModule("ai_sales"))) return off;
  const [fanpage, cfg] = await Promise.all([fanpageSetupView(orgCode), loadSalesChatbotConfig()]);
  const usesPlatformAi = cfg.connectorKey === "platform";
  const plat = usesPlatformAi ? await platformChatAi(orgCode) : null;
  return {
    show: true,
    canConnect,
    canBot,
    fanpage,
    bot: { enabled: cfg.enabled, usesPlatformAi, aiReady: plat ? plat.ok : true, aiReason: plat && !plat.ok ? plat.reason : null },
  };
}

/** Lưu → Kiểm tra → Bật kết nối «Fanpage qua Pancake» trong MỘT lượt bấm. */
export async function quickConnectFanpage(user: SessionUser, raw: { pageId?: unknown; pageAccessToken?: unknown }, deps: { tester?: TesterDeps } = {}): Promise<{ ok: true; message: string } | { error: string }> {
  if (!(await canUseModule("ai_sales"))) return { error: "Module AI bán hàng chưa bật — bật ở Cài đặt → Module." };
  const pageId = typeof raw.pageId === "string" ? raw.pageId.trim() : "";
  const token = typeof raw.pageAccessToken === "string" ? raw.pageAccessToken.trim() : "";
  if (!pageId || !token) return { error: "Nhập Page ID và page access token (Pancake → Cài đặt page → Công cụ)." };
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

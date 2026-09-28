import { loadAlertConfig } from "@/lib/alerts/config";
import { resolveProviderName } from "@/lib/ai/router";
import type { HomeReadiness } from "@/lib/connectors/types";
import { env, integrationStatus } from "@/lib/env";

/**
 * ═══════════ TRẠNG THÁI CẤU HÌNH HIỆN HÀNH CỦA TỔ CHỨC NHÀ — CHỈ ĐỌC, CHỈ CÓ/KHÔNG ═══════════
 *
 * Màn hình Kết nối của tổ chức nhà hiện các connector HOME_ONLY ở chế độ CHỈ ĐỌC (hợp đồng §2, X7):
 * "đã cấu hình" hay "chưa" — KHÔNG BAO GIỜ một ký tự của giá trị, và KHÔNG ghi gì. Mọi ô ở đây là
 * `Boolean(...)` trên getter có sẵn (`integrationStatus()`, `loadAlertConfig()`, `env.*`).
 *
 * CHỈ GỌI KHI NGƯỜI XEM THUỘC TỔ CHỨC NHÀ (bên gọi kiểm `isHome` từ ngữ cảnh). `integrationStatus()`
 * chỉ tự trả toàn `false` khi có ngữ cảnh TƯỜNG MINH của tổ chức khác; request mang phiên tổ chức B
 * không có ngữ cảnh tường minh ⇒ nó sẽ đọc biến môi trường của nhà. Nên cổng là ở bên gọi, không ở đây.
 */
export async function homeReadiness(): Promise<Record<string, HomeReadiness>> {
  const s = integrationStatus();
  const yes = (ok: boolean, what: string): HomeReadiness => (ok ? { state: "CONFIGURED", detail: `Đã có ${what}` } : { state: "NOT_CONFIGURED", detail: `Chưa có ${what}` });
  let alerts: { lark: boolean; telegram: boolean } | null = null;
  try {
    const cfg = await loadAlertConfig();
    alerts = { lark: Boolean(cfg.larkWebhookUrl), telegram: Boolean(cfg.telegramBotToken && cfg.telegramChatId) };
  } catch {
    alerts = null;
  }
  const unknownAlerts: HomeReadiness = { state: "UNKNOWN", detail: "Không đọc được settings[\"alerts.config\"] lúc này" };
  return {
    "pancake-pos": yes(s.pancake, s.pancakeWebhook ? "API key + mã shop · có bí mật webhook" : "API key + mã shop (bí mật webhook: chưa)"),
    "pancake-pages": yes(s.pancakePages, "access token Pancake Pages"),
    viettelpost: yes(s.viettelPost, s.viettelPostWebhook ? "tài khoản / token · có bí mật webhook" : "tài khoản / token (bí mật webhook: chưa)"),
    "viettelpost-statement": yes(s.viettelPostWebhook, "bí mật webhook bảng kê"),
    sepay: s.sepayWebhook || s.sepayApi ? { state: "CONFIGURED", detail: `Webhook: ${s.sepayWebhook ? (s.sepayWebhookSigned ? "ký HMAC" : "API key") : "chưa"} · API đối chiếu: ${s.sepayApi ? "có" : "chưa"}` } : { state: "NOT_CONFIGURED", detail: "Chưa có khoá webhook hay token API SePay" },
    "meta-ads": yes(s.facebook, "token System User"),
    "pancake-chatbot": yes(Boolean((process.env.CHATBOT_ADMIN_TOKEN ?? "").trim()), "khoá nội bộ bot"),
    "lark-alerts": alerts ? yes(alerts.lark, "webhook nhóm chính (settings hoặc biến môi trường)") : unknownAlerts,
    "telegram-alerts": alerts ? yes(alerts.telegram, "bot token + chat ID") : unknownAlerts,
    "ai-chat": resolveProviderName() ? { state: "CONFIGURED", detail: `Đang dùng ${resolveProviderName()}` } : { state: "NOT_CONFIGURED", detail: "Chưa có khoá AI (hoặc AI_PROVIDER=off)" },
    "openai-rest": yes(Boolean(env.openaiRest.apiKey), "OPENAI_API_KEY"),
    "gemini-video": yes(Boolean(env.gemini.apiKey), "GEMINI_API_KEY"),
    github: { state: "UNKNOWN", detail: "Kho công khai đọc được không cần token — trạng thái thật ở /tech/deployments" },
    "google-drive-backup": { state: "UNKNOWN", detail: "Cron máy chủ — xem thẻ Sao lưu ở /integrations" },
  };
}

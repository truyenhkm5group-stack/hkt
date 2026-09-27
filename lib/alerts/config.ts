import { ALERT_CONFIG_KEY, DEFAULT_ALERT_CONFIG, type AlertConfig } from "@/lib/constants/alerts";
import { currentOrganization } from "@/lib/platform/context";
import { getSettingJson } from "@/lib/settings";

function readProcessEnv(name: string) {
  const v = process.env[name];
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Cấu hình cảnh báo: settings → fallback env.
 *
 * ─── FALLBACK ENV CHỈ CHO TỔ CHỨC NHÀ (audit ISO-05 · target-architecture P12) ───
 *
 * `TELEGRAM_*` / `LARK_*` trong môi trường là nhóm chat CỦA VNX. Tổ chức khác chưa khai kênh (bảng
 * `settings` trống) mà lùi về env thì mọi cảnh báo, bản tin sáng, bảng lương tự động của họ — kèm
 * mã đơn, tên khách, số tiền — đi thẳng vào nhóm Lark của VNX: rò ra NGOÀI hệ thống, không thu hồi
 * được. Nên tổ chức khác chỉ có đúng kênh đã khai trong CSDL của họ; trống là "chưa khai kênh".
 * Không xác định được tổ chức ⇒ ném (`OrgContextError`), không đoán là nhà.
 *
 * `deps.readEnv` chỉ để kiểm thử đưa vào một "môi trường" giả mà không chạm biến môi trường của máy.
 */
export async function loadAlertConfig(deps: { readEnv?: (name: string) => string } = {}): Promise<AlertConfig> {
  const org = await currentOrganization();
  const envRead = deps.readEnv ?? readProcessEnv;
  const read = (name: string) => (org.isHome ? envRead(name) : "");
  const cfg = await getSettingJson<AlertConfig>(ALERT_CONFIG_KEY, DEFAULT_ALERT_CONFIG);
  return {
    ...DEFAULT_ALERT_CONFIG,
    ...cfg,
    enabled: { ...DEFAULT_ALERT_CONFIG.enabled, ...(cfg.enabled ?? {}) },
    telegramBotToken: cfg.telegramBotToken || read("TELEGRAM_BOT_TOKEN"),
    telegramChatId: cfg.telegramChatId || read("TELEGRAM_CHAT_ID"),
    larkWebhookUrl: cfg.larkWebhookUrl || read("LARK_WEBHOOK_URL"),
    larkSecret: cfg.larkSecret || read("LARK_WEBHOOK_SECRET"),
    larkBillingWebhookUrl: cfg.larkBillingWebhookUrl || read("LARK_BILLING_WEBHOOK_URL"),
    larkBillingSecret: cfg.larkBillingSecret || read("LARK_BILLING_WEBHOOK_SECRET"),
    larkInventoryWebhookUrl: cfg.larkInventoryWebhookUrl || read("LARK_INVENTORY_WEBHOOK_URL"),
    larkInventorySecret: cfg.larkInventorySecret || read("LARK_INVENTORY_WEBHOOK_SECRET"),
    larkManagerWebhookUrl: cfg.larkManagerWebhookUrl || read("LARK_MANAGER_WEBHOOK_URL"),
    larkManagerSecret: cfg.larkManagerSecret || read("LARK_MANAGER_WEBHOOK_SECRET"),
  };
}

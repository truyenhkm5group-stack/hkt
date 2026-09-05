import { ALERT_CONFIG_KEY, DEFAULT_ALERT_CONFIG, type AlertConfig } from "@/lib/constants/alerts";
import { getSettingJson } from "@/lib/settings";

function read(name: string) {
  const v = process.env[name];
  return typeof v === "string" ? v.trim() : "";
}

/** Cấu hình cảnh báo: settings → fallback env */
export async function loadAlertConfig(): Promise<AlertConfig> {
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
  };
}

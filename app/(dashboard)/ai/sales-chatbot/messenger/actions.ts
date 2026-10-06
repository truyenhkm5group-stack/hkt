"use server";

import { requirePermission } from "@/lib/auth/session";
import { checkPageWebhook, messengerApp } from "@/lib/integrations/messenger/graph";
import { webhookRow, type WebhookRow } from "@/lib/integrations/messenger/permission-guide";
import { messengerTokenFor, messengerView } from "@/lib/sales-chatbot/messenger";

/** Trần số page kiểm một lượt bấm — mỗi page 2 lời gọi Graph (debug_token + subscribed_apps). */
const RECHECK_MAX_PAGES = 30;
const RECHECK_CONCURRENCY = 5;

/**
 * «Kiểm tra lại» trạng thái webhook của các page đang nối — CHỈ ĐỌC: hỏi Meta `debug_token` + `GET subscribed_apps`, không đăng
 * ký lại, không đổi token, không ghi CSDL. Kết quả trả thẳng cho màn hình (không token nào).
 */
export async function recheckMessengerWebhooksAction(): Promise<{ ok: true; checkedAt: string; rows: WebhookRow[]; truncated: number } | { error: string }> {
  await requirePermission("settings:manage");
  const app = messengerApp();
  if (!app) return { error: "Nền tảng chưa cấu hình app Facebook — báo người vận hành." };
  const view = await messengerView();
  const pages = view.pages.filter((p) => p.status === "ACTIVE" && p.kind === "PAGE");
  const batch = pages.slice(0, RECHECK_MAX_PAGES);
  const rows: WebhookRow[] = [];
  for (let i = 0; i < batch.length; i += RECHECK_CONCURRENCY) {
    const part = await Promise.all(
      batch.slice(i, i + RECHECK_CONCURRENCY).map(async (p) => {
        const tk = await messengerTokenFor(p.id);
        if (!tk.ok) return webhookRow({ pageId: p.id, state: "UNKNOWN", missingFields: [], token: { state: "UNKNOWN", expiresAt: null, why: null }, detail: tk.error }, p.name);
        return webhookRow(await checkPageWebhook(app, p.id, tk.token), p.name);
      }),
    );
    rows.push(...part);
  }
  return { ok: true, checkedAt: new Date().toISOString(), rows, truncated: Math.max(0, pages.length - batch.length) };
}

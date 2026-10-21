/**
 * ═══════════ NGƯỠNG CẢNH BÁO WEBHOOK MESSENGER — CHỦ SHOP DUYỆT 21/10/2026 ═══════════
 *
 * MỘT chỗ duy nhất cho ngưỡng (AGENTS.md mục 7: đổi ngưỡng là quyết định của chủ shop — sửa ở đây, ghi ngày duyệt mới). Đếm đọc từ
 * sổ `platform_webhook_rejections` (24 giờ tính lúc đọc — lib/platform/webhook-rejections.ts).
 *  · ORG_LOOKUP_FAILED ≥ 1 gói / 24 giờ ⇒ báo NGAY: mỗi gói như thế là tin của khách mà ERP chưa tra được page (Meta đang gửi lại).
 *  · SIGNATURE > 20 gói / 24 giờ (tức TỪ 21) ⇒ báo: app secret lệch thì tin của MỌI cửa hàng bị bỏ; dưới ngưỡng thường là người lạ dò URL.
 *  · MỘT tin mỗi ngày (giờ Việt Nam) mỗi loại — không spam.
 * HÀM THUẦN, client import được.
 */
export const MESSENGER_WEBHOOK_ALERT_RULES = [
  {
    reason: "ORG_LOOKUP_FAILED",
    minCount24h: 1,
    severity: "critical",
    title: (n: number) => `Webhook Messenger: ${n} gói không tra được page trong 24 giờ`,
    body: "ERP trả 503 để Meta gửi lại, nhưng CSDL nền tảng đang trục trặc — tin của khách có thể đang chờ. Kiểm CSDL / log máy chủ ngay.",
  },
  {
    reason: "SIGNATURE",
    minCount24h: 21,
    severity: "critical",
    title: (n: number) => `Webhook Messenger: ${n} gói sai chữ ký trong 24 giờ`,
    body: "Quá 20 gói / 24 giờ sai chữ ký — thường là app secret Meta trên máy chủ lệch với app (vừa xoay khoá?) ⇒ tin của MỌI cửa hàng bị bỏ. Kiểm FACEBOOK_*_APP_SECRET và /platform.",
  },
] as const;

export type MessengerWebhookAlertRule = (typeof MESSENGER_WEBHOOK_ALERT_RULES)[number];

/** Luật nào đã tới ngưỡng, với số đếm 24 giờ hiện tại. HÀM THUẦN. */
export function messengerWebhookAlertsDue(rows: readonly { reason: string; count24h: number }[]): { rule: MessengerWebhookAlertRule; count24h: number }[] {
  const out: { rule: MessengerWebhookAlertRule; count24h: number }[] = [];
  for (const rule of MESSENGER_WEBHOOK_ALERT_RULES) {
    const n = rows.find((r) => r.reason === rule.reason)?.count24h ?? 0;
    if (n >= rule.minCount24h) out.push({ rule, count24h: n });
  }
  return out;
}

/** Ngày giờ Việt Nam (UTC+7) — khoá «một tin mỗi ngày». HÀM THUẦN. */
export function vnDay(at: Date): string {
  return new Date(at.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

export const messengerWebhookAlertKey = (reason: string, at: Date) => `messenger-webhook:${reason}:${vnDay(at)}`;

/**
 * ═══════════ QUAN SÁT WEBHOOK MESSENGER TRỰC TIẾP (gap analysis slice 5) ═══════════
 *
 * Webhook Meta là MỘT URL cho mọi tổ chức, và trước bản này nó im lặng: chữ ký sai (app secret lệch), page chưa nối (gói tới
 * mà không tổ chức nào nhận), gói gửi lại, lượt AI / gửi tin hỏng sau phản hồi — không để lại dấu vết nào ngoài HTTP status.
 * Mỗi chuyện là MỘT dòng log có cấu trúc (`evt`), cùng khuôn với `meta_ad_post_error`:
 *  · `messenger_webhook_rejected` — SIGNATURE · NOT_JSON · BODY_TOO_LARGE · VERIFY_TOKEN (401 / 400 / 413 / 403);
 *  · `messenger_webhook_anomaly`  — gói có sự kiện của page LẠ hoặc sự kiện TRÙNG (Meta gửi lại); gói bình thường KHÔNG ghi;
 *  · `messenger_process_failed`   — lượt nền (AI · gửi Send API) hỏng, theo tổ chức + page.
 * CHỈ số đếm, mã page, mã tổ chức và câu lỗi đã che bí mật (≤ 300 ký tự) — KHÔNG nội dung tin, KHÔNG PSID, KHÔNG token.
 */

export type WebhookOutcome = { pageId: string; outcome: "QUEUED" | "DUPLICATE" | "IGNORED" | "UNKNOWN_PAGE" };

/** Tóm tắt MỘT gói: `null` khi bình thường (không ghi log); có page lạ / sự kiện trùng ⇒ số đếm + mã page lạ. HÀM THUẦN. */
export function summarizeMessengerWebhook(outcomes: readonly WebhookOutcome[]): { events: number; queued: number; duplicates: number; ignored: number; unknownPages: string[] } | null {
  const count = (o: WebhookOutcome["outcome"]) => outcomes.filter((x) => x.outcome === o).length;
  const unknownPages = [...new Set(outcomes.filter((x) => x.outcome === "UNKNOWN_PAGE").map((x) => x.pageId))].sort();
  const duplicates = count("DUPLICATE");
  if (!unknownPages.length && !duplicates) return null;
  return { events: outcomes.length, queued: count("QUEUED"), duplicates, ignored: count("IGNORED"), unknownPages };
}

type LogFields = Record<string, string | number | boolean | string[] | null>;

export function messengerWebhookLog(evt: "messenger_webhook_rejected" | "messenger_webhook_anomaly" | "messenger_process_failed", fields: LogFields): void {
  const safe: LogFields = {};
  for (const [k, v] of Object.entries(fields)) safe[k] = typeof v === "string" ? v.slice(0, 300) : v;
  console.warn(JSON.stringify({ evt, ...safe }));
}

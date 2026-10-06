import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { MESSENGER_WEBHOOK_MAX_BODY_BYTES } from "@/lib/constants/webhook-limits";
import { readBodyCapped } from "@/lib/http/body-limit";
import { messengerVerifyToken, messengerWebhookSecrets, parseMessengerWebhook, verifyMessengerSignatureAny } from "@/lib/integrations/messenger/graph";
import { bindOrganization } from "@/lib/platform/background";
import { withOrganization } from "@/lib/platform/context";
import { resolveWebhookOrganization, WebhookAuthError } from "@/lib/platform/webhooks";
import { processMessengerThreadDebounced, receiveMessengerEvent, sweepStaleMessengerThreads } from "@/lib/sales-chatbot/messenger";
import { messengerWebhookLog, summarizeMessengerWebhook } from "@/lib/sales-chatbot/messenger-observability";

export const dynamic = "force-dynamic";

/**
 * Webhook MESSENGER TRỰC TIẾP của mọi tổ chức (0207 · lib/sales-chatbot/messenger.ts). Meta chỉ cho khai MỘT URL mỗi app, nên:
 *  1. chữ ký `X-Hub-Signature-256` bằng app secret của nền tảng (app đăng nhập, và app Messenger riêng nếu đã khai) — sai ⇒ 401;
 *  2. mỗi sự kiện ⇒ tổ chức theo MÃ PAGE (`WEBHOOK_BINDINGS.MESSENGER`, PAGE_INDEX) — page chưa nối ⇒ bỏ qua sự kiện đó, không
 *     bao giờ rơi về tổ chức nhà;
 *  3. ghi tin rồi trả 200 ngay; gọi AI + Send API chạy SAU phản hồi trong đúng ngữ cảnh tổ chức (`bindOrganization`).
 * Meta gửi lại tối đa nhiều lần khi không nhận 200 ⇒ mọi bước idempotent theo `mid`.
 * QUAN SÁT (messenger-observability.ts): chữ ký sai · page lạ · gói trùng · lượt nền hỏng ⇒ MỘT dòng log có cấu trúc, chỉ số
 * đếm + mã page — không nội dung tin, không token.
 */
export async function POST(request: NextRequest) {
  // App đăng nhập (đang chạy) + app Messenger riêng nếu đã khai (đang cấu hình thử) — gói của app nào cũng phải ký đúng secret
  // của CHÍNH app đó; không khai secret nào ⇒ kênh chưa mở.
  const secrets = messengerWebhookSecrets();
  if (!secrets.length) return NextResponse.json({ ok: false, error: "Messenger chưa cấu hình" }, { status: 503 });
  const read = await readBodyCapped(request, MESSENGER_WEBHOOK_MAX_BODY_BYTES);
  if (!read.ok) {
    messengerWebhookLog("messenger_webhook_rejected", { reason: "BODY_TOO_LARGE" });
    return NextResponse.json({ ok: false, error: read.reason }, { status: 413 });
  }
  if (!verifyMessengerSignatureAny(read.text, request.headers.get("x-hub-signature-256"), secrets)) {
    messengerWebhookLog("messenger_webhook_rejected", { reason: "SIGNATURE" });
    return NextResponse.json({ ok: false, error: "Sai chữ ký" }, { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(read.text) as unknown;
  } catch {
    messengerWebhookLog("messenger_webhook_rejected", { reason: "NOT_JSON" });
    return NextResponse.json({ ok: false, error: "Body không phải JSON" }, { status: 400 });
  }
  const events = parseMessengerWebhook(payload);
  let queued = 0;
  const outcomes: { pageId: string; outcome: "QUEUED" | "DUPLICATE" | "IGNORED" | "UNKNOWN_PAGE" }[] = [];
  for (const ev of events) {
    let orgCode: string;
    try {
      orgCode = await resolveWebhookOrganization("MESSENGER", { pageId: ev.pageId });
    } catch (e) {
      if (e instanceof WebhookAuthError) {
        outcomes.push({ pageId: ev.pageId, outcome: "UNKNOWN_PAGE" });
        continue;
      }
      throw e;
    }
    await withOrganization(orgCode, async () => {
      const r = await receiveMessengerEvent(ev);
      if (r.queued) queued += 1;
      outcomes.push({ pageId: ev.pageId, outcome: r.queued ? "QUEUED" : /trùng/i.test(r.reason) ? "DUPLICATE" : "IGNORED" });
      after(
        await bindOrganization(async () => {
          // Bình luận: hàng chờ riêng của chính bình luận («comment:<mã>»); tin nhắn: hội thoại theo người gửi (PSID / IGSID).
          try {
            if (r.queued) {
              const p = await processMessengerThreadDebounced(ev.pageId, ev.comment ? ev.mid : ev.psid);
              if (p.error) messengerWebhookLog("messenger_process_failed", { org: orgCode, pageId: ev.pageId, stage: "SEND", error: p.error });
            }
            await sweepStaleMessengerThreads();
          } catch (error) {
            messengerWebhookLog("messenger_process_failed", { org: orgCode, pageId: ev.pageId, stage: "PROCESS", error: error instanceof Error ? error.message : String(error) });
          }
        }),
      );
    });
  }
  const summary = summarizeMessengerWebhook(outcomes);
  if (summary) messengerWebhookLog("messenger_webhook_anomaly", summary);
  return NextResponse.json({ ok: true, events: events.length, queued });
}

/** Meta xác minh URL khi khai webhook: `hub.verify_token` đúng ⇒ trả lại `hub.challenge`. */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  if (q.get("hub.mode") === "subscribe" && q.get("hub.verify_token") === messengerVerifyToken()) {
    return new NextResponse(q.get("hub.challenge") ?? "", { status: 200, headers: { "content-type": "text/plain" } });
  }
  messengerWebhookLog("messenger_webhook_rejected", { reason: "VERIFY_TOKEN" });
  return NextResponse.json({ ok: false }, { status: 403 });
}

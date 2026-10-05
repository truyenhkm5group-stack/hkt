import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { PANCAKE_WEBHOOK_MAX_BODY_BYTES } from "@/lib/constants/webhook-limits";
import { readBodyCapped } from "@/lib/http/body-limit";
import { bindOrganization } from "@/lib/platform/background";
import { withOrganization } from "@/lib/platform/context";
import { resolveWebhookOrganization, WebhookAuthError } from "@/lib/platform/webhooks";
import { parsePancakeWebhook, processFanpageThreadDebounced, receiveFanpageEvent, sweepStaleFanpageThreads } from "@/lib/sales-chatbot/fanpage";
import { syncFanpageThreadWhenQuiet } from "@/lib/sales-chatbot/order-sync";

export const dynamic = "force-dynamic";

/**
 * Webhook tin nhắn FANPAGE của MỘT tổ chức khách (0182 · lib/sales-chatbot/fanpage.ts). Không phiên: tổ chức phân giải
 * từ token trong đường dẫn (`WEBHOOK_BINDINGS.PANCAKE_FANPAGE`, URL_SECRET) TRƯỚC khi đọc body — token sai ⇒ 401, không
 * bao giờ rơi về tổ chức nhà. Ghi tin rồi trả 200 ngay; gọi AI và trả lời qua Pancake chạy SAU phản hồi, trong đúng ngữ
 * cảnh tổ chức (`bindOrganization`).
 */
export async function POST(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const orgCode = await orgOf(context);
  if (!orgCode) return NextResponse.json({ ok: false, error: "Sai token webhook" }, { status: 401 });
  const read = await readBodyCapped(request, PANCAKE_WEBHOOK_MAX_BODY_BYTES);
  if (!read.ok) return NextResponse.json({ ok: false, error: read.reason }, { status: 413 });
  let payload: unknown;
  try {
    payload = JSON.parse(read.text) as unknown;
  } catch {
    return NextResponse.json({ ok: false, error: "Body không phải JSON" }, { status: 400 });
  }
  const ev = parsePancakeWebhook(payload);
  if (!ev) return NextResponse.json({ ok: true, ignored: "Không phải tin nhắn" });
  return withOrganization(orgCode, async () => {
    const r = await receiveFanpageEvent(ev);
    after(
      await bindOrganization(async () => {
        if (r.queued) await processFanpageThreadDebounced(ev.pageId, ev.threadId);
        await sweepStaleFanpageThreads();
      }),
    );
    // Ghi đơn nhân viên chốt trên fanpage NGAY khi hội thoại yên (công tắc «ghi đơn từ hội thoại» tắt ⇒ không làm gì).
    if (r.reason !== "Tin của chính bot") after(await bindOrganization(() => syncFanpageThreadWhenQuiet(ev.pageId, ev.threadId)));
    return NextResponse.json({ ok: true, queued: r.queued, reason: r.reason });
  });
}

/** Pancake / người cấu hình mở URL để thử: token đúng ⇒ 200. Không đọc gì khác. */
export async function GET(_request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const orgCode = await orgOf(context);
  if (!orgCode) return NextResponse.json({ ok: false }, { status: 401 });
  return withOrganization(orgCode, async () => NextResponse.json({ ok: true, message: "Webhook fanpage sẵn sàng — Pancake POST tin nhắn vào URL này." }));
}

/** Token ⇒ tổ chức qua cổng chung `WEBHOOK_BINDINGS.PANCAKE_FANPAGE` (URL_SECRET); sai ⇒ `null` (401). */
async function orgOf(context: { params: Promise<{ token: string }> }): Promise<string | null> {
  const { token } = await context.params;
  try {
    return await resolveWebhookOrganization("PANCAKE_FANPAGE", { token });
  } catch (e) {
    if (e instanceof WebhookAuthError) return null;
    throw e;
  }
}

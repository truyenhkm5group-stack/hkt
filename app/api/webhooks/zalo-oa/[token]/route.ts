import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { openActiveConnection } from "@/lib/connectors/service";
import { ZALO_OA_WEBHOOK_MAX_BODY_BYTES } from "@/lib/constants/webhook-limits";
import { readBodyCapped } from "@/lib/http/body-limit";
import { parseZaloEvent, verifyZaloSignature } from "@/lib/integrations/zalo/oa";
import { bindOrganization } from "@/lib/platform/background";
import { withOrganization } from "@/lib/platform/context";
import { resolveWebhookOrganization, WebhookAuthError } from "@/lib/platform/webhooks";
import { processZaloThreadDebounced, receiveZaloEvent, sweepStaleZaloThreads, ZALO_CONNECTOR } from "@/lib/sales-chatbot/zalo";

export const dynamic = "force-dynamic";

/**
 * Webhook tin nhắn ZALO OA của MỘT tổ chức khách (kênh ZALO · lib/sales-chatbot/zalo.ts). Không phiên: tổ chức phân giải từ token
 * trong đường dẫn (`WEBHOOK_BINDINGS.ZALO_OA`, URL_SECRET) TRƯỚC khi đọc body — token sai ⇒ 401, không bao giờ rơi về tổ chức
 * nhà. Rồi chữ ký `X-ZEvent-Signature` trên THÂN THÔ bằng OA Secret Key của chính tổ chức đó — sai ⇒ 401. Ghi tin rồi trả 200
 * ngay; gọi AI và trả lời qua Zalo chạy SAU phản hồi, trong đúng ngữ cảnh tổ chức (`bindOrganization`).
 */
export async function POST(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const orgCode = await orgOf(context);
  if (!orgCode) return NextResponse.json({ ok: false, error: "Sai token webhook" }, { status: 401 });
  const read = await readBodyCapped(request, ZALO_OA_WEBHOOK_MAX_BODY_BYTES);
  if (!read.ok) return NextResponse.json({ ok: false, error: read.reason }, { status: 413 });
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(read.text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    payload = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Body không phải JSON" }, { status: 400 });
  }
  const signature = request.headers.get("x-zevent-signature");
  return withOrganization(orgCode, async () => {
    const conn = await openActiveConnection(ZALO_CONNECTOR);
    // Kết nối chưa bật (đang dựng, Zalo bấm «Kiểm tra webhook»): trả 200 để Zalo không đánh dấu URL hỏng, nhưng không nhận gì.
    if (!conn.ok) return NextResponse.json({ ok: true, ignored: "Kết nối Zalo OA chưa bật" });
    const timestamp = typeof payload.timestamp === "string" || typeof payload.timestamp === "number" ? String(payload.timestamp) : "";
    const valid = verifyZaloSignature({ appId: (conn.settings.appId ?? "").trim(), rawBody: read.text, timestamp, oaSecretKey: (conn.secrets.oaSecretKey ?? "").trim(), header: signature });
    if (!valid) return NextResponse.json({ ok: false, error: "Sai chữ ký" }, { status: 401 });
    const r = await receiveZaloEvent(parseZaloEvent(payload));
    after(
      await bindOrganization(async () => {
        if (r.queued && r.userId) await processZaloThreadDebounced(r.userId);
        await sweepStaleZaloThreads();
      }),
    );
    return NextResponse.json({ ok: true, queued: r.queued, reason: r.reason });
  });
}

/** Người cấu hình mở URL để thử: token đúng ⇒ 200. Không đọc gì khác. */
export async function GET(_request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const orgCode = await orgOf(context);
  if (!orgCode) return NextResponse.json({ ok: false }, { status: 401 });
  return withOrganization(orgCode, async () => NextResponse.json({ ok: true, message: "Webhook Zalo OA sẵn sàng — Zalo POST sự kiện tin nhắn vào URL này." }));
}

/** Token ⇒ tổ chức qua cổng chung `WEBHOOK_BINDINGS.ZALO_OA` (URL_SECRET); sai ⇒ `null` (401). */
async function orgOf(context: { params: Promise<{ token: string }> }): Promise<string | null> {
  const { token } = await context.params;
  try {
    return await resolveWebhookOrganization("ZALO_OA", { token });
  } catch (e) {
    if (e instanceof WebhookAuthError) return null;
    throw e;
  }
}

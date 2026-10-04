import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { scheduleAlertEvaluation } from "@/lib/alerts/rules";
import { staleMemo } from "@/lib/cache";
import { PANCAKE_WEBHOOK_MAX_BODY_BYTES } from "@/lib/constants/webhook-limits";
import { readBodyCapped } from "@/lib/http/body-limit";
import { str } from "@/lib/integrations/http";
import { withPancakeClient } from "@/lib/integrations/pancake/client";
import { openOrgPancakeClient } from "@/lib/integrations/pancake/org";
import { detectKind, parseWebhookBody, processPancakeWebhook, storeWebhook, webhookDedupeKey } from "@/lib/integrations/pancake/webhook";
import { bindOrganization } from "@/lib/platform/background";
import { withOrganization } from "@/lib/platform/context";
import { resolveWebhookOrganization, WebhookAuthError } from "@/lib/platform/webhooks";

export const dynamic = "force-dynamic";

/**
 * WEBHOOK PANCAKE POS CỦA MỘT TỔ CHỨC KHÁCH (F1 · kết nối «pancake-pos-org»).
 *
 * Tổ chức phân giải từ TOKEN trong đường dẫn (`URL_SECRET` — chữ ký HMAC riêng của tổ chức, dẫn xuất từ PLATFORM_SECRETS_KEY)
 * TRƯỚC khi đọc body; token sai ⇒ 401, KHÔNG rơi về nhà. Mọi phần xử lý — kể cả việc sau phản hồi — chạy trong
 * `withOrganization(mã đã phân giải)` và với client Pancake của CHÍNH tổ chức đó (`withPancakeClient`), qua ĐÚNG bộ xử lý của
 * nhà (`processPancakeWebhook`): cùng chống trùng theo (loại, id, updated_at), cùng luật webhook cũ không đè dữ liệu mới.
 * Kết nối chưa bật ⇒ 409 — Pancake hiện lỗi cho shop thấy, không có gói nào bị ghi lặng lẽ.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ token: string; event?: string[] }> }) {
  const { token, event = [] } = await context.params;
  let orgCode: string;
  try {
    orgCode = await resolveWebhookOrganization("PANCAKE_POS_ORG", { token });
  } catch (error) {
    if (error instanceof WebhookAuthError) return NextResponse.json({ ok: false, error: "Sai token webhook" }, { status: 401 });
    throw error;
  }
  return withOrganization(orgCode, async () => {
    const opened = await openOrgPancakeClient();
    if (!("ok" in opened)) return NextResponse.json({ ok: false, error: "Kết nối Pancake POS của tổ chức chưa bật" }, { status: 409 });

    const read = await readBodyCapped(request, PANCAKE_WEBHOOK_MAX_BODY_BYTES);
    if (!read.ok) return NextResponse.json({ ok: false, error: read.reason }, { status: 413 });
    let payload: Record<string, unknown>;
    try {
      payload = parseWebhookBody(read.text);
    } catch {
      return NextResponse.json({ ok: false, error: "Body không phải JSON" }, { status: 400 });
    }
    const kind = detectKind(payload, event.join("/"));
    const externalId = str(payload.id, payload.variation_id, payload.system_id) || null;
    const headers: Record<string, string> = {};
    for (const key of ["user-agent", "x-forwarded-for", "content-type"]) {
      const value = request.headers.get(key);
      if (value) headers[key] = value;
    }
    const updatedAt = str(payload.updated_at, payload.updated_at_external, payload.last_update_status_at) || null;
    const stored = await storeWebhook("PANCAKE", kind, externalId, payload, headers, {
      dedupeKey: webhookDedupeKey("PANCAKE", [kind, externalId, updatedAt]),
      occurredAt: updatedAt ? new Date(updatedAt) : null,
    });
    const client = opened.client;
    after(
      await bindOrganization(async () => {
        const outcome = await withPancakeClient(client, () => processPancakeWebhook(stored.id));
        if (outcome.changed) {
          staleMemo();
          scheduleAlertEvaluation();
        }
      }),
    );
    return NextResponse.json({ ok: true, received: kind, id: stored.id, duplicate: stored.duplicate });
  });
}

export async function GET(_request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  try {
    await resolveWebhookOrganization("PANCAKE_POS_ORG", { token });
  } catch {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  return NextResponse.json({ ok: true, message: "Webhook Pancake POS của tổ chức sẵn sàng. Pancake sẽ POST dữ liệu vào URL này." });
}

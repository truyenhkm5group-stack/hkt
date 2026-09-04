import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { env } from "@/lib/env";
import { str } from "@/lib/integrations/http";
import { detectKind, parseWebhookBody, processPancakeWebhook, storeWebhook } from "@/lib/integrations/pancake/webhook";

export const dynamic = "force-dynamic";

function secretOk(secret: string) {
  const expected = env.pancake.webhookSecret;
  return Boolean(expected) && secret === expected;
}

export async function POST(request: NextRequest, context: { params: Promise<{ secret: string; event?: string[] }> }) {
  const { secret, event = [] } = await context.params;
  if (!secretOk(secret)) return NextResponse.json({ ok: false, error: "Sai bí mật webhook" }, { status: 401 });

  const text = await request.text();
  let payload: Record<string, unknown>;
  try {
    payload = parseWebhookBody(text);
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
  const eventId = await storeWebhook("PANCAKE", kind, externalId, payload, headers);
  after(async () => {
    await processPancakeWebhook(eventId);
  });
  return NextResponse.json({ ok: true, received: kind, id: eventId });
}

export async function GET(_request: NextRequest, context: { params: Promise<{ secret: string; event?: string[] }> }) {
  const { secret } = await context.params;
  if (!secretOk(secret)) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true, message: "Webhook Pancake POS sẵn sàng. Pancake sẽ POST dữ liệu vào URL này." });
}

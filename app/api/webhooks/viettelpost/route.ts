import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { env } from "@/lib/env";
import { asRecord, parseJsonSafeInts, str } from "@/lib/integrations/http";
import { markWebhook, storeWebhook } from "@/lib/integrations/pancake/webhook";
import { normalizeTracking } from "@/lib/integrations/viettelpost/client";
import { applyVtpTracking } from "@/lib/integrations/viettelpost/sync";

export const dynamic = "force-dynamic";

function extractSecret(request: NextRequest, body: Record<string, unknown>) {
  const auth = request.headers.get("authorization") ?? "";
  return [
    str(body.TOKEN, body.token),
    request.headers.get("token") ?? "",
    auth.replace(/^Bearer\s+/i, ""),
    request.nextUrl.searchParams.get("access_token") ?? "",
    request.nextUrl.searchParams.get("token") ?? "",
  ].filter(Boolean);
}

export async function POST(request: NextRequest) {
  const text = await request.text();
  let body: Record<string, unknown>;
  try {
    body = asRecord(parseJsonSafeInts(text));
  } catch {
    return NextResponse.json({ status: 400, error: true, message: "Body không phải JSON" }, { status: 400 });
  }

  const expected = env.viettelPost.webhookSecret;
  if (expected && !extractSecret(request, body).includes(expected)) {
    return NextResponse.json({ status: 401, error: true, message: "Sai tham số bí mật" }, { status: 401 });
  }

  const data = asRecord(body.DATA ?? body.data ?? body);
  const record = normalizeTracking(data);
  const eventId = await storeWebhook("VIETTELPOST", "tracking", record.orderNumber || null, { DATA: data }, { "user-agent": request.headers.get("user-agent") ?? "" });

  after(async () => {
    try {
      const result = await applyVtpTracking(record, "VTP_WEBHOOK", { allowCreate: true });
      await markWebhook(eventId, result ? "PROCESSED" : "IGNORED", result ? null : "Không tìm thấy vận đơn tương ứng");
    } catch (error) {
      await markWebhook(eventId, "FAILED", error instanceof Error ? error.message : String(error));
    }
  });

  // Viettel Post yêu cầu trả HTTP 200 trong < 1 giây
  return NextResponse.json({ status: 200, error: false, message: "OK" });
}

export async function GET() {
  return NextResponse.json({ status: 200, error: false, message: "Webhook Viettel Post sẵn sàng. Viettel Post sẽ POST {DATA, TOKEN} vào URL này." });
}

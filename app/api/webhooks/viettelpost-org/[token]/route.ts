import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { VTP_WEBHOOK_MAX_BODY_BYTES } from "@/lib/constants/webhook-limits";
import { readBodyCapped } from "@/lib/http/body-limit";
import { asRecord, parseJsonSafeInts } from "@/lib/integrations/http";
import { acceptVtpWebhook, applyAcceptedVtpWebhook } from "@/lib/integrations/viettelpost/webhook-core";
import { bindOrganization } from "@/lib/platform/background";
import { canUseModule } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { resolveWebhookOrganization, WebhookAuthError } from "@/lib/platform/webhooks";

export const dynamic = "force-dynamic";

/**
 * WEBHOOK VIETTEL POST CỦA MỘT TỔ CHỨC KHÁCH (F2 · docs/verticals/fashion-cod.md).
 *
 * Gói Viettel Post không mang mã khách nên tổ chức phân giải từ TOKEN trong đường dẫn (`URL_SECRET` — chữ ký HMAC riêng của
 * tổ chức) TRƯỚC khi đọc body; sai ⇒ 401, không rơi về nhà. Tổ chức chưa bật module Giao vận ⇒ 409. Sau đó đi qua ĐÚNG lõi của
 * route nhà (`lib/integrations/viettelpost/webhook-core.ts`): cùng khoá chống trùng, cùng `applyVtpTracking`, cùng luật mốc
 * ĐVVC mới hơn thì thắng. Trả HTTP 200 ngay (Viettel Post đòi < 1 giây), áp trạng thái sau phản hồi.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  let orgCode: string;
  try {
    orgCode = await resolveWebhookOrganization("VIETTELPOST_ORG", { token });
  } catch (error) {
    if (error instanceof WebhookAuthError) return NextResponse.json({ status: 401, error: true, message: "Sai token webhook" }, { status: 401 });
    throw error;
  }
  return withOrganization(orgCode, async () => {
    if (!(await canUseModule("logistics"))) return NextResponse.json({ status: 409, error: true, message: "Tổ chức chưa bật module Giao vận" }, { status: 409 });
    const read = await readBodyCapped(request, VTP_WEBHOOK_MAX_BODY_BYTES);
    if (!read.ok) return NextResponse.json({ status: 413, error: true, message: read.reason }, { status: 413 });
    let body: Record<string, unknown>;
    try {
      body = asRecord(parseJsonSafeInts(read.text));
    } catch {
      return NextResponse.json({ status: 400, error: true, message: "Body không phải JSON" }, { status: 400 });
    }
    const accepted = await acceptVtpWebhook(body, { userAgent: request.headers.get("user-agent") ?? "", contentType: request.headers.get("content-type") ?? "" });
    after(await bindOrganization(() => applyAcceptedVtpWebhook(accepted)));
    return NextResponse.json({ status: 200, error: false, message: "OK" });
  });
}

export async function GET(_request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  try {
    await resolveWebhookOrganization("VIETTELPOST_ORG", { token });
  } catch {
    return NextResponse.json({ status: 401, error: true }, { status: 401 });
  }
  return NextResponse.json({ status: 200, error: false, message: "Webhook Viettel Post của tổ chức sẵn sàng. Viettel Post POST {DATA} vào URL này." });
}

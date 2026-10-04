import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { VTP_WEBHOOK_MAX_BODY_BYTES } from "@/lib/constants/webhook-limits";
import { readBodyCapped } from "@/lib/http/body-limit";
import { asRecord } from "@/lib/integrations/http";
import { acceptGhnWebhook, applyAcceptedGhnWebhook } from "@/lib/integrations/ghn/webhook";
import { bindOrganization } from "@/lib/platform/background";
import { canUseModule } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { resolveWebhookOrganization, WebhookAuthError } from "@/lib/platform/webhooks";

export const dynamic = "force-dynamic";

/**
 * WEBHOOK TRẠNG THÁI GHN CỦA MỘT TỔ CHỨC KHÁCH (POS tự chủ · ORDER_OUTCOME.md mục 4.1).
 *
 * Gói GHN chỉ mang ShopID của hãng nên tổ chức phân giải từ TOKEN trong đường dẫn (`URL_SECRET` — chữ ký HMAC riêng của tổ
 * chức) TRƯỚC khi đọc body; sai ⇒ 401 (GHN bỏ hẳn 4xx — đúng ý: gói không thuộc ai). Tổ chức chưa bật module Giao vận ⇒ 409.
 * Lưu với khoá chống trùng (OrderCode, Type, Time), trả 200 ngay, áp vào vận đơn sau phản hồi (`lib/integrations/ghn/webhook.ts`).
 */
export async function POST(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  let orgCode: string;
  try {
    orgCode = await resolveWebhookOrganization("GHN_ORG", { token });
  } catch (error) {
    if (error instanceof WebhookAuthError) return NextResponse.json({ code: 401, message: "Sai token webhook" }, { status: 401 });
    throw error;
  }
  return withOrganization(orgCode, async () => {
    if (!(await canUseModule("logistics"))) return NextResponse.json({ code: 409, message: "Tổ chức chưa bật module Giao vận" }, { status: 409 });
    const read = await readBodyCapped(request, VTP_WEBHOOK_MAX_BODY_BYTES);
    if (!read.ok) return NextResponse.json({ code: 413, message: read.reason }, { status: 413 });
    let body: Record<string, unknown>;
    try {
      body = asRecord(JSON.parse(read.text));
    } catch {
      return NextResponse.json({ code: 400, message: "Body không phải JSON" }, { status: 400 });
    }
    const accepted = await acceptGhnWebhook(body, { userAgent: request.headers.get("user-agent") ?? "", contentType: request.headers.get("content-type") ?? "" });
    after(await bindOrganization(() => applyAcceptedGhnWebhook(accepted, body)));
    return NextResponse.json({ code: 200, message: "OK" });
  });
}

export async function GET(_request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  try {
    await resolveWebhookOrganization("GHN_ORG", { token });
  } catch {
    return NextResponse.json({ code: 401 }, { status: 401 });
  }
  return NextResponse.json({ code: 200, message: "Webhook GHN của tổ chức sẵn sàng. GHN POST gói trạng thái (JSON) vào URL này." });
}

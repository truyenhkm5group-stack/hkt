import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { VTP_WEBHOOK_MAX_BODY_BYTES } from "@/lib/constants/webhook-limits";
import { readBodyCapped } from "@/lib/http/body-limit";
import { acceptGhtkWebhook, applyAcceptedGhtkWebhook, readGhtkBody } from "@/lib/integrations/ghtk/webhook";
import { bindOrganization } from "@/lib/platform/background";
import { canUseModule } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { resolveWebhookOrganization, WebhookAuthError } from "@/lib/platform/webhooks";

export const dynamic = "force-dynamic";

/**
 * WEBHOOK TRẠNG THÁI GHTK CỦA MỘT TỔ CHỨC KHÁCH (POS tự chủ · ORDER_OUTCOME.md mục 4.1).
 *
 * Gói GHTK không mang mã khách của ERP nên tổ chức phân giải từ TOKEN trong đường dẫn (`URL_SECRET` — chữ ký HMAC riêng của tổ
 * chức) TRƯỚC khi đọc body; sai ⇒ 401. Tổ chức chưa bật module Giao vận ⇒ 409. Thân form-urlencoded (tài liệu); lưu với khoá
 * chống trùng (label_id, status_id, action_time), trả 200 ngay, áp vào vận đơn sau phản hồi (`lib/integrations/ghtk/webhook.ts`).
 */
export async function POST(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  let orgCode: string;
  try {
    orgCode = await resolveWebhookOrganization("GHTK_ORG", { token });
  } catch (error) {
    if (error instanceof WebhookAuthError) return NextResponse.json({ code: 401, message: "Sai token webhook" }, { status: 401 });
    throw error;
  }
  return withOrganization(orgCode, async () => {
    if (!(await canUseModule("logistics"))) return NextResponse.json({ code: 409, message: "Tổ chức chưa bật module Giao vận" }, { status: 409 });
    const read = await readBodyCapped(request, VTP_WEBHOOK_MAX_BODY_BYTES);
    if (!read.ok) return NextResponse.json({ code: 413, message: read.reason }, { status: 413 });
    const contentType = request.headers.get("content-type") ?? "";
    const body = readGhtkBody(read.text, contentType);
    if (!body) return NextResponse.json({ code: 400, message: "Body không đọc được (cần form-urlencoded hoặc JSON)" }, { status: 400 });
    const accepted = await acceptGhtkWebhook(body, { userAgent: request.headers.get("user-agent") ?? "", contentType });
    after(await bindOrganization(() => applyAcceptedGhtkWebhook(accepted, body)));
    return NextResponse.json({ code: 200, message: "OK" });
  });
}

export async function GET(_request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  try {
    await resolveWebhookOrganization("GHTK_ORG", { token });
  } catch {
    return NextResponse.json({ code: 401 }, { status: 401 });
  }
  return NextResponse.json({ code: 200, message: "Webhook GHTK của tổ chức sẵn sàng. GHTK POST gói trạng thái (form-urlencoded) vào URL này." });
}

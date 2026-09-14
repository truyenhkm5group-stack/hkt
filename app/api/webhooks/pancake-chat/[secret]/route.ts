/**
 * WEBHOOK HỘI THOẠI PANCAKE → miền bán hàng của nền tảng nhân sự AI.
 *
 * Tách hẳn khỏi webhook đơn hàng (`/api/webhooks/pancake/...`) một cách CÓ CHỦ Ý: đường đơn hàng
 * đang chạy thật và nuôi toàn bộ báo cáo doanh thu; thêm một nhánh vào đó để phục vụ tính năng
 * mới là đặt một thứ chưa chạy ổn định lên cùng một đường ống với thứ không được phép hỏng.
 *
 * BỐN LUẬT CỦA MỘT WEBHOOK SẢN XUẤT, giống hệt webhook Viettel Post đang chạy:
 *   • Xác thực bằng bí mật trong URL (Pancake không ký gói tin). Chưa cấu hình bí mật ⇒ 401,
 *     KHÔNG phải mở toang.
 *   • Trả HTTP 200 trong dưới một giây: ghi vào hộp thư đến rồi xử lý ở `after()`.
 *   • Idempotent: cùng một tin nhắn gửi lại bao nhiêu lần cũng chỉ ra một dòng.
 *   • Không bao giờ nuốt lặng: gói tin không nhận dạng được vẫn được lưu để mở ra đọc.
 */
import { NextResponse, after, type NextRequest } from "next/server";
import { aiEnv } from "@/lib/ai-workforce/config";
import { recordAiError } from "@/lib/ai-workforce/events";
import { ingestChatWebhook, normalizeChatWebhook } from "@/lib/ai-workforce/agents/sales/ingest";
import { drainSalesTasks } from "@/lib/ai-workforce/agents/sales/pipeline";
import { parseWebhookBody, storeWebhook, webhookDedupeKey, markWebhook } from "@/lib/integrations/pancake/webhook";

export const dynamic = "force-dynamic";

function secretOk(secret: string) {
  const expected = aiEnv.chatWebhookSecret;
  return Boolean(expected) && secret === expected;
}

export async function POST(request: NextRequest, context: { params: Promise<{ secret: string }> }) {
  const { secret } = await context.params;
  if (!secretOk(secret)) return NextResponse.json({ ok: false, error: "Sai bí mật webhook" }, { status: 401 });

  const text = await request.text();
  let payload: Record<string, unknown>;
  try {
    payload = parseWebhookBody(text);
  } catch {
    return NextResponse.json({ ok: false, error: "Body không phải JSON" }, { status: 400 });
  }

  const normalized = normalizeChatWebhook(payload);
  const headers: Record<string, string> = {};
  for (const key of ["user-agent", "x-forwarded-for", "content-type"]) {
    const value = request.headers.get(key);
    if (value) headers[key] = value;
  }
  // Danh tính nghiệp vụ của gói tin chat là MÃ TIN NHẮN: Pancake đẩy lại cùng một tin thì đây là
  // cùng một sự việc, dù mốc nhận khác nhau.
  const stored = await storeWebhook("PANCAKE_CHAT", "chat.message", normalized.ok ? normalized.message.externalId : null, payload, headers, {
    dedupeKey: normalized.ok ? webhookDedupeKey("PANCAKE_CHAT", [normalized.conversation.externalId, normalized.message.externalId]) : null,
    occurredAt: normalized.ok ? normalized.message.sentAt : null,
  });

  after(async () => {
    try {
      const result = await ingestChatWebhook(payload);
      await markWebhook(stored.id, result.conversationId ? "PROCESSED" : "IGNORED", result.reason);
      // Chạy dây chuyền ngay sau khi nạp: ở nấc SHADOW việc này chỉ sinh ra một GỢI Ý trong ERP.
      if (result.conversationId) await drainSalesTasks(5);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markWebhook(stored.id, "FAILED", message);
      await recordAiError({ scope: "WEBHOOK", agentKey: "sales", message });
    }
  });

  return NextResponse.json({ ok: true, id: stored.id, duplicate: stored.duplicate, recognized: normalized.ok });
}

export async function GET(_request: NextRequest, context: { params: Promise<{ secret: string }> }) {
  const { secret } = await context.params;
  if (!secretOk(secret)) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true, message: "Webhook hội thoại Pancake sẵn sàng. Pancake sẽ POST tin nhắn vào URL này." });
}

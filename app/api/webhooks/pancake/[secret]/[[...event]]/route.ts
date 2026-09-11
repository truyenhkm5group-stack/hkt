import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { scheduleAlertEvaluation } from "@/lib/alerts/rules";
import { staleMemo } from "@/lib/cache";
import { env } from "@/lib/env";
import { str } from "@/lib/integrations/http";
import { detectKind, parseWebhookBody, processPancakeWebhook, storeWebhook, webhookDedupeKey } from "@/lib/integrations/pancake/webhook";

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
  // Danh tính gói tin gồm cả mốc cập nhật: Pancake đẩy lại NGUYÊN bản ghi mỗi lần đơn đổi, nên
  // chống trùng chỉ theo id sẽ nuốt mất các lần cập nhật sau. Thiếu mốc thì không chống trùng.
  const updatedAt = str(payload.updated_at, payload.updated_at_external, payload.last_update_status_at) || null;
  const stored = await storeWebhook("PANCAKE", kind, externalId, payload, headers, {
    dedupeKey: webhookDedupeKey("PANCAKE", [kind, externalId, updatedAt]),
    occurredAt: updatedAt ? new Date(updatedAt) : null,
  });
  after(async () => {
    const outcome = await processPancakeWebhook(stored.id);
    /*
      CHỈ KHI CÓ GÌ ĐỔI, VÀ CHỈ ĐÁNH DẤU CŨ.

      Pancake đẩy lại NGUYÊN bản ghi mỗi lần đơn đổi, thường vài lần cho một đơn, và gói tin lặp thì
      không ghi gì. Xoá hẳn đệm sau MỌI gói tin là san phẳng đệm liên tục trong giờ cao điểm — không
      ai đang chờ webhook, nên đúng ngữ nghĩa là "đánh dấu cũ" (lib/cache.ts).
    */
    if (outcome.changed) {
      staleMemo();
      scheduleAlertEvaluation();
    }
  });
  return NextResponse.json({ ok: true, received: kind, id: stored.id, duplicate: stored.duplicate });
}

export async function GET(_request: NextRequest, context: { params: Promise<{ secret: string; event?: string[] }> }) {
  const { secret } = await context.params;
  if (!secretOk(secret)) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true, message: "Webhook Pancake POS sẵn sàng. Pancake sẽ POST dữ liệu vào URL này." });
}

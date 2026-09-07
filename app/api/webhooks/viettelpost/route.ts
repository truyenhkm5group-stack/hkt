import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { env } from "@/lib/env";
import { asRecord, parseJsonSafeInts, str } from "@/lib/integrations/http";
import { markWebhook, storeWebhook } from "@/lib/integrations/pancake/webhook";
import { normalizeTracking } from "@/lib/integrations/viettelpost/client";
import { scheduleAlertEvaluation } from "@/lib/alerts/rules";
import { clearMemo } from "@/lib/cache";
import { applyVtpTracking } from "@/lib/integrations/viettelpost/sync";

export const dynamic = "force-dynamic";

function extractSecret(request: NextRequest, body: Record<string, unknown>) {
  const auth = request.headers.get("authorization") ?? "";
  const h = (name: string) => request.headers.get(name) ?? "";
  const q = (name: string) => request.nextUrl.searchParams.get(name) ?? "";
  return [
    str(body.TOKEN, body.token, body.secret, body.SECRET),
    h("token"), h("x-token"), h("secret"), h("x-secret"), h("x-webhook-secret"), h("x-api-key"),
    auth.replace(/^(Bearer|Token)\s+/i, ""),
    q("access_token"), q("token"), q("secret"),
  ].filter(Boolean);
}

/** Tìm bản ghi hành trình Viettel Post trong body: trực tiếp {DATA}, hoặc bọc trong gói chuyển tiếp của Pancake / bên thứ ba (tối đa 4 tầng) */
function findVtpData(body: Record<string, unknown>): Record<string, unknown> {
  const isTracking = (r: Record<string, unknown>) => ["ORDER_NUMBER", "order_number", "ORDER_STATUS", "order_status"].some((k) => k in r);
  const queue: { rec: Record<string, unknown>; depth: number }[] = [{ rec: body, depth: 0 }];
  while (queue.length) {
    const { rec, depth } = queue.shift() as { rec: Record<string, unknown>; depth: number };
    if (isTracking(rec)) return rec;
    if (depth >= 4) continue;
    for (const value of Object.values(rec)) {
      if (Array.isArray(value)) {
        for (const v of value.slice(0, 20)) if (v && typeof v === "object") queue.push({ rec: v as Record<string, unknown>, depth: depth + 1 });
      } else if (value && typeof value === "object") {
        queue.push({ rec: value as Record<string, unknown>, depth: depth + 1 });
      }
    }
  }
  return asRecord(body.DATA ?? body.data ?? body);
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
    // Gói tin bị chặn KHÔNG được ghi vào webhook_events (ai cũng POST được thì bảng sẽ phình vô
    // hạn). Nhưng im lặng hoàn toàn thì cấu hình sai secret sẽ làm mất sạch dữ liệu mà không ai
    // biết — nên để lại một dòng log tra được bằng `docker logs`.
    console.warn(`[vtp-webhook] 401 sai tham số bí mật · ua=${request.headers.get("user-agent") ?? "?"} · vận đơn=${str(asRecord(body.DATA ?? body).ORDER_NUMBER) || "?"}`);
    return NextResponse.json({ status: 401, error: true, message: "Sai tham số bí mật" }, { status: 401 });
  }

  const data = findVtpData(body);
  const record = normalizeTracking(data);
  // lưu cả body gốc để soi định dạng khi gói tin đi qua trung gian (Pancake chuyển tiếp)
  const eventId = await storeWebhook("VIETTELPOST", "tracking", record.orderNumber || null, data === body ? { DATA: data } : { DATA: data, RAW: body }, { "user-agent": request.headers.get("user-agent") ?? "", "content-type": request.headers.get("content-type") ?? "" });

  after(async () => {
    try {
      const result = await applyVtpTracking(record, "VTP_WEBHOOK", { allowCreate: true });
      await markWebhook(eventId, result ? "PROCESSED" : "IGNORED", result ? null : "Không tìm thấy vận đơn tương ứng");
      if (result) {
        clearMemo();
        scheduleAlertEvaluation();
      }
    } catch (error) {
      await markWebhook(eventId, "FAILED", error instanceof Error ? error.message : String(error));
    }
  });

  // Viettel Post yêu cầu trả HTTP 200 trong < 1 giây
  return NextResponse.json({ status: 200, error: false, message: "OK" });
}

export async function GET() {
  return NextResponse.json({ status: 200, error: false, message: "Webhook Viettel Post sẵn sàng. Viettel Post (hoặc Pancake chuyển tiếp) POST {DATA, TOKEN} vào URL này; có thể truyền secret qua ?token=… nếu bên gửi không cho nhập tham số bí mật." });
}

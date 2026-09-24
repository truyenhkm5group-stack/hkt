import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { env } from "@/lib/env";
import { asRecord, parseJsonSafeInts, str } from "@/lib/integrations/http";
import { markWebhook, storeWebhook, webhookDedupeKey } from "@/lib/integrations/pancake/webhook";
import { normalizeTracking } from "@/lib/integrations/viettelpost/client";
import { scheduleAlertEvaluation } from "@/lib/alerts/rules";
import { staleMemo } from "@/lib/cache";
import { applyVtpTracking } from "@/lib/integrations/viettelpost/sync";
import { anySecretMatches } from "@/lib/auth/secret-compare";
import { VTP_WEBHOOK_MAX_BODY_BYTES } from "@/lib/constants/webhook-limits";
import { readBodyCapped } from "@/lib/http/body-limit";

export const dynamic = "force-dynamic";

/**
 * Bí mật NGOÀI body (header / query) — đọc được TRƯỚC khi đụng tới body.
 * Viettel Post chính thức gửi `{DATA, TOKEN}` nên bí mật thường nằm TRONG body (xem `bodySecrets`);
 * đường ngoài body là cho bên chuyển tiếp không cho nhập tham số (`?token=`) hoặc gửi header.
 */
function outerSecrets(request: NextRequest) {
  const auth = request.headers.get("authorization") ?? "";
  const h = (name: string) => request.headers.get(name) ?? "";
  const q = (name: string) => request.nextUrl.searchParams.get(name) ?? "";
  return [
    h("token"), h("x-token"), h("secret"), h("x-secret"), h("x-webhook-secret"), h("x-api-key"),
    auth.replace(/^(Bearer|Token)\s+/i, ""),
    q("access_token"), q("token"), q("secret"),
  ].filter(Boolean);
}

function bodySecrets(body: Record<string, unknown>) {
  return [str(body.TOKEN, body.token, body.secret, body.SECRET)].filter(Boolean);
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
  const expected = env.viettelPost.webhookSecret;
  // THIẾU BÍ MẬT LÀ ĐÓNG CỬA, không phải mở toang. Trước đây `expected` rỗng ⇒ mọi POST nặc danh
  // đều được nhận và được phép TẠO vận đơn / đổi trạng thái — tức là ghi thẳng vào kết quả đơn.
  // scripts/install-vps.sh luôn sinh VIETTELPOST_WEBHOOK_SECRET khi cài, nên production không bao
  // giờ rơi vào nhánh này; máy dev không đặt biến thì vẫn chạy để thử webhook bằng tay.
  // Kiểm TRƯỚC khi đọc body: cửa đang đóng thì không có lý do gì để nhận một byte.
  if (!expected && process.env.NODE_ENV === "production") {
    console.error("[vtp-webhook] 503 chưa cấu hình VIETTELPOST_WEBHOOK_SECRET — từ chối mọi gói tin");
    return NextResponse.json({ status: 503, error: true, message: "Chưa cấu hình tham số bí mật webhook" }, { status: 503 });
  }
  // Bí mật ngoài body kiểm TRƯỚC; bí mật trong body (`TOKEN` — cách Viettel Post gửi) buộc phải đọc
  // body, nên body đọc CÓ TRẦN (lib/constants/webhook-limits.ts) — trước đây đọc + parse TOÀN BỘ
  // body của bất kỳ ai rồi mới hỏi bí mật. Trần 1 MB không làm chậm đường nóng: gói thật vài KB.
  const outerOk = expected ? anySecretMatches(outerSecrets(request), expected) : true;
  const read = await readBodyCapped(request, VTP_WEBHOOK_MAX_BODY_BYTES);
  if (!read.ok) {
    console.warn(`[vtp-webhook] 413 ${read.reason} · ua=${request.headers.get("user-agent") ?? "?"}`);
    return NextResponse.json({ status: 413, error: true, message: read.reason }, { status: 413 });
  }
  let body: Record<string, unknown>;
  try {
    body = asRecord(parseJsonSafeInts(read.text));
  } catch {
    return NextResponse.json({ status: 400, error: true, message: "Body không phải JSON" }, { status: 400 });
  }

  if (expected && !outerOk && !anySecretMatches(bodySecrets(body), expected)) {
    // Gói tin bị chặn KHÔNG được ghi vào webhook_events (ai cũng POST được thì bảng sẽ phình vô
    // hạn). Nhưng im lặng hoàn toàn thì cấu hình sai secret sẽ làm mất sạch dữ liệu mà không ai
    // biết — nên để lại một dòng log tra được bằng `docker logs`.
    console.warn(`[vtp-webhook] 401 sai tham số bí mật · ua=${request.headers.get("user-agent") ?? "?"} · vận đơn=${str(asRecord(body.DATA ?? body).ORDER_NUMBER) || "?"}`);
    return NextResponse.json({ status: 401, error: true, message: "Sai tham số bí mật" }, { status: 401 });
  }

  const data = findVtpData(body);
  const record = normalizeTracking(data);
  // lưu cả body gốc để soi định dạng khi gói tin đi qua trung gian (Pancake chuyển tiếp)
  // Viettel Post thử lại tối đa 5 lần cho CÙNG một sự việc. Danh tính của sự việc là
  // mã vận đơn + trạng thái + MỐC CỦA ĐVVC — không phải thời điểm ERP nhận được gói tin.
  // Lần gửi lại chỉ tăng delivery_count trên dòng cũ rồi vẫn được xử lý lại (xử lý idempotent),
  // nên nếu lần đầu hỏng thì lần gửi lại còn cơ hội chữa.
  const occurredAt = record.statusDate ?? null;
  const stored = await storeWebhook(
    "VIETTELPOST",
    "tracking",
    record.orderNumber || null,
    data === body ? { DATA: data } : { DATA: data, RAW: body },
    { "user-agent": request.headers.get("user-agent") ?? "", "content-type": request.headers.get("content-type") ?? "" },
    {
      dedupeKey: webhookDedupeKey("VIETTELPOST", [record.orderNumber, record.status ?? record.statusName, occurredAt?.toISOString()]),
      occurredAt,
    },
  );
  const eventId = stored.id;

  after(async () => {
    try {
      const result = await applyVtpTracking(record, "VTP_WEBHOOK", { allowCreate: true });
      // PROCESSED phải có nghĩa là ĐÃ ÁP DỤNG. Gói tin lặp hay gói tin đến muộn vẫn được lưu và
      // vẫn vào lịch sử hành trình, nhưng không được đếm như đã cập nhật trạng thái — nếu không
      // thì con số "đã xử lý" trên trang Kết nối dữ liệu che mất webhook không đổi được gì.
      const note =
        !result ? "Không tìm thấy vận đơn tương ứng"
        : result.reason === "duplicate" ? "Gói tin lặp — trạng thái đã đúng, không cần cập nhật"
        : result.reason === "stale" ? "Sự kiện của Viettel Post cũ hơn trạng thái đang lưu — giữ trạng thái mới hơn, đã ghi vào lịch sử"
        : null;
      const retryNote = stored.duplicate ? `Viettel Post gửi lại lần ${stored.deliveryCount}` : null;
      await markWebhook(eventId, result?.changed ? "PROCESSED" : "IGNORED", [note, retryNote].filter(Boolean).join(" · ") || null);
      if (result?.changed) {
        // Không ai ngồi chờ webhook: đánh dấu đệm cũ để người đang mở trang nhận số ngay và được
        // kéo lên số mới khi lượt tính lại xong — thay vì bắt họ trả giá lượt tính nguội.
        staleMemo();
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

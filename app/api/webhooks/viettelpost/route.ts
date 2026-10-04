import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { env } from "@/lib/env";
import { asRecord, parseJsonSafeInts, str } from "@/lib/integrations/http";
import { acceptVtpWebhook, applyAcceptedVtpWebhook, vtpOrderNumberOf } from "@/lib/integrations/viettelpost/webhook-core";
import { anySecretMatches } from "@/lib/auth/secret-compare";
import { VTP_WEBHOOK_MAX_BODY_BYTES } from "@/lib/constants/webhook-limits";
import { readBodyCapped } from "@/lib/http/body-limit";
import { bindOrganization } from "@/lib/platform/background";
import { withOrganization } from "@/lib/platform/context";
import { resolveWebhookOrganization } from "@/lib/platform/webhooks";

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

/**
 * Webhook không có phiên: tổ chức phân giải TƯỜNG MINH theo `WEBHOOK_BINDINGS` rồi bọc TOÀN BỘ
 * phần xử lý — kể cả việc sau phản hồi — trong `withOrganization` (audit ISO-07 · hợp đồng mục 8).
 */
export async function POST(request: NextRequest) {
  return withOrganization(await resolveWebhookOrganization("VIETTELPOST"), () => handlePost(request));
}

async function handlePost(request: NextRequest) {
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
    console.warn(`[vtp-webhook] 401 sai tham số bí mật · ua=${request.headers.get("user-agent") ?? "?"} · vận đơn=${vtpOrderNumberOf(body)}`);
    return NextResponse.json({ status: 401, error: true, message: "Sai tham số bí mật" }, { status: 401 });
  }

  const accepted = await acceptVtpWebhook(body, { userAgent: request.headers.get("user-agent") ?? "", contentType: request.headers.get("content-type") ?? "" });
  after(await bindOrganization(() => applyAcceptedVtpWebhook(accepted)));

  // Viettel Post yêu cầu trả HTTP 200 trong < 1 giây
  return NextResponse.json({ status: 200, error: false, message: "OK" });
}

export async function GET() {
  return NextResponse.json({ status: 200, error: false, message: "Webhook Viettel Post sẵn sàng. Viettel Post (hoặc Pancake chuyển tiếp) POST {DATA, TOKEN} vào URL này; có thể truyền secret qua ?token=… nếu bên gửi không cho nhập tham số bí mật." });
}

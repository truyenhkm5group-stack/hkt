/**
 * ═══════════ WEBHOOK SEPAY — BIẾN ĐỘNG SỐ DƯ REALTIME ═══════════
 *
 * Tài liệu: https://docs.sepay.vn/tich-hop-webhooks.html
 *
 * ─── TẠI SAO XỬ LÝ ĐỒNG BỘ, KHÁC WEBHOOK VIETTEL POST ───
 *
 * Viettel Post đòi HTTP 200 trong dưới 1 giây nên phải đẩy việc sang `after()`. SePay cho 30 giây và
 * — quan trọng hơn — SePay THỬ LẠI khi nhận 5xx (7 lần, giãn Fibonacci, tối đa 5 giờ). Trả 200 rồi
 * mới ghi sổ ở nền là vứt bỏ chính cơ chế thử lại đó: ghi hỏng thì gói tin mất luôn, và sổ thiếu
 * tiền mà không ai biết.
 *
 * Nên phần GHI SỔ chạy đồng bộ (2–3 câu lệnh có chỉ mục, vài mili giây) và lỗi tạm thời trả 5xx để
 * SePay gửi lại. Chỉ những việc KHÔNG được phép làm hỏng một gói tin đã ghi xong mới đẩy sang
 * `after()`: gán nhãn theo quy tắc và làm cũ bộ đệm báo cáo.
 *
 * ─── BYTE GỐC ───
 *
 * Chữ ký HMAC ký trên `{timestamp}.{raw_body}`. Route Handler của Next không tự parse body, nên
 * `request.text()` cho đúng byte gốc — nhưng phải đọc TRƯỚC và chỉ parse JSON từ chính chuỗi đó.
 * `JSON.stringify` lại đối tượng đã parse sẽ đổi thứ tự khoá và khoảng trắng ⇒ chữ ký luôn sai.
 */
import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { getDb } from "@/db";
import { staleMemo } from "@/lib/cache";
import { env } from "@/lib/env";
import { applyBankRules } from "@/lib/integrations/bank/apply-rules";
import { ingestSepayTransaction } from "@/lib/integrations/bank/sepay-ingest";
import {
  parseSepayPayload,
  SEPAY_SIGNATURE_HEADER,
  SEPAY_TIMESTAMP_HEADER,
  verifySepayRequest,
} from "@/lib/integrations/bank/sepay";
import { markWebhook, storeWebhook, webhookDedupeKey, type WebhookStatus } from "@/lib/integrations/pancake/webhook";

export const dynamic = "force-dynamic";

/** SePay coi là thành công khi nhận 200/201 kèm `{"success": true}`. */
function ok(extra: Record<string, unknown> = {}) {
  return NextResponse.json({ success: true, ...extra });
}

function fail(status: number, message: string) {
  return NextResponse.json({ success: false, message }, { status });
}

export async function POST(request: NextRequest) {
  // 1 ─ BYTE GỐC trước mọi thứ khác.
  const rawBody = await request.text();

  // 2 ─ XÁC THỰC. Gói tin không qua được KHÔNG được lưu: ai cũng POST được thì bảng sự kiện phình
  //     vô hạn. Nhưng im lặng hoàn toàn thì cấu hình sai secret sẽ làm mất sạch dữ liệu mà không ai
  //     biết — nên để lại một dòng log tra được bằng `docker logs`, tuyệt đối không in chữ ký/secret.
  const auth = verifySepayRequest({
    secret: env.sepay.webhookSecret,
    apiKey: env.sepay.webhookApiKey,
    signature: request.headers.get(SEPAY_SIGNATURE_HEADER),
    timestamp: request.headers.get(SEPAY_TIMESTAMP_HEADER),
    authorization: request.headers.get("authorization"),
    rawBody,
  });
  if (!auth.ok) {
    console.warn(`[sepay-webhook] 401 ${auth.reason} · ua=${request.headers.get("user-agent") ?? "?"} · ${rawBody.length} byte`);
    return fail(401, auth.reason);
  }

  // 3 ─ ĐỌC JSON.
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.warn("[sepay-webhook] 400 body không phải JSON");
    return fail(400, "Body không phải JSON");
  }

  const parsed = parseSepayPayload(payload);

  // 4 ─ LƯU BẰNG CHỨNG NGAY KHI ĐÃ XÁC THỰC, kể cả khi gói tin sai định dạng.
  //     Gói tin đã chứng minh được nguồn gốc là gói tin thật; vứt nó đi vì ERP chưa đọc được là mất
  //     tiền thật. `dedupeKey` theo `id` của SePay nên 7 lần gửi lại chỉ là một dòng, đếm delivery.
  const providerTxnId = parsed.ok ? parsed.txn.providerTxnId : String((payload as Record<string, unknown>)?.id ?? "");
  const stored = await storeWebhook(
    "SEPAY",
    "bank_transaction",
    providerTxnId || null,
    payload,
    {
      "user-agent": request.headers.get("user-agent") ?? "",
      "content-type": request.headers.get("content-type") ?? "",
      // Cố ý KHÔNG lưu Authorization / X-SePay-Signature: chúng là bí mật, không phải bằng chứng.
      "x-sepay-auth-method": auth.method,
    },
    {
      dedupeKey: webhookDedupeKey("SEPAY", ["bank_transaction", providerTxnId]),
      occurredAt: parsed.ok ? parsed.txn.txnAt : null,
    },
  );

  if (!parsed.ok) {
    await markWebhook(stored.id, "FAILED", parsed.error);
    console.warn(`[sepay-webhook] 400 ${parsed.error}`);
    return fail(400, parsed.error);
  }

  // 5 ─ GHI SỔ. Lỗi ở đây là lỗi TẠM THỜI ⇒ 5xx để SePay gửi lại; ghi lại đúng lý do vào sự kiện.
  let outcome;
  try {
    outcome = await ingestSepayTransaction(await getDb(), parsed.txn);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markWebhook(stored.id, "FAILED", message);
    console.error(`[sepay-webhook] 500 ghi sổ hỏng · id=${parsed.txn.providerTxnId} · ${message}`);
    return fail(500, "Chưa ghi được vào sổ, hãy gửi lại");
  }

  const notes = [
    stored.duplicate ? `SePay gửi lại lần ${stored.deliveryCount}` : null,
    outcome.duplicate && !stored.duplicate ? "Giao dịch đã có trong sổ (sao kê đã nhập trước)" : null,
    outcome.accountUnmapped ? "Tài khoản ngân hàng chưa được xác nhận" : null,
    outcome.duplicateSuspect ? "Nghi trùng: có dòng khác cùng tài khoản/số tiền/phút" : null,
    outcome.conflict ? `Mâu thuẫn nguồn: ${outcome.conflict}` : null,
  ].filter(Boolean);

  // ACCOUNT_UNMAPPED là trạng thái riêng để đếm được ở trang Kết nối dữ liệu — tiền VẪN vào sổ, chỉ
  // là tài khoản chưa được đặt tên. IGNORED dành cho gói tin không đổi gì (gửi lại).
  const status: WebhookStatus = outcome.accountUnmapped ? "ACCOUNT_UNMAPPED" : outcome.created ? "PROCESSED" : "IGNORED";
  await markWebhook(stored.id, status, notes.join(" · ") || null);

  // 6 ─ Việc nặng và việc không được phép làm hỏng một gói tin đã ghi xong.
  if (outcome.created) {
    const transactionId = outcome.transactionId;
    after(async () => {
      try {
        await applyBankRules(await getDb(), { ids: [transactionId] });
        // Không ai ngồi chờ webhook: đánh dấu đệm cũ để người đang mở trang được kéo lên số mới.
        staleMemo();
      } catch (error) {
        console.error(`[sepay-webhook] gán nhãn hỏng cho ${transactionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  return ok({
    transactionId: outcome.transactionId,
    created: outcome.created,
    duplicate: outcome.duplicate,
  });
}

/** Bấm thử URL trên trình duyệt phải nói được endpoint sống hay chưa cấu hình. */
export async function GET() {
  return NextResponse.json({
    success: true,
    message: env.sepay.webhookSecret
      ? "Webhook SePay sẵn sàng (HMAC-SHA256)."
      : env.sepay.webhookApiKey
        ? "Webhook SePay sẵn sàng (API key). Nên chuyển sang HMAC-SHA256 cho production."
        : "Chưa cấu hình SEPAY_WEBHOOK_SECRET — mọi gói tin sẽ bị từ chối 401.",
  });
}

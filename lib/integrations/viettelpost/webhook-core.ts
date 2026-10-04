import { scheduleAlertEvaluation } from "@/lib/alerts/rules";
import { staleMemo } from "@/lib/cache";
import { asRecord, str } from "@/lib/integrations/http";
import { markWebhook, storeWebhook, webhookDedupeKey } from "@/lib/integrations/pancake/webhook";
import { normalizeTracking } from "@/lib/integrations/viettelpost/client";
import { applyVtpTracking } from "@/lib/integrations/viettelpost/sync";

/**
 * ═══════════ WEBHOOK VIETTEL POST — LÕI DÙNG CHUNG (route của nhà + route theo tổ chức · F2 Fashion COD) ═══════════
 *
 * Hai route chỉ khác nhau ở CÁCH XÁC THỰC (nhà: bí mật môi trường ở header / query / body; tổ chức khách: token HMAC trong
 * đường dẫn). Từ lúc đã biết gói tin của ai, mọi thứ đi qua đây: tìm bản ghi hành trình trong body, lưu với khoá chống trùng
 * (vận đơn, trạng thái, mốc ĐVVC), rồi áp bằng `applyVtpTracking` — một luật, không hai bản.
 */

/** Tìm bản ghi hành trình Viettel Post trong body: trực tiếp {DATA}, hoặc bọc trong gói chuyển tiếp của Pancake / bên thứ ba (tối đa 4 tầng) */
export function findVtpData(body: Record<string, unknown>): Record<string, unknown> {
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

export type AcceptedVtpWebhook = { eventId: string; record: ReturnType<typeof normalizeTracking>; duplicate: boolean; deliveryCount: number };

/** Lưu gói tin (trong ngữ cảnh tổ chức ĐÃ phân giải) — trả việc cần áp sau phản hồi. */
export async function acceptVtpWebhook(body: Record<string, unknown>, headers: { userAgent: string; contentType: string }): Promise<AcceptedVtpWebhook> {
  const data = findVtpData(body);
  const record = normalizeTracking(data);
  const occurredAt = record.statusDate ?? null;
  const stored = await storeWebhook(
    "VIETTELPOST",
    "tracking",
    record.orderNumber || null,
    data === body ? { DATA: data } : { DATA: data, RAW: body },
    { "user-agent": headers.userAgent, "content-type": headers.contentType },
    {
      dedupeKey: webhookDedupeKey("VIETTELPOST", [record.orderNumber, record.status ?? record.statusName, occurredAt?.toISOString()]),
      occurredAt,
    },
  );
  return { eventId: stored.id, record, duplicate: stored.duplicate, deliveryCount: stored.deliveryCount };
}

/** Áp gói tin đã lưu (chạy sau phản hồi — Viettel Post đòi HTTP 200 trong < 1 giây). Không ném: lỗi ghi vào dòng webhook. */
export async function applyAcceptedVtpWebhook(accepted: AcceptedVtpWebhook): Promise<void> {
  try {
    const result = await applyVtpTracking(accepted.record, "VTP_WEBHOOK", { allowCreate: true });
    // PROCESSED phải có nghĩa là ĐÃ ÁP DỤNG. Gói tin lặp hay gói tin đến muộn vẫn được lưu và
    // vẫn vào lịch sử hành trình, nhưng không được đếm như đã cập nhật trạng thái — nếu không
    // thì con số "đã xử lý" trên trang Kết nối dữ liệu che mất webhook không đổi được gì.
    const note =
      !result ? "Không tìm thấy vận đơn tương ứng"
      : result.reason === "duplicate" ? "Gói tin lặp — trạng thái đã đúng, không cần cập nhật"
      : result.reason === "stale" ? "Sự kiện của Viettel Post cũ hơn trạng thái đang lưu — giữ trạng thái mới hơn, đã ghi vào lịch sử"
      : null;
    const retryNote = accepted.duplicate ? `Viettel Post gửi lại lần ${accepted.deliveryCount}` : null;
    await markWebhook(accepted.eventId, result?.changed ? "PROCESSED" : "IGNORED", [note, retryNote].filter(Boolean).join(" · ") || null);
    if (result?.changed) {
      // Không ai ngồi chờ webhook: đánh dấu đệm cũ để người đang mở trang nhận số ngay và được
      // kéo lên số mới khi lượt tính lại xong — thay vì bắt họ trả giá lượt tính nguội.
      staleMemo();
      scheduleAlertEvaluation();
    }
  } catch (error) {
    await markWebhook(accepted.eventId, "FAILED", error instanceof Error ? error.message : String(error));
  }
}

/** Mã vận đơn trong body (cho dòng nhật ký khi từ chối) — không ném. */
export function vtpOrderNumberOf(body: Record<string, unknown>): string {
  return str(asRecord(body.DATA ?? body).ORDER_NUMBER) || "?";
}

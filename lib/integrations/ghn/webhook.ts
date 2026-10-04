import { and, eq, or } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { staleMemo } from "@/lib/cache";
import { carrierStatusMeta } from "@/lib/constants/carrier-status";
import { markWebhook, storeWebhook, webhookDedupeKey } from "@/lib/integrations/pancake/webhook";
import { materializeShipmentState } from "@/lib/integrations/viettelpost/state";

/**
 * ═══════════ WEBHOOK TRẠNG THÁI GHN CỦA TỔ CHỨC (POS tự chủ · ORDER_OUTCOME.md mục 4.1) ═══════════
 *
 * Gói GHN (tài liệu «Order Status Callback»): JSON PascalCase, mọi trường luôn có mặt; chống trùng bằng `OrderCode + Type +
 * Time` (đúng khoá tài liệu khuyên); thứ tự giao FIFO theo đơn; 4xx (trừ 408/429) GHN BỎ HẲN, không gửi lại — nên route chỉ
 * trả 4xx khi token sai (gói không bao giờ thuộc ai).
 *
 * Áp vào vận đơn:
 *  · CHỈ vận đơn ERP đã tạo bằng GHN (`carrier = 'GHN'`), khớp theo mã GHN (`tracking_code`) hoặc mã ERP của lần gửi
 *    (`ClientOrderCode` = `order_reference`) — gói `create` bắn ngay lúc tạo, có thể tới TRƯỚC khi lõi kịp ghi mã GHN. Không
 *    khớp ⇒ lưu gói, KHÔNG dựng vận đơn mồ côi (đơn GHN tạo ngoài ERP không thuộc ERP).
 *  · Sự kiện `shipment_events` nguồn `GHN_WEBHOOK`: `status` = mã CỦA GHN nguyên văn, chặng + chiều tra bảng
 *    `lib/constants/carrier-status.ts` (mã lạ ⇒ chặng UNKNOWN, lưu, không kết luận). Mốc = `Time` của GHN.
 *  · Chặng vận đơn dựng lại bằng ĐÚNG `materializeShipmentState` (SHIPMENT_STAGE_WRITERS) — webhook KHÔNG ghi `stage`.
 *  · Tiền: `CODAmount` của gói là số GHN ĐỊNH thu, không phải số thực thu (mục 8) — không ghi vào `cod_collected`.
 */

export type GhnCallback = {
  orderCode: string;
  clientOrderCode: string;
  type: string;
  status: string;
  time: Date | null;
  reason: string;
};

const STATUS_TYPES = new Set(["create", "switch_status"]);

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

export function parseGhnCallback(body: Record<string, unknown>): GhnCallback {
  const t = str(body.Time);
  const time = t ? new Date(t) : null;
  return {
    orderCode: str(body.OrderCode),
    clientOrderCode: str(body.ClientOrderCode),
    type: str(body.Type),
    status: str(body.Status),
    time: time && Number.isFinite(time.getTime()) ? time : null,
    reason: str(body.Reason),
  };
}

export type AcceptedGhnWebhook = { eventId: string; callback: GhnCallback; duplicate: boolean; deliveryCount: number };

/** Lưu gói tin (trong ngữ cảnh tổ chức ĐÃ phân giải) — trả việc cần áp sau phản hồi. */
export async function acceptGhnWebhook(body: Record<string, unknown>, headers: { userAgent: string; contentType: string }): Promise<AcceptedGhnWebhook> {
  const callback = parseGhnCallback(body);
  const stored = await storeWebhook("GHN", callback.type || "unknown", callback.orderCode || null, body, { "user-agent": headers.userAgent, "content-type": headers.contentType }, {
    dedupeKey: webhookDedupeKey("GHN", [callback.orderCode, callback.type, callback.time?.toISOString()]),
    occurredAt: callback.time,
  });
  return { eventId: stored.id, callback, duplicate: stored.duplicate, deliveryCount: stored.deliveryCount };
}

export type GhnApplyResult = { applied: boolean; note: string };

/** Áp MỘT gói vào vận đơn GHN của ERP. Không ném vì dữ liệu lạ — trả lý do. */
export async function applyGhnCallback(cb: GhnCallback, raw: Record<string, unknown>): Promise<GhnApplyResult> {
  if (!STATUS_TYPES.has(cb.type) || !cb.status) return { applied: false, note: `Gói «${cb.type || "?"}» không mang trạng thái vận đơn — chỉ lưu.` };
  if (!cb.orderCode && !cb.clientOrderCode) return { applied: false, note: "Gói không có mã đơn GHN lẫn mã ERP." };
  if (!cb.time) return { applied: false, note: "Gói không có mốc thời gian (Time) — không dựng được hành trình." };
  const db = await getDb();
  const s = schema.shipments;
  const keys = [cb.orderCode ? eq(s.trackingCode, cb.orderCode) : null, cb.clientOrderCode ? eq(s.orderReference, cb.clientOrderCode) : null].filter((x) => x !== null);
  const [ship] = await db
    .select({ id: s.id, trackingCode: s.trackingCode })
    .from(s)
    .where(and(eq(s.carrier, "GHN"), or(...keys)))
    .limit(1);
  if (!ship) return { applied: false, note: `Không có vận đơn GHN nào của ERP mang mã ${cb.orderCode || cb.clientOrderCode} — đơn tạo ngoài ERP, chỉ lưu gói.` };
  // Gói tới trước khi lõi kịp ghi mã GHN vào chỗ giữ ⇒ ghi mã ngay (mã do CHÍNH GHN gửi, khớp mã ERP của lần gửi).
  if (!ship.trackingCode && cb.orderCode) await db.update(s).set({ trackingCode: cb.orderCode, updatedAt: new Date() }).where(eq(s.id, ship.id));
  const meta = carrierStatusMeta("GHN_WEBHOOK", cb.status);
  const inserted = await db
    .insert(schema.shipmentEvents)
    .values({
      shipmentId: ship.id,
      source: "GHN_WEBHOOK",
      status: cb.status,
      statusName: meta?.name ?? cb.status,
      note: cb.reason,
      occurredAt: cb.time,
      normalizedStage: meta?.stage ?? "UNKNOWN",
      legType: meta?.leg ?? "UNKNOWN",
      raw,
    })
    .onConflictDoNothing()
    .returning({ id: schema.shipmentEvents.id });
  const state = await materializeShipmentState(db, ship.id);
  if (!inserted.length) return { applied: false, note: "Gói lặp — sự kiện đã có trong hành trình." };
  return { applied: state.changed, note: meta ? (state.changed ? `Chặng → ${state.after}` : "Đã ghi vào hành trình, chặng không đổi (sự kiện cũ hơn trạng thái đang lưu)") : `Mã «${cb.status}» chưa có trong bảng GHN — lưu, không kết luận.` };
}

/** Áp gói tin đã lưu (chạy sau phản hồi). Không ném: lỗi ghi vào dòng webhook. */
export async function applyAcceptedGhnWebhook(accepted: AcceptedGhnWebhook, raw: Record<string, unknown>): Promise<void> {
  try {
    const r = await applyGhnCallback(accepted.callback, raw);
    const retryNote = accepted.duplicate ? `GHN gửi lại lần ${accepted.deliveryCount}` : null;
    await markWebhook(accepted.eventId, r.applied ? "PROCESSED" : "IGNORED", [r.note, retryNote].filter(Boolean).join(" · ") || null);
    if (r.applied) staleMemo();
  } catch (error) {
    await markWebhook(accepted.eventId, "FAILED", error instanceof Error ? error.message : String(error));
  }
}

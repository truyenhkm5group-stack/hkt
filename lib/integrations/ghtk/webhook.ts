import { and, eq, or } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { staleMemo } from "@/lib/cache";
import { carrierStatusMeta } from "@/lib/constants/carrier-status";
import { markWebhook, storeWebhook, webhookDedupeKey } from "@/lib/integrations/pancake/webhook";
import { materializeShipmentState } from "@/lib/integrations/viettelpost/state";

/**
 * ═══════════ WEBHOOK TRẠNG THÁI GHTK CỦA TỔ CHỨC (POS tự chủ · ORDER_OUTCOME.md mục 4.1) ═══════════
 *
 * Gói GHTK (tài liệu «Webhook»): POST `application/x-www-form-urlencoded` với `label_id` (mã GHTK) · `partner_id` (mã ERP của
 * lần gửi) · `status_id` · `action_time` (ISO, giờ VN) · `reason_code` · `reason` · `weight` · `fee` · `pick_money` ·
 * `return_part_package`. Không phải 200 ⇒ GHTK gửi lại MỘT lần. Chống trùng bằng `label_id + status_id + action_time`.
 *
 * Áp vào vận đơn — cùng khuôn với GHN:
 *  · CHỈ vận đơn ERP đã tạo bằng GHTK (`carrier = 'GHTK'`), khớp theo mã GHTK (`tracking_code`) hoặc mã ERP của lần gửi
 *    (`partner_id` = `order_reference`). Không khớp ⇒ lưu gói, KHÔNG dựng vận đơn mồ côi.
 *  · Sự kiện `shipment_events` nguồn `GHTK_WEBHOOK`: `status` = mã CỦA GHTK nguyên văn, chặng + chiều tra bảng
 *    `lib/constants/carrier-status.ts` (mã lạ — vd 45/49/123 «shipper báo» — ⇒ chặng UNKNOWN, lưu, không kết luận).
 *  · Chặng vận đơn dựng lại bằng ĐÚNG `materializeShipmentState` (SHIPMENT_STAGE_WRITERS) — webhook KHÔNG ghi `stage`.
 *  · Tiền: `pick_money` là số GHTK ĐỊNH thu, không phải số thực thu (mục 8) — không ghi vào `cod_collected`.
 *    `return_part_package = 1` (giao một phần) đi vào ghi chú của sự kiện để người đọc thấy; kết luận vẫn theo bảng mã.
 */

export type GhtkCallback = {
  label: string;
  partnerId: string;
  status: string;
  time: Date | null;
  reasonCode: string;
  reason: string;
  partial: boolean;
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

export function parseGhtkCallback(body: Record<string, unknown>): GhtkCallback {
  const t = str(body.action_time);
  const time = t ? new Date(t) : null;
  return {
    label: str(body.label_id),
    partnerId: str(body.partner_id),
    status: str(body.status_id),
    time: time && Number.isFinite(time.getTime()) ? time : null,
    reasonCode: str(body.reason_code),
    reason: str(body.reason),
    partial: str(body.return_part_package) === "1",
  };
}

/** Thân gói: GHTK gửi form-urlencoded; JSON cũng nhận (công cụ thử của hãng / proxy). Không đọc được ⇒ `null`. */
export function readGhtkBody(text: string, contentType: string): Record<string, unknown> | null {
  if (contentType.includes("json") || text.trim().startsWith("{")) {
    try {
      const v = JSON.parse(text) as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  /*
    Không dùng URLSearchParams: chuẩn form đổi «+» thành khoảng trắng, mà mẫu của tài liệu GHTK gửi mốc giờ có «+» TRẦN
    («action_time=2016-11-02T12:18:39+07:00») — đổi đi là «12:18:39 07:00», không đọc được mốc, gói bị bỏ. Riêng `action_time`
    giữ «+»; trường chữ (lý do…) vẫn đổi «+» thành khoảng trắng như form chuẩn.
  */
  const out: Record<string, unknown> = {};
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  for (const pair of text.split("&")) {
    if (!pair) continue;
    const at = pair.indexOf("=");
    const key = decode((at < 0 ? pair : pair.slice(0, at)).replace(/\+/g, " ")).trim();
    const raw = at < 0 ? "" : pair.slice(at + 1);
    if (key) out[key] = key === "action_time" ? decode(raw) : decode(raw.replace(/\+/g, " "));
  }
  return Object.keys(out).length ? out : null;
}

export type AcceptedGhtkWebhook = { eventId: string; callback: GhtkCallback; duplicate: boolean; deliveryCount: number };

/** Lưu gói tin (trong ngữ cảnh tổ chức ĐÃ phân giải) — trả việc cần áp sau phản hồi. */
export async function acceptGhtkWebhook(body: Record<string, unknown>, headers: { userAgent: string; contentType: string }): Promise<AcceptedGhtkWebhook> {
  const callback = parseGhtkCallback(body);
  const stored = await storeWebhook("GHTK", callback.status ? `status_${callback.status}` : "unknown", callback.label || null, body, { "user-agent": headers.userAgent, "content-type": headers.contentType }, {
    dedupeKey: webhookDedupeKey("GHTK", [callback.label || callback.partnerId, callback.status, callback.time?.toISOString()]),
    occurredAt: callback.time,
  });
  return { eventId: stored.id, callback, duplicate: stored.duplicate, deliveryCount: stored.deliveryCount };
}

export type GhtkApplyResult = { applied: boolean; note: string };

/** Áp MỘT gói vào vận đơn GHTK của ERP. Không ném vì dữ liệu lạ — trả lý do. */
export async function applyGhtkCallback(cb: GhtkCallback, raw: Record<string, unknown>): Promise<GhtkApplyResult> {
  if (!cb.status) return { applied: false, note: "Gói không mang status_id — chỉ lưu." };
  if (!cb.label && !cb.partnerId) return { applied: false, note: "Gói không có mã GHTK lẫn mã ERP." };
  if (!cb.time) return { applied: false, note: "Gói không có mốc thời gian (action_time) — không dựng được hành trình." };
  const db = await getDb();
  const s = schema.shipments;
  const keys = [cb.label ? eq(s.trackingCode, cb.label) : null, cb.partnerId ? eq(s.orderReference, cb.partnerId) : null].filter((x) => x !== null);
  const [ship] = await db
    .select({ id: s.id, trackingCode: s.trackingCode })
    .from(s)
    .where(and(eq(s.carrier, "GHTK"), or(...keys)))
    .limit(1);
  if (!ship) return { applied: false, note: `Không có vận đơn GHTK nào của ERP mang mã ${cb.label || cb.partnerId} — đơn tạo ngoài ERP, chỉ lưu gói.` };
  if (!ship.trackingCode && cb.label) await db.update(s).set({ trackingCode: cb.label, updatedAt: new Date() }).where(eq(s.id, ship.id));
  const meta = carrierStatusMeta("GHTK_WEBHOOK", cb.status);
  const note = [cb.reason, cb.reasonCode ? `mã lý do ${cb.reasonCode}` : "", cb.partial ? "GHTK báo GIAO MỘT PHẦN (return_part_package = 1)" : ""].filter(Boolean).join(" · ");
  const inserted = await db
    .insert(schema.shipmentEvents)
    .values({
      shipmentId: ship.id,
      source: "GHTK_WEBHOOK",
      status: cb.status,
      statusName: meta?.name ?? cb.status,
      note,
      occurredAt: cb.time,
      normalizedStage: meta?.stage ?? "UNKNOWN",
      legType: meta?.leg ?? "UNKNOWN",
      raw,
    })
    .onConflictDoNothing()
    .returning({ id: schema.shipmentEvents.id });
  const state = await materializeShipmentState(db, ship.id);
  if (!inserted.length) return { applied: false, note: "Gói lặp — sự kiện đã có trong hành trình." };
  return { applied: state.changed, note: meta ? (state.changed ? `Chặng → ${state.after}` : "Đã ghi vào hành trình, chặng không đổi (sự kiện cũ hơn trạng thái đang lưu)") : `Mã «${cb.status}» chưa có trong bảng GHTK — lưu, không kết luận.` };
}

/** Áp gói tin đã lưu (chạy sau phản hồi). Không ném: lỗi ghi vào dòng webhook. */
export async function applyAcceptedGhtkWebhook(accepted: AcceptedGhtkWebhook, raw: Record<string, unknown>): Promise<void> {
  try {
    const r = await applyGhtkCallback(accepted.callback, raw);
    const retryNote = accepted.duplicate ? `GHTK gửi lại lần ${accepted.deliveryCount}` : null;
    await markWebhook(accepted.eventId, r.applied ? "PROCESSED" : "IGNORED", [r.note, retryNote].filter(Boolean).join(" · ") || null);
    if (r.applied) staleMemo();
  } catch (error) {
    await markWebhook(accepted.eventId, "FAILED", error instanceof Error ? error.message : String(error));
  }
}

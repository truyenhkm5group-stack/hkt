import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import type { ShipmentStage } from "@/db/schema";
import { VTP_FINAL_STATUSES } from "@/lib/constants/viettelpost";
import { eventStatusCode, resolveVtpStatus } from "@/lib/integrations/viettelpost/status";

const s = schema.shipments;
const e = schema.shipmentEvents;

/**
 * TRẠNG THÁI HIỆN TẠI CỦA VẬN ĐƠN LÀ HÀM CỦA LỊCH SỬ, KHÔNG PHẢI BIẾN BỊ GHI ĐÈ.
 *
 * Trước đây `shipments.stage` là ô nhớ mà bất kỳ luồng nào cũng ghi được: webhook, nhập tệp,
 * đồng bộ Pancake. Luồng nào chạy sau thì thắng, kể cả khi nó mang sự kiện CŨ HƠN. Hậu quả đo
 * được trên production: 30/228 vận đơn có webhook mới hơn trạng thái đang lưu, và có vận đơn giữ
 * `vtp_status = 500` (bưu tá đi phát) trong khi `stage = PENDING`.
 *
 * Nay trạng thái được TÍNH RA từ `shipment_events` theo MỐC THỜI GIAN CỦA ĐVVC:
 *  · chỉ xét sự kiện có trạng thái chuẩn hoá và có mốc thời gian hợp lệ;
 *  · sự kiện mới nhất theo `occurred_at` thắng — gói tin đến muộn không kéo lùi trạng thái;
 *  · cùng mốc thời gian thì ưu tiên nguồn đáng tin hơn (webhook > tệp > tra API > Pancake);
 *  · sự kiện trùng không đổi gì vì kết quả chỉ phụ thuộc tập sự kiện, không phụ thuộc số lần ghi.
 *
 * `shipments` giữ vai trò ẢNH CHỤP để truy vấn nhanh, được dựng lại từ lịch sử một cách xác định.
 */
export type DerivedState = {
  stage: ShipmentStage;
  isFinal: boolean;
  vtpStatus: number | null;
  vtpStatusName: string;
  vtpStatusDate: Date;
  vtpLocation: string;
  vtpNote: string;
  pickedUpAt: Date | null;
  firstDeliveryAt: Date | null;
  deliveredAt: Date | null;
  returnedAt: Date | null;
  cancelledAt: Date | null;
  /** Sự kiện quyết định trạng thái — để giải thích được vì sao ERP kết luận như vậy. */
  decidedBy: { source: string; status: string; occurredAt: Date };
};

/** Nguồn nào đáng tin hơn khi hai sự kiện cùng mốc thời gian. Cao hơn = thắng. */
const SOURCE_RANK: Record<string, number> = { VTP_WEBHOOK: 40, VTP_IMPORT: 30, VTP_POLL: 20, MANUAL: 15, PANCAKE: 10 };

/** Các mốc "lần đầu đạt tới" — giữ nguyên kể cả khi sau đó vận đơn chuyển sang trạng thái khác. */
const REACHED_PICKUP: ShipmentStage[] = ["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"];
const REACHED_DELIVERY_ATTEMPT: ShipmentStage[] = ["OUT_FOR_DELIVERY", "DELIVERED"];

function firstAt(rows: { stage: ShipmentStage; occurredAt: Date }[], stages: ShipmentStage[]): Date | null {
  const hit = rows.filter((r) => stages.includes(r.stage)).map((r) => r.occurredAt.getTime());
  return hit.length ? new Date(Math.min(...hit)) : null;
}

/** Tính trạng thái từ lịch sử. Trả null khi chưa có sự kiện nào đủ căn cứ. */
export async function deriveShipmentState(db: Db, shipmentId: string): Promise<DerivedState | null> {
  const rows = await db
    .select({ source: e.source, status: e.status, statusName: e.statusName, location: e.location, note: e.note, occurredAt: e.occurredAt, normalizedStage: e.normalizedStage, createdAt: e.createdAt })
    .from(e)
    .where(and(eq(e.shipmentId, shipmentId), isNotNull(e.occurredAt)));

  // Dịch lại bằng bộ dịch dùng chung: sự kiện cũ chưa có normalized_stage vẫn hiểu được, và mọi
  // luồng nhập liệu cho ra cùng một kết luận cho cùng một trạng thái của ĐVVC.
  const usable = rows
    .map((r) => {
      const resolved = resolveVtpStatus({ code: eventStatusCode(r.status), text: r.statusName || r.status });
      const stage = (r.normalizedStage ?? resolved.stage) as ShipmentStage;
      return { ...r, stage, resolved };
    })
    .filter((r) => r.stage !== "UNKNOWN" && r.occurredAt instanceof Date && Number.isFinite(r.occurredAt.getTime()));

  if (!usable.length) return null;

  const winner = [...usable].sort((a, b) => {
    const byTime = b.occurredAt.getTime() - a.occurredAt.getTime();
    if (byTime !== 0) return byTime;
    const bySource = (SOURCE_RANK[b.source] ?? 0) - (SOURCE_RANK[a.source] ?? 0);
    if (bySource !== 0) return bySource;
    return b.createdAt.getTime() - a.createdAt.getTime();
  })[0];

  const code = eventStatusCode(winner.status);
  return {
    stage: winner.stage,
    isFinal: code !== null ? VTP_FINAL_STATUSES.has(code) : winner.resolved.final,
    vtpStatus: code,
    vtpStatusName: winner.statusName || winner.resolved.name,
    vtpStatusDate: winner.occurredAt,
    vtpLocation: winner.location,
    vtpNote: winner.note,
    pickedUpAt: firstAt(usable, REACHED_PICKUP),
    firstDeliveryAt: firstAt(usable, REACHED_DELIVERY_ATTEMPT),
    deliveredAt: firstAt(usable, ["DELIVERED"]),
    returnedAt: firstAt(usable, ["RETURNED"]),
    cancelledAt: firstAt(usable, ["CANCELLED"]),
    decidedBy: { source: winner.source, status: winner.status, occurredAt: winner.occurredAt },
  };
}

export type MaterializeResult = { shipmentId: string; changed: boolean; before: string | null; after: string | null; reason: "no-events" | "unchanged" | "updated" };

/**
 * Ghi ảnh chụp trạng thái vào `shipments`. Idempotent: chạy lại trên cùng tập sự kiện cho cùng
 * kết quả và không báo thay đổi. KHÔNG đụng tới tiền, người nhận hay mốc kho nhận hàng hoàn —
 * đó là dữ liệu của luồng khác, không suy ra từ hành trình được.
 */
export async function materializeShipmentState(db: Db, shipmentId: string): Promise<MaterializeResult> {
  const derived = await deriveShipmentState(db, shipmentId);
  const [current] = await db
    .select({ stage: s.stage, isFinal: s.isFinal, vtpStatus: s.vtpStatus, vtpStatusDate: s.vtpStatusDate })
    .from(s)
    .where(eq(s.id, shipmentId));
  if (!derived || !current) return { shipmentId, changed: false, before: current?.stage ?? null, after: null, reason: "no-events" };

  const same =
    current.stage === derived.stage &&
    current.isFinal === derived.isFinal &&
    current.vtpStatus === derived.vtpStatus &&
    current.vtpStatusDate?.getTime() === derived.vtpStatusDate.getTime();
  if (same) return { shipmentId, changed: false, before: current.stage, after: derived.stage, reason: "unchanged" };

  await db
    .update(s)
    .set({
      stage: derived.stage,
      isFinal: derived.isFinal,
      vtpStatus: derived.vtpStatus,
      vtpStatusName: derived.vtpStatusName,
      vtpStatusDate: derived.vtpStatusDate,
      vtpLocation: derived.vtpLocation || sql`${s.vtpLocation}`,
      vtpNote: derived.vtpNote || sql`${s.vtpNote}`,
      pickedUpAt: derived.pickedUpAt,
      firstDeliveryAt: derived.firstDeliveryAt,
      deliveredAt: derived.deliveredAt,
      returnedAt: derived.returnedAt,
      cancelledAt: derived.cancelledAt,
      updatedAt: new Date(),
    })
    .where(eq(s.id, shipmentId));
  return { shipmentId, changed: true, before: current.stage, after: derived.stage, reason: "updated" };
}

/** Tiện dụng cho lớp gọi không sẵn `db`. */
export async function materializeShipment(shipmentId: string) {
  return materializeShipmentState(await getDb(), shipmentId);
}

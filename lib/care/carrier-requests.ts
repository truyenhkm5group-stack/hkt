import { and, asc, eq, gte, inArray, isNotNull, isNull, like, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { legAwareStage } from "@/lib/care/entry";
import { CARRIER_ACTION_CONFIRM_STAGES, type CarrierActionKey } from "@/lib/constants/care";
import { MANUAL_STATUSES, manualInstructionText } from "@/lib/constants/carrier-manual";
import type { CarrierRequestStatus } from "@/lib/constants/care";
import type { CarrierRequestView } from "@/lib/care/contracts";
import type { ShipmentStage } from "@/db/schema";

/**
 * MỘT phép khớp cho cả đường ghi (`settleCarrierRequests`) lẫn đường đọc
 * (`derivedManualConfirmations`): chặng ĐÃ leg-aware nằm trong tập chặng xác nhận của lệnh, và sự
 * kiện xảy ra KHÔNG SỚM HƠN mốc so. Hai bản của một luật là mở đường cho hai màn hình nói hai điều.
 */
export function confirmsCarrierAction(actionKey: string, legAware: string, eventAt: Date, from: Date | null): boolean {
  const stages = CARRIER_ACTION_CONFIRM_STAGES[actionKey as CarrierActionKey] ?? [];
  return stages.includes(legAware) && from !== null && eventAt.getTime() >= from.getTime();
}

/**
 * ───────────── ĐVVC XÁC NHẬN BẰNG SỰ KIỆN, KHÔNG BẰNG PHẢN HỒI API ─────────────
 *
 * API trả "OK" chỉ là ACKNOWLEDGED: Viettel Post đã nhận yêu cầu. Bưu tá có đi phát lại hay không thì phải
 * đợi sự kiện hành trình. Hàm này chạy mỗi khi có sự kiện mới của kiện (webhook / tra API / nhập
 * tệp): yêu cầu đang ACK mà thấy chặng khớp, xảy ra SAU lúc gửi ⇒ SUCCESS, ghi mốc xác nhận.
 *
 * Idempotent: chạy lại không đổi gì. Không bao giờ hạ SUCCESS xuống.
 *
 * CHẶNG PHẢI LEG-AWARE. "Phát thành công" (501) trên CHIỀU HOÀN là hàng về tới shop — đúng điều
 * ngược lại với thứ lệnh "phát tiếp" xin. Bản trước nhận chặng thô nên lệnh phát tiếp được ghi
 * SUCCESS khi kiện hoàn về kho. Nơi gọi nào biết cờ IS_RETURNING thì truyền `legType`; chặng đã
 * dựng từ lịch sử (`materializeShipmentState`) vốn đã leg-aware nên truyền `null` là đủ.
 *
 * LỆNH LÀM TAY CŨNG ĐƯỢC WEBHOOK XÁC MINH (`lib/constants/carrier-manual.ts`). Viettel Post không cấp
 * API cho shop nên gần như MỌI lệnh là `MANUAL_REQUIRED` / `MANUAL_DONE`, và trước đây hàm này bỏ qua
 * chúng — vòng làm tay không bao giờ khép. Với lệnh làm tay, mốc so là lúc LẬP LỆNH (người làm trên
 * web có thể làm trước khi bấm "Đã làm tay"), và chỉ đóng dấu `confirmed_at`: `status` giữ nguyên vì
 * nó là lời khai của người, còn `confirmed_at` là chứng từ ĐVVC — hai chiều không ghi đè nhau.
 */
export async function settleCarrierRequests(db: Db, shipmentId: string, stage: string, eventAt: Date, legType: "OUTBOUND" | "RETURN" | null = null): Promise<number> {
  const chang = legAwareStage(stage as ShipmentStage, legType);
  const open = await db
    .select({ id: schema.carrierActionRequests.id, actionKey: schema.carrierActionRequests.actionKey, sentAt: schema.carrierActionRequests.sentAt })
    .from(schema.carrierActionRequests)
    .where(and(eq(schema.carrierActionRequests.shipmentId, shipmentId), inArray(schema.carrierActionRequests.status, ["SENT", "ACKNOWLEDGED"]), isNotNull(schema.carrierActionRequests.sentAt)));
  const khop = (actionKey: string, from: Date | null) => confirmsCarrierAction(actionKey, chang, eventAt, from);
  const matched = open.filter((r) => khop(r.actionKey, r.sentAt));
  if (matched.length) {
    await db
      .update(schema.carrierActionRequests)
      .set({ status: "SUCCESS", confirmedAt: eventAt, finishedAt: sql`coalesce(${schema.carrierActionRequests.finishedAt}, now())` })
      .where(inArray(schema.carrierActionRequests.id, matched.map((r) => r.id)));
  }

  const manual = await db
    .select({ id: schema.carrierActionRequests.id, actionKey: schema.carrierActionRequests.actionKey, createdAt: schema.carrierActionRequests.createdAt })
    .from(schema.carrierActionRequests)
    .where(and(eq(schema.carrierActionRequests.shipmentId, shipmentId), inArray(schema.carrierActionRequests.status, [...MANUAL_STATUSES]), isNull(schema.carrierActionRequests.confirmedAt)));
  const manualMatched = manual.filter((r) => khop(r.actionKey, r.createdAt));
  if (manualMatched.length) {
    // Chỉ đóng dấu chứng từ, không đổi lời khai của người. `isNull` lặp lại: mốc đã đóng thì không
    // sự kiện nào tới sau được ghi đè nó.
    await db
      .update(schema.carrierActionRequests)
      .set({ confirmedAt: eventAt })
      .where(and(inArray(schema.carrierActionRequests.id, manualMatched.map((r) => r.id)), isNull(schema.carrierActionRequests.confirmedAt)));
  }
  return matched.length + manualMatched.length;
}

/**
 * LỆNH LÀM TAY LẬP TRƯỚC BẢN NÀY: webhook xác nhận của chúng đã tới từ trước, lúc hàm ghi còn bỏ qua
 * lệnh làm tay, nên `confirmed_at` trống dù chứng từ nằm sẵn trong `shipment_events`. KHÔNG backfill
 * (mục 8.8) — đọc ra lúc xem bằng đúng phép khớp của đường ghi, chỉ trên sự kiện của ĐVVC (`VTP_*`;
 * trạng thái Pancake và dòng ERP tự ghi không phải chứng từ). Trả mốc SỚM NHẤT khớp cho mỗi lệnh.
 */
export async function derivedManualConfirmations(
  db: Db,
  requests: { id: string; shipmentId: string; actionKey: string; createdAt: Date }[],
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  const can = requests.filter((r) => (CARRIER_ACTION_CONFIRM_STAGES[r.actionKey as CarrierActionKey] ?? []).length);
  if (!can.length) return out;
  const since = new Date(Math.min(...can.map((r) => r.createdAt.getTime())));
  const events = await db
    .select({ shipmentId: schema.shipmentEvents.shipmentId, stage: schema.shipmentEvents.normalizedStage, legType: schema.shipmentEvents.legType, at: schema.shipmentEvents.occurredAt })
    .from(schema.shipmentEvents)
    .where(
      and(
        inArray(schema.shipmentEvents.shipmentId, [...new Set(can.map((r) => r.shipmentId))]),
        isNotNull(schema.shipmentEvents.normalizedStage),
        gte(schema.shipmentEvents.occurredAt, since),
        like(schema.shipmentEvents.source, "VTP_%"),
      ),
    )
    .orderBy(asc(schema.shipmentEvents.occurredAt));
  for (const r of can) {
    const hit = events.find(
      (e) => e.shipmentId === r.shipmentId && e.stage !== null && confirmsCarrierAction(r.actionKey, legAwareStage(e.stage, e.legType === "RETURN" ? "RETURN" : e.legType === "OUTBOUND" ? "OUTBOUND" : null), e.at, r.createdAt),
    );
    if (hit) out.set(r.id, hit.at);
  }
  return out;
}

/**
 * MỘT cách dựng khung nhìn của một lệnh — dùng chung cho hàng đợi, ngăn kéo và kết quả Server
 * Action. `derivedConfirmedAt` là mốc suy ra lúc đọc (`derivedManualConfirmations`) cho lệnh làm tay
 * mà cột còn trống; mốc đã ghi luôn thắng.
 */
export function carrierRequestView(
  r: {
    id: string;
    actionKey: string;
    status: string;
    createdAt: Date;
    error: string | null;
    note: string;
    actorEmail: string;
    attempts: number;
    confirmedAt: Date | null;
    finishedAt: Date | null;
    orderNumber: string;
    payload: unknown;
  },
  derivedConfirmedAt: Date | null = null,
): CarrierRequestView {
  const manual = (MANUAL_STATUSES as readonly string[]).includes(r.status);
  const actionKey = r.actionKey as CarrierActionKey;
  return {
    id: r.id,
    actionKey,
    status: r.status as CarrierRequestStatus,
    at: r.createdAt,
    error: r.error,
    note: r.note,
    actor: r.actorEmail,
    attempts: Number(r.attempts ?? 0),
    confirmedAt: r.confirmedAt ?? (manual ? derivedConfirmedAt : null),
    doneAt: r.status === "MANUAL_DONE" ? r.finishedAt : null,
    copyText: manual ? manualInstructionText({ actionKey, orderNumber: r.orderNumber, note: r.note, payload: r.payload }) : null,
  };
}

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { CARRIER_ACTION_CONFIRM_STAGES, type CarrierActionKey } from "@/lib/constants/care";

/**
 * ───────────── ĐVVC XÁC NHẬN BẰNG SỰ KIỆN, KHÔNG BẰNG PHẢN HỒI API ─────────────
 *
 * API trả "OK" chỉ là ACK: Viettel Post đã nhận yêu cầu. Bưu tá có đi phát lại hay không thì phải
 * đợi sự kiện hành trình. Hàm này chạy mỗi khi có sự kiện mới của kiện (webhook / tra API / nhập
 * tệp): yêu cầu đang ACK mà thấy chặng khớp, xảy ra SAU lúc gửi ⇒ SUCCESS, ghi mốc xác nhận.
 *
 * Idempotent: chạy lại không đổi gì. Không bao giờ hạ SUCCESS xuống.
 */
export async function settleCarrierRequests(db: Db, shipmentId: string, stage: string, eventAt: Date): Promise<number> {
  const open = await db
    .select({ id: schema.carrierActionRequests.id, actionKey: schema.carrierActionRequests.actionKey, sentAt: schema.carrierActionRequests.sentAt })
    .from(schema.carrierActionRequests)
    .where(and(eq(schema.carrierActionRequests.shipmentId, shipmentId), inArray(schema.carrierActionRequests.status, ["SENT", "ACK"]), isNotNull(schema.carrierActionRequests.sentAt)));
  const matched = open.filter((r) => {
    const stages = CARRIER_ACTION_CONFIRM_STAGES[r.actionKey as CarrierActionKey] ?? [];
    return stages.includes(stage) && r.sentAt !== null && eventAt.getTime() >= r.sentAt.getTime();
  });
  if (!matched.length) return 0;
  await db
    .update(schema.carrierActionRequests)
    .set({ status: "SUCCESS", confirmedAt: eventAt, finishedAt: sql`coalesce(${schema.carrierActionRequests.finishedAt}, now())` })
    .where(inArray(schema.carrierActionRequests.id, matched.map((r) => r.id)));
  return matched.length;
}

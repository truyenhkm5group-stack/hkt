"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { requirePermission, requireUser } from "@/lib/auth/session";
import { CARE_ACTION_KINDS } from "@/lib/constants/delivery-tower";
import { getShipmentQuickView } from "@/lib/queries/shipment-quickview";

/**
 * ───────────── GHI NHẬN VIỆC ĐÃ CHĂM MỘT KIỆN HÀNG ─────────────
 *
 * ERP **không** tự nhắn khách ở đây. Việc này chỉ GHI LẠI điều người vừa làm — và đó mới là thứ
 * biến "đội CSKH cứu được bao nhiêu đơn" từ một câu hỏi không có dữ liệu thành một con số đo được.
 *
 * Bối cảnh được chụp lại NGAY LÚC GHI (chặng, tuổi tin cuối, COD, số lần giao hụt). Tính lại về sau
 * là hỏi "kiện này giờ ra sao" chứ không phải "việc chăm có tác dụng gì".
 */
const schemaGhi = z.object({
  shipmentId: z.string().min(1),
  kind: z.enum(CARE_ACTION_KINDS),
  note: z.string().trim().max(500).default(""),
});

export async function recordCareAction(input: z.input<typeof schemaGhi>): Promise<{ error?: string; ok?: true }> {
  const user = await requireUser();
  const parsed = schemaGhi.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { shipmentId, kind, note } = parsed.data;

  const db = await getDb();
  const [s] = await db
    .select({
      id: schema.shipments.id,
      orderId: schema.shipments.orderId,
      stage: schema.shipments.stage,
      cod: schema.shipments.codAmount,
      // Tuổi tin cuối đọc từ SỰ KIỆN ĐVVC, không từ `updated_at` — `updated_at` bị chạm bởi mọi lần ghi.
      tuoi: sql<number | null>`extract(epoch from (now() - (select max(e.occurred_at) from shipment_events e where e.shipment_id = ${schema.shipments.id} and e.source in ('VTP_WEBHOOK','PANCAKE','VTP_IMPORT','VTP_UI_MANUAL_VERIFICATION')))) / 3600`,
      lanHut: sql<number>`(select count(*) from shipment_events e where e.shipment_id = ${schema.shipments.id} and e.normalized_stage = 'DELIVERY_FAILED')::int`,
    })
    .from(schema.shipments)
    .where(eq(schema.shipments.id, shipmentId))
    .limit(1);
  if (!s) return { error: "Không tìm thấy vận đơn" };

  await db.insert(schema.careActions).values({
    shipmentId,
    orderId: s.orderId,
    actorId: user.id,
    actorEmail: user.email ?? "",
    kind,
    note,
    stageAtAction: s.stage,
    // `NULL` = CHƯA BIẾT. Vận đơn không có sự kiện nào thì tuổi là chưa biết, không phải 0 giờ.
    codAtAction: s.cod ?? null,
    eventAgeHoursAtAction: s.tuoi === null ? null : Math.round(Number(s.tuoi)),
    failedAttemptsAtAction: s.lanHut === null ? null : Number(s.lanHut),
  });

  await audit({ userId: user.id, userEmail: user.email ?? "", action: "care.record", entity: "SHIPMENT", entityId: shipmentId, after: { kind, note }, reason: "CSKH ghi nhận việc đã làm với kiện hàng" });
  revalidatePath("/shipments");
  return { ok: true };
}

/** Nạp gói thông tin cần để gọi khách — chỉ khi người dùng thật sự mở ngăn kéo. */
export async function loadShipmentQuickView(shipmentId: string) {
  await requirePermission("shipments:view");
  return getShipmentQuickView(shipmentId);
}

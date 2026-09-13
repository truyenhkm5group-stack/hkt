"use server";

/**
 * Ghi đè lý do hoàn bằng bằng chứng của con người.
 *
 * Suy luận của máy chỉ phủ được ~22% vận đơn hoàn (đo production 13/09/2026). Người xử lý thường
 * BIẾT lý do — họ vừa gọi cho khách xong. Đây là chỗ ghi lại điều đó.
 *
 * Nhật ký ghi CẢ lý do cũ lẫn lý do máy suy ra tại thời điểm ghi đè: một con số đi vào báo cáo
 * hiệu suất mã hàng thì phải lần ngược được về người đã quyết và bằng chứng họ dựa vào.
 */
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { RETURN_REASONS } from "@/lib/constants/return-reason";
import { reasonsForShipments } from "@/lib/queries/return-reason";

const schemaInput = z.object({
  shipmentId: z.string().min(1),
  reason: z.enum(RETURN_REASONS),
  note: z.string().trim().max(500).default(""),
});

export async function setReturnReason(input: unknown): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  // Cùng quyền với các thao tác care khác: người đang xử lý kiện là người biết lý do.
  if (!can(user, "shipments:view")) return { error: "Không có quyền" };
  const parsed = schemaInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { shipmentId, reason, note } = parsed.data;

  const db = await getDb();
  const vanDon = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, shipmentId), columns: { id: true, vtpOrderNumber: true } });
  if (!vanDon) return { error: "Không tìm thấy vận đơn" };

  // Lý do ĐANG có hiệu lực trước khi ghi đè — chép vào nhật ký để so được về sau.
  const truoc = (await reasonsForShipments([shipmentId])).get(shipmentId);

  await db
    .insert(schema.shipmentReturnReasons)
    .values({ shipmentId, reason, note, inferredReason: truoc?.manual ? "" : (truoc?.reason ?? "UNKNOWN"), actorId: user.id, actorEmail: user.email })
    .onConflictDoUpdate({
      target: schema.shipmentReturnReasons.shipmentId,
      set: { reason, note, actorId: user.id, actorEmail: user.email, updatedAt: new Date() },
    });

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "RETURN_REASON_SET",
    entity: "SHIPMENT",
    entityId: shipmentId,
    detail: {
      tracking: vanDon.vtpOrderNumber,
      before: { reason: truoc?.reason ?? "UNKNOWN", confidence: truoc?.confidence ?? "NONE", evidence: truoc?.evidence ?? "" },
      after: { reason, note },
    },
  });

  revalidatePath("/shipments");
  revalidatePath("/reports/returns");
  return { ok: true };
}

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
import { RETURN_REASON_GROUP_OF, RETURN_REASONS } from "@/lib/constants/return-reason";
import { reasonsForShipments } from "@/lib/queries/return-reason";

const schemaInput = z.object({
  shipmentId: z.string().min(1),
  reason: z.enum(RETURN_REASONS),
  /**
   * GHI CHÚ TỰ DO — KHÔNG PHẢI LÝ DO.
   *
   * `reason` là danh mục để đếm; `note` là câu chuyện cho người sau đọc. Nơi gọi KHÔNG được nhét
   * lý do vào đây: "vải mỏng quá khách kêu" nằm trong ô ghi chú thì báo cáo không bao giờ đếm
   * được nó. Ô chọn lý do là bắt buộc, ô ghi chú là tuỳ.
   */
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

  /*
    NHÓM LỚN LƯU KÈM, KHÔNG SUY LÚC ĐỌC.

    Suy lúc đọc thì ngày nào đó một lý do được xếp sang nhóm khác là toàn bộ lịch sử đổi theo,
    lặng lẽ — báo cáo quý trước in ra hồi đó không còn khớp với chính nó nữa.
  */
  const reasonGroup = RETURN_REASON_GROUP_OF[reason];
  await db
    .insert(schema.shipmentReturnReasons)
    .values({
      shipmentId,
      reason,
      reasonGroup,
      note,
      inferredReason: truoc?.manual ? "" : (truoc?.reason ?? "UNKNOWN"),
      source: "MANUAL",
      confidence: "CONFIRMED",
      actorId: user.id,
      actorEmail: user.email,
    })
    .onConflictDoUpdate({
      target: schema.shipmentReturnReasons.shipmentId,
      // Sửa lại lý do VẪN là người xác định — giữ `source`/`confidence`, chỉ đổi nội dung và người.
      set: { reason, reasonGroup, note, source: "MANUAL", confidence: "CONFIRMED", actorId: user.id, actorEmail: user.email, updatedAt: new Date() },
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
      after: { reason, reasonGroup, note },
    },
  });

  revalidatePath("/shipments");
  revalidatePath("/reports/returns");
  return { ok: true };
}

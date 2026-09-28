"use server";

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { reconcileCareCoverage } from "@/lib/care/lifecycle";
import { syncOrderById } from "@/lib/integrations/pancake/sync";

/** Trần mỗi lượt bấm — mỗi đơn là một lượt gọi API Pancake, chạy lần lượt. */
const PANCAKE_REFRESH_LIMIT = 80;

export type PancakeRefreshResult = { error?: string; ok?: true; checked: number; closed: number; failed: number };

/**
 * ═══════════ HỎI LẠI PANCAKE CHO NHỮNG CA ĐANG CHỜ QUYẾT ĐỊNH HOÀN ═══════════
 *
 * Kiện đang ở "đề nghị hoàn" (505, hoặc dòng tệp "Chờ xử lý") có thể ĐÃ được VTP duyệt hoàn mà ERP chưa biết: webhook VTP không
 * bao giờ gửi 515, và Pancake chỉ đẩy đơn khi trạng thái giao vận thô của NÓ đổi — lời duyệt hoàn
 * thường không làm đổi, nên dòng ấy chỉ tới ERP ở lượt đối chiếu đêm (đo 28/09/2026: ERP biết sau
 * trung vị 5,1 giờ, 47 % số kiện sau hơn 6 giờ).
 *
 * Nút này tải lại ĐÚNG những đơn ấy từ Pancake (ép ghi, như nút "Tải lại từ Pancake" từng đơn), rồi
 * đối chiếu ca care của chúng. Ca nào đã có lời duyệt hoàn thì rời hàng đợi ngay. Người bấm — không
 * có lịch chạy nền (đổi lịch scheduler là việc chủ shop quyết, AGENTS.md mục 7).
 */
export async function refreshPendingReturnsFromPancake(): Promise<PancakeRefreshResult> {
  const user = await requireUser();
  if (!can(user, "shipments:manage")) return { error: "Bạn không có quyền xử lý case vận đơn", checked: 0, closed: 0, failed: 0 };
  const db = await getDb();
  const rows = await db
    .select({ shipmentId: schema.shipments.id, orderId: schema.shipments.orderId })
    .from(schema.shipmentCare)
    .innerJoin(schema.shipments, eq(schema.shipments.id, schema.shipmentCare.shipmentId))
    .where(
      and(
        eq(schema.shipmentCare.active, true),
        // Chặng RETURNING mà ảnh chụp chưa nói "đã duyệt": mã 505, hoặc dòng tệp "Chờ xử lý" (mã rỗng).
        // Ca đã có lời duyệt thì bộ đối chiếu đã đóng rồi — không còn nằm trong tập `active` này.
        eq(schema.shipments.stage, "RETURNING"),
        isNotNull(schema.shipments.orderId),
      ),
    )
    .orderBy(schema.shipmentCare.openedAt)
    .limit(PANCAKE_REFRESH_LIMIT);

  const shipmentIds = [...new Set(rows.map((r) => r.shipmentId))];
  let failed = 0;
  for (const orderId of new Set(rows.map((r) => r.orderId as string))) {
    try {
      await syncOrderById(orderId, { force: true });
    } catch {
      // Một đơn hỏng (Pancake 429 hết lượt thử / đơn bị xoá) không chặn các đơn còn lại.
      failed += 1;
    }
  }
  if (shipmentIds.length) await reconcileCareCoverage(db, new Date(), { shipmentIds });
  const conMo = shipmentIds.length
    ? await db
        .select({ id: schema.shipmentCare.shipmentId })
        .from(schema.shipmentCare)
        .where(and(eq(schema.shipmentCare.active, true), inArray(schema.shipmentCare.shipmentId, shipmentIds)))
    : [];
  const closed = shipmentIds.length - new Set(conMo.map((r) => r.id)).size;

  await audit({
    userId: user.id,
    userEmail: user.email ?? "",
    action: "care.pancake-refresh",
    entity: "SHIPMENT",
    entityId: "care-queue",
    after: { checked: shipmentIds.length, closed, failed },
    reason: "Hỏi lại Pancake cho các ca đang chờ quyết định hoàn (VTP không gửi 515 qua webhook)",
  });
  revalidatePath("/shipments");
  return { ok: true, checked: shipmentIds.length, closed, failed };
}

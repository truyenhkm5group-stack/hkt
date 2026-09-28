import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { reconcileCareCoverage } from "@/lib/care/lifecycle";
import { syncOrderById } from "@/lib/integrations/pancake/sync";

/** Trần mỗi lượt — mỗi đơn là một lượt gọi API Pancake, chạy lần lượt. */
export const PANCAKE_REFRESH_LIMIT = 80;

export type PancakeRefreshSummary = { checked: number; closed: number; failed: number };

/**
 * ═══════════ HỎI LẠI PANCAKE CHO NHỮNG CA ĐANG CHỜ QUYẾT ĐỊNH HOÀN ═══════════
 *
 * Kiện ở "đề nghị hoàn" (505, hoặc dòng tệp "Chờ xử lý" mã rỗng) có thể ĐÃ được VTP duyệt hoàn mà
 * ERP chưa biết: webhook VTP không bao giờ gửi 515, và Pancake chỉ đẩy đơn khi trạng thái giao vận
 * thô của NÓ đổi — lời duyệt hoàn thường không đổi, nên dòng ấy chỉ tới ERP ở lượt đối chiếu đêm (đo
 * 28/09/2026: trung vị 5,1 giờ, 47 % số kiện sau hơn 6 giờ). Lượt bấm tay đầu tiên trên production
 * (28/09): hỏi 66 ca, 15 ca VTP đã duyệt hoàn nên rời hàng đợi.
 *
 * MỘT hàm cho cả nút "Kiểm tra duyệt hoàn" lẫn job `care-return-check` — hai đường không được nói
 * hai điều khác nhau. Tải lại ĐÚNG những đơn ấy từ Pancake (ép ghi, như nút tải lại từng đơn), rồi
 * đối chiếu ca care của chúng; ca có lời duyệt thì luật ở `reconcileCareCoverage` đóng.
 */
export async function refreshPendingReturns(db: Db, opts: { limit?: number } = {}): Promise<PancakeRefreshSummary> {
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
    .limit(opts.limit ?? PANCAKE_REFRESH_LIMIT);

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
  return { checked: shipmentIds.length, closed: shipmentIds.length - new Set(conMo.map((r) => r.id)).size, failed };
}

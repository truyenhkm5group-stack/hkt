"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { can, requireUser } from "@/lib/auth/session";
import { orderForReference } from "@/lib/integrations/viettelpost/order-reference";
import { linkOrphanToOrder } from "@/lib/integrations/viettelpost/reship";

const Input = z.object({ shipmentId: z.string().uuid(), orderRef: z.string().trim().min(1).max(64) });

const WHY: Record<string, string> = {
  NOT_FOUND: "Không tìm thấy vận đơn",
  ALREADY_LINKED: "Vận đơn này đã gắn đơn",
  RETURN_LEG: "Vận đơn chiều hoàn không gắn vào đơn — nó là dòng riêng của hàng hoàn",
  PHONE_MISMATCH: "SĐT người nhận của vận đơn khác SĐT của đơn — không gắn",
  ORDER_NOT_FOUND: "Không tìm thấy đơn",
};

/**
 * Nút «Gắn đơn» cho vận đơn chưa gắn đơn (vtp-direct-sync (4), 25/10/2026). Mã đơn nhận đúng dạng mà webhook / tệp nhận
 * (order-reference.ts: mã đơn ERP · số đơn POS «6277») — một luật cho ba đường. Ghi qua `linkOrphanToOrder` (reship.ts).
 */
export async function linkShipmentToOrder(raw: { shipmentId: string; orderRef: string }): Promise<{ error?: string; ok?: true; orderId?: string; attemptNo?: number }> {
  const user = await requireUser();
  if (!can(user, "shipments:manage")) return { error: "Bạn không có quyền gắn vận đơn vào đơn" };
  const parsed = Input.safeParse(raw);
  if (!parsed.success) return { error: "Mã đơn không hợp lệ" };
  const db = await getDb();
  const order = await orderForReference(db, parsed.data.orderRef);
  if (!order) return { error: "Không tìm thấy ĐÚNG MỘT đơn với mã này (nhập mã đơn ERP hoặc số đơn POS, vd 6277)" };
  const r = await linkOrphanToOrder(db, {
    shipmentId: parsed.data.shipmentId,
    orderId: order.id,
    actor: { id: user.id, email: user.email ?? "" },
    reason: `Gắn tay vận đơn chưa gắn đơn vào đơn ${parsed.data.orderRef}`,
  });
  if (!r.ok) return { error: WHY[r.why] ?? "Không gắn được" };
  revalidatePath("/shipments");
  revalidatePath(`/orders/${r.orderId}`);
  return { ok: true, orderId: r.orderId, attemptNo: r.attemptNo };
}

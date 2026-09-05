"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { clearMemo } from "@/lib/cache";
import { getViettelPostClient, VTP_ORDER_ACTIONS, type VtpOrderActionType } from "@/lib/integrations/viettelpost/client";
import { syncViettelPostShipments } from "@/lib/integrations/viettelpost/sync";

export type VtpActionResult = { ok: true; message: string } | { error: string };

async function shipmentNumber(id: string) {
  const db = await getDb();
  const s = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, id), columns: { id: true, vtpOrderNumber: true, trackingCode: true, orderId: true, stage: true } });
  if (!s) return { error: "Không tìm thấy vận đơn" as const };
  const number = s.vtpOrderNumber ?? s.trackingCode;
  if (!number) return { error: "Vận đơn chưa có mã Viettel Post" as const };
  return { s, number, error: undefined };
}

async function logEvent(shipmentId: string, status: string, note: string) {
  const db = await getDb();
  await db.insert(schema.shipmentEvents).values({ shipmentId, source: "MANUAL", status, statusName: status, note, occurredAt: new Date() }).onConflictDoNothing();
}

/** Thao tác Viettel Post: phát tiếp / duyệt hoàn / gửi lại / duyệt / huỷ — rồi tra lại trạng thái từ VTP */
export async function vtpOrderAction(shipmentId: string, type: VtpOrderActionType, note = ""): Promise<VtpActionResult> {
  const user = await requireUser();
  if (!can(user, "shipments:manage")) return { error: "Không có quyền thao tác vận đơn" };
  const action = VTP_ORDER_ACTIONS.find((a) => a.type === type);
  if (!action) return { error: "Thao tác không hợp lệ" };
  const found = await shipmentNumber(shipmentId);
  if (found.error || !found.number) return { error: found.error ?? "Không tìm thấy vận đơn" };
  try {
    const client = getViettelPostClient();
    const res = await client.updateOrder(found.number, type, note || `${action.label} từ ERP bởi ${user.name || user.email}`);
    await logEvent(shipmentId, `ERP · ${action.label}`, `${user.name || user.email}${note ? `: ${note}` : ""} · VTP: ${res.message || "OK"}`);
    await audit({ userId: user.id, userEmail: user.email, action: "VTP_ORDER_ACTION", entity: "SHIPMENT", entityId: shipmentId, detail: { number: found.number, type, label: action.label, note, response: res.message } });
    await syncViettelPostShipments({ trigger: "MANUAL", actor: user.email, shipmentIds: [shipmentId], includeFinal: true }).catch(() => undefined);
    clearMemo();
    revalidatePath(`/shipments/${shipmentId}`);
    return { ok: true, message: `Viettel Post đã nhận yêu cầu “${action.label}” cho ${found.number}${res.message ? ` · ${res.message}` : ""}` };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await audit({ userId: user.id, userEmail: user.email, action: "VTP_ORDER_ACTION_FAILED", entity: "SHIPMENT", entityId: shipmentId, detail: { number: found.number, type, label: action.label, error: message } });
    return { error: /quy[eề]n|permission|không tồn tại|not exist/i.test(message) ? `${message} — tài khoản Viettel Post đang cấu hình trong ERP phải là tài khoản chủ vận đơn (cùng mã khách hàng với Pancake, vd GLMTQY). Kiểm tra VIETTELPOST_USERNAME / PASSWORD.` : message };
  }
}

const editSchema = z.object({
  receiverName: z.string().trim().min(1, "Nhập tên người nhận").max(120),
  receiverPhone: z.string().trim().regex(/^0\d{9,10}$/, "SĐT không hợp lệ"),
  receiverAddress: z.string().trim().min(5, "Nhập địa chỉ").max(500),
  moneyCollection: z.number().int().min(0).max(100_000_000),
  note: z.string().trim().max(300).default(""),
});

/** Sửa người nhận / SĐT / địa chỉ / tiền thu hộ / ghi chú trên Viettel Post (đơn chưa phát) */
export async function vtpEditOrder(shipmentId: string, input: unknown): Promise<VtpActionResult> {
  const user = await requireUser();
  if (!can(user, "shipments:manage")) return { error: "Không có quyền thao tác vận đơn" };
  const parsed = editSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const found = await shipmentNumber(shipmentId);
  if (found.error || !found.number) return { error: found.error ?? "Không tìm thấy vận đơn" };
  try {
    const client = getViettelPostClient();
    const res = await client.editOrder(found.number, parsed.data);
    const db = await getDb();
    await db.update(schema.shipments).set({ codAmount: parsed.data.moneyCollection, updatedAt: new Date() }).where(eq(schema.shipments.id, shipmentId));
    await logEvent(shipmentId, "ERP · Sửa đơn", `${user.name || user.email}: ${parsed.data.receiverName} · ${parsed.data.receiverPhone} · ${parsed.data.receiverAddress} · COD ${parsed.data.moneyCollection.toLocaleString("vi-VN")}đ${parsed.data.note ? ` · ${parsed.data.note}` : ""} · VTP: ${res.message || "OK"}`);
    await audit({ userId: user.id, userEmail: user.email, action: "VTP_ORDER_EDIT", entity: "SHIPMENT", entityId: shipmentId, detail: { number: found.number, ...parsed.data, response: res.message } });
    await syncViettelPostShipments({ trigger: "MANUAL", actor: user.email, shipmentIds: [shipmentId], includeFinal: true }).catch(() => undefined);
    clearMemo();
    revalidatePath(`/shipments/${shipmentId}`);
    return { ok: true, message: `Đã gửi sửa đơn ${found.number} lên Viettel Post${res.message ? ` · ${res.message}` : ""}` };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { error: /quy[eề]n|permission|không tồn tại|not exist/i.test(message) ? `${message} — tài khoản Viettel Post trong ERP phải là chủ vận đơn.` : message };
  }
}

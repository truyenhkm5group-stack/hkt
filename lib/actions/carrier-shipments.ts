"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { cancelVtpShipmentCore, createVtpShipmentCore, discardVtpCreateCore, quoteVtpShipmentCore, vtpPrintLinkCore } from "@/lib/carriers/vtp-shipments";

/**
 * ═══════════ SERVER ACTION — VẬN ĐƠN VIETTEL POST CỦA ĐƠN ERP (POS tự chủ) ═══════════
 *
 * Mỏng: phiên → lõi (`lib/carriers/vtp-shipments.ts` — quyền `shipments:manage`, zod, kết nối của CHÍNH tổ chức phiên, giữ
 * chỗ chống tạo trùng, nhật ký) → `revalidatePath`. Chỉ nhận id đơn / id vận đơn trong CSDL của phiên — không nhận mã tổ chức.
 * Lỗi nghiệp vụ trả `{ ok: false, error }`, không ném.
 */

function revalidateOrder(orderId: string) {
  revalidatePath("/orders");
  revalidatePath(`/orders/${encodeURIComponent(orderId)}`);
  revalidatePath("/shipments");
}

export async function quoteVtpShipmentAction(orderId: string, input: unknown) {
  const user = await requireUser();
  return quoteVtpShipmentCore(user, orderId, input);
}

export async function createVtpShipmentAction(orderId: string, input: unknown) {
  const user = await requireUser();
  const r = await createVtpShipmentCore(user, orderId, input);
  // Cả nhánh lỗi cũng làm mới: lượt «không rõ kết quả» để lại một chỗ giữ mà trang phải hiện ra.
  revalidateOrder(orderId);
  return r;
}

export async function cancelVtpShipmentAction(orderId: string, shipmentId: string, input: unknown) {
  const user = await requireUser();
  const r = await cancelVtpShipmentCore(user, shipmentId, input);
  if (r.ok) revalidateOrder(orderId);
  return r;
}

export async function discardVtpCreateAction(orderId: string, shipmentId: string) {
  const user = await requireUser();
  const r = await discardVtpCreateCore(user, shipmentId);
  if (r.ok) revalidateOrder(orderId);
  return r;
}

export async function vtpPrintLinkAction(shipmentId: string) {
  const user = await requireUser();
  return vtpPrintLinkCore(user, shipmentId);
}

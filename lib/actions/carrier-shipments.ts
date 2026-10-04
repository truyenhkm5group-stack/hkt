"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { bulkCreateCore, bulkPrintLinkCore, bulkQuoteCore, cancelShipmentCore, carrierWardOptionsCore, createShipmentCore, discardCreateCore, printLinkCore, quoteShipmentCore, retryCreateCore } from "@/lib/carriers/engine";

/**
 * ═══════════ SERVER ACTION — VẬN ĐƠN CỦA ĐƠN ERP, MỌI HÃNG (POS tự chủ) ═══════════
 *
 * Mỏng: phiên → lõi (`lib/carriers/engine.ts` — quyền `shipments:manage`, zod, kết nối của CHÍNH tổ chức phiên, giữ chỗ chống
 * tạo trùng, nhật ký) → `revalidatePath`. Chỉ nhận mã hãng, id đơn / id vận đơn trong CSDL của phiên — không nhận mã tổ chức.
 * Lỗi nghiệp vụ trả `{ ok: false, error }`, không ném.
 */

function revalidateOrder(orderId: string) {
  revalidatePath("/orders");
  revalidatePath(`/orders/${encodeURIComponent(orderId)}`);
  revalidatePath("/shipments");
}

export async function quoteShipmentAction(carrier: string, orderId: string, input: unknown) {
  const user = await requireUser();
  return quoteShipmentCore(user, carrier, orderId, input);
}

export async function carrierWardOptionsAction(carrier: string, province: string) {
  const user = await requireUser();
  return carrierWardOptionsCore(user, carrier, province);
}

export async function createShipmentAction(carrier: string, orderId: string, input: unknown) {
  const user = await requireUser();
  const r = await createShipmentCore(user, carrier, orderId, input);
  // Cả nhánh lỗi cũng làm mới: lượt «không rõ kết quả» để lại một chỗ giữ mà trang phải hiện ra.
  revalidateOrder(orderId);
  return r;
}

export async function cancelShipmentAction(orderId: string, shipmentId: string, input: unknown) {
  const user = await requireUser();
  const r = await cancelShipmentCore(user, shipmentId, input);
  if (r.ok) revalidateOrder(orderId);
  return r;
}

export async function discardCreateAction(orderId: string, shipmentId: string) {
  const user = await requireUser();
  const r = await discardCreateCore(user, shipmentId);
  if (r.ok) revalidateOrder(orderId);
  return r;
}

export async function retryCreateAction(orderId: string, shipmentId: string) {
  const user = await requireUser();
  const r = await retryCreateCore(user, shipmentId);
  revalidateOrder(orderId);
  return r;
}

export async function printLinkAction(shipmentId: string) {
  const user = await requireUser();
  return printLinkCore(user, shipmentId);
}

/** Hàng loạt (danh sách đơn): bảng cước tra bằng đơn đầu tiên tạo được. */
export async function bulkQuoteAction(carrier: string, orderIds: string[]) {
  const user = await requireUser();
  return bulkQuoteCore(user, carrier, orderIds);
}

/** Hàng loạt: tạo tuần tự qua đúng lõi tạo một đơn; kết quả từng đơn. */
export async function bulkCreateAction(carrier: string, orderIds: string[], input: unknown) {
  const user = await requireUser();
  const r = await bulkCreateCore(user, carrier, orderIds, input);
  revalidatePath("/orders");
  revalidatePath("/shipments");
  return r;
}

/** Hàng loạt: một link in cho mọi vận đơn ERP tạo (một hãng) của các đơn đã chọn. */
export async function bulkPrintLinkAction(carrier: string, orderIds: string[]) {
  const user = await requireUser();
  return bulkPrintLinkCore(user, carrier, orderIds);
}

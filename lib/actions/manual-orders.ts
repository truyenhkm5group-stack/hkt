"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import type { MetadataErrorCode } from "@/lib/metadata/errors";
import type { FieldError } from "@/lib/metadata/types";
import { cancelManualOrderCore, confirmManualDeliveryCore, createManualOrderCore, markManualDeliveryFailedCore, saveManualDeliveryFeeCore, undoManualDeliveryFailedCore, updateManualOrderCore, voidManualDeliveryCore } from "@/lib/records/order-create";
import { recordManualPaymentCore, voidManualPaymentCore } from "@/lib/records/order-payments";

/**
 * ═══════════ SERVER ACTION ĐƠN HÀNG TẠO TAY (pilot P0 #3) ═══════════
 *
 * Mỏng: phiên → lõi (`lib/records/order-create.ts` — cổng tổ chức không đồng bộ đơn + `orders:write`, zod, phép tính tiền
 * thuần, khách / mẫu mã có thật, một giao dịch, nhật ký) → `revalidatePath`. Lỗi nghiệp vụ trả `{ error, errors, code }`.
 */

type Failure = { error: string; errors: FieldError[]; code: MetadataErrorCode };
type Success = { ok: true; id: string; redirectTo: string; message: string };

function failure(r: { code: MetadataErrorCode; errors: FieldError[] }): Failure {
  return { error: r.errors.map((e) => e.message).join(" · ") || "Không lưu được.", errors: r.errors, code: r.code };
}

export async function createManualOrderAction(input: unknown): Promise<Success | Failure> {
  const user = await requireUser();
  const r = await createManualOrderCore(user, input);
  if (!r.ok) return failure(r);
  revalidatePath("/orders");
  return { ok: true, id: r.id, redirectTo: `/orders/${encodeURIComponent(r.id)}`, message: "Đã tạo đơn hàng" };
}

export async function updateManualOrderAction(orderId: string, input: unknown): Promise<Success | Failure> {
  const user = await requireUser();
  const r = await updateManualOrderCore(user, orderId, input);
  if (!r.ok) return failure(r);
  revalidatePath("/orders");
  revalidatePath(`/orders/${encodeURIComponent(r.id)}`);
  return { ok: true, id: r.id, redirectTo: `/orders/${encodeURIComponent(r.id)}`, message: "Đã lưu đơn hàng" };
}

export async function cancelManualOrderAction(orderId: string, input: unknown): Promise<Success | Failure> {
  const user = await requireUser();
  const r = await cancelManualOrderCore(user, orderId, input);
  if (!r.ok) return failure(r);
  revalidatePath("/orders");
  revalidatePath(`/orders/${encodeURIComponent(r.id)}`);
  return { ok: true, id: r.id, redirectTo: `/orders/${encodeURIComponent(r.id)}`, message: "Đã huỷ đơn" };
}

/** Xác nhận ĐÃ GIAO bằng phiếu giao có ký nhận (G-ORDER) — chỉ id đơn trong CSDL của phiên; không nhận mã tổ chức. */
export async function confirmManualDeliveryAction(orderId: string, input: unknown): Promise<Success | Failure> {
  const user = await requireUser();
  const r = await confirmManualDeliveryCore(user, orderId, input);
  if (!r.ok) return failure(r);
  revalidatePath("/orders");
  revalidatePath(`/orders/${encodeURIComponent(r.id)}`);
  revalidatePath("/products");
  return { ok: true, id: r.id, redirectTo: `/orders/${encodeURIComponent(r.id)}`, message: "Đã xác nhận giao thành công — hàng đã trừ khỏi kho; tiền thật vẫn chờ phiếu thu" };
}

/** Huỷ phiếu giao ghi nhầm — bắt buộc lý do; đơn về «Đã xác nhận», hàng quay lại kho. */
export async function voidManualDeliveryAction(orderId: string, input: unknown): Promise<Success | Failure> {
  const user = await requireUser();
  const r = await voidManualDeliveryCore(user, orderId, input);
  if (!r.ok) return failure(r);
  revalidatePath("/orders");
  revalidatePath(`/orders/${encodeURIComponent(r.id)}`);
  revalidatePath("/products");
  return { ok: true, id: r.id, redirectTo: `/orders/${encodeURIComponent(r.id)}`, message: "Đã huỷ phiếu giao" };
}

/** Giao KHÔNG thành công (khách không nhận / hoàn) — bắt buộc lý do; đơn «Đã hoàn», hàng quay lại khả dụng ngay. */
export async function markManualDeliveryFailedAction(orderId: string, input: unknown): Promise<Success | Failure> {
  const user = await requireUser();
  const r = await markManualDeliveryFailedCore(user, orderId, input);
  if (!r.ok) return failure(r);
  revalidatePath("/orders");
  revalidatePath(`/orders/${encodeURIComponent(r.id)}`);
  revalidatePath("/products");
  return { ok: true, id: r.id, redirectTo: `/orders/${encodeURIComponent(r.id)}`, message: "Đã ghi giao không thành công — đơn tính là hoàn, hàng quay lại tồn" };
}

/** Hoàn tác «giao không thành công» ghi nhầm — đơn về «Đã xác nhận». */
export async function undoManualDeliveryFailedAction(orderId: string, input: unknown): Promise<Success | Failure> {
  const user = await requireUser();
  const r = await undoManualDeliveryFailedCore(user, orderId, input);
  if (!r.ok) return failure(r);
  revalidatePath("/orders");
  revalidatePath(`/orders/${encodeURIComponent(r.id)}`);
  revalidatePath("/products");
  return { ok: true, id: r.id, redirectTo: `/orders/${encodeURIComponent(r.id)}`, message: "Đã hoàn tác — đơn về «Đã xác nhận»" };
}

/** Phí giao đồng giá mỗi đơn giao thành công (₫) — `null` / rỗng = xoá. */
export async function saveManualDeliveryFeeAction(fee: number | null): Promise<{ ok: true; message: string } | Failure> {
  const user = await requireUser();
  const r = await saveManualDeliveryFeeCore(user, fee);
  if (!r.ok) return failure(r);
  revalidatePath("/orders");
  return { ok: true, message: r.fee === null ? "Đã xoá phí giao đồng giá" : "Đã lưu phí giao — áp cho đơn xác nhận đã giao từ bây giờ" };
}

/**
 * Ghi CHỨNG TỪ THANH TOÁN (phiếu thu / hoàn tiền) cho đơn tay — chỉ id đơn trong CSDL của phiên; không nhận mã tổ chức.
 * Tiền đi theo chứng từ, không theo phiếu giao (ORDER_OUTCOME.md mục 11).
 */
export async function recordManualPaymentAction(orderId: string, input: unknown): Promise<Success | Failure> {
  const user = await requireUser();
  const r = await recordManualPaymentCore(user, orderId, input);
  if (!r.ok) return failure(r);
  revalidatePath("/orders");
  revalidatePath(`/orders/${encodeURIComponent(r.id)}`);
  return { ok: true, id: r.id, redirectTo: `/orders/${encodeURIComponent(r.id)}`, message: "Đã ghi chứng từ thanh toán" };
}

/** Huỷ chứng từ thanh toán ghi nhầm — bắt buộc lý do; chứng từ giữ làm vết, thôi vào mọi phép tính. */
export async function voidManualPaymentAction(orderId: string, input: unknown): Promise<Success | Failure> {
  const user = await requireUser();
  const r = await voidManualPaymentCore(user, orderId, input);
  if (!r.ok) return failure(r);
  revalidatePath("/orders");
  revalidatePath(`/orders/${encodeURIComponent(r.id)}`);
  return { ok: true, id: r.id, redirectTo: `/orders/${encodeURIComponent(r.id)}`, message: "Đã huỷ chứng từ thanh toán" };
}

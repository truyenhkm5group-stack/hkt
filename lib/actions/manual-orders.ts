"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import type { MetadataErrorCode } from "@/lib/metadata/errors";
import type { FieldError } from "@/lib/metadata/types";
import { cancelManualOrderCore, createManualOrderCore, updateManualOrderCore } from "@/lib/records/order-create";

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

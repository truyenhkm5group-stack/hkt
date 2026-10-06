"use server";

import { revalidatePath } from "next/cache";
import { can, requireUser } from "@/lib/auth/session";
import type { MetaFailure } from "@/lib/metadata/errors";
import { confirmManualDeliveryCore, markManualDeliveryFailedCore } from "@/lib/records/order-create";
import { assignCourierCore, runShippingRouteJob, saveShippingRoutingCore } from "@/lib/shipping/routing";

/**
 * ═══════════ SERVER ACTION TUYẾN GIAO + DANH SÁCH TỰ GIAO (POS tự chủ P7) ═══════════
 *
 * Mỏng: phiên → lõi (`lib/shipping/routing.ts` · `lib/records/order-create.ts`) → `revalidatePath`. «Đã giao» và «Giao không
 * thành công» đi qua ĐÚNG hai lõi của trang đơn (phiếu giao có ký nhận · đơn «Đã hoàn») — danh sách tự giao không có đường ghi
 * kết quả giao thứ hai. Lỗi nghiệp vụ trả `{ error }`.
 */

type Failure = { error: string };

const LIST_PATH = "/orders/self-delivery";

function metaError(r: MetaFailure): Failure {
  return { error: r.errors.map((e) => e.message).join(" · ") || "Không lưu được." };
}

function touchOrder(orderId: string) {
  revalidatePath(LIST_PATH);
  revalidatePath("/orders");
  revalidatePath(`/orders/${encodeURIComponent(orderId)}`);
  revalidatePath("/products");
}

/** Lưu cấu hình tuyến giao (khu tự giao · hãng mặc định · công tắc tự tạo vận đơn). Cần `settings:manage`. */
export async function saveShippingRoutingAction(input: unknown): Promise<{ ok: true; message: string } | Failure> {
  const user = await requireUser();
  const r = await saveShippingRoutingCore(user, input);
  if (!r.ok) return { error: r.error };
  revalidatePath(LIST_PATH);
  revalidatePath("/orders/shipping-routes");
  const areas = r.config.selfAreas.length;
  return { ok: true, message: `Đã lưu tuyến giao — ${areas} khu tự giao · ${r.config.autoCreate ? "máy tự tạo vận đơn cho đơn xác nhận từ bây giờ" : "tự tạo vận đơn đang tắt"}.` };
}

/** Gán / bỏ người giao cho các đơn tự giao đã chọn (khoá tài khoản — luật 34). */
export async function assignCourierAction(orderIds: string[], courierUserId: string | null): Promise<{ ok: true; message: string } | Failure> {
  const user = await requireUser();
  const r = await assignCourierCore(user, { orderIds, courierUserId });
  if (!r.ok) return { error: r.error };
  revalidatePath(LIST_PATH);
  return { ok: true, message: `${courierUserId ? `Đã giao ${r.assigned} đơn cho ${r.courierName}` : `Đã bỏ người giao ở ${r.assigned} đơn`}${r.skipped ? ` · ${r.skipped} đơn không còn chờ giao, bỏ qua` : ""}.` };
}

/** «Đã giao» trên danh sách tự giao — ĐÚNG lõi phiếu giao có ký nhận (G-ORDER, ORDER_OUTCOME.md mục 11). */
export async function selfDeliveredAction(orderId: string, input: unknown): Promise<{ ok: true; message: string } | Failure> {
  const user = await requireUser();
  const r = await confirmManualDeliveryCore(user, orderId, input);
  if (!r.ok) return metaError(r);
  touchOrder(r.id);
  return { ok: true, message: "Đã ghi phiếu giao — đơn giao thành công, hàng trừ khỏi kho; tiền thật vẫn chờ phiếu thu." };
}

/** «Giao không thành công» trên danh sách tự giao — ĐÚNG lõi của trang đơn (đơn «Đã hoàn», hàng về tồn ngay). */
export async function selfDeliveryFailedAction(orderId: string, input: unknown): Promise<{ ok: true; message: string } | Failure> {
  const user = await requireUser();
  const r = await markManualDeliveryFailedCore(user, orderId, input);
  if (!r.ok) return metaError(r);
  touchOrder(r.id);
  return { ok: true, message: "Đã ghi giao không thành công — đơn tính là hoàn, hàng quay lại tồn." };
}

/** «Chạy ngay» lượt máy tự tạo vận đơn (cùng hàm của job `shipping-route`). Cần `shipments:manage`. */
export async function runShippingRouteNowAction(): Promise<{ ok: true; message: string } | Failure> {
  const user = await requireUser();
  if (!can(user, "shipments:manage")) return { error: "Cần quyền vận đơn (shipments:manage) để chạy lượt tạo vận đơn." };
  const r = await runShippingRouteJob({ trigger: "MANUAL", actor: user.email });
  revalidatePath(LIST_PATH);
  if (r.skipped) return { ok: true, message: r.detail };
  return { ok: true, message: `Máy tạo ${r.created} vận đơn · hỏng ${r.failed}${r.detail.length ? ` — ${r.detail.slice(0, 2).join(" · ")}` : ""}.` };
}

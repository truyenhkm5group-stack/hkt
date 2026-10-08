"use server";

import { revalidatePath } from "next/cache";
import { can, requireUser } from "@/lib/auth/session";
import { clearMemo } from "@/lib/cache";
import { requestCarrierAction } from "@/lib/care/service";
import { CARRIER_ACTION_KEYS, type CarrierActionKey } from "@/lib/constants/care";
import { VTP_ORDER_ACTIONS, type VtpOrderActionType } from "@/lib/integrations/viettelpost/client";
import { syncViettelPostShipments } from "@/lib/integrations/viettelpost/sync";
import { applyVtpOrderEdit } from "@/lib/shipping/vtp-edit";

export type VtpActionResult = { ok: true; message: string } | { error: string };

/**
 * ═══════════ MỘT ĐƯỜNG DUY NHẤT GỬI LỆNH SANG ĐVVC ═══════════
 *
 * ─── VÌ SAO HÀM NÀY KHÔNG CÒN TỰ GỌI API ───
 *
 * Trước bản này có HAI đường gửi lệnh "Phát tiếp":
 *
 *   · nút trên trang chi tiết vận đơn  → hàm này, gọi thẳng `client.updateOrder`;
 *   · nút trong bàn làm việc chăm sóc  → `lib/care/service.ts::requestCarrierAction`.
 *
 * Chỉ đường thứ hai kiểm tra điều kiện, chỉ đường thứ hai ghi `carrier_action_requests`, và chỉ
 * đường thứ hai biết dừng lại khi tài khoản API không sở hữu kiện. Đo production 13/09/2026:
 * bảng `carrier_action_requests` có **0 dòng** — nghĩa là mọi lần bấm thật đều đi đường thứ nhất,
 * và **không một lời từ chối nào của Viettel Post từng được lưu lại**. Đó chính là lý do câu hỏi
 * "vì sao HTTP 400" không thể trả lời bằng dữ liệu, chỉ có thể đoán.
 *
 * Nay hàm này CHUYỂN TIẾP sang đúng đường kia. Cùng một lệnh, cùng một sổ, cùng một luật:
 *   · điều kiện xét trên TRẠNG THÁI CON (không phải `stage` — xem redelivery-eligibility.ts);
 *   · tài khoản không sở hữu kiện ⇒ KHÔNG gọi API, ghi `MANUAL_REQUIRED` kèm hướng làm tay;
 *   · thất bại ⇒ lưu đúng câu Viettel Post nói vào `carrier_action_requests.error`;
 *   · bấm hai lần trong ngày với cùng nội dung ⇒ idempotent, không gửi hai yêu cầu.
 *
 * KHÔNG tự đặt trạng thái lạc quan sau khi gửi: lệnh được NHẬN không phải là hàng đã đi tiếp. Chỉ
 * sự kiện hành trình của ĐVVC mới chuyển `ACKNOWLEDGED` → `SUCCESS`.
 */
export async function vtpOrderAction(shipmentId: string, type: VtpOrderActionType, note = ""): Promise<VtpActionResult> {
  const user = await requireUser();
  if (!can(user, "shipments:manage")) return { error: "Không có quyền thao tác vận đơn" };
  const action = VTP_ORDER_ACTIONS.find((a) => a.type === type);
  if (!action) return { error: "Thao tác không hợp lệ" };
  const actionKey = action.key as CarrierActionKey;
  if (!CARRIER_ACTION_KEYS.includes(actionKey)) return { error: `Thao tác “${action.label}” chưa có trong sổ đăng ký hành động ĐVVC` };

  const res = await requestCarrierAction({ id: user.id, email: user.email, name: user.name }, { shipmentId, actionKey, note });
  if ("error" in res) return { error: res.error };
  revalidatePath(`/shipments/${shipmentId}`);
  revalidatePath("/shipments");
  return { ok: true, message: res.data.message };
}

/**
 * Sửa người nhận / SĐT / địa chỉ / tiền thu hộ / ghi chú trên Viettel Post (đơn chưa phát).
 * Lõi (kể cả cổng xác nhận đổi COD) ở `lib/shipping/vtp-edit.ts`; ở đây chỉ quyền + làm mới trang.
 */
export async function vtpEditOrder(shipmentId: string, input: unknown): Promise<VtpActionResult> {
  const user = await requireUser();
  if (!can(user, "shipments:manage")) return { error: "Không có quyền thao tác vận đơn" };
  const res = await applyVtpOrderEdit({ id: user.id, email: user.email, name: user.name }, shipmentId, input);
  if ("error" in res) return { error: res.error };
  await syncViettelPostShipments({ trigger: "MANUAL", actor: user.email, shipmentIds: [shipmentId], includeFinal: true }).catch(() => undefined);
  clearMemo();
  revalidatePath(`/shipments/${shipmentId}`);
  return { ok: true, message: res.message };
}

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { RETURN_CONDITIONS } from "@/lib/constants/returns-condition";
import { recordInspection } from "@/lib/returns/inspection";
import { listPendingReturnedIds, markReturnReceived, undoReturnReceived } from "@/lib/returns/warehouse";

export type ReturnReceiveResult = { ok: true; count: number; message: string } | { error: string };

const schema = z.object({
  ids: z.array(z.string().min(1).max(100)).min(1, "Chưa chọn vận đơn").max(500, "Tối đa 500 vận đơn mỗi lần"),
  note: z.string().trim().max(500).optional(),
});

function revalidate() {
  for (const path of ["/data-quality", "/products", "/inventory", "/inventory/planning", "/shipments", "/"]) revalidatePath(path);
}

/**
 * Kho ghi nhận kiện hàng hoàn ĐÃ VỀ TỚI NƠI.
 *
 * KHÔNG cộng tồn ở bước này: hàng vào tồn khi có người ĐẾM (`submitReturnInspection`), theo số đếm
 * được và chỉ phần còn bán lại được.
 */
export async function confirmReturnReceived(input: unknown): Promise<ReturnReceiveResult> {
  const user = await requireUser();
  if (!can(user, "inventory:write")) return { error: "Bạn không có quyền cập nhật kho" };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };

  const { count, ids } = await markReturnReceived(parsed.data.ids, user.email, parsed.data.note);
  if (!count) return { ok: true, count: 0, message: "Các vận đơn đã được ghi nhận trước đó, không thay đổi gì." };
  await audit({ userId: user.id, userEmail: user.email, action: "return.received", entity: "shipments", entityId: ids.join(","), detail: { count, note: parsed.data.note ?? "" } });
  revalidate();
  return { ok: true, count, message: `Đã ghi nhận ${count} kiện hàng hoàn về kho, đang CHỜ ĐẾM. Hàng vào tồn sau khi kiểm đếm thực tế.` };
}

/** Huỷ ghi nhận đã về khi bấm nhầm. Kiện đã đếm thì không huỷ được — sửa tồn phải qua phiếu điều chỉnh. */
export async function cancelReturnReceived(input: unknown): Promise<ReturnReceiveResult> {
  const user = await requireUser();
  if (!can(user, "inventory:write")) return { error: "Bạn không có quyền cập nhật kho" };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };

  const { count, blocked } = await undoReturnReceived(parsed.data.ids);
  if (!count) {
    return blocked
      ? { error: `${blocked} kiện đã được kiểm đếm nên không huỷ được — muốn sửa tồn thì lập phiếu điều chỉnh kho.` }
      : { ok: true, count: 0, message: "Không có vận đơn nào đang ở trạng thái đã nhận." };
  }
  await audit({ userId: user.id, userEmail: user.email, action: "return.received.undo", entity: "shipments", entityId: parsed.data.ids.join(","), detail: { count, blocked } });
  revalidate();
  const tail = blocked ? ` Bỏ qua ${blocked} kiện đã kiểm đếm.` : "";
  return { ok: true, count, message: `Đã huỷ ghi nhận ${count} vận đơn. Hàng trở lại trạng thái chưa về kho.${tail}` };
}

/** Số vận đơn xử lý mỗi lần bấm — cùng trần với thao tác chọn tay để không có đường vòng. */
const BULK_LIMIT = 500;

/**
 * Xác nhận hàng loạt toàn bộ hàng hoàn ĐÃ VỀ TỚI SHOP mà kho chưa xác nhận.
 *
 * Vì sao cần: thao tác chọn tay chỉ tick được các dòng của trang đang xem, nên tồn đọng lớn
 * (production đang có hàng trăm vận đơn, cũ nhất hơn một tháng) không bao giờ được dọn — hàng có
 * thật trong kho nhưng ERP không cộng vào tồn, làm kế hoạch đặt hàng đặt thừa.
 *
 * Chỉ lấy vận đơn RETURNED (Viettel Post đã trả hàng xong cho người gửi), không đụng vận đơn
 * đang trên đường về. Vẫn là quyết định của con người: server không tự chạy, và huỷ xác nhận
 * được nếu bấm nhầm.
 */
export async function confirmAllReturnedReceived(input: unknown): Promise<ReturnReceiveResult & { remaining?: number }> {
  const user = await requireUser();
  if (!can(user, "inventory:write")) return { error: "Bạn không có quyền cập nhật kho" };
  const parsed = z.object({ note: z.string().trim().max(500).optional() }).safeParse(input ?? {});
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };

  const ids = await listPendingReturnedIds(BULK_LIMIT);
  if (!ids.length) return { ok: true, count: 0, message: "Không còn hàng hoàn nào chờ kho xác nhận." };

  const { count, ids: done } = await markReturnReceived(ids, user.email, parsed.data.note);
  await audit({ userId: user.id, userEmail: user.email, action: "return.received.bulk", entity: "shipments", entityId: done.join(","), detail: { count, note: parsed.data.note ?? "" } });
  revalidate();
  const remaining = (await listPendingReturnedIds(BULK_LIMIT)).length;
  return {
    ok: true,
    count,
    remaining,
    message: remaining
      ? `Đã ghi nhận ${count} kiện hàng hoàn về kho. Còn ${remaining} kiện — bấm tiếp để xử lý nốt.`
      : `Đã ghi nhận ${count} kiện hàng hoàn về kho. Tất cả đang CHỜ ĐẾM — hàng vào tồn sau khi kiểm đếm.`,
  };
}

// ───────────────────────── KIỂM ĐẾM MỘT KIỆN HÀNG HOÀN ─────────────────────────

const inspectionSchema = z
  .object({
    shipmentId: z.string().min(1, "Thiếu vận đơn").max(100),
    condition: z.enum(RETURN_CONDITIONS),
    restockQty: z.coerce.number().int().min(0, "Số món không được âm").max(10_000),
    unsellableQty: z.coerce.number().int().min(0, "Số món không được âm").max(10_000),
    note: z.string().trim().max(1000).default(""),
  })
  .refine((v) => v.condition === "RESTOCKABLE" || v.note.length > 0, {
    path: ["note"],
    message: "Kết luận không bán được thì phải ghi rõ vì sao",
  });

export type InspectionActionResult = { ok: true; restocked: number; message: string } | { error: string };

/**
 * Kho ĐẾM XONG một kiện hàng hoàn.
 *
 * Đây là điểm DUY NHẤT hàng hoàn được cộng lại tồn — và chỉ đúng phần người đếm nói là còn bán được.
 * Phần không bán được ghi thành số riêng để nhìn thấy được mức hao, thay vì giấu nó bằng cách lặng lẽ
 * không cộng vào.
 */
export async function submitReturnInspection(input: unknown): Promise<InspectionActionResult> {
  const user = await requireUser();
  if (!can(user, "inventory:write")) return { error: "Bạn không có quyền cập nhật kho" };
  const parsed = inspectionSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };

  const result = await recordInspection({ ...parsed.data, actor: user.email });
  if ("error" in result) return { error: result.error };

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "return.inspected",
    entity: "shipments",
    entityId: parsed.data.shipmentId,
    detail: { condition: parsed.data.condition, restockQty: result.restocked, unsellableQty: parsed.data.unsellableQty, receiptId: result.receiptId ?? "" },
  });
  revalidate();

  const restocked = result.restocked;
  return {
    ok: true,
    restocked,
    message: restocked
      ? `Đã kiểm đếm: ${restocked} món vào lại tồn${parsed.data.unsellableQty ? `, ${parsed.data.unsellableQty} món không bán được` : ""}.`
      : `Đã kiểm đếm: không món nào vào lại tồn (${parsed.data.unsellableQty} món không bán được).`,
  };
}

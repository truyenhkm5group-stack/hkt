"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { markReturnReceived, undoReturnReceived } from "@/lib/returns/warehouse";

export type ReturnReceiveResult = { ok: true; count: number; message: string } | { error: string };

const schema = z.object({
  ids: z.array(z.string().min(1).max(100)).min(1, "Chưa chọn vận đơn").max(500, "Tối đa 500 vận đơn mỗi lần"),
  note: z.string().trim().max(500).optional(),
});

function revalidate() {
  for (const path of ["/data-quality", "/products", "/inventory", "/inventory/planning", "/shipments", "/"]) revalidatePath(path);
}

/** Kho xác nhận đã nhận hàng hoàn → hàng được cộng lại tồn ERP. */
export async function confirmReturnReceived(input: unknown): Promise<ReturnReceiveResult> {
  const user = await requireUser();
  if (!can(user, "inventory:write")) return { error: "Bạn không có quyền cập nhật kho" };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };

  const { count, ids } = await markReturnReceived(parsed.data.ids, user.email, parsed.data.note);
  if (!count) return { ok: true, count: 0, message: "Các vận đơn đã được xác nhận trước đó, không thay đổi gì." };
  await audit({ userId: user.id, userEmail: user.email, action: "return.received", entity: "shipments", entityId: ids.join(","), detail: { count, note: parsed.data.note ?? "" } });
  revalidate();
  return { ok: true, count, message: `Đã xác nhận nhận ${count} kiện hàng hoàn về kho. Tồn kho đã được cộng lại.` };
}

/** Huỷ xác nhận nhận hoàn khi ghi nhầm → hàng bị trừ khỏi tồn ERP trở lại. */
export async function cancelReturnReceived(input: unknown): Promise<ReturnReceiveResult> {
  const user = await requireUser();
  if (!can(user, "inventory:write")) return { error: "Bạn không có quyền cập nhật kho" };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };

  const { count } = await undoReturnReceived(parsed.data.ids);
  if (!count) return { ok: true, count: 0, message: "Không có vận đơn nào đang ở trạng thái đã nhận." };
  await audit({ userId: user.id, userEmail: user.email, action: "return.received.undo", entity: "shipments", entityId: parsed.data.ids.join(","), detail: { count } });
  revalidate();
  return { ok: true, count, message: `Đã huỷ xác nhận ${count} vận đơn. Hàng trở lại trạng thái chưa về kho.` };
}

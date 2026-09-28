"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { refreshPendingReturns } from "@/lib/care/pancake-refresh";

export type PancakeRefreshResult = { error?: string; ok?: true; checked: number; closed: number; failed: number };

/**
 * Nút "Kiểm tra duyệt hoàn" trên /shipments — cùng hàm với job `care-return-check`
 * (lib/care/pancake-refresh.ts), chỉ thêm quyền, nhật ký và làm mới trang.
 */
export async function refreshPendingReturnsFromPancake(): Promise<PancakeRefreshResult> {
  const user = await requireUser();
  if (!can(user, "shipments:manage")) return { error: "Bạn không có quyền xử lý case vận đơn", checked: 0, closed: 0, failed: 0 };
  const r = await refreshPendingReturns(await getDb());
  await audit({
    userId: user.id,
    userEmail: user.email ?? "",
    action: "care.pancake-refresh",
    entity: "SHIPMENT",
    entityId: "care-queue",
    after: r,
    reason: "Hỏi lại Pancake cho các ca đang chờ quyết định hoàn (VTP không gửi 515 qua webhook)",
  });
  revalidatePath("/shipments");
  return { ok: true, ...r };
}

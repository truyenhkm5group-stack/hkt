"use server";

import { can, requireUser } from "@/lib/auth/session";
import type { ReconcileReason } from "@/lib/constants/vtp-reconcile-queue";
import { getVtpReconcileCodes } from "@/lib/queries/vtp-reconcile-queue";

/**
 * Lấy TOÀN BỘ mã vận đơn của hàng đợi đối chiếu (theo lý do đang chọn), không phải những mã đang
 * hiện trên màn hình.
 *
 * CHỈ ĐỌC: không ghi một dòng nào, không gọi Viettel Post một câu nào. Nó tồn tại vì nút "chép
 * toàn bộ" phải nói đúng chữ "toàn bộ" — xem `getVtpReconcileCodes`.
 *
 * Quyền `shipments:view`: ai nhìn thấy hàng đợi thì chép được mã của chính hàng đợi ấy.
 */
export async function layMaDoiChieu(reason?: ReconcileReason | "all"): Promise<{ data: string[] } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "shipments:view")) return { error: "Không có quyền xem vận đơn" };
  return { data: await getVtpReconcileCodes(reason) };
}

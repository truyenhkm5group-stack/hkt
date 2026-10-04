"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { setPlatformCostDeclaration } from "@/lib/platform/saas-ledger";

/**
 * Vỏ Next của Owner Cockpit (`/platform/saas`): đọc phiên → lõi `setPlatformCostDeclaration` (hỏi lại người vận hành,
 * bắt buộc căn cứ, nhật ký nền tảng) → làm mới trang.
 */
export async function setPlatformCostsAction(input: { infraMonthlyVnd: string; supportMonthlyVnd: string; reason: string }): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requirePermission("platform:operate");
  const r = await setPlatformCostDeclaration(user, input ?? {});
  if ("ok" in r) revalidatePath("/platform/saas");
  return r;
}

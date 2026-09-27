"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { toggleModuleForOrganization, toggleOwnFeature, toggleOwnModule, type ToggleResult } from "@/lib/platform-ui/module-toggle";

/**
 * ═══════════ BẬT / TẮT MODULE — BA SERVER ACTION ═══════════
 *
 * Đường ghi DUY NHẤT là `lib/platform/module-config.ts` (kiểm phụ thuộc + hai nhật ký + xoá đệm năng
 * lực). Tệp này chỉ: đọc phiên → lõi ở `lib/platform-ui/module-toggle.ts` (kiểm quyền lần hai, zod,
 * dịch lỗi) → `revalidatePath`.
 *
 * `revalidatePath("/", "layout")` vì thanh menu nằm ở layout: bật một module là mục menu của nó hiện
 * ngay ở lần dựng kế tiếp. KHÔNG gọi thêm `router.refresh()` ở phía client — hai cơ chế cùng lúc là
 * dựng trang hai lần (tiền lệ PR #272).
 */

export async function toggleModuleAction(input: { moduleKey: string; enabled: boolean; reason?: string }): Promise<ToggleResult> {
  const user = await requirePermission("modules:manage");
  const result = await toggleOwnModule(user, input);
  if ("ok" in result && result.changed) revalidatePath("/", "layout");
  return result;
}

export async function toggleFeatureAction(input: { featureKey: string; enabled: boolean; reason?: string }): Promise<ToggleResult> {
  const user = await requirePermission("modules:manage");
  const result = await toggleOwnFeature(user, input);
  if ("ok" in result && result.changed) revalidatePath("/", "layout");
  return result;
}

/** Chỉ người của tổ chức nhà có `platform:operate` — kiểm ở đây (phiên) VÀ ở lõi (tổ chức nhà). */
export async function toggleModuleForOrgAction(input: { orgCode: string; moduleKey: string; enabled: boolean; reason: string }): Promise<ToggleResult> {
  const user = await requirePermission("platform:operate");
  const result = await toggleModuleForOrganization(user, input);
  if ("ok" in result && result.changed) revalidatePath("/platform");
  return result;
}

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { SLOW_MOVING_DAYS_MAX, SLOW_MOVING_DAYS_MIN, SLOW_MOVING_KEY, slowMovingRulesProblem, sparseSlowMovingOverride } from "@/lib/constants/slow-moving";
import { loadSlowMovingRules } from "@/lib/queries/slow-moving";
import { setSettingJson } from "@/lib/settings";

const day = z.number({ error: "Nhập số ngày" }).int("Số ngày phải là số nguyên").min(SLOW_MOVING_DAYS_MIN).max(SLOW_MOVING_DAYS_MAX);
const schema = z.object({ deadDays: day, excessCoverDays: day, slowCoverDays: day, healthyCoverDays: day });

/**
 * Lưu ngưỡng hàng chậm / vốn nằm chết (`inventory.slowMoving`).
 *
 * Lưu THƯA: chỉ ô khác mặc định trong mã. Bộ sai thứ tự bị TỪ CHỐI cả bộ (không sửa hộ ô nào) —
 * cùng luật với lúc đọc, để thứ người lưu được cũng là thứ máy dùng được.
 */
export async function saveSlowMovingRules(input: unknown): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "planning:write")) return { error: "Không có quyền" };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const problem = slowMovingRulesProblem(parsed.data);
  if (problem) return { error: problem };
  const before = await loadSlowMovingRules();
  const sparse = sparseSlowMovingOverride(parsed.data);
  await setSettingJson(SLOW_MOVING_KEY, sparse);
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "SETTINGS_UPDATE",
    entity: "SETTINGS",
    entityId: SLOW_MOVING_KEY,
    before: before.rules,
    after: parsed.data,
    detail: { stored: sparse },
  });
  revalidatePath("/inventory/planning");
  revalidatePath("/inventory/decisions");
  return { ok: true };
}

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { PLANNING_KEY } from "@/lib/constants/planning";
import { setSettingJson } from "@/lib/settings";

const schema = z.object({
  leadTimeDays: z.number().int().min(1).max(180),
  coverDays: z.number().int().min(0).max(365),
  velocityWindowDays: z.number().int().min(3).max(180),
  safetyDays: z.number().int().min(0).max(60),
  roundTo: z.number().int().min(1).max(1000),
  leadTimeOverrides: z.record(z.string(), z.number().int().min(1).max(180)).default({}),
});

export async function savePlanningAssumptions(input: unknown): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "inventory:write")) return { error: "Không có quyền" };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  await setSettingJson(PLANNING_KEY, parsed.data);
  await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: PLANNING_KEY, detail: parsed.data });
  revalidatePath("/inventory/planning");
  revalidatePath("/alerts");
  return { ok: true };
}

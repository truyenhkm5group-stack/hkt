"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import type { AgentZone } from "@/lib/constants/department-ai";
import type { GraduationRule } from "@/lib/constants/mission-control";
import { setGraduationCore, type GraduationResult } from "@/lib/mission-control/settings";

/** Vỏ Next của điều kiện tốt nghiệp. Lõi (`lib/mission-control/settings.ts`) tự kiểm quyền `settings:manage` + zod. */
export async function setGraduationAction(zone: AgentZone, rule: GraduationRule | null): Promise<GraduationResult> {
  const user = await requireUser();
  const r = await setGraduationCore(user, { zone, rule });
  if (r.ok && r.changed) revalidatePath("/departments/mission-control");
  return r;
}

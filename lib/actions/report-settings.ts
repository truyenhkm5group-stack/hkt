"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { DEFAULT_PROFIT_ASSUMPTIONS, PROFIT_ASSUMPTIONS_KEY, type ProfitAssumptions } from "@/lib/constants/profit";
import { getSettingJson, setSettingJson } from "@/lib/settings";

const schema = z.object({
  shipFeeDelivered: z.number().int().min(0).max(1_000_000),
  shipFeeReturned: z.number().int().min(0).max(1_000_000),
  returnRateWindowDays: z.number().int().min(7).max(730),
  defaultReturnRate: z.number().min(0).max(100),
  minFinishedOrders: z.number().int().min(1).max(10_000),
  overrides: z.record(z.string(), z.number().min(0).max(100)),
});

export async function saveProfitAssumptions(input: unknown): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  if (!can(user.role, "expenses:write")) return { error: "Không có quyền" };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const before = await getSettingJson<ProfitAssumptions>(PROFIT_ASSUMPTIONS_KEY, DEFAULT_PROFIT_ASSUMPTIONS);
  await setSettingJson(PROFIT_ASSUMPTIONS_KEY, parsed.data);
  await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: PROFIT_ASSUMPTIONS_KEY, detail: { before, after: parsed.data } });
  revalidatePath("/reports");
  return { ok: true };
}

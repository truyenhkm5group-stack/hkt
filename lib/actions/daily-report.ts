"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import type { DailyReportConfig } from "@/lib/constants/daily-report";
import { setDailyReportConfigCore, type ConfigResult } from "@/lib/daily-report/service";

/** Vỏ Next của cấu hình báo cáo ngày. Lõi tự kiểm `settings:manage` + zod; lưu lặp không ghi. */
export async function setDailyReportConfigAction(cfg: DailyReportConfig): Promise<ConfigResult> {
  const user = await requireUser();
  const r = await setDailyReportConfigCore(user, cfg);
  if (r.ok && r.changed) revalidatePath("/daily-report");
  return r;
}

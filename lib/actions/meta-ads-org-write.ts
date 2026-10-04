"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { saveOrgAdsWriteCore } from "@/lib/marketing/meta-ads-org-write";

/**
 * Bật / tắt «Cho ERP đăng quảng cáo bằng token của tổ chức» (tổ chức khách, chủ nền tảng chốt 04/10/2026). Luật và chốt:
 * `lib/marketing/meta-ads-org-write.ts`. Người thao tác do MÁY CHỦ ghi từ phiên (mục 34).
 */
const inputSchema = z.object({ enabled: z.boolean() });

export async function setOrgAdsWriteAction(input: unknown): Promise<{ ok: true; enabled: boolean } | { error: string }> {
  const user = await requireUser();
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const r = await saveOrgAdsWriteCore(user, parsed.data.enabled);
  if ("error" in r) return r;
  revalidatePath("/marketing/creatives");
  return r;
}

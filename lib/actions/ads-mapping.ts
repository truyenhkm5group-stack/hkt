"use server";

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { loadAdsMapping, reapplyAdsMapping, saveCampaignMap, saveProductAliases } from "@/lib/integrations/facebook/mapping";

type Result = { ok: true; changed: number } | { error: string };

function revalidate() {
  for (const path of ["/expenses", "/reports", "/"]) revalidatePath(path);
}

/** Ghép một chiến dịch với mã hàng ("" = chung, "__exclude__" = không tính, "__auto__" = bỏ ghép tay) */
export async function setCampaignProduct(campaignId: string, value: string): Promise<Result> {
  const user = await requireUser();
  if (!can(user.role, "expenses:write")) return { error: "Không có quyền" };
  if (!campaignId) return { error: "Thiếu mã chiến dịch" };
  const { campaignMap } = await loadAdsMapping();
  if (value === "__auto__") delete campaignMap[campaignId];
  else if (value === "__exclude__") campaignMap[campaignId] = { productId: null, exclude: true };
  else campaignMap[campaignId] = { productId: value || null, exclude: false };
  await saveCampaignMap(campaignMap);
  const result = await reapplyAdsMapping();
  await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: "ads.campaignMap", detail: { campaignId, value } });
  revalidate();
  return { ok: true, changed: result.changed };
}

/** Bí danh trong tên chiến dịch cho một mã hàng, cách nhau bằng dấu phẩy */
export async function setProductAliases(productId: string, aliasesText: string): Promise<Result> {
  const user = await requireUser();
  if (!can(user.role, "expenses:write")) return { error: "Không có quyền" };
  if (!productId) return { error: "Thiếu mã hàng" };
  const { aliases } = await loadAdsMapping();
  const list = [...new Set(aliasesText.split(/[,;\n]/).map((a) => a.trim().toLowerCase()).filter((a) => a.length >= 2))].slice(0, 30);
  if (list.length) aliases[productId] = list;
  else delete aliases[productId];
  await saveProductAliases(aliases);
  const result = await reapplyAdsMapping();
  await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: "ads.productAliases", detail: { productId, aliases: list } });
  revalidate();
  return { ok: true, changed: result.changed };
}

"use server";

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { type CampaignMap, loadAdsMapping, reapplyAdsMapping, saveCampaignMap, saveProductAliases } from "@/lib/integrations/facebook/mapping";

type Result = { ok: true; changed: number } | { error: string };

function revalidate() {
  for (const path of ["/ads", "/expenses", "/reports", "/"]) revalidatePath(path);
}

function applyProduct(campaignMap: CampaignMap, campaignId: string, value: string) {
  const current = campaignMap[campaignId] ?? { productId: null, exclude: false };
  const keepMarketer = current.marketerId;
  if (value === "__auto__") {
    if (keepMarketer !== undefined) campaignMap[campaignId] = { productId: null, exclude: false, marketerId: keepMarketer };
    else delete campaignMap[campaignId];
  } else if (value === "__exclude__") campaignMap[campaignId] = { ...current, productId: null, exclude: true, testCost: false };
  else if (value === "__test__") campaignMap[campaignId] = { ...current, productId: null, exclude: false, testCost: true };
  else campaignMap[campaignId] = { ...current, productId: value || null, exclude: false, testCost: false };
}

function applyMarketer(campaignMap: CampaignMap, campaignId: string, value: string) {
  const current = campaignMap[campaignId] ?? { productId: null, exclude: false };
  if (value === "__auto__") {
    delete current.marketerId;
    if (!current.exclude && !current.productId && !current.testCost) delete campaignMap[campaignId];
    else campaignMap[campaignId] = current;
  } else campaignMap[campaignId] = { ...current, marketerId: value || null };
}

/** Ghép một chiến dịch với mã hàng ("__test__" = chi phí test không thuộc mã, "__exclude__" = không tính, "__auto__" = bỏ ghép tay) */
export async function setCampaignProduct(campaignId: string, value: string): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  if (!campaignId) return { error: "Thiếu mã chiến dịch" };
  const { campaignMap } = await loadAdsMapping();
  applyProduct(campaignMap, campaignId, value);
  await saveCampaignMap(campaignMap);
  const result = await reapplyAdsMapping();
  await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: "ads.campaignMap", detail: { campaignId, value } });
  revalidate();
  return { ok: true, changed: result.changed };
}

/** Gán marketer cho một chiến dịch ("" = không ai, "__auto__" = tự nhận diện theo bí danh / tài khoản) */
export async function setCampaignMarketer(campaignId: string, value: string): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  if (!campaignId) return { error: "Thiếu mã chiến dịch" };
  const { campaignMap } = await loadAdsMapping();
  applyMarketer(campaignMap, campaignId, value);
  await saveCampaignMap(campaignMap);
  const result = await reapplyAdsMapping();
  await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: "ads.campaignMap", detail: { campaignId, marketer: value } });
  revalidate();
  revalidatePath("/payroll");
  return { ok: true, changed: result.changed };
}

/** Gán hàng loạt: mã hàng và/hoặc marketer cho nhiều chiến dịch cùng lúc (bỏ trống trường nào thì giữ nguyên) */
export async function bulkSetCampaigns(campaignIds: string[], patch: { product?: string; marketer?: string }): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  const ids = [...new Set((campaignIds ?? []).filter((id) => typeof id === "string" && id))].slice(0, 2000);
  if (!ids.length) return { error: "Chưa chọn chiến dịch nào" };
  if (patch.product === undefined && patch.marketer === undefined) return { error: "Chọn mã hàng hoặc marketer để áp dụng" };
  const { campaignMap } = await loadAdsMapping();
  for (const id of ids) {
    if (patch.product !== undefined) applyProduct(campaignMap, id, patch.product);
    if (patch.marketer !== undefined) applyMarketer(campaignMap, id, patch.marketer);
  }
  await saveCampaignMap(campaignMap);
  const result = await reapplyAdsMapping();
  await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: "ads.campaignMap", detail: { campaignIds: ids, ...patch } });
  revalidate();
  revalidatePath("/payroll");
  return { ok: true, changed: result.changed };
}

/** Bí danh trong tên chiến dịch cho một mã hàng, cách nhau bằng dấu phẩy */
export async function setProductAliases(productId: string, aliasesText: string): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
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

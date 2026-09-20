"use server";

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { type CampaignMap, loadAdsMapping, reapplyAdsMapping, saveCampaignMap, saveProductAliases } from "@/lib/integrations/facebook/mapping";
import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";

/**
 * `warning` = lượt ghi ĐÃ XONG nhưng có chuyện phải biết. Khác hẳn `error` (không ghi gì cả).
 * Gộp hai thứ này làm một là hoặc chặn một lượt ghi hợp lệ, hoặc nuốt mất một cảnh báo thật.
 */
type Result = { ok: true; changed: number; warning?: string } | { error: string };

/**
 * ═══════════ MÃ HÀNG PHẢI CÓ THẬT MỚI ĐƯỢC LƯU VÀO BẢNG GHÉP ═══════════
 *
 * Bảng ghép nằm ở `settings` (một ô JSON), nên CSDL không ràng buộc được gì. Nhưng thứ nó trỏ tới
 * lại đi thẳng vào `ad_spends.product_id` — cột CÓ khoá ngoại. Một mã hàng không tồn tại lọt vào
 * đây thì `reapplyAdsMapping()` ném lỗi mỗi lượt chạy, và trước ngày 20/09/2026 cú ném đó làm cả
 * job `facebook-ads` ghi FAILED nhiều giờ liền.
 *
 * Chặn ở ĐƯỜNG VÀO là chỗ rẻ nhất và rõ nhất: người bấm biết ngay mình vừa chọn gì, thay vì một
 * job nền hỏng lúc 4 giờ sáng ba ngày sau.
 */
async function productsExist(ids: string[]): Promise<Set<string>> {
  // KHÔNG đặt tên biến là `can`: tệp này dùng `can(user, ...)` làm cổng quyền, và che nó đi trong
  // một hàm là mời một lần sửa sau này gọi nhầm mảng thành hàm kiểm quyền.
  const canKiem = [...new Set(ids.filter(Boolean))];
  if (!canKiem.length) return new Set();
  const db = await getDb();
  const rows = await db.select({ id: schema.products.id }).from(schema.products).where(inArray(schema.products.id, canKiem));
  return new Set(rows.map((r) => r.id));
}

/** Câu cảnh báo cho những dòng ghép ĐANG CÓ SẴN trỏ vào mã hàng đã biến mất. `null` = không có dòng nào. */
function danglingWarning(dangling: { campaignId: string; campaign: string; productId: string }[]): string | undefined {
  if (!dangling.length) return undefined;
  const ten = dangling.slice(0, 5).map((d) => `${d.campaign || d.campaignId} → ${d.productId}`);
  return `${dangling.length} chiến dịch đang ghép vào mã hàng KHÔNG CÒN TỒN TẠI nên chưa áp được (dữ liệu cũ giữ nguyên): ${ten.join(" · ")}${dangling.length > 5 ? " …" : ""}`;
}

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
  // Bốn giá trị điều khiển KHÔNG phải mã hàng; chỉ giá trị còn lại mới phải có thật trong sổ.
  const laDieuKhien = value === "__auto__" || value === "__exclude__" || value === "__test__" || value === "";
  if (!laDieuKhien && !(await productsExist([value])).has(value)) {
    return { error: `Mã hàng "${value}" không có trong sổ sản phẩm — không lưu ghép này. Ghép trỏ vào mã đã biến mất sẽ làm job đồng bộ quảng cáo hỏng ở mỗi lượt chạy.` };
  }
  const { campaignMap } = await loadAdsMapping();
  applyProduct(campaignMap, campaignId, value);
  await saveCampaignMap(campaignMap);
  const result = await reapplyAdsMapping();
  await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: "ads.campaignMap", detail: { campaignId, value } });
  revalidate();
  return { ok: true, changed: result.changed, warning: danglingWarning(result.danglingProducts) };
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
  return { ok: true, changed: result.changed, warning: danglingWarning(result.danglingProducts) };
}

/** Gán hàng loạt: mã hàng và/hoặc marketer cho nhiều chiến dịch cùng lúc (bỏ trống trường nào thì giữ nguyên) */
export async function bulkSetCampaigns(campaignIds: string[], patch: { product?: string; marketer?: string }): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  const ids = [...new Set((campaignIds ?? []).filter((id) => typeof id === "string" && id))].slice(0, 2000);
  if (!ids.length) return { error: "Chưa chọn chiến dịch nào" };
  if (patch.product === undefined && patch.marketer === undefined) return { error: "Chọn mã hàng hoặc marketer để áp dụng" };
  const dk = patch.product === "__auto__" || patch.product === "__exclude__" || patch.product === "__test__" || patch.product === "";
  if (patch.product !== undefined && !dk && !(await productsExist([patch.product])).has(patch.product)) {
    return { error: `Mã hàng "${patch.product}" không có trong sổ sản phẩm — không lưu ghép nào.` };
  }
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
  return { ok: true, changed: result.changed, warning: danglingWarning(result.danglingProducts) };
}

/** Bí danh trong tên chiến dịch cho một mã hàng, cách nhau bằng dấu phẩy */
export async function setProductAliases(productId: string, aliasesText: string): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  if (!productId) return { error: "Thiếu mã hàng" };
  if (!(await productsExist([productId])).has(productId)) {
    return { error: `Mã hàng "${productId}" không có trong sổ sản phẩm — không lưu bí danh cho nó.` };
  }
  const { aliases } = await loadAdsMapping();
  const list = [...new Set(aliasesText.split(/[,;\n]/).map((a) => a.trim().toLowerCase()).filter((a) => a.length >= 2))].slice(0, 30);
  if (list.length) aliases[productId] = list;
  else delete aliases[productId];
  await saveProductAliases(aliases);
  const result = await reapplyAdsMapping();
  await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: "ads.productAliases", detail: { productId, aliases: list } });
  revalidate();
  return { ok: true, changed: result.changed, warning: danglingWarning(result.danglingProducts) };
}

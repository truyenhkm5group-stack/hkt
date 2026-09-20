import { normalize } from "@/lib/text";
import { moTaLoiCsdl } from "@/lib/db/error-message";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { loadProductCodeIndex } from "@/lib/integrations/facebook/sync";
import { matchCampaignToProduct, type ProductCodeEntry } from "@/lib/integrations/facebook/match";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { PAYROLL_EMPLOYEES_KEY, type Employee } from "@/lib/constants/payroll";

export const ADS_CAMPAIGN_MAP_KEY = "ads.campaignMap";
export const ADS_ALIASES_KEY = "ads.productAliases";

/** Ghép thủ công theo campaignId: productId (null = chung, không theo mã) và exclude (không tính) */
export type CampaignMap = Record<string, { productId: string | null; exclude: boolean; marketerId?: string | null; testCost?: boolean }>;
/** Bí danh xuất hiện trong tên chiến dịch → productId (vd "q2" → Đầm Q002) */
export type ProductAliases = Record<string, string[]>;

export type AdsMapping = { campaignMap: CampaignMap; aliases: ProductAliases; employees: Employee[] };

export async function loadAdsMapping(): Promise<AdsMapping> {
  const [campaignMap, aliases, payroll] = await Promise.all([
    getSettingJson<CampaignMap>(ADS_CAMPAIGN_MAP_KEY, {}),
    getSettingJson<ProductAliases>(ADS_ALIASES_KEY, {}),
    getSettingJson<{ list: Employee[] }>(PAYROLL_EMPLOYEES_KEY, { list: [] }),
  ]);
  return { campaignMap, aliases, employees: payroll.list ?? [] };
}

export async function saveCampaignMap(map: CampaignMap) {
  await setSettingJson(ADS_CAMPAIGN_MAP_KEY, map);
}

export async function saveProductAliases(aliases: ProductAliases) {
  await setSettingJson(ADS_ALIASES_KEY, aliases);
}

/** Chữ thường, bỏ dấu tiếng Việt, đ→d, mọi ký tự khác chữ/số thành khoảng trắng */
export { normalize };

/** Marketer của chiến dịch: ghép tay → bí danh trong tên chiến dịch → tài khoản quảng cáo mặc định của marketer */
export function resolveMarketer(campaignId: string, campaignName: string, accountId: string | null, mapping: AdsMapping): string | null {
  const manual = mapping.campaignMap[campaignId];
  if (manual && manual.marketerId !== undefined) return manual.marketerId;
  const name = normalize(campaignName);
  const hits = mapping.employees
    .filter((e) => e.active !== false)
    .flatMap((e) => (e.aliases ?? []).map((alias) => ({ id: e.id, alias: normalize(alias).trim() })))
    .filter((a) => a.alias && name.includes(` ${a.alias} `))
    .sort((a, b) => b.alias.length - a.alias.length);
  if (hits[0]) return hits[0].id;
  if (accountId) {
    const byAccount = mapping.employees.find((e) => e.active !== false && (e.accountIds ?? []).includes(accountId));
    if (byAccount) return byAccount.id;
  }
  return null;
}

/** Thứ tự ưu tiên: ghép tay theo chiến dịch → bí danh → mã tự nhận diện trong tên. Không thuộc mã nào = chi phí test. */
export function resolveCampaign(campaignId: string, campaignName: string, mapping: AdsMapping, index: ProductCodeEntry[], accountId: string | null = null): { productId: string | null; excluded: boolean; marketerId: string | null; source: "manual" | "alias" | "auto" | "test" | "none" } {
  const marketerId = resolveMarketer(campaignId, campaignName, accountId, mapping);
  const manual = mapping.campaignMap[campaignId];
  if (manual && (manual.exclude || manual.productId !== undefined && (manual.productId || manual.testCost))) {
    return { productId: manual.exclude ? null : manual.productId, excluded: manual.exclude, marketerId, source: "manual" };
  }
  const name = normalize(campaignName);
  // Tên chiến dịch có chữ TEST → chi phí test (không thuộc mã), kể cả khi có mã hàng trong tên
  if (/ test /.test(name) || /_test_|_test$|^test_/.test(campaignName.toLowerCase())) return { productId: null, excluded: false, marketerId, source: "test" };
  const aliasHits = Object.entries(mapping.aliases)
    .flatMap(([productId, list]) => list.map((alias) => ({ productId, alias: alias.trim().toLowerCase() })))
    .filter((a) => a.alias && (name.includes(` ${a.alias} `) || (a.alias.length >= 3 && name.includes(a.alias))))
    .sort((a, b) => b.alias.length - a.alias.length);
  if (aliasHits[0]) return { productId: aliasHits[0].productId, excluded: false, marketerId, source: "alias" };
  const auto = matchCampaignToProduct(campaignName, index);
  return { productId: auto, excluded: false, marketerId, source: auto ? "auto" : "none" };
}

/**
 * ═══════════ ÁP LẠI GHÉP MÃ HÀNG — VÀ VÌ SAO NÓ KHÔNG ĐƯỢC PHÉP GIẾT LƯỢT ĐỒNG BỘ ═══════════
 *
 * SỰ CỐ THẬT (đo 20/09/2026). `facebook-ads` báo FAILED lặp lại nhiều giờ, câu lệnh hỏng là
 * `update "ad_spends" ... returning "id"` — tức ĐÚNG hàm này. Ba tính chất cộng lại thành một
 * lỗi im lặng và VĨNH VIỄN:
 *
 *  1. `ad_spends.product_id` có KHOÁ NGOẠI tới `products.id`.
 *  2. Nhưng `productId` ở đây đến từ **`settings`** (`ads.campaignMap`, `ads.productAliases`) —
 *     những chuỗi NGƯỜI đã lưu lúc ghép tay. Không gì ràng buộc chúng còn tồn tại trong
 *     `products`; sổ mã hàng đổi mà bảng ghép thì không đổi theo.
 *  3. Hàm được gọi ở CUỐI `syncFacebookAds`, NGOÀI mọi `try/catch`. Nên một dòng ghép trỏ vào
 *     một mã hàng không còn tồn tại làm hỏng cả lượt chạy — **sau khi** toàn bộ số liệu quảng
 *     cáo đã ghi xong. `sync_runs` ghi FAILED cho một lượt đã làm đúng việc của nó.
 *
 * Và vì nguyên nhân là TẤT ĐỊNH (cùng bảng ghép, cùng dòng, cùng cú ném), nó lặp lại mỗi lượt
 * chạy, mãi mãi, trong khi màn hình chỉ nói "FAILED" — không ai phân biệt được *đồng bộ hỏng*
 * với *một bước dọn dẹp hỏng*, mà hai thứ đó sửa ở hai chỗ khác hẳn.
 *
 * ─── BA THAY ĐỔI, VÀ KHÔNG THAY ĐỔI NÀO ĐỤNG VÀO MỘT CON SỐ ───
 *
 *  · **Mã hàng phải CÓ THẬT mới được ghi.** Kiểm trước bằng một câu đọc `products`. Dòng ghép trỏ
 *    vào mã đã biến mất thì BỎ QUA — giữ nguyên dữ liệu cũ, KHÔNG ghi `null`. Ghi `null` là lặng
 *    lẽ gỡ chi phí quảng cáo khỏi một mã hàng, và báo cáo lợi nhuận đổi số mà không ai được báo
 *    (AGENTS.md mục 8.8). Bỏ qua thì số giữ nguyên, và lý do được nêu tên.
 *  · **Một chiến dịch hỏng không kéo theo 200 chiến dịch còn lại.** Mỗi lượt ghi có `try/catch`
 *    riêng; câu lỗi được giữ lại để in ra, không nuốt.
 *  · **Trả về cái đã bỏ qua.** Một hàm im lặng làm ít hơn lời hứa của nó là hàm không ai kiểm được.
 */
export type ReapplyAdsMappingResult = {
  campaigns: number;
  changed: number;
  /** Chiến dịch trỏ vào mã hàng KHÔNG CÒN TỒN TẠI — nêu tên để người sửa được bảng ghép. */
  danglingProducts: { campaignId: string; campaign: string; productId: string }[];
  /** Lỗi ghi của từng chiến dịch. Rỗng = mọi lượt ghi đều qua. */
  errors: { campaignId: string; message: string }[];
};

export async function reapplyAdsMapping(): Promise<ReapplyAdsMappingResult> {
  const db = await getDb();
  const [mapping, index] = await Promise.all([loadAdsMapping(), loadProductCodeIndex()]);
  const rows = await db
    .select({ campaignId: schema.adSpends.campaignId, campaign: sql<string>`max(${schema.adSpends.campaign})`, accountId: sql<string | null>`max(${schema.adSpends.accountId})` })
    .from(schema.adSpends)
    .where(and(eq(schema.adSpends.platform, "Facebook"), sql`${schema.adSpends.campaignId} is not null`))
    .groupBy(schema.adSpends.campaignId);

  /*
    ĐỌC SỔ MÃ HÀNG MỘT LẦN, KHÔNG HỎI MỖI DÒNG.

    Đọc cả cột `id` của `products` chứ KHÔNG lọc `is_removed`: câu hỏi ở đây là "khoá ngoại có
    thoả không", và một mã hàng đã ẩn vẫn còn dòng trong bảng nên vẫn ghi được. Lọc `is_removed`
    ở đây sẽ bỏ qua cả những ghép hoàn toàn hợp lệ.
  */
  const coThat = new Set((await db.select({ id: schema.products.id }).from(schema.products)).map((p) => p.id));

  let changed = 0;
  const danglingProducts: ReapplyAdsMappingResult["danglingProducts"] = [];
  const errors: ReapplyAdsMappingResult["errors"] = [];

  for (const row of rows) {
    if (!row.campaignId) continue;
    const r = resolveCampaign(row.campaignId, row.campaign ?? "", mapping, index, row.accountId);
    if (r.productId && !coThat.has(r.productId)) {
      danglingProducts.push({ campaignId: row.campaignId, campaign: row.campaign ?? "", productId: r.productId });
      continue;
    }
    try {
      const result = await db
        .update(schema.adSpends)
        .set({ productId: r.productId, excluded: r.excluded, marketerId: r.marketerId })
        .where(and(eq(schema.adSpends.campaignId, row.campaignId), sql`(${schema.adSpends.productId} is distinct from ${r.productId} or ${schema.adSpends.excluded} <> ${r.excluded} or ${schema.adSpends.marketerId} is distinct from ${r.marketerId})`))
        .returning({ id: schema.adSpends.id });
      changed += result.length;
    } catch (error) {
      errors.push({ campaignId: row.campaignId, message: moTaLoiCsdl(error) });
    }
  }
  return { campaigns: rows.length, changed, danglingProducts, errors };
}

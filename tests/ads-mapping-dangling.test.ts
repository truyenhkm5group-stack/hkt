import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ADS_ALIASES_KEY, ADS_CAMPAIGN_MAP_KEY, reapplyAdsMapping, type CampaignMap, type ProductAliases } from "@/lib/integrations/facebook/mapping";
import { getSettingJson, setSettingJson } from "@/lib/settings";

/**
 * ═══════════ BẢNG GHÉP TRỎ VÀO MÃ HÀNG ĐÃ BIẾN MẤT ═══════════
 *
 * SỰ CỐ THẬT (đo production 20/09/2026). `facebook-ads` ghi FAILED lặp lại nhiều giờ; câu lệnh
 * hỏng là `update "ad_spends" ... returning "id"` — tức ĐÚNG `reapplyAdsMapping()`, hàm duy nhất
 * trong kho chạy câu đó.
 *
 * Chuỗi nhân quả, cả ba mắt xích đều đọc được từ mã nguồn:
 *
 *  1. `ad_spends.product_id` có KHOÁ NGOẠI tới `products.id`.
 *  2. Giá trị ghi vào nó đến từ `settings` (`ads.campaignMap` / `ads.productAliases`) — chuỗi
 *     NGƯỜI lưu lúc ghép tay. Không gì ràng buộc chúng còn tồn tại trong `products`.
 *  3. Hàm được gọi ở CUỐI `syncFacebookAds`, NGOÀI mọi `try/catch`.
 *
 * ⇒ một dòng ghép hỏng làm cả lượt đồng bộ ghi FAILED — **sau khi** số liệu quảng cáo đã ghi
 * xong — và vì nguyên nhân là TẤT ĐỊNH, nó lặp lại mỗi lượt chạy, mãi mãi.
 *
 * Bài kiểm này CHẠY THẬT câu lệnh cũ để chứng minh nó ném lỗi, rồi chạy hàm đã vá trên đúng dữ
 * liệu đó. Không mô phỏng bằng lời.
 *
 * Mốc thời gian đi theo đồng hồ thật (AGENTS.md mục 50). Dữ liệu nhận ra bằng tiền tố `amd-`.
 */

const P = "amd-";
const MA_CHET = `${P}ma-hang-da-bien-mat`;

/**
 * `reapplyAdsMapping()` quét TOÀN BỘ dòng Facebook, nên chạy nó trong bộ kiểm thử dùng chung sẽ
 * ghi đè `product_id` / `marketer_id` của fixture bài khác (`landing-attribution` có ba dòng như
 * vậy). Chụp lại trước, trả về sau — bài kiểm không được để lại dấu vết nào.
 */
async function chupVaTraVe<T>(chay: () => Promise<T>): Promise<T> {
  const db = await getDb();
  const truoc = await db
    .select({ id: schema.adSpends.id, productId: schema.adSpends.productId, excluded: schema.adSpends.excluded, marketerId: schema.adSpends.marketerId })
    .from(schema.adSpends)
    .where(eq(schema.adSpends.platform, "Facebook"));
  try {
    return await chay();
  } finally {
    for (const r of truoc) {
      await db.update(schema.adSpends).set({ productId: r.productId, excluded: r.excluded, marketerId: r.marketerId }).where(eq(schema.adSpends.id, r.id));
    }
  }
}

export async function testAdsMappingDangling() {
  const db = await getDb();
  const mapCu = await getSettingJson<CampaignMap>(ADS_CAMPAIGN_MAP_KEY, {});
  const aliasCu = await getSettingJson<ProductAliases>(ADS_ALIASES_KEY, {});

  await db.delete(schema.adSpends).where(sql`${schema.adSpends.id} like ${`${P}%`}`);
  await db.delete(schema.products).where(sql`${schema.products.id} like ${`${P}%`}`);
  await db.insert(schema.products).values({ id: `${P}prod-that`, name: "Đầm kiểm thử ghép treo" }).onConflictDoNothing();
  await db.insert(schema.adSpends).values({
    id: `${P}spend-1`,
    platform: "Facebook",
    campaign: `${P}chien-dich-ghep-treo`,
    campaignId: `${P}camp-1`,
    accountId: `${P}act-1`,
    productId: `${P}prod-that`,
    spend: 1_234_000,
    spendDate: new Date(),
    createdBy: "test",
  });

  try {
    /*
      ───────── 1 · CHỨNG MINH CÂU LỆNH CŨ THẬT SỰ NÉM LỖI ─────────
      Không có bước này thì bài kiểm chỉ đang khẳng định một giả thuyết. Ghi thẳng một mã hàng
      không tồn tại vào cột có khoá ngoại phải hỏng — nếu ngày nào đó nó KHÔNG hỏng nữa (ai đó gỡ
      khoá ngoại) thì bài này đỏ, và đó đúng là lúc cần đọc lại cả tệp.
    */
    await assert.rejects(
      () => db.update(schema.adSpends).set({ productId: MA_CHET }).where(eq(schema.adSpends.id, `${P}spend-1`)),
      "ghi một mã hàng không tồn tại vào ad_spends.product_id PHẢI vi phạm khoá ngoại — đây là cú ném đã giết job facebook-ads",
    );

    // ───────── 2 · HÀM ĐÃ VÁ: KHÔNG NÉM, NÊU TÊN, VÀ KHÔNG ĐỔI MỘT CON SỐ NÀO ─────────
    await setSettingJson(ADS_CAMPAIGN_MAP_KEY, { [`${P}camp-1`]: { productId: MA_CHET, exclude: false } } satisfies CampaignMap);
    await setSettingJson(ADS_ALIASES_KEY, {});

    const treo = await chupVaTraVe(() => reapplyAdsMapping());
    const cuaToi = treo.danglingProducts.filter((d) => d.campaignId === `${P}camp-1`);
    assert.equal(cuaToi.length, 1, "chiến dịch ghép vào mã hàng đã biến mất phải được NÊU TÊN, không được nuốt");
    assert.equal(cuaToi[0].productId, MA_CHET);
    assert.deepEqual(treo.errors, [], "bỏ qua có kiểm soát ⇒ KHÔNG còn lỗi nào ném ra; cả lượt đồng bộ không được chết vì một dòng ghép");

    const sau = await db.query.adSpends.findFirst({ where: eq(schema.adSpends.id, `${P}spend-1`) });
    assert.equal(
      sau?.productId,
      `${P}prod-that`,
      "dòng cũ phải GIỮ NGUYÊN mã hàng. Ghi `null` là lặng lẽ gỡ chi phí quảng cáo khỏi một mã hàng và làm báo cáo lợi nhuận đổi số mà không ai được báo (AGENTS.md mục 8.8)",
    );

    // ───────── 3 · Ghép vào mã hàng CÓ THẬT thì vẫn áp bình thường ─────────
    await setSettingJson(ADS_CAMPAIGN_MAP_KEY, { [`${P}camp-1`]: { productId: null, exclude: true } } satisfies CampaignMap);
    const ok = await chupVaTraVe(async () => {
      const r = await reapplyAdsMapping();
      const row = await db.query.adSpends.findFirst({ where: eq(schema.adSpends.id, `${P}spend-1`) });
      return { r, excluded: row?.excluded };
    });
    assert.equal(ok.excluded, true, "ghép hợp lệ vẫn phải áp được — bản vá không được làm hàm ngừng làm việc của nó");
    assert.ok(!ok.r.danglingProducts.some((d) => d.campaignId === `${P}camp-1`), "ghép hợp lệ KHÔNG được vào danh sách treo");

    console.log(`✓ Ghép quảng cáo treo: câu lệnh cũ ném thật, hàm đã vá nêu tên ${cuaToi.length} dòng treo và giữ nguyên số`);
  } finally {
    await setSettingJson(ADS_CAMPAIGN_MAP_KEY, mapCu);
    await setSettingJson(ADS_ALIASES_KEY, aliasCu);
    await db.delete(schema.adSpends).where(sql`${schema.adSpends.id} like ${`${P}%`}`);
    await db.delete(schema.products).where(inArray(schema.products.id, [`${P}prod-that`]));
  }
}

/**
 * ═══════ VÒNG LẶP NẠP SỐ LIỆU CŨNG GHI VÀO ĐÚNG CỘT ẤY ═══════
 *
 * Phát hiện lúc review. `reapplyAdsMapping()` đã vá, nhưng `syncFacebookAds` còn một đường ghi
 * thứ hai: `values.productId` trong vòng lặp upsert, cùng nguồn (`resolveCampaign` → bảng ghép
 * trong `settings`) và cùng cột (`ad_spends.product_id → products.id`). Vá một đường mà để hở
 * đường kia thì lỗi quay lại nguyên vẹn, chỉ khác chỗ ném — và ở đây nó còn kết thúc sớm vòng
 * lặp của cả tài khoản, nên những dòng insight còn lại không bao giờ được ghi.
 *
 * Quét mã nguồn chứ không chạy job: chạy `syncFacebookAds` đòi một client Facebook thật.
 */
export function testAdsIngestGuardsProductFk() {
  const src = readFileSync("lib/integrations/facebook/sync.ts", "utf8");
  const viTri = src.indexOf(".onConflictDoUpdate({ target: schema.adSpends.externalKey");
  assert.ok(viTri > 0, "vòng lặp nạp phải còn upsert theo external_key");
  const truoc = src.slice(0, viTri);
  assert.ok(truoc.includes("maHangCoThat"), "vòng lặp nạp phải kiểm mã hàng có thật TRƯỚC khi ghi vào cột có khoá ngoại");
  assert.ok(
    /productId:\s*sql`/.test(src),
    "nhánh DO UPDATE phải trỏ lại CHÍNH cột `product_id` khi gặp mã treo — ghi NULL đè lên nó là lặng lẽ gỡ chi phí quảng cáo khỏi một mã hàng (AGENTS.md mục 8.8)",
  );

  /*
    Cảnh báo của vòng lặp NẠP phải nằm NGOÀI khối `try` của bước dọn dẹp. Gộp vào trong thì một
    cú ném của `reapplyAdsMapping()` cuốn theo cả danh sách ấy — và chỗ hỏng nằm ở vòng lặp nạp,
    nơi đã ghi dữ liệu xong, lại là chỗ biến mất khỏi báo cáo.
  */
  const baoTreoNap = src.indexOf("const treoNap =");
  const moTry = src.indexOf("    try {\n      const reapplied = await reapplyAdsMapping()");
  assert.ok(baoTreoNap > 0 && moTry > 0 && baoTreoNap < moTry, "cảnh báo ghép treo của vòng lặp nạp phải được phát TRƯỚC, ngoài khối try của bước dọn dẹp");

  console.log("✓ Đường ghi thứ hai (vòng lặp nạp) cũng kiểm khoá ngoại, và cảnh báo của nó không bị cú ném của bước dọn dẹp cuốn đi");
}

/**
 * ═══════ HAI HÀNG RÀO, VÀ CHÚNG PHẢI CÙNG TỒN TẠI ═══════
 *
 * Hàng rào 1 (chạy được, kiểm ở trên): `reapplyAdsMapping` bỏ qua mã hàng không tồn tại.
 * Hàng rào 2 (quét mã nguồn, kiểm ở đây): đường GHI không cho một mã hàng chết lọt vào `settings`
 * ngay từ đầu, và bước áp lại bảng ghép KHÔNG được nằm ngoài `try/catch` trong job đồng bộ.
 *
 * Giữ cả hai: hàng rào 1 dọn hậu quả, hàng rào 2 chặn nguyên nhân. Bỏ cái nào thì lỗi quay lại
 * theo một đường khác.
 */
export function testAdsMappingGuards() {
  const src = readFileSync("lib/actions/ads-mapping.ts", "utf8");
  assert.ok(src.includes("productsExist("), "lib/actions/ads-mapping.ts phải kiểm mã hàng có thật trước khi lưu bảng ghép");
  const luuCampaign = src.indexOf("await saveCampaignMap(campaignMap)");
  assert.ok(luuCampaign > 0 && src.slice(0, luuCampaign).includes("productsExist("), "phép kiểm phải đứng TRƯỚC lượt lưu — kiểm sau khi lưu là không kiểm");
  const luuAlias = src.indexOf("await saveProductAliases(aliases)");
  assert.ok(luuAlias > 0 && src.slice(0, luuAlias).includes("productsExist("), "bí danh cũng đi vào cùng một cột có khoá ngoại, nên cũng phải kiểm");

  const sync = readFileSync("lib/integrations/facebook/sync.ts", "utf8");
  const goi = sync.indexOf("await reapplyAdsMapping()");
  assert.ok(goi > 0, "job facebook-ads vẫn phải áp lại bảng ghép");
  /*
    Bước dọn dẹp phải nằm TRONG một `try`. Trước 20/09/2026 nó đứng trần, nên một dòng ghép hỏng
    làm cả lượt đồng bộ ghi FAILED sau khi mọi số liệu đã vào kho — và màn hình không phân biệt
    được ĐỒNG BỘ HỎNG với MỘT BƯỚC DỌN DẸP HỎNG, hai thứ sửa ở hai chỗ khác hẳn.
  */
  const truoc = sync.slice(0, goi);
  const moTry = truoc.lastIndexOf("try {");
  const dongTryCuoi = truoc.lastIndexOf("} catch");
  assert.ok(moTry > dongTryCuoi, "lời gọi reapplyAdsMapping() phải nằm TRONG một khối try — một bước dọn dẹp không được giết lượt đồng bộ đã làm xong việc");

  console.log("✓ Hàng rào ghép quảng cáo: chặn ở đường ghi (trước khi lưu) VÀ bước dọn dẹp không giết được lượt đồng bộ");
}

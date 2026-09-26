import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { eq, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { designCode, parseDesignMoqSnapshot, type DesignDna, type Genes } from "@/lib/constants/creative-loop";
import { buildMoqDraft, moqSnapshotOf } from "@/lib/creative/moq";
import { vnStartOfDay } from "@/lib/format";
import { getAdsDecision } from "@/lib/queries/ads-decision";
import { KILL_RULE_ORDER_BASIS } from "@/lib/queries/creative-loop";
import { designMoqCounts, type DesignMoqCount } from "@/lib/queries/creative-moq";
import { getMarketingBreakdown, getMarketingDaily } from "@/lib/queries/marketing-daily";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ COMPANY OS · B2 — MỘT CÁCH ĐẾM ĐƠN QUẢNG CÁO CHO MOQ THIẾT KẾ VÀ /ads/daily ═══════════
 *
 * Agent B đã đưa số đơn của creative sang `ORDER_AD_ID` nhưng để lại hai chỗ còn đọc `orders.ad_id` thô
 * (docs/company-os/handoff-b.md §6). Tệp này khoá:
 *  1. MOQ thiết kế (`designMoqCounts`, đường `viaAd`) đi bằng `ORDER_AD_ID`: đơn qua bài viết của ĐÚNG MỘT
 *     mẩu đếm MỘT lần (kể cả khi nó cũng thấy qua mã TK); bài nhiều mẩu KHÔNG nối; đơn mang `ad_id` không
 *     bị đếm lại qua bài viết và không bị kéo sang thiết kế khác vì bài viết của nó. Căn cứ (mang `ad_id`
 *     · qua bài viết) có mặt ở số đếm, ảnh chụp và ghi chú nháp.
 *  2. `/ads/daily` chiều nhóm / mẩu: số đơn của một dòng BẰNG số đơn của dòng cùng khoá trên `/ads`.
 *  3. Chiều chiến dịch / mã hàng / marketer / fanpage / nguồn: tổng KHÔNG đổi (kỳ vọng dựng tay từ dữ liệu
 *     gieo — chạy CÙNG bài này trên mã cũ cũng ra đúng những số ấy).
 *  4. Luật TẮT vẫn đứng trên `DIRECT_AD_ID`; MOQ không có đường tự động nào quá nháp `DRAFT`.
 *
 * MỐC THỜI GIAN (mục 50, 65): mọi ngày là ngày CỐ ĐỊNH của chính dữ liệu gieo (13/02/2019), kỳ báo cáo dựng
 * từ đúng ngày ấy — không cửa sổ trượt theo đồng hồ thật. Tiền tố `cosb2-`, mã bài viết `9913…`, dọn trong
 * `finally`.
 */

const P = "cosb2-";
const DAY = "2019-02-13";
const PAGE = "991399";
const POST_ONE = "991300000001"; // bài của ĐÚNG MỘT mẩu (ad-1)
const POST_SHARED = "991300000002"; // hai mẩu, HAI nhóm (ad-2 @ as-1, ad-3 @ as-2), cùng chiến dịch
const POST_SAMESET = "991300000003"; // hai mẩu, CÙNG một nhóm (ad-4, ad-5 @ as-1) ⇒ nhóm xác định, mẩu nhập nhằng
const POST_SEVEN = "991300000007"; // bài của đúng ad-7 (nhóm as-4) — mẩu/nhóm CHỈ có đơn qua bài viết
const SRC = `${P}src`;
const MKT = `${P}m1`;

const DNA: DesignDna = { category: "DRESS", silhouette: "A_LINE", length: "MIDI", neckline: "V_NECK", sleeve: "SHORT", material: "CHIFFON", pattern: "FLORAL", colorFamily: "PINK", detail: "RUFFLE", style: "CASUAL" };
const G: Genes = { angle: "SOCIAL_PROOF", scene: "STREET", model: "FEMALE_YOUNG", composition: "SINGLE_HERO", textOverlay: "PRICE_BADGE", palette: "WARM" };

const period = (): Period => {
  const from = vnStartOfDay(DAY);
  return { key: "custom", from, to: new Date(from.getTime() + 86_400_000 - 1), label: DAY, fromKey: DAY, toKey: DAY };
};

const [TK1, TK2, TK3] = [97, 98, 99].map((n) => designCode(DAY, n));

async function cleanup(db: Db) {
  await db.delete(schema.creativeVariants).where(like(schema.creativeVariants.id, `${P}%`));
  await db.delete(schema.designConcepts).where(inArray(schema.designConcepts.code, [TK1, TK2, TK3]));
  await db.delete(schema.creativeBatches).where(like(schema.creativeBatches.id, `${P}%`));
  const orderIds = (await db.select({ id: schema.orders.id }).from(schema.orders).where(like(schema.orders.id, `${P}%`))).map((r) => r.id);
  if (orderIds.length) {
    await db.delete(schema.orderAttributions).where(inArray(schema.orderAttributions.orderId, orderIds));
    await db.delete(schema.orderItems).where(inArray(schema.orderItems.orderId, orderIds));
    await db.delete(schema.orders).where(inArray(schema.orders.id, orderIds));
  }
  await db.delete(schema.fbAds).where(like(schema.fbAds.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
}

async function seed(db: Db) {
  const ad = (id: string, campaign: string, adset: string, postId: string | null) => ({ id: `${P}${id}`, name: `Mẩu ${id}`, campaignId: `${P}${campaign}`, adsetId: `${P}${adset}`, postId });
  await db.insert(schema.fbAds).values([
    ad("ad-1", "camp-1", "as-1", POST_ONE),
    ad("ad-2", "camp-1", "as-1", POST_SHARED),
    ad("ad-3", "camp-1", "as-2", POST_SHARED),
    ad("ad-4", "camp-1", "as-1", POST_SAMESET),
    ad("ad-5", "camp-1", "as-1", POST_SAMESET),
    ad("ad-6", "camp-2", "as-3", null),
    ad("ad-7", "camp-1", "as-4", POST_SEVEN),
  ]);
  await db.insert(schema.products).values([
    { id: `${P}prod-a`, name: "Mẫu A" },
    { id: `${P}prod-b`, name: "Mẫu B" },
    { id: `${P}prod-tk1`, name: "Đầm TK1", customId: TK1 },
  ]);
  const at = vnStartOfDay(DAY);
  const order = (id: string, revenue: number, extra: Partial<typeof schema.orders.$inferInsert>) => ({
    id: `${P}${id}`,
    stage: "CONFIRMED" as never,
    cod: revenue,
    totalPriceAfterDiscount: revenue,
    prepaid: 0,
    pageId: PAGE,
    source: SRC,
    insertedAt: new Date(at.getTime() + 3 * 3_600_000),
    ...extra,
  });
  await db.insert(schema.orders).values([
    // ad_id của ad-1 VÀ bài của ad-1 ⇒ TRỰC TIẾP, một lần.
    order("o-direct", 100_000, { adId: `${P}ad-1`, postId: `${PAGE}_${POST_ONE}` }),
    // Không ad_id, bài của đúng ad-1 ⇒ qua bài viết. Có cả dòng mã TK1 ⇒ thấy ở HAI đường của MOQ.
    order("o-post", 200_000, { adId: null, postId: `${PAGE}_${POST_ONE}` }),
    // ad_id RỖNG ⇒ như không có ⇒ qua bài viết (bài không tiền tố trang).
    order("o-post-empty", 300_000, { adId: "", postId: POST_ONE }),
    // Bài hai mẩu / hai nhóm ⇒ mẩu & nhóm nhập nhằng; chiến dịch vẫn xác định.
    order("o-shared", 400_000, { adId: null, postId: `${PAGE}_${POST_SHARED}` }),
    // Bài hai mẩu cùng một nhóm ⇒ nhóm as-1, mẩu nhập nhằng.
    order("o-sameset", 500_000, { adId: null, postId: `${PAGE}_${POST_SAMESET}` }),
    // ad_id của ad-6 mà bài là bài của ad-1 ⇒ thuộc ad-6, KHÔNG sang ad-1.
    order("o-other-ad", 600_000, { adId: `${P}ad-6`, postId: `${PAGE}_${POST_ONE}` }),
    // Mẩu ad-7 / nhóm as-4 CHỈ có đơn qua bài viết ⇒ khoá này chỉ hiện nếu bóc tách đi bằng ORDER_*_ID.
    order("o-post7", 50_000, { adId: null, postId: `${PAGE}_${POST_SEVEN}` }),
    // Đơn huỷ qua bài của ad-1 ⇒ không phải đơn chốt ở bất kỳ đâu.
    order("o-cancelled", 700_000, { adId: null, postId: `${PAGE}_${POST_ONE}`, stage: "CANCELLED" as never }),
    // Đơn không dấu vết quảng cáo.
    order("o-organic", 800_000, { adId: null, postId: null }),
  ]);
  const line = (orderId: string, n: number, productId: string, lineTotal: number) => ({ id: `${P}oi-${orderId}-${n}`, orderId: `${P}${orderId}`, productId, quantity: 1, lineTotal, isBonus: false });
  await db.insert(schema.orderItems).values([
    line("o-direct", 0, `${P}prod-a`, 100_000),
    line("o-post", 0, `${P}prod-a`, 150_000),
    line("o-post", 1, `${P}prod-tk1`, 50_000),
    line("o-post-empty", 0, `${P}prod-b`, 300_000),
  ]);
  await db.insert(schema.orderAttributions).values(
    ["o-direct", "o-post"].map((id) => ({ orderId: `${P}${id}`, marketerId: MKT, status: "ATTRIBUTED", sourceOrderAt: at })),
  );

  // Vòng mẫu: TK1 ← ad-1 · TK2 ← ad-2, ad-3, ad-4 (toàn bài nhập nhằng) · TK3 ← ad-6.
  const start = vnStartOfDay(DAY);
  await db.insert(schema.creativeBatches).values({ id: `${P}batch`, batchDay: DAY, status: "PLANNED", slotCount: 5, startAt: start, endAt: new Date(start.getTime() + 86_400_000), approvalDeadline: new Date(start.getTime() - 3_600_000), ruleVersion: 1 });
  const designs = await db
    .insert(schema.designConcepts)
    .values([TK1, TK2, TK3].map((code) => ({ code, batchId: `${P}batch`, dna: DNA, dnaVersion: 1, status: "TESTING" })))
    .returning({ id: schema.designConcepts.id, code: schema.designConcepts.code });
  const idOf = new Map(designs.map((d) => [d.code, d.id]));
  const variant = (slot: number, code: string, adId: string) => ({ id: `${P}v-${slot}`, batchId: `${P}batch`, slot, mode: "DESIGN", genes: G, genesVersion: 1, designConceptId: idOf.get(code) as string, fbAdId: `${P}${adId}` });
  await db.insert(schema.creativeVariants).values([variant(1, TK1, "ad-1"), variant(2, TK2, "ad-2"), variant(3, TK2, "ad-3"), variant(4, TK2, "ad-4"), variant(5, TK3, "ad-6")]);
  return designs;
}

/* ═══════════ 1. MOQ THIẾT KẾ ═══════════ */

async function testMoq(db: Db, designs: { id: string; code: string }[]) {
  const cnt = await designMoqCounts(db, designs);
  const byCode = (code: string) => cnt.get(designs.find((d) => d.code === code)?.id as string) as DesignMoqCount;
  const k1 = byCode(TK1);
  assert.equal(k1.viaAd, 3, "TK1: 1 mang ad_id + 2 qua bài của đúng một mẩu; đơn huỷ / đơn của mẩu khác không vào");
  assert.equal(k1.viaAdDirect, 1, "đơn mang ad_id VÀ bài của chính mẩu ấy tính TRỰC TIẾP, một lần — không đếm lại qua bài viết");
  assert.equal(k1.viaAdPost, 2, "ad_id NULL và ad_id rỗng đều đi đường bài viết");
  assert.equal(k1.viaAdDirect + k1.viaAdPost, k1.viaAd, "hai căn cứ cộng lại đúng bằng đường quảng cáo");
  assert.equal(k1.viaCode, 1, "đơn qua bài viết có dòng mã TK1");
  assert.equal(k1.both, 1, "đơn qua bài viết thấy ở cả hai đường");
  assert.equal(k1.orders, 3, "HỢP theo id đơn: đơn qua bài viết + mã TK tính MỘT lần (3 + 1 − 1)");
  assert.equal(k1.adOnly, 2);
  const k2 = byCode(TK2);
  assert.equal(k2.viaAd, 0, "TK2: bài của nhiều mẩu (khác nhóm hoặc cùng nhóm) ⇒ nhập nhằng ở cấp mẩu ⇒ KHÔNG nối");
  assert.equal(k2.orders, 0);
  const k3 = byCode(TK3);
  assert.equal(k3.viaAd, 1, "TK3: đơn mang ad_id của ad-6 ở lại ad-6 dù bài viết là bài của ad-1");
  assert.equal(k3.viaAdDirect, 1);
  assert.equal(k3.viaAdPost, 0);
  const tong = [...cnt.values()].reduce((s, c) => s + c.viaAd, 0);
  assert.equal(tong, 4, "TK1 3 + TK3 1: đơn nhập nhằng không vào đâu, không đơn nào bị đếm ở hai thiết kế");

  // Căn cứ phải đi tới ảnh chụp và ghi chú nháp — người bấm gửi xưởng thấy con số đứng trên bằng chứng nào.
  const at = vnStartOfDay(DAY);
  const snap = moqSnapshotOf(k1, at, false, 3);
  assert.equal(snap.viaAdDirect, 1);
  assert.equal(snap.viaAdPost, 2);
  const draft = buildMoqDraft({ code: TK1 }, k1, at, 3);
  assert.match(draft.note, /3\/3 đơn đã xác nhận = 1 qua sản phẩm mã TK \+ 2 chỉ qua quảng cáo \(đường quảng cáo 3 đơn: 1 mang ad_id · 2 qua bài viết của đúng một mẩu\)/, "ghi chú nháp nói ra căn cứ của đường quảng cáo");
  const old = parseDesignMoqSnapshot({ orders: 50, viaAd: 12, viaCode: 40, both: 2, adOnly: 10, minOrders: 50 });
  assert.equal(old?.viaAdDirect, null, "ảnh chụp trước B2 không có căn cứ ⇒ CHƯA BIẾT, không phải 0 đơn qua bài viết");
  assert.equal(old?.viaAdPost, null);
}

/* ═══════════ 2. /ads/daily NHÓM / MẨU = /ads ═══════════ */

async function testDailyMatchesAds() {
  clearMemo();
  const p = period();
  for (const [dimension, key, expected] of [
    ["ad", `${P}ad-1`, 3],
    ["ad", `${P}ad-6`, 1],
    ["adset", `${P}as-1`, 4],
    ["adset", `${P}as-3`, 1],
    ["ad", `${P}ad-7`, 1],
    ["adset", `${P}as-4`, 1],
  ] as const) {
    const decision = await getAdsDecision(p, dimension);
    const adsRow = decision.rows.find((r) => r.key === key);
    assert.ok(adsRow, `/ads có dòng ${dimension} ${key}`);
    assert.equal(adsRow.bookedOrders, expected, `/ads ${dimension} ${key}: số đơn chốt của fixture`);
    const breakdown = await getMarketingBreakdown(p, "created", dimension, {}, 50);
    const bdRow = breakdown.rows.find((r) => r.key === key);
    assert.ok(bdRow, `/ads/daily bóc tách ${dimension} có dòng ${key} (khoá ORDER_*_ID, không chỉ ad_id)`);
    assert.equal(bdRow.orders, adsRow.bookedOrders, `/ads/daily bóc tách ${dimension} ${key} = /ads (cùng dòng, cùng số đơn)`);
    const filtered = await getMarketingDaily(p, "created", dimension === "ad" ? { adId: key } : { adsetId: key });
    assert.equal(filtered.totals.orders, adsRow.bookedOrders, `/ads/daily lọc ${dimension} ${key} = /ads`);
    assert.equal(filtered.totals.posRevenue, adsRow.bookedRevenue, `/ads/daily lọc ${dimension} ${key}: doanh số lên đơn = /ads`);
    // Khoá nhóm của bóc tách (`dimensionKeyExpr` — số lượng sp) và bộ lọc phải là MỘT tập đơn.
    assert.equal(bdRow.units, filtered.totals.units, `/ads/daily ${dimension} ${key}: số lượng theo khoá nhóm = số lượng theo bộ lọc`);
  }
  // Mẩu mà mọi đơn đều nhập nhằng ⇒ không đơn nào ở cả hai trang.
  const ambiguous = await getMarketingDaily(p, "created", { adId: `${P}ad-4` });
  assert.equal(ambiguous.totals.orders, 0, "bài hai mẩu cùng nhóm: cấp mẩu KHÔNG nối");
  const adsAd = await getAdsDecision(p, "ad");
  assert.equal(adsAd.rows.find((r) => r.key === `${P}ad-4`)?.bookedOrders ?? 0, 0);
}

/* ═══════════ 3. CÁC CHIỀU KHÁC KHÔNG ĐỔI ═══════════ */

async function testOtherDimensionsUnchanged() {
  clearMemo();
  const p = period();
  // Kỳ vọng dựng tay từ dữ liệu gieo — mã TRƯỚC B2 cho đúng những số này (xem commit: chạy bài trên mã cũ).
  const cases: { label: string; filters: Parameters<typeof getMarketingDaily>[2]; orders: number; posRevenue: number }[] = [
    // camp-1: trực tiếp + 2 qua bài ad-1 + bài hai mẩu (cùng chiến dịch) + bài cùng nhóm + bài ad-7 = 6 đơn.
    { label: "chiến dịch camp-1", filters: { campaignId: `${P}camp-1` }, orders: 6, posRevenue: 1_550_000 },
    { label: "chiến dịch camp-2", filters: { campaignId: `${P}camp-2` }, orders: 1, posRevenue: 600_000 },
    { label: "fanpage", filters: { pageId: PAGE }, orders: 8, posRevenue: 2_950_000 },
    { label: "nguồn đơn", filters: { source: SRC }, orders: 8, posRevenue: 2_950_000 },
    { label: "marketer", filters: { marketerId: MKT }, orders: 2, posRevenue: 300_000 },
    // Mã hàng: doanh số theo DÒNG (100K + 150K), không theo đơn.
    { label: "mã hàng prod-a", filters: { productId: `${P}prod-a` }, orders: 2, posRevenue: 250_000 },
  ];
  for (const c of cases) {
    const r = await getMarketingDaily(p, "created", c.filters);
    assert.equal(r.totals.orders, c.orders, `${c.label}: số đơn không đổi`);
    assert.equal(r.totals.posRevenue, c.posRevenue, `${c.label}: doanh số không đổi`);
  }
  const camp = await getMarketingBreakdown(p, "created", "campaign", { pageId: PAGE }, 50);
  assert.equal(camp.rows.find((r) => r.key === `${P}camp-1`)?.orders, 6, "bóc tách chiến dịch: camp-1 không đổi");
  assert.equal(camp.rows.find((r) => r.key === `${P}camp-2`)?.orders, 1);
}

/* ═══════════ 4. RÀO NGUỒN: luật tắt, không bản chép, MOQ dừng ở nháp ═══════════ */

function testSourceGuards() {
  const root = path.join(__dirname, "..");
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
  assert.equal(KILL_RULE_ORDER_BASIS, "DIRECT_AD_ID", "luật TẮT giữ định nghĩa đã duyệt — đổi là HUMAN GATE của chủ shop, không phải việc của B2");
  assert.match(read("lib/queries/creative-loop.ts"), /export const KILL_RULE_ORDER_BASIS: "DIRECT_AD_ID" \| "ORDER_AD_ID" = "DIRECT_AD_ID";/);
  for (const rel of ["lib/queries/creative-moq.ts", "lib/queries/marketing-daily.ts"]) {
    const src = read(rel);
    assert.match(src, /import \{[^}]*\bORDER_AD_ID\b[^}]*\} from "@\/lib\/queries\/ads-attribution-link"/, `${rel}: dùng CHÍNH ORDER_AD_ID`);
    assert.doesNotMatch(src, /having count\(distinct fa\.id\)|POST_TO_AD\b/, `${rel}: không chép luật bài viết → mẩu`);
  }
  const daily = read("lib/queries/marketing-daily.ts");
  assert.doesNotMatch(daily, /\$\{o\.adId\} = \$\{f\.adId\}/, "bộ lọc mẩu không còn đọc ad_id thô");
  assert.doesNotMatch(daily, /fa\.id = \$\{o\.adId\} and fa\.adset_id = \$\{f\.adsetId\}/, "bộ lọc nhóm không còn đọc ad_id thô");
  assert.doesNotMatch(read("lib/queries/creative-moq.ts"), /inArray\(o\.adId, adIds\)/, "MOQ không còn thu hẹp CHỈ theo ad_id thô");
  // MOQ chỉ dựng NHÁP: không đường nào trong tệp máy MOQ đặt SENT hay gọi hàm gửi xưởng.
  const moq = read("lib/creative/moq.ts");
  assert.match(moq, /status: "DRAFT"/);
  assert.doesNotMatch(moq, /status:\s*"SENT"|sentAt:|from "@\/lib\/actions\/production"/, "máy MOQ không gửi xưởng");
}

export async function testCompanyOsAdOrderUnify(db: Db) {
  testSourceGuards();
  await cleanup(db);
  try {
    const designs = await seed(db);
    await testMoq(db, designs);
    await testDailyMatchesAds();
    await testOtherDimensionsUnchanged();
    // Dọn kiểm tra: thiết kế của khối này không bị máy MOQ chạm (bài chỉ ĐẾM, không chạy lượt ghi).
    const rows = await db.select({ reached: schema.designConcepts.moqReachedAt }).from(schema.designConcepts).where(eq(schema.designConcepts.batchId, `${P}batch`));
    assert.ok(rows.every((r) => r.reached === null));
    console.log("✓ Company OS · B2: MOQ thiết kế đếm đơn QC bằng ORDER_AD_ID (qua bài một lần, bài nhập nhằng không nối, ad_id không đếm đúp, căn cứ tách) · /ads/daily nhóm/mẩu = /ads · chiến dịch/mã/marketer/fanpage/nguồn không đổi · luật tắt vẫn DIRECT_AD_ID · MOQ dừng ở nháp");
  } finally {
    await cleanup(db);
    clearMemo();
  }
}

import assert from "node:assert/strict";
import { inArray, like, or } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { judgeVariant, type VariantMetrics } from "@/lib/creative/judge";
import type { CreativeRule } from "@/lib/constants/creative-loop";
import { MARKETING_DIMENSION_SPEND } from "@/lib/constants/marketing-daily";
import { vnStartOfDay } from "@/lib/format";
import { KILL_RULE_ORDER_BASIS, listLibrary, listLibraryProductOptions, variantMetrics } from "@/lib/queries/creative-loop";
import { getMarketingDaily } from "@/lib/queries/marketing-daily";
import { getModelAdsSummary, modelCreativeSummary, NO_VERDICT, summarizeModelAds } from "@/lib/queries/model-ads";
import type { getAdsDecision } from "@/lib/queries/ads-decision";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ COMPANY OS · AGENT B — CREATIVE ↔ QUẢNG CÁO THEO MẪU ═══════════
 *
 * Khoá năm điều (docs/company-os/handoff-b.md):
 *  1. Số đơn của creative đi bằng `ORDER_AD_ID`: đơn qua bài viết của ĐÚNG MỘT mẩu được đếm MỘT lần;
 *     bài do nhiều mẩu chạy KHÔNG được đếm; đơn mang `ad_id` không bị đếm lại qua bài viết, và không
 *     bị kéo sang mẩu khác vì bài viết của nó.
 *  2. Luật TẮT vẫn nhìn đơn mang `ad_id` (`KILL_RULE_ORDER_BASIS`) — đổi định nghĩa đơn không được tự
 *     sinh một lượt tạm dừng Facebook mà người duyệt lô chưa cho phép.
 *  3. `/ads/daily` chiều nhóm/mẩu: chi ĐÚNG ở ngày hạt mẩu, `null` ở ngày hạt chiến dịch, tổng kỳ
 *     `null` khi có ngày chưa tách, độ phủ đi kèm; chiều chiến dịch / mã hàng KHÔNG đổi.
 *  4. Tóm tắt theo mẫu: không có dữ liệu ⇒ `null`, không phải 0.
 *  5. Thư viện lọc được theo mẫu và ngày vào thư viện.
 *
 * MỐC THỜI GIAN (mục 50, 65): mọi ngày là ngày CỐ ĐỊNH của CHÍNH dữ liệu gieo vào (2021), và kỳ báo
 * cáo dựng từ đúng những ngày ấy — không có cửa sổ trượt theo đồng hồ thật nào.
 *
 * Dữ liệu mang tiền tố `cosb-` và mã bài viết `9912…` riêng; dọn sạch trong `finally`.
 */

const P = "cosb-";
const POST_ONE = "991200000001"; // bài của ĐÚNG MỘT mẩu (ad-1)
const POST_SHARED = "991200000002"; // bài do HAI mẩu cùng chạy (ad-2, ad-3) ⇒ nhập nhằng
const PAGE = "991299";

const day = (d: string) => vnStartOfDay(d);
const period = (from: string, toInclusive: string): Period => {
  const end = new Date(day(toInclusive).getTime() + 86_400_000 - 1);
  return { key: "custom", from: day(from), to: end, label: `${from} → ${toInclusive}`, fromKey: from, toKey: toInclusive };
};

async function cleanup(db: Db) {
  const v = schema.creativeVariants;
  const ids = (await db.select({ id: v.id }).from(v).where(like(v.id, `${P}%`))).map((r) => r.id);
  if (ids.length) {
    await db.delete(schema.creativeVerdicts).where(inArray(schema.creativeVerdicts.variantId, ids));
    await db.delete(v).where(inArray(v.id, ids));
  }
  await db.delete(schema.creativeBatches).where(like(schema.creativeBatches.id, `${P}%`));
  const orderIds = (await db.select({ id: schema.orders.id }).from(schema.orders).where(like(schema.orders.id, `${P}%`))).map((r) => r.id);
  if (orderIds.length) {
    await db.delete(schema.shipments).where(inArray(schema.shipments.orderId, orderIds));
    await db.delete(schema.orders).where(inArray(schema.orders.id, orderIds));
  }
  await db.delete(schema.adSpends).where(or(like(schema.adSpends.createdBy, `${P}%`), like(schema.adSpends.adId, `${P}%`)));
  await db.delete(schema.fbAds).where(like(schema.fbAds.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
}

/* ═══════════ 1. SỐ ĐƠN CỦA CREATIVE ═══════════ */

async function testCreativeOrderAttribution(db: Db) {
  await db.insert(schema.fbAds).values([
    { id: `${P}ad-1`, campaignId: `${P}camp-1`, adsetId: `${P}as-1`, postId: POST_ONE },
    { id: `${P}ad-2`, campaignId: `${P}camp-1`, adsetId: `${P}as-1`, postId: POST_SHARED },
    { id: `${P}ad-3`, campaignId: `${P}camp-1`, adsetId: `${P}as-1`, postId: POST_SHARED },
    { id: `${P}ad-4`, campaignId: `${P}camp-1`, adsetId: `${P}as-1`, postId: null },
  ]);
  const order = (id: string, extra: Partial<typeof schema.orders.$inferInsert>) => ({
    id: `${P}${id}`,
    stage: "CONFIRMED" as never,
    cod: 300_000,
    totalPriceAfterDiscount: 300_000,
    prepaid: 0,
    insertedAt: day("2021-03-01"),
    ...extra,
  });
  await db.insert(schema.orders).values([
    // Đơn mang ad_id của ad-1 VÀ bài viết của ad-1 ⇒ trực tiếp, MỘT lần.
    order("o-direct", { adId: `${P}ad-1`, postId: `${PAGE}_${POST_ONE}` }),
    // Không ad_id, bài của đúng ad-1 ⇒ qua bài viết.
    order("o-post", { adId: null, postId: `${PAGE}_${POST_ONE}`, totalPriceAfterDiscount: 250_000 }),
    // ad_id RỖNG ⇒ như không có ⇒ qua bài viết.
    order("o-post-empty", { adId: "", postId: POST_ONE, totalPriceAfterDiscount: 200_000 }),
    // Bài do hai mẩu chạy ⇒ KHÔNG được nối về mẩu nào.
    order("o-ambiguous", { adId: null, postId: `${PAGE}_${POST_SHARED}` }),
    // ad_id của ad-4 mà bài lại là bài của ad-1 ⇒ thuộc ad-4, KHÔNG sang ad-1.
    order("o-other-ad", { adId: `${P}ad-4`, postId: `${PAGE}_${POST_ONE}` }),
    // Đơn huỷ qua bài viết ⇒ không phải đơn chốt.
    order("o-cancelled", { adId: null, postId: `${PAGE}_${POST_ONE}`, stage: "CANCELLED" as never }),
    // Đơn NEW (chưa chốt) ⇒ ngoài population.
    order("o-new", { adId: null, postId: `${PAGE}_${POST_ONE}`, stage: "NEW" as never }),
  ]);

  const m = await variantMetrics(db, [
    { id: "v1", fbAdId: `${P}ad-1`, startAt: null },
    { id: "v2", fbAdId: `${P}ad-2`, startAt: null },
    { id: "v3", fbAdId: `${P}ad-3`, startAt: null },
    { id: "v4", fbAdId: `${P}ad-4`, startAt: null },
    { id: "v-unpublished", fbAdId: null, startAt: null },
  ]);
  const v1 = m.get("v1");
  assert.ok(v1);
  assert.equal(v1.bookedOrders, 3, "ad-1: 1 trực tiếp + 2 qua bài viết; huỷ / NEW / nhập nhằng / đơn của mẩu khác không vào");
  assert.equal(v1.attribution.direct.booked, 1, "đơn mang ad_id đếm TRỰC TIẾP, không đếm lại qua bài viết");
  assert.equal(v1.attribution.viaPost.booked, 2, "đơn không ad_id (kể cả ad_id rỗng) nối qua bài của ĐÚNG MỘT mẩu");
  assert.equal(v1.attribution.direct.booked + v1.attribution.viaPost.booked, v1.bookedOrders, "hai đường cộng lại đúng bằng tổng");
  assert.equal(v1.bookedRevenueVnd, 750_000, "doanh thu lên đơn = 300K + 250K + 200K");
  assert.equal(v1.killRuleOrders, KILL_RULE_ORDER_BASIS === "DIRECT_AD_ID" ? 1 : 3, "luật tắt nhìn đúng đường đã được duyệt");
  assert.equal(KILL_RULE_ORDER_BASIS, "DIRECT_AD_ID", "đổi luật tắt sang định nghĩa mới là HUMAN GATE — sửa hằng số kèm quyết định của chủ shop");
  for (const k of ["v2", "v3"]) {
    const x = m.get(k);
    assert.ok(x);
    assert.equal(x.bookedOrders, 0, `${k}: bài do hai mẩu chạy ⇒ nhập nhằng ⇒ không nối, không chia`);
    assert.equal(x.bookedRevenueVnd, 0, `${k}: mẩu CÓ id mà không đơn ⇒ 0 thật, không phải null`);
  }
  const v4 = m.get("v4");
  assert.ok(v4);
  assert.equal(v4.bookedOrders, 1, "đơn mang ad_id của ad-4 ở lại ad-4 dù bài viết là của ad-1");
  assert.equal(v4.attribution.viaPost.booked, 0);
  const vu = m.get("v-unpublished");
  assert.ok(vu);
  assert.equal(vu.bookedRevenueVnd, null, "mẫu chưa có mẩu QC ⇒ doanh thu CHƯA BIẾT");
  assert.equal(vu.bookedOrders, 0);
  // Đếm tổng: không đơn nào bị đếm hai lần trên toàn tập mẩu.
  const total = [...m.values()].reduce((s, x) => s + x.bookedOrders, 0);
  assert.equal(total, 4, "5 đơn chốt gieo vào, 1 nhập nhằng ⇒ đúng 4 lượt quy kết, mỗi đơn một lần");
}

/* ═══════════ 2. LUẬT TẮT KHÔNG ĐỔI THEO ĐỊNH NGHĨA ĐƠN MỚI (hàm thuần) ═══════════ */

function testKillRuleBasis() {
  const now = new Date("2021-03-02T12:00:00Z");
  const input = (metrics: VariantMetrics) => ({ status: "LIVE" as const, startAt: new Date("2021-03-02T00:00:00Z"), endAt: new Date("2021-03-03T00:00:00Z"), libraryAt: null, metrics });
  const cpoKill: CreativeRule = { metric: "costPerOrder", op: "gt", value: 50_000, minSpendVnd: 100_000 };
  const noOrderKill: CreativeRule = { metric: "orders", op: "lt", value: 1, minSpendVnd: 100_000 };
  const cfg = (killRules: CreativeRule[]) => ({ killRules, keepRules: [], winOrdersAbove: 100, verdictSettleHours: 24 });
  const base: VariantMetrics = { spendVnd: 200_000, impressions: 1_000, clicks: 10, messages: 5, bookedOrders: 3, deliveredOrders: 0, returnedOrders: 0 };

  // 3 đơn (2 qua bài viết), 0 đơn mang ad_id: luật CPO nhìn 0 đơn ⇒ CPO CHƯA BIẾT ⇒ KHÔNG tắt.
  const guarded = judgeVariant(input({ ...base, killRuleOrders: 0 }), cfg([cpoKill]), now);
  assert.notEqual(guarded.verdict, "KILL", "đơn qua bài viết không được làm một luật CPO đang CHƯA BIẾT bỗng tắt mẫu");
  // Không truyền killRuleOrders ⇒ hành vi cũ (luật nhìn bookedOrders): 200K/3 > 50K ⇒ tắt.
  assert.equal(judgeVariant(input(base), cfg([cpoKill]), now).verdict, "KILL", "không có killRuleOrders ⇒ luật đọc bookedOrders như trước");
  // Luật "0 đơn sau 100K" vẫn tắt theo đúng định nghĩa đã duyệt (0 đơn mang ad_id), dù nhãn đơn đầy đủ là 3.
  const old = judgeVariant(input({ ...base, killRuleOrders: 0 }), cfg([noOrderKill]), now);
  assert.equal(old.verdict, "KILL", "luật tắt giữ nguyên hành vi đã được người duyệt lô cho phép");
  // Luật GIỮ và ngưỡng THẮNG đọc số đơn đầy đủ.
  const win = judgeVariant(input({ ...base, bookedOrders: 101, killRuleOrders: 0 }), cfg([noOrderKill]), now);
  assert.equal(win.verdict, "WIN", "ngưỡng THẮNG đọc số đơn đầy đủ — không đổi ngưỡng, chỉ đổi cách đếm");
}

/* ═══════════ 3. /ads/daily — CHI NHÓM / MẨU ═══════════ */

async function testAdGrainSpend(db: Db) {
  await db.insert(schema.products).values({ id: `${P}prod-spend`, name: "Mẫu thử chi hạt mẩu" });
  const row = (d: string, grain: "AD" | "CAMPAIGN", spend: number, extra: Partial<typeof schema.adSpends.$inferInsert> = {}) => ({
    platform: "FACEBOOK",
    campaign: `${P}camp-1`,
    campaignId: `${P}camp-1`,
    accountId: `${P}acc`,
    grain,
    spend,
    messages: grain === "AD" ? 2 : 6,
    spendDate: day(d),
    productId: `${P}prod-spend`,
    createdBy: `${P}test`,
    ...extra,
  });
  await db.insert(schema.adSpends).values([
    // 01/03: tài khoản ở hạt MẨU — hai mẩu cùng chiến dịch.
    row("2021-03-01", "AD", 100_000, { adId: `${P}ad-1`, adsetId: `${P}as-1` }),
    row("2021-03-01", "AD", 50_000, { adId: `${P}ad-4`, adsetId: `${P}as-1` }),
    // 02/03: hạt CHIẾN DỊCH (vd tổng cấp mẩu lệch quá 1.000 ₫) ⇒ chưa tách được.
    row("2021-03-02", "CAMPAIGN", 300_000),
    // 03/03: chiến dịch KHÁC tiêu ở hạt chiến dịch ⇒ không làm mẩu của chiến dịch 1 thành chưa biết.
    row("2021-03-03", "CAMPAIGN", 200_000, { campaign: `${P}camp-2`, campaignId: `${P}camp-2`, productId: null }),
  ]);
  clearMemo();

  // Mẩu, kỳ chỉ gồm ngày hạt mẩu ⇒ ĐÚNG phép cộng.
  const adDay1 = await getMarketingDaily(period("2021-03-01", "2021-03-01"), "created", { adId: `${P}ad-1` });
  assert.equal(adDay1.totals.adSpend, 100_000, "ngày hạt mẩu: chi của mẩu = dòng hạt mẩu của chính nó");
  assert.equal(adDay1.totals.messages, 2);
  assert.deepEqual(adDay1.spendCoverage, { knownDays: 1, knownSpend: 100_000, unsplitDays: 0, unsplitCampaignSpend: 0 });

  // Nhóm = phép cộng các mẩu của nhóm.
  const adset = await getMarketingDaily(period("2021-03-01", "2021-03-01"), "created", { adsetId: `${P}as-1` });
  assert.equal(adset.totals.adSpend, 150_000, "nhóm = Σ mẩu của nhóm ở hạt mẩu");

  // Mẩu, kỳ gồm ngày hạt chiến dịch ⇒ ngày ấy null, tổng null, độ phủ nói rõ phần đã biết.
  const adAll = await getMarketingDaily(period("2021-03-01", "2021-03-03"), "created", { adId: `${P}ad-1` });
  const d1 = adAll.rows.find((r) => r.day === "2021-03-01");
  const d2 = adAll.rows.find((r) => r.day === "2021-03-02");
  assert.ok(d1 && d2, "ngày chưa tách vẫn là một dòng — không biến mất khỏi bảng");
  assert.equal(d1.spendKnown, true);
  assert.equal(d1.adSpend, 100_000);
  assert.equal(d2.spendKnown, false, "ngày hạt chiến dịch: chi của mẩu CHƯA BIẾT");
  assert.equal(d2.adSpend, null, "KHÔNG chia đều 300K chiến dịch xuống mẩu");
  assert.equal(d2.contributionProfit, null);
  assert.equal(adAll.rows.some((r) => r.day === "2021-03-03" && r.adSpend === null), false, "chiến dịch khác tiêu không làm ngày của mẩu này thành chưa biết");
  assert.equal(adAll.totals.adSpend, null, "có ngày chưa tách ⇒ tổng kỳ CHƯA BIẾT, không in phần cộng thiếu như tổng");
  assert.equal(adAll.totals.contributionProfit, null);
  assert.deepEqual(adAll.spendCoverage, { knownDays: 1, knownSpend: 100_000, unsplitDays: 1, unsplitCampaignSpend: 300_000 });
  assert.ok(adAll.warnings.some((w) => w.includes("HẠT CHIẾN DỊCH") && w.includes("300.000")), "cảnh báo phải nói số ngày và số tiền chưa tách");

  // Chiều chiến dịch / mã hàng: tổng KHÔNG đổi — mọi hạt đều cộng, như trước.
  const camp = await getMarketingDaily(period("2021-03-01", "2021-03-03"), "created", { campaignId: `${P}camp-1` });
  assert.equal(camp.totals.adSpend, 450_000, "chiến dịch = 100K + 50K (hạt mẩu) + 300K (hạt chiến dịch)");
  assert.equal(camp.spendCoverage, null, "chiều chiến dịch không có khái niệm chưa tách");
  const prod = await getMarketingDaily(period("2021-03-01", "2021-03-03"), "created", { productId: `${P}prod-spend` });
  assert.equal(prod.totals.adSpend, 450_000, "mã hàng: tổng không đổi");
  assert.equal(prod.spendCoverage, null);

  // Mẩu mà sổ không biết chiến dịch ⇒ cả chiều CHƯA BIẾT.
  const ghost = await getMarketingDaily(period("2021-03-01", "2021-03-03"), "created", { adId: `${P}ad-khong-co` });
  assert.equal(ghost.totals.adSpend, null);
  assert.ok(ghost.warnings.some((w) => w.includes("chi quảng cáo") && w.includes("chiến dịch nào")));

  assert.equal(MARKETING_DIMENSION_SPEND.ad, true, "chiều mẩu CÓ số chi ở hạt mẩu");
  assert.equal(MARKETING_DIMENSION_SPEND.adset, true);
  assert.equal(MARKETING_DIMENSION_SPEND.page, false, "fanpage vẫn không có số chi riêng");
}

/* ═══════════ 4. TÓM TẮT THEO MẪU ═══════════ */

type DecisionRow = Awaited<ReturnType<typeof getAdsDecision>>["rows"][number];

async function testModelSummaries(db: Db) {
  const ctx = { spendMapped: true, orderCoveragePct: 72.5, spendAtAdGrainPct: 40 };
  const none = summarizeModelAds("x", null, ctx);
  assert.equal(none.status, "NO_ROW");
  for (const k of ["spend", "orders", "cpo", "bookedRoas", "deliveredRoas", "profitAfterAds", "projectedProfitAfterAds", "decision"] as const) {
    assert.equal(none[k], null, `không có dòng ⇒ ${k} là null, không phải 0`);
  }
  const row = {
    key: "x",
    spendKnown: true,
    spend: 0,
    bookedOrders: 12,
    deliveredOrders: 5,
    costPerOrder: 0,
    bookedRoas: null,
    deliveredRoas: null,
    profitAfterAds: 900_000,
    projectedProfitAfterAds: 1_000_000,
    action: "HOLD",
    reason: "headroom 1,1",
    basis: "ACTUAL",
  } as unknown as DecisionRow;
  const unmapped = summarizeModelAds("x", row, { ...ctx, spendMapped: false });
  assert.equal(unmapped.status, "SPEND_UNMAPPED");
  assert.equal(unmapped.spend, null, "chưa ghép chiến dịch ⇒ chi CHƯA BIẾT, không phải 0 ₫");
  assert.equal(unmapped.profitAfterAds, null, "lợi nhuận sau QC trên chi chưa biết là chưa biết");
  assert.equal(unmapped.orders, 12, "đơn vẫn là số đo thật");
  assert.equal(unmapped.decision?.action, "HOLD", "hành động của bảng quyết định trả NGUYÊN — không ai sửa hộ ai");
  const mapped = summarizeModelAds("x", { ...row, spend: 600_000, costPerOrder: 50_000, bookedRoas: 6 } as DecisionRow, ctx);
  assert.equal(mapped.status, "OK");
  assert.deepEqual([mapped.spend, mapped.cpo, mapped.bookedRoas, mapped.profitAfterAds], [600_000, 50_000, 6, 900_000], "đọc nguyên dòng quyết định, không tính lại");
  assert.equal(mapped.attribution.orderCoveragePct, 72.5);

  clearMemo();
  const ghost = await getModelAdsSummary(`${P}khong-co-ma`, period("2021-03-01", "2021-03-03"));
  assert.equal(ghost.status, "NO_ROW");
  assert.equal(ghost.spend, null);
  assert.equal(ghost.orders, null);

  const empty = await modelCreativeSummary(db, `${P}khong-co-ma`);
  assert.equal(empty.total, 0, "0 creative là số đếm thật");
  assert.equal(empty.spendVnd, null, "không mẩu nào ⇒ chi CHƯA BIẾT");
  assert.equal(empty.cpoVnd, null);
  assert.equal(empty.latestWinner, null);
}

/* ═══════════ 5. THƯ VIỆN: LỌC THEO MẪU VÀ NGÀY ═══════════ */

async function testLibraryFilters(db: Db) {
  await db.insert(schema.products).values([
    { id: `${P}prod-a`, name: "Mẫu A" },
    { id: `${P}prod-b`, name: "Mẫu B" },
  ]);
  const start = day("2021-02-20");
  await db.insert(schema.creativeBatches).values({
    id: `${P}batch`,
    batchDay: "2021-02-20",
    status: "PUBLISHED",
    slotCount: 3,
    startAt: start,
    endAt: new Date(start.getTime() + 86_400_000),
    approvalDeadline: new Date(start.getTime() - 1_800_000),
    configSnapshot: {},
    ruleVersion: 1,
    approvedAt: new Date(start.getTime() - 3_600_000),
    approvalDigest: "cosb-digest",
  });
  const variant = (id: string, slot: number, productId: string, libraryAt: Date | null, fbAdId: string | null) => ({
    id: `${P}${id}`,
    batchId: `${P}batch`,
    slot,
    mode: "EXPLORE",
    productId,
    status: fbAdId ? "ENDED" : "GENERATED",
    genes: {} as Record<string, string>,
    genesVersion: 1,
    fbAdId,
    libraryAt,
    libraryOrders: libraryAt ? 101 : null,
  });
  await db.insert(schema.creativeVariants).values([
    variant("lib-a", 1, `${P}prod-a`, day("2021-03-01"), `${P}ad-1`),
    variant("lib-b", 2, `${P}prod-b`, day("2021-03-10"), `${P}ad-4`),
    variant("not-lib", 3, `${P}prod-a`, null, null),
  ]);
  await db.insert(schema.creativeVerdicts).values({ verdictDay: "2021-03-01", variantId: `${P}lib-a`, verdict: "WIN", ruleVersion: 1 });

  const ours = (xs: { id: string }[]) => xs.filter((x) => x.id.startsWith(P)).map((x) => x.id).sort();
  assert.deepEqual(ours(await listLibrary(db)), [`${P}lib-a`, `${P}lib-b`], "không lọc ⇒ mọi mẫu đã vào thư viện, mẫu chưa thắng không vào");
  assert.deepEqual(ours(await listLibrary(db, { productId: `${P}prod-a` })), [`${P}lib-a`], "lọc theo mẫu");
  assert.deepEqual(ours(await listLibrary(db, { from: day("2021-03-05") })), [`${P}lib-b`], "lọc theo NGÀY VÀO THƯ VIỆN (từ)");
  assert.deepEqual(ours(await listLibrary(db, { to: day("2021-03-05") })), [`${P}lib-a`], "lọc theo ngày vào thư viện (đến)");
  assert.deepEqual(ours(await listLibrary(db, { productId: `${P}prod-a`, from: day("2021-03-05") })), [], "các vế chỉ THU HẸP");
  const a = (await listLibrary(db, { productId: `${P}prod-a` }))[0];
  assert.equal(a.bookedOrders, 3, "thẻ thư viện dùng CHÍNH số đơn ORDER_AD_ID");
  assert.equal(a.ordersViaPost, 2);
  assert.equal(a.bookedRevenueVnd, 750_000, "bằng chứng: doanh thu lên đơn");
  assert.equal(a.costPerOrderVnd, Math.round(100_000 / 3), "bằng chứng: chi hạt mẩu (100K ngày 01/03, sau ngày chạy lô) / 3 đơn");
  const opts = await listLibraryProductOptions(db);
  assert.deepEqual(opts.filter((o) => o.id.startsWith(P)).map((o) => [o.id, o.count]).sort(), [[`${P}prod-a`, 1], [`${P}prod-b`, 1]], "lựa chọn bộ lọc = mẫu có mặt trong thư viện");

  const sum = await modelCreativeSummary(db, `${P}prod-a`);
  assert.equal(sum.total, 2);
  assert.equal(sum.byVerdict.WIN, 1);
  assert.equal(sum.byVerdict[NO_VERDICT], 1, "mẫu chưa có dòng phán quyết đứng riêng, không bị gộp vào một phán quyết");
  assert.equal(sum.attributedOrders, 3);
  assert.equal(sum.spendVnd, 100_000);
  assert.equal(sum.cpoVnd, Math.round(100_000 / 3));
  assert.equal(sum.latestWinner?.variantId, `${P}lib-a`);
  assert.ok(sum.links.library.includes("mau="));
}

export async function testCompanyOsCreativeAds(db: Db) {
  testKillRuleBasis();
  await cleanup(db);
  try {
    await testCreativeOrderAttribution(db);
    await testAdGrainSpend(db);
    await testModelSummaries(db);
    await testLibraryFilters(db);
    console.log("✓ Company OS · B: đơn creative qua ORDER_AD_ID (nhập nhằng không nối, không đếm đúp) · luật tắt giữ định nghĩa đã duyệt · chi nhóm/mẩu theo hạt mẩu + độ phủ, chiến dịch/mã không đổi · tóm tắt mẫu null khi chưa có dữ liệu · thư viện lọc mẫu/ngày");
  } finally {
    await cleanup(db);
    clearMemo();
  }
}

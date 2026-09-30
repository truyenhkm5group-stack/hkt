import assert from "node:assert/strict";
import { eq, inArray, like } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import {
  adsManagerUrl,
  filterLiveRows,
  groupLiveByProduct,
  liveRowsToCsv,
  liveStateOf,
  matchesLiveQuery,
  parseLiveView,
  resolveLiveNames,
  sortLiveRows,
  summarizeLive,
  type LiveBoardRow,
} from "@/lib/constants/creative-live-board";
import { CREATIVE_VERDICT_LABEL } from "@/lib/constants/creative-loop";
import { lastSuccessFor } from "@/lib/constants/sync";
import { shiftDay, vnDay } from "@/lib/constants/marketing-decision-ledger";
import { vnStartOfDay } from "@/lib/format";
import { loadLiveBoard, parseLiveBoardQuery } from "@/lib/queries/creative-live-board";
import { variantDailySeries } from "@/lib/queries/creative-loop";
import { marketingFreshness } from "@/lib/queries/marketing-daily";

/**
 * ═══════════ TAB ④ ĐANG CHẠY — BẢNG ĐIỀU KHIỂN CAMP (30/09/2026) ═══════════
 *
 * Khoá:
 *  1. TÊN: Facebook thắng ERP từng trường; khác tên ERP lúc đăng ⇒ cờ "đã đổi tên"; Facebook chưa báo ⇒ tên ERP, và
 *     nói ra là tên ERP. Tìm kiếm khớp CẢ tên cũ, không phân biệt dấu, mọi từ khoá phải có.
 *  2. LINK Ads Manager: chiến dịch riêng trước, mẩu sau; thiếu TKQC ⇒ không có link (không mở nhầm tài khoản).
 *  3. CHƯA BIẾT ≠ 0: sắp xếp đẩy `null` xuống cuối ở CẢ HAI chiều; tổng trả `null` khi không ô nào có số; tỷ số của
 *     tập là tỷ số của hai tổng trên các camp có CẢ HAI vế; CSV để ô trống.
 *  4. KỲ (CSDL thật): camp hiện = camp ĐÃ CHẠY trong kỳ; camp còn LIVE luôn hiện khi kỳ chứa hôm nay (kể cả hẹn giờ);
 *     số đo trong bảng là số TRONG KỲ, phán quyết vẫn trên số đo TOÀN ĐỜI.
 *
 * MỐC THỜI GIAN (mục 50): mọi mốc tương đối với ĐỒNG HỒ THẬT, cùng một `now` cho mọi lời gọi. Dữ liệu mang tiền tố
 * `lb-`, dọn trong `finally`; assertion chỉ nhìn dòng `lb-` vì khối khác có thể để lại camp LIVE.
 *
 * Chạy riêng phần thuần: npx tsx --tsconfig tsconfig.json tests/creative-live-board.test.ts
 */

const H = 3_600_000;
const D = 24 * H;

function row(over: Partial<LiveBoardRow> = {}): LiveBoardRow {
  return {
    id: "r",
    batchId: "b",
    slot: 1,
    headline: "Đầm hoa nhí",
    imageId: null,
    imageAvailable: false,
    productId: "p1",
    productLabel: "Q005 · Đầm hoa nhí",
    mode: "MANUAL",
    status: "LIVE",
    state: "RUNNING",
    batchDay: "2031-05-10",
    startAt: "2031-05-10T00:00:00.000Z",
    endAt: "2031-05-11T00:00:00.000Z",
    pausedAt: null,
    pauseReason: "",
    dailyBudget: true,
    committedBudgetVnd: 200_000,
    names: resolveLiveNames(null, { campaign: "TEST Q005 01", adset: "", ad: "" }),
    fbCampaignId: "c1",
    fbAdsetId: "as1",
    fbAdId: "ad1",
    adAccountId: "123",
    adsManagerUrl: null,
    spendVnd: 100_000,
    impressions: 1_000,
    clicks: 10,
    messages: 5,
    bookedOrders: 2,
    deliveredOrders: 1,
    returnedOrders: 0,
    ordersDirect: 2,
    ordersViaPost: 0,
    bookedRevenueVnd: 800_000,
    cpm: 100_000,
    ctr: 1,
    cpc: 10_000,
    costPerMessage: 20_000,
    costPerOrder: 50_000,
    lastSpendDate: "2031-05-10",
    verdict: "RUNNING",
    reasons: [],
    keepChecks: [],
    lifetimeSpendVnd: 100_000,
    lifetimeOrders: 2,
    ...over,
  };
}

function testPure() {
  const now = new Date("2031-05-11T09:00:00+07:00");
  assert.equal(liveStateOf("LIVE", "2031-05-11T10:00:00+07:00", now), "SCHEDULED", "LIVE chưa tới giờ ⇒ chờ tới giờ, không phải đang chạy");
  assert.equal(liveStateOf("LIVE", "2031-05-11T08:00:00+07:00", now), "RUNNING");
  assert.equal(liveStateOf("PAUSED", "2031-05-01T08:00:00+07:00", now), "PAUSED");
  assert.equal(liveStateOf("ENDED", "2031-05-01T08:00:00+07:00", now), "ENDED");

  // ── 1. Tên ──
  const erp = { campaign: "TEST Q005 01", adset: "Nhóm ERP", ad: "QC ERP" };
  const fb = resolveLiveNames({ campaign: "Q005 đầm hoa — scale", adset: "", ad: "QC FB", syncedAt: "2031-05-11T01:00:00.000Z" }, erp);
  assert.equal(fb.campaign, "Q005 đầm hoa — scale", "tên chiến dịch lấy từ Facebook");
  assert.equal(fb.adset, "Nhóm ERP", "Facebook không có chữ ở trường nào ⇒ trường đó lấy ERP");
  assert.equal(fb.ad, "QC FB");
  assert.equal(fb.source, "FACEBOOK");
  assert.equal(fb.renamed, true, "khác tên ERP lúc đăng ⇒ cờ đã đổi tên");
  assert.equal(fb.erpCampaign, "TEST Q005 01");
  assert.equal(resolveLiveNames({ campaign: "TEST Q005 01", adset: "", ad: "", syncedAt: null }, erp).renamed, false, "cùng tên ⇒ không đổi tên");
  const onlyErp = resolveLiveNames(null, erp);
  assert.equal(onlyErp.source, "ERP", "Facebook chưa báo về ⇒ NÓI RA là tên ERP");
  assert.equal(onlyErp.syncedAt, null);
  assert.equal(onlyErp.renamed, false);
  assert.equal(resolveLiveNames({ campaign: " ", adset: "", ad: "", syncedAt: "x" }, erp).source, "ERP", "dòng fb_ads không có chữ nào không phải là tên Facebook");

  // ── 2. Link Ads Manager ──
  assert.equal(adsManagerUrl({ adAccountId: "act_123", fbCampaignId: "c1", fbAdId: "ad1" }), "https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=123&selected_campaign_ids=c1", "chiến dịch riêng trước, bỏ tiền tố act_");
  assert.equal(adsManagerUrl({ adAccountId: "123", fbCampaignId: null, fbAdId: "ad1" }), "https://adsmanager.facebook.com/adsmanager/manage/ads?act=123&selected_ad_ids=ad1", "lô cũ (chiến dịch chung) ⇒ mở đúng mẩu");
  assert.equal(adsManagerUrl({ adAccountId: null, fbCampaignId: "c1", fbAdId: "ad1" }), null, "thiếu TKQC ⇒ không vẽ link");
  assert.equal(adsManagerUrl({ adAccountId: "123", fbCampaignId: null, fbAdId: null }), null);

  // ── Tìm kiếm ──
  const r = row({ names: fb });
  assert.ok(matchesLiveQuery(r, "dam hoa"), "không dấu khớp có dấu");
  assert.ok(matchesLiveQuery(r, "ĐẦM   scale"), "hoa thường + nhiều dấu cách");
  assert.ok(matchesLiveQuery(r, "test q005"), "khớp cả tên ERP lúc đăng (đã đổi tên trên Ads Manager)");
  assert.ok(matchesLiveQuery(r, "ad1") && matchesLiveQuery(r, "c1"), "khớp ID quảng cáo / chiến dịch");
  assert.ok(!matchesLiveQuery(r, "dam vay"), "MỌI từ khoá phải có mặt");
  assert.ok(matchesLiveQuery(r, "   "), "ô tìm rỗng không lọc");

  const rows = [
    row({ id: "a", state: "RUNNING", verdict: "PROMISING", productId: "p1", mode: "MANUAL" }),
    row({ id: "b", state: "PAUSED", verdict: "KILL", productId: "p2", mode: "DESIGN" }),
    row({ id: "c", state: "SCHEDULED", verdict: "PENDING", productId: null, mode: "MANUAL" }),
  ];
  const base = { q: "", states: [], verdicts: [], products: [], modes: [] };
  assert.deepEqual(filterLiveRows(rows, base).map((x) => x.id), ["a", "b", "c"], "không lọc gì ⇒ đủ");
  assert.deepEqual(filterLiveRows(rows, { ...base, states: ["RUNNING", "SCHEDULED"] }).map((x) => x.id), ["a", "c"]);
  assert.deepEqual(filterLiveRows(rows, { ...base, verdicts: ["KILL"] }).map((x) => x.id), ["b"]);
  assert.deepEqual(filterLiveRows(rows, { ...base, products: ["p2"], modes: ["DESIGN"] }).map((x) => x.id), ["b"], "các bộ lọc giao nhau");

  // ── 3. CHƯA BIẾT ≠ 0 ──
  const s = [row({ id: "x", costPerOrder: 30_000 }), row({ id: "unk", costPerOrder: null }), row({ id: "y", costPerOrder: 90_000 })];
  assert.deepEqual(sortLiveRows(s, "costPerOrder", "asc").map((x) => x.id), ["x", "y", "unk"], "tăng dần: CHƯA BIẾT xuống cuối, không đứng đầu như 'rẻ nhất'");
  assert.deepEqual(sortLiveRows(s, "costPerOrder", "desc").map((x) => x.id), ["y", "x", "unk"], "giảm dần: CHƯA BIẾT vẫn xuống cuối");
  assert.deepEqual(
    sortLiveRows([row({ id: "old", startAt: "2031-05-01T00:00:00.000Z" }), row({ id: "new", startAt: "2031-05-09T00:00:00.000Z" })], "khoa-la", "desc").map((x) => x.id),
    ["new", "old"],
    "khoá sắp xếp lạ ⇒ mặc định (mới đăng trước)",
  );

  const none = summarizeLive([row({ spendVnd: null, messages: null, bookedOrders: null, bookedRevenueVnd: null })]);
  assert.equal(none.spendVnd, null, "không camp nào có số chi ⇒ tổng CHƯA BIẾT, không phải 0");
  assert.equal(none.costPerOrder, null);
  const sum = summarizeLive([
    row({ spendVnd: 100_000, bookedOrders: 2, messages: 10, state: "RUNNING", verdict: "PROMISING" }),
    row({ spendVnd: 300_000, bookedOrders: null, messages: 5, state: "SCHEDULED", verdict: "RUNNING" }),
    row({ spendVnd: null, bookedOrders: 0, messages: null, state: "PAUSED", verdict: "KILL" }),
  ]);
  assert.equal(sum.spendVnd, 400_000, "tổng chỉ cộng ô có số");
  assert.equal(sum.bookedOrders, 2);
  assert.equal(sum.costPerOrder, 50_000, "chi/đơn = chi ÷ đơn trên camp có CẢ HAI vế — không cộng chi của camp chưa đếm được đơn");
  assert.equal(sum.costPerMessage, 26_667, "chi/tin = 400K ÷ 15 tin, làm tròn đồng");
  assert.equal(sum.running, 1);
  assert.equal(sum.scheduled, 1);
  assert.equal(sum.promising, 1);
  assert.equal(sum.killed, 1);
  assert.equal(sum.undecided, 1, "RUNNING là chưa kết luận");

  // ── Gộp theo sản phẩm ──
  const groups = groupLiveByProduct([
    row({ id: "g1", productId: "p1", productLabel: "Q005", spendVnd: 100_000, bookedOrders: 1, state: "RUNNING" }),
    row({ id: "g2", productId: "p1", productLabel: "Q005", spendVnd: 300_000, bookedOrders: 3, state: "PAUSED" }),
    row({ id: "g3", productId: "p2", productLabel: "A112", spendVnd: 500_000, bookedOrders: 0 }),
    row({ id: "g4", productId: "p3", productLabel: "B045", spendVnd: null, bookedOrders: null }),
    row({ id: "g5", productId: null, productLabel: null, spendVnd: 900_000 }),
  ]);
  assert.deepEqual(groups.map((g) => g.productId), ["p2", "p1", "p3", null], "chi giảm dần · chi CHƯA BIẾT xuống cuối · 'không gắn mã' luôn cuối cùng dù chi lớn nhất");
  const q005 = groups[1].summary;
  assert.equal(q005.total, 2);
  assert.equal(q005.running, 1);
  assert.equal(q005.spendVnd, 400_000);
  assert.equal(q005.costPerOrder, 100_000, "chi/đơn của MÃ = tổng chi ÷ tổng đơn, không trung bình các tỷ số");
  assert.equal(groups[0].summary.costPerOrder, null, "0 đơn ⇒ chi/đơn CHƯA BIẾT, không phải chia cho 0");
  assert.equal(groups[3].label, "Không gắn mã");
  assert.equal(parseLiveView("sp"), "sp");
  assert.equal(parseLiveView("la"), "camp", "giá trị lạ ⇒ góc nhìn mặc định");

  // ── Mốc đồng bộ: sync_runs ghi TÊN CON, khoá job phải đi qua JOB_RUN_KEYS ──
  const t1 = new Date("2031-05-11T01:00:00Z");
  const t2 = new Date("2031-05-11T02:00:00Z");
  const runs = [
    { source: "FACEBOOK", job: "ads_insights", at: t1 },
    { source: "FACEBOOK", job: "ads_insights", at: t2 },
    { source: "PANCAKE", job: "orders_incremental", at: t2 },
    { source: "FACEBOOK", job: "facebook-ads", at: new Date("2031-06-01T00:00:00Z") },
  ];
  assert.equal(lastSuccessFor("facebook-ads", runs)?.toISOString(), t2.toISOString(), "khớp theo SOURCE:tên con, lấy lượt muộn nhất; dòng mang khoá job trần không phải tên con");
  assert.equal(lastSuccessFor("pancake-orders", runs)?.toISOString(), t2.toISOString());
  assert.equal(lastSuccessFor("vtp-tracking", runs), null, "chưa có lượt nào ⇒ CHƯA BIẾT");
  assert.equal(lastSuccessFor("khoa-la", runs), null, "khoá không khai ⇒ không đoán tên con");

  const csv = liveRowsToCsv([row({ names: fb, spendVnd: null, bookedOrders: null, reasons: ['Có "ngoặc", phẩy'] })], { verdict: CREATIVE_VERDICT_LABEL });
  const [head, line] = csv.split("\r\n");
  assert.ok(head.startsWith("Chiến dịch (Facebook),"), "CSV có tiêu đề tiếng Việt");
  assert.ok(line.startsWith("Q005 đầm hoa — scale,Nhóm ERP,QC FB,TEST Q005 01,Facebook,"), "CSV in tên Facebook + tên ERP lúc đăng");
  assert.ok(line.includes(',"Có ""ngoặc"", phẩy"'), "ô có ngoặc kép / dấu phẩy được bọc đúng");
  const cells = line.split(",");
  assert.equal(cells[11], "", "chi CHƯA BIẾT ⇒ ô trống, không phải 0");
}

// ───────────────────────────── CSDL THẬT ─────────────────────────────

const P = "lb-";

async function cleanup(db: Db) {
  const v = schema.creativeVariants;
  const ids = (await db.select({ id: v.id }).from(v).where(like(v.id, `${P}%`))).map((r) => r.id);
  if (ids.length) {
    await db.delete(schema.creativeScaleDrafts).where(inArray(schema.creativeScaleDrafts.variantId, ids));
    await db.delete(schema.creativeFbActions).where(inArray(schema.creativeFbActions.variantId, ids));
    await db.delete(v).where(inArray(v.id, ids));
  }
  await db.delete(schema.creativeBatches).where(like(schema.creativeBatches.id, `${P}%`));
  await db.delete(schema.orders).where(like(schema.orders.id, `${P}%`));
  await db.delete(schema.adSpends).where(like(schema.adSpends.adId, `${P}%`));
  await db.delete(schema.fbAds).where(like(schema.fbAds.id, `${P}%`));
  await db.delete(schema.fbAdsets).where(like(schema.fbAdsets.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
  await db.delete(schema.syncRuns).where(eq(schema.syncRuns.actor, "lb-test"));
}

async function testDb(db: Db) {
  const now = new Date();
  const today = vnDay(now);
  await cleanup(db);
  try {
    await db.insert(schema.products).values({ id: `${P}prod`, name: "Đầm thử bảng camp", customId: "LB01" });
    const startRun = new Date(now.getTime() - 10 * D);
    const startOld = new Date(now.getTime() - 40 * D);
    // Hẹn sang NGÀY MAI (ca 28/09/2026: 7 camp hẹn 07:00 sáng hôm sau) — bắt đầu SAU cuối kỳ mà vẫn phải hiện.
    const startSched = new Date(now.getTime() + 30 * H);
    const startPaused = new Date(now.getTime() - 20 * D);
    const batch = (id: string, start: Date, snapshot: Record<string, unknown> = { adAccountId: "act_999" }) => ({
      id: `${P}${id}`,
      batchDay: vnDay(start),
      kind: "INSTANT",
      status: "PUBLISHED",
      slotCount: 1,
      startAt: start,
      endAt: new Date(start.getTime() + D),
      approvalDeadline: new Date(start.getTime() - H),
      configSnapshot: snapshot,
      plan: { instant: true, budgetMode: "DAILY" },
      ruleVersion: 1,
      approvedAt: new Date(start.getTime() - H),
      approvalDigest: "lb-digest",
    });
    await db.insert(schema.creativeBatches).values([batch("b-run", startRun), batch("b-old", startOld), batch("b-sched", startSched), batch("b-paused", startPaused, {})]);
    const variant = (id: string, status: string, extra: Partial<typeof schema.creativeVariants.$inferInsert> = {}) => ({
      id: `${P}${id}`,
      batchId: `${P}b-${id}`,
      slot: 1,
      mode: "MANUAL",
      productId: `${P}prod`,
      genes: {},
      genesVersion: 1,
      status,
      fbAdId: `${P}ad-${id}`,
      fbAdsetId: `${P}as-${id}`,
      committedBudgetVnd: 200_000,
      ...extra,
    });
    await db.insert(schema.creativeVariants).values([
      variant("run", "LIVE", { campaignName: "TEST LB01 CU", fbCampaignId: `${P}camp-run` }),
      variant("old", "ENDED", { campaignName: "TEST LB01 00" }),
      variant("sched", "LIVE", { campaignName: "TEST LB01 02" }),
      // Tắt 15 ngày trước, KHÔNG có TKQC trong cấu hình chụp của lô và chưa vào sổ fb_ads ⇒ không có link.
      variant("paused", "PAUSED", { campaignName: "TEST LB01 03", pausedAt: new Date(now.getTime() - 15 * D) }),
    ]);
    // Tên trên Facebook: người đã đổi tên chiến dịch trên Ads Manager.
    await db.insert(schema.fbAdsets).values({ id: `${P}as-run`, name: "Nhóm FB LB", campaignId: `${P}camp-run`, accountId: "act_555" });
    await db.insert(schema.fbAds).values({ id: `${P}ad-run`, name: "QC FB LB", adsetId: `${P}as-run`, campaignId: `${P}camp-run`, campaignName: "Đầm LB01 — scale tháng 10", accountId: "act_555" });

    const spend = (adId: string, day: string, amount: number) => ({ platform: "FACEBOOK", campaign: "LB", grain: "AD", adId: `${P}${adId}`, spend: amount, impressions: 1_000, clicks: 10, messages: 2, spendDate: vnStartOfDay(day), createdBy: "test" });
    await db.insert(schema.adSpends).values([spend("ad-run", shiftDay(today, -9), 300_000), spend("ad-run", shiftDay(today, -1), 100_000), spend("ad-old", vnDay(startOld), 150_000)]);
    const order = (id: string, at: Date) => ({ id: `${P}${id}`, stage: "CONFIRMED" as never, adId: `${P}ad-run`, cod: 400_000, totalPriceAfterDiscount: 400_000, prepaid: 0, insertedAt: at });
    await db.insert(schema.orders).values([order("o-early", new Date(now.getTime() - 9 * D)), order("o-late", new Date(now.getTime() - 1 * D))]);

    const mine = (rows: LiveBoardRow[]) => rows.filter((r) => r.id.startsWith(P));
    const byId = (rows: LiveBoardRow[]) => new Map(mine(rows).map((r) => [r.id.slice(P.length), r]));

    // ── Kỳ 7 ngày (mặc định) ──
    const q7 = parseLiveBoardQuery({ pageSize: "200" });
    assert.equal(q7.period.key, "7d", "kỳ mặc định của tab là 7 ngày qua");
    const w7 = await loadLiveBoard(db, now, q7);
    assert.ok(w7.windowed);
    const m7 = byId(w7.rows);
    assert.deepEqual([...m7.keys()].sort(), ["run", "sched"], "7 ngày: camp đang chạy + camp hẹn giờ; camp hết khung 40 ngày trước và camp tắt 15 ngày trước KHÔNG hiện");
    const run = m7.get("run");
    assert.ok(run);
    assert.equal(run.spendVnd, 100_000, "số đo TRONG KỲ: chỉ chi hôm qua, không chi 9 ngày trước");
    assert.equal(run.bookedOrders, 1, "đơn TRONG KỲ theo ngày lên đơn");
    assert.equal(run.lifetimeSpendVnd, 400_000, "phán quyết đọc số đo TOÀN ĐỜI");
    assert.equal(run.lifetimeOrders, 2);
    assert.equal(run.costPerOrder, 100_000);
    assert.equal(run.state, "RUNNING");
    assert.equal(m7.get("sched")?.state, "SCHEDULED");
    assert.equal(m7.get("sched")?.spendVnd, null, "chưa có dòng chi ⇒ CHƯA BIẾT, không phải 0");

    // Tên đồng bộ từ Ads Manager + link mở đúng chiến dịch, bằng TKQC của mẩu trên Facebook.
    assert.equal(run.names.campaign, "Đầm LB01 — scale tháng 10");
    assert.equal(run.names.adset, "Nhóm FB LB");
    assert.equal(run.names.ad, "QC FB LB");
    assert.equal(run.names.source, "FACEBOOK");
    assert.equal(run.names.renamed, true);
    assert.equal(run.productLabel, "LB01 · Đầm thử bảng camp");
    assert.equal(run.adsManagerUrl, `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=555&selected_campaign_ids=${P}camp-run`);
    assert.equal(m7.get("sched")?.names.source, "ERP", "camp chưa tiêu đồng nào ⇒ tên ERP, nói ra là tên ERP");
    assert.equal(m7.get("sched")?.adsManagerUrl, `https://adsmanager.facebook.com/adsmanager/manage/ads?act=999&selected_ad_ids=${P}ad-sched`, "chưa có mẩu trên sổ fb_ads ⇒ TKQC của lô");

    // Tìm theo tên CŨ và theo tên MỚI đều ra cùng camp; lọc trạng thái.
    for (const kw of ["test lb01 cu", "dam lb01 scale"]) {
      const f = await loadLiveBoard(db, now, parseLiveBoardQuery({ q: kw, pageSize: "200" }));
      assert.deepEqual([...byId(f.rows).keys()], ["run"], `tìm “${kw}”`);
    }
    const sch = await loadLiveBoard(db, now, parseLiveBoardQuery({ tt: "SCHEDULED", pageSize: "200" }));
    assert.deepEqual([...byId(sch.rows).keys()], ["sched"]);

    // ── Kỳ trong QUÁ KHỨ: camp chạy hồi đó hiện, camp LIVE bắt đầu sau cuối kỳ không hiện ──
    const past = await loadLiveBoard(db, now, parseLiveBoardQuery({ period: "custom", from: shiftDay(vnDay(startOld), -1), to: shiftDay(vnDay(startOld), 2), pageSize: "200" }));
    const mp = byId(past.rows);
    assert.deepEqual([...mp.keys()], ["old"], "kỳ cũ: chỉ camp chạy trong kỳ; camp hẹn giờ không hiện vì kỳ không chứa hôm nay");
    assert.equal(mp.get("old")?.spendVnd, 150_000);

    // ── Kỳ chứa camp đã tắt ──
    const mid = await loadLiveBoard(db, now, parseLiveBoardQuery({ period: "custom", from: shiftDay(today, -18), to: shiftDay(today, -16), pageSize: "200" }));
    const mm = byId(mid.rows);
    assert.ok(mm.has("paused"), "camp tắt SAU đầu kỳ đã chạy trong kỳ");
    assert.equal(mm.get("paused")?.adsManagerUrl, null, "không biết TKQC ⇒ không vẽ link (không mở nhầm tài khoản)");
    assert.equal(mm.get("paused")?.bookedOrders, 0, "có mẩu QC mà 0 đơn ⇒ 0 THẬT");
    assert.equal(mm.get("paused")?.spendVnd, null, "không dòng chi trong kỳ ⇒ CHƯA BIẾT");
    assert.equal(mm.has("run"), false, "camp bắt đầu SAU cuối kỳ không hiện");

    // ── Chuỗi theo ngày: cộng các ngày ra ĐÚNG số của dòng camp trong cùng kỳ ──
    const w7win = { from: q7.period.from, to: q7.period.to };
    const s7 = await variantDailySeries(db, { fbAdId: `${P}ad-run`, startAt: startRun }, w7win, now);
    const sum7 = (pick: (p: (typeof s7.points)[number]) => number | null) => s7.points.reduce<number | null>((acc, p) => (pick(p) === null ? acc : (acc ?? 0) + (pick(p) as number)), null);
    assert.equal(sum7((p) => p.spendVnd), run.spendVnd, "cộng chi theo ngày = chi trong kỳ của dòng camp");
    assert.equal(sum7((p) => p.bookedOrders), run.bookedOrders, "cộng đơn theo ngày = đơn trong kỳ của dòng camp");
    assert.equal(s7.points.length, 7, "trục đủ 7 ngày của kỳ, kể cả ngày trống");
    assert.equal(s7.points.find((p) => p.day === shiftDay(today, -2))?.spendVnd, null, "ngày không có dòng chi ⇒ CHƯA BIẾT, không vẽ 0");
    const sAll = await variantDailySeries(db, { fbAdId: `${P}ad-run`, startAt: startRun }, null, now);
    assert.equal(sAll.points[0].day, vnDay(startRun), "toàn đời: trục bắt đầu từ ngày chạy");
    assert.equal(sAll.points.at(-1)?.day, today);
    assert.equal(sAll.truncated, false);
    assert.equal(sAll.points.reduce((a, p) => a + (p.spendVnd ?? 0), 0), run.lifetimeSpendVnd, "toàn đời: cộng ngày = chi toàn đời");
    assert.equal(sAll.points.reduce((a, p) => a + p.bookedOrders, 0), run.lifetimeOrders);

    // ── Độ tươi nguồn ở /ads/daily: lượt đồng bộ Facebook THÀNH CÔNG phải được thấy ──
    const doneAt = new Date(now.getTime() - 5 * 60_000);
    await db.insert(schema.syncRuns).values({ source: "FACEBOOK", job: "ads_insights", status: "SUCCESS", actor: "lb-test", startedAt: new Date(doneAt.getTime() - 60_000), finishedAt: doneAt });
    const fresh = (await marketingFreshness(db)).find((f) => f.job === "facebook-ads");
    assert.ok(fresh?.lastOkAt && fresh.lastOkAt >= doneAt, "sync_runs ghi 'ads_insights' ⇒ nguồn 'facebook-ads' KHÔNG được báo chưa đồng bộ");
    assert.equal(fresh?.stale, false);

    // ── Toàn bộ: số đo toàn đời ──
    const all = await loadLiveBoard(db, now, parseLiveBoardQuery({ period: "all", pageSize: "200" }));
    assert.equal(all.windowed, false);
    const ma = byId(all.rows);
    assert.deepEqual([...ma.keys()].sort(), ["old", "paused", "run", "sched"]);
    assert.equal(ma.get("run")?.spendVnd, 400_000, "kỳ toàn bộ ⇒ số đo toàn đời");
  } finally {
    await cleanup(db);
  }
}

export function testCreativeLiveBoardPure() {
  testPure();
  console.log("✓ Bảng camp ④: tên Facebook thắng tên ERP (cờ đổi tên) · link Ads Manager đúng đối tượng · tìm không dấu khớp cả tên cũ · CHƯA BIẾT xuống cuối, tổng null, tỷ số của hai tổng · CSV ô trống");
}

export async function testCreativeLiveBoardDb(db: Db) {
  await testDb(db);
  console.log("✓ Bảng camp ④ (CSDL): kỳ = camp đã chạy trong kỳ, LIVE hẹn giờ luôn hiện khi kỳ chứa hôm nay · số đo trong kỳ, phán quyết toàn đời · tên + TKQC từ fb_ads");
}

if (process.argv[1] && /creative-live-board\.test\.ts$/.test(process.argv[1])) {
  testCreativeLiveBoardPure();
}

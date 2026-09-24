import assert from "node:assert/strict";
import {
  CREATIVE_HARD_LIMITS,
  DEFAULT_CREATIVE_CONFIG,
  GENE_KEYS,
  PIXEL_SAFE_SOURCE_KINDS,
  geneSignature,
  normalizeCreativeConfig,
  parseGenes,
  parsePartialGenes,
  type CreativeLoopConfig,
  type CreativeRule,
  type Genes,
} from "@/lib/constants/creative-loop";
import { judgeVariant, metricValue, type JudgeInput, type VariantMetrics } from "@/lib/creative/judge";
import { geneStats, outcomeOf, sampleBeta, seededRandom, thompsonPick, type Observation } from "@/lib/creative/learn";
import { planBatch, type PlanInput } from "@/lib/creative/plan";
import { batchDayToBuild, batchWindow, isApprovalOpen, isPublishOpen } from "@/lib/creative/schedule";

/**
 * ═══════════ VÒNG MẪU QUẢNG CÁO — BA HÀM THUẦN VÀ CÁC TRẦN ═══════════
 *
 * Đặc tả: `docs/creative-loop.md`. Khối này khoá:
 *  1. TRẦN CỨNG — cấu hình chỉ làm hẹp, không nới ra.
 *  2. BẢNG CHÂN LÝ của `judgeVariant` — kể cả CHƯA BIẾT ≠ 0 và "không có luật giữ ⇒ không kết luận".
 *  3. HỌC — thành công theo luật vs theo nền tương đối; Thompson tất định theo hạt giống.
 *  4. LẬP LÔ — tất định, không trùng, đổi ĐÚNG MỘT gen ở ô khai thác, không nhồi khi thiếu.
 *  5. LỊCH — không bao giờ dựng lô cho hôm nay; quá hạn duyệt là không đăng.
 */

const G: Genes = { angle: "LIFESTYLE", scene: "CAFE", model: "FEMALE_YOUNG", composition: "SINGLE_HERO", textOverlay: "NONE", palette: "WARM" };

const M0: VariantMetrics = { spendVnd: 0, impressions: 0, clicks: 0, messages: 0, bookedOrders: 0, deliveredOrders: 0, returnedOrders: 0 };

const START = new Date("2026-10-01T06:00:00+07:00");
const END = new Date("2026-10-02T06:00:00+07:00");

function jin(over: Partial<JudgeInput> = {}, metrics: Partial<VariantMetrics> = {}): JudgeInput {
  return { status: "LIVE", startAt: START, endAt: END, libraryAt: null, ...over, metrics: { ...M0, ...metrics } };
}

const KILL_NO_MSG: CreativeRule = { metric: "messages", op: "lt", value: 1, minSpendVnd: 100_000, label: "Tiêu 100K không có tin nhắn" };
const KILL_CPM: CreativeRule = { metric: "cpm", op: "gt", value: 60_000, minSpendVnd: 50_000 };
const KEEP_CPM: CreativeRule = { metric: "costPerMessage", op: "lte", value: 20_000, minSpendVnd: 150_000 };

function cfg(over: Partial<CreativeLoopConfig> = {}) {
  return { ...DEFAULT_CREATIVE_CONFIG, killRules: [KILL_NO_MSG, KILL_CPM], keepRules: [KEEP_CPM], ...over };
}

export function testCreativeLoop() {
  // ═══════════ 1. TRẦN CỨNG ═══════════

  // Chủ shop chốt 24/09/2026: 10 mẫu × 200.000đ × 1 ngày, chạy 6:00. Đổi trần là một lần sửa mã có
  // người đọc — bài kiểm này đỏ để người sửa phải thấy mình đang đổi một quyết định của chủ shop.
  assert.equal(CREATIVE_HARD_LIMITS.maxBatchSize, 10);
  assert.equal(CREATIVE_HARD_LIMITS.maxBudgetPerVariantVnd, 200_000);
  assert.equal(CREATIVE_HARD_LIMITS.maxTestDays, 1);
  assert.equal(CREATIVE_HARD_LIMITS.maxDailyTestSpendVnd, CREATIVE_HARD_LIMITS.maxBatchSize * CREATIVE_HARD_LIMITS.maxBudgetPerVariantVnd);
  assert.equal(DEFAULT_CREATIVE_CONFIG.startHourVn, 6);
  assert.equal(DEFAULT_CREATIVE_CONFIG.winOrdersAbove, 100, "chủ shop chốt: > 100 đơn là THẮNG");
  assert.deepEqual(DEFAULT_CREATIVE_CONFIG.killRules, [], "không có bộ luật tắt mặc định — chủ shop tự điền");
  assert.deepEqual(DEFAULT_CREATIVE_CONFIG.keepRules, [], "không có bộ luật giữ mặc định — chủ shop tự điền");
  assert.equal(DEFAULT_CREATIVE_CONFIG.enabled, false, "vòng mặc định TẮT");

  // Cấu hình chỉ LÀM HẸP.
  const wide = normalizeCreativeConfig({ batchSize: 50, budgetPerVariantVnd: 5_000_000, testDays: 7, imageDailyCapUsd: 999 });
  assert.equal(wide.config.batchSize, CREATIVE_HARD_LIMITS.maxBatchSize);
  assert.equal(wide.config.budgetPerVariantVnd, CREATIVE_HARD_LIMITS.maxBudgetPerVariantVnd);
  assert.equal(wide.config.testDays, CREATIVE_HARD_LIMITS.maxTestDays);
  assert.equal(wide.config.imageDailyCapUsd, CREATIVE_HARD_LIMITS.maxImageUsdPerDay);
  const narrow = normalizeCreativeConfig({ batchSize: 4, budgetPerVariantVnd: 100_000 });
  assert.equal(narrow.config.batchSize, 4);
  assert.equal(narrow.config.budgetPerVariantVnd, 100_000);
  // Thiếu bốn trường đăng ⇒ nói ra đủ bốn, không im lặng.
  assert.deepEqual(narrow.problems.map((p) => p.field).sort(), ["adAccountId", "pageId", "templateAdId", "testCampaignId"]);
  // Luật hỏng bị BỎ NGUYÊN DÒNG và được báo — không sửa hộ.
  const badRule = normalizeCreativeConfig({ killRules: [KILL_NO_MSG, { metric: "cpm", op: "gt", value: "60k", minSpendVnd: 0 }, { metric: "roas", op: "gt", value: 2, minSpendVnd: 0 }] });
  assert.equal(badRule.config.killRules.length, 1);
  assert.equal(badRule.problems.filter((p) => p.field === "rules").length, 2);
  assert.equal(normalizeCreativeConfig({ adAccountId: "act_123" }).config.adAccountId, "123", "id tài khoản không mang tiền tố act_");

  // Ảnh đối thủ KHÔNG BAO GIỜ được gửi điểm ảnh sang máy sinh ảnh.
  assert.deepEqual([...PIXEL_SAFE_SOURCE_KINDS], ["PRODUCT_PHOTO"]);

  // Gen: từ vựng đóng, giá trị lạ bị bỏ, không bị ép.
  assert.deepEqual(parsePartialGenes({ scene: "CAFE", model: "ROBOT", palette: 3 }), { scene: "CAFE" });
  assert.equal(parseGenes({ ...G, scene: "coffee shop" }), null, "thiếu một gen hợp lệ ⇒ không vào thống kê");
  assert.deepEqual(parseGenes(G), G);

  // ═══════════ 2. BẢNG CHÂN LÝ CỦA PHÁN QUYẾT ═══════════

  const now = (h: number) => new Date(START.getTime() + h * 3_600_000);
  const c = cfg();

  assert.equal(judgeVariant(jin({ status: "GENERATED", startAt: null, endAt: null }), c, now(1)).verdict, "PENDING");
  assert.equal(judgeVariant(jin(), c, now(-1)).verdict, "PENDING", "chưa tới 6:00");
  // CHƯA BIẾT không phải 0: chưa có dòng chi nào ⇒ không luật nào được xét, kể cả luật tắt.
  assert.equal(judgeVariant(jin({}, { spendVnd: null, messages: null }), c, now(3)).verdict, "RUNNING");
  assert.equal(judgeVariant(jin({}, { spendVnd: null }), c, now(30)).verdict, "UNJUDGED", "hết khung mà không có số chi ⇒ không kết luận, không phải LOẠI");

  // Luật tắt chạy NGAY TRONG khung test, nhưng chỉ khi đã qua sàn chi.
  assert.equal(judgeVariant(jin({}, { spendVnd: 90_000, messages: 0 }), c, now(3)).verdict, "RUNNING", "chưa đủ 100K thì 0 tin nhắn chưa nói gì");
  const k = judgeVariant(jin({}, { spendVnd: 120_000, messages: 0, impressions: 10_000 }), c, now(3));
  assert.equal(k.verdict, "KILL");
  assert.equal(k.firedKillRule?.label, "Tiêu 100K không có tin nhắn");
  // Tỷ số có mẫu số 0 là null ⇒ luật trên tỷ số KHÔNG kích hoạt (CPM với 0 hiển thị).
  assert.equal(metricValue({ ...M0, spendVnd: 80_000, impressions: 0 }, "cpm"), null);
  assert.equal(judgeVariant(jin({}, { spendVnd: 80_000, impressions: 0, messages: 3 }), c, now(3)).verdict, "RUNNING");
  assert.equal(judgeVariant(jin({}, { spendVnd: 80_000, impressions: 1_000, messages: 3 }), c, now(3)).verdict, "KILL", "CPM 80.000 > 60.000");

  // Hết khung: đợi đơn về trước khi kết luận.
  const good = { spendVnd: 200_000, impressions: 8_000, clicks: 200, messages: 12 };
  assert.equal(judgeVariant(jin({ status: "ENDED" }, good), c, now(30)).verdict, "AWAITING_ORDERS");
  assert.equal(judgeVariant(jin({ status: "ENDED" }, good), c, now(48)).verdict, "PROMISING", "200K / 12 tin = 16.667đ ≤ 20.000đ");
  assert.equal(judgeVariant(jin({ status: "ENDED" }, { ...good, messages: 5 }), c, now(48)).verdict, "LOSE", "40.000đ / tin");
  // Không có luật giữ ⇒ máy KHÔNG kết luận tốt hay kém.
  assert.equal(judgeVariant(jin({ status: "ENDED" }, good), cfg({ keepRules: [] }), now(48)).verdict, "UNJUDGED");

  // THẮNG: VƯỢT (không phải bằng) ngưỡng, và đã vào thư viện thì không tự rơi ra.
  assert.equal(judgeVariant(jin({ status: "ENDED" }, { ...good, bookedOrders: 100 }), c, now(48)).verdict, "PROMISING", "100 đơn chưa VƯỢT 100");
  assert.equal(judgeVariant(jin({ status: "ENDED" }, { ...good, bookedOrders: 101 }), c, now(48)).verdict, "WIN");
  const latched = judgeVariant(jin({ status: "ENDED", libraryAt: now(40) }, { ...good, bookedOrders: 97 }), c, now(60));
  assert.equal(latched.verdict, "WIN");
  assert.ok(latched.reasons.some((r) => r.includes("97")), "in số đơn HIỆN TẠI cạnh dấu thư viện");

  // ═══════════ 3. HỌC ═══════════

  const obs = (id: string, verdict: Observation["verdict"], genes: Partial<Genes>, spend: number | null, orders: number): Observation => ({
    variantId: id,
    productId: "p1",
    genes: { ...G, ...genes },
    genesVersion: 1,
    verdict,
    spendVnd: spend,
    bookedOrders: orders,
  });
  assert.deepEqual(outcomeOf(obs("a", "WIN", {}, 1, 1), null), { success: true, basis: "RULES" });
  assert.deepEqual(outcomeOf(obs("a", "KILL", {}, 1, 0), null), { success: false, basis: "RULES" });
  assert.equal(outcomeOf(obs("a", "RUNNING", {}, 1, 0), null), null, "chưa ngã ngũ ⇒ không dạy gì");
  assert.equal(outcomeOf(obs("a", "UNJUDGED", {}, null, 0), null), null, "không có số chi ⇒ không dạy gì");
  assert.deepEqual(outcomeOf(obs("a", "UNJUDGED", {}, 200_000, 0), 50_000), { success: false, basis: "RELATIVE" }, "chi tiền mà 0 đơn là thua ở mọi nền");
  assert.deepEqual(outcomeOf(obs("a", "UNJUDGED", {}, 200_000, 5), 50_000), { success: true, basis: "RELATIVE" }, "40.000đ/đơn ≤ trung vị 50.000đ");

  const stats = geneStats([
    obs("1", "WIN", { scene: "CAFE" }, 2_000_000, 120),
    obs("2", "PROMISING", { scene: "CAFE" }, 200_000, 4),
    obs("3", "KILL", { scene: "STREET" }, 120_000, 0),
    obs("4", "LOSE", { scene: "STREET" }, 200_000, 1),
    { ...obs("5", "WIN", { scene: "HOME" }, 1, 200), genesVersion: 999 },
  ]);
  const cafe = stats.find((s) => s.key === "scene" && s.value === "CAFE")!;
  const street = stats.find((s) => s.key === "scene" && s.value === "STREET")!;
  const home = stats.find((s) => s.key === "scene" && s.value === "HOME")!;
  assert.deepEqual([cafe.tests, cafe.successes, cafe.wins], [2, 2, 1]);
  assert.deepEqual([street.tests, street.successes], [2, 0]);
  assert.equal(home.tests, 0, "khác phiên bản từ vựng gen ⇒ không cộng dồn");
  assert.equal(home.posteriorMean, 0.5, "chưa thử ⇒ 0,5 = CHƯA BIẾT, không phải 0");

  // Thompson tất định theo hạt giống, và ưu tiên rõ giá trị đã thắng.
  const r1 = seededRandom("x");
  const r2 = seededRandom("x");
  for (let i = 0; i < 5; i += 1) assert.equal(r1(), r2());
  const bigStats = geneStats([
    ...Array.from({ length: 30 }, (_, i) => obs(`c${i}`, "PROMISING", { scene: "CAFE" }, 1, 1)),
    ...Array.from({ length: 30 }, (_, i) => obs(`s${i}`, "LOSE", { scene: "STREET" }, 1, 0)),
  ]);
  const rand = seededRandom("pick");
  let cafeWins = 0;
  let streetPicks = 0;
  for (let i = 0; i < 200; i += 1) {
    const v = thompsonPick("scene", bigStats, rand);
    if (v === "CAFE") cafeWins += 1;
    if (v === "STREET") streetPicks += 1;
  }
  assert.ok(cafeWins > 60, `CAFE thắng 30/30 phải được chọn nhiều (được ${cafeWins}/200)`);
  assert.ok(streetPicks < 5, `STREET thua 30/30 gần như không bao giờ được chọn lại (được ${streetPicks}/200)`);
  assert.notEqual(thompsonPick("scene", bigStats, seededRandom("e"), ["CAFE"]), "CAFE", "loại trừ giá trị hiện tại khi đột biến");
  const b = sampleBeta(3, 5, seededRandom("b"));
  assert.ok(b > 0 && b < 1);

  // ═══════════ 4. LẬP LÔ ═══════════

  const base: PlanInput = {
    batchDay: "2026-10-01",
    slotCount: 10,
    exploreShare: 0.4,
    products: [
      { productId: "p1", photoSourceId: "ph1", recentTests: 5 },
      { productId: "p2", photoSourceId: "ph2", recentTests: 0 },
    ],
    inspirations: [
      { sourceId: "spy1", kind: "SPY", productId: null, genes: { scene: "STREET", model: "MALE" }, usedCount: 3 },
      { sourceId: "man1", kind: "MANUAL", productId: "p1", genes: { angle: "PRICE_DEAL" }, usedCount: 0 },
    ],
    parents: [
      { variantId: "v-win", productId: "p1", genes: G, verdict: "WIN", bookedOrders: 150, spendVnd: 3_000_000, imageId: "img-win" },
      { variantId: "v-pro", productId: "p2", genes: { ...G, scene: "HOME" }, verdict: "PROMISING", bookedOrders: 6, spendVnd: 200_000, imageId: "img-pro" },
    ],
    stats: [],
    recentSignatures: [],
  };
  const plan = planBatch(base);
  assert.equal(plan.slots.length, 10);
  assert.equal(plan.shortfall, null);
  assert.deepEqual(planBatch(base), plan, "TẤT ĐỊNH: chạy lại cùng ngày ra đúng lô cũ");
  assert.notDeepEqual(planBatch({ ...base, batchDay: "2026-10-02" }).slots.map((s) => s.genes), plan.slots.map((s) => s.genes), "ngày khác ⇒ lô khác");
  assert.equal(plan.slots.filter((s) => s.mode === "EXPLOIT").length, 6, "10 × (1 − 0,4)");
  const sigs = plan.slots.map((s) => geneSignature(s.productId, s.genes));
  assert.equal(new Set(sigs).size, sigs.length, "không có hai ô trùng chữ ký");
  for (const s of plan.slots) {
    assert.ok(s.productPhotoSourceId, "MỌI ô phải có ảnh sản phẩm thật làm gốc");
    if (s.mode === "EXPLOIT") {
      const parent = base.parents.find((p) => p.variantId === s.parentVariantId)!;
      const changed = GENE_KEYS.filter((k) => s.genes[k] !== parent.genes[k]);
      assert.deepEqual(changed, [s.mutatedGene], "ô khai thác đổi ĐÚNG MỘT gen");
      assert.equal(s.productId, parent.productId, "biến thể giữ nguyên mã hàng");
    } else {
      assert.equal(s.parentVariantId, null);
    }
  }
  // Mẫu THẮNG đứng trước mẫu hứa hẹn.
  assert.equal(plan.slots[0].parentVariantId, "v-win");

  // Chưa có mẫu tốt ⇒ toàn bộ là thăm dò (khai thác thứ chưa tồn tại là bịa).
  assert.ok(planBatch({ ...base, parents: [] }).slots.every((s) => s.mode === "EXPLORE"));
  // Không có ảnh sản phẩm thật ⇒ KHÔNG sinh gì, và nói ra vì sao.
  const none = planBatch({ ...base, products: [] });
  assert.equal(none.slots.length, 0);
  assert.equal(none.shortfall?.missing, 10);
  // Mẫu cha của mã không còn ảnh thật thì không được khai thác.
  assert.ok(planBatch({ ...base, products: [base.products[1]] }).slots.every((s) => s.productId === "p2"));

  // Hết biến thể không trùng ⇒ BỎ Ô và nói ra, không nhồi.
  const allSigs: string[] = [];
  const tiny = planBatch({ ...base, inspirations: [], parents: [], products: [base.products[0]], slotCount: 3 });
  for (const s of tiny.slots) allSigs.push(geneSignature(s.productId, s.genes));
  const again = planBatch({ ...base, inspirations: [], parents: [], products: [base.products[0]], slotCount: 3, recentSignatures: allSigs });
  for (const s of again.slots) assert.ok(!allSigs.includes(geneSignature(s.productId, s.genes)), "không lặp lại chữ ký gần đây");

  // ═══════════ 5. LỊCH ═══════════

  const w = batchWindow("2026-10-01", DEFAULT_CREATIVE_CONFIG);
  assert.equal(w.startAt.toISOString(), "2026-09-30T23:00:00.000Z", "6:00 giờ Việt Nam");
  assert.equal(w.endAt.getTime() - w.startAt.getTime(), 24 * 3_600_000);
  assert.equal(w.approvalDeadline.toISOString(), "2026-09-30T22:30:00.000Z", "hạn duyệt 5:30");
  assert.equal(w.buildFrom.toISOString(), "2026-09-30T07:00:00.000Z", "dựng từ 14:00 hôm trước");

  // Mốc dựng từ CHÍNH hàm lịch, không ghim giờ tuyệt đối rồi gieo dữ liệu tương đối (mục 50).
  assert.equal(batchDayToBuild(new Date(w.buildFrom.getTime() - 60_000), DEFAULT_CREATIVE_CONFIG), null, "trước giờ dựng");
  assert.equal(batchDayToBuild(w.buildFrom, DEFAULT_CREATIVE_CONFIG), "2026-10-01");
  // Qua nửa đêm, "ngày mai" đã là 02/10 — KHÔNG BAO GIỜ dựng vội lô cho hôm nay.
  assert.equal(batchDayToBuild(new Date(w.approvalDeadline.getTime() - 60_000), DEFAULT_CREATIVE_CONFIG), null);
  assert.ok(isApprovalOpen(new Date(w.approvalDeadline.getTime() - 1), w));
  assert.ok(!isApprovalOpen(w.approvalDeadline, w), "đúng hạn là hết hạn");
  assert.ok(!isPublishOpen(w.startAt, w), "đăng sau giờ chạy là chạy một khung khác khung đã duyệt");
}

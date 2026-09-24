import assert from "node:assert/strict";
import { and, eq, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import {
  CREATIVE_CONFIG_KEY,
  CREATIVE_HARD_LIMITS,
  DEFAULT_CREATIVE_CONFIG,
  DESIGN_CODE_RE,
  DESIGN_DNA_KEYS,
  DESIGN_DNA_PROMPT_EN,
  DESIGN_DNA_VALUE_LABEL,
  DESIGN_DNA_VOCAB,
  DESIGN_NOVELTY,
  MOCKUP_RULES,
  designCode,
  designParentScore,
  dnaDifference,
  mockupRulesFromHistory,
  normalizeCreativeConfig,
  parseDna,
  parsePartialDna,
  parseVariantRules,
  variantRuleSet,
  type CreativeLoopConfig,
  type DesignDna,
  type Genes,
} from "@/lib/constants/creative-loop";
import { shiftDay, vnDay } from "@/lib/constants/marketing-decision-ledger";
import { approvalDigest } from "@/lib/creative/approval";
import type { VariantCaptioner } from "@/lib/creative/caption";
import { designPromptEn, dnaStats, planDesigns, type DesignParent } from "@/lib/creative/design";
import { readProductDna } from "@/lib/creative/dna";
import { buildBatch } from "@/lib/creative/generate";
import { sha256Hex, storeCreativeImage } from "@/lib/creative/images";
import { judgeVariant } from "@/lib/creative/judge";
import { publishOrder } from "@/lib/creative/manual";
import { composeDailyBatch, type PlanInput, type PlanParent } from "@/lib/creative/plan";
import { batchApprovalContent, pauseCreativeVariant, type CreativeWriter } from "@/lib/creative/publish";
import { batchWindow } from "@/lib/creative/schedule";
import { NEW_DESIGN_CLAUSE, PRESERVE_PRODUCT_CLAUSE, writeVariantCopy, type CopyWriter, type WriterInput } from "@/lib/creative/writer";
import type { AiProvider } from "@/lib/ai/provider";
import { vnStartOfDay } from "@/lib/format";
import type { ImageEditClient } from "@/lib/integrations/openai/images";
import { effectiveJudgeConfig } from "@/lib/queries/creative-loop";
import { pendingProductDna, productAdCostHistory, productSellScores } from "@/lib/queries/creative-design";

/**
 * ═══════════ VÒNG MẪU — THIẾT KẾ SẢN PHẨM MỚI + MOCKUP CÓ LUẬT RIÊNG (chủ shop 24/09/2026) ═══════════
 *
 * Khoá:
 *  (1) Từ vựng DNA ĐÓNG: giá trị lạ bị bỏ (CHƯA BIẾT), đủ nhãn tiếng Việt + câu tiếng Anh; chưa biết
 *      không tính là khác (`dnaDifference`).
 *  (2) `planDesigns` tất định theo ngày lô · MỚI LẠ ≥ 2 thuộc tính so với mọi mã và mọi thiết kế gần đây
 *      (kể cả nhau) · cha trội có ảnh thật · giá = giá cha trội · không đủ thì `shortfall`, không nhồi.
 *  (3) Lô hằng ngày: 10 ô DESIGN + 1 mockup cho MỖI mẫu được chọn, không ô thăm dò mặc định; thứ tự
 *      đăng tự làm → thiết kế → mockup; trần cắt ở cuối.
 *  (4) Luật riêng theo mã: đủ / thiếu lịch sử (p75 · trung vị · sàn 50.000đ · 5 mẩu); chấm dùng luật của
 *      ô; digest đổi khi luật riêng đổi; đường TẮT chấp nhận luật riêng như luật thuộc lô.
 *  (5) Trần 20 mẫu / 4.000.000đ.
 *  (6) Ảnh tham chiếu ô DESIGN chỉ là ảnh CỦA SHOP (ảnh sản phẩm thật của mã cha); câu lệnh dặn "không
 *      sao chép"; giá trên câu chữ là giá đề nghị của thiết kế.
 *  (7) Đọc DNA: lũy đẳng, vào sổ `ai_interactions` route `creative.dna`, không mạng thật.
 *
 * Mốc dựng từ `batchWindow` của NGÀY MAI theo đồng hồ thật (AGENTS.md mục 50).
 */

const P = "cd-";
const G: Genes = { angle: "SOCIAL_PROOF", scene: "STREET", model: "FEMALE_YOUNG", composition: "SINGLE_HERO", textOverlay: "PRICE_BADGE", palette: "WARM" };
const DNA_A: DesignDna = { category: "DRESS", silhouette: "A_LINE", length: "MIDI", neckline: "V_NECK", sleeve: "SHORT", material: "CHIFFON", pattern: "FLORAL", colorFamily: "PINK", detail: "RUFFLE", style: "CASUAL" };
const DNA_B: DesignDna = { category: "BLOUSE", silhouette: "SHIFT", length: "HIP", neckline: "SHIRT_COLLAR", sleeve: "LONG", material: "SILK_SATIN", pattern: "SOLID", colorFamily: "WHITE_CREAM", detail: "BUTTONS", style: "OFFICE" };
const DNA_C: DesignDna = { category: "DRESS", silhouette: "BODYCON", length: "KNEE", neckline: "SQUARE", sleeve: "SLEEVELESS", material: "KNIT", pattern: "SOLID", colorFamily: "BLACK", detail: "NONE", style: "PARTY" };

function fakeJpeg(tag: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, tag & 0xff, (tag >> 8) & 0xff, 3, 3, 3, 3, 5, 5, 5, 5]);
}

const parent = (id: string, dna: Partial<DesignDna>, score: number, photo: boolean, price: number | null): DesignParent => ({ productId: id, label: id, dna, score, photoSourceId: photo ? `photo-${id}` : null, priceVnd: price });

// ───────────────────────────── hàm thuần ─────────────────────────────

export function testCreativeDesignPure() {
  // ═══ (1) TỪ VỰNG DNA ═══
  for (const k of DESIGN_DNA_KEYS) {
    for (const v of DESIGN_DNA_VOCAB[k] as readonly string[]) {
      assert.ok((DESIGN_DNA_VALUE_LABEL[k] as Record<string, string>)[v], `thiếu nhãn tiếng Việt ${k}.${v}`);
      assert.equal(typeof (DESIGN_DNA_PROMPT_EN[k] as Record<string, string>)[v], "string", `thiếu câu tiếng Anh ${k}.${v}`);
    }
  }
  assert.deepEqual(parsePartialDna({ category: "DRESS", silhouette: "HÌNH NÓN", sleeve: 5, colorFamily: "PINK" }), { category: "DRESS", colorFamily: "PINK" }, "giá trị lạ bị BỎ, không ép về giá trị gần nhất");
  assert.equal(parseDna({ ...DNA_A, detail: "LẠ" }), null, "thiết kế phải đủ mười thuộc tính");
  assert.deepEqual(parseDna(DNA_A), DNA_A);

  // Bảng chân lý của phép so khác biệt: CHƯA BIẾT không tính là khác.
  const truth: [Partial<DesignDna>, Partial<DesignDna>, number][] = [
    [DNA_A, DNA_A, 0],
    [DNA_A, { ...DNA_A, colorFamily: "BLUE" }, 1],
    [DNA_A, { ...DNA_A, colorFamily: "BLUE", sleeve: "LONG" }, 2],
    [DNA_A, { category: "DRESS" }, 0],
    [DNA_A, { category: "SKIRT", pattern: "SOLID" }, 2],
    [{ colorFamily: "PINK" }, { pattern: "SOLID" }, 0],
  ];
  for (const [a, b, n] of truth) {
    assert.equal(dnaDifference(a, b), n, `dnaDifference(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
    assert.equal(dnaDifference(b, a), n, "đối xứng");
  }
  assert.equal(designCode("2026-09-25", 3), "TK-260925-03");
  assert.match(designCode("2026-12-01", 12), DESIGN_CODE_RE);

  // Điểm "bán tốt": bảng chân lý.
  assert.equal(designParentScore({ delivered: 2, returned: 0, spendVnd: null, messages: null }), null, "dưới 3 đơn giao, không có chỉ số QC tốt ⇒ không làm cha");
  assert.equal(designParentScore({ delivered: 3, returned: 1, spendVnd: null, messages: null }), 2.25, "3 × 3/4");
  assert.equal(designParentScore({ delivered: 0, returned: 0, spendVnd: 30_000, messages: 10 }), 1, "chỉ số QC tốt (3.000đ/tin) mà chưa có đơn ⇒ trọng số tối thiểu 1");
  assert.equal(designParentScore({ delivered: 0, returned: 0, spendVnd: 80_000, messages: 10 }), null, "8.000đ/tin không phải tốt");
  assert.equal(designParentScore({ delivered: 0, returned: 0, spendVnd: 10_000, messages: 4 }), null, "dưới 5 tin nhắn ⇒ chưa phải chỉ số");

  // ═══ (2) planDesigns ═══
  const existing = [DNA_A, DNA_B, DNA_C];
  const base = {
    batchDay: "2026-10-01",
    count: 10,
    parents: [parent("A", DNA_A, 9, true, 399_000), parent("B", DNA_B, 3, true, null), parent("C", DNA_C, 5, false, 250_000)],
    existingDna: existing,
    recentDesigns: [] as DesignDna[],
    stats: [],
  };
  const plan = planDesigns(base);
  assert.equal(plan.designs.length, 10, "đủ vật liệu ⇒ đủ 10 thiết kế");
  assert.equal(plan.shortfall, null);
  assert.deepEqual(planDesigns(base), plan, "TẤT ĐỊNH: cùng ngày lô ⇒ cùng thiết kế");
  assert.notDeepEqual(
    planDesigns({ ...base, batchDay: "2026-10-02" }).designs.map((d) => d.dna),
    plan.designs.map((d) => d.dna),
    "ngày khác ⇒ thiết kế khác",
  );
  const codes = new Set(plan.designs.map((d) => d.code));
  assert.equal(codes.size, 10, "mã TK không trùng trong lô");
  plan.designs.forEach((d, i) => {
    assert.equal(d.code, designCode("2026-10-01", i + 1));
    assert.ok(parseDna(d.dna), "thiết kế đủ mười thuộc tính");
    // MỚI LẠ: khác MỌI mã đang có và MỌI thiết kế khác trong lô ở ≥ 2 thuộc tính.
    for (const e of existing) assert.ok(dnaDifference(d.dna, e) >= DESIGN_NOVELTY.minDiffAttributes, `${d.code} quá giống một mã đang có`);
    for (const o of plan.designs) if (o !== d) assert.ok(dnaDifference(d.dna, o.dna) >= DESIGN_NOVELTY.minDiffAttributes, `${d.code} quá giống ${o.code}`);
    assert.ok(d.minDiff >= DESIGN_NOVELTY.minDiffAttributes);
    // Cha trội luôn có ảnh sản phẩm thật (ảnh tham chiếu) và giá đề nghị là giá của nó.
    const dom = base.parents.find((p) => p.productId === d.parentProductIds[0]) as DesignParent;
    assert.ok(dom.photoSourceId, "mã C không có ảnh ⇒ không bao giờ là cha trội");
    assert.equal(d.photoSourceId, dom.photoSourceId);
    assert.equal(d.priceVnd, dom.priceVnd, "giá đề nghị = giá của cha trội (null giữ null, không đoán)");
    assert.equal(d.dna.category, dom.dna.category, "nhóm hàng theo cha trội");
    if (["PANTS", "SHORTS", "SKIRT"].includes(d.dna.category)) assert.deepEqual([d.dna.neckline, d.dna.sleeve], ["NONE", "NONE"]);
  });
  // Thiết kế gần đây cũng là "cũ": lập lại cùng ngày với các thiết kế vừa lập làm "gần đây" ⇒ ra thiết kế KHÁC.
  const again = planDesigns({ ...base, recentDesigns: plan.designs.map((d) => d.dna) });
  for (const d of again.designs) for (const o of plan.designs) assert.ok(dnaDifference(d.dna, o.dna) >= DESIGN_NOVELTY.minDiffAttributes, "khác thiết kế 30 ngày gần nhất");
  // Không đủ thì nói ra.
  const none = planDesigns({ ...base, parents: [] });
  assert.equal(none.designs.length, 0);
  assert.equal(none.shortfall?.missing, 10);
  assert.match(none.shortfall?.reasons.join(" ") ?? "", /DNA/);
  const noPhoto = planDesigns({ ...base, parents: [parent("C", DNA_C, 5, false, 1)] });
  assert.equal(noPhoto.designs.length, 0);
  assert.match(noPhoto.shortfall?.reasons.join(" ") ?? "", /ẢNH SẢN PHẨM THẬT/);
  assert.equal(planDesigns({ ...base, count: 0 }).shortfall, null);

  // Học: giá trị DNA của thiết kế đã THẮNG được đếm; phán quyết chưa ngã ngũ không dạy gì.
  const st = dnaStats([
    { dna: DNA_A, dnaVersion: 1, verdict: "WIN" },
    { dna: DNA_B, dnaVersion: 1, verdict: "LOSE" },
    { dna: DNA_C, dnaVersion: 1, verdict: "RUNNING" },
    { dna: DNA_C, dnaVersion: 99, verdict: "WIN" },
  ]);
  const cnt = (k: string, v: string) => st.find((x) => x.key === k && x.value === v);
  assert.deepEqual([cnt("colorFamily", "PINK")?.tests, cnt("colorFamily", "PINK")?.successes], [1, 1]);
  assert.deepEqual([cnt("colorFamily", "WHITE_CREAM")?.tests, cnt("colorFamily", "WHITE_CREAM")?.successes], [1, 0]);
  assert.equal(cnt("colorFamily", "BLACK")?.tests, 0, "đang chạy / khác phiên bản từ vựng ⇒ không phải quan sát");

  // Câu lệnh tất định theo DNA.
  const en = designPromptEn(DNA_A);
  assert.ok(en.includes("a dress") && en.includes("chiffon") && en.includes("V-neckline") && en.startsWith("NEW GARMENT DESIGN"));

  // ═══ (4) LUẬT RIÊNG THEO MÃ ═══
  assert.deepEqual(MOCKUP_RULES, { lookbackDays: 60, killQuantile: 0.75, keepQuantile: 0.5, killMinSpendVnd: 50_000, minSamples: 5 }, "tham số chủ shop 24/09");
  const thieu = mockupRulesFromHistory("A", [1000, 2000, 3000, 4000, 0, Number.NaN]);
  assert.equal(thieu.basis, "GLOBAL", "4 mẩu có tin nhắn < 5 ⇒ luật chung (0 / NaN không phải mẩu có tin nhắn)");
  const du = mockupRulesFromHistory("A", [5000, 1000, 3000, 2000, 4000]);
  assert.equal(du.basis, "PRODUCT_HISTORY");
  if (du.basis !== "PRODUCT_HISTORY") throw new Error("unreachable");
  assert.equal(du.p75CostPerMessageVnd, 4000);
  assert.equal(du.medianCostPerMessageVnd, 3000);
  assert.deepEqual(
    du.killRules.map((r) => [r.metric, r.op, r.value, r.minSpendVnd]),
    [["costPerMessage", "gt", 4000, 50_000]],
  );
  assert.deepEqual(
    du.keepRules.map((r) => [r.metric, r.op, r.value, r.minSpendVnd]),
    [["costPerMessage", "lte", 3000, 0]],
  );
  assert.deepEqual(parseVariantRules(JSON.parse(JSON.stringify(du))), du, "chụp vào jsonb rồi đọc lại ra đúng bộ luật");
  assert.equal(parseVariantRules({ basis: "PRODUCT_HISTORY", killRules: [] }), null, "luật riêng hỏng ⇒ null (về luật chung), không phải 'không luật'");
  const batchRules = { killRules: [{ metric: "messages" as const, op: "lt" as const, value: 1, minSpendVnd: 150_000 }], keepRules: [] };
  assert.deepEqual(variantRuleSet(du, batchRules), { killRules: du.killRules, keepRules: du.keepRules, own: true });
  assert.deepEqual(variantRuleSet(thieu, batchRules), { ...batchRules, own: false });
  assert.deepEqual(variantRuleSet(null, batchRules), { ...batchRules, own: false });
  // Bộ luật dùng để chấm: luật của ô thay luật chung.
  const current = normalizeCreativeConfig({ keepRules: [{ metric: "orders", op: "gte", value: 5, minSpendVnd: 0 }] }).config;
  const jc = effectiveJudgeConfig(batchRules, current, du);
  assert.deepEqual([jc.killRules, jc.keepRules], [du.killRules, du.keepRules]);
  const jcGlobal = effectiveJudgeConfig(batchRules, current, null);
  assert.deepEqual([jcGlobal.killRules, jcGlobal.keepRules], [batchRules.killRules, current.keepRules]);
  const start = new Date("2026-10-01T06:00:00+07:00");
  const end = new Date(start.getTime() + 86_400_000);
  const m = (spendVnd: number, messages: number) => ({ spendVnd, impressions: 1000, clicks: 10, messages, bookedOrders: 0, deliveredOrders: 0, returnedOrders: 0 });
  const live = (metrics: ReturnType<typeof m>, now: Date) => judgeVariant({ status: "LIVE", startAt: start, endAt: end, libraryAt: null, metrics }, jc, now);
  assert.equal(live(m(60_000, 12), new Date(start.getTime() + 3_600_000)).verdict, "KILL", "5.000đ/tin > p75 4.000đ, đã chi ≥ 50.000đ ⇒ tắt");
  assert.equal(live(m(45_000, 9), new Date(start.getTime() + 3_600_000)).verdict, "RUNNING", "chưa đủ sàn chi 50.000đ ⇒ chưa xét luật tắt");
  const settled = new Date(end.getTime() + 25 * 3_600_000);
  assert.equal(judgeVariant({ status: "ENDED", startAt: start, endAt: end, libraryAt: null, metrics: m(90_000, 30) }, jc, settled).verdict, "PROMISING", "3.000đ/tin ≤ trung vị ⇒ giữ");
  assert.equal(judgeVariant({ status: "ENDED", startAt: start, endAt: end, libraryAt: null, metrics: m(105_000, 30) }, jc, settled).verdict, "LOSE", "3.500đ/tin > trung vị, chưa tệ hơn p75 ⇒ loại, không tắt");

  // Digest: luật riêng đổi ⇒ phiếu đổi; ô không có luật riêng ⇒ digest y như trước khi có cột này.
  const content = {
    batchDay: "2026-10-01",
    startAt: start,
    endAt: end,
    budgetPerVariantVnd: 200_000,
    killRules: batchRules.killRules,
    variants: [
      { id: "v1", imageSha256: "a", primaryText: "x", headline: "y" },
      { id: "v2", imageSha256: "b", primaryText: "x", headline: "y" },
    ],
  };
  const d0 = approvalDigest(content);
  assert.equal(approvalDigest({ ...content, variants: content.variants.map((v) => ({ ...v, rules: null })) }), d0, "ô không có luật riêng: digest không đổi so với phiếu cũ");
  const withRules = { ...content, variants: [{ ...content.variants[0], rules: du as unknown as Record<string, unknown> }, content.variants[1]] };
  const d1 = approvalDigest(withRules);
  assert.notEqual(d1, d0, "thêm luật riêng ⇒ digest đổi");
  const du2 = mockupRulesFromHistory("A", [5000, 1000, 3000, 2000, 9000]);
  assert.notEqual(approvalDigest({ ...content, variants: [{ ...content.variants[0], rules: du2 as unknown as Record<string, unknown> }, content.variants[1]] }), d1, "luật riêng đổi ngưỡng ⇒ digest đổi");

  // ═══ (5) TRẦN MỚI ═══
  assert.equal(CREATIVE_HARD_LIMITS.maxBatchSize, 20, "chủ shop 24/09: 20 mẫu / ngày");
  assert.equal(CREATIVE_HARD_LIMITS.maxDailyTestSpendVnd, 4_000_000, "chủ shop 24/09: 4.000.000đ / ngày");
  assert.equal(CREATIVE_HARD_LIMITS.maxDailyTestSpendVnd, CREATIVE_HARD_LIMITS.maxBatchSize * CREATIVE_HARD_LIMITS.maxBudgetPerVariantVnd);
  assert.equal(normalizeCreativeConfig({ batchSize: 50 }).config.batchSize, 20);
  assert.equal(normalizeCreativeConfig({ designSlots: 99, exploreSlots: -3 }).config.designSlots, 20);
  assert.equal(normalizeCreativeConfig({ exploreSlots: -3 }).config.exploreSlots, 0);
  assert.deepEqual([DEFAULT_CREATIVE_CONFIG.designSlots, DEFAULT_CREATIVE_CONFIG.exploreSlots, DEFAULT_CREATIVE_CONFIG.extraCandidates], [10, 0, 0], "lô mặc định: 10 thiết kế, không thăm dò, không sinh dư");
  assert.deepEqual(normalizeCreativeConfig({ mockupSourceIds: ["s1", "s1", "", 7, " s2 "] }).config.mockupSourceIds, ["s1", "s2"], "danh sách mockup: bỏ trùng / rỗng / lạ");

  // ═══ (3) LÔ HẰNG NGÀY ═══
  const gp = (id: string, productId: string, verdict: "WIN" | "PROMISING", orders: number, ownAd: string | null = null): PlanParent => ({ variantId: ownAd ? null : id, ownAdSourceId: ownAd, productId, genes: G, verdict, bookedOrders: orders, spendVnd: 1_000_000, imageId: null });
  const planInput: PlanInput = {
    batchDay: "2026-10-01",
    slotCount: 20,
    products: [
      { productId: "A", photoSourceId: "photo-A", recentTests: 0 },
      { productId: "B", photoSourceId: "photo-B", recentTests: 0 },
    ],
    inspirations: [],
    parents: [gp("vA", "A", "WIN", 150), gp("sB", "B", "PROMISING", 20, "src-B"), gp("vB2", "B", "WIN", 120), gp("sX", "A", "PROMISING", 3, "src-X")],
    stats: [],
    recentSignatures: [],
  };
  const composeIn = {
    batchDay: "2026-10-01",
    budget: 20,
    designSlots: 10,
    exploreSlots: 0,
    plan: planInput,
    mockup: { sourceIds: ["src-B", "src-khong-co"], productIds: ["A"] },
    design: { parents: base.parents, existingDna: existing, recentDesigns: [], stats: [] },
    mockupHistory: new Map([["A", [1000, 2000, 3000, 4000, 5000]]]),
  };
  const lo = composeDailyBatch(composeIn);
  const modes = lo.slots.map((s) => s.mode);
  assert.deepEqual(modes, [...Array(10).fill("DESIGN"), "EXPLOIT", "EXPLOIT"], "10 thiết kế + 1 mockup / mẫu được chọn, không ô thăm dò");
  assert.deepEqual(
    lo.slots.map((s) => s.slot),
    Array.from({ length: 12 }, (_, i) => i + 1),
  );
  const mock = lo.slots.filter((s) => s.mode === "EXPLOIT");
  assert.deepEqual(mock.map((s) => s.productId).sort(), ["A", "B"]);
  assert.ok(mock.find((s) => s.productId === "B")?.inspirationSourceId === "src-B", "nguồn OWN_AD được chọn ⇒ đúng mẫu cha ấy");
  assert.equal(mock.find((s) => s.productId === "A")?.parentVariantId, "vA", "mã được chọn ⇒ mẫu cha TỐT NHẤT của mã (thắng, nhiều đơn)");
  assert.ok(!lo.slots.some((s) => s.inspirationSourceId === "src-X"), "mẫu không được chọn không có mockup");
  assert.equal(mock.find((s) => s.productId === "A")?.rulesSnapshot?.basis, "PRODUCT_HISTORY");
  assert.equal(mock.find((s) => s.productId === "B")?.rulesSnapshot?.basis, "GLOBAL", "mã chưa đủ lịch sử ⇒ luật chung, vẫn chụp lý do");
  assert.match(lo.shortfall?.reasons.join(" ") ?? "", /src-khong-co/, "chọn mà không lập được ⇒ nói ra");
  for (const s of lo.slots.filter((x) => x.mode === "DESIGN")) {
    assert.equal(s.productId, null, "ô thiết kế không gắn mã hàng — mẫu chưa tồn tại");
    assert.ok(s.design && s.productPhotoSourceId === s.design.photoSourceId, "ảnh gốc của ô thiết kế = ảnh sản phẩm thật của cha trội");
    assert.notEqual(s.genes.model, "NONE", "thiết kế mới luôn có người mẫu mặc");
    assert.notEqual(s.genes.scene, "FLATLAY");
  }
  assert.deepEqual(composeDailyBatch(composeIn), lo, "lô hằng ngày TẤT ĐỊNH");
  // Trần cắt ở CUỐI: còn 11 chỗ (ví dụ 9 mẫu tự làm) ⇒ 10 thiết kế + 1 mockup.
  const cut = composeDailyBatch({ ...composeIn, budget: 11 });
  assert.deepEqual(cut.slots.map((s) => s.mode), [...Array(10).fill("DESIGN"), "EXPLOIT"]);
  assert.match(cut.shortfall?.reasons.join(" ") ?? "", /mockup bị cắt/);
  const explore = composeDailyBatch({ ...composeIn, exploreSlots: 2 });
  assert.deepEqual(explore.slots.slice(-2).map((s) => s.mode), ["EXPLORE", "EXPLORE"], "thăm dò bật lại được bằng cấu hình, đứng cuối");

  // Thứ tự ĐĂNG: tự làm → thiết kế → mockup → thăm dò.
  const order = publishOrder([
    { mode: "EXPLORE", slot: 1 },
    { mode: "EXPLOIT", slot: 2 },
    { mode: "DESIGN", slot: 5 },
    { mode: "MANUAL", slot: 1001 },
    { mode: "DESIGN", slot: 3 },
  ]);
  assert.deepEqual(
    order.map((x) => `${x.mode}#${x.slot}`),
    ["MANUAL#1001", "DESIGN#3", "DESIGN#5", "EXPLOIT#2", "EXPLORE#1"],
  );
  console.log("✓ Vòng mẫu · thiết kế mới: từ vựng DNA đóng · mới lạ ≥ 2 thuộc tính · tất định · 10 thiết kế + mockup mẫu được chọn · luật riêng theo mã (p75/trung vị/5 mẩu) · digest khoá luật riêng · trần 20 / 4.000.000đ");
}

// ───────────────────────────── CSDL ─────────────────────────────

async function cleanup(db: Db) {
  const v = schema.creativeVariants;
  const b = schema.creativeBatches;
  const batches = await db.select({ id: b.id }).from(b).where(like(b.error, `${P}%`));
  const byPlan = await db.select({ id: b.id, plan: b.plan }).from(b);
  const ids = [...new Set([...batches.map((x) => x.id), ...byPlan.filter((x) => JSON.stringify(x.plan).includes(`${P}prod`)).map((x) => x.id)])];
  if (ids.length) {
    const vs = await db.select({ id: v.id, imageId: v.imageId }).from(v).where(inArray(v.batchId, ids));
    const vids = vs.map((x) => x.id);
    if (vids.length) {
      await db.delete(schema.creativeFbActions).where(inArray(schema.creativeFbActions.variantId, vids));
      await db.delete(schema.creativeVerdicts).where(inArray(schema.creativeVerdicts.variantId, vids));
      await db.delete(v).where(inArray(v.id, vids));
    }
    await db.delete(schema.creativeFbActions).where(inArray(schema.creativeFbActions.batchId, ids));
    await db.delete(schema.designConcepts).where(inArray(schema.designConcepts.batchId, ids));
    await db.delete(b).where(inArray(b.id, ids));
    const imgs = vs.map((x) => x.imageId).filter((x): x is string => Boolean(x));
    if (imgs.length) await db.delete(schema.creativeImages).where(inArray(schema.creativeImages.id, imgs));
  }
  const srcs = await db.select({ id: schema.creativeSources.id, imageId: schema.creativeSources.imageId }).from(schema.creativeSources).where(like(schema.creativeSources.title, `${P}%`));
  if (srcs.length) {
    await db.delete(schema.creativeSources).where(
      inArray(
        schema.creativeSources.id,
        srcs.map((x) => x.id),
      ),
    );
    const imgs = srcs.map((x) => x.imageId).filter((x): x is string => Boolean(x));
    if (imgs.length) await db.delete(schema.creativeImages).where(inArray(schema.creativeImages.id, imgs));
  }
  await db.delete(schema.productDna).where(like(schema.productDna.productId, `${P}%`));
  await db.delete(schema.aiInteractions).where(and(eq(schema.aiInteractions.route, "creative.dna"), like(schema.aiInteractions.entityId, `${P}%`)));
  await db.delete(schema.orderItems).where(like(schema.orderItems.id, `${P}%`));
  await db.delete(schema.shipments).where(like(schema.shipments.vtpOrderNumber, "CD-%"));
  await db.delete(schema.orders).where(like(schema.orders.id, `${P}%`));
  await db.delete(schema.adSpends).where(like(schema.adSpends.campaign, `${P}%`));
  await db.delete(schema.productVariants).where(like(schema.productVariants.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
}

async function setConfig(db: Db, cfg: CreativeLoopConfig) {
  const text = JSON.stringify(cfg);
  await db.insert(schema.settings).values({ key: CREATIVE_CONFIG_KEY, value: text }).onConflictDoUpdate({ target: schema.settings.key, set: { value: text } });
}

export async function testCreativeDesignDb(db: Db) {
  const realNow = new Date();
  const batchDay = shiftDay(vnDay(realNow), 1);
  const [prevCfg] = await db.select().from(schema.settings).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
  await cleanup(db);
  try {
    const cfg: CreativeLoopConfig = { ...DEFAULT_CREATIVE_CONFIG, enabled: true, imageMode: "SYNC", pageId: "p", adAccountId: "1", testCampaignId: "c", templateAdId: "t", focusProductIds: [`${P}prod-A`, `${P}prod-B`] };
    const w = batchWindow(batchDay, cfg);
    const now = new Date(w.buildFrom.getTime() + 60_000);
    const asOf = new Date(`${batchDay}T00:00:00+07:00`);

    // ─── Sản phẩm, giá, ảnh thật, DNA ───
    await db.insert(schema.products).values([
      { id: `${P}prod-A`, name: "Đầm hoa cd", customId: "CDA" },
      { id: `${P}prod-B`, name: "Áo sơ mi cd", customId: "CDB" },
      { id: `${P}prod-C`, name: "Đầm ôm cd", customId: "CDC" },
      { id: `${P}prod-R`, name: "Mã đã gỡ cd", customId: "CDR", isRemoved: true, image: "https://img.test/cd-r.jpg" },
    ]);
    await db.insert(schema.productVariants).values([
      { id: `${P}var-A`, productId: `${P}prod-A`, retailPrice: 450_000, retailPriceAfterDiscount: 399_000 },
      { id: `${P}var-B1`, productId: `${P}prod-B`, retailPrice: 299_000, retailPriceAfterDiscount: 0 },
      { id: `${P}var-B2`, productId: `${P}prod-B`, retailPrice: 349_000, retailPriceAfterDiscount: 0 },
      { id: `${P}var-C`, productId: `${P}prod-C`, retailPrice: 250_000, retailPriceAfterDiscount: 0 },
    ]);
    const photoA = await storeCreativeImage(db, fakeJpeg(1));
    const photoB = await storeCreativeImage(db, fakeJpeg(2));
    const adImgA = await storeCreativeImage(db, fakeJpeg(3));
    const adImgB = await storeCreativeImage(db, fakeJpeg(4));
    const adImgX = await storeCreativeImage(db, fakeJpeg(5));
    const src = async (x: typeof schema.creativeSources.$inferInsert) => (await db.insert(schema.creativeSources).values(x).returning({ id: schema.creativeSources.id }))[0].id;
    const photoSrcA = await src({ kind: "PRODUCT_PHOTO", productId: `${P}prod-A`, title: `${P}photo-A`, imageId: photoA.id });
    const photoSrcB = await src({ kind: "PRODUCT_PHOTO", productId: `${P}prod-B`, title: `${P}photo-B`, imageId: photoB.id });
    const ownA = await src({ kind: "OWN_AD", productId: `${P}prod-A`, title: `${P}own-A`, imageId: adImgA.id, genes: G, fbAdId: `${P}ad-own-A`, metrics: { reason: "WIN", bookedOrders: 150, spendVnd: 900_000 } });
    const ownB = await src({ kind: "OWN_AD", productId: `${P}prod-B`, title: `${P}own-B`, imageId: adImgB.id, genes: { ...G, palette: "COOL" }, fbAdId: `${P}ad-own-B`, metrics: { reason: "GOOD", bookedOrders: 10, spendVnd: 300_000 } });
    const ownX = await src({ kind: "OWN_AD", productId: `${P}prod-A`, title: `${P}own-X`, imageId: adImgX.id, genes: { ...G, scene: "CAFE" }, fbAdId: `${P}ad-own-X`, metrics: { reason: "GOOD", bookedOrders: 2, spendVnd: 100_000 } });
    await db.insert(schema.productDna).values([
      { productId: `${P}prod-A`, dna: DNA_A, dnaVersion: 1 },
      { productId: `${P}prod-B`, dna: DNA_B, dnaVersion: 1 },
      { productId: `${P}prod-C`, dna: DNA_C, dnaVersion: 1 },
    ]);

    // ─── Đơn 90 ngày: A 4 giao + 1 hoàn · B 3 giao · C 3 giao (C không có ảnh ⇒ chỉ làm mẹ) ───
    let n = 0;
    const order = async (productId: string, outcome: "DELIVERED" | "RETURNED", daysAgo: number, isBonus = false) => {
      n += 1;
      const id = `${P}o-${n}`;
      await db.insert(schema.orders).values({ id, stage: "SHIPPED" as never, cod: 400_000, totalPriceAfterDiscount: 400_000, prepaid: 0, insertedAt: new Date(asOf.getTime() - daysAgo * 86_400_000) });
      await db.insert(schema.orderItems).values({ id: `${P}oi-${n}`, orderId: id, productId, quantity: 1, isBonus });
      await db.insert(schema.shipments).values({ orderId: id, vtpOrderNumber: `CD-${n}`, trackingCode: `CD-${n}`, stage: outcome as never, codAmount: 400_000, codCollected: outcome === "DELIVERED" ? 400_000 : 0 });
    };
    for (let i = 0; i < 4; i += 1) await order(`${P}prod-A`, "DELIVERED", 5 + i);
    await order(`${P}prod-A`, "RETURNED", 6);
    for (let i = 0; i < 3; i += 1) await order(`${P}prod-B`, "DELIVERED", 10 + i);
    for (let i = 0; i < 3; i += 1) await order(`${P}prod-C`, "DELIVERED", 20 + i);
    await order(`${P}prod-C`, "DELIVERED", 120); // ngoài cửa sổ 90 ngày
    await order(`${P}prod-B`, "DELIVERED", 3, true); // dòng quà tặng không phải đơn của mã

    // ─── Lịch sử QC hạt AD: A 6 mẩu có tin (1 mẩu 0 tin, 1 mẩu ngoài 60 ngày) · B 2 mẩu ───
    const spend = (adId: string, productId: string | null, daysAgo: number, amount: number, messages: number) => ({
      platform: "FACEBOOK",
      campaign: `${P}camp`,
      grain: "AD",
      adId: `${P}${adId}`,
      productId,
      spend: amount,
      messages,
      spendDate: vnStartOfDay(vnDay(new Date(asOf.getTime() - daysAgo * 86_400_000))),
      createdBy: "test",
    });
    await db.insert(schema.adSpends).values([
      spend("h1", `${P}prod-A`, 3, 10_000, 10),
      spend("h2", `${P}prod-A`, 4, 20_000, 10),
      spend("h3", `${P}prod-A`, 5, 30_000, 10),
      spend("h4", `${P}prod-A`, 6, 40_000, 10),
      spend("h5", `${P}prod-A`, 7, 50_000, 10),
      spend("h0", `${P}prod-A`, 7, 50_000, 0),
      spend("hOld", `${P}prod-A`, 70, 900_000, 1),
      spend("ad-own-A", null, 8, 60_000, 10), // không có mã trên dòng chi ⇒ nối qua nguồn OWN_AD
      spend("hb1", `${P}prod-B`, 3, 10_000, 5),
      spend("hb2", `${P}prod-B`, 3, 20_000, 5),
    ]);

    // ═══ ĐỌC ═══
    const scores = await productSellScores(db, asOf);
    assert.deepEqual([scores.get(`${P}prod-A`)?.delivered, scores.get(`${P}prod-A`)?.returned], [4, 1], "đơn giao / hoàn theo ORDER_OUTCOME, 90 ngày");
    assert.equal(scores.get(`${P}prod-C`)?.delivered, 3, "đơn ngoài 90 ngày không tính");
    assert.equal(scores.get(`${P}prod-B`)?.delivered, 3, "dòng quà tặng không phải đơn của mã");
    const hist = await productAdCostHistory(db, [`${P}prod-A`, `${P}prod-B`], asOf);
    assert.deepEqual(hist.get(`${P}prod-A`), [1000, 2000, 3000, 4000, 5000, 6000], "6 mẩu có tin nhắn trong 60 ngày (mẩu 0 tin và mẩu cũ bị bỏ; mẩu không mã nối qua OWN_AD)");
    assert.deepEqual(hist.get(`${P}prod-B`), [2000, 4000]);

    // ═══ ĐỌC DNA — lũy đẳng, sổ AI, không mạng thật ═══
    const pending = await pendingProductDna(db, now, 50);
    const mine = pending.filter((t) => t.productId.startsWith(P));
    assert.deepEqual(
      mine.map((t) => [t.productId, t.source]),
      [[`${P}prod-R`, "PANCAKE_URL"]],
      "mã đã có DNA không đọc lại; mã đã gỡ có ảnh Pancake vẫn được đọc",
    );
    const calls: string[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://img.test/cd-r.jpg") return new Response(new Uint8Array(fakeJpeg(9)).buffer, { status: 200, headers: { "content-type": "image/jpeg" } });
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: { content?: { type: string }[] }[] };
      assert.ok(body.input?.[0]?.content?.some((c) => c.type === "input_image"), "gửi ảnh cho mô hình ĐỌC");
      const answer = { dna: { ...DNA_C, colorFamily: "TÍM THAN", category: "SKIRT" }, summary: "Chân váy ôm" };
      return new Response(JSON.stringify({ model: "gpt-test", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] }], usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200 });
    }) as typeof fetch;
    const r = await readProductDna(db, mine[0], { apiKey: "test-key", fetchImpl: fakeFetch, download: { fetchImpl: fakeFetch }, now });
    assert.ok(r.ok);
    const [dnaR] = await db.select().from(schema.productDna).where(eq(schema.productDna.productId, `${P}prod-R`));
    assert.equal(dnaR.dna.category, "SKIRT");
    assert.equal(dnaR.dna.colorFamily, undefined, "giá trị lạ của mô hình bị bỏ (CHƯA BIẾT), không ép");
    assert.equal(dnaR.error, "");
    assert.equal(dnaR.imageSource, "PANCAKE_URL");
    const logs = await db.select().from(schema.aiInteractions).where(and(eq(schema.aiInteractions.route, "creative.dna"), eq(schema.aiInteractions.entityId, `${P}prod-R`)));
    assert.equal(logs.length, 1, "mỗi lượt đọc vào sổ ai_interactions (route creative.dna)");
    assert.equal((await pendingProductDna(db, now, 50)).filter((t) => t.productId.startsWith(P)).length, 0, "đã đọc ⇒ lượt sau không đọc lại");
    const noKey = await readProductDna(db, mine[0], { apiKey: "", fetchImpl: fakeFetch, now });
    assert.ok(!noKey.ok && noKey.skipped, "không có khoá API ⇒ bỏ qua, không ghi lỗi");
    await db.delete(schema.productDna).where(eq(schema.productDna.productId, `${P}prod-R`));

    // ═══ DỰNG LÔ ═══
    await setConfig(db, { ...cfg, mockupSourceIds: [ownB], mockupProductIds: [`${P}prod-A`] });
    const imageCalls: { kinds: string[]; shas: string[] }[] = [];
    let tag = 100;
    const fakeClient: ImageEditClient = async (input) => {
      imageCalls.push({ kinds: input.images.map((i) => i.kind), shas: input.images.map((i) => sha256Hex(i.bytes)) });
      tag += 1;
      return { bytes: fakeJpeg(tag), contentType: "image/jpeg", usage: null, costUsd: 0.01 };
    };
    const writerCalls: WriterInput[] = [];
    const fakeWriter: CopyWriter = async (input) => {
      writerCalls.push(input);
      return { imagePrompt: "prompt", primaryText: "Câu chữ", headline: "Tiêu đề", model: "fake", costUsd: null, attempts: 1, priceStripped: false };
    };
    const captionNotes: (string | undefined)[] = [];
    const fakeCaption: VariantCaptioner = async (_db, input) => {
      captionNotes.push(input.productNote);
      return { ok: true, headline: "T", primaryText: "C", options: [{ headline: "T", primaryText: "C" }], seen: "", model: "fake", costUsd: null, attempts: 1, priceStripped: false };
    };
    let dnaReads = 0;
    const built = await buildBatch(db, now, {
      imageClient: fakeClient,
      writer: fakeWriter,
      caption: fakeCaption,
      describe: async () => ({ ok: false as const, error: "giả" }),
      dna: async () => {
        dnaReads += 1;
        return { ok: false, error: "giả", skipped: true };
      },
      perTick: 30,
    });
    assert.equal(built.created, true, built.skippedReason ?? "");
    const [batch] = await db.select().from(schema.creativeBatches).where(eq(schema.creativeBatches.batchDay, batchDay));
    const vs = await db.select().from(schema.creativeVariants).where(eq(schema.creativeVariants.batchId, batch.id));
    const designs = vs.filter((x) => x.mode === "DESIGN");
    const mocks = vs.filter((x) => x.mode === "EXPLOIT");
    assert.equal(designs.length, 10, "10 ô thiết kế mới");
    assert.equal(mocks.length, 2, "1 mockup cho MỖI mẫu được chọn (nguồn B + mã A)");
    assert.equal(vs.filter((x) => x.mode === "EXPLORE").length, 0, "không ô thăm dò mặc định");
    assert.ok(!mocks.some((x) => x.inspirationSourceId === ownX), "quảng cáo cũ không được chọn không có mockup");
    assert.equal(mocks.find((x) => x.productId === `${P}prod-A`)?.inspirationSourceId, ownA, "mã A ⇒ mẫu cha tốt nhất của mã (quảng cáo THẮNG)");
    const rulesA = parseVariantRules(mocks.find((x) => x.productId === `${P}prod-A`)?.rulesSnapshot);
    assert.equal(rulesA?.basis, "PRODUCT_HISTORY");
    if (rulesA?.basis === "PRODUCT_HISTORY") assert.deepEqual([rulesA.samples, rulesA.p75CostPerMessageVnd, rulesA.medianCostPerMessageVnd], [6, 4750, 3500]);
    assert.equal(parseVariantRules(mocks.find((x) => x.productId === `${P}prod-B`)?.rulesSnapshot)?.basis, "GLOBAL");

    const concepts = await db.select().from(schema.designConcepts).where(eq(schema.designConcepts.batchId, batch.id));
    assert.equal(concepts.length, 10);
    for (const c of concepts) {
      assert.match(c.code, DESIGN_CODE_RE);
      assert.ok(c.code.startsWith(`TK-${batchDay.slice(2, 4)}${batchDay.slice(5, 7)}${batchDay.slice(8, 10)}-`), "mã TK mang ngày chạy của lô");
      assert.equal(c.status, "DRAFT");
      assert.ok(parseDna(c.dna));
      for (const e of [DNA_A, DNA_B, DNA_C]) assert.ok(dnaDifference(parseDna(c.dna) as DesignDna, e) >= 2, `${c.code} khác mọi mã đang có ≥ 2 thuộc tính`);
      assert.ok(c.parentProductIds[0] === `${P}prod-A` || c.parentProductIds[0] === `${P}prod-B`, "cha trội có ảnh sản phẩm thật (C không có ảnh)");
      assert.equal(c.priceVnd, c.parentProductIds[0] === `${P}prod-A` ? 399_000 : null, "giá đề nghị = giá cha trội; B nhiều giá ⇒ null, không đoán");
    }
    for (const d of designs) {
      assert.equal(d.productId, null);
      const c = concepts.find((x) => x.id === d.designConceptId);
      assert.ok(c, "ô thiết kế nối về design_concepts");
      assert.equal(d.productPhotoSourceId, c.parentProductIds[0] === `${P}prod-A` ? photoSrcA : photoSrcB);
    }

    // Người viết: ô thiết kế nhận DNA + giá đề nghị; câu chữ theo ảnh được dặn "mẫu mới".
    const dWriter = writerCalls.filter((x) => x.mode === "DESIGN");
    assert.ok(dWriter.length >= 1, "người viết được gọi cho ô thiết kế");
    for (const wi of dWriter) {
      const c = concepts.find((x) => x.code === wi.design?.code);
      assert.ok(c && wi.design);
      assert.equal(wi.product.priceVnd, c.priceVnd, "giá trên câu chữ = price_vnd của thiết kế");
      assert.equal(wi.product.code, c.code);
    }
    assert.ok(captionNotes.some((x) => (x ?? "").includes("MẪU MỚI")), "câu chữ theo ảnh được báo đây là mẫu mới");

    // ẢNH THAM CHIẾU ô DESIGN: chỉ MỘT ảnh, là ảnh sản phẩm thật của cha trội — không ảnh quảng cáo, không ảnh nào khác.
    const designShas = new Set([photoA.sha256, photoB.sha256]);
    const designCalls = imageCalls.filter((c) => c.kinds.length === 1);
    assert.ok(designCalls.length >= 1, "có ít nhất một ảnh thiết kế được vẽ");
    for (const c of designCalls) {
      assert.deepEqual(c.kinds, ["PRODUCT_PHOTO"]);
      assert.ok(designShas.has(c.shas[0]));
    }
    for (const c of imageCalls) assert.ok(c.kinds.includes("PRODUCT_PHOTO"), "mọi lượt vẽ có ảnh sản phẩm thật (assertPixelSafe)");
    const generatedDesigns = (await db.select().from(schema.designConcepts).where(eq(schema.designConcepts.batchId, batch.id))).filter((c) => c.imageId);
    assert.ok(generatedDesigns.length >= 1, "ảnh đầu tiên của thiết kế thành ảnh đại diện");
    assert.ok(dnaReads >= 1, "bước đọc DNA chạy TRƯỚC khi lập lô (mã đã gỡ R lại thiếu DNA)");

    // ═══ PHIẾU DUYỆT khoá luật riêng; đường TẮT chấp nhận luật riêng ═══
    const d0 = approvalDigest(await batchApprovalContent(db, batch));
    const mA = mocks.find((x) => x.productId === `${P}prod-A`) as (typeof mocks)[number];
    const [cur] = await db.select().from(schema.creativeVariants).where(eq(schema.creativeVariants.id, mA.id));
    if (cur.status === "GENERATED") {
      const tweaked = { ...(cur.rulesSnapshot as Record<string, unknown>), p75CostPerMessageVnd: 9999 };
      await db.update(schema.creativeVariants).set({ rulesSnapshot: tweaked }).where(eq(schema.creativeVariants.id, mA.id));
      assert.notEqual(approvalDigest(await batchApprovalContent(db, batch)), d0, "luật riêng đổi SAU khi mở phiếu ⇒ digest khác");
      await db.update(schema.creativeVariants).set({ rulesSnapshot: cur.rulesSnapshot }).where(eq(schema.creativeVariants.id, mA.id));
      assert.equal(approvalDigest(await batchApprovalContent(db, batch)), d0);
    }

    // Mẫu A đang chạy: tắt theo LUẬT RIÊNG của ô được, luật lạ thì không.
    await db.update(schema.creativeBatches).set({ status: "PUBLISHED", approvedAt: now, approvalDigest: `${P}digest`, error: `${P}lo` }).where(eq(schema.creativeBatches.id, batch.id));
    await db.update(schema.creativeVariants).set({ status: "LIVE", fbAdId: `${P}fb-ad-A`, fbAdsetId: `${P}fb-as-A` }).where(eq(schema.creativeVariants.id, mA.id));
    const paused: string[] = [];
    const writer = { pauseAdset: async (id: string) => void paused.push(id) } as unknown as CreativeWriter;
    const env = { hardEnabled: true, mode: "COPILOT" as const };
    const ownKill = rulesA?.basis === "PRODUCT_HISTORY" ? rulesA.killRules[0] : null;
    assert.ok(ownKill);
    const ruleLa = { ...ownKill, value: 1 };
    const denied = await pauseCreativeVariant(db, { variantId: mA.id, kind: "KILL_RULE", rule: ruleLa, actor: { id: null, label: "test" } }, now, { writer, env });
    assert.equal(denied.ok, false, "luật không thuộc lô, không thuộc ô ⇒ không tắt");
    assert.equal(paused.length, 0);
    const ok = await pauseCreativeVariant(db, { variantId: mA.id, kind: "KILL_RULE", rule: ownKill, actor: { id: null, label: "test" } }, now, { writer, env });
    assert.ok(ok.ok, `luật riêng của ô là luật thuộc lô: ${ok.ok ? "" : ok.detail}`);
    assert.deepEqual(paused, [`${P}fb-as-A`]);

    // Người viết THẬT với ô thiết kế: mô tả thiết kế mới + "không sao chép", không câu giữ sản phẩm.
    const provider: AiProvider = {
      name: "fake",
      model: "fake-model",
      complete: async () => ({ content: [{ type: "text", text: JSON.stringify({ imagePrompt: "A model walking in a sunny street.", primaryText: "Mẫu mới giá 399.000đ", headline: "Mẫu mới" }) }], model: "fake-model", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: "end_turn" }),
    } as unknown as AiProvider;
    const out = await writeVariantCopy({ genes: G, mode: "DESIGN", why: "x", product: { name: "Mẫu mới TK-X", code: "TK-261001-01", priceVnd: 399_000 }, inspirationSummary: null, winningExamples: [], design: { code: "TK-261001-01", dna: DNA_A } }, { provider, now });
    assert.ok(out.imagePrompt.includes(NEW_DESIGN_CLAUSE) && out.imagePrompt.includes("NEW GARMENT DESIGN"));
    assert.ok(!out.imagePrompt.includes(PRESERVE_PRODUCT_CLAUSE), "ô thiết kế không được dặn 'giữ nguyên sản phẩm'");
    assert.equal(out.priceStripped, false, "giá đề nghị đúng ⇒ giữ");
    console.log("✓ Vòng mẫu · thiết kế mới (CSDL): đơn giao/hoàn 90 ngày qua ORDER_OUTCOME · lịch sử chi/tin 60 ngày · đọc DNA lũy đẳng + sổ AI · lô 10 thiết kế + mockup mẫu được chọn · ảnh tham chiếu chỉ là ảnh sản phẩm của shop · luật riêng trong phiếu và trên đường tắt");
  } finally {
    await cleanup(db);
    if (prevCfg) await db.update(schema.settings).set({ value: prevCfg.value }).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
    else await db.delete(schema.settings).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
  }
}

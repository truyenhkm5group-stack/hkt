import assert from "node:assert/strict";
import { eq, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import {
  CREATIVE_HARD_LIMITS,
  DEFAULT_CREATIVE_CONFIG,
  DESIGN_NOVELTY,
  MANUAL_DESIGN,
  MANUAL_GEN,
  MANUAL_SLOT_BASE,
  dnaDifference,
  dnaSignature,
  estimateImageUsd,
  parseGenes,
  type CreativeLoopConfig,
  type DesignDna,
} from "@/lib/constants/creative-loop";
import { shiftDay, vnDay } from "@/lib/constants/marketing-decision-ledger";
import type { CaptionInput, VariantCaptioner } from "@/lib/creative/caption";
import { designPromptEn, type DesignParent } from "@/lib/creative/design";
import { imageSpendToday, reservedImageSpend } from "@/lib/creative/generate";
import { storeCreativeImage } from "@/lib/creative/images";
import { manualTargetDay } from "@/lib/creative/manual";
import { drawManualGen, manualDesignCode, manualDesignPrompt, manualGenGenes, parseManualDesignSpec, planManualDesigns, promoteManualGenImage, reviewManualGenImage, startManualDesignGen } from "@/lib/creative/manual-gen";
import { batchWindow } from "@/lib/creative/schedule";
import { vnStartOfDay } from "@/lib/format";
import type { ImageEditClient, ImageEditInputImage } from "@/lib/integrations/openai/images";

/**
 * ═══════════ GEN TAY KIỂU THIẾT KẾ MỚI (chủ shop 25/09/2026, §5i) ═══════════
 *
 * Chủ shop: "gen các mẫu MỚI HOÀN TOÀN, sáng tạo từ các ảnh đầu vào (mẫu đã win và mẫu có chỉ số tốt), không
 * phải tạo mockup mới cho các mẫu cũ". Khoá:
 *  (a) HÀM THUẦN: 10 bộ gen thiết kế có người mẫu, không trải phẳng, 10 tổ hợp khác nhau · câu lệnh là "thiết kế
 *      mới, KHÔNG sao chép" chứ không phải "giữ nguyên sản phẩm" · lập thiết kế chỉ từ mã người chọn, tất định,
 *      khác mọi mã đang có · mã TK của người ở dải 101+, không đụng dải của lô.
 *  (b) PGLITE, máy vẽ GIẢ (0 lời gọi mạng): mã không đủ điều kiện / không có ảnh thật bị chặn · máy vẽ chỉ nhận
 *      ẢNH SẢN PHẨM THẬT của mã cha · câu chữ theo giá đề nghị + "mẫu mới" · đưa vào lô ⇒ `design_concepts` mã
 *      TK-…-101, mẫu KHÔNG gắn mã cha · lượt sau không vẽ lại thiết kế của lượt trước.
 *
 * Mốc: chi QC gieo tương đối so với đồng hồ THẬT (cửa sổ "bán tốt" 90 ngày trước hôm nay), lô đích dựng từ
 * chính hàm lịch — không ghim ngày tuyệt đối (AGENTS.md mục 50).
 */

const P = "cmd-";

const DNA_A: DesignDna = { category: "DRESS", silhouette: "A_LINE", length: "MIDI", neckline: "V_NECK", sleeve: "SHORT", material: "CHIFFON", pattern: "FLORAL", colorFamily: "PINK", detail: "RUFFLE", style: "CASUAL" };
const DNA_B: DesignDna = { category: "BLOUSE", silhouette: "SHIFT", length: "HIP", neckline: "SHIRT_COLLAR", sleeve: "LONG", material: "SILK_SATIN", pattern: "SOLID", colorFamily: "WHITE_CREAM", detail: "BUTTONS", style: "OFFICE" };
const DNA_C: DesignDna = { category: "DRESS", silhouette: "BODYCON", length: "KNEE", neckline: "SQUARE", sleeve: "SLEEVELESS", material: "KNIT", pattern: "SOLID", colorFamily: "BLACK", detail: "NONE", style: "PARTY" };

function fakeJpeg(tag: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, tag & 0xff, (tag >> 8) & 0xff, (tag >> 16) & 0xff, 7, 7, 1, 2, 3]);
}

export function testCreativeManualDesignPure() {
  // ── Gen của ảnh thiết kế: có người mẫu, không trải phẳng, 10 tổ hợp khác nhau, tất định ──
  const g = manualGenGenes("lượt-tk", MANUAL_GEN.imagesPerRun, { design: true });
  assert.equal(g.length, MANUAL_GEN.imagesPerRun);
  assert.ok(g.every((x) => parseGenes(x) !== null), "đủ sáu gen trong từ vựng đóng ⇒ máy học được");
  assert.ok(g.every((x) => x.scene !== "FLATLAY" && x.model !== "NONE"), "thiết kế mới luôn có người mẫu mặc, không trải phẳng");
  assert.equal(new Set(g.map((x) => `${x.scene}|${x.composition}`)).size, g.length, "10 thiết kế = 10 tổ hợp bối cảnh × bố cục khác nhau");
  assert.ok(new Set(g.map((x) => x.scene)).size >= 5, "bối cảnh trải đều (bước 3 trên 6 bối cảnh chỉ ra 2)");
  assert.deepEqual(manualGenGenes("lượt-tk", MANUAL_GEN.imagesPerRun, { design: true }), g, "tất định theo id lượt");

  // ── Câu lệnh: thiết kế MỚI, không sao chép — không phải "giữ nguyên sản phẩm" ──
  const pr = manualDesignPrompt({ idea: "đi biển mùa thu", genes: g[0], dna: DNA_A, refCount: 2 });
  assert.ok(pr.includes(designPromptEn(DNA_A)), "mô tả thiết kế tất định theo DNA (cùng hàm của ô thiết kế trong lô)");
  assert.ok(pr.includes("do NOT copy") && !pr.includes("keep the product EXACTLY"), "câu lệnh dặn KHÔNG sao chép mẫu tham chiếu, không giữ nguyên sản phẩm");
  assert.ok(pr.includes("đi biển mùa thu") && pr.includes("2 attached photos"), "ý tưởng người + số ảnh tham chiếu thật");
  assert.ok(!manualDesignPrompt({ idea: "", genes: g[0], dna: DNA_A, refCount: 1 }).includes("Creative direction"), "không có ý tưởng thì không nhắc");

  // ── Lập thiết kế: chỉ từ mã NGƯỜI CHỌN, tất định, khác mọi mã đang có ──
  const parent = (id: string, dna: DesignDna, score: number, photo: string | null, price: number | null): DesignParent => ({ productId: id, label: `Mã ${id}`, dna, score, photoSourceId: photo, priceVnd: price });
  const parents = [parent("A", DNA_A, 5, "ph-A", 399_000), parent("B", DNA_B, 3, "ph-B", 350_000), parent("C", DNA_C, 2, null, 299_000)];
  const existing = [DNA_A, DNA_B, DNA_C];
  const plan = planManualDesigns({ seed: "lượt-1", day: "2026-09-25", count: MANUAL_GEN.imagesPerRun, parents, existingDna: existing, recentDesigns: [], stats: [] });
  assert.ok(plan.specs.length >= 5, `lập được nhiều thiết kế (nhận ${plan.specs.length}; ${plan.reasons.join(" ")})`);
  assert.deepEqual(planManualDesigns({ seed: "lượt-1", day: "2026-09-25", count: MANUAL_GEN.imagesPerRun, parents, existingDna: existing, recentDesigns: [], stats: [] }), plan, "tất định theo id lượt");
  const other = planManualDesigns({ seed: "lượt-2", day: "2026-09-25", count: MANUAL_GEN.imagesPerRun, parents, existingDna: existing, recentDesigns: [], stats: [] });
  assert.notDeepEqual(
    other.specs.map((s) => dnaSignature(s.dna)),
    plan.specs.map((s) => dnaSignature(s.dna)),
    "hai lượt cùng ngày ra hai bộ thiết kế khác nhau (hạt giống là id lượt, không phải ngày)",
  );
  for (const s of plan.specs) {
    assert.ok(s.parentProductIds.every((id) => ["A", "B", "C"].includes(id)), "chỉ lai từ mã người đã chọn");
    assert.ok(["ph-A", "ph-B"].includes(s.photoSourceIds[0]), "cha trội luôn có ảnh sản phẩm thật");
    assert.ok(s.photoSourceIds.length <= MANUAL_DESIGN.refPhotos && s.photoSourceIds.every((x) => x.startsWith("ph-")), "ảnh tham chiếu chỉ là ảnh thật của mã cha");
    assert.equal(s.priceVnd, parents.find((p) => p.productId === s.parentProductIds[0])?.priceVnd, "giá đề nghị = giá của cha trội");
    assert.ok(Math.min(...existing.map((e) => dnaDifference(s.dna, e))) >= DESIGN_NOVELTY.minDiffAttributes, "khác MỌI mẫu đang có ở ≥ 2 thuộc tính — mẫu mới, không phải mẫu cũ");
    assert.deepEqual(parseManualDesignSpec(JSON.parse(JSON.stringify(s))), s, "bản mô tả đọc lại nguyên vẹn từ cột JSON");
  }
  assert.equal(new Set(plan.specs.map((s) => dnaSignature(s.dna))).size, plan.specs.length, "không hai thiết kế trùng nhau trong một lượt");
  // Lượt sau thấy thiết kế của lượt trước ⇒ không vẽ lại chúng.
  const next = planManualDesigns({ seed: "lượt-3", day: "2026-09-25", count: MANUAL_GEN.imagesPerRun, parents, existingDna: existing, recentDesigns: plan.specs.map((s) => s.dna), stats: [] });
  const truoc = new Set(plan.specs.map((s) => dnaSignature(s.dna)));
  assert.ok(next.specs.every((s) => !truoc.has(dnaSignature(s.dna))), "thiết kế gen tay gần đây nằm trong phép kiểm mới lạ");
  assert.equal(planManualDesigns({ seed: "x", day: "2026-09-25", count: 3, parents: [parents[2]], existingDna: existing, recentDesigns: [], stats: [] }).specs.length, 0, "không mã nào có ảnh thật ⇒ không lập, không đoán");
  assert.equal(parseManualDesignSpec(null), null);
  assert.equal(parseManualDesignSpec({ ...plan.specs[0], photoSourceIds: [] }), null, "thiếu ảnh tham chiếu ⇒ không phải bản mô tả vẽ được");

  // ── Mã TK của người: dải 101+, không đụng dải 01… của lô ──
  assert.ok(MANUAL_DESIGN.codeBase > CREATIVE_HARD_LIMITS.maxBatchSize * 2, "dải mã người nằm trên mọi số ô thiết kế lô có thể cấp");
  assert.equal(manualDesignCode("2026-09-25", []), "TK-260925-101");
  assert.equal(manualDesignCode("2026-09-25", ["TK-260925-01", "TK-260925-09", "TK-260925-101", "TK-260925-104", "TK-260924-150"]), "TK-260925-105", "nối tiếp số lớn nhất của ĐÚNG ngày, bỏ qua dải của lô và ngày khác");

  console.log("  ✓ Gen tay thiết kế mới (thuần): gen có người mẫu, 10 tổ hợp khác nhau · câu lệnh KHÔNG sao chép · chỉ lai mã người chọn, tất định, khác mọi mẫu đang có · lượt sau không lặp lượt trước · mã TK dải 101+");
}

// ═══════════════════════════ PGLITE ═══════════════════════════

function cfgOf(over: Partial<CreativeLoopConfig> = {}): CreativeLoopConfig {
  return { ...DEFAULT_CREATIVE_CONFIG, enabled: false, pageId: `${P}page`, adAccountId: "8880002", testCampaignId: "7770002", templateAdId: "9990002", imageModel: "gpt-image-2", imageQuality: "low", imageSize: "1024x1024", ...over };
}

async function cleanup(db: Db, days: string[]) {
  const gens = await db.select({ id: schema.creativeManualGens.id }).from(schema.creativeManualGens).where(like(schema.creativeManualGens.createdByName, `${P}%`));
  const genIds = gens.map((g) => g.id);
  if (genIds.length) {
    await db.delete(schema.creativeManualGenImages).where(inArray(schema.creativeManualGenImages.genId, genIds));
    await db.delete(schema.creativeManualGens).where(inArray(schema.creativeManualGens.id, genIds));
  }
  const batches = await db.select({ id: schema.creativeBatches.id }).from(schema.creativeBatches).where(inArray(schema.creativeBatches.batchDay, days));
  const ids = batches.map((b) => b.id);
  if (ids.length) {
    await db.delete(schema.creativeVariants).where(inArray(schema.creativeVariants.batchId, ids));
    await db.delete(schema.designConcepts).where(inArray(schema.designConcepts.batchId, ids));
    await db.delete(schema.creativeBatches).where(inArray(schema.creativeBatches.id, ids));
  }
  await db.delete(schema.creativeSources).where(like(schema.creativeSources.id, `${P}%`));
  await db.delete(schema.productDna).where(like(schema.productDna.productId, `${P}%`));
  await db.delete(schema.adSpends).where(like(schema.adSpends.campaign, `${P}%`));
  await db.delete(schema.productVariants).where(like(schema.productVariants.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
  await db.delete(schema.users).where(like(schema.users.id, `${P}%`));
}

export async function testCreativeManualDesignDb(db: Db) {
  const actor = { id: `${P}u`, name: `${P}Chủ shop` };
  const farDay = shiftDay(vnDay(new Date()), 95);
  const farNow = new Date(batchWindow(farDay, DEFAULT_CREATIVE_CONFIG).approvalDeadline.getTime() - 6 * 3_600_000);
  const targetDay = manualTargetDay(farNow, DEFAULT_CREATIVE_CONFIG);
  await cleanup(db, [targetDay]);

  const seen: ImageEditInputImage["kind"][][] = [];
  let calls = 0;
  const imageClient: ImageEditClient = async (input) => {
    calls += 1;
    seen.push(input.images.map((i) => i.kind));
    return { bytes: fakeJpeg(70_000 + calls), contentType: "image/jpeg", usage: null, costUsd: null };
  };
  const captionInputs: CaptionInput[] = [];
  const caption: VariantCaptioner = async (_db, input) => {
    captionInputs.push(input);
    return { ok: true, headline: "Mẫu mới vừa về", primaryText: "Thiết kế mới của shop — nhắn để được tư vấn size.", options: [], seen: "đầm mới", model: "fake-caption", costUsd: null, attempts: 1, priceStripped: false };
  };

  try {
    await db.insert(schema.users).values({ id: `${P}u`, email: `${P}u@t.local`, name: actor.name, passwordHash: "x", role: "ADMIN" });
    await db.insert(schema.products).values([
      { id: `${P}A`, name: "Đầm hoa bán chạy", customId: `${P}Q01` },
      { id: `${P}B`, name: "Sơ mi lụa bán chạy", customId: `${P}Q02` },
      { id: `${P}C`, name: "Đầm body không ảnh", customId: `${P}Q03` },
      { id: `${P}X`, name: "Mã không bán được", customId: `${P}Q09` },
    ]);
    await db.insert(schema.productVariants).values([
      { id: `${P}vA`, productId: `${P}A`, retailPrice: 399_000 },
      { id: `${P}vB`, productId: `${P}B`, retailPrice: 399_000 },
    ]);
    const phA = await storeCreativeImage(db, fakeJpeg(11));
    const phB = await storeCreativeImage(db, fakeJpeg(12));
    const own = await storeCreativeImage(db, fakeJpeg(13));
    await db.insert(schema.creativeSources).values([
      { id: `${P}phA`, kind: "PRODUCT_PHOTO", productId: `${P}A`, imageId: phA.id, title: "ảnh thật A" },
      { id: `${P}phB`, kind: "PRODUCT_PHOTO", productId: `${P}B`, imageId: phB.id, title: "ảnh thật B" },
      { id: `${P}own`, kind: "OWN_AD", productId: `${P}A`, imageId: own.id, fbAdId: `${P}ad-own`, title: "QC cũ thắng" },
    ]);
    await db.insert(schema.productDna).values([
      { productId: `${P}A`, dna: DNA_A, dnaVersion: 1 },
      { productId: `${P}B`, dna: DNA_B, dnaVersion: 1 },
      { productId: `${P}C`, dna: DNA_C, dnaVersion: 1 },
      { productId: `${P}X`, dna: { ...DNA_C, colorFamily: "RED" }, dnaVersion: 1 },
    ]);
    // "Chỉ số tốt": chi mỗi tin nhắn thấp trên đủ tin — A, B, C đủ điều kiện mã cha; X không có số đo nào.
    const spend = (adId: string, productId: string, amount: number, messages: number) => ({
      platform: "FACEBOOK",
      campaign: `${P}camp`,
      grain: "AD",
      adId: `${P}${adId}`,
      productId,
      spend: amount,
      messages,
      spendDate: vnStartOfDay(vnDay(new Date(Date.now() - 5 * 86_400_000))),
      createdBy: "test",
    });
    await db.insert(schema.adSpends).values([spend("a", `${P}A`, 20_000, 10), spend("b", `${P}B`, 24_000, 10), spend("c", `${P}C`, 30_000, 10)]);

    const now = new Date();
    const unit = estimateImageUsd(cfgOf().imageModel, cfgOf().imageQuality, cfgOf().imageSize);
    const [s0, r0] = await Promise.all([imageSpendToday(db, now, unit), reservedImageSpend(db, now)]);
    const cfg = cfgOf({ imageDailyCapUsd: Math.min(CREATIVE_HARD_LIMITS.maxImageUsdPerDay, s0.usd + r0.usd + 10.5 * unit) });

    // ── (b1) Mã không đủ điều kiện / không có ảnh thật ⇒ chặn, không ghi gì ──
    const x = await startManualDesignGen(db, { inspirationProductIds: [`${P}X`], idea: "" }, cfg, actor, now);
    assert.ok(!x.ok && x.error.includes("không còn đủ điều kiện"), "mã không bán tốt không làm cảm hứng được");
    const c = await startManualDesignGen(db, { inspirationProductIds: [`${P}C`], idea: "" }, cfg, actor, now);
    assert.ok(!c.ok && c.error.includes("ẢNH SẢN PHẨM THẬT"), "không mã nào có ảnh thật ⇒ không vẽ");
    assert.ok(!(await startManualDesignGen(db, { inspirationProductIds: [], idea: "" }, cfg, actor, now)).ok);

    // ── (b2) Lượt thiết kế: mỗi ảnh một thiết kế mới, ảnh tham chiếu chỉ là ảnh thật của mã cha ──
    const s1 = await startManualDesignGen(db, { inspirationProductIds: [`${P}A`, `${P}B`, `${P}C`], idea: "đi biển mùa thu" }, cfg, actor, now, { seed: `${P}hat-giong` });
    assert.ok(s1.ok, s1.ok ? "" : s1.error);
    const [run] = await db.select().from(schema.creativeManualGens).where(eq(schema.creativeManualGens.id, s1.genId));
    assert.equal(run.kind, "DESIGN");
    assert.deepEqual(run.inspirationProductIds, [`${P}A`, `${P}B`, `${P}C`]);
    assert.equal(run.productId, null, "lượt thiết kế không gắn một mã hàng cũ");
    const rows = (await db.select().from(schema.creativeManualGenImages).where(eq(schema.creativeManualGenImages.genId, s1.genId))).sort((a, b) => a.seq - b.seq);
    assert.ok(rows.length >= 3 && rows.length <= MANUAL_GEN.imagesPerRun, `lập được nhiều thiết kế (nhận ${rows.length})`);
    const specs = rows.map((r) => parseManualDesignSpec(r.design));
    assert.ok(specs.every((s) => s !== null), "mỗi ảnh mang bản mô tả thiết kế đủ DNA");
    assert.ok(rows.every((r) => r.prompt.includes("NEW GARMENT DESIGN") && r.prompt.includes("đi biển mùa thu") && !r.prompt.includes("keep the product EXACTLY")));
    assert.equal(new Set(specs.map((s) => dnaSignature((s as NonNullable<typeof s>).dna))).size, rows.length, "mỗi ảnh là một thiết kế khác");
    for (const s of specs) {
      const d = (s as NonNullable<typeof s>).dna;
      assert.ok(Math.min(dnaDifference(d, DNA_A), dnaDifference(d, DNA_B), dnaDifference(d, DNA_C)) >= DESIGN_NOVELTY.minDiffAttributes, "thiết kế khác mọi mẫu cảm hứng — mẫu mới, không phải mockup");
    }
    assert.equal(calls, 0, "bấm Gen KHÔNG gọi máy vẽ");

    // ── (b2') Lượt sau CÙNG hạt giống, cùng đầu vào: không có luật "thiết kế gen tay gần đây" thì nó ra đúng
    //         bộ thiết kế của lượt trước; có luật thì không trùng một thiết kế nào ──
    const cfgRong = cfgOf({ imageDailyCapUsd: Math.min(CREATIVE_HARD_LIMITS.maxImageUsdPerDay, s0.usd + r0.usd + 21 * unit) });
    const s1b = await startManualDesignGen(db, { inspirationProductIds: [`${P}A`, `${P}B`, `${P}C`], idea: "" }, cfgRong, actor, now, { seed: `${P}hat-giong` });
    if (s1b.ok) {
      const truoc = new Set(specs.map((s) => dnaSignature((s as NonNullable<typeof s>).dna)));
      const rows1b = await db.select().from(schema.creativeManualGenImages).where(eq(schema.creativeManualGenImages.genId, s1b.genId));
      assert.ok(rows1b.length > 0 && rows1b.every((r) => !truoc.has(dnaSignature((parseManualDesignSpec(r.design) as NonNullable<ReturnType<typeof parseManualDesignSpec>>).dna))), "thiết kế gen tay gần đây nằm trong phép kiểm mới lạ");
      await db.delete(schema.creativeManualGenImages).where(eq(schema.creativeManualGenImages.genId, s1b.genId));
      await db.delete(schema.creativeManualGens).where(eq(schema.creativeManualGens.id, s1b.genId));
    } else {
      assert.match(s1b.error, /mới lạ/, `không lập thêm được thì nói ra, không vẽ lại thiết kế cũ (nhận: ${s1b.error})`);
    }

    const d1 = await drawManualGen(db, { genId: s1.genId, imageClient, config: cfg });
    assert.equal(d1.drawn, s1.allowed);
    assert.ok(seen.length > 0 && seen.every((k) => k.length >= 1 && k.length <= MANUAL_DESIGN.refPhotos && k.every((kind) => kind === "PRODUCT_PHOTO")), "máy vẽ chỉ nhận ẢNH SẢN PHẨM THẬT của mã cha — không quảng cáo cũ, không spy");

    // ── (b3) Duyệt ⇒ câu chữ theo giá đề nghị + "mẫu mới"; đưa vào lô ⇒ design_concepts TK-…-101 ──
    const ready = (await db.select().from(schema.creativeManualGenImages).where(eq(schema.creativeManualGenImages.genId, s1.genId))).filter((r) => r.status === "GENERATED").sort((a, b) => a.seq - b.seq);
    assert.ok(ready.length >= 2);
    const spec0 = parseManualDesignSpec(ready[0].design) as NonNullable<ReturnType<typeof parseManualDesignSpec>>;
    const ok = await reviewManualGenImage(db, { imageId: ready[0].id, decision: "APPROVE", reason: "" }, actor, now, { caption });
    assert.ok(ok.ok && ok.caption?.ok);
    assert.equal(captionInputs[0].product.name, "Mẫu mới");
    assert.equal(captionInputs[0].product.priceVnd, spec0.priceVnd, "câu chữ dùng GIÁ ĐỀ NGHỊ của thiết kế");
    assert.match(captionInputs[0].productNote ?? "", /MẪU MỚI/);

    const p1 = await promoteManualGenImage(db, { imageId: ready[0].id, headline: "Mẫu mới vừa về", primaryText: "Thiết kế mới của shop.", names: { campaign: "", adset: "", ad: "" }, predictedSeq: null }, cfg, actor, farNow);
    assert.ok(p1.ok, p1.ok ? "" : p1.error);
    const code1 = manualDesignCode(targetDay, []);
    assert.equal(p1.designCode, code1, "mã TK theo NGÀY LÔ, dải 101+");
    assert.equal(p1.slot, MANUAL_SLOT_BASE + 1, "vào lô như mẫu người đưa vào (đăng trước ô máy lập)");
    const [v1] = await db.select().from(schema.creativeVariants).where(eq(schema.creativeVariants.id, p1.variantId));
    assert.equal(v1.mode, "MANUAL");
    assert.equal(v1.productId, null, "mẫu thiết kế mới KHÔNG gắn mã cha — đơn của nó không cộng vào mã cũ");
    assert.equal(v1.productPhotoSourceId, spec0.photoSourceIds[0]);
    assert.ok(v1.designConceptId, "mẫu nối vào thiết kế ⇒ đơn, chấm, MOQ đi theo mã TK");
    assert.match(v1.why, new RegExp(`Thiết kế mới ${code1}`));
    const [tk] = await db.select().from(schema.designConcepts).where(eq(schema.designConcepts.id, v1.designConceptId as string));
    assert.equal(tk.code, code1);
    assert.equal(tk.status, "DRAFT");
    assert.equal(tk.batchId, v1.batchId);
    assert.equal(tk.imageId, ready[0].imageId, "ảnh đại diện của thiết kế là đúng ảnh đã duyệt");
    assert.deepEqual(tk.dna, spec0.dna);
    assert.deepEqual(tk.parentProductIds, spec0.parentProductIds);
    assert.equal(tk.priceVnd, spec0.priceVnd);
    assert.equal(p1.priceVnd, spec0.priceVnd, "cảnh báo giá của server action đọc giá đề nghị");

    await reviewManualGenImage(db, { imageId: ready[1].id, decision: "APPROVE", reason: "" }, actor, now, { caption });
    const p2 = await promoteManualGenImage(db, { imageId: ready[1].id, headline: "", primaryText: "Thiết kế mới thứ hai.", names: { campaign: "", adset: "", ad: "" }, predictedSeq: null }, cfg, actor, farNow);
    assert.ok(p2.ok && p2.designCode === manualDesignCode(targetDay, [code1]), "thiết kế thứ hai nhận mã kế tiếp");
  } finally {
    await cleanup(db, [targetDay]);
  }
  console.log("  ✓ Gen tay thiết kế mới (PGlite, máy vẽ giả): mã không bán tốt / không ảnh thật bị chặn · mỗi ảnh một thiết kế khác mọi mẫu cảm hứng · máy vẽ chỉ nhận ảnh thật của mã cha · câu chữ theo giá đề nghị · vào lô ⇒ TK-…-101, không gắn mã cha · lượt sau không lặp");
}

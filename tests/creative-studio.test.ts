import assert from "node:assert/strict";
import { eq, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { DEFAULT_CREATIVE_CONFIG, GENE_KEYS, GENE_VOCAB, MANUAL_GEN_RUN, normalizeCreativeConfig, parseGenes, type CreativeLoopConfig, type Genes } from "@/lib/constants/creative-loop";
import {
  OUTPUT_STYLES,
  OUTPUT_STYLE_KEYS,
  PRESERVE_PRODUCT_RECOLOR_CLAUSE,
  applyStyleGenes,
  normalizeColors,
  normalizeStudioOptions,
  planStudioCells,
  studioCellLabel,
  studioDirectives,
  studioProblem,
  studioTotal,
} from "@/lib/constants/creative-studio";
import { storeCreativeImage } from "@/lib/creative/images";
import { drawManualGen, manualGenGenes, manualGenPrompt, startManualGen } from "@/lib/creative/manual-gen";
import { PRESERVE_PRODUCT_CLAUSE } from "@/lib/creative/writer";
import { assertPixelSafe, type ImageEditClient } from "@/lib/integrations/openai/images";
import { listRecentIdeas, loadManualGenImagePrompt, loadManualGenRemix } from "@/lib/queries/creative-manual-gen";

/**
 * ═══════════ STUDIO TẠO ẢNH — KIỂU ẢNH · BIẾN THỂ MÀU · KHỔ · CHẤT LƯỢNG (chủ shop 29/09/2026) ═══════════
 *
 * Thuần: lưới "mẫu × màu × kiểu" đúng thứ tự (biến thể của CÙNG một mẫu liền nhau) và đúng trần một lần bấm · khoá lạ bị bỏ,
 * `AUTO` đi cùng kiểu khác thì bỏ, kiểu không hợp thiết kế mới bị bỏ ở lượt thiết kế · màu trùng / rỗng / quá dài bị làm sạch ·
 * mọi kiểu giữ bộ gen HỢP LỆ (máy học được) · không chọn gì ⇒ câu lệnh GIỐNG HỆT trước studio · đổi màu ảnh mockup thay câu
 * "giữ đúng màu" bằng câu "giữ mọi thứ trừ màu".
 * CSDL: 2 bố cục × 2 màu × 2 kiểu = 8 ảnh, cùng bố cục giữ cùng gen gốc ở hai màu, mỗi ảnh ghi màu + kiểu, lượt ghi khổ +
 * chất lượng người chọn và máy vẽ nhận ĐÚNG khổ + chất lượng ấy · vượt trần ⇒ từ chối, không ghi gì · "Tạo lại tương tự" đọc
 * lại đúng thiết lập · câu lệnh đọc riêng theo ảnh · ý tưởng gần đây mới trước, không trùng.
 */

export function testCreativeStudioPure() {
  // Lưới + thứ tự: mẫu → màu → kiểu.
  const cells = planStudioCells(2, { styles: ["STUDIO", "LIFESTYLE"], colors: ["Đỏ đô", "Đen"] });
  assert.equal(cells.length, 8);
  assert.deepEqual(
    cells.slice(0, 4).map((c) => `${c.unit}|${c.color}|${c.style}`),
    ["0|Đỏ đô|STUDIO", "0|Đỏ đô|LIFESTYLE", "0|Đen|STUDIO", "0|Đen|LIFESTYLE"],
    "mọi biến thể của mẫu 1 đứng trước mẫu 2",
  );
  assert.deepEqual(planStudioCells(3, { styles: [], colors: [] }), [0, 1, 2].map((unit) => ({ unit, style: "AUTO", color: "" })), "không chọn gì ⇒ như trước");
  assert.equal(studioTotal(3, { styles: [], colors: ["a", "b"] }), 6);
  assert.equal(studioProblem(4, { styles: ["STUDIO", "HERO"], colors: ["a", "b", "c"] }), `4 mẫu × 3 màu × 2 kiểu = 24 ảnh — vượt trần ${MANUAL_GEN_RUN.maxImagesPerRun} ảnh một lần bấm. Bớt màu / kiểu / số mẫu.`);
  assert.equal(studioProblem(MANUAL_GEN_RUN.maxImagesPerRun, { styles: [], colors: [] }), null, "đúng trần thì được");
  assert.ok(studioProblem(0, { styles: [], colors: [] }));

  // Làm sạch đầu vào.
  assert.deepEqual(normalizeColors([" Đỏ  đô ", "đỏ đô", "", 7, "x".repeat(200), "Đen"]), ["Đỏ đô", "x".repeat(60), "Đen"]);
  assert.equal(normalizeColors(["a", "b", "c", "d", "e", "f", "g"]).length, 6, "tối đa 6 màu");
  assert.deepEqual(normalizeStudioOptions({ styles: ["AUTO", "STUDIO", "BAY", "STUDIO"], colors: ["Be"], size: "999x1", quality: "ultra" }), { styles: ["STUDIO"], colors: ["Be"], size: null, quality: null });
  assert.deepEqual(normalizeStudioOptions({ styles: ["FLATLAY", "MANNEQUIN"] }, "DESIGN").styles, ["MANNEQUIN"], "thiết kế mới không trải phẳng");
  assert.deepEqual(normalizeStudioOptions({ size: "1088x1360", quality: "low" }), { styles: [], colors: [], size: "1088x1360", quality: "low" });
  assert.deepEqual(normalizeStudioOptions("rác"), { styles: [], colors: [], size: null, quality: null });

  // Mọi kiểu × mọi bộ gen gốc ⇒ bộ gen HỢP LỆ đủ sáu khoá (máy học được).
  const bases = [...manualGenGenes("seed-a", 12), ...manualGenGenes("seed-b", 12, { design: true })];
  for (const style of OUTPUT_STYLE_KEYS) {
    for (const g of bases) {
      const out = applyStyleGenes(g, style);
      assert.ok(parseGenes(out), `${style}: bộ gen hỏng ${JSON.stringify(out)}`);
      for (const k of GENE_KEYS) assert.ok((GENE_VOCAB[k] as readonly string[]).includes(out[k]), `${style}.${k}`);
      assert.ok(!(out.model === "NONE" && out.composition === "MIRROR_SELFIE"), "không người mẫu thì không selfie gương");
      assert.equal(out.textOverlay, "NONE", "studio không in chữ lên ảnh");
      for (const [k, v] of Object.entries(OUTPUT_STYLES[style].genes)) if (!(style === "UGC_SELFIE" && k === "model")) assert.equal(out[k as keyof Genes], v, `${style} ghi đè ${k}`);
    }
  }
  assert.deepEqual(applyStyleGenes(bases[0], "AUTO"), bases[0], "Tự động không đổi gen");

  // Câu lệnh: không chọn gì ⇒ giống hệt trước studio.
  const g0 = bases[0];
  const base = { idea: "đi biển", genes: g0, productName: "Đầm A", hasOwnAd: false };
  assert.equal(manualGenPrompt({ ...base, cell: { style: "AUTO", color: "" } }), manualGenPrompt(base));
  const withColor = manualGenPrompt({ ...base, cell: { style: "STUDIO", color: "Đỏ đô" } });
  assert.ok(withColor.includes("COLOUR VARIANT") && withColor.includes("Đỏ đô") && withColor.includes("OUTPUT STYLE"), withColor);
  assert.ok(withColor.includes(PRESERVE_PRODUCT_RECOLOR_CLAUSE) && !withColor.includes(PRESERVE_PRODUCT_CLAUSE), "đổi màu ⇒ thôi dặn 'giữ đúng màu'");
  assert.ok(withColor.indexOf("TOP PRIORITY") < withColor.indexOf("OUTPUT STYLE"), "ý tưởng người vẫn đứng đầu");
  assert.deepEqual(studioDirectives({ style: "AUTO", color: "  " }, "MOCKUP"), []);
  assert.ok(studioDirectives({ style: "AUTO", color: "Be" }, "DESIGN")[0].includes("new garment design"));
  for (const s of OUTPUT_STYLE_KEYS) assert.ok(!/[<>{}]/.test(OUTPUT_STYLES[s].prompt), `${s}: câu lệnh bảng hằng sạch`);

  assert.equal(studioCellLabel("STUDIO", "Đen"), "Studio nền trơn · Đen");
  assert.equal(studioCellLabel("AUTO", ""), "");
  assert.equal(studioCellLabel("", "Be"), "Be");

  console.log("✓ Studio tạo ảnh (thuần): lưới mẫu × màu × kiểu đúng thứ tự + trần · đầu vào lạ bị bỏ · gen luôn hợp lệ · không chọn gì ⇒ câu lệnh như cũ · đổi màu thay câu giữ màu");
}

const P = "cst-";

async function cleanup(db: Db) {
  const gens = await db.select({ id: schema.creativeManualGens.id }).from(schema.creativeManualGens).where(like(schema.creativeManualGens.createdByName, `${P}%`));
  const ids = gens.map((g) => g.id);
  if (ids.length) {
    await db.delete(schema.creativeManualGenImages).where(inArray(schema.creativeManualGenImages.genId, ids));
    await db.delete(schema.creativeManualGens).where(inArray(schema.creativeManualGens.id, ids));
  }
  await db.delete(schema.creativeSources).where(like(schema.creativeSources.id, `${P}%`));
  await db.delete(schema.productVariants).where(like(schema.productVariants.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
  await db.delete(schema.users).where(like(schema.users.id, `${P}%`));
}

function fakeJpeg(tag: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, tag & 0xff, (tag >> 8) & 0xff, 7, 7, 9, 1, 2, 3]);
}

export async function testCreativeStudioDb(db: Db) {
  const actor = { id: `${P}u`, name: `${P}Chủ shop` };
  const cfg: CreativeLoopConfig = normalizeCreativeConfig({ ...DEFAULT_CREATIVE_CONFIG, imageSize: "1024x1024", imageQuality: "medium" }).config;
  await cleanup(db);
  try {
    await db.insert(schema.users).values({ id: `${P}u`, email: `${P}u@t.local`, name: actor.name, passwordHash: "x", role: "ADMIN" });
    await db.insert(schema.products).values({ id: `${P}prod`, name: "Đầm studio thử" });
    await db.insert(schema.productVariants).values({ id: `${P}var`, productId: `${P}prod`, retailPrice: 399_000, retailPriceAfterDiscount: 399_000 });
    const photo = await storeCreativeImage(db, fakeJpeg(1));
    await db.insert(schema.creativeSources).values({ id: `${P}photo`, kind: "PRODUCT_PHOTO", productId: `${P}prod`, imageId: photo.id, title: "ảnh thật" });

    // Vượt trần ⇒ từ chối, không ghi gì.
    const qua = await startManualGen(db, { productPhotoSourceId: `${P}photo`, ownAdSourceId: null, idea: "", count: 4, studio: { styles: ["STUDIO", "HERO"], colors: ["a", "b", "c"] } }, cfg, actor);
    assert.ok(!qua.ok && qua.error.includes("vượt trần"), qua.ok ? "" : qua.error);
    assert.equal((await db.select().from(schema.creativeManualGens).where(like(schema.creativeManualGens.createdByName, `${P}%`))).length, 0);

    // 2 bố cục × 2 màu × 2 kiểu, khổ dọc 4:5, chất lượng thấp.
    const s = await startManualGen(db, { productPhotoSourceId: `${P}photo`, ownAdSourceId: null, idea: "dạo phố Hội An", count: 2, studio: { styles: ["STUDIO", "UGC_SELFIE"], colors: ["Đỏ đô", "Đen"], size: "1088x1360", quality: "low" } }, cfg, actor);
    assert.ok(s.ok, s.ok ? "" : s.error);
    if (!s.ok) return;
    assert.equal(s.requested, 8);
    const [run] = await db.select().from(schema.creativeManualGens).where(eq(schema.creativeManualGens.id, s.genId));
    assert.equal(run.size, "1088x1360", "khổ người chọn, không phải khổ cấu hình");
    assert.equal(run.quality, "low");
    assert.deepEqual(run.options, { units: 2, styles: ["STUDIO", "UGC_SELFIE"], colors: ["Đỏ đô", "Đen"], size: "1088x1360", quality: "low" });
    const rows = (await db.select().from(schema.creativeManualGenImages).where(eq(schema.creativeManualGenImages.genId, s.genId))).sort((a, b) => a.seq - b.seq);
    assert.deepEqual(
      rows.map((r) => `${r.color}|${r.outputStyle}`),
      ["Đỏ đô|STUDIO", "Đỏ đô|UGC_SELFIE", "Đen|STUDIO", "Đen|UGC_SELFIE", "Đỏ đô|STUDIO", "Đỏ đô|UGC_SELFIE", "Đen|STUDIO", "Đen|UGC_SELFIE"],
    );
    // Cùng bố cục, cùng kiểu, khác màu ⇒ CÙNG bộ gen (so được màu thật).
    assert.deepEqual(rows[0].genes, rows[2].genes);
    assert.equal(rows[0].genes.scene, "STUDIO_PLAIN");
    assert.equal(rows[1].genes.composition, "MIRROR_SELFIE");
    assert.ok(rows.every((r) => r.prompt.includes("dạo phố Hội An") && r.prompt.includes(`COLOUR VARIANT`) && r.prompt.includes(r.color)));

    // Máy vẽ nhận ĐÚNG khổ + chất lượng của lượt.
    const calls: { size: string; quality: string }[] = [];
    const imageClient: ImageEditClient = async (input) => {
      assertPixelSafe(input.images);
      calls.push({ size: input.size, quality: input.quality });
      return { bytes: fakeJpeg(100 + calls.length), contentType: "image/jpeg", usage: null, costUsd: 0.005 };
    };
    const d = await drawManualGen(db, { genId: s.genId, imageClient, limit: 2 });
    assert.equal(d.drawn, 2);
    assert.ok(calls.every((c) => c.size === "1088x1360" && c.quality === "low"), JSON.stringify(calls));

    // Tạo lại tương tự + câu lệnh + ý tưởng gần đây.
    const remix = await loadManualGenRemix(db, s.genId);
    assert.deepEqual(remix && { kind: remix.kind, idea: remix.idea, units: remix.units, styles: remix.styles, colors: remix.colors, size: remix.size, quality: remix.quality, photo: remix.productPhotoSourceId }, {
      kind: "MOCKUP",
      idea: "dạo phố Hội An",
      units: 2,
      styles: ["STUDIO", "UGC_SELFIE"],
      colors: ["Đỏ đô", "Đen"],
      size: "1088x1360",
      quality: "low",
      photo: `${P}photo`,
    });
    const pr = await loadManualGenImagePrompt(db, rows[3].id);
    assert.equal(pr?.prompt, rows[3].prompt);
    assert.equal(pr?.size, "1088x1360");
    const s2 = await startManualGen(db, { productPhotoSourceId: `${P}photo`, ownAdSourceId: null, idea: "đi làm công sở", count: 1 }, cfg, actor);
    assert.ok(s2.ok);
    const ideas = await listRecentIdeas(db, 20);
    assert.ok(ideas.indexOf("đi làm công sở") < ideas.indexOf("dạo phố Hội An") && ideas.indexOf("đi làm công sở") >= 0, "mới trước");
    assert.equal(ideas.filter((x) => x === "dạo phố Hội An").length, 1, "không trùng");
    if (s2.ok) {
      const [r2] = await db.select().from(schema.creativeManualGens).where(eq(schema.creativeManualGens.id, s2.genId));
      assert.equal(r2.size, "1024x1024", "không chọn khổ ⇒ khổ của cấu hình");
      const [img2] = await db.select().from(schema.creativeManualGenImages).where(eq(schema.creativeManualGenImages.genId, s2.genId));
      assert.equal(img2.color, "");
      assert.equal(img2.outputStyle, "AUTO");
    }
    console.log("✓ Studio tạo ảnh (CSDL): 2 × 2 × 2 = 8 ảnh đúng thứ tự, cùng bố cục giữ cùng gen ở hai màu · máy vẽ nhận đúng khổ + chất lượng · vượt trần không ghi gì · tạo lại tương tự · câu lệnh theo ảnh · ý tưởng gần đây");
  } finally {
    await cleanup(db);
  }
}

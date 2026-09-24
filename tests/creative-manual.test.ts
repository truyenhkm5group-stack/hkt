import assert from "node:assert/strict";
import { and, eq, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { CREATIVE_CONFIG_KEY, DEFAULT_CREATIVE_CONFIG, MANUAL_SLOT_BASE, normalizeCreativeConfig, type Genes } from "@/lib/constants/creative-loop";
import { shiftDay, vnDay } from "@/lib/constants/marketing-decision-ledger";
import { buildBatch } from "@/lib/creative/generate";
import { storeCreativeImage } from "@/lib/creative/images";
import { addManualVariant, isManualSeed, manualTargetDay, publishOrder } from "@/lib/creative/manual";
import { batchWindow } from "@/lib/creative/schedule";
import type { CopyWriter } from "@/lib/creative/writer";
import type { ImageEditClient } from "@/lib/integrations/openai/images";
import { manualCreativeInputSchema } from "@/lib/validation/creative";

/**
 * ═══════════ VÒNG MẪU — MẪU TỰ LÀM ═══════════
 *
 * Khoá (docs/creative-loop.md, "Mẫu tự làm"):
 *  1. Lô đích = lô gần nhất CÒN hạn duyệt (hàm thuần, mốc dựng từ chính hàm lịch — mục 50).
 *  2. Mẫu tự làm ĐĂNG TRƯỚC ô máy lập — trần số mẫu cắt ô máy trước.
 *  3. Chưa có lô ⇒ dựng sẵn "Chờ duyệt"; tới giờ dựng lô, máy lập PHẦN CÒN THIẾU và không đụng mẫu của người.
 *  4. Lô đã duyệt / quá hạn ⇒ không thêm được; sáu gen + mã hàng là bắt buộc.
 */

const P = "cm-";
const G: Genes = { angle: "PRICE_DEAL", scene: "STREET", model: "FEMALE_YOUNG", composition: "SINGLE_HERO", textOverlay: "PRICE_BADGE", palette: "VIVID" };

function fakeJpeg(tag: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, tag & 0xff, (tag >> 8) & 0xff, 7, 7, 7, 1, 2, 3]);
}

export function testCreativeManualPure() {
  // 1. Lô đích.
  const cfg = DEFAULT_CREATIVE_CONFIG;
  const d = "2026-10-01";
  const hanHomNay = batchWindow(d, cfg).approvalDeadline; // 05:30 ngày d
  assert.equal(manualTargetDay(new Date(hanHomNay.getTime() - 60_000), cfg), d, "trước 5:30 ⇒ lô HÔM NAY còn duyệt kịp");
  assert.equal(manualTargetDay(hanHomNay, cfg), shiftDay(d, 1), "đúng hạn là hết hạn ⇒ lô ngày mai");
  assert.equal(manualTargetDay(new Date(batchWindow(shiftDay(d, 1), cfg).buildFrom.getTime() + 3_600_000), cfg), shiftDay(d, 1), "15:00 ⇒ lô ngày mai");

  // 2. Thứ tự đăng.
  const order = publishOrder([
    { id: "a", mode: "EXPLORE", slot: 1 },
    { id: "m2", mode: "MANUAL", slot: MANUAL_SLOT_BASE + 2 },
    { id: "b", mode: "EXPLOIT", slot: 2 },
    { id: "m1", mode: "MANUAL", slot: MANUAL_SLOT_BASE + 1 },
  ]);
  assert.deepEqual(
    order.map((x) => x.id),
    ["m1", "m2", "a", "b"],
    "mẫu tự làm đăng trước, rồi theo số ô",
  );

  assert.equal(isManualSeed({ manualSeed: true }), true);
  assert.equal(isManualSeed({ manualSeed: true, slots: [] }), false, "đã lập phần còn thiếu thì không lập lại");
  assert.equal(isManualSeed({ slots: [] }), false);

  // 4. Lược đồ: đủ sáu gen + mã hàng.
  const ok = { productId: "p", primaryText: "Nội dung", headline: "Tiêu đề", note: "", genes: G, imageBase64: "AAAA" };
  assert.ok(manualCreativeInputSchema.safeParse(ok).success);
  assert.ok(!manualCreativeInputSchema.safeParse({ ...ok, productId: "" }).success, "thiếu mã hàng");
  assert.ok(!manualCreativeInputSchema.safeParse({ ...ok, genes: { ...G, scene: undefined } }).success, "thiếu một gen");
  assert.ok(!manualCreativeInputSchema.safeParse({ ...ok, genes: { ...G, scene: "coffee" } }).success, "gen ngoài từ vựng");
  assert.ok(!manualCreativeInputSchema.safeParse({ ...ok, headline: "x".repeat(41) }).success, "tiêu đề > 40 ký tự");
}

async function cleanup(db: Db, days: string[]) {
  const batches = await db.select({ id: schema.creativeBatches.id }).from(schema.creativeBatches).where(inArray(schema.creativeBatches.batchDay, days));
  const ids = batches.map((b) => b.id);
  if (ids.length) {
    await db.delete(schema.creativeVariants).where(inArray(schema.creativeVariants.batchId, ids));
    await db.delete(schema.creativeBatches).where(inArray(schema.creativeBatches.id, ids));
  }
  await db.delete(schema.creativeSources).where(like(schema.creativeSources.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
  await db.delete(schema.users).where(like(schema.users.id, `${P}%`));
}

export async function testCreativeManualDb(db: Db) {
  // Ngày lô xa trong tương lai; mọi mốc dựng từ CHÍNH hàm lịch (AGENTS.md mục 50).
  const day = shiftDay(vnDay(new Date()), 70);
  const w = batchWindow(day, DEFAULT_CREATIVE_CONFIG);
  const truocGioDung = new Date(w.buildFrom.getTime() - 2 * 3_600_000); // 12:00 hôm trước
  const sauGioDung = new Date(w.buildFrom.getTime() + 3_600_000); // 15:00 hôm trước
  const [prevCfg] = await db.select().from(schema.settings).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
  const cfg = normalizeCreativeConfig({ enabled: true, batchSize: 3, extraCandidates: 0, focusProductIds: [`${P}prod`] }).config;

  await cleanup(db, [day]);
  try {
    await db
      .insert(schema.settings)
      .values({ key: CREATIVE_CONFIG_KEY, value: JSON.stringify(cfg) })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(cfg) } });
    await db.insert(schema.users).values({ id: `${P}u`, email: `${P}u@t.local`, name: "Chủ shop thử", passwordHash: "x", role: "ADMIN" });
    await db.insert(schema.products).values({ id: `${P}prod`, name: "Đầm linen thử" });
    const photo = await storeCreativeImage(db, fakeJpeg(1));
    await db.insert(schema.creativeSources).values({ id: `${P}photo`, kind: "PRODUCT_PHOTO", productId: `${P}prod`, imageId: photo.id, title: "ảnh thật" });

    const actor = { id: `${P}u`, name: "Chủ shop thử" };
    const input = (tag: number) => ({ productId: `${P}prod`, genes: G, primaryText: "Đầm linen mặc mát", headline: "Mát cả ngày", note: "vẽ trên web", imageBytes: fakeJpeg(tag) });

    // 3a. Chưa có lô ⇒ dựng sẵn "Chờ duyệt", mẫu tự làm vào ô 1001, rồi 1002.
    const r1 = await addManualVariant(db, input(11), cfg, actor, truocGioDung);
    assert.ok(r1.ok && r1.batchDay === day && r1.slot === MANUAL_SLOT_BASE + 1 && r1.createdBatch);
    const r2 = await addManualVariant(db, input(12), cfg, actor, truocGioDung);
    assert.ok(r2.ok && r2.slot === MANUAL_SLOT_BASE + 2 && !r2.createdBatch);
    const [b0] = await db.select().from(schema.creativeBatches).where(eq(schema.creativeBatches.batchDay, day));
    assert.equal(b0.status, "PENDING_APPROVAL");
    assert.ok(isManualSeed(b0.plan));
    const manual = await db.select().from(schema.creativeVariants).where(and(eq(schema.creativeVariants.batchId, b0.id), eq(schema.creativeVariants.mode, "MANUAL")));
    assert.equal(manual.length, 2);
    assert.ok(manual.every((v) => v.status === "GENERATED" && v.createdByUserId === `${P}u` && v.createdByName === "Chủ shop thử"), "quy kết bằng khoá tài khoản + tên do máy chủ đọc (mục 34)");

    // 3b. Tới giờ dựng lô: máy chỉ lập PHẦN CÒN THIẾU = 3 − 2 = 1 ô, không đụng mẫu của người.
    let writerCalls = 0;
    let imageCalls = 0;
    const writer: CopyWriter = async () => {
      writerCalls += 1;
      return { imagePrompt: "p", primaryText: "Câu máy viết", headline: "Máy", model: "fake", costUsd: null, attempts: 1, priceStripped: false };
    };
    const imageClient: ImageEditClient = async () => {
      imageCalls += 1;
      return { bytes: fakeJpeg(100 + imageCalls), contentType: "image/jpeg", usage: null, costUsd: 0.04 };
    };
    const deps = { writer, imageClient, describe: async () => ({ ok: false as const, error: "bỏ qua" }), caption: async () => ({ ok: false as const, error: "không gọi mạng trong kiểm thử" }), perTick: 5 };
    await buildBatch(db, sauGioDung, deps);
    await buildBatch(db, sauGioDung, deps); // lượt chạy lại không lập thêm
    const all = await db.select().from(schema.creativeVariants).where(eq(schema.creativeVariants.batchId, b0.id));
    const ai = all.filter((v) => v.mode !== "MANUAL");
    assert.equal(ai.length, 1, "chỉ lập phần còn thiếu cho đủ lô, và chỉ một lần");
    assert.ok(ai[0].slot < MANUAL_SLOT_BASE, "ô máy lập nằm ở dải riêng");
    assert.equal(writerCalls, 1, "mẫu tự làm không qua máy viết");
    assert.equal(imageCalls, 1, "mẫu tự làm không qua máy vẽ ảnh");
    const manualAfter = all.filter((v) => v.mode === "MANUAL");
    assert.deepEqual(
      manualAfter.map((v) => [v.slot, v.status, v.primaryText]),
      manual.map((v) => [v.slot, "GENERATED", "Đầm linen mặc mát"]),
      "mẫu của người giữ nguyên",
    );
    const [b1] = await db.select().from(schema.creativeBatches).where(eq(schema.creativeBatches.id, b0.id));
    assert.equal(b1.status, "PENDING_APPROVAL");
    assert.ok(!isManualSeed(b1.plan), "đã lập phần còn thiếu");

    // 4. Lô đã duyệt ⇒ không thêm được.
    await db.update(schema.creativeBatches).set({ status: "APPROVED", approvedAt: sauGioDung, approvalDigest: "x" }).where(eq(schema.creativeBatches.id, b0.id));
    const r3 = await addManualVariant(db, input(13), cfg, actor, sauGioDung);
    assert.ok(!r3.ok && r3.error.includes("APPROVED"));
  } finally {
    await cleanup(db, [day]);
    if (prevCfg) await db.update(schema.settings).set({ value: prevCfg.value }).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
    else await db.delete(schema.settings).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
  }
  console.log("✓ Vòng mẫu — mẫu tự làm: vào lô còn hạn duyệt · dựng sẵn lô · máy chỉ lập phần còn thiếu · không qua máy viết/vẽ · lô đã duyệt thì chặn");
}

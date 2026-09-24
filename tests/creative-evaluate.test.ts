import assert from "node:assert/strict";
import { and, eq, inArray, like } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { CREATIVE_CONFIG_KEY, type CreativeRule } from "@/lib/constants/creative-loop";
import { shiftDay, vnDay } from "@/lib/constants/marketing-decision-ledger";
import { evaluateCreatives, stableJson, type NarrativeWriter } from "@/lib/creative/evaluate";
import { vnStartOfDay } from "@/lib/format";
import {
  getBatchDetail,
  getLatestLearning,
  getPendingBatch,
  listLibrary,
  listLiveVariants,
  listRecentBatches,
  listSources,
  variantMetrics,
} from "@/lib/queries/creative-loop";

/**
 * ═══════════ VÒNG MẪU — ĐO · CHẤM · CHỐT · HỌC TRÊN CSDL THẬT (PGlite) ═══════════
 *
 * Đặc tả: `docs/creative-loop.md` §4–§5. Khoá:
 *  · chưa có dòng chi cấp mẩu ⇒ số đo `null` (CHƯA BIẾT), không phải 0 — cả trong sổ phán quyết;
 *  · đơn huỷ / đơn chưa chốt không vào `bookedOrders`; hoàn theo `ORDER_OUTCOME` (gồm RETURNED_BY_RULE);
 *  · `WIN` chốt thư viện MỘT lần và không gỡ khi đơn giảm; `ENDED` khi quá `endAt`;
 *  · lệnh tắt chỉ theo luật tắt CỦA LÔ — luật thêm vào cấu hình sau khi duyệt không sinh lệnh tắt;
 *  · chạy lại cùng ngày không đẻ dòng phán quyết / dòng học thứ hai, không gọi lại mô hình;
 *  · không xoá ảnh của mẫu là CHA của mẫu đang chạy, không xoá ảnh sản phẩm thật;
 *  · hàm đọc cho màn hình trả dữ liệu thuần JSON, không kèm điểm ảnh.
 *
 * MỐC THỜI GIAN (AGENTS.md mục 50): mọi mốc tương đối với ĐỒNG HỒ THẬT, và cả ba lượt chấm dùng CÙNG
 * một `now` — không lượt nào được vắt qua nửa đêm để đẻ ra "ngày thứ hai".
 *
 * Dữ liệu mang tiền tố `ce-` / `CE-`, mã quảng cáo riêng — không lọt vào tổng của khối khác — và dọn
 * sạch trong `finally`.
 */

const P = "ce-";
const H = 3_600_000;
const D = 24 * H;

const G = { angle: "LIFESTYLE", scene: "CAFE", model: "FEMALE_YOUNG", composition: "SINGLE_HERO", textOverlay: "HEADLINE", palette: "WARM" };

const SNAP_KILL: CreativeRule = { metric: "messages", op: "lt", value: 1, minSpendVnd: 100_000, label: "Tiêu 100K không có tin nhắn" };
/** Luật tắt THÊM VÀO SAU khi lô đã duyệt — không được tự tắt mẫu của lô cũ. */
const LATE_KILL: CreativeRule = { metric: "clicks", op: "lt", value: 10, minSpendVnd: 100_000, label: "Luật thêm sau duyệt" };
const KEEP: CreativeRule = { metric: "orders", op: "gte", value: 1, minSpendVnd: 0, label: "Có ít nhất 1 đơn" };

async function cleanup(db: Db) {
  const v = schema.creativeVariants;
  const ids = (await db.select({ id: v.id }).from(v).where(like(v.id, `${P}%`))).map((r) => r.id);
  if (ids.length) {
    await db.delete(schema.creativeVerdicts).where(inArray(schema.creativeVerdicts.variantId, ids));
    // Lượt chấm chèn ĐỀ NGHỊ scale cho mẫu THẮNG / HỨA HẸN (§5f) — dọn trước khi xoá mẫu (khoá ngoại).
    await db.delete(schema.creativeScaleDrafts).where(inArray(schema.creativeScaleDrafts.variantId, ids));
    await db.delete(schema.creativeFbActions).where(inArray(schema.creativeFbActions.variantId, ids));
    await db.update(v).set({ parentVariantId: null }).where(inArray(v.id, ids));
    await db.delete(v).where(inArray(v.id, ids));
  }
  await db.delete(schema.creativeBatches).where(like(schema.creativeBatches.id, `${P}%`));
  await db.delete(schema.creativeSources).where(like(schema.creativeSources.id, `${P}%`));
  await db.delete(schema.creativeImages).where(like(schema.creativeImages.id, `${P}%`));
  const orderIds = (await db.select({ id: schema.orders.id }).from(schema.orders).where(like(schema.orders.id, `${P}%`))).map((r) => r.id);
  if (orderIds.length) {
    await db.delete(schema.shipments).where(inArray(schema.shipments.orderId, orderIds));
    await db.delete(schema.orders).where(inArray(schema.orders.id, orderIds));
  }
  await db.delete(schema.adSpends).where(like(schema.adSpends.adId, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
}

export async function testCreativeEvaluate(db: Db) {
  const now = new Date();
  const L = schema.creativeLearnings;
  const learningDay = vnDay(now);
  const [prevSetting] = await db.select().from(schema.settings).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
  const [prevLearning] = await db.select({ id: L.id }).from(L).where(eq(L.learningDay, learningDay));
  assert.equal(prevLearning, undefined, "khối kiểm thử cần ngày học hôm nay còn trống");

  await cleanup(db);
  try {
    // ─────────── CẤU HÌNH HIỆN TẠI: luật giữ + một luật TẮT thêm sau duyệt ───────────
    const currentCfg = { killRules: [LATE_KILL], keepRules: [KEEP], winOrdersAbove: 3, verdictSettleHours: 24, loserImageRetentionDays: 7 };
    await db
      .insert(schema.settings)
      .values({ key: CREATIVE_CONFIG_KEY, value: JSON.stringify(currentCfg) })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(currentCfg) } });

    await db.insert(schema.products).values({ id: `${P}prod-1`, name: "Váy thử vòng mẫu" });
    await db.insert(schema.creativeImages).values([
      { id: `${P}img-photo`, sha256: "ce-photo", data: "cGhvdG8=" },
      { id: `${P}img-old`, sha256: "ce-old", data: "b2xk" },
      { id: `${P}img-parent`, sha256: "ce-parent", data: "cGFyZW50" },
      { id: `${P}img-win`, sha256: "ce-win", data: "d2lu" },
      { id: `${P}img-pending`, sha256: "ce-pending", data: "cGVuZGluZw==" },
    ]);
    await db.insert(schema.creativeSources).values({ id: `${P}src-photo`, kind: "PRODUCT_PHOTO", productId: `${P}prod-1`, title: "Ảnh váy thật", imageId: `${P}img-photo` });

    // ─────────── BA LÔ ĐÃ CHẠY + MỘT LÔ CHỜ DUYỆT, mốc tương đối với đồng hồ thật ───────────
    const startA = new Date(now.getTime() - 3 * D);
    const startB = new Date(now.getTime() - 1 * H);
    const startC = new Date(now.getTime() - 30 * D);
    const startD = new Date(now.getTime() + 26 * H);
    const batch = (id: string, start: Date, status: string, snapshot: Record<string, unknown>) => ({
      id: `${P}${id}`,
      batchDay: vnDay(start),
      status,
      slotCount: 3,
      startAt: start,
      endAt: new Date(start.getTime() + D),
      approvalDeadline: new Date(start.getTime() - 30 * 60_000),
      configSnapshot: snapshot,
      ruleVersion: 1,
      ...(status === "PUBLISHED" ? { approvedAt: new Date(start.getTime() - H), approvalDigest: "ce-digest" } : {}),
    });
    await db.insert(schema.creativeBatches).values([
      batch("batch-a", startA, "PUBLISHED", {}),
      batch("batch-b", startB, "PUBLISHED", { killRules: [SNAP_KILL] }),
      batch("batch-c", startC, "PUBLISHED", {}),
      batch("batch-d", startD, "PENDING_APPROVAL", { killRules: [SNAP_KILL], budgetPerVariantVnd: 200_000 }),
    ]);

    const variant = (id: string, batchId: string, slot: number, extra: Partial<typeof schema.creativeVariants.$inferInsert>) => ({
      id: `${P}${id}`,
      batchId: `${P}${batchId}`,
      slot,
      mode: "EXPLORE",
      productId: `${P}prod-1`,
      genes: G as Record<string, string>,
      genesVersion: 1,
      ...extra,
    });
    const old = new Date(now.getTime() - 20 * D);
    await db.insert(schema.creativeVariants).values([
      // Lô C (30 ngày trước): ba mẫu thua đã lâu.
      variant("v-old-lost", "batch-c", 1, { status: "ENDED", fbAdId: `${P}ad-old-lost`, fbAdsetId: `${P}as-old-lost`, imageId: `${P}img-old`, lostAt: old, genes: {} }),
      variant("v-old-parent", "batch-c", 2, { status: "ENDED", fbAdId: `${P}ad-old-parent`, fbAdsetId: `${P}as-old-parent`, imageId: `${P}img-parent`, lostAt: old, genes: {} }),
      variant("v-old-photo", "batch-c", 3, { status: "ENDED", fbAdId: `${P}ad-old-photo`, fbAdsetId: `${P}as-old-photo`, imageId: `${P}img-photo`, lostAt: old, genes: {} }),
      // Lô A (3 ngày trước): đã hết khung và qua 24 giờ đợi đơn.
      variant("v-win", "batch-a", 1, { status: "LIVE", fbAdId: `${P}ad-win`, fbAdsetId: `${P}as-win`, imageId: `${P}img-win`, productPhotoSourceId: `${P}src-photo` }),
      variant("v-lose", "batch-a", 2, { status: "ENDED", fbAdId: `${P}ad-lose`, fbAdsetId: `${P}as-lose`, genes: { ...G, scene: "STREET" } }),
      // Lô B (đang chạy).
      variant("v-kill", "batch-b", 1, { status: "LIVE", fbAdId: `${P}ad-kill`, fbAdsetId: `${P}as-kill`, productPhotoSourceId: `${P}src-photo`, genes: { ...G, palette: "COOL" } }),
      variant("v-new", "batch-b", 2, { status: "LIVE", fbAdId: `${P}ad-new`, fbAdsetId: `${P}as-new`, mode: "EXPLOIT", parentVariantId: `${P}v-old-parent` }),
      variant("v-nospend", "batch-b", 3, { status: "LIVE", fbAdId: `${P}ad-nospend`, fbAdsetId: `${P}as-nospend`, genes: { scene: "CAFE" } }),
      // Lô D (chờ duyệt).
      variant("v-pending", "batch-d", 1, { status: "GENERATED", imageId: `${P}img-pending`, headline: "Váy mới" }),
    ]);

    // ─────────── CHI HẠT AD ───────────
    const spend = (adId: string, day: string, amount: number, extra: Partial<typeof schema.adSpends.$inferInsert> = {}) => ({
      platform: "FACEBOOK",
      campaign: "CE test",
      campaignId: "ce-camp",
      grain: "AD",
      adId: `${P}${adId}`,
      adsetId: `${P}as-${adId}`,
      spend: amount,
      spendDate: vnStartOfDay(day),
      createdBy: "test",
      ...extra,
    });
    const dayA = vnDay(startA);
    const dayB = vnDay(startB);
    await db.insert(schema.adSpends).values([
      spend("ad-kill", dayB, 150_000, { impressions: 5_000, clicks: 20, messages: 0 }),
      // TRƯỚC ngày chạy ⇒ ngoài mốc; và dòng `excluded` ⇒ không phải tiền của shop.
      spend("ad-kill", shiftDay(dayB, -2), 999_999, { impressions: 1, clicks: 1, messages: 1 }),
      spend("ad-kill", dayB, 777_777, { excluded: true, externalKey: "ce-excluded" }),
      spend("ad-new", dayB, 150_000, { impressions: 5_000, clicks: 3, messages: 5 }),
      spend("ad-win", dayA, 180_000, { impressions: 8_000, clicks: 50, messages: 10 }),
      spend("ad-win", shiftDay(dayA, 1), 20_000, { impressions: 1_000, clicks: 5, messages: 1 }),
      spend("ad-lose", dayA, 200_000, { impressions: 9_000, clicks: 40, messages: 2 }),
    ]);

    // ─────────── ĐƠN THEO ad_id ───────────
    const order = async (id: string, stage: string, ship: { stage: string; collected: number } | null) => {
      await db.insert(schema.orders).values({ id: `${P}${id}`, stage: stage as never, adId: `${P}ad-win`, cod: 400_000, totalPriceAfterDiscount: 400_000, prepaid: 0, insertedAt: new Date(startA.getTime() + 2 * H) });
      if (ship) {
        await db.insert(schema.shipments).values({
          orderId: `${P}${id}`,
          vtpOrderNumber: `CE-${id}`,
          trackingCode: `CE-${id}`,
          stage: ship.stage as never,
          codAmount: 400_000,
          codCollected: ship.collected,
        });
      }
    };
    await order("o-delivered", "SHIPPED", { stage: "DELIVERED", collected: 400_000 });
    await order("o-returned", "SHIPPED", { stage: "RETURNED", collected: 0 });
    await order("o-rule", "SHIPPED", { stage: "DELIVERED", collected: 80_000 });
    await order("o-open", "CONFIRMED", null);
    await order("o-cancelled", "CANCELLED", null);
    await order("o-new", "NEW", null);

    // ═══════════ 1. SỐ ĐO ═══════════
    const m = await variantMetrics(db, [
      { id: "kill", fbAdId: `${P}ad-kill`, startAt: startB },
      { id: "win", fbAdId: `${P}ad-win`, startAt: startA },
      { id: "nospend", fbAdId: `${P}ad-nospend`, startAt: startB },
      { id: "unpublished", fbAdId: null, startAt: null },
    ]);
    const mk = m.get("kill");
    assert.ok(mk);
    assert.equal(mk.spendVnd, 150_000, "chỉ dòng hạt AD, từ ngày chạy, không `excluded`");
    assert.equal(mk.messages, 0, "0 tin nhắn THẬT (có dòng chi) là 0, không phải null");
    assert.equal(mk.spendDays, 1);
    const mw = m.get("win");
    assert.ok(mw);
    assert.equal(mw.spendVnd, 200_000);
    assert.equal(mw.spendDays, 2);
    assert.equal(mw.lastSpendDate, shiftDay(dayA, 1));
    assert.equal(mw.bookedOrders, 4, "đơn huỷ và đơn NEW chưa chốt KHÔNG vào đơn chốt");
    assert.equal(mw.deliveredOrders, 1);
    assert.equal(mw.returnedOrders, 2, "hoàn = RETURNED + RETURNED_BY_RULE theo ORDER_OUTCOME");
    for (const k of ["nospend", "unpublished"]) {
      const x = m.get(k);
      assert.ok(x);
      assert.deepEqual([x.spendVnd, x.impressions, x.clicks, x.messages, x.lastSpendDate], [null, null, null, null, null], `${k}: chưa có dòng chi ⇒ CHƯA BIẾT, không phải 0`);
      assert.equal(x.spendDays, 0);
    }

    // ═══════════ 2. LƯỢT CHẤM ĐẦU ═══════════
    let calls = 0;
    const stub: NarrativeWriter = async (input) => {
      calls += 1;
      assert.ok(input.observations > 0);
      return { text: "Bản tin thử: bối cảnh quán cà phê đang nhỉnh hơn.", model: "stub" };
    };
    const r1 = await evaluateCreatives(db, now, { writeNarrative: stub });
    assert.equal(r1.judged, 8, "3 mẫu lô C + 2 lô A + 3 lô B; mẫu chờ duyệt không được chấm");
    assert.deepEqual(
      r1.kills.map((k) => [k.variantId, k.adsetId, k.rule.label]),
      [[`${P}v-kill`, `${P}as-kill`, SNAP_KILL.label]],
      "lệnh tắt CHỈ theo luật của lô — luật thêm sau duyệt (clicks < 10) không tắt v-new",
    );
    assert.deepEqual(r1.ended, [`${P}v-win`], "LIVE quá endAt ⇒ ENDED");
    assert.deepEqual(r1.newWins, [`${P}v-win`]);
    assert.deepEqual(r1.losses, [`${P}v-lose`]);
    assert.deepEqual(r1.purged.sort(), [`${P}v-old-lost`], "chỉ xoá ảnh mẫu thua quá hạn, không phải cha của mẫu đang chạy, không phải ảnh sản phẩm thật");
    assert.deepEqual(r1.learning, { observations: 3, relative: 0 }, "WIN + LOSE + KILL; mẫu đang chạy và mẫu thiếu gen không dạy gì");
    assert.equal(calls, 1);

    const vrow = async (id: string) => {
      const [row] = await db.select().from(schema.creativeVariants).where(eq(schema.creativeVariants.id, `${P}${id}`));
      assert.ok(row);
      return row;
    };
    const win1 = await vrow("v-win");
    assert.equal(win1.status, "ENDED");
    assert.equal(win1.libraryAt?.getTime(), now.getTime());
    assert.equal(win1.libraryOrders, 4);
    assert.equal((await vrow("v-lose")).lostAt?.getTime(), now.getTime());
    assert.equal((await vrow("v-kill")).status, "LIVE", "lượt chấm KHÔNG tự tắt — gói C thực thi lệnh tắt");

    const imgs = async () => new Map((await db.select({ id: schema.creativeImages.id, purgedAt: schema.creativeImages.purgedAt, data: schema.creativeImages.data }).from(schema.creativeImages).where(like(schema.creativeImages.id, `${P}%`))).map((r) => [r.id, r]));
    const i1 = await imgs();
    assert.ok(i1.get(`${P}img-old`)?.purgedAt, "ảnh mẫu thua 20 ngày bị xoá điểm ảnh");
    assert.equal(i1.get(`${P}img-old`)?.data, "");
    assert.equal(i1.get(`${P}img-parent`)?.purgedAt, null, "ảnh CHA của mẫu đang LIVE được giữ");
    assert.equal(i1.get(`${P}img-photo`)?.purgedAt, null, "ảnh sản phẩm thật KHÔNG BAO GIỜ bị xoá");

    const verdicts = async () => db.select().from(schema.creativeVerdicts).where(like(schema.creativeVerdicts.variantId, `${P}%`));
    const vd1 = await verdicts();
    assert.equal(vd1.length, 8);
    const byId = new Map(vd1.map((x) => [x.variantId, x]));
    assert.equal(byId.get(`${P}v-kill`)?.verdict, "KILL");
    assert.equal(byId.get(`${P}v-new`)?.verdict, "RUNNING", "luật tắt mới không áp cho lô đã duyệt");
    assert.equal(byId.get(`${P}v-win`)?.verdict, "WIN");
    assert.equal(byId.get(`${P}v-lose`)?.verdict, "LOSE");
    const noSpendMetrics = byId.get(`${P}v-nospend`)?.metrics as Record<string, unknown> | undefined;
    assert.equal(noSpendMetrics?.spendVnd, null, "sổ phán quyết giữ null là null");
    assert.equal(noSpendMetrics?.messages, null);
    assert.equal(byId.get(`${P}v-nospend`)?.verdict, "RUNNING");

    const learnRows1 = await db.select().from(L).where(eq(L.learningDay, learningDay));
    assert.equal(learnRows1.length, 1);
    assert.equal(learnRows1[0].observations, 3);
    assert.equal(learnRows1[0].relativeObservations, 0);
    assert.equal(learnRows1[0].narrativeModel, "stub");
    assert.ok(learnRows1[0].narrative.length > 0);

    // ═══════════ 3. CHẠY LẠI — LŨY ĐẲNG ═══════════
    const r2 = await evaluateCreatives(db, now, { writeNarrative: stub });
    assert.deepEqual([r2.newWins, r2.losses, r2.ended, r2.purged], [[], [], [], []], "lượt thứ hai không chốt / chuyển / xoá lại gì");
    assert.equal(r2.kills.length, 1, "lệnh tắt vẫn còn cho tới khi gói C tắt thật (lệnh tắt là lũy đẳng)");
    assert.equal((await verdicts()).length, 8, "không đẻ dòng phán quyết thứ hai trong cùng ngày");
    assert.equal((await db.select().from(L).where(eq(L.learningDay, learningDay))).length, 1, "không đẻ dòng học thứ hai");
    assert.equal(calls, 1, "bảng gen không đổi ⇒ không gọi lại mô hình");
    assert.equal(stableJson({ b: 1, a: [2, { d: 3, c: null }] }), stableJson({ a: [2, { c: null, d: 3 }], b: 1 }));

    // ═══════════ 4. ĐƠN GIẢM SAU KHI THẮNG + BẢN TIN HỎNG ═══════════
    await db.update(schema.orders).set({ stage: "CANCELLED", updatedAt: new Date() }).where(eq(schema.orders.id, `${P}o-open`));
    const broken: NarrativeWriter = async () => {
      throw new Error("mô hình hỏng");
    };
    const r3 = await evaluateCreatives(db, now, { writeNarrative: broken });
    assert.ok(r3.warnings.some((w) => w.includes("mô hình hỏng")), "bản tin hỏng thành cảnh báo, KHÔNG chặn lượt chấm");
    const win3 = await vrow("v-win");
    assert.equal(win3.libraryAt?.getTime(), now.getTime(), "WIN chốt một lần, không gỡ, không dời mốc");
    assert.equal(win3.libraryOrders, 4, "số đơn lúc vào thư viện không bị ghi đè");
    const vWin3 = (await verdicts()).find((x) => x.variantId === `${P}v-win`);
    assert.equal(vWin3?.verdict, "WIN", "3 đơn không còn vượt ngưỡng 3 — nhưng mẫu đã vào thư viện thì không tự rơi ra");
    assert.ok((vWin3?.reasons ?? []).some((x) => x.includes("Hiện đếm được 3 đơn chốt")), "màn hình phải nói số đơn hiện tại đã tụt");
    assert.equal((vWin3?.metrics as Record<string, unknown>).bookedOrders, 3, "sổ phán quyết mang số đơn HIỆN TẠI");
    const [learn3] = await db.select().from(L).where(eq(L.learningDay, learningDay));
    assert.equal(learn3.narrative, "", "bảng đã đổi mà bản tin viết hỏng ⇒ rỗng, không giữ bản tin của bảng cũ");

    // ═══════════ 5. HÀM ĐỌC CHO MÀN HÌNH ═══════════
    const json = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
    const pending = await getPendingBatch(db);
    assert.ok(pending);
    assert.equal(pending.batch.id, `${P}batch-d`);
    assert.equal(pending.variants.length, 1);
    assert.equal(pending.variants[0].imageAvailable, true);
    assert.ok(!("data" in pending.variants[0]), "không kèm dữ liệu ảnh");
    assert.deepEqual(pending.config.killRules, [SNAP_KILL], "người duyệt thấy đúng luật tắt đã chụp vào lô");
    assert.equal(pending.committedIfApprovedVnd, 200_000);
    assert.deepEqual(json(pending), pending, "thuần JSON — không có Date lẫn vào");

    const detail = await getBatchDetail(db, `${P}batch-b`, now);
    assert.ok(detail);
    assert.equal(detail.judged.length, 3);
    assert.equal(detail.judged.find((x) => x.id === `${P}v-kill`)?.verdict, "KILL");
    assert.deepEqual(json(detail), detail);
    assert.equal(await getBatchDetail(db, `${P}khong-co`, now), null);

    const recent = await listRecentBatches(db, 50);
    const rb = recent.find((x) => x.id === `${P}batch-b`);
    assert.deepEqual(rb?.variantCounts, { LIVE: 3 });

    const live = await listLiveVariants(db, now);
    const liveIds = live.map((x) => x.id).filter((id) => id.startsWith(P)).sort();
    assert.deepEqual(liveIds, [`${P}v-kill`, `${P}v-lose`, `${P}v-new`, `${P}v-nospend`, `${P}v-win`].sort(), "14 ngày gần nhất: lô A + B, không lô C, không mẫu chờ duyệt");
    const liveNew = live.find((x) => x.id === `${P}v-new`);
    assert.equal(liveNew?.verdict, "RUNNING");
    assert.equal(live.find((x) => x.id === `${P}v-nospend`)?.metrics.spendVnd, null);
    assert.deepEqual(json(live), live);

    const lib = await listLibrary(db);
    const lw = lib.find((x) => x.id === `${P}v-win`);
    assert.ok(lw);
    assert.equal(lw.libraryOrders, 4);
    assert.equal(lw.bookedOrders, 3, "thư viện in số đơn HIỆN TẠI cạnh số lúc vào");
    assert.equal(lw.returnedOrders, 2);

    const learning = await getLatestLearning(db);
    assert.ok(learning);
    assert.equal(learning.learningDay, learningDay);
    assert.equal(learning.series.length, 14);
    assert.equal(learning.series[13].observations, 3);
    assert.equal(learning.series[0].observations, null, "ngày không có lượt học là null, không phải 0");
    assert.ok(learning.geneStats.some((s) => s.key === "scene" && s.value === "CAFE" && s.tests === 2));

    const sources = await listSources(db, {});
    const src = sources.find((x) => x.id === `${P}src-photo`);
    assert.ok(src);
    assert.equal(src.usedCount, 2);
    assert.equal(src.imageAvailable, true);
    assert.equal(src.productName, "Váy thử vòng mẫu");
    assert.equal((await listSources(db, { kind: "SPY" })).filter((x) => x.id.startsWith(P)).length, 0);
    assert.deepEqual(json(sources), sources);

    console.log(
      `✓ Vòng mẫu — đo/chấm/học: ${r1.judged} mẫu · tắt ${r1.kills.length} (chỉ luật của lô) · thắng ${r1.newWins.length} · thua ${r1.losses.length} · ` +
        `xoá ảnh ${r1.purged.length} · ${r1.learning.observations} quan sát · chạy lại không đẻ dòng mới`,
    );
  } finally {
    await db.delete(L).where(and(eq(L.learningDay, learningDay)));
    await cleanup(db);
    if (prevSetting) await db.update(schema.settings).set({ value: prevSetting.value }).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
    else await db.delete(schema.settings).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
  }
}

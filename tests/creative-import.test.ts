import assert from "node:assert/strict";
import { and, eq, inArray, isNotNull, like, or } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { CREATIVE_CONFIG_KEY, DEFAULT_CREATIVE_CONFIG, GENE_KEYS, OWN_AD_IMPORT, classifyOwnAd, parseOwnAdMetrics, type Genes } from "@/lib/constants/creative-loop";
import { shiftDay, vnDay } from "@/lib/constants/marketing-decision-ledger";
import { buildBatch } from "@/lib/creative/generate";
import { sha256Hex, storeCreativeImage } from "@/lib/creative/images";
import { downloadImage, importOwnAds, importPancakeProductPhotos, pickOwnAdContent, type OwnAdGraph } from "@/lib/creative/import";
import { planBatch } from "@/lib/creative/plan";
import { batchWindow } from "@/lib/creative/schedule";
import type { CopyWriter } from "@/lib/creative/writer";
import { vnStartOfDay } from "@/lib/format";
import type { ImageEditClient } from "@/lib/integrations/openai/images";
import { listOwnAdCandidates } from "@/lib/queries/creative-own-ads";
import { loadPlanInputs, loadWinningExamples } from "@/lib/queries/creative-plan";

/**
 * ═══════════ VÒNG MẪU — NHẬP NGUỒN ẢNH CÓ SẴN (PANCAKE · FACEBOOK) ═══════════
 *
 * Khoá:
 *  (1) Nhập ảnh Pancake: LŨY ĐẲNG theo (mã, URL) · mã đã gỡ / không ảnh bị bỏ · ảnh lỗi không làm hỏng
 *      cả lượt và mang lý do.
 *  (2) Lọc ứng viên đúng ngưỡng: một mẩu tốt, một mẩu đắt, một mẩu ít tin, một mẩu cũ, một mẩu chi ít,
 *      một mẩu THẮNG theo đơn — đơn đếm bằng CHÍNH `variantMetrics` của vòng.
 *  (3) Nhập Facebook với Graph GIẢ: image_url · link_data.picture · image_hash · video bị bỏ · mẩu không
 *      đạt bị bỏ · LŨY ĐẲNG theo `fb_ad_id` · suy mã hàng từ dòng đơn, rồi từ `ad_spends`, không có thì nói ra.
 *  (4) `planBatch` dùng `OWN_AD` đủ gen làm MẪU CHA (đổi đúng một gen, nguồn ghi vào `inspiration_source_id`);
 *      `OWN_AD` thiếu gen là nguồn cảm hứng ĐỨNG TRƯỚC; câu chữ của nó tới người viết.
 *  (5) Đường điểm ảnh: ảnh `OWN_AD` cùng mã được gửi (nhãn `OWN_VARIANT`), ảnh SPY / MANUAL — kể cả cùng
 *      mã — và `OWN_AD` khác mã KHÔNG BAO GIỜ.
 *
 * Không gọi mạng: tải ảnh qua `fetchImpl` giả, Graph qua `OwnAdGraph` giả, sinh ảnh qua client giả.
 * Mốc từ đồng hồ thật (AGENTS.md mục 50): dòng chi đặt lùi N ngày so với HÔM NAY, lô là NGÀY MAI.
 */

const P = "ci-";
const G: Genes = { angle: "SOCIAL_PROOF", scene: "STREET", model: "FEMALE_YOUNG", composition: "SINGLE_HERO", textOverlay: "PRICE_BADGE", palette: "WARM" };
const AD = { good: "990000000001", pricey: "990000000002", fewMsg: "990000000003", win: "990000000004", old: "990000000005", lowSpend: "990000000006", video: "990000000007", hash: "990000000008" } as const;
const ALL_ADS = Object.values(AD) as string[];
const WIN_ABOVE = 2;

function fakeJpeg(tag: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, tag & 0xff, (tag >> 8) & 0xff, 7, 7, 7, 7, 7, 7, 7, 7, 9, 9]);
}

/** Máy chủ ảnh giả: URL có trong bảng ⇒ trả byte; không có ⇒ 404. Đếm số lần được gọi. */
function fakeFetch(table: Record<string, Uint8Array>) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const bytes = table[url];
    if (!bytes) return new Response("không có", { status: 404 });
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Response(copy.buffer, { status: 200, headers: { "content-type": "image/jpeg" } });
  }) as typeof fetch;
  return { impl, calls };
}

// ───────────────────────────── hàm thuần ─────────────────────────────

export function testCreativeImportPure() {
  const L = OWN_AD_IMPORT;
  // Ngưỡng: chủ shop nêu 24/09/2026 — chi / tin < 4.000đ, ≥ 5 tin, đã chi ≥ 50.000đ; THẮNG khi đơn VƯỢT ngưỡng.
  assert.equal(L.goodCostPerMessageBelowVnd, 4_000);
  assert.equal(L.minMessages, 5);
  assert.equal(L.goodMinSpendVnd, 50_000);
  assert.equal(L.lookbackDays, 60);
  assert.equal(classifyOwnAd({ spendVnd: 60_000, messages: 20, bookedOrders: 0 }, 100), "GOOD");
  assert.equal(classifyOwnAd({ spendVnd: 80_000, messages: 20, bookedOrders: 0 }, 100), null, "đúng 4.000đ / tin KHÔNG phải dưới 4.000đ");
  assert.equal(classifyOwnAd({ spendVnd: 50_000, messages: 13, bookedOrders: 0 }, 100), "GOOD", "đúng 50.000đ là đủ sàn chi");
  assert.equal(classifyOwnAd({ spendVnd: 49_999, messages: 20, bookedOrders: 0 }, 100), null, "chi ít hơn sàn ⇒ rẻ chưa chứng minh được gì");
  assert.equal(classifyOwnAd({ spendVnd: 10_000, messages: 4, bookedOrders: 500 }, 100), null, "dưới 5 tin nhắn ⇒ không xét, kể cả nhiều đơn");
  assert.equal(classifyOwnAd({ spendVnd: 900_000, messages: 5, bookedOrders: 101 }, 100), "WIN");
  assert.equal(classifyOwnAd({ spendVnd: 900_000, messages: 5, bookedOrders: 100 }, 100), null, "THẮNG là VƯỢT ngưỡng, không phải bằng");
  assert.equal(classifyOwnAd({ spendVnd: null, messages: 50, bookedOrders: 0 }, 100), null, "không có số chi ⇒ CHƯA BIẾT, không phải rẻ");
  assert.deepEqual(parseOwnAdMetrics({ spendVnd: "nhiều", bookedOrders: 3, reason: "BOGUS" }).spendVnd, null, "số hỏng ⇒ null, không phải 0");
  assert.equal(parseOwnAdMetrics({}).reason, null);

  // Bóc nội dung quảng cáo.
  const one = pickOwnAdContent({ name: "QC", account_id: "act_555666", creative: { image_url: "https://x/1.jpg", body: "Câu chữ", title: "Tiêu đề" } });
  assert.ok(one.ok && one.imageUrl === "https://x/1.jpg" && one.primaryText === "Câu chữ" && one.headline === "Tiêu đề" && one.accountId === "555666");
  const link = pickOwnAdContent({ creative: { object_story_spec: { link_data: { picture: "https://x/2.jpg", message: "Tin", name: "Tên" } } } });
  assert.ok(link.ok && link.imageUrl === "https://x/2.jpg" && link.primaryText === "Tin" && link.headline === "Tên");
  const photo = pickOwnAdContent({ creative: { object_story_spec: { photo_data: { url: "https://x/3.jpg", caption: "Chú thích" } } } });
  assert.ok(photo.ok && photo.imageUrl === "https://x/3.jpg" && photo.primaryText === "Chú thích");
  const hashOnly = pickOwnAdContent({ creative: { image_hash: "h1" } });
  assert.ok(hashOnly.ok && hashOnly.imageUrl === null && hashOnly.imageHash === "h1");
  const reasons = [
    pickOwnAdContent({ creative: { image_url: "https://x/t.jpg", object_story_spec: { video_data: { video_id: "1" } } } }),
    pickOwnAdContent({ creative: { object_story_spec: { link_data: { child_attachments: [{ picture: "a" }, { picture: "b" }] } } } }),
    pickOwnAdContent({ creative: { image_url: "https://x/d.jpg", asset_feed_spec: { images: [{ hash: "a" }] } } }),
    pickOwnAdContent({ creative: { thumbnail_url: "https://x/thumb.jpg" } }),
    pickOwnAdContent({}),
  ].map((r) => (r.ok ? "OK" : r.reason));
  assert.match(reasons[0], /video/i, "video bị bỏ dù có image_url (ảnh bìa video không phải thứ đã bán)");
  assert.match(reasons[1], /băng chuyền/);
  assert.match(reasons[2], /động/);
  assert.match(reasons[3], /thu nhỏ/, "ảnh thu nhỏ không làm nguồn");
  assert.notEqual(reasons[4], "OK");
  console.log("✓ Vòng mẫu · nhập mẫu tốt: ngưỡng 4.000đ/tin · 5 tin · 50.000đ · THẮNG là VƯỢT · CHƯA BIẾT không phải rẻ · chỉ nhận quảng cáo một ảnh");
}

// ───────────────────────────── dọn ─────────────────────────────

async function cleanup(db: Db, batchDay: string) {
  const [b] = await db.select({ id: schema.creativeBatches.id }).from(schema.creativeBatches).where(eq(schema.creativeBatches.batchDay, batchDay));
  const imageIds: string[] = [];
  if (b) {
    const vs = await db.select({ imageId: schema.creativeVariants.imageId }).from(schema.creativeVariants).where(eq(schema.creativeVariants.batchId, b.id));
    imageIds.push(...vs.map((v) => v.imageId).filter((x): x is string => Boolean(x)));
    await db.delete(schema.creativeVariants).where(eq(schema.creativeVariants.batchId, b.id));
    await db.delete(schema.creativeBatches).where(eq(schema.creativeBatches.id, b.id));
  }
  const srcCond = or(like(schema.creativeSources.productId, `${P}%`), inArray(schema.creativeSources.fbAdId, ALL_ADS), like(schema.creativeSources.title, `${P}%`));
  const srcs = await db.select({ imageId: schema.creativeSources.imageId }).from(schema.creativeSources).where(srcCond);
  imageIds.push(...srcs.map((s) => s.imageId).filter((x): x is string => Boolean(x)));
  await db.delete(schema.creativeSources).where(srcCond);
  if (imageIds.length) await db.delete(schema.creativeImages).where(inArray(schema.creativeImages.id, imageIds));
  await db.delete(schema.adSpends).where(eq(schema.adSpends.createdBy, `${P}test`));
  await db.delete(schema.orderItems).where(like(schema.orderItems.id, `${P}%`));
  await db.delete(schema.orders).where(like(schema.orders.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
}

// ───────────────────────────── CSDL ─────────────────────────────

export async function testCreativeImportDb(db: Db) {
  const realNow = new Date();
  const today = vnDay(realNow);
  const batchDay = shiftDay(today, 1);
  const w = batchWindow(batchDay, DEFAULT_CREATIVE_CONFIG);
  // 14:01 giờ VN của HÔM NAY — cùng ngày Việt Nam với `created_at` mà CSDL ghi (trần ảnh / ngày).
  const buildNow = new Date(w.buildFrom.getTime() + 60_000);
  const [prevCfg] = await db.select().from(schema.settings).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
  await cleanup(db, batchDay);

  try {
    // ═══════════ 1. ẢNH SẢN PHẨM TỪ PANCAKE ═══════════
    await db.insert(schema.products).values([
      { id: `${P}prod-1`, name: `${P}Đầm hoa`, image: "https://pancake.test/ci-1.jpg" },
      { id: `${P}prod-2`, name: `${P}Áo lụa`, image: "https://pancake.test/ci-2-hong.jpg" },
      { id: `${P}prod-3`, name: `${P}Mã đã gỡ`, image: "https://pancake.test/ci-3.jpg", isRemoved: true },
      { id: `${P}prod-4`, name: `${P}Không ảnh` },
      { id: `${P}prod-5`, name: `${P}Không phải ảnh`, image: "https://pancake.test/ci-5.html" },
    ]);
    const pancakeBytes = fakeJpeg(1);
    const pancake = fakeFetch({ "https://pancake.test/ci-1.jpg": pancakeBytes, "https://pancake.test/ci-3.jpg": fakeJpeg(3), "https://pancake.test/ci-5.html": new TextEncoder().encode("<html>đăng nhập</html>") });
    const actor = { id: null, name: "Máy thử" };
    const r1 = await importPancakeProductPhotos(db, actor, { fetchImpl: pancake.impl, max: 100_000 });
    const mine = <T extends { productId: string }>(xs: T[]) => xs.filter((x) => x.productId.startsWith(P));
    assert.deepEqual(mine(r1.imported).map((x) => x.productId), [`${P}prod-1`], "(1) chỉ mã đang bán, có ảnh, tải được");
    const failed = mine(r1.failed);
    assert.deepEqual(failed.map((x) => x.productId).sort(), [`${P}prod-2`, `${P}prod-5`]);
    assert.match(failed.find((x) => x.productId === `${P}prod-2`)?.reason ?? "", /404/, "(1) ảnh lỗi mang lý do");
    assert.match(failed.find((x) => x.productId === `${P}prod-5`)?.reason ?? "", /không phải ảnh/, "(1) loại ảnh nhận bằng chữ ký tệp, không tin máy chủ");
    assert.ok(!pancake.calls.includes("https://pancake.test/ci-3.jpg"), "(1) mã đã gỡ không được tải");
    const photos = await db.select().from(schema.creativeSources).where(and(eq(schema.creativeSources.kind, "PRODUCT_PHOTO"), like(schema.creativeSources.productId, `${P}%`)));
    assert.equal(photos.length, 1);
    assert.equal(photos[0].title, `${P}Đầm hoa`);
    assert.equal(photos[0].sourceUrl, "https://pancake.test/ci-1.jpg");
    assert.equal(photos[0].createdByUserId, null, "máy nhập ⇒ khoá tài khoản NULL (mục 34)");
    const photoSha = sha256Hex(pancakeBytes);

    const callsBefore = pancake.calls.length;
    const r2 = await importPancakeProductPhotos(db, actor, { fetchImpl: pancake.impl, max: 100_000 });
    assert.equal(mine(r2.imported).length, 0, "(1) bấm lại không đẻ bản thứ hai");
    assert.ok(!pancake.calls.slice(callsBefore).includes("https://pancake.test/ci-1.jpg"), "(1) ảnh đã có thì không tải lại");
    assert.equal((await db.select().from(schema.creativeSources).where(and(eq(schema.creativeSources.kind, "PRODUCT_PHOTO"), like(schema.creativeSources.productId, `${P}%`)))).length, 1);

    // Trần kích thước: máy chủ khai content-length quá lớn ⇒ chặn trước khi đọc thân.
    const huge = (async () => new Response("x", { status: 200, headers: { "content-length": String(50 * 1024 * 1024) } })) as typeof fetch;
    await assert.rejects(() => downloadImage("https://pancake.test/big.jpg", { fetchImpl: huge }), /quá lớn/);
    await assert.rejects(() => downloadImage("file:///etc/passwd", { fetchImpl: huge }), /http/);
    console.log("✓ Vòng mẫu · nhập ảnh Pancake: lũy đẳng theo (mã, URL) · bỏ mã đã gỡ / không ảnh · ảnh lỗi mang lý do, không hỏng cả lượt");

    // ═══════════ 2. ỨNG VIÊN TỪ ad_spends + ĐƠN ═══════════
    const spend = (adId: string, daysAgo: number, amount: number, messages: number, extra: Partial<typeof schema.adSpends.$inferInsert> = {}) => ({
      platform: "FACEBOOK",
      campaign: `${P}chiến dịch ${adId}`,
      grain: "AD",
      accountId: "123456",
      adId,
      adName: `${P}QC ${adId}`,
      spend: amount,
      messages,
      impressions: 10_000,
      clicks: 200,
      spendDate: vnStartOfDay(shiftDay(today, -daysAgo)),
      createdBy: `${P}test`,
      ...extra,
    });
    await db.insert(schema.adSpends).values([
      spend(AD.good, 3, 30_000, 10, { productId: `${P}prod-2` }),
      spend(AD.good, 2, 30_000, 10, { productId: `${P}prod-2` }), // cả đời: 60.000đ / 20 tin = 3.000đ
      spend(AD.pricey, 3, 100_000, 10), // 10.000đ / tin
      spend(AD.fewMsg, 3, 60_000, 4), // 4 tin
      spend(AD.win, 5, 500_000, 30), // đắt tin nhắn nhưng nhiều đơn
      spend(AD.old, 90, 60_000, 30), // tốt nhưng ngoài 60 ngày
      spend(AD.lowSpend, 3, 20_000, 10), // 2.000đ / tin nhưng chi dưới sàn
      spend(AD.video, 3, 60_000, 30),
      spend(AD.hash, 3, 60_000, 30),
      spend(AD.good, 3, 999_999, 1, { excluded: true }), // tiền của shop khác cùng BM ⇒ không đếm
    ]);
    const orderAt = new Date(realNow.getTime() - 4 * 86_400_000);
    for (const [id, stage] of [["o1", "CONFIRMED"], ["o2", "CONFIRMED"], ["o3", "PACKING"], ["o4", "CANCELLED"], ["o5", "NEW"]] as const) {
      await db.insert(schema.orders).values({ id: `${P}${id}`, stage, adId: AD.win, cod: 300_000, totalPriceAfterDiscount: 300_000, prepaid: 0, insertedAt: orderAt });
    }
    // Mã chiếm nhiều dòng đơn nhất trong các đơn mang ad_id = prod-1 (2 dòng) > prod-2 (1 dòng); quà tặng không tính.
    await db.insert(schema.orderItems).values([
      { id: `${P}oi1`, orderId: `${P}o1`, productId: `${P}prod-1` },
      { id: `${P}oi2`, orderId: `${P}o2`, productId: `${P}prod-1` },
      { id: `${P}oi3`, orderId: `${P}o3`, productId: `${P}prod-2` },
      { id: `${P}oi4`, orderId: `${P}o3`, productId: `${P}prod-2`, isBonus: true },
      { id: `${P}oi5`, orderId: `${P}o4`, productId: `${P}prod-2`, isBonus: true },
    ]);

    const cand = await listOwnAdCandidates(db, { now: realNow, winOrdersAbove: WIN_ABOVE, adIds: ALL_ADS });
    const ids = cand.rows.map((r) => r.adId);
    assert.equal(ids[0], AD.win, "(2) THẮNG đứng đầu");
    assert.deepEqual([...ids].sort(), [AD.good, AD.win, AD.video, AD.hash].sort(), `(2) đúng bốn mẩu đạt: ${ids.join(",")}`);
    const good = cand.rows.find((r) => r.adId === AD.good)!;
    assert.equal(good.reason, "GOOD");
    assert.equal(good.spendVnd, 60_000, "(2) dòng excluded không đếm");
    assert.equal(good.messages, 20);
    assert.equal(good.costPerMessageVnd, 3_000);
    assert.equal(good.ctrPct, 2, "CTR = 400 / 20.000");
    assert.equal(good.cpcVnd, 150);
    assert.equal(good.periodFrom, shiftDay(today, -3));
    assert.equal(good.periodTo, shiftDay(today, -2));
    const win = cand.rows.find((r) => r.adId === AD.win)!;
    assert.equal(win.reason, "WIN");
    assert.equal(win.bookedOrders, 3, "(2) đơn chốt = CONFIRMED_ORDER, kết quả ≠ huỷ — NEW và CANCELLED không tính");
    assert.ok(cand.rows.every((r) => r.importedSourceId === null));
    console.log("✓ Vòng mẫu · ứng viên mẫu tốt: tốt / đắt / ít tin / cũ / chi ít / THẮNG theo đơn — đơn đếm bằng variantMetrics của vòng");

    // ═══════════ 3. NHẬP TỪ FACEBOOK (Graph giả) ═══════════
    const winBytes = fakeJpeg(40);
    const goodBytes = fakeJpeg(41);
    const hashBytes = fakeJpeg(48);
    const images = fakeFetch({ "https://fb.test/win.jpg": winBytes, "https://fb.test/good.jpg": goodBytes, "https://fb.test/hash.jpg": hashBytes, "https://fb.test/thumb.jpg": fakeJpeg(47) });
    const graphCalls: string[] = [];
    const hashLookups: [string, string[]][] = [];
    const raw: Record<string, Record<string, unknown>> = {
      [AD.win]: { name: "QC thắng", account_id: "act_123456", creative: { id: "c4", image_url: "https://fb.test/win.jpg", body: "Đầm hoa mặc là mát, 300 khách đã mua", title: "Mua ngay hôm nay" } },
      [AD.good]: { name: "QC tốt", creative: { object_story_spec: { link_data: { picture: "https://fb.test/good.jpg", message: "Áo lụa mềm mát", name: "Áo lụa" } } } },
      [AD.hash]: { name: "QC băm", account_id: "act_123456", creative: { image_hash: "abc123" } },
      [AD.video]: { name: "QC video", creative: { image_url: "https://fb.test/thumb.jpg", object_story_spec: { video_data: { video_id: "1" } } } },
    };
    const graph: OwnAdGraph = {
      getAdCreativeContent: async (adId) => {
        graphCalls.push(adId);
        const r = raw[adId];
        if (!r) throw new Error("không có");
        return r;
      },
      getAdImageUrls: async (account, hashes): Promise<Record<string, string>> => {
        hashLookups.push([account, hashes]);
        return hashes.includes("abc123") ? { abc123: "https://fb.test/hash.jpg" } : {};
      },
    };
    const deps = { graph, fetchImpl: images.impl, now: realNow, winOrdersAbove: WIN_ABOVE };
    const imp = await importOwnAds(db, [AD.win, AD.good, AD.hash, AD.video, AD.pricey, "không-phải-số"], actor, deps);
    assert.deepEqual(imp.imported.map((x) => x.adId).sort(), [AD.win, AD.good, AD.hash].sort());
    assert.deepEqual(imp.skipped.map((x) => x.adId).sort(), [AD.pricey, AD.video].sort());
    assert.match(imp.skipped.find((x) => x.adId === AD.video)?.reason ?? "", /video/i);
    assert.match(imp.skipped.find((x) => x.adId === AD.pricey)?.reason ?? "", /ngưỡng/, "(3) danh sách client gửi lên được KIỂM LẠI ở máy chủ");
    assert.ok(!graphCalls.includes(AD.pricey), "(3) mẩu không đạt thì không gọi Facebook");
    assert.deepEqual(hashLookups, [["123456", ["abc123"]]], "(3) chỉ có mã băm ⇒ tra thư viện ảnh của tài khoản");
    assert.ok(!images.calls.includes("https://fb.test/thumb.jpg"), "(3) ảnh bìa video không được tải");
    assert.deepEqual(imp.noProduct, [AD.hash], "(3) không suy được mã hàng ⇒ NÓI RA");

    const own = await db.select().from(schema.creativeSources).where(inArray(schema.creativeSources.fbAdId, ALL_ADS));
    const byAd = new Map(own.map((s) => [s.fbAdId as string, s]));
    const sWin = byAd.get(AD.win)!;
    const sGood = byAd.get(AD.good)!;
    const sHash = byAd.get(AD.hash)!;
    assert.ok(own.every((s) => s.kind === "OWN_AD" && s.imageId));
    assert.equal(sWin.productId, `${P}prod-1`, "(3) mã chiếm nhiều dòng đơn nhất (quà tặng không tính)");
    assert.equal(parseOwnAdMetrics(sWin.metrics).productBasis, "ORDERS");
    assert.equal(sGood.productId, `${P}prod-2`, "(3) không có đơn ⇒ ad_spends.product_id");
    assert.equal(parseOwnAdMetrics(sGood.metrics).productBasis, "AD_SPENDS");
    assert.equal(sHash.productId, null);
    assert.equal(sWin.title, `${P}QC ${AD.win}`, "tên QC lấy từ ad_spends (tên mới nhất)");
    assert.equal(sWin.primaryText, "Đầm hoa mặc là mát, 300 khách đã mua");
    assert.equal(sWin.headline, "Mua ngay hôm nay");
    assert.equal(sGood.primaryText, "Áo lụa mềm mát", "(3) link_data.message khi không có body");
    const mWin = parseOwnAdMetrics(sWin.metrics);
    assert.equal(mWin.reason, "WIN");
    assert.equal(mWin.bookedOrders, 3);
    assert.equal(mWin.spendVnd, 500_000);
    assert.equal(parseOwnAdMetrics(sGood.metrics).costPerMessageVnd, 3_000);

    const callsBefore2 = graphCalls.length;
    const again = await importOwnAds(db, [AD.win, AD.good, AD.hash], actor, deps);
    assert.equal(again.imported.length, 0, "(3) LŨY ĐẲNG theo fb_ad_id");
    assert.equal(again.existing.length, 3);
    assert.equal(graphCalls.length, callsBefore2, "(3) mẩu đã nhập thì không gọi Facebook lần nữa");
    assert.equal((await db.select().from(schema.creativeSources).where(inArray(schema.creativeSources.fbAdId, ALL_ADS))).length, 3);
    // Ứng viên giờ hiện "đã nhập".
    const cand2 = await listOwnAdCandidates(db, { now: realNow, winOrdersAbove: WIN_ABOVE, adIds: ALL_ADS });
    assert.equal(cand2.rows.find((r) => r.adId === AD.win)?.importedSourceId, sWin.id);
    // CSDL: OWN_AD bắt buộc fb_ad_id.
    await assert.rejects(async () => {
      await db.insert(schema.creativeSources).values({ kind: "OWN_AD", title: `${P}giả mạo` });
    }, "(3) OWN_AD không có fb_ad_id bị CSDL chặn");
    console.log("✓ Vòng mẫu · nhập mẫu tốt từ Facebook: image_url · link_data · image_hash · video bị bỏ · kiểm lại ngưỡng ở máy chủ · lũy đẳng · suy mã hàng hoặc nói ra");

    // ═══════════ 4. LẬP LÔ VỚI OWN_AD ═══════════
    // Giả lượt đọc ảnh: quảng cáo thắng đủ sáu gen, quảng cáo tốt chỉ đọc được một gen.
    await db.update(schema.creativeSources).set({ genes: G as Record<string, string>, visionAt: realNow, visionSummary: "Người mẫu dạo phố, nắng chiều" }).where(eq(schema.creativeSources.id, sWin.id));
    await db.update(schema.creativeSources).set({ genes: { scene: "CAFE" }, visionAt: realNow }).where(eq(schema.creativeSources.id, sGood.id));
    await db.update(schema.creativeSources).set({ visionAt: realNow }).where(eq(schema.creativeSources.id, sHash.id));
    // Ảnh SPY / MANUAL CÙNG MÃ với ảnh sản phẩm — chặn phải là do LOẠI, không phải do lệch mã.
    const spyImg = await storeCreativeImage(db, fakeJpeg(60));
    const manImg = await storeCreativeImage(db, fakeJpeg(61));
    await db.insert(schema.creativeSources).values([
      { kind: "SPY", productId: `${P}prod-1`, title: `${P}spy`, imageId: spyImg.id, genes: { palette: "COOL" }, visionAt: realNow, visionSummary: "Ảnh đối thủ" },
      { kind: "MANUAL", productId: `${P}prod-1`, title: `${P}manual`, imageId: manImg.id, genes: { model: "MALE" }, visionAt: realNow, visionSummary: "Ảnh tay" },
    ]);

    // Không ô THIẾT KẾ ở đây (khối kiểm riêng: tests/creative-design.test.ts); mockup của quảng cáo cũ THẮNG + 4 thăm dò.
    const cfg = { ...DEFAULT_CREATIVE_CONFIG, enabled: true, batchSize: 5, extraCandidates: 3, designSlots: 0, exploreSlots: 4, mockupSourceIds: [sWin.id], focusProductIds: [`${P}prod-1`, `${P}prod-2`] };
    const inputs = await loadPlanInputs(db, batchDay, cfg);
    assert.deepEqual(inputs.products.map((x) => x.productId), [`${P}prod-1`], "prod-2 không có ảnh thật (ảnh Pancake lỗi)");
    const ownParent = inputs.parents.find((x) => x.ownAdSourceId === sWin.id);
    assert.ok(ownParent, "(4) OWN_AD đủ gen + có mã có ảnh thật ⇒ MẪU CHA");
    assert.equal(ownParent.variantId, null);
    assert.equal(ownParent.verdict, "WIN");
    assert.equal(ownParent.bookedOrders, 3);
    assert.equal(ownParent.imageId, sWin.imageId);
    assert.ok(!inputs.parents.some((x) => x.ownAdSourceId === sGood.id), "(4) gen chưa đủ ⇒ không làm mẫu cha");
    const insp = inputs.inspirations.find((x) => x.sourceId === sGood.id);
    assert.ok(insp && insp.kind === "OWN_AD", "(4) OWN_AD thiếu gen là nguồn cảm hứng");
    assert.ok(!inputs.inspirations.some((x) => x.sourceId === sWin.id), "(4) mẫu cha không đồng thời là nguồn cảm hứng");

    const plan = planBatch({ ...inputs, exploreShare: 0.5, parents: inputs.parents.filter((x) => x.productId.startsWith(P)), inspirations: inputs.inspirations.filter((x) => x.productId === null || x.productId.startsWith(P)) });
    const exploit = plan.slots.filter((x) => x.mode === "EXPLOIT");
    assert.equal(exploit.length, 4, "8 ô × (1 − 0,5)");
    for (const x of exploit) {
      assert.equal(x.parentVariantId, null);
      assert.equal(x.inspirationSourceId, sWin.id, "(4) ô sinh ra từ OWN_AD ghi nguồn vào inspiration_source_id");
      assert.equal(x.parentImageId, sWin.imageId);
      const changed = GENE_KEYS.filter((k) => x.genes[k] !== G[k]);
      assert.deepEqual(changed, [x.mutatedGene], "(4) biến thể của quảng cáo cũ đổi ĐÚNG MỘT gen");
      assert.match(x.why, /quảng cáo cũ của shop/);
    }
    const explore = plan.slots.filter((x) => x.mode === "EXPLORE");
    const ownIds = new Set([sGood.id, sHash.id]);
    assert.ok(explore.length >= 2 && ownIds.has(explore[0].inspirationSourceId ?? "") && ownIds.has(explore[1].inspirationSourceId ?? ""), "(4) quảng cáo cũ thiếu gen đứng TRƯỚC spy / tay ở ô thăm dò");

    const examples = await loadWinningExamples(db, `${P}prod-1`);
    assert.ok(examples.some((e) => e.primaryText === "Đầm hoa mặc là mát, 300 khách đã mua"), "(4) câu chữ đã bán được tới người viết");
    console.log("✓ Vòng mẫu · lập lô với quảng cáo cũ: đủ gen ⇒ mẫu cha (đổi đúng một gen) · thiếu gen ⇒ cảm hứng đứng trước · câu chữ tới người viết");

    // ═══════════ 5. ĐƯỜNG ĐIỂM ẢNH ═══════════
    await db
      .insert(schema.settings)
      .values({ key: CREATIVE_CONFIG_KEY, value: JSON.stringify({ ...cfg, focusProductIds: [`${P}prod-1`] }) })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify({ ...cfg, focusProductIds: [`${P}prod-1`] }) } });
    const imageCalls: { kinds: string[]; shas: string[] }[] = [];
    let tag = 2000;
    const imageClient: ImageEditClient = async (input) => {
      imageCalls.push({ kinds: input.images.map((i) => i.kind), shas: input.images.map((i) => sha256Hex(i.bytes)) });
      tag += 1;
      return { bytes: fakeJpeg(tag), contentType: "image/jpeg", usage: null, costUsd: 0.01 };
    };
    const writer: CopyWriter = async () => ({ imagePrompt: "p", primaryText: "Câu máy viết", headline: "Máy", model: "fake", costUsd: null, attempts: 1, priceStripped: false });
    const built = await buildBatch(db, buildNow, { imageClient, writer, describe: async () => ({ ok: false as const, error: "bỏ qua" }), perTick: 20 });
    assert.ok(built.generated > 0, JSON.stringify(built));
    const [batch] = await db.select().from(schema.creativeBatches).where(eq(schema.creativeBatches.batchDay, batchDay));
    const vs = await db.select().from(schema.creativeVariants).where(and(eq(schema.creativeVariants.batchId, batch.id), isNotNull(schema.creativeVariants.inspirationSourceId)));
    const spySrc = await db.select({ id: schema.creativeSources.id }).from(schema.creativeSources).where(like(schema.creativeSources.title, `${P}%`));
    assert.ok(vs.some((v) => v.inspirationSourceId === sWin.id && v.mode === "EXPLOIT"), "có ô khai thác từ quảng cáo cũ");
    assert.ok(vs.some((v) => spySrc.some((s) => s.id === v.inspirationSourceId)), "có ô nhận SPY / MANUAL làm nguồn cảm hứng — để phép kiểm dưới có nghĩa");

    const winSha = sha256Hex(winBytes);
    const forbidden = new Set([spyImg.sha256, manImg.sha256, sha256Hex(goodBytes), sha256Hex(hashBytes)]);
    assert.equal(imageCalls.length, built.generated);
    for (const c of imageCalls) {
      assert.ok(c.kinds.every((k) => k === "PRODUCT_PHOTO" || k === "OWN_VARIANT"), `(5) nhãn lạ: ${c.kinds.join(",")}`);
      assert.equal(c.shas.filter((s, i) => c.kinds[i] === "PRODUCT_PHOTO" && s === photoSha).length, 1, "(5) mỗi lượt đúng một ảnh sản phẩm thật làm gốc");
      assert.ok(c.shas.every((s) => !forbidden.has(s)), "(5) điểm ảnh SPY / MANUAL / OWN_AD khác mã / OWN_AD không mã KHÔNG BAO GIỜ tới máy sinh ảnh");
    }
    assert.ok(imageCalls.some((c) => c.shas.includes(winSha) && c.kinds[c.shas.indexOf(winSha)] === "OWN_VARIANT"), "(5) ảnh quảng cáo cũ CÙNG MÃ đi dưới nhãn OWN_VARIANT");
    console.log("✓ Vòng mẫu · đường điểm ảnh: quảng cáo cũ cùng mã được gửi làm tham chiếu · SPY / MANUAL (kể cả cùng mã) và quảng cáo khác mã không bao giờ");
  } finally {
    await cleanup(db, batchDay);
    if (prevCfg) await db.update(schema.settings).set({ value: prevCfg.value }).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
    else await db.delete(schema.settings).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
  }
}

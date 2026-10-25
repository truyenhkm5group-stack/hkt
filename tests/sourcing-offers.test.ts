/**
 * ═══ SRC-3 · KHO MẪU NGUỒN NHẬP TAY + SO SÁNH (docs/tech/ai-sourcing.md §3.1, Tech Lead duyệt 23/10/2026) ═══
 *
 * Khoá: (1) tiền CNY là FEN nguyên — «12.30» là 1230, không bao giờ 12.299999, cả khi qua jsonb; (2) đọc link THUẦN, chỉ http(s),
 * ca vàng 1688 / Alibaba / Taobao / Tmall / link lạ; (3) chống trùng HAI khoá (nền tảng + mã · link chuẩn hoá), trùng ⇒ không tạo,
 * trả mẫu đã có; (4) ảnh chụp giá CHỈ THÊM, lần mới nhất là lần hiển thị; (5) «cũ» tính lúc đọc, không lưu; (6) thiếu là NULL,
 * không 0; (7) lưu trữ hai lần không ghi thêm; (8) SERVE-COMPAT 0256: bảng chưa có ⇒ đọc trả `unavailable`, ghi trả câu lỗi.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { SOURCING_COMPARE_QUANTITIES, SOURCING_DATA_STALE_DAYS, SOURCING_DATA_STATUSES, staleness } from "@/lib/constants/sourcing";
import { getSourcingCompare, getSourcingOffer, listSourcingOffers } from "@/lib/queries/sourcing";
import type { ListParams } from "@/lib/search-params";
import { canonicalShopUrl, imageKey, parseOfferUrl, safeHttpUrl } from "@/lib/sourcing/offer-url";
import { addSourcingSnapshot, createSourcingOffer, setSourcingOfferArchived, updateSourcingSupplier, type SourcingActor } from "@/lib/sourcing/offer-service";
import { formatCny, formatHundredths, parseCnyInput, parseHundredthsInput, parsePriceTiers, priceAtQty, serializePriceTiers, validatePriceTiers } from "@/lib/sourcing/price";
import { parseSkus, serializeSkus } from "@/lib/sourcing/skus";

const P = "src3-";

function testMoney() {
  assert.equal(parseCnyInput("12.30"), 1230, "«12.30» ⇒ 1230 fen");
  assert.ok(Number.isInteger(parseCnyInput("12.30")!), "fen là số nguyên");
  for (const [s, fen] of [["12,3", 1230], ["¥ 0.05", 5], ["7", 700], ["12.3元", 1230], ["0.1", 10]] as const) assert.equal(parseCnyInput(s), fen, s);
  for (const bad of ["12.305", "-1", "abc", "1e3", "12.", "", "1.2.3"]) assert.equal(parseCnyInput(bad), null, `«${bad}» không đoán`);
  assert.deepEqual([formatCny(1230), formatCny(5), formatCny(0), formatCny(null)], ["¥12.30", "¥0.05", "¥0.00", "—"]);
  // Vòng tròn chữ ⇒ fen ⇒ chữ đúng cho MỌI giá từ 0,01 tới 100 tệ — đây là chỗ số thực từng đẻ ra 12.299999.
  for (let fen = 1; fen <= 10_000; fen++) assert.equal(parseCnyInput(formatCny(fen).slice(1)), fen);
  const tiers = serializePriceTiers([{ fromQty: 2, priceFen: 1230 }, { fromQty: 50, priceFen: 1180 }]);
  assert.deepEqual(parsePriceTiers(JSON.parse(JSON.stringify(tiers))), tiers, "qua jsonb vẫn nguyên fen");
  assert.equal(formatHundredths(480), "4,80");
  assert.equal(formatHundredths(null), "—");
  assert.deepEqual([parseHundredthsInput("4,8", 500), parseHundredthsInput("95.5%", 10000), parseHundredthsInput("", 500), parseHundredthsInput("5.01", 500), parseHundredthsInput("4.888", 500)], [480, 9550, null, "INVALID", "INVALID"]);

  assert.equal(validatePriceTiers([]), "Cần ít nhất một bậc giá.");
  assert.match(validatePriceTiers([{ fromQty: 10, priceFen: 100 }, { fromQty: 10, priceFen: 90 }])!, /lớn hơn bậc trước/, "số lượng phải tăng nghiêm ngặt — không tự sắp xếp hộ");
  assert.match(validatePriceTiers([{ fromQty: 1, priceFen: 0 }])!, /giá phải lớn hơn 0/);
  assert.match(validatePriceTiers(Array.from({ length: 9 }, (_, i) => ({ fromQty: i + 1, priceFen: 100 })))!, /Tối đa 8/);
  assert.equal(parsePriceTiers([{ fromQty: "2", priceFen: 1230 }]), null, "jsonb sai kiểu ⇒ null (in «bậc giá hỏng»), không ép");
  assert.equal(parsePriceTiers({}), null);

  const t = [
    { fromQty: 2, priceFen: 1500 },
    { fromQty: 50, priceFen: 1200 },
    { fromQty: 200, priceFen: 1000 },
  ];
  assert.deepEqual(priceAtQty(t, 1, 5), { kind: "BELOW_LOWEST_TIER", lowestFrom: 2 }, "dưới bậc thấp nhất ⇒ không có giá, không lấy giá bậc thấp nhất");
  assert.deepEqual(priceAtQty(t, 3, 5), { kind: "PRICE", priceFen: 1500, tierFrom: 2, belowMoq: true });
  assert.deepEqual(priceAtQty(t, 50, 5), { kind: "PRICE", priceFen: 1200, tierFrom: 50, belowMoq: false }, "đúng mốc ⇒ bậc đó");
  assert.deepEqual(priceAtQty(t, 300, null), { kind: "PRICE", priceFen: 1000, tierFrom: 200, belowMoq: false });
  assert.deepEqual(priceAtQty(null, 10, null), { kind: "UNKNOWN" });
  assert.ok(SOURCING_COMPARE_QUANTITIES.every((q, i) => i === 0 || q > SOURCING_COMPARE_QUANTITIES[i - 1]), "mốc so sánh tăng dần");

  assert.deepEqual(serializeSkus("黑色 / đen, 白色，黑色 / đen", ""), { colors: ["黑色 / đen", "白色"], sizes: [] }, "tách cả dấu phẩy Trung, bỏ trùng");
  assert.equal(serializeSkus(" ", ""), null, "không khai ⇒ null, không phải hai mảng rỗng");
  assert.equal(parseSkus([1, 2]), null);
}

function testUrls() {
  const id = "612345678901";
  const c1688 = `https://detail.1688.com/offer/${id}.html`;
  for (const u of [`https://detail.1688.com/offer/${id}.html?spm=a26352.13672862&tracelog=x#top`, `m.1688.com/offer/${id}.html`, `https://detail.m.1688.com/page/index.html?offerId=${id}`, `HTTP://DETAIL.1688.COM/offer/${id}.html`])
    assert.deepEqual(parseOfferUrl(u), { platform: "1688", offerId: id, canonicalUrl: c1688 }, u);
  assert.deepEqual(parseOfferUrl("https://www.alibaba.com/product-detail/Women-Loose-Dress_1600123456789.html?spm=a2700"), { platform: "ALIBABA", offerId: "1600123456789", canonicalUrl: "https://www.alibaba.com/product-detail/_1600123456789.html" });
  assert.deepEqual(parseOfferUrl("https://item.taobao.com/item.htm?spm=x&id=712345678901&ns=1"), { platform: "TAOBAO", offerId: "712345678901", canonicalUrl: "https://item.taobao.com/item.htm?id=712345678901" });
  assert.deepEqual(parseOfferUrl("https://detail.tmall.com/item.htm?id=712345678901&skuId=1"), { platform: "TAOBAO", offerId: "712345678901", canonicalUrl: "https://detail.tmall.com/item.htm?id=712345678901" });
  assert.deepEqual(parseOfferUrl("https://Shop.Example.vn/san-pham/dam-123/?utm_source=fb#x"), { platform: "OTHER", offerId: null, canonicalUrl: "https://shop.example.vn/san-pham/dam-123" }, "link lạ ⇒ OTHER, bỏ tham số / # / «/» cuối");
  assert.deepEqual(parseOfferUrl("https://shop123.1688.com/page/offerlist.htm"), { platform: "1688", offerId: null, canonicalUrl: "https://shop123.1688.com/page/offerlist.htm" }, "link 1688 không phải trang sản phẩm ⇒ không bịa mã");
  for (const bad of ["javascript:alert(1)", "ftp://x.com/a", "", "không phải link", "data:text/html,x", "localhost/a"]) assert.equal(parseOfferUrl(bad), null, `«${bad}» bị từ chối`);
  assert.equal(safeHttpUrl("javascript:alert(1)"), null, "không bao giờ in javascript: thành href");
  assert.equal(imageKey("https://cbu01.alicdn.com/img/ibank/O1CN01abc.jpg_220x220.jpg?x=1"), imageKey("https://CBU01.alicdn.com/img/ibank/O1CN01abc.jpg"), "cùng ảnh khác cỡ ⇒ cùng khoá");
  assert.notEqual(imageKey("https://cbu01.alicdn.com/img/ibank/a.jpg"), imageKey("https://cbu01.alicdn.com/img/ibank/b.jpg"));
  assert.equal(canonicalShopUrl("https://shop123.1688.com/?spm=x"), "https://shop123.1688.com");
}

function testStaleness() {
  // SRC-6 (25/10/2026) thêm EXTENSION — tiện ích «Lưu mẫu từ 1688». Vẫn KHÔNG có trạng thái «cũ» được lưu.
  assert.deepEqual([...SOURCING_DATA_STATUSES], ["MANUAL", "API", "EXTENSION", "UNKNOWN"], "nguồn số liệu là danh sách đóng");
  assert.ok(!(SOURCING_DATA_STATUSES as readonly string[]).includes("STALE"), "không có trạng thái «cũ» được LƯU (Tech Lead 23/10)");
  const now = new Date("2026-10-23T05:00:00Z");
  assert.equal(staleness(null, now), null, "không có mốc ⇒ chưa biết, không phải «mới»");
  assert.deepEqual(staleness(new Date(now.getTime() - 10 * 86_400_000), now), { stale: false, days: 10 });
  assert.deepEqual(staleness(new Date(now.getTime() - (SOURCING_DATA_STALE_DAYS + 1) * 86_400_000), now), { stale: true, days: SOURCING_DATA_STALE_DAYS + 1 });
  const mig = readFileSync("drizzle/0256_sourcing_offer_catalog.sql", "utf8");
  assert.ok(!/STALE/.test(mig), "CHECK ở CSDL không nhận STALE");
}

const listParams = (over: Partial<ListParams> = {}): ListParams => ({
  page: 1,
  pageSize: 25,
  sort: "createdAt",
  dir: "desc",
  q: "",
  filters: {},
  period: { key: "all", from: null, to: null, label: "", fromKey: null, toKey: null },
  ...over,
});

const ok = <T extends { ok: boolean }>(r: T, why: string): Extract<T, { ok: true }> => {
  assert.ok(r.ok, `${why}: ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
};

async function testDb() {
  const db = await getDb();
  await db.insert(schema.users).values({ id: `${P}u1`, email: "src3@test", name: "Người tìm hàng", passwordHash: "x", role: "MANAGER" }).onConflictDoNothing();
  const actor: SourcingActor = { id: `${P}u1`, email: "src3@test" };
  const base = { titleZh: "妈妈装 宽松 连衣裙", imageUrl: "", supplierShopUrl: "", supplierName: "", moq: 5, colors: "", sizes: "" };

  // Tạo + tiền nguyên fen qua CSDL thật.
  const a = ok(
    await createSourcingOffer(actor, { ...base, url: "https://detail.1688.com/offer/612345678901.html?spm=x", titleVi: "Đầm suông cho mẹ", imageUrl: "https://cbu01.alicdn.com/img/ibank/O1CN01abc.jpg_220x220.jpg", supplierShopUrl: "https://shop123.1688.com/?spm=1", supplierName: "Xưởng A", tiers: [{ fromQty: 2, price: "12.30" }, { fromQty: 50, price: "11,8" }] }),
    "tạo mẫu",
  );
  const snaps = await db.select().from(schema.sourcingOfferSnapshots).where(eq(schema.sourcingOfferSnapshots.offerId, a.id));
  assert.deepEqual(snaps[0].tiers, [{ fromQty: 2, priceFen: 1230 }, { fromQty: 50, priceFen: 1180 }], "12.30 ¥ lưu là 1230 fen, không phải 12.299999");
  const [offerA] = await db.select().from(schema.sourcingOffers).where(eq(schema.sourcingOffers.id, a.id));
  assert.deepEqual([offerA.platform, offerA.offerId, offerA.canonicalUrl, offerA.dataStatus, offerA.createdBy], ["1688", "612345678901", "https://detail.1688.com/offer/612345678901.html", "MANUAL", `${P}u1`]);
  const [supA] = await db.select().from(schema.sourcingSuppliers).where(eq(schema.sourcingSuppliers.id, offerA.supplierId!));
  assert.deepEqual([supA.shopUrl, supA.name, supA.yearsOnPlatform, supA.ratingX100, supA.verified, supA.factsAsOf], ["https://shop123.1688.com", "Xưởng A", null, null, null, null], "nhà cung cấp mới: mọi số CHƯA BIẾT (null), không 0");
  assert.equal((await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "SOURCING_OFFER_CREATE"), eq(schema.auditLogs.entityId, a.id)))).length, 1, "ghi có nhật ký");

  // Chống trùng: cùng mã từ link điện thoại; cùng link chuẩn hoá của nền tảng khác.
  const dup = await createSourcingOffer(actor, { ...base, url: "m.1688.com/offer/612345678901.html", titleVi: "Bản sao", tiers: [{ fromQty: 1, price: "10" }] });
  assert.ok(!dup.ok && dup.duplicateOfId === a.id && /đã có trong kho/.test(dup.errors[0].message), `trùng mã ⇒ trả mẫu đã có: ${JSON.stringify(dup)}`);
  const o1 = ok(await createSourcingOffer(actor, { ...base, url: "https://shop.example.vn/dam-1?utm=1", titleVi: "Đầm web 1", tiers: [{ fromQty: 1, price: "20" }] }), "link lạ 1");
  ok(await createSourcingOffer(actor, { ...base, url: "https://shop.example.vn/dam-2", titleVi: "Đầm web 2", tiers: [{ fromQty: 1, price: "20" }] }), "link lạ khác đường dẫn — hai mã NULL không đụng nhau");
  const dupUrl = await createSourcingOffer(actor, { ...base, url: "https://SHOP.example.vn/dam-1/#x", titleVi: "Bản sao web", tiers: [{ fromQty: 1, price: "20" }] });
  assert.ok(!dupUrl.ok && dupUrl.duplicateOfId === o1.id, "trùng link chuẩn hoá ⇒ không tạo");
  assert.equal((await db.select().from(schema.sourcingOffers)).length, 3, "hai lượt trùng không ghi dòng nào");

  // Giá sai ⇒ không ghi gì.
  const bad = await createSourcingOffer(actor, { ...base, url: "https://detail.1688.com/offer/699999999999.html", titleVi: "Giá sai", tiers: [{ fromQty: 2, price: "12.305" }] });
  assert.ok(!bad.ok && /Bậc 1/.test(bad.errors[0].message), "chỉ đúng bậc sai");
  assert.equal((await db.select().from(schema.sourcingOffers).where(eq(schema.sourcingOffers.offerId, "699999999999"))).length, 0);
  const lui = await createSourcingOffer(actor, { ...base, url: "https://detail.1688.com/offer/699999999998.html", titleVi: "Bậc lùi", tiers: [{ fromQty: 50, price: "10" }, { fromQty: 10, price: "11" }] });
  assert.ok(!lui.ok && /lớn hơn bậc trước/.test(lui.errors[0].message));

  // Chụp giá mới: chỉ thêm, lần mới nhất hiển thị.
  ok(await addSourcingSnapshot(actor, { offerId: a.id, tiers: [{ fromQty: 2, price: "13.5" }], moq: 10, colors: "đen", sizes: "XL, 2XL" }), "chụp giá mới");
  const after = await db.select().from(schema.sourcingOfferSnapshots).where(eq(schema.sourcingOfferSnapshots.offerId, a.id));
  assert.equal(after.length, 2, "lần chụp cũ còn nguyên");
  const list = await listSourcingOffers(listParams());
  assert.ok(!list.unavailable);
  const rowA = list.rows.find((r) => r.id === a.id)!;
  assert.deepEqual([rowA.latest?.tiers, rowA.latest?.moq, rowA.supplierName, rowA.imageDupes], [[{ fromQty: 2, priceFen: 1350 }], 10, "Xưởng A", 0]);
  assert.equal(list.rows.find((r) => r.id === o1.id)?.imageDupes, null, "không có link ảnh ⇒ không biết trùng hay không (null), không phải 0");

  // Cờ trùng ảnh: cùng ảnh khác cỡ ở mẫu khác ⇒ gắn cờ, không gộp.
  const b = ok(await createSourcingOffer(actor, { ...base, url: "https://detail.1688.com/offer/622222222222.html", titleVi: "Đầm shop khác cùng ảnh", imageUrl: "https://cbu01.alicdn.com/img/ibank/O1CN01abc.jpg", tiers: [{ fromQty: 3, price: "9.9" }] }), "mẫu cùng ảnh");
  const list2 = await listSourcingOffers(listParams());
  assert.ok(!list2.unavailable);
  assert.deepEqual([list2.rows.find((r) => r.id === a.id)?.imageDupes, list2.rows.find((r) => r.id === b.id)?.imageDupes], [1, 1], "hai mẫu cùng ảnh đều mang cờ");
  const detailA = await getSourcingOffer(a.id);
  assert.ok(detailA && !("unavailable" in detailA));
  assert.deepEqual(detailA.sameImage.map((m) => m.id), [b.id]);
  assert.equal(detailA.snapshots[0].tiers?.[0].priceFen, 1350, "chi tiết: lần mới nhất đứng đầu");

  // Nhà cung cấp: số tay ×100 không qua số thực; ô trống là null; không khai số nào ⇒ không có mốc.
  ok(await updateSourcingSupplier(actor, { supplierId: supA.id, offerId: a.id, name: "Xưởng A", yearsOnPlatform: 6, rating: "4,8", responseRate: "95.5", verified: true, shipFrom: "Quảng Châu", factsAsOf: "2026-10-20" }), "sửa NCC");
  const [supA2] = await db.select().from(schema.sourcingSuppliers).where(eq(schema.sourcingSuppliers.id, supA.id));
  assert.deepEqual([supA2.ratingX100, supA2.responseRateBp, supA2.yearsOnPlatform, supA2.verified, supA2.factsAsOf?.toISOString()], [480, 9550, 6, true, "2026-10-20T05:00:00.000Z"]);
  const r6 = await updateSourcingSupplier(actor, { supplierId: supA.id, offerId: a.id, name: "Xưởng A", yearsOnPlatform: null, rating: "6", responseRate: "", verified: null, shipFrom: "", factsAsOf: "" });
  assert.ok(!r6.ok && /0 tới 5/.test(r6.errors[0].message), "điểm > 5 bị chặn");
  ok(await updateSourcingSupplier(actor, { supplierId: supA.id, offerId: a.id, name: "Xưởng A", yearsOnPlatform: null, rating: "", responseRate: "", verified: null, shipFrom: "", factsAsOf: "" }), "xoá hết số");
  const [supA3] = await db.select().from(schema.sourcingSuppliers).where(eq(schema.sourcingSuppliers.id, supA.id));
  assert.deepEqual([supA3.ratingX100, supA3.responseRateBp, supA3.factsAsOf], [null, null, null], "không khai số nào ⇒ không có mốc «cũ»");

  // Lưu trữ: hai lần chỉ một dòng nhật ký; mặc định danh sách giấu; tạo lại mẫu đã lưu trữ ⇒ bảo khôi phục.
  ok(await setSourcingOfferArchived(actor, { offerId: b.id, archived: true, reason: "trùng ảnh, giữ mẫu A" }), "lưu trữ");
  ok(await setSourcingOfferArchived(actor, { offerId: b.id, archived: true, reason: "bấm lần hai" }), "lưu trữ lần hai");
  assert.equal((await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "SOURCING_OFFER_ARCHIVE"), eq(schema.auditLogs.entityId, b.id)))).length, 1, "bấm hai lần không ghi thêm");
  const active = await listSourcingOffers(listParams());
  const archived = await listSourcingOffers(listParams({ filters: { state: ["ARCHIVED"] } }));
  assert.ok(!active.unavailable && !archived.unavailable);
  assert.ok(!active.rows.some((r) => r.id === b.id) && archived.rows.map((r) => r.id).join() === b.id, "mặc định chỉ mẫu đang dùng; lọc «lưu trữ» ra đúng mẫu đó");
  const again = await createSourcingOffer(actor, { ...base, url: "https://detail.1688.com/offer/622222222222.html", titleVi: "Tạo lại", tiers: [{ fromQty: 1, price: "1" }] });
  assert.ok(!again.ok && again.duplicateOfId === b.id && /lưu trữ/.test(again.errors[0].message), "mẫu đã lưu trữ ⇒ bảo khôi phục, không tạo bản thứ hai");
  const search = await listSourcingOffers(listParams({ q: "Xưởng A" }));
  assert.ok(!search.unavailable && search.rows.some((r) => r.id === a.id), "tìm theo tên nhà cung cấp");

  // So sánh: giữ thứ tự người chọn, nói ra mẫu không còn, cắt ở trần.
  const cmp = await getSourcingCompare([b.id, "khong-co", a.id]);
  assert.ok(!cmp.unavailable);
  assert.deepEqual([cmp.items.map((i) => i.id), cmp.missing], [[b.id, a.id], ["khong-co"]]);
  assert.equal(cmp.items[1].latest?.moq, 10, "so sánh đọc lần chụp MỚI NHẤT");
  const cmp5 = await getSourcingCompare(["1", "2", "3", "4", a.id]);
  assert.ok(!cmp5.unavailable && cmp5.items.length === 0 && cmp5.missing.length === 4, "quá 4 ⇒ chỉ 4 mã đầu được xét");

  // SERVE-COMPAT 0256: CSDL chưa có bảng ⇒ đọc trả unavailable, ghi trả câu lỗi — không ném, không sập trang.
  await db.execute(sql.raw(`ALTER TABLE sourcing_offers RENAME TO sourcing_offers_tam`));
  try {
    assert.deepEqual(await listSourcingOffers(listParams()), { unavailable: true });
    assert.deepEqual(await getSourcingOffer(a.id), { unavailable: true });
    assert.deepEqual(await getSourcingCompare([a.id, b.id]), { unavailable: true });
    const w = await createSourcingOffer(actor, { ...base, url: "https://detail.1688.com/offer/633333333333.html", titleVi: "Khi chưa áp", tiers: [{ fromQty: 1, price: "1" }] });
    assert.ok(!w.ok && /chưa áp migration 0256/.test(w.errors[0].message), "ghi khi chưa áp ⇒ câu lỗi");
    const w2 = await setSourcingOfferArchived(actor, { offerId: a.id, archived: true, reason: "thử khi chưa áp" });
    assert.ok(!w2.ok && /0256/.test(w2.errors[0].message));
  } finally {
    await db.execute(sql.raw(`ALTER TABLE sourcing_offers_tam RENAME TO sourcing_offers`));
  }

  // Dọn.
  await db.delete(schema.sourcingOfferSnapshots);
  await db.delete(schema.sourcingOffers);
  await db.delete(schema.sourcingSuppliers);
}

function testSourceFences() {
  const files = execFileSync("git", ["ls-files", "lib", "app", "components", "scripts"], { encoding: "utf8" }).split("\n").filter((f) => /\.tsx?$/.test(f));
  const writes: string[] = [];
  for (const f of files) {
    const s = readFileSync(f, "utf8");
    if (/update\(schema\.sourcingOfferSnapshots\)|delete\(schema\.sourcingOfferSnapshots\)/.test(s)) writes.push(`${f}: sửa / xoá ảnh chụp giá`);
    if (/delete\(schema\.sourcingOffers\)/.test(s)) writes.push(`${f}: xoá cứng mẫu`);
  }
  assert.deepEqual(writes, [], "ảnh chụp giá CHỈ THÊM; mẫu không xoá cứng (lưu trữ)");
  const act = readFileSync("lib/actions/sourcing-offers.ts", "utf8");
  assert.ok(act.startsWith('"use server";') && act.includes('can(user, "sourcing:write")') && !act.includes("getDb"), "server action mỏng: phiên + quyền, không chạm CSDL");
  const svc = readFileSync("lib/sourcing/offer-service.ts", "utf8");
  assert.equal((svc.match(/await audit\(\{/g) ?? []).length, 6, "sáu đường ghi (tạo · chụp giá · sửa · NCC · lưu trữ · cân nặng SRC-4) đều có nhật ký");
  const ui = ["components/sourcing/offer-bits.tsx", "components/sourcing/offer-forms.tsx", "app/(dashboard)/sourcing/offers-columns.tsx", "app/(dashboard)/sourcing/compare/page.tsx", "app/(dashboard)/sourcing/offers/[id]/page.tsx"];
  for (const f of [...ui, "lib/sourcing/offer-url.ts", "lib/sourcing/price.ts", "lib/queries/sourcing.ts", "lib/sourcing/offer-service.ts"]) {
    const s = readFileSync(f, "utf8");
    assert.ok(!/\bfetch\(|fetchJson\(|fetchPublicUrl\(/.test(s), `${f}: không mở link nguồn, không tải ảnh`);
    if (f !== "lib/sourcing/price.ts") assert.ok(!/priceFen\s*[*/]|[*/]\s*100\b/.test(s), `${f}: không tự nhân / chia tiền — chỉ lib/sourcing/price.ts`);
  }
  const imgs = ui.flatMap((f) => [...readFileSync(f, "utf8").matchAll(/<img\b[^>]*>/g)].map((m) => m[0]));
  assert.equal(imgs.length, 1, "một chỗ duy nhất vẽ ảnh nguồn (OfferImage)");
  assert.ok(imgs[0].includes('referrerPolicy="no-referrer"') && imgs[0].includes("onError"), "ảnh: no-referrer + chấp nhận vỡ");
  const cmp = readFileSync("app/(dashboard)/sourcing/compare/page.tsx", "utf8");
  assert.ok(cmp.includes("SOURCING_COMPARE_QUANTITIES") && !/\[\s*10\s*,\s*50/.test(cmp), "mốc số lượng lấy từ hằng số, không gõ lại");
}

export async function testSourcingOffers() {
  testMoney();
  testUrls();
  testStaleness();
  await testDb();
  testSourceFences();
  console.log("  ✓ SRC-3 kho mẫu nguồn: tiền CNY là fen nguyên (12.30 ⇒ 1230, cả qua jsonb) · đọc link thuần, chỉ http(s) · chống trùng mã + link · ảnh chụp giá chỉ thêm · «cũ» tính lúc đọc · thiếu là null · lưu trữ hai lần không ghi thêm · so sánh giữ thứ tự, cắt ở 4 · chưa áp 0256 ⇒ không sập");
}

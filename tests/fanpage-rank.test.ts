import assert from "node:assert/strict";
import { inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { EMPTY_FANPAGE_EVIDENCE, dnaSimilarity, rankFanpagesForCamp, type FanpageEvidence } from "@/lib/constants/fanpage-rank";
import { loadFanpageEvidence } from "@/lib/queries/creative-manual-gen";

/**
 * ═══════════ XẾP FANPAGE CHO MỘT CAMP (chủ shop 28/09/2026) ═══════════
 *
 * Khoá:
 *  (a) HÀM THUẦN: camp mã win ⇒ page đã ra đơn mã ấy lên đầu (nhiều đơn trước) · camp TEST ⇒ page CHƯA TỪNG ra đơn mà đã
 *      chạy mẫu CÙNG NHÓM HÀNG lên đầu, gần DNA hơn trước, rồi nhiều tiền hơn · khác nhóm hàng KHÔNG tính dù trùng nhiều
 *      thuộc tính · page còn lại giữ thứ tự vào · thiếu DNA / thiếu mã ⇒ không xếp và nói ra.
 *  (b) TRUY VẤN trên PGlite: đơn xác nhận theo (mã, page), đơn huỷ không tính; page của chiến dịch lấy DISTINCT trước khi
 *      nối tiền (hai mẩu cùng chiến dịch KHÔNG nhân đôi tiền); page đã có đơn không vào danh sách "đã chạy".
 */

const P = "fpr-";

export function testFanpageRankPure() {
  const dam = { category: "DRESS", silhouette: "A_LINE", length: "MIDI", neckline: "V_NECK", colorFamily: "RED" };
  assert.equal(dnaSimilarity(dam, { category: "DRESS", silhouette: "A_LINE", length: "MIDI", colorFamily: "BLACK" }), 2);
  assert.equal(dnaSimilarity(dam, { category: "PANTS", silhouette: "A_LINE", length: "MIDI", neckline: "V_NECK", colorFamily: "RED" }), null, "khác nhóm hàng ⇒ không tương tự dù trùng mọi thứ khác");
  assert.equal(dnaSimilarity({ silhouette: "A_LINE" }, dam), null, "chưa biết nhóm hàng ⇒ không tương tự");
  assert.equal(dnaSimilarity(dam, { category: "DRESS" }), 0, "cùng nhóm, không thuộc tính nào biết ở cả hai ⇒ 0 (vẫn tương tự)");

  const pages = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
    { id: "d", name: "D" },
    { id: "e", name: "E" },
  ];
  const ev: FanpageEvidence = {
    orderedPages: ["a", "b"],
    ordersByProduct: { q005: { b: 7, a: 2 } },
    ranByPage: {
      c: [{ productId: "dam-gan", spendVnd: 100_000 }],
      d: [
        { productId: "dam-xa", spendVnd: 900_000 },
        { productId: "quan", spendVnd: 5_000_000 },
      ],
      e: [{ productId: "quan", spendVnd: 9_000_000 }],
    },
    dna: { q005: dam, "dam-gan": { ...dam, colorFamily: "BLACK" }, "dam-xa": { category: "DRESS", silhouette: "BODYCON" }, quan: { ...dam, category: "PANTS" } },
    productLabel: { "dam-gan": "Q010", "dam-xa": "Q020", quan: "QN01" },
  };

  const win = rankFanpagesForCamp(pages, ev, { kind: "WIN", productId: "q005", dna: null });
  assert.deepEqual(win.pages.map((p) => p.id), ["b", "a", "c", "d", "e"], "camp mã win: page đã ra đơn mã ấy lên đầu, nhiều đơn trước; còn lại giữ thứ tự");
  assert.equal(win.prioritized, 2);
  assert.equal(win.pages[0].hint, "7 đơn mã này");
  assert.equal(win.pages[2].hint, null);

  const test = rankFanpagesForCamp(pages, ev, { kind: "TEST", productId: "q005", dna: null });
  assert.deepEqual(test.pages.map((p) => p.id), ["c", "d", "a", "b", "e"], "camp TEST: page chưa ra đơn đã chạy mẫu cùng nhóm lên đầu, DNA gần hơn trước (không theo tiền)");
  assert.equal(test.prioritized, 2, "page chỉ chạy nhóm hàng khác (quần) KHÔNG được ưu tiên dù chi nhiều");
  assert.match(test.pages[0].hint ?? "", /chưa ra đơn · đã chạy 1 mẫu tương tự \(Q010\)/);
  assert.match(test.pages[1].hint ?? "", /1 mẫu tương tự \(Q020\) · 900\.000đ/, "tiền chỉ cộng mẫu tương tự, không cộng quần");

  const thietKe = rankFanpagesForCamp(pages, ev, { kind: "TEST", productId: null, dna: { category: "DRESS", silhouette: "BODYCON" } });
  assert.deepEqual(thietKe.pages.slice(0, 2).map((p) => p.id), ["d", "c"], "ảnh thiết kế mới so bằng DNA của chính nó");

  const chuaDna = rankFanpagesForCamp(pages, ev, { kind: "TEST", productId: "khong-dna", dna: null });
  assert.deepEqual([chuaDna.prioritized, chuaDna.pages.map((p) => p.id)], [0, ["a", "b", "c", "d", "e"]]);
  assert.match(chuaDna.note ?? "", /chưa đọc được nhóm hàng/, "thiếu DNA ⇒ nói ra, không đoán");
  assert.match(rankFanpagesForCamp(pages, EMPTY_FANPAGE_EVIDENCE, { kind: "WIN", productId: "q005", dna: null }).note ?? "", /Chưa fanpage nào có đơn/);
  assert.match(rankFanpagesForCamp(pages, ev, { kind: "WIN", productId: null, dna: null }).note ?? "", /không thuộc mã hàng/);
}

export async function testFanpageRankDb(db: Db) {
  const cleanup = async () => {
    await db.delete(schema.orderItems).where(like(schema.orderItems.id, `${P}%`));
    await db.delete(schema.orders).where(like(schema.orders.id, `${P}%`));
    await db.delete(schema.adSpends).where(like(schema.adSpends.campaign, `${P}%`));
    await db.delete(schema.fbAds).where(like(schema.fbAds.id, `${P}%`));
    await db.delete(schema.productDna).where(like(schema.productDna.productId, `${P}%`));
    await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
  };
  await cleanup();
  try {
    await db.insert(schema.products).values([
      { id: `${P}q005`, name: "Đầm Q005", customId: "Q005" },
      { id: `${P}q010`, name: "Đầm Q010", customId: "Q010" },
    ]);
    await db.insert(schema.productDna).values([
      { productId: `${P}q005`, dna: { category: "DRESS", silhouette: "A_LINE" }, dnaVersion: 1 },
      { productId: `${P}q010`, dna: { category: "DRESS", silhouette: "A_LINE" }, dnaVersion: 1 },
    ]);
    const at = new Date("2026-09-01T03:00:00Z");
    await db.insert(schema.orders).values([
      { id: `${P}o1`, stage: "SHIPPED", pageId: `${P}pg-ban`, insertedAt: at },
      { id: `${P}o2`, stage: "DELIVERED", pageId: `${P}pg-ban`, insertedAt: at },
      { id: `${P}o3`, stage: "CANCELLED", pageId: `${P}pg-huy`, insertedAt: at },
    ]);
    await db.insert(schema.orderItems).values([
      { id: `${P}i1`, orderId: `${P}o1`, productId: `${P}q005` },
      { id: `${P}i2`, orderId: `${P}o2`, productId: `${P}q005` },
      { id: `${P}i2b`, orderId: `${P}o2`, productId: `${P}q005`, isBonus: true },
      { id: `${P}i3`, orderId: `${P}o3`, productId: `${P}q005` },
    ]);
    // Chiến dịch test chạy Q010 trên page chưa ra đơn: HAI mẩu cùng page ⇒ tiền không được nhân đôi.
    await db.insert(schema.fbAds).values([
      { id: `${P}ad1`, campaignId: `${P}c-test`, storyId: `${P}pg-test_111` },
      { id: `${P}ad2`, campaignId: `${P}c-test`, storyId: `${P}pg-test_222` },
      { id: `${P}ad3`, campaignId: `${P}c-ban`, storyId: `${P}pg-ban_333` },
    ]);
    await db.insert(schema.adSpends).values([
      { platform: "facebook", campaign: `${P}camp-test`, campaignId: `${P}c-test`, productId: `${P}q010`, spend: 300_000, spendDate: at },
      { platform: "facebook", campaign: `${P}camp-ban`, campaignId: `${P}c-ban`, productId: `${P}q010`, spend: 500_000, spendDate: at },
    ]);
    clearMemo();
    const ev = await loadFanpageEvidence(db, [`${P}q005`]);
    assert.deepEqual(ev.ordersByProduct[`${P}q005`], { [`${P}pg-ban`]: 2 }, "đơn xác nhận theo (mã, page): đơn huỷ không tính, hàng tặng không đếm thêm đơn");
    assert.ok(ev.orderedPages.includes(`${P}pg-ban`) && !ev.orderedPages.includes(`${P}pg-huy`), "page chỉ có đơn huỷ = chưa từng ra đơn");
    assert.deepEqual(ev.ranByPage[`${P}pg-test`], [{ productId: `${P}q010`, spendVnd: 300_000 }], "tiền chiến dịch KHÔNG nhân theo số mẩu");
    assert.equal(ev.ranByPage[`${P}pg-ban`], undefined, "page đã ra đơn không vào danh sách 'chưa ra đơn đã chạy'");
    assert.deepEqual([ev.dna[`${P}q010`]?.category, ev.productLabel[`${P}q010`]], ["DRESS", "Q010"], "DNA + nhãn của mã page đã chạy có sẵn để so");
    const r = rankFanpagesForCamp([{ id: `${P}pg-ban` }, { id: `${P}pg-test` }], ev, { kind: "TEST", productId: `${P}q005`, dna: null });
    assert.equal(r.pages[0].id, `${P}pg-test`, "đi hết đường: camp TEST của Q005 đưa page test đã chạy Q010 lên đầu");
  } finally {
    await cleanup();
    await db.delete(schema.orders).where(inArray(schema.orders.id, [`${P}o1`, `${P}o2`, `${P}o3`]));
    clearMemo();
  }
}

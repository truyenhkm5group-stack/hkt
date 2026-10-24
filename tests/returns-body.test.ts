import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { getReturnReasonReport, listReasonShipments } from "@/lib/queries/return-reason-report";
import { getReturnIntelligence } from "@/lib/queries/return-intelligence";
import type { Period } from "@/lib/search-params";

/*
  ═══ THÂN NGUỘI /reports/returns: BỚT VIỆC, KHÔNG ĐỔI SỐ (24/10/2026) ═══

  Hai chỗ sửa, mỗi chỗ một bất biến phải giữ:

  1. `baseRows` (return-reason-report.ts) đệm phần SQL theo khoá KHÔNG có kỳ: kỳ này · kỳ trước · drilldown của cùng một
     bộ lọc gửi lên CSDL ĐÚNG MỘT lần. Bất biến: báo cáo dựng từ dòng đệm (của một lần gọi khác kỳ) ra ĐÚNG như báo cáo
     dựng từ CSDL; số ca thiếu mốc đếm như cũ ở mọi kỳ; `clearMemo()` buộc đọc lại; bộ lọc khác ⇒ khoá khác.
  2. `careRows` (return-intelligence.ts) chỉ tính kết quả đơn cho kiện CÓ đợt care. Bất biến: cùng tập ca, cùng phép đếm.

  Mốc dữ liệu đặt năm 2031 để không giao với dữ liệu của bài kiểm khác trong bộ fixture dùng chung; bài kiểm không so
  với đồng hồ thật (AGENTS mục 50) — kỳ là kỳ tuyệt đối, dữ liệu cũng tuyệt đối.
*/

const P = "rbd-";
const KY = (from: string, to: string): Period => ({ key: "custom", label: "thử", from: new Date(from), to: new Date(to), fromKey: from, toKey: to });
const KY_NAY = KY("2031-03-10T00:00:00.000Z", "2031-03-20T23:59:59.999Z");
const KY_TRUOC = KY("2031-02-27T00:00:00.000Z", "2031-03-09T23:59:59.999Z");
const MA = ["RBD1"];

/** Chữ đặc trưng của câu `baseRows` — chỉ câu ấy chọn ra hai cột 2b này liền nhau. */
const DAU_BASE_ROWS = "b.care_owner, b.care_any";
const DAU_CARE_ROWS = "c.entry_carrier_state as state";

type Don = { o: string; stage: "DELIVERED" | "RETURNED" | "IN_TRANSIT"; code: number; status: string; cod: number; handoff: string | null };

/*
  Năm đơn, mỗi đơn đứng ở một chỗ khác nhau so với kỳ:
    o1 giao được · o2 hoàn — trong kỳ
    o3 hoàn — NGOÀI kỳ (tháng 1)                         ⇒ SQL mới không chở về, TS cũ vứt: cùng kết quả
    o4 đang chạy — mốc 23:59:59.9995, nửa mili giây SAU `to` ⇒ TS (cắt về mili giây) GIỮ trong kỳ
    o5 đang chạy — KHÔNG có chứng cứ bàn giao ⇒ thiếu mốc, phải còn để đếm
*/
const DON: Don[] = [
  { o: `${P}o1`, stage: "DELIVERED", code: 501, status: "Giao thành công", cod: 500_000, handoff: "2031-03-15 03:00:00+00" },
  { o: `${P}o2`, stage: "RETURNED", code: 506, status: "Tồn - Khách hàng nghỉ, không có nhà", cod: 0, handoff: "2031-03-15 03:00:00+00" },
  { o: `${P}o3`, stage: "RETURNED", code: 506, status: "Tồn - Khách hàng nghỉ, không có nhà", cod: 0, handoff: "2031-01-05 03:00:00+00" },
  { o: `${P}o4`, stage: "IN_TRANSIT", code: 200, status: "Nhận từ bưu tá - Bưu cục gốc", cod: 0, handoff: "2031-03-20 23:59:59.9995+00" },
  { o: `${P}o5`, stage: "IN_TRANSIT", code: 102, status: "Đơn hàng chờ xử lý", cod: 0, handoff: null },
];

async function dung(db: Db) {
  await db.insert(schema.products).values({ id: `${P}p1`, name: "Đầm RBD", customId: "RBD1", isRemoved: false }).onConflictDoNothing();
  await db.insert(schema.productVariants).values({ id: `${P}v1`, productId: `${P}p1`, sku: "RBD1-S", detail: "S" }).onConflictDoNothing();
  for (const [i, d] of DON.entries()) {
    await db
      .insert(schema.orders)
      .values({ id: d.o, stage: "CONFIRMED", status: 2, insertedAt: new Date("2030-12-20T03:00:00Z"), totalPriceAfterDiscount: 500_000, billFullName: `Khách RBD ${i + 1}`, billPhone: `091000000${i}` })
      .onConflictDoNothing();
    await db.insert(schema.orderItems).values({ id: `${P}i${i}`, orderId: d.o, variantId: `${P}v1`, sku: "RBD1-S", productName: "Đầm RBD", quantity: 1, lineTotal: 500_000, isBonus: false }).onConflictDoNothing();
    await db
      .insert(schema.shipments)
      .values({
        id: `${P}s${i}`,
        orderId: d.o,
        vtpOrderNumber: `${P}T${i}`,
        trackingCode: `${P}T${i}`,
        stage: d.stage,
        vtpStatus: d.code,
        vtpStatusName: d.status,
        codCollected: d.cod,
        createdAt: new Date("2030-12-20T04:00:00Z"),
        isFinal: d.stage !== "IN_TRANSIT",
      })
      .onConflictDoNothing();
    if (d.handoff) {
      // Mốc bàn giao ghi bằng chữ để giữ phần micro giây (Date của JS chỉ tới mili giây).
      await db.execute(sql`update shipments set picked_up_at = ${d.handoff}::timestamptz where id = ${`${P}s${i}`}`);
      await db
        .insert(schema.shipmentEvents)
        .values({ id: `${P}e${i}`, shipmentId: `${P}s${i}`, source: "VTP_WEBHOOK", status: String(d.code), statusName: d.status, normalizedStage: d.stage, occurredAt: new Date("2031-03-25T03:00:00Z") })
        .onConflictDoNothing();
      await db.execute(sql`update shipment_events set occurred_at = ${d.handoff}::timestamptz where id = ${`${P}e${i}`}`);
    }
  }
  /*
    Đợt care: s0 (giao được) HAI đợt, khác trạng thái lúc mở · s1 (hoàn) HAI đợt · s2 (hoàn, NGOÀI kỳ) một đợt — không
    được vào. s3 (biên kỳ) và s4 (thiếu mốc) không có đợt nào: careRows so mốc kỳ KHÍT ở SQL (tới micro giây), khác
    baseRows — chỗ lệch biên ấy có từ trước, bản sửa này không đổi nó và bài kiểm cố ý không khoá nó.
    Trạng thái ĐVVC lúc mở đợt đặt bằng chuỗi riêng để tách khỏi ca của bài kiểm khác.
  */
  const dot = [
    { s: 0, ep: 1, active: false, state: "RBD_B", owner: "" },
    { s: 0, ep: 2, active: true, state: "RBD_A", owner: "a@rbd.test" },
    { s: 1, ep: 1, active: false, state: "RBD_A", owner: "" },
    { s: 1, ep: 2, active: true, state: "RBD_A", owner: "a@rbd.test" },
    { s: 2, ep: 1, active: true, state: "RBD_A", owner: "a@rbd.test" },
  ];
  for (const [i, c] of dot.entries()) {
    await db
      .insert(schema.shipmentCare)
      .values({ id: `${P}c${i}`, shipmentId: `${P}s${c.s}`, episodeNo: c.ep, active: c.active, entryCarrierState: c.state, ownerEmail: c.owner, openedAt: new Date("2031-03-16T03:00:00Z") })
      .onConflictDoNothing();
  }
}

async function don(db: Db) {
  for (let i = 0; i < DON.length; i += 1) {
    await db.delete(schema.shipments).where(eq(schema.shipments.id, `${P}s${i}`)); // đợt care + sự kiện đi theo (cascade)
    await db.delete(schema.shipmentEvents).where(eq(schema.shipmentEvents.id, `${P}e${i}`));
    await db.delete(schema.orderItems).where(eq(schema.orderItems.id, `${P}i${i}`));
    await db.delete(schema.orders).where(eq(schema.orders.id, DON[i].o));
  }
  await db.delete(schema.productVariants).where(eq(schema.productVariants.id, `${P}v1`));
  await db.delete(schema.products).where(eq(schema.products.id, `${P}p1`));
}

/** Ghi lại mọi câu đi qua kết nối PGlite trong lúc `fn` chạy: chữ câu + số dòng trả về. */
async function ghiCau<T>(db: Db, fn: () => Promise<T>): Promise<{ value: T; cau: { text: string; rows: number }[] }> {
  const client = (db as unknown as { $client: { query: (...a: unknown[]) => Promise<unknown> } }).$client;
  const goc = client.query.bind(client);
  const cau: { text: string; rows: number }[] = [];
  client.query = async (...a: unknown[]) => {
    const x = a[0] as string | { text: string };
    const kq = await goc(...a);
    const rows = (kq as { rows?: unknown[] } | null)?.rows;
    cau.push({ text: typeof x === "string" ? x : x.text, rows: Array.isArray(rows) ? rows.length : -1 });
    return kq;
  };
  try {
    return { value: await fn(), cau };
  } finally {
    client.query = goc;
  }
}

export async function testReturnsBodyTrim(db: Db) {
  await dung(db);
  try {
    clearMemo();
    const loc = { basis: "SHIPPED" as const, codes: MA };
    const demBase = (cau: { text: string; rows: number }[]) => cau.filter((c) => c.text.includes(DAU_BASE_ROWS));

    // ── 1. ba lần gọi khác kỳ của cùng bộ lọc ⇒ một lượt CSDL ──
    const { value: ba, cau } = await ghiCau(db, async () => {
      // Đúng thứ tự của trang: báo cáo kỳ này xong rồi tầng quyết định mới hỏi kỳ trước + drilldown cho problemByProduct.
      const nay = await getReturnReasonReport({ ...loc, period: KY_NAY });
      const [truoc, ds] = await Promise.all([getReturnReasonReport({ ...loc, period: KY_TRUOC }), listReasonShipments({ ...loc, period: KY_NAY, limit: 500 })]);
      return { nay, truoc, ds };
    });
    const base = demBase(cau);
    assert.equal(base.length, 1, `kỳ này · kỳ trước · drilldown của cùng bộ lọc = MỘT câu baseRows (đếm được ${base.length})`);
    assert.equal(base[0].rows, 5, "câu SQL không lọc kỳ: đủ năm đơn của bộ lọc mã RBD1");

    // Kỳ vẫn lọc ở TS cho TỪNG lần gọi: o3 ngoài kỳ không vào đâu; o4 ở biên vẫn trong kỳ; o5 thiếu mốc được đếm ở mọi kỳ.
    const { nay, truoc, ds } = ba;
    assert.equal(nay.finished, 2, "đã ngã ngũ trong kỳ: o1 + o2");
    assert.equal(nay.delivered, 1, "giao được: o1");
    assert.equal(nay.returned, 1, "hoàn trong kỳ: o2 (o3 nằm ngoài kỳ)");
    assert.equal(nay.missingBasis, 1, "o5 không có chứng cứ bàn giao ⇒ thiếu mốc");
    assert.equal(truoc.finished, 0, "kỳ trước không có đơn nào có mốc");
    assert.equal(truoc.missingBasis, 1, "ca thiếu mốc được đếm ở MỌI kỳ, như cũ");
    assert.deepEqual(
      ds.map((r) => r.orderId),
      [`${P}o2`],
      "drilldown kỳ này chỉ có o2",
    );

    // Dòng đệm của một lần gọi KHÁC kỳ cho ĐÚNG báo cáo mà CSDL cho: dựng lại kỳ trước sau khi xoá đệm rồi so nguyên khối.
    clearMemo();
    const { value: truocMoi, cau: cauMoi } = await ghiCau(db, () => getReturnReasonReport({ ...loc, period: KY_TRUOC }));
    assert.equal(demBase(cauMoi).length, 1, "clearMemo() (người vừa ghi) ⇒ đọc lại CSDL, không trả dòng cũ");
    assert.deepEqual(JSON.parse(JSON.stringify(truocMoi)), JSON.parse(JSON.stringify(truoc)), "báo cáo kỳ trước dựng từ dòng đệm ≡ dựng thẳng từ CSDL");

    // Bộ lọc khác (mốc khác / không lọc mã) ⇒ khoá khác ⇒ câu riêng, không nhận nhầm dòng của bộ lọc kia.
    const { value: tatCa, cau: cauKhac } = await ghiCau(db, async () => {
      await getReturnReasonReport({ ...loc, basis: "OUTCOME", period: KY_NAY });
      return getReturnReasonReport({ ...loc, period: { ...KY_NAY, from: null, to: null } });
    });
    assert.equal(demBase(cauKhac).length, 1, "mốc OUTCOME là khoá riêng; kỳ trống của bộ lọc SHIPPED dùng lại dòng đệm");
    assert.equal(tatCa.returned, 2, "kỳ trống: cả o2 lẫn o3");

    // ── 2. careRows chỉ tính kiện có đợt care, cùng tập ca ──
    clearMemo();
    const { value: intel, cau: cauIntel } = await ghiCau(db, () => getReturnIntelligence({ period: KY_NAY, previous: null, basis: "SHIPPED", codes: MA }));
    const care = cauIntel.filter((c) => c.text.includes(DAU_CARE_ROWS));
    assert.equal(care.length, 1, "tầng quyết định chạy đúng một câu careRows");
    assert.ok(care[0].text.includes("exists (select 1 from shipment_care sc where sc.shipment_id"), "bảng dẫn xuất của careRows lọc kiện có đợt care TRƯỚC khi tính kết quả đơn");
    const a = intel.care.byState.find((s) => s.state === "RBD_A");
    const b = intel.care.byState.find((s) => s.state === "RBD_B");
    assert.deepEqual(
      a && { cases: a.cases, withOwner: a.withOwner, delivered: a.delivered, failed: a.failed, pending: a.pending },
      { cases: 3, withOwner: 0, delivered: 1, failed: 2, pending: 0 },
      "RBD_A: s0 + hai đợt của s1; đợt của s2 (ngoài kỳ) không vào",
    );
    assert.deepEqual(b && { cases: b.cases, delivered: b.delivered, pending: b.pending }, { cases: 1, delivered: 1, pending: 0 }, "RBD_B: đợt đầu của s0 — kiện giao được");

    console.log(
      `✓ Thân /reports/returns bớt việc, không đổi số: kỳ này · kỳ trước · drilldown = ${base.length} câu baseRows · dựng từ đệm ≡ dựng từ CSDL · clearMemo đọc lại · khoá theo bộ lọc · careRows ${(a?.cases ?? 0) + (b?.cases ?? 0)} ca`,
    );
  } finally {
    clearMemo();
    await don(db);
  }
}

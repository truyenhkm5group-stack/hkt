import assert from "node:assert/strict";
import { inArray, like, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { rowsOf } from "@/lib/sql-rows";
import { legBaseCode } from "@/lib/integrations/viettelpost/statement";
import { RETURN_ARRIVAL_MAX_DAYS, RETURN_ARRIVAL_SKEW_SECONDS } from "@/lib/constants/return-arrival";
import { WEBHOOK_CLOCK_SKEW_SECONDS } from "@/lib/constants/webhook-gap";
import { detectReturnArrival, isReturnLegCodeOf, legShapeSqlForTest, returnArrivalsOf, type ReturnLegCandidate } from "@/lib/queries/shipment-return-arrival";
import { getShipmentTimeline } from "@/lib/queries/shipment-timeline";
import { listShipments, outcomeOfShipment } from "@/lib/queries/shipments";
import { parseListParams } from "@/lib/search-params";

/**
 * ═══════════ «HOÀN VỀ SHOP» KHI VTP GHI «PHÁT THÀNH CÔNG» TRÊN MÃ GỐC ═══════════
 *
 * Đo production 25/10/2026: VTP gửi 501 trên MÃ GỐC với IS_RETURNING = false khi kiện hoàn về tới
 * shop; dòng chiều hoàn (mã gốc + «1P1») giao về 5–9 giây sau (6/8 ca mẫu) hoặc 2–3 ngày sau (2/8).
 * Bài này khoá: (1) các nhánh của luật, kể cả biên; (2) bản SQL ≡ bản TypeScript trên cùng dữ liệu,
 * từng vận đơn; (3) vế dạng mã SQL ≡ `legBaseCode` (regex lười không đổi); (4) nhật ký thêm một dòng
 * DERIVED và KHÔNG sửa dòng CARRIER; (5) `ORDER_OUTCOME` không đổi.
 *
 * Mốc dữ liệu CỐ ĐỊNH và luật KHÔNG đọc đồng hồ thật — không có cửa sổ «N giờ trước» (AGENTS 50).
 * Tự dọn sạch mọi dòng mang tiền tố `vra-` ở cuối, nên tổng của các bài sau không đổi.
 */

const P = "vra-";
const T = new Date("2026-10-20T03:00:00Z");
const giay = (s: number) => new Date(T.getTime() + s * 1000);
const NGAY = 86_400;

type Ca = {
  key: string;
  /** Mốc 501 chiều đi của mã gốc; `null` = không có. */
  outbound501?: Date | null;
  /** Chiều của sự kiện 501 trên mã gốc (mặc định OUTBOUND). */
  leg501?: "OUTBOUND" | "RETURN";
  codCollected?: number;
  /** Dòng «chiều hoàn» (mặc định mã gốc + 1P1). */
  leg?: { suffix?: string; code?: string; stage: "DELIVERED" | "RETURNING" | "RETURNED"; at: Date } | null;
};

const CA: Ca[] = [
  { key: "a7s", outbound501: T, codCollected: 30_000, leg: { stage: "DELIVERED", at: giay(7) } },
  { key: "b2d", outbound501: T, codCollected: 30_000, leg: { stage: "DELIVERED", at: giay(2 * NGAY) } },
  { key: "c3d1", outbound501: T, codCollected: 30_000, leg: { stage: "DELIVERED", at: giay(3 * NGAY + 60) } },
  { key: "d0", outbound501: T, codCollected: 499_000, leg: null },
  { key: "e-ret", outbound501: T, codCollected: 0, leg: { stage: "RETURNING", at: giay(5) } },
  { key: "f-121", outbound501: T, codCollected: 30_000, leg: { stage: "DELIVERED", at: giay(-RETURN_ARRIVAL_SKEW_SECONDS - 1) } },
  { key: "g-120", outbound501: T, codCollected: 30_000, leg: { stage: "DELIVERED", at: giay(-RETURN_ARRIVAL_SKEW_SECONDS) } },
  { key: "h3d", outbound501: T, codCollected: 30_000, leg: { stage: "DELIVERED", at: giay(RETURN_ARRIVAL_MAX_DAYS * NGAY) } },
  // Vận đơn GỬI LẠI tạo trên web VTP cũng mang order_reference = mã gốc — nhưng không có dạng chiều hoàn.
  { key: "i-reship", outbound501: T, codCollected: 30_000, leg: { code: "PKEVRARESHIP9", stage: "DELIVERED", at: giay(5) } },
  // 501 của mã gốc mang cờ CHIỀU HOÀN ⇒ không phải «501 chiều đi», luật không áp.
  { key: "j-retleg", outbound501: T, leg501: "RETURN", codCollected: 30_000, leg: { stage: "DELIVERED", at: giay(6) } },
  // Không có mốc 501 nào (chặng DELIVERED từ nguồn khác) ⇒ không kết luận.
  { key: "k-noanchor", outbound501: null, codCollected: 30_000, leg: { stage: "DELIVERED", at: giay(6) } },
  // Kiện chiều hoàn ở chặng RETURNED (VTP gửi 501 trên kiện chiều hoàn CÓ cờ IS_RETURNING) — lead chốt 27/10: cũng là «đã về shop».
  { key: "l-returned", outbound501: T, codCollected: 30_000, leg: { stage: "RETURNED", at: giay(8) } },
  // ...nhưng RETURNED ngoài cửa sổ 3 ngày thì vẫn không.
  { key: "m-returned-late", outbound501: T, codCollected: 30_000, leg: { stage: "RETURNED", at: giay(4 * NGAY) } },
];

/** Mã gốc: PKE + 10 chữ số, tận cùng bằng chữ số — đúng dạng production. */
const maGoc = (i: number) => `PKEVRA${String(1_000_000 + i).padStart(7, "0")}`;

const KY_VONG: Record<string, boolean> = {
  a7s: true,
  b2d: true,
  c3d1: false,
  d0: false,
  "e-ret": false,
  "f-121": false,
  "g-120": true,
  h3d: true,
  "i-reship": false,
  "j-retleg": false,
  "k-noanchor": false,
  "l-returned": true,
  "m-returned-late": false,
};

export async function testShipmentReturnArrival(db: Db) {
  /* ═════════ 0 · HẰNG SỐ DÙNG LẠI, KHÔNG GÕ LẠI ═════════ */
  assert.equal(RETURN_ARRIVAL_SKEW_SECONDS, WEBHOOK_CLOCK_SKEW_SECONDS, "dung sai lệch đồng hồ dùng lại đúng hằng số của webhook-gap");
  assert.equal(RETURN_ARRIVAL_MAX_DAYS, 3);

  /* ═════════ 1 · GIEO ═════════ */
  const ids: Record<string, string> = {};
  const legIds: string[] = [];
  for (const [i, c] of CA.entries()) {
    const goc = maGoc(i);
    const orderId = `${P}o-${c.key}`;
    const shipId = `${P}s-${c.key}`;
    ids[c.key] = shipId;
    await db.insert(schema.orders).values({ id: orderId, stage: "DELIVERED", status: 3, cod: 499_000, insertedAt: new Date(T.getTime() - 4 * NGAY * 1000) });
    await db.insert(schema.shipments).values({
      id: shipId,
      orderId,
      carrier: "Viettel Post",
      vtpOrderNumber: goc,
      trackingCode: goc,
      stage: "DELIVERED",
      codAmount: 499_000,
      codCollected: c.codCollected ?? 0,
      shippingFee: 30_000,
      deliveredAt: c.outbound501 ?? T,
      vtpStatusDate: c.outbound501 ?? T,
      vtpStatusName: "Phát thành công",
    });
    if (c.outbound501) {
      await db.insert(schema.shipmentEvents).values({
        shipmentId: shipId,
        source: "VTP_WEBHOOK",
        status: "501",
        statusName: "Thành công - Phát thành công",
        occurredAt: c.outbound501,
        normalizedStage: "DELIVERED",
        legType: c.leg501 ?? "OUTBOUND",
      });
      // Bản sao cùng sự việc từ tệp, mốc lệch vài giây — luật lấy mốc SỚM NHẤT.
      await db.insert(schema.shipmentEvents).values({
        shipmentId: shipId,
        source: "VTP_IMPORT",
        status: "501",
        statusName: "Giao thành công",
        occurredAt: new Date(c.outbound501.getTime() + 4000),
        normalizedStage: "DELIVERED",
        legType: c.leg501 ?? "OUTBOUND",
      });
    }
    if (c.leg) {
      const code = c.leg.code ?? `${goc}${c.leg.suffix ?? "1P1"}`;
      const legId = `${P}leg-${c.key}`;
      legIds.push(legId);
      await db.insert(schema.shipments).values({
        id: legId,
        orderId: null,
        carrier: "Viettel Post",
        vtpOrderNumber: code,
        trackingCode: code,
        orderReference: goc,
        stage: c.leg.stage,
        codAmount: 0,
        shippingFee: 15_000,
        deliveredAt: c.leg.stage === "DELIVERED" ? c.leg.at : null,
        returnedAt: c.leg.stage === "RETURNED" ? c.leg.at : null,
        // Mốc ảnh chụp KHÁC mốc chặng cho kiện RETURNED: nếu luật đọc nhầm cột, ca biên sẽ đỏ.
        vtpStatusDate: c.leg.stage === "RETURNED" ? new Date(c.leg.at.getTime() + 5 * NGAY * 1000) : c.leg.at,
      });
    }
  }

  /* ═════════ 2 · BẢN SQL: TỪNG NHÁNH, KỂ CẢ BIÊN ═════════ */
  const allIds = [...Object.values(ids), ...legIds];
  const sqlMap = await returnArrivalsOf(allIds);
  for (const c of CA) {
    assert.equal(sqlMap.has(ids[c.key]), KY_VONG[c.key], `ca ${c.key}: kỳ vọng ${KY_VONG[c.key] ? "HOÀN VỀ SHOP" : "không"} — nhận ${sqlMap.has(ids[c.key])}`);
  }
  for (const legId of legIds) assert.equal(sqlMap.has(legId), false, "chính dòng chiều hoàn không bao giờ là «vận đơn gốc hoàn về shop»");
  const a = sqlMap.get(ids.a7s);
  assert.ok(a);
  assert.equal(a.outbound501At.getTime(), T.getTime(), "mốc 501 gốc là mốc SỚM NHẤT trong các chứng từ 501 chiều đi");
  assert.equal(a.legCode, `${maGoc(0)}1P1`);
  assert.equal(a.legDeliveredAt.getTime(), giay(7).getTime());
  const l = sqlMap.get(ids["l-returned"]);
  assert.ok(l, "kiện chiều hoàn RETURNED trong cửa sổ ⇒ hoàn về shop");
  assert.equal(l.legDeliveredAt.getTime(), giay(8).getTime(), "kiện RETURNED: mốc về shop đọc `returned_at`, không phải `vtp_status_date`");
  assert.equal(sqlMap.has(ids["e-ret"]), false, "kiện chiều hoàn RETURNING (còn trên đường) ⇒ vẫn KHÔNG");

  /* ═════════ 3 · SQL ≡ TYPESCRIPT TRÊN CÙNG DỮ LIỆU, TỪNG VẬN ĐƠN ═════════ */
  const ships = await db.select().from(schema.shipments).where(like(schema.shipments.id, `${P}%`));
  const ev = await db.select().from(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, ships.map((s) => s.id)));
  const legs: ReturnLegCandidate[] = ships.map((s) => ({ id: s.id, vtpOrderNumber: s.vtpOrderNumber, orderReference: s.orderReference, stage: s.stage, deliveredAt: s.deliveredAt, returnedAt: s.returnedAt, vtpStatusDate: s.vtpStatusDate }));
  for (const s of ships) {
    const moc = ev
      .filter((e) => e.shipmentId === s.id && e.status === "501" && e.legType === "OUTBOUND" && ["VTP_WEBHOOK", "VTP_POLL", "VTP_IMPORT"].includes(e.source))
      .map((e) => e.occurredAt.getTime());
    const ts = detectReturnArrival({ id: s.id, stage: s.stage, vtpOrderNumber: s.vtpOrderNumber, outbound501At: moc.length ? new Date(Math.min(...moc)) : null, legs });
    const q = sqlMap.get(s.id) ?? null;
    assert.deepEqual(
      ts && { at: ts.outbound501At.getTime(), code: ts.legCode, leg: ts.legDeliveredAt.getTime() },
      q && { at: q.outbound501At.getTime(), code: q.legCode, leg: q.legDeliveredAt.getTime() },
      `bản TS và bản SQL phải nói CÙNG một điều về ${s.id}`,
    );
  }
  // Hàm thuần: chạy hai lần ra cùng kết quả.
  const input = { id: ids.a7s, stage: "DELIVERED", vtpOrderNumber: maGoc(0), outbound501At: T, legs };
  assert.deepEqual(detectReturnArrival(input), detectReturnArrival(input));

  /* ═════════ 4 · VẾ DẠNG MÃ: SQL ≡ legBaseCode (REGEX LƯỜI KHÔNG ĐỔI) ═════════ */
  const cap: [string, string][] = [
    ["PKE15357366151P1", "PKE1535736615"],
    ["PKE15357366152P3", "PKE1535736615"],
    ["pke15357366151p1", "PKE1535736615"],
    [" PKE15357366151P1 ", "PKE1535736615"],
    // Thiếu chữ số trước P: regex lười cắt chữ số cuối của mã gốc ⇒ gốc là PKE153573661, KHÔNG phải PKE1535736615.
    ["PKE1535736615P1", "PKE1535736615"],
    ["PKE1535736615P1", "PKE153573661"],
    ["PKE153573661512P1", "PKE1535736615"],
    ["CHPKE1535736615", "PKE1535736615"],
    ["PKE1535736615", "PKE1535736615"],
    ["PKEVRARESHIP9", maGoc(8)],
    ["PKE15089090051P1", "PKE1508909005"],
    ["PKE15089090051P1", "PKE15089090051"],
    ["ABCDEFGHP1", "ABCDEFGH"],
    ["ABCDEFGH1P1", "ABCDEFGH"],
    ["ABCDEFG1P1", "ABCDEFG"],
  ];
  for (const [code, base] of cap) {
    const ts = isReturnLegCodeOf(code, base);
    assert.equal(ts, legBaseCode(code) === base.trim().toUpperCase(), `isReturnLegCodeOf phải đúng bằng legBaseCode cho ${code}/${base}`);
    const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
    const [row] = rowsOf<{ ok: boolean }>(await db.execute(sql.raw(`select ${legShapeSqlForTest(lit(code), lit(base))} as ok`)));
    assert.equal(Boolean(row?.ok), ts, `bản SQL của vế dạng mã phải khớp legBaseCode cho ${JSON.stringify(code)} / ${base} (TS=${ts})`);
  }

  /* ═════════ 5 · NHẬT KÝ: THÊM MỘT DÒNG DERIVED, KHÔNG SỬA DÒNG CARRIER ═════════ */
  const nk = await getShipmentTimeline(ids.a7s);
  const hoanVe = nk.entries.filter((e) => e.eventType === "RETURN_ARRIVAL");
  assert.equal(hoanVe.length, 1, "nhật ký vận đơn gốc phải có ĐÚNG một dòng «Hoàn về shop»");
  assert.equal(hoanVe[0].lane, "DERIVED", "kết luận suy ra đứng ở chiều DERIVED");
  assert.ok(hoanVe[0].detail.includes(`${maGoc(0)}1P1`), "dòng suy ra phải nêu mã kiện chiều hoàn làm căn cứ");
  assert.equal(hoanVe[0].at.getTime(), giay(7).getTime(), "mốc của dòng suy ra là lúc kiện chiều hoàn giao về — lúc đủ căn cứ");
  const chungTu = nk.entries.filter((e) => e.lane === "CARRIER");
  assert.ok(
    chungTu.some((e) => e.title.includes("Phát thành công") && e.after === "Giao thành công"),
    "dòng chứng từ VTP GIỮ NGUYÊN «Phát thành công» / «Giao thành công» (AGENTS 47)",
  );
  const nkD = await getShipmentTimeline(ids.d0);
  assert.equal(nkD.entries.filter((e) => e.eventType === "RETURN_ARRIVAL").length, 0, "không có kiện chiều hoàn ⇒ không có dòng «Hoàn về shop»");
  const nkC = await getShipmentTimeline(ids.c3d1);
  assert.equal(nkC.entries.filter((e) => e.eventType === "RETURN_ARRIVAL").length, 0, "kiện chiều hoàn tới quá 3 ngày ⇒ không kết luận");
  // Chứng từ trong CSDL không bị đụng tới.
  const ev501 = ev.filter((e) => e.shipmentId === ids.a7s && e.status === "501");
  assert.ok(ev501.every((e) => e.normalizedStage === "DELIVERED" && e.legType === "OUTBOUND"));

  /* ═════════ 6 · TRANG VẬN ĐƠN NHẬN NHÃN TỪ CÙNG LUẬT ═════════ */
  const ds = await listShipments(parseListParams({ q: maGoc(0) }, { defaultSort: "createdAt", sortable: ["createdAt"], defaultPeriod: "all" }));
  const dong = ds.rows.find((r) => r.id === ids.a7s);
  assert.ok(dong, "tìm theo mã gốc phải ra vận đơn gốc");
  assert.equal(dong.returnArrival?.legCode, `${maGoc(0)}1P1`, "danh sách vận đơn gắn «Hoàn về shop» bằng chính returnArrivalsOf");
  const dsD = await listShipments(parseListParams({ q: maGoc(3) }, { defaultSort: "createdAt", sortable: ["createdAt"], defaultPeriod: "all" }));
  assert.equal(dsD.rows.find((r) => r.id === ids.d0)?.returnArrival ?? null, null);

  /* ═════════ 7 · ORDER_OUTCOME KHÔNG ĐỔI ═════════ */
  // Bản này KHÔNG chạm ORDER_OUTCOME: ca mẫu vẫn ra đúng kết quả như trước (luật tiền < 50K + vận đơn chiều hoàn
  // thắng chặng DELIVERED; vận đơn giao thật thu đủ tiền vẫn là giao thành công).
  assert.equal(await outcomeOfShipment(ids.a7s), "RETURNED", "ca 5–9 giây: ORDER_OUTCOME vẫn RETURNED như trước");
  assert.equal(await outcomeOfShipment(ids.b2d), "RETURNED", "ca 2 ngày: ORDER_OUTCOME vẫn RETURNED");
  assert.equal(await outcomeOfShipment(ids.d0), "DELIVERED", "giao thật, thu 499.000 ₫, không chiều hoàn ⇒ vẫn DELIVERED");
  assert.equal(await outcomeOfShipment(ids.c3d1), "RETURNED", "nhãn logistics bỏ sót (quá 3 ngày) không làm kết quả đơn đổi — vẫn RETURNED");
  assert.equal(await outcomeOfShipment(ids["l-returned"]), "RETURNED", "kiện chiều hoàn RETURNED: ORDER_OUTCOME vẫn RETURNED");

  /* ═════════ DỌN ═════════ */
  await db.delete(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, ships.map((s) => s.id)));
  await db.delete(schema.shipments).where(like(schema.shipments.id, `${P}%`));
  await db.delete(schema.orders).where(like(schema.orders.id, `${P}%`));
  console.log("✓ «Hoàn về shop»: 13 ca luật (kể cả biên ±120 s / 3 ngày, chiều hoàn DELIVERED hoặc RETURNED), SQL ≡ TS, dạng mã ≡ legBaseCode, nhật ký DERIVED, ORDER_OUTCOME không đổi");
}

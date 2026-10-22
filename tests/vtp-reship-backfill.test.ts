/**
 * ops `vtp-reship-backfill` (P0 22/10/2026): chạy thử không ghi · `--apply` gắn qua ĐÚNG `relinkOrphanShipment` · chạy lại 0 lượt
 * ghi · AMBIGUOUS / tự tham chiếu không bao giờ gắn · vế SĐT «không kiểm được» khi vận đơn mới không có SĐT · script không có câu
 * ghi nào và không luật ghép thứ hai · kênh tóm tắt chỉ số đếm.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { applyGateProblem, applyPlan, measureWindows, parseBackfillArgs, planReship, planSummaryLines, RESHIP_ACTOR, RESHIP_APPLY_BLOCKED, RESHIP_FROM_DAY, RESHIP_REASON, vnToday } from "../scripts/vtp-reship-backfill";

function testPure() {
  assert.deepEqual(parseBackfillArgs([]), { ok: true, apply: false });
  assert.deepEqual(parseBackfillArgs(["--measure"]), { ok: true, apply: false });
  assert.deepEqual(parseBackfillArgs(["--apply"]), { ok: true, apply: true });
  assert.equal(parseBackfillArgs(["--all"]).ok, false, "cờ lạ ⇒ lỗi, không đoán");
  const now = new Date("2026-10-22T18:00:00Z");
  assert.equal(vnToday(now), "2026-10-23", "ngày giờ Việt Nam");
  assert.deepEqual(measureWindows(now).map((w) => w.raw), [{ period: "7d" }, { period: "custom", from: RESHIP_FROM_DAY, to: "2026-10-23" }], "đúng tham số URL người dùng mở");

  // Hàng rào --apply: image chưa có PR2 #981 (CANONICAL_OUTCOME_VERSION < 4) ⇒ từ chối, kèm câu nói rõ hậu quả.
  for (const v of [1, 2, 3]) assert.match(applyGateProblem(v) ?? "", /^#981 chưa lên production — vá bây giờ sẽ trừ tồn hai lần ~73 đơn 15\/10/, `phiên bản ${v} ⇒ từ chối`);
  assert.equal(applyGateProblem(4), null, "image có PR2 ⇒ được ghi");
  assert.equal(applyGateProblem(5), null, "phiên bản sau PR2 ⇒ vẫn được");
  assert.ok(RESHIP_APPLY_BLOCKED.includes("trừ tồn hai lần"));

  const src = readFileSync("scripts/vtp-reship-backfill.ts", "utf8");
  const main = src.slice(src.indexOf("async function main("));
  assert.ok(main.includes("applyGateProblem(CANONICAL_OUTCOME_VERSION)"), "hàng rào đọc hằng số của lib ĐANG CHẠY");
  assert.ok(main.indexOf("applyGateProblem(") < main.indexOf("getDb()") && main.indexOf("applyGateProblem(") < main.indexOf("applyPlan("), "hàng rào đứng TRƯỚC mọi lần mở CSDL và mọi lượt ghi");
  assert.ok(/if \(parsed\.apply\) \{\s*const chan = applyGateProblem/.test(main), "chỉ chặn --apply — chạy thử không bị chặn");
  assert.ok(/const chan = applyGateProblem\(CANONICAL_OUTCOME_VERSION\);\s*if \(chan\) \{[\s\S]{0,200}?process\.exit\(3\);\s*\}/.test(main), "bị từ chối ⇒ DỪNG ngay (mã 3), không đi tiếp tới ghi");
  assert.ok(src.includes('if (CHAY_THANG && !process.argv.slice(2).includes("--apply")) process.env.ERP_READ_ONLY = "1";') && src.includes("show transaction_read_only"), "chạy thử chỉ đọc do Postgres ép + hỏi lại phiên");
  for (const cam of [".insert(", ".update(", ".delete(", "insert into", "update shipments", "update orders", "set order_id"]) assert.ok(!src.toLowerCase().includes(cam.toLowerCase()), `không câu ghi trong script: ${cam}`);
  for (const loi of ["reshipCandidates(", "reshipParentOf(", "relinkOrphanShipment("]) assert.ok(src.includes(loi), `dùng đúng lõi ${loi}`);
  assert.ok(!/legBaseCode|referencedBy|phoneTail/.test(src), "không chép lại luật ghép");
  assert.ok(src.includes("loadReturnsPage(") && src.includes("returnsPageParams("), "GTC qua đúng hàm của /reports/returns");
  assert.ok(src.includes("SHIPMENT_LEFT_WAREHOUSE"), "rời kho theo đúng vị ngữ của sổ kho");
  assert.ok(src.includes("clearMemo();"), "mốc SAU không đọc bộ đệm báo cáo của mốc TRƯỚC");
  const tom = [...src.matchAll(/tomTat\(`([^`]*)`\)/g)].map((m) => m[1]);
  // Biểu thức in ra GIÁ TRỊ của một khoá (kết thúc bằng tên khoá) là cấm; `${pairs.filter((p) => … p.origId …).length}` in số đếm thì được.
  assert.ok(tom.length >= 4 && tom.every((t) => !/\$\{[^}]*\b(shipmentId|orderId|origId|newId|vtp_order_number|order_reference|code|ref)\s*\}/.test(t)), "kênh tóm tắt chỉ có số đếm");
  assert.ok(/\$\{[^}]*\b(orderId)\s*\}/.test("x ${r.orderId} y"), "phép kiểm bắt được một lần in khoá thật");
}

async function testFlow(db: Db) {
  const s = schema.shipments;
  const ids = ["rsb-goc", "rsb-moi", "rsb-tu", "rsb-amb-a", "rsb-amb-b", "rsb-amb-moi"];
  const wipe = async () => {
    await db.delete(s).where(inArray(s.id, ids));
    await db.delete(schema.orders).where(like(schema.orders.id, "rsb-o%"));
    await db.delete(schema.auditLogs).where(and(eq(schema.auditLogs.entity, "SHIPMENT"), inArray(schema.auditLogs.entityId, ids)));
  };
  await wipe();
  try {
    const order = (id: string, systemId: number) => db.insert(schema.orders).values({ id, systemId, stage: "CANCELLED", cod: 499000, insertedAt: new Date("2026-10-15T00:00:00Z") });
    await order("rsb-o1", 993001);
    await order("rsb-o2", 993002);
    await order("rsb-o3", 993003);
    await db.insert(s).values([
      // Gốc Pancake (đơn rsb-o1) + vận đơn tạo lại trên web: số VTP 12 chữ, tham chiếu = số vận đơn gốc.
      { id: "rsb-goc", orderId: "rsb-o1", carrier: "Viettel Post", vtpOrderNumber: "PKERSB00001", trackingCode: "PKERSB00001", codAmount: 499000, attemptNo: 1, direction: "OUTBOUND" },
      { id: "rsb-moi", carrier: "Viettel Post", vtpOrderNumber: "155000000001", trackingCode: "155000000001", orderReference: "pkersb00001", codAmount: 499000 },
      // Lô «154»: tham chiếu = chính nó ⇒ không gắn.
      { id: "rsb-tu", carrier: "Viettel Post", vtpOrderNumber: "154000000001", trackingCode: "154000000001", orderReference: "154000000001", codAmount: 499000 },
      // Hai đơn cùng mang một mã tra cứu (dòng chưa có mã VTP) ⇒ AMBIGUOUS, không đoán.
      { id: "rsb-amb-a", orderId: "rsb-o2", carrier: "Viettel Post", trackingCode: "TRKRSBAMB01" },
      { id: "rsb-amb-b", orderId: "rsb-o3", carrier: "Viettel Post", trackingCode: "TRKRSBAMB01" },
      { id: "rsb-amb-moi", carrier: "Viettel Post", vtpOrderNumber: "155000000002", trackingCode: "155000000002", orderReference: "TRKRSBAMB01" },
    ]);
    const anh = async () => JSON.stringify((await db.select({ id: s.id, orderId: s.orderId, attemptNo: s.attemptNo, direction: s.direction }).from(s).where(inArray(s.id, ids))).sort((a, b) => a.id.localeCompare(b.id)));

    // ── CHẠY THỬ: kế hoạch đúng, không ghi gì ──
    const a0 = await anh();
    const plan = await planReship(db);
    assert.equal(await anh(), a0, "lập kế hoạch không đổi một dòng nào");
    const mine = (id: string) => plan.find((r) => r.shipmentId === id)!;
    assert.deepEqual([mine("rsb-moi").verdict.kind, mine("rsb-moi").matchedBy], ["ATTEMPT", "VTP"], "tham chiếu = số vận đơn gốc (không phân biệt hoa thường) ⇒ lần gửi kế");
    assert.deepEqual(mine("rsb-tu").verdict, { kind: "NONE", reason: "SELF_REFERENCE" }, "tự tham chiếu ⇒ không gắn");
    assert.deepEqual(mine("rsb-amb-moi").verdict, { kind: "HOLD", reason: "AMBIGUOUS", candidates: 2 }, "hai đơn ⇒ giữ lại, không đoán");
    assert.ok(!mine("rsb-moi").phoneChecked, "vận đơn mới không có SĐT ⇒ vế SĐT không kiểm được");
    const lines = planSummaryLines(plan.filter((r) => ids.includes(r.shipmentId)));
    assert.ok(lines.some((l) => /gắn được \(ATTEMPT\) 1 \(1 đơn\) · khớp mã VTP cấp 1 · chỉ khớp mã tra cứu của dòng chưa có mã VTP 0/.test(l)), lines.join(" | "));
    assert.ok(lines.some((l) => l.includes("HOLD/AMBIGUOUS 1") && l.includes("NONE/SELF_REFERENCE 1")));
    assert.ok(lines.some((l) => l.includes("KHÔNG KIỂM ĐƯỢC ở 3/3 dòng")), "PHONE_MISMATCH «không kiểm được», không in 0 như đã khớp");
    for (const l of lines) for (const bad of ["PKERSB", "155000000001", "rsb-"]) assert.ok(!l.includes(bad), `tóm tắt không mang mã: ${bad}`);

    // ── GHI: chỉ dòng ATTEMPT, qua relinkOrphanShipment ──
    const now = new Date("2026-10-23T02:00:00Z");
    const res = await applyPlan(db, plan.filter((r) => ids.includes(r.shipmentId)), now);
    assert.deepEqual(res, { LINKED: 1 }, "đúng một dòng được gắn");
    const [moi] = await db.select().from(s).where(eq(s.id, "rsb-moi"));
    assert.deepEqual([moi.orderId, moi.attemptNo, moi.direction], ["rsb-o1", 2, "OUTBOUND"], "lần gửi kế của CÙNG đơn");
    for (const id of ["rsb-tu", "rsb-amb-moi"]) assert.equal((await db.select({ o: s.orderId }).from(s).where(eq(s.id, id)))[0].o, null, `${id} vẫn mồ côi`);
    const [au] = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "SHIPMENT_RESHIP_RELINK"), eq(schema.auditLogs.entityId, "rsb-moi")));
    assert.ok(au && au.reason === RESHIP_REASON && au.userEmail === RESHIP_ACTOR, "audit mang lý do P0 và người thao tác là script");

    // ── CHẠY LẠI: 0 lượt ghi ──
    const a1 = await anh();
    const plan2 = (await planReship(db)).filter((r) => ids.includes(r.shipmentId));
    assert.ok(!plan2.some((r) => r.shipmentId === "rsb-moi"), "dòng đã gắn không còn trong tập mồ côi");
    assert.deepEqual(await applyPlan(db, plan2, now), { LINKED: 0 }, "chạy lại ⇒ 0 lượt ghi");
    assert.deepEqual(await applyPlan(db, plan.filter((r) => r.shipmentId === "rsb-moi"), now), { LINKED: 0, ALREADY_LINKED: 1 }, "kế hoạch cũ áp lại ⇒ ALREADY_LINKED, không ghi đè");
    assert.equal(await anh(), a1, "chạy lại không đổi dòng nào");
  } finally {
    await wipe();
  }
}

export async function testVtpReshipBackfill(db: Db) {
  testPure();
  await testFlow(db);
  console.log("  ✓ vtp-reship-backfill: chạy thử không ghi · gắn qua relinkOrphanShipment (lần gửi kế, audit lý do P0) · chạy lại 0 lượt ghi · AMBIGUOUS / tự tham chiếu không gắn · SĐT «không kiểm được» · GTC qua hàm /reports/returns · không câu ghi, không luật thứ hai trong script · tóm tắt chỉ số đếm");
}

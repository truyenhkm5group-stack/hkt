/**
 * Ops `shipment-origin-audit` (chủ shop 18/10/2026, HSLC — «chưa mặc định mọi vận đơn đều tạo từ ERP»):
 *  1. hàm phân loại THUẦN: đủ sáu nhóm (ERP_CREATED · POS_OR_PANCAKE · CARRIER_ONLY_NO_ORDER · CARRIER_ONLY · CONFLICT · UNKNOWN),
 *     thứ tự ưu tiên, lượt tạo ERP chưa xác nhận ⇒ UNKNOWN (không bao giờ «coi như ERP»), đối số được soát;
 *  2. CSDL thật (dòng dựng riêng, tự dọn): mỗi dòng vào đúng nhóm, đơn ERP «Đã xác nhận» thiếu xã có vận đơn ⇒ «đã có vận đơn dù ERP
 *     đang giữ» (NO_WARD, hỏi bằng decideShippingRoute), gói GHTK không khớp ⇒ chỉ có gói webhook, gợi ý SĐT không đổi nhóm;
 *     kênh tóm tắt không lọt mã vận đơn / SĐT / mã đơn;
 *  3. chỉ đọc, xả stdout trước khi thoát, khai đủ bốn chỗ ở ops-vps + platform-isolation-static.
 * Không mốc tuyệt đối: dòng dựng với mốc mặc định của CSDL, cửa sổ đọc «1 ngày trước giờ chạy» đi cùng nhịp đồng hồ (mục 50/65).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { auditShipmentOrigin, carrierBucket, classifyShipmentOrigin, ORIGIN_CLASSES, parseOriginArgs, referenceShape, type ShipmentEvidence } from "../scripts/shipment-origin-audit";

const base = (over: Partial<ShipmentEvidence> = {}): ShipmentEvidence => ({
  orderKind: "ERP",
  orderShort: "42F28794",
  code: "PKE100",
  erpCreate: null,
  erpAudit: null,
  carrierReference: null,
  pancake: { raw: false, syncedAt: false, partnerId: false, event: false },
  carrier: { events: false, rawVtp: false, vtpSyncedAt: false, statement: false, packetOnly: false },
  ...over,
});
const carrierSeen = { events: true, rawVtp: true, vtpSyncedAt: false, statement: false, packetOnly: false };

function testPure() {
  assert.deepEqual(parseOriginArgs(["hslc-hmt-shop"]), { code: "hslc-hmt-shop", days: 30 });
  assert.deepEqual(parseOriginArgs(["hslc-hmt-shop", "--days=90"]), { code: "hslc-hmt-shop", days: 90 });
  const since = parseOriginArgs(["hslc", "--since=2026-10-14T08:10Z"]);
  assert.ok(!("error" in since) && since.since?.toISOString() === "2026-10-14T08:10:00.000Z");
  for (const bad of [[], ["HSLC"], ["hslc", "--days=0"], ["hslc", "--days=91"], ["hslc", "--days=2.5"], ["hslc", "--since=hôm qua"], ["hslc", "--apply"]]) assert.ok("error" in parseOriginArgs(bad), `phải từ chối: ${bad.join(" ")}`);

  assert.equal(referenceShape("ERP42F28794-1"), "ERP");
  assert.equal(referenceShape("erp42f28794-2"), "ERP");
  assert.equal(referenceShape("123456"), "DIGITS");
  assert.equal(referenceShape("POS-77"), "OTHER");
  assert.equal(referenceShape(null), "NONE");
  assert.equal(carrierBucket("Viettel Post"), "VTP");
  assert.equal(carrierBucket("Giao Hàng Tiết Kiệm"), "GHTK");
  assert.equal(carrierBucket("GHN"), "GHN");
  assert.equal(carrierBucket("J&T Express"), "JT");
  assert.equal(carrierBucket(""), "TRONG");
  assert.equal(carrierBucket("Xe nhà"), "KHAC");

  const created = { state: "CREATED" as const, reference: "ERP42F28794-1" };
  // ERP_CREATED — ba căn cứ độc lập, mỗi cái đủ một mình.
  assert.equal(classifyShipmentOrigin(base({ erpCreate: created, carrier: carrierSeen })).cls, "ERP_CREATED");
  assert.equal(classifyShipmentOrigin(base({ erpAudit: { trackingCode: "PKE100" } })).cls, "ERP_CREATED");
  const echo = classifyShipmentOrigin(base({ orderKind: "NONE", orderShort: null, carrierReference: "ERP42F28794-1", carrier: carrierSeen }));
  assert.equal(echo.cls, "ERP_CREATED", "hãng gửi lại mã tham chiếu dạng ERP (chỉ ERP sinh dạng này) ⇒ ERP tạo, dù dòng ERP đã mất");
  assert.ok(echo.keys.includes("CARRIER_ECHOED_ERP_REF") && echo.keys.includes("NO_ORDER"));
  // Lượt tạo ERP chưa xác nhận ⇒ UNKNOWN, không «coi như ERP».
  const pending = classifyShipmentOrigin(base({ erpCreate: { state: "UNKNOWN", reference: "ERP42F28794-1" }, carrier: carrierSeen }));
  assert.equal(pending.cls, "UNKNOWN");
  assert.ok(pending.keys.includes("ERP_REQUEST_UNCONFIRMED") && pending.keys.includes("ERP_CREATE_UNKNOWN"));
  // POS_OR_PANCAKE thắng chứng từ hãng (Pancake biết vận đơn trước, hãng báo hành trình sau).
  assert.equal(classifyShipmentOrigin(base({ orderKind: "SYNCED", orderShort: null, pancake: { raw: true, syncedAt: true, partnerId: true, event: false }, carrier: carrierSeen })).cls, "POS_OR_PANCAKE");
  // CARRIER_ONLY_NO_ORDER vs CARRIER_ONLY — tách theo có gắn đơn hay không.
  assert.equal(classifyShipmentOrigin(base({ orderKind: "NONE", orderShort: null, carrierReference: "12345", carrier: carrierSeen })).cls, "CARRIER_ONLY_NO_ORDER");
  assert.equal(classifyShipmentOrigin(base({ orderKind: "NONE", orderShort: null, carrier: { ...carrierSeen, events: false, rawVtp: false, packetOnly: true } })).cls, "CARRIER_ONLY_NO_ORDER");
  assert.equal(classifyShipmentOrigin(base({ carrier: carrierSeen })).cls, "CARRIER_ONLY", "gắn đơn ERP mà không có dấu tạo nào của ERP");
  // CONFLICT — đứng trên mọi nhóm.
  const conflicts: [Partial<ShipmentEvidence>, string][] = [
    [{ erpCreate: created, pancake: { raw: true, syncedAt: false, partnerId: false, event: false } }, "CONFLICT_ERP_AND_PANCAKE"],
    [{ erpCreate: created, erpAudit: { trackingCode: "PKE999" } }, "CONFLICT_AUDIT_CODE_MISMATCH"],
    [{ orderKind: "SYNCED", orderShort: null, erpCreate: created }, "CONFLICT_ERP_ON_NON_ERP_ORDER"],
    [{ carrierReference: "ERPAAAAAAAA-1", carrier: carrierSeen }, "CONFLICT_CARRIER_REF_OTHER_ORDER"],
    [{ erpCreate: created, carrierReference: "ERP42F28794-2" }, "CONFLICT_CARRIER_REF_NE_ERP_REF"],
  ];
  for (const [over, key] of conflicts) {
    const v = classifyShipmentOrigin(base(over));
    assert.equal(v.cls, "CONFLICT", key);
    assert.ok((v.keys as string[]).includes(key), `${key}: ${v.keys.join("+")}`);
  }
  // UNKNOWN — không căn cứ nào: GIỮ UNKNOWN.
  const none = classifyShipmentOrigin(base({ orderKind: "NONE", orderShort: null }));
  assert.equal(none.cls, "UNKNOWN");
  assert.ok(none.keys.includes("NO_SOURCE_MARKER"));
  assert.deepEqual([...ORIGIN_CLASSES], ["ERP_CREATED", "POS_OR_PANCAKE", "CARRIER_ONLY_NO_ORDER", "CARRIER_ONLY", "CONFLICT", "UNKNOWN"]);
}

function testSource() {
  const src = readFileSync("scripts/shipment-origin-audit.ts", "utf8");
  assert.match(src, /process\.env\.ERP_READ_ONLY = "1"/);
  assert.match(src, /show default_transaction_read_only/);
  assert.match(src, /getDbForInspection\(/);
  assert.match(src, /decideShippingRoute\(/, "hỏi tuyến giao bằng CHÍNH hàm của nó");
  assert.match(src, /process\.stdout\.write\("", \(\) => process\.exit/, "xả stdout trước khi thoát");
  assert.doesNotMatch(src, /\.(insert|update|delete)\(|\binsert into\b|\bupdate \w+ set\b/i, "script không câu ghi");
  assert.ok(!/\(\?<[=!]/.test(src), "không nhìn-ngược");
  for (const line of src.split("\n").filter((l) => /tomTat\(`/.test(l))) assert.doesNotMatch(line, /\$\{(?:codeOf|r\.trackingCode|r\.vtpOrderNumber|p\.code|p\.ref|r\.vtpRef|sp\.phone|orderLabel|manualOrderShortCode)\b/, `dòng tóm tắt không in mã / SĐT: ${line.trim().slice(0, 120)}`);
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8").replace(/\r\n/g, "\n");
  assert.match(ops, /- shipment-origin-audit\s+#/, "ops-vps khai lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bshipment-origin-audit\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\bshipment-origin-audit\b/, "làn ĐỌC nặng");
  assert.match(ops, /\n\s+shipment-origin-audit\)\n[\s\S]*?kiem_arg\n\s+ma_hoa_ket_qua chay_voi_arg[^\n]*scripts\/shipment-origin-audit\.ts ;;/, "nhánh chạy đúng script, soát arg, trong ma_hoa_ket_qua");
  assert.ok(readFileSync("tests/platform-isolation-static.test.ts", "utf8").includes('"scripts/shipment-origin-audit.ts":'), "khai getDbForInspection ở platform-isolation-static");
}

async function capture<T>(fn: () => Promise<T>): Promise<{ printed: string[]; result: T }> {
  const printed: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  try {
    return { printed, result: await fn() };
  } finally {
    console.log = orig;
  }
}

async function testDb() {
  const db = await getDb();
  const tag = randomUUID().slice(0, 6).toUpperCase();
  const erpA = `erp-${randomUUID()}`;
  const erpB = `erp-${randomUUID()}`;
  const synced = `soa-pk-${tag}`;
  const shortA = erpA.slice(4, 12).toUpperCase();
  const PHONE = "0900007718";
  const codes = { erp: `SOA${tag}E`, carrierLinked: `SOA${tag}C`, orphan: `SOA${tag}O`, pancake: `SOA${tag}P`, conflict: `SOA${tag}X`, unknown: `SOA${tag}U`, packet: `SOA${tag}G` };
  const shipIds: string[] = [];
  const webhookIds: string[] = [];
  try {
    await db.insert(schema.orders).values([
      { id: erpA, stage: "CONFIRMED", origin: "AI_AGENT", shipPhone: PHONE, shipProvince: "Thành phố Hà Nội", shipCommune: "Phường Ba Đình", totalPriceAfterDiscount: 280_000, insertedAt: new Date() },
      { id: erpB, stage: "CONFIRMED", origin: "AI_AGENT", shipPhone: "0900007719", shipProvince: "Thành phố Hà Nội", shipCommune: "", totalPriceAfterDiscount: 280_000, insertedAt: new Date() },
      { id: synced, stage: "SHIPPED", totalPriceAfterDiscount: 300_000, insertedAt: new Date() },
    ] as (typeof schema.orders.$inferInsert)[]);
    const at = new Date().toISOString();
    const rows = await db
      .insert(schema.shipments)
      .values([
        { orderId: erpA, attemptNo: 1, carrier: "Viettel Post", trackingCode: codes.erp, vtpOrderNumber: codes.erp, orderReference: `ERP${shortA}-1`, raw: { carrierCreate: { state: "CREATED", carrier: "VTP", reference: `ERP${shortA}-1`, by: null, at }, vtp: { ORDER_REFERENCE: `ERP${shortA}-1` } } },
        { orderId: erpB, attemptNo: 1, carrier: "Viettel Post", trackingCode: codes.carrierLinked, vtpOrderNumber: codes.carrierLinked, raw: { vtp: { ORDER_REFERENCE: "778899" } } },
        { orderId: null, carrier: "Viettel Post", trackingCode: codes.orphan, vtpOrderNumber: codes.orphan, receiverPhone: PHONE, raw: { vtp: { ORDER_REFERENCE: "12345" } } },
        { orderId: synced, attemptNo: 1, carrier: "Giao Hàng Tiết Kiệm", trackingCode: codes.pancake, partnerId: 5, lastPancakeSyncAt: new Date(), raw: { pancake: { id: 1 } } },
        { orderId: synced, attemptNo: 2, carrier: "Giao Hàng Tiết Kiệm", trackingCode: codes.conflict, lastPancakeSyncAt: new Date(), raw: { pancake: { id: 2 }, carrierCreate: { state: "CREATED", carrier: "GHTK", reference: "ERPZZZZZZZZ-1", by: null, at } } },
        { orderId: null, carrier: "", trackingCode: codes.unknown },
      ] as (typeof schema.shipments.$inferInsert)[])
      .returning({ id: schema.shipments.id, code: schema.shipments.trackingCode });
    shipIds.push(...rows.map((r) => r.id));
    const idOf = (c: string) => rows.find((r) => r.code === c)!.id;
    await db.insert(schema.shipmentEvents).values([
      { shipmentId: idOf(codes.carrierLinked), source: "VTP_WEBHOOK", status: "200", statusName: "Nhận từ bưu tá", occurredAt: new Date(), normalizedStage: "PICKED_UP" },
      { shipmentId: idOf(codes.orphan), source: "VTP_WEBHOOK", status: "200", statusName: "Nhận từ bưu tá", occurredAt: new Date(), normalizedStage: "PICKED_UP" },
    ] as (typeof schema.shipmentEvents.$inferInsert)[]);
    await db.insert(schema.auditLogs).values({ userEmail: "job:shipping-route", action: "SHIPMENT_CARRIER_CREATE", entity: "ORDER", entityId: erpA, detail: { after: { carrier: "VTP", shipmentId: idOf(codes.erp), trackingCode: codes.erp } } });
    const [pkt] = await db.insert(schema.webhookEvents).values({ source: "GHTK", eventType: "status_3", externalId: codes.packet, payload: { label_id: codes.packet, partner_id: "POS-77" }, dedupeKey: `soa-${tag}` }).returning({ id: schema.webhookEvents.id });
    webhookIds.push(pkt.id);

    const now = new Date();
    const { printed, result } = await capture(() => auditShipmentOrigin(db, new Date(now.getTime() - 86_400_000), now, "1 ngày"));
    const line = (c: string) => printed.find((l) => l.includes(c) && !l.startsWith("[ops:tom-tat]") && !l.includes("GIỮ ") && !l.includes("GỢI Ý")) ?? "";
    assert.match(line(codes.erp), /· ERP_CREATED · căn cứ .*ERP_CREATE_CREATED.*AUDIT_CARRIER_CREATE.*CARRIER_ECHOED_ERP_REF/, line(codes.erp));
    assert.match(line(codes.carrierLinked), / · CARRIER_ONLY · /, line(codes.carrierLinked));
    assert.match(line(codes.orphan), /không đơn .* · CARRIER_ONLY_NO_ORDER · /, line(codes.orphan));
    assert.match(line(codes.pancake), / · GHTK · .* · POS_OR_PANCAKE · /, line(codes.pancake));
    assert.match(line(codes.conflict), / · CONFLICT · .*CONFLICT_ERP_AND_PANCAKE/, line(codes.conflict));
    assert.match(line(codes.unknown), / · UNKNOWN · .*NO_SOURCE_MARKER/, line(codes.unknown));
    assert.match(line(codes.packet), /không dòng vận đơn · GHTK · .*tham chiếu OTHER · CARRIER_ONLY_NO_ORDER · căn cứ .*WEBHOOK_PACKET_ONLY/, line(codes.packet));
    // Đơn B «Đã xác nhận» thiếu xã có vận đơn sống ⇒ ERP đang giữ NO_WARD mà vẫn có vận đơn; đơn A có xã ⇒ không giữ vì địa chỉ.
    const shortB = erpB.slice(4, 12).toUpperCase();
    assert.ok(printed.some((l) => l.includes(`GIỮ NO_WARD · #${shortB}`) && l.includes("CARRIER_ONLY")), "đã có vận đơn dù ERP đang giữ (NO_WARD)");
    assert.ok(!printed.some((l) => l.includes(`GIỮ NO_WARD · #${shortA}`)));
    assert.ok(result.held.held >= 1 && (result.held.byCode.get("NO_WARD") ?? 0) >= 1);
    assert.ok(result.missingAddress.ward >= 1);
    // Gợi ý SĐT: vận đơn mồ côi trùng SĐT đơn A — chỉ là đầu mối, nhóm vẫn CARRIER_ONLY_NO_ORDER.
    assert.ok(printed.some((l) => l.includes("GỢI Ý SĐT") && l.includes(codes.orphan) && l.includes(`#${shortA}`) && l.includes("CARRIER_ONLY_NO_ORDER")));
    assert.ok(result.phoneHint.shipments >= 1 && result.phoneHint.ordersWithErpShipment >= 1);
    for (const c of ORIGIN_CLASSES) assert.ok((result.classes.get(c) ?? 0) >= 1, `nhóm ${c} có mặt`);
    // Kênh tóm tắt: số đếm, không mã vận đơn / SĐT / mã đơn.
    const summary = printed.filter((l) => l.startsWith("[ops:tom-tat]"));
    assert.ok(summary.some((l) => /CARRIER_ONLY_NO_ORDER [1-9]/.test(l)), summary.join("\n"));
    assert.ok(summary.some((l) => /ĐÃ CÓ VẬN ĐƠN DÙ ERP ĐANG GIỮ [1-9]\d*: .*NO_WARD [1-9]/.test(l)), summary.join("\n"));
    for (const l of summary) {
      for (const c of Object.values(codes)) assert.ok(!l.includes(c), `tóm tắt lọt mã vận đơn: ${l}`);
      assert.ok(!l.includes(PHONE) && !l.includes(shortA) && !l.includes(shortB), `tóm tắt lọt SĐT / mã đơn: ${l}`);
    }
    for (const l of printed) assert.ok(!l.includes(PHONE), `không in SĐT ở bất kỳ đâu: ${l}`);
  } finally {
    if (shipIds.length) await db.delete(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, shipIds));
    if (shipIds.length) await db.delete(schema.shipments).where(inArray(schema.shipments.id, shipIds));
    await db.delete(schema.auditLogs).where(inArray(schema.auditLogs.entityId, [erpA, erpB]));
    if (webhookIds.length) await db.delete(schema.webhookEvents).where(inArray(schema.webhookEvents.id, webhookIds));
    await db.delete(schema.orders).where(inArray(schema.orders.id, [erpA, erpB, synced]));
  }
}

export async function testShipmentOriginAudit() {
  testPure();
  testSource();
  await testDb();
  console.log("  ✓ ops shipment-origin-audit: sáu nhóm nguồn gốc vận đơn (ERP · POS/Pancake · chỉ hãng không đơn · chỉ hãng · cãi nhau · chưa biết), lượt tạo ERP chưa xác nhận ⇒ UNKNOWN, đơn thiếu xã có vận đơn dù ERP giữ NO_WARD, gói GHTK không khớp ⇒ ngoài ERP, gợi ý SĐT không đổi nhóm; tóm tắt chỉ số đếm; chỉ đọc, khai đủ bốn chỗ");
}

if (process.argv[1] && /shipment-origin-audit\.test\.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testShipmentOriginAudit)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}

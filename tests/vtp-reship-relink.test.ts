/**
 * ═══════════ VẬN ĐƠN TẠO LẠI TRÊN WEB VIETTEL POST — GẮN VỀ ĐÚNG ĐƠN (P0 chủ shop 22/10/2026) ═══════════
 *
 * Ca thật (đo production 22/10/2026, ẩn danh ở đây): shop tạo LẠI vận đơn trên viettelpost.vn cho chính đơn của mình —
 * mã mới là số VTP 12 chữ, `ORDER_REFERENCE` / cột «Mã đơn hàng» là SỐ VẬN ĐƠN GỐC. Trước bản này 330 vận đơn như vậy
 * thành dòng mồ côi và GTC tụt đúng bằng số đơn ấy.
 *
 * Khoá:
 *  1. Hàm thuần `reshipParentOf`: không tham chiếu · chiều hoàn [số]P[số] · tự tham chiếu · không vận đơn gốc ⇒ NONE;
 *     đúng một đơn ⇒ ATTEMPT; nhiều đơn ⇒ HOLD AMBIGUOUS; khác SĐT ⇒ HOLD PHONE_MISMATCH; mã tra cứu chỉ tính khi dòng
 *     chưa có mã VTP (ca PKE1508295104).
 *  2. Webhook: gửi lại có tham chiếu ⇒ lần gửi kế CỦA CÙNG ĐƠN (attempt_no + 1, OUTBOUND, vết raw.reship) · gói trùng /
 *     sai thứ tự ⇒ vẫn MỘT dòng · lô không tham chiếu (VTP 107) ⇒ mồ côi như cũ · mơ hồ ⇒ mồ côi + raw.relink ·
 *     chiều hoàn mang tham chiếu mã gốc ⇒ KHÔNG thành lần gửi kế.
 *  3. `relinkOrphanShipment` (đường ghi của script vá dòng cũ): gắn đúng một lần, chạy lại ⇒ ALREADY_LINKED, có audit.
 *  4. Nhập tệp «Danh sách vận đơn» dùng CÙNG luật: tham chiếu vận đơn gốc ⇒ lần gửi kế; không gắn được ⇒ TẠO dòng mồ
 *     côi; thiếu thu hộ / cước ⇒ không tạo (ô chưa biết không thành 0).
 *  5. Đa tổ chức: ứng viên chỉ đọc bằng CSDL của tổ chức đang xử lý (quét mã nguồn).
 * Dữ liệu dựng, không PII.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq, inArray, like, or } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import type { VtpTrackingRecord } from "@/lib/integrations/viettelpost/client";
import { phoneTail, relinkOrphanShipment, reshipCandidates, reshipParentOf, type ReshipCandidate } from "@/lib/integrations/viettelpost/reship";
import { applyVtpOrderList, matchVtpOrderList, orderListRowCreatable } from "@/lib/integrations/viettelpost/statement-db";
import type { VtpOrderListRow } from "@/lib/integrations/viettelpost/statement";
import { applyVtpTracking } from "@/lib/integrations/viettelpost/sync";
import { getVtpSyncCoverage } from "@/lib/queries/vtp-sync-coverage";

const track = (orderNumber: string, status: number | null, statusName: string, at: string, extra: Partial<VtpTrackingRecord> = {}): VtpTrackingRecord => ({
  orderNumber,
  orderReference: "",
  status,
  statusName,
  statusDate: new Date(at),
  location: "",
  note: "",
  reasonCode: null,
  isReturning: null,
  moneyCollectionOrigin: null,
  moneyCollection: 499000,
  moneyTotal: 0,
  moneyTotalFee: 0,
  moneyFeeCod: 0,
  productWeight: 0,
  service: "",
  expectedDelivery: "",
  receiverName: "",
  receiverPhone: "",
  receiverAddress: "",
  employeeName: "",
  employeePhone: "",
  journey: [],
  raw: {},
  ...extra,
});

const cand = (over: Partial<ReshipCandidate>): ReshipCandidate => ({ id: "s1", orderId: "o1", vtpOrderNumber: "PKE1500000001", trackingCode: "PKE1500000001", direction: "OUTBOUND", phone: null, ...over });

export function testVtpReshipPure() {
  const inp = (orderReference: string, orderNumber = "123456789012", receiverPhone = "") => ({ orderNumber, orderReference, receiverPhone });
  assert.deepEqual(reshipParentOf(inp(""), [cand({})]), { kind: "NONE", reason: "NO_REFERENCE" });
  assert.deepEqual(reshipParentOf(inp("PKE1500000001", "PKE15000000011P1"), [cand({})]), { kind: "NONE", reason: "RETURN_LEG" }, "chiều hoàn mang mã gốc trong tham chiếu ⇒ KHÔNG BAO GIỜ là lần gửi kế (AGENTS 3.7)");
  assert.deepEqual(reshipParentOf(inp("PKE1500000001", "pke1500000001"), [cand({})]), { kind: "NONE", reason: "SELF_REFERENCE" });
  assert.deepEqual(reshipParentOf(inp("PKE1500000001"), [cand({ orderId: null })]), { kind: "NONE", reason: "NO_PARENT" }, "vận đơn gốc chưa có đơn ⇒ không có gì để gắn");
  assert.deepEqual(reshipParentOf(inp("PKE1500000001"), [cand({ direction: "RETURN" })]), { kind: "NONE", reason: "NO_PARENT" }, "dòng chiều hoàn không làm vận đơn gốc");
  assert.deepEqual(reshipParentOf(inp("pke1500000001"), [cand({})]), { kind: "ATTEMPT", orderId: "o1", parentShipmentId: "s1" }, "không phân biệt hoa thường");
  assert.deepEqual(reshipParentOf(inp("TRK-1"), [cand({ id: "a", orderId: "o1", vtpOrderNumber: null, trackingCode: "TRK-1" }), cand({ id: "b", orderId: "o2", vtpOrderNumber: null, trackingCode: "TRK-1" })]), { kind: "HOLD", reason: "AMBIGUOUS", candidates: 2 });
  assert.deepEqual(reshipParentOf(inp("PKE1500000001", "123456789012", "0961 000 111"), [cand({ phone: "+84961000222" })]), { kind: "HOLD", reason: "PHONE_MISMATCH", candidates: 1 });
  assert.equal(reshipParentOf(inp("PKE1500000001", "123456789012", "0961000111"), [cand({ phone: "84961000111" })]).kind, "ATTEMPT", "cùng thuê bao, khác cách ghi ⇒ khớp");
  assert.equal(reshipParentOf(inp("PKE1500000001", "123456789012", ""), [cand({ phone: "0961000222" })]).kind, "ATTEMPT", "webhook không có SĐT ⇒ không có bằng chứng ngược, mã đứng một mình");
  // Ca PKE1508295104: tham chiếu trùng MÃ TRA CỨU của một vận đơn đã có mã VTP KHÁC ⇒ không phải vận đơn gốc.
  assert.deepEqual(reshipParentOf(inp("PKE10911261809"), [cand({ vtpOrderNumber: "PKE1508000000", trackingCode: "PKE10911261809" })]), { kind: "NONE", reason: "NO_PARENT" }, "mã tra cứu chỉ tính khi dòng chưa có mã VTP");
  assert.equal(reshipParentOf(inp("TRK-2"), [cand({ vtpOrderNumber: null, trackingCode: "trk-2" })]).kind, "ATTEMPT", "vận đơn Pancake chỉ mang mã tra cứu ⇒ vẫn là vận đơn gốc");
  assert.deepEqual([phoneTail("+84 961 000 111"), phoneTail("0961000111"), phoneTail("123")], ["961000111", "961000111", ""]);
  // Đa tổ chức: ứng viên chỉ đọc bằng CSDL của tổ chức đang xử lý; hai đường gọi đúng hàm, không tự viết luật.
  const sync = readFileSync("lib/integrations/viettelpost/sync.ts", "utf8");
  assert.match(sync, /reshipParentOf\(record, ref \? \(\(await reshipCandidates\(db, \[ref\]\)\)/, "webhook gom ứng viên bằng `db` của tổ chức (getDb trong applyVtpTracking)");
  assert.match(readFileSync("lib/integrations/viettelpost/statement-db.ts", "utf8"), /reshipParentOf\(\{ orderNumber: r\.trackingCode, orderReference: r\.orderCode, receiverPhone: r\.receiverPhone \}/, "nhập tệp dùng CÙNG hàm ghép");
  assert.doesNotMatch(readFileSync("lib/integrations/viettelpost/reship.ts", "utf8"), /getDb\(|getPlatformDb\(/, "luật ghép không tự mở CSDL — không có đường nào đọc chéo tổ chức");
  console.log("  ✓ thuần: không tham chiếu · chiều hoàn · tự tham chiếu · không vận đơn gốc ⇒ đường cũ · một đơn ⇒ lần gửi kế · nhiều đơn / khác SĐT ⇒ giữ · mã tra cứu chỉ khi chưa có mã VTP · một luật hai đường");
}

/** Mã vận đơn bài này gieo — dọn sạch sau bài để không đổi tổng của các bài khác trong cùng khối (AGENTS 6.3). */
const CODES = ["PKERSGOC01", "823456789012", "154000000001", "823456789013", "PKERSGOC011P1", "PKERSGOC04", "823456789014", "PKERSGOC05", "923456789015", "923456789016", "923456789017"];

async function donDep(db: Db) {
  const s = schema.shipments;
  const ids = (await db.select({ id: s.id }).from(s).where(or(inArray(s.vtpOrderNumber, CODES), like(s.id, "vtp-rs-%")))).map((r) => r.id);
  if (ids.length) {
    await db.delete(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, ids));
    await db.delete(schema.auditLogs).where(inArray(schema.auditLogs.entityId, ids));
    await db.delete(s).where(inArray(s.id, ids));
  }
  await db.delete(schema.canonicalOrderOutcome).where(like(schema.canonicalOrderOutcome.orderId, "vtp-rs-%"));
  await db.delete(schema.orders).where(like(schema.orders.id, "vtp-rs-%"));
}

export async function testVtpReshipDb(db: Db) {
  try {
    await testVtpReshipDbInner(db);
  } finally {
    await donDep(db);
  }
}

async function testVtpReshipDbInner(db: Db) {
  // ── Đơn gốc + vận đơn gốc (lần gửi 1) ──
  const order = async (id: string, systemId: number) =>
    (await db.insert(schema.orders).values({ id, systemId, stage: "CANCELLED", cod: 499000, insertedAt: new Date("2026-10-15T00:00:00Z") }).onConflictDoNothing().returning())[0]?.id ?? id;
  const O1 = await order("vtp-rs-o1", 992001);
  const GOC = "PKERSGOC01";
  await db.insert(schema.shipments).values({ id: "vtp-rs-s1", orderId: O1, carrier: "Viettel Post", vtpOrderNumber: GOC, trackingCode: GOC, codAmount: 499000, attemptNo: 1, direction: "OUTBOUND" }).onConflictDoNothing();
  const byCode = async (code: string) => db.query.shipments.findFirst({ where: eq(schema.shipments.vtpOrderNumber, code) });

  // (2a) Gửi lại có tham chiếu ⇒ lần gửi kế của CÙNG đơn.
  const MOI = "823456789012";
  await applyVtpTracking(track(MOI, 300, "Đóng tải - vận chuyển đi", "2026-10-16T03:00:00Z", { orderReference: GOC }), "VTP_WEBHOOK", { allowCreate: true });
  const moi = await byCode(MOI);
  assert.ok(moi && moi.orderId === O1 && moi.attemptNo === 2 && moi.direction === "OUTBOUND", `gửi lại trên web VTP ⇒ lần gửi kế của đơn gốc: ${JSON.stringify({ orderId: moi?.orderId, attemptNo: moi?.attemptNo, direction: moi?.direction })}`);
  assert.equal((moi.raw as { reship?: { of?: string } } | null)?.reship?.of, "vtp-rs-s1", "vết raw.reship trỏ về vận đơn gốc");
  assert.equal((await byCode(GOC))?.orderId, O1, "vận đơn gốc không bị đụng");
  // (2b) Gói trùng + gói SAI THỨ TỰ (cũ hơn tới sau) ⇒ vẫn MỘT dòng, vẫn lần gửi 2.
  await applyVtpTracking(track(MOI, 300, "Đóng tải - vận chuyển đi", "2026-10-16T03:00:00Z", { orderReference: GOC }), "VTP_WEBHOOK", { allowCreate: true });
  await applyVtpTracking(track(MOI, 200, "Nhận từ bưu tá - Bưu cục gốc", "2026-10-16T01:00:00Z", { orderReference: GOC }), "VTP_WEBHOOK", { allowCreate: true });
  const dong = await db.select({ id: schema.shipments.id, attemptNo: schema.shipments.attemptNo }).from(schema.shipments).where(eq(schema.shipments.orderId, O1));
  assert.deepEqual(dong.map((d) => d.attemptNo).sort(), [1, 2], "gói trùng / sai thứ tự không đẻ thêm lần gửi");
  assert.equal((await byCode(MOI))?.stage, "IN_TRANSIT", "mốc ĐVVC mới nhất thắng, gói cũ tới sau không kéo lùi");

  // (2c) Lô tạo nhầm không tham chiếu rồi huỷ (VTP 107) ⇒ mồ côi như cũ.
  const LO = "154000000001";
  await applyVtpTracking(track(LO, 107, "Đối tác yêu cầu hủy qua API", "2026-10-16T05:00:00Z"), "VTP_WEBHOOK", { allowCreate: true });
  const lo = await byCode(LO);
  assert.ok(lo && lo.orderId === null && !(lo.raw as Record<string, unknown> | null)?.relink, "không tham chiếu ⇒ mồ côi, không vết relink");

  // (2d) Tham chiếu mơ hồ (hai đơn cùng mã tra cứu, chưa mã VTP) ⇒ mồ côi + lý do.
  const O2 = await order("vtp-rs-o2", 992002);
  const O3 = await order("vtp-rs-o3", 992003);
  await db.insert(schema.shipments).values([
    { id: "vtp-rs-amb-a", orderId: O2, carrier: "Viettel Post", trackingCode: "TRKRSAMB01" },
    { id: "vtp-rs-amb-b", orderId: O3, carrier: "Viettel Post", trackingCode: "TRKRSAMB01" },
  ]).onConflictDoNothing();
  const MO = "823456789013";
  await applyVtpTracking(track(MO, 300, "Đóng tải - vận chuyển đi", "2026-10-16T06:00:00Z", { orderReference: "TRKRSAMB01" }), "VTP_WEBHOOK", { allowCreate: true });
  const mo = await byCode(MO);
  assert.ok(mo && mo.orderId === null, "mơ hồ ⇒ không đoán đơn");
  assert.equal((mo.raw as { relink?: { status?: string } } | null)?.relink?.status, "AMBIGUOUS", "lý do giữ mồ côi ghi trên raw.relink");

  // (2e) Chiều hoàn mang tham chiếu mã gốc ⇒ dòng riêng không đơn (AGENTS 3.7), KHÔNG thành lần gửi kế.
  const LEG = `${GOC}1P1`;
  await applyVtpTracking(track(LEG, 501, "Thành công - Phát thành công", "2026-10-18T10:00:00Z", { orderReference: GOC, isReturning: true }), "VTP_WEBHOOK", { allowCreate: true });
  const leg = await byCode(LEG);
  assert.ok(leg && leg.orderId === null && leg.attemptNo === null, "chiều hoàn không bị gắn thành lần gửi kế");

  // (3) Dòng mồ côi CÓ SẴN (bản cũ) ⇒ relinkOrphanShipment gắn đúng một lần, có audit.
  const O4 = await order("vtp-rs-o4", 992004);
  const GOC4 = "PKERSGOC04";
  await db.insert(schema.shipments).values({ id: "vtp-rs-s4", orderId: O4, carrier: "Viettel Post", vtpOrderNumber: GOC4, trackingCode: GOC4, attemptNo: 1 }).onConflictDoNothing();
  await db.insert(schema.shipments).values({ id: "vtp-rs-orphan4", carrier: "Viettel Post", vtpOrderNumber: "823456789014", trackingCode: "823456789014", orderReference: GOC4 }).onConflictDoNothing();
  const v4 = reshipParentOf({ orderNumber: "823456789014", orderReference: GOC4, receiverPhone: "" }, (await reshipCandidates(db, [GOC4])).get(GOC4) ?? []);
  assert.equal(v4.kind, "ATTEMPT");
  const r1 = await relinkOrphanShipment(db, { shipmentId: "vtp-rs-orphan4", verdict: v4, source: "SCRIPT_RELINK", reason: "thử", actor: "script:vtp-reship-patch" });
  assert.deepEqual(r1, { ok: true, orderId: O4, attemptNo: 2 });
  const coo = await db.select({ shipmentId: schema.canonicalOrderOutcome.shipmentId }).from(schema.canonicalOrderOutcome).where(eq(schema.canonicalOrderOutcome.orderId, O4));
  assert.ok(coo.some((r) => r.shipmentId === "vtp-rs-orphan4"), `kết quả đơn dựng lại NGAY trên lần gửi chính mới (không đợi job 5 phút): ${JSON.stringify(coo)}`);
  assert.deepEqual(await relinkOrphanShipment(db, { shipmentId: "vtp-rs-orphan4", verdict: v4, source: "SCRIPT_RELINK", reason: "thử", actor: "script:vtp-reship-patch" }), { ok: false, why: "ALREADY_LINKED" }, "chạy lại ⇒ không ghi gì");
  assert.deepEqual(await relinkOrphanShipment(db, { shipmentId: "vtp-rs-orphan4", verdict: { kind: "NONE", reason: "NO_PARENT" }, source: "x", reason: "x", actor: "script:x" }), { ok: false, why: "NOT_ATTEMPT" });
  const vet = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "SHIPMENT_RESHIP_RELINK"), eq(schema.auditLogs.entityId, "vtp-rs-orphan4")));
  assert.equal(vet.length, 1, "đúng một dòng audit cho một lần gắn");

  // (4) Nhập tệp «Danh sách vận đơn» — cùng luật.
  const O5 = await order("vtp-rs-o5", 992005);
  const GOC5 = "PKERSGOC05";
  await db.insert(schema.shipments).values({ id: "vtp-rs-s5", orderId: O5, carrier: "Viettel Post", vtpOrderNumber: GOC5, trackingCode: GOC5, attemptNo: 1 }).onConflictDoNothing();
  const row = (trackingCode: string, orderCode: string, cod: number | null, fee: number | null): VtpOrderListRow => ({ trackingCode, orderCode, statusText: "Đóng tải - vận chuyển đi", statusCode: 300, cod, fee, statusDate: "2026-10-17", statusAt: "2026-10-17T03:00:00.000Z", raw: "{}" });
  const rows = [row("923456789015", GOC5, 499000, 25000), row("923456789016", "", 350000, 25000), row("923456789017", "", null, null)];
  const m = await matchVtpOrderList(rows);
  assert.deepEqual(m.map((x) => [x.matchKind, orderListRowCreatable(x)]), [["reship", true], ["new", true], ["new", false]], "xem trước và đường ghi đọc CÙNG điều kiện tạo");
  const applied = await applyVtpOrderList(rows);
  assert.equal(applied.reshipped, 1);
  assert.equal(applied.orphansCreated, 1);
  const s15 = await byCode("923456789015");
  assert.ok(s15 && s15.orderId === O5 && s15.attemptNo === 2 && s15.shippingFee === 25000, "tệp: tham chiếu vận đơn gốc ⇒ lần gửi kế, mang cước của dòng tệp");
  const s16 = await byCode("923456789016");
  assert.ok(s16 && s16.orderId === null, "tệp: không gắn được ⇒ TẠO dòng mồ côi từ chứng từ ĐVVC");
  assert.equal(await byCode("923456789017"), undefined, "thiếu thu hộ / cước ⇒ không tạo (không ghi 0 cho ô chưa biết)");
  const again = await applyVtpOrderList(rows);
  assert.deepEqual([again.reshipped, again.orphansCreated], [0, 0], "nhập lại cùng tệp ⇒ không đẻ thêm dòng");

  // (5) Độ phủ đồng bộ: tách lô huỷ / chưa ghép / chiều hoàn; KHÔNG có «tổng trên VTP».
  const cov = await getVtpSyncCoverage({ from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 3_600_000) });
  assert.ok(cov.orphanCancelledBatch >= 1, `lô 107 không tham chiếu ⇒ «lô huỷ»: ${JSON.stringify(cov)}`);
  assert.ok(cov.orphanUnmatched >= 2, "mơ hồ + mồ côi từ tệp ⇒ «chưa ghép được»");
  assert.ok(cov.returnLegs >= 1 && cov.linked >= 3, "chiều hoàn đứng riêng; lần gửi kế đã gắn đơn");
  assert.equal(cov.known, cov.linked + cov.returnLegs + cov.orphanCancelledBatch + cov.orphanUnmatched, "mỗi vận đơn rơi vào đúng một nhóm");
  assert.equal(cov.carrierTotal, null, "không API ⇒ tổng vận đơn trên VTP là CHƯA BIẾT, không phải một con số");
  assert.match(cov.carrierTotalNote, /chưa đo được/);
  console.log("  ✓ CSDL: webhook gửi lại ⇒ lần gửi kế cùng đơn · trùng / sai thứ tự một dòng · lô 107 mồ côi · mơ hồ giữ + lý do · chiều hoàn không gắn · vá dòng cũ một lần + audit · tệp: lần gửi kế / mồ côi / thiếu tiền không tạo · nhập lại không nhân đôi");
}

export async function testVtpReshipRelink(db: Db) {
  testVtpReshipPure();
  await testVtpReshipDb(db);
  console.log("✓ Vận đơn tạo lại trên web Viettel Post (P0 22/10/2026): gắn về đơn gốc thành lần gửi kế ở cả webhook lẫn nhập tệp — một luật, không mồ côi mới");
}

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { setCareOwner } from "@/lib/care/service";
import { WORK_STAFFING_KEY } from "@/lib/constants/workforce";
import { assignByMachine, machineAssignable } from "@/lib/work/assign";
import { runAutoAssign } from "@/lib/work/auto-assign-run";

/**
 * ═══ CHIA CASE CARE CHƯA AI NHẬN — MÁY GIAO, NHƯNG KHÔNG ĐƯỢC NÓI DỐI THAY NGƯỜI ═══
 *
 * Chủ shop hỏi 27/09/2026: cho case chưa ai nhận tự về Trần Anh Quân, đỡ công giao tay. Đường làm là
 * máy phân việc của phòng Giao vận (đã có, có xem trước) + job nền đọc công tắc "Phân việc tự động"
 * (trước đây công tắc in "chạy nền" mà không job nào đọc nó).
 *
 * Bài này khoá bốn chỗ mà một lượt giao của MÁY khác một lượt giao của NGƯỜI:
 *  (a) máy giao KHÔNG ghi `first_response_at` — nếu ghi, mọi ca "phản hồi trong 0 phút" (mục 63);
 *      người giao vẫn ghi như cũ;
 *  (b) máy KHÔNG lấy ca khỏi tay người vừa nhận giữa lúc dựng kế hoạch và lúc ghi;
 *  (c) máy KHÔNG mở lại ca đã đóng — đường mở lại tay đi vòng qua chốt mốc kích hoạt (mục 59);
 *  (d) lịch sử ghi đúng: người thao tác là MÁY (`actor_id` NULL, nguồn SYSTEM), không phải "chưa biết";
 *  (e) công tắc tắt ⇒ job không đụng phòng nào; và job thật sự có trong lịch.
 */
export async function testCareAutoAssign(db: Db) {
  const gio = (h: number) => new Date(Date.now() - h * 3600_000);
  await db.insert(schema.users).values([
    { id: "caa-quan", email: "caa-quan@test", name: "Trần Anh Quân", passwordHash: "x", role: "CS", active: true },
    { id: "caa-khac", email: "caa-khac@test", name: "Người Khác", passwordHash: "x", role: "CS", active: true },
  ]).onConflictDoNothing();
  for (const [i, active] of [[1, true], [2, false], [3, true]] as const) {
    await db.insert(schema.orders).values({ id: `caa-o${i}`, stage: "SHIPPED", status: 3, insertedAt: gio(50), billFullName: `Khách ${i}`, billPhone: `090000020${i}` }).onConflictDoNothing();
    await db.insert(schema.shipments).values({ id: `caa-s${i}`, orderId: `caa-o${i}`, carrier: "Viettel Post", vtpOrderNumber: `CAA00${i}`, stage: "DELIVERY_FAILED", codAmount: 300_000, vtpStatusDate: gio(5), vtpStatusName: "Phát không thành công" }).onConflictDoNothing();
    await db.insert(schema.shipmentCare).values({ shipmentId: `caa-s${i}`, orderId: `caa-o${i}`, trackingNumber: `CAA00${i}`, episodeNo: 1, active, careStatus: active ? "NEW" : "RESOLVED", openedAt: active ? gio(4) : gio(39), doneAt: active ? null : gio(30), careOutcome: "PENDING" });
  }
  /*
    caa-s2: ca ĐÃ ĐÓNG 30 giờ trước, rồi ĐVVC báo giao hụt MỚI 3 giờ trước ⇒ kiện vào lại "Cần care".
    Đó đúng là trường hợp NGƯỜI giao được (giao = mở lại rồi giao — `care-closed-assign.test.ts`),
    nên nó phân biệt được máy với người. Ca đóng mà kiện không còn cần care thì cả hai cùng từ chối
    và bài kiểm không nói được gì.
  */
  await db.insert(schema.shipmentEvents).values([
    { shipmentId: "caa-s2", source: "VTP_WEBHOOK", status: "502", statusName: "Phát không thành công", occurredAt: gio(40), normalizedStage: "DELIVERY_FAILED", legType: "OUTBOUND" },
    { shipmentId: "caa-s2", source: "VTP_WEBHOOK", status: "502", statusName: "Phát không thành công", occurredAt: gio(3), normalizedStage: "DELIVERY_FAILED", legType: "OUTBOUND" },
  ]).onConflictDoNothing();
  clearMemo();

  // (a) + (d) Máy giao: có người, ASSIGNED, KHÔNG có mốc phản hồi; sự kiện mang dấu MÁY.
  const g1 = await assignByMachine("SHIPMENT_CARE:caa-s1", "caa-quan");
  assert.deepEqual(g1, { ok: true }, "máy giao được ca đang mở, chưa ai cầm");
  const r1 = await db.query.shipmentCare.findFirst({ where: eq(schema.shipmentCare.shipmentId, "caa-s1") });
  assert.equal(r1?.ownerId, "caa-quan");
  assert.equal(r1?.careStatus, "ASSIGNED");
  assert.equal(r1?.firstResponseAt, null, "(a) máy giao KHÔNG phải một lần có người chạm vào ca — mốc phản hồi đầu tiên phải còn trống");
  assert.ok(r1?.assignedAt, "mốc giao vẫn ghi — đó là sự thật: ca đã có chủ từ lúc này");
  const ev = await db.select().from(schema.careCaseEvents).where(eq(schema.careCaseEvents.shipmentId, "caa-s1"));
  const giao = ev.find((e) => e.action === "ASSIGN");
  assert.equal(giao?.actorId, null, "(d) người thao tác là máy — khoá NULL");
  assert.equal(giao?.source, "SYSTEM", "(d) nguồn SYSTEM phân biệt máy với 'chưa biết ai'");
  assert.equal(giao?.nextOwnerId, "caa-quan");

  // (b) Ca đã có người cầm: máy không giành.
  const g2 = await assignByMachine("SHIPMENT_CARE:caa-s1", "caa-khac");
  assert.ok("error" in g2 && /có người nhận/.test(g2.error), "(b) máy không lấy việc khỏi tay người đang cầm");
  assert.equal((await db.query.shipmentCare.findFirst({ where: eq(schema.shipmentCare.shipmentId, "caa-s1") }))?.ownerId, "caa-quan");

  // (c) Ca đã đóng: máy không mở lại.
  const g3 = await assignByMachine("SHIPMENT_CARE:caa-s2", "caa-quan");
  assert.ok("error" in g3 && /máy không tự mở lại/.test(g3.error), "(c) máy không tự mở lại ca đã đóng — kể cả khi kiện đã vào lại Cần care");
  const r2 = await db.select().from(schema.shipmentCare).where(eq(schema.shipmentCare.shipmentId, "caa-s2"));
  assert.equal(r2.length, 1, "(c) không có đợt mới nào được mở");
  assert.equal(r2[0].ownerId, null);
  assert.equal(r2[0].active, false);

  // (a) đối chứng: NGƯỜI giao vẫn ghi mốc phản hồi như trước — không đổi hành vi của đường tay.
  const g4 = await setCareOwner({ id: "caa-khac", email: "caa-khac@test", name: "Người Khác", source: "UI" }, { shipmentIds: ["caa-s3"], ownerId: "caa-quan" });
  assert.ok("ok" in g4);
  assert.ok((await db.query.shipmentCare.findFirst({ where: eq(schema.shipmentCare.shipmentId, "caa-s3") }))?.firstResponseAt, "người giao tay: giữ nguyên hành vi cũ");

  // Nguồn máy giao được: care vận đơn thì có; case CSKH chưa có đường ghi cho máy ⇒ không.
  assert.equal(machineAssignable("SHIPMENT_CARE"), true);
  assert.equal(machineAssignable("CS_CASE"), false, "case CSKH: đường ghi còn gắn phiên đăng nhập — không đoán");
  assert.equal(machineAssignable("KHONG_TON_TAI"), false);

  // (e) Công tắc TẮT ở mọi phòng (mặc định) ⇒ job không đụng phòng nào.
  const truoc = await db.select({ v: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, WORK_STAFFING_KEY));
  assert.ok(!truoc.length || !JSON.stringify(truoc[0].v).includes('"autoAssign":{"'), "fixture không được bật sẵn phân việc tự động");
  clearMemo();
  const chay = await runAutoAssign();
  assert.deepEqual(chay.enabled, [], "(e) mặc định TẮT ở mọi phòng");
  assert.deepEqual(chay.departments, []);

  // (e) Job có định nghĩa VÀ có trong lịch — công tắc "chạy nền" không được lại là lời hứa suông.
  const goc = path.resolve(__dirname, "..");
  const lich = fs.readFileSync(path.join(goc, "scripts/scheduler.mjs"), "utf8");
  assert.match(lich, /\{\s*job:\s*"work-auto-assign"/, "job phân việc tự động phải nằm trong bộ lập lịch");
  // Một bộ luật chọn người: nút xem trước và job nền cùng đi qua `buildDepartmentPlan`.
  const action = fs.readFileSync(path.join(goc, "lib/actions/workforce.ts"), "utf8");
  assert.ok(action.includes("buildDepartmentPlan(") && !action.includes("planDistribution("), "nút xem trước phải dùng CHUNG hàm dựng kế hoạch với job nền");

  // (f) Máy giao một việc CHIẾU chưa có lớp ghi chú (người phụ trách do lớp công việc giữ): dòng `work_items` sinh ra phải mang
  //     `created_by` / `assigned_by` = NULL (MÁY làm — AGENTS.md mục 34), không phải chuỗi rỗng. Production 05–07/10/2026: mọi lượt
  //     job hỏng vì `ensureOverlay` ghi `created_by = ''` ⇒ vi phạm khoá ngoại sang `users`, cứ 10 phút một lần.
  const viecChieu = "RETURN_INSPECTION:caa-ri-1";
  const gChieu = await assignByMachine(viecChieu, "caa-quan");
  assert.ok("ok" in gChieu, `(f) máy giao được việc chiếu chưa có lớp ghi chú: ${JSON.stringify(gChieu)}`);
  const lop = await db.query.workItems.findFirst({ where: eq(schema.workItems.sourceKey, "caa-ri-1") });
  assert.equal(lop?.assigneeId, "caa-quan", "(f) người được giao ghi vào lớp công việc");
  assert.equal(lop?.createdBy, null, "(f) dòng do MÁY tạo mang created_by NULL, không phải chuỗi rỗng");
  assert.equal(lop?.assignedBy, null, "(f) lượt giao của MÁY mang assigned_by NULL");
  if (lop) {
    await db.delete(schema.workItemEvents).where(eq(schema.workItemEvents.workItemId, lop.id));
    await db.delete(schema.workItems).where(eq(schema.workItems.id, lop.id));
  }

  await db.delete(schema.careCaseEvents).where(eq(schema.careCaseEvents.shipmentId, "caa-s1"));
  await db.delete(schema.careCaseEvents).where(eq(schema.careCaseEvents.shipmentId, "caa-s3"));
  await db.delete(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, "caa-s2"));
  for (const i of [1, 2, 3]) {
    await db.delete(schema.shipmentCare).where(eq(schema.shipmentCare.shipmentId, `caa-s${i}`));
    await db.delete(schema.shipments).where(eq(schema.shipments.id, `caa-s${i}`));
    await db.delete(schema.orders).where(eq(schema.orders.id, `caa-o${i}`));
  }
  clearMemo();
  console.log("✓ Máy chia case care: không ghi mốc phản hồi thay người, không giành ca người đang cầm, không mở lại ca đã đóng, lịch sử ghi là MÁY; công tắc tắt thì không đụng gì, và job có trong lịch");
}

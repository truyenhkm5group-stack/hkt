/**
 * LƯU TRÚ NGẮN NGÀY (module `stays`, 0198 · docs/verticals/homestay.md) + mẫu ngành «Homestay / Airbnb».
 *
 *  1. THUẦN — khoảng nửa mở (trả sáng, nhận chiều cùng ngày KHÔNG trùng); trùng phòng bỏ qua ngày khoá nhập từ kênh (vọng lịch);
 *     lấp đầy theo từng đêm, không đêm bán được ⇒ null; dọn phòng ưu tiên phòng có khách nhận cùng ngày; doanh thu chưa ghi tiền
 *     ⇒ null; đọc .ics (gập dòng, ngày / giờ, thiếu DTEND, dòng hỏng đếm riêng, «Not available», CANCELLED); phát .ics không mang
 *     tên khách, không phát lại ngày khoá của kênh, bỏ lượt của chính kênh; kế hoạch nhập (mới / đổi / huỷ / lượt cũ giữ nguyên).
 *  2. TỔ CHỨC THẬT (`st-home`, cài mẫu homestay): quyền stays:write; đặt tay trùng ⇒ chặn, nối tiếp ⇒ được; nhập .ics chạy thử
 *     không ghi, nhập thật ghi; kênh bán trùng ⇒ hiện ở bảng trùng phòng; vọng lịch không báo trùng; nhập lại thiếu lượt ⇒ huỷ
 *     lượt sắp tới, giữ lượt đã qua; lượt của kênh không huỷ tay được; đường dẫn lịch công khai đúng / sai / đổi token / phòng
 *     ngưng; dọn phòng; báo cáo chủ nhà.
 *
 * Mốc ngày đi theo ĐỒNG HỒ THẬT (luật 50): mọi ngày dựng tương đối từ hôm nay.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { installBlueprint, planForOrg } from "@/lib/blueprints/install";
import { HOMESTAY_BLUEPRINT } from "@/lib/blueprints/templates/homestay";
import { validateBlueprint } from "@/lib/blueprints/validate";
import { moduleDef } from "@/lib/constants/platform-modules";
import { buildIcs, findStayConflicts, parseIcs, planIcsImport, stayDayCells, stayNights, stayOccupancy, stayRevenue, staysOverlap, stayTurnoversOn } from "@/lib/constants/stays";
import { BUSINESS_TYPE_SPEC } from "@/lib/onboarding/shared";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { stayBoard, stayOwnerReport } from "@/lib/queries/stays";
import { cancelStayBookingCore, createStayBookingCore, createStayUnitCore, importStayIcsCore, markStayTurnoverCore, rotateStayIcalTokenCore, updateStayBookingDetailsCore, updateStayUnitCore } from "@/lib/records/stays";
import { feedExcludeChannel, serveStayFeed } from "@/lib/stays/feed";

const ORG = "st-home";

async function cleanupOrg() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

const codeOf = (r: { ok: true } | { ok: false; code: string }) => (r.ok ? "OK" : r.code);
const fieldsOf = (r: { ok: true } | { ok: false; errors: { field: string }[] }) => (r.ok ? [] : r.errors.map((e) => e.field));
const vnDay = (offsetDays = 0) => new Date(Date.now() + 7 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
const icsDate = (d: string) => d.replace(/-/g, "");

/** Tệp lịch kiểu Airbnb: mỗi sự kiện (uid, nhận, trả, tóm tắt). */
function ics(events: { uid: string; from: string; to: string; summary?: string; status?: string }[]): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Airbnb Inc//Hosting Calendar 1.0//EN"];
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `DTSTART;VALUE=DATE:${icsDate(e.from)}`, `DTEND;VALUE=DATE:${icsDate(e.to)}`, `UID:${e.uid}`, `SUMMARY:${e.summary ?? "Reserved"}`);
    if (e.status) lines.push(`STATUS:${e.status}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function testPure() {
  assert.equal(stayNights("2026-10-01", "2026-10-04"), 3);
  assert.equal(stayNights("2026-10-04", "2026-10-04"), null, "trả = nhận ⇒ không hợp lệ");
  assert.equal(stayNights("2026-02-30", "2026-03-02"), null, "ngày không có thật");
  assert.ok(!staysOverlap({ checkIn: "2026-10-01", checkOut: "2026-10-05" }, { checkIn: "2026-10-05", checkOut: "2026-10-07" }), "trả sáng ngày 5, nhận chiều ngày 5 KHÔNG trùng");
  assert.ok(staysOverlap({ checkIn: "2026-10-01", checkOut: "2026-10-05" }, { checkIn: "2026-10-04", checkOut: "2026-10-07" }));

  const B = (id: string, checkIn: string, checkOut: string, over: Partial<{ status: string; channel: string; source: string; unitId: string }> = {}) => ({ id, unitId: "u1", checkIn, checkOut, status: "CONFIRMED", channel: "AIRBNB", source: "ICAL", ...over });
  const direct = B("d1", "2026-10-10", "2026-10-13", { channel: "DIRECT", source: "MANUAL" });
  const echo = B("e1", "2026-10-10", "2026-10-13", { status: "BLOCKED" });
  const booking = B("k1", "2026-10-12", "2026-10-14", { channel: "BOOKING" });
  const otherUnit = B("o1", "2026-10-10", "2026-10-13", { unitId: "u2" });
  const cancelled = B("c1", "2026-10-10", "2026-10-13", { status: "CANCELLED" });
  const conflicts = findStayConflicts([direct, echo, booking, otherUnit, cancelled]);
  assert.deepEqual(conflicts.map((c) => [c.a.id, c.b.id]), [["d1", "k1"]], "chỉ cặp thật: vọng lịch, phòng khác, lượt huỷ không tính");
  const manualBlock = B("m1", "2026-10-11", "2026-10-12", { status: "BLOCKED", source: "MANUAL" });
  assert.equal(findStayConflicts([direct, manualBlock]).length, 1, "ngày chủ khoá TRONG ERP thì tính");

  const occ = stayOccupancy([direct, echo, B("x", "2026-10-20", "2026-10-22", { status: "BLOCKED" })], "2026-10-01", "2026-11-01");
  assert.deepEqual(occ, { soldNights: 3, blockedNights: 2, sellableNights: 29, rate: 3 / 29 }, "đêm vừa bán vừa có vọng lịch chỉ tính MỘT lần (đã bán)");
  assert.equal(stayOccupancy([B("x", "2026-10-01", "2026-10-03", { status: "BLOCKED" })], "2026-10-01", "2026-10-03").rate, null, "không còn đêm bán được ⇒ null, không phải 0%");
  assert.deepEqual(
    stayDayCells([direct, booking, echo], ["2026-10-09", "2026-10-10", "2026-10-12"]).map((c) => c.kind),
    ["FREE", "SOLD", "CONFLICT"],
  );

  const turn = stayTurnoversOn([B("a", "2026-10-01", "2026-10-05"), B("b", "2026-10-05", "2026-10-06"), B("c", "2026-10-02", "2026-10-05", { unitId: "u2" })], "2026-10-05");
  assert.deepEqual(turn.map((t) => [t.unitId, t.sameDayArrival]), [["u1", true], ["u2", false]], "phòng có khách nhận cùng ngày lên đầu");

  assert.deepEqual(stayRevenue([{ checkIn: "2026-10-03", status: "CONFIRMED", amountVnd: null }], "2026-10-01", "2026-11-01"), { knownVnd: null, withAmount: 0, missingAmount: 1 }, "chưa ghi tiền ⇒ null, không phải 0");
  assert.deepEqual(stayRevenue([{ checkIn: "2026-10-03", status: "CONFIRMED", amountVnd: 1_200_000 }, { checkIn: "2026-10-05", status: "CONFIRMED", amountVnd: null }, { checkIn: "2026-09-30", status: "CONFIRMED", amountVnd: 9 }], "2026-10-01", "2026-11-01"), { knownVnd: 1_200_000, withAmount: 1, missingAmount: 1 });

  const text = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "DTSTART;VALUE=DATE:20261010",
    "DTEND;VALUE=DATE:20261013",
    "UID:abc-",
    " 123@airbnb.com",
    "SUMMARY:Reserved",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART:20261020T140000Z",
    "UID:one-night",
    "SUMMARY:Airbnb (Not available)",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART;VALUE=DATE:20261101",
    "DTEND;VALUE=DATE:20261030",
    "UID:bad-range",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART;VALUE=DATE:20261105",
    "SUMMARY:no uid",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART;VALUE=DATE:20261110",
    "DTEND;VALUE=DATE:20261112",
    "UID:gone",
    "STATUS:CANCELLED",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const parsed = parseIcs(text);
  assert.equal(parsed.skipped, 2, "khoảng ngày ngược + thiếu UID ⇒ bỏ qua và đếm");
  assert.deepEqual(
    parsed.events.map((e) => [e.uid, e.checkIn, e.checkOut, e.blocked, e.cancelled]),
    [
      ["abc-123@airbnb.com", "2026-10-10", "2026-10-13", false, false],
      ["one-night", "2026-10-20", "2026-10-21", true, false],
      ["gone", "2026-11-10", "2026-11-12", false, true],
    ],
    "gập dòng nối lại; có giờ vẫn lấy ngày; thiếu DTEND ⇒ một đêm; «Not available» là khoá",
  );

  const feed = buildIcs({ id: "u1", name: "Phòng 201, view biển" }, [{ ...direct, guestName: "Nguyễn Văn A" } as typeof direct, echo, booking, manualBlock], new Date("2026-10-04T00:00:00Z"));
  assert.ok(feed.includes("DTSTART;VALUE=DATE:20261010") && feed.includes("DTSTART;VALUE=DATE:20261012") && feed.includes("SUMMARY:Khoá ngày"));
  assert.ok(!feed.includes(`UID:${echo.id}@`), "ngày khoá nhập từ kênh KHÔNG phát lại (vòng vọng)");
  assert.ok(!feed.includes("Nguyễn"), "lịch phát ra không mang tên khách");
  assert.ok(feed.includes("X-WR-CALNAME:Phòng 201\\, view biển"), "dấu phẩy được thoát");
  assert.ok(!buildIcs({ id: "u1", name: "P" }, [booking], new Date(), { excludeChannel: "BOOKING" }).includes("VEVENT"), "lịch phát cho Booking bỏ lượt của chính Booking");
  assert.equal(feedExcludeChannel("airbnb"), "AIRBNB");
  assert.equal(feedExcludeChannel("lạ"), null);

  const today = "2026-10-15";
  const existing = [
    { id: "keep", externalUid: "u-keep", checkIn: "2026-10-20", checkOut: "2026-10-22", status: "CONFIRMED" },
    { id: "move", externalUid: "u-move", checkIn: "2026-10-25", checkOut: "2026-10-27", status: "CONFIRMED" },
    { id: "drop", externalUid: "u-drop", checkIn: "2026-11-01", checkOut: "2026-11-03", status: "CONFIRMED" },
    { id: "past", externalUid: "u-past", checkIn: "2026-10-01", checkOut: "2026-10-03", status: "CONFIRMED" },
    { id: "stay", externalUid: "u-stay", checkIn: "2026-10-14", checkOut: "2026-10-16", status: "CONFIRMED" },
  ];
  const plan = planIcsImport(
    existing,
    [
      { uid: "u-keep", checkIn: "2026-10-20", checkOut: "2026-10-22", summary: "", blocked: false, cancelled: false },
      { uid: "u-move", checkIn: "2026-10-26", checkOut: "2026-10-28", summary: "", blocked: false, cancelled: false },
      { uid: "u-new", checkIn: "2026-12-01", checkOut: "2026-12-02", summary: "", blocked: false, cancelled: false },
      { uid: "u-new", checkIn: "2026-12-01", checkOut: "2026-12-02", summary: "", blocked: false, cancelled: false },
    ],
    today,
  );
  assert.deepEqual(plan.create.map((e) => e.uid), ["u-new"], "UID lặp trong tệp chỉ tạo một");
  assert.deepEqual(plan.update.map((u) => u.id), ["move"]);
  assert.deepEqual(plan.cancel.map((c) => c.id).sort(), ["drop", "stay"], "lượt sắp tới / đang ở mà kênh bỏ ⇒ huỷ");
  assert.equal(plan.unchanged, 1);
  assert.ok(!plan.cancel.some((c) => c.id === "past"), "lượt đã trả phòng KHÔNG đụng tới — lịch kênh tự rụng lượt cũ");

  const v = validateBlueprint(HOMESTAY_BLUEPRINT);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.equal(BUSINESS_TYPE_SPEC.homestay.templateKey, "homestay");
  assert.equal(moduleDef("stays")?.homeOptIn, true, "module lưu trú TẮT ở tổ chức nhà");
}

export async function testStays() {
  testPure();
  const home = await getHomeOrganization();
  assert.ok(!(await getEnabledModules(home.code)).has("stays"), "0198: tổ chức nhà KHÔNG bật lưu trú");
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Homestay thử", plan: "standard", modules: [], admin: { email: `admin@${ORG}.local`, name: "QT homestay", password: "Homestay@12345" }, source: "TEST", actor: null });
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const sessionOf = async (over: Partial<SessionUser> = {}): Promise<SessionUser> => ({ id: u.id, email: u.email, name: "QT homestay", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Homestay thử", isHome: false }, modules: [...(await getEnabledModules(ORG))], ...over });
      let admin = await sessionOf();
      assert.ok((await serveStayFeed(`${ORG}.${"x".repeat(32)}`, null)).status === 404, "module chưa bật ⇒ 404");
      const plan = await planForOrg(HOMESTAY_BLUEPRINT, admin);
      assert.ok(plan.ok, JSON.stringify(plan.steps.filter((s) => s.action === "BLOCKED")));
      assert.ok((await installBlueprint(HOMESTAY_BLUEPRINT, admin, { expectedPlanHash: plan.planHash })).ok);
      assert.deepEqual([...(await getEnabledModules(ORG))].sort(), [...HOMESTAY_BLUEPRINT.modules].sort());
      admin = await sessionOf();
      const viewer = await sessionOf({ role: "VIEWER", permissions: ["stays:view"] });

      // ── Phòng ──
      assert.equal(codeOf(await createStayUnitCore(viewer, { name: "Phòng 201", code: "P201" })), "FORBIDDEN");
      const p201 = await createStayUnitCore(admin, { name: "Phòng 201", code: "P201", ownerName: "Anh Minh", capacity: 2 });
      assert.ok(p201.ok, JSON.stringify(p201));
      assert.deepEqual(fieldsOf(await createStayUnitCore(admin, { name: "Trùng mã", code: "p201" })), ["code"], "mã phòng trùng (khác hoa thường) ⇒ chặn");
      const p202 = await createStayUnitCore(admin, { name: "Phòng 202", code: "P202" });
      assert.ok(p202.ok);

      // ── Đặt tay ──
      const d = (n: number) => vnDay(n);
      const manual = (over: Record<string, unknown> = {}) => ({ unitId: p201.id, checkIn: d(2), checkOut: d(5), guestName: "Chị Lan", guestPhone: "0903 222 333", ...over });
      const m1 = await createStayBookingCore(admin, manual());
      assert.ok(m1.ok, JSON.stringify(m1));
      assert.deepEqual(fieldsOf(await createStayBookingCore(admin, manual({ checkIn: d(4), checkOut: d(6), guestName: "Anh Tú" }))), ["checkIn"], "đặt tay trùng ⇒ chặn");
      assert.deepEqual(fieldsOf(await createStayBookingCore(admin, manual({ guestName: "" }))), ["guestName"], "đặt phòng cần tên khách");
      assert.deepEqual(fieldsOf(await createStayBookingCore(admin, manual({ checkIn: d(5), checkOut: d(5) }))), ["checkOut"]);
      const m2 = await createStayBookingCore(admin, manual({ checkIn: d(5), checkOut: d(7), guestName: "Anh Tú", amountVnd: 1_500_000 }));
      assert.ok(m2.ok, "trả sáng / nhận chiều cùng ngày ⇒ được");
      const block = await createStayBookingCore(admin, { unitId: p202.id, kind: "BLOCK", checkIn: d(20), checkOut: d(22), note: "Sơn lại tường" });
      assert.ok(block.ok);

      // ── Nhập lịch Airbnb cho P201 ──
      const airbnb = ics([
        { uid: "air-1", from: d(5), to: d(8) }, // trùng với Anh Tú (d5→d7) — kênh đã bán thật
        { uid: "air-2", from: d(10), to: d(12) },
        { uid: "air-echo", from: d(2), to: d(5), summary: "Airbnb (Not available)" }, // vọng lịch của lượt Chị Lan
        { uid: "air-past", from: d(-10), to: d(-8) },
      ]);
      const dry = await importStayIcsCore(admin, { unitId: p201.id, channel: "AIRBNB", text: airbnb });
      assert.ok(dry.ok && !dry.applied && dry.created === 4, JSON.stringify(dry));
      assert.equal((await db.select().from(schema.stayBookings).where(eq(schema.stayBookings.source, "ICAL"))).length, 0, "chạy thử KHÔNG ghi lượt đặt nào");
      assert.equal(codeOf(await importStayIcsCore(admin, { unitId: p201.id, channel: "DIRECT", text: airbnb })), "INVALID", "khách trực tiếp không có lịch kênh");
      assert.equal(codeOf(await importStayIcsCore(admin, { unitId: p201.id, channel: "AIRBNB", text: "xin chào" })), "INVALID", "không phải tệp lịch");
      const real = await importStayIcsCore(admin, { unitId: p201.id, channel: "AIRBNB", text: airbnb, apply: true });
      assert.ok(real.ok && real.applied && real.created === 4, JSON.stringify(real));
      const again = await importStayIcsCore(admin, { unitId: p201.id, channel: "AIRBNB", text: airbnb, apply: true });
      assert.ok(again.ok && again.created === 0 && again.unchanged === 4, "nhập lại cùng tệp ⇒ không đẻ thêm lượt");

      let board = await stayBoard(vnDay(0));
      assert.equal(board.conflicts.length, 1, "kênh bán trùng ⇒ hiện ở bảng trùng phòng; vọng lịch KHÔNG báo trùng");
      assert.deepEqual([board.conflicts[0].a.checkIn, board.conflicts[0].b.checkIn].sort(), [d(5), d(5)]);
      assert.ok(!board.upcoming.some((b) => b.checkOut <= vnDay(0)), "bảng sắp tới không có lượt đã trả phòng");

      // Kênh huỷ air-1 và bỏ air-past khỏi tệp ⇒ air-1 huỷ, lượt đã qua giữ nguyên.
      const airbnb2 = ics([
        { uid: "air-1", from: d(5), to: d(8), status: "CANCELLED" },
        { uid: "air-2", from: d(11), to: d(13) },
        { uid: "air-echo", from: d(2), to: d(5), summary: "Airbnb (Not available)" },
      ]);
      const r2 = await importStayIcsCore(admin, { unitId: p201.id, channel: "AIRBNB", text: airbnb2, apply: true });
      assert.ok(r2.ok && r2.cancelled === 1 && r2.updated === 1, JSON.stringify(r2));
      const past = await db.select().from(schema.stayBookings).where(and(eq(schema.stayBookings.externalUid, "air-past")));
      assert.equal(past[0].status, "CONFIRMED", "lượt đã qua không bị huỷ vì kênh rụng nó khỏi lịch");
      board = await stayBoard(vnDay(0));
      assert.equal(board.conflicts.length, 0, "kênh huỷ ⇒ hết trùng");
      const air2 = await db.select().from(schema.stayBookings).where(eq(schema.stayBookings.externalUid, "air-2"));
      assert.equal(air2[0].checkIn, d(11), "kênh dời ngày ⇒ ERP dời theo");

      // Lượt của kênh: không huỷ tay, nhưng bổ sung thông tin được.
      assert.equal(codeOf(await cancelStayBookingCore(admin, air2[0].id, "Khách báo huỷ")), "CONFLICT");
      assert.ok((await updateStayBookingDetailsCore(admin, air2[0].id, { guestName: "John", guestPhone: "", guests: 2, amountVnd: 2_000_000, note: "" })).ok);
      assert.deepEqual(fieldsOf(await cancelStayBookingCore(admin, m2.id, "x")), ["reason"], "huỷ cần lý do");

      // ── Đường dẫn lịch công khai ──
      const [unitRow] = await db.select().from(schema.stayUnits).where(eq(schema.stayUnits.id, p201.id));
      const ok = await serveStayFeed(`${ORG}.${unitRow.icalToken}.ics`, null);
      assert.equal(ok.status, 200);
      if (ok.status === 200) {
        assert.ok(ok.body.includes(`DTSTART;VALUE=DATE:${icsDate(d(2))}`) && ok.body.includes(`DTSTART;VALUE=DATE:${icsDate(d(11))}`));
        assert.ok(!ok.body.includes("Chị Lan") && !ok.body.includes("John"), "lịch công khai không mang tên khách");
        assert.ok(!ok.body.includes("air-echo"), "không phát lại vọng lịch");
      }
      const forAirbnb = await serveStayFeed(`${ORG}.${unitRow.icalToken}`, "AIRBNB");
      assert.ok(forAirbnb.status === 200 && !forAirbnb.body.includes(`DTSTART;VALUE=DATE:${icsDate(d(11))}`), "lịch phát cho Airbnb bỏ lượt của chính Airbnb");
      assert.equal((await serveStayFeed(`${ORG}.${"A".repeat(32)}`, null)).status, 404, "token sai ⇒ 404");
      assert.equal((await serveStayFeed(`khong-co.${unitRow.icalToken}`, null)).status, 404, "tổ chức không có ⇒ 404");
      assert.equal((await serveStayFeed("rác", null)).status, 404);
      assert.ok((await rotateStayIcalTokenCore(admin, p201.id)).ok);
      assert.equal((await serveStayFeed(`${ORG}.${unitRow.icalToken}`, null)).status, 404, "đổi đường dẫn ⇒ đường cũ chết ngay");
      const [rotated] = await db.select().from(schema.stayUnits).where(eq(schema.stayUnits.id, p201.id));
      assert.equal((await serveStayFeed(`${ORG}.${rotated.icalToken}`, null)).status, 200);
      assert.ok((await updateStayUnitCore(admin, p201.id, { name: "Phòng 201", code: "P201", active: false })).ok);
      assert.equal((await serveStayFeed(`${ORG}.${rotated.icalToken}`, null)).status, 404, "phòng ngưng cho thuê ⇒ 404");
      assert.ok((await updateStayUnitCore(admin, p201.id, { name: "Phòng 201", code: "P201", ownerName: "Anh Minh", active: true })).ok);

      // ── Dọn phòng ──
      assert.ok((await markStayTurnoverCore(admin, p201.id, d(5), true)).ok);
      assert.equal(codeOf(await markStayTurnoverCore(admin, p201.id, d(5), true)), "CONFLICT", "dọn xong hai lần ⇒ không ghi thêm");
      assert.ok((await markStayTurnoverCore(admin, p201.id, d(5), false)).ok);
      const boardTurn = await stayBoard(d(5));
      const t5 = boardTurn.turnovers.find((t) => t.unitId === p201.id && t.day === d(5));
      assert.ok(t5 && t5.sameDayArrival && t5.doneByName === null, "Chị Lan trả, Anh Tú nhận cùng ngày ⇒ dọn gấp");

      // ── Báo cáo chủ nhà (tháng chứa d(2)) ──
      const report = await stayOwnerReport(d(2).slice(0, 7));
      const r201 = report.rows.find((r) => r.unitId === p201.id)!;
      assert.equal(r201.ownerName, "Anh Minh");
      assert.ok(r201.soldNights > 0 && r201.occupancy !== null);
      assert.ok(r201.missingAmount >= 1, "lượt chưa ghi tiền đếm riêng");
      const r202 = report.rows.find((r) => r.unitId === p202.id);
      assert.ok(!r202 || r202.revenueKnownVnd === null, "phòng không có lượt tiền ⇒ doanh thu chưa biết, không phải 0");

      assert.ok((await db.select().from(schema.stayIcalImports)).length >= 4, "mọi lượt nhập (kể cả chạy thử) vào sổ");
      assert.ok((await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "STAY_BOOKING"))).length >= 3, "mọi lượt ghi có nhật ký");
    });
  } finally {
    await cleanupOrg();
  }
  console.log("  ✓ lưu trú: khoảng nửa mở, trùng phòng bỏ qua vọng lịch, lấp đầy theo đêm (null khi không bán được), dọn gấp lên đầu, doanh thu chưa ghi tiền = chưa biết; .ics đọc gập dòng / thiếu DTEND / dòng hỏng đếm riêng; nhập có chạy thử, nhập lại không nhân bản, kênh huỷ / dời / rụng lượt cũ đúng; đặt tay trùng chặn; đường dẫn lịch không lộ tên, sai / đổi / ngưng ⇒ 404; mẫu Homestay cài đúng module; nhà TẮT");
}

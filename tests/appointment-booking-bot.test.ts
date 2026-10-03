/**
 * ═══════════ CHATBOT ĐẶT LỊCH HẸN (module «Lịch hẹn» · lib/constants/booking.ts · docs/verticals/appointments.md) ═══════════
 *
 *  1. THUẦN — giờ trống theo giờ mở cửa · bước chia · đặt trước tối thiểu · ngày nghỉ · quá xa · ngày đã qua · ngày sai dạng;
 *     sức chứa đếm MỌI lịch đang hiệu lực chồng giờ; giờ lệch lưới không nhận; cấu hình cũ chưa có khối đặt lịch ⇒ TẮT.
 *  2. TỔ CHỨC THẬT (`bt-spa`, mẫu spa): công cụ chỉ tồn tại khi `bookingOn`; khách chưa xác nhận ⇒ không ghi; khung thử chỉ
 *     mô phỏng; đặt thật ⇒ lịch BOOKED không kỹ thuật viên, khách không cần địa chỉ, có tin báo người xem lịch; một hội
 *     thoại một lịch; sức chứa đầy ⇒ từ chối CẢ ở bước kiểm giờ LẪN trong giao dịch (khoá chung); SĐT cũ dùng lại khách cũ;
 *     tổ chức tắt module ⇒ đường ghi của bot từ chối.
 *
 * Mốc thời gian đi theo ĐỒNG HỒ THẬT (luật 50): ngày đặt = «ngày mai» tính từ bây giờ, không ghim ngày tuyệt đối.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { installBlueprint, planForOrg } from "@/lib/blueprints/install";
import { SPA_BEAUTY_BLUEPRINT } from "@/lib/blueprints/templates/spa-beauty";
import { bookingConfigZ, freeSlots, slotBookable, vnDayOffset, vnInstant, type BookingConfig } from "@/lib/constants/booking";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { createAppointmentAsAgent } from "@/lib/records/appointments";
import { createCustomerAsAgent } from "@/lib/records/customer-create";
import { parseSalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { bookingPrompt, systemPrompt } from "@/lib/sales-chatbot/engine";
import { executeTool, toolDefsFor, type ChatState } from "@/lib/sales-chatbot/tools";

const ORG = "bt-spa";
const BOT = { name: "Chatbot thử", source: "tests/appointment-booking-bot.test.ts" };

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

function testPure() {
  const now = new Date();
  const tomorrow = vnDayOffset(now, 1);
  const cfg: BookingConfig = { enabled: true, open: "09:00", close: "12:00", days: [0, 1, 2, 3, 4, 5, 6], slotMinutes: 60, capacity: 2, leadMinutes: 60, horizonDays: 7 };
  const at = (hhmm: string, day = tomorrow) => vnInstant(day, hhmm)!;
  assert.equal(vnInstant("2026-11-05", "09:00")!.toISOString(), "2026-11-05T02:00:00.000Z", "giờ VN = UTC+7");
  assert.equal(vnInstant("2026-02-30", "09:00"), null, "ngày không có thật");
  assert.deepEqual(freeSlots(cfg, tomorrow, now, []).times, ["09:00", "10:00", "11:00"], "11:00 + 60 phút = đúng giờ đóng cửa ⇒ vẫn nhận");
  const one = [{ start: at("10:00"), end: at("11:00") }];
  assert.deepEqual(freeSlots(cfg, tomorrow, now, one).times, ["09:00", "10:00", "11:00"], "sức chứa 2, mới 1 lịch ⇒ còn");
  const two = [...one, { start: at("10:30"), end: at("11:30") }];
  assert.deepEqual(freeSlots(cfg, tomorrow, now, two).times, ["09:00", "11:00"], "10:00–11:00 chồng 2 lịch ⇒ kín; 11:00 chỉ chồng 1");
  assert.deepEqual(freeSlots(cfg, tomorrow, now, [{ start: at("08:00"), end: at("09:00") }, { start: at("08:00"), end: at("09:00") }]).times, ["09:00", "10:00", "11:00"], "chạm mép không chiếm chỗ");
  // Đặt trước tối thiểu: mở cửa ngay bây giờ ⇒ giờ sớm hơn bây giờ + lead không nhận.
  const lead = freeSlots({ ...cfg, open: "00:00", close: "23:00", slotMinutes: 15, leadMinutes: 120 }, vnDayOffset(now), now, []);
  assert.ok(lead.times.every((t) => vnInstant(vnDayOffset(now), t)!.getTime() >= now.getTime() + 120 * 60_000), "không giờ nào sớm hơn bây giờ + 120 phút");
  const wd = new Date(`${tomorrow}T00:00:00Z`).getUTCDay();
  assert.match(freeSlots({ ...cfg, days: [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== wd) }, tomorrow, now, []).closedReason ?? "", /không nhận lịch/, "ngày nghỉ");
  assert.match(freeSlots(cfg, vnDayOffset(now, -1), now, []).closedReason ?? "", /đã qua/);
  assert.match(freeSlots(cfg, vnDayOffset(now, 8), now, []).closedReason ?? "", /7 ngày tới/);
  assert.match(freeSlots(cfg, "05-11-2026", now, []).closedReason ?? "", /không hợp lệ/);
  assert.equal(slotBookable(cfg, tomorrow, "10:30", now, []).ok, false, "giờ lệch lưới ⇒ không nhận");
  assert.equal(slotBookable(cfg, tomorrow, "10:00", now, two).ok, false, "giờ đã kín ⇒ không nhận");
  assert.equal(slotBookable(cfg, tomorrow, "11:00", now, two).ok, true);

  assert.equal(bookingConfigZ.safeParse({ ...cfg, open: "12:00", close: "09:00" }).success, false, "không nhận khung qua nửa đêm");
  assert.equal(bookingConfigZ.safeParse({ ...cfg, capacity: 0 }).success, false);
  const legacy = parseSalesChatbotConfig({ enabled: true, botName: "Bot cũ", connectorKey: "gemini-byok", tone: "FRIENDLY", greeting: "Chào bạn", businessHours: { enabled: false, start: "08:00", end: "21:00", days: [1], outsideMessage: "" }, handoff: { onCustomerRequest: true, onComplaint: true, message: "Đợi chút" }, confirmation: "RECAP_AND_WAIT", shippingFee: null, allowedTools: ["search_products"] });
  assert.equal(legacy.enabled, true, "cấu hình cũ vẫn đọc được");
  assert.equal(legacy.booking.enabled, false, "cấu hình cũ chưa có khối đặt lịch ⇒ TẮT");

  const c = { ...parseSalesChatbotConfig(null), booking: cfg };
  assert.ok(!toolDefsFor(c).some((t) => t.name === "book_appointment"), "không bookingOn ⇒ không có công cụ đặt lịch");
  assert.ok(toolDefsFor(c, { bookingOn: true }).some((t) => t.name === "book_appointment"));
  const p = bookingPrompt(c, now);
  assert.ok(p.includes(vnDayOffset(now)) && p.includes("09:00–12:00") && p.includes("book_appointment"), "lời nhắc có ngày hôm nay + giờ mở cửa");
  assert.ok(!systemPrompt(c, "Spa", "", "WEB").includes("ĐẶT LỊCH HẸN"), "không bật ⇒ lời nhắc không nói chuyện đặt lịch");
  assert.ok(systemPrompt(c, "Spa", "", "WEB", "", [], "", p).includes("ĐẶT LỊCH HẸN"));
}

export async function testAppointmentBookingBot() {
  testPure();
  await cleanupOrg();
  // Tổ chức nhà KHÔNG bật module Lịch hẹn ⇒ đường ghi của bot từ chối, kể cả khi ai đó gọi thẳng.
  const homeTry = await createAppointmentAsAgent(BOT, { customerId: "x", variantId: "x", startsAt: new Date(), durationMin: 60, note: "" }, 1);
  assert.ok(!homeTry.ok && homeTry.code === "MODULE_DISABLED", JSON.stringify(homeTry));

  await provisionOrganization({ code: ORG, name: "Spa bot thử", plan: "standard", modules: [], admin: { email: `admin@${ORG}.local`, name: "QT spa", password: "SpaBot@12345" }, source: "TEST", actor: null });
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin: SessionUser = { id: u.id, email: u.email, name: "QT spa", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Spa bot thử", isHome: false }, modules: [...(await getEnabledModules(ORG))] };
      const plan = await planForOrg(SPA_BEAUTY_BLUEPRINT, admin);
      assert.ok(plan.ok && (await installBlueprint(SPA_BEAUTY_BLUEPRINT, admin, { expectedPlanHash: plan.planHash })).ok);
      assert.ok((await getEnabledModules(ORG)).has("appointments"));
      await db.insert(schema.products).values({ id: "erp-bt-prod", name: "Gội đầu dưỡng sinh", raw: { origin: "ERP_MANUAL" } });
      await db.insert(schema.productVariants).values({ id: "erp-bt-v", productId: "erp-bt-prod", sku: "GD-60", size: "60 phút", retailPrice: 150_000 });

      const now = new Date();
      const day = vnDayOffset(now, 1);
      const cfg = { ...parseSalesChatbotConfig(null), booking: { enabled: true, open: "09:00", close: "12:00", days: [0, 1, 2, 3, 4, 5, 6], slotMinutes: 60, capacity: 2, leadMinutes: 60, horizonDays: 7 } satisfies BookingConfig };
      const ctx = (state: ChatState, lastUserText: string, over: { channel?: "WEB" | "TEST"; bookingOn?: boolean; conversationId?: string } = {}) => ({ conversationId: over.conversationId ?? "bt-c1", channel: over.channel ?? ("WEB" as const), config: cfg, state, lastUserText, agent: BOT, bookingOn: over.bookingOn ?? true, now });
      const book = (state: ChatState, last: string, over: Record<string, unknown> = {}, o: Parameters<typeof ctx>[2] = {}) =>
        executeTool("book_appointment", { variant_id: "erp-bt-v", date: day, time: "10:00", name: "Chị Lan", phone: "0903 111 222", customer_confirmation: "ok đặt giúp em", ...over }, ctx(state, last, o));
      const appts = async () => db.select().from(schema.appointments);

      // Công cụ chỉ chạy khi bookingOn.
      const off = await executeTool("find_booking_slots", { date: day }, ctx({}, "", { bookingOn: false }));
      assert.ok(off.isError && off.content.includes("không được bật"));
      const slots = await executeTool("find_booking_slots", { date: day }, ctx({}, ""));
      assert.deepEqual(JSON.parse(slots.content).times, ["09:00", "10:00", "11:00"]);

      // Khách chưa xác nhận ⇒ không ghi gì.
      const noConfirm = await book({}, "cho em đặt 10h mai");
      assert.ok(noConfirm.isError && noConfirm.summary.includes("chưa xác nhận"));
      assert.equal((await appts()).length, 0);

      // Khung thử ⇒ chỉ mô phỏng.
      const test = await book({}, "ok đặt giúp em nhé", {}, { channel: "TEST" });
      assert.ok(!test.isError && test.state.appointment?.simulated === true);
      assert.equal((await appts()).length, 0, "khung thử không ghi lịch thật");
      assert.equal((await db.select().from(schema.customers).where(eq(schema.customers.phone, "0903111222"))).length, 0, "khung thử không tạo khách");

      // Đặt thật.
      const real = await book({}, "ok đặt giúp em nhé");
      assert.ok(!real.isError, real.content);
      const [a] = await appts();
      assert.ok(a && a.status === "BOOKED" && a.staffUserId === null && a.createdByUserId === null && a.createdByName === BOT.name, JSON.stringify(a));
      assert.equal(a.startsAt.toISOString(), vnInstant(day, "10:00")!.toISOString());
      assert.equal(a.endsAt.getTime() - a.startsAt.getTime(), 60 * 60_000);
      assert.equal(a.serviceName, "Gội đầu dưỡng sinh · 60 phút");
      const [kh] = await db.select().from(schema.customers).where(eq(schema.customers.phone, "0903111222"));
      assert.ok(kh && kh.address === "" && a.customerId === kh.id, "khách đặt lịch không cần địa chỉ");
      assert.ok((await db.select().from(schema.notifications).where(eq(schema.notifications.dedupeKey, `sales-chat:booking:${a.id}`))).length === 1, "có tin báo người xem lịch");
      assert.ok((await db.select().from(schema.userMessages).where(and(eq(schema.userMessages.userId, u.id), eq(schema.userMessages.kind, "SALES_CHAT_BOOKING")))).length === 1, "quản trị nhận tin trong chuông");
      const log = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entityId, a.id), eq(schema.auditLogs.action, "APPOINTMENT_CREATE")));
      assert.equal(log.length, 1);
      assert.equal(log[0].actorKind, "AGENT", "tác nhân là MÁY");

      // Một hội thoại một lịch.
      const again = await book(real.state, "ok đặt giúp em nhé", { time: "11:00" });
      assert.ok(again.isError && again.summary.includes("đã đặt"));

      // Hội thoại thứ hai, cùng SĐT ⇒ dùng lại khách; 10:00 còn 1 chỗ (sức chứa 2).
      const second = await book({}, "ok đặt giúp em nhé", { name: "Lan" }, { conversationId: "bt-c2" });
      assert.ok(!second.isError, second.content);
      assert.equal((await db.select().from(schema.customers).where(eq(schema.customers.phone, "0903111222"))).length, 1, "SĐT cũ ⇒ cùng một khách");
      // Hết chỗ: bước kiểm giờ chặn…
      const full = await book({}, "ok đặt giúp em nhé", { phone: "0903999888", name: "Anh Tú" }, { conversationId: "bt-c3" });
      assert.ok(full.isError && full.summary.includes("giờ không nhận"), full.content);
      // …và giao dịch cũng chặn khi ai đó chen vào giữa bước kiểm và bước ghi.
      const raced = await createAppointmentAsAgent(BOT, { customerId: kh.id, variantId: "erp-bt-v", startsAt: vnInstant(day, "10:00")!, durationMin: 60, note: "" }, 2);
      assert.ok(!raced.ok && raced.code === "CONFLICT", JSON.stringify(raced));
      assert.equal((await appts()).length, 2);
      assert.deepEqual(JSON.parse((await executeTool("find_booking_slots", { date: day }, ctx({}, ""))).content).times, ["09:00", "11:00"], "10:00 đã kín");

      // Địa chỉ vẫn bắt buộc với mọi đường lên ĐƠN (mặc định).
      const noAddr = await createCustomerAsAgent(BOT, { name: "Chị Mai", phone: "0903777666", address: "" });
      assert.ok(!noAddr.ok, "mặc định vẫn đòi địa chỉ");
    });
  } finally {
    await cleanupOrg();
  }
  console.log("  ✓ chatbot đặt lịch: giờ trống theo giờ mở cửa · lead · ngày nghỉ · sức chứa đếm mọi lịch; công cụ chỉ có khi bật + module bật; chưa xác nhận ⇒ không ghi; khung thử mô phỏng; lịch BOOKED không kỹ thuật viên + tin báo; một hội thoại một lịch; đầy chỗ ⇒ chặn ở cả bước kiểm lẫn giao dịch; tổ chức tắt module ⇒ từ chối");
}

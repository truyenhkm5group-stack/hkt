/**
 * LỊCH HẸN & LIỆU TRÌNH (module `appointments`, 0190 · docs/verticals/appointments.md) + mẫu ngành «Spa / làm đẹp».
 *
 *  1. THUẦN — chuyển trạng thái (trạng thái cuối không đổi nữa), chồng giờ (chạm mép không chồng), số dư liệu trình (đã làm ·
 *     đang giữ · còn đặt được), liệu trình dùng được (đóng · hết hạn · hết buổi).
 *  2. TỔ CHỨC THẬT (PGlite riêng): module TẮT ở nhà; cài mẫu spa ⇒ đúng bộ module; quyền appointments:write; chặn trùng giờ
 *     của MỘT kỹ thuật viên (người khác cùng giờ vẫn được, chạm mép được, lịch đã huỷ không chiếm giờ); liệu trình giữ chỗ khi
 *     đặt, trừ buổi khi làm xong, không tới không trừ, hết buổi thì không đặt thêm; huỷ cần lý do; sửa giờ không tự va chính nó.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { installBlueprint, planForOrg } from "@/lib/blueprints/install";
import { SPA_BEAUTY_BLUEPRINT } from "@/lib/blueprints/templates/spa-beauty";
import { validateBlueprint } from "@/lib/blueprints/validate";
import { canTransitionAppointment, overlaps, packageBalance, packageUsable } from "@/lib/constants/appointments";
import { moduleDef } from "@/lib/constants/platform-modules";
import { BUSINESS_TYPE_SPEC } from "@/lib/onboarding/shared";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { packagesOf } from "@/lib/queries/appointments";
import { closePackageCore, createAppointmentCore, createPackageCore, setAppointmentStatusCore, updateAppointmentCore } from "@/lib/records/appointments";

const ORG = "ap-spa";

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
const at = (hhmm: string) => `2026-11-05T${hhmm}:00+07:00`;

function testPure() {
  assert.ok(canTransitionAppointment("BOOKED", "DONE") && canTransitionAppointment("CHECKED_IN", "CANCELLED"));
  assert.ok(!canTransitionAppointment("DONE", "CANCELLED") && !canTransitionAppointment("NO_SHOW", "DONE") && !canTransitionAppointment("CHECKED_IN", "NO_SHOW"), "trạng thái cuối không đổi; khách đã tới thì không còn «không tới»");
  const d = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 5, h, m));
  assert.equal(overlaps({ start: d(9), end: d(10) }, { start: d(10), end: d(11) }), false, "chạm mép không chồng");
  assert.equal(overlaps({ start: d(9), end: d(10) }, { start: d(9, 30), end: d(9, 45) }), true);
  assert.deepEqual(packageBalance(10, 3, 2), { total: 10, used: 3, reserved: 2, remaining: 7, available: 5 });
  assert.equal(packageUsable({ status: "CLOSED", expiresOn: null }, packageBalance(5, 0, 0), "2026-11-05").ok, false);
  assert.equal(packageUsable({ status: "ACTIVE", expiresOn: "2026-11-04" }, packageBalance(5, 0, 0), "2026-11-05").ok, false, "hết hạn");
  assert.equal(packageUsable({ status: "ACTIVE", expiresOn: "2026-11-05" }, packageBalance(5, 0, 0), "2026-11-05").ok, true, "đúng ngày hết hạn vẫn dùng");
  assert.equal(packageUsable({ status: "ACTIVE", expiresOn: null }, packageBalance(2, 1, 1), "2026-11-05").ok, false, "1 đã làm + 1 đang giữ = hết");

  const v = validateBlueprint(SPA_BEAUTY_BLUEPRINT);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.equal(BUSINESS_TYPE_SPEC.spa.templateKey, "spa-beauty");
  assert.equal(moduleDef("appointments")?.homeOptIn, true, "module lịch hẹn TẮT ở tổ chức nhà");
}

export async function testAppointments() {
  testPure();
  const home = await getHomeOrganization();
  assert.ok(!(await getEnabledModules(home.code)).has("appointments"), "0190: tổ chức nhà KHÔNG bật lịch hẹn");
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Spa thử", plan: "standard", modules: [], admin: { email: `admin@${ORG}.local`, name: "QT spa", password: "SpaThu@12345" }, source: "TEST", actor: null });
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const sessionOf = async (over: Partial<SessionUser> = {}): Promise<SessionUser> => ({ id: u.id, email: u.email, name: "QT spa", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Spa thử", isHome: false }, modules: [...(await getEnabledModules(ORG))], ...over });

      // ── Cài mẫu spa ⇒ đúng bộ module (gồm lịch hẹn).
      let admin = await sessionOf();
      const plan = await planForOrg(SPA_BEAUTY_BLUEPRINT, admin);
      assert.ok(plan.ok, JSON.stringify(plan.steps.filter((s) => s.action === "BLOCKED")));
      assert.ok((await installBlueprint(SPA_BEAUTY_BLUEPRINT, admin, { expectedPlanHash: plan.planHash })).ok);
      assert.deepEqual([...(await getEnabledModules(ORG))].sort(), [...SPA_BEAUTY_BLUEPRINT.modules].sort());
      admin = await sessionOf();
      const viewer = await sessionOf({ role: "VIEWER", permissions: ["appointments:view", "customers:view"] });

      const [kt2] = await db.insert(schema.users).values({ email: `kt2@${ORG}.local`, name: "KTV Lan", passwordHash: "x", role: "VIEWER" }).returning({ id: schema.users.id });
      const [kh] = await db.insert(schema.customers).values({ name: "Chị Hoa", phone: "0903000111" }).returning({ id: schema.customers.id });
      const [kh2] = await db.insert(schema.customers).values({ name: "Anh Minh" }).returning({ id: schema.customers.id });
      await db.insert(schema.products).values({ id: "erp-ap-prod", name: "Chăm sóc da", raw: { origin: "ERP_MANUAL" } });
      await db.insert(schema.productVariants).values({ id: "erp-ap-v", productId: "erp-ap-prod", sku: "CSD-60", size: "60 phút", retailPrice: 350_000 });
      const slot = (over: Record<string, unknown> = {}) => ({ customerId: kh.id, variantId: "erp-ap-v", staffUserId: u.id, startsAt: at("09:00"), durationMin: 60, ...over });

      // ── Quyền + chặn trùng giờ.
      assert.equal(codeOf(await createAppointmentCore(viewer, slot())), "FORBIDDEN");
      const a1 = await createAppointmentCore(admin, slot());
      assert.ok(a1.ok, JSON.stringify(a1));
      assert.deepEqual(fieldsOf(await createAppointmentCore(admin, slot({ customerId: kh2.id, startsAt: at("09:30") }))), ["staffUserId"], "cùng kỹ thuật viên chồng giờ ⇒ chặn");
      assert.ok((await createAppointmentCore(admin, slot({ customerId: kh2.id, startsAt: at("09:30"), staffUserId: kt2.id }))).ok, "người khác cùng giờ ⇒ được");
      const edge = await createAppointmentCore(admin, slot({ customerId: kh2.id, startsAt: at("10:00") }));
      assert.ok(edge.ok, "chạm mép (10:00) ⇒ được");
      assert.ok((await updateAppointmentCore(admin, a1.id, slot({ startsAt: at("08:30") }))).ok, "dời lịch trong khoảng của chính nó ⇒ không tự va");
      assert.deepEqual(fieldsOf(await updateAppointmentCore(admin, a1.id, slot({ startsAt: at("09:45") }))), ["staffUserId"], "dời vào lịch 10:00 ⇒ chặn");
      assert.deepEqual(fieldsOf(await setAppointmentStatusCore(admin, edge.id, { status: "CANCELLED" })), ["reason"], "huỷ cần lý do");
      assert.ok((await setAppointmentStatusCore(admin, edge.id, { status: "CANCELLED", reason: "Khách báo bận" })).ok);
      assert.ok((await createAppointmentCore(admin, slot({ customerId: kh2.id, startsAt: at("10:00") }))).ok, "lịch đã huỷ không chiếm giờ");
      assert.equal(codeOf(await setAppointmentStatusCore(admin, edge.id, { status: "DONE" })), "CONFLICT", "lịch đã huỷ không làm xong được");

      // ── Liệu trình 2 buổi: đặt giữ chỗ, làm xong trừ buổi, không tới không trừ, hết buổi ⇒ chặn.
      const pkg = await createPackageCore(admin, kh.id, { name: "Chăm sóc da — 2 buổi", variantId: "erp-ap-v", totalSessions: 2 });
      assert.ok(pkg.ok);
      const p1 = await createAppointmentCore(admin, slot({ startsAt: at("13:00"), packageId: pkg.id }));
      const p2 = await createAppointmentCore(admin, slot({ startsAt: at("15:00"), packageId: pkg.id }));
      assert.ok(p1.ok && p2.ok);
      assert.deepEqual(fieldsOf(await createAppointmentCore(admin, slot({ startsAt: at("17:00"), packageId: pkg.id }))), ["packageId"], "2 buổi đang giữ chỗ ⇒ hết");
      assert.deepEqual(fieldsOf(await createAppointmentCore(admin, slot({ customerId: kh2.id, startsAt: at("17:00"), packageId: pkg.id }))), ["packageId"], "liệu trình không thuộc khách khác");
      assert.ok((await setAppointmentStatusCore(admin, p1.id, { status: "DONE" })).ok);
      assert.ok((await setAppointmentStatusCore(admin, p2.id, { status: "NO_SHOW" })).ok);
      let bal = (await packagesOf([kh.id])).find((p) => p.id === pkg.id)!.balance;
      assert.deepEqual([bal.used, bal.reserved, bal.available], [1, 0, 1], "không tới ⇒ không trừ buổi, nhả chỗ");
      const p3 = await createAppointmentCore(admin, slot({ startsAt: at("17:00"), packageId: pkg.id }));
      assert.ok(p3.ok);
      assert.ok((await setAppointmentStatusCore(admin, p3.id, { status: "DONE" })).ok);
      bal = (await packagesOf([kh.id])).find((p) => p.id === pkg.id)!.balance;
      assert.deepEqual([bal.used, bal.available], [2, 0]);
      assert.ok(!(await closePackageCore(admin, pkg.id, "")).ok, "đóng liệu trình cần lý do");
      assert.ok((await closePackageCore(admin, pkg.id, "Đã dùng hết")).ok);
      const [audit] = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "APPOINTMENT_CREATE")).limit(1);
      assert.ok(audit?.userId === u.id, "nhật ký mang khoá tài khoản người đặt");
    });
  } finally {
    await cleanupOrg();
  }
  console.log("✓ Lịch hẹn & liệu trình: module TẮT ở nhà, mẫu spa cài đúng module; chặn trùng giờ một kỹ thuật viên (người khác / chạm mép / lịch huỷ không chặn, dời lịch không tự va); liệu trình giữ chỗ khi đặt, trừ buổi khi làm xong, không tới không trừ, hết buổi chặn đặt, không dùng chéo khách; huỷ / đóng cần lý do; trạng thái cuối không đổi");
}

/**
 * ═══════════ MẪU «NHÀ HÀNG / QUÁN ĂN» (lib/blueprints/templates/restaurant.ts · docs/verticals/restaurant.md) ═══════════
 *
 *  1. THUẦN — mẫu hợp lệ; dựng trên module CÓ SẴN (đặt bàn = Lịch hẹn, chatbot = AI bán hàng); vai trò «Bếp» không ghi đơn,
 *     không xem tiền; loại hình «Nhà hàng / quán ăn» ở /start gợi ý đúng mẫu; mẫu không khai giá / món / số bàn nào.
 *  2. TỔ CHỨC THẬT (`rq-quan`): cài mẫu ⇒ đúng bộ module, field «Hình thức» / «Số bàn» trên đơn, hai vai trò; cài lại lần hai
 *     không tạo thêm gì.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { installBlueprint, planForOrg } from "@/lib/blueprints/install";
import { RESTAURANT_BLUEPRINT } from "@/lib/blueprints/templates/restaurant";
import { validateBlueprint } from "@/lib/blueprints/validate";
import { BUSINESS_TYPE_SPEC } from "@/lib/onboarding/shared";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";

const ORG = "rq-quan";

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
  const v = validateBlueprint(RESTAURANT_BLUEPRINT);
  assert.ok(v.ok, JSON.stringify(v.errors));
  for (const m of ["appointments", "ai_sales", "orders", "products", "customers"]) assert.ok(RESTAURANT_BLUEPRINT.modules.includes(m as never), `module ${m}`);
  const bep = RESTAURANT_BLUEPRINT.roles?.find((r) => r.key === "bep");
  assert.ok(bep && !bep.permissions.includes("orders:write") && !bep.permissions.some((p) => p.startsWith("finance") || p.startsWith("reports")), "bếp không sửa đơn, không xem tiền");
  const hinhThuc = RESTAURANT_BLUEPRINT.fields?.find((f) => f.objectKey === "order" && f.key === "hinh_thuc");
  assert.deepEqual(hinhThuc?.options?.map((o) => o.value), ["tai_ban", "mang_ve", "giao_hang"]);
  assert.equal(BUSINESS_TYPE_SPEC.restaurant.templateKey, "restaurant");
  // Không khai giá / số bàn mặc định (luật 38): mẫu không mang sản phẩm, không mang cấu hình đặt lịch.
  const json = JSON.stringify(RESTAURANT_BLUEPRINT);
  assert.ok(!/"retailPrice"|"capacity"|"price"/.test(json), "mẫu không mang giá hay số bàn");
}

export async function testRestaurantTemplate() {
  testPure();
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Quán thử", plan: "standard", modules: [], admin: { email: `admin@${ORG}.local`, name: "QT quán", password: "QuanThu@12345" }, source: "TEST", actor: null });
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const sessionOf = async (): Promise<SessionUser> => ({ id: u.id, email: u.email, name: "QT quán", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Quán thử", isHome: false }, modules: [...(await getEnabledModules(ORG))] });
      let admin = await sessionOf();
      const plan = await planForOrg(RESTAURANT_BLUEPRINT, admin);
      assert.ok(plan.ok, JSON.stringify(plan.steps.filter((s) => s.action === "BLOCKED")));
      const done = await installBlueprint(RESTAURANT_BLUEPRINT, admin, { expectedPlanHash: plan.planHash });
      assert.ok(done.ok, JSON.stringify(done));
      assert.deepEqual([...(await getEnabledModules(ORG))].sort(), [...RESTAURANT_BLUEPRINT.modules].sort());
      const roles = await db.select({ code: schema.accessRoles.code }).from(schema.accessRoles);
      assert.ok(["THU_NGAN", "BEP"].every((c) => roles.some((r) => r.code.toUpperCase() === c)), JSON.stringify(roles));
      admin = await sessionOf();
      const again = await planForOrg(RESTAURANT_BLUEPRINT, admin);
      assert.ok(again.ok && !again.steps.some((s) => s.action === "CREATE"), `cài lại không tạo thêm: ${JSON.stringify(again.steps.filter((s) => s.action === "CREATE"))}`);
    });
  } finally {
    await cleanupOrg();
  }
  console.log("  ✓ mẫu nhà hàng: hợp lệ, dựng trên Lịch hẹn + AI bán hàng có sẵn, bếp không sửa đơn / không xem tiền, /start gợi ý đúng mẫu, không mang giá / số bàn; cài thật ⇒ đúng module + vai trò, cài lại không tạo thêm");
}

/**
 * CÔNG TẮC TỔ CHỨC CỦA FACEBOOK FRIEND CRM (`lib/fb-crm/settings.ts`) — chủ shop HSLC 30/10/2026 «Có bật Facebook CRM cho HSLC».
 *
 * Tổ chức PGlite riêng `fbt-si`: chỉ `settings:manage` bật / tắt được; bấm lại cùng trạng thái KHÔNG ghi settings và KHÔNG ghi nhật ký
 * (luật 61); mỗi lượt đổi thật đúng MỘT dòng audit `FB_CRM_TOGGLE` mang khoá tài khoản; cờ đọc lại đúng qua `fbCrmEnabled()`; giá trị lưu
 * là OBJECT `{"on": …}`. Trang dựng công tắc chỉ cho người có quyền, người khác thấy câu «nhờ quản trị bật» (quét mã nguồn).
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { FB_CRM_SETTING_KEY } from "@/lib/constants/fb-crm";
import { AUDIT_ACTION_LABEL } from "@/lib/constants/audit";
import { fbCrmSetEnabledCore } from "@/lib/fb-crm/settings";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { fbCrmEnabled } from "@/lib/queries/fb-crm";

const ORG = "fbt-si";

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

function testSource() {
  const goc = path.resolve(__dirname, "..");
  const page = readFileSync(path.join(goc, "app/(dashboard)/customers/facebook-crm/page.tsx"), "utf8");
  assert.ok(page.includes(`can(user, "settings:manage")`), "trang dựng công tắc theo ĐÚNG quyền các trang /settings dùng (settings:manage)");
  assert.ok((page.match(/<FbCrmToggle/g) ?? []).length >= 2, "công tắc có mặt ở CẢ trạng thái tắt lẫn bật");
  const toggle = readFileSync(path.join(goc, "app/(dashboard)/customers/facebook-crm/fb-crm-toggle.tsx"), "utf8");
  assert.ok(toggle.includes("nhờ quản trị"), "người không có quyền thấy câu nhờ quản trị bật");
  assert.ok(AUDIT_ACTION_LABEL.FB_CRM_TOGGLE, "nhật ký có nhãn tiếng Việt cho lượt bật / tắt");
  const settings = readFileSync(path.join(goc, "lib/fb-crm/settings.ts"), "utf8");
  assert.ok(!settings.includes("getPlatformDb"), "cờ ở settings của CSDL TỔ CHỨC, không ở CSDL nền tảng");
}

export async function testFbCrmToggle() {
  testSource();
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "HSLC thử công tắc FB CRM", plan: "standard", modules: ["customers", "products", "orders"], admin: { email: `admin@${ORG}.local`, name: "QT công tắc", password: "FbToggle@12345" }, source: "TEST", actor: null });
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const org = { code: ORG, name: "HSLC thử công tắc FB CRM", isHome: false };
      const admin: SessionUser = { id: u.id, email: u.email, name: "QT công tắc", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: org };
      // Có customers:write nhưng KHÔNG có settings:manage — sửa được khách, không bật được tính năng của tổ chức.
      const staff: SessionUser = { ...admin, role: "CS", permissions: ["customers:view", "customers:write"] };
      const audits = () => db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "FB_CRM_TOGGLE"), eq(schema.auditLogs.entityId, FB_CRM_SETTING_KEY)));
      const stored = async () => (await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, FB_CRM_SETTING_KEY)))[0]?.value ?? null;

      assert.equal(await fbCrmEnabled(), false, "mặc định TẮT");
      const denied = await fbCrmSetEnabledCore(staff, { on: true });
      assert.ok(!denied.ok && denied.error.includes("settings:manage"), "thiếu settings:manage ⇒ từ chối");
      assert.equal(await fbCrmEnabled(), false);
      assert.equal(await stored(), null, "lượt bị từ chối không ghi gì");
      assert.ok(!(await fbCrmSetEnabledCore(admin, { on: "true" })).ok, "zod: chỉ nhận boolean");

      const noop = await fbCrmSetEnabledCore(admin, { on: false });
      assert.ok(noop.ok && !noop.changed, "tắt khi đang tắt ⇒ không đổi");
      assert.equal(await stored(), null, "không đổi ⇒ không ghi settings");
      assert.equal((await audits()).length, 0, "không đổi ⇒ không ghi nhật ký");

      const on = await fbCrmSetEnabledCore(admin, { on: true });
      assert.ok(on.ok && on.changed && on.on);
      assert.equal(await fbCrmEnabled(), true, "cờ đọc lại đúng sau khi bật");
      assert.deepEqual(JSON.parse(String(await stored())), { on: true }, "giá trị lưu là object {on: true}");
      const again = await fbCrmSetEnabledCore(admin, { on: true });
      assert.ok(again.ok && !again.changed, "bật lần hai ⇒ không ghi");
      let rows = await audits();
      assert.equal(rows.length, 1, "MỘT lượt đổi thật = MỘT dòng nhật ký");
      assert.equal(rows[0].userId, admin.id, "nhật ký mang khoá tài khoản (luật 34)");

      const off = await fbCrmSetEnabledCore(admin, { on: false });
      assert.ok(off.ok && off.changed && !off.on);
      assert.equal(await fbCrmEnabled(), false, "cờ đọc lại đúng sau khi tắt");
      assert.deepEqual(JSON.parse(String(await stored())), { on: false });
      rows = await audits();
      assert.equal(rows.length, 2);
    });
  } finally {
    await cleanupOrg();
  }
  console.log("✓ Facebook CRM công tắc tổ chức: chỉ settings:manage · bấm lại cùng trạng thái không ghi settings / nhật ký · mỗi lượt đổi một dòng audit mang khoá tài khoản · cờ đọc lại đúng · lưu object {on}");
}

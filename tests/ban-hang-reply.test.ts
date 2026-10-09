/**
 * ═══════════ «NHÂN VIÊN BÁN HÀNG» TRẢ LỜI ĐƯỢC KHÁCH — chủ shop duyệt 09/10/2026 ═══════════
 *
 * Vai trò `BAN_HANG` của mẫu «AI bán hàng» nhận ĐÚNG MỘT quyền `ai_sales:reply`, cho tổ chức mới (mẫu 1.1.0) lẫn tổ chức đã có
 * (ops `ban-hang-reply-upgrade` → lib/blueprints/ban-hang-reply.ts, đi qua phép so ba chiều của bộ cài mẫu). Khoá:
 *  1. Mẫu cho đúng tám quyền (bảy cũ + `ai_sales:reply`); bản thu hẹp chỉ mang mục vai trò, không module.
 *  2. CHẠY THỬ không ghi gì: quyền, sổ cài, nhật ký y nguyên.
 *  3. GHI: thêm đúng `ai_sales:reply` vào BAN_HANG (không bớt / thêm quyền nào khác), vai trò mã khác không đổi; chạy lại ⇒ 0
 *     tổ chức được nâng; tổ chức đã tự sửa vai trò ⇒ bỏ qua; BAN_HANG nền khác VIEWER ⇒ bỏ qua (mơ hồ).
 *  4. Người mang BAN_HANG: trước nâng `can(…, "ai_sales:reply")` = false, sau nâng = true (đọc phiên thật).
 *  5. Ô arg của script: rỗng / mã / --apply; cờ lạ ⇒ lỗi cách dùng.
 *
 * Tổ chức THẬT (mã `bhr-a` · `bhr-b` · `bhr-c`, thương hiệu chotdon) tự cấp và tự dọn.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, count, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { can, resolveCurrentUser, setRequestPathSourceForTests, signSession, type SessionUser } from "@/lib/auth/session";
import { BAN_HANG_REPLY_PERMISSION, banHangReplySummaryLines, banHangRoleBlueprint, runBanHangReplyUpgrade, upgradeBanHangReplyForOrg } from "@/lib/blueprints/ban-hang-reply";
import { installBlueprint } from "@/lib/blueprints/install";
import { AI_SALES_BLUEPRINT } from "@/lib/blueprints/templates/ai-sales";
import type { Blueprint } from "@/lib/blueprints/types";
import { SHELL_SALES_STAFF_ROLE_CODE } from "@/lib/constants/roles";
import { adminSessionUser } from "@/lib/onboarding/service";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { setSessionTokenSourceForTests, withOrganization } from "@/lib/platform/context";
import { findOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { parseBanHangReplyArgs } from "@/scripts/ban-hang-reply-upgrade";

const ORGS = ["bhr-a", "bhr-b", "bhr-c"] as const;
const MODULES = ["customers", "products", "orders", "inventory", "ai_sales"];
const OLD_PERMS = ["dashboard:view", "orders:read", "orders:write", "customers:view", "customers:write", "products:view", "ai_sales:view"];

/** Mẫu như bản 1.0.0 mà tổ chức cũ đã cài: vai trò bán hàng bảy quyền. */
function oldTemplate(): Blueprint {
  return { ...AI_SALES_BLUEPRINT, version: "1.0.0", roles: (AI_SALES_BLUEPRINT.roles ?? []).map((r) => ({ ...r, permissions: OLD_PERMS })) };
}

export function testBanHangReplyPure() {
  const role = (AI_SALES_BLUEPRINT.roles ?? []).find((r) => r.key.toUpperCase() === SHELL_SALES_STAFF_ROLE_CODE)!;
  assert.deepEqual([...role.permissions].sort(), [...OLD_PERMS, BAN_HANG_REPLY_PERMISSION].sort(), "mẫu: đúng tám quyền — bảy cũ + ai_sales:reply (chủ shop duyệt 09/10/2026)");
  assert.equal(role.base, "VIEWER");
  assert.equal(AI_SALES_BLUEPRINT.version, "1.1.0", "mẫu đổi ⇒ phiên bản đổi");
  const narrow = banHangRoleBlueprint();
  assert.deepEqual({ key: narrow.key, version: narrow.version, modules: narrow.modules, roles: narrow.roles?.map((r) => r.key), fields: narrow.fields }, { key: "ai-sales", version: "1.1.0", modules: ["core"], roles: ["ban_hang"], fields: undefined }, "bản thu hẹp: cùng khoá + phiên bản, CHỈ mục vai trò (+ core luôn bật) — không bật lại module, không dựng lại field");

  assert.deepEqual(parseBanHangReplyArgs([]), { ok: true, apply: false, orgCode: null }, "mặc định CHẠY THỬ mọi tổ chức");
  assert.deepEqual(parseBanHangReplyArgs(["bhr-a"]), { ok: true, apply: false, orgCode: "bhr-a" });
  assert.deepEqual(parseBanHangReplyArgs(["--apply"]), { ok: true, apply: true, orgCode: null });
  assert.equal(parseBanHangReplyArgs(["--force"]).ok, false, "cờ lạ ⇒ lỗi cách dùng");
  assert.equal(parseBanHangReplyArgs(["a", "b"]).ok, false);
  assert.equal(parseBanHangReplyArgs(["Bad Code"]).ok, false);
  const lines = banHangReplySummaryLines({ apply: false, orgs: [{ orgCode: "bi-mat", outcome: "WOULD_UPDATE", detail: null }], counts: { UPDATED: 0, WOULD_UPDATE: 1, ALREADY: 0, NO_ROLE: 0, SKIP_BASE: 0, SKIP_CUSTOMIZED: 0, SKIP_NOT_FROM_TEMPLATE: 0, SKIP_NO_ADMIN: 0, SKIP_HOME: 0, SKIP_INACTIVE_ORG: 0, FAILED: 0 } });
  assert.ok(lines.every((l) => !l.includes("bi-mat")), "tóm tắt công khai: chỉ số đếm, không mã tổ chức");
  console.log("✓ Nhân viên bán hàng trả lời khách (thuần): mẫu 1.1.0 đúng tám quyền · bản thu hẹp chỉ vai trò · ô arg mặc định chạy thử · tóm tắt chỉ số đếm");
}

async function provision(code: string) {
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  const r = await provisionOrganization({ code, name: `Shop ${code}`, modules: MODULES, admin: { email: `chu@${code}.local`, name: "Chủ shop", password: "Bhr-shop@12345" }, source: "TEST", actor: null, brand: "chotdon" });
  assert.equal(r.created, true);
  const subject = await adminSessionUser(code, `Shop ${code}`, `chu@${code}.local`);
  assert.ok(subject);
  return subject;
}

const roleOf = (code: string, roleCode: string) => withOrganization(code, async () => (await getDb()).query.accessRoles.findFirst({ where: eq(schema.accessRoles.code, roleCode) }));
const ledgerCount = (code: string) => withOrganization(code, async () => Number((await (await getDb()).select({ n: count() }).from(schema.blueprintInstalls))[0]?.n ?? 0));
const auditCount = (code: string) => withOrganization(code, async () => Number((await (await getDb()).select({ n: count() }).from(schema.auditLogs))[0]?.n ?? 0));

async function canReplyAs(code: string, user: { id: string; email: string; name: string }): Promise<boolean> {
  const token = await signSession({ id: user.id, email: user.email, name: user.name, role: "VIEWER", orgCode: code });
  setSessionTokenSourceForTests(async () => token);
  setRequestPathSourceForTests(() => "/ai/sales-chatbot/inbox");
  try {
    const r = await resolveCurrentUser();
    assert.ok("user" in r, "nhân viên bán hàng mở được phiên");
    return can(r.user as SessionUser, "ai_sales:reply");
  } finally {
    setSessionTokenSourceForTests(null);
    setRequestPathSourceForTests(null);
  }
}

export async function testBanHangReplyServer() {
  const pdb = await getPlatformDb();
  let failure: unknown = null;
  try {
    // ── A: tổ chức cài mẫu 1.0.0 (bảy quyền), có một vai trò mã khác và một nhân viên mang BAN_HANG ──
    const a = await provision("bhr-a");
    const cai = await withOrganization("bhr-a", () => installBlueprint(banHangRoleBlueprint(oldTemplate()), a));
    assert.ok(cai.ok, `cài mẫu cũ: ${JSON.stringify(cai)}`);
    const banA = await roleOf("bhr-a", SHELL_SALES_STAFF_ROLE_CODE);
    assert.deepEqual([...(banA?.permissions ?? [])].sort(), [...OLD_PERMS].sort(), "trước nâng: bảy quyền");
    const lan = await withOrganization("bhr-a", async () => {
      const db = await getDb();
      await db.insert(schema.accessRoles).values({ code: "KHAC", name: "Vai trò khác", description: "", baseRole: "VIEWER", permissions: ["dashboard:view"], defaultScope: "ALL", active: true });
      const [u] = await db.insert(schema.users).values({ email: "lan@bhr-a.local", name: "Lan", passwordHash: "x", role: "VIEWER", accessRoleId: banA!.id }).returning({ id: schema.users.id, email: schema.users.email, name: schema.users.name });
      return u;
    });
    assert.equal(await canReplyAs("bhr-a", lan), false, "trước nâng: nhân viên bán hàng CHƯA trả lời được");

    // ── B: đã cài rồi TỰ SỬA vai trò (đổi tên) ⇒ bỏ qua ──
    const b = await provision("bhr-b");
    assert.ok((await withOrganization("bhr-b", () => installBlueprint(banHangRoleBlueprint(oldTemplate()), b))).ok);
    await withOrganization("bhr-b", async () => (await getDb()).update(schema.accessRoles).set({ name: "Sale ca tối" }).where(eq(schema.accessRoles.code, SHELL_SALES_STAFF_ROLE_CODE)));

    // ── C: BAN_HANG nền khác VIEWER (không do mẫu) ⇒ mơ hồ, bỏ qua ──
    await provision("bhr-c");
    await withOrganization("bhr-c", async () => (await getDb()).insert(schema.accessRoles).values({ code: SHELL_SALES_STAFF_ROLE_CODE, name: "Nhân viên bán hàng", description: "", baseRole: "CS", permissions: OLD_PERMS, defaultScope: "ALL", active: true }));

    invalidateOrganizations();
    const orgOf = async (code: string) => (await findOrganization(code))!;

    // ── CHẠY THỬ: không ghi gì ──
    const truoc = { ledger: await ledgerCount("bhr-a"), audit: await auditCount("bhr-a") };
    const thu = await upgradeBanHangReplyForOrg(await orgOf("bhr-a"), { apply: false });
    assert.equal(thu.outcome, "WOULD_UPDATE");
    assert.deepEqual([...((await roleOf("bhr-a", SHELL_SALES_STAFF_ROLE_CODE))?.permissions ?? [])].sort(), [...OLD_PERMS].sort(), "chạy thử: quyền không đổi");
    assert.deepEqual({ ledger: await ledgerCount("bhr-a"), audit: await auditCount("bhr-a") }, truoc, "chạy thử: không một dòng sổ cài / nhật ký nào");
    const dryAll = await runBanHangReplyUpgrade({ apply: false, orgCode: "bhr-b" });
    assert.equal(dryAll.counts.SKIP_CUSTOMIZED, 1, "chạy thử thấy tổ chức đã tự sửa");

    // ── GHI ──
    const ghi = await upgradeBanHangReplyForOrg(await orgOf("bhr-a"), { apply: true });
    assert.equal(ghi.outcome, "UPDATED", JSON.stringify(ghi));
    const sau = await roleOf("bhr-a", SHELL_SALES_STAFF_ROLE_CODE);
    assert.deepEqual([...(sau?.permissions ?? [])].sort(), [...OLD_PERMS, BAN_HANG_REPLY_PERMISSION].sort(), "ghi: thêm ĐÚNG ai_sales:reply, không bớt / thêm quyền nào khác");
    assert.deepEqual({ name: sau?.name, baseRole: sau?.baseRole, active: sau?.active, id: sau?.id }, { name: banA!.name, baseRole: "VIEWER", active: true, id: banA!.id }, "ghi: tên / nền / trạng thái / id giữ nguyên");
    assert.deepEqual((await roleOf("bhr-a", "KHAC"))?.permissions, ["dashboard:view"], "vai trò mã khác KHÔNG đổi");
    const nhatKy = await withOrganization("bhr-a", async () => (await getDb()).select({ action: schema.auditLogs.action }).from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "BLUEPRINT_STEP"))));
    assert.ok(nhatKy.length >= 2, "ghi qua bộ cài: có nhật ký bước mẫu (lần cài cũ + lần nâng)");
    assert.equal(await canReplyAs("bhr-a", lan), true, "sau nâng: nhân viên bán hàng trả lời được khách");

    const lai = await upgradeBanHangReplyForOrg(await orgOf("bhr-a"), { apply: true });
    assert.equal(lai.outcome, "ALREADY", "chạy lại ⇒ không nâng gì (idempotent)");

    const runB = await runBanHangReplyUpgrade({ apply: true, orgCode: "bhr-b" });
    assert.equal(runB.counts.SKIP_CUSTOMIZED, 1, "tổ chức đã tự sửa vai trò ⇒ bỏ qua");
    assert.deepEqual([...((await roleOf("bhr-b", SHELL_SALES_STAFF_ROLE_CODE))?.permissions ?? [])].sort(), [...OLD_PERMS].sort(), "bỏ qua ⇒ quyền y nguyên");

    const runC = await runBanHangReplyUpgrade({ apply: true, orgCode: "bhr-c" });
    assert.equal(runC.counts.SKIP_BASE, 1, "nền khác VIEWER ⇒ bỏ qua (mơ hồ)");
    assert.deepEqual((await roleOf("bhr-c", SHELL_SALES_STAFF_ROLE_CODE))?.permissions, OLD_PERMS, "bỏ qua ⇒ quyền y nguyên");

    const runAgain = await runBanHangReplyUpgrade({ apply: true, orgCode: "bhr-a" });
    assert.equal(runAgain.counts.UPDATED, 0, "lượt hai trên cả lượt quét: 0 tổ chức được nâng");
  } catch (error) {
    failure = error;
  }
  try {
    setSessionTokenSourceForTests(null);
    setRequestPathSourceForTests(null);
    for (const code of ORGS) {
      await pdb.update(schema.platformOrganizations).set({ status: "ARCHIVED" }).where(eq(schema.platformOrganizations.code, code));
      invalidateCapabilities(code);
    }
    invalidateOrganizations();
    for (const code of ORGS) rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  } catch (cleanupError) {
    if (!failure) throw cleanupError;
    console.error("[ban-hang-reply] dọn dẹp cũng lỗi (lỗi chính ở dưới):", cleanupError);
  }
  if (failure) throw failure;
  console.log("✓ Nhân viên bán hàng trả lời khách (máy chủ): chạy thử không ghi · ghi thêm đúng ai_sales:reply qua bộ cài · vai trò khác không đổi · chạy lại 0 · đã tự sửa / nền khác ⇒ bỏ qua · can(ai_sales:reply) false → true");
}

/**
 * ═══════════ VAI TRÒ Ở VỎ CHỐT ĐƠN: ĐÚNG BA LỰA CHỌN (commercial C1 #5 · MM-FU-700) ═══════════
 *
 * Đo 09/10/2026: không vai trò HỆ THỐNG nào vừa với «nhân viên bán hàng» mà không thừa quyền (CS / LEADER thiếu
 * `ai_sales:view`, MANAGER thừa COD / chi phí / đồng bộ và thiếu tạo đơn / khách). Vai trò đúng việc đã có sẵn: mẫu «AI bán
 * hàng» cài vai trò tuỳ chỉnh mã `BAN_HANG`. Nên vỏ chỉ cho chọn Chủ cửa hàng (ADMIN) · Nhân viên bán hàng (`BAN_HANG`) ·
 * Chỉ xem (VIEWER). Đây là TRÌNH BÀY + GIỚI HẠN LỰA CHỌN: không đổi một quyền, một mẫu vai trò, hay `lib/auth/*`.
 *
 * Khoá:
 *  1. THUẦN — bộ ba của vỏ; thiếu / tắt `BAN_HANG` ⇒ chỉ hai lựa chọn + câu báo, không lùi sang vai trò khác; nhận ra vai trò
 *     bán hàng bằng MÃ (một vai trò khác MANG TÊN «Nhân viên bán hàng» không lọt); mã khớp mẫu thật.
 *  2. ERP KHÔNG ĐỔI — tám vai trò, nhãn, mô tả y nguyên; hộp thoại ERP vẫn liệt kê ROLE_ORDER + vai trò tuỳ chỉnh.
 *  3. QUÉT MÃ NGUỒN — không quyền / mẫu vai trò nào bị sửa ngoài ý chủ shop: vai trò `BAN_HANG` của mẫu giữ ĐÚNG tám quyền
 *     (thứ tám `ai_sales:reply` do chủ shop duyệt 09/10/2026 — mọi thay đổi khác phải qua chủ shop), tệp hằng của vỏ không đụng
 *     tới bộ máy quyền.
 *  4. MÁY CHỦ (tổ chức THẬT mã `ssr-shell`, thương hiệu chotdon) — mời / tạo / sửa / gán vai trò ngoài bộ ⇒ `{ error }`;
 *     trong bộ ⇒ đi qua; thiếu `BAN_HANG` ⇒ mời bán hàng bị từ chối. Nhà (ERP) mời «Quản lý» vẫn được.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, rmSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { RequestCookies, ResponseCookies } from "next/dist/server/web/spec-extension/cookies";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { setUserAccess } from "@/lib/actions/access";
import { createUserInviteAction } from "@/lib/actions/user-invites";
import { createUser, updateUser } from "@/lib/actions/users";
import { signSession } from "@/lib/auth/session";
import { AI_SALES_BLUEPRINT } from "@/lib/blueprints/templates/ai-sales";
import {
  ROLE_HINT,
  ROLE_LABEL,
  ROLE_ORDER,
  salesStaffRoleOf,
  SHELL_ROLE_INVITE_CHOICE,
  SHELL_ROLE_LABEL,
  SHELL_ROLE_REJECTED,
  SHELL_ROLE_SYSTEM_ROLE,
  SHELL_SALES_STAFF_MISSING_NOTE,
  SHELL_SALES_STAFF_ROLE_CODE,
  shellRoleChoiceOk,
  shellRoleKeyOf,
  shellRoleKeys,
} from "@/lib/constants/roles";
import { SESSION_COOKIE } from "@/lib/constants/session";
import { inviteChoiceToInput } from "@/lib/users/invite-shared";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { setSessionTokenSourceForTests, withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";

const ORG = "ssr-shell";
const HOME_ADMIN_ID = "ssr-home-admin";
const SHELL_MODULES = ["customers", "products", "orders", "inventory", "ai_sales"];

/* ═════════════ 1 + 2 + 3 · THUẦN, ERP, QUÉT MÃ NGUỒN ═════════════ */
export function testShellStaffRolesPure() {
  // Mã vai trò bán hàng = khoá của mẫu viết HOA (lib/blueprints/apply.ts dựng `code: role.key.toUpperCase()`).
  const tmpl = AI_SALES_BLUEPRINT.roles?.find((r) => r.key.toUpperCase() === SHELL_SALES_STAFF_ROLE_CODE);
  assert.ok(tmpl, "mẫu «AI bán hàng» phải cài vai trò mã BAN_HANG — vỏ nhận ra vai trò bán hàng bằng mã ấy");
  assert.equal(tmpl!.base, "VIEWER", "vai trò bán hàng có nền VIEWER");
  assert.deepEqual(
    [...tmpl!.permissions].sort(),
    ["ai_sales:reply", "ai_sales:view", "customers:view", "customers:write", "dashboard:view", "orders:read", "orders:write", "products:view"],
    "tám quyền của vai trò bán hàng — `ai_sales:reply` chủ shop duyệt 09/10/2026; thêm / bớt quyền nào khác là quyết định của chủ shop, không phải của một bản vá",
  );

  assert.deepEqual(shellRoleKeys(true), ["OWNER", "SALES", "VIEWER"], "vỏ: đúng ba lựa chọn, đúng thứ tự");
  assert.deepEqual(shellRoleKeys(false), ["OWNER", "VIEWER"], "thiếu vai trò bán hàng ⇒ chỉ hai, KHÔNG lùi sang vai trò khác");
  assert.deepEqual(SHELL_ROLE_LABEL, { OWNER: "Chủ cửa hàng", SALES: "Nhân viên bán hàng", VIEWER: "Chỉ xem" });
  assert.equal(SHELL_SALES_STAFF_MISSING_NOTE, "Vai trò Nhân viên bán hàng chưa được cài — liên hệ hỗ trợ");
  assert.deepEqual(SHELL_ROLE_SYSTEM_ROLE, { OWNER: "ADMIN", SALES: "VIEWER", VIEWER: "VIEWER" });
  // Ô chọn của hộp thoại mời dịch về đúng đầu vào của lõi lời mời.
  assert.deepEqual(inviteChoiceToInput(SHELL_ROLE_INVITE_CHOICE.OWNER), { role: "ADMIN" });
  assert.deepEqual(inviteChoiceToInput(SHELL_ROLE_INVITE_CHOICE.SALES), { accessRoleCode: SHELL_SALES_STAFF_ROLE_CODE });
  assert.deepEqual(inviteChoiceToInput(SHELL_ROLE_INVITE_CHOICE.VIEWER), { role: "VIEWER" });

  for (const r of ["ADMIN", "VIEWER"]) assert.equal(shellRoleChoiceOk({ role: r }, true), true, `${r} thuộc bộ của vỏ`);
  for (const r of ROLE_ORDER.filter((x) => x !== "ADMIN" && x !== "VIEWER")) assert.equal(shellRoleChoiceOk({ role: r }, true), false, `${r} KHÔNG thuộc bộ của vỏ`);
  assert.equal(shellRoleChoiceOk({ accessRoleCode: "BAN_HANG" }, true), true);
  assert.equal(shellRoleChoiceOk({ accessRoleCode: "BAN_HANG" }, false), false, "chưa cài ⇒ không nhận mã bán hàng");
  assert.equal(shellRoleChoiceOk({ accessRoleCode: "KHAC", role: "ADMIN" }, true), false, "mã tuỳ chỉnh khác ⇒ từ chối, kể cả khi kèm role hợp lệ");
  assert.equal(shellRoleChoiceOk({}, true), false, "không chọn gì ⇒ từ chối");
  assert.equal(shellRoleChoiceOk({ role: "admin" }, true), false, "chuỗi lạ ⇒ phía hẹp");

  const roles = [
    { id: "r1", code: "KHAC", name: "Nhân viên bán hàng", active: true, baseRole: "VIEWER" },
    { id: "r2", code: "BAN_HANG", name: "Tên đã đổi", active: true, baseRole: "VIEWER" },
  ];
  assert.equal(salesStaffRoleOf(roles)?.id, "r2", "nhận ra bằng MÃ, không bằng tên hiển thị");
  assert.equal(salesStaffRoleOf([{ ...roles[1], active: false }]), null, "vai trò tắt ⇒ coi như chưa cài");
  assert.equal(salesStaffRoleOf([{ ...roles[1], baseRole: "ADMIN" }]), null, "nền ADMIN không bao giờ là vai trò bán hàng (luật 31)");
  assert.equal(salesStaffRoleOf([roles[0]]), null, "chỉ có vai trò trùng TÊN ⇒ chưa cài");

  assert.equal(shellRoleKeyOf({ role: "ADMIN" }, null, "r2"), "OWNER");
  assert.equal(shellRoleKeyOf({ role: "VIEWER" }, "r2", "r2"), "SALES");
  assert.equal(shellRoleKeyOf({ role: "VIEWER" }, null, "r2"), "VIEWER");
  assert.equal(shellRoleKeyOf({ role: "VIEWER" }, "r1", "r2"), null, "vai trò tuỳ chỉnh khác ⇒ ngoài bộ, phải chọn lại");
  assert.equal(shellRoleKeyOf({ role: "CS" }, null, "r2"), null, "vai trò hệ thống cũ ⇒ ngoài bộ");

  // ERP KHÔNG ĐỔI: tám vai trò, nhãn, mô tả y nguyên.
  assert.deepEqual(ROLE_ORDER, ["ADMIN", "MANAGER", "LEADER", "ACCOUNTANT", "WAREHOUSE", "CS", "MARKETING", "VIEWER"]);
  assert.deepEqual(Object.values(ROLE_LABEL), ["Quản trị", "Quản lý", "Trưởng nhóm", "Kế toán", "Kho", "CSKH", "Marketing", "Chỉ xem"]);
  assert.equal(ROLE_HINT.ADMIN, "Toàn quyền: quản lý người dùng, cấu hình, đồng bộ");
  const dir = "app/(dashboard)/settings/users/";
  const dialog = readFileSync(`${dir}user-dialog.tsx`, "utf8");
  const invite = readFileSync(`${dir}invites-panel.tsx`, "utf8");
  const page = readFileSync(`${dir}page.tsx`, "utf8");
  assert.ok(dialog.includes("{ROLE_ORDER.map((r) => (") && dialog.includes("<RoleSelect value={field.value} onChange={field.onChange} />"), "ERP: ô vai trò vẫn liệt kê tám vai trò hệ thống");
  assert.ok(invite.includes("<SelectLabel>Vai trò hệ thống</SelectLabel>") && invite.includes("<SelectLabel>Vai trò tuỳ chỉnh</SelectLabel>"), "ERP: hộp thoại mời vẫn có vai trò hệ thống + tuỳ chỉnh");
  assert.match(page, /const shellRoles = shell \? \{ salesRoleId: salesRole\?\.id \?\? null \} : undefined;/, "chỉ vỏ mới truyền bộ ba — ERP nhận `undefined` ⇒ hộp thoại như cũ");
  assert.match(page, /const salesRole = shell \? salesStaffRoleOf\(accessRoles\) : null;/);

  // QUÉT MÃ NGUỒN: tệp hằng của vỏ không chạm bộ máy quyền; ba action chỉ thêm một lượt kiểm lựa chọn.
  const rolesSrc = readFileSync("lib/constants/roles.ts", "utf8");
  assert.ok(!/@\/lib\/auth\//.test(rolesSrc) && !/DEFAULT_ROLE_PERMISSIONS|ROLE_PERMISSIONS_KEY|ALL_PERMISSIONS/.test(rolesSrc), "lib/constants/roles.ts không đọc / ghi quyền");
  for (const f of ["lib/actions/users.ts", "lib/actions/user-invites.ts"]) {
    const src = readFileSync(f, "utf8");
    const helper = src.slice(src.indexOf("async function shellRoleError"), src.indexOf("function pick("));
    assert.ok(helper.length > 0 && !/permissions|setSettingJson|ROLE_PERMISSIONS_KEY|update\(/.test(helper), `${f}: lượt kiểm của vỏ chỉ ĐỌC và TỪ CHỐI`);
  }
  const accessSrc = readFileSync("lib/actions/access.ts", "utf8");
  assert.match(accessSrc, /if \(isSalesAgentUser\(user\) && data\.accessRoleId\) \{\n\s+const sales = salesStaffRoleOf\(await listAccessRoles\(\)\);\n\s+if \(!sales \|\| sales\.id !== data\.accessRoleId\) return \{ error: SHELL_ROLE_REJECTED \};/, "gán vai trò tuỳ chỉnh ở vỏ: chỉ đúng vai trò bán hàng");
  console.log("✓ Vai trò vỏ Chốt Đơn (thuần): đúng ba lựa chọn · thiếu BAN_HANG ⇒ hai + câu báo · nhận bằng mã, không bằng tên · ERP tám vai trò y nguyên · không quyền / mẫu nào đổi");
}

/* ═════════════ 4 · MÁY CHỦ ═════════════ */
// Cùng cách `tests/identity-email-login.test.ts`: kho ngữ cảnh của Next ngoài máy chủ Next là vỏ rỗng — gắn kho thật khi chạy,
// gỡ khi xong để bài khác không thấy khác biệt.
const NEXT_STORES = [workAsyncStorage, workUnitAsyncStorage] as unknown as Record<string, unknown>[];
const ALS_METHODS = ["run", "getStore", "exit", "enterWith", "disable"] as const;
function installRealStores() {
  for (const store of NEXT_STORES) {
    if (store instanceof AsyncLocalStorage || Object.prototype.hasOwnProperty.call(store, "run")) continue;
    const real = new AsyncLocalStorage<unknown>() as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const m of ALS_METHODS) store[m] = real[m].bind(real);
  }
}
function removeRealStores() {
  for (const store of NEXT_STORES) if (!(store instanceof AsyncLocalStorage)) for (const m of ALS_METHODS) delete store[m];
}

async function asAction<T>(token: string, fn: () => Promise<T>): Promise<T> {
  const jar = new ResponseCookies(new Headers());
  jar.set(SESSION_COOKIE, token);
  const workStore = { route: "/settings/users", page: "/settings/users", incrementalCache: {}, isStaticGeneration: false, forceStatic: false, dynamicShouldError: false, pendingRevalidatedTags: [] as string[] };
  const requestStore = {
    type: "request",
    phase: "action",
    implicitTags: { tags: [], expirationsByCacheKind: new Map() },
    url: { pathname: "/settings/users", search: "" },
    headers: new Headers({ "x-forwarded-for": "10.9.9.9", "x-erp-path": "/settings/users" }),
    cookies: new RequestCookies(new Headers()),
    mutableCookies: new ResponseCookies(new Headers()),
    userspaceMutableCookies: jar,
    draftMode: { isEnabled: false },
  };
  setSessionTokenSourceForTests(async () => token);
  try {
    return await workAsyncStorage.run(workStore as unknown as Parameters<typeof workAsyncStorage.run>[0], () =>
      workUnitAsyncStorage.run(requestStore as unknown as Parameters<typeof workUnitAsyncStorage.run>[0], fn),
    );
  } finally {
    setSessionTokenSourceForTests(null);
  }
}

function errorOf(r: unknown): string | null {
  return r && typeof r === "object" && "error" in r ? String((r as { error: unknown }).error) : null;
}

export async function testShellStaffRolesServer() {
  const dir = organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, "");
  rmSync(dir, { recursive: true, force: true });
  const pdb = await getPlatformDb();
  const homeInvite = `ssr-home-${Date.now()}@test.local`;
  let failure: unknown = null;
  installRealStores();
  try {
    const prov = await provisionOrganization({ code: ORG, name: "Shop vai trò vỏ", modules: SHELL_MODULES, admin: { email: "chu@ssr-shell.local", name: "Chủ shop", password: "Ssr-shell@12345" }, source: "TEST", actor: null, brand: "chotdon" });
    assert.equal(prov.created, true);
    const owner = await withOrganization(ORG, async () => (await getDb()).query.users.findFirst({ where: eq(schema.users.email, "chu@ssr-shell.local") }));
    assert.ok(owner);
    const token = await signSession({ id: owner.id, email: owner.email, name: owner.name, role: "ADMIN", orgCode: ORG });
    // Gói dùng thử giữ một ghế cho mỗi lời mời còn hạn — xoá lời mời đã đi qua để lượt sau không vấp hạn mức (bài này không đo nó).
    const clearInvites = () => withOrganization(ORG, async () => (await getDb()).delete(schema.userInvites));

    // ── Chưa cài BAN_HANG: mời bán hàng bị từ chối; vai trò hệ thống ngoài bộ bị từ chối; ADMIN / VIEWER đi qua ──
    assert.equal(errorOf(await asAction(token, () => createUserInviteAction({ email: "a@ssr.local", accessRoleCode: SHELL_SALES_STAFF_ROLE_CODE }))), SHELL_ROLE_REJECTED, "thiếu BAN_HANG ⇒ không mời được vai trò bán hàng");
    assert.equal(errorOf(await asAction(token, () => createUserInviteAction({ email: "b@ssr.local", role: "MANAGER" }))), SHELL_ROLE_REJECTED, "vỏ: mời «Quản lý» ⇒ từ chối");
    assert.equal(errorOf(await asAction(token, () => createUserInviteAction({ email: "c@ssr.local", role: "VIEWER" }))), null, "vỏ: mời «Chỉ xem» ⇒ đi qua");
    await clearInvites();

    // ── Cài BAN_HANG (đúng hình mẫu cài: mã = khoá viết HOA) + một vai trò khác MANG TÊN «Nhân viên bán hàng» ──
    const [ban, khac] = await withOrganization(ORG, async () => {
      const db = await getDb();
      const a = await db.insert(schema.accessRoles).values({ code: SHELL_SALES_STAFF_ROLE_CODE, name: "Nhân viên bán hàng", description: "", baseRole: "VIEWER", permissions: [...tmplPermissions()], defaultScope: "ALL", active: true }).returning({ id: schema.accessRoles.id });
      const b = await db.insert(schema.accessRoles).values({ code: "KHAC", name: "Nhân viên bán hàng", description: "", baseRole: "VIEWER", permissions: ["dashboard:view"], defaultScope: "ALL", active: true }).returning({ id: schema.accessRoles.id });
      return [a[0].id, b[0].id];
    });
    assert.equal(errorOf(await asAction(token, () => createUserInviteAction({ email: "d@ssr.local", accessRoleCode: SHELL_SALES_STAFF_ROLE_CODE }))), null, "đã cài ⇒ mời bán hàng đi qua");
    await clearInvites();
    assert.equal(errorOf(await asAction(token, () => createUserInviteAction({ email: "e@ssr.local", accessRoleCode: "KHAC" }))), SHELL_ROLE_REJECTED, "vai trò tuỳ chỉnh khác (dù trùng TÊN) ⇒ từ chối");

    // ── Tạo / sửa / gán ──
    assert.equal(errorOf(await asAction(token, () => createUser({ name: "Kho", email: "kho@ssr.local", password: "Kho-ssr@12345", role: "WAREHOUSE" }))), SHELL_ROLE_REJECTED, "vỏ: tạo «Kho» ⇒ từ chối");
    const created = await asAction(token, () => createUser({ name: "Lan", email: "lan@ssr.local", password: "Lan-ssr@12345", role: "VIEWER" }));
    assert.equal(errorOf(created), null, "vỏ: tạo «Chỉ xem» ⇒ đi qua");
    const lanId = (created as { id: string }).id;
    assert.equal(errorOf(await asAction(token, () => updateUser({ id: lanId, name: "Lan", role: "CS", active: true }))), SHELL_ROLE_REJECTED, "vỏ: sửa thành «CSKH» ⇒ từ chối");
    assert.equal(errorOf(await asAction(token, () => setUserAccess({ userId: lanId, accessRoleId: khac, positionId: "", scope: "ALL" }))), SHELL_ROLE_REJECTED, "vỏ: gán vai trò tuỳ chỉnh khác ⇒ từ chối");
    assert.equal(errorOf(await asAction(token, () => setUserAccess({ userId: lanId, accessRoleId: ban, positionId: "", scope: "ALL" }))), null, "vỏ: gán «Nhân viên bán hàng» ⇒ đi qua");
    const lan = await withOrganization(ORG, async () => (await getDb()).query.users.findFirst({ where: eq(schema.users.id, lanId), columns: { role: true, accessRoleId: true } }));
    assert.deepEqual(lan, { role: "VIEWER", accessRoleId: ban }, "Nhân viên bán hàng = VIEWER + vai trò mã BAN_HANG — không quyền nào mới");
    assert.equal(errorOf(await asAction(token, () => updateUser({ id: lanId, name: "Lan", role: "VIEWER", active: true }))), null, "vỏ: sửa tên giữ «Chỉ xem» ⇒ đi qua");

    // ── ERP / nhà KHÔNG ĐỔI: quản trị nhà mời «Quản lý» vẫn được ──
    const home = await getHomeOrganization();
    await (await getDb()).insert(schema.users).values({ id: HOME_ADMIN_ID, email: "admin@ssr-home.local", name: "Quản trị nhà (ssr)", passwordHash: "x", role: "ADMIN" });
    const homeToken = await signSession({ id: HOME_ADMIN_ID, email: "admin@ssr-home.local", name: "Quản trị nhà (ssr)", role: "ADMIN", orgCode: home.code });
    assert.equal(errorOf(await asAction(homeToken, () => createUserInviteAction({ email: homeInvite, role: "MANAGER" }))), null, "ERP: mời «Quản lý» vẫn đi qua");
  } catch (error) {
    failure = error;
  }
  try {
    setSessionTokenSourceForTests(null);
    removeRealStores();
    await (await getDb()).delete(schema.userInvites).where(inArray(schema.userInvites.email, [homeInvite]));
    await (await getDb()).delete(schema.users).where(eq(schema.users.id, HOME_ADMIN_ID));
    await pdb.update(schema.platformOrganizations).set({ status: "ARCHIVED" }).where(eq(schema.platformOrganizations.code, ORG));
    invalidateOrganizations();
    invalidateCapabilities(ORG);
    rmSync(dir, { recursive: true, force: true });
  } catch (cleanupError) {
    if (!failure) throw cleanupError;
    console.error("[shell-staff-roles] dọn dẹp cũng lỗi (lỗi chính ở dưới):", cleanupError);
  }
  if (failure) throw failure;
  console.log("✓ Vai trò vỏ Chốt Đơn (máy chủ): mời / tạo / sửa / gán ngoài bộ ba ⇒ { error } · thiếu BAN_HANG ⇒ không mời được bán hàng · vai trò trùng tên không lọt · nhà mời «Quản lý» như cũ");
}

function tmplPermissions(): string[] {
  return AI_SALES_BLUEPRINT.roles?.find((r) => r.key.toUpperCase() === SHELL_SALES_STAFF_ROLE_CODE)?.permissions ?? [];
}

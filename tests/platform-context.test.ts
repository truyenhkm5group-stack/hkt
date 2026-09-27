/**
 * NỀN TẢNG ĐA TỔ CHỨC — ngữ cảnh tổ chức, định tuyến CSDL, cấp tổ chức (docs/platform/shared-contracts.md
 * mục 3, 4, 12). Chạy trên PGlite: tổ chức nhà là CSDL của bộ kiểm thử, tổ chức thứ hai là một CSDL
 * PGlite THẬT khác (thư mục `<thư mục kiểm thử>-org-<mã>`), không phải một bản giả.
 *
 * Tự dọn: tổ chức mang tiền tố `pt-`, thư mục của nó xoá trước và sau.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { getDb, getDbFor, getPlatformDb, organizationDatabaseUrl, pgliteDataDir, schema } from "@/db";
import { env } from "@/lib/env";
import { currentOrganization, OrgContextError, peekOrganization, setSessionTokenSourceForTests, withOrganization } from "@/lib/platform/context";
import { findOrganization, getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { GET as healthGet } from "@/app/api/health/route";

const B = "pt-beta";

async function token(claims: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setSubject("u-test").setIssuedAt(now).setExpirationTime(now + 600).sign(new TextEncoder().encode(env.authSecret));
}

async function readSetting(key: string) {
  const db = await getDb();
  const row = await db.query.settings.findFirst({ where: eq(schema.settings.key, key) });
  return row?.value ?? null;
}

async function writeSetting(key: string, value: string) {
  const db = await getDb();
  await db.insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });
}

function dirOf(code: string) {
  const url = organizationDatabaseUrl({ code, isHome: false });
  return url.replace(/^pglite:\/\//, "");
}

export async function testPlatformContext() {
  const dir = dirOf(B);
  rmSync(dir, { recursive: true, force: true });

  // ── 1. Tổ chức nhà: migration 0152 đã tạo đúng MỘT dòng nhà, `module_default = ENABLED` ──
  const home = await getHomeOrganization();
  assert.equal(home.code, "vnx", "migration 0152 chèn tổ chức nhà mã vnx");
  assert.equal(home.isHome, true);
  assert.equal(home.moduleDefault, "ENABLED", "tổ chức nhà: dòng module thiếu = BẬT (hành vi y như trước nền tảng)");
  const noCtx = await currentOrganization();
  assert.equal(noCtx.isHome, true, "không ngữ cảnh, không phiên ⇒ tổ chức nhà");
  assert.equal(noCtx.source, "HOME_DEFAULT");
  assert.equal(peekOrganization(), null);
  assert.equal(organizationDatabaseUrl({ code: B, isHome: false }), `pglite://${pgliteDataDir()}-org-${B}`, "CSDL tổ chức dẫn xuất từ mã");

  // ── 2. Cấp tổ chức thứ hai: dòng + CSDL riêng + migration + module tường minh + quản trị ──
  const prov = await provisionOrganization({
    code: B,
    name: "Bán buôn thử nghiệm",
    templateKey: "wholesale",
    modules: ["customers", "products", "orders"],
    admin: { email: "admin@pt-beta.local", name: "Quản trị Beta", password: "Beta@12345" },
    source: "TEST",
    actor: null,
  });
  assert.equal(prov.created, true);
  assert.equal(prov.adminCreated, true);
  assert.equal(prov.organization.moduleDefault, "DISABLED", "tổ chức mới: dòng module thiếu = TẮT");
  const again = await provisionOrganization({ code: B, name: "x", modules: ["customers", "products", "orders"], admin: { email: "admin@pt-beta.local", name: "x", password: "x" }, source: "TEST", actor: null });
  assert.equal(again.created, false, "cấp lại là idempotent — không nhân đôi tổ chức");
  assert.equal(again.adminCreated, false, "không nhân đôi tài khoản quản trị");
  const pdb = await getPlatformDb();
  const modRows = await pdb.select().from(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, prov.organization.id));
  assert.deepEqual(modRows.map((r) => r.moduleKey).sort(), ["customers", "orders", "products"], "module bật tường minh, không nhân đôi");
  const audits = await pdb.select().from(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, B));
  assert.equal(audits.filter((a) => a.action === "ORG_CREATE").length, 1, "đúng một vết ORG_CREATE");
  assert.equal(audits.filter((a) => a.action === "MODULE_ENABLE").length, 3, "mỗi module bật một vết");

  // ── 3. Định tuyến CSDL: cùng khoá settings, hai CSDL, hai giá trị ──
  await writeSetting("pt:probe", "nha");
  await withOrganization(B, async () => {
    assert.equal(peekOrganization()?.code, B);
    assert.equal(await readSetting("pt:probe"), null, "CSDL tổ chức B KHÔNG thấy dòng của nhà");
    await writeSetting("pt:probe", "beta");
    assert.equal(await readSetting("pt:probe"), "beta");
    // Lồng: ngữ cảnh trong cùng thắng.
    await withOrganization(home.code, async () => assert.equal(await readSetting("pt:probe"), "nha"));
    assert.equal(await readSetting("pt:probe"), "beta", "ra khỏi ngữ cảnh lồng thì về lại B");
  });
  assert.equal(await readSetting("pt:probe"), "nha", "CSDL nhà không bị ghi đè bởi B");

  // Tài khoản quản trị của B nằm trong CSDL B, không trong CSDL nhà.
  const homeDb = await getPlatformDb();
  assert.equal(await homeDb.query.users.findFirst({ where: eq(schema.users.email, "admin@pt-beta.local") }), undefined, "quản trị B không có trong CSDL nhà");
  const bDb = await getDbFor(prov.organization);
  assert.ok(await bDb.query.users.findFirst({ where: eq(schema.users.email, "admin@pt-beta.local") }), "quản trị B có trong CSDL B");

  // Bản sao mặt phẳng điều khiển trong CSDL B phải RỖNG (migration 0152 chèn dòng nhà rồi được dọn).
  for (const table of ["platform_organizations", "platform_organization_modules", "platform_flag_overrides", "platform_audit_log"]) {
    const r = await bDb.execute(sql.raw(`select count(*)::int as n from ${table}`));
    const rows = (r as unknown as { rows: { n: number }[] }).rows;
    assert.equal(rows[0].n, 0, `${table} trong CSDL tổ chức B phải rỗng`);
  }

  // ── 4. Phiên: claim `org` quyết định CSDL; token cũ ⇒ nhà; claim lạ ⇒ NÉM, không rơi về nhà ──
  try {
    setSessionTokenSourceForTests(async () => token({ email: "a@b", org: B }));
    const ctx = await currentOrganization();
    assert.equal(ctx.code, B);
    assert.equal(ctx.source, "SESSION");
    assert.equal(await readSetting("pt:probe"), "beta", "request mang phiên tổ chức B đọc CSDL B");

    setSessionTokenSourceForTests(async () => token({ email: "a@b" }));
    const legacy = await currentOrganization();
    assert.equal(legacy.isHome, true, "token cũ không claim ⇒ nhà");
    assert.equal(legacy.source, "LEGACY_SESSION");

    setSessionTokenSourceForTests(async () => token({ email: "a@b", org: "pt-khong-ton-tai" }));
    await assert.rejects(() => getDb(), (e: unknown) => e instanceof OrgContextError && e.code === "ORG_UNKNOWN", "claim trỏ tổ chức không tồn tại ⇒ ném, KHÔNG rơi về nhà");

    // Chữ ký giả ⇒ coi như không có phiên (middleware đã chặn trang cần đăng nhập).
    setSessionTokenSourceForTests(async () => {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ org: B }).setProtectedHeader({ alg: "HS256" }).setIssuedAt(now).setExpirationTime(now + 600).sign(new TextEncoder().encode("khoa-gia-mao-khoa-gia-mao-khoa-gia-mao"));
    });
    const forged = await currentOrganization();
    assert.equal(forged.source, "HOME_DEFAULT", "token ký sai khoá không bao giờ mở CSDL của B");

    // Ngữ cảnh tường minh thắng phiên (job chạy trong một request vẫn đúng tổ chức của job).
    setSessionTokenSourceForTests(async () => token({ email: "a@b", org: B }));
    await withOrganization(home.code, async () => assert.equal(await readSetting("pt:probe"), "nha"));
  } finally {
    setSessionTokenSourceForTests(null);
  }

  // ── 5. Tổ chức bị đình chỉ: không mở được ngữ cảnh, phiên của họ bị từ chối ──
  await pdb.update(schema.platformOrganizations).set({ status: "SUSPENDED" }).where(eq(schema.platformOrganizations.code, B));
  invalidateOrganizations();
  await assert.rejects(() => withOrganization(B, async () => 1), (e: unknown) => e instanceof OrgContextError && e.code === "ORG_INACTIVE");
  try {
    setSessionTokenSourceForTests(async () => token({ email: "a@b", org: B }));
    await assert.rejects(() => getDb(), (e: unknown) => e instanceof OrgContextError && e.code === "ORG_INACTIVE", "phiên của tổ chức bị đình chỉ bị từ chối");
  } finally {
    setSessionTokenSourceForTests(null);
  }
  await pdb.update(schema.platformOrganizations).set({ status: "ACTIVE" }).where(eq(schema.platformOrganizations.code, B));
  invalidateOrganizations();
  assert.equal((await findOrganization(B))?.status, "ACTIVE");
  await assert.rejects(() => withOrganization("pt-khong-ton-tai", async () => 1), (e: unknown) => e instanceof OrgContextError && e.code === "ORG_UNKNOWN");

  // Không cấp lại được tổ chức nhà.
  await assert.rejects(() => provisionOrganization({ code: home.code, name: "x", modules: [], source: "TEST", actor: null }), /tổ chức nhà/);

  await withOrganization(home.code, async () => writeSetting("pt:probe", "nha"));
  const homeDbAgain = await getPlatformDb();
  await homeDbAgain.delete(schema.settings).where(eq(schema.settings.key, "pt:probe"));
  // `/api/health` (công khai) nói về tổ chức nhà bằng CỜ, không in mã / số lượng tổ chức nào — dù lúc
  // này đang có thêm tổ chức `pt-` trong sổ.
  const health = (await (await healthGet()).json()) as { ok: boolean; platform: Record<string, unknown> };
  assert.equal(health.ok, true);
  assert.equal(health.platform.ok, true, "health: mặt phẳng điều khiển + tổ chức nhà + đủ module");
  assert.equal(health.platform.homeResolved, true);
  const [bat, tong] = String(health.platform.homeModules).split("/");
  assert.ok(Number(tong) > 0 && bat === tong, "tổ chức nhà bật ĐỦ mọi module");
  assert.equal(JSON.stringify(health).includes(B), false, "health công khai KHÔNG lộ mã tổ chức khác");
  console.log("✓ Nền tảng · ngữ cảnh tổ chức: hai CSDL cô lập, claim lạ/giả/đình chỉ không rơi về nhà, cấp tổ chức idempotent");
}

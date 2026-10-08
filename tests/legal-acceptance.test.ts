/**
 * SỔ CHẤP THUẬN VĂN BẢN PHÁP LÝ (M-ACCEPT · 0236 · lib/legal/acceptance.ts).
 *
 *  1. THUẦN — băm email là HMAC 64 hex, không chứa email, không trùng sha256 trần; UA cắt độ dài + bỏ ký tự điều khiển;
 *     phiên bản lấy đúng hằng đang công bố, băm nội dung CHƯA BIẾT là `null` (không bịa từ số phiên bản).
 *  2. MÃ NGUỒN — mỗi chỗ ghi (`LEGAL_CONSENT_SURFACES`) trỏ tới tệp giao diện CÓ dòng đồng ý thật; chỉ lõi tạo tổ chức gọi
 *     đường ghi; đường KHÔNG có dòng đồng ý (đặt mật khẩu qua liên kết · /join) không mang câu đồng ý và không chạm sổ.
 *  3. CSDL THẬT (PGlite) — đăng ký nhanh ⇒ đúng 2 dòng TERMS + PRIVACY, đúng phiên bản / băm, khoá tài khoản, không email /
 *     IP thô; gọi lại không nhân đôi; sổ hỏng ⇒ đăng ký VẪN thành công và log không mang dữ liệu người; lõi tạo tổ chức
 *     không được nêu chỗ đồng ý ⇒ 0 dòng; người vận hành tạo hộ (kể cả có nêu chỗ đồng ý) ⇒ 0 dòng; CHECK từ chối giá trị lạ;
 *     chỉ người vận hành nền tảng đọc được sổ.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { eq, inArray, or, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { PRIVACY_POLICY, TERMS_OF_SERVICE } from "@/lib/constants/company";
import {
  LEGAL_ACCEPTANCE_ACTIONS,
  LEGAL_CONSENT_SURFACES,
  LEGAL_DOCUMENTS,
  USER_AGENT_MAX,
  legalEmailHash,
  listAcceptances,
  recordSignupAcceptance,
  setLegalAcceptanceFaultForTests,
  signupDocuments,
  trimUserAgent,
} from "@/lib/legal/acceptance";
import { quickSignup } from "@/lib/onboarding/quick";
import { orgCodeBase } from "@/lib/onboarding/quick-shared";
import { hashIp } from "@/lib/onboarding/rate";
import { createOrganizationFromSignup, type SignupActor } from "@/lib/onboarding/service";
import { invalidateSignupSetting, SIGNUP_MODE_SETTING_KEY } from "@/lib/onboarding/signup-mode";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";

const NAME_QUICK = "LA Nhanh";
const NAME_FAULT = "LA Hong So";
const CODE_QUICK = orgCodeBase(NAME_QUICK);
const CODE_FAULT = orgCodeBase(NAME_FAULT);
const CODE_WIZARD = "la-wizard";
const CODE_OPERATOR = "la-van-hanh";
const ORGS = [CODE_QUICK, `${CODE_QUICK}-2`, CODE_FAULT, `${CODE_FAULT}-2`, CODE_WIZARD, CODE_OPERATOR] as const;
const IPS = ["203.0.113.141", "203.0.113.142", "203.0.113.143"] as const;
const EMAIL_QUICK = "chu@la-nhanh.vn";
const EMAIL_FAULT = "chu@la-hong-so.vn";
const PW = "MatKhau@2026";
const UA = `Mozilla/5.0 (LA-test)\n${"x".repeat(400)}`;

// ═══════════ 1 · THUẦN ═══════════

function testPure() {
  const h = legalEmailHash(" Chu@LA-Nhanh.VN ");
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, legalEmailHash(EMAIL_QUICK), "chuẩn hoá chữ thường + khoảng trắng trước khi băm");
  assert.notEqual(h, createHash("sha256").update(EMAIL_QUICK).digest("hex"), "HMAC có khoá, không phải sha256 trần (dò từ điển được)");
  assert.notEqual(h, legalEmailHash("khac@la-nhanh.vn"));
  assert.ok(!h.includes("chu") && !h.includes("@"));

  const ua = trimUserAgent(UA);
  assert.ok(ua && ua.length === USER_AGENT_MAX, "UA cắt đúng trần");
  assert.ok(!/[\n\r\t]/.test(ua!), "UA không mang ký tự điều khiển");
  assert.equal(trimUserAgent(null), null);
  assert.equal(trimUserAgent("   "), null, "UA rỗng ⇒ CHƯA BIẾT, không phải chuỗi rỗng");

  const docs = signupDocuments();
  assert.deepEqual(
    docs.map((d) => [d.document, d.version]),
    [
      ["TERMS", TERMS_OF_SERVICE.version],
      ["PRIVACY", PRIVACY_POLICY.version],
    ],
    "dòng đồng ý ở /start dẫn chiếu đúng Điều khoản + Chính sách ở phiên bản đang công bố",
  );
  for (const d of docs) assert.ok(d.contentSha256 === null || /^[0-9a-f]{64}$/.test(d.contentSha256), "băm nội dung: 64 hex hoặc CHƯA BIẾT");
  assert.deepEqual([...LEGAL_DOCUMENTS], ["TERMS", "PRIVACY", "DPA"]);
  assert.deepEqual([...LEGAL_ACCEPTANCE_ACTIONS], ["SIGNUP", "INVITE_ACCEPT", "NOTICE_SEEN"]);
}

// ═══════════ 2 · MÃ NGUỒN ═══════════

function testSource() {
  // Mỗi chỗ ghi phải là một màn hình CÓ dòng đồng ý thật, dẫn chiếu đúng hai văn bản.
  for (const [surface, file] of Object.entries(LEGAL_CONSENT_SURFACES)) {
    const src = readFileSync(file, "utf8");
    assert.ok(src.includes("bạn đồng ý với"), `${surface}: ${file} không còn dòng «bạn đồng ý với» — không được ghi chấp thuận cho màn hình đó`);
    assert.ok(src.includes("TERMS_OF_SERVICE.path") && src.includes("PRIVACY_POLICY.path"), `${surface}: dòng đồng ý phải dẫn tới Điều khoản + Chính sách`);
  }
  // Danh sách đóng trong mã khớp CHECK của migration.
  const mig = readFileSync("drizzle/0236_legal_acceptances.sql", "utf8");
  assert.ok(mig.includes(`IN (${Object.keys(LEGAL_CONSENT_SURFACES).map((s) => `'${s}'`).join(",")})`), "CHECK source = đúng LEGAL_CONSENT_SURFACES");
  assert.ok(mig.includes(`IN (${LEGAL_DOCUMENTS.map((s) => `'${s}'`).join(",")})`) && mig.includes(`IN (${LEGAL_ACCEPTANCE_ACTIONS.map((s) => `'${s}'`).join(",")})`));
  assert.ok(!/\bINSERT\b|\bUPDATE\b/i.test(mig.replace(/^--.*$/gm, "")), "migration không backfill (AGENTS 35)");

  // Đường KHÔNG có dòng đồng ý: không câu đồng ý trên giao diện ⇒ không được có đường ghi.
  for (const f of ["app/reset/[org]/[token]/reset-form.tsx", "app/reset/[org]/[token]/page.tsx", "app/join/[org]/[token]/join-form.tsx", "app/join/[org]/[token]/page.tsx"]) {
    assert.ok(!readFileSync(f, "utf8").includes("bạn đồng ý"), `${f} có dòng đồng ý — cập nhật LEGAL_CONSENT_SURFACES + tài liệu chỗ hở trước khi ghi sổ ở đó`);
  }

  // Chỉ lõi tạo tổ chức gọi đường ghi; chỉ hai cửa vào /start nêu chỗ đồng ý; chỉ lib/legal chạm bảng.
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.ts", "*.tsx"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !f.startsWith("tests/") && !f.startsWith("node_modules/"));
  const who = (needle: string | RegExp) => files.filter((f) => (typeof needle === "string" ? readFileSync(f, "utf8").includes(needle) : needle.test(readFileSync(f, "utf8")))).sort();
  assert.deepEqual(who("recordSignupAcceptance("), ["lib/legal/acceptance.ts", "lib/onboarding/service.ts"], "chỉ lõi tạo tổ chức ghi sổ chấp thuận");
  assert.deepEqual(who("platformLegalAcceptances"), ["db/schema.ts", "lib/legal/acceptance.ts"], "chỉ lib/legal/acceptance.ts đọc / ghi bảng");
  assert.deepEqual(who(/surface: "START_(WIZARD|QUICK)"/), ["lib/actions/onboarding.ts", "lib/onboarding/quick.ts"], "chỉ hai cửa vào /start (có dòng đồng ý) nêu chỗ đồng ý");
  const action = readFileSync("lib/actions/onboarding.ts", "utf8");
  assert.ok(/who\.kind === "public" \? \{[^}]*consent: \{ surface: "START_WIZARD"/.test(action), "trình hướng dẫn chỉ nêu chỗ đồng ý cho KHÁCH, người vận hành tạo hộ thì không");
}

// ═══════════ 3 · CSDL THẬT ═══════════

async function rowsOf(codes: readonly string[]) {
  const pdb = await getPlatformDb();
  return pdb.select().from(schema.platformLegalAcceptances).where(inArray(schema.platformLegalAcceptances.orgCode, [...codes]));
}

async function cleanup() {
  const pdb = await getPlatformDb();
  for (const code of ORGS) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
  }
  await pdb.delete(schema.platformLegalAcceptances).where(inArray(schema.platformLegalAcceptances.orgCode, [...ORGS]));
  await pdb.delete(schema.platformIdentities).where(inArray(schema.platformIdentities.orgCode, [...ORGS]));
  await pdb.delete(schema.platformSignupAttempts).where(or(inArray(schema.platformSignupAttempts.organizationCode, [...ORGS]), inArray(schema.platformSignupAttempts.ipHash, IPS.map(hashIp))));
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [...ORGS]));
  await pdb.delete(schema.platformSubscriptions).where(inArray(schema.platformSubscriptions.orgCode, [...ORGS]));
  await pdb.delete(schema.platformProductSubscriptions).where(inArray(schema.platformProductSubscriptions.orgCode, [...ORGS]));
  invalidateOrganizations();
  invalidateCapabilities();
}

async function withOpenSignup<T>(fn: () => Promise<T>): Promise<T> {
  const pdb = await getPlatformDb();
  const envBefore = process.env.PLATFORM_SIGNUP_MODE;
  const row = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, SIGNUP_MODE_SETTING_KEY) });
  process.env.PLATFORM_SIGNUP_MODE = "open";
  await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, SIGNUP_MODE_SETTING_KEY));
  await pdb.insert(schema.platformSettings).values({ key: SIGNUP_MODE_SETTING_KEY, value: "open", updatedByEmail: "la-test@local" });
  invalidateSignupSetting();
  try {
    return await fn();
  } finally {
    if (envBefore === undefined) delete process.env.PLATFORM_SIGNUP_MODE;
    else process.env.PLATFORM_SIGNUP_MODE = envBefore;
    await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, SIGNUP_MODE_SETTING_KEY));
    if (row) await pdb.insert(schema.platformSettings).values({ key: row.key, value: row.value, updatedByEmail: row.updatedByEmail });
    invalidateSignupSetting();
  }
}

const blankDraft = (code: string, email: string) => ({
  invite: null,
  org: { name: `LA ${code}`, code },
  admin: { name: "Chủ LA", email, password: PW },
  plan: { businessType: "blank" as const, templateKey: null, modules: [] as string[] },
  planKey: null,
});

async function testSignupWritesTwoRows() {
  const who: SignupActor = { kind: "public", ip: IPS[0] };
  const r = await quickSignup({ storeName: NAME_QUICK, businessType: "food", phone: "0912 345 141", email: EMAIL_QUICK, password: PW }, who, { userAgent: UA });
  assert.ok("ok" in r, JSON.stringify(r));
  assert.equal(r.orgCode, CODE_QUICK);

  const rows = await rowsOf([CODE_QUICK]);
  assert.equal(rows.length, 2, "đăng ký qua /start ⇒ ĐÚNG hai dòng");
  const docs = signupDocuments();
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, CODE_QUICK) });
  const admin = await withOrganization(CODE_QUICK, async () => (await getDb()).query.users.findFirst({ where: eq(schema.users.email, EMAIL_QUICK) }));
  assert.ok(org && admin);
  for (const d of docs) {
    const row = rows.find((x) => x.document === d.document);
    assert.ok(row, `thiếu dòng ${d.document}`);
    assert.equal(row.version, d.version, `${d.document}: đúng phiên bản đang công bố`);
    assert.equal(row.contentSha256, d.contentSha256, `${d.document}: đúng băm nội dung của nguồn phiên bản`);
    assert.equal(row.action, "SIGNUP");
    assert.equal(row.source, "START_QUICK");
    assert.equal(row.userId, admin.id, "khoá tài khoản quản trị (AGENTS 3.34), không ô chữ");
    assert.equal(row.organizationId, org.id);
    assert.equal(row.accountId, org.accountId ?? null);
    assert.equal(row.emailHash, legalEmailHash(EMAIL_QUICK));
    assert.equal(row.ipHash, hashIp(IPS[0]), "IP băm cùng phép với trần đăng ký");
    assert.equal(row.userAgent, trimUserAgent(UA));
    assert.ok(Date.now() - row.acceptedAt.getTime() < 10 * 60_000);
  }
  const dump = JSON.stringify(rows);
  for (const raw of [EMAIL_QUICK, "chu@la-nhanh", IPS[0], "84912345141"]) assert.ok(!dump.includes(raw), `sổ chấp thuận mang dữ liệu thô: ${raw}`);

  // Gọi lại cùng tổ chức / phiên bản (chạy lại sau hỏng, gửi lại) ⇒ không nhân đôi.
  const again = await recordSignupAcceptance({ orgCode: CODE_QUICK, userId: admin.id, email: EMAIL_QUICK, ipHash: hashIp(IPS[0]), userAgent: UA, surface: "START_QUICK", documents: docs });
  assert.equal(again, 0);
  assert.equal((await rowsOf([CODE_QUICK])).length, 2, "idempotent theo (tổ chức, văn bản, phiên bản)");
}

async function testFaultDoesNotBreakSignup() {
  const warns: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warns.push(args.map(String).join(" "));
  setLegalAcceptanceFaultForTests(() => {
    throw new Error("sổ chấp thuận hỏng (giả lập)");
  });
  try {
    const r = await quickSignup({ storeName: NAME_FAULT, businessType: "food", phone: "0912 345 142", email: EMAIL_FAULT, password: PW }, { kind: "public", ip: IPS[1] }, { userAgent: "LA-UA-fault" });
    assert.ok("ok" in r, `sổ hỏng KHÔNG được làm hỏng đăng ký: ${JSON.stringify(r)}`);
    assert.equal(r.orgCode, CODE_FAULT);
  } finally {
    setLegalAcceptanceFaultForTests(null);
    console.warn = warn;
  }
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, CODE_FAULT) });
  assert.equal(org?.status, "ACTIVE", "tổ chức dựng xong bình thường");
  assert.equal((await rowsOf([CODE_FAULT])).length, 0);
  const legal = warns.filter((w) => w.includes("[legal]"));
  assert.equal(legal.length, 1, "sổ hỏng ⇒ đúng một cảnh báo");
  for (const raw of [EMAIL_FAULT, IPS[1], "LA-UA-fault"]) assert.ok(!legal[0]!.includes(raw), `log mang dữ liệu người: ${raw}`);
}

async function testNoConsentNoRow() {
  // Lõi tạo tổ chức được gọi KHÔNG nêu chỗ đồng ý (một đường gọi không có dòng đồng ý trên giao diện) ⇒ 0 dòng.
  const r = await createOrganizationFromSignup(blankDraft(CODE_WIZARD, "chu@la-wizard.vn"), { kind: "public", ip: IPS[2] });
  assert.ok("ok" in r, JSON.stringify(r));
  assert.equal((await rowsOf([CODE_WIZARD])).length, 0, "không có dòng đồng ý ⇒ không bịa chấp thuận");

  // Người vận hành tạo hộ — kể cả có nêu chỗ đồng ý — KHÔNG phải khách đồng ý ⇒ 0 dòng.
  const home = await getHomeOrganization();
  const op: SignupActor = { kind: "operator", ip: IPS[2], actor: { orgCode: home.code, userId: "la-op", email: "op@nha.local" } };
  const r2 = await createOrganizationFromSignup(blankDraft(CODE_OPERATOR, "chu@la-van-hanh.vn"), op, { consent: { surface: "START_WIZARD", userAgent: UA } });
  assert.ok("ok" in r2, JSON.stringify(r2));
  assert.equal((await rowsOf([CODE_OPERATOR])).length, 0, "người vận hành tạo hộ ⇒ khách chưa thấy dòng đồng ý ⇒ 0 dòng");
}

async function testChecks() {
  const pdb = await getPlatformDb();
  const base = { orgCode: CODE_QUICK, document: "TERMS", version: "1.1", action: "NOTICE_SEEN", source: "START_QUICK" };
  const bad: [string, Record<string, unknown>][] = [
    ["văn bản lạ", { document: "EULA" }],
    ["hành động lạ", { action: "CLICKED" }],
    ["chỗ đồng ý lạ", { source: "RESET_LINK" }],
    ["băm nội dung không phải 64 hex", { contentSha256: "abc" }],
    ["băm nội dung chữ hoa", { contentSha256: "A".repeat(64) }],
    ["email thô thay cho băm", { emailHash: EMAIL_QUICK }],
    ["IP thô thay cho băm", { ipHash: IPS[0] }],
    ["UA quá dài", { userAgent: "x".repeat(USER_AGENT_MAX + 1) }],
    ["phiên bản rỗng", { version: "" }],
  ];
  for (const [label, patch] of bad) {
    await assert.rejects(
      pdb.execute(
        // Ghi thô (không qua kiểu của drizzle) — chứng minh CSDL tự chặn, không chỉ TypeScript.
        sql`insert into platform_legal_acceptances (id, org_code, document, version, action, source, content_sha256, email_hash, ip_hash, user_agent)
          values (${`la-bad-${label}`}, ${base.orgCode}, ${String(patch.document ?? base.document)}, ${String(patch.version ?? base.version)}, ${String(patch.action ?? base.action)}, ${String(patch.source ?? base.source)},
                  ${(patch.contentSha256 as string | undefined) ?? null}, ${(patch.emailHash as string | undefined) ?? null}, ${(patch.ipHash as string | undefined) ?? null}, ${(patch.userAgent as string | undefined) ?? null})`,
      ),
      `CHECK phải từ chối: ${label}`,
    );
  }
  // Giá trị hợp lệ đi qua (đối chứng — các ca trên đỏ vì đúng vế đó, không vì câu lệnh hỏng).
  await pdb.execute(sql`insert into platform_legal_acceptances (id, org_code, document, version, action, source, content_sha256) values ('la-ok', ${CODE_QUICK}, 'DPA', '1.0', 'NOTICE_SEEN', 'START_QUICK', ${"a".repeat(64)})`);
  await pdb.delete(schema.platformLegalAcceptances).where(eq(schema.platformLegalAcceptances.id, "la-ok"));
}

async function testOperatorOnlyRead() {
  const home = await getHomeOrganization();
  const u = (over: Partial<SessionUser>): SessionUser => ({ id: "la-u", email: "la@local", name: "LA", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, ...over });
  const tenantAdmin = u({ organization: { code: CODE_QUICK, name: NAME_QUICK, isHome: false } });
  const homeViewer = u({ role: "VIEWER", organization: { code: home.code, name: home.name, isHome: true } });
  const operator = u({ organization: { code: home.code, name: home.name, isHome: true } });
  assert.ok("error" in (await listAcceptances(tenantAdmin, CODE_QUICK)), "quản trị của chính tổ chức khách KHÔNG đọc sổ nền tảng");
  assert.ok("error" in (await listAcceptances(homeViewer, CODE_QUICK)), "người nhà không có platform:operate ⇒ không đọc");
  const ok = await listAcceptances(operator, CODE_QUICK);
  assert.ok("ok" in ok, JSON.stringify(ok));
  assert.equal(ok.rows.length, 2);
  assert.ok(ok.rows.every((r) => r.currentWorkspace), "dòng của đời tổ chức hiện tại");
  assert.ok(!JSON.stringify(ok.rows).includes(legalEmailHash(EMAIL_QUICK)), "bản đọc của người vận hành không trả băm email");
}

export async function testLegalAcceptance() {
  testPure();
  testSource();
  await cleanup();
  for (const code of ORGS) rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  try {
    await withOpenSignup(async () => {
      await testSignupWritesTwoRows();
      await testFaultDoesNotBreakSignup();
      await testNoConsentNoRow();
    });
    await testChecks();
    await testOperatorOnlyRead();
  } finally {
    setLegalAcceptanceFaultForTests(null);
    await cleanup();
  }
  console.log("✓ Sổ chấp thuận: đăng ký qua /start ⇒ đúng 2 dòng TERMS + PRIVACY ở phiên bản đang công bố, khoá tài khoản, email HMAC / IP băm / UA cắt, không nhân đôi; sổ hỏng không làm hỏng đăng ký và log không mang dữ liệu người; không dòng đồng ý hoặc người vận hành tạo hộ ⇒ 0 dòng; CHECK chặn văn bản / hành động / chỗ / băm lạ; chỉ người vận hành nền tảng đọc được");
}

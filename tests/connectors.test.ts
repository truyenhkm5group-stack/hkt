/**
 * PHASE 9 · SỔ CONNECTOR + KẾT NỐI THEO TỔ CHỨC (docs/platform/phase-9-contracts.md §1–3).
 *
 *  · SỔ ↔ MÃ (thuần): mỗi tệp dưới `lib/integrations/` thuộc ĐÚNG MỘT connector (hoặc là helper có lý do), mỗi
 *    route `app/api/webhooks/**` có mục khai và chế độ phân giải khớp `WEBHOOK_BINDINGS`, `healthRef` trỏ hàm có
 *    thật, mọi biến credential của nhà (`CUSTOMER_CREDENTIAL_ENV`) có chủ trong sổ, năng lực thuộc tập đóng.
 *  · MÃ HOÁ (thuần): vòng tròn; nonce ngẫu nhiên; AAD — bản mã của tổ chức A / connector X không giải được ở B / Y;
 *    sửa một byte ⇒ hỏng; khoá đổi ⇒ câu "khoá khác"; THIẾU / NGẮN `PLATFORM_SECRETS_KEY` ⇒ từ chối, không lùi về
 *    `AUTH_SECRET`.
 *  · KIỂM TRA (thuần, máy chủ giả): chỉ gọi đúng máy chủ Lark / api.telegram.org, không theo chuyển hướng, câu lỗi
 *    không mang bí mật.
 *  · HAI TỔ CHỨC THẬT (`pc-a`, `pc-b` — tự cấp, tự dọn): lưu → kiểm tra → bật qua ĐÚNG hàm server action gọi; thiếu
 *    khoá ⇒ từ chối lưu; B không thấy kết nối của A, bản mã của A chép sang B không giải được; tổ chức nhà thấy
 *    connector HOME_ONLY CHỈ ĐỌC, không một giá trị bí mật nào, và CSDL nhà không đổi một dòng.
 *  · QUÉT MÃ: chỉ service giải mã; action / trang / client không chạm bản mã; AI không import connector; không log.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import {
  CAPABILITIES_BY_KIND,
  CONNECTORS,
  INTEGRATION_HELPERS,
  findConnector,
  isOrgConfigurable,
  maskSecret,
  type ConnectorSpec,
} from "@/lib/connectors/registry";
import { SecretsDecryptError, SecretsUnavailableError, openSecrets, sealSecrets, secretsKeyState } from "@/lib/connectors/secrets";
import { loadConnectionsView, saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { LARK_HOOK_PATTERN, ORG_CONNECTION_TESTERS, TELEGRAM_CHAT_PATTERN, TELEGRAM_TOKEN_PATTERN, testLarkWebhook, testTelegramBot } from "@/lib/connectors/testers";
import type { ConnectionsView } from "@/lib/connectors/types";
import { MODULE_KEYS } from "@/lib/constants/platform-modules";
import { CUSTOMER_CREDENTIAL_ENV } from "@/lib/env";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { currentOrganization, withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { WEBHOOK_BINDINGS } from "@/lib/platform/webhooks";

const goc = path.resolve(__dirname, "..");
const A = "pc-a";
const B = "pc-b";
const MASTER = "khoa-thu-nghiem-chi-de-kiem-thu-0123456789abcdef";
const MASTER_2 = "mot-khoa-khac-hoan-toan-cung-du-dai-0123456789zz";
const LARK_URL = "https://open.larksuite.com/open-apis/bot/v2/hook/aaaa1111-bbbb-2222-cccc-3333dddd4444";
const LARK_SIGN = "ky-lark-bi-mat-cua-to-chuc-a-9f8e7d";
const TG_TOKEN = "1234567890:AAH-bi-mat-telegram-cua-to-chuc-a_xyz0";

function chuan(p: string): string {
  return p.split(path.sep).join("/").split("\\").join("/");
}

function boChuThich(ma: string): string {
  return ma.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Tệp đã vào kho HOẶC đang được thêm (chưa commit) — bài quét phải thấy cả mã của chính lượt này. */
function tepKho(): string[] {
  return execSync("git ls-files --cached --others --exclude-standard", { cwd: goc, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .map((l) => chuan(l.trim()))
    .filter((t) => t && existsSync(path.join(goc, t)));
}

function doc(tep: string): string {
  return readFileSync(path.join(goc, tep), "utf8");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path.join(goc, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

/* ═════════════ 1 · SỔ ↔ MÃ ═════════════ */

function covers(spec: ConnectorSpec, file: string): boolean {
  return spec.code.some((c) => (c.endsWith("/") ? file.startsWith(c) : file === c));
}

export function testRegistryMatchesCode(): { perKind: Record<string, number>; homeOnly: number; perOrg: number } {
  const keys = CONNECTORS.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length, "khoá connector phải duy nhất");
  for (const c of CONNECTORS) {
    assert.match(c.key, /^[a-z][a-z0-9-]{1,60}$/, `${c.key}: khoá phải khớp ràng buộc org_connections_key_check`);
    const allowed = CAPABILITIES_BY_KIND[c.kind] as readonly string[];
    for (const cap of c.capabilities) assert.ok(allowed.includes(cap), `${c.key}: năng lực "${cap}" không thuộc tập đóng của loại ${c.kind}`);
    assert.ok(c.capabilities.length > 0, `${c.key}: phải khai ít nhất một năng lực`);
    assert.ok((MODULE_KEYS as readonly string[]).includes(c.module), `${c.key}: module "${c.module}" không có trong sổ module`);
    assert.ok(c.why.length >= 40, `${c.key}: phải nói vì sao được khai như vậy`);
    assert.equal(c.health === "testConnection", c.healthRef !== null, `${c.key}: health và healthRef phải đi cùng nhau`);
    if (c.healthRef) {
      const [file, sym] = c.healthRef.split("::");
      assert.ok(existsSync(path.join(goc, file)), `${c.key}: healthRef trỏ tệp không có — ${file}`);
      assert.ok(new RegExp(`(?:function\\s+${sym}\\s*\\(|async\\s+${sym}\\s*\\()`).test(doc(file)), `${c.key}: healthRef trỏ hàm không có — ${c.healthRef}`);
    }
    for (const code of c.code) assert.ok(existsSync(path.join(goc, code)), `${c.key}: code trỏ tệp/thư mục không có — ${code}`);
    if (c.tenancy === "HOME_ONLY") {
      assert.ok(c.config.store === "ENV" || c.config.store === "SETTINGS_TABLE", `${c.key}: HOME_ONLY thì cấu hình nằm ở biến môi trường / settings của nhà`);
      assert.equal(isOrgConfigurable(c), false, `${c.key}: HOME_ONLY không bao giờ cấu hình được ở org_connections (X7)`);
    }
    if (isOrgConfigurable(c)) {
      assert.equal(c.health, "testConnection", `${c.key}: kết nối theo tổ chức phải có hàm kiểm tra thật — bật chỉ sau khi kiểm tra đạt`);
      assert.ok(ORG_CONNECTION_TESTERS[c.key], `${c.key}: thiếu hàm trong ORG_CONNECTION_TESTERS`);
      assert.ok(c.settings.some((f) => f.secret), `${c.key}: kết nối theo tổ chức lưu ở org_connections phải có ít nhất một ô bí mật`);
    }
    for (const f of c.settings) if (f.pattern) new RegExp(f.pattern); // biểu thức phải biên dịch được
  }
  for (const k of Object.keys(ORG_CONNECTION_TESTERS)) {
    const spec = findConnector(k);
    assert.ok(spec && isOrgConfigurable(spec), `ORG_CONNECTION_TESTERS["${k}"] không ứng với connector theo tổ chức nào`);
    assert.equal(spec?.healthRef?.startsWith("lib/connectors/testers.ts::"), true, `${k}: healthRef phải trỏ vào lib/connectors/testers.ts`);
  }

  // Mỗi tệp dưới lib/integrations/ thuộc ĐÚNG MỘT connector, hoặc là helper có lý do.
  const files = walk("lib/integrations").filter((f) => /\.(ts|tsx)$/.test(f));
  assert.ok(files.length >= 40, `phải thấy các tệp tích hợp đã biết — mới thấy ${files.length}`);
  const loi: string[] = [];
  for (const f of files) {
    const owners = CONNECTORS.filter((c) => covers(c, f)).map((c) => c.key);
    if (INTEGRATION_HELPERS[f]) {
      if (owners.length) loi.push(`${f}: vừa là helper vừa thuộc ${owners.join(", ")}`);
      continue;
    }
    if (owners.length !== 1) loi.push(`${f}: thuộc ${owners.length} connector (${owners.join(", ") || "không cái nào"})`);
  }
  assert.deepEqual(loi, [], "mỗi tệp dưới lib/integrations/ phải thuộc ĐÚNG MỘT mục sổ connector (trường code) hoặc khai ở INTEGRATION_HELPERS");
  for (const [f, lyDo] of Object.entries(INTEGRATION_HELPERS)) {
    assert.ok(existsSync(path.join(goc, f)), `INTEGRATION_HELPERS có tệp không còn: ${f}`);
    assert.ok(lyDo.length >= 20, `helper ${f} phải kèm lý do`);
  }
  // Mỗi thư mục con của lib/integrations/ có ít nhất một mục sổ.
  for (const d of readdirSync(path.join(goc, "lib/integrations"), { withFileTypes: true }).filter((e) => e.isDirectory())) {
    assert.ok(
      CONNECTORS.some((c) => c.code.some((code) => code.startsWith(`lib/integrations/${d.name}/`))),
      `thư mục lib/integrations/${d.name}/ không có mục nào trong sổ connector`,
    );
  }

  // Mỗi route webhook có mục khai; mỗi khai webhook có route; chế độ phân giải khớp WEBHOOK_BINDINGS.
  const routes = walk("app/api/webhooks")
    .filter((f) => /\/route\.tsx?$/.test(f))
    .map((f) => f.replace(/^app/, "").replace(/\/route\.tsx?$/, ""));
  assert.ok(routes.length >= 4, `phải thấy các route webhook đã biết — mới thấy ${routes.length}`);
  const declared = CONNECTORS.flatMap((c) => (c.webhook ? [{ spec: c, w: c.webhook }] : []));
  for (const r of routes) {
    const owners = declared.filter((d) => d.w.path === r);
    assert.equal(owners.length, 1, `route webhook ${r} phải được khai ở ĐÚNG MỘT connector (thấy ${owners.length})`);
  }
  const bindingsUsed = new Set<string>();
  for (const { spec, w } of declared) {
    const file = ["route.ts", "route.tsx"].map((n) => path.join(goc, "app", w.path, n)).find((p) => existsSync(p));
    assert.ok(file, `${spec.key}: webhook.path ${w.path} không có route nào`);
    assert.ok(w.idempotencyKey.length >= 10 && w.verify.length >= 10, `${spec.key}: webhook phải khai cách xác thực và khoá chống trùng`);
    if (w.binding) {
      bindingsUsed.add(w.binding);
      assert.equal(WEBHOOK_BINDINGS[w.binding].mode, w.tenantResolution, `${spec.key}: tenantResolution phải khớp WEBHOOK_BINDINGS.${w.binding}`);
      assert.ok(readFileSync(file, "utf8").includes(`resolveWebhookOrganization("${w.binding}")`), `${spec.key}: route ${w.path} phải phân giải tổ chức bằng binding ${w.binding}`);
    } else {
      assert.equal(w.tenantResolution, "HOME_ONLY", `${spec.key}: tuyến không qua WEBHOOK_BINDINGS chỉ được là HOME_ONLY`);
      assert.ok(!w.path.startsWith("/api/webhooks/"), `${spec.key}: route dưới /api/webhooks/ phải có binding trong WEBHOOK_BINDINGS`);
    }
  }
  assert.deepEqual([...bindingsUsed].sort(), Object.keys(WEBHOOK_BINDINGS).sort(), "mỗi dòng WEBHOOK_BINDINGS phải có đúng connector khai nó");

  // Mọi biến credential môi trường của nhà có chủ trong sổ (HOME_ONLY).
  const envOwned = new Set(CONNECTORS.filter((c) => c.tenancy === "HOME_ONLY").flatMap((c) => c.settings.map((f) => f.envVar).filter(Boolean)));
  const orphan = CUSTOMER_CREDENTIAL_ENV.filter((v) => !envOwned.has(v));
  assert.deepEqual(orphan, [], "biến credential của tổ chức nhà chưa có connector nào khai (envVar)");

  // Biểu thức kiểm ô trong sổ = biểu thức hàm kiểm tra dùng — hai chỗ không được nói hai điều.
  const src = (key: string, field: string) => new RegExp(findConnector(key)?.settings.find((f) => f.key === field)?.pattern ?? "(?!)").source;
  assert.equal(src("lark-webhook", "webhookUrl"), LARK_HOOK_PATTERN.source);
  assert.equal(src("telegram-bot", "botToken"), TELEGRAM_TOKEN_PATTERN.source);
  assert.equal(src("telegram-bot", "chatId"), TELEGRAM_CHAT_PATTERN.source);

  assert.equal(maskSecret("abc"), "••••", "bí mật ngắn chỉ hiện ••••");
  assert.equal(maskSecret("0123456789abcdef"), "••••cdef");
  assert.equal(maskSecret("   "), "");

  const perKind: Record<string, number> = {};
  for (const c of CONNECTORS) perKind[c.kind] = (perKind[c.kind] ?? 0) + 1;
  return { perKind, homeOnly: CONNECTORS.filter((c) => c.tenancy === "HOME_ONLY").length, perOrg: CONNECTORS.filter((c) => c.tenancy === "PER_ORG").length };
}

/* ═════════════ 2 · MÃ HOÁ ═════════════ */

export function testSecretsCrypto() {
  const env = (v: Record<string, string>) => (n: string) => v[n];
  const state = secretsKeyState(env({ PLATFORM_SECRETS_KEY: MASTER }));
  assert.ok(state.ok, "khoá đủ dài ⇒ dùng được");
  const bind = { orgCode: A, connectorKey: "lark-webhook" };
  const plain = { webhookUrl: LARK_URL, signSecret: LARK_SIGN };
  const s1 = sealSecrets(plain, bind, state);
  const s2 = sealSecrets(plain, bind, state);
  assert.deepEqual(openSecrets(s1.ciphertext, { ...bind, keyId: s1.keyId }, state), plain, "vòng tròn mã hoá → giải mã");
  assert.ok(!s1.ciphertext.includes(Buffer.from(LARK_SIGN)) && !s1.ciphertext.includes(Buffer.from("larksuite")), "bản mã không chứa bản rõ");
  assert.notDeepEqual(s1.ciphertext.subarray(1, 13), s2.ciphertext.subarray(1, 13), "mỗi lần mã hoá một nonce mới");
  assert.notDeepEqual(s1.ciphertext, s2.ciphertext);

  // AAD: đổi tổ chức hoặc connector ⇒ không giải được, kể cả khi cùng khoá chủ.
  assert.throws(() => openSecrets(s1.ciphertext, { orgCode: B, connectorKey: "lark-webhook" }, state), SecretsDecryptError, "bản mã của A không giải được ở B (AAD)");
  assert.throws(() => openSecrets(s1.ciphertext, { orgCode: A, connectorKey: "telegram-bot" }, state), SecretsDecryptError, "bản mã của connector X không giải được ở Y (AAD)");
  const tampered = Buffer.from(s1.ciphertext);
  tampered[tampered.length - 1] ^= 0x01;
  assert.throws(() => openSecrets(tampered, bind, state), SecretsDecryptError, "sửa một byte ⇒ thẻ xác thực hỏng");
  assert.throws(() => openSecrets(Buffer.from([9, 9, 9]), bind, state), SecretsDecryptError, "định dạng lạ ⇒ từ chối");

  // Khoá chủ đổi ⇒ mã khoá đổi ⇒ câu "khoá khác", không phải rác.
  const other = secretsKeyState(env({ PLATFORM_SECRETS_KEY: MASTER_2 }));
  assert.ok(other.ok && other.keyId !== state.keyId, "khoá khác ⇒ mã khoá khác");
  assert.throws(() => openSecrets(s1.ciphertext, { ...bind, keyId: s1.keyId }, other), /PLATFORM_SECRETS_KEY khác/);
  assert.throws(() => openSecrets(s1.ciphertext, bind, other), SecretsDecryptError, "không mang mã khoá vẫn không giải được bằng khoá khác");

  // THIẾU / NGẮN ⇒ tắt, KHÔNG lùi về AUTH_SECRET hay khoá cứng.
  const missing = secretsKeyState(env({ AUTH_SECRET: MASTER, NEXTAUTH_SECRET: MASTER }));
  assert.equal(missing.ok, false, "thiếu PLATFORM_SECRETS_KEY ⇒ tắt dù AUTH_SECRET có");
  assert.match(missing.ok ? "" : missing.reason, /PLATFORM_SECRETS_KEY/);
  assert.equal(secretsKeyState(env({ PLATFORM_SECRETS_KEY: "ngan-qua" })).ok, false, "khoá < 32 ký tự ⇒ tắt");
  assert.throws(() => sealSecrets(plain, bind, missing), SecretsUnavailableError);
  assert.throws(() => openSecrets(s1.ciphertext, bind, missing), SecretsUnavailableError);
  const src = boChuThich(doc("lib/connectors/secrets.ts"));
  assert.ok(!/AUTH_SECRET|authSecret|env\.auth/.test(src), "secrets.ts không được đọc khoá ký phiên");
  assert.ok(!/createCipheriv\(\s*["']aes-256-(cbc|ecb|ctr)/.test(src) && src.includes('"aes-256-gcm"'), "chỉ AES-256-GCM");
}

/* ═════════════ 3 · HÀM KIỂM TRA (máy chủ giả) ═════════════ */

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: (url: string) => { status?: number; body: unknown } | Error): { fetch: (url: string, init: RequestInit) => Promise<Response>; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const r = respond(url);
      if (r instanceof Error) throw r;
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
    },
  };
}

export async function testTesters() {
  const now = () => new Date("2026-09-28T03:00:00Z");
  const ok = fakeFetch(() => ({ body: { code: 0, msg: "success" } }));
  const r = await testLarkWebhook({ secrets: { webhookUrl: LARK_URL, signSecret: LARK_SIGN }, orgName: "A" }, { fetch: ok.fetch, now });
  assert.equal(r.ok, true);
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].url, LARK_URL, "chỉ gọi đúng URL đã khai");
  assert.equal(ok.calls[0].init.redirect, "manual", "không theo chuyển hướng");
  const body = JSON.parse(String(ok.calls[0].init.body)) as Record<string, unknown>;
  assert.equal(body.msg_type, "text");
  assert.ok(typeof body.sign === "string" && body.timestamp === "1790564400", "có khoá ký ⇒ gửi chữ ký");
  assert.ok(!String(ok.calls[0].init.body).includes(LARK_SIGN), "khoá ký không đi trong body");

  for (const bad of ["http://open.larksuite.com/open-apis/bot/v2/hook/aaaa1111", "https://169.254.169.254/open-apis/bot/v2/hook/aaaa1111", "https://open.larksuite.com.evil.vn/open-apis/bot/v2/hook/aaaa1111", "https://evil.vn/?u=https://open.larksuite.com/open-apis/bot/v2/hook/aaaa1111", "https://open.larksuite.com/open-apis/bot/v2/hook/../../x"]) {
    const f = fakeFetch(() => ({ body: { code: 0 } }));
    const res = await testLarkWebhook({ secrets: { webhookUrl: bad }, orgName: "A" }, { fetch: f.fetch });
    assert.equal(res.ok, false, `${bad} phải bị từ chối`);
    assert.equal(f.calls.length, 0, `${bad}: không một request nào rời máy`);
  }
  const refused = await testLarkWebhook({ secrets: { webhookUrl: LARK_URL }, orgName: "A" }, { fetch: fakeFetch(() => ({ body: { code: 19021, msg: `sign match fail ${LARK_URL}` } })).fetch });
  assert.equal(refused.ok, false, "Lark trả HTTP 200 kèm code ≠ 0 ⇒ hỏng (không tin HTTP status)");
  assert.ok(!refused.message.includes("aaaa1111"), "câu lỗi không mang mã hook");
  const thrown = await testLarkWebhook({ secrets: { webhookUrl: LARK_URL }, orgName: "A" }, { fetch: fakeFetch(() => new Error(`connect ECONNREFUSED ${LARK_URL}`)).fetch });
  assert.equal(thrown.ok, false);
  assert.ok(!thrown.message.includes("aaaa1111"), "lỗi mạng mang URL ⇒ đã che");
  const redirect = await testLarkWebhook({ secrets: { webhookUrl: LARK_URL }, orgName: "A" }, { fetch: fakeFetch(() => ({ status: 302, body: {} })).fetch });
  assert.equal(redirect.ok, false, "3xx ⇒ không theo, không đạt");

  const tg = fakeFetch((url) => (url.endsWith("/getMe") ? { body: { ok: true, result: { username: "shop_bot" } } } : { body: { ok: true } }));
  const t = await testTelegramBot({ secrets: { botToken: TG_TOKEN }, settings: { chatId: "-1001234567" }, orgName: "A" }, { fetch: tg.fetch });
  assert.equal(t.ok, true);
  assert.deepEqual(tg.calls.map((c) => c.url.replace(TG_TOKEN, "<t>")), ["https://api.telegram.org/bot<t>/getMe", "https://api.telegram.org/bot<t>/sendMessage"]);
  assert.ok(!t.message.includes(TG_TOKEN));
  const tgFail = await testTelegramBot({ secrets: { botToken: TG_TOKEN }, settings: { chatId: "-1001234567" }, orgName: "A" }, { fetch: fakeFetch(() => new Error(`request to https://api.telegram.org/bot${TG_TOKEN}/getMe failed`)).fetch });
  assert.equal(tgFail.ok, false);
  assert.ok(!tgFail.message.includes(TG_TOKEN), "token Telegram không lọt vào câu lỗi");
  const tgBad = fakeFetch(() => ({ body: { ok: true } }));
  assert.equal((await testTelegramBot({ secrets: { botToken: "khong-phai-token" }, settings: { chatId: "-1001234567" }, orgName: "A" }, { fetch: tgBad.fetch })).ok, false);
  assert.equal((await testTelegramBot({ secrets: { botToken: TG_TOKEN }, settings: { chatId: "x; drop" }, orgName: "A" }, { fetch: tgBad.fetch })).ok, false);
  assert.equal(tgBad.calls.length, 0, "đầu vào sai dạng ⇒ không gọi mạng");
}

/* ═════════════ 4 · HAI TỔ CHỨC THẬT + TỔ CHỨC NHÀ ═════════════ */

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
}

const MODULES = ["customers", "products", "orders", "alerts"];

async function adminOf(org: string): Promise<SessionUser> {
  return withOrganization(org, async () => {
    const u = await (await getDb()).query.users.findFirst({ where: eq(schema.users.email, `admin@${org}.local`) });
    assert.ok(u, `quản trị của ${org}`);
    return { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: org, name: `Tổ chức ${org}`, isHome: false }, modules: ["core", "work", ...MODULES] };
  });
}

async function homeFingerprint() {
  const db = await getDb();
  const conn = await db.execute(sql`select count(*)::int as n from org_connections`);
  const set = await db.execute(sql`select coalesce(md5(string_agg(key || '=' || value, '|' order by key)), '') as h from settings`);
  const aud = await db.execute(sql`select count(*)::int as n from audit_logs where entity = 'org_connection'`);
  const one = (r: unknown, k: string) => ((r as { rows: Record<string, unknown>[] }).rows[0] ?? {})[k];
  return { connections: one(conn, "n"), settings: one(set, "h"), audits: one(aud, "n") };
}

function assertNoSecret(label: string, value: unknown, secrets: readonly string[]) {
  const json = JSON.stringify(value);
  for (const s of secrets) if (s && s.length >= 6) assert.ok(!json.includes(s), `${label}: lộ bí mật "${s.slice(0, 3)}…"`);
}

export async function testConnectionsTwoOrgs() {
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  const home0 = await homeFingerprint();
  for (const code of [A, B]) {
    await cleanupOrg(code);
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
    await provisionOrganization({ code, name: `Tổ chức ${code}`, modules: MODULES, admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "Conn@12345" }, source: "TEST", actor: null });
  }
  const larkOk = fakeFetch(() => ({ body: { code: 0 } }));
  const larkNo = fakeFetch(() => ({ body: { code: 19001, msg: "param invalid" } }));
  const SECRETS = [LARK_URL, LARK_SIGN, TG_TOKEN, "aaaa1111-bbbb-2222-cccc-3333dddd4444"];
  try {
    const adminA = await adminOf(A);
    const adminB = await adminOf(B);

    await withOrganization(A, async () => {
      // Thiếu khoá: màn hình nói ra, lưu bí mật bị TỪ CHỐI, không dòng nào sinh ra.
      delete process.env.PLATFORM_SECRETS_KEY;
      const v0 = (await loadConnectionsView(adminA)) as ConnectionsView;
      assert.equal(v0.secretsReady.ok, false);
      assert.match(v0.secretsReady.reason ?? "", /PLATFORM_SECRETS_KEY/);
      const noKey = await saveConnection(adminA, { connectorKey: "lark-webhook", secrets: { webhookUrl: LARK_URL } });
      assert.ok("error" in noKey && /PLATFORM_SECRETS_KEY/.test(noKey.error), "thiếu PLATFORM_SECRETS_KEY ⇒ từ chối lưu");
      assert.equal((await (await getDb()).select().from(schema.orgConnections)).length, 0, "từ chối lưu ⇒ không dòng nào");

      process.env.PLATFORM_SECRETS_KEY = MASTER;
      const rows0 = v0.groups.flatMap((g) => g.rows);
      for (const r of rows0.filter((x) => x.tenancy === "HOME_ONLY")) {
        assert.equal(r.mode, "HOME_ONLY_UNAVAILABLE", `${r.key}: tổ chức khác thấy "chưa mở"`);
        assert.equal(r.homeReadiness, null, `${r.key}: tổ chức khác KHÔNG được đọc trạng thái cấu hình của nhà`);
      }
      // Quyền, module, tổ chức lệch, connector HOME_ONLY, đầu vào sai.
      const viewer: SessionUser = { ...adminA, role: "VIEWER", permissions: ["dashboard:view"] };
      assert.ok("error" in (await saveConnection(viewer, { connectorKey: "lark-webhook", secrets: { webhookUrl: LARK_URL } })), "thiếu settings:manage ⇒ từ chối");
      assert.ok("error" in (await loadConnectionsView(viewer)), "thiếu settings:manage ⇒ không xem");
      assert.ok("error" in (await saveConnection({ ...adminA, modules: ["core", "work", "customers", "products", "orders"] }, { connectorKey: "lark-webhook", secrets: { webhookUrl: LARK_URL } })), "module của connector tắt ⇒ từ chối");
      assert.ok("error" in (await saveConnection({ ...adminA, organization: { code: B, name: "B", isHome: false } }, { connectorKey: "lark-webhook", secrets: { webhookUrl: LARK_URL } })), "phiên nói B mà ngữ cảnh là A ⇒ từ chối");
      assert.ok("error" in (await saveConnection(adminA, { connectorKey: "pancake-pos", secrets: { apiKey: "x".repeat(20) } })), "HOME_ONLY không cấu hình được");
      assert.ok("error" in (await saveConnection(adminA, { connectorKey: "lark-webhook", secrets: { webhookUrl: "https://evil.vn/open-apis/bot/v2/hook/aaaa1111" } })), "URL ngoài máy chủ Lark ⇒ từ chối ngay lúc lưu");
      assert.ok("error" in (await saveConnection(adminA, { connectorKey: "lark-webhook", secrets: { lạ: "x" } })), "ô lạ ⇒ từ chối");
      assert.ok("error" in (await saveConnection(adminA, { connectorKey: "lark-webhook", secrets: {} })), "thiếu ô bí mật bắt buộc ⇒ từ chối");

      // Lưu → nháp, bản mã không chứa bản rõ, gợi ý •••• + 4 ký tự.
      const saved = await saveConnection(adminA, { connectorKey: "lark-webhook", secrets: { webhookUrl: LARK_URL, signSecret: LARK_SIGN } });
      assert.ok("ok" in saved && saved.status === "DRAFT", `lưu được: ${JSON.stringify(saved)}`);
      const db = await getDb();
      const [row] = await db.select().from(schema.orgConnections).where(eq(schema.orgConnections.connectorKey, "lark-webhook"));
      assert.equal(row.orgCode, A);
      assert.ok(row.secretsEnc && !row.secretsEnc.includes(Buffer.from(LARK_SIGN)) && !row.secretsEnc.includes(Buffer.from("aaaa1111")), "CSDL chỉ có bản mã");
      assert.deepEqual(row.secretHints, { webhookUrl: "••••4444", signSecret: "••••8e7d" }, "gợi ý = •••• + 4 ký tự cuối");
      assertNoSecret("dòng CSDL (trừ bản mã)", { ...row, secretsEnc: null }, SECRETS);

      assert.ok("error" in (await setConnectionStatus(adminA, "lark-webhook", "ACTIVE")), "chưa kiểm tra ⇒ không bật được");
      const failed = await testOrgConnection(adminA, "lark-webhook", { tester: { fetch: larkNo.fetch } });
      assert.ok("error" in failed, "Lark từ chối ⇒ kiểm tra hỏng");
      assert.ok("error" in (await setConnectionStatus(adminA, "lark-webhook", "ACTIVE")), "kiểm tra hỏng ⇒ không bật được");
      const passed = await testOrgConnection(adminA, "lark-webhook", { tester: { fetch: larkOk.fetch } });
      assert.ok("ok" in passed, `kiểm tra đạt: ${JSON.stringify(passed)}`);
      assert.equal(larkOk.calls[0]?.url, LARK_URL, "kiểm tra dùng đúng URL đã giải mã của A");
      const on = await setConnectionStatus(adminA, "lark-webhook", "ACTIVE");
      assert.ok("ok" in on && on.status === "ACTIVE");

      // Lưu lại (ô bí mật trống = giữ) ⇒ bản mã giữ nguyên, về Nháp, kết quả kiểm tra cũ bị xoá.
      const before = (await db.select().from(schema.orgConnections).where(eq(schema.orgConnections.connectorKey, "lark-webhook")))[0];
      const resaved = await saveConnection(adminA, { connectorKey: "lark-webhook", secrets: {} });
      assert.ok("ok" in resaved && resaved.status === "DRAFT");
      const after = (await db.select().from(schema.orgConnections).where(eq(schema.orgConnections.connectorKey, "lark-webhook")))[0];
      assert.ok(after.secretsEnc && before.secretsEnc && after.secretsEnc.equals(before.secretsEnc), "ô trống ⇒ giữ bản mã cũ");
      assert.equal(after.lastTestOk, null, "đổi cấu hình ⇒ kết quả kiểm tra cũ không còn giá trị");
      // Đang bật mà kiểm tra lại hỏng ⇒ về Nháp (phía hẹp).
      assert.ok("ok" in (await testOrgConnection(adminA, "lark-webhook", { tester: { fetch: larkOk.fetch } })));
      assert.ok("ok" in (await setConnectionStatus(adminA, "lark-webhook", "ACTIVE")));
      const drop = await testOrgConnection(adminA, "lark-webhook", { tester: { fetch: larkNo.fetch } });
      assert.ok("error" in drop && /Nháp/.test(drop.error));
      assert.equal((await db.select().from(schema.orgConnections).where(eq(schema.orgConnections.connectorKey, "lark-webhook")))[0].status, "DRAFT");
      // CSDL tự chặn: không đường ghi nào đặt ACTIVE khi kiểm tra chưa đạt.
      await assert.rejects(() => db.execute(sql`update org_connections set status = 'ACTIVE' where connector_key = 'lark-webhook'`), "ràng buộc org_connections_active_tested_check");

      // Telegram: ô thường lưu rõ, ô bí mật mã hoá.
      const tg = await saveConnection(adminA, { connectorKey: "telegram-bot", settings: { chatId: "-1001234567" }, secrets: { botToken: TG_TOKEN } });
      assert.ok("ok" in tg);
      const tgFetch = fakeFetch((url) => (url.endsWith("/getMe") ? { body: { ok: true, result: { username: "a_bot" } } } : { body: { ok: true } }));
      assert.ok("ok" in (await testOrgConnection(adminA, "telegram-bot", { tester: { fetch: tgFetch.fetch } })));

      // Không đường trả về nào mang bí mật: màn hình, kết quả action, nhật ký.
      const vA = await loadConnectionsView(adminA);
      assertNoSecret("màn hình Kết nối của A", vA, SECRETS);
      assertNoSecret("kết quả action", [saved, failed, passed, on, resaved, drop, tg], SECRETS);
      const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "org_connection"));
      assert.ok(audits.length >= 8, `mọi lượt lưu / kiểm tra / bật đều có nhật ký — thấy ${audits.length}`);
      assertNoSecret("nhật ký", audits, SECRETS);
      const lark = (vA as ConnectionsView).groups.flatMap((g) => g.rows).find((r) => r.key === "lark-webhook");
      assert.equal(lark?.connection?.secretHints.webhookUrl, "••••4444");
      assert.equal(lark?.fields.find((f) => f.key === "webhookUrl")?.secret, true);
    });

    // B: không thấy kết nối của A; bản mã của A chép sang B không giải được.
    const stolen = await withOrganization(A, async () => (await (await getDb()).select().from(schema.orgConnections).where(eq(schema.orgConnections.connectorKey, "lark-webhook")))[0]);
    await withOrganization(B, async () => {
      const vB = (await loadConnectionsView(adminB)) as ConnectionsView;
      for (const r of vB.groups.flatMap((g) => g.rows)) assert.equal(r.connection, null, `${r.key}: B không thấy kết nối của A`);
      const db = await getDb();
      assert.equal((await db.select().from(schema.orgConnections)).length, 0, "CSDL của B không có dòng nào");
      // Dòng chép nguyên (mã tổ chức A) ⇒ dây bẫy.
      await db.insert(schema.orgConnections).values({ ...stolen, id: "chep-nguyen", lastTestOk: null, status: "DRAFT" });
      const trip = await testOrgConnection(adminB, "lark-webhook", { tester: { fetch: larkOk.fetch } });
      assert.ok("error" in trip && /mã tổ chức/.test(trip.error), "dòng mang mã tổ chức khác ⇒ không dùng");
      // Dòng chép rồi sửa mã tổ chức thành B ⇒ AAD chặn: không giải được, không một request nào rời máy.
      await db.update(schema.orgConnections).set({ orgCode: B }).where(eq(schema.orgConnections.id, "chep-nguyen"));
      const callsBefore = larkOk.calls.length;
      const aad = await testOrgConnection(adminB, "lark-webhook", { tester: { fetch: larkOk.fetch } });
      assert.ok("error" in aad && /giải mã/.test(aad.error), `bản mã của A không giải được ở B: ${JSON.stringify(aad)}`);
      assert.equal(larkOk.calls.length, callsBefore, "không giải được ⇒ không gửi gì");
      assertNoSecret("lỗi giải mã", aad, SECRETS);
    });

    // Tổ chức nhà: HOME_ONLY CHỈ ĐỌC, không giá trị bí mật nào của môi trường, CSDL nhà không đổi một dòng.
    const homeCtx = await currentOrganization();
    assert.equal(homeCtx.isHome, true, "tiền đề: không ngữ cảnh tường minh ⇒ tổ chức nhà");
    const homeUser: SessionUser = { id: "pc-home-viewer", email: "home@local", name: "Nhà", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: homeCtx.code, name: "Nhà", isHome: true } };
    // ĐẶT khoá BỊA cho vài biến credential của nhà (đầu vào của tình huống), đọc màn hình, rồi trả lại nguyên
    // trạng: kết luận "không lộ giá trị" không phụ thuộc máy đang chạy có khoá thật hay không (luật 65).
    const FAKE_ENV: Record<string, string> = {
      PANCAKE_API_KEY: "pk-bia-khong-co-that-0001aa",
      PANCAKE_SHOP_ID: "990011223344",
      PANCAKE_ACCESS_TOKEN: "pat-bia-khong-co-that-0002bb",
      VIETTELPOST_PASSWORD: "vtp-mat-khau-bia-0003cc",
      VIETTELPOST_USERNAME: "vtp-tai-khoan-bia-0004",
      FACEBOOK_ACCESS_TOKEN: "EAAbia-khong-co-that-0005dd",
      CHATBOT_ADMIN_TOKEN: "bot-bia-khong-co-that-0006ee",
      GEMINI_API_KEY: "gem-bia-khong-co-that-0007ff",
    };
    const savedEnv = Object.fromEntries(Object.keys(FAKE_ENV).map((k) => [k, process.env[k]]));
    let vHome: ConnectionsView;
    try {
      Object.assign(process.env, FAKE_ENV);
      vHome = (await loadConnectionsView(homeUser)) as ConnectionsView;
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const homeRows = vHome.groups.flatMap((g) => g.rows);
    for (const r of homeRows.filter((x) => x.tenancy === "HOME_ONLY")) {
      assert.equal(r.mode, "HOME_READONLY", `${r.key}: nhà thấy chế độ chỉ đọc`);
      assert.ok(r.homeReadiness, `${r.key}: nhà thấy đã cấu hình hay chưa`);
      assert.deepEqual(r.fields, [], `${r.key}: không có ô nào để sửa`);
    }
    for (const k of ["pancake-pos", "pancake-pages", "viettelpost", "meta-ads", "pancake-chatbot", "gemini-video"]) {
      assert.equal(homeRows.find((r) => r.key === k)?.homeReadiness?.state, "CONFIGURED", `${k}: nhà có khoá ⇒ «đã cấu hình»`);
    }
    assertNoSecret("màn hình Kết nối của nhà", vHome, Object.values(FAKE_ENV));
    assert.ok(CUSTOMER_CREDENTIAL_ENV.length >= 20, "tiền đề: danh sách credential của nhà");
    assert.ok("error" in (await saveConnection(homeUser, { connectorKey: "viettelpost", secrets: { password: "x".repeat(20) } })), "nhà không đổi được connector HOME_ONLY qua màn hình này");
    const home1 = await homeFingerprint();
    assert.deepEqual(home1, home0, "CSDL nhà: org_connections, settings, nhật ký kết nối — không đổi một dòng");
  } finally {
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    for (const code of [A, B]) await cleanupOrg(code);
  }
}

/* ═════════════ 5 · QUÉT MÃ: BÍ MẬT KHÔNG CÓ ĐƯỜNG RA ═════════════ */

export function testNoSecretPathsStatic() {
  const files = tepKho().filter((t) => /\.(ts|tsx)$/.test(t) && !t.startsWith("tests/"));
  const src = new Map(files.map((f) => [f, boChuThich(doc(f))]));
  const giaiMa = files.filter((f) => /\bopenSecrets\s*\(/.test(src.get(f) ?? "") && f !== "lib/connectors/secrets.ts");
  assert.deepEqual(giaiMa, ["lib/connectors/service.ts"], "chỉ lib/connectors/service.ts được giải mã bí mật kết nối");
  const chamBanMa = files.filter((f) => /\bsecretsEnc\b|secrets_enc/.test(src.get(f) ?? "") && !["db/schema.ts", "lib/connectors/service.ts"].includes(f));
  assert.deepEqual(chamBanMa, [], "chỉ schema + service chạm cột bản mã");
  const chamBang = files.filter((f) => /\borgConnections\b/.test(src.get(f) ?? "") && !["db/schema.ts", "lib/connectors/service.ts"].includes(f));
  assert.deepEqual(chamBang, [], "bảng org_connections chỉ đọc/ghi qua lib/connectors/service.ts");
  const client = files.filter((f) => /^\s*["']use client["']/.test(doc(f)));
  const clientSai = client.filter((f) => /from\s+["']@\/lib\/connectors\/(service|secrets|testers|home-status)["']/.test((src.get(f) ?? "").replace(/import\s+type[^;]+;/g, "")));
  assert.deepEqual(clientSai, [], "client component không import mã chỉ-máy-chủ của connector");
  const ai = files.filter((f) => /^lib\/(ai|agents)\//.test(f) && /@\/lib\/connectors\//.test(src.get(f) ?? ""));
  assert.deepEqual(ai, [], "ngữ cảnh AI không được đọc connector / bí mật kết nối");
  const log = files.filter((f) => f.startsWith("lib/connectors/") && /\bconsole\.(log|info|warn|error|debug)\s*\(/.test(src.get(f) ?? ""));
  assert.deepEqual(log, [], "lib/connectors/* không in log (bí mật không bao giờ vào log)");
  const action = src.get("lib/actions/connections.ts") ?? "";
  assert.ok(action.includes('"use server"') || doc("lib/actions/connections.ts").startsWith('"use server"'));
  assert.ok(/requirePermission\(\s*CONNECTIONS_PERMISSION\s*\)/.test(action) && (action.match(/requirePermission\(/g) ?? []).length === 3, "ba action đều đọc phiên với quyền của màn hình");
  const page = src.get("app/(dashboard)/settings/connections/page.tsx") ?? "";
  assert.ok(page.includes("requirePermission(CONNECTIONS_PERMISSION)"), "trang gác quyền trước khi đọc");
}

export async function testConnectors() {
  const sum = testRegistryMatchesCode();
  testSecretsCrypto();
  await testTesters();
  testNoSecretPathsStatic();
  await testConnectionsTwoOrgs();
  console.log(
    `✓ Phase 9 · connector: sổ ${CONNECTORS.length} mục (${sum.homeOnly} chỉ nhà · ${sum.perOrg} theo tổ chức · ${Object.entries(sum.perKind)
      .map(([k, n]) => `${k} ${n}`)
      .join(" · ")}) khớp lib/integrations + route webhook + WEBHOOK_BINDINGS + CUSTOMER_CREDENTIAL_ENV · AES-256-GCM vòng tròn, nonce mới, AAD chặn chép chéo tổ chức / connector, thiếu PLATFORM_SECRETS_KEY ⇒ từ chối · kiểm tra chỉ gọi Lark / Telegram, không theo chuyển hướng · hai tổ chức thật không thấy nhau, bật chỉ sau kiểm tra đạt · nhà chỉ đọc, CSDL nhà không đổi · không đường nào trả bí mật`,
  );
}

if (process.argv[1] && /connectors\.test\.ts$/.test(process.argv[1])) {
  testConnectors().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}

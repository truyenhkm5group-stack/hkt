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
import { createHash } from "node:crypto";
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
import { SELF_TEST_ORG, SecretsDecryptError, SecretsUnavailableError, openSecrets, sealSecrets, secretsKeyHealth, secretsKeyPublicStatus, secretsKeyState, selfTestSecrets } from "@/lib/connectors/secrets";
import { aiConnectionAudit, loadConnectionsView, openActiveConnection, saveAiConnectionAsOperator, saveConnection, setAiConnectionStatusAsOperator, setConnectionStatus, testAiConnectionAsOperator, testOrgConnection, type RekeyVerdict } from "@/lib/connectors/service";
import { LARK_HOOK_PATTERN, ORG_CONNECTION_CHAT_DISCOVERY, ORG_CONNECTION_TESTERS, TELEGRAM_CHAT_PATTERN, TELEGRAM_TOKEN_PATTERN, testLarkWebhook, testTelegramBot, testZaloBot, testPancakeFanpage, pancakeVerdict, PANCAKE_TEST_MAX_BYTES } from "@/lib/connectors/testers";
import { chunkText } from "@/lib/messaging/providers";
import type { ConnectionsView } from "@/lib/connectors/types";
import { MODULE_KEYS } from "@/lib/constants/platform-modules";
import { CUSTOMER_CREDENTIAL_ENV } from "@/lib/env";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { currentOrganization, withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { runSecretsSelfTest } from "@/lib/platform/secrets-self-test";
import { provisionOrganization } from "@/lib/platform/provision";
import { WEBHOOK_BINDINGS } from "@/lib/platform/webhooks";
import { CUSTOMER_AI_CONFIG_MANAGED } from "@/lib/saas/visibility";
import { rotateAllOrganizations } from "../scripts/rotate-platform-secrets";

/** Khoá AI của workspace khách: CHỈ người vận hành nền tảng ghi (lib/saas/visibility.ts) — bài kiểm đi đúng đường đó. */
const OPERATOR_AI_REF = { orgCode: "home", email: "op@nha.local" };

const goc = path.resolve(__dirname, "..");
const A = "pc-a";
const B = "pc-b";
const MASTER = "khoa-thu-nghiem-chi-de-kiem-thu-0123456789abcdef";
const MASTER_2 = "mot-khoa-khac-hoan-toan-cung-du-dai-0123456789zz";
const LARK_URL = "https://open.larksuite.com/open-apis/bot/v2/hook/aaaa1111-bbbb-2222-cccc-3333dddd4444";
const LARK_SIGN = "ky-lark-bi-mat-cua-to-chuc-a-9f8e7d";
const TG_TOKEN = "1234567890:AAH-bi-mat-telegram-cua-to-chuc-a_xyz0";
const AI_KEY = "sk-ant-api03-khoa-bia-vong-tron-pc-a-0123456789wxyz";

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
      // Ngoại lệ DUY NHẤT: connector khai `auth: "NONE"` (hộp thử nhắn tin, 0180) — không có gì để giữ bí mật.
      assert.ok(c.settings.some((f) => f.secret) || c.auth === "NONE", `${c.key}: kết nối theo tổ chức lưu ở org_connections phải có ít nhất một ô bí mật`);
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
      assert.ok(new RegExp(`resolveWebhookOrganization\\("${w.binding}"(\\)|, \\{ token \\}\\)|, \\{ pageId: [\\w.]+ \\}\\))`).test(readFileSync(file, "utf8")), `${spec.key}: route ${w.path} phải phân giải tổ chức bằng binding ${w.binding}`);
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

  // ── Xoay khoá: PREVIOUS giải bản mã mang ĐÚNG mã khoá cũ; không có PREVIOUS ⇒ câu "nhập lại", không phải rác ──
  const rotating = secretsKeyState(env({ PLATFORM_SECRETS_KEY: MASTER_2, PLATFORM_SECRETS_KEY_PREVIOUS: MASTER }));
  assert.ok(rotating.ok && rotating.previousState === "ready" && rotating.previous?.keyId === state.keyId, "PREVIOUS hợp lệ ⇒ dùng được, mã khoá = mã của khoá cũ");
  assert.deepEqual(openSecrets(s1.ciphertext, { ...bind, keyId: s1.keyId }, rotating), plain, "deploy khoá mới + PREVIOUS ⇒ bản mã cũ vẫn giải được");
  assert.equal(sealSecrets(plain, bind, rotating).keyId, other.ok ? other.keyId : "", "mã hoá LUÔN bằng khoá hiện tại, kể cả khi có PREVIOUS");
  try {
    openSecrets(s1.ciphertext, { ...bind, keyId: s1.keyId }, other);
    assert.fail("khoá mới không PREVIOUS phải từ chối");
  } catch (e) {
    assert.ok(e instanceof SecretsDecryptError && e.code === "SECRETS_DECRYPT_FAILED" && /nhập lại/.test(e.message), "SECRETS_DECRYPT_FAILED kèm câu nhập lại");
    assert.ok(!e.message.includes(s1.keyId), "câu lỗi chỉ có mã khoá RÚT GỌN");
  }
  assert.throws(() => openSecrets(s1.ciphertext, { ...bind, keyId: "0123456789abcdef" }, rotating), /nhập lại/, "mã khoá lạ (không khớp hiện tại lẫn PREVIOUS) ⇒ từ chối");
  const fresh = sealSecrets(plain, bind, other);
  assert.throws(() => openSecrets(fresh.ciphertext, { ...bind, keyId: state.keyId }, rotating), SecretsDecryptError, "bản mã khoá MỚI khai man mã khoá cũ ⇒ thẻ xác thực chặn (không thử khoá khác)");
  assert.throws(() => openSecrets(s1.ciphertext, { orgCode: B, connectorKey: "lark-webhook", keyId: s1.keyId }, rotating), SecretsDecryptError, "PREVIOUS vẫn giữ AAD tổ chức");
  const same = secretsKeyState(env({ PLATFORM_SECRETS_KEY: MASTER, PLATFORM_SECRETS_KEY_PREVIOUS: MASTER }));
  assert.ok(same.ok && same.previous === null && same.previousState === "invalid", "PREVIOUS trùng khoá hiện tại ⇒ invalid, không dùng");
  const shortPrev = secretsKeyState(env({ PLATFORM_SECRETS_KEY: MASTER, PLATFORM_SECRETS_KEY_PREVIOUS: "ngan" }));
  assert.ok(shortPrev.ok && shortPrev.previous === null && shortPrev.previousState === "invalid", "PREVIOUS ngắn ⇒ invalid");
  assert.equal(secretsKeyState(env({ PLATFORM_SECRETS_KEY_PREVIOUS: MASTER })).ok, false, "chỉ có PREVIOUS mà không có khoá hiện tại ⇒ TẮT (không lấy khoá cũ làm khoá chính)");
  // "Khởi động lại": không đệm — cùng chuỗi ⇒ cùng khoá, cùng mã khoá, giải được bản mã của lần chạy trước.
  const restarted = secretsKeyState(env({ PLATFORM_SECRETS_KEY: `  ${MASTER}\n` }));
  assert.ok(restarted.ok && restarted.keyId === s1.keyId, "nạp lại từ .env (kể cả khoảng trắng thừa) ⇒ cùng mã khoá");
  assert.deepEqual(openSecrets(s1.ciphertext, { ...bind, keyId: s1.keyId }, restarted), plain);
  assert.ok(!/^(?:const|let)\s+\w+\s*(?::[^=]+)?=\s*(?:secretsKeyState|derive)\(/m.test(src), "secrets.ts không đóng băng khoá ở cấp module");

  // ── Dòng /api/health: chỉ trạng thái + 8 hex ──
  assert.deepEqual(secretsKeyHealth(missing), { secretsKey: "missing", secretsKeyIdShort: null, secretsKeyPrevious: "absent" });
  assert.equal(secretsKeyHealth(secretsKeyState(env({ PLATFORM_SECRETS_KEY: "ngan-qua" }))).secretsKey, "invalid");
  const h = secretsKeyHealth(rotating);
  assert.deepEqual(h, { secretsKey: "ready", secretsKeyIdShort: rotating.ok ? rotating.keyId.slice(0, 8) : "", secretsKeyPrevious: "ready" });
  assert.ok(!JSON.stringify(h).includes(MASTER) && !JSON.stringify(h).includes(MASTER_2) && rotating.ok && !JSON.stringify(h).includes(rotating.keyId), "health: không khoá, không mã khoá đầy đủ");
}

/* ═════════════ 2b · TỰ KIỂM KHOÁ — TRONG BỘ NHỚ, FAIL CLOSED ═════════════ */

export async function testSecretsSelfTest() {
  const env = (v: Record<string, string>) => (n: string) => v[n];
  const state = secretsKeyState(env({ PLATFORM_SECRETS_KEY: MASTER }));
  assert.ok(state.ok);
  const good = selfTestSecrets(state);
  assert.equal(good.ok, true, `khoá tốt ⇒ tự kiểm ĐẠT: ${good.reason}`);
  assert.ok(good.checks.length >= 9 && good.checks.every((c) => c.ok), "đủ các phép thử: vòng tròn, nonce, 4 lượt từ chối…");
  for (const need of ["AAD tổ chức khác", "AAD connector khác", "Khoá khác", "sửa một byte"]) assert.ok(good.checks.some((c) => c.name.includes(need)), `có phép thử «${need}»`);
  assert.equal(good.keyIdShort, `${state.keyId.slice(0, 8)}…`);
  assert.equal(good.keySource, "PLATFORM_SECRETS_KEY");
  assert.ok(!JSON.stringify(good).includes(MASTER) && !JSON.stringify(good).includes(state.keyId), "kết quả không có khoá / mã khoá đầy đủ");

  const withPrev = selfTestSecrets(secretsKeyState(env({ PLATFORM_SECRETS_KEY: MASTER_2, PLATFORM_SECRETS_KEY_PREVIOUS: MASTER })));
  assert.ok(withPrev.ok && withPrev.previous === "ready" && withPrev.checks.some((c) => c.name.includes("PREVIOUS") && c.ok), "có PREVIOUS ⇒ thêm phép thử khoá cũ, và nó đạt");

  const none = selfTestSecrets(secretsKeyState(env({})));
  assert.equal(none.ok, false);
  assert.match(none.reason ?? "", /PLATFORM_SECRETS_KEY/);

  // FAIL CLOSED: bộ giải HỎNG (bỏ qua AAD / nuốt lỗi / ném lỗi lạ) ⇒ tự kiểm HỎNG, không bao giờ "đạt".
  const ignoresAad: typeof openSecrets = (ct, b, st) => openSecrets(ct, { orgCode: SELF_TEST_ORG, connectorKey: "tu-kiem-khoa", keyId: b.keyId }, st);
  const r1 = selfTestSecrets(state, { open: ignoresAad });
  assert.equal(r1.ok, false, "bộ giải bỏ qua AAD ⇒ HỎNG");
  assert.ok(r1.checks.filter((c) => !c.ok).every((c) => c.name.includes("AAD")), "chỉ đúng hai phép thử AAD hỏng");
  const swallows: typeof openSecrets = (ct, b, st) => {
    try {
      return openSecrets(ct, b, st);
    } catch {
      return {};
    }
  };
  assert.equal(selfTestSecrets(state, { open: swallows }).ok, false, "bộ giải nuốt lỗi (trả {} thay vì ném) ⇒ HỎNG");
  const wrongError: typeof openSecrets = () => {
    throw new Error("lạ");
  };
  assert.equal(selfTestSecrets(state, { open: wrongError }).ok, false, "bộ giải ném lỗi lạ (không phải SECRETS_DECRYPT_FAILED) ⇒ HỎNG");

  // Người vận hành: chỉ tổ chức nhà + platform:operate; ĐÚNG một dòng platform_audit_log; không ghi org_connections.
  const home = await getHomeOrganization();
  const operator: SessionUser = { id: "pc-op", email: "op@nha.local", name: "Vận hành", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: home.code, name: home.name, isHome: true } };
  const viewer: SessionUser = { ...operator, id: "pc-xem", role: "VIEWER", permissions: ["dashboard:view"] };
  const otherOrg: SessionUser = { ...operator, id: "pc-khac", permissions: ["platform:operate"], organization: { code: A, name: "Khác", isHome: false } };
  const pdb = await getPlatformDb();
  const logRows = async () => pdb.select().from(schema.platformAuditLog).where(eq(schema.platformAuditLog.action, "SECRETS_SELF_TEST")).orderBy(schema.platformAuditLog.at);
  const before = (await logRows()).length;
  const conn0 = await homeFingerprint();
  assert.ok("error" in (await runSecretsSelfTest(viewer, { keyState: state })), "không có platform:operate ⇒ từ chối");
  assert.ok("error" in (await runSecretsSelfTest(otherOrg, { keyState: state })), "tổ chức khác (kể cả mang khoá platform:operate) ⇒ từ chối");
  assert.equal((await logRows()).length, before, "bị từ chối ⇒ không một dòng nhật ký");
  const ran = await runSecretsSelfTest(operator, { keyState: state });
  assert.ok(!("error" in ran) && ran.ok && ran.audited, `người vận hành ⇒ tự kiểm ĐẠT và có vết: ${JSON.stringify(ran)}`);
  const rows = await logRows();
  assert.equal(rows.length, before + 1, "ĐÚNG một dòng platform_audit_log");
  const last = rows[rows.length - 1];
  assert.equal(last.actorEmail, operator.email);
  assert.equal(last.targetOrgCode, home.code);
  assertNoSecret("nhật ký tự kiểm", [last, ran], [MASTER, state.keyId]);
  assert.deepEqual(await homeFingerprint(), conn0, "tự kiểm không ghi org_connections / settings / nhật ký kết nối");
  const broken = await runSecretsSelfTest(operator, { keyState: secretsKeyState(env({})) });
  assert.ok(!("error" in broken) && broken.ok === false && broken.checks.length === 0, "thiếu khoá ⇒ tự kiểm HỎNG, vẫn có vết");
  const act = boChuThich(doc("lib/actions/platform-secrets.ts"));
  assert.ok(/requirePermission\(\s*["']platform:operate["']\s*\)/.test(act) && /runSecretsSelfTest\(user\)/.test(act) && !/\bopenSecrets\b|orgConnections|getDb\(/.test(act), "action: đọc phiên platform:operate rồi gọi lõi — không đối số, không chạm bảng");
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

  // Lỗi MẠNG ⇒ câu đọc được, không phải «fetch failed» trần (đo UAT 30/09/2026: máy chủ không tới được api.telegram.org
  // mà màn hình chỉ in «fetch failed» — người dùng tưởng token sai). Lỗi dựng đúng hình của fetch Node: TypeError + cause.code.
  const netErr = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`${code} https://api.telegram.org/bot${TG_TOKEN}/getMe`), { code }) });
  const tgReset = await testTelegramBot({ secrets: { botToken: TG_TOKEN }, settings: { chatId: "-1001234567" }, orgName: "A" }, { fetch: fakeFetch(() => netErr("ECONNRESET")).fetch });
  assert.equal(tgReset.ok, false);
  assert.match(tgReset.message, /bị ngắt ngay khi mở \(ECONNRESET\)/, tgReset.message);
  assert.match(tgReset.message, /Lark — webhook nhóm của tổ chức/, "chỉ đường thay thế");
  assert.ok(!/fetch failed/.test(tgReset.message) && !tgReset.message.includes(TG_TOKEN), "không «fetch failed» trần, không token");
  const tgDns = await testTelegramBot({ secrets: { botToken: TG_TOKEN }, settings: { chatId: "-1001234567" }, orgName: "A" }, { fetch: fakeFetch(() => netErr("ENOTFOUND")).fetch });
  assert.match(tgDns.message, /không phân giải được tên miền api\.telegram\.org \(ENOTFOUND\)/, tgDns.message);
  const tgTimeout = await testTelegramBot({ secrets: { botToken: TG_TOKEN }, settings: { chatId: "-1001234567" }, orgName: "A" }, { fetch: fakeFetch(() => netErr("UND_ERR_CONNECT_TIMEOUT")).fetch });
  assert.match(tgTimeout.message, /hết thời gian chờ/, tgTimeout.message);
  const larkNet = await testLarkWebhook({ secrets: { webhookUrl: LARK_URL }, orgName: "A" }, { fetch: fakeFetch(() => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })).fetch });
  assert.match(larkNet.message, /open\.larksuite\.com từ chối kết nối/, larkNet.message);
  assert.ok(!larkNet.message.includes("aaaa1111"), "không mang mã hook");

  // ── Zalo Bot (bot.zaloplatforms.com): getMe rồi MỘT tin thử; phong bì {ok, result | error_code, description} ──
  const ZALO_TOKEN = "3456789012345:zAbC-dEf_ghIJkl.MNOpq";
  const ZALO_CHAT = "6ede9afa66b88fe6d6a9";
  const zOk = fakeFetch((url) => (url.endsWith("/getMe") ? { body: { ok: true, result: { account_name: "bot.hslc" } } } : { body: { ok: true, result: { message_id: "m1" } } }));
  const z = await testZaloBot({ secrets: { botToken: ZALO_TOKEN }, settings: { chatId: ZALO_CHAT }, orgName: "A" }, { fetch: zOk.fetch });
  assert.equal(z.ok, true, z.message);
  assert.deepEqual(zOk.calls.map((c) => [c.url.replace(ZALO_TOKEN, "<t>"), c.init.method, c.init.redirect]), [["https://bot-api.zaloplatforms.com/bot<t>/getMe", "POST", "manual"], ["https://bot-api.zaloplatforms.com/bot<t>/sendMessage", "POST", "manual"]], "chỉ gọi đúng địa chỉ hằng số, không theo chuyển hướng");
  assert.equal(JSON.parse(String(zOk.calls[1].init.body)).chat_id, ZALO_CHAT);
  assert.ok(!z.message.includes(ZALO_TOKEN));
  const zNone = fakeFetch(() => ({ body: { ok: true } }));
  assert.equal((await testZaloBot({ secrets: { botToken: "khong-phai" }, settings: { chatId: ZALO_CHAT }, orgName: "A" }, { fetch: zNone.fetch })).ok, false);
  const zNoChat = await testZaloBot({ secrets: { botToken: ZALO_TOKEN }, settings: { chatId: "" }, orgName: "A" }, { fetch: zNone.fetch });
  assert.ok(!zNoChat.ok && /Tìm chat/.test(zNoChat.message), "thiếu chat ⇒ chỉ tới nút Tìm chat");
  assert.equal(zNone.calls.length, 0, "đầu vào sai dạng ⇒ không gọi mạng");
  const zBad = await testZaloBot({ secrets: { botToken: ZALO_TOKEN }, settings: { chatId: ZALO_CHAT }, orgName: "A" }, { fetch: fakeFetch(() => ({ status: 200, body: { ok: false, error_code: 401, description: `Unauthorized ${ZALO_TOKEN}` } })).fetch });
  assert.ok(!zBad.ok && /Zalo không nhận token: Unauthorized/.test(zBad.message) && !zBad.message.includes(ZALO_TOKEN), zBad.message);
  const zNoSend = await testZaloBot({ secrets: { botToken: ZALO_TOKEN }, settings: { chatId: ZALO_CHAT }, orgName: "A" }, { fetch: fakeFetch((url) => (url.endsWith("/getMe") ? { body: { ok: true, result: { account_name: "bot.hslc" } } } : { body: { ok: false, error_code: 404, description: "Chat not found" } })).fetch });
  assert.ok(!zNoSend.ok && /hợp lệ nhưng không gửi được vào chat đã khai: Chat not found/.test(zNoSend.message), "token đúng mà chat sai ⇒ KHÔNG đạt");
  const zNet = await testZaloBot({ secrets: { botToken: ZALO_TOKEN }, settings: { chatId: ZALO_CHAT }, orgName: "A" }, { fetch: fakeFetch(() => netErr("ETIMEDOUT")).fetch });
  assert.match(zNet.message, /Không gọi được Zalo: Máy chủ ERP không tới được bot-api\.zaloplatforms\.com/, zNet.message);

  // Fanpage (Pancake): token đúng ⇒ danh sách 60 hội thoại DÀI hơn 64 KB vẫn phải ĐẠT (01/10/2026 báo nhầm «HTTP 200»);
  // token sai ⇒ HTTP 200 + success:false ⇒ in đúng câu của Pancake.
  const bigConvs = { success: true, conversations: Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, snippet: "x".repeat(3000), from: { name: `Khách ${i}` } })) };
  assert.ok(JSON.stringify(bigConvs).length > 64 * 1024, "dữ liệu thử phải vượt trần 64 KB");
  const fpOk = await testPancakeFanpage({ secrets: { pageAccessToken: "pancake_page_token_0123456789abcdef" }, settings: { pageId: "107401132450005" } }, { fetch: fakeFetch(() => ({ body: bigConvs })).fetch });
  assert.ok(fpOk.ok && /đọc được 60 hội thoại/.test(fpOk.message), fpOk.message);
  const fpBad = await testPancakeFanpage({ secrets: { pageAccessToken: "pancake_page_token_0123456789abcdef" }, settings: { pageId: "107401132450005" } }, { fetch: fakeFetch(() => ({ body: { message: "Invalid access_token", success: false, error_code: 102 } })).fetch });
  assert.ok(!fpBad.ok && /Invalid access_token/.test(fpBad.message), fpBad.message);
  assert.deepEqual(pancakeVerdict(200, `{"conversations":[${"{},".repeat(10)}`.padEnd(PANCAKE_TEST_MAX_BYTES + 10, " ")), { ok: true, count: null }, "quá dài để đọc hết, không dấu từ chối ⇒ đạt");

  // «Tìm chat»: getUpdates trả MỘT tin mỗi lượt ⇒ gom nhiều lượt, dừng khi Zalo báo hết tin (408).
  let zi = 0;
  const zUpd = fakeFetch(() => {
    zi += 1;
    if (zi === 1) return { body: { ok: true, result: { message: { from: { display_name: "Chủ shop" }, chat: { id: "grp123abc", chat_type: "GROUP" }, text: "@bot đây là nhóm vận hành" }, event_name: "message.text.received" } } };
    if (zi === 2) return { body: { ok: true, result: { message: { from: { display_name: "Lan" }, chat: { id: ZALO_CHAT, chat_type: "PRIVATE" }, text: "xin chào" }, event_name: "message.text.received" } } };
    return { body: { ok: false, error_code: 408, description: "Request timeout" } };
  });
  const found = await ORG_CONNECTION_CHAT_DISCOVERY["zalo-bot"]({ botToken: ZALO_TOKEN }, { fetch: zUpd.fetch });
  assert.ok(found.ok);
  assert.deepEqual(found.ok ? found.chats.map((c) => [c.id, c.type, c.name]) : [], [["grp123abc", "GROUP", "Chủ shop"], [ZALO_CHAT, "PRIVATE", "Lan"]]);
  assert.ok(zUpd.calls.every((c) => c.url.endsWith("/getUpdates") && c.init.method === "POST"), "chỉ đọc getUpdates");
  const none = await ORG_CONNECTION_CHAT_DISCOVERY["zalo-bot"]({ botToken: ZALO_TOKEN }, { fetch: fakeFetch(() => ({ body: { ok: false, error_code: 408, description: "Request timeout" } })).fetch });
  assert.ok(none.ok && none.chats.length === 0 && /Chưa thấy tin mới/.test(none.message), "không tin mới ⇒ hướng dẫn nhắn cho bot, không phải lỗi");
  const tgFound = await ORG_CONNECTION_CHAT_DISCOVERY["telegram-bot"]({ botToken: TG_TOKEN }, { fetch: fakeFetch(() => ({ body: { ok: true, result: [{ message: { chat: { id: -100123456789, type: "supergroup", title: "Vận hành" }, text: "hi" } }] } })).fetch });
  assert.deepEqual(tgFound.ok ? tgFound.chats.map((c) => [c.id, c.type, c.name]) : [], [["-100123456789", "GROUP", "Vận hành"]]);

  // Tin dài hơn trần 2000 ký tự của Zalo ⇒ tách theo DÒNG, không mất ký tự nào, không đoạn nào vượt trần.
  const longLines = Array.from({ length: 120 }, (_, i) => `• Dòng hàng số ${i} × 1 × 120.000 ₫ = 120.000 ₫`).join("\n");
  const parts = chunkText(longLines, 2000);
  assert.ok(parts.length > 1 && parts.every((x) => x.length <= 2000), "mỗi đoạn ≤ 2000");
  assert.equal(parts.join("\n"), longLines, "ghép lại đúng nguyên văn");
  assert.deepEqual(chunkText("a".repeat(4500), 2000).map((x) => x.length), [2000, 2000, 500], "dòng dài hơn trần ⇒ cắt cứng");
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

const LARK_SIGN_2 = "ky-lark-moi-sau-khi-doi-cua-a-4c3b2a";
const TG_TOKEN_B = "9876543210:BBH-bi-mat-telegram-cua-to-chuc-b_q9w8";
const TG_TOKEN_A2 = "1122334455:CCH-token-nhap-lai-cua-to-chuc-a_z7y6";
const AI_KEY_2 = "sk-ant-api03-khoa-bia-thu-hai-pc-a-9876543210abcd";
const LARK_URL_B = "https://open.larksuite.com/open-apis/bot/v2/hook/eeee5555-ffff-6666-aaaa-7777bbbb8888";
const ALL_SECRETS = [LARK_URL, LARK_SIGN, LARK_SIGN_2, TG_TOKEN, TG_TOKEN_B, TG_TOKEN_A2, AI_KEY, AI_KEY_2, LARK_URL_B, MASTER, MASTER_2, "aaaa1111-bbbb-2222-cccc-3333dddd4444", "eeee5555-ffff-6666-aaaa-7777bbbb8888"];

type RowSnap = { key: string; enc: string; kid: string | null; status: string; lastTestOk: boolean | null; activatedAt: string | null };
async function snapRows(org: string): Promise<RowSnap[]> {
  return withOrganization(org, async () =>
    (await (await getDb()).select().from(schema.orgConnections).orderBy(schema.orgConnections.connectorKey)).map((r) => ({
      key: r.connectorKey,
      enc: r.secretsEnc ? Buffer.from(r.secretsEnc).toString("hex") : "",
      kid: r.secretsKeyId,
      status: r.status,
      lastTestOk: r.lastTestOk,
      activatedAt: r.activatedAt ? r.activatedAt.toISOString() : null,
    })),
  );
}

async function rekeyAudits(org: string): Promise<unknown[]> {
  return withOrganization(org, async () => (await getDb()).select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "ORG_CONNECTION_REKEY")));
}

/** Mọi bảng `public` của CSDL đang ngữ cảnh, mỗi dòng ở dạng chữ (`bảng::text`) — để QUÉT bản rõ ở bất kỳ đâu. */
async function dumpAllTables(): Promise<string> {
  const db = await getDb();
  const names = (await db.execute(sql`select table_name as t from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`)) as unknown as { rows: { t: string }[] };
  const parts: string[] = [];
  for (const { t } of names.rows) {
    const r = (await db.execute(sql.raw(`select coalesce(string_agg(x::text, '|'), '') as s from "${t.replace(/"/g, '""')}" x`))) as unknown as { rows: { s: string }[] };
    parts.push(r.rows[0]?.s ?? "");
  }
  assert.ok(names.rows.length >= 50, `phải quét được các bảng của CSDL — mới thấy ${names.rows.length}`);
  return parts.join("\n");
}

function countOf(sum: { totals: Record<RekeyVerdict, number> }, v: RekeyVerdict) {
  return sum.totals[v];
}

/**
 * VÒNG ĐỜI BÍ MẬT TRÊN HAI TỔ CHỨC THẬT (tiếp nối trạng thái của `testConnectionsTwoOrgs`): cập nhật giữ trạng thái đúng
 * · khởi động lại vẫn giải được · khoá sai ⇒ từ chối, không bản rõ rác · A không đọc được bản mã của B · xoay khoá
 * (chạy thử không ghi, chạy thật mã hoá lại mọi dòng, chạy lại = không đổi) · QUÉT mọi bảng của A, B và nhà: không bản
 * rõ nào · QUÉT log: không bản rõ nào.
 */
async function secretsLifecycle(adminA: SessionUser, adminB: SessionUser) {
  const logs: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const original = methods.map((m) => console[m]);
  methods.forEach((m) => {
    console[m] = (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  });
  const larkOk = fakeFetch(() => ({ body: { code: 0 } }));
  const tgOk = () => fakeFetch((url) => (url.endsWith("/getMe") ? { body: { ok: true, result: { username: "bot" } } } : { body: { ok: true } }));
  const kidOf = (m: string) => {
    const s = secretsKeyState((n) => (n === "PLATFORM_SECRETS_KEY" ? m : undefined));
    assert.ok(s.ok);
    return s.keyId;
  };
  try {
    process.env.PLATFORM_SECRETS_KEY = MASTER;
    delete process.env.PLATFORM_SECRETS_KEY_PREVIOUS;

    await withOrganization(A, async () => {
      const db = await getDb();
      const rowOf = async (k: string) => (await db.select().from(schema.orgConnections).where(eq(schema.orgConnections.connectorKey, k)))[0];

      // ── CẬP NHẬT bí mật của kết nối ĐANG BẬT ⇒ về Nháp, kết quả kiểm tra cũ xoá, lúc chạy KHÔNG đọc được tới khi bật lại ──
      assert.equal((await rowOf("anthropic-byok")).status, "ACTIVE", "tiền đề: khoá AI của A đang bật");
      const upd = await saveAiConnectionAsOperator({ operator: OPERATOR_AI_REF, reason: "kiểm thử", connectorKey: "anthropic-byok", secrets: { apiKey: AI_KEY_2 } });
      assert.ok("ok" in upd && upd.status === "DRAFT", JSON.stringify(upd));
      const ai = await rowOf("anthropic-byok");
      assert.ok(ai.status === "DRAFT" && ai.lastTestOk === null && ai.activatedAt === null, "cập nhật ⇒ Nháp, xoá kết quả kiểm tra + mốc bật");
      assert.deepEqual(ai.secretHints, { apiKey: `••••${AI_KEY_2.slice(-4)}` }, "gợi ý theo giá trị MỚI");
      const blocked = await openActiveConnection("anthropic-byok");
      assert.ok(!blocked.ok && !("secrets" in blocked), "chưa kiểm tra lại ⇒ luồng chạy KHÔNG nhận bí mật (cũ lẫn mới)");
      assert.ok("ok" in (await testAiConnectionAsOperator({ connectorKey: "anthropic-byok", operator: OPERATOR_AI_REF, reason: "kiểm thử" }, { tester: { fetch: fakeFetch(() => ({ body: { data: [] } })).fetch } })));
      assert.ok("ok" in (await setAiConnectionStatusAsOperator({ connectorKey: "anthropic-byok", status: "ACTIVE", operator: OPERATOR_AI_REF, reason: "kiểm thử" })));
      const reopened = await openActiveConnection("anthropic-byok");
      assert.ok(reopened.ok && reopened.secrets.apiKey === AI_KEY_2, "kiểm tra + bật lại ⇒ đọc ra giá trị MỚI");
      // Kiểm khoá cho ops (org-ai-cutover): chỉ DẤU BĂM của khoá rời service — không bao giờ khoá, kể cả một mảnh.
      const auditRows = await aiConnectionAudit(db, A);
      assert.equal(auditRows.find((r) => r.connectorKey === "anthropic-byok")?.keyDigest, createHash("sha256").update(AI_KEY_2, "utf8").digest("hex"), "dấu băm = SHA-256 của khoá đang lưu");
      assert.ok(!JSON.stringify(auditRows).includes(AI_KEY_2.slice(-8)), "kết quả kiểm khoá không mang khoá");
      assert.equal(auditRows.find((r) => r.connectorKey === "anthropic-byok")?.status, "ACTIVE");

      // Cập nhật MỘT ô bí mật: ô kia giữ nguyên (gộp trong bản rõ, không mất webhook khi đổi khoá ký).
      const part = await saveConnection(adminA, { connectorKey: "lark-webhook", secrets: { signSecret: LARK_SIGN_2 } });
      assert.ok("ok" in part);
      assert.deepEqual((await rowOf("lark-webhook")).secretHints, { webhookUrl: "••••4444", signSecret: `••••${LARK_SIGN_2.slice(-4)}` }, "ô không nhập giữ gợi ý cũ, ô nhập đổi gợi ý");
      const callsBefore = larkOk.calls.length;
      assert.ok("ok" in (await testOrgConnection(adminA, "lark-webhook", { tester: { fetch: larkOk.fetch } })));
      assert.equal(larkOk.calls[callsBefore]?.url, LARK_URL, "webhook cũ vẫn còn trong bản mã sau khi chỉ đổi khoá ký");

      // ── "KHỞI ĐỘNG LẠI": biến môi trường mất rồi nạp lại từ .env (cùng chuỗi) ⇒ cùng mã khoá, vẫn giải được ──
      delete process.env.PLATFORM_SECRETS_KEY;
      const down = await openActiveConnection("anthropic-byok");
      assert.ok(!down.ok && /PLATFORM_SECRETS_KEY/.test(down.reason) && !("secrets" in down), "không có khoá ⇒ từ chối, không bản rõ");
      process.env.PLATFORM_SECRETS_KEY = `${MASTER.slice(0, 10)}${MASTER.slice(10)}`;
      const up = await openActiveConnection("anthropic-byok");
      assert.ok(up.ok && up.secrets.apiKey === AI_KEY_2, "nạp lại cùng khoá ⇒ giải được");
      assert.equal((await rowOf("anthropic-byok")).secretsKeyId, kidOf(MASTER), "mã khoá trên dòng = mã khoá tính lại từ cùng chuỗi");

      // ── KHOÁ SAI ⇒ từ chối, KHÔNG trả bản rõ rác — kể cả khi dòng mất mã khoá (chỉ còn thẻ xác thực đứng gác) ──
      process.env.PLATFORM_SECRETS_KEY = MASTER_2;
      const wrong = await openActiveConnection("anthropic-byok");
      assert.ok(!wrong.ok && /nhập lại/.test(wrong.reason) && !("secrets" in wrong), "khoá sai ⇒ câu nhập lại");
      const kid0 = (await rowOf("anthropic-byok")).secretsKeyId;
      await db.update(schema.orgConnections).set({ secretsKeyId: null }).where(eq(schema.orgConnections.connectorKey, "anthropic-byok"));
      const noKid = await openActiveConnection("anthropic-byok");
      assert.ok(!noKid.ok && /giải mã/.test(noKid.reason) && !("secrets" in noKid), "không mã khoá + khoá sai ⇒ GCM từ chối, không rác");
      await db.update(schema.orgConnections).set({ secretsKeyId: kid0 }).where(eq(schema.orgConnections.connectorKey, "anthropic-byok"));
      const larkCalls = larkOk.calls.length;
      const wrongTest = await testOrgConnection(adminA, "lark-webhook", { tester: { fetch: larkOk.fetch } });
      assert.ok("error" in wrongTest && /nhập lại/.test(wrongTest.error), "kiểm tra với khoá sai ⇒ câu nhập lại");
      assert.equal(larkOk.calls.length, larkCalls, "khoá sai ⇒ không một request nào rời máy");
      process.env.PLATFORM_SECRETS_KEY = MASTER;
    });

    // ── A KHÔNG đọc được của B, kể cả chép nguyên bản mã + mã khoá sang dòng của A ──
    const bRow = await withOrganization(B, async () => {
      const saved = await saveConnection(adminB, { connectorKey: "telegram-bot", settings: { chatId: "-1009876543" }, secrets: { botToken: TG_TOKEN_B } });
      assert.ok("ok" in saved, JSON.stringify(saved));
      return (await (await getDb()).select().from(schema.orgConnections).where(eq(schema.orgConnections.connectorKey, "telegram-bot")))[0];
    });
    await withOrganization(A, async () => {
      const db = await getDb();
      await db.update(schema.orgConnections).set({ secretsEnc: bRow.secretsEnc, secretsKeyId: bRow.secretsKeyId }).where(eq(schema.orgConnections.connectorKey, "telegram-bot"));
      const tg = tgOk();
      const stolen = await testOrgConnection(adminA, "telegram-bot", { tester: { fetch: tg.fetch } });
      assert.ok("error" in stolen && /giải mã/.test(stolen.error), `A không giải được bản mã của B: ${JSON.stringify(stolen)}`);
      assert.equal(tg.calls.length, 0, "không giải được ⇒ token của B không đi đâu cả");
      assertNoSecret("lỗi khi A đọc bản mã của B", stolen, ALL_SECRETS);
    });

    // ── XOAY KHOÁ ──
    const codes = [A, B];
    const beforeDeploy = { a: await snapRows(A), b: await snapRows(B) };
    // Deploy khoá MỚI kèm PREVIOUS = khoá cũ: chưa xoay mà không kết nối nào chết.
    process.env.PLATFORM_SECRETS_KEY = MASTER_2;
    process.env.PLATFORM_SECRETS_KEY_PREVIOUS = MASTER;
    await withOrganization(A, async () => {
      const live = await openActiveConnection("anthropic-byok");
      assert.ok(live.ok && live.secrets.apiKey === AI_KEY_2, "khoá mới + PREVIOUS ⇒ bí mật cũ vẫn sống trước khi xoay");
      delete process.env.PLATFORM_SECRETS_KEY_PREVIOUS;
      const dead = await openActiveConnection("anthropic-byok");
      assert.ok(!dead.ok && /nhập lại/.test(dead.reason), "thiếu PREVIOUS ⇒ bí mật cũ chết (lý do PREVIOUS phải đi qua deploy)");
      process.env.PLATFORM_SECRETS_KEY_PREVIOUS = MASTER;
    });

    // CHẠY THỬ: không một byte, không một dòng nhật ký.
    const dry = await rotateAllOrganizations({ apply: false, codes });
    assert.equal(dry.reports.length, 2, JSON.stringify(dry.skipped));
    assert.equal(countOf(dry, "WOULD_REKEY"), 3, `chạy thử: A lark + A khoá AI + B telegram mang khoá cũ — ${JSON.stringify(dry.totals)}`);
    assert.equal(countOf(dry, "DECRYPT_FAILED"), 2, "dòng chép chéo (A mang bản mã B · B mang bản mã A) ⇒ DECRYPT_FAILED, không sửa hộ");
    assert.equal(countOf(dry, "REKEYED"), 0);
    assert.equal(dry.previousRemovable, false);
    assert.equal(dry.exitCode, 2, "còn dòng cần người ⇒ mã thoát 2");
    assert.deepEqual({ a: await snapRows(A), b: await snapRows(B) }, beforeDeploy, "CHẠY THỬ không ghi một byte");
    assert.equal((await rekeyAudits(A)).length + (await rekeyAudits(B)).length, 0, "CHẠY THỬ không ghi nhật ký");

    // CHẠY THẬT: mọi dòng giải được đều sang khoá mới; trạng thái / kết quả kiểm tra / mốc bật KHÔNG đổi.
    const run = await rotateAllOrganizations({ apply: true, codes });
    assert.equal(countOf(run, "REKEYED"), 3, JSON.stringify(run.totals));
    assert.equal(countOf(run, "DECRYPT_FAILED"), 2);
    const after = { a: await snapRows(A), b: await snapRows(B) };
    for (const [org, rows] of Object.entries(after)) {
      for (const r of rows) {
        const was = beforeDeploy[org as "a" | "b"].find((x) => x.key === r.key)!;
        const rotated = run.reports.flatMap((x) => x.rows).some((x) => x.connectorKey === r.key && x.verdict === "REKEYED" && x.keyAfter?.startsWith(r.kid?.slice(0, 8) ?? "-"));
        assert.deepEqual({ status: r.status, lastTestOk: r.lastTestOk, activatedAt: r.activatedAt }, { status: was.status, lastTestOk: was.lastTestOk, activatedAt: was.activatedAt }, `${org}/${r.key}: xoay khoá không đổi trạng thái`);
        if (r.kid === kidOf(MASTER_2)) assert.ok(rotated && r.enc !== was.enc, `${org}/${r.key}: đã mã hoá lại`);
        else assert.deepEqual(r, was, `${org}/${r.key}: dòng không giải được giữ NGUYÊN (người nhập lại)`);
      }
    }
    assert.equal((await rekeyAudits(A)).length + (await rekeyAudits(B)).length, 3, "mỗi dòng mã hoá lại ĐÚNG một dòng nhật ký");
    assertNoSecret("nhật ký xoay khoá", [await rekeyAudits(A), await rekeyAudits(B), run], ALL_SECRETS);
    assert.ok(!JSON.stringify(run).includes(kidOf(MASTER)) && !JSON.stringify(run).includes(kidOf(MASTER_2)), "báo cáo chỉ có mã khoá rút gọn");

    // CHẠY LẠI = không đổi.
    const again = await rotateAllOrganizations({ apply: true, codes });
    assert.equal(countOf(again, "REKEYED"), 0, "chạy lại ⇒ không mã hoá lại gì");
    assert.equal(countOf(again, "CURRENT"), 3);
    assert.deepEqual({ a: await snapRows(A), b: await snapRows(B) }, after, "chạy lại ⇒ không byte nào đổi");

    // Gỡ PREVIOUS: mọi dòng đã xoay vẫn dùng được với CHỈ khoá mới.
    delete process.env.PLATFORM_SECRETS_KEY_PREVIOUS;
    await withOrganization(A, async () => {
      const ai = await openActiveConnection("anthropic-byok");
      assert.ok(ai.ok && ai.secrets.apiKey === AI_KEY_2, "sau xoay, bỏ PREVIOUS ⇒ vẫn đúng bản rõ");
      const n = larkOk.calls.length;
      assert.ok("ok" in (await testOrgConnection(adminA, "lark-webhook", { tester: { fetch: larkOk.fetch } })));
      assert.equal(larkOk.calls[n]?.url, LARK_URL);
      // Dòng hỏng: người nhập lại ⇒ mã hoá bằng khoá mới.
      assert.ok("ok" in (await saveConnection(adminA, { connectorKey: "telegram-bot", settings: { chatId: "-1001234567" }, secrets: { botToken: TG_TOKEN_A2 } })));
    });
    await withOrganization(B, async () => {
      const tg = tgOk();
      assert.ok("ok" in (await testOrgConnection(adminB, "telegram-bot", { tester: { fetch: tg.fetch } })));
      assert.ok(tg.calls[0]?.url.includes(`/bot${TG_TOKEN_B}/`), "B sau xoay ⇒ đúng token của B");
      const fixed = await saveConnection(adminB, { connectorKey: "lark-webhook", secrets: { webhookUrl: LARK_URL_B } });
      assert.ok("ok" in fixed, JSON.stringify(fixed));
    });
    const clean = await rotateAllOrganizations({ apply: false, codes });
    assert.ok(clean.previousRemovable && clean.exitCode === 0 && countOf(clean, "CURRENT") === 5, `nhập lại xong ⇒ được gỡ PREVIOUS: ${JSON.stringify(clean.totals)}`);

    // ── QUÉT: không bản rõ nào trong BẤT KỲ bảng nào của A, B, nhà — dạng chữ lẫn dạng hex (cột bytea) ──
    const needles = ALL_SECRETS.flatMap((s) => [s, Buffer.from(s, "utf8").toString("hex")]);
    for (const org of [A, B]) {
      const dump = await withOrganization(org, dumpAllTables);
      for (const s of needles) assert.ok(!dump.includes(s), `${org}: bảng nào đó chứa bản rõ "${s.slice(0, 6)}…"`);
    }
    const homeDump = await dumpAllTables();
    for (const s of needles) assert.ok(!homeDump.includes(s), `nhà: bảng nào đó chứa bản rõ "${s.slice(0, 6)}…"`);
  } finally {
    methods.forEach((m, i) => {
      console[m] = original[i];
    });
  }
  const logText = logs.join("\n");
  for (const s of ALL_SECRETS) assert.ok(!logText.includes(s), `log chứa bí mật "${s.slice(0, 6)}…"`);
}

export async function testConnectionsTwoOrgs() {
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  const savedPrev = process.env.PLATFORM_SECRETS_KEY_PREVIOUS;
  delete process.env.PLATFORM_SECRETS_KEY_PREVIOUS;
  const home0 = await homeFingerprint();
  for (const code of [A, B]) {
    await cleanupOrg(code);
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
    await provisionOrganization({ code, name: `Tổ chức ${code}`, modules: MODULES, admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "Conn@12345" }, source: "TEST", actor: null });
  }
  const larkOk = fakeFetch(() => ({ body: { code: 0 } }));
  const larkNo = fakeFetch(() => ({ body: { code: 19001, msg: "param invalid" } }));
  const SECRETS = [LARK_URL, LARK_SIGN, TG_TOKEN, AI_KEY, MASTER, "aaaa1111-bbbb-2222-cccc-3333dddd4444"];
  try {
    const adminA = await adminOf(A);
    const adminB = await adminOf(B);

    await withOrganization(A, async () => {
      // Thiếu khoá: màn hình nói ra, lưu bí mật bị TỪ CHỐI, không dòng nào sinh ra.
      delete process.env.PLATFORM_SECRETS_KEY;
      const v0 = (await loadConnectionsView(adminA)) as ConnectionsView;
      assert.equal(v0.secretsReady.ok, false);
      // Khách (07/10/2026): câu chung «liên hệ hỗ trợ» — tên biến môi trường / secret GitHub là thông tin vận hành nội bộ.
      assert.ok(!/PLATFORM_SECRETS_KEY|GitHub|deploy/.test(v0.secretsReady.reason ?? ""), `khách không đọc tên biến / quy trình deploy: ${v0.secretsReady.reason}`);
      assert.match(v0.secretsReady.reason ?? "", /hỗ trợ/);
      const pubNoKey = secretsKeyPublicStatus(secretsKeyState(() => undefined));
      assert.ok(!pubNoKey.ready && /secret GitHub PLATFORM_SECRETS_KEY.*deploy/.test(pubNoKey.reason), "câu cho người vận hành (nhà) vẫn nói rõ: thêm secret GitHub rồi deploy");
      assert.equal(v0.secretsReady.keyIdShort, null, "chưa có khoá ⇒ không có mã khoá");
      const noKey = await saveConnection(adminA, { connectorKey: "lark-webhook", secrets: { webhookUrl: LARK_URL } });
      assert.ok("error" in noKey && /PLATFORM_SECRETS_KEY/.test(noKey.error), "thiếu PLATFORM_SECRETS_KEY ⇒ từ chối lưu");
      assert.equal((await (await getDb()).select().from(schema.orgConnections)).length, 0, "từ chối lưu ⇒ không dòng nào");

      process.env.PLATFORM_SECRETS_KEY = MASTER;
      const rows0 = v0.groups.flatMap((g) => g.rows);
      // 07/10/2026 (lib/saas/visibility.ts): workspace KHÁCH không nhận connector chỉ-nhà, không connector AI, không mô tả nội bộ.
      for (const k of ["pancake-pos", "viettelpost", "ai-chat", "anthropic-byok", "openai-byok", "gemini-byok"]) assert.ok(!rows0.some((r) => r.key === k), `${k}: khách không thấy connector chỉ-nhà / AI`);
      for (const r of rows0) {
        assert.equal(r.homeReadiness, null, `${r.key}: tổ chức khác KHÔNG được đọc trạng thái cấu hình của nhà`);
        for (const k of ["tenancy", "why", "consumers", "webhook", "configStore"] as const) assert.ok(!(k in r), `${r.key}: khách không nhận «${k}»`);
      }
      // Quyền, module, tổ chức lệch, connector HOME_ONLY, đầu vào sai.
      const viewer: SessionUser = { ...adminA, role: "VIEWER", permissions: ["dashboard:view"] };
      assert.ok("error" in (await saveConnection(viewer, { connectorKey: "lark-webhook", secrets: { webhookUrl: LARK_URL } })), "thiếu settings:manage ⇒ từ chối");
      assert.ok("error" in (await loadConnectionsView(viewer)), "thiếu settings:manage ⇒ không xem");
      // 0180: kết nối nhắn tin theo tổ chức thuộc LÕI (luật tự động «báo nhóm» là của lõi, không của module «Cần xử lý») —
      // không tắt được theo module. Cổng module của connector vẫn nằm trong `guard()`; ở đây khoá lại rằng cả ba kết nối nhắn
      // tin theo tổ chức đều khai module lõi.
      for (const k of ["lark-webhook", "telegram-bot", "sandbox-messaging"]) assert.equal(findConnector(k)?.module, "core", `${k}: kết nối nhắn tin theo tổ chức thuộc lõi`);
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
      assert.ok(tgFetch.calls[0]?.url.includes(`/bot${TG_TOKEN}/`), "kiểm tra Telegram nhận ĐÚNG token đã giải mã");

      // Vòng tròn qua ĐƯỜNG ỨNG DỤNG (không gọi openSecrets trong bài): lưu → kiểm tra → bật → openActiveConnection (đường
      // AI Builder đọc lúc chạy) ra ĐÚNG bản rõ; màn hình / action chỉ trả •••• + 4 ký tự cuối, và mã khoá rút gọn.
      // Workspace KHÁCH không tự ghi khoá AI (lib/saas/visibility.ts): Lưu / Kiểm tra / Bật / Tắt của quản trị A đều bị lõi từ
      // chối bằng câu của khách, KHÔNG dòng nào sinh ra / đổi; người vận hành nền tảng ghi hộ qua đường riêng.
      const aiFetch = fakeFetch(() => ({ body: { data: [] } }));
      for (const r of [
        await saveConnection(adminA, { connectorKey: "anthropic-byok", secrets: { apiKey: AI_KEY } }),
        await testOrgConnection(adminA, "anthropic-byok", { tester: { fetch: aiFetch.fetch } }),
        await setConnectionStatus(adminA, "anthropic-byok", "ACTIVE"),
        await setConnectionStatus(adminA, "gemini-byok", "DISABLED"),
      ])
        assert.ok("error" in r && r.error === CUSTOMER_AI_CONFIG_MANAGED, `khách ghi khoá AI ⇒ từ chối: ${JSON.stringify(r)}`);
      assert.equal(aiFetch.calls.length, 0, "khách kiểm tra khoá AI ⇒ không một request nào rời máy");
      assert.equal((await db.select().from(schema.orgConnections).where(eq(schema.orgConnections.connectorKey, "anthropic-byok"))).length, 0, "khách lưu khoá AI ⇒ không dòng nào");
      const aiSaved = await saveAiConnectionAsOperator({ operator: OPERATOR_AI_REF, reason: "kiểm thử", connectorKey: "anthropic-byok", secrets: { apiKey: AI_KEY } });
      assert.ok("ok" in aiSaved, JSON.stringify(aiSaved));
      const aiTest = await testAiConnectionAsOperator({ connectorKey: "anthropic-byok", operator: OPERATOR_AI_REF, reason: "kiểm thử" }, { tester: { fetch: aiFetch.fetch } });
      assert.ok("ok" in aiTest, JSON.stringify(aiTest));
      const aiOn = await setAiConnectionStatusAsOperator({ connectorKey: "anthropic-byok", status: "ACTIVE", operator: OPERATOR_AI_REF, reason: "kiểm thử" });
      assert.ok("ok" in aiOn && aiOn.status === "ACTIVE");
      const opened = await openActiveConnection("anthropic-byok");
      assert.ok(opened.ok && opened.secrets.apiKey === AI_KEY, "lưu → đọc lại qua service ra ĐÚNG bản rõ");
      const vAi = (await loadConnectionsView(adminA)) as ConnectionsView;
      // Khách: khoá AI của chính họ cũng không còn trên màn Kết nối (người vận hành sửa ở /platform/org/<mã>) — kể cả gợi ý ••••.
      assert.equal(vAi.groups.flatMap((g) => g.rows).find((r) => r.key === "anthropic-byok"), undefined, "màn hình khách: không dòng khoá AI");
      assert.ok(vAi.secretsReady.ok && vAi.secretsReady.keyIdShort === null, "khách: máy chủ sẵn sàng nhưng KHÔNG in mã khoá mã hoá");
      assertNoSecret("màn hình + action của khoá AI", [vAi, aiSaved, aiTest, aiOn], SECRETS);

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

    await secretsLifecycle(adminA, adminB);
  } finally {
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    if (savedPrev === undefined) delete process.env.PLATFORM_SECRETS_KEY_PREVIOUS;
    else process.env.PLATFORM_SECRETS_KEY_PREVIOUS = savedPrev;
    for (const code of [A, B]) await cleanupOrg(code);
  }
}

/* ═════════════ 5 · QUÉT MÃ: BÍ MẬT KHÔNG CÓ ĐƯỜNG RA ═════════════ */

export function testNoSecretPathsStatic() {
  const files = tepKho().filter((t) => /\.(ts|tsx)$/.test(t) && !t.startsWith("tests/"));
  const src = new Map(files.map((f) => [f, boChuThich(doc(f))]));
  const giaiMa = files.filter((f) => /\bopenSecrets\s*\(/.test(src.get(f) ?? "") && f !== "lib/connectors/secrets.ts");
  // Ngoại lệ DUY NHẤT: script kiểm khoá của người vận hành (ops platform-secrets-verify) giải CANARY tổng hợp của chính
  // nó (tổ chức giả `__canary__`) để chứng minh khoá production giải được bản mã đã lưu qua deploy. Nó không chạm
  // `org_connections` / `secrets_enc` — hai phép quét ngay dưới vẫn chặn điều đó.
  assert.deepEqual(giaiMa, ["lib/connectors/service.ts", "scripts/platform-secrets-verify.ts"], "chỉ lib/connectors/service.ts được giải mã bí mật kết nối (cộng canary của script kiểm khoá)");
  assert.ok(!/\borgConnections\b|secretsEnc|secrets_enc/.test(src.get("scripts/platform-secrets-verify.ts") ?? ""), "script kiểm khoá không chạm bảng / cột bí mật kết nối");
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
  const exported = (action.match(/export async function /g) ?? []).length;
  const gated = (action.match(/requirePermission\(\s*CONNECTIONS_PERMISSION\s*\)/g) ?? []).length;
  assert.ok(exported >= 4 && gated === exported && (action.match(/requirePermission\(/g) ?? []).length === exported, `mọi action (${exported}) đều đọc phiên với quyền của màn hình (${gated})`);
  const page = src.get("app/(dashboard)/settings/connections/page.tsx") ?? "";
  assert.ok(page.includes("requirePermission(CONNECTIONS_PERMISSION)"), "trang gác quyền trước khi đọc");
}

export async function testConnectors() {
  const sum = testRegistryMatchesCode();
  testSecretsCrypto();
  await testSecretsSelfTest();
  await testTesters();
  testNoSecretPathsStatic();
  await testConnectionsTwoOrgs();
  console.log(
    `✓ Phase 9 · connector: sổ ${CONNECTORS.length} mục (${sum.homeOnly} chỉ nhà · ${sum.perOrg} theo tổ chức · ${Object.entries(sum.perKind)
      .map(([k, n]) => `${k} ${n}`)
      .join(" · ")}) khớp lib/integrations + route webhook + WEBHOOK_BINDINGS + CUSTOMER_CREDENTIAL_ENV · AES-256-GCM vòng tròn, nonce mới, AAD chặn chép chéo tổ chức / connector, thiếu PLATFORM_SECRETS_KEY ⇒ từ chối · kiểm tra chỉ gọi Lark / Telegram, không theo chuyển hướng · hai tổ chức thật không thấy nhau, bật chỉ sau kiểm tra đạt · nhà chỉ đọc, CSDL nhà không đổi · không đường nào trả bí mật · tự kiểm khoá trong bộ nhớ fail-closed (bộ giải hỏng ⇒ HỎNG), một dòng nhật ký nền tảng · cập nhật ⇒ Nháp, khởi động lại vẫn giải được, khoá sai ⇒ từ chối không rác, A không đọc bản mã của B · xoay khoá: PREVIOUS giữ bí mật cũ sống, chạy thử 0 byte, chạy thật mã hoá lại 3 dòng, chạy lại 0 đổi · quét mọi bảng A/B/nhà + log: không bản rõ`,
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

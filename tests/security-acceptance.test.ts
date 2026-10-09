/**
 * ═══════════ ops `security-acceptance` — BẰNG CHỨNG LAUNCH_GATE §3 (S1 · S2 · S3), CHỈ ĐỌC (scripts/security-acceptance.ts) ═══════════
 *
 *  · Thuần: máy quét bí mật (mẫu + giá trị thật của biến môi trường, không khớp nhầm băm của Next, không in chỗ khớp) · phán quyết
 *    một lượt dò cô lập (200 dựng bản ghi tổ chức kia = LEAK) · phong bì bản mã (bản rõ = PLAINTEXT) · dòng công khai không dữ liệu.
 *  · CSDL (PGlite): khách THẬT của tổ chức nhà ⇒ lượt dò mang dấu hiệu nội dung (không nằm trong đường dẫn), trang dựng bản ghi ⇒
 *    LEAK, 404 ⇒ BLOCKED; ô bí mật bản rõ gieo vào CSDL ⇒ S3 FAIL; trang công khai cài bí mật ⇒ S2 FAIL; lượt chạy CLI không lộ gì.
 *  · Mã nguồn: không câu ghi, chỉ GET, không giải mã / không chạm cột bản mã; ops-vps khai đủ bốn chỗ.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { secretsAtRestCells } from "@/lib/connectors/service";
import { getHomeOrganization } from "@/lib/platform/organizations";
import { sealSecrets, secretsKeyState } from "@/lib/connectors/secrets";
import {
  classifyEnvelope,
  classifyIsolationProbe,
  envSecretValues,
  scanForSecrets,
  securityPublicLines,
  securityVerdict,
  usableMarkers,
  type SecurityCheck,
} from "@/lib/constants/security-acceptance";
import type { HttpReply } from "@/lib/saas/acceptance";
import { homeProbes, inspectSecretCells, runProbe, summarizeS1, summarizeS3, type SecretCell } from "@/lib/saas/security-acceptance";
import { homeHostFrom, runSecurityCli } from "@/scripts/security-acceptance";

const PLANT_GOOGLE = `AIza${"Sy0123456789abcdefghijABCDEFGHIJ_-xy".slice(0, 35)}`;
const PLANT_FB = `EAAG${"x9".repeat(30)}`;
const SECRET_NAME = "Khách Bí Mật Cô Lập";
const SECRET_PHONE = "0987001122";

const reply = (status: number, body: string, location: string | null = null): HttpReply => ({ status, location, body });

export function testSecurityAcceptancePure() {
  // ── S2: máy quét ──
  const nextLike = `<script src="/_next/static/chunks/app/page-${"a1B2c3D4e5F6".repeat(4)}.js"></script><div id="${"x".repeat(40)}">Chốt Đơn</div>`;
  assert.deepEqual(scanForSecrets(nextLike), {}, "băm chunk / id dài của Next KHÔNG phải bí mật");
  const planted = `<p>${PLANT_GOOGLE}</p><p>${PLANT_FB}</p><p>postgres://u:p@db:5432/erp</p><p>AUTH_SECRET=abcdefghijklmnop123</p>`;
  const hits = scanForSecrets(planted);
  for (const k of ["GOOGLE_API_KEY", "FB_ACCESS_TOKEN", "POSTGRES_URL", "ENV_ASSIGNMENT"]) assert.ok((hits[k] ?? 0) >= 1, `${k} phải trúng: ${JSON.stringify(hits)}`);
  assert.ok(!JSON.stringify(hits).includes(PLANT_GOOGLE) && !JSON.stringify(hits).includes("postgres://"), "kết quả quét chỉ có TÊN mẫu + số, không chỗ khớp");
  const env = envSecretValues({ AUTH_SECRET: "gia-tri-bi-mat-that-0123456789", NEXT_PUBLIC_VAPID_PUBLIC_KEY: "khoa-cong-khai-0123456789abc", NODE_ENV: "production", SHORT_TOKEN: "ngan" });
  assert.deepEqual(env.map((e) => e.name), ["ENV:AUTH_SECRET"], "chỉ biến bí mật đủ dài; biến PUBLIC cố ý có trong trang bị loại");
  assert.deepEqual(scanForSecrets("<p>gia-tri-bi-mat-that-0123456789 và gia-tri-bi-mat-that-0123456789</p>", env), { "ENV:AUTH_SECRET": 2 });

  // ── S1: phán quyết một lượt dò ──
  const base = { kind: "DETAIL" as const, requestedPath: "/orders/123", finalPath: "/orders/123", markers: [SECRET_NAME], loginRedirect: false };
  assert.equal(classifyIsolationProbe({ ...base, status: 404, body: "" }), "BLOCKED");
  assert.equal(classifyIsolationProbe({ ...base, status: 200, body: "<h1>Không tìm thấy dữ liệu</h1>" }), "BLOCKED");
  assert.equal(classifyIsolationProbe({ ...base, status: 200, body: `<h1>Đơn của ${SECRET_NAME}</h1>` }), "LEAK", "200 dựng bản ghi của tổ chức kia = RÒ");
  assert.equal(classifyIsolationProbe({ ...base, status: 404, body: `<p>${SECRET_NAME}</p>` }), "LEAK", "dấu hiệu nội dung thắng mã HTTP");
  assert.equal(classifyIsolationProbe({ ...base, status: 200, body: "<h1>Đơn hàng</h1>" }), "UNSURE", "200 đúng đường dẫn mà không chứng minh được ⇒ không kết luận an toàn");
  assert.equal(classifyIsolationProbe({ ...base, finalPath: "/ai/sales-chatbot/inbox?forbidden=1", status: 200, body: "<h1>Hộp thư</h1>" }), "BLOCKED");
  assert.equal(classifyIsolationProbe({ ...base, status: 200, body: "", loginRedirect: true }), "SESSION_REJECTED");
  assert.equal(classifyIsolationProbe({ ...base, kind: "API", markers: [], status: 200, body: "" }), "LEAK");
  assert.equal(classifyIsolationProbe({ ...base, kind: "API", markers: [], status: 404, body: "Không tìm thấy ảnh" }), "BLOCKED");
  assert.equal(classifyIsolationProbe({ ...base, kind: "LIST", requestedPath: "/inbox?c=1", finalPath: "/inbox?c=1", status: 200, body: "<ul></ul>" }), "BLOCKED");
  assert.equal(classifyIsolationProbe({ ...base, kind: "LIST", markers: [], requestedPath: "/inbox?c=1", finalPath: "/inbox?c=1", status: 200, body: "<ul></ul>" }), "SKIPPED");
  assert.deepEqual(usableMarkers(["Lan", "0987001122", SECRET_NAME, "", null], "/customers/0987001122"), [SECRET_NAME], "bỏ dấu hiệu ngắn và dấu hiệu nằm trong đường dẫn (trang nào cũng lặp lại tham số)");

  // ── S3: phong bì ──
  const key = secretsKeyState((n) => (n === "PLATFORM_SECRETS_KEY" ? "khoa-kiem-thu-bao-mat-0123456789abcdefghij" : undefined));
  const sealed = sealSecrets({ pageAccessToken: PLANT_FB }, { orgCode: "sa-org", connectorKey: "meta-messenger" }, key);
  assert.equal(classifyEnvelope(sealed.ciphertext, sealed.keyId), "ENCRYPTED");
  assert.equal(classifyEnvelope(Buffer.from(JSON.stringify({ pageAccessToken: PLANT_FB })), null), "PLAINTEXT");
  assert.equal(classifyEnvelope(Buffer.from(JSON.stringify({ pageAccessToken: PLANT_FB })), sealed.keyId), "PLAINTEXT", "mã khoá hợp lệ không cứu được byte bản rõ");
  assert.equal(classifyEnvelope(null, null), "EMPTY");
  assert.equal(classifyEnvelope(Uint8Array.from([7, 0, 1, 2, 3]), null), "MALFORMED");
  const s3 = summarizeS3([
    { orgCode: "sa-org", category: "ket_noi", verdict: classifyEnvelope(sealed.ciphertext, sealed.keyId) },
    { orgCode: "sa-org-2", category: "token_page", verdict: classifyEnvelope(Buffer.from(PLANT_FB), null) },
  ]);
  assert.equal(s3.status, "FAIL");
  assert.deepEqual(s3.counts, { "ket_noi:ENCRYPTED": 1, "token_page:PLAINTEXT": 1 });
  assert.equal(summarizeS3([{ orgCode: "sa-org", category: "ket_noi", verdict: "ENCRYPTED" }, { orgCode: "sa-org", category: "ket_noi", verdict: "EMPTY" }]).status, "PASS", "phong bì + ô trống ⇒ ĐẠT");
  assert.equal(summarizeS3([{ orgCode: "sa-org", category: "ket_noi", verdict: "FOREIGN_ORG" }]).status, "FAIL", "dòng mang mã tổ chức khác ⇒ hỏng");

  // ── Dòng công khai: không dữ liệu ──
  const checks: SecurityCheck[] = [
    { key: "S1", ...summarizeS1([]), detail: [SECRET_NAME] },
    { key: "S2", status: "FAIL", counts: { trang: 3, trung: 1, GOOGLE_API_KEY: 1, [`${SECRET_NAME}`]: 9 }, note: null, detail: [PLANT_GOOGLE] },
    { key: "S3", status: s3.status, counts: s3.counts, note: null, detail: ["sa-org-2: BẢN RÕ 1"] },
  ];
  const pub = securityPublicLines(checks).join("\n");
  assert.equal(securityVerdict(checks), "FAIL");
  assert.match(pub, /^security-acceptance: FAIL · hỏng S2, S3 · CHƯA ĐO ĐƯỢC S1/);
  assert.match(pub, /S2 bí mật không lộ trong trang: FAIL · trang 3 · trung 1 · GOOGLE_API_KEY 1/);
  for (const bad of [SECRET_NAME, PLANT_GOOGLE, "sa-org", "@"]) assert.ok(!pub.includes(bad), `dòng công khai không mang «${bad}»`);
  assert.equal(homeHostFrom("https://erp.vnx.test/x"), "erp.vnx.test");
  assert.equal(homeHostFrom(undefined), "127.0.0.1:3000");
  console.log("✓ security-acceptance thuần: quét bí mật (mẫu + giá trị thật, không khớp nhầm băm Next) · 200 dựng bản ghi tổ chức kia = RÒ · bản rõ = FAIL · công khai chỉ trạng thái + số");
}

export function testSecurityAcceptanceSource() {
  const strip = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const f of ["scripts/security-acceptance.ts", "lib/saas/security-acceptance.ts", "lib/constants/security-acceptance.ts"]) {
    const code = strip(f);
    assert.ok(!/\.(insert|update|delete|execute|transaction)\s*\(|onConflict|returning\s*\(|\bsql\s*`/.test(code), `${f}: không câu ghi / SQL thô`);
    for (const w of ["openSecrets", "secretsEnc", "secrets_enc", "orgConnections", "audit(", "setSetting", "recordAuthFailure", "runJob", "requestProvisioning", "method:", "fetch("]) assert.ok(!code.includes(w), `${f}: không ${w}`);
    assert.ok(!/["'](?:POST|PUT|PATCH|DELETE)["']/.test(code), `${f}: chỉ GET`);
  }
  // S3: hàm đọc ô bản mã sống ở lib/connectors/service.ts (nơi DUY NHẤT chạm cột ấy), chỉ SELECT, không giải mã, chỉ trả loại ô + phán quyết.
  const svc = strip("lib/connectors/service.ts");
  const fn = /export async function secretsAtRestCells\([\s\S]*?\n\}/.exec(svc)?.[0] ?? "";
  assert.ok(fn.length > 100, "có hàm secretsAtRestCells");
  assert.ok(!/openSecrets|sealSecrets|\.(insert|update|delete|execute)\s*\(|getDb\(/.test(fn), "secretsAtRestCells: không giải mã, không ghi, không mở CSDL theo ngữ cảnh (nhận handle chỉ đọc)");
  assert.match(fn, /return \[\.\.\.conns\.map\(\(r\) => \(\{ category: "org_connections" as const, verdict: verdictOf\(r\) \}\)\)/, "chỉ trả loại ô + phán quyết");
  assert.match(strip("lib/saas/security-acceptance.ts"), /getDbForInspection\(org\)/, "S3 mở CSDL tổ chức bằng getDbForInspection (không migrate)");
  assert.match(strip("scripts/security-acceptance.ts"), /readSecretCells: inspectSecretCells/, "script nối đường đọc S3 thật");
  assert.match(readFileSync("scripts/security-acceptance.ts", "utf8"), /if \(CHAY_THANG\) process\.env\.ERP_READ_ONLY = "1"/);
  assert.match(strip("scripts/security-acceptance.ts"), /platformReadOnlyConfirmed\)\(\)/);
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- security-acceptance\s+#/);
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bsecurity-acceptance\b/);
  assert.match(ops, /DOC_NANG="[^"]*\bsecurity-acceptance\b/);
  assert.match(ops, /\n\s+security-acceptance\)\n[\s\S]*?ma_hoa_ket_qua chay_voi_arg docker exec erp-app npx tsx --tsconfig tsconfig\.json scripts\/security-acceptance\.ts ;;/);
  console.log("✓ security-acceptance mã nguồn: không câu ghi · chỉ GET · không giải mã / không chạm cột bản mã · ERP_READ_ONLY + hỏi lại Postgres · ops-vps khai đủ bốn chỗ");
}

/** CSDL (PGlite của bộ kiểm thử). */
export async function testSecurityAcceptanceDb() {
  const db = await getDb();
  const CUSTOMER_ID = "sa-khach-bi-mat";
  await db.delete(schema.customers).where(eq(schema.customers.id, CUSTOMER_ID));
  await db.insert(schema.customers).values({ id: CUSTOMER_ID, name: SECRET_NAME, phone: SECRET_PHONE });
  try {
    // S1: khách THẬT của tổ chức nhà ⇒ lượt dò /customers/<id> mang dấu hiệu nội dung (tên + SĐT), id không in.
    const probes = await homeProbes();
    const cust = probes.find((p) => p.label.startsWith("/customers/"))!;
    assert.equal(cust.path, `/customers/${CUSTOMER_ID}`);
    assert.ok(cust.markers.includes(SECRET_NAME) && cust.markers.includes(SECRET_PHONE), JSON.stringify(cust.markers.length));
    assert.ok(probes.every((p) => !p.label.includes(CUSTOMER_ID)), "nhãn in ra không mang id");
    const leak = await runProbe(async () => reply(200, `<h1>${SECRET_NAME}</h1>`), cust, "app.chotdon.test", "erp_session=x");
    assert.equal(leak.verdict, "LEAK");
    assert.ok(!leak.why.includes(SECRET_NAME), "câu giải thích không mang dấu hiệu nội dung");
    const blocked = await runProbe(async () => reply(404, "<h1>Không tìm thấy dữ liệu</h1>"), cust, "app.chotdon.test", "erp_session=x");
    assert.equal(blocked.verdict, "BLOCKED");
    const kicked = await runProbe(async () => reply(307, "", "/login?reason=expired"), cust, "app.chotdon.test", "erp_session=x");
    assert.equal(kicked.verdict, "SESSION_REJECTED");
    assert.equal(summarizeS1([leak, blocked]).status, "FAIL");
    assert.equal(summarizeS1([blocked]).status, "PASS");

    // CLI trọn vòng với ứng dụng GIẢ: trang công khai cài bí mật ⇒ S2 FAIL; ô bí mật bản rõ ⇒ S3 FAIL; công khai không lộ gì.
    const plainCells: SecretCell[] = [{ orgCode: "sa-org-that", category: "token_page", verdict: "PLAINTEXT" }];
    const out: string[] = [];
    const leaky = await runSecurityCli([], { appGet: async (p) => (p === "/pricing" ? reply(200, `<p>${PLANT_GOOGLE}</p>`) : reply(200, "<p>sạch</p>")), env: {}, baseDomain: null, homeHost: "erp.test", readSecretCells: async (o) => (o.isHome ? plainCells : []) }, { readOnlyGuard: async () => true, emit: (l) => out.push(l) });
    assert.equal(leaky.code, 1);
    const S2 = leaky.checks.find((c) => c.key === "S2")!;
    const S3 = leaky.checks.find((c) => c.key === "S3")!;
    assert.ok(S2.status === "FAIL" && S2.counts.GOOGLE_API_KEY >= 1, JSON.stringify(S2.counts));
    assert.equal(S3.status, "FAIL");
    const pub = out.filter((l) => l.startsWith("[ops:tom-tat] ")).join("\n");
    assert.match(pub, /S3 token mã hoá khi nằm yên: FAIL · to_chuc \d+ · o 1 · token_page:PLAINTEXT 1 /);
    for (const bad of [PLANT_GOOGLE, PLANT_FB, "sa-org-that", SECRET_NAME, SECRET_PHONE, CUSTOMER_ID]) assert.ok(!pub.includes(bad), `công khai không mang «${bad}»`);
    for (const bad of [PLANT_GOOGLE, PLANT_FB, SECRET_NAME, SECRET_PHONE, CUSTOMER_ID]) assert.ok(!out.join("\n").includes(bad), `cả phần mã hoá cũng không in «${bad}»`);
    assert.ok(out.some((l) => l.includes("sa-org-that: mã hoá 0 · trống 0 · BẢN RÕ 1")), "mã tổ chức chỉ ở phần mã hoá");
    const clean = await runSecurityCli([], { appGet: async () => reply(200, "<p>sạch</p>"), env: {}, baseDomain: null, homeHost: "erp.test", readSecretCells: null }, { readOnlyGuard: async () => true, emit: () => undefined });
    assert.equal(clean.checks.find((c) => c.key === "S2")!.status, "PASS");
    assert.equal(clean.checks.find((c) => c.key === "S3")!.status, "SKIP", "chưa có đường đọc bản mã được phép ⇒ CHƯA ĐO ĐƯỢC, không giả PASS");
    assert.equal((await runSecurityCli(["--x"], {}, { readOnlyGuard: async () => true, emit: () => undefined })).code, 64);
    assert.equal((await runSecurityCli([], {}, { readOnlyGuard: async () => false, emit: () => undefined })).code, 70);
  } finally {
    await db.delete(schema.customers).where(eq(schema.customers.id, CUSTOMER_ID));
  }
  console.log("✓ security-acceptance CSDL: khách thật của nhà ⇒ trang dựng bản ghi = RÒ, 404 = CHẶN, bị đá về /login = phiên hỏng · bí mật cài vào trang ⇒ S2 FAIL · ô bản rõ ⇒ S3 FAIL · phần mã hoá không in id / dấu hiệu / bí mật");
}

/** S3 trên CSDL thật: ô bản rõ ⇒ FAIL, phong bì ⇒ PASS; hàm không trả byte / bản rõ nào. */
export async function testSecretsAtRestDb() {
  const db = await getDb();
  const home = await getHomeOrganization();
  const KEYS = ["sa-plain-test", "sa-sealed-test", "sa-foreign-test"];
  const cleanup = async () => {
    for (const k of KEYS) await db.delete(schema.orgConnections).where(eq(schema.orgConnections.connectorKey, k));
    await db.delete(schema.orgChannelPages).where(eq(schema.orgChannelPages.connectorKey, "sa-page-test"));
  };
  await cleanup();
  const key = secretsKeyState((n) => (n === "PLATFORM_SECRETS_KEY" ? "khoa-kiem-thu-bao-mat-0123456789abcdefghij" : undefined));
  const sealed = sealSecrets({ apiKey: PLANT_GOOGLE }, { orgCode: home.code, connectorKey: "sa-sealed-test" }, key);
  const tally = (cells: { verdict: string }[]) => cells.reduce<Record<string, number>>((m, c) => ((m[c.verdict] = (m[c.verdict] ?? 0) + 1), m), {});
  const before = tally(await secretsAtRestCells(db, home.code));
  const delta = (after: Record<string, number>, k: string) => (after[k] ?? 0) - (before[k] ?? 0);
  try {
    await db.insert(schema.orgConnections).values({ orgCode: home.code, connectorKey: "sa-sealed-test", secretsEnc: sealed.ciphertext, secretsKeyId: sealed.keyId });
    await db.insert(schema.orgChannelPages).values({ orgCode: home.code, connectorKey: "sa-page-test", pageId: "123", secretsEnc: sealSecrets({ pageAccessToken: PLANT_FB }, { orgCode: home.code, connectorKey: "sa-page-test#page:123" }, key).ciphertext, secretsKeyId: sealed.keyId });
    const ok = await secretsAtRestCells(db, home.code);
    assert.ok(ok.every((c) => Object.keys(c).sort().join(",") === "category,verdict"), `hàm chỉ trả loại ô + phán quyết: ${JSON.stringify(ok[0])}`);
    assert.ok(!JSON.stringify(ok).includes(PLANT_GOOGLE) && !JSON.stringify(ok).includes(PLANT_FB), "không bản rõ nào rời hàm");
    assert.equal(delta(tally(ok), "ENCRYPTED"), 2, "hai ô phong bì ⇒ ENCRYPTED");
    assert.equal(summarizeS3(ok.map((c) => ({ orgCode: home.code, ...c }))).status, "PASS", "chỉ phong bì ⇒ S3 ĐẠT");
    // Ô BẢN RÕ gieo thẳng vào CSDL (đúng loại lỗi S3 phải bắt) + một dòng mang mã tổ chức khác.
    await db.insert(schema.orgConnections).values({ orgCode: home.code, connectorKey: "sa-plain-test", secretsEnc: Buffer.from(JSON.stringify({ accessToken: PLANT_FB })), secretsKeyId: null });
    await db.insert(schema.orgConnections).values({ orgCode: "to-chuc-khac", connectorKey: "sa-foreign-test", secretsEnc: sealed.ciphertext, secretsKeyId: sealed.keyId });
    const viaReader = await inspectSecretCells({ code: home.code, isHome: true });
    const t = tally(viaReader);
    assert.equal(delta(t, "PLAINTEXT"), 1, "ô bản rõ ⇒ PLAINTEXT");
    assert.equal(delta(t, "FOREIGN_ORG"), 1, "dòng mang mã tổ chức khác ⇒ FOREIGN_ORG");
    assert.ok(!JSON.stringify(viaReader).includes(PLANT_FB), "không bản rõ nào rời hàm");
    assert.equal(summarizeS3(viaReader).status, "FAIL", "ô bản rõ ⇒ S3 HỎNG");
  } finally {
    await cleanup();
  }
  console.log("✓ security-acceptance S3 (CSDL): secretsAtRestCells chỉ SELECT, không giải mã, chỉ trả loại ô + phán quyết · phong bì ⇒ ĐẠT · bản rõ / mã tổ chức khác ⇒ HỎNG");
}

export async function testSecurityAcceptance() {
  testSecurityAcceptancePure();
  testSecurityAcceptanceSource();
  await testSecurityAcceptanceDb();
  await testSecretsAtRestDb();
}

if (/security-acceptance\.test\.ts$/.test(process.argv[1] ?? "")) testSecurityAcceptance().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

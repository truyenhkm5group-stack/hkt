/**
 * ═══════════ NGHIỆM THU KHÁCH CHỐT ĐƠN — OPS `saas-acceptance` (lib/saas/acceptance.ts · lib/constants/saas-acceptance.ts) ═══════════
 *
 * Lượt đi vai KHÁCH trên production phải tự chứng minh được những điều nó hứa, và KHÔNG được làm những điều nó hứa không làm:
 *
 *  1. LÁ CHẮN SỔ KHAI — mã ngoài sổ ⇒ từ chối TRƯỚC mọi lượt đọc / ghi (không job, không tổ chức); đường phát liên kết của máy
 *     (`createAcceptanceResetLink`) từ chối mọi cặp (workspace, email) ngoài sổ; một workspace TRÙNG mã mà không do ops tạo ⇒ không
 *     bước nào chạm vào nó (mật khẩu chủ thật vẫn nguyên).
 *  2. `--apply` lần đầu tạo workspace qua ĐÚNG job «Tạo khách» (máy, `actor = null`); lần hai idempotent — một job, một tài khoản,
 *     một tổ chức, một dòng chỉ mục.
 *  3. Đăng nhập email KHÔNG mã tổ chức ra đúng workspace thử; mật khẩu sai bị từ chối.
 *  4. Sau lượt chạy, mật khẩu đã dùng KHÔNG còn đăng nhập được (xoay rồi vứt).
 *  5. Toàn bộ stdout / stderr của lượt chạy không chứa mật khẩu, mã liên kết, phiên ký, AUTH_SECRET.
 *  6. Danh sách tuyến của vỏ DẪN XUẤT từ sổ khai của vỏ — khác rỗng, trùng nguồn nav, kèm `/` và một tuyến ERP bị chặn.
 *  7. E2E với AI giả (cơ chế của tests/e2e-ai-sales-platform.test.ts): thiếu chuẩn bị ⇒ SKIP, KHÔNG tự ghi gì; đủ chuẩn bị ⇒ chat
 *     web → AI → đơn CONFIRMED đúng SKU · SL · SĐT · xã trong OMS, ops không tạo sản phẩm / không đổi cấu hình bot.
 *
 * (8 — loại workspace thử khỏi chỉ số buồng lái — CHƯA làm: đụng rộng, xem docs/saas/ACCEPTANCE.md §6.)
 *
 * Tổ chức THẬT trên PGlite mang đúng mã của sổ khai; tự dọn trước và sau. Mốc thời gian theo đồng hồ thật (AGENTS 50 · 65).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, like } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, releaseOrganizationDb, schema } from "@/db";
import type { AiBlock } from "@/lib/ai/provider";
import { resolveRecipientPlace } from "@/lib/address/vn-address";
import { credentialsMatch, matchingLoginOrganizations } from "@/lib/auth/login";
import { resolvePermissions } from "@/lib/auth/permissions";
import { verifySessionToken, type SessionUser } from "@/lib/auth/session";
import {
  ACCEPTANCE_ACTOR_LABEL,
  ACCEPTANCE_ORDER,
  ACCEPTANCE_REGISTRY_REFUSAL,
  ACCEPTANCE_SAMPLE_PRODUCTS,
  ACCEPTANCE_SUMMARY_MAX,
  ACCEPTANCE_WORKSPACES,
  acceptanceChatTurns,
  acceptanceIdempotencyKey,
  acceptanceOrderNote,
  acceptanceRegistryProblems,
  acceptanceSummary,
  acceptanceWorkspaceOf,
  formatStepLine,
  PAGE_ERROR_DIGEST,
  PAGE_ERROR_MARKER,
  parseAcceptanceArgs,
  scrubSecrets,
  type StepResult,
} from "@/lib/constants/saas-acceptance";
import { ERP_FRAME_HTML_MARKERS, SALES_AGENT_DENIED_PREFIXES, SALES_AGENT_SHELL_HTML_MARKER, salesAgentNavFor, salesAgentPathAllowed, salesAgentRedirectFor, type ShellUser } from "@/lib/constants/saas-nav";
import { env } from "@/lib/env";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { HOST_NOT_FOUND_MESSAGE } from "@/lib/platform/host-org";
import { findOrganization, getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { publishOrganization, setDomainSlug } from "@/lib/platform/publish";
import { CHOTDON_ASSETS } from "@/lib/platform/site-host";
import { createProductCore } from "@/lib/records/product-create";
import { deniedLanding, metaRedirectTarget, probeShellRoute, publicChatProblem, runAcceptance, shellBodyProblem, shellRoutesFor, type AcceptanceDeps, type AcceptanceReport, type HttpReply } from "@/lib/saas/acceptance";
import { foldVi } from "@/lib/sales-chatbot/catalog";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { setSalesChatProviderForTests } from "@/lib/sales-chatbot/engine";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { createAcceptanceResetLink } from "@/lib/users/password-reset";
import { runAcceptanceCli } from "@/scripts/saas-acceptance";
import { fakeProvider } from "./e2e-ai-sales-platform.test";

const goc = path.resolve(__dirname, "..");
const ENTRY = ACCEPTANCE_WORKSPACES[0];
const CODE = ENTRY.code;
/** Miền gốc giả của tên miền con — đưa vào lõi qua `deps.baseDomain`, không đụng biến môi trường của tiến trình. */
const BASE = "nt.erp.test";
const APP_HOST = "app.chotdontudong.com";
const SQUAT_EMAIL = "chu-that@khach-trung-ma.vn";
const SQUAT_PW = "KhachThat@2026xyz";

const reply = (status: number, location: string | null, body: string): HttpReply => ({ status, location, body });

/** Ứng dụng GIẢ cho bước C / E: cổng vỏ bằng ĐÚNG hàm của vỏ; phiên kiểm bằng ĐÚNG hàm đọc phiên. */
function fakeApp(opts: { userId: () => Promise<string | null>; shopName: string; leakErp?: boolean }): AcceptanceDeps["appGet"] {
  return async (p, req) => {
    const pathname = p.split("?")[0];
    if (pathname === "/chat") {
      if (req.host !== `${ENTRY.domainSlug}.${BASE}`) return reply(200, null, `<h1>Chưa mở chat</h1><p>${HOST_NOT_FOUND_MESSAGE}</p>`);
      return reply(200, null, `<html><body><h1>${opts.shopName}</h1><p>Chat với Trợ lý</p></body></html>`);
    }
    if (req.host !== APP_HOST) return reply(200, null, '<html><a aria-label="VNXcommerce — về trang tổng quan" href="/">x</a></html>');
    const token = /(?:^|;\s*)erp_session=([^;]+)/.exec(req.cookie ?? "")?.[1];
    const who = token ? await verifySessionToken(token) : null;
    if (!who || who.id !== (await opts.userId())) return reply(307, "/login?reason=expired", "");
    const user: ShellUser = { role: "ADMIN", permissions: [], organization: { isHome: false, brand: "chotdon" }, modules: ["core", "customers", "products", "orders", "inventory", "ai_sales"] };
    if (!salesAgentPathAllowed(pathname)) return reply(307, salesAgentRedirectFor(user, pathname), "");
    const frame = opts.leakErp ? '<a aria-label="VNXcommerce — về trang tổng quan" href="/">ERP</a>' : `<div class="flex min-h-screen" ${SALES_AGENT_SHELL_HTML_MARKER}>`;
    return reply(200, null, `<html><head><link rel="manifest" href="${CHOTDON_ASSETS.manifest}"/></head><body>${frame}<main>${pathname}</main></div></body></html>`);
  };
}

/** Mật khẩu biết trước (bài kiểm cần biết để kiểm «mật khẩu cũ chết»); production sinh bằng crypto và không ai thấy. */
function passwordBook() {
  const issued: string[] = [];
  let n = 0;
  return { issued, next: () => { const p = `NtKiem-${++n}-${Math.random().toString(36).slice(2, 10)}-Zq9`; issued.push(p); return p; } };
}

async function acceptanceUserId(): Promise<string | null> {
  const pdb = await getPlatformDb();
  const [row] = await pdb.select({ userId: schema.platformIdentities.userId }).from(schema.platformIdentities).where(and(eq(schema.platformIdentities.orgCode, CODE), eq(schema.platformIdentities.value, ENTRY.ownerEmail))).limit(1);
  return row?.userId ?? null;
}

function deps(runId: string, book: ReturnType<typeof passwordBook>, over: Partial<AcceptanceDeps> = {}): Partial<AcceptanceDeps> {
  return {
    now: () => new Date(),
    runId,
    appGet: fakeApp({ userId: acceptanceUserId, shopName: ENTRY.name }),
    publicGet: async (url) => (url === `https://${ENTRY.domainSlug}.${BASE}/chat` ? reply(200, null, `<h1>${ENTRY.name}</h1>`) : reply(404, null, "")),
    newPassword: book.next,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    emit: (line) => console.log(line),
    siteEnv: { CHOTDON_DOMAIN: "chotdontudong.com" },
    baseDomain: BASE,
    ...over,
  };
}

/** Bắt TOÀN BỘ stdout + stderr của một lượt (console.log / warn / error của mọi tầng đều đi qua hai luồng này). */
async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
  const chunks: string[] = [];
  const ow = process.stdout.write.bind(process.stdout);
  const ew = process.stderr.write.bind(process.stderr);
  const grab = (chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    return true;
  };
  process.stdout.write = grab as typeof process.stdout.write;
  process.stderr.write = grab as typeof process.stderr.write;
  try {
    const value = await fn();
    return { value, out: chunks.join("") };
  } finally {
    process.stdout.write = ow;
    process.stderr.write = ew;
  }
}

/**
 * (5) Không bí mật nào lọt ra — mật khẩu đã phát, AUTH_SECRET, đường liên kết đặt lại, phiên ký (JWT). `summaries` = số dòng công
 * khai phải có: lượt qua script ops ⇒ ĐÚNG MỘT; gọi thẳng lõi ⇒ 0.
 */
function assertNoSecrets(out: string, book: ReturnType<typeof passwordBook>, label: string, summaries = 1) {
  for (const p of book.issued) assert.ok(!out.includes(p), `${label}: lộ một mật khẩu đã sinh`);
  assert.ok(!out.includes(env.authSecret), `${label}: lộ AUTH_SECRET`);
  assert.ok(!/\/reset\/[^\s/]+\/[A-Za-z0-9_-]{20,}/.test(out), `${label}: lộ liên kết đặt lại / kích hoạt`);
  assert.ok(!/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(out), `${label}: lộ phiên ký (JWT)`);
  assert.equal(out.match(/^\[ops:tom-tat\] /gm)?.length ?? 0, summaries, `${label}: phải có ĐÚNG ${summaries} dòng công khai [ops:tom-tat]`);
}

const stepOf = (r: AcceptanceReport, key: StepResult["key"]) => r.results.find((x) => x.key === key)!;

function summaryLine(out: string): string {
  return /^\[ops:tom-tat\] (.*)$/m.exec(out)?.[1] ?? "";
}

async function cleanup() {
  const pdb = await getPlatformDb();
  const codes = [CODE];
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, CODE) });
  await pdb.delete(schema.platformProductSubscriptions).where(inArray(schema.platformProductSubscriptions.orgCode, codes));
  await pdb.delete(schema.platformProvisioningJobs).where(like(schema.platformProvisioningJobs.idempotencyKey, "saas-acceptance:%"));
  await pdb.delete(schema.platformIdentities).where(inArray(schema.platformIdentities.orgCode, codes));
  await pdb.delete(schema.platformSubscriptions).where(inArray(schema.platformSubscriptions.orgCode, codes));
  await pdb.delete(schema.platformPricePins).where(inArray(schema.platformPricePins.orgCode, codes));
  await pdb.delete(schema.platformUsageEvents).where(inArray(schema.platformUsageEvents.orgCode, codes));
  await pdb.delete(schema.platformAiUsage).where(inArray(schema.platformAiUsage.orgCode, codes));
  await pdb.delete(schema.platformSaasDaily).where(inArray(schema.platformSaasDaily.orgCode, codes));
  await pdb.delete(schema.platformOrgMilestones).where(inArray(schema.platformOrgMilestones.orgCode, codes));
  await pdb.delete(schema.platformTenantUsageDaily).where(inArray(schema.platformTenantUsageDaily.orgCode, codes));
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
    await pdb.delete(schema.platformOrgPricing).where(eq(schema.platformOrgPricing.orgCode, CODE));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  const accountIds = [...new Set([org?.accountId ?? null, ...(await pdb.select({ id: schema.platformAccounts.id }).from(schema.platformAccounts).where(eq(schema.platformAccounts.code, ENTRY.accountCode))).map((a) => a.id)].filter((x): x is string => Boolean(x)))];
  if (accountIds.length) {
    await pdb.delete(schema.platformProductSubscriptions).where(inArray(schema.platformProductSubscriptions.accountId, accountIds));
    await pdb.delete(schema.platformAccounts).where(inArray(schema.platformAccounts.id, accountIds));
  }
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, codes));
  await releaseOrganizationDb(CODE);
  rmSync(organizationDatabaseUrl({ code: CODE, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  invalidateOrganizations();
  invalidateCapabilities();
}

// ═══════════ 1 · THUẦN ═══════════

function testPure() {
  // Sổ khai tự kiểm + lá chắn so khớp CHÍNH XÁC.
  assert.deepEqual(acceptanceRegistryProblems(), [], "sổ khai nghiệm thu phải hợp lệ");
  assert.ok(ACCEPTANCE_WORKSPACES.length >= 1);
  assert.equal(acceptanceWorkspaceOf(` ${CODE.toUpperCase()} `)?.code, CODE);
  for (const bad of ["hslc-hmt-shop", "", null, undefined, `${CODE}-x`, CODE.slice(0, -1), "vnx"]) assert.equal(acceptanceWorkspaceOf(bad), null, `mã ${String(bad)} không thuộc sổ`);
  const xau = acceptanceRegistryProblems([
    { ...ENTRY, code: "test", domainSlug: "admin", ownerEmail: "ai-do@gmail.com", name: "Shop ABC", reason: "x" },
    { ...ENTRY, code: "test" },
  ]);
  for (const want of ["dành riêng", "tên miền con", "tên miền của nền tảng", "không phải khách thật", "thiếu lý do", "mã trùng"]) assert.ok(xau.some((p) => p.includes(want)), `sổ khai xấu phải bị bắt: ${want}`);
  assert.equal(acceptanceIdempotencyKey(CODE), `saas-acceptance:${CODE}`);

  // Ô arg: chế độ + cờ lạ / lặp / sai cặp.
  assert.deepEqual(parseAcceptanceArgs([]), { ok: true, mode: "READ", orgCode: null });
  assert.deepEqual(parseAcceptanceArgs(["--apply"]), { ok: true, mode: "APPLY", orgCode: null });
  assert.deepEqual(parseAcceptanceArgs(["--apply", "--e2e", `--org=${CODE}`]), { ok: true, mode: "E2E", orgCode: CODE });
  for (const bad of [["--e2e"], ["--aply"], ["--apply", "--apply"], ["--org=-x"], [CODE], ["--extend-trial"]]) assert.equal(parseAcceptanceArgs(bad).ok, false, JSON.stringify(bad));

  // Dòng bước + dòng tóm tắt: n = số bước ĐÃ chạy; bỏ qua nêu riêng; không email / SĐT.
  const rs: StepResult[] = [
    { key: "A", status: "PASS", reason: "ok", ms: 3, detail: [] },
    { key: "B1", status: "SKIP", reason: "chỉ đọc", ms: 0, detail: [] },
    { key: "C", status: "FAIL", reason: "hỏng", ms: 9, detail: [] },
  ];
  assert.equal(formatStepLine(rs[0]), "PASS A · workspace nghiệm thu — ok (3ms)");
  const sum = acceptanceSummary(rs, { mode: "READ", orgCode: CODE, baseDomain: "erp.vnxcommerce.com" });
  assert.ok(sum.startsWith("saas-acceptance: FAIL 1/2 · hỏng C · bỏ qua B1 · chế độ CHỈ ĐỌC"), sum);
  assert.ok(sum.includes(`workspace ${CODE}`) && sum.includes("miền chat erp.vnxcommerce.com"));
  assert.ok(!sum.includes("@") && sum.length <= ACCEPTANCE_SUMMARY_MAX);
  assert.ok(acceptanceSummary([{ ...rs[0] }], { mode: "APPLY", orgCode: CODE }).startsWith("saas-acceptance: PASS 1/1"));
  assert.ok(acceptanceSummary([], { mode: "READ", orgCode: null }).startsWith("saas-acceptance: FAIL 0/0"), "không bước nào chạy ⇒ không phải PASS");
  assert.ok(acceptanceSummary([{ ...rs[0] }], { mode: "E2E", orgCode: CODE, aiCostUsd: 0.0028 }).includes("AI lượt này ≈ 0,0028 USD"), "chi phí AI kiểu Việt");
  assert.ok(!acceptanceSummary([{ ...rs[0] }], { mode: "E2E", orgCode: CODE, aiCostUsd: null }).includes("AI lượt này"), "chưa định giá ⇒ không in 0");

  // Che bí mật.
  assert.equal(scrubSecrets("mk=Abcdefgh123 và Abcdefgh123", ["Abcdefgh123"]), "mk=••• và •••");
  assert.equal(scrubSecrets("abc", ["abc"]), "abc", "bí mật ngắn không đăng ký (tránh che nhầm chữ thường)");

  // (6) Tuyến vỏ DẪN XUẤT từ sổ khai của vỏ.
  const admin: ShellUser = { role: "ADMIN", permissions: [], organization: { isHome: false, brand: "chotdon" }, modules: ["core", "customers", "products", "orders", "inventory", "ai_sales"] };
  const routes = shellRoutesFor(admin);
  const nav = salesAgentNavFor(admin).map((i) => i.href);
  assert.ok(nav.length > 0);
  assert.deepEqual(routes.slice(0, nav.length).map((r) => r.path), nav, "tuyến vỏ = đúng các mục nav (cùng thứ tự)");
  assert.deepEqual(routes.slice(nav.length), [
    { path: "/", expect: salesAgentRedirectFor(admin, "/") },
    { path: SALES_AGENT_DENIED_PREFIXES[0], expect: salesAgentRedirectFor(admin, SALES_AGENT_DENIED_PREFIXES[0]) },
  ]);
  assert.ok(!salesAgentPathAllowed(SALES_AGENT_DENIED_PREFIXES[0]), "tuyến ERP thử phải là tuyến vỏ chặn");

  // Soi thân trang của vỏ.
  const tot = `<head><link rel="manifest" href="${CHOTDON_ASSETS.manifest}"/></head><div ${SALES_AGENT_SHELL_HTML_MARKER}>x</div>`;
  assert.equal(shellBodyProblem(tot), null);
  assert.match(shellBodyProblem(`${tot}<a aria-label="VNXcommerce — về trang tổng quan">`) ?? "", /lộ khung ERP/);
  assert.match(shellBodyProblem(`${tot}<button aria-label="Mở AI Copilot">`) ?? "", /lộ khung ERP/);
  assert.match(shellBodyProblem(tot.replace(SALES_AGENT_SHELL_HTML_MARKER, "")) ?? "", /không dựng vỏ/);
  assert.match(shellBodyProblem(tot.replace(CHOTDON_ASSETS.manifest, "/brand/vnx/site.webmanifest")) ?? "", /thương hiệu Chốt Đơn/);
  assert.match(shellBodyProblem(`${tot}${PAGE_ERROR_MARKER}`) ?? "", /trang lỗi/);
  assert.match(shellBodyProblem(`${tot}{"digest":"1532032257"}`) ?? "", /lỗi máy chủ \(1532032257\)/);
  assert.equal(metaRedirectTarget('<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/ai/x?a=1&amp;b=2"/>'), "/ai/x?a=1&b=2");
  assert.equal(metaRedirectTarget("<html>không</html>"), null);

  // Trang chat công khai.
  assert.equal(publicChatProblem(reply(200, null, `<h1>${ENTRY.name}</h1>`), ENTRY.name), null);
  assert.match(publicChatProblem(reply(200, null, HOST_NOT_FOUND_MESSAGE), ENTRY.name) ?? "", /không trỏ tới shop/);
  assert.match(publicChatProblem(reply(200, null, "Shop chưa bật chatbot bán hàng."), ENTRY.name) ?? "", /bot TẮT/);
  assert.match(publicChatProblem(reply(502, null, ""), ENTRY.name) ?? "", /HTTP 502/);

  // Đơn thử: địa chỉ ghép được tới xã; kịch bản mang SĐT + địa chỉ + mã lượt chạy + lời đồng ý.
  const place = resolveRecipientPlace({ address: ACCEPTANCE_ORDER.address, province: "" });
  assert.ok(place.ward && place.province, "địa chỉ đơn thử phải ghép được tới cấp xã (MATCHED)");
  const turns = acceptanceChatTurns("nt-run-1");
  assert.equal(turns.length, 3);
  assert.ok(turns[1].includes(ACCEPTANCE_ORDER.phone) && turns[1].includes(ACCEPTANCE_ORDER.address) && turns[1].includes(acceptanceOrderNote("nt-run-1")));
  assert.ok(foldVi(turns[2]).includes("chot don"), "lượt cuối là lời đồng ý chốt");
  assert.ok(ACCEPTANCE_SAMPLE_PRODUCTS.every((p) => p.name.startsWith("Mẫu ·")), "sản phẩm mẫu mang tiền tố «Mẫu ·»");

  // Dấu hiệu trang lỗi: CÙNG định nghĩa với scripts/smoke.ts (không danh sách thứ hai lệch nhau).
  const smoke = readFileSync(path.join(goc, "scripts", "smoke.ts"), "utf8");
  assert.ok(smoke.includes(`const ERROR_MARKER = ${JSON.stringify(PAGE_ERROR_MARKER)};`), "PAGE_ERROR_MARKER phải trùng ERROR_MARKER của smoke");
  assert.ok(smoke.includes(`const DIGEST_MARKER = /${PAGE_ERROR_DIGEST.source}/;`), "PAGE_ERROR_DIGEST phải trùng DIGEST_MARKER của smoke");
}

async function testProbe() {
  const ok = reply(200, null, `<head><link rel="manifest" href="${CHOTDON_ASSETS.manifest}"/></head><div ${SALES_AGENT_SHELL_HTML_MARKER}></div>`);
  const map = (m: Record<string, HttpReply>): AcceptanceDeps["appGet"] => async (p) => m[p] ?? reply(404, null, "");
  const r1 = await probeShellRoute(map({ "/": reply(307, "/a", ""), "/a": reply(307, "http://x.local/b", ""), "/b": ok }), { path: "/", expect: "/b" }, APP_HOST, "c");
  assert.ok(r1.ok, r1.text);
  const loop = await probeShellRoute(map({ "/a": reply(307, "/b", ""), "/b": reply(307, "/a", "") }), { path: "/a", expect: null }, APP_HOST, "c");
  assert.ok(!loop.ok && /vòng lặp/.test(loop.text), loop.text);
  const login = await probeShellRoute(map({ "/a": reply(307, "/login?reason=revoked", "") }), { path: "/a", expect: null }, APP_HOST, "c");
  assert.ok(!login.ok && /đá về đăng nhập \(reason=revoked\)/.test(login.text), login.text);
  const chain: Record<string, HttpReply> = {};
  for (let i = 0; i < 10; i++) chain[`/c${i}`] = reply(307, `/c${i + 1}`, "");
  const longChain = await probeShellRoute(map(chain), { path: "/c0", expect: null }, APP_HOST, "c");
  assert.ok(!longChain.ok && /quá 5 lần chuyển hướng/.test(longChain.text), longChain.text);
  const wrongHome = await probeShellRoute(map({ "/": reply(307, "/b", ""), "/b": ok }), { path: "/", expect: "/khac" }, APP_HOST, "c");
  assert.ok(!wrongHome.ok && /phải về \/khac/.test(wrongHome.text));
  const meta = await probeShellRoute(map({ "/": reply(200, null, '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/b">'), "/b": ok }), { path: "/", expect: "/b" }, APP_HOST, "c");
  assert.ok(meta.ok, `chuyển hướng bằng meta của Next vẫn được theo: ${meta.text}`);
  const err = await probeShellRoute(map({ "/a": reply(500, null, "") }), { path: "/a", expect: null }, APP_HOST, "c");
  assert.ok(!err.ok && /HTTP 500/.test(err.text));
  // #686: mục menu bị cổng quyền / cổng vỏ / cổng module đá về trang nhà vỏ — trang đích 200 + đủ dấu vỏ, vẫn KHÔNG phải «mở được».
  for (const [to, why] of [["/ai/overview?forbidden=1", /thiếu quyền/], ["/ai/overview?ngoai-goi=1", /ngoài vỏ/], ["/module-disabled", /module TẮT/]] as const) {
    const bounced = await probeShellRoute(map({ "/settings/plan": reply(307, to, ""), [to]: ok }), { path: "/settings/plan", expect: null }, APP_HOST, "c");
    assert.ok(!bounced.ok && why.test(bounced.text), `${to}: ${bounced.text}`);
  }
  assert.equal(deniedLanding("/settings/plan"), null);
}

// ═══════════ 2 · MÃ NGUỒN ═══════════

function sourceFiles(dirs: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(path.join(goc, d), { withFileTypes: true })) {
      const rel = `${d}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(rel);
      } else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
    }
  };
  for (const d of dirs) walk(d);
  return out;
}

function testSource() {
  const files = sourceFiles(["lib", "app", "components", "scripts"]);
  const callers = (re: RegExp, def: string) => files.filter((f) => f !== def && re.test(readFileSync(path.join(goc, f), "utf8"))).sort();
  // Đường phát liên kết của MÁY: chỉ ops nghiệm thu gọi.
  assert.deepEqual(callers(/\bcreateAcceptanceResetLink\(/, "lib/users/password-reset.ts"), ["lib/saas/acceptance.ts"], "createAcceptanceResetLink chỉ được gọi từ lõi ops nghiệm thu");
  // Luật gửi lại kích hoạt: MỘT bản — nút người vận hành (sau cổng) + ops nghiệm thu (sau lá chắn sổ khai).
  assert.deepEqual(callers(/\bresendActivation\(/, "lib/saas/activation.ts"), ["lib/saas/acceptance.ts", "lib/saas/console.ts"]);
  // /login không mã tổ chức: MỘT phép quyết định, form và ops cùng đi qua.
  const auth = readFileSync(path.join(goc, "lib", "actions", "auth.ts"), "utf8");
  assert.ok(/matchingLoginOrganizations\(email, password\)/.test(auth) && !/credentialsMatch\(/.test(auth), "loginAction dùng matchingLoginOrganizations, không tự lặp lại phép dò");
  // Lõi ops KHÔNG ghi hộ vào workspace (chỉ đạo 08/10/2026) và KHÔNG dùng móc chỉ-dành-cho-bài-kiểm.
  const core = readFileSync(path.join(goc, "lib", "saas", "acceptance.ts"), "utf8");
  for (const cam of ["createProductCore", "createProductAction", "saveSalesChatbotConfig", "setSettingJson", "publishOrganization", "setDomainSlug", "confirmOrderReviewCore", "updateManualOrderCore", "createManualOrderCore", "setOrgBilling", "adminSessionUser", "ForTests(", "AsOperator("]) {
    assert.ok(!core.includes(cam), `lib/saas/acceptance.ts không được gọi ${cam}`);
  }
  assert.ok(core.includes('actor: null, email: ACCEPTANCE_ACTOR_LABEL, source: "PROVISIONING"'), "cấp phát đứng tên MÁY (actor null) — AGENTS 34");
  // Script ops: chạy thử mặc định chỉ đọc, một dòng công khai.
  const script = readFileSync(path.join(goc, "scripts", "saas-acceptance.ts"), "utf8");
  assert.match(script, /if \(CHAY_THANG && !ARGS\.includes\("--apply"\)\) process\.env\.ERP_READ_ONLY = "1";/);
  assert.equal(script.match(/\[ops:tom-tat\] \$\{/g)?.length, 1, "chỉ một chỗ in kênh tóm tắt");
  // Ops: có trong danh sách chọn, kết quả MÃ HOÁ, chạy thử là lượt ĐỌC, nhánh chạy qua ma_hoa_ket_qua + chay_voi_arg.
  const ops = readFileSync(path.join(goc, ".github", "workflows", "ops-vps.yml"), "utf8");
  assert.match(ops, /^\s+- saas-acceptance\s+#/m);
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bsaas-acceptance\b/);
  assert.match(ops, /DOC_NANG="[^"]*\bsaas-acceptance\b/);
  assert.match(ops, /saas-acceptance\)\n[\s\S]{0,2500}?fetch_script saas-acceptance\.ts[\s\S]{0,300}?ma_hoa_ket_qua chay_voi_arg docker exec erp-app npx tsx --tsconfig tsconfig\.json scripts\/saas-acceptance\.ts ;;/);
  // Dấu hiệu HTML của vỏ / khung ERP còn đúng trong các tệp vẽ ra chúng.
  const shell = readFileSync(path.join(goc, "components", "saas-shell.tsx"), "utf8");
  assert.ok(shell.includes(SALES_AGENT_SHELL_HTML_MARKER) && ERP_FRAME_HTML_MARKERS.every((m) => !shell.includes(m)));
}

// ═══════════ 3 · CSDL THẬT ═══════════

async function adminOf(): Promise<SessionUser> {
  const u = await withOrganization(CODE, async () => (await getDb()).query.users.findFirst({ where: eq(schema.users.email, ENTRY.ownerEmail) }));
  assert.ok(u);
  invalidateCapabilities(CODE);
  return { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: resolvePermissions("ADMIN", null), scope: "ALL", departmentCodes: [], positionId: null, organization: { code: CODE, name: ENTRY.name, isHome: false }, modules: [...(await getEnabledModules(CODE))] };
}

async function testGuardAndSquatter() {
  const book = passwordBook();
  // Mã ngoài sổ ⇒ từ chối trước mọi lượt đọc / ghi.
  const refused = await captured(() => runAcceptanceCli(["--apply", "--org=hslc-hmt-shop"], deps("nt-guard", book)));
  assert.equal(refused.value, 64);
  assert.ok(summaryLine(refused.out).startsWith("saas-acceptance: FAIL 0/0") && refused.out.includes(ACCEPTANCE_REGISTRY_REFUSAL));
  assert.ok(!refused.out.includes("hslc-hmt-shop"), "câu từ chối không lặp lại mã đã gõ");
  const pdb = await getPlatformDb();
  assert.equal((await pdb.select().from(schema.platformProvisioningJobs).where(eq(schema.platformProvisioningJobs.idempotencyKey, "saas-acceptance:hslc-hmt-shop"))).length, 0, "không job nào cho mã ngoài sổ");
  const home = await getHomeOrganization();
  for (const raw of [{ orgCode: "hslc-hmt-shop", email: ENTRY.ownerEmail }, { orgCode: home.code, email: ENTRY.ownerEmail }, { orgCode: CODE, email: SQUAT_EMAIL }]) {
    const r = await createAcceptanceResetLink({ ...raw, reason: "Bài kiểm lá chắn sổ khai" });
    assert.deepEqual(r, { error: ACCEPTANCE_REGISTRY_REFUSAL }, `đường của máy từ chối ${raw.orgCode}/${raw.email}`);
  }
  // Ô arg sai ⇒ 64; chạy thử trên CSDL KHÔNG chỉ đọc ⇒ 70, không đọc gì.
  assert.equal((await captured(() => runAcceptanceCli(["--e2e"], deps("nt-guard", book)))).value, 64);
  const notRo = await captured(() => runAcceptanceCli([], deps("nt-guard", book)));
  assert.equal(notRo.value, 70);
  assert.ok(!/^(PASS|FAIL|SKIP) /m.test(notRo.out), "không bước nào chạy khi CSDL không ở chế độ chỉ đọc");
  // Chạy thử khi CHƯA có workspace: A hỏng rõ lý do, mọi bước khác bỏ qua, không ghi gì.
  const fresh = await captured(() => runAcceptanceCli([], deps("nt-read0", book), { readOnlyGuard: async () => true }));
  assert.equal(fresh.value, 1);
  assert.match(fresh.out, /^FAIL A · workspace nghiệm thu — chưa có workspace nghiệm thu/m);
  for (const k of ["B · kích hoạt", "C · vỏ app", "D · chat web", "E · chat công khai", "B · xoay"]) assert.match(fresh.out, new RegExp(`^SKIP ${k}`, "m"));
  assert.equal(await findOrganization(CODE), null, "chạy thử không tạo tổ chức");
  assertNoSecrets(fresh.out, book, "chạy thử trống");

  // KHÁCH THẬT TRÙNG MÃ (không qua ops): không bước nào chạm vào nó.
  await provisionOrganization({ code: CODE, name: "Khách thật trùng mã", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: SQUAT_EMAIL, name: "Chủ thật", password: SQUAT_PW }, source: "TEST", actor: null, brand: "chotdon" });
  const squat = await captured(() => runAcceptanceCli(["--apply", "--e2e"], deps("nt-squat", book)));
  assert.equal(squat.value, 1);
  assert.match(squat.out, /^FAIL A · workspace nghiệm thu — mã trùng một workspace KHÔNG do ops nghiệm thu tạo/m);
  for (const k of ["B · kích hoạt", "C · vỏ app", "D · chat web", "E · chat công khai", "B · xoay"]) assert.match(squat.out, new RegExp(`^SKIP ${k}`, "m"));
  assert.equal(await credentialsMatch({ email: SQUAT_EMAIL, password: SQUAT_PW, orgCode: CODE }), true, "mật khẩu của chủ thật NGUYÊN");
  assert.equal((await pdb.select().from(schema.platformProvisioningJobs).where(eq(schema.platformProvisioningJobs.idempotencyKey, acceptanceIdempotencyKey(CODE)))).length, 0, "không cả một job cấp phát hỏng");
  const tokens = await withOrganization(CODE, async () => (await getDb()).select().from(schema.passwordResetTokens));
  assert.equal(tokens.length, 0, "không một liên kết đặt lại nào cho tài khoản của khách thật");
  assertNoSecrets(squat.out, book, "khách trùng mã");
}

/** Kịch bản AI giả: tìm → báo giá · lưu khách → lên nháp (kèm ghi chú khách gửi) → tóm tắt · khách đồng ý → chốt. */
function acceptanceShopScript(variantId: string, runId: string) {
  let n = 0;
  const use = (name: string, input: unknown): AiBlock => ({ type: "tool_use", id: `nt-${++n}`, name, input });
  return (user: string, results: Record<string, unknown>[]): AiBlock[] => {
    const u = foldVi(user);
    if (results.length) {
      const r = results[0];
      if (Array.isArray(r.results)) return [{ type: "text", text: "Dạ mẫu áo thun nghiệm thu giá 150.000 ₫ một cái ạ." }];
      if (r.customer_id) return [use("create_draft_order", { items: [{ variant_id: variantId, quantity: ACCEPTANCE_ORDER.quantity }], delivery_note: acceptanceOrderNote(runId) })];
      if (r.order_code && r.confirmed) return [{ type: "text", text: "Dạ em đã chốt đơn, shop giao sớm cho mình ạ." }];
      if (r.order_code) return [{ type: "text", text: "Dạ em tóm tắt: 2 áo thun nghiệm thu giao về 12 Lê Lợi. Mình xác nhận giúp em nhé?" }];
      return [{ type: "text", text: "Dạ." }];
    }
    if (u.includes("gia bao nhieu")) return [use("search_products", { query: "áo thun nghiệm thu" })];
    if (u.includes(ACCEPTANCE_ORDER.phone)) return [use("create_customer", { name: ACCEPTANCE_ORDER.recipient, phone: ACCEPTANCE_ORDER.phone, address: ACCEPTANCE_ORDER.address })];
    if (u.includes("chot don")) return [use("confirm_order", { customer_confirmation: "em đồng ý, chốt đơn giúp em" })];
    return [{ type: "text", text: "Dạ em nghe ạ." }];
  };
}

async function testApplyFlow() {
  const book = passwordBook();
  // ── (2) lần đầu: tạo qua ĐÚNG job «Tạo khách», máy đứng tên ──
  const first = await captured(() => runAcceptance({ orgCode: null, mode: "APPLY" }, { ...(deps("nt-apply-1", book) as AcceptanceDeps) }));
  const r1 = first.value;
  for (const k of ["A", "B1", "C", "B2"] as const) assert.equal(stepOf(r1, k).status, "PASS", `${k}: ${stepOf(r1, k).reason} | ${stepOf(r1, k).detail.join(" | ")}`);
  assert.equal(stepOf(r1, "D").status, "SKIP");
  assert.equal(stepOf(r1, "E").status, "SKIP", "chưa xuất bản ⇒ bỏ qua kèm việc người làm");
  assert.match(stepOf(r1, "E").reason, /\/setup/);
  assert.equal(r1.verdict, "PASS");
  assertNoSecrets(first.out, book, "lượt --apply đầu", 0);
  const pdb = await getPlatformDb();
  const jobs = await pdb.select().from(schema.platformProvisioningJobs).where(eq(schema.platformProvisioningJobs.idempotencyKey, acceptanceIdempotencyKey(CODE)));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "SUCCEEDED");
  assert.equal(jobs[0].requestedByEmail, ACCEPTANCE_ACTOR_LABEL, "danh sách job hiện «Nghiệm thu tự động», không tên người");
  const org = await findOrganization(CODE);
  assert.ok(org && org.brand === "chotdon" && org.status === "ACTIVE");
  const account = await pdb.query.platformAccounts.findFirst({ where: eq(schema.platformAccounts.code, ENTRY.accountCode) });
  assert.equal(account?.accountType, "EXTERNAL", "tài khoản khách NGOÀI thử");
  const links = await pdb.select().from(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.targetOrgCode, CODE), eq(schema.platformAuditLog.action, "PASSWORD_RESET_LINK")));
  assert.ok(links.length >= 2 && links.every((l) => l.actorUserId === null && l.source === "SCRIPT"), "liên kết kích hoạt / xoay đứng tên MÁY, nguồn SCRIPT");
  assert.ok(links.some((l) => (l.after as { purpose?: string } | null)?.purpose === "ACTIVATION"), "lượt đầu đi đường KÍCH HOẠT");
  // ── (3) + (4): mật khẩu của lượt chạy đã chết; mật khẩu sai không khớp; mật khẩu xoay (vứt trong production) là thứ duy nhất khớp ──
  const [pw1, wrong, rotated] = book.issued;
  assert.deepEqual(await matchingLoginOrganizations(ENTRY.ownerEmail, pw1), [], "mật khẩu đã dùng trong lượt chạy KHÔNG còn đăng nhập được");
  assert.deepEqual(await matchingLoginOrganizations(ENTRY.ownerEmail, wrong), []);
  assert.deepEqual(await matchingLoginOrganizations(ENTRY.ownerEmail, rotated), [CODE], "đăng nhập email KHÔNG mã tổ chức ra đúng workspace thử");
  // ── (6) C phủ đủ tuyến dẫn xuất ──
  assert.match(stepOf(r1, "C").reason, /^10\/10 tuyến của vỏ mở được qua host app\.chotdontudong\.com/);

  // ── (2) lần hai: idempotent — cùng job, cùng tài khoản, cùng tổ chức, cùng một dòng chỉ mục; kích hoạt lại bằng «đặt lại» ──
  // Giả lập danh mục / bảng giá đã đổi kể từ lượt tạo (đầu vào ĐÃ LƯU của job khác đầu vào dựng hôm nay): «Tạo khách» gửi lại cùng
  // khoá mà đầu vào khác bị từ chối (#684) — job đã xong thì ops KHÔNG gửi lại, nên A vẫn đạt thay vì báo «thông tin KHÁC».
  const [stored] = await pdb.select().from(schema.platformProvisioningJobs).where(eq(schema.platformProvisioningJobs.idempotencyKey, acceptanceIdempotencyKey(CODE)));
  const storedProducts = Array.isArray(stored.input.products) ? (stored.input.products as string[]) : [];
  await pdb.update(schema.platformProvisioningJobs).set({ input: { ...stored.input, products: [...storedProducts, "san-pham-da-go-khoi-danh-muc"] } }).where(eq(schema.platformProvisioningJobs.id, stored.id));
  const second = await captured(() => runAcceptanceCli(["--apply"], deps("nt-apply-2", book)));
  assert.equal(second.value, 0, second.out);
  assertNoSecrets(second.out, book, "lượt --apply hai");
  assert.match(second.out, /job «Tạo khách» đã chạy xong từ trước — không gửi lại/);
  assert.match(second.out, /đặt lại mật khẩu cho khách \(đã kích hoạt ở lượt trước\)/);
  assert.ok(summaryLine(second.out).startsWith("saas-acceptance: PASS 4/4 · bỏ qua D, E · chế độ GHI"), summaryLine(second.out));
  assert.equal((await pdb.select().from(schema.platformProvisioningJobs).where(eq(schema.platformProvisioningJobs.idempotencyKey, acceptanceIdempotencyKey(CODE)))).length, 1);
  assert.equal((await pdb.select().from(schema.platformAccounts).where(eq(schema.platformAccounts.code, ENTRY.accountCode))).length, 1);
  assert.equal((await pdb.select().from(schema.platformOrganizations).where(eq(schema.platformOrganizations.code, CODE))).length, 1);
  assert.equal((await pdb.select().from(schema.platformIdentities).where(and(eq(schema.platformIdentities.orgCode, CODE), eq(schema.platformIdentities.value, ENTRY.ownerEmail)))).length, 1);
  assert.deepEqual(await matchingLoginOrganizations(ENTRY.ownerEmail, book.issued[3]), [], "mật khẩu của lượt hai cũng đã chết");

  // ── Chạy thử (chỉ đọc) trên workspace có thật: A + C đạt, B bỏ qua ──
  const read = await captured(() => runAcceptanceCli([], deps("nt-read1", book), { readOnlyGuard: async () => true }));
  assert.equal(read.value, 0, read.out);
  assert.match(read.out, /^PASS A · workspace nghiệm thu/m);
  assert.match(read.out, /^PASS C · vỏ app Chốt Đơn — 10\/10/m);
  assert.match(read.out, /^SKIP B · kích hoạt \+ đăng nhập email — chế độ CHỈ ĐỌC/m);
  assertNoSecrets(read.out, book, "chạy thử");

  // ── C phát hiện khung ERP lọt vào vỏ ──
  const leak = await captured(() => runAcceptance({ orgCode: CODE, mode: "READ" }, { ...(deps("nt-leak", book, { appGet: fakeApp({ userId: acceptanceUserId, shopName: ENTRY.name, leakErp: true }) }) as AcceptanceDeps) }));
  assert.equal(stepOf(leak.value, "C").status, "FAIL");
  assert.match(stepOf(leak.value, "C").reason, /lộ khung ERP nội bộ/);

  // ── (7) E2E: thiếu chuẩn bị ⇒ SKIP, KHÔNG ghi gì vào workspace ──
  const noPrep = await captured(() => runAcceptanceCli(["--apply", "--e2e"], deps("nt-e2e-0", book)));
  assert.match(noPrep.out, /^SKIP D · chat web → AI → đơn — chuẩn bị E2E chưa đủ/m);
  assert.match(noPrep.out, /bot bán hàng chưa BẬT/);
  assert.match(noPrep.out, new RegExp(`chưa có sản phẩm mẫu «${ACCEPTANCE_SAMPLE_PRODUCTS[0].name}»`));
  const convs0 = await withOrganization(CODE, async () => (await getDb()).select().from(schema.salesChatConversations));
  assert.equal(convs0.length, 0, "thiếu chuẩn bị ⇒ không mở hội thoại nào");
  assertNoSecrets(noPrep.out, book, "E2E thiếu chuẩn bị");

  // Người làm chuẩn bị MỘT lần (ở đây bài kiểm đóng vai người bấm UI): sản phẩm mẫu + nhập hàng + bật bot + xuất bản.
  const admin = await adminOf();
  const sample = ACCEPTANCE_SAMPLE_PRODUCTS[0];
  const variantId = await withOrganization(CODE, async () => {
    const p = await createProductCore(admin, { name: sample.name, code: sample.sku, unit: "cái", retailPrice: sample.priceVnd, cost: null, variants: [{ sku: sample.sku, size: "", color: "", retailPrice: sample.priceVnd, cost: null, selling: true }] });
    assert.ok(p.ok, JSON.stringify(p));
    const db = await getDb();
    const v = await db.query.productVariants.findFirst({ where: eq(schema.productVariants.productId, p.id) });
    assert.ok(v);
    const [rc] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: new Date(), reference: "PN-NT-1", totalQuantity: 20, createdBy: ENTRY.ownerEmail }).returning({ id: schema.stockReceipts.id });
    await db.insert(schema.stockReceiptItems).values({ receiptId: rc.id, variantId: v.id, quantity: 20, unitCost: 90_000 });
    await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, connectorKey: "anthropic-byok", enabled: true });
    const slug = await setDomainSlug(admin, ENTRY.domainSlug);
    assert.ok(slug.ok, JSON.stringify(slug));
    const pub = await publishOrganization(admin);
    assert.ok(pub.ok, JSON.stringify(pub));
    return v.id;
  });
  invalidateOrganizations();
  const runId = "nt-e2e-1";
  const script = acceptanceShopScript(variantId, runId);
  setSalesChatProviderForTests(() => fakeProvider(script));
  const before = await withOrganization(CODE, async () => ({ products: (await (await getDb()).select().from(schema.products)).length, bot: await getSettingJson(SALES_CHATBOT_SETTING_KEY, {}) }));
  const e2e = await captured(() => runAcceptanceCli(["--apply", "--e2e"], deps(runId, book)));
  setSalesChatProviderForTests(null);
  assert.equal(e2e.value, 0, e2e.out);
  assert.match(e2e.out, /^PASS D · chat web → AI → đơn — AI trả lời 3 lượt · đơn #\S+ CONFIRMED trong OMS · 2 × NT-AO-01 · SĐT \+ xã khớp/m);
  assert.match(e2e.out, /^PASS E · chat công khai theo tên miền con — https:\/\/cdt-nghiem-thu\.nt\.erp\.test\/chat ⇒ 200 \+ tên shop/m);
  assert.match(e2e.out, /miền gốc đang dùng: nt\.erp\.test/);
  assert.ok(summaryLine(e2e.out).startsWith("saas-acceptance: PASS 6/6 · chế độ GHI + E2E"), summaryLine(e2e.out));
  assertNoSecrets(e2e.out, book, "E2E");
  const after = await withOrganization(CODE, async () => {
    const db = await getDb();
    const conv = (await db.select().from(schema.salesChatConversations))[0];
    const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, conv.orderId!) });
    const items = await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, conv.orderId!));
    return { products: (await db.select().from(schema.products)).length, bot: await getSettingJson(SALES_CHATBOT_SETTING_KEY, {}), conv, order, items };
  });
  assert.equal(after.order?.stage, "CONFIRMED", "đơn trong OMS đã xác nhận");
  assert.deepEqual(after.items.map((i) => [i.variantId, i.quantity]), [[variantId, ACCEPTANCE_ORDER.quantity]]);
  assert.ok(after.order?.note?.includes(runId), "ghi chú khách gửi (mang mã lượt chạy) nằm trên đơn");
  assert.equal(after.conv.channel, "WEB", "đi đúng kênh chat công khai");
  assert.equal(after.products, before.products, "ops KHÔNG tạo sản phẩm");
  assert.deepEqual(after.bot, before.bot, "ops KHÔNG đổi cấu hình bot");
  const usage = await pdb.select().from(schema.platformAiUsage).where(and(eq(schema.platformAiUsage.orgCode, CODE), eq(schema.platformAiUsage.conversationId, after.conv.id)));
  assert.ok(usage.length > 0, "lượt AI được ghi sổ (chi phí đọc từ đó)");
}

export async function testSaasAcceptance() {
  testPure();
  await testProbe();
  testSource();
  let failure: unknown = null;
  try {
    await cleanup();
    await testGuardAndSquatter();
    await cleanup();
    await testApplyFlow();
  } catch (error) {
    failure = error;
  }
  try {
    setSalesChatProviderForTests(null);
    await cleanup();
  } catch (cleanupError) {
    if (!failure) throw cleanupError;
    console.error("[saas-acceptance] dọn dẹp cũng lỗi (lỗi chính ở dưới):", cleanupError);
  }
  if (failure) throw failure;
  console.log("  ✓ Nghiệm thu khách Chốt Đơn (ops saas-acceptance): lá chắn sổ khai + khách trùng mã không bị chạm · --apply tạo qua job «Tạo khách» (máy) rồi idempotent · kích hoạt → /reset → /login email KHÔNG mã tổ chức · mật khẩu xoay rồi vứt · không lộ mật khẩu / liên kết / phiên / AUTH_SECRET · tuyến vỏ dẫn xuất từ nav · E2E thiếu chuẩn bị ⇒ SKIP không ghi, đủ ⇒ AI → đơn CONFIRMED trong OMS");
}

if (process.argv[1] && /saas-acceptance\.test\.ts$/.test(process.argv[1])) {
  testSaasAcceptance().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}

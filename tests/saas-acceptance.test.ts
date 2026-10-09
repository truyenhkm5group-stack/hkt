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
 *     web → AI → đơn CONFIRMED đúng SKU · SL · SĐT · xã trong OMS, bước D không tạo sản phẩm / không đổi cấu hình bot.
 *  8. Bước P (`--apply --prep`, quyết định chủ shop 09/10/2026): đúng MỘT sản phẩm / mẫu mã + MỘT phiếu nhập (khả dụng ≥ mức tối thiểu
 *     theo sổ kho) + bật bot + xuất bản, qua ĐÚNG lõi của nút UI, đứng tên CHỦ workspace thử, không gọi AI; AI nền tảng chưa sẵn sàng ⇒
 *     bot BỎ QUA kèm đúng phần thiếu; lượt hai ⇒ CÓ SẴN hết; đơn chốt làm tồn hụt ⇒ MỘT phiếu đúng phần chênh; khách trùng mã không bị
 *     chạm; không có --apply ⇒ từ chối; dòng công khai chỉ tên việc + trạng thái.
 *
 * (8 — loại workspace thử khỏi chỉ số buồng lái — CHƯA làm: đụng rộng, xem docs/saas/ACCEPTANCE.md §6.)
 *
 * Tổ chức THẬT trên PGlite mang đúng mã của sổ khai; tự dọn trước và sau. Mốc thời gian theo đồng hồ thật (AGENTS 50 · 65).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, like } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, releaseOrganizationDb, schema } from "@/db";
import type { AiBlock } from "@/lib/ai/provider";
import { resolveRecipientPlace } from "@/lib/address/vn-address";
import { credentialsMatch, matchingLoginOrganizations } from "@/lib/auth/login";
import { verifySessionToken, type SessionUser } from "@/lib/auth/session";
import {
  ACCEPTANCE_ACTOR_LABEL,
  ACCEPTANCE_ORDER,
  ACCEPTANCE_REGISTRY_REFUSAL,
  ACCEPTANCE_RESERVED_MESSAGE,
  ACCEPTANCE_SAMPLE_PRODUCTS,
  ACCEPTANCE_SUMMARY_MAX,
  ACCEPTANCE_UNMEASURABLE_DRILLS,
  ACCEPTANCE_WORKSPACES,
  acceptanceChatTurns,
  acceptanceIdempotencyKey,
  acceptanceOrderNote,
  acceptanceRegistryProblems,
  acceptanceReservedName,
  acceptanceStepsFor,
  acceptanceSummary,
  acceptanceWorkspaceOf,
  drillStepStatus,
  drillSummaryPart,
  formatDrillLine,
  formatPrepLine,
  formatStepLine,
  PAGE_ERROR_DIGEST,
  PAGE_ERROR_MARKER,
  parseAcceptanceArgs,
  prepStepStatus,
  prepSummaryPart,
  scrubSecrets,
  type DrillResult,
  type PrepItemResult,
  type StepResult,
} from "@/lib/constants/saas-acceptance";
import { OPS_SIGNAL_KEYS } from "@/lib/constants/ops-signals";
import { loadOrgOpsSignals } from "@/lib/platform/ops-signals";
import { resetOrgHealthHotPathForTests } from "@/lib/platform/org-health";
import { ERP_FRAME_HTML_MARKERS, SALES_AGENT_DENIED_PREFIXES, SALES_AGENT_SHELL_HTML_MARKER, salesAgentNavFor, salesAgentPathAllowed, salesAgentRedirectFor, type ShellUser } from "@/lib/constants/saas-nav";
import { env } from "@/lib/env";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { HOST_NOT_FOUND_MESSAGE } from "@/lib/platform/host-org";
import { freeOrgCode } from "@/lib/onboarding/quick";
import { orgCodeBase } from "@/lib/onboarding/quick-shared";
import { orgStepZ } from "@/lib/onboarding/shared";
import { findOrganization, getHomeOrganization, invalidateOrganizations, listOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { checkDomainSlug, publicationOf } from "@/lib/platform/publish";
import { loadOwnerCockpit } from "@/lib/platform/saas-cockpit";
import { captureSaasSnapshot } from "@/lib/platform/saas-ledger";
import { CHOTDON_ASSETS } from "@/lib/platform/site-host";
import { shortfalls } from "@/lib/commerce/stock";
import { ACCEPTANCE_NOT_OWNED_REFUSAL, ACCEPTANCE_RUNTIME_REFUSAL, acceptanceRuntimeRefusal } from "@/lib/saas/acceptance-guard";
import { ACCEPTANCE_PREP_REGISTRY_REFUSAL, ACCEPTANCE_PREP_REQUIRED_TOOLS, runAcceptancePrep } from "@/lib/saas/acceptance-prep";
import { ACCEPTANCE_SESSION_TTL_SEC, deniedLanding, metaRedirectTarget, probeShellRoute, publicChatProblem, runAcceptance, shellBodyProblem, shellRoutesFor, type AcceptanceDeps, type AcceptanceReport, type HttpReply } from "@/lib/saas/acceptance";
import { loadCommercialSnapshot, productEconomics } from "@/lib/saas/customers";
import { foldVi } from "@/lib/sales-chatbot/catalog";
import { SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { loadSalesChatbotConfig, setSalesChatProviderForTests } from "@/lib/sales-chatbot/engine";
import { getSettingJson } from "@/lib/settings";
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

/** Hạn (exp − iat, giây) của phiên vỏ mà ứng dụng giả nhận gần nhất — L2: phiên máy phải NGẮN, không phải 7 ngày. */
let lastShellSessionTtl: number | null = null;

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
    if (token) {
      const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { iat?: number; exp?: number };
      lastShellSessionTtl = typeof claims.exp === "number" && typeof claims.iat === "number" ? claims.exp - claims.iat : null;
    }
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
  await pdb.delete(schema.platformAuthFailures).where(inArray(schema.platformAuthFailures.orgCode, codes));
  await pdb.delete(schema.platformOrgHealth).where(inArray(schema.platformOrgHealth.orgCode, codes));
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
  // (b) Đường máy chỉ sống trong tiến trình ops: Next đặt NEXT_RUNTIME (nodejs / edge) ⇒ từ chối; tsx để trống ⇒ được chạy.
  for (const rt of ["nodejs", "edge"]) assert.equal(acceptanceRuntimeRefusal(rt), ACCEPTANCE_RUNTIME_REFUSAL, `máy chủ ứng dụng (${rt}) không mở được đường máy`);
  for (const rt of [undefined, ""]) assert.equal(acceptanceRuntimeRefusal(rt), null);
  // (c) Giữ chỗ: mã + tên miền con của sổ khai, không ai tự đăng ký được (kho PUBLIC — mã đã lộ).
  assert.equal(acceptanceReservedName(` ${CODE.toUpperCase()} `)?.code, CODE);
  assert.equal(acceptanceReservedName(ENTRY.domainSlug)?.code, CODE);
  assert.equal(acceptanceReservedName(`${CODE}-2`), null);
  const dangKy = orgStepZ.safeParse({ name: "CDT Nghiem Thu", code: CODE });
  assert.ok(!dangKy.success && dangKy.error.issues.some((i) => i.message === ACCEPTANCE_RESERVED_MESSAGE), "lược đồ tự đăng ký (/start · đăng ký nhanh) từ chối mã nghiệm thu");
  assert.ok(orgStepZ.safeParse({ name: "CDT Nghiem Thu Hai", code: `${CODE}-2` }).success, "chỉ đúng tên giữ chỗ bị chặn, không chặn theo tiền tố");

  // Ô arg: chế độ + cờ lạ / lặp / sai cặp.
  assert.deepEqual(parseAcceptanceArgs([]), { ok: true, mode: "READ", orgCode: null, drills: false, prep: false });
  assert.deepEqual(parseAcceptanceArgs(["--apply"]), { ok: true, mode: "APPLY", orgCode: null, drills: false, prep: false });
  assert.deepEqual(parseAcceptanceArgs(["--apply", "--e2e", `--org=${CODE}`]), { ok: true, mode: "E2E", orgCode: CODE, drills: false, prep: false });
  assert.deepEqual(parseAcceptanceArgs(["--apply", "--drills"]), { ok: true, mode: "APPLY", orgCode: null, drills: true, prep: false }, "diễn tập chỉ khi gõ --drills");
  assert.deepEqual(parseAcceptanceArgs(["--apply", "--prep", "--e2e"]), { ok: true, mode: "E2E", orgCode: null, drills: false, prep: true }, "chuẩn bị chỉ khi gõ --prep");
  for (const bad of [["--e2e"], ["--aply"], ["--apply", "--apply"], ["--org=-x"], [CODE], ["--extend-trial"], ["--drills"], ["--apply", "--drills", "--drills"], ["--prep"], ["--prep", "--e2e"], ["--apply", "--prep", "--prep"]]) assert.equal(parseAcceptanceArgs(bad).ok, false, JSON.stringify(bad));
  assert.match((parseAcceptanceArgs(["--prep"]) as { error: string }).error, /--prep chỉ đi cùng --apply/);
  // Bước P chỉ có trong lượt --prep, chen SAU B1 (chủ đã kích hoạt) và TRƯỚC C / D / E; F chen TRƯỚC B2; lượt thường giữ nguyên sáu bước.
  assert.deepEqual([...acceptanceStepsFor({})], ["A", "B1", "C", "D", "E", "B2"]);
  assert.deepEqual([...acceptanceStepsFor({ drills: true })], ["A", "B1", "C", "D", "E", "F", "B2"]);
  assert.deepEqual([...acceptanceStepsFor({ prep: true })], ["A", "B1", "P", "C", "D", "E", "B2"]);
  assert.deepEqual([...acceptanceStepsFor({ prep: true, drills: true })], ["A", "B1", "P", "C", "D", "E", "F", "B2"]);
  // Chuẩn bị: dòng công khai chỉ tên việc theo trạng thái (không id / SKU / câu lỗi); phán quyết bước P.
  const prs: PrepItemResult[] = [
    { key: "PRODUCT", status: "DONE", why: "sản phẩm erp-bi-mat · mẫu mã erp-v-bi-mat" },
    { key: "STOCK", status: "DONE", why: "phiếu nhập rc-bi-mat +10 NT-AO-01" },
    { key: "BOT", status: "SKIPPED", why: "AI của bot chưa sẵn sàng: Nền tảng chưa bật AI dùng chung" },
    { key: "PUBLISH", status: "ALREADY", why: "đã xuất bản" },
  ];
  assert.equal(prepSummaryPart(prs), "chuẩn bị: ĐÃ LÀM sản phẩm mẫu,phiếu nhập · CÓ SẴN xuất bản · BỎ QUA bot");
  assert.ok(!/bi-mat|NT-AO-01|Nền tảng/.test(prepSummaryPart(prs)), "phần chuẩn bị công khai không mang id / SKU / câu lỗi");
  assert.equal(prepStepStatus(prs), "SKIP", "chuẩn bị chưa trọn KHÔNG phải đạt");
  assert.equal(prepStepStatus(prs.map((r) => ({ ...r, status: r.status === "SKIPPED" ? ("ALREADY" as const) : r.status }))), "PASS");
  assert.equal(prepStepStatus(prs.map((r) => (r.key === "STOCK" ? { ...r, status: "FAILED" as const } : r))), "FAIL");
  assert.equal(prepStepStatus([]), "SKIP");
  assert.equal(formatPrepLine(prs[2]), "bot: BỎ QUA — AI của bot chưa sẵn sàng: Nền tảng chưa bật AI dùng chung");
  assert.ok(acceptanceSummary([{ key: "P", status: "PASS", reason: "x", ms: 1, detail: [] }], { mode: "APPLY", orgCode: CODE, prep: prepSummaryPart(prs) }).includes("chuẩn bị: ĐÃ LÀM sản phẩm mẫu,phiếu nhập"));
  // Diễn tập: dòng công khai chỉ số hiệu tín hiệu theo trạng thái; mọi tín hiệu không diễn tập được có lý do; phán quyết bước F.
  const drs: DrillResult[] = OPS_SIGNAL_KEYS.map((key) => (key === "LOGIN" ? { key, status: "DRILLED", code: "LOGIN/BAD_PASSWORD", why: "B1" } : key === "ORDER_VALIDATION" ? { key, status: "DRILLED", code: "MISSING_CONTACT · audit bi-mat-id", why: "executeTool" } : { key, status: "UNMEASURABLE", code: null, why: ACCEPTANCE_UNMEASURABLE_DRILLS[key] ?? "" }));
  assert.equal(drillSummaryPart(drs), "diễn tập: ĐÃ DIỄN TẬP O1,O6 · CHƯA ĐO ĐƯỢC O2,O3,O4,O5,O7,O8");
  assert.ok(!/BAD_PASSWORD|MISSING_CONTACT|bi-mat-id/.test(drillSummaryPart(drs)), "phần diễn tập công khai không mang mã lý do / id");
  assert.ok(OPS_SIGNAL_KEYS.filter((k) => k !== "LOGIN" && k !== "ORDER_VALIDATION").every((k) => (ACCEPTANCE_UNMEASURABLE_DRILLS[k] ?? "").length > 30), "mỗi tín hiệu CHƯA ĐO ĐƯỢC khai lý do cụ thể");
  assert.equal(drillStepStatus(drs), "PASS");
  assert.equal(drillStepStatus(drs.map((r) => (r.key === "ORDER_VALIDATION" ? { ...r, status: "FAILED" as const } : r))), "FAIL");
  assert.equal(drillStepStatus(drs.map((r) => (r.status === "DRILLED" ? { ...r, status: "SKIPPED" as const } : r))), "SKIP");
  assert.match(formatDrillLine(drs[5]), /^O6 ORDER_VALIDATION: ĐÃ DIỄN TẬP \(MISSING_CONTACT/);

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

/** Tệp TS đã vào kho (git ls-files) — gồm cả tệp mới tạo nếu đã `git add`; đường dẫn luôn dùng «/». */
function trackedSources(): string[] {
  return execFileSync("git", ["ls-files", "*.ts", "*.tsx"], { cwd: goc, encoding: "utf8" })
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
}

/** Bỏ chú thích (khối + dòng) — mọi lần nhắc tới định danh trong MÃ (gọi · nhập · xuất lại · đổi tên) đều còn lại. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Các mệnh đề `import … from "x"` của một tệp: module + tên nhập (mặc định = "default", namespace = "*"). */
function importsOf(src: string): { from: string; names: string[] }[] {
  const out: { from: string; names: string[] }[] = [];
  for (const m of src.matchAll(/^import\s+(?:type\s+)?([\s\S]*?)\s+from\s+"([^"]+)";/gm)) {
    const clause = m[1];
    const names: string[] = [];
    const braces = /\{([\s\S]*)\}/.exec(clause);
    if (braces) for (const part of braces[1].split(",")) {
      const n = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (n) names.push(n);
    }
    const rest = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, " ").trim();
    if (/^\*\s+as\s+/.test(rest)) names.push("*");
    else if (rest) names.push("default");
    out.push({ from: m[2], names });
  }
  return out;
}

/**
 * «KHÔNG GHI HỘ» bằng ALLOWLIST (chỉ đạo 08/10/2026, review #690 L3): lõi ops chỉ được nhập ĐÚNG những tên này. Thêm một lõi ghi
 * (tạo sản phẩm, lưu cấu hình bot, xuất bản, xác nhận đơn, thu phí…) là thêm một tên ngoài danh sách ⇒ đỏ, kể cả khi nó đến từ một
 * module đã có mặt. Danh sách cấm cũ chỉ bắt được tên đã biết trước.
 */
const CORE_IMPORT_ALLOWLIST: Record<string, readonly string[]> = {
  "node:crypto": ["randomBytes"],
  "node:http": ["default"],
  "node:https": ["default"],
  "drizzle-orm": ["and", "eq"],
  "@/db": ["getDb", "getPlatformDb", "schema"],
  "@/lib/address/vn-address": ["foldVnText", "resolveRecipientPlace"],
  "@/lib/auth/identities": ["findIdentity"],
  "@/lib/auth/login": ["matchingLoginOrganizations", "verifyLogin", "LoginFailureNote"],
  "@/lib/auth/session": ["signSession", "SessionSubject"],
  "@/lib/commerce/stock": ["shortfalls"],
  "@/lib/constants/saas-acceptance": [
    "ACCEPTANCE_ACTOR_LABEL", "ACCEPTANCE_NUDGE_TURN", "ACCEPTANCE_ORDER", "ACCEPTANCE_REGISTRY_REFUSAL", "ACCEPTANCE_SAMPLE_PRODUCTS", "ACCEPTANCE_STEPS", "ACCEPTANCE_WORKSPACES",
    "ACCEPTANCE_DRILL_ID_PREFIX", "ACCEPTANCE_UNMEASURABLE_DRILLS", "acceptanceStepsFor", "drillStepStatus", "drillSummaryPart", "formatDrillLine", "DrillResult",
    "formatPrepLine", "prepStepStatus", "prepSummaryPart", "PrepItemResult",
    "acceptanceChatTurns", "acceptanceIdempotencyKey", "acceptanceSummary", "acceptanceVerdict", "acceptanceWorkspaceOf", "formatAcceptanceUsd", "formatStepLine", "PAGE_ERROR_DIGEST", "PAGE_ERROR_MARKER", "scrubSecrets",
    "AcceptanceMode", "AcceptanceStepKey", "AcceptanceWorkspace", "StepResult", "StepStatus",
  ],
  "@/lib/constants/saas-nav": ["ERP_FRAME_HTML_MARKERS", "FORBIDDEN_PARAM", "isSalesAgentUser", "SALES_AGENT_DENIED_PREFIXES", "SALES_AGENT_SHELL_HTML_MARKER", "SHELL_BLOCKED_PARAM", "salesAgentNavFor", "salesAgentRedirectFor", "ShellUser"],
  "@/lib/constants/session": ["SESSION_COOKIE"],
  "@/lib/constants/session-revocation": ["revokeMarkFrom"],
  "@/lib/env": ["env"],
  "@/lib/platform/capabilities": ["getEnabledModules", "invalidateCapabilities"],
  "@/lib/platform/context": ["withOrganization"],
  "@/lib/platform/host-org": ["HOST_NOT_FOUND_MESSAGE"],
  // Ghi DUY NHẤT vào sổ lỗi đăng nhập của nền tảng: lượt mật khẩu SAI của B1 (bằng chứng O1 luồng LOGIN — ghi ở mặt phẳng điều khiển,
  // KHÔNG ghi vào workspace), chỉ cho workspace nghiệm thu. Tech Lead duyệt 09/10/2026.
  "@/lib/platform/auth-failures": ["recordAuthFailure"],
  "@/lib/platform/organizations": ["findOrganization", "invalidateOrganizations"],
  "@/lib/platform/publish": ["platformBaseDomain", "publicationOf"],
  "@/lib/platform/site-host": ["CHOTDON_ASSETS", "chotdonAppHost", "SiteEnv"],
  "@/lib/pricing/ai-entitlement": ["AI_STOP_MESSAGE"],
  "@/lib/pricing/ai-gate": ["loadAiEntitlement"],
  "@/lib/pricing/price-book": ["loadPriceBook", "readPricePin"],
  "@/lib/pricing/versions": ["currentCatalogVersion"],
  "@/lib/records/customer-create": ["normalizeCustomerPhone"],
  "@/lib/records/order-create": ["loadAutoConfirmComplete"],
  "@/lib/saas/accounts": ["accountOfWorkspace"],
  "@/lib/saas/acceptance-guard": ["acceptanceWorkspaceOwned"],
  // Bước P (`--apply --prep`, quyết định chủ shop 09/10/2026): lõi chỉ GỌI tệp chuẩn bị — mọi lõi ghi vào workspace nằm ở tệp đó, sau
  // ba lá chắn của riêng nó (allowlist thứ hai: PREP_IMPORT_ALLOWLIST).
  "@/lib/saas/acceptance-prep": ["runAcceptancePrep"],
  "@/lib/saas/activation": ["activationRefusal", "loadWorkspaceActivation", "resendActivation"],
  "@/lib/saas/catalog": ["PRODUCTS"],
  "@/lib/saas/customers": ["readPlans"],
  "@/lib/saas/provisioning": ["requestProvisioning"],
  "@/lib/sales-chatbot/config": ["withinBusinessHours"],
  "@/lib/sales-chatbot/engine": ["chatTurn", "conversationView", "EMPTY_REPLY_TEXT", "loadSalesChatbotConfig", "openConversation", "SALES_AGENT", "salesChatProvider", "visitorKeyOf"],
  // Diễn tập O6 (bước F, chỉ `--apply --drills`): ĐÚNG bộ chạy công cụ của bot, gọi DUY NHẤT với «Lưu khách» thiếu SĐT — công cụ từ chối
  // TRƯỚC mọi lượt ghi khách, chỉ còn dòng tín hiệu order.validation_failed (kiểm ở testSource: không công cụ ghi nào khác được gọi).
  "@/lib/sales-chatbot/tools": ["executeTool"],
  "@/lib/constants/ops-signals": ["OPS_SIGNAL_KEYS", "ORDER_VALIDATION_FAILED_ACTION"],
  "@/lib/users/password-reset": ["completePasswordResetCore", "createAcceptanceResetLink", "lookupResetToken"],
};

/**
 * Tệp chuẩn bị (bước P) — chỗ DUY NHẤT ops nghiệm thu ghi vào bên trong workspace. Mỗi việc đi qua ĐÚNG lõi của nút UI; thêm một lõi ghi
 * khác (lưu cài đặt thẳng, cấu hình AI của người vận hành, xác nhận đơn…) là thêm một tên ngoài danh sách ⇒ đỏ.
 */
const PREP_IMPORT_ALLOWLIST: Record<string, readonly string[]> = {
  "drizzle-orm": ["eq", "sql"],
  "@/db": ["getDb", "schema"],
  "@/lib/ai-builder/provider": ["platformChatAi"],
  "@/lib/audit": ["audit"],
  "@/lib/auth/identities": ["findIdentity"],
  "@/lib/auth/permissions": ["resolvePermissions"],
  "@/lib/auth/session": ["can", "loadPermissionSnapshots", "loadRoleTemplates", "SessionUser"],
  "@/lib/connectors/service": ["connectionIsActive"],
  "@/lib/constants/access-scope": ["normalizeScope"],
  "@/lib/constants/actor": ["Actor"],
  "@/lib/constants/saas-acceptance": ["ACCEPTANCE_ACTOR_LABEL", "ACCEPTANCE_SAMPLE_PRODUCTS", "acceptanceWorkspaceOf", "AcceptanceWorkspace", "PrepItemKey", "PrepItemResult", "PrepStatus"],
  "@/lib/format": ["todayVN", "vnStartOfDay"],
  // «Nhập hàng» (createStockReceipt) và «tồn đầu» khi nhập sản phẩm từ tệp cùng ghi qua lõi này.
  "@/lib/inventory/receipt-create": ["writeStockReceiptCore"],
  "@/lib/inventory/receipt-pricing": ["priceReceiptLines", "receiptPricingModeFor"],
  "@/lib/platform/capabilities": ["getEnabledModules", "invalidateCapabilities"],
  "@/lib/platform/context": ["withOrganization"],
  "@/lib/platform/organizations": ["findOrganization", "invalidateOrganizations"],
  // /setup: chọn tên miền con → Xuất bản.
  "@/lib/platform/publish": ["publicationOf", "publishOrganization", "setDomainSlug"],
  "@/lib/queries/stock": ["availableStockExpr", "stockKnownExpr", "variantReceiptsSubquery", "variantSalesSubquery"],
  // Sản phẩm → Tạo sản phẩm.
  "@/lib/records/product-create": ["createProductCore"],
  "@/lib/saas/acceptance-guard": ["acceptanceRuntimeRefusal", "acceptanceWorkspaceOwned", "ACCEPTANCE_NOT_OWNED_REFUSAL"],
  "@/lib/saas/visibility": ["customerChatbotConfig"],
  "@/lib/sales-chatbot/config": ["SalesChatbotConfig"],
  "@/lib/sales-chatbot/engine": ["loadSalesChatbotConfig"],
  // AI Sales → Lưu (lõi của khách: giữ nguyên ô động cơ AI).
  "@/lib/sales-chatbot/settings": ["saveSalesChatbotConfig"],
  "@/lib/validation/stock": ["stockReceiptSchema"],
};

function testPrepSource() {
  const src = readFileSync(path.join(goc, "lib", "saas", "acceptance-prep.ts"), "utf8");
  const imports = importsOf(src);
  assert.equal(imports.length, src.match(/^import\s/gm)?.length ?? 0, "đọc được MỌI mệnh đề import của tệp chuẩn bị");
  const ngoai = imports.flatMap((i) => i.names.filter((n) => !(PREP_IMPORT_ALLOWLIST[i.from] ?? []).includes(n)).map((n) => `${i.from} → ${n}`));
  assert.deepEqual(ngoai, [], "tệp chuẩn bị chỉ nhập tên trong PREP_IMPORT_ALLOWLIST — lõi ghi mới phải qua review");
  const code = codeOnly(src);
  assert.ok(!/\brequire\(|\bimport\(/.test(code), "không nạp động (vượt allowlist)");
  // Không ghi vòng qua lõi: không insert / update / delete thẳng, không lưu cài đặt thẳng, không đường của người vận hành, không AI trả tiền.
  for (const cam of [".insert(", ".update(", ".delete(", "setSettingJson", "AsOperator(", "ForTests(", "chatTurn", "openConversation", "salesChatProvider", "confirmOrderReviewCore", "createManualOrderCore", "setOrgBilling", "setOrgAiControl", "setPlatformAi"]) {
    assert.ok(!code.includes(cam), `lib/saas/acceptance-prep.ts không được dùng ${cam}`);
  }
  // Ba lá chắn, theo ĐÚNG thứ tự, TRƯỚC mọi lượt ghi: lúc chạy → sổ khai → sở hữu → mới tới các việc.
  const fn = code.slice(code.indexOf("export async function runAcceptancePrep("), code.indexOf("async function ownerSessionUser("));
  const at = (needle: string) => fn.indexOf(needle);
  assert.ok(at("acceptanceRuntimeRefusal()") > 0 && at("acceptanceRuntimeRefusal()") < at("await "), "(1) lá chắn lúc chạy đứng đầu, trước lượt await đầu tiên");
  assert.ok(at("acceptanceWorkspaceOf(code)") > at("acceptanceRuntimeRefusal()"), "(2) sổ khai — mục do SỔ trả");
  assert.ok(at("await acceptanceWorkspaceOwned(entry)") > at("acceptanceWorkspaceOf(code)"), "(3) sở hữu");
  for (const step of ["prepProduct(", "prepStock(", "prepBot(", "prepPublish("]) assert.ok(at(step) > at("await acceptanceWorkspaceOwned(entry)"), `${step} chỉ sau ba lá chắn`);
  // Bot đi ĐÚNG hình đầu vào của form khách (không ô động cơ AI).
  assert.ok(code.includes("...customerChatbotConfig(cfg)"), "bật bot gửi cấu hình dạng của KHÁCH — không đụng nguồn AI / model");
}

function testSource() {
  const files = trackedSources();
  assert.ok(files.includes("lib/users/password-reset.ts") && files.includes("tests/saas-acceptance.test.ts"), "đọc được danh sách tệp đã vào kho");
  // MỌI lần nhắc tới định danh trong MÃ (gọi · nhập · xuất lại · đổi tên) trên mọi tệp đã vào kho — không chỉ chuỗi `tên(`.
  const mentions = (id: string) => files.filter((f) => new RegExp(`\\b${id}\\b`).test(codeOnly(readFileSync(path.join(goc, f), "utf8")))).sort();
  // Bước P: định nghĩa + lõi ops (nơi gọi duy nhất) + bài kiểm này — không server action / trang nào gọi được.
  assert.deepEqual(mentions("runAcceptancePrep"), ["lib/saas/acceptance-prep.ts", "lib/saas/acceptance.ts", "tests/saas-acceptance.test.ts"], "runAcceptancePrep chỉ được nhắc tới ở lõi ops nghiệm thu");
  // Đường phát liên kết của MÁY: định nghĩa + lõi ops (nơi gọi duy nhất) + bài kiểm này.
  assert.deepEqual(mentions("createAcceptanceResetLink"), ["lib/saas/acceptance.ts", "lib/users/password-reset.ts", "tests/saas-acceptance.test.ts"], "createAcceptanceResetLink chỉ được nhắc tới ở lõi ops nghiệm thu (không xuất lại, không đổi tên)");
  // Luật gửi lại kích hoạt: MỘT bản — nút người vận hành (sau cổng) + ops nghiệm thu (sau lá chắn).
  assert.deepEqual(mentions("resendActivation"), ["lib/saas/acceptance.ts", "lib/saas/activation.ts", "lib/saas/console.ts", "tests/saas-acceptance.test.ts"]);
  // Ba lá chắn của đường máy, theo ĐÚNG thứ tự, TRƯỚC lượt ghi: lúc chạy → cặp sổ khai → sở hữu → mới tới lõi chung.
  const reset = readFileSync(path.join(goc, "lib", "users", "password-reset.ts"), "utf8");
  const fn = reset.slice(reset.indexOf("export async function createAcceptanceResetLink("), reset.indexOf("async function issueCustomerAccountLink("));
  const at = (needle: string) => fn.indexOf(needle);
  assert.ok(at("const runtime = acceptanceRuntimeRefusal();") > 0 && at("if (runtime) return { error: runtime };") > at("const runtime"), "(b) lá chắn lúc chạy đứng đầu hàm");
  assert.ok(at("if (runtime) return") < at("await "), "(b) lá chắn lúc chạy đứng TRƯỚC lượt await đầu tiên");
  assert.ok(at("email !== entry.ownerEmail) return { error: ACCEPTANCE_REGISTRY_REFUSAL }") > at("if (runtime) return"), "cặp (mã, email) của sổ khai");
  assert.ok(at("if (!(await acceptanceWorkspaceOwned(entry))) return { error: ACCEPTANCE_NOT_OWNED_REFUSAL };") > at("ACCEPTANCE_REGISTRY_REFUSAL"), "(a) kiểm sở hữu ngay trong hàm phát liên kết");
  assert.ok(at("return issueCustomerAccountLink(") > at("acceptanceWorkspaceOwned(entry)"), "(a) lõi chung chỉ sau kiểm sở hữu");
  // Next thay ĐÚNG biểu thức này lúc dựng — đọc qua biến trung gian là mù.
  assert.match(readFileSync(path.join(goc, "lib", "saas", "acceptance-guard.ts"), "utf8"), /nextRuntime: string \| undefined = process\.env\.NEXT_RUNTIME\)/);
  // /login không mã tổ chức: MỘT phép quyết định, form và ops cùng đi qua.
  const auth = readFileSync(path.join(goc, "lib", "actions", "auth.ts"), "utf8");
  // `loginOrganizationsCheck` là CHÍNH phép dò ấy kèm lý do cho sổ lỗi đăng nhập (sứ mệnh saas-ops-signals) — `matchingLoginOrganizations`
  // dẫn xuất từ nó; auth.ts vẫn không được tự lặp vòng kiểm mật khẩu (credentialsMatch / credentialsCheck).
  assert.ok(/(?:matchingLoginOrganizations|loginOrganizationsCheck)\(email, password\)/.test(auth) && !/credentialsMatch\(|credentialsCheck\(/.test(auth), "loginAction dùng phép dò chung, không tự lặp lại phép dò");
  const loginTs = readFileSync(path.join(goc, "lib", "auth", "login.ts"), "utf8");
  assert.ok(/matchingLoginOrganizations[\s\S]{0,200}return \(await loginOrganizationsCheck\(identifier, password\)\)\.matched;/.test(loginTs), "matchingLoginOrganizations dẫn xuất từ loginOrganizationsCheck — một phép dò, hai lối");
  // Lõi ops KHÔNG ghi hộ vào workspace (chỉ đạo 08/10/2026): ALLOWLIST import — mỗi tên nhập phải có trong danh sách khai.
  const core = readFileSync(path.join(goc, "lib", "saas", "acceptance.ts"), "utf8");
  const imports = importsOf(core);
  assert.equal(imports.length, core.match(/^import\s/gm)?.length ?? 0, "đọc được MỌI mệnh đề import của lõi");
  const ngoai = imports.flatMap((i) => i.names.filter((n) => !(CORE_IMPORT_ALLOWLIST[i.from] ?? []).includes(n)).map((n) => `${i.from} → ${n}`));
  assert.deepEqual(ngoai, [], "lõi ops chỉ nhập tên trong CORE_IMPORT_ALLOWLIST — lõi ghi mới phải qua review, không lặng lẽ thêm");
  assert.ok(!/\brequire\(|\bimport\(/.test(codeOnly(core)), "không nạp động (vượt allowlist)");
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
  // Chuẩn bị KHÔNG có --apply ⇒ lỗi cách dùng, không bước nào chạy, không ghi gì.
  const prepNoApply = await captured(() => runAcceptanceCli(["--prep"], deps("nt-guard", book)));
  assert.equal(prepNoApply.value, 64);
  assert.ok(!/^(PASS|FAIL|SKIP) /m.test(prepNoApply.out) && /--prep chỉ đi cùng --apply/.test(summaryLine(prepNoApply.out)), prepNoApply.out);
  assert.deepEqual(await runAcceptancePrep("hslc-hmt-shop", { runId: "nt-guard" }), { refused: ACCEPTANCE_PREP_REGISTRY_REFUSAL }, "tệp chuẩn bị tự từ chối mã ngoài sổ");
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

  // (c) GIỮ CHỖ ở mọi đường tự đăng ký / đặt tên miền: «CDT Nghiem Thu» ra đúng mã nghiệm thu nhưng không bao giờ được cấp nó.
  assert.equal(orgCodeBase("CDT Nghiem Thu"), CODE, "tiền đề: tên cửa hàng này dựng ra đúng mã nghiệm thu");
  const cap = await freeOrgCode("CDT Nghiem Thu");
  assert.ok(cap !== CODE && acceptanceReservedName(cap) === null, `đăng ký nhanh bỏ qua mã giữ chỗ (cấp ${cap})`);
  assert.deepEqual(await checkDomainSlug(ENTRY.domainSlug, "khach-khac"), { ok: false, error: ACCEPTANCE_RESERVED_MESSAGE }, "tổ chức khác không đặt được tên miền con của workspace thử");
  assert.equal((await checkDomainSlug(ENTRY.domainSlug, CODE)).ok, true, "chính workspace thử vẫn đặt được tên miền con của nó (bước người làm ở ACCEPTANCE.md §3)");

  // (d) KHÁCH THẬT TRÙNG CẢ MÃ LẪN EMAIL (đăng ký trước bản giữ chỗ — kho PUBLIC, mã đã lộ): không bước nào chạm vào nó, và chính
  // hàm phát liên kết của máy cũng từ chối (sổ khai một mình KHÔNG đủ — review #690 MEDIUM-1).
  await provisionOrganization({ code: CODE, name: "Khách thật trùng mã", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: ENTRY.ownerEmail, name: "Chủ thật", password: SQUAT_PW }, source: "TEST", actor: null, brand: "chotdon" });
  const goiThang = await createAcceptanceResetLink({ orgCode: CODE, email: ENTRY.ownerEmail, reason: "Gọi thẳng hàm phát liên kết của máy" }, { purpose: "RESET" });
  assert.deepEqual(goiThang, { error: ACCEPTANCE_NOT_OWNED_REFUSAL }, "(a) workspace trùng mã + email mà không do ops tạo ⇒ đường máy từ chối");
  const squat = await captured(() => runAcceptanceCli(["--apply", "--e2e"], deps("nt-squat", book)));
  assert.equal(squat.value, 1);
  assert.match(squat.out, /^FAIL A · workspace nghiệm thu — mã trùng một workspace KHÔNG do ops nghiệm thu tạo/m);
  for (const k of ["B · kích hoạt", "C · vỏ app", "D · chat web", "E · chat công khai", "B · xoay"]) assert.match(squat.out, new RegExp(`^SKIP ${k}`, "m"));
  assert.equal(await credentialsMatch({ email: ENTRY.ownerEmail, password: SQUAT_PW, orgCode: CODE }), true, "mật khẩu của chủ thật NGUYÊN");
  assert.equal((await pdb.select().from(schema.platformProvisioningJobs).where(eq(schema.platformProvisioningJobs.idempotencyKey, acceptanceIdempotencyKey(CODE)))).length, 0, "không cả một job cấp phát hỏng");
  const tokens = await withOrganization(CODE, async () => (await getDb()).select().from(schema.passwordResetTokens));
  assert.equal(tokens.length, 0, "không một liên kết đặt lại nào cho tài khoản của khách thật");
  const nhatKy = await pdb.select().from(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.targetOrgCode, CODE), eq(schema.platformAuditLog.action, "PASSWORD_RESET_LINK")));
  assert.equal(nhatKy.length, 0, "không một dòng nhật ký phát liên kết nào cho workspace của khách thật");
  assertNoSecrets(squat.out, book, "khách trùng mã");
  // Chuẩn bị trên workspace trùng mã: P bỏ qua; gọi thẳng tệp chuẩn bị cũng bị từ chối — không sản phẩm, không phiếu, bot + xuất bản nguyên.
  assert.deepEqual(await runAcceptancePrep(CODE, { runId: "nt-squat-prep" }), { refused: ACCEPTANCE_NOT_OWNED_REFUSAL }, "khách trùng mã: tệp chuẩn bị từ chối ngay cả khi gọi thẳng");
  const squatPrep = await captured(() => runAcceptanceCli(["--apply", "--prep", "--e2e"], deps("nt-squat-prep", book)));
  assert.equal(squatPrep.value, 1);
  assert.match(squatPrep.out, /^SKIP P · chuẩn bị workspace thử — workspace mang mã nghiệm thu nhưng KHÔNG do ops nghiệm thu tạo/m);
  const squatData = await withOrganization(CODE, async () => {
    const db = await getDb();
    return { products: (await db.select().from(schema.products)).length, receipts: (await db.select().from(schema.stockReceipts)).length, bot: await getSettingJson(SALES_CHATBOT_SETTING_KEY, null) };
  });
  assert.deepEqual(squatData, { products: 0, receipts: 0, bot: null }, "khách trùng mã: không sản phẩm, không phiếu kho, cấu hình bot không đổi");
  assert.notEqual((await publicationOf(CODE)).state, "PUBLISHED", "khách trùng mã: không bị xuất bản hộ");
  assertNoSecrets(squatPrep.out, book, "khách trùng mã + chuẩn bị");
  // Diễn tập trên workspace trùng mã: F bỏ qua, không một dòng tín hiệu nào (gương · nhật ký tổ chức) mang mã nghiệm thu.
  resetOrgHealthHotPathForTests();
  const squatDrill = await captured(() => runAcceptanceCli(["--apply", "--drills"], deps("nt-squat-drill", book)));
  assert.equal(squatDrill.value, 1);
  assert.match(squatDrill.out, /^SKIP F · diễn tập tín hiệu vận hành — workspace mang mã nghiệm thu nhưng KHÔNG do ops nghiệm thu tạo/m);
  assert.equal((await pdb.select().from(schema.platformOrgHealth).where(eq(schema.platformOrgHealth.orgCode, CODE))).length, 0, "khách trùng mã: gương sức khoẻ không bị diễn tập chạm");
  const squatAudit = await withOrganization(CODE, async () => (await getDb()).select().from(schema.auditLogs).where(like(schema.auditLogs.correlationId, "nghiem-thu-drill:%")));
  assert.equal(squatAudit.length, 0, "khách trùng mã: không một dòng nhật ký diễn tập trong CSDL của khách thật");
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
  assert.equal(lastShellSessionTtl, ACCEPTANCE_SESSION_TTL_SEC, "phiên ký cho bước C là phiên NGẮN của máy, không phải 7 ngày");
  // ── (6) C phủ đủ tuyến dẫn xuất ──
  assert.match(stepOf(r1, "C").reason, /^10\/10 tuyến của vỏ mở được qua host app\.chotdontudong\.com/);

  // ── O1 luồng LOGIN: lượt mật khẩu SAI của B1 ghi ĐÚNG một dòng sổ lỗi đăng nhập như form /login; lượt ĐÚNG không ghi gì ──
  const loginRows = await pdb.select().from(schema.platformAuthFailures).where(and(eq(schema.platformAuthFailures.orgCode, CODE), eq(schema.platformAuthFailures.flow, "LOGIN")));
  assert.equal(loginRows.length, 1, `đúng MỘT dòng LOGIN (lượt sai), không dòng nào cho lượt đăng nhập đúng: ${JSON.stringify(loginRows.map((r) => r.reasonCode))}`);
  assert.equal(loginRows[0].reasonCode, "BAD_PASSWORD", "lý do lấy từ onFailure của verifyLogin, khác rỗng");
  assert.ok(loginRows[0].identifierMasked?.includes("***") && !loginRows[0].identifierMasked.includes(ENTRY.ownerEmail) && loginRows[0].ipHash === null, "định danh đã che, máy không có IP");
  assert.match(stepOf(r1, "B1").detail.join(" | "), /sổ lỗi đăng nhập: ghi 1 dòng LOGIN\/BAD_PASSWORD cho cdt-nghiem-thu/);
  assert.ok(!/BAD_PASSWORD|sổ lỗi đăng nhập/.test(r1.summary), `lý do đăng nhập KHÔNG ra dòng tóm tắt công khai: ${r1.summary}`);

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

  // ── F · diễn tập tín hiệu (`--apply --drills`): O1 (B1) + O6 sáng qua ĐÚNG đường mã; sáu tín hiệu còn lại khai CHƯA ĐO ĐƯỢC ──
  const homeOrg = await getHomeOrganization();
  const operator: SessionUser = { id: "nt-op", email: "op@nha.local", name: "Vận hành", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: homeOrg.code, name: homeOrg.name, isHome: true } };
  const signalOf = async (k: string) => {
    const r = await loadOrgOpsSignals(operator, CODE, { aiSalesEnabled: true });
    assert.ok(r.ok, JSON.stringify(r));
    return r.value.lines.find((l) => l.key === k)!;
  };
  const ovBefore = await signalOf("ORDER_VALIDATION");
  assert.equal(ovBefore.level, "UNKNOWN", `trước diễn tập: chưa có dòng gương ORDER_VALIDATION (${JSON.stringify(ovBefore)})`);
  const cfgBefore = await withOrganization(CODE, () => getSettingJson(SALES_CHATBOT_SETTING_KEY, null));
  const customersBefore = (await withOrganization(CODE, async () => (await getDb()).select({ id: schema.customers.id }).from(schema.customers))).length;
  const aiBefore = (await pdb.select().from(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, CODE))).length;
  resetOrgHealthHotPathForTests();
  const drill = await captured(() => runAcceptanceCli(["--apply", "--drills"], deps("nt-drill", book)));
  assert.equal(drill.value, 0, drill.out);
  assert.match(drill.out, /^PASS F · diễn tập tín hiệu vận hành — diễn tập: ĐÃ DIỄN TẬP O1,O6 · CHƯA ĐO ĐƯỢC O2,O3,O4,O5,O7,O8/m);
  assert.match(drill.out, /O1 LOGIN: ĐÃ DIỄN TẬP \(LOGIN\/BAD_PASSWORD\)/);
  assert.match(drill.out, /O6 ORDER_VALIDATION: ĐÃ DIỄN TẬP \(MISSING_CONTACT · audit \S+\) — executeTool\(create_customer, thiếu SĐT, kênh WEB\) ⇒ order\.validation_failed · gương WARNING/);
  for (const k of ["FB_CONNECTION", "WEBHOOK", "AI", "SEND", "ORDER_WRITE", "QUOTA"] as const) assert.ok(drill.out.includes(`${k}: CHƯA ĐO ĐƯỢC — ${ACCEPTANCE_UNMEASURABLE_DRILLS[k]}`), `${k}: in CHƯA ĐO ĐƯỢC kèm lý do`);
  const drillSummary = summaryLine(drill.out);
  assert.ok(drillSummary.includes("diễn tập: ĐÃ DIỄN TẬP O1,O6 · CHƯA ĐO ĐƯỢC O2,O3,O4,O5,O7,O8") && !/MISSING_CONTACT|BAD_PASSWORD|audit/.test(drillSummary), drillSummary);
  assertNoSecrets(drill.out, book, "lượt diễn tập");
  // Mức tín hiệu ĐỔI cho workspace nghiệm thu — đọc qua ĐÚNG hàm của khung /platform/org.
  const ovAfter = await signalOf("ORDER_VALIDATION");
  assert.ok(ovAfter.level === "WARNING" && ovAfter.lastReason === "MISSING_CONTACT" && ovAfter.correlationId === "nghiem-thu-drill:nt-drill", `sau diễn tập: O6 CẢNH BÁO đúng lý do + id diễn tập (${JSON.stringify(ovAfter)})`);
  const loginAfter = await signalOf("LOGIN");
  assert.equal(loginAfter.level, "WARNING", "O1 vẫn sáng (B1 của lượt diễn tập)");
  const drillAudit = await withOrganization(CODE, async () => (await getDb()).select().from(schema.auditLogs).where(eq(schema.auditLogs.correlationId, "nghiem-thu-drill:nt-drill")));
  assert.equal(drillAudit.length, 1, "đúng MỘT dòng order.validation_failed của lượt diễn tập");
  assert.equal(drillAudit[0].action, "order.validation_failed");
  // Không đổi gì của workspace: không khách mới (công cụ từ chối trước lượt ghi), cấu hình bot nguyên vẹn, không lượt AI nào.
  assert.equal((await withOrganization(CODE, async () => (await getDb()).select({ id: schema.customers.id }).from(schema.customers))).length, customersBefore, "diễn tập không tạo khách");
  assert.deepEqual(await withOrganization(CODE, () => getSettingJson(SALES_CHATBOT_SETTING_KEY, null)), cfgBefore, "diễn tập không đổi cấu hình bot");
  assert.equal((await pdb.select().from(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, CODE))).length, aiBefore, "diễn tập không gọi AI");

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

  // ── P · chuẩn bị (`--apply --prep`, quyết định chủ shop 09/10/2026): ĐÚNG lõi của nút UI, đứng tên CHỦ workspace thử, idempotent ──
  const sample = ACCEPTANCE_SAMPLE_PRODUCTS[0];
  const aiRows = async () => (await pdb.select().from(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, CODE))).length;
  const aiBeforePrep = await aiRows();
  const ownerId = await acceptanceUserId();
  assert.ok(ownerId);
  const prepState = () =>
    withOrganization(CODE, async () => {
      const db = await getDb();
      const variants = await db.select({ id: schema.productVariants.id, productId: schema.productVariants.productId, price: schema.productVariants.retailPrice }).from(schema.productVariants).where(eq(schema.productVariants.sku, sample.sku));
      const receipts = await db.select({ id: schema.stockReceipts.id, kind: schema.stockReceipts.kind, total: schema.stockReceipts.totalQuantity, createdBy: schema.stockReceipts.createdBy }).from(schema.stockReceipts);
      const items = await db.select({ receiptId: schema.stockReceiptItems.receiptId, variantId: schema.stockReceiptItems.variantId, quantity: schema.stockReceiptItems.quantity }).from(schema.stockReceiptItems);
      const products = (await db.select({ id: schema.products.id }).from(schema.products)).length;
      const audits = await db.select({ action: schema.auditLogs.action, userId: schema.auditLogs.userId }).from(schema.auditLogs).where(inArray(schema.auditLogs.action, ["PRODUCT_CREATE", "STOCK_RECEIPT_CREATE", "SALES_CHATBOT_CONFIG", "ORG_DOMAIN_SET", "ORG_PUBLISH"]));
      return { variants, receipts, items, products, audits, bot: await loadSalesChatbotConfig() };
    });
  /** Khả dụng của mẫu mã theo ĐÚNG luật sổ kho (cùng hàm bot dùng khi chốt): `null` = chưa biết tồn (chưa có phiếu nhập). */
  const availableNow = (variantId: string) =>
    withOrganization(CODE, async () => {
      const db = await getDb();
      if (!(await shortfalls(db, new Map([[variantId, 1_000_000]]))).length) return null;
      return (await shortfalls(db, new Map([[variantId, 1_000_000]])))[0].available;
    });
  const stepLines = (out: string) => [...out.matchAll(/^(?:PASS|FAIL|SKIP) (\S+) · /gm)].map((m) => m[1]);
  const PRIVATE = (out: string, ids: string[]) => {
    const line = summaryLine(out);
    for (const id of [...ids, sample.sku, ENTRY.ownerEmail, "@"]) assert.ok(!line.includes(id), `dòng công khai không mang id / SKU / email: ${line}`);
    return line;
  };
  const AI_ENV = ["PLATFORM_AI_ENABLED", "PLATFORM_AI_API_KEY", "PLATFORM_AI_PROVIDER", "PLATFORM_AI_MODEL"] as const;
  const savedAiEnv = Object.fromEntries(AI_ENV.map((k) => [k, process.env[k]]));
  try {
    // (a) AI dùng chung CHƯA sẵn sàng: sản phẩm · phiếu · xuất bản ĐÃ LÀM; bot BỎ QUA kèm ĐÚNG phần thiếu (không đổi cấu hình AI nào).
    for (const k of AI_ENV) delete process.env[k];
    const p1 = await captured(() => runAcceptanceCli(["--apply", "--prep"], deps("nt-prep-1", book)));
    assert.equal(p1.value, 0, p1.out);
    assert.deepEqual(stepLines(p1.out), ["A", "B", "P", "C", "D", "E", "B"], "thứ tự: A → B1 → P → C → D → E → B2");
    assert.match(p1.out, /^SKIP P · chuẩn bị workspace thử — chuẩn bị: ĐÃ LÀM sản phẩm mẫu,phiếu nhập,xuất bản · BỎ QUA bot/m);
    assert.match(p1.out, /bot: BỎ QUA — AI của bot chưa sẵn sàng: Nền tảng chưa bật AI dùng chung[^\n]*\/platform\/org\/cdt-nghiem-thu; chuẩn bị KHÔNG đổi cấu hình AI nền tảng/);
    assert.match(p1.out, /^PASS E · chat công khai theo tên miền con — https:\/\/cdt-nghiem-thu\.nt\.erp\.test\/chat/m, "E chạy SAU P trong cùng lượt ⇒ đã xuất bản");
    const s1 = await prepState();
    assert.equal(s1.variants.length, 1, "đúng MỘT mẫu mã SKU mẫu");
    assert.equal(s1.products, 1, "đúng MỘT sản phẩm");
    assert.equal(s1.variants[0].price, sample.priceVnd);
    const vid = s1.variants[0].id;
    assert.deepEqual(s1.receipts.map((r) => [r.kind, r.total]), [["RECEIPT", sample.minStock]], "đúng MỘT phiếu NHẬP HÀNG, đủ mức tối thiểu");
    assert.deepEqual(s1.items.map((i) => [i.variantId, i.quantity]), [[vid, sample.minStock]]);
    assert.equal(await availableNow(vid), sample.minStock, "khả dụng theo sổ kho = mức tối thiểu");
    assert.equal(s1.bot.enabled, false, "AI chưa sẵn sàng ⇒ bot KHÔNG bật");
    const pub1 = await publicationOf(CODE);
    assert.ok(pub1.state === "PUBLISHED" && pub1.slug === ENTRY.domainSlug, JSON.stringify(pub1));
    // Đứng tên CHỦ workspace thử (khoá tài khoản — AGENTS 34), không phải người vận hành / máy.
    for (const a of ["PRODUCT_CREATE", "STOCK_RECEIPT_CREATE", "ORG_DOMAIN_SET", "ORG_PUBLISH"]) assert.ok(s1.audits.some((x) => x.action === a && x.userId === ownerId), `${a} đứng tên chủ workspace thử: ${JSON.stringify(s1.audits)}`);
    const l1 = PRIVATE(p1.out, [vid, s1.receipts[0].id, ownerId]);
    assert.ok(l1.startsWith("saas-acceptance: PASS 5/5 · bỏ qua P, D · chế độ GHI") && l1.includes("chuẩn bị: ĐÃ LÀM sản phẩm mẫu,phiếu nhập,xuất bản · BỎ QUA bot"), l1);
    assertNoSecrets(p1.out, book, "chuẩn bị lượt 1");

    // (b) AI dùng chung sẵn sàng (môi trường của nền tảng — bài kiểm đặt, chuẩn bị KHÔNG đặt): bot ĐÃ LÀM, phần còn lại CÓ SẴN.
    process.env.PLATFORM_AI_ENABLED = "1";
    process.env.PLATFORM_AI_API_KEY = "khoa-ai-nen-tang-gia-nt";
    process.env.PLATFORM_AI_PROVIDER = "gemini";
    const p2 = await captured(() => runAcceptanceCli(["--apply", "--prep"], deps("nt-prep-2", book)));
    assert.equal(p2.value, 0, p2.out);
    assert.match(p2.out, /^PASS P · chuẩn bị workspace thử — chuẩn bị: ĐÃ LÀM bot · CÓ SẴN sản phẩm mẫu,phiếu nhập,xuất bản/m);
    const s2 = await prepState();
    assert.ok(s2.bot.enabled, "bot đã bật");
    assert.ok(ACCEPTANCE_PREP_REQUIRED_TOOLS.every((t) => s2.bot.allowedTools.includes(t)), "đủ công cụ tìm / lên nháp / chốt");
    assert.ok(!s2.bot.businessHours.enabled, "giờ làm việc luôn mở");
    assert.equal(s2.bot.connectorKey, s1.bot.connectorKey, "nguồn AI (ô của người vận hành) giữ nguyên");
    assert.ok(s2.audits.some((x) => x.action === "SALES_CHATBOT_CONFIG" && x.userId === ownerId), "lưu cấu hình bot đứng tên chủ");
    assert.equal(s2.variants.length, 1);
    assert.equal(s2.receipts.length, 1, "lượt hai không lập phiếu thêm");

    // (c) MỘT lượt `--apply --prep --e2e`: P CÓ SẴN hết (không ghi gì), rồi D nhắn bot → đơn, E chat công khai — A → B1 → P → C → D → E → B2.
    invalidateOrganizations();
    const runId = "nt-e2e-1";
    setSalesChatProviderForTests(() => fakeProvider(acceptanceShopScript(vid, runId)));
    const before = await withOrganization(CODE, async () => ({ products: (await (await getDb()).select().from(schema.products)).length, bot: await getSettingJson(SALES_CHATBOT_SETTING_KEY, {}) }));
    const e2e = await captured(() => runAcceptanceCli(["--apply", "--prep", "--e2e"], deps(runId, book)));
    setSalesChatProviderForTests(null);
    assert.equal(e2e.value, 0, e2e.out);
    assert.deepEqual(stepLines(e2e.out), ["A", "B", "P", "C", "D", "E", "B"], "thứ tự --apply --prep --e2e: A → B1 → P → C → D → E → B2");
    assert.match(e2e.out, /^PASS P · chuẩn bị workspace thử — chuẩn bị: CÓ SẴN sản phẩm mẫu,phiếu nhập,bot,xuất bản/m);
    assert.match(e2e.out, /^PASS D · chat web → AI → đơn — AI trả lời 3 lượt · đơn #\S+ CONFIRMED trong OMS · 2 × NT-AO-01 · SĐT \+ xã khớp/m);
    assert.match(e2e.out, /^PASS E · chat công khai theo tên miền con — https:\/\/cdt-nghiem-thu\.nt\.erp\.test\/chat ⇒ 200 \+ tên shop/m);
    assert.match(e2e.out, /miền gốc đang dùng: nt\.erp\.test/);
    const l3 = PRIVATE(e2e.out, [vid, ownerId]);
    assert.ok(l3.startsWith("saas-acceptance: PASS 7/7 · chế độ GHI + E2E") && l3.includes("chuẩn bị: CÓ SẴN sản phẩm mẫu,phiếu nhập,bot,xuất bản"), l3);
    assertNoSecrets(e2e.out, book, "E2E");
    const after = await withOrganization(CODE, async () => {
      const db = await getDb();
      const conv = (await db.select().from(schema.salesChatConversations))[0];
      const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, conv.orderId!) });
      const items = await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, conv.orderId!));
      return { products: (await db.select().from(schema.products)).length, bot: await getSettingJson(SALES_CHATBOT_SETTING_KEY, {}), conv, order, items };
    });
    assert.equal(after.order?.stage, "CONFIRMED", "đơn trong OMS đã xác nhận");
    assert.deepEqual(after.items.map((i) => [i.variantId, i.quantity]), [[vid, ACCEPTANCE_ORDER.quantity]]);
    assert.ok(after.order?.note?.includes(runId), "ghi chú khách gửi (mang mã lượt chạy) nằm trên đơn");
    assert.equal(after.conv.channel, "WEB", "đi đúng kênh chat công khai");
    assert.equal(after.products, before.products, "lượt có sẵn chuẩn bị + bước D KHÔNG tạo sản phẩm");
    assert.deepEqual(after.bot, before.bot, "lượt có sẵn chuẩn bị + bước D KHÔNG đổi cấu hình bot");

    const usage = await pdb.select().from(schema.platformAiUsage).where(and(eq(schema.platformAiUsage.orgCode, CODE), eq(schema.platformAiUsage.conversationId, after.conv.id)));
    assert.ok(usage.length > 0, "lượt AI được ghi sổ (chi phí đọc từ đó)");

    // (d) Đơn bot vừa chốt giữ 2 cái ⇒ khả dụng hụt dưới mức tối thiểu ⇒ lượt chuẩn bị sau lập ĐÚNG MỘT phiếu cho phần chênh.
    assert.equal(await availableNow(vid), sample.minStock - ACCEPTANCE_ORDER.quantity, "đơn đã chốt chưa xuất trừ vào khả dụng");
    const p4 = await captured(() => runAcceptanceCli(["--apply", "--prep"], deps("nt-prep-4", book)));
    assert.equal(p4.value, 0, p4.out);
    assert.match(p4.out, /^PASS P · chuẩn bị workspace thử — chuẩn bị: ĐÃ LÀM phiếu nhập · CÓ SẴN sản phẩm mẫu,bot,xuất bản/m);
    const s4 = await prepState();
    assert.deepEqual(s4.receipts.map((r) => r.total).sort((a, b) => (a ?? 0) - (b ?? 0)), [ACCEPTANCE_ORDER.quantity, sample.minStock], "phiếu thứ hai = đúng phần chênh");
    assert.equal(await availableNow(vid), sample.minStock, "khả dụng về lại mức tối thiểu");
    assert.equal(await aiRows(), aiBeforePrep + usage.length, "chuẩn bị KHÔNG gọi AI — chỉ lượt chat của D vào sổ AI");
  } finally {
    setSalesChatProviderForTests(null);
    for (const k of AI_ENV) {
      if (savedAiEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedAiEnv[k];
    }
  }

  // ── Workspace thử KHÔNG phải khách (review #690 MEDIUM-2, «không fake analytics»): đã kích hoạt + có đơn CONFIRMED + có lượt AI,
  //    vẫn không vào sổ kinh tế SaaS, buồng lái, phễu kích hoạt, mốc vòng đời, phân bổ chi phí, kinh tế sản phẩm, ô đếm khách. ──
  await captureSaasSnapshot(new Date());
  assert.equal((await pdb.select().from(schema.platformSaasDaily).where(eq(schema.platformSaasDaily.orgCode, CODE))).length, 0, "sổ kinh tế không chụp MRR của workspace thử");
  assert.equal((await pdb.select().from(schema.platformOrgMilestones).where(eq(schema.platformOrgMilestones.orgCode, CODE))).length, 0, "không mốc vòng đời / kích hoạt nào cho workspace thử");
  assert.equal((await pdb.select().from(schema.platformTenantUsageDaily).where(eq(schema.platformTenantUsageDaily.orgCode, CODE))).length, 0, "không số dùng theo ngày cho workspace thử");
  const home = await getHomeOrganization();
  const op: SessionUser = { id: "nt-op", email: "op@nghiem-thu.local", name: "OP", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: home.code, name: home.name, isHome: true } };
  const ck = await loadOwnerCockpit(op);
  if (!ck.ok) assert.fail(ck.error);
  assert.ok(!ck.value.tenants.some((t) => t.code === CODE), "buồng lái: không có dòng khách cho workspace thử");
  assert.deepEqual(ck.value.testWorkspaces.codes, [CODE], "buồng lái nói RA workspace thử nào bị loại");
  assert.ok(ck.value.testWorkspaces.aiRequests > 0, "chi phí AI của lượt nghiệm thu in riêng, không bị giấu");
  invalidateOrganizations();
  const khach = (await listOrganizations()).filter((o) => !o.isHome && o.status !== "ARCHIVED" && o.status !== "SETUP_FAILED" && o.code !== CODE).length;
  assert.equal(ck.value.headline.tenants, khach, "số tổ chức khách không đếm workspace thử");
  assert.equal(ck.value.activationOrgs, khach, "phễu kích hoạt không đếm workspace thử");
  const snap = await loadCommercialSnapshot();
  const thu = snap.customers.find((c) => c.account.code === ENTRY.accountCode);
  assert.ok(thu?.test, "danh sách khách vẫn có tài khoản thử, mang cờ «Kiểm thử»");
  assert.ok(snap.customers.every((c) => c === thu || !c.test), "chỉ tài khoản thử mang cờ");
  assert.deepEqual(thu.workspaces.flatMap((w) => w.allocated), [], "phân bổ chi phí chung (EQUAL_ACTIVE_WORKSPACES) không chia cho workspace thử");
  assert.ok(thu.workspaces.some((w) => w.subscriptions.some((s) => s.productKey === "chotdon")), "tiền đề: tài khoản thử thuê Chốt Đơn");
  const chotdon = productEconomics(snap).find((e) => e.product.key === "chotdon");
  assert.equal(chotdon?.customers, snap.customers.filter((c) => !c.test && c.workspaces.some((w) => w.subscriptions.some((s) => s.productKey === "chotdon"))).length, "kinh tế sản phẩm không đếm tài khoản thử");
}

export async function testSaasAcceptance() {
  testPure();
  await testProbe();
  testSource();
  testPrepSource();
  let failure: unknown = null;
  try {
    await cleanup();
    await testGuardAndSquatter();
    // Workspace trùng mã KHÔNG do ops tạo ⇒ B1 không chạy ⇒ không một dòng sổ lỗi đăng nhập nào mang mã nghiệm thu.
    const squat = await (await getPlatformDb()).select().from(schema.platformAuthFailures).where(and(eq(schema.platformAuthFailures.orgCode, CODE), eq(schema.platformAuthFailures.flow, "LOGIN")));
    assert.equal(squat.length, 0, "khách trùng mã: ops không ghi sổ lỗi đăng nhập cho workspace không phải của nó");
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

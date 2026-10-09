/**
 * ═══════════ NGHIỆM THU KHÁCH CHỐT ĐƠN TRÊN PRODUCTION — LÕI CỦA OPS `saas-acceptance` (docs/saas/ACCEPTANCE.md) ═══════════
 *
 * Smoke sau deploy (`scripts/smoke.ts`) đi vai NGƯỜI NHÀ; lượt này đi vai KHÁCH, trên MỘT workspace thử có tên trong sổ khai
 * `lib/constants/saas-acceptance.ts` (mã ngoài sổ ⇒ từ chối trước mọi lượt đọc). Sáu bước, chạy theo thứ tự A → B1 → C → D → E → B2:
 *
 *  A  · workspace thử: `--apply` tạo / đảm bảo qua ĐÚNG job «Tạo khách» (`requestProvisioning` — dịch vụ form «Tạo khách mới» gọi),
 *       người thao tác là MÁY (`actor = null`, AGENTS 34); mọi chế độ kiểm: job xong · thuộc ops này · thương hiệu · gói dùng thử của
 *       bảng giá catalog đang hiệu lực + ghim V1 · module Chốt Đơn · mẫu (nếu job có bước đó) · chỉ mục danh tính · AI theo gói.
 *  B1 · kích hoạt + đăng nhập: liên kết qua ĐÚNG hàm của nút «Gửi lại kích hoạt» (`resendActivation`, phát bằng đường của máy
 *       `createAcceptanceResetLink`) → hàm của trang `/reset/<mã>/<token>` → lõi của form `/login` KHÔNG mã tổ chức
 *       (`matchingLoginOrganizations` + `verifyLogin`) ⇒ đúng workspace thử; mật khẩu sai ⇒ từ chối. Mật khẩu SINH TRONG BỘ NHỚ.
 *  C  · vỏ app: phiên ký như smoke ký cho người nhà (`signSession` — cùng hàm của lượt đăng nhập), GET thật mọi mục của vỏ (danh sách
 *       DẪN XUẤT từ `salesAgentNavFor`) + `/` + một tuyến ERP vỏ phải chặn, qua host của thương hiệu Chốt Đơn.
 *  D  · (`--e2e`) chat web → AI → đơn: CHỈ ĐỌC phần chuẩn bị (sản phẩm mẫu · bot bật + AI sẵn sàng — người làm MỘT lần trên UI,
 *       ACCEPTANCE.md §3; thiếu ⇒ SKIP có lý do, KHÔNG tự ghi), rồi nhắn bằng ĐÚNG lõi chat công khai gọi sau bước định tuyến
 *       (`openConversation("WEB")` · `chatTurn`) — đơn do BOT tạo / chốt là hành vi sản phẩm bình thường. Đọc đơn trong OMS + chi phí AI.
 *  E  · chat công khai: `<slug>.<PLATFORM_BASE_DOMAIN>/chat` (qua ứng dụng với Host đó, và qua mạng ngoài thật) ⇒ 200 + tên shop.
 *       Chưa xuất bản ⇒ SKIP kèm việc người làm (xuất bản ghi vào workspace dưới danh tính quản trị — không tự làm).
 *  F  · (`--drills`, chen trước B2) diễn tập tín hiệu vận hành O1–O8 qua ĐÚNG đường mã ghi tín hiệu, đầu vào cố ý sai — tín hiệu không
 *       diễn tập trung thực được in «CHƯA ĐO ĐƯỢC» kèm lý do (docs/saas/ACCEPTANCE.md §10).
 *  B2 · xoay mật khẩu: đặt một mật khẩu ngẫu nhiên MỚI rồi vứt — mật khẩu của lượt chạy không còn đăng nhập được, mọi phiên bị thu hồi.
 *       Chạy CUỐI và chạy cả khi bước giữa hỏng.
 *
 * ─── KHÔNG GHI HỘ VÀO WORKSPACE (chỉ đạo 08/10/2026) ───
 * Ops này KHÔNG có lõi «ghi thay quản trị khách» nào: không tạo sản phẩm, không bật bot, không xuất bản, không bấm xác nhận đơn hộ ai.
 * Ghi duy nhất của nó: job cấp phát (mặt phẳng điều khiển), liên kết kích hoạt / đặt lại + mật khẩu + lượt đăng nhập của CHÍNH tài
 * khoản thử, và các lượt nhắn của khách vào bot (đường công khai, không cần quyền).
 *
 * ─── BÍ MẬT ───
 * Mật khẩu, mã liên kết, phiên ký chỉ sống trong bộ nhớ của tiến trình; mọi dòng in ra (kể cả phần mã hoá) đi qua `scrubSecrets`.
 * Không in liên kết, không ghi tệp, không ghi log.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, schema } from "@/db";
import { foldVnText, resolveRecipientPlace } from "@/lib/address/vn-address";
import { findIdentity } from "@/lib/auth/identities";
import { matchingLoginOrganizations, verifyLogin, type LoginFailureNote } from "@/lib/auth/login";
import { signSession, type SessionSubject } from "@/lib/auth/session";
import { shortfalls } from "@/lib/commerce/stock";
import {
  ACCEPTANCE_ACTOR_LABEL,
  ACCEPTANCE_NUDGE_TURN,
  ACCEPTANCE_ORDER,
  ACCEPTANCE_REGISTRY_REFUSAL,
  ACCEPTANCE_DRILL_ID_PREFIX,
  ACCEPTANCE_SAMPLE_PRODUCTS,
  ACCEPTANCE_UNMEASURABLE_DRILLS,
  ACCEPTANCE_WORKSPACES,
  acceptanceChatTurns,
  acceptanceIdempotencyKey,
  acceptanceStepsFor,
  acceptanceSummary,
  acceptanceVerdict,
  acceptanceWorkspaceOf,
  drillStepStatus,
  drillSummaryPart,
  formatAcceptanceUsd,
  formatDrillLine,
  formatStepLine,
  PAGE_ERROR_DIGEST,
  PAGE_ERROR_MARKER,
  scrubSecrets,
  type AcceptanceMode,
  type AcceptanceStepKey,
  type AcceptanceWorkspace,
  type DrillResult,
  type StepResult,
  type StepStatus,
} from "@/lib/constants/saas-acceptance";
import { OPS_SIGNAL_KEYS, ORDER_VALIDATION_FAILED_ACTION } from "@/lib/constants/ops-signals";
import { ERP_FRAME_HTML_MARKERS, FORBIDDEN_PARAM, isSalesAgentUser, SALES_AGENT_DENIED_PREFIXES, SALES_AGENT_SHELL_HTML_MARKER, SHELL_BLOCKED_PARAM, salesAgentNavFor, salesAgentRedirectFor, type ShellUser } from "@/lib/constants/saas-nav";
import { SESSION_COOKIE } from "@/lib/constants/session";
import { revokeMarkFrom } from "@/lib/constants/session-revocation";
import { env } from "@/lib/env";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { HOST_NOT_FOUND_MESSAGE } from "@/lib/platform/host-org";
import { recordAuthFailure } from "@/lib/platform/auth-failures";
import { findOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { platformBaseDomain, publicationOf } from "@/lib/platform/publish";
import { CHOTDON_ASSETS, chotdonAppHost, type SiteEnv } from "@/lib/platform/site-host";
import { AI_STOP_MESSAGE } from "@/lib/pricing/ai-entitlement";
import { loadAiEntitlement } from "@/lib/pricing/ai-gate";
import { loadPriceBook, readPricePin } from "@/lib/pricing/price-book";
import { currentCatalogVersion } from "@/lib/pricing/versions";
import { normalizeCustomerPhone } from "@/lib/records/customer-create";
import { loadAutoConfirmComplete } from "@/lib/records/order-create";
import { accountOfWorkspace } from "@/lib/saas/accounts";
import { acceptanceWorkspaceOwned } from "@/lib/saas/acceptance-guard";
import { activationRefusal, loadWorkspaceActivation, resendActivation } from "@/lib/saas/activation";
import { PRODUCTS } from "@/lib/saas/catalog";
import { readPlans } from "@/lib/saas/customers";
import { requestProvisioning } from "@/lib/saas/provisioning";
import { withinBusinessHours } from "@/lib/sales-chatbot/config";
import { chatTurn, conversationView, EMPTY_REPLY_TEXT, loadSalesChatbotConfig, openConversation, SALES_AGENT, salesChatProvider, visitorKeyOf } from "@/lib/sales-chatbot/engine";
import { executeTool } from "@/lib/sales-chatbot/tools";
import { completePasswordResetCore, createAcceptanceResetLink, lookupResetToken } from "@/lib/users/password-reset";

// ─────────────────────────── Phụ thuộc thay được (bài kiểm: AI giả, HTTP giả, mật khẩu biết trước) ───────────────────────────

export type HttpReply = { status: number; location: string | null; body: string };

export type AcceptanceDeps = {
  now: () => Date;
  /** Mã lượt chạy — đi vào ghi chú đơn và khoá khách truy cập của hội thoại thử, để đối chiếu từng lượt. */
  runId: string;
  /** GET tới ỨNG DỤNG đang chạy (mặc định `http://127.0.0.1:3000`, như smoke) với Host chỉ định — bước C và E (nội bộ). */
  appGet: (path: string, opts: { host: string; cookie?: string; timeoutMs: number }) => Promise<HttpReply>;
  /** GET ra MẠNG NGOÀI thật (DNS + Caddy + chứng chỉ) — bước E. */
  publicGet: (url: string, opts: { timeoutMs: number }) => Promise<HttpReply>;
  /** Mật khẩu ngẫu nhiên — SINH TRONG BỘ NHỚ, không in, không ghi. */
  newPassword: () => string;
  sleep: (ms: number) => Promise<void>;
  /** In MỘT dòng — mọi chữ đã qua `scrubSecrets` trước khi tới đây. */
  emit: (line: string) => void;
  /** Biến môi trường của lớp mặt tiền (host thương hiệu Chốt Đơn). */
  siteEnv: SiteEnv;
  /** Miền gốc của tên miền con (`PLATFORM_BASE_DOMAIN` của tiến trình) — bước E dựng địa chỉ chat công khai từ đây. */
  baseDomain: string | null;
};

/** Trần thân phản hồi giữ lại để soi dấu hiệu — trang vỏ vài trăm kB; quá trần thì phần đầu đã đủ để thấy khung. */
const MAX_BODY_BYTES = 6 * 1024 * 1024;
/** Hạn chờ MỘT lượt GET trang (cùng hạn đầu phản hồi của smoke). */
const PAGE_TIMEOUT_MS = 60_000;
/** Số lần chuyển hướng tối đa theo một tuyến — quá ngần này là vòng lặp, kể cả khi đích không lặp lại nguyên văn. */
const MAX_REDIRECTS = 5;
/** Hạn phiên ký cho bước C — đủ cho 10 tuyến kể cả máy chủ chậm, rồi tự chết. */
export const ACCEPTANCE_SESSION_TTL_SEC = 15 * 60;
/** «IP» của lượt gọi trang `/reset` (kèm mã lượt chạy) — chỉ để dựng khoá bộ chặn dò (băm): lượt cố ý dùng lại liên kết để kiểm «dùng một lần» không dồn bộ đếm của lượt sau. */
const ACCEPTANCE_IP = "ops-saas-acceptance";

function appGetOver(baseUrl: string): AcceptanceDeps["appGet"] {
  return (path, opts) =>
    new Promise<HttpReply>((resolve, reject) => {
      const u = new URL(path, baseUrl);
      const client = u.protocol === "https:" ? https : http;
      const req = client.request(
        { protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: `${u.pathname}${u.search}`, method: "GET", headers: { host: opts.host, "user-agent": "erp-saas-acceptance", ...(opts.cookie ? { cookie: opts.cookie } : {}) } },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size <= MAX_BODY_BYTES) chunks.push(c);
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, location: typeof res.headers.location === "string" ? res.headers.location : null, body: Buffer.concat(chunks).toString("utf8") }));
          res.on("error", reject);
        },
      );
      req.setTimeout(opts.timeoutMs, () => req.destroy(new Error(`không trả lời trong ${Math.round(opts.timeoutMs / 1000)}s`)));
      req.on("error", reject);
      req.end();
    });
}

async function publicGetOverFetch(url: string, opts: { timeoutMs: number }): Promise<HttpReply> {
  // Không cookie, không khoá, không tiêu đề nào của nền tảng — đúng một khách lạ mở trang chat công khai.
  const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs), headers: { "user-agent": "erp-saas-acceptance" } });
  return { status: res.status, location: res.headers.get("location"), body: (await res.text()).slice(0, MAX_BODY_BYTES) };
}

/** Phụ thuộc thật của tiến trình ops (trong container app — có AUTH_SECRET + DATABASE_URL như smoke). */
export function defaultAcceptanceDeps(opts: { emit: (line: string) => void }): AcceptanceDeps {
  const base = (process.env.ACCEPTANCE_APP_URL ?? process.env.SMOKE_URL ?? "http://127.0.0.1:3000").trim();
  return {
    now: () => new Date(),
    runId: `nt-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
    appGet: appGetOver(base),
    publicGet: publicGetOverFetch,
    newPassword: () => `Nt-${randomBytes(24).toString("base64url")}`,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    emit: opts.emit,
    siteEnv: { SITE_DOMAIN: process.env.SITE_DOMAIN, CHOTDON_DOMAIN: process.env.CHOTDON_DOMAIN, APP_URL: process.env.APP_URL, CHOTDON_APP_URL: process.env.CHOTDON_APP_URL },
    baseDomain: platformBaseDomain(),
  };
}

// ─────────────────────────── Kết quả ───────────────────────────

export type AcceptanceReport = {
  /** `true` = lá chắn sổ khai từ chối — KHÔNG có lượt đọc / ghi nào xảy ra. */
  refused: boolean;
  results: StepResult[];
  verdict: "PASS" | "FAIL";
  summary: string;
};

type Outcome = { status: StepStatus; reason: string; detail?: string[] };
const pass = (reason: string, detail: string[] = []): Outcome => ({ status: "PASS", reason, detail });
const fail = (reason: string, detail: string[] = []): Outcome => ({ status: "FAIL", reason, detail });
const skip = (reason: string, detail: string[] = []): Outcome => ({ status: "SKIP", reason, detail });

/** Câu lỗi một dòng, cắt ngắn — lỗi CSDL có thể kèm `params:` ở dòng sau; chỉ giữ dòng đầu. */
function firstLine(error: unknown): string {
  const s = error instanceof Error ? error.message : String(error);
  return (s.split("\n")[0] ?? "").slice(0, 300);
}

/** Mã liên kết `/reset/<mã tổ chức>/<mã>` ⇒ hai phần — không bao giờ in. */
function parseResetLink(link: string): { orgCode: string; token: string } | null {
  const parts = link.split("?")[0].split("/").filter(Boolean);
  if (parts.length < 3) return null;
  try {
    return { orgCode: decodeURIComponent(parts[parts.length - 2]), token: decodeURIComponent(parts[parts.length - 1]) };
  } catch {
    return null;
  }
}

/** Đường dẫn + query của một đích chuyển hướng (bỏ gốc — mọi bước chỉ đi trong ứng dụng). */
function pathOf(location: string): string {
  try {
    const u = new URL(location, "http://ung-dung.local");
    return `${u.pathname}${u.search}`;
  } catch {
    return location;
  }
}

/** Trang 200 mà mang lệnh chuyển hướng của Next (`redirect()` sau khi luồng HTML đã bắt đầu) ⇒ đích của nó. */
export function metaRedirectTarget(body: string): string | null {
  const at = body.indexOf("__next-page-redirect");
  if (at < 0) return null;
  const tagStart = body.lastIndexOf("<meta", at);
  const tagEnd = body.indexOf(">", at);
  const tag = body.slice(tagStart < 0 ? at : tagStart, tagEnd < 0 ? undefined : tagEnd);
  const m = /url=([^"'>]+)/i.exec(tag);
  return m ? m[1].replace(/&amp;/g, "&") : null;
}

// ─────────────────────────── Lõi ───────────────────────────

type Ctx = {
  entry: AcceptanceWorkspace;
  mode: AcceptanceMode;
  deps: AcceptanceDeps;
  secrets: Set<string>;
  /** Workspace có thật VÀ do chính ops này tạo (job khoá cố định + tài khoản trong sổ) — điều kiện để chạm bất cứ gì bên trong. */
  owned: boolean;
  exists: boolean;
  /** Mật khẩu của lượt chạy đang còn hiệu lực (B1 đặt, B2 vứt). Chỉ nằm trong bộ nhớ. */
  knownPassword: string | null;
  /** Mốc đổi mật khẩu gần nhất — phiên ký sau mốc thu hồi (làm tròn LÊN giây) mới sống. */
  lastPasswordChangeMs: number;
  aiCostUsd: number | null;
  baseDomain: string | null;
  /** `--drills`: thêm bước F diễn tập tín hiệu vận hành. */
  drills: boolean;
  /** Mã lý do của dòng LOGIN mà B1 vừa ghi được (bằng chứng O1 của lượt này); `null` = lượt này không ghi được. */
  loginEvidence: string | null;
  /** Kết quả diễn tập (bước F) — dòng tóm tắt công khai đọc số hiệu tín hiệu theo trạng thái từ đây. */
  drillResults: DrillResult[] | null;
};

/**
 * Chạy nghiệm thu. `orgCode` bỏ trống ⇒ mục DUY NHẤT của sổ (sổ nhiều mục ⇒ phải chỉ rõ). Mã ngoài sổ ⇒ `refused`, không một lượt
 * đọc / ghi nào. Không bao giờ ném: mỗi bước tự bắt lỗi của mình thành FAIL.
 */
export async function runAcceptance(input: { orgCode: string | null; mode: AcceptanceMode; drills?: boolean }, deps: AcceptanceDeps): Promise<AcceptanceReport> {
  const secrets = new Set<string>();
  const say = (line: string) => deps.emit(scrubSecrets(line, secrets));
  const target = input.orgCode ? acceptanceWorkspaceOf(input.orgCode) : ACCEPTANCE_WORKSPACES.length === 1 ? ACCEPTANCE_WORKSPACES[0] : null;
  if (!target) {
    const why = input.orgCode ? ACCEPTANCE_REGISTRY_REFUSAL : "Sổ khai nghiệm thu có nhiều mục — chỉ rõ --org=<mã>.";
    say(`TỪ CHỐI — ${why}`);
    return { refused: true, results: [], verdict: "FAIL", summary: acceptanceSummary([], { mode: input.mode, orgCode: null, note: why }) };
  }
  const ctx: Ctx = { entry: target, mode: input.mode, deps, secrets, owned: false, exists: false, knownPassword: null, lastPasswordChangeMs: 0, aiCostUsd: null, baseDomain: deps.baseDomain, drills: input.drills === true && input.mode !== "READ", loginEvidence: null, drillResults: null };
  const results: StepResult[] = [];
  const steps: Record<AcceptanceStepKey, () => Promise<Outcome>> = {
    A: () => stepWorkspace(ctx),
    B1: () => (ctx.mode === "READ" ? Promise.resolve(skip("chế độ CHỈ ĐỌC — kích hoạt + đăng nhập ghi mật khẩu / lượt đăng nhập, chỉ chạy với --apply")) : needOwned(ctx, () => stepActivateAndLogin(ctx))),
    C: () => needOwned(ctx, () => stepShell(ctx)),
    D: () => (ctx.mode !== "E2E" ? Promise.resolve(skip("chỉ chạy với --apply --e2e (nhắn bot thật, tốn AI)")) : needOwned(ctx, () => stepE2e(ctx))),
    E: () => needOwned(ctx, () => stepPublicChat(ctx)),
    // Chỉ có mặt trong lượt `--apply --drills` (acceptanceStepsFor) — và chỉ sau khi A xác nhận workspace là của CHÍNH ops này.
    F: () => needOwned(ctx, () => stepDrills(ctx)),
    B2: () => (ctx.mode === "READ" ? Promise.resolve(skip("chế độ CHỈ ĐỌC — không có mật khẩu nào được đặt")) : stepRotate(ctx)),
  };
  for (const key of acceptanceStepsFor(ctx.drills)) {
    const started = Date.now();
    let out: Outcome;
    try {
      out = await steps[key]();
    } catch (error) {
      out = fail(`lỗi không lường trước: ${firstLine(error)}`);
    }
    const r: StepResult = { key, status: out.status, reason: scrubSecrets(out.reason, secrets), ms: Date.now() - started, detail: (out.detail ?? []).map((d) => scrubSecrets(d, secrets)) };
    results.push(r);
    say(formatStepLine(r));
    for (const d of r.detail) say(`    · ${d}`);
  }
  const summary = acceptanceSummary(results, { mode: input.mode, orgCode: target.code, baseDomain: ctx.baseDomain, aiCostUsd: ctx.mode === "E2E" ? ctx.aiCostUsd : undefined, drills: ctx.drillResults ? drillSummaryPart(ctx.drillResults) : undefined });
  return { refused: false, results, verdict: acceptanceVerdict(results), summary: scrubSecrets(summary, secrets) };
}

/** Bước chạm vào bên trong workspace chỉ chạy khi bước A đã xác nhận workspace là của CHÍNH ops này. */
async function needOwned(ctx: Ctx, fn: () => Promise<Outcome>): Promise<Outcome> {
  if (!ctx.exists) return skip(ctx.mode === "READ" ? "chưa có workspace nghiệm thu — chạy --apply một lần để tạo" : "bước A không tạo / tìm được workspace nghiệm thu");
  if (!ctx.owned) return skip("workspace mang mã nghiệm thu nhưng KHÔNG do ops nghiệm thu tạo — không chạm (xem bước A)");
  return fn();
}

// ─────────────────────────── A · workspace ───────────────────────────

/** Gói dùng thử của bảng giá CATALOG đang hiệu lực — đọc từ sổ giá (dòng giá khai `trial_days`), không gõ cứng khoá gói. */
async function trialPlanOfCatalog(now: Date): Promise<{ planKey: string; versionKey: string } | { error: string }> {
  const book = await loadPriceBook({ fresh: true });
  const catalog = currentCatalogVersion(book, now);
  if (!catalog) return { error: "chưa có bảng giá CATALOG đang hiệu lực — không chọn được gói dùng thử" };
  const trial = book.prices.filter((p) => p.versionKey === catalog.key && p.trialDays !== null).sort((a, b) => a.position - b.position)[0];
  if (!trial) return { error: `bảng giá ${catalog.key} không có gói dùng thử nào` };
  if (!(await readPlans(now)).some((p) => p.key === trial.planKey)) return { error: `gói ${trial.planKey} của bảng giá ${catalog.key} không có trong sổ gói` };
  return { planKey: trial.planKey, versionKey: catalog.key };
}

async function stepWorkspace(ctx: Ctx): Promise<Outcome> {
  const { entry } = ctx;
  const now = ctx.deps.now();
  const products = PRODUCTS.filter((p) => p.brand === entry.brand);
  if (!products.length) return fail(`danh mục không có sản phẩm nào của thương hiệu ${entry.brand}`);
  const plan = await trialPlanOfCatalog(now);
  const detail: string[] = [];
  invalidateOrganizations();
  const before = await findOrganization(entry.code);
  // Mã đã có mà không phải của ops này ⇒ dừng TRƯỚC mọi lượt ghi (kể cả một job cấp phát sẽ hỏng).
  if (before && !(await acceptanceWorkspaceOwned(entry))) {
    ctx.exists = true;
    return fail("mã trùng một workspace KHÔNG do ops nghiệm thu tạo (không có job khoá nghiệm thu / tài khoản khác sổ khai) — không chạm, đổi mã trong sổ khai");
  }
  const prior = await (await getPlatformDb()).query.platformProvisioningJobs.findFirst({ where: eq(schema.platformProvisioningJobs.idempotencyKey, acceptanceIdempotencyKey(entry.code)) });
  if (ctx.mode !== "READ" && before && prior?.status === "SUCCEEDED") {
    // Job đã xong ⇒ KHÔNG gửi lại: `requestProvisioning` so dấu vân lượt gửi lại với đầu vào ĐÃ LƯU (#684), nên một sản phẩm / gói dùng
    // thử mới của bảng giá sẽ biến lượt gửi lại thành «thông tin KHÁC» dù workspace vẫn đúng. Các điều kiện bên dưới đọc thẳng trạng thái.
    detail.push("job «Tạo khách» đã chạy xong từ trước — không gửi lại, không tạo thêm");
  } else if (ctx.mode !== "READ") {
    if ("error" in plan) return fail(plan.error);
    // ĐÚNG job của form «Tạo khách mới» (lib/saas/console.ts → requestProvisioning): thương hiệu + gói TRUYỀN TƯỜNG MINH — chạy được cả
    // trước lẫn sau luật mặc định của #682. Khoá idempotent CỐ ĐỊNH ⇒ job hỏng / treo chạy lại đúng job ấy, không tạo khách thứ hai.
    const res = await requestProvisioning(
      {
        kind: "CREATE_CUSTOMER",
        account: { code: entry.accountCode, name: entry.name, accountType: entry.accountType },
        workspace: { code: entry.code, name: entry.name, planKey: plan.planKey, brand: entry.brand },
        products: products.map((p) => p.key),
        admin: { email: entry.ownerEmail, name: entry.ownerName },
      },
      { actor: null, email: ACCEPTANCE_ACTOR_LABEL, source: "PROVISIONING", idempotencyKey: acceptanceIdempotencyKey(entry.code) },
    );
    if ("error" in res) return fail(`job «Tạo khách» từ chối: ${res.error}`);
    detail.push(`job «Tạo khách» ${res.job.status}${res.reused ? " (job có từ trước — dùng lại, không tạo thêm)" : prior ? " (chạy lại job hỏng / treo)" : " (vừa tạo)"}`);
    invalidateOrganizations();
    invalidateCapabilities(entry.code);
  }
  const org = await findOrganization(entry.code);
  ctx.exists = Boolean(org);
  if (!org) return fail(ctx.mode === "READ" ? "chưa có workspace nghiệm thu — chạy ops với --apply một lần để tạo" : "job xong mà không thấy workspace trong sổ tổ chức", detail);
  // Bằng chứng SỞ HỮU (lần nữa, sau cấp phát): job khoá cố định của ops này cho ĐÚNG mã + tài khoản đúng mã trong sổ.
  ctx.owned = await acceptanceWorkspaceOwned(entry);
  if (!ctx.owned) return fail("mã trùng một workspace KHÔNG do ops nghiệm thu tạo (không có job khoá nghiệm thu / tài khoản khác sổ khai) — không chạm, đổi mã trong sổ khai", detail);
  const pdb = await getPlatformDb();
  const job = await pdb.query.platformProvisioningJobs.findFirst({ where: eq(schema.platformProvisioningJobs.idempotencyKey, acceptanceIdempotencyKey(entry.code)) });
  const account = await accountOfWorkspace(entry.code);
  if (!job || !account) return fail("mất job / tài khoản giữa hai lượt đọc", detail);
  const checks: { ok: boolean; text: string }[] = [];
  const check = (ok: boolean, text: string) => checks.push({ ok, text });
  check(job.status === "SUCCEEDED", `job cấp phát ${job.status}${job.lastError ? ` — ${job.lastError.slice(0, 160)}` : ""}`);
  check(org.status === "ACTIVE" && !org.isHome, `workspace ${org.status}${org.isHome ? " · LÀ NHÀ" : ""}`);
  check(account.accountType === entry.accountType, `tài khoản ${account.accountType} (sổ khai ${entry.accountType})`);
  check(org.brand === entry.brand, `thương hiệu ${org.brand ?? "NULL"} (sổ khai ${entry.brand})`);
  if (!("error" in plan)) check(org.plan === plan.planKey, `gói ${org.plan ?? "—"} (gói dùng thử của bảng giá ${plan.versionKey}: ${plan.planKey})`);
  else check(false, plan.error);
  const pin = await readPricePin(entry.code, { fresh: true });
  const book = await loadPriceBook({ fresh: true });
  check(Boolean(pin && book.versions.find((v) => v.key === pin)?.kind === "CATALOG"), `ghim giá ${pin ?? "CHƯA GHIM"}${pin ? ` (${book.versions.find((v) => v.key === pin)?.kind ?? "không có trong sổ giá"})` : ""}`);
  invalidateCapabilities(entry.code);
  const modules = await getEnabledModules(entry.code);
  const needed = [...new Set(products.flatMap((p) => p.exclusiveModules))];
  check(
    needed.every((m) => modules.has(m)),
    `module Chốt Đơn ${needed.map((m) => `${m}:${modules.has(m) ? "bật" : "TẮT"}`).join(" · ")}`,
  );
  const steps = Array.isArray(job.steps) ? (job.steps as { key?: unknown; status?: unknown; detail?: unknown }[]) : [];
  const tpl = steps.filter((s) => s?.key === "TEMPLATE").pop();
  if (tpl) check(tpl.status === "DONE" || tpl.status === "SKIPPED", `mẫu «Chỉ cần AI bán hàng»: ${String(tpl.status)}${typeof tpl.detail === "string" ? ` — ${tpl.detail.slice(0, 160)}` : ""}`);
  else detail.push("mẫu AI bán hàng: job không có bước TEMPLATE (main chưa có luật cài mẫu của «Tạo khách») — không kiểm");
  const identity = (await findIdentity("EMAIL", entry.ownerEmail)).some((h) => h.orgCode === entry.code);
  check(identity, `chỉ mục đăng nhập email ⇒ workspace: ${identity ? "có" : "THIẾU — /login không mã tổ chức sẽ báo sai mật khẩu"}`);
  const ai = await loadAiEntitlement(entry.code, { now, fresh: true });
  const trialEnd = ai.trialEndsAt ? ai.trialEndsAt.toISOString().slice(0, 10) : "—";
  if (ai.allowed) check(true, `AI theo gói: được trả lời${ai.trial ? ` (dùng thử tới ${trialEnd})` : ""}`);
  else if (ai.reason === "TRIAL_EXPIRED") check(false, `dùng thử HẾT HẠN (${trialEnd}) — gia hạn bằng thao tác người vận hành «Thu phí thuê bao» ở /platform/org/${entry.code} (đặt «Đã trả tới ngày»); ops này KHÔNG tự gia hạn`);
  else check(false, `AI theo gói bị dừng: ${ai.reason ? AI_STOP_MESSAGE[ai.reason] : "không rõ lý do"}`);
  for (const c of checks) detail.push(`${c.ok ? "✓" : "✗"} ${c.text}`);
  const bad = checks.filter((c) => !c.ok);
  if (bad.length) return fail(`${bad.length}/${checks.length} điều kiện hỏng: ${bad.map((c) => c.text).join(" · ").slice(0, 400)}`, detail);
  return pass(`${org.code} đúng cấu hình — ${checks.length}/${checks.length} điều kiện (job xong · ngoài · ${entry.brand} · gói ${org.plan} · ghim ${pin} · module · chỉ mục · AI)`, detail);
}

// ─────────────────────────── B1 · kích hoạt + đăng nhập ───────────────────────────

/**
 * BẰNG CHỨNG O1 CHO LUỒNG ĐĂNG NHẬP (LAUNCH_GATE §4): lượt mật khẩu SAI của B1 phải để lại ĐÚNG một dòng `platform_auth_failures`
 * luồng LOGIN như form `/login` để lại — ops `ops-signals-check` đọc dòng ấy để chứng minh tín hiệu O1 chạy trọn vòng trên production.
 *
 * Vì sao chép HÌNH lời gọi thay vì gọi `loginAction`: `loginAction` là server action (đọc `headers()` của request, ký cookie phiên,
 * chặn dò theo IP) — tiến trình ops không có request. Phép đổi «ghi chú lỗi ⇒ tham số ghi sổ» nằm inline trong `loginAction`, không có
 * hàm xuất khẩu nào để gọi lại; nên ở đây CHỈ lặp lại đúng hình lời gọi `recordAuthFailure` của nó (luồng LOGIN, lý do + tổ chức của
 * `onFailure`, định danh = email đã gõ) — vẫn đi qua ĐƯỜNG GHI DUY NHẤT của sổ (băm + che định danh, tổ chức phải có thật). Khác hai
 * chỗ, có chủ ý: `ip = null` (máy, không có IP người) và `lock = null` (lượt này không qua bộ chặn dò, nên không có cửa sổ khoá).
 *
 * Chỉ ghi cho workspace NGHIỆM THU: bước B1 chỉ chạy sau `needOwned` (A đã xác nhận `acceptanceWorkspaceOwned`), và ở đây hỏi lại cả
 * sổ khai lẫn tổ chức mà `verifyLogin` báo. Ghi sổ là BẰNG CHỨNG, không phải phép kiểm: hỏng ⇒ trả một dòng chi tiết (phần mã hoá),
 * không làm B1 hỏng. Lượt đăng nhập ĐÚNG không bao giờ tới đây (không truyền `onFailure`, và chỉ gọi khi verdict hỏng).
 */
async function recordWrongLoginEvidence(ctx: Ctx, note: LoginFailureNote | null): Promise<string> {
  const { entry } = ctx;
  if (!ctx.owned || acceptanceWorkspaceOf(entry.code)?.code !== entry.code) return "sổ lỗi đăng nhập: KHÔNG ghi — workspace không phải workspace nghiệm thu của ops này";
  if (!note || note.orgCode !== entry.code) return `sổ lỗi đăng nhập: KHÔNG ghi — lượt sai không quy về ${entry.code} (tổ chức ${note?.orgCode ?? "—"})`;
  try {
    const ok = await recordAuthFailure({ flow: "LOGIN", reason: note.reason, orgCode: note.orgCode, identifier: entry.ownerEmail, ip: null, lock: null });
    if (ok) ctx.loginEvidence = note.reason;
    return ok ? `sổ lỗi đăng nhập: ghi 1 dòng LOGIN/${note.reason} cho ${entry.code} (bằng chứng O1)` : `sổ lỗi đăng nhập: KHÔNG ghi được dòng LOGIN/${note.reason} (recordAuthFailure trả false) — thiếu bằng chứng O1, bước vẫn chấm theo phép kiểm`;
  } catch (error) {
    return `sổ lỗi đăng nhập: ghi hỏng (${firstLine(error)}) — thiếu bằng chứng O1, bước vẫn chấm theo phép kiểm`;
  }
}

async function stepActivateAndLogin(ctx: Ctx): Promise<Outcome> {
  const { entry, deps } = ctx;
  const detail: string[] = [];
  const act0 = await loadWorkspaceActivation(entry.code, deps.now());
  if (!act0) return fail("không đọc được trạng thái kích hoạt (workspace không có / là nhà)");
  detail.push(`trạng thái kích hoạt trước lượt chạy: ${act0.state}`);
  const reason = `${ACCEPTANCE_ACTOR_LABEL} ${deps.runId}`;
  let link: string;
  let via: string;
  if (act0.canResend) {
    // ĐÚNG luật của nút «Gửi lại liên kết kích hoạt» (lib/saas/activation.ts), phát bằng đường của máy (ba lá chắn của `createAcceptanceResetLink`).
    const r = await resendActivation({ orgCode: entry.code, reason: `${reason} — kích hoạt tài khoản thử` }, (i) => createAcceptanceResetLink(i, { purpose: "ACTIVATION" }));
    if ("error" in r) return fail(`gửi lại kích hoạt bị từ chối: ${r.error}`, detail);
    link = r.link;
    via = `gửi lại kích hoạt (${act0.state})`;
  } else if (act0.state === "ACTIVATED") {
    // Đã kích hoạt ở lượt trước ⇒ nút gửi lại từ chối (đúng luật) — lối của người vận hành là «Đặt lại mật khẩu cho khách».
    const r = await createAcceptanceResetLink({ orgCode: entry.code, email: entry.ownerEmail, reason: `${reason} — kích hoạt lại cho lượt chạy` }, { purpose: "RESET" });
    if ("error" in r) return fail(`đặt lại mật khẩu cho khách bị từ chối: ${r.error}`, detail);
    link = r.link;
    via = "đặt lại mật khẩu cho khách (đã kích hoạt ở lượt trước)";
  } else return fail(`không phát được liên kết: ${activationRefusal(act0.state)}`, detail);
  ctx.secrets.add(link);
  const parsed = parseResetLink(link);
  if (!parsed) return fail("liên kết kích hoạt sai dạng /reset/<mã>/<token>", detail);
  ctx.secrets.add(parsed.token);
  if (parsed.orgCode !== entry.code) return fail("liên kết kích hoạt trỏ sang workspace khác", detail);
  // Trang /reset/<mã>/<token>: mở (chỉ tra, không tiêu mã) rồi đặt mật khẩu — ĐÚNG hai hàm của trang.
  const look = await lookupResetToken(entry.code, parsed.token, { ip: `${ACCEPTANCE_IP}:${deps.runId}` });
  if (!look.ok) return fail(`trang /reset không nhận liên kết: ${look.error}`, detail);
  if (look.email !== entry.ownerEmail) return fail("liên kết thuộc một tài khoản khác tài khoản thử", detail);
  const password = deps.newPassword();
  ctx.secrets.add(password);
  // Ghi nhận TRƯỚC lời gọi: lời gọi ném giữa chừng (mật khẩu có thể đã đổi) vẫn để B2 xoay — mật khẩu của lượt chạy không ở lại.
  ctx.knownPassword = password;
  const done = await completePasswordResetCore(entry.code, parsed.token, { password, confirmPassword: password }, { ip: `${ACCEPTANCE_IP}:${deps.runId}` });
  if ("error" in done) return fail(`đặt mật khẩu qua liên kết hỏng: ${done.error}`, detail);
  ctx.lastPasswordChangeMs = Date.now();
  const reused = await completePasswordResetCore(entry.code, parsed.token, { password, confirmPassword: password }, { ip: `${ACCEPTANCE_IP}:${deps.runId}` });
  if (!("error" in reused)) return fail("liên kết dùng LẦN HAI vẫn đặt được mật khẩu — mã phải dùng một lần", detail);
  const act1 = await loadWorkspaceActivation(entry.code, deps.now());
  if (act1?.state !== "ACTIVATED") return fail(`đặt mật khẩu xong mà trạng thái là ${act1?.state ?? "—"}, không phải ACTIVATED`, detail);
  // Lõi của form /login KHÔNG có ô mã tổ chức: tổ chức ra từ chỉ mục danh tính + mật khẩu khớp — phải đúng MỘT, đúng workspace thử.
  const matched = await matchingLoginOrganizations(entry.ownerEmail, password);
  if (matched.length !== 1 || matched[0] !== entry.code) return fail(`đăng nhập email không mã tổ chức ra ${matched.length ? matched.join(", ") : "không tổ chức nào (sẽ báo «sai mật khẩu»)"} — phải đúng ${entry.code}`, detail);
  let subject: SessionSubject | null = null;
  const verdict = await verifyLogin({ email: entry.ownerEmail, password, orgCode: matched[0] }, async (s) => {
    subject = s;
  });
  const opened = subject as SessionSubject | null;
  if (!verdict.ok || !opened) return fail(`đăng nhập bị từ chối: ${verdict.ok ? "không mở phiên" : verdict.error}`, detail);
  if (opened.orgCode !== entry.code) return fail(`phiên mở ở ${opened.orgCode}, không phải ${entry.code}`, detail);
  const wrong = deps.newPassword();
  ctx.secrets.add(wrong);
  if ((await matchingLoginOrganizations(entry.ownerEmail, wrong)).length) return fail("mật khẩu SAI vẫn khớp một tổ chức", detail);
  // Lý do NỘI BỘ của lượt sai đi qua `onFailure` — ĐÚNG cách `loginAction` (lib/actions/auth.ts) lấy nó để ghi sổ lỗi đăng nhập.
  const wrongSeen: { note: LoginFailureNote | null } = { note: null };
  const wrongVerdict = await verifyLogin(
    { email: entry.ownerEmail, password: wrong, orgCode: entry.code },
    async () => {
      throw new Error("mật khẩu sai mà vẫn mở phiên");
    },
    { onFailure: (note) => (wrongSeen.note = note) },
  );
  if (!wrongVerdict.ok) detail.push(await recordWrongLoginEvidence(ctx, wrongSeen.note));
  if (wrongVerdict.ok || wrongVerdict.code !== "BAD_CREDENTIALS") return fail("mật khẩu sai không bị từ chối đúng câu «sai mật khẩu»", detail);
  const used = (await findIdentity("EMAIL", entry.ownerEmail, { usedOnly: true })).some((h) => h.orgCode === entry.code);
  if (!used) return fail("đăng nhập xong mà chỉ mục danh tính không ghi mốc dùng", detail);
  return pass(`${via} → /reset mở được + đặt mật khẩu (dùng lại liên kết bị từ chối) → ACTIVATED → /login email KHÔNG mã tổ chức vào đúng ${entry.code} · mật khẩu sai bị từ chối`, detail);
}

// ─────────────────────────── B2 · xoay mật khẩu rồi vứt ───────────────────────────

async function stepRotate(ctx: Ctx): Promise<Outcome> {
  const { entry, deps } = ctx;
  const used = ctx.knownPassword;
  if (!used) return skip("lượt này chưa đặt mật khẩu nào — không có gì để xoay");
  const r = await createAcceptanceResetLink({ orgCode: entry.code, email: entry.ownerEmail, reason: `${ACCEPTANCE_ACTOR_LABEL} ${deps.runId} — xoay mật khẩu sau lượt chạy` }, { purpose: "RESET" });
  if ("error" in r) return fail(`không phát được liên kết để xoay: ${r.error} — mật khẩu của lượt chạy CÒN HIỆU LỰC (chỉ nằm trong bộ nhớ tiến trình đã thoát)`);
  ctx.secrets.add(r.link);
  const parsed = parseResetLink(r.link);
  if (!parsed) return fail("liên kết xoay sai dạng");
  ctx.secrets.add(parsed.token);
  // Mật khẩu mới SINH RỒI VỨT: không biến nào giữ nó sau hàm này — lượt sau kích hoạt lại bằng liên kết mới.
  const fresh = deps.newPassword();
  ctx.secrets.add(fresh);
  const done = await completePasswordResetCore(entry.code, parsed.token, { password: fresh, confirmPassword: fresh }, { ip: `${ACCEPTANCE_IP}:${deps.runId}` });
  if ("error" in done) return fail(`xoay mật khẩu hỏng: ${done.error}`);
  ctx.knownPassword = null;
  ctx.lastPasswordChangeMs = Date.now();
  if ((await matchingLoginOrganizations(entry.ownerEmail, used)).length) return fail("mật khẩu đã dùng trong lượt chạy VẪN đăng nhập được sau khi xoay");
  return pass("mật khẩu của lượt chạy đã bị thay bằng một mật khẩu ngẫu nhiên không lưu ở đâu · mọi phiên của tài khoản thử bị thu hồi · mật khẩu cũ bị từ chối");
}

// ─────────────────────────── F · diễn tập tín hiệu vận hành (`--apply --drills`) ───────────────────────────

/**
 * Bước F: mỗi tín hiệu O1–O8 một dòng ĐÃ DIỄN TẬP / BỎ QUA / CHƯA ĐO ĐƯỢC / HỎNG (lib/constants/saas-acceptance.ts). Chỉ chạy sau
 * `needOwned` (A đã xác nhận `acceptanceWorkspaceOwned`) và hỏi lại sổ khai. KHÔNG gọi nhà cung cấp AI, KHÔNG gọi dịch vụ ngoài, KHÔNG
 * chèn dòng lỗi giả, KHÔNG đổi cấu hình bot / gói / công tắc: tín hiệu nào chỉ gây được bằng những cách đó là «CHƯA ĐO ĐƯỢC».
 */
async function stepDrills(ctx: Ctx): Promise<Outcome> {
  const { entry } = ctx;
  if (!ctx.owned || acceptanceWorkspaceOf(entry.code)?.code !== entry.code) return skip("workspace không phải workspace nghiệm thu của ops này — không diễn tập");
  const results: DrillResult[] = [];
  for (const key of OPS_SIGNAL_KEYS) {
    if (key === "LOGIN") {
      // O1 diễn tập ngay ở B1 (lượt mật khẩu sai qua verifyLogin + recordAuthFailure) — F chỉ đọc lại kết quả của lượt này.
      results.push(
        ctx.loginEvidence
          ? { key, status: "DRILLED", code: `LOGIN/${ctx.loginEvidence}`, why: "bước B1: lượt mật khẩu sai ghi một dòng platform_auth_failures luồng LOGIN" }
          : { key, status: "SKIPPED", code: null, why: "bước B1 của lượt này không ghi được dòng LOGIN (xem chi tiết B1)" },
      );
    } else if (key === "ORDER_VALIDATION") results.push(await drillOrderValidation(ctx));
    else results.push({ key, status: "UNMEASURABLE", code: null, why: ACCEPTANCE_UNMEASURABLE_DRILLS[key] ?? "chưa có đường diễn tập trung thực" });
  }
  ctx.drillResults = results;
  const status = drillStepStatus(results);
  const reason = drillSummaryPart(results);
  const detail = [...results.map(formatDrillLine), "dọn dẹp: không có gì để gỡ — dòng tín hiệu tự hết hạn theo cửa sổ 24 giờ / 7 ngày; không đổi cấu hình bot, gói hay công tắc nào"];
  return status === "FAIL" ? fail(reason, detail) : status === "PASS" ? pass(reason, detail) : skip(reason, detail);
}

/**
 * O6 ĐƠN KHÔNG HỢP LỆ — gọi ĐÚNG `executeTool` (bộ chạy công cụ mà engine gọi sau khi model chọn công cụ) với công cụ «Lưu khách»
 * THIẾU số điện thoại, kênh WEB, trong ngữ cảnh workspace nghiệm thu. Công cụ từ chối TRƯỚC mọi lượt ghi khách (`MISSING_CONTACT`) ⇒
 * `executeTool` ghi `order.validation_failed` vào `audit_logs` của workspace + nâng gương `platform_org_health` — đúng đường của một
 * khách thật để thiếu SĐT. Không gọi AI (bỏ qua bước model chọn công cụ — phần duy nhất tốn tiền), không tạo khách / đơn / hội thoại:
 * id tương quan mang tiền tố diễn tập. Tự hết hạn: mức của tín hiệu tính trên số đếm 24 giờ.
 */
async function drillOrderValidation(ctx: Ctx): Promise<DrillResult> {
  const key = "ORDER_VALIDATION" as const;
  const { entry, deps } = ctx;
  const drillId = `${ACCEPTANCE_DRILL_ID_PREFIX}${deps.runId}`;
  try {
    return await withOrganization(entry.code, async (): Promise<DrillResult> => {
      invalidateCapabilities(entry.code);
      if (!(await getEnabledModules(entry.code)).has("ai_sales")) return { key, status: "SKIPPED", code: null, why: "module ai_sales của workspace đang tắt — công cụ của bot không chạy" };
      const cfg = await loadSalesChatbotConfig();
      if (!cfg.allowedTools.includes("create_customer")) return { key, status: "SKIPPED", code: null, why: "bot của workspace không bật công cụ «Lưu khách» (create_customer) — bật ở AI Sales rồi chạy lại" };
      const out = await executeTool("create_customer", { name: ACCEPTANCE_ACTOR_LABEL, address: "Diễn tập nghiệm thu — cố ý thiếu số điện thoại" }, { conversationId: drillId, channel: "WEB", config: cfg, state: {}, lastUserText: "", agent: SALES_AGENT, now: deps.now() });
      if (out.orderSignal?.reason !== "MISSING_CONTACT") return { key, status: "FAILED", code: out.orderSignal?.reason ?? null, why: `công cụ «Lưu khách» thiếu SĐT không trả tín hiệu MISSING_CONTACT (${out.summary})` };
      const db = await getDb();
      const [row] = await db
        .select({ id: schema.auditLogs.id })
        .from(schema.auditLogs)
        .where(and(eq(schema.auditLogs.action, ORDER_VALIDATION_FAILED_ACTION), eq(schema.auditLogs.correlationId, drillId)))
        .limit(1);
      if (!row) return { key, status: "FAILED", code: "MISSING_CONTACT", why: "công cụ trả tín hiệu nhưng audit_logs của workspace không có dòng order.validation_failed của lượt diễn tập" };
      const mirror = await (await getPlatformDb()).query.platformOrgHealth.findFirst({ where: and(eq(schema.platformOrgHealth.orgCode, entry.code), eq(schema.platformOrgHealth.checkKey, key)) });
      const lit = mirror && (mirror.level === "WARNING" || mirror.level === "CRITICAL");
      return {
        key,
        status: "DRILLED",
        code: `MISSING_CONTACT · audit ${row.id}`,
        why: `executeTool(create_customer, thiếu SĐT, kênh WEB) ⇒ order.validation_failed · gương ${mirror ? `${mirror.level} (24h ${mirror.count24h ?? "—"})` : "chưa có dòng"}${lit ? "" : " — gương chưa sáng (trần tần suất đường nóng); job sales-health đếm lại từ audit_logs trong 5 phút"}`,
      };
    });
  } catch (error) {
    return { key, status: "FAILED", code: null, why: `diễn tập ném lỗi: ${firstLine(error)}` };
  }
}

// ─────────────────────────── C · vỏ app ───────────────────────────

export type RouteCheck = { path: string; expect: string | null };

/** Tuyến vỏ phải mở được — DẪN XUẤT từ sổ khai của vỏ (không danh sách thứ hai): mọi mục người này thấy + `/` + một tuyến ERP bị chặn. */
export function shellRoutesFor(user: ShellUser): RouteCheck[] {
  const items = salesAgentNavFor(user).map((i) => ({ path: i.href, expect: null }));
  const blocked = SALES_AGENT_DENIED_PREFIXES[0];
  return [...items, { path: "/", expect: salesAgentRedirectFor(user, "/") }, ...(blocked ? [{ path: blocked, expect: salesAgentRedirectFor(user, blocked) }] : [])];
}

/** Soi thân một trang 200 của vỏ: `null` = đạt, chuỗi = vì sao hỏng. THUẦN. */
export function shellBodyProblem(body: string): string | null {
  if (body.includes(PAGE_ERROR_MARKER)) return "trang lỗi (ranh giới lỗi của Next)";
  const digest = PAGE_ERROR_DIGEST.exec(body);
  if (digest) return `gói RSC mang lỗi máy chủ (${/(\d{3,})/.exec(digest[0])?.[1] ?? "?"})`;
  const leak = ERP_FRAME_HTML_MARKERS.find((m) => body.includes(m));
  if (leak) return `lộ khung ERP nội bộ (${leak})`;
  if (!body.includes(SALES_AGENT_SHELL_HTML_MARKER)) return "không dựng vỏ app Chốt Đơn";
  if (!body.includes(CHOTDON_ASSETS.manifest)) return "không mang thương hiệu Chốt Đơn của host";
  return null;
}

/** Mở MỘT tuyến của vỏ như trình duyệt: theo tối đa `MAX_REDIRECTS` lần chuyển hướng, phát hiện vòng lặp / bị đá về `/login`, soi thân. */
/**
 * Đích mà cổng quyền (`?forbidden=1`, #686), cổng vỏ (`?ngoai-goi=1`) và cổng module (`/module-disabled`) đưa người bị từ chối
 * tới. Trang nhà của vỏ trả 200 + đủ dấu vỏ, nên một mục menu bị đá về đó TRÔNG như đã mở được — đây là cách phân biệt. THUẦN.
 */
export function deniedLanding(path: string): string | null {
  const [p, q = ""] = path.split("?");
  const params = new URLSearchParams(q);
  if (params.get(FORBIDDEN_PARAM) === "1") return "thiếu quyền — cổng quyền đưa về trang nhà vỏ (?forbidden=1)";
  if (params.get(SHELL_BLOCKED_PARAM) === "1") return "ngoài vỏ — cổng vỏ đưa về trang nhà (?ngoai-goi=1)";
  if (p === "/module-disabled") return "module TẮT (/module-disabled)";
  return null;
}

export async function probeShellRoute(appGet: AcceptanceDeps["appGet"], route: RouteCheck, host: string, cookie: string): Promise<{ ok: boolean; text: string }> {
  const seen: string[] = [];
  let current = route.path;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (seen.includes(current)) return { ok: false, text: `${route.path}: vòng lặp chuyển hướng ${[...seen, current].join(" → ")}` };
    seen.push(current);
    const r = await appGet(current, { host, cookie, timeoutMs: PAGE_TIMEOUT_MS });
    const target = r.status >= 300 && r.status < 400 ? r.location : r.status === 200 ? metaRedirectTarget(r.body) : null;
    if (target) {
      const next = pathOf(target);
      if (next.split("?")[0] === "/login") return { ok: false, text: `${route.path}: bị đá về đăng nhập (${next.split("?")[1] ?? "không lý do"}) — phiên của tài khoản thử bị từ chối` };
      current = next;
      continue;
    }
    if (r.status !== 200) return { ok: false, text: `${route.path}: HTTP ${r.status}` };
    const problem = shellBodyProblem(r.body);
    if (problem) return { ok: false, text: `${route.path}${current !== route.path ? ` → ${current}` : ""}: ${problem}` };
    if (route.expect && current !== route.expect) return { ok: false, text: `${route.path}: về ${current}, phải về ${route.expect}` };
    const denied = route.expect ? null : deniedLanding(current);
    if (denied) return { ok: false, text: `${route.path} → ${current}: ${denied}` };
    return { ok: true, text: `${route.path}${current !== route.path ? ` → ${current}` : ""}: 200 · vỏ Chốt Đơn · ${Math.round(r.body.length / 1024)}kB` };
  }
  return { ok: false, text: `${route.path}: quá ${MAX_REDIRECTS} lần chuyển hướng (${seen.join(" → ")})` };
}

async function stepShell(ctx: Ctx): Promise<Outcome> {
  const { entry, deps } = ctx;
  const host = chotdonAppHost(deps.siteEnv);
  if (!host) return fail("nền tảng tắt tên miền Chốt Đơn (CHOTDON_DOMAIN=off) — vỏ không có host để mở");
  const userId = (await findIdentity("EMAIL", entry.ownerEmail)).find((h) => h.orgCode === entry.code)?.userId ?? null;
  if (!userId) return fail("không có chỉ mục danh tính của tài khoản thử — không biết ký phiên cho ai (chạy --apply)");
  invalidateOrganizations();
  invalidateCapabilities(entry.code);
  const org = await findOrganization(entry.code);
  const modules = [...(await getEnabledModules(entry.code))];
  const user: ShellUser = { role: "ADMIN", permissions: [], organization: { isHome: false, brand: org?.brand ?? null }, modules };
  if (!isSalesAgentUser(user)) return fail(`workspace KHÔNG mang vỏ Chốt Đơn (thương hiệu ${org?.brand ?? "NULL"} · module ${modules.join(",")}) — khách sẽ thấy menu ERP nội bộ`);
  const routes = shellRoutesFor(user);
  // Phiên ký như lượt đăng nhập ký (cùng `signSession`) — SAU mốc thu hồi của lượt đổi mật khẩu gần nhất (làm tròn LÊN giây).
  const wait = ctx.lastPasswordChangeMs ? revokeMarkFrom(ctx.lastPasswordChangeMs) + 50 - Date.now() : 0;
  if (wait > 0) await deps.sleep(wait);
  // Hạn NGẮN (ACCEPTANCE_SESSION_TTL_SEC), không phải 7 ngày của phiên người: phiên này chỉ sống trong bộ nhớ đúng một lượt C.
  const token = await signSession({ id: userId, email: entry.ownerEmail, name: entry.ownerName, role: "ADMIN", orgCode: entry.code }, { ttlSec: ACCEPTANCE_SESSION_TTL_SEC });
  ctx.secrets.add(token);
  const cookie = `${SESSION_COOKIE}=${token}`;
  const lines: { ok: boolean; text: string }[] = [];
  for (const route of routes) {
    try {
      lines.push(await probeShellRoute(deps.appGet, route, host, cookie));
    } catch (error) {
      lines.push({ ok: false, text: `${route.path}: ${firstLine(error)}` });
    }
  }
  const detail = lines.map((l) => `${l.ok ? "✓" : "✗"} ${l.text}`);
  const bad = lines.filter((l) => !l.ok);
  if (bad.length) return fail(`${bad.length}/${routes.length} tuyến hỏng: ${bad.map((l) => l.text).join(" · ").slice(0, 400)}`, detail);
  return pass(`${routes.length}/${routes.length} tuyến của vỏ mở được qua host ${host} (${routes.length - 2} mục + \`/\` + tuyến ERP bị chặn về nhà) · không lộ khung ERP`, detail);
}

// ─────────────────────────── D · chat web → AI → đơn ───────────────────────────

type Prep = { ok: true; variantId: string; autoConfirm: boolean; botName: string } | { ok: false; missing: string[] };

/** CHỈ ĐỌC phần chuẩn bị (người làm một lần trên UI). Thiếu gì nói đúng chỗ đó — không tự ghi. */
async function readE2ePrep(orgCode: string, now: Date): Promise<Prep> {
  const missing: string[] = [];
  invalidateCapabilities(orgCode);
  const modules = await getEnabledModules(orgCode);
  if (!modules.has("ai_sales")) missing.push("module AI bán hàng chưa bật");
  const cfg = await loadSalesChatbotConfig();
  if (!cfg.enabled) missing.push("bot bán hàng chưa BẬT (AI Sales → bật bot)");
  for (const t of ["search_products", "create_draft_order", "confirm_order"] as const) if (!cfg.allowedTools.includes(t)) missing.push(`bot tắt công cụ ${t}`);
  if (!withinBusinessHours(cfg.businessHours, now)) missing.push("đang ngoài giờ làm việc của bot");
  const ai = await salesChatProvider({ feature: "sales_chatbot", actorId: null, ref: null });
  if (!ai.ok) missing.push(`AI của bot chưa dùng được: ${ai.error}`);
  const sample = ACCEPTANCE_SAMPLE_PRODUCTS[0];
  const db = await getDb();
  const pv = schema.productVariants;
  const rows = await db.select({ id: pv.id, price: pv.retailPrice, removed: pv.isRemoved, hidden: pv.isHidden }).from(pv).where(eq(pv.sku, sample.sku)).limit(3);
  const live = rows.filter((r) => !r.removed && !r.hidden);
  if (live.length !== 1) missing.push(live.length ? `có ${live.length} mẫu mã cùng SKU ${sample.sku}` : `chưa có sản phẩm mẫu «${sample.name}» SKU ${sample.sku}`);
  else if (live[0].price !== sample.priceVnd) missing.push(`giá mẫu ${sample.sku} là ${live[0].price.toLocaleString("vi-VN")} ₫, sổ khai ${sample.priceVnd.toLocaleString("vi-VN")} ₫`);
  else if (!cfg.sellWithoutStockCheck) {
    const short = await shortfalls(db, new Map([[live[0].id, ACCEPTANCE_ORDER.quantity]]));
    if (short.length) missing.push(`tồn khả dụng ${sample.sku} còn ${Math.max(0, short[0].available)} (cần ${ACCEPTANCE_ORDER.quantity}) — nhập hàng mẫu ≥ ${sample.minStock}`);
  }
  if (missing.length) return { ok: false, missing };
  return { ok: true, variantId: live[0].id, autoConfirm: await loadAutoConfirmComplete(), botName: cfg.botName };
}

async function aiCostOf(orgCode: string, conversationId: string): Promise<{ calls: number; usd: number | null; unpriced: number }> {
  const pdb = await getPlatformDb();
  const u = schema.platformAiUsage;
  const rows = await pdb.select({ requests: u.requests, cost: u.costUsd }).from(u).where(and(eq(u.orgCode, orgCode), eq(u.conversationId, conversationId)));
  const calls = rows.reduce((s, r) => s + r.requests, 0);
  const priced = rows.filter((r) => r.cost !== null);
  const unpriced = rows.filter((r) => r.cost === null && r.requests > 0).length;
  // Chưa định giá KHÔNG phải 0 (AGENTS 42): không lượt nào có giá ⇒ `null`.
  return { calls, usd: priced.length ? priced.reduce((s, r) => s + (r.cost ?? 0), 0) : null, unpriced };
}

async function stepE2e(ctx: Ctx): Promise<Outcome> {
  const { entry, deps } = ctx;
  return withOrganization(entry.code, async () => {
    const now = deps.now();
    const prep = await readE2ePrep(entry.code, now);
    if (!prep.ok) return skip(`chuẩn bị E2E chưa đủ — người làm MỘT lần trên UI (docs/saas/ACCEPTANCE.md §3), ops không ghi hộ: ${prep.missing.join(" · ")}`.slice(0, 600));
    const detail: string[] = [`chuẩn bị: sản phẩm mẫu ${ACCEPTANCE_SAMPLE_PRODUCTS[0].sku} · bot «${prep.botName}» bật · AI sẵn sàng · công tắc «đơn đủ thông tin = đã xác nhận» ${prep.autoConfirm ? "BẬT" : "tắt"}`];
    // ĐÚNG lõi chat công khai gọi sau bước định tuyến: hội thoại WEB của một khách truy cập (khoá theo mã lượt chạy).
    const visitorKey = visitorKeyOf(`saas-acceptance:${deps.runId}`);
    const conv = await openConversation("WEB", { visitorKey });
    const turns = [...acceptanceChatTurns(deps.runId)];
    let aiTurns = 0;
    let nudged = false;
    for (let i = 0; i < turns.length; i++) {
      const before = (await conversationView(conv.id))?.messages.length ?? 0;
      const r = await chatTurn(conv.id, turns[i], { channel: "WEB", visitorKey });
      if (!r.ok) return fail(`lượt khách ${i + 1}: ${r.error}`, detail);
      const replies = r.view.messages.slice(before).filter((m) => m.role === "assistant" && m.text.trim() && m.text.trim() !== EMPTY_REPLY_TEXT);
      const byAi = (r.aiTexts?.length ?? 0) > 0;
      if (byAi) aiTurns += 1;
      detail.push(`lượt ${i + 1}: ${replies.length ? `bot trả lời (${byAi ? "AI" : "câu mẫu / câu hệ thống"})` : "bot IM"}${r.view.order ? ` · đơn ${r.view.order.id ?? "?"} ${r.view.order.stage}` : ""}`);
      if (!replies.length) {
        const [row] = await (await getDb()).select({ status: schema.salesChatConversations.status, reason: schema.salesChatConversations.handoffReason }).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, conv.id)).limit(1);
        return fail(`lượt khách ${i + 1}: bot không trả lời${row?.status === "HANDOFF" ? ` — chuyển người: ${row.reason ?? "không rõ"}` : ""}`, detail);
      }
      if (r.view.order?.stage === "CONFIRMED") break;
      // Hết kịch bản mà bot vẫn chưa chốt ⇒ nhắn thêm MỘT câu khách thật hay nhắn, rồi kết luận.
      if (i === turns.length - 1 && !nudged) {
        nudged = true;
        turns.push(ACCEPTANCE_NUDGE_TURN);
      }
    }
    const cost = await aiCostOf(entry.code, conv.id);
    ctx.aiCostUsd = cost.usd;
    detail.push(`chi phí AI lượt này: ${cost.usd === null ? "CHƯA ĐỊNH GIÁ" : `${formatAcceptanceUsd(cost.usd)} USD ≈ ${Math.round(cost.usd * env.facebook.usdToVnd).toLocaleString("vi-VN")} ₫`} · ${cost.calls} lượt gọi${cost.unpriced ? ` · ${cost.unpriced} dòng chưa định giá` : ""}`);
    if (aiTurns === 0) return fail("không lượt nào do AI sinh câu trả lời", detail);
    const db = await getDb();
    const c = schema.salesChatConversations;
    const [row] = await db.select({ orderId: c.orderId, draftOrderId: c.draftOrderId }).from(c).where(eq(c.id, conv.id)).limit(1);
    const orderId = row?.orderId ?? row?.draftOrderId ?? null;
    if (!orderId) return fail("hết kịch bản mà bot KHÔNG lên đơn nào (không có đơn nháp lẫn đơn chốt)", detail);
    const o = schema.orders;
    const [order] = await db.select({ id: o.id, stage: o.stage, phone: o.shipPhone, address: o.shipAddress, province: o.shipProvince, ward: o.shipCommune, note: o.note }).from(o).where(eq(o.id, orderId)).limit(1);
    if (!order) return fail("hội thoại trỏ tới một đơn không có trong OMS", detail);
    const items = await db.select({ sku: schema.productVariants.sku, quantity: schema.orderItems.quantity }).from(schema.orderItems).leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.orderItems.variantId)).where(eq(schema.orderItems.orderId, order.id));
    const code = (await conversationView(conv.id))?.order?.id ?? order.id;
    const want = resolveRecipientPlace({ address: ACCEPTANCE_ORDER.address, province: "" });
    const problems: string[] = [];
    if (items.length !== 1 || items[0].sku !== ACCEPTANCE_ORDER.sku || items[0].quantity !== ACCEPTANCE_ORDER.quantity) problems.push(`dòng hàng ${items.map((x) => `${x.quantity} × ${x.sku ?? "?"}`).join(", ") || "rỗng"} — phải ${ACCEPTANCE_ORDER.quantity} × ${ACCEPTANCE_ORDER.sku}`);
    if (normalizeCustomerPhone(order.phone ?? "") !== normalizeCustomerPhone(ACCEPTANCE_ORDER.phone)) problems.push("SĐT trên đơn khác SĐT khách gửi");
    if (!order.ward || order.ward !== want.ward || order.province !== want.province) problems.push(`địa chỉ ${order.ward || "chưa ghép xã"} / ${order.province || "—"} — phải ${want.ward} / ${want.province}`);
    if (!foldVnText(order.address ?? "").includes(foldVnText("Lê Lợi"))) detail.push("lưu ý: số nhà / đường trên đơn khác chữ khách gửi");
    detail.push(`đơn ${code} trong OMS: ${order.stage} · ${items.map((x) => `${x.quantity} × ${x.sku ?? "?"}`).join(", ")} · ghi chú ${order.note?.includes(deps.runId) ? "mang mã lượt chạy" : "KHÔNG mang mã lượt chạy (AI không chép ghi chú)"}`);
    if (problems.length) return fail(`đơn ${code} sai: ${problems.join(" · ")}`, detail);
    if (order.stage !== "CONFIRMED") return fail(`đơn ${code} vẫn ${order.stage} sau lời đồng ý của khách — AI chưa chốt${prep.autoConfirm ? "" : " (công tắc «đơn đủ thông tin = đã xác nhận» tắt; xác nhận bằng nút nhanh là thao tác NGƯỜI ở hộp thư — ops không bấm hộ)"}`, detail);
    return pass(`AI trả lời ${aiTurns} lượt · đơn ${code} CONFIRMED trong OMS · ${ACCEPTANCE_ORDER.quantity} × ${ACCEPTANCE_ORDER.sku} · SĐT + xã khớp · AI ${cost.usd === null ? "chưa định giá" : `${formatAcceptanceUsd(cost.usd)} USD`}`, detail);
  });
}

// ─────────────────────────── E · chat công khai theo tên miền con ───────────────────────────

/** Soi trang `/chat` công khai: `null` = mở đúng shop có bot, chuỗi = vì sao không. THUẦN. */
export function publicChatProblem(r: HttpReply, shopName: string): string | null {
  if (r.status !== 200) return `HTTP ${r.status}${r.location ? ` → ${r.location}` : ""}`;
  if (r.body.includes(HOST_NOT_FOUND_MESSAGE)) return "tên miền con không trỏ tới shop nào (chưa xuất bản / sai tên miền)";
  if (r.body.includes("Shop chưa bật chatbot bán hàng.")) return "đúng shop nhưng bot TẮT — khách thấy «Chưa mở chat»";
  if (!r.body.includes(shopName)) return "trang không mang tên shop";
  return null;
}

async function stepPublicChat(ctx: Ctx): Promise<Outcome> {
  const { entry, deps } = ctx;
  const base = ctx.baseDomain;
  if (!base) return fail("PLATFORM_BASE_DOMAIN chưa khai — không có địa chỉ chat công khai nào cho khách");
  const pub = await publicationOf(entry.code);
  const org = await findOrganization(entry.code);
  if (pub.state !== "PUBLISHED" || !pub.slug) return skip(`chưa xuất bản (${pub.state}${pub.slug ? `, tên miền giữ chỗ ${pub.slug}` : ""}) — người làm MỘT lần: đăng nhập tài khoản thử → /setup → tên miền «${entry.domainSlug}» → Xuất bản (ops không xuất bản hộ) · miền gốc đang dùng ${base}`);
  if (pub.slug !== entry.domainSlug) return fail(`tên miền con đang là ${pub.slug}, sổ khai là ${entry.domainSlug}`);
  const host = `${pub.slug}.${base}`;
  const detail: string[] = [`miền gốc đang dùng: ${base} — khách Chốt Đơn nhận địa chỉ chat dạng https://<tên>.${base}/chat`];
  const shop = org?.name ?? entry.name;
  const inside = await deps.appGet("/chat", { host, timeoutMs: PAGE_TIMEOUT_MS }).then(
    (r) => publicChatProblem(r, shop),
    (e: unknown) => `không gọi được ứng dụng: ${firstLine(e)}`,
  );
  detail.push(`${inside ? "✗" : "✓"} qua ứng dụng (Host ${host}): ${inside ?? "200 + tên shop"}`);
  const url = `https://${host}/chat`;
  const outside = await deps.publicGet(url, { timeoutMs: 30_000 }).then(
    (r) => publicChatProblem(r, shop),
    (e: unknown) => `không với tới qua mạng ngoài: ${firstLine(e)}`,
  );
  detail.push(`${outside ? "✗" : "✓"} qua mạng ngoài (${url}): ${outside ?? "200 + tên shop"}`);
  if (inside || outside) return fail(`${url}: ${[inside, outside].filter(Boolean).join(" · ")}`, detail);
  return pass(`${url} ⇒ 200 + tên shop (qua ứng dụng và qua mạng ngoài) · miền gốc ${base}`, detail);
}

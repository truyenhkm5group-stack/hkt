/**
 * ═══════════ PHASE 11 · H1 — TẤN CÔNG CÔ LẬP TỔ CHỨC (docs/platform/phase-11-12-plan.md §H1) ═══════════
 *
 * Hai tổ chức THẬT (`ta-a`, `ta-b` — hai CSDL PGlite riêng, tự cấp, tự dọn). B có ĐỦ mọi loại dữ liệu của Phase 2–10:
 * field tuỳ biến + tệp, đối tượng tuỳ biến + bản ghi + quan hệ, form, trang đã xuất bản, luật + lượt chạy + lời duyệt
 * đang chờ, blueprint đã cài (B dựng qua /start bằng mã mời), bản nháp AI, kết nối có bí mật, thương hiệu + logo.
 *
 * Người quản trị của A — PHIÊN THẬT của A (JWT ký bằng bí mật của ứng dụng, claim `org = ta-a`) — gọi THẲNG server
 * action / route handler / page component / dịch vụ bằng id, khoá, slug, tên tệp, mã mời của B. Lượt gọi chạy trong
 * một phạm vi request dựng tay (work store + request store của Next) để `headers()` / `cookies()` / `revalidatePath`
 * chạy thật: một lượt THÀNH CÔNG không bao giờ bị che bởi lỗi "thiếu store" của môi trường kiểm thử.
 *
 * Mọi lượt phải bị từ chối (lỗi / 401 / 403 / 404 / chuyển hướng / rỗng) — hoặc, với vài cửa không nhận đích (chạy
 * luật, xem trước mẫu), chỉ chạm CHÍNH A — và:
 *  · không kết quả nào mang dấu `MARK` (mọi chữ của B đều có nó) hay bí mật của B;
 *  · ẢNH CHỤP CSDL của B (số dòng + băm nội dung của MỌI bảng) và các dòng mặt phẳng điều khiển của B (dòng tổ chức,
 *    module, mã mời, nhật ký nền tảng) TRƯỚC = SAU;
 *  · không một request mạng nào rời máy (fetch bị thay bằng bản ghi lượt gọi).
 *
 * Thêm bốn đòn không đi qua id: ĐỆM (B vừa dựng trang `chung` ⇒ A dựng `chung` cùng cấu hình phải ra số của A),
 * ĐỆM NĂNG LỰC (module của B vừa được đọc ⇒ phiên A vẫn chỉ có module của A), BẢN MÃ BỊ ĐÁNH CẮP (khoá AI đang bật
 * của B chép sang A, sửa mã tổ chức ⇒ AAD chặn, không gửi gì), PHIÊN GIẢ (claim `org = ta-b` + id quản trị B, ký bằng
 * khoá sai ⇒ về /login / 401).
 *
 * Kiểm đột biến đã chạy (28/09/2026), mỗi cái làm bài này ĐỎ: bỏ tiền tố tổ chức của khoá memo · bỏ mã tổ chức khỏi
 * AAD của bí mật kết nối · bỏ hai chốt "chỉ tổ chức nhà vận hành nền tảng" · đăng nhập tra tài khoản ngoài tổ chức
 * được chọn · bỏ kiểm chữ ký JWT phiên · khoá đệm năng lực không theo tổ chức.
 *
 * Chạy qua `npm test` (cần `./setup-env` + `ensureMigrated()` của bộ chạy chung).
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { rmSync } from "node:fs";
import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import * as ReactNs from "react";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { RequestCookies, ResponseCookies } from "next/dist/server/web/spec-extension/cookies";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import ObjectRecordsPage from "@/app/(dashboard)/o/[object]/page";
import ObjectRecordPage from "@/app/(dashboard)/o/[object]/[id]/page";
import DynamicPage from "@/app/(dashboard)/p/[slug]/page";
import { GET as logoGET } from "@/app/api/branding/logo/route";
import { GET as metadataFileGET } from "@/app/api/metadata/files/[id]/route";
import { POST as syncPOST } from "@/app/api/sync/[job]/route";
import { applyAiDraftAction, createAiDraftAction, discardAiDraftAction, previewAiDraftAction } from "@/lib/actions/ai-builder";
import { decideApproval, listPendingApprovals } from "@/lib/actions/approvals";
import { loginAction } from "@/lib/actions/auth";
import { installTemplateAction, previewTemplateAction } from "@/lib/actions/blueprints";
import { removeLogoAction } from "@/lib/actions/branding";
import { saveConnectionAction, setConnectionStatusAction, testConnectionAction } from "@/lib/actions/connections";
import { saveCustomValuesAction } from "@/lib/actions/metadata";
import {
  archiveFieldAction,
  createFieldAction,
  moveFieldAction,
  publishFormAdminAction,
  publishListAdminAction,
  saveFormDraftAdminAction,
  saveListDraftAdminAction,
  saveStatusOverridesAdminAction,
  updateFieldAction,
} from "@/lib/actions/metadata-admin";
import { uploadCustomerFileAction } from "@/lib/actions/metadata-records";
import { createRecordAction, deleteRecordAction, setObjectArchivedAction, updateObjectAction, updateRecordAction, uploadRecordFileAction } from "@/lib/actions/objects";
import { checkOrgAction, createInviteAction, createOrganizationAction, previewSignupAction, retrySetupAction, revokeInviteAction } from "@/lib/actions/onboarding";
import { runPageAction } from "@/lib/actions/page-actions";
import { addPageToMenuAction, archivePageAction, loadBuilderDraftAction, publishBuilderPageAction, publishPageAction, savePageDraftAction, saveBuilderDraftAction, updatePageMetaAction } from "@/lib/actions/page-admin";
import { previewPageBlock } from "@/lib/actions/page-preview";
import { toggleModuleForOrgAction } from "@/lib/actions/platform-modules";
import { previewWorkflowRuleAction, runWorkflowsNowAction, saveWorkflowRuleAction, setWorkflowRuleModeAction, setWorkflowRuleStatusAction } from "@/lib/actions/workflow-admin";
import { readOrgBuilderState } from "@/lib/ai-builder/metadata";
import { BLUEPRINT_TOOL_NAME } from "@/lib/ai-builder/prompt";
import { getBuilderAi, setBuilderAiForTests } from "@/lib/ai-builder/provider";
import { createDraft, loadDraft, previewDraft } from "@/lib/ai-builder/service";
import { FakeProvider, type AiRequest, type AiResponse } from "@/lib/ai/provider";
import { verifyLogin } from "@/lib/auth/login";
import { requireUser, setRequestPathSourceForTests, signSession, type SessionUser } from "@/lib/auth/session";
import { loadTemplateCatalog, previewTemplate } from "@/lib/blueprints/admin";
import { WHOLESALE_BLUEPRINT } from "@/lib/blueprints/templates/wholesale";
import { getBranding, readLogo, saveBrandingCore, uploadLogoCore } from "@/lib/branding/service";
import { clearMemo } from "@/lib/cache";
import { loadConnectionsView, openActiveConnection, saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { env } from "@/lib/env";
import { createCustomField } from "@/lib/metadata/fields";
import type { MetadataActor } from "@/lib/metadata/types";
import { openCustomFile, saveCustomFile, saveCustomValues } from "@/lib/metadata/values";
import { createObject } from "@/lib/objects/objects";
import { createRecord, getRecord, listRecords, reverseRelations } from "@/lib/objects/records";
import { claimInvite, createInvite } from "@/lib/onboarding/invites";
import { hashIp } from "@/lib/onboarding/rate";
import { createOrganizationFromSignup } from "@/lib/onboarding/service";
import { CORE_MODULES, type SignupDraft } from "@/lib/onboarding/shared";
import { resolveBlock, resolvePage } from "@/lib/pages/data-sources";
import { createPage, getPageBySlug, publishPage, savePageDraft } from "@/lib/pages/registry";
import type { BlockType, KpiData, PageBlock, PageRenderContext, PageSchema, ResolvedBlock } from "@/lib/pages/types";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { setSessionTokenSourceForTests, withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { loadPageBuilder, adminLoadBuilderDraft } from "@/lib/platform-ui/page-builder";
import { loadPageEditor } from "@/lib/platform-ui/page-admin";
import { loadWorkflowEditor } from "@/lib/platform-ui/workflow-admin";
import { parseListParams } from "@/lib/search-params";
import { runWorkflows } from "@/lib/workflow/engine";
import { saveRule, setRuleMode, setRuleStatus } from "@/lib/workflow/rules";

const A = "ta-a";
const B = "ta-b";
/** Mọi chữ của B mang dấu này — thấy nó ở bất kỳ kết quả nào A nhận được là rò. */
const MARK = "TABIMAT7Q";
const NOTE = "ta-h1";
const IP_B = "10.91.0.2";
const IP_A = "10.91.0.1";
const A_EMAIL = "admin@ta-a.local";
const A_PW = "TanCong@A2026";
const B_EMAIL = "admin@ta-b.local";
const B_PW = "TanCong@B2026";
const MASTER = "khoa-thu-nghiem-tan-cong-co-lap-0123456789abcdef";
const LARK_B = "https://open.larksuite.com/open-apis/bot/v2/hook/bbbb2222-cccc-3333-dddd-4444eeee5555";
const SIGN_B = `ky-lark-${MARK}-7c6b`;
const AI_KEY_B = `sk-ant-api03-khoa-bia-${MARK}-0123456789abcdef`;
const SECRETS_B = [LARK_B, SIGN_B, "bbbb2222-cccc-3333", AI_KEY_B];
const PNG_B = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`logo-${MARK}`), Buffer.alloc(64, 7)]);
const PDF_B = Buffer.from(`%PDF-1.4 hop dong ${MARK}`);

// ─────────────────────────── dựng / dọn ───────────────────────────

async function cleanup() {
  const pdb = await getPlatformDb();
  for (const code of [A, B]) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
  }
  await pdb.delete(schema.platformSignupInvites).where(or(like(schema.platformSignupInvites.note, `${NOTE}%`), inArray(schema.platformSignupInvites.organizationCode, [A, B])));
  await pdb.delete(schema.platformSignupAttempts).where(or(inArray(schema.platformSignupAttempts.organizationCode, [A, B]), inArray(schema.platformSignupAttempts.ipHash, [hashIp(IP_A), hashIp(IP_B)])));
  invalidateOrganizations();
  invalidateCapabilities();
}

async function withEnv<T>(key: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
}

async function adminOf(org: string, email: string): Promise<SessionUser> {
  const modules = [...(await getEnabledModules(org))];
  return withOrganization(org, async () => {
    const u = await (await getDb()).query.users.findFirst({ where: eq(schema.users.email, email) });
    assert.ok(u, `quản trị của ${org}`);
    return { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: org, name: org, isHome: false }, modules };
  });
}

function block<T extends BlockType>(id: string, type: T, config: PageBlock<T>["config"], span: PageBlock["span"] = 12): PageBlock<T> {
  return { id, type, span, config };
}

const ctxOf = (searchParams: Record<string, string | undefined> = {}): PageRenderContext => ({ searchParams, period: "30d" });

/** Trang `chung` — CÙNG cấu hình ở cả hai tổ chức: KPI đếm là đầu dò của đệm. */
const CHUNG: PageSchema = {
  version: 1,
  sections: [
    {
      key: "so",
      blocks: [
        block("c_dem", "kpi", { aggregate: { objectKey: "x_chung", fn: "count" } }, 4),
        block("c_bang", "table", { source: "x_chung", columns: ["system:title", "custom:trang_thai"], rowLink: true, pageSize: 20, rowActions: [{ action: "open_record", label: "Mở" }] }),
        block("c_kanban", "kanban", { objectKey: "x_chung", statusField: "custom:trang_thai", cardFields: [], allowMove: true }),
      ],
    },
  ],
};

const TRANG_B: PageSchema = {
  version: 1,
  sections: [
    {
      key: "b",
      title: `Trang ${MARK}`,
      blocks: [
        block("b_dem", "kpi", { aggregate: { objectKey: "x_b_hd", fn: "sum", field: "custom:gia_tri" }, label: `Tổng ${MARK}` }, 4),
        block("b_bang", "table", { source: "x_b_hd", columns: ["system:title", "custom:gia_tri", "custom:khach"], rowLink: true, pageSize: 20, rowActions: [{ action: "open_record", label: "Mở" }] }),
        block("b_nut", "button", { action: "open_page", label: `Sang ${MARK}`, input: { slug: "chung" } }, 3),
      ],
    },
  ],
};

function flat(resolved: Awaited<ReturnType<typeof resolvePage>>): Map<string, ResolvedBlock> {
  const out = new Map<string, ResolvedBlock>();
  for (const s of resolved.sections) for (const b of s.blocks) out.set(b.block.id, b);
  return out;
}

function kpiOf(m: Map<string, ResolvedBlock>, id: string): number | null {
  const b = m.get(id);
  assert.ok(b && b.ok, `khối ${id}: ${JSON.stringify(b && !b.ok ? b.issue : null)}`);
  return (b.data as KpiData).value;
}

type Step = (req: AiRequest, round: number) => Omit<AiResponse, "usage" | "model" | "latencyMs">;
function toolCall(input: unknown): Step {
  return () => ({ content: [{ type: "tool_use", id: `call-${Math.random().toString(36).slice(2, 8)}`, name: BLUEPRINT_TOOL_NAME, input: JSON.parse(JSON.stringify(input)) }], stopReason: "tool_use" });
}

/** Gói AI của B: mẫu bán sỉ đổi tên / khoá, mang dấu MARK. */
function aiBodyB(): Record<string, unknown> {
  const bp = JSON.parse(JSON.stringify(WHOLESALE_BLUEPRINT)) as Record<string, unknown>;
  bp.name = `Gói AI ${MARK}`;
  (bp.pages as { slug: string; name: string }[])[0].slug = "cong-no-ai-b";
  (bp.pages as { slug: string; name: string }[])[0].name = `Công nợ ${MARK}`;
  (bp.workflows as { key: string }[])[0].key = "nhac_no_ai_b";
  return bp;
}

// ─────────────────────────── ảnh chụp CSDL của B ───────────────────────────

type Snapshot = Map<string, string>;

function rowsOf<T>(r: unknown): T[] {
  return ((r as { rows?: T[] }).rows ?? (r as T[])) as T[];
}

/** Số dòng + băm nội dung của MỌI bảng trong CSDL của tổ chức ngữ cảnh. */
async function snapshotOrgDb(): Promise<Snapshot> {
  const db = await getDb();
  const tables = rowsOf<{ s: string; t: string }>(
    await db.execute(sql`select table_schema as s, table_name as t from information_schema.tables where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema') order by 1, 2`),
  );
  assert.ok(tables.length > 100, `phải thấy toàn bộ bảng của CSDL tổ chức — mới thấy ${tables.length}`);
  const out: Snapshot = new Map();
  for (const { s, t } of tables) {
    const q = `select count(*)::int as n, coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), '') as h from "${s}"."${t}" x`;
    const [r] = rowsOf<{ n: number; h: string }>(await db.execute(sql.raw(q)));
    out.set(`${s}.${t}`, `${r.n}:${r.h}`);
  }
  return out;
}

/** Các dòng mặt phẳng điều khiển (CSDL nhà) thuộc về B. */
async function snapshotControlPlane(inviteIds: string[]): Promise<Snapshot> {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, B) });
  assert.ok(org);
  const one = async (label: string, q: ReturnType<typeof sql>) => {
    const [r] = rowsOf<{ n: number; h: string }>(await pdb.execute(q));
    return [label, `${r.n}:${r.h}`] as const;
  };
  const ids = sql.join(inviteIds.map((i) => sql`${i}`), sql`, `);
  return new Map([
    await one("platform_organizations", sql`select count(*)::int as n, coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), '') as h from platform_organizations x where code = ${B}`),
    await one("platform_organization_modules", sql`select count(*)::int as n, coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), '') as h from platform_organization_modules x where organization_id = ${org.id}`),
    await one("platform_flag_overrides", sql`select count(*)::int as n, coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), '') as h from platform_flag_overrides x where organization_id = ${org.id}`),
    await one("platform_signup_invites", sql`select count(*)::int as n, coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), '') as h from platform_signup_invites x where organization_code = ${B} or id in (${ids})`),
    await one("platform_audit_log", sql`select count(*)::int as n, coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), '') as h from platform_audit_log x where target_org_code = ${B}`),
  ]);
}

function diff(before: Snapshot, after: Snapshot): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((k) => before.get(k) !== after.get(k)).map((k) => `${k}: ${before.get(k) ?? "(không có)"} → ${after.get(k) ?? "(không có)"}`);
}

// ─────────────────────────── một lượt gọi "như request thật" ───────────────────────────

type Settled = { ok: true; value: unknown } | { ok: false; error: unknown };

/**
 * Ngoài máy chủ Next, `globalThis.AsyncLocalStorage` không được dựng nên hai kho ngữ cảnh request của Next là bản GIẢ
 * (`getStore()` luôn rỗng, `run()` ném). Gắn tạm một AsyncLocalStorage THẬT của Node vào đúng hai đối tượng ấy (thuộc
 * tính riêng che phương thức của bản giả) để `headers()` / `cookies()` / `revalidatePath()` chạy như trong request;
 * gỡ ra khi xong — ngoài `asRequest`, `getStore()` vẫn rỗng y như trước.
 */
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

/**
 * Chạy `fn` như MỘT request của trình duyệt: token phiên + đường dẫn (cổng module) + work store / request store của
 * Next, để `headers()` / `cookies()` / `revalidatePath()` / `redirect()` / `notFound()` chạy đúng như trong ứng dụng.
 */
async function asRequest(token: string | null, reqPath: string, fn: () => Promise<unknown>): Promise<Settled> {
  installRealStores();
  setSessionTokenSourceForTests(async () => token ?? undefined);
  setRequestPathSourceForTests(() => reqPath);
  const workStore = { route: reqPath, page: reqPath, incrementalCache: {}, isStaticGeneration: false, forceStatic: false, dynamicShouldError: false, pendingRevalidatedTags: [] as string[] };
  const requestStore = {
    type: "request",
    phase: "action",
    implicitTags: { tags: [], expirationsByCacheKind: new Map() },
    url: { pathname: reqPath, search: "" },
    headers: new Headers({ "x-forwarded-for": IP_A, "x-erp-path": reqPath }),
    cookies: new RequestCookies(new Headers()),
    mutableCookies: new ResponseCookies(new Headers()),
    userspaceMutableCookies: new ResponseCookies(new Headers()),
    draftMode: { isEnabled: false },
  };
  try {
    const value = await workAsyncStorage.run(workStore as unknown as Parameters<typeof workAsyncStorage.run>[0], () =>
      workUnitAsyncStorage.run(requestStore as unknown as Parameters<typeof workUnitAsyncStorage.run>[0], fn),
    );
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  } finally {
    setSessionTokenSourceForTests(null);
    setRequestPathSourceForTests(null);
  }
}

function digestOf(e: unknown): string {
  return e && typeof e === "object" && "digest" in e ? String((e as { digest: unknown }).digest) : "";
}

/** Lý do lượt gọi bị từ chối, hoặc `null` nếu nó THÀNH CÔNG. */
function refusal(s: Settled): string | null {
  if (!s.ok) {
    const d = digestOf(s.error);
    if (d.startsWith("NEXT_REDIRECT")) return `chuyển hướng ${d.split(";")[2]}`;
    if (d.startsWith("NEXT_HTTP_ERROR_FALLBACK;404")) return "404";
    const msg = s.error instanceof Error ? s.error.message : String(s.error);
    // Lỗi của CHÍNH hạ tầng kiểm thử không được tính là "bị chặn" — nó che một lượt có thể đã thành công.
    assert.ok(!/Invariant|outside a request scope|static generation store/i.test(msg), `hạ tầng kiểm thử hỏng: ${msg}`);
    // Lỗi LẬP TRÌNH (ReferenceError, TypeError…) không phải một lời từ chối — nó làm lượt gọi chết trước khi tới cổng.
    assert.ok(!(s.error instanceof ReferenceError || s.error instanceof TypeError || s.error instanceof SyntaxError || s.error instanceof RangeError), `lượt gọi chết vì lỗi lập trình, không phải vì bị chặn: ${msg}`);
    return `ném ${(s.error as Error)?.name ?? "lỗi"}: ${msg.slice(0, 80)}`;
  }
  const v = s.value;
  if (v instanceof Response) return v.status >= 400 ? `HTTP ${v.status}` : null;
  if (v === null || v === undefined) return "rỗng";
  if (Array.isArray(v)) return v.length === 0 ? "rỗng" : null;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.error === "string" && o.error) return `lỗi: ${o.error.slice(0, 80)}`;
    // Chạy thử luật: "không khớp" kèm lý do là câu trả lời RỖNG, không phải một lượt chạy.
    if (o.matched === false && Array.isArray(o.wouldDo) && o.wouldDo.length === 0) return `không khớp: ${String(o.reason ?? "").slice(0, 80)}`;
    if (o.ok === false) {
      const why = o.error ?? o.code ?? o.reason ?? (Array.isArray(o.errors) ? (o.errors as { message?: string }[])[0]?.message : undefined) ?? (o.issue as { code?: string } | undefined)?.code;
      return `từ chối: ${String(why ?? "").slice(0, 80)}`;
    }
  }
  return null;
}

/** JSON an toàn cho mọi thứ (bigint, Buffer, vòng tham chiếu, hàm, JSX) — để dò rò. */
function serialize(v: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(v, (_k, x: unknown) => {
        if (typeof x === "bigint") return x.toString();
        if (typeof x === "function" || typeof x === "symbol") return undefined;
        if (x && typeof x === "object") {
          if (seen.has(x)) return undefined;
          seen.add(x);
          if (Buffer.isBuffer(x)) return x.toString("latin1");
          if (x instanceof Uint8Array) return Buffer.from(x).toString("latin1");
          if (x instanceof Map) return Object.fromEntries(x);
          if (x instanceof Set) return [...x];
        }
        return x;
      }) ?? ""
    );
  } catch {
    return String(v);
  }
}

async function payloadOf(s: Settled): Promise<string> {
  if (s.ok && s.value instanceof Response) {
    const buf = Buffer.from(await s.value.clone().arrayBuffer());
    return `${s.value.status} ${buf.toString("latin1")}`;
  }
  if (!s.ok) return `${(s.error as Error)?.message ?? ""} ${digestOf(s.error)}`;
  return serialize(s.value);
}

type Attempt = { loai: string; mat: string; ket: string };
const log: Attempt[] = [];

type AttackOpts = {
  token?: string | null;
  path?: string;
  /** Cửa không nhận đích (chạy luật của tổ chức mình, xem trước mẫu): được phép thành công, nhưng phải CHỈ chạm A. */
  ownOnly?: (value: unknown) => void;
};

let TOKEN_A = "";

async function attack(loai: string, mat: string, fn: () => Promise<unknown>, opts: AttackOpts = {}) {
  const s = await asRequest(opts.token === undefined ? TOKEN_A : opts.token, opts.path ?? "/", fn);
  const text = await payloadOf(s);
  for (const secret of [MARK, ...SECRETS_B]) assert.ok(!text.includes(secret), `${loai} · ${mat}: kết quả mang dữ liệu của B («${secret}»): ${text.slice(0, 400)}`);
  const why = refusal(s);
  if (opts.ownOnly) {
    if (why === null) opts.ownOnly(s.ok ? s.value : undefined);
    log.push({ loai, mat, ket: why ?? "chỉ chạm A" });
    return s;
  }
  assert.ok(why !== null, `${loai} · ${mat}: lượt gọi bằng dữ liệu của B phải bị từ chối — nhận ${text.slice(0, 400)}`);
  log.push({ loai, mat, ket: why });
  return s;
}

function form(fields: Record<string, string | Blob>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

// ─────────────────────────── bài kiểm ───────────────────────────

export async function testTenantAttack() {
  const realFetch = globalThis.fetch;
  // tsx biên dịch JSX của page component theo kiểu cổ điển (`React.createElement`) — Next thì tự chèn; ở đây gắn tạm.
  const g = globalThis as { React?: unknown };
  const hadReact = "React" in g;
  g.React ??= ReactNs;
  const netCalls: string[] = [];
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = MASTER;
  await cleanup();
  for (const code of [A, B]) rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  clearMemo();

  try {
    // ══════════ B: dựng qua /start bằng MÃ MỜI (blueprint bán sỉ đã cài + trạng thái dựng + mã mời đã gắn) ══════════
    const inviteB = await createInvite({ actor: null, note: `${NOTE} mã mời của B` });
    const spareInvite = await createInvite({ actor: null, note: `${NOTE} mã mời chưa dùng` });
    const planModules = [...WHOLESALE_BLUEPRINT.modules.filter((m) => m !== "purchasing" && !CORE_MODULES.includes(m)), "apps", "alerts"];
    const draftB: SignupDraft = {
      invite: inviteB.code,
      org: { name: `Tổ chức ${MARK}`, code: B },
      admin: { name: `QT ${MARK}`, email: B_EMAIL, password: B_PW },
      plan: { businessType: "wholesale", templateKey: "wholesale", modules: planModules },
      planKey: null,
    };
    const madeB = await withEnv("PLATFORM_SIGNUP_MODE", "invite", () => createOrganizationFromSignup(draftB, { kind: "public", ip: IP_B }, { issue: async () => undefined }));
    assert.ok("ok" in madeB && madeB.created, `B dựng qua /start: ${JSON.stringify(madeB)}`);

    // ══════════ A: cấp thẳng, KHÔNG có Kho / Tài chính (để đòn đệm năng lực thấy được) ══════════
    await provisionOrganization({ code: A, name: "Tổ chức A", modules: ["customers", "products", "orders", "alerts", "apps"], admin: { email: A_EMAIL, name: "QT A", password: A_PW }, source: "TEST", actor: null });

    const qtA = await adminOf(A, A_EMAIL);
    const qtB = await adminOf(B, B_EMAIL);
    assert.ok(qtB.modules?.includes("finance") && !qtA.modules?.includes("finance"), `tiền đề: B có Tài chính, A không — A ${qtA.modules} · B ${qtB.modules}`);
    const actorA: MetadataActor = { id: qtA.id, email: qtA.email };
    const actorB: MetadataActor = { id: qtB.id, email: qtB.email };
    const idB: Record<string, string> = {};

    // ══════════ B có ĐỦ mọi loại dữ liệu ══════════
    const wholesalePlanB = await withOrganization(B, async () => {
      const db = await getDb();
      await db.insert(schema.customers).values({ id: "ta-b-cus1", name: `Khách ${MARK}` });
      const field = async (objectKey: string, input: Record<string, unknown>) => {
        const r = await createCustomField(objectKey, input, actorB);
        assert.ok(r.ok, `B · ${objectKey}.${String(input.key)}: ${JSON.stringify(r)}`);
      };
      // Field tuỳ biến + tệp trên khách.
      await field("customer", { key: "b_hang", label: `Hạng ${MARK}`, type: "text" });
      await field("customer", { key: "b_stage", label: "Giai đoạn", type: "status", options: [{ value: "lead", label: "Tiềm năng" }, { value: "vip", label: "VIP" }] });
      await field("customer", { key: "b_hop_dong", label: "Hợp đồng", type: "file" });
      assert.ok((await saveCustomValues("customer", "ta-b-cus1", { b_hang: `Vàng ${MARK}` }, qtB)).ok);
      const f1 = await saveCustomFile("customer", "ta-b-cus1", "b_hop_dong", { filename: `hd-${MARK}.pdf`, mime: "application/pdf", data: PDF_B }, qtB);
      assert.ok(f1.ok, JSON.stringify(f1));
      idB.customerFile = f1.file.id;

      // Đối tượng tuỳ biến + quan hệ + tệp; và `x_chung` — CÙNG khoá với A.
      for (const [key, label] of [
        ["x_b_hd", `Hợp đồng ${MARK}`],
        ["x_chung", `Chung ${MARK}`],
      ] as const) {
        const r = await createObject(qtB, { key, label, labelPlural: label, icon: "file-text" });
        assert.ok(r.ok, JSON.stringify(r));
      }
      await field("x_b_hd", { key: "gia_tri", label: "Giá trị", type: "currency" });
      await field("x_b_hd", { key: "khach", label: "Khách", type: "relation", relationObject: "customer" });
      await field("x_b_hd", { key: "trang_thai", label: "Trạng thái", type: "status", options: [{ value: "nhap", label: "Nháp" }, { value: "xong", label: "Xong" }] });
      await field("x_b_hd", { key: "tai_lieu", label: "Tài liệu", type: "file" });
      await field("x_chung", { key: "trang_thai", label: "Trạng thái", type: "status", options: [{ value: "moi", label: "Mới" }, { value: "xong", label: "Xong" }], transitions: { moi: ["xong"] } });
      const rec = await createRecord("x_b_hd", { system: { title: `HĐ ${MARK}` }, custom: { gia_tri: 7_000_000, khach: "ta-b-cus1", trang_thai: "nhap" } }, qtB);
      assert.ok(rec.ok, JSON.stringify(rec));
      idB.record = rec.id;
      const f2 = await saveCustomFile("x_b_hd", rec.id, "tai_lieu", { filename: `tl-${MARK}.pdf`, mime: "application/pdf", data: PDF_B }, qtB);
      assert.ok(f2.ok, JSON.stringify(f2));
      idB.recordFile = f2.file.id;
      for (let i = 1; i <= 3; i++) {
        const r = await createRecord("x_chung", { system: { title: `Việc ${i} ${MARK}` }, custom: { trang_thai: "moi" } }, qtB);
        assert.ok(r.ok, JSON.stringify(r));
        if (i === 1) idB.chung = r.id;
      }

      // Trang đã xuất bản: `trang-b` (riêng B) + `chung` (cùng slug, cùng cấu hình với A).
      for (const [slug, name, s] of [
        ["trang-b", `Trang ${MARK}`, TRANG_B],
        ["chung", `Chung ${MARK}`, CHUNG],
      ] as const) {
        const p = await createPage({ slug, name, moduleKey: "apps", nav: { enabled: true } }, actorB);
        assert.ok(p.ok, JSON.stringify(p));
        assert.ok((await savePageDraft(p.page.id, s, actorB)).ok);
        assert.ok((await publishPage(p.page.id, actorB)).ok);
        if (slug === "trang-b") idB.page = p.page.id;
      }

      // Luật + lượt chạy + lời duyệt đang chờ.
      const rule = await saveRule(
        { key: "b_vip", name: `Luật ${MARK}`, trigger: { kind: "custom_status", objectKey: "customer", fieldKey: "b_stage", to: ["vip"] }, conditions: null, actions: [{ kind: "notify", message: `Tin ${MARK}` }], gate: { kind: "approval", reason: `Duyệt ${MARK}` } },
        actorB,
      );
      assert.ok(rule.ok, JSON.stringify(rule));
      idB.rule = rule.rule.id;
      assert.ok((await setRuleStatus(rule.rule.id, "ACTIVE", actorB)).ok);
      assert.ok((await setRuleMode(rule.rule.id, "LIVE", actorB)).ok);
      assert.ok((await saveCustomValues("customer", "ta-b-cus1", { b_stage: "vip" }, qtB)).ok);
      const run = await runWorkflows();
      assert.equal(run.waiting, 1, `B: một lượt chờ duyệt — ${JSON.stringify(run)}`);
      const [req] = await db.select().from(schema.approvalRequests).where(and(eq(schema.approvalRequests.group, "WORKFLOW"), eq(schema.approvalRequests.status, "PENDING")));
      assert.ok(req, "B: lời duyệt đang chờ");
      idB.approval = req.id;

      // Bản nháp AI (provider giả, không mạng).
      setBuilderAiForTests({ provider: new FakeProvider([toolCall(aiBodyB())]), source: "ORG_CONNECTION", connectorKey: "anthropic-byok" });
      const d = await createDraft(qtB, { mode: "new", prompt: `Công ty bán buôn ${MARK} cần CRM, đơn và kho.` });
      assert.ok(d.ok && d.value.valid, JSON.stringify(d));
      idB.aiDraft = d.value.id;
      const dp = await previewDraft(qtB, d.value.id);
      assert.ok(dp.ok, JSON.stringify(dp));
      idB.aiPlanHash = dp.value.plan.planHash;
      setBuilderAiForTests(undefined);

      // Kết nối có bí mật, đã kiểm tra (fetch giả) và BẬT.
      const larkOk = async () => new Response(JSON.stringify({ code: 0 }), { status: 200, headers: { "content-type": "application/json" } });
      assert.ok("ok" in (await saveConnection(qtB, { connectorKey: "lark-webhook", settings: {}, secrets: { webhookUrl: LARK_B, signSecret: SIGN_B } })));
      assert.ok("ok" in (await testOrgConnection(qtB, "lark-webhook", { tester: { fetch: larkOk } })));
      assert.ok("ok" in (await setConnectionStatus(qtB, "lark-webhook", "ACTIVE")));
      // Khoá AI của chính B (BYOK) — kết nối DUY NHẤT có luồng đọc bí mật lúc chạy (AI Builder).
      const probe = async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      assert.ok("ok" in (await saveConnection(qtB, { connectorKey: "anthropic-byok", settings: {}, secrets: { apiKey: AI_KEY_B } })));
      assert.ok("ok" in (await testOrgConnection(qtB, "anthropic-byok", { tester: { fetch: probe } })));
      assert.ok("ok" in (await setConnectionStatus(qtB, "anthropic-byok", "ACTIVE")));
      const own = await openActiveConnection("anthropic-byok");
      assert.ok(own.ok && own.secrets.apiKey === AI_KEY_B, `B mở được khoá AI của chính mình: ${JSON.stringify(own.ok ? "ok" : own.reason)}`);

      // Thương hiệu + logo.
      assert.ok("ok" in (await saveBrandingCore(qtB, { displayName: `Thương hiệu ${MARK}`, accent: null })));
      const logo = await uploadLogoCore(qtB, { data: PNG_B });
      assert.ok("ok" in logo, JSON.stringify(logo));
      idB.logoFile = logo.branding.logoFileId ?? "";

      // Kế hoạch mẫu bán sỉ của B (đã cài ⇒ mọi mục UNCHANGED) — A sẽ thử cài bằng đúng planHash này.
      const pv = await previewTemplate(qtB, "wholesale");
      assert.ok(pv.ok && pv.value.plan.installedVersion, "B đã cài mẫu bán sỉ qua /start");
      return pv.value.plan.planHash;
    });
    // Mã mời thứ hai GẮN cho B (khách được cấp hai mã, dùng một) — A sẽ thử dùng lại.
    assert.ok(await claimInvite(spareInvite.id, B));
    const freeInvite = await createInvite({ actor: null, note: `${NOTE} mã mời còn trống` });
    const inviteIds = [inviteB.id, spareInvite.id, freeInvite.id];

    // ══════════ A: dữ liệu CỦA MÌNH cho các đòn cùng khoá ══════════
    await withOrganization(A, async () => {
      const db = await getDb();
      await db.insert(schema.customers).values({ id: "ta-a-cus1", name: "Khách A1" });
      assert.ok((await createObject(qtA, { key: "x_chung", label: "Chung A", labelPlural: "Chung A", icon: "file-text" })).ok);
      assert.ok((await createCustomField("x_chung", { key: "trang_thai", label: "Trạng thái", type: "status", options: [{ value: "moi", label: "Mới" }, { value: "xong", label: "Xong" }], transitions: { moi: ["xong"] } }, actorA)).ok);
      assert.ok((await createCustomField("x_chung", { key: "khach", label: "Khách", type: "relation", relationObject: "customer" }, actorA)).ok);
      assert.ok((await createCustomField("x_chung", { key: "tep", label: "Tệp", type: "file" }, actorA)).ok);
      assert.ok((await createRecord("x_chung", { system: { title: "Việc của A" }, custom: { trang_thai: "moi" } }, qtA)).ok);
      const p = await createPage({ slug: "chung", name: "Chung A", moduleKey: "apps", nav: { enabled: true } }, actorA);
      assert.ok(p.ok, JSON.stringify(p));
      assert.ok((await savePageDraft(p.page.id, CHUNG, actorA)).ok);
      assert.ok((await publishPage(p.page.id, actorA)).ok);
      idB.pageA = p.page.id;
    });

    TOKEN_A = await signSession({ id: qtA.id, email: qtA.email, name: "QT A", role: "ADMIN", orgCode: A });
    const now = Math.floor(Date.now() / 1000);
    const FORGED = await new SignJWT({ email: B_EMAIL, name: "QT B", role: "ADMIN", org: B, lgn: now })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(qtB.id)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(new TextEncoder().encode(`khoa-gia-cua-ke-tan-cong-${"x".repeat(40)}`));
    assert.notEqual(env.authSecret, `khoa-gia-cua-ke-tan-cong-${"x".repeat(40)}`);

    // ══════════ ẢNH CHỤP TRƯỚC ══════════
    const before = await withOrganization(B, snapshotOrgDb);
    const cpBefore = await snapshotControlPlane(inviteIds);

    // Không một request mạng nào được rời máy trong lúc tấn công.
    globalThis.fetch = (async (input: string | URL | Request) => {
      netCalls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response("chặn trong bài kiểm", { status: 599 });
    }) as typeof fetch;

    // ══════════ ĐÒN 0 · TRẠNG THÁI TIẾN TRÌNH: đệm, đệm năng lực ══════════
    clearMemo();
    const pubB = await withOrganization(B, () => getPageBySlug("chung"));
    assert.ok(pubB);
    const seenB = await withOrganization(B, async () => kpiOf(flat(await resolvePage(pubB.schema, qtB, ctxOf(), "chung")), "c_dem"));
    assert.equal(seenB, 3, "tiền đề: B đếm 3 việc của mình (đệm đã ấm)");
    const pageA = await attack("Đệm", "dựng /p/chung cùng cấu hình ngay sau B (khoá memo)", async () => {
      const pub = await getPageBySlug("chung");
      assert.ok(pub && pub.page.name === "Chung A", "slug `chung` mở trang của A");
      return kpiOf(flat(await resolvePage(pub.schema, qtA, ctxOf(), "chung")), "c_dem");
    }, { path: "/p/chung", ownOnly: () => undefined });
    assert.ok(pageA.ok && pageA.value === 1, `ĐỆM RÒ: A dựng trang cùng cấu hình ngay sau B phải ra số của A (1), nhận ${pageA.ok ? String(pageA.value) : "lỗi"}`);

    await getEnabledModules(B); // đệm năng lực của B vừa được đọc
    const sessA = await attack("Đệm năng lực", "phiên A ngay sau khi module của B được đọc", () => requireUser(), { ownOnly: () => undefined });
    assert.ok(sessA.ok, "phiên A hợp lệ");
    const modsA = (sessA.value as SessionUser).modules ?? [];
    assert.ok(!modsA.includes("finance") && !modsA.includes("inventory"), `ĐỆM NĂNG LỰC RÒ: phiên A mang module của B — ${modsA.join(", ")}`);

    // ══════════ ĐÒN 1 · FIELD / GIÁ TRỊ / TỆP (Phase 2–3) ══════════
    const M = "Field & giá trị";
    await attack(M, "ghi giá trị field lên khách của B", () => saveCustomValuesAction({ objectKey: "customer", recordId: "ta-b-cus1", values: { b_hang: "chiếm" } }), { path: "/customers" });
    await attack(M, "tạo field trên đối tượng của B", () => createFieldAction("x_b_hd", { key: "chen", label: "Chèn", type: "text" }), { path: "/settings/data-model" });
    await attack(M, "sửa field của B", () => updateFieldAction("customer", "b_hang", { label: "Đổi" }), { path: "/settings/data-model" });
    await attack(M, "lưu trữ field của B", () => archiveFieldAction("x_b_hd", "gia_tri"), { path: "/settings/data-model" });
    await attack(M, "đổi thứ tự field của B", () => moveFieldAction("customer", "b_stage", 1), { path: "/settings/data-model" });
    await attack(M, "lưu nháp form của đối tượng B", () => saveFormDraftAdminAction("x_b_hd", "create", { sections: [] }), { path: "/settings/forms" });
    await attack(M, "xuất bản form của đối tượng B", () => publishFormAdminAction("x_b_hd", "create"), { path: "/settings/forms" });
    await attack(M, "lưu nháp danh sách của đối tượng B", () => saveListDraftAdminAction("x_b_hd", "default", { columns: [] }), { path: "/settings/lists" });
    await attack(M, "xuất bản danh sách của đối tượng B", () => publishListAdminAction("x_b_hd", "default"), { path: "/settings/lists" });
    await attack(M, "sửa nhãn trạng thái của B", () => saveStatusOverridesAdminAction("x_b_hd", "trang_thai", [{ value: "nhap", label: "Chiếm" }]), { path: "/settings/statuses" });
    await attack(M, "tải tệp lên field tệp của khách B", () => uploadCustomerFileAction(form({ recordId: "ta-b-cus1", field: "b_hop_dong", file: new File([PDF_B], "x.pdf", { type: "application/pdf" }) })), { path: "/customers" });
    await attack("Tệp tuỳ biến", "GET /api/metadata/files/<tệp khách của B>", () => metadataFileGET(new Request(`http://erp.local/api/metadata/files/${idB.customerFile}`), { params: Promise.resolve({ id: idB.customerFile }) }), { path: `/api/metadata/files/${idB.customerFile}` });
    await attack("Tệp tuỳ biến", "GET /api/metadata/files/<tệp bản ghi của B>", () => metadataFileGET(new Request(`http://erp.local/api/metadata/files/${idB.recordFile}`), { params: Promise.resolve({ id: idB.recordFile }) }), { path: `/api/metadata/files/${idB.recordFile}` });
    await attack("Tệp tuỳ biến", "GET /api/metadata/files/<id tệp logo của B>", () => metadataFileGET(new Request(`http://erp.local/api/metadata/files/${idB.logoFile}`), { params: Promise.resolve({ id: idB.logoFile }) }), { path: `/api/metadata/files/${idB.logoFile}` });
    await attack("Tệp tuỳ biến", "openCustomFile(id tệp của B)", () => openCustomFile(idB.customerFile, qtA));

    // ══════════ ĐÒN 2 · ĐỐI TƯỢNG TUỲ BIẾN + BẢN GHI + QUAN HỆ (Phase 6) ══════════
    const O = "Đối tượng & bản ghi";
    await attack(O, "sửa định nghĩa đối tượng của B", () => updateObjectAction("x_b_hd", { label: "Chiếm" }), { path: "/settings/objects" });
    await attack(O, "lưu trữ đối tượng của B", () => setObjectArchivedAction("x_b_hd", true), { path: "/settings/objects" });
    await attack(O, "tạo bản ghi trong đối tượng của B", () => createRecordAction("x_b_hd", { system: { title: "chen" }, custom: {} }), { path: "/o/x_b_hd" });
    await attack(O, "sửa bản ghi của B", () => updateRecordAction("x_b_hd", idB.record, { system: { title: "đổi" }, custom: { gia_tri: 1 } }), { path: "/o/x_b_hd" });
    await attack(O, "sửa bản ghi của B qua khoá đối tượng TRÙNG (x_chung)", () => updateRecordAction("x_chung", idB.chung, { system: { title: "đổi" }, custom: {} }), { path: "/o/x_chung" });
    await attack(O, "xoá bản ghi của B", () => deleteRecordAction("x_b_hd", idB.record), { path: "/o/x_b_hd" });
    await attack(O, "xoá bản ghi của B qua khoá TRÙNG", () => deleteRecordAction("x_chung", idB.chung), { path: "/o/x_chung" });
    await attack(O, "tải tệp lên bản ghi của B", () => uploadRecordFileAction(form({ objectKey: "x_chung", recordId: idB.chung, field: "tep", file: new File([PDF_B], "x.pdf", { type: "application/pdf" }) })), { path: "/o/x_chung" });
    await attack(O, "tạo bản ghi A trỏ quan hệ tới khách của B", () => createRecordAction("x_chung", { system: { title: "Trỏ B" }, custom: { khach: "ta-b-cus1" } }), { path: "/o/x_chung" });
    await attack(O, "getRecord(x_chung, id của B)", () => getRecord("x_chung", idB.chung, qtA));
    await attack(O, "listRecords(x_b_hd)", () => listRecords("x_b_hd", parseListParams({}, { defaultSort: "" }), qtA));
    await attack(O, "reverseRelations(khách của B)", () => reverseRelations("customer", "ta-b-cus1", qtA));
    await attack(O, "listRecords(x_chung) — chỉ bản ghi của A", () => listRecords("x_chung", parseListParams({}, { defaultSort: "" }), qtA), {
      ownOnly: (v) => assert.equal((v as { total: number }).total, 1, "khoá trùng: A chỉ thấy MỘT bản ghi của mình"),
    });
    await attack(O, "mở /o/x_chung/<id của B> (page component)", async () => {
      const el = await ObjectRecordPage({ params: Promise.resolve({ object: "x_chung", id: idB.chung }) });
      assert.ok(/"ok":false|NOT_FOUND/.test(serialize(el)), "trang chi tiết phải là thông báo từ chối");
      return { ok: false, error: "GateMessage" };
    }, { path: `/o/x_chung/${idB.chung}` });
    await attack(O, "mở /o/x_b_hd (page component)", async () => {
      const el = await ObjectRecordsPage({ params: Promise.resolve({ object: "x_b_hd" }), searchParams: Promise.resolve({}) });
      assert.ok(/"ok":false|NOT_FOUND/.test(serialize(el)), "trang danh sách phải là thông báo từ chối");
      return { ok: false, error: "GateMessage" };
    }, { path: "/o/x_b_hd" });

    // ══════════ ĐÒN 3 · TRANG ĐỘNG + TRÌNH DỰNG (Phase 4–5) ══════════
    const P = "Trang động";
    await attack(P, "getPageBySlug(trang-b)", () => getPageBySlug("trang-b"));
    await attack(P, "mở /p/trang-b (page component)", () => DynamicPage({ params: Promise.resolve({ slug: "trang-b" }), searchParams: Promise.resolve({}) }), { path: "/p/trang-b" });
    await attack(P, "mở /p/cong-no-khach-hang (trang của mẫu B đã cài)", () => DynamicPage({ params: Promise.resolve({ slug: "cong-no-khach-hang" }), searchParams: Promise.resolve({}) }), { path: "/p/cong-no-khach-hang" });
    await attack(P, "runPageAction(trang-b, nút của B)", () => runPageAction("trang-b", "b_nut", {}), { path: "/p/trang-b" });
    await attack(P, "runPageAction(trang-b, hành động dòng trên bản ghi B)", () => runPageAction("trang-b", "b_bang", {}, { recordId: idB.record, actionIndex: 0 }), { path: "/p/trang-b" });
    await attack(P, "runPageAction(chung, kéo thẻ kanban = bản ghi B)", () => runPageAction("chung", "c_kanban", { recordId: idB.chung, value: "xong" }), { path: "/p/chung" });
    await attack(P, "runPageAction(chung, mở dòng = bản ghi B)", () => runPageAction("chung", "c_bang", {}, { recordId: idB.chung, actionIndex: 0 }), { path: "/p/chung" });
    await attack(P, "previewPageBlock(trang của B)", () => previewPageBlock(idB.page, block("x", "kpi", { aggregate: { objectKey: "x_chung", fn: "count" } })), { path: "/settings/pages" });
    await attack(P, "previewPageBlock(trang A, khối đọc đối tượng của B)", () => previewPageBlock(idB.pageA, block("x", "table", { source: "x_b_hd" })), { path: "/settings/pages" });
    await attack(P, "resolveBlock(bảng x_b_hd)", () => resolveBlock(block("x", "table", { source: "x_b_hd" }), qtA, ctxOf()));
    await attack(P, "resolveBlock(KPI tổng x_b_hd)", () => resolveBlock(block("x", "kpi", { aggregate: { objectKey: "x_b_hd", fn: "sum", field: "custom:gia_tri" } }), qtA, ctxOf()));
    await attack(P, "resolveBlock(form sửa khách, ?id=khách của B)", () => resolveBlock(block("x", "form", { objectKey: "customer", formKey: "profile", mode: "edit", recordParam: "id" }), qtA, ctxOf({ id: "ta-b-cus1" })));
    await attack(P, "resolveBlock(dòng thời gian bản ghi x_chung của B)", () => resolveBlock(block("x", "timeline", { source: "custom_record_x_chung", recordParam: "id" }), qtA, ctxOf({ id: idB.chung })));
    await attack(P, "sửa thông tin trang của B", () => updatePageMetaAction(idB.page, { slug: "trang-b", name: "Chiếm", moduleKey: "apps", requiredPermission: null, nav: { enabled: true } }), { path: "/settings/pages" });
    await attack(P, "lưu nháp trang của B", () => savePageDraftAction(idB.page, CHUNG), { path: "/settings/pages" });
    await attack(P, "xuất bản trang của B", () => publishPageAction(idB.page), { path: "/settings/pages" });
    await attack(P, "lưu trữ trang của B", () => archivePageAction(idB.page), { path: "/settings/pages" });
    await attack(P, "trình kéo-thả: lưu nháp trang của B", () => saveBuilderDraftAction(idB.page, CHUNG, 1), { path: "/settings/pages" });
    await attack(P, "trình kéo-thả: tải nháp trang của B", () => loadBuilderDraftAction(idB.page), { path: "/settings/pages" });
    await attack(P, "trình kéo-thả: xuất bản trang của B", () => publishBuilderPageAction(idB.page), { path: "/settings/pages" });
    await attack(P, "trình kéo-thả: đưa trang của B vào menu", () => addPageToMenuAction(idB.page), { path: "/settings/pages" });
    await attack(P, "mở trình soạn trang của B (loader)", () => loadPageEditor(qtA, idB.page));
    await attack(P, "mở trình kéo-thả trang của B (loader)", () => loadPageBuilder(qtA, idB.page));
    await attack(P, "tải nháp trang của B (lõi)", () => adminLoadBuilderDraft(qtA, idB.page));

    // ══════════ ĐÒN 4 · LUẬT + LƯỢT CHẠY + LỜI DUYỆT (Phase 3) ══════════
    const W = "Luật & duyệt";
    await attack(W, "sửa luật của B", () => saveWorkflowRuleAction(idB.rule, { key: "b_vip", name: "Chiếm", trigger: { kind: "event", event: "custom_status.changed" }, actions: [{ kind: "notify", message: "x" }] }), { path: "/settings/workflows" });
    await attack(W, "tạm dừng luật của B", () => setWorkflowRuleStatusAction(idB.rule, "PAUSED"), { path: "/settings/workflows" });
    await attack(W, "đổi chế độ luật của B", () => setWorkflowRuleModeAction(idB.rule, "DRY_RUN"), { path: "/settings/workflows" });
    await attack(W, "chạy thử luật của B trên khách của B", () => previewWorkflowRuleAction(idB.rule, { objectKey: "customer", recordId: "ta-b-cus1" }), { path: "/settings/workflows" });
    await attack(W, "mở trình soạn luật của B (loader)", () => loadWorkflowEditor(qtA, idB.rule));
    await attack(W, "duyệt lời duyệt của B", () => decideApproval(idB.approval, true, "chiếm"), { path: "/alerts" });
    await attack(W, "từ chối lời duyệt của B", () => decideApproval(idB.approval, false, "phá"), { path: "/alerts" });
    await attack(W, "danh sách chờ duyệt không có lời duyệt của B", () => listPendingApprovals(), {
      path: "/alerts",
      ownOnly: (v) => assert.ok(!serialize(v).includes(idB.approval), "danh sách chờ duyệt của A không có lời duyệt của B"),
    });
    await attack(W, "«chạy luật ngay» — chỉ luật của A", () => runWorkflowsNowAction(), {
      path: "/settings/workflows",
      ownOnly: (v) => assert.equal((v as { runs?: number }).runs ?? 0, 0, "A không có luật nào ⇒ 0 lượt chạy (lượt chờ của B không bị chạm)"),
    });

    // ══════════ ĐÒN 5 · BLUEPRINT (Phase 7) ══════════
    const T = "Blueprint";
    await attack(T, "xem trước mẫu bán sỉ — kế hoạch của A, không phải trạng thái đã cài của B", () => previewTemplateAction("wholesale", {}), {
      path: "/settings/templates",
      ownOnly: (v) => {
        const plan = (v as { plan: { installedVersion: string | null; planHash: string } }).plan;
        assert.equal(plan.installedVersion, null, "A chưa cài ⇒ phiên bản đã cài phải là null (B đã cài)");
        assert.notEqual(plan.planHash, wholesalePlanB, "kế hoạch của A khác kế hoạch của B");
      },
    });
    await attack(T, "cài mẫu bằng planHash B đã xem", () => installTemplateAction("wholesale", { planHash: wholesalePlanB, resolutions: {} }), { path: "/settings/templates" });
    await attack(T, "lịch sử cài của A không có lượt cài của B", () => loadTemplateCatalog(qtA), {
      ownOnly: (v) => assert.equal((v as { value: { history: unknown[] } }).value.history.length, 0, "A chưa cài lượt nào"),
    });

    // ══════════ ĐÒN 6 · AI BUILDER (Phase 8) ══════════
    const I = "AI Builder";
    await attack(I, "xem trước nháp AI của B", () => previewAiDraftAction(idB.aiDraft, { excludedKeys: [], resolutions: {} }), { path: "/settings/ai-builder" });
    await attack(I, "áp dụng nháp AI của B (đúng planHash)", () => applyAiDraftAction(idB.aiDraft, { planHash: idB.aiPlanHash, excludedKeys: [], resolutions: {} }), { path: "/settings/ai-builder" });
    await attack(I, "bỏ nháp AI của B", () => discardAiDraftAction(idB.aiDraft), { path: "/settings/ai-builder" });
    await attack(I, "đọc nháp AI của B (lõi)", () => loadDraft(qtA, idB.aiDraft));
    await attack(I, "ngữ cảnh AI của A (readOrgBuilderState)", () => readOrgBuilderState(), {
      ownOnly: (v) => {
        const s = serialize(v);
        assert.ok(!s.includes("x_b_hd") && !s.includes("b_stage") && !s.includes("b_hang"), "ngữ cảnh AI của A không có khoá của B");
      },
    });
    const spy = new FakeProvider([() => ({ content: [{ type: "text", text: "không có gói" }], stopReason: "end_turn" })]);
    setBuilderAiForTests({ provider: spy, source: "ORG_CONNECTION", connectorKey: "anthropic-byok" });
    try {
      await attack(I, "soạn nháp «sửa lặp» — tóm tắt gửi AI là của A", () => createAiDraftAction({ mode: "edit", prompt: "Thêm field hạng khách cho đối tượng chung." }), {
        path: "/settings/ai-builder",
        ownOnly: () => undefined,
      });
    } finally {
      setBuilderAiForTests(undefined);
    }
    assert.ok(spy.calls.length >= 1, "provider giả phải được gọi (lượt soạn chạy thật)");
    const sent = serialize(spy.calls);
    assert.ok(sent.includes("Chung A") && !sent.includes("x_b_hd") && !sent.includes(MARK), "tóm tắt cấu hình gửi AI: có khoá của A, không một khoá / chữ nào của B");

    // ══════════ ĐÒN 7 · KẾT NỐI + BÍ MẬT (Phase 9) ══════════
    const C = "Kết nối & bí mật";
    await attack(C, "kiểm tra kết nối lark-webhook (của B)", () => testConnectionAction("lark-webhook"), { path: "/settings/connections" });
    await attack(C, "bật kết nối lark-webhook (của B)", () => setConnectionStatusAction({ connectorKey: "lark-webhook", status: "ACTIVE" }), { path: "/settings/connections" });
    await attack(C, "tắt kết nối lark-webhook (của B)", () => setConnectionStatusAction({ connectorKey: "lark-webhook", status: "DISABLED" }), { path: "/settings/connections" });
    await attack(C, "lưu kết nối với ô bí mật TRỐNG (mong «giữ bí mật cũ» của B)", () => saveConnectionAction({ connectorKey: "lark-webhook", settings: {}, secrets: {} }), { path: "/settings/connections" });
    await attack(C, "đọc khoá AI đang bật (openActiveConnection anthropic-byok)", () => openActiveConnection("anthropic-byok"));
    await attack(C, "AI Builder của A mượn khoá AI của B (getBuilderAi)", () => getBuilderAi({ fetch: globalThis.fetch }).then((r) => (r.ok ? { ok: true, source: r.ai.source } : { ok: false, error: r.reason })));
    await attack(C, "kiểm tra khoá AI (anthropic-byok của B)", () => testConnectionAction("anthropic-byok"), { path: "/settings/connections" });
    await attack(C, "màn Kết nối của A không có dấu vết của B", () => loadConnectionsView(qtA), {
      ownOnly: (v) => {
        const lark = (v as { groups: { rows: { key: string; connection: unknown }[] }[] }).groups.flatMap((g) => g.rows).find((r) => r.key === "lark-webhook");
        assert.equal(lark?.connection ?? null, null, "A không thấy kết nối của B");
      },
    });
    // Bản mã bị đánh cắp: dòng khoá AI ĐANG BẬT của B chép vào A, mã tổ chức SỬA thành A ⇒ chỉ còn AAD đứng chặn.
    const stolen = await withOrganization(B, async () => (await (await getDb()).select().from(schema.orgConnections).where(eq(schema.orgConnections.connectorKey, "anthropic-byok")))[0]);
    assert.ok(stolen?.secretsEnc && stolen.status === "ACTIVE", "tiền đề: B có bản mã đang bật");
    await withOrganization(A, async () => (await getDb()).insert(schema.orgConnections).values({ ...stolen, id: "ta-danh-cap", orgCode: A }));
    try {
      const read = await attack(C, "đọc khoá AI từ bản mã của B chép sang A (AAD)", () => openActiveConnection("anthropic-byok"));
      assert.ok(read.ok && /giải mã/i.test(serialize(read.value)), `bản mã của B không giải được ở A: ${serialize(read.ok ? read.value : read.error)}`);
      await attack(C, "AI Builder của A dùng bản mã đánh cắp (getBuilderAi)", () => getBuilderAi({ fetch: globalThis.fetch }).then((r) => (r.ok ? { ok: true, source: r.ai.source } : { ok: false, error: r.reason })));
      await attack(C, "kiểm tra kết nối bằng bản mã đánh cắp", () => testConnectionAction("anthropic-byok"), { path: "/settings/connections" });
    } finally {
      await withOrganization(A, async () => (await getDb()).delete(schema.orgConnections).where(eq(schema.orgConnections.id, "ta-danh-cap")));
    }

    // ══════════ ĐÒN 8 · THƯƠNG HIỆU / LOGO / TỰ PHỤC VỤ / ĐĂNG NHẬP / VẬN HÀNH NỀN TẢNG (Phase 10 + 1) ══════════
    const S = "Thương hiệu & tự phục vụ";
    await attack(S, "GET /api/branding/logo (A không có logo ⇒ 404, không phải byte của B)", () => logoGET(), { path: "/api/branding/logo" });
    await attack(S, "readLogo()", () => readLogo());
    await attack(S, "thương hiệu của A không mang tên B", () => getBranding(), { ownOnly: () => undefined });
    await attack(S, "gỡ logo — chỉ gỡ của A", () => removeLogoAction(), { path: "/settings/branding", ownOnly: () => undefined });
    await attack(S, "tạo mã mời (không phải người vận hành)", () => createInviteAction({ note: `${NOTE} kẻ lạ` }), { path: "/platform" });
    await attack(S, "thu hồi mã mời CÒN TRỐNG", () => revokeInviteAction(freeInvite.id), { path: "/platform" });
    await attack(S, "thu hồi mã mời đã gắn B", () => revokeInviteAction(inviteB.id), { path: "/platform" });
    await attack(S, "chạy lại việc dựng tổ chức B", () => retrySetupAction(B), { path: "/platform" });
    await attack(S, "tắt module Ứng dụng của B", () => toggleModuleForOrgAction({ orgCode: B, moduleKey: "apps", enabled: false, reason: "kẻ lạ tắt hộ" }), { path: "/platform" });
    await attack(S, "bật module Sản xuất cho B", () => toggleModuleForOrgAction({ orgCode: B, moduleKey: "production", enabled: true, reason: "kẻ lạ bật hộ" }), { path: "/platform" });
    await withEnv("PLATFORM_SIGNUP_MODE", "invite", async () => {
      await attack(S, "/start: kiểm mã tổ chức ta-b bằng mã mời còn trống", () => checkOrgAction({ name: "Chiếm B", code: B }, freeInvite.code), { path: "/start" });
      const redo = (invite: string, email: string, password: string): SignupDraft => ({ ...draftB, invite, admin: { name: "Kẻ lạ", email, password } });
      await attack(S, "/start: tạo tổ chức mã ta-b bằng mã mời còn trống", () => createOrganizationAction(redo(freeInvite.code, "ke-la@ta-a.local", "KeLa@2026x")), { path: "/start" });
      await attack(S, "/start: dùng lại mã mời đã gắn B (email lạ)", () => createOrganizationAction(redo(spareInvite.code, "ke-la@ta-a.local", "KeLa@2026x")), { path: "/start" });
      await attack(S, "/start: dùng lại mã mời dựng B + email quản trị B, sai mật khẩu", () => createOrganizationAction(redo(inviteB.code, B_EMAIL, "SaiMatKhau@2026")), { path: "/start" });
      await attack(S, "/start: xem trước bằng mã mời của B", () => previewSignupAction({ invite: inviteB.code, orgCode: B, plan: draftB.plan, planKey: null }), {
        path: "/start",
        ownOnly: (v) => assert.ok(!serialize(v).includes("x_b_hd"), "xem trước dựng trên tổ chức TRẮNG, không đọc gì của B"),
      });
    });
    await withEnv("PLATFORM_SIGNUP_MODE", "open", async () => {
      await attack(S, "/start (mở): tạo tổ chức mã ta-b", () => createOrganizationAction({ ...draftB, invite: null, admin: { name: "Kẻ lạ", email: "ke-la@ta-a.local", password: "KeLa@2026x" } }), { path: "/start" });
    });
    const login = await attack(S, "đăng nhập VÀO B bằng tài khoản của A", () => loginAction(undefined, form({ email: A_EMAIL, password: A_PW, org: B, next: "/da-vao-b" })), { path: "/login" });
    assert.ok(login.ok && typeof (login.value as { error?: unknown }).error === "string", `đăng nhập phải TRẢ LỖI (không chuyển hướng vào trong): ${serialize(login.ok ? login.value : digestOf(login.error))}`);
    let issued = false;
    await attack(S, "verifyLogin(email + mật khẩu của A, tổ chức B)", () => verifyLogin({ email: A_EMAIL, password: A_PW, orgCode: B }, async () => void (issued = true)));
    assert.equal(issued, false, "không một phiên nào mang org = B được ký cho tài khoản của A");
    await attack(S, "POST /api/sync/<job>?org=ta-b bằng phiên A", () => syncPOST(new NextLikeRequest(`http://erp.local/api/sync/alerts?org=${B}`) as never, { params: Promise.resolve({ job: "alerts" }) }), { path: "/api/sync/alerts" });

    // ══════════ ĐÒN 9 · PHIÊN GIẢ (claim org = ta-b, sub = quản trị B, ký bằng khoá sai) ══════════
    const F = "Phiên giả";
    await attack(F, "tạo bản ghi trong x_b_hd", () => createRecordAction("x_b_hd", { system: { title: "giả" }, custom: {} }), { token: FORGED, path: "/o/x_b_hd" });
    await attack(F, "duyệt lời duyệt của B", () => decideApproval(idB.approval, true, "giả"), { token: FORGED, path: "/alerts" });
    await attack(F, "xuất bản trang của B", () => publishPageAction(idB.page), { token: FORGED, path: "/settings/pages" });
    await attack(F, "áp dụng nháp AI của B", () => applyAiDraftAction(idB.aiDraft, { planHash: idB.aiPlanHash, excludedKeys: [], resolutions: {} }), { token: FORGED, path: "/settings/ai-builder" });
    await attack(F, "bật kết nối của B", () => setConnectionStatusAction({ connectorKey: "lark-webhook", status: "DISABLED" }), { token: FORGED, path: "/settings/connections" });
    await attack(F, "tải tệp của B qua route", () => metadataFileGET(new Request(`http://erp.local/api/metadata/files/${idB.customerFile}`), { params: Promise.resolve({ id: idB.customerFile }) }), { token: FORGED, path: `/api/metadata/files/${idB.customerFile}` });
    await attack(F, "tải logo của B qua route", () => logoGET(), { token: FORGED, path: "/api/branding/logo" });
    await attack(F, "mở /p/trang-b", () => DynamicPage({ params: Promise.resolve({ slug: "trang-b" }), searchParams: Promise.resolve({}) }), { token: FORGED, path: "/p/trang-b" });

    // ══════════ SAU: B không đổi một dòng, không request mạng nào ══════════
    globalThis.fetch = realFetch;
    assert.deepEqual(netCalls, [], "không một lượt tấn công nào được gửi request ra mạng");
    const after = await withOrganization(B, snapshotOrgDb);
    assert.deepEqual(diff(before, after), [], "CSDL của B phải y nguyên sau mọi lượt tấn công (số dòng + băm nội dung từng bảng)");
    assert.deepEqual(diff(cpBefore, await snapshotControlPlane(inviteIds)), [], "dòng mặt phẳng điều khiển của B (tổ chức, module, mã mời, nhật ký nền tảng) phải y nguyên");
    await withOrganization(B, async () => {
      assert.ok((await openActiveConnection("anthropic-byok")).ok, "B vẫn mở được khoá AI của mình");
      assert.equal((await readLogo())?.data.equals(PNG_B), true, "logo của B còn nguyên");
      assert.ok(await getPageBySlug("trang-b"), "trang của B còn xuất bản");
    });

    const byType = new Map<string, number>();
    for (const a of log) byType.set(a.loai, (byType.get(a.loai) ?? 0) + 1);
    console.log(
      `✓ Phase 11 · H1 tấn công cô lập: phiên thật của A gọi thẳng ${log.length} mặt bằng id / khoá / slug / tệp / mã mời của B — ` +
        [...byType].map(([k, n]) => `${k} ${n}`).join(" · ") +
        ` — mọi lượt bị từ chối hoặc chỉ chạm A, 0 kết quả mang dữ liệu / bí mật của B, 0 request mạng; CSDL B (${before.size} bảng) + 5 nhóm dòng mặt phẳng điều khiển của B y nguyên. Mặt đã tấn công: ` +
        log.map((a) => `[${a.loai}] ${a.mat} ⇒ ${a.ket}`).join("; "),
    );
  } finally {
    if (!hadReact) delete g.React;
    removeRealStores();
    globalThis.fetch = realFetch;
    setSessionTokenSourceForTests(null);
    setRequestPathSourceForTests(null);
    setBuilderAiForTests(undefined);
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    await cleanup();
    clearMemo();
  }
}

/** `NextRequest` tối thiểu cho route job: `nextUrl.searchParams` + `headers`. */
class NextLikeRequest extends Request {
  readonly nextUrl: URL;
  constructor(url: string) {
    super(url, { method: "POST" });
    this.nextUrl = new URL(url);
  }
}

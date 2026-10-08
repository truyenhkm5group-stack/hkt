/**
 * ═══════════ LUỒNG TẠO TỔ CHỨC TỰ PHỤC VỤ (Phase 10 · §1–§2) — CHỈ MÁY CHỦ ═══════════
 *
 * MỘT luồng cho ba cửa vào: khách có mã mời (`invite`), khách tự đăng ký (`open`), người vận hành nền tảng tạo hộ
 * (`operator`, luôn được, không cần cờ). Không có đường tạo tổ chức thứ hai — mọi thứ đi qua:
 *
 *   gate (cờ / mã mời / trần) → lược đồ (zod, như trình duyệt) → blueprint (mẫu cắt theo module, hoặc trắng)
 *   → kế hoạch (`planBlueprint`, phải ok) + hạn mức gói → `provisionOrganization` (module LÕI, chưa quản trị)
 *   → CSDL mới phải RỖNG → `provisionOrganization` (quản trị đầu tiên) → `installBlueprint` trong `withOrganization`
 *   → thuê bao sản phẩm theo module mẫu vừa bật (`openSignupSubscriptions`, không làm hỏng lượt dựng — F-02)
 *   → DONE → đăng nhập qua ĐÚNG `verifyLogin` của màn đăng nhập (khách) / không đăng nhập (người vận hành).
 *
 * ─── IDEMPOTENT THEO MÃ TỔ CHỨC ───
 * Trạng thái dựng nằm ở `platform_organizations.settings.onboarding` (`RUNNING` · `DONE` · `FAILED`). Gửi lại cùng
 * bản nháp (bấm hai lần, trình duyệt gửi lại, chạy lại sau hỏng) với cùng mã tổ chức và CÙNG chủ (cùng mã mời, hoặc
 * người vận hành) thì: đã `DONE` ⇒ không làm gì (khách: kiểm mật khẩu rồi mới đăng nhập); `FAILED` ⇒ chạy tiếp —
 * `provisionOrganization` và bộ cài đều idempotent nên không gì nhân đôi. Chủ khác ⇒ "mã đã có người dùng".
 *
 * ─── HỎNG GIỮA CHỪNG ⇒ `SETUP_FAILED`, KHÔNG XOÁ GÌ ───
 * Tổ chức chuyển `SETUP_FAILED` (không đăng nhập, không job), bước hỏng + câu lỗi ghi vào trạng thái dựng và nhật ký
 * nền tảng; `/platform` hiện nó cho người vận hành, kèm nút chạy lại. CSDL không bị xoá tự động: xoá dữ liệu là
 * quyết định của người (AGENTS.md mục 7).
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, getPlatformDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { verifyLogin } from "@/lib/auth/login";
import { initWorkspaceBilling } from "@/lib/billing/service";
import { resolvePermissions } from "@/lib/auth/permissions";
import type { SessionSubject, SessionUser } from "@/lib/auth/session";
import { PRIVACY_POLICY, TERMS_OF_SERVICE } from "@/lib/constants/company";
import { moduleDef } from "@/lib/constants/platform-modules";
import { installBlueprint } from "@/lib/blueprints/install";
import { planBlueprint } from "@/lib/blueprints/plan";
import { BLUEPRINT_ITEM_KIND_LABEL } from "@/lib/blueprints/types";
import { DEFAULT_PLAN_KEY, listPlans, overPlanLimits, resolvePlan } from "@/lib/entitlements/check";
import { platformAudit, type PlatformActor } from "@/lib/platform/audit";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { markPilotConfigured, markPilotCreated } from "@/lib/platform/pilot";
import { provisionOrganization } from "@/lib/platform/provision";
import { markOrganizationDraft } from "@/lib/platform/publish";
import { openSignupSubscriptions } from "@/lib/saas/signup-subscriptions";
import { buildSignupBlueprint, freshOrgState, type SignupBlueprint } from "@/lib/onboarding/blueprint";
import { claimInvite, lookupInvite, type InviteRow } from "@/lib/onboarding/invites";
import { checkSignupRate, hashIp, recordAttempt, type AttemptMode } from "@/lib/onboarding/rate";
import { effectiveSignupMode } from "@/lib/onboarding/signup-mode";
import {
  adminStepZ,
  CORE_MODULES,
  firstIssue,
  inviteCodeZ,
  orgStepZ,
  planStepZ,
  signupDraftZ,
  type PlanStep,
  type SignupMode,
  type SignupPreview,
  type SignupStepResult,
} from "@/lib/onboarding/shared";

// ═══ CỜ + CỬA VÀO ═══

/**
 * Chế độ đăng ký ĐANG CÓ HIỆU LỰC, đọc ở MÁY CHỦ mỗi lần = min(trần `PLATFORM_SIGNUP_MODE`, cài đặt control plane) —
 * `lib/onboarding/signup-mode.ts`. Người vận hành đổi cài đặt ở `/platform`: có hiệu lực không cần deploy.
 */
export async function signupMode(): Promise<SignupMode> {
  return effectiveSignupMode();
}

export const SIGNUP_CLOSED = "Chưa mở đăng ký tổ chức mới.";

export type OperatorActor = { orgCode: string; userId: string; email: string };
/** Ai đang đi luồng. `operator` do lớp action quyết từ PHIÊN (`platformOperatorDenial`), không bao giờ từ client. */
export type SignupActor = { kind: "public"; ip: string } | { kind: "operator"; ip: string; actor: OperatorActor };

type Gate = { ok: true; mode: AttemptMode; ipHash: string } | { ok: false; error: string };

async function gate(who: SignupActor): Promise<Gate> {
  const ipHash = hashIp(who.ip);
  if (who.kind === "operator") return { ok: true, mode: "operator", ipHash };
  const mode = await signupMode();
  if (mode === "off") return { ok: false, error: SIGNUP_CLOSED };
  return { ok: true, mode, ipHash };
}

function platformActorOf(who: SignupActor): PlatformActor {
  return who.kind === "operator" ? who.actor : null;
}

// ═══ TRẠNG THÁI DỰNG (settings.onboarding của dòng tổ chức) ═══

export type OnboardingState = {
  state: "RUNNING" | "DONE" | "FAILED";
  source: "INVITE" | "OPEN" | "OPERATOR";
  inviteId: string | null;
  templateKey: string | null;
  blueprintKey: string;
  modules: string[];
  adminEmail: string;
  startedAt: string;
  finishedAt: string | null;
  failedStep: string | null;
  error: string | null;
  installId: string | null;
  runs: number;
  /**
   * Bước THUÊ BAO SẢN PHẨM của lượt dựng gần nhất (F-02, `lib/saas/signup-subscriptions.ts`): sản phẩm vừa mở, sản phẩm đang
   * dùng theo module, câu lỗi nếu hỏng. Bước này KHÔNG làm hỏng lượt dựng — đây là vết đọc được của nó. Dòng có từ trước bản vá
   * không có ô này (`undefined`), không suy ra gì từ đó.
   */
  subscriptions?: { at: string; opened: string[]; inUse: string[] | null; error: string | null };
};

/** Mốc "đang dựng" coi là CHẾT sau từng này (tiến trình sập giữa chừng) — lượt sau được chạy tiếp. Câu SQL của `claimRunning` ghi cùng số: 10 phút. */
const RUNNING_STALE_MS = 10 * 60_000;

async function orgRow(code: string) {
  const pdb = await getPlatformDb();
  return pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
}

export async function readOnboarding(code: string): Promise<OnboardingState | null> {
  const row = await orgRow(code);
  const raw = (row?.settings as Record<string, unknown> | null)?.onboarding;
  return raw && typeof raw === "object" ? (raw as OnboardingState) : null;
}

async function writeOnboarding(code: string, patch: Partial<OnboardingState>, status?: "ACTIVE" | "SETUP_FAILED") {
  const row = await orgRow(code);
  if (!row) return;
  const settings = (row.settings ?? {}) as Record<string, unknown>;
  const prev = (settings.onboarding ?? {}) as Partial<OnboardingState>;
  const pdb = await getPlatformDb();
  await pdb
    .update(schema.platformOrganizations)
    .set({ settings: { ...settings, onboarding: { ...prev, ...patch } }, ...(status ? { status } : {}), updatedAt: new Date() })
    .where(eq(schema.platformOrganizations.code, code));
  invalidateOrganizations();
}

/** Lượt khác đang dựng đúng tổ chức này (bấm hai lần, hai tab) — lượt thua dừng, KHÔNG đánh dấu hỏng. */
class SetupBusyError extends Error {}

/**
 * Giành quyền dựng: MỘT câu điều kiện — chỉ đổi sang `RUNNING` khi chưa ai đang dựng (hoặc lượt đang dựng đã chết quá
 * `RUNNING_STALE_MS`). Hai lượt đua nhau thì đúng một lượt đi tiếp.
 */
async function claimRunning(code: string, next: OnboardingState) {
  const pdb = await getPlatformDb();
  const t = schema.platformOrganizations;
  const won = await pdb
    .update(t)
    .set({ settings: sql`jsonb_set(coalesce(${t.settings}, '{}'::jsonb), '{onboarding}', ${JSON.stringify(next)}::jsonb, true)`, updatedAt: new Date() })
    .where(and(eq(t.code, code), sql`((${t.settings}->'onboarding'->>'state') is distinct from 'RUNNING' or (${t.settings}->'onboarding'->>'startedAt')::timestamptz < now() - interval '10 minutes')`))
    .returning({ id: t.id });
  invalidateOrganizations();
  if (won.length === 0) throw new SetupBusyError("Tổ chức đang được dựng bởi một lượt khác — đợi vài giây rồi thử lại.");
}

/** Mọi tổ chức có trạng thái dựng (cho `/platform`). */
export async function listOnboardingStates(): Promise<Record<string, OnboardingState>> {
  const pdb = await getPlatformDb();
  const rows = await pdb.select({ code: schema.platformOrganizations.code, settings: schema.platformOrganizations.settings }).from(schema.platformOrganizations);
  const out: Record<string, OnboardingState> = {};
  for (const r of rows) {
    const raw = (r.settings as Record<string, unknown> | null)?.onboarding;
    if (raw && typeof raw === "object") out[r.code] = raw as OnboardingState;
  }
  return out;
}

// ═══ MÓC KIỂM THỬ: tiêm lỗi vào một bước ═══

export type SetupStepName = "PROVISION" | "ADMIN" | "INSTALL" | "FINISH";
/** Điểm tiêm lỗi: bốn bước làm hỏng lượt dựng + bước thuê bao sản phẩm (KHÔNG làm hỏng lượt dựng — chỉ để lại vết). */
export type SetupFaultPoint = SetupStepName | "SUBSCRIPTIONS";
let faultHook: ((step: SetupFaultPoint) => void) | null = null;
/** Chỉ bộ kiểm thử gọi: ném ở bước chỉ định để chứng minh nhánh `SETUP_FAILED` (hoặc nhánh vết của bước thuê bao). `null` để gỡ. */
export function setOnboardingFaultForTests(hook: ((step: SetupFaultPoint) => void) | null) {
  faultHook = hook;
}

const SETUP_SOURCE_LABEL: Record<OnboardingState["source"], string> = { OPEN: "cửa hàng tự đăng ký", INVITE: "khách có mã mời", OPERATOR: "người vận hành dựng hộ" };

/**
 * Bước THUÊ BAO SẢN PHẨM của lượt dựng (F-02): chạy SAU khi mẫu ngành đã bật module, mở thuê bao cho sản phẩm đang dùng — CÙNG
 * hàm với lượt sửa bù (`openSignupSubscriptions`). Không bao giờ làm hỏng lượt dựng; kết quả (kể cả câu lỗi) ghi vào trạng thái
 * dựng để đọc lại được, cạnh dòng nhật ký nền tảng mà hàm đã ghi khi hỏng.
 */
async function openSetupSubscriptions(input: SetupInput) {
  const outcome = await openSignupSubscriptions(input.code, {
    actor: platformActorOf(input.who),
    reason: `Mở cùng lượt dựng /start (${SETUP_SOURCE_LABEL[input.source]}) — theo module đang dùng sau khi cài mẫu`,
    auditSource: "UI",
    beforeOpen: () => faultHook?.("SUBSCRIPTIONS"),
  });
  try {
    await writeOnboarding(input.code, {
      subscriptions: outcome.ok ? { at: new Date().toISOString(), opened: outcome.opened, inUse: outcome.inUse, error: null } : { at: new Date().toISOString(), opened: [], inUse: null, error: outcome.error },
    });
  } catch (error) {
    console.warn(`[onboarding] không ghi được vết bước thuê bao của ${input.code}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ═══ TỪNG BƯỚC (mỗi bước kiểm ở máy chủ) ═══

async function reservedCode(code: string): Promise<boolean> {
  const home = await getHomeOrganization();
  return code === home.code;
}

/** Bước 1 — mã mời (chỉ khi `invite`). Tra, không tiêu mã. Mã sai tính vào trần của IP. */
export async function checkInviteStep(raw: unknown, who: SignupActor): Promise<SignupStepResult> {
  const g = await gate(who);
  if (!g.ok) return { error: g.error };
  if (g.mode !== "invite") return { ok: true };
  const rate = await checkSignupRate(g.mode, g.ipHash, { creating: false });
  if (!rate.ok) return { error: rate.error };
  const parsed = inviteCodeZ.safeParse(raw);
  const found = parsed.success ? await lookupInvite(parsed.data) : null;
  if (!found?.ok) {
    await recordAttempt({ mode: g.mode, ipHash: g.ipHash, outcome: "INVITE_REJECTED", reason: found && !found.ok ? found.reason : "SHAPE" });
    return { error: found && !found.ok ? found.error : "Mã mời không đúng." };
  }
  return { ok: true };
}

/**
 * Bước 2 — tổ chức (tên, mã, kiểm trùng). Ở chế độ `invite` phải kèm mã mời hợp lệ: không cho người không có mã
 * dùng ô "kiểm trùng" làm máy dò danh sách khách hàng. Ở `open`, mỗi lượt trùng tính vào trần của IP.
 */
export async function checkOrgStep(input: unknown, invite: unknown, who: SignupActor): Promise<SignupStepResult> {
  const g = await gate(who);
  if (!g.ok) return { error: g.error };
  const parsed = orgStepZ.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  if (g.mode === "invite") {
    const inv = typeof invite === "string" ? await lookupInvite(invite, parsed.data.code) : null;
    if (!inv?.ok) return { error: inv && !inv.ok ? inv.error : "Thiếu mã mời." };
  }
  if (g.mode !== "operator") {
    const rate = await checkSignupRate(g.mode, g.ipHash, { creating: false });
    if (!rate.ok) return { error: rate.error };
  }
  if (await reservedCode(parsed.data.code)) return { error: "Mã này dành riêng cho nền tảng — chọn mã khác." };
  const existing = await findOrganization(parsed.data.code);
  if (existing) {
    if (g.mode === "open") await recordAttempt({ mode: g.mode, ipHash: g.ipHash, orgCode: parsed.data.code, outcome: "REJECTED", reason: "CODE_TAKEN" });
    return { error: "Mã tổ chức này đã có người dùng — chọn mã khác." };
  }
  return { ok: true };
}

/** Bước 3 — quản trị đầu tiên (chỉ lược đồ; tài khoản chưa tồn tại ở đâu cả). */
export function checkAdminStep(input: unknown): SignupStepResult {
  const parsed = adminStepZ.safeParse(input);
  return parsed.success ? { ok: true } : { error: firstIssue(parsed.error) };
}

// ═══ XEM TRƯỚC (= planBlueprint, chưa ghi gì) ═══

async function planFor(who: SignupActor, invite: InviteRow | null, requested: string | null | undefined): Promise<string> {
  if (who.kind === "operator") {
    const key = requested?.trim();
    if (key && (await listPlans()).some((p) => p.key === key)) return key;
    return DEFAULT_PLAN_KEY;
  }
  return invite?.planKey?.trim() || DEFAULT_PLAN_KEY;
}

type Built = { built: SignupBlueprint; preview: SignupPreview };

async function buildPreview(step: PlanStep, planKey: string): Promise<Built | { error: string }> {
  const built = buildSignupBlueprint(step);
  if ("error" in built) return built;
  const plan = planBlueprint(built.bp, { orgState: freshOrgState(), can: () => true });
  const resolved = await resolvePlan({ isHome: false, plan: planKey });
  const over = resolved ? overPlanLimits(resolved.limits, { users: 1, pages: built.bp.pages?.length ?? 0, workflows: built.bp.workflows?.length ?? 0, objects: built.bp.objects?.length ?? 0 }, resolved.name) : ["Không đọc được gói dịch vụ."];
  const preview: SignupPreview = {
    blueprint: { key: built.bp.key, name: built.bp.name, version: built.bp.version, fromTemplate: built.fromTemplate },
    modules: [...CORE_MODULES, ...built.modules].map((k) => ({ key: k, label: moduleDef(k)?.label ?? k, autoAdded: built.autoAdded.includes(k) })),
    steps: plan.steps
      .filter((s) => s.action !== "UNCHANGED")
      .map((s) => ({ kind: s.kind, kindLabel: BLUEPRINT_ITEM_KIND_LABEL[s.kind], key: s.key, label: s.label, action: s.action, reason: s.reason })),
    counts: plan.counts,
    dropped: built.dropped,
    issues: [...plan.issues.map((i) => i.message), ...plan.steps.filter((s) => s.action === "BLOCKED").map((s) => `${s.label}: ${s.reason ?? "bị chặn"}`)],
    plan: { key: resolved?.key ?? planKey, name: resolved?.name ?? planKey, over },
    ok: plan.ok && over.length === 0,
  };
  return { built, preview };
}

/** Bước Xem trước. `draft` KHÔNG cần mật khẩu. */
export async function previewSignup(input: { invite?: unknown; orgCode?: unknown; plan: unknown; planKey?: unknown }, who: SignupActor): Promise<{ ok: true; preview: SignupPreview } | { error: string }> {
  const g = await gate(who);
  if (!g.ok) return { error: g.error };
  let invite: InviteRow | null = null;
  if (g.mode === "invite") {
    const inv = typeof input.invite === "string" ? await lookupInvite(input.invite, typeof input.orgCode === "string" ? input.orgCode : null) : null;
    if (!inv?.ok) return { error: inv && !inv.ok ? inv.error : "Thiếu mã mời." };
    invite = inv.invite;
  }
  const parsed = planStepZ.safeParse(input.plan);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const r = await buildPreview(parsed.data, await planFor(who, invite, typeof input.planKey === "string" ? input.planKey : null));
  return "error" in r ? r : { ok: true, preview: r.preview };
}

// ═══ TẠO ═══

export type CreateResult =
  | { ok: true; orgCode: string; created: boolean; loggedIn: boolean; installId: string | null }
  | { error: string; orgCode?: string; setupFailed?: boolean };

/**
 * Phiên của quản trị đầu tiên — người ĐỨNG TÊN lượt cài mẫu. Dùng chung cho bước INSTALL ở đây và bước TEMPLATE của job «Tạo
 * khách» (lib/saas/provisioning-template.ts): một mẫu, một bộ cài, một người đứng tên — không dựng phiên thứ hai.
 */
export async function adminSessionUser(orgCode: string, orgName: string, email: string): Promise<SessionUser | null> {
  return withOrganization(orgCode, async () => {
    const db = await getDb();
    const u = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
    if (!u || u.role !== "ADMIN" || !u.active) return null;
    invalidateCapabilities(orgCode);
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: "ADMIN",
      permissions: resolvePermissions("ADMIN", null),
      scope: "ALL",
      departmentCodes: [],
      positionId: null,
      organization: { code: orgCode, name: orgName, isHome: false },
      modules: [...(await getEnabledModules(orgCode))],
    } satisfies SessionUser;
  });
}

async function tenantUserCount(orgCode: string): Promise<number> {
  return withOrganization(orgCode, async () => {
    const db = await getDb();
    const rows = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
    return rows.length;
  });
}

type SetupInput = {
  code: string;
  name: string;
  planKey: string;
  built: SignupBlueprint;
  admin: { name: string; email: string; password: string } | null;
  adminEmail: string;
  source: OnboardingState["source"];
  inviteId: string | null;
  who: SignupActor;
  isNew: boolean;
  /** Thương hiệu nơi khách tự đăng ký (0215) — chỉ có nghĩa ở lượt TẠO; chạy lại truyền `null` và dòng cũ giữ nguyên. */
  brand: "vnx" | "chotdon" | null;
};

/**
 * Các bước GHI của lượt dựng — dùng chung cho lượt đầu và lượt chạy lại. Ném ⇒ người gọi đánh dấu `SETUP_FAILED`.
 * Trả mã lượt cài blueprint.
 */
async function runSetup(input: SetupInput, step: { current: SetupStepName }): Promise<string | null> {
  const actor = platformActorOf(input.who);
  const source = "UI" as const;
  step.current = "PROVISION";
  await provisionOrganization({ code: input.code, name: input.name, templateKey: input.built.fromTemplate, plan: input.planKey, brand: input.brand, modules: CORE_MODULES, source, actor });
  // Vòng đời pilot (docs/platform/pilot-operations.md): tổ chức MỚI của luồng này bắt đầu ở «Vừa tạo». Chỉ ghi khi chưa
  // có giai đoạn — chạy lại sau hỏng không đè giai đoạn người vận hành đã đổi.
  if (input.isNew) await markPilotCreated(input.code, actor, source);
  // Hành trình tự phục vụ (0180): tổ chức mới là NHÁP tới khi chủ tổ chức tự bấm Xuất bản ở /setup — ERP của họ chính là
  // bản xem trước. Không đè trạng thái đã có (chạy lại sau hỏng).
  await markOrganizationDraft(input.code);
  // THU PHÍ + DÙNG THỬ (lib/billing/service.ts::initWorkspaceBilling — CÙNG dịch vụ với bước BILLING của cấp phát người vận hành):
  // ghim phiên bản giá hiện hành, chụp số ngày dùng thử của PHIÊN BẢN (V1 = 7 ngày) vào thuê bao. Chỉ cửa hàng TỰ ĐĂNG KÝ qua cửa
  // mở mới bật thu phí (khoá chỉ xem khi quá hạn). Lỗi ghi sổ thuê bao KHÔNG làm hỏng lượt dựng — tổ chức chỉ ở «Chưa thu phí»
  // như trước, người vận hành thấy ở /platform.
  if (input.isNew) {
    try {
      await initWorkspaceBilling(input.code, { selfService: input.source === "OPEN", actor, reason: input.source === "OPEN" ? "Cửa hàng tự đăng ký" : "Khách mời / người vận hành dựng qua /start" });
    } catch (error) {
      console.warn(`[onboarding] chưa khởi tạo được thu phí / dùng thử cho ${input.code}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const prev = await readOnboarding(input.code);
  await claimRunning(input.code, {
    ...prev,
    state: "RUNNING",
    source: input.source,
    inviteId: input.inviteId,
    templateKey: input.built.fromTemplate,
    blueprintKey: input.built.bp.key,
    modules: input.built.modules,
    adminEmail: input.adminEmail,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    failedStep: null,
    error: null,
    installId: prev?.installId ?? null,
    runs: (prev?.runs ?? 0) + 1,
  } as OnboardingState);
  // CSDL của một mã tổ chức MỚI phải rỗng: thư mục / CSDL còn sót của một tổ chức đã bị xoá tay không được thành
  // dữ liệu của khách mới.
  if (input.isNew && (await tenantUserCount(input.code)) > 0) throw new Error("CSDL của mã tổ chức này đã có dữ liệu từ trước — không dựng đè. Người vận hành cần kiểm tra.");
  faultHook?.("PROVISION");

  step.current = "ADMIN";
  if (input.admin) {
    await provisionOrganization({ code: input.code, name: input.name, templateKey: input.built.fromTemplate, plan: input.planKey, modules: CORE_MODULES, admin: input.admin, source, actor });
  }
  const org = await findOrganization(input.code);
  const subject = await adminSessionUser(input.code, org?.name ?? input.name, input.adminEmail);
  if (!subject) throw new Error("Chưa có tài khoản quản trị đang hoạt động trong tổ chức — chạy lại qua /start với cùng mã tổ chức (khách: cùng mã mời) để tạo quản trị.");
  faultHook?.("ADMIN");

  step.current = "INSTALL";
  const result = await withOrganization(input.code, () => installBlueprint(input.built.bp, subject));
  if (!result.ok) throw new Error(`Cài «${input.built.bp.name}» hỏng: ${result.errors.map((e) => e.message).join(" · ")}`);
  faultHook?.("INSTALL");

  // THUÊ BAO SẢN PHẨM (F-02 · kiểm vỏ khách 08/10/2026): `provisionOrganization` ở bước PROVISION chỉ thấy module lõi nên không
  // mở được thuê bao nào; mẫu vừa cài mới bật `ai_sales` / module ERP. Chạy cả ở lượt chạy lại (idempotent) — không làm hỏng lượt dựng.
  await openSetupSubscriptions(input);

  step.current = "FINISH";
  await withOrganization(input.code, () =>
    audit({
      userId: input.who.kind === "operator" ? null : subject.id,
      userEmail: input.who.kind === "operator" ? `${input.who.actor.email} (vận hành nền tảng · ${input.who.actor.orgCode})` : subject.email,
      action: "ORG_ONBOARDED",
      entity: "ORGANIZATION",
      entityId: input.code,
      // Phiên bản văn bản người đăng ký đã đồng ý (dòng «Bằng việc tạo cửa hàng, bạn đồng ý…» ngay trên nút tạo).
      after: { blueprint: input.built.bp.key, template: input.built.fromTemplate, modules: input.built.modules, plan: input.planKey, installId: result.installId, acceptedTerms: input.who.kind === "public" ? { terms: TERMS_OF_SERVICE.version, privacy: PRIVACY_POLICY.version } : null },
    }),
  );
  faultHook?.("FINISH");
  return result.installId;
}

async function markFailed(code: string, stepName: SetupStepName, message: string, who: SignupActor) {
  await writeOnboarding(code, { state: "FAILED", failedStep: stepName, error: message.slice(0, 500), finishedAt: new Date().toISOString() }, "SETUP_FAILED");
  await platformAudit({ action: "ORG_STATUS", targetOrgCode: code, subject: code, before: { status: "ACTIVE" }, after: { status: "SETUP_FAILED", step: stepName }, reason: message.slice(0, 500), source: "UI", actor: platformActorOf(who) });
}

async function markDone(code: string, installId: string | null, who: SignupActor) {
  await writeOnboarding(code, { state: "DONE", installId, finishedAt: new Date().toISOString(), failedStep: null, error: null }, "ACTIVE");
  await platformAudit({ action: "ORG_SETUP", targetOrgCode: code, subject: code, after: { state: "DONE", installId }, source: "UI", actor: platformActorOf(who) });
  // Cài mẫu xong ⇒ «Vừa tạo» → «Đang cấu hình». Tổ chức không ở «Vừa tạo» (cũ, hoặc người vận hành đã đổi) thì không đụng.
  await markPilotConfigured(code, platformActorOf(who), "UI");
}

/** Đưa tổ chức `SETUP_FAILED` về `ACTIVE` trước khi chạy lại: `withOrganization` chỉ vào được tổ chức đang chạy. */
async function reactivateForRetry(code: string) {
  const pdb = await getPlatformDb();
  await pdb.update(schema.platformOrganizations).set({ status: "ACTIVE" }).where(eq(schema.platformOrganizations.code, code));
  invalidateOrganizations();
}

/**
 * Tạo tổ chức từ bản nháp. `issue` = ghi phiên cho quản trị vừa tạo (khách); bỏ trống ⇒ không đăng nhập (người vận
 * hành tạo hộ, hoặc bài kiểm muốn tự đăng nhập).
 *
 * `brand` = thương hiệu của host khách đang đứng khi bấm tạo (tầng action đọc `hostBrand()` rồi truyền vào — service không
 * đọc header). Người vận hành tạo hộ ⇒ KHÔNG ghi: host của người vận hành không nói gì về khách.
 */
export async function createOrganizationFromSignup(rawDraft: unknown, who: SignupActor, opts: { issue?: (subject: SessionSubject) => Promise<void>; brand?: "vnx" | "chotdon" | null } = {}): Promise<CreateResult> {
  const g = await gate(who);
  if (!g.ok) return { error: g.error };
  const parsed = signupDraftZ.safeParse(rawDraft);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const draft = parsed.data;
  const code = draft.org.code;
  if (await reservedCode(code)) return { error: "Mã này dành riêng cho nền tảng — chọn mã khác." };

  // Trần (khách): kiểm TRƯỚC mọi việc nặng.
  if (g.mode !== "operator") {
    const rate = await checkSignupRate(g.mode, g.ipHash, { creating: true });
    if (!rate.ok) {
      await recordAttempt({ mode: g.mode, ipHash: g.ipHash, orgCode: code, outcome: "REJECTED", reason: "RATE" });
      return { error: rate.error };
    }
  }

  // Mã mời (khách, chế độ invite): mã dùng được, hoặc đã gắn đúng tổ chức này từ lượt trước.
  let invite: InviteRow | null = null;
  if (g.mode === "invite") {
    const inv = await lookupInvite(String(draft.invite ?? ""), code);
    if (!inv.ok) {
      await recordAttempt({ mode: g.mode, ipHash: g.ipHash, orgCode: code, outcome: "INVITE_REJECTED", reason: inv.reason });
      return { error: inv.error };
    }
    invite = inv.invite;
  }

  const planKey = await planFor(who, invite, draft.planKey);
  const pv = await buildPreview(draft.plan, planKey);
  if ("error" in pv) return pv;
  if (!pv.preview.ok) return { error: `Kế hoạch chưa cài được: ${[...pv.preview.issues, ...pv.preview.plan.over].join(" · ") || "có bước bị chặn"}` };

  // Mã tổ chức đã có: chỉ ĐÚNG chủ mới đi tiếp (chạy lại / gửi lại), còn lại là trùng.
  const existing = await findOrganization(code);
  const state = existing ? await readOnboarding(code) : null;
  const sameOwner = Boolean(existing && !existing.isHome && state && (who.kind === "operator" || (invite && state.inviteId === invite.id)));
  if (existing && !sameOwner) {
    if (g.mode === "open") await recordAttempt({ mode: g.mode, ipHash: g.ipHash, orgCode: code, outcome: "REJECTED", reason: "CODE_TAKEN" });
    return { error: "Mã tổ chức này đã có người dùng — chọn mã khác." };
  }

  const loginInto = async (): Promise<boolean> => {
    if (!opts.issue) return false;
    const v = await verifyLogin({ email: draft.admin.email, password: draft.admin.password, orgCode: code }, opts.issue);
    return v.ok;
  };

  if (existing && (existing.status === "SUSPENDED" || existing.status === "ARCHIVED")) return { error: "Tổ chức này đang bị đình chỉ / lưu trữ — liên hệ người vận hành nền tảng." };
  if (existing && state) {
    if (state.state === "DONE") {
      // Gửi lại sau khi đã xong: không ghi gì. Khách chỉ được phiên nếu mật khẩu KHỚP tài khoản đã tạo.
      if (who.kind === "public" && state.adminEmail !== draft.admin.email) return { error: "Tổ chức này đã được tạo với một email quản trị khác — đăng nhập ở màn Đăng nhập." };
      const loggedIn = await loginInto();
      if (who.kind === "public" && opts.issue && !loggedIn) return { error: "Tổ chức đã được tạo. Mật khẩu không khớp tài khoản quản trị — đăng nhập ở màn Đăng nhập." };
      return { ok: true, orgCode: code, created: false, loggedIn, installId: state.installId };
    }
    if (state.state === "RUNNING" && Date.now() - new Date(state.startedAt).getTime() < RUNNING_STALE_MS) {
      return { error: "Tổ chức đang được dựng — đợi vài giây rồi thử lại." };
    }
    if (who.kind === "public" && state.adminEmail !== draft.admin.email) return { error: "Lượt chạy lại phải dùng đúng email quản trị của lượt đầu." };
  }

  // Giữ mã mời cho mã tổ chức này (một câu điều kiện — hai lượt đua thì một lượt thua).
  if (invite && !(await claimInvite(invite.id, code))) {
    await recordAttempt({ mode: g.mode, ipHash: g.ipHash, orgCode: code, outcome: "INVITE_REJECTED", reason: "CLAIM_LOST" });
    return { error: "Mã mời vừa được dùng cho tổ chức khác." };
  }

  if (existing?.status === "SETUP_FAILED") await reactivateForRetry(code);

  const step: { current: SetupStepName } = { current: "PROVISION" };
  let installId: string | null = null;
  try {
    installId = await runSetup(
      {
        code,
        name: draft.org.name,
        planKey,
        built: pv.built,
        admin: { name: draft.admin.name, email: draft.admin.email, password: draft.admin.password },
        adminEmail: draft.admin.email,
        source: who.kind === "operator" ? "OPERATOR" : g.mode === "invite" ? "INVITE" : "OPEN",
        inviteId: invite?.id ?? null,
        who,
        isNew: !existing,
        brand: who.kind === "operator" ? null : (opts.brand ?? null),
      },
      step,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SetupBusyError) return { error: message, orgCode: code };
    if (await findOrganization(code)) await markFailed(code, step.current, message, who);
    await recordAttempt({ mode: g.mode, ipHash: g.ipHash, orgCode: code, outcome: "FAILED", reason: `${step.current}: ${message}` });
    console.warn(`[onboarding] dựng tổ chức ${code} hỏng ở ${step.current}: ${message}`);
    return { error: `Dựng tổ chức hỏng ở bước ${step.current}. Tổ chức được giữ ở trạng thái «Dựng hỏng» và người vận hành nền tảng đã thấy nó — không có dữ liệu nào bị xoá.`, orgCode: code, setupFailed: true };
  }
  await markDone(code, installId, who);
  await recordAttempt({ mode: g.mode, ipHash: g.ipHash, orgCode: code, outcome: "CREATED" });
  // Khách: vào thẳng ERP mới qua ĐÚNG đường đăng nhập (kiểm mật khẩu, ký phiên mang `org`, ghi nhật ký LOGIN).
  const loggedIn = await loginInto();
  return { ok: true, orgCode: code, created: !existing, loggedIn, installId };
}

/** Người vận hành chạy lại một tổ chức `SETUP_FAILED` từ `/platform` — cùng các bước, không tạo quản trị mới. */
export async function retryOrganizationSetup(code: string, who: Extract<SignupActor, { kind: "operator" }>): Promise<CreateResult> {
  const org = await findOrganization(code);
  if (!org || org.isHome) return { error: `Không có tổ chức "${code}".` };
  if (org.status === "SUSPENDED" || org.status === "ARCHIVED") return { error: "Tổ chức đang bị đình chỉ / lưu trữ — mở lại trước khi chạy lại việc dựng." };
  const state = await readOnboarding(code);
  if (!state) return { error: "Tổ chức này không được dựng bằng luồng tự phục vụ — không có gì để chạy lại." };
  if (state.state === "DONE" && org.status === "ACTIVE") return { ok: true, orgCode: code, created: false, loggedIn: false, installId: state.installId };
  if (state.state === "RUNNING" && Date.now() - new Date(state.startedAt).getTime() < RUNNING_STALE_MS) return { error: "Tổ chức đang được dựng — đợi vài giây." };
  const built = buildSignupBlueprint({ businessType: "blank", templateKey: state.templateKey, modules: state.modules });
  if ("error" in built) return built;
  if (org.status === "SETUP_FAILED") await reactivateForRetry(code);
  const step: { current: SetupStepName } = { current: "PROVISION" };
  let installId: string | null = null;
  try {
    installId = await runSetup({ code, name: org.name, planKey: org.plan ?? DEFAULT_PLAN_KEY, built, admin: null, adminEmail: state.adminEmail, source: state.source, inviteId: state.inviteId, who, isNew: false, brand: null }, step);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SetupBusyError) return { error: message, orgCode: code };
    await markFailed(code, step.current, message, who);
    return { error: `Chạy lại vẫn hỏng ở bước ${step.current}: ${message}`, orgCode: code, setupFailed: true };
  }
  await markDone(code, installId, who);
  return { ok: true, orgCode: code, created: false, loggedIn: false, installId };
}

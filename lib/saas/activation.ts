/**
 * ═══════════ KÍCH HOẠT QUẢN TRỊ KHÁCH — CHỈ MÁY CHỦ, SAU CỔNG NGƯỜI VẬN HÀNH (docs/saas/PROVISIONING.md) ═══════════
 *
 * Job cấp phát tạo quản trị khách với mật khẩu NGẪU NHIÊN không ai biết; quản trị vào được lần đầu chỉ bằng liên kết đặt mật khẩu
 * dùng một lần (24 giờ) — liên kết ấy in ĐÚNG MỘT LẦN trong khung kết quả của form «Tạo khách». Trang khách
 * (`/platform/customers/<mã>`) phải trả lời «quản trị đã vào được chưa, liên kết còn hạn không» từ DỮ LIỆU THẬT trong CSDL
 * workspace: dòng `users` (khoá · lần đăng nhập) + `password_reset_tokens` (chỉ băm — không mã thô nào ở đây).
 *
 * Ai là «quản trị khách»: email mà job «Tạo khách» ĐÃ tạo (job có bước ADMIN xong — lượt «Tạo khách» sau trên workspace đã có
 * đều bị từ chối trước bước đó); workspace không qua job (tự đăng ký, tạo trước 0224) ⇒ quản trị ADMIN tạo SỚM NHẤT. Xác định,
 * không đoán: email UNIQUE trong CSDL tổ chức.
 *
 * Mọi hàm đọc ở đây nhìn sang CSDL workspace khác — chỉ gọi SAU `platformOperatorDenial` (lib/saas/console.ts), hoặc SAU lá chắn sổ
 * khai nghiệm thu (lib/saas/acceptance.ts — máy, chỉ workspace thử trong `lib/constants/saas-acceptance.ts`).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb, getPlatformDb, schema } from "@/db";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";

export const ACTIVATION_STATES = ["ACTIVATED", "PENDING", "EXPIRED", "NO_LINK", "NO_ADMIN", "DISABLED", "ORG_INACTIVE", "UNKNOWN"] as const;
export type ActivationState = (typeof ACTIVATION_STATES)[number];

/** Gửi lại được khi quản trị CHƯA vào được: liên kết còn hạn (khách báo không nhận được) · đã hết hạn · không còn liên kết dùng được. */
export const ACTIVATION_RESENDABLE: readonly ActivationState[] = ["PENDING", "EXPIRED", "NO_LINK"];

/** Vì sao KHÔNG gửi lại — mỗi trạng thái một lối ra cho người vận hành. */
const RESEND_REFUSAL: Record<ActivationState, string> = {
  ACTIVATED: "Quản trị đã kích hoạt — liên kết mới lúc này là liên kết ĐẶT LẠI mật khẩu: dùng «Đặt lại mật khẩu cho khách» ở trang workspace (Sức khoẻ · module · kết nối).",
  NO_ADMIN: "Workspace chưa có tài khoản quản trị — chạy lại job cấp phát (khung «Job cấp phát») trước.",
  DISABLED: "Tài khoản quản trị đang khoá — mở khoá trước rồi mới gửi kích hoạt.",
  ORG_INACTIVE: "Workspace không ở trạng thái hoạt động — không gửi kích hoạt.",
  UNKNOWN: "Chưa đọc được trạng thái kích hoạt (CSDL workspace không mở được) — thử lại sau.",
  PENDING: "",
  EXPIRED: "",
  NO_LINK: "",
};

export function activationRefusal(state: ActivationState): string {
  return RESEND_REFUSAL[state] || "Không gửi lại được liên kết kích hoạt lúc này.";
}

export type AdminActivation = {
  orgCode: string;
  /** Email quản trị khách; `null` = không xác định được (workspace chưa có quản trị nào). */
  email: string | null;
  /** `JOB` = email job «Tạo khách» đã tạo · `FIRST_ADMIN` = quản trị ADMIN tạo sớm nhất (workspace không qua job). */
  source: "JOB" | "FIRST_ADMIN" | null;
  state: ActivationState;
  /** ISO — bằng chứng vào được SỚM NHẤT: lần dùng liên kết hoặc lần đăng nhập ghi trên tài khoản. */
  activatedAt: string | null;
  /** ISO — PENDING: liên kết hiện hành hết hạn lúc · EXPIRED: đã hết lúc. */
  linkExpiresAt: string | null;
  /** ISO — lúc phát liên kết gần nhất (mọi đường: job, gửi lại, người vận hành, quản trị tổ chức). */
  lastLinkAt: string | null;
  canResend: boolean;
};

export type ActivationTokenFacts = { createdAt: Date; expiresAt: Date; usedAt: Date | null; revokedAt: Date | null };
export type ActivationAdminFacts = { active: boolean; lastLoginAt: Date | null };

/**
 * THUẦN. Thứ tự là luật: không có tài khoản ⇒ NO_ADMIN; khoá ⇒ DISABLED (đăng nhập không mở được dù có gì); đã có bằng chứng
 * vào được ⇒ ACTIVATED; còn lại xét liên kết MỚI NHẤT (phát liên kết mới thu hồi liên kết cũ chưa dùng): bị thu hồi / không có ⇒
 * NO_LINK, còn hạn ⇒ PENDING, quá hạn ⇒ EXPIRED.
 */
export function activationStateOf(admin: ActivationAdminFacts | null, tokens: readonly ActivationTokenFacts[], now: Date): Pick<AdminActivation, "state" | "activatedAt" | "linkExpiresAt" | "lastLinkAt"> {
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  if (!admin) return { state: "NO_ADMIN", activatedAt: null, linkExpiresAt: null, lastLinkAt: null };
  const latest = tokens.reduce<ActivationTokenFacts | null>((a, t) => (!a || t.createdAt.getTime() > a.createdAt.getTime() ? t : a), null);
  const evidence = [...tokens.flatMap((t) => (t.usedAt ? [t.usedAt.getTime()] : [])), ...(admin.lastLoginAt ? [admin.lastLoginAt.getTime()] : [])];
  const activatedAt = evidence.length ? new Date(Math.min(...evidence)) : null;
  const lastLinkAt = iso(latest?.createdAt);
  if (!admin.active) return { state: "DISABLED", activatedAt: iso(activatedAt), linkExpiresAt: null, lastLinkAt };
  if (activatedAt) return { state: "ACTIVATED", activatedAt: iso(activatedAt), linkExpiresAt: null, lastLinkAt };
  if (!latest || latest.revokedAt) return { state: "NO_LINK", activatedAt: null, linkExpiresAt: null, lastLinkAt };
  return { state: latest.expiresAt.getTime() > now.getTime() ? "PENDING" : "EXPIRED", activatedAt: null, linkExpiresAt: iso(latest.expiresAt), lastLinkAt };
}

type JobFacts = { orgCode: string | null; input: unknown; steps: unknown; createdAt: Date };

function jobAdminEmailOf(job: JobFacts): string | null {
  const admin = (job.input as { admin?: { email?: unknown } } | null)?.admin;
  return typeof admin?.email === "string" && admin.email.trim() ? admin.email.trim().toLowerCase() : null;
}

function jobCreatedAdmin(job: JobFacts): boolean {
  return Array.isArray(job.steps) && job.steps.some((s) => Boolean(s) && typeof s === "object" && (s as { key?: unknown }).key === "ADMIN" && (s as { status?: unknown }).status === "DONE");
}

/**
 * THUẦN. Email quản trị của workspace theo job «Tạo khách»: job SỚM NHẤT có bước ADMIN xong. `fallback` = email của job sớm nhất
 * (job hỏng trước bước ADMIN) — chỉ để hiện, KHÔNG dùng để tra khi CSDL có quản trị khác (workspace tự đăng ký mà ai đó từng thử
 * «Tạo khách» trùng mã: job ấy bị từ chối ở bước WORKSPACE).
 */
export function jobAdminEmail(jobs: readonly JobFacts[], orgCode: string): { created: string | null; fallback: string | null } {
  const mine = jobs.filter((j) => j.orgCode === orgCode).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const creator = mine.find(jobCreatedAdmin);
  return { created: creator ? jobAdminEmailOf(creator) : null, fallback: mine.length ? jobAdminEmailOf(mine[0]) : null };
}

type WorkspaceFacts = { code: string; status: string; isHome: boolean };

async function activationOf(w: WorkspaceFacts, jobs: readonly JobFacts[], now: Date): Promise<AdminActivation> {
  const fromJob = jobAdminEmail(jobs, w.code);
  const blank = { activatedAt: null, linkExpiresAt: null, lastLinkAt: null, canResend: false } as const;
  if (w.status !== "ACTIVE") return { orgCode: w.code, email: fromJob.created ?? fromJob.fallback, source: fromJob.created || fromJob.fallback ? "JOB" : null, state: "ORG_INACTIVE", ...blank };
  try {
    return await withOrganization(w.code, async () => {
      const db = await getDb();
      const u = schema.users;
      const cols = { id: u.id, email: u.email, active: u.active, lastLoginAt: u.lastLoginAt };
      const [admin] = fromJob.created
        ? await db.select(cols).from(u).where(eq(u.email, fromJob.created)).limit(1)
        : await db.select(cols).from(u).where(eq(u.role, "ADMIN")).orderBy(asc(u.createdAt), asc(u.id)).limit(1);
      const t = schema.passwordResetTokens;
      const tokens = admin ? await db.select({ createdAt: t.createdAt, expiresAt: t.expiresAt, usedAt: t.usedAt, revokedAt: t.revokedAt }).from(t).where(eq(t.userId, admin.id)) : [];
      const facts = activationStateOf(admin ? { active: admin.active, lastLoginAt: admin.lastLoginAt } : null, tokens, now);
      const email = admin?.email ?? fromJob.created ?? fromJob.fallback;
      return { orgCode: w.code, email, source: fromJob.created ? "JOB" : admin ? "FIRST_ADMIN" : email ? "JOB" : null, ...facts, canResend: ACTIVATION_RESENDABLE.includes(facts.state) && Boolean(admin) };
    });
  } catch (error) {
    // CHƯA BIẾT không phải «chưa kích hoạt» (AGENTS 42): CSDL workspace không mở được thì nói đúng như vậy, không đoán.
    console.warn(`[activation] không đọc được trạng thái kích hoạt của ${w.code}: ${error instanceof Error ? error.message : String(error)}`);
    return { orgCode: w.code, email: fromJob.created ?? fromJob.fallback, source: null, state: "UNKNOWN", ...blank };
  }
}

/** Trạng thái kích hoạt của quản trị từng workspace; workspace NHÀ ⇒ `null` (người nhà không «kích hoạt» qua đây). */
export async function loadAdminActivations(workspaces: readonly WorkspaceFacts[], now: Date = new Date()): Promise<Record<string, AdminActivation | null>> {
  const out: Record<string, AdminActivation | null> = {};
  const codes = workspaces.filter((w) => !w.isHome).map((w) => w.code);
  let jobs: JobFacts[] = [];
  if (codes.length) {
    const pdb = await getPlatformDb();
    const j = schema.platformProvisioningJobs;
    jobs = await pdb.select({ orgCode: j.orgCode, input: j.input, steps: j.steps, createdAt: j.createdAt }).from(j).where(and(eq(j.kind, "CREATE_CUSTOMER"), inArray(j.orgCode, codes)));
  }
  for (const w of workspaces) out[w.code] = w.isHome ? null : await activationOf(w, jobs, now);
  return out;
}

/** Một workspace theo mã; không có / là nhà ⇒ `null`. */
export async function loadWorkspaceActivation(orgCode: string, now: Date = new Date()): Promise<AdminActivation | null> {
  const org = await findOrganization(orgCode);
  if (!org || org.isHome) return null;
  return (await loadAdminActivations([org], now))[org.code] ?? null;
}

/** Liên kết kích hoạt vừa phát — trả về người gọi MỘT lần (chưa có kênh thư). */
export type ResendActivationResult = { ok: true; link: string; expiresAt: string; email: string; message: string };

/**
 * Đường PHÁT liên kết của người gọi: người vận hành (`createResetLinkAsOperator` — đã qua `platformOperatorDenial`) hoặc máy nghiệm thu
 * (`createAcceptanceResetLink` — chỉ tiến trình ops, đúng cặp mã + email của sổ khai, workspace đúng do ops tạo). Cả hai đi chung MỘT lõi trong
 * lib/users/password-reset.ts; chỉ khác người đứng tên trong nhật ký nền tảng.
 */
export type ActivationLinkIssuer = (input: { orgCode: string; email: string; reason: string }) => Promise<{ ok: true; link: string; expiresAt: Date; email: string } | { error: string }>;

/**
 * LUẬT «GỬI LẠI KÍCH HOẠT» — MỘT bản cho nút của người vận hành (lib/saas/console.ts, SAU `platformOperatorDenial`) và ops nghiệm thu
 * (lib/saas/acceptance.ts, SAU lá chắn sổ khai + kiểm sở hữu — máy): chỉ khi quản trị CHƯA vào được; người nhận do MÁY CHỦ tra (job «Tạo khách» /
 * quản trị đầu tiên), không bao giờ một email từ người gọi; liên kết phát qua `issue` của chính người gọi. tests/saas-acceptance.test.ts
 * khoá danh sách nơi gọi hàm này.
 */
export async function resendActivation(input: { orgCode: string; reason: string }, issue: ActivationLinkIssuer): Promise<ResendActivationResult | { error: string }> {
  const act = await loadWorkspaceActivation(input.orgCode);
  if (!act) return { error: "Chỉ gửi kích hoạt cho quản trị của một workspace khách." };
  if (!act.canResend || !act.email) return { error: activationRefusal(act.state) };
  const r = await issue({ orgCode: act.orgCode, email: act.email, reason: `Gửi lại liên kết kích hoạt: ${input.reason}` });
  if ("error" in r) return r;
  return { ok: true, link: r.link, expiresAt: r.expiresAt.toISOString(), email: r.email, message: "Đã tạo liên kết kích hoạt mới — liên kết cũ chưa dùng hết hiệu lực." };
}

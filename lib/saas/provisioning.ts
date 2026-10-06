/**
 * ═══════════ BỘ MÁY CẤP PHÁT — CHỈ MÁY CHỦ (docs/saas/PROVISIONING.md) ═══════════
 *
 *   Account → Workspace → Subscription → Entitlements (module) → Admin → ready
 *
 * Mỗi yêu cầu là MỘT dòng `platform_provisioning_jobs` có khoá idempotent: gửi lại cùng khoá ⇒ trả job cũ (đã xong thì
 * không chạy lại); job FAILED chạy lại được và mọi bước tự idempotent (cấp workspace dùng `provisionOrganization` — đã
 * idempotent từ Phase 1; module dùng `setOrganizationModule` — kiểm phụ thuộc + nhật ký). Không bước nào đòi người vận hành
 * sửa CSDL tay; không bước nào ghi bí mật vào job (mật khẩu quản trị là ngẫu nhiên, không lưu, không trả — quản trị nhận
 * liên kết kích hoạt dùng một lần do server action tạo SAU khi job xong).
 */
import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { platformAudit, type PlatformActor } from "@/lib/platform/audit";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { setOrganizationModule } from "@/lib/platform/module-config";
import { findOrganization, getHomeOrganization } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { ORGANIZATION_CODE_PATTERN } from "@/lib/platform/types";
import { accountOfWorkspace, createAccount, findAccountByCode, findAccountById, insertSubscription, liveSubscriptions, setSubscriptionState, type SaasSource } from "@/lib/saas/accounts";
import { PRODUCTS, SHARED_COMMERCE_CORE, modulesToProvision, productDef, type ProductDef } from "@/lib/saas/catalog";
import { readPlans } from "@/lib/saas/customers";
import { ACCOUNT_TYPES, BILLING_MODES, type AccountType, type BillingMode } from "@/lib/saas/policy";

export type ProvisioningKind = "CREATE_CUSTOMER" | "SUBSCRIBE_PRODUCT" | "CANCEL_SUBSCRIPTION";
export type JobStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
export type JobStep = { key: string; status: "DONE" | "SKIPPED" | "FAILED"; at: string; detail: string | null };
export type JobRow = typeof schema.platformProvisioningJobs.$inferSelect;

export const JOB_STATUS_LABEL: Record<JobStatus, string> = { PENDING: "Chờ chạy", RUNNING: "Đang chạy", SUCCEEDED: "Xong", FAILED: "Hỏng — chạy lại được" };
export const JOB_KIND_LABEL: Record<ProvisioningKind, string> = { CREATE_CUSTOMER: "Tạo khách", SUBSCRIBE_PRODUCT: "Thuê sản phẩm", CANCEL_SUBSCRIPTION: "Huỷ thuê bao" };

/** Job RUNNING lâu hơn ngưỡng này coi như tiến trình đã chết giữa chừng — chạy lại được (mọi bước idempotent). */
export const STALE_RUNNING_MS = 10 * 60_000;

export type CreateCustomerRequest = {
  kind: "CREATE_CUSTOMER";
  /** Gắn vào tài khoản có sẵn (thêm workspace cho khách cũ) — bỏ trống thì tạo tài khoản mới. */
  accountId?: string | null;
  account?: { code?: string | null; name: string; accountType: AccountType; billingMode?: BillingMode | null; legalName?: string | null; taxCode?: string | null; billingEmail?: string | null };
  workspace: { code: string; name: string; planKey: string; brand?: "vnx" | "chotdon" | null };
  products: string[];
  admin: { email: string; name: string };
};
export type SubscribeRequest = { kind: "SUBSCRIBE_PRODUCT"; orgCode: string; productKey: string; planKey?: string | null };
export type CancelRequest = { kind: "CANCEL_SUBSCRIPTION"; subscriptionId: string; reason: string };
export type ProvisioningRequest = CreateCustomerRequest | SubscribeRequest | CancelRequest;

export type JobResult = { job: JobRow; reused: boolean };

type Ctx = { actor: PlatformActor; email: string | null; source: SaasSource; idempotencyKey: string; catalog?: readonly ProductDef[] };

class StepFailure extends Error {}

/** Kiểm đầu vào TRƯỚC khi ghi job — đầu vào sai không đáng một dòng FAILED. */
export async function validateRequest(req: ProvisioningRequest, catalog: readonly ProductDef[] = PRODUCTS): Promise<string | null> {
  if (req.kind === "CREATE_CUSTOMER") {
    if (!ORGANIZATION_CODE_PATTERN.test(req.workspace.code)) return `Mã workspace "${req.workspace.code}" không hợp lệ (chữ thường, số, gạch ngang; 2–31 ký tự).`;
    if (req.workspace.name.trim().length < 2) return "Tên workspace cần ít nhất 2 ký tự.";
    if (!req.products.length) return "Chọn ít nhất một sản phẩm.";
    for (const p of req.products) if (!productDef(p, catalog)) return `Sản phẩm "${p}" không có trong danh mục.`;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(req.admin.email.trim())) return "Email quản trị không hợp lệ.";
    if (!req.accountId && !req.account) return "Thiếu tài khoản khách (chọn có sẵn hoặc khai mới).";
    if (req.account && !(ACCOUNT_TYPES as readonly string[]).includes(req.account.accountType)) return "Loại tài khoản không hợp lệ.";
    if (req.account?.billingMode && !(BILLING_MODES as readonly string[]).includes(req.account.billingMode)) return "Cách lập chứng từ không hợp lệ.";
    const plan = (await readPlans()).find((p) => p.key === req.workspace.planKey);
    if (!plan) return `Gói "${req.workspace.planKey}" không có.`;
    const outside = req.products.filter((p) => plan.productKeys && !plan.productKeys.includes(p));
    if (outside.length) return `Gói «${plan.name}» không phủ sản phẩm: ${outside.join(", ")}.`;
    const existing = await findOrganization(req.workspace.code);
    if (existing?.isHome) return "Không cấp lại workspace nhà.";
    return null;
  }
  if (req.kind === "SUBSCRIBE_PRODUCT") {
    if (!productDef(req.productKey, catalog)) return `Sản phẩm "${req.productKey}" không có trong danh mục.`;
    const org = await findOrganization(req.orgCode);
    if (!org) return `Không có workspace "${req.orgCode}".`;
    if (req.planKey) {
      const plan = (await readPlans()).find((p) => p.key === req.planKey);
      if (!plan) return `Gói "${req.planKey}" không có.`;
      if (plan.productKeys && !plan.productKeys.includes(req.productKey)) return `Gói «${plan.name}» không phủ sản phẩm này.`;
    }
    return null;
  }
  if (req.reason.trim().length < 5) return "Huỷ thuê bao cần lý do (ít nhất 5 ký tự).";
  return null;
}

/** Gửi một yêu cầu cấp phát. Cùng khoá ⇒ cùng job; job đã xong không chạy lại; job hỏng / treo chạy lại. */
export async function requestProvisioning(req: ProvisioningRequest, ctx: Ctx): Promise<JobResult | { error: string }> {
  const invalid = await validateRequest(req, ctx.catalog);
  if (invalid) return { error: invalid };
  const key = ctx.idempotencyKey.trim();
  if (!key || key.length > 200) return { error: "Thiếu khoá idempotent (1–200 ký tự)." };
  const pdb = await getPlatformDb();
  const orgCode = req.kind === "CREATE_CUSTOMER" ? req.workspace.code : req.kind === "SUBSCRIBE_PRODUCT" ? req.orgCode : null;
  const productKey = req.kind === "SUBSCRIBE_PRODUCT" ? req.productKey : null;
  const inserted = await pdb
    .insert(schema.platformProvisioningJobs)
    .values({ kind: req.kind, idempotencyKey: key, accountId: req.kind === "CREATE_CUSTOMER" ? (req.accountId ?? null) : null, orgCode, productKey, input: req as unknown as Record<string, unknown>, status: "PENDING", requestedByEmail: ctx.email })
    .onConflictDoNothing()
    .returning();
  const job = inserted[0] ?? (await pdb.query.platformProvisioningJobs.findFirst({ where: eq(schema.platformProvisioningJobs.idempotencyKey, key) }));
  if (!job) return { error: "Không ghi / đọc được job cấp phát." };
  if (!inserted.length) {
    if (job.kind !== req.kind) return { error: `Khoá "${key}" đã dùng cho một yêu cầu loại khác.` };
    if (job.status === "SUCCEEDED") return { job, reused: true };
    if (job.status === "RUNNING" && job.startedAt && Date.now() - job.startedAt.getTime() < STALE_RUNNING_MS) return { job, reused: true };
  }
  return { job: await runJob(job, ctx), reused: !inserted.length };
}

/** Chạy lại một job FAILED / treo (nút «Chạy lại» của người vận hành). */
export async function retryJob(jobId: string, ctx: Omit<Ctx, "idempotencyKey">): Promise<JobRow | { error: string }> {
  const pdb = await getPlatformDb();
  const job = await pdb.query.platformProvisioningJobs.findFirst({ where: eq(schema.platformProvisioningJobs.id, jobId) });
  if (!job) return { error: "Không có job này." };
  if (job.status === "SUCCEEDED") return { error: "Job đã xong — không chạy lại." };
  if (job.status === "RUNNING" && job.startedAt && Date.now() - job.startedAt.getTime() < STALE_RUNNING_MS) return { error: "Job đang chạy — đợi xong hoặc quá 10 phút mới chạy lại." };
  return runJob(job, { ...ctx, idempotencyKey: job.idempotencyKey });
}

async function runJob(job: JobRow, ctx: Ctx): Promise<JobRow> {
  const pdb = await getPlatformDb();
  // Chiếm job bằng so-và-ghi: hai lượt cùng chạy một job thì chỉ một lượt thắng.
  const claimed = await pdb
    .update(schema.platformProvisioningJobs)
    .set({ status: "RUNNING", attempts: job.attempts + 1, startedAt: new Date(), lastError: null })
    .where(and(eq(schema.platformProvisioningJobs.id, job.id), eq(schema.platformProvisioningJobs.attempts, job.attempts)))
    .returning();
  if (!claimed.length) return (await pdb.query.platformProvisioningJobs.findFirst({ where: eq(schema.platformProvisioningJobs.id, job.id) })) ?? job;
  const steps: JobStep[] = [];
  const step = (key: string, status: JobStep["status"], detail: string | null = null) => steps.push({ key, status, at: new Date().toISOString(), detail });
  const req = job.input as unknown as ProvisioningRequest;
  const catalog = ctx.catalog ?? PRODUCTS;
  let accountId = job.accountId;
  let orgCode = job.orgCode;
  let error: string | null = null;
  try {
    if (req.kind === "CREATE_CUSTOMER") ({ accountId, orgCode } = await runCreateCustomer(req, ctx, step, accountId, catalog));
    else if (req.kind === "SUBSCRIBE_PRODUCT") accountId = await runSubscribe(req, ctx, step, catalog);
    else ({ accountId, orgCode } = await runCancel(req, ctx, step, catalog));
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    if (!(e instanceof StepFailure)) step("UNEXPECTED", "FAILED", error);
  }
  const [done] = await pdb
    .update(schema.platformProvisioningJobs)
    .set({ status: error ? "FAILED" : "SUCCEEDED", steps: [...((job.steps as JobStep[]) ?? []), ...steps], lastError: error, finishedAt: new Date(), accountId, orgCode })
    .where(eq(schema.platformProvisioningJobs.id, job.id))
    .returning();
  const home = await getHomeOrganization();
  await platformAudit({ action: "PROVISIONING_RUN", targetOrgCode: orgCode ?? home.code, targetAccountId: accountId, subject: `job:${job.kind}:${job.idempotencyKey}`, after: { status: done.status, attempt: done.attempts, steps: steps.map((s) => `${s.key}:${s.status}`) }, reason: error, source: ctx.source === "TEST" ? "TEST" : ctx.source === "OPERATOR" ? "UI" : "SCRIPT", actor: ctx.actor });
  return done;
}

type StepFn = (key: string, status: JobStep["status"], detail?: string | null) => void;

function fail(step: StepFn, key: string, message: string): never {
  step(key, "FAILED", message);
  throw new StepFailure(message);
}

async function runCreateCustomer(req: CreateCustomerRequest, ctx: Ctx, step: StepFn, knownAccountId: string | null, catalog: readonly ProductDef[]): Promise<{ accountId: string; orgCode: string }> {
  // 1. Tài khoản — lượt chạy lại dùng lại tài khoản lượt trước đã tạo (ghi trên job), không tạo tài khoản thứ hai.
  let account = knownAccountId ? await findAccountById(knownAccountId) : null;
  if (!account && req.account?.code) account = await findAccountByCode(req.account.code);
  if (!account && req.account) account = await createAccount({ ...req.account }, { actor: ctx.actor, source: ctx.source, reason: `Job cấp phát ${ctx.idempotencyKey}` });
  if (!account) fail(step, "ACCOUNT", "Không có tài khoản để gắn workspace.");
  step("ACCOUNT", "DONE", account.code);
  const pdb = await getPlatformDb();
  await pdb.update(schema.platformProvisioningJobs).set({ accountId: account.id }).where(eq(schema.platformProvisioningJobs.idempotencyKey, ctx.idempotencyKey));

  // 2. Workspace + CSDL + module + quản trị + tài khoản/thuê bao (provisionOrganization bước 1–6, idempotent).
  const existing = await findOrganization(req.workspace.code);
  if (existing) {
    const owner = await accountOfWorkspace(existing.code);
    if (owner && owner.id !== account.id) fail(step, "WORKSPACE", `Mã workspace "${existing.code}" đã thuộc tài khoản ${owner.code}.`);
  }
  const products = req.products.map((p) => productDef(p, catalog)!).filter(Boolean);
  const modules = [...new Set(products.flatMap((p) => modulesToProvision(p)))];
  const res = await provisionOrganization({
    code: req.workspace.code,
    name: req.workspace.name.trim(),
    plan: req.workspace.planKey,
    brand: req.workspace.brand ?? null,
    modules,
    admin: { email: req.admin.email.trim().toLowerCase(), name: req.admin.name.trim() || req.admin.email, password: randomBytes(24).toString("base64url") },
    accountId: account.id,
    source: ctx.source === "TEST" ? "TEST" : "UI",
    actor: ctx.actor,
  });
  step("WORKSPACE", "DONE", `${res.organization.code}${res.created ? " (mới)" : " (đã có)"} · ${modules.length} module`);
  step("ADMIN", "DONE", res.adminCreated ? `tạo ${req.admin.email.trim().toLowerCase()} — kích hoạt bằng liên kết dùng một lần` : "quản trị đã có");

  // 3. Thuê bao cho đúng sản phẩm đã chọn (provision đã mở theo module; bước này phủ phần còn thiếu, theo gói workspace).
  const live = new Set((await liveSubscriptions(res.organization.code)).map((s) => s.productKey));
  for (const p of products) {
    if (live.has(p.key)) continue;
    await insertSubscription({ accountId: account.id, orgCode: res.organization.code, productKey: p.key, planKey: null }, { actor: ctx.actor, source: ctx.source, reason: `Job cấp phát ${ctx.idempotencyKey}` });
  }
  step("SUBSCRIPTIONS", "DONE", products.map((p) => p.key).join(", "));
  step("BILLING", "SKIPPED", "điều khoản thu phí (hạn trả, ân hạn) đặt ở trang workspace — 0187; chargeback nội bộ không cần");
  return { accountId: account.id, orgCode: res.organization.code };
}

/** Bật module theo thứ tự phụ thuộc: lõi trước, module của sản phẩm sau. */
async function enableModules(orgCode: string, product: ProductDef, ctx: Ctx, step: StepFn) {
  const want = modulesToProvision(product);
  const ordered = [...SHARED_COMMERCE_CORE.filter((m) => want.includes(m)), ...want.filter((m) => !SHARED_COMMERCE_CORE.includes(m))];
  const enabled = await getEnabledModules(orgCode);
  const turnedOn: string[] = [];
  for (const m of ordered) {
    if (enabled.has(m)) continue;
    const r = await setOrganizationModule({ orgCode, moduleKey: m, enabled: true, reason: `Thuê sản phẩm ${product.key} (${ctx.idempotencyKey})`, actor: ctx.actor, source: ctx.source === "TEST" ? "TEST" : "UI" });
    if (!r.ok) fail(step, "MODULES", `Không bật được module ${m}: ${r.message}`);
    turnedOn.push(m);
  }
  invalidateCapabilities(orgCode);
  step("MODULES", turnedOn.length ? "DONE" : "SKIPPED", turnedOn.length ? `bật ${turnedOn.join(", ")}` : "đã bật đủ");
}

async function runSubscribe(req: SubscribeRequest, ctx: Ctx, step: StepFn, catalog: readonly ProductDef[]): Promise<string> {
  const account = await accountOfWorkspace(req.orgCode);
  if (!account) fail(step, "ACCOUNT", `Workspace "${req.orgCode}" chưa gắn tài khoản — gắn trước ở trang khách.`);
  step("ACCOUNT", "DONE", account.code);
  const product = productDef(req.productKey, catalog)!;
  await enableModules(req.orgCode, product, ctx, step);
  const live = (await liveSubscriptions(req.orgCode)).find((s) => s.productKey === product.key);
  if (live) step("SUBSCRIPTION", "SKIPPED", `đã có thuê bao ${live.state}`);
  else {
    await insertSubscription({ accountId: account.id, orgCode: req.orgCode, productKey: product.key, planKey: req.planKey ?? null }, { actor: ctx.actor, source: ctx.source, reason: `Job cấp phát ${ctx.idempotencyKey}` });
    step("SUBSCRIPTION", "DONE", req.planKey ? `gói ${req.planKey}` : "theo gói workspace");
  }
  return account.id;
}

/**
 * Huỷ = thu hồi QUYỀN DÙNG: thuê bao CANCELED rồi tắt module ĐỘC QUYỀN của sản phẩm (không xoá dữ liệu — bật lại là thấy
 * lại). Module mà sản phẩm khác còn cần (lõi thương mại) không bao giờ bị tắt ở đây.
 */
async function runCancel(req: CancelRequest, ctx: Ctx, step: StepFn, catalog: readonly ProductDef[]): Promise<{ accountId: string; orgCode: string }> {
  const pdb = await getPlatformDb();
  const sub = await pdb.query.platformProductSubscriptions.findFirst({ where: eq(schema.platformProductSubscriptions.id, req.subscriptionId) });
  if (!sub) fail(step, "SUBSCRIPTION", "Không có thuê bao này.");
  if (!sub.endedAt) await setSubscriptionState(sub.id, { state: "CANCELED" }, { actor: ctx.actor, source: ctx.source, reason: req.reason });
  step("SUBSCRIPTION", sub.endedAt ? "SKIPPED" : "DONE", sub.endedAt ? "đã huỷ từ trước" : "CANCELED");
  const product = productDef(sub.productKey, catalog);
  const stillLive = await pdb
    .select({ productKey: schema.platformProductSubscriptions.productKey })
    .from(schema.platformProductSubscriptions)
    .where(and(eq(schema.platformProductSubscriptions.orgCode, sub.orgCode), isNull(schema.platformProductSubscriptions.endedAt)));
  const neededElsewhere = new Set(stillLive.flatMap((s) => (productDef(s.productKey, catalog) ? modulesToProvision(productDef(s.productKey, catalog)!) : [])));
  const targets = (product?.exclusiveModules ?? []).filter((m) => !neededElsewhere.has(m));
  // Tắt theo vòng: module có module khác phụ thuộc bị từ chối ở vòng đầu, vòng sau thử lại khi phụ thuộc đã tắt.
  let pending = [...targets];
  const off: string[] = [];
  for (let round = 0; round < 6 && pending.length; round++) {
    const enabled = await getEnabledModules(sub.orgCode);
    pending = pending.filter((m) => enabled.has(m));
    const next: typeof pending = [];
    for (const m of pending) {
      const r = await setOrganizationModule({ orgCode: sub.orgCode, moduleKey: m, enabled: false, reason: `Huỷ thuê bao ${sub.productKey}: ${req.reason}`, actor: ctx.actor, source: ctx.source === "TEST" ? "TEST" : "UI" });
      if (r.ok) off.push(m);
      else next.push(m);
    }
    if (next.length === pending.length) break;
    pending = next;
    invalidateCapabilities(sub.orgCode);
  }
  invalidateCapabilities(sub.orgCode);
  const enabledNow = await getEnabledModules(sub.orgCode);
  const stuck = targets.filter((m) => enabledNow.has(m));
  if (stuck.length) fail(step, "MODULES", `Thuê bao đã huỷ nhưng còn module chưa tắt được (có module khác phụ thuộc): ${stuck.join(", ")} — tắt tay ở trang module rồi chạy lại.`);
  step("MODULES", off.length ? "DONE" : "SKIPPED", off.length ? `tắt ${off.join(", ")}` : "không còn module độc quyền nào bật");
  return { accountId: sub.accountId, orgCode: sub.orgCode };
}

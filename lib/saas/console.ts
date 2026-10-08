/**
 * ═══════════ OPERATOR CONSOLE — LÕI CÓ KIỂM QUYỀN (docs/saas/README.md §6) ═══════════
 *
 * Mọi hàm ở đây nhìn hoặc sửa XUYÊN tài khoản, nên hỏi `platformOperatorDenial` TRƯỚC mọi lượt đọc / ghi — kể cả khi trang
 * đã hỏi (ẩn menu không phải bảo mật; server action gọi được không cần trang). Quyền vận hành = `platform:operate` của người
 * thuộc workspace NHÀ (nơi mặt phẳng điều khiển sống) — TƯỜNG MINH, không suy ra từ loại tài khoản: một tài khoản khách
 * mang `account_type = INTERNAL` không vì thế mà nhìn được khách khác (tests/saas-platform.test.ts).
 */
import { z } from "zod";
import type { SessionUser } from "@/lib/auth/session";
import { createResetLinkAsOperator } from "@/lib/users/password-reset";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import type { PlatformActor } from "@/lib/platform/audit";
import { findAccountByCode, findAccountById, moveWorkspaceToAccount, openSubscriptionsForProductsInUse, productsInUse, setSubscriptionState, updateAccount, accountMergeCandidates } from "@/lib/saas/accounts";
import { activationRefusal, loadAdminActivations, loadWorkspaceActivation, type AdminActivation } from "@/lib/saas/activation";
import { finalizeStatement } from "@/lib/saas/billing";
import { PRODUCT_KEYS, productDef } from "@/lib/saas/catalog";
import { accountAuditTrail, accountProvisioningJobs, finalizedStatements, loadCommercialSnapshot, moduleDrift, productEconomics, workspaceReach, type CommercialSnapshot, type CustomerView } from "@/lib/saas/customers";
import { productEntitlement, type ProductEntitlement } from "@/lib/saas/entitlements";
import { COST_CATEGORIES, addCostEntry, listCostEntries, voidCostEntry } from "@/lib/saas/ledger";
import { ACCOUNT_STATUSES, ACCOUNT_TYPES, BILLING_MODES } from "@/lib/saas/policy";
import { requestProvisioning, retryJob, type CreateCustomerRequest, type JobRow } from "@/lib/saas/provisioning";
import { isPeriodMonth } from "@/lib/saas/statement";

export const OPERATOR_REASON_MIN = 5;

type Denied = { error: string };

function actorOf(user: SessionUser): PlatformActor {
  return { orgCode: user.organization!.code, userId: user.id, email: user.email };
}

function firstIssue(e: z.ZodError): string {
  return e.issues[0]?.message ?? "Dữ liệu không hợp lệ.";
}

const reason = z.string().trim().min(OPERATOR_REASON_MIN, `Ghi lý do (ít nhất ${OPERATOR_REASON_MIN} ký tự) — nó vào nhật ký nền tảng.`).max(500);
const period = z.string().refine(isPeriodMonth, "Kỳ phải có dạng YYYY-MM-01.");

// ─────────────────────────── Đọc ───────────────────────────

export async function loadCustomersConsole(user: SessionUser, periodMonth?: string): Promise<(CommercialSnapshot & { mergeCandidates: { stem: string; accounts: string[] }[] }) | Denied> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const snap = await loadCommercialSnapshot({ periodMonth: periodMonth && isPeriodMonth(periodMonth) ? periodMonth : undefined });
  return { ...snap, mergeCandidates: accountMergeCandidates(snap.customers.map((c) => c.account)) };
}

export type CustomerDetail = {
  customer: CustomerView;
  periodMonth: string;
  usdToVnd: number;
  entitlements: Record<string, ProductEntitlement[]>;
  drift: Record<string, { missingSubscription: string[]; subscribedButOff: string[] }>;
  reach: Map<string, { identities: number; lastLoginAt: Date | null; messengerPages: number }>;
  /** Kích hoạt của quản trị khách theo workspace (lib/saas/activation.ts); workspace nhà ⇒ `null`. */
  activation: Record<string, AdminActivation | null>;
  audit: Awaited<ReturnType<typeof accountAuditTrail>>;
  jobs: JobRow[];
  statements: Awaited<ReturnType<typeof finalizedStatements>>;
  costEntries: Awaited<ReturnType<typeof listCostEntries>>;
  accounts: { id: string; code: string; name: string }[];
};

export async function loadCustomerDetail(user: SessionUser, accountCode: string, periodMonth?: string): Promise<CustomerDetail | Denied | null> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const snap = await loadCommercialSnapshot({ periodMonth: periodMonth && isPeriodMonth(periodMonth) ? periodMonth : undefined });
  const customer = snap.customers.find((c) => c.account.code === accountCode);
  if (!customer) return null;
  const codes = customer.workspaces.map((w) => w.code);
  const entitlements: Record<string, ProductEntitlement[]> = {};
  const drift: CustomerDetail["drift"] = {};
  for (const w of customer.workspaces) {
    entitlements[w.code] = await Promise.all(w.subscriptions.filter((s) => productDef(s.productKey)).map((s) => productEntitlement(w.code, s.productKey)));
    drift[w.code] = moduleDrift(await productsInUse(w.code).catch(() => []), w.subscriptions);
  }
  const [reach, activation, audit, jobs, statements, costEntries] = await Promise.all([workspaceReach(codes), loadAdminActivations(customer.workspaces), accountAuditTrail(customer.account, codes), accountProvisioningJobs(customer.account, codes), finalizedStatements(customer.account.id), listCostEntries(snap.periodMonth)]);
  return {
    customer,
    periodMonth: snap.periodMonth,
    usdToVnd: snap.usdToVnd,
    entitlements,
    drift,
    reach,
    activation,
    audit,
    jobs,
    statements,
    costEntries: costEntries.filter((e) => e.accountId === customer.account.id || (e.orgCode && codes.includes(e.orgCode))),
    accounts: snap.customers.map((c) => ({ id: c.account.id, code: c.account.code, name: c.account.name })),
  };
}

export async function loadProductsConsole(user: SessionUser, periodMonth?: string) {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial } as Denied;
  const snap = await loadCommercialSnapshot({ periodMonth: periodMonth && isPeriodMonth(periodMonth) ? periodMonth : undefined });
  return { snap, products: productEconomics(snap) };
}

// ─────────────────────────── Ghi ───────────────────────────

const accountInput = z.object({
  code: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9-]{1,40}$/, "Mã tài khoản: chữ thường, số, gạch ngang; bắt đầu bằng chữ.").optional().or(z.literal("")),
  name: z.string().trim().min(2, "Tên khách cần ít nhất 2 ký tự.").max(200),
  accountType: z.enum(ACCOUNT_TYPES),
  billingMode: z.enum(BILLING_MODES).optional(),
  legalName: z.string().trim().max(300).optional(),
  taxCode: z.string().trim().max(30).optional(),
  billingEmail: z.string().trim().max(200).optional(),
});

const createCustomerInput = z.object({
  accountId: z.string().trim().max(64).optional().or(z.literal("")),
  account: accountInput.optional(),
  workspace: z.object({ code: z.string().trim().toLowerCase(), name: z.string().trim().min(2).max(200), planKey: z.string().trim().min(1), brand: z.enum(["vnx", "chotdon"]).nullable().optional() }),
  products: z.array(z.enum(PRODUCT_KEYS)).min(1, "Chọn ít nhất một sản phẩm."),
  admin: z.object({ email: z.string().trim().toLowerCase().email("Email quản trị không hợp lệ."), name: z.string().trim().max(200) }),
  idempotencyKey: z.string().trim().min(8).max(200),
  reason,
});

/** Tạo khách (tài khoản + workspace + thuê bao + quản trị) qua job cấp phát; trả liên kết kích hoạt dùng một lần cho quản trị. */
export async function createCustomerAsOperator(user: SessionUser, raw: unknown): Promise<{ ok: true; jobId: string; status: string; activationLink: string | null; accountCode: string | null; message: string } | Denied> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const p = createCustomerInput.safeParse(raw);
  if (!p.success) return { error: firstIssue(p.error) };
  const d = p.data;
  const res = await requestProvisioning(
    { kind: "CREATE_CUSTOMER", accountId: d.accountId || null, account: d.accountId ? undefined : d.account ? { ...d.account, code: d.account.code || null } : undefined, workspace: d.workspace, products: d.products, admin: d.admin },
    { actor: actorOf(user), email: user.email, source: "OPERATOR", idempotencyKey: d.idempotencyKey },
  );
  if ("error" in res) return res;
  const job = res.job;
  // Người nhận liên kết lấy từ ĐẦU VÀO ĐÃ LƯU của job — job chạy theo nó, không theo form vừa gửi (lượt gửi lại cùng khoá mà đầu
  // vào khác đã bị `requestProvisioning` từ chối; đọc từ job là lớp chặn thứ hai, không tin lại dữ liệu của trình duyệt).
  const stored = job.input as unknown as Partial<CreateCustomerRequest>;
  const target = stored.workspace?.code && stored.admin?.email ? { orgCode: stored.workspace.code, email: stored.admin.email.trim().toLowerCase() } : null;
  let activationLink: string | null = null;
  let activationNote = "";
  if (job.status === "SUCCEEDED" && target) {
    // Gửi lại CÙNG khoá (job đã xong từ trước) chỉ phát liên kết khi quản trị CHƯA kích hoạt: liên kết cho người đã vào được là
    // liên kết ĐẶT LẠI mật khẩu, không phải kích hoạt — cùng luật với «Gửi lại liên kết kích hoạt» (`resendActivationAsOperator`).
    const before = res.reused ? await loadWorkspaceActivation(target.orgCode) : null;
    if (before && !before.canResend) activationNote = ` ${activationRefusal(before.state)}`;
    else {
      // Nhật ký nói ĐÚNG việc: lần đầu = kích hoạt quản trị mới; lượt gửi lại form = gửi lại liên kết kích hoạt (cùng purpose).
      const why = res.reused ? `Gửi lại liên kết kích hoạt — form «Tạo khách» gửi lại cùng yêu cầu (job ${job.id.slice(0, 8)}): ${d.reason}` : `Kích hoạt quản trị khách mới (job ${job.id.slice(0, 8)}): ${d.reason}`;
      const link = await createResetLinkAsOperator(user, { orgCode: target.orgCode, email: before?.email ?? target.email, reason: why }, { purpose: "ACTIVATION" });
      if ("ok" in link) activationLink = link.link;
    }
  }
  const account = job.accountId ? ((await findAccountById(job.accountId))?.code ?? null) : null;
  return { ok: true, jobId: job.id, status: job.status, activationLink, accountCode: account, message: job.status === "SUCCEEDED" ? (res.reused ? `Yêu cầu này đã chạy xong trước đó.${activationNote}` : "Đã tạo khách.") : `Job ${job.status}: ${job.lastError ?? ""}` };
}

const resendActivationInput = z.object({ orgCode: z.string().trim().toLowerCase().min(2).max(64), reason });

/**
 * «Gửi lại liên kết kích hoạt» cho quản trị khách (báo cáo Finish Line 08/10/2026 — PR #680, blocker 5): liên kết kích hoạt dùng một lần, hết hạn sau
 * 24 giờ và chỉ in MỘT lần trong khung kết quả của form «Tạo khách» — đóng trang là mất. Chỉ khi quản trị CHƯA vào được (liên kết
 * còn hạn mà khách không nhận được · đã hết hạn · không còn liên kết dùng được — lib/saas/activation.ts); người đã kích hoạt thì
 * lối ra là «Đặt lại mật khẩu cho khách». Người nhận = quản trị do MÁY CHỦ tra (job «Tạo khách» / quản trị đầu tiên), không bao
 * giờ một email từ trình duyệt. Liên kết tạo qua ĐÚNG hàm của job (`createResetLinkAsOperator`): liên kết cũ chưa dùng bị THU HỒI,
 * CSDL chỉ giữ băm, nhật ký nền tảng (`PASSWORD_RESET_LINK`, `purpose: ACTIVATION`, kèm lý do) ghi TRƯỚC khi trả. Chưa có kênh
 * thư (dịch vụ ngoài mới cần chủ shop duyệt) ⇒ liên kết trả về người vận hành MỘT lần để gửi tay.
 */
export async function resendActivationAsOperator(user: SessionUser, raw: unknown): Promise<{ ok: true; link: string; expiresAt: string; email: string; message: string } | Denied> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const p = resendActivationInput.safeParse(raw);
  if (!p.success) return { error: firstIssue(p.error) };
  const act = await loadWorkspaceActivation(p.data.orgCode);
  if (!act) return { error: "Chỉ gửi kích hoạt cho quản trị của một workspace khách." };
  if (!act.canResend || !act.email) return { error: activationRefusal(act.state) };
  const r = await createResetLinkAsOperator(user, { orgCode: act.orgCode, email: act.email, reason: `Gửi lại liên kết kích hoạt: ${p.data.reason}` }, { purpose: "ACTIVATION" });
  if ("error" in r) return r;
  return { ok: true, link: r.link, expiresAt: r.expiresAt.toISOString(), email: r.email, message: "Đã tạo liên kết kích hoạt mới — liên kết cũ chưa dùng hết hiệu lực." };
}

const subscribeInput = z.object({ orgCode: z.string().trim(), productKey: z.enum(PRODUCT_KEYS), planKey: z.string().trim().optional().or(z.literal("")), idempotencyKey: z.string().trim().min(8).max(200), reason });

export async function subscribeProductAsOperator(user: SessionUser, raw: unknown): Promise<{ ok: true; status: string; message: string } | Denied> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const p = subscribeInput.safeParse(raw);
  if (!p.success) return { error: firstIssue(p.error) };
  const res = await requestProvisioning({ kind: "SUBSCRIBE_PRODUCT", orgCode: p.data.orgCode, productKey: p.data.productKey, planKey: p.data.planKey || null }, { actor: actorOf(user), email: user.email, source: "OPERATOR", idempotencyKey: p.data.idempotencyKey });
  if ("error" in res) return res;
  return { ok: true, status: res.job.status, message: res.job.status === "SUCCEEDED" ? "Đã thuê sản phẩm." : `Job ${res.job.status}: ${res.job.lastError ?? ""}` };
}

const subscriptionChangeInput = z.object({ subscriptionId: z.string().trim().min(1), action: z.enum(["PAUSE", "RESUME", "CANCEL"]), reason, idempotencyKey: z.string().trim().min(8).max(200).optional() });

export async function changeSubscriptionAsOperator(user: SessionUser, raw: unknown): Promise<{ ok: true; message: string } | Denied> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const p = subscriptionChangeInput.safeParse(raw);
  if (!p.success) return { error: firstIssue(p.error) };
  const d = p.data;
  try {
    if (d.action === "CANCEL") {
      const res = await requestProvisioning({ kind: "CANCEL_SUBSCRIPTION", subscriptionId: d.subscriptionId, reason: d.reason }, { actor: actorOf(user), email: user.email, source: "OPERATOR", idempotencyKey: d.idempotencyKey ?? `cancel:${d.subscriptionId}` });
      if ("error" in res) return res;
      return { ok: true, message: res.job.status === "SUCCEEDED" ? "Đã huỷ thuê bao và tắt module độc quyền." : `Job ${res.job.status}: ${res.job.lastError ?? ""}` };
    }
    await setSubscriptionState(d.subscriptionId, { state: d.action === "PAUSE" ? "PAUSED" : "ACTIVE" }, { actor: actorOf(user), source: "OPERATOR", reason: d.reason });
    return { ok: true, message: d.action === "PAUSE" ? "Đã tạm dừng thuê bao." : "Đã tiếp tục thuê bao." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function retryProvisioningAsOperator(user: SessionUser, raw: unknown): Promise<{ ok: true; status: string; message: string } | Denied> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const p = z.object({ jobId: z.string().trim().min(1) }).safeParse(raw);
  if (!p.success) return { error: firstIssue(p.error) };
  const r = await retryJob(p.data.jobId, { actor: actorOf(user), email: user.email, source: "OPERATOR" });
  if ("error" in r) return r;
  return { ok: true, status: r.status, message: r.status === "SUCCEEDED" ? "Job đã chạy xong." : `Vẫn hỏng: ${r.lastError ?? ""}` };
}

const updateInput = z.object({ accountCode: z.string().trim(), name: z.string().trim().min(2).max(200).optional(), accountType: z.enum(ACCOUNT_TYPES).optional(), billingMode: z.enum(BILLING_MODES).optional(), status: z.enum(ACCOUNT_STATUSES).optional(), legalName: z.string().trim().max(300).optional(), taxCode: z.string().trim().max(30).optional(), billingEmail: z.string().trim().max(200).optional(), reason });

export async function updateAccountAsOperator(user: SessionUser, raw: unknown): Promise<{ ok: true; message: string } | Denied> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const p = updateInput.safeParse(raw);
  if (!p.success) return { error: firstIssue(p.error) };
  const { accountCode, reason: why, ...patch } = p.data;
  const account = await findAccountByCode(accountCode);
  if (!account) return { error: "Không có tài khoản này." };
  try {
    await updateAccount(account.id, patch, { actor: actorOf(user), source: "OPERATOR", reason: why });
    return { ok: true, message: "Đã lưu tài khoản." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function moveWorkspaceAsOperator(user: SessionUser, raw: unknown): Promise<{ ok: true; message: string } | Denied> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const p = z.object({ orgCode: z.string().trim(), toAccountCode: z.string().trim(), reason }).safeParse(raw);
  if (!p.success) return { error: firstIssue(p.error) };
  const target = await findAccountByCode(p.data.toAccountCode);
  if (!target) return { error: "Không có tài khoản đích." };
  try {
    await moveWorkspaceToAccount(p.data.orgCode, target.id, { actor: actorOf(user), source: "OPERATOR", reason: p.data.reason });
    return { ok: true, message: `Đã chuyển workspace sang ${target.name}.` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Mở thuê bao cho sản phẩm workspace ĐANG dùng theo module mà chưa có thuê bao (sửa lệch — có lý do, có nhật ký). */
export async function reconcileSubscriptionsAsOperator(user: SessionUser, raw: unknown): Promise<{ ok: true; message: string } | Denied> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const p = z.object({ orgCode: z.string().trim(), reason }).safeParse(raw);
  if (!p.success) return { error: firstIssue(p.error) };
  try {
    const opened = await openSubscriptionsForProductsInUse(p.data.orgCode, { actor: actorOf(user), source: "OPERATOR", reason: p.data.reason });
    return { ok: true, message: opened.length ? `Đã mở thuê bao: ${opened.join(", ")}.` : "Không có sản phẩm nào thiếu thuê bao." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const costInput = z.object({
  periodMonth: period,
  category: z.enum(COST_CATEGORIES),
  scope: z.enum(["PLATFORM", "PRODUCT", "ACCOUNT", "WORKSPACE"]),
  productKey: z.enum(PRODUCT_KEYS).optional(),
  accountCode: z.string().trim().optional(),
  orgCode: z.string().trim().optional(),
  basis: z.enum(["DIRECT", "EQUAL_ACTIVE_WORKSPACES", "AI_COST_SHARE"]),
  amountVnd: z.coerce.number().int("Số tiền là số nguyên VND.").positive("Số tiền phải dương.").max(2_000_000_000),
  description: z.string().trim().min(3).max(300),
  reason,
});

export async function addCostEntryAsOperator(user: SessionUser, raw: unknown): Promise<{ ok: true; message: string } | Denied> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const p = costInput.safeParse(raw);
  if (!p.success) return { error: firstIssue(p.error) };
  const d = p.data;
  const account = d.accountCode ? await findAccountByCode(d.accountCode) : null;
  if (d.scope === "ACCOUNT" && !account) return { error: "Chọn tài khoản cho khoản chi cấp tài khoản." };
  if (d.scope === "WORKSPACE" && !d.orgCode) return { error: "Chọn workspace cho khoản chi trực tiếp." };
  if (d.scope === "PRODUCT" && !d.productKey) return { error: "Chọn sản phẩm." };
  if ((d.scope === "PLATFORM" || d.scope === "PRODUCT") && d.basis === "DIRECT") return { error: "Chi phí nền tảng / sản phẩm phải khai căn cứ chia (đều theo workspace, hoặc theo tỷ trọng AI)." };
  try {
    const r = await addCostEntry({ periodMonth: d.periodMonth, category: d.category, scope: d.scope, productKey: d.productKey ?? null, accountId: account?.id ?? null, orgCode: d.orgCode ?? null, basis: d.basis, amountVnd: d.amountVnd, description: d.description }, { actor: actorOf(user), email: user.email, reason: d.reason, source: "UI" });
    return { ok: true, message: r.created ? "Đã ghi khoản chi." : "Khoản chi này đã ghi trước đó (cùng kỳ, hạng mục, mô tả)." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function voidCostEntryAsOperator(user: SessionUser, raw: unknown): Promise<{ ok: true; message: string } | Denied> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const p = z.object({ id: z.string().trim().min(1), reason }).safeParse(raw);
  if (!p.success) return { error: firstIssue(p.error) };
  try {
    await voidCostEntry(p.data.id, { actor: actorOf(user), reason: p.data.reason, source: "UI" });
    return { ok: true, message: "Đã huỷ khoản chi." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function finalizeStatementAsOperator(user: SessionUser, raw: unknown): Promise<{ ok: true; message: string } | Denied> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const p = z.object({ accountCode: z.string().trim(), periodMonth: period, reason }).safeParse(raw);
  if (!p.success) return { error: firstIssue(p.error) };
  const r = await finalizeStatement(p.data.accountCode, p.data.periodMonth, { actor: actorOf(user), email: user.email, reason: p.data.reason, source: "UI" });
  return "ok" in r ? { ok: true, message: "Đã chốt bảng kê kỳ." } : r;
}

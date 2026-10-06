/**
 * ═══════════ TÀI KHOẢN KHÁCH · WORKSPACE · THUÊ BAO SẢN PHẨM — CHỈ MÁY CHỦ (docs/saas/README.md §2–4) ═══════════
 *
 * Account (khách thương mại) → Workspace (`platform_organizations`, ranh giới cô lập = một CSDL) → Product Subscription.
 * Mọi đường ghi ở đây ghi nhật ký nền tảng; người gọi (server action / job cấp phát) kiểm quyền vận hành TRƯỚC.
 *
 * Không gộp tài khoản theo tên: hai workspace "HSLC…" là hai tài khoản tới khi người vận hành chuyển workspace (có lý do,
 * có vết). `accountMergeCandidates` chỉ GỢI Ý.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { platformAudit, type PlatformActor, type PlatformAuditSource } from "@/lib/platform/audit";
import { canUseFeature, getEnabledModules } from "@/lib/platform/capabilities";
import { findOrganization, getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { LEGACY_CHATBOT_FEATURE, productsFromModules } from "@/lib/saas/catalog";
import { defaultBillingMode, mergeSuggestible, type AccountType, type BillingMode } from "@/lib/saas/policy";

export type SaasSource = "OPERATOR" | "PROVISIONING" | "SIGNUP" | "TEST";

export type AccountRow = typeof schema.platformAccounts.$inferSelect;
export type SubscriptionRow = typeof schema.platformProductSubscriptions.$inferSelect;
export type WorkspaceRow = { id: string; code: string; name: string; status: string; isHome: boolean; plan: string | null; brand: string | null; accountId: string | null; createdAt: Date };

const ACCOUNT_CODE = /^[a-z][a-z0-9-]{1,40}$/;

function auditSource(s: SaasSource): PlatformAuditSource {
  return s === "TEST" ? "TEST" : s === "OPERATOR" ? "UI" : "SCRIPT";
}

/** Toàn bộ sổ thương mại — ba câu đọc, ghép trong bộ nhớ (số tài khoản cỡ trăm, không phải triệu). */
export async function readCommercialRegistry(): Promise<{ accounts: AccountRow[]; workspaces: WorkspaceRow[]; subscriptions: SubscriptionRow[] }> {
  const pdb = await getPlatformDb();
  const [accounts, orgs, subscriptions] = await Promise.all([
    pdb.select().from(schema.platformAccounts).orderBy(asc(schema.platformAccounts.createdAt)),
    pdb
      .select({ id: schema.platformOrganizations.id, code: schema.platformOrganizations.code, name: schema.platformOrganizations.name, status: schema.platformOrganizations.status, isHome: schema.platformOrganizations.isHome, plan: schema.platformOrganizations.plan, brand: schema.platformOrganizations.brand, accountId: schema.platformOrganizations.accountId, createdAt: schema.platformOrganizations.createdAt })
      .from(schema.platformOrganizations)
      .orderBy(asc(schema.platformOrganizations.createdAt)),
    pdb.select().from(schema.platformProductSubscriptions).orderBy(asc(schema.platformProductSubscriptions.startedAt)),
  ]);
  return { accounts, workspaces: orgs, subscriptions };
}

export async function findAccountByCode(code: string): Promise<AccountRow | null> {
  const pdb = await getPlatformDb();
  return (await pdb.query.platformAccounts.findFirst({ where: eq(schema.platformAccounts.code, code) })) ?? null;
}

export async function findAccountById(id: string): Promise<AccountRow | null> {
  const pdb = await getPlatformDb();
  return (await pdb.query.platformAccounts.findFirst({ where: eq(schema.platformAccounts.id, id) })) ?? null;
}

/** Tài khoản sở hữu một workspace — `null` = chưa gắn (chỉ xảy ra trước 0224 hoặc khi một lượt cấp hỏng giữa chừng). */
export async function accountOfWorkspace(orgCode: string): Promise<AccountRow | null> {
  const pdb = await getPlatformDb();
  const row = await pdb.select({ accountId: schema.platformOrganizations.accountId }).from(schema.platformOrganizations).where(eq(schema.platformOrganizations.code, orgCode)).limit(1);
  const id = row[0]?.accountId;
  return id ? findAccountById(id) : null;
}

async function freeAccountCode(base: string): Promise<string> {
  const pdb = await getPlatformDb();
  const stem = base.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^[^a-z]+/, "").slice(0, 36) || "khach";
  for (let i = 1; i < 100; i++) {
    const code = i === 1 ? stem : `${stem}-${i}`;
    if (!ACCOUNT_CODE.test(code)) continue;
    const hit = await pdb.query.platformAccounts.findFirst({ where: eq(schema.platformAccounts.code, code), columns: { id: true } });
    if (!hit) return code;
  }
  throw new Error(`Không tìm được mã tài khoản trống cho "${base}".`);
}

export type CreateAccountInput = { code?: string | null; name: string; accountType: AccountType; billingMode?: BillingMode | null; legalName?: string | null; taxCode?: string | null; billingEmail?: string | null; note?: string | null };

export async function createAccount(input: CreateAccountInput, ctx: { actor: PlatformActor; source: SaasSource; reason?: string | null }): Promise<AccountRow> {
  const name = input.name.trim();
  if (name.length < 2) throw new Error("Tên tài khoản cần ít nhất 2 ký tự.");
  const code = input.code?.trim() ? input.code.trim().toLowerCase() : await freeAccountCode(name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d"));
  if (!ACCOUNT_CODE.test(code)) throw new Error(`Mã tài khoản "${code}" không hợp lệ (chữ thường, số, gạch ngang; bắt đầu bằng chữ).`);
  const pdb = await getPlatformDb();
  const values = {
    code,
    name,
    accountType: input.accountType,
    billingMode: input.billingMode ?? defaultBillingMode(input.accountType),
    legalName: input.legalName?.trim() || null,
    taxCode: input.taxCode?.trim() || null,
    billingEmail: input.billingEmail?.trim() || null,
    note: input.note?.trim() || null,
    source: ctx.source,
    updatedBy: ctx.actor ? `${ctx.actor.orgCode}:${ctx.actor.userId}` : `system:${ctx.source.toLowerCase()}`,
  };
  const [row] = await pdb.insert(schema.platformAccounts).values(values).onConflictDoNothing().returning();
  if (!row) throw new Error(`Mã tài khoản "${code}" đã có.`);
  const home = await getHomeOrganization();
  await platformAudit({ action: "ACCOUNT_CREATE", targetOrgCode: home.code, targetAccountId: row.id, subject: `account:${row.code}`, after: values, reason: ctx.reason ?? null, source: auditSource(ctx.source), actor: ctx.actor });
  return row;
}

export type UpdateAccountInput = Partial<Pick<CreateAccountInput, "name" | "legalName" | "taxCode" | "billingEmail" | "note">> & { accountType?: AccountType; billingMode?: BillingMode; status?: "ACTIVE" | "SUSPENDED" | "CLOSED" };

export async function updateAccount(accountId: string, patch: UpdateAccountInput, ctx: { actor: PlatformActor; source: SaasSource; reason: string }): Promise<AccountRow> {
  const before = await findAccountById(accountId);
  if (!before) throw new Error("Không có tài khoản này.");
  const next: Partial<AccountRow> = {};
  if (patch.name !== undefined) {
    if (patch.name.trim().length < 2) throw new Error("Tên tài khoản cần ít nhất 2 ký tự.");
    next.name = patch.name.trim();
  }
  for (const k of ["legalName", "taxCode", "billingEmail", "note"] as const) if (patch[k] !== undefined) next[k] = patch[k]?.trim() || null;
  if (patch.accountType) next.accountType = patch.accountType;
  if (patch.billingMode) next.billingMode = patch.billingMode;
  if (patch.status) next.status = patch.status;
  if (!Object.keys(next).length) return before;
  const pdb = await getPlatformDb();
  const [row] = await pdb
    .update(schema.platformAccounts)
    .set({ ...next, updatedAt: new Date(), updatedBy: ctx.actor ? `${ctx.actor.orgCode}:${ctx.actor.userId}` : `system:${ctx.source.toLowerCase()}` })
    .where(eq(schema.platformAccounts.id, accountId))
    .returning();
  const home = await getHomeOrganization();
  const pick = (r: AccountRow) => Object.fromEntries(Object.keys(next).map((k) => [k, r[k as keyof AccountRow]]));
  await platformAudit({ action: "ACCOUNT_UPDATE", targetOrgCode: home.code, targetAccountId: accountId, subject: `account:${before.code}`, before: pick(before), after: pick(row), reason: ctx.reason, source: auditSource(ctx.source), actor: ctx.actor });
  return row;
}

/**
 * Chuyển workspace sang tài khoản khác (gộp hai tài khoản là chuyển từng workspace). Thuê bao ĐANG SỐNG của workspace đi
 * theo (tài khoản là bên trả tiền của nó); thuê bao đã huỷ giữ tài khoản cũ — lịch sử không bị viết lại.
 */
export async function moveWorkspaceToAccount(orgCode: string, accountId: string, ctx: { actor: PlatformActor; source: SaasSource; reason: string }): Promise<void> {
  const org = await findOrganization(orgCode);
  if (!org) throw new Error(`Không có workspace "${orgCode}".`);
  const target = await findAccountById(accountId);
  if (!target) throw new Error("Không có tài khoản đích.");
  const before = await accountOfWorkspace(orgCode);
  if (before?.id === target.id) return;
  const pdb = await getPlatformDb();
  await pdb.transaction(async (tx) => {
    await tx.update(schema.platformOrganizations).set({ accountId: target.id, updatedAt: new Date() }).where(eq(schema.platformOrganizations.code, orgCode));
    await tx
      .update(schema.platformProductSubscriptions)
      .set({ accountId: target.id, updatedAt: new Date() })
      .where(and(eq(schema.platformProductSubscriptions.orgCode, orgCode), isNull(schema.platformProductSubscriptions.endedAt)));
  });
  invalidateOrganizations();
  await platformAudit({ action: "WORKSPACE_ACCOUNT_SET", targetOrgCode: orgCode, targetAccountId: target.id, subject: `workspace:${orgCode}`, before: before ? { account: before.code } : null, after: { account: target.code }, reason: ctx.reason, source: auditSource(ctx.source), actor: ctx.actor });
}

/**
 * Workspace chưa có tài khoản ⇒ gắn vào `accountId` (nếu đưa) hoặc tạo MỘT tài khoản khách ngoài mang tên workspace. Đã có
 * ⇒ không đổi gì (idempotent). Gọi từ bước cuối của `provisionOrganization` — mọi đường tạo workspace đều đi qua đó.
 */
export async function ensureAccountForWorkspace(orgCode: string, opts: { accountId?: string | null; source: SaasSource; actor: PlatformActor }): Promise<AccountRow> {
  const has = await accountOfWorkspace(orgCode);
  if (has) return has;
  const org = await findOrganization(orgCode);
  if (!org) throw new Error(`Không có workspace "${orgCode}".`);
  let account = opts.accountId ? await findAccountById(opts.accountId) : null;
  if (opts.accountId && !account) throw new Error("Không có tài khoản được chỉ định.");
  if (!account) account = await createAccount({ code: await freeAccountCode(org.code), name: org.name, accountType: "EXTERNAL" }, { actor: opts.actor, source: opts.source, reason: `Tạo cùng workspace ${org.code}` });
  const pdb = await getPlatformDb();
  await pdb.update(schema.platformOrganizations).set({ accountId: account.id, updatedAt: new Date() }).where(and(eq(schema.platformOrganizations.code, orgCode), isNull(schema.platformOrganizations.accountId)));
  invalidateOrganizations();
  await platformAudit({ action: "WORKSPACE_ACCOUNT_SET", targetOrgCode: orgCode, targetAccountId: account.id, subject: `workspace:${orgCode}`, before: null, after: { account: account.code }, reason: "Gắn workspace mới vào tài khoản", source: auditSource(opts.source), actor: opts.actor });
  return account;
}

/** Sản phẩm workspace ĐANG dùng theo module — cùng luật backfill 0224. */
export async function productsInUse(orgCode: string): Promise<string[]> {
  const enabled = await getEnabledModules(orgCode);
  const legacyChatbotOn = enabled.has("connector_pancake") ? await canUseFeature(LEGACY_CHATBOT_FEATURE as `${string}.${string}`, orgCode) : false;
  return productsFromModules(enabled, { legacyChatbotOn });
}

export async function liveSubscriptions(orgCode: string): Promise<SubscriptionRow[]> {
  const pdb = await getPlatformDb();
  return pdb
    .select()
    .from(schema.platformProductSubscriptions)
    .where(and(eq(schema.platformProductSubscriptions.orgCode, orgCode), isNull(schema.platformProductSubscriptions.endedAt)));
}

/**
 * Mở thuê bao (theo gói của workspace) cho sản phẩm workspace ĐANG dùng mà chưa có thuê bao sống. CHỈ THÊM — không bao giờ
 * huỷ một thuê bao vì module tắt (huỷ là quyết định thương mại, đi qua job cấp phát). Trả các sản phẩm vừa mở.
 */
export async function openSubscriptionsForProductsInUse(orgCode: string, ctx: { actor: PlatformActor; source: SaasSource; reason: string }): Promise<string[]> {
  const account = await accountOfWorkspace(orgCode);
  if (!account) throw new Error(`Workspace "${orgCode}" chưa gắn tài khoản.`);
  const live = new Set((await liveSubscriptions(orgCode)).map((s) => s.productKey));
  const opened: string[] = [];
  for (const product of await productsInUse(orgCode)) {
    if (live.has(product)) continue;
    const row = await insertSubscription({ accountId: account.id, orgCode, productKey: product, planKey: null }, ctx);
    if (row) opened.push(product);
  }
  return opened;
}

export async function insertSubscription(input: { accountId: string; orgCode: string; productKey: string; planKey: string | null }, ctx: { actor: PlatformActor; source: SaasSource; reason: string }): Promise<SubscriptionRow | null> {
  const pdb = await getPlatformDb();
  const [row] = await pdb
    .insert(schema.platformProductSubscriptions)
    .values({ accountId: input.accountId, orgCode: input.orgCode, productKey: input.productKey, planKey: input.planKey, state: "ACTIVE", source: ctx.source, updatedBy: ctx.actor ? `${ctx.actor.orgCode}:${ctx.actor.userId}` : `system:${ctx.source.toLowerCase()}` })
    .onConflictDoNothing()
    .returning();
  if (!row) return null;
  await platformAudit({ action: "PRODUCT_SUBSCRIBE", targetOrgCode: input.orgCode, targetAccountId: input.accountId, subject: `product:${input.productKey}`, after: { planKey: input.planKey ?? "(gói workspace)", state: "ACTIVE" }, reason: ctx.reason, source: auditSource(ctx.source), actor: ctx.actor });
  return row;
}

/** Tạm dừng · tiếp tục · huỷ · hẹn đổi gói một thuê bao — luôn có lý do và nhật ký. */
export async function setSubscriptionState(subscriptionId: string, change: { state: "ACTIVE" | "PAUSED" | "CANCELED" } | { schedulePlanKey: string | null; scheduledAt: string | null }, ctx: { actor: PlatformActor; source: SaasSource; reason: string }): Promise<SubscriptionRow> {
  const pdb = await getPlatformDb();
  const before = await pdb.query.platformProductSubscriptions.findFirst({ where: eq(schema.platformProductSubscriptions.id, subscriptionId) });
  if (!before) throw new Error("Không có thuê bao này.");
  if (before.endedAt) throw new Error("Thuê bao đã huỷ — thuê lại là một thuê bao mới.");
  const now = new Date();
  const set: Partial<SubscriptionRow> =
    "state" in change
      ? change.state === "CANCELED"
        ? { state: "CANCELED", endedAt: now, endReason: ctx.reason, scheduledPlanKey: null, scheduledAt: null }
        : { state: change.state }
      : { scheduledPlanKey: change.schedulePlanKey, scheduledAt: change.schedulePlanKey ? change.scheduledAt : null };
  const [row] = await pdb
    .update(schema.platformProductSubscriptions)
    .set({ ...set, updatedAt: now, updatedBy: ctx.actor ? `${ctx.actor.orgCode}:${ctx.actor.userId}` : `system:${ctx.source.toLowerCase()}` })
    .where(and(eq(schema.platformProductSubscriptions.id, subscriptionId), isNull(schema.platformProductSubscriptions.endedAt)))
    .returning();
  if (!row) throw new Error("Thuê bao vừa bị đổi bởi người khác — tải lại trang.");
  await platformAudit({
    action: "PRODUCT_SUBSCRIPTION_SET",
    targetOrgCode: before.orgCode,
    targetAccountId: before.accountId,
    subject: `product:${before.productKey}`,
    before: { state: before.state, scheduledPlanKey: before.scheduledPlanKey, scheduledAt: before.scheduledAt },
    after: { state: row.state, scheduledPlanKey: row.scheduledPlanKey, scheduledAt: row.scheduledAt },
    reason: ctx.reason,
    source: auditSource(ctx.source),
    actor: ctx.actor,
  });
  return row;
}

/**
 * GỢI Ý gộp — tài khoản khách ngoài có tên bắt đầu cùng một từ (≥ 3 ký tự, bỏ dấu). KHÔNG BAO GIỜ tự gộp: tên giống nhau
 * không chứng minh cùng một bên trả tiền (AGENTS mục 35 — không đoán người, không đoán khách).
 */
export function accountMergeCandidates(accounts: readonly Pick<AccountRow, "id" | "code" | "name" | "accountType">[]): { stem: string; accounts: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const a of accounts) {
    if (!mergeSuggestible(a.accountType as AccountType)) continue;
    const stem = a.name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().match(/[a-z0-9]{3,}/)?.[0];
    if (!stem) continue;
    groups.set(stem, [...(groups.get(stem) ?? []), a.code]);
  }
  return [...groups.entries()].filter(([, v]) => v.length > 1).map(([stem, v]) => ({ stem, accounts: v }));
}

/**
 * ═══════════ XUẤT BẢN ERP CỦA TỔ CHỨC + TÊN MIỀN CON (0180) — CHỈ MÁY CHỦ ═══════════
 *
 * Tài liệu: docs/platform/self-service-journey.md mục «Xem trước · Tên miền con · Xuất bản». Tổ chức tạo qua `/start`
 * sinh ra ở trạng thái NHÁP (`publish_state = DRAFT`): chủ tổ chức vào ERP của mình, cấu hình, và ERP đó CHÍNH LÀ bản
 * xem trước (thanh "Bản nháp" ở đầu mọi trang). Bấm **Xuất bản** thì máy kiểm lại mọi thứ, rồi bật định tuyến
 * `<slug>.<PLATFORM_BASE_DOMAIN>` — không git, không build, không deploy cho từng khách.
 *
 * ─── NHÁP KHÁC ĐÃ XUẤT BẢN Ở ĐÚNG HAI CHỖ ───
 *  1. Định tuyến theo tên miền con: CHỈ tổ chức `PUBLISHED` (+ `ACTIVE`) được host `<slug>.<miền gốc>` trỏ tới
 *     (`organizationForHostSlug`). Nháp ⇒ tên miền con trả "không có ERP ở địa chỉ này", như slug chưa ai dùng.
 *  2. Trang chat công khai của chatbot bán hàng chỉ mở trên tên miền con ⇒ chỉ tổ chức đã xuất bản nhận khách lạ.
 * Còn lại (đăng nhập bằng mã tổ chức ở miền chính, mời người dùng, cấu hình) chạy như nhau — nháp là để CHỦ tự dùng thử.
 *
 * `NULL` = KHÔNG theo dõi (tổ chức nhà, tổ chức có từ trước 0180): không đoán trạng thái cho tổ chức cũ (mục 8.8), và
 * chúng không có tên miền con nên không bị cổng nào chặn.
 *
 * ─── KIỂM TRƯỚC KHI XUẤT BẢN (MỘT danh sách, màn hình in đúng nó) ───
 * module (phụ thuộc đóng) · cấu hình dữ liệu (xuất cấu hình hiện tại rồi `validateBlueprint` — cùng bộ kiểm của mẫu /
 * AI) · luật đang bật (kiểm lại TOÀN BỘ tham chiếu như lúc bật) · quyền (còn ít nhất một quản trị hoạt động có
 * `users:manage`) · tên miền (đúng dạng, không dành riêng, không trùng). Mục CHẶN hỏng ⇒ không xuất bản. Mục NHẮC (chưa có
 * sản phẩm, chatbot chưa cấu hình, chưa có kênh báo nhóm) chỉ in ra — shop được quyền xuất bản trước khi làm đủ.
 */
import { and, eq, ne, sql } from "drizzle-orm";
import { getDb, getPlatformDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { exportOrgBlueprint } from "@/lib/blueprints/export";
import { clearMemo } from "@/lib/cache";
import { moduleDef } from "@/lib/constants/platform-modules";
import { env } from "@/lib/env";
import { RESERVED_ORG_CODES } from "@/lib/onboarding/shared";
import { ACCEPTANCE_RESERVED_MESSAGE, acceptanceReservedName } from "@/lib/constants/saas-acceptance-registry";
import { platformAudit } from "@/lib/platform/audit";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { currentOrganization } from "@/lib/platform/context";
import { domainSlugProblem, subdomainOrigin } from "@/lib/platform/host";
import { invalidateOrganizations, listOrganizations } from "@/lib/platform/organizations";
import type { Organization } from "@/lib/platform/types";
import { listRules, validateRuleInput } from "@/lib/workflow/rules";

/** Quyền bấm Xuất bản / đổi tên miền con: cấu hình hệ thống của tổ chức. Quản trị có sẵn; vai trò tuỳ chỉnh không cấp được. */
export const PUBLISH_PERMISSION = "settings:manage" as const;

export type PublishState = "UNTRACKED" | "DRAFT" | "PUBLISHED";
export type Publication = { state: PublishState; slug: string | null; publishedAt: Date | null; publishedBy: string | null; url: string | null; baseDomain: string | null };

/** Miền gốc của tên miền con; `null` khi nền tảng chưa bật định tuyến theo tên miền con. */
export function platformBaseDomain(): string | null {
  return env.platformBaseDomain;
}

async function orgRow(code: string) {
  const pdb = await getPlatformDb();
  return pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
}

export async function publicationOf(code: string): Promise<Publication> {
  const row = await orgRow(code);
  const base = platformBaseDomain();
  const state: PublishState = row?.publishState === "DRAFT" ? "DRAFT" : row?.publishState === "PUBLISHED" ? "PUBLISHED" : "UNTRACKED";
  const slug = row?.domainSlug ?? null;
  return { state, slug, publishedAt: row?.publishedAt ?? null, publishedBy: row?.publishedBy ?? null, url: slug && base ? subdomainOrigin(slug, base) : null, baseDomain: base };
}

/**
 * Gốc liên kết cho người của tổ chức — sống ở `lib/platform/org-links.ts` (tệp nhẹ, đường gửi cảnh báo import được mà
 * không kéo theo luật workflow / blueprint). Xuất lại ở đây để các chỗ gọi cũ giữ nguyên.
 */
export { organizationBaseUrl } from "@/lib/platform/org-links";

/**
 * Tổ chức mà tên miền con `slug` trỏ tới — CHỈ tổ chức đã xuất bản, đang hoạt động, không phải nhà. Không có ⇒ `null`
 * (người gọi trả "không có ERP ở địa chỉ này" — KHÔNG BAO GIỜ rơi về tổ chức nhà). Đọc sổ có đệm 10 giây
 * (`listOrganizations`); lượt xuất bản trong cùng tiến trình xoá đệm ngay.
 */
export async function organizationForHostSlug(slug: string | null | undefined): Promise<Organization | null> {
  if (!slug) return null;
  const list = await listOrganizations();
  return list.find((o) => !o.isHome && o.status === "ACTIVE" && o.publishState === "PUBLISHED" && o.domainSlug === slug) ?? null;
}

/** Tổ chức mới qua `/start` bắt đầu ở NHÁP. Chỉ `lib/onboarding/service.ts` gọi; không đè trạng thái đã có. */
export async function markOrganizationDraft(code: string): Promise<void> {
  const pdb = await getPlatformDb();
  const t = schema.platformOrganizations;
  const row = await orgRow(code);
  if (!row || row.isHome || row.publishState) return;
  await pdb.update(t).set({ publishState: "DRAFT", updatedAt: new Date() }).where(eq(t.code, code));
  invalidateOrganizations();
}

// ═══ TÊN MIỀN CON ═══

export type SlugCheck = { ok: true; slug: string; url: string | null } | { ok: false; error: string };

/** Dạng + dành riêng + không trùng (với tên miền con của tổ chức KHÁC). Không ghi gì. */
export async function checkDomainSlug(raw: unknown, selfCode: string): Promise<SlugCheck> {
  const slug = String(raw ?? "").trim().toLowerCase();
  const problem = domainSlugProblem(slug);
  if (problem) return { ok: false, error: problem.message };
  if ((RESERVED_ORG_CODES as readonly string[]).includes(slug)) return { ok: false, error: "Tên này dành riêng cho nền tảng — chọn tên khác." };
  // Tên miền con / mã của workspace NGHIỆM THU (sổ khai, kho mã PUBLIC nên tên đã lộ) chỉ CHÍNH workspace ấy mang được.
  const held = acceptanceReservedName(slug);
  if (held && held.code !== selfCode) return { ok: false, error: ACCEPTANCE_RESERVED_MESSAGE };
  const pdb = await getPlatformDb();
  const t = schema.platformOrganizations;
  const [taken] = await pdb.select({ code: t.code }).from(t).where(and(eq(t.domainSlug, slug), ne(t.code, selfCode))).limit(1);
  if (taken) return { ok: false, error: "Tên miền con này đã có tổ chức khác dùng — chọn tên khác." };
  const base = platformBaseDomain();
  return { ok: true, slug, url: base ? subdomainOrigin(slug, base) : null };
}

function actorOf(user: SessionUser, code: string) {
  return { orgCode: code, userId: user.id, email: user.email };
}

export type PublishResult = { ok: true; publication: Publication; message: string } | { ok: false; error: string; checks?: PublishCheck[] };

/** Chọn / đổi tên miền con. Chỉ lúc NHÁP: tên miền đã in lên danh thiếp của khách thì đổi là làm gãy liên kết của họ. */
export async function setDomainSlug(user: SessionUser, raw: unknown): Promise<PublishResult> {
  if (!can(user, PUBLISH_PERMISSION)) return { ok: false, error: "Bạn không có quyền đổi tên miền của tổ chức (settings:manage)." };
  const ctx = await currentOrganization();
  if (ctx.isHome) return { ok: false, error: "Tổ chức nhà chạy ở tên miền chính — không có tên miền con." };
  const before = await publicationOf(ctx.code);
  if (before.state === "PUBLISHED") return { ok: false, error: "ERP đã xuất bản — tên miền con đã khoá (liên kết khách đang dùng sẽ gãy). Liên hệ người vận hành nền tảng nếu thật sự cần đổi." };
  const checked = await checkDomainSlug(raw, ctx.code);
  if (!checked.ok) return { ok: false, error: checked.error };
  if (before.slug === checked.slug) return { ok: true, publication: before, message: "Tên miền con không đổi." };
  const pdb = await getPlatformDb();
  const t = schema.platformOrganizations;
  try {
    await pdb.update(t).set({ domainSlug: checked.slug, ...(before.state === "UNTRACKED" ? { publishState: "DRAFT" } : {}), updatedAt: new Date() }).where(eq(t.code, ctx.code));
  } catch (error) {
    // Hai tổ chức giành cùng một tên trong cùng một giây: chỉ mục UNIQUE quyết người thắng.
    if (String((error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code) === "23505") return { ok: false, error: "Tên miền con này vừa có tổ chức khác lấy — chọn tên khác." };
    throw error;
  }
  invalidateOrganizations();
  await platformAudit({ action: "ORG_DOMAIN_SET", targetOrgCode: ctx.code, subject: checked.slug, before: { slug: before.slug }, after: { slug: checked.slug }, source: "UI", actor: actorOf(user, ctx.code) });
  await audit({ userId: user.id, userEmail: user.email, action: "ORG_DOMAIN_SET", entity: "ORGANIZATION", entityId: ctx.code, before: { slug: before.slug }, after: { slug: checked.slug } });
  return { ok: true, publication: await publicationOf(ctx.code), message: checked.url ? `Đã giữ tên miền ${checked.url.replace(/^https?:\/\//, "")} — có hiệu lực khi Xuất bản.` : "Đã lưu tên miền con — nền tảng chưa bật định tuyến theo tên miền con (PLATFORM_BASE_DOMAIN)." };
}

// ═══ KIỂM TRƯỚC KHI XUẤT BẢN ═══

export type PublishCheckKey = "modules" | "metadata" | "workflows" | "permissions" | "domain" | "products" | "chatbot" | "messaging";
export type PublishCheck = { key: PublishCheckKey; label: string; ok: boolean; blocking: boolean; detail: string; href: string | null };

async function checkModules(): Promise<PublishCheck> {
  const enabled = await getEnabledModules();
  const missing: string[] = [];
  for (const m of enabled) for (const d of moduleDef(m)?.dependsOn ?? []) if (!enabled.has(d)) missing.push(`${moduleDef(m)?.label ?? m} cần ${moduleDef(d)?.label ?? d}`);
  return {
    key: "modules",
    label: "Module",
    ok: missing.length === 0,
    blocking: true,
    detail: missing.length ? `Thiếu phụ thuộc: ${missing.join(" · ")}` : `${enabled.size} module đang bật, đủ phụ thuộc.`,
    href: "/settings/modules",
  };
}

async function checkMetadata(): Promise<PublishCheck> {
  const exp = await exportOrgBlueprint();
  const errs = exp.validation.errors;
  const c = exp.counts;
  return {
    key: "metadata",
    label: "Cấu hình dữ liệu (field · form · danh sách · trang)",
    ok: errs.length === 0,
    blocking: true,
    detail: errs.length ? `${errs.length} lỗi: ${errs.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join(" · ")}` : `${c.fields} field · ${c.forms} form · ${c.lists} danh sách · ${c.pages} trang · ${c.roles} vai trò — hợp lệ.`,
    href: "/settings/data-model",
  };
}

async function checkWorkflows(): Promise<PublishCheck> {
  const rules = (await listRules()).filter((r) => r.status === "ACTIVE");
  const broken: string[] = [];
  for (const r of rules) {
    const v = await validateRuleInput({ id: r.id, key: r.key, name: r.name, description: r.description, trigger: r.trigger, conditions: r.conditions, actions: r.actions, gate: r.gate });
    if (!v.ok) broken.push(`«${r.name}»: ${v.errors[0]?.message ?? "không hợp lệ"}`);
  }
  return {
    key: "workflows",
    label: "Luật tự động đang bật",
    ok: broken.length === 0,
    blocking: true,
    detail: broken.length ? broken.slice(0, 3).join(" · ") : rules.length ? `${rules.length} luật đang bật, tham chiếu đều còn.` : "Chưa bật luật nào.",
    href: "/settings/workflows",
  };
}

async function checkPermissions(): Promise<PublishCheck> {
  const db = await getDb();
  const admins = await db.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.role, "ADMIN"), eq(schema.users.active, true)));
  return {
    key: "permissions",
    label: "Quyền quản trị",
    ok: admins.length > 0,
    blocking: true,
    detail: admins.length ? `${admins.length} quản trị đang hoạt động.` : "Không còn quản trị nào hoạt động — không ai quản lý được người dùng sau khi xuất bản.",
    href: "/settings/users",
  };
}

async function checkDomain(code: string): Promise<PublishCheck> {
  const pub = await publicationOf(code);
  if (!pub.slug) return { key: "domain", label: "Tên miền con", ok: false, blocking: true, detail: "Chưa chọn tên miền con.", href: "/setup#ten-mien" };
  const again = await checkDomainSlug(pub.slug, code);
  if (!again.ok) return { key: "domain", label: "Tên miền con", ok: false, blocking: true, detail: again.error, href: "/setup#ten-mien" };
  return {
    key: "domain",
    label: "Tên miền con",
    ok: true,
    blocking: true,
    detail: again.url ? `${again.url.replace(/^https?:\/\//, "")}` : `«${pub.slug}» — nền tảng chưa bật định tuyến theo tên miền con: ERP vẫn mở được bằng mã tổ chức.`,
    href: "/setup#ten-mien",
  };
}

async function checkProducts(): Promise<PublishCheck> {
  const db = await getDb();
  const [row] = await db.select({ id: schema.products.id }).from(schema.products).limit(1);
  return { key: "products", label: "Sản phẩm", ok: Boolean(row), blocking: false, detail: row ? "Đã có sản phẩm." : "Chưa có sản phẩm nào — nhập từ tệp ở Sản phẩm → Nhập từ tệp.", href: "/products/import" };
}

async function checkSetting(key: string): Promise<unknown> {
  const db = await getDb();
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, key)).limit(1);
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return null;
  }
}

async function checkChatbot(): Promise<PublishCheck> {
  const enabled = await getEnabledModules();
  if (!enabled.has("ai_sales")) return { key: "chatbot", label: "Chatbot bán hàng", ok: true, blocking: false, detail: "Module AI bán hàng đang tắt — bỏ qua.", href: "/settings/modules" };
  const cfg = (await checkSetting("ai.salesChatbot")) as { enabled?: boolean } | null;
  return { key: "chatbot", label: "Chatbot bán hàng", ok: Boolean(cfg?.enabled), blocking: false, detail: cfg?.enabled ? "Đã cấu hình và bật." : "Chưa cấu hình / chưa bật — trang chat công khai sẽ báo «chưa mở».", href: "/ai/sales-chatbot" };
}

async function checkMessaging(): Promise<PublishCheck> {
  const rules = (await listRules()).filter((r) => r.status === "ACTIVE" && r.mode === "LIVE" && r.actions.some((a) => a.kind === "send_message"));
  return { key: "messaging", label: "Báo nhóm vận hành", ok: rules.length > 0, blocking: false, detail: rules.length ? `${rules.length} luật gửi tin nhóm đang chạy thật.` : "Chưa có luật gửi tin nhóm — đơn chốt chỉ báo trong ERP.", href: "/settings/notifications" };
}

export async function publishChecklist(): Promise<{ checks: PublishCheck[]; ready: boolean; publication: Publication }> {
  const ctx = await currentOrganization();
  const checks = [await checkModules(), await checkMetadata(), await checkWorkflows(), await checkPermissions(), await checkDomain(ctx.code), await checkProducts(), await checkChatbot(), await checkMessaging()];
  return { checks, ready: checks.every((c) => c.ok || !c.blocking), publication: await publicationOf(ctx.code) };
}

/**
 * XUẤT BẢN: kiểm lại (không tin màn hình) → ghi trạng thái + mốc + người → xoá đệm sổ tổ chức / module / báo cáo →
 * nhật ký nền tảng + nhật ký tổ chức. Bấm lần hai khi đã xuất bản ⇒ không ghi gì thêm (mục 61).
 */
export async function publishOrganization(user: SessionUser): Promise<PublishResult> {
  if (!can(user, PUBLISH_PERMISSION)) return { ok: false, error: "Bạn không có quyền xuất bản ERP của tổ chức (settings:manage)." };
  const ctx = await currentOrganization();
  if (ctx.isHome) return { ok: false, error: "Tổ chức nhà luôn đang chạy — không có bước xuất bản." };
  const before = await publicationOf(ctx.code);
  if (before.state === "PUBLISHED") return { ok: true, publication: before, message: "ERP đã xuất bản từ trước — không làm gì thêm." };
  const { checks, ready } = await publishChecklist();
  if (!ready) return { ok: false, error: `Chưa xuất bản được: ${checks.filter((c) => c.blocking && !c.ok).map((c) => `${c.label} — ${c.detail}`).join(" · ")}`, checks };
  const now = new Date();
  const pdb = await getPlatformDb();
  const t = schema.platformOrganizations;
  const done = await pdb
    .update(t)
    .set({ publishState: "PUBLISHED", publishedAt: now, publishedBy: user.email, updatedAt: now })
    .where(and(eq(t.code, ctx.code), sql`${t.publishState} is distinct from 'PUBLISHED'`))
    .returning({ code: t.code });
  invalidateOrganizations();
  invalidateCapabilities(ctx.code);
  clearMemo();
  if (done.length === 0) return { ok: true, publication: await publicationOf(ctx.code), message: "ERP vừa được xuất bản bởi lượt khác." };
  const after = await publicationOf(ctx.code);
  await platformAudit({ action: "ORG_PUBLISH", targetOrgCode: ctx.code, subject: after.slug ?? ctx.code, before: { state: before.state }, after: { state: "PUBLISHED", slug: after.slug, url: after.url }, source: "UI", actor: actorOf(user, ctx.code) });
  await audit({ userId: user.id, userEmail: user.email, action: "ORG_PUBLISH", entity: "ORGANIZATION", entityId: ctx.code, before: { state: before.state }, after: { state: "PUBLISHED", slug: after.slug }, detail: { checks: checks.map((c) => ({ key: c.key, ok: c.ok })) } });
  return { ok: true, publication: after, message: after.url ? `Đã xuất bản — ERP chạy ở ${after.url.replace(/^https?:\/\//, "")}.` : "Đã xuất bản." };
}

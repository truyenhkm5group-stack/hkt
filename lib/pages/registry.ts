/**
 * ═══════════ SỔ TRANG TUỲ BIẾN CỦA TỔ CHỨC (Phase 4 · G1) — CHỈ MÁY CHỦ ═══════════
 *
 * Hợp đồng: docs/platform/phase-4-contracts.md mục 3. Khuôn: `lib/metadata/forms.ts` — NHÁP / ĐÃ XUẤT BẢN /
 * PHIÊN BẢN / ẢNH CHỤP / NHẬT KÝ, cùng kho `config-store` (ConfigKind `PAGE`, bảng `meta_pages`).
 *
 *  · Người dùng CHỈ thấy bản ĐÃ XUẤT BẢN (`getPageBySlug`). Lưu nháp không đổi gì người dùng thấy.
 *  · Slug `^[a-z][a-z0-9-]{1,60}$`, duy nhất trong tổ chức (chỉ mục duy nhất của CSDL tổ chức), BẤT BIẾN sau lần
 *    xuất bản đầu — liên kết đã gửi, mục menu, bộ đếm lượt mở đều trỏ vào nó.
 *  · Lưu nháp + xuất bản đều qua `validatePageSchema`. Lưu nháp hạ "module tắt" xuống cảnh báo; xuất bản
 *    CHẶN (G7) — kể cả module chủ của trang và module sở hữu quyền xem trang.
 *  · Mỗi lần xuất bản: `published_version + 1` + MỘT ảnh chụp bất biến `meta_config_versions` (kind `PAGE`)
 *    trong cùng giao dịch, khoá lạc quan; `audit()` trước/sau chạy SAU giao dịch (khoá chết PGlite, xem config-store).
 *  · `archivePage` ⇒ trang không mở được, rời menu. Dữ liệu không xoá.
 *
 * Tổ chức luôn là tổ chức của ngữ cảnh (`getDb()` chọn CSDL silo) — không hàm nào nhận mã tổ chức, nên id /
 * slug của tổ chức khác đơn giản là KHÔNG TỒN TẠI ở đây.
 *
 * Quyền `metadata:manage` kiểm ở lớp action của màn hình `/settings/pages` (`requirePermission` rồi kiểm lần
 * hai ở lõi màn hình — `pageAdminDenial` dưới đây là luật dùng chung). Tệp này là DỊCH VỤ: bài kiểm gọi thẳng với
 * một `MetadataActor`; mọi lượt ghi đều trả `page` để lớp trên không phải đọc lại.
 */
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { ALL_PERMISSIONS } from "@/lib/auth/permissions";
import { can, type SessionUser } from "@/lib/auth/session";
import { objectDef } from "@/lib/constants/object-registry";
import { ZONE_ORDER } from "@/lib/constants/department-modules";
import { MODULE_KEYS, moduleOfPermission, type ModuleKey } from "@/lib/constants/platform-modules";
import { auditActor, isUniqueViolation, loadCustomDefs } from "@/lib/metadata/common";
import { loadConfigRow, PAGE_CONFIG_OBJECT, publishConfig } from "@/lib/metadata/config-store";
import { MetadataError } from "@/lib/metadata/errors";
import type { MetadataActor } from "@/lib/metadata/types";
import { getEnabledModules } from "@/lib/platform/capabilities";
import { AGGREGATE_NUMERIC_TYPES, blockCountOf, catalogObject, customRefsOf, DATE_TYPES, EMPTY_PAGE_SCHEMA, GROUPABLE_TYPES, normalizePageSchema, PAGE_SLUG_PATTERN, validatePageSchema, type PageCatalog } from "@/lib/pages/components";
import { effectivePageCatalog } from "@/lib/pages/custom-sources";
import { buildTemplateSchema, templateSpec, type TemplateCustomField } from "@/lib/pages/templates";
import type { PageDefinition, PageNav, PageSchema, PageStatus } from "@/lib/pages/types";

// ═══ Kết quả ═══

export type PageErrorCode = "INVALID" | "NOT_FOUND" | "CONFLICT" | "MODULE_DISABLED" | "SLUG_TAKEN" | "SLUG_LOCKED" | "ARCHIVED";
export type PageIssue = { path: string; message: string };
/** `draftRevision`: chỉ có ở `CONFLICT` của lượt lưu nháp — revision HIỆN TẠI trong CSDL (bản của người lưu trước). */
export type PageFailure = { ok: false; code: PageErrorCode; errors: PageIssue[]; draftRevision?: number };

function pageFail(code: PageErrorCode, errors: PageIssue[] | string, path = ""): PageFailure {
  return { ok: false, code, errors: typeof errors === "string" ? [{ path, message: errors }] : errors };
}

/** Vì sao người này KHÔNG cấu hình được trang (`null` = được). Hỏng về phía hẹp. */
export function pageAdminDenial(user: SessionUser): string | null {
  if (!can(user, "metadata:manage")) return "Bạn không có quyền cấu hình trang tuỳ biến.";
  if (!user.organization) return "Phiên chưa gắn tổ chức — đăng nhập lại.";
  return null;
}

// ═══ Đầu vào ═══

const MODULE_SET: ReadonlySet<string> = new Set(MODULE_KEYS);
const PERMISSION_SET: ReadonlySet<string> = new Set(ALL_PERMISSIONS);
const ZONE_SET: ReadonlySet<string> = new Set(ZONE_ORDER);

const navZ = z.strictObject({
  enabled: z.boolean(),
  label: z.string().trim().max(60),
  zone: z
    .string()
    .nullable()
    .refine((v) => v === null || ZONE_SET.has(v), "Nhóm menu không có trong bản đồ phòng ban"),
  order: z.number().int().min(0).max(999),
});

const pageMetaZ = z.strictObject({
  slug: z.string().regex(PAGE_SLUG_PATTERN, "Đường dẫn chỉ gồm chữ thường, số, gạch nối; 2–61 ký tự, bắt đầu bằng chữ"),
  name: z.string().trim().min(1, "Cần tên trang").max(120),
  moduleKey: z.string().refine((v) => MODULE_SET.has(v), "Module không có trong sổ module"),
  requiredPermission: z
    .string()
    .nullable()
    .refine((v) => v === null || PERMISSION_SET.has(v), "Khoá quyền không có trong danh mục quyền"),
  nav: navZ,
});

export type PageMetaInput = { slug: string; name: string; moduleKey: ModuleKey; requiredPermission?: string | null; nav?: Partial<PageNav> };

const DEFAULT_NAV: PageNav = { enabled: false, label: "", zone: null, order: 0 };

function issuesOf(error: z.ZodError): PageIssue[] {
  return error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
}

// ═══ Đọc ═══

type PageRow = typeof schema.metaPages.$inferSelect;

function asNav(raw: unknown): PageNav {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    enabled: r.enabled === true,
    label: typeof r.label === "string" ? r.label : "",
    zone: typeof r.zone === "string" && ZONE_SET.has(r.zone) ? r.zone : null,
    order: typeof r.order === "number" && Number.isFinite(r.order) ? r.order : 0,
  };
}

function toDefinition(r: PageRow): PageDefinition {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    // Khoá lạ (dữ liệu gõ tay) giữ NGUYÊN: tập module đang bật không bao giờ chứa nó ⇒ trang không mở, không lên
    // menu — hỏng về phía hẹp. Thay bằng một khoá thật là đoán hộ và có thể mở trang cho người không nên thấy.
    moduleKey: r.moduleKey as ModuleKey,
    requiredPermission: r.requiredPermission ?? null,
    nav: asNav(r.nav),
    status: (r.status === "ARCHIVED" ? "ARCHIVED" : "ACTIVE") as PageStatus,
    publishedVersion: r.publishedVersion,
    publishedAt: r.publishedAt ?? null,
    publishedBy: r.publishedBy ?? null,
  };
}

function asSchema(raw: unknown): PageSchema {
  const r = raw as PageSchema | null | undefined;
  if (!r || r.version !== 1 || !Array.isArray(r.sections)) return EMPTY_PAGE_SCHEMA;
  return r;
}

async function loadRow(id: string): Promise<PageRow | null> {
  if (typeof id !== "string" || id.length === 0 || id.length > 200) return null;
  const db = await getDb();
  const t = schema.metaPages;
  const [r] = await db.select().from(t).where(eq(t.id, id)).limit(1);
  return r ?? null;
}

export async function listPages(opts: { includeArchived?: boolean } = {}): Promise<PageDefinition[]> {
  const db = await getDb();
  const t = schema.metaPages;
  const rows = await db
    .select()
    .from(t)
    .where(opts.includeArchived ? undefined : eq(t.status, "ACTIVE"))
    .orderBy(asc(t.name), asc(t.slug));
  return rows.map(toDefinition);
}

/**
 * BẢN ĐÃ XUẤT BẢN của trang theo slug — thứ duy nhất người dùng thấy. `null` khi: slug sai dạng, không có
 * trong tổ chức này, đã lưu trữ, hoặc chưa xuất bản lần nào.
 */
export async function getPageBySlug(slug: string): Promise<{ page: PageDefinition; schema: PageSchema } | null> {
  if (typeof slug !== "string" || !PAGE_SLUG_PATTERN.test(slug)) return null;
  const db = await getDb();
  const t = schema.metaPages;
  const [r] = await db.select().from(t).where(eq(t.slug, slug)).limit(1);
  if (!r || r.status !== "ACTIVE" || r.publishedVersion <= 0 || r.published === null || r.published === undefined) return null;
  return { page: toDefinition(r), schema: asSchema(r.published) };
}

/**
 * Bản nháp cho trình soạn / xem trước: nháp đã lưu → bản đã xuất bản → trang rỗng. Không có trang ⇒ ném `NOT_FOUND`.
 * `draftRevision` là số trình soạn gửi lại làm `baseRevision` ở lượt lưu kế tiếp (Phase 5 §2).
 */
export async function getPageDraft(id: string): Promise<{ page: PageDefinition; draft: PageSchema; draftRevision: number }> {
  const r = await loadRow(id);
  if (!r) throw new MetadataError("NOT_FOUND", "Không có trang này trong tổ chức.");
  return { page: toDefinition(r), draft: asSchema(r.draft ?? r.published ?? EMPTY_PAGE_SCHEMA), draftRevision: r.draftRevision };
}

/** Trang đã xuất bản, còn hoạt động, bật menu — nguyên liệu của menu động (lọc theo người xem ở `lib/pages/nav.ts`). */
export async function listNavPages(): Promise<PageDefinition[]> {
  const db = await getDb();
  const t = schema.metaPages;
  const rows = await db
    .select()
    .from(t)
    .where(and(eq(t.status, "ACTIVE"), ne(t.publishedVersion, 0)));
  return rows
    .map(toDefinition)
    .filter((p) => p.nav.enabled)
    .sort((a, b) => a.nav.order - b.nav.order || a.name.localeCompare(b.name, "vi"));
}

// ═══ Kiểm phụ thuộc cần CSDL ═══

/**
 * Field custom mà schema trỏ tới phải còn hoạt động; `statusField` của kanban phải là field kiểu trạng thái; field
 * tổng hợp phải là SỐ (field số tuỳ biến tổng hợp được mặc định — Phase 5); nhóm theo field chọn / trạng thái /
 * có-không / người dùng; mốc kỳ là field ngày.
 */
async function customRefProblems(s: PageSchema, catalog: PageCatalog): Promise<PageIssue[]> {
  const refs = customRefsOf(s);
  if (refs.length === 0) return [];
  const byObject = new Map<string, Awaited<ReturnType<typeof loadCustomDefs>>>();
  const out: PageIssue[] = [];
  for (const r of refs) {
    const def = catalogObject(r.objectKey, catalog);
    if (!def) continue; // validatePageSchema đã báo
    if (!def.capabilities.customFields) {
      out.push({ path: r.path, message: `${def.label} không có field custom.` });
      continue;
    }
    if (!byObject.has(r.objectKey)) byObject.set(r.objectKey, await loadCustomDefs(r.objectKey, false));
    const key = r.ref.slice("custom:".length);
    const f = byObject.get(r.objectKey)!.find((x) => x.key === key);
    if (!f) out.push({ path: r.path, message: `${def.label} không có field custom «${key}» đang hoạt động.` });
    else if (r.role === "status" && f.type !== "status") out.push({ path: r.path, message: `Field «${f.label}» không phải kiểu trạng thái — kanban chỉ chạy trên field trạng thái.` });
    else if (r.role === "filter" && !f.filterable) out.push({ path: r.path, message: `Field «${f.label}» không bật lọc.` });
    else if (r.role === "aggregate" && !AGGREGATE_NUMERIC_TYPES.has(f.type)) out.push({ path: r.path, message: `Field «${f.label}» không phải số — chỉ đếm được.` });
    else if (r.role === "group" && !GROUPABLE_TYPES.has(f.type)) out.push({ path: r.path, message: `Field «${f.label}» không nhóm được — chỉ field chọn / trạng thái / có-không / người dùng.` });
    else if (r.role === "date" && !DATE_TYPES.has(f.type)) out.push({ path: r.path, message: `Field «${f.label}» không phải ngày / ngày giờ.` });
  }
  return out;
}

/** G7 cho chính TRANG: module chủ + module sở hữu quyền xem phải bật. */
function pageModuleProblems(page: Pick<PageDefinition, "moduleKey" | "requiredPermission">, modules: ReadonlySet<ModuleKey>): PageIssue[] {
  const out: PageIssue[] = [];
  if (!modules.has(page.moduleKey)) out.push({ path: "moduleKey", message: `Module chủ «${page.moduleKey}» của trang đang TẮT với tổ chức.` });
  const owner = page.requiredPermission ? moduleOfPermission(page.requiredPermission) : null;
  if (owner && !modules.has(owner)) out.push({ path: "requiredPermission", message: `Quyền «${page.requiredPermission}» thuộc module «${owner}» đang TẮT — không ai mở được trang.` });
  return out;
}

// ═══ Ghi ═══

/**
 * `baseRevision` (chỉ lượt lưu nháp): revision trình soạn đã đọc. Có và lệch revision hiện tại ⇒ `CONFLICT`, không
 * ghi gì. Không truyền ⇒ hành vi Phase 4 (trình soạn cũ lưu đè) — nhưng revision vẫn tăng, để trình kéo-thả đang
 * mở cùng trang biết có người vừa lưu.
 */
export type PageWriteOptions = { catalog?: PageCatalog; baseRevision?: number };

export async function createPage(
  input: PageMetaInput & { draft?: unknown },
  actor: MetadataActor,
  opts: PageWriteOptions = {},
): Promise<{ ok: true; page: PageDefinition; warnings: PageIssue[] } | PageFailure> {
  const raw = (input ?? {}) as Partial<PageMetaInput> & { draft?: unknown };
  const parsed = pageMetaZ.safeParse({
    slug: raw.slug,
    name: raw.name,
    moduleKey: raw.moduleKey,
    requiredPermission: raw.requiredPermission ?? null,
    nav: { ...DEFAULT_NAV, ...(raw.nav ?? {}) },
  });
  if (!parsed.success) return pageFail("INVALID", issuesOf(parsed.error));
  const meta = parsed.data;
  const modules = await getEnabledModules();
  if (!modules.has(meta.moduleKey as ModuleKey)) return pageFail("MODULE_DISABLED", `Module «${meta.moduleKey}» đang tắt với tổ chức — bật module trước khi tạo trang của nó.`, "moduleKey");

  let draft: PageSchema = EMPTY_PAGE_SCHEMA;
  let warnings: PageIssue[] = [];
  if (raw.draft !== undefined) {
    const catalog = opts.catalog ?? (await effectivePageCatalog());
    const v = validatePageSchema(raw.draft, { modules, catalog, moduleIssues: "warning" });
    if (!v.ok) return pageFail("INVALID", v.errors);
    draft = normalizePageSchema(raw.draft, { modules, catalog })!;
    const custom = await customRefProblems(draft, catalog);
    if (custom.length > 0) return pageFail("INVALID", custom);
    warnings = v.warnings;
  }
  const nav: PageNav = { ...meta.nav, label: meta.nav.label || meta.name };
  const db = await getDb();
  let row: PageRow;
  try {
    [row] = await db
      .insert(schema.metaPages)
      .values({ slug: meta.slug, name: meta.name, moduleKey: meta.moduleKey, requiredPermission: meta.requiredPermission, nav, draft, createdBy: actor.id, updatedBy: actor.id })
      .returning();
  } catch (error) {
    if (isUniqueViolation(error)) return pageFail("SLUG_TAKEN", `Đường dẫn /p/${meta.slug} đã có trang khác dùng (kể cả trang đã lưu trữ).`, "slug");
    throw error;
  }
  const page = toDefinition(row);
  await audit({ ...auditActor(actor), action: "META_PAGE_CREATE", entity: "META_PAGE", entityId: page.id, before: null, after: { slug: page.slug, name: page.name, moduleKey: page.moduleKey, requiredPermission: page.requiredPermission, nav: page.nav, draft } });
  return { ok: true, page, warnings };
}

/** Sửa tên / slug / module chủ / quyền xem / menu. Slug chỉ đổi được khi CHƯA xuất bản lần nào. Menu có hiệu lực ngay (không qua xuất bản). */
export async function updatePageMeta(id: string, input: Partial<PageMetaInput>, actor: MetadataActor): Promise<{ ok: true; page: PageDefinition } | PageFailure> {
  const r = await loadRow(id);
  if (!r) return pageFail("NOT_FOUND", "Không có trang này trong tổ chức.");
  if (r.status === "ARCHIVED") return pageFail("ARCHIVED", "Trang đã lưu trữ — không sửa được.");
  const before = toDefinition(r);
  const patch = (input ?? {}) as Partial<PageMetaInput>;
  const parsed = pageMetaZ.safeParse({
    slug: patch.slug ?? before.slug,
    name: patch.name ?? before.name,
    moduleKey: patch.moduleKey ?? before.moduleKey,
    requiredPermission: patch.requiredPermission === undefined ? before.requiredPermission : patch.requiredPermission,
    nav: { ...before.nav, ...(patch.nav ?? {}) },
  });
  if (!parsed.success) return pageFail("INVALID", issuesOf(parsed.error));
  const next = parsed.data;
  if (next.slug !== before.slug && before.publishedVersion > 0) return pageFail("SLUG_LOCKED", "Đường dẫn đã cố định từ lần xuất bản đầu — liên kết đã gửi và mục menu đang trỏ vào nó.", "slug");
  if (next.moduleKey !== before.moduleKey && !(await getEnabledModules()).has(next.moduleKey as ModuleKey)) return pageFail("MODULE_DISABLED", `Module «${next.moduleKey}» đang tắt với tổ chức.`, "moduleKey");
  const nav: PageNav = { ...next.nav, label: next.nav.label || next.name };
  const db = await getDb();
  const t = schema.metaPages;
  let row: PageRow | undefined;
  try {
    [row] = await db
      .update(t)
      .set({ slug: next.slug, name: next.name, moduleKey: next.moduleKey, requiredPermission: next.requiredPermission, nav, updatedBy: actor.id, updatedAt: new Date() })
      // Khoá lạc quan trên SLUG: hai người cùng xuất bản / đổi slug cùng lúc không làm slug trượt sau lần xuất bản đầu.
      .where(and(eq(t.id, id), eq(t.status, "ACTIVE"), next.slug !== before.slug ? eq(t.publishedVersion, 0) : undefined))
      .returning();
  } catch (error) {
    if (isUniqueViolation(error)) return pageFail("SLUG_TAKEN", `Đường dẫn /p/${next.slug} đã có trang khác dùng.`, "slug");
    throw error;
  }
  if (!row) return pageFail("CONFLICT", "Trang vừa được người khác xuất bản hoặc lưu trữ — tải lại rồi thử lại.");
  const page = toDefinition(row);
  const pick = (p: PageDefinition) => ({ slug: p.slug, name: p.name, moduleKey: p.moduleKey, requiredPermission: p.requiredPermission, nav: p.nav });
  await audit({ ...auditActor(actor), action: "META_PAGE_UPDATE", entity: "META_PAGE", entityId: id, before: pick(before), after: pick(page) });
  return { ok: true, page };
}

export async function savePageDraft(
  id: string,
  schemaInput: unknown,
  actor: MetadataActor,
  opts: PageWriteOptions = {},
): Promise<{ ok: true; page: PageDefinition; draft: PageSchema; warnings: PageIssue[]; draftRevision: number } | PageFailure> {
  const r = await loadRow(id);
  if (!r) return pageFail("NOT_FOUND", "Không có trang này trong tổ chức.");
  if (r.status === "ARCHIVED") return pageFail("ARCHIVED", "Trang đã lưu trữ — không sửa được.");
  const base = opts.baseRevision;
  if (base !== undefined && (!Number.isInteger(base) || base < 0)) return pageFail("INVALID", "baseRevision phải là số nguyên không âm.", "baseRevision");
  if (base !== undefined && base !== r.draftRevision) return revisionConflict(r.draftRevision);
  const modules = await getEnabledModules();
  const catalog = opts.catalog ?? (await effectivePageCatalog());
  const v = validatePageSchema(schemaInput, { modules, catalog, moduleIssues: "warning" });
  if (!v.ok) return pageFail("INVALID", v.errors);
  const draft = normalizePageSchema(schemaInput, { modules, catalog })!;
  const custom = await customRefProblems(draft, catalog);
  if (custom.length > 0) return pageFail("INVALID", custom);
  const page = toDefinition(r);
  // So theo NỘI DUNG (khoá xếp thứ tự): jsonb của Postgres tự sắp lại khoá, so chuỗi thô thì không bao giờ bằng.
  if (stableJson(r.draft ?? null) === stableJson(draft)) return { ok: true, page, draft, warnings: v.warnings, draftRevision: r.draftRevision };
  // Ghi CÓ ĐIỀU KIỆN trên revision đã đọc: hai người cùng lưu từ cùng một revision ⇒ đúng một người thắng, người kia
  // nhận CONFLICT (kể cả khi cả hai đã qua phép so ở trên cùng lúc).
  const db = await getDb();
  const t = schema.metaPages;
  const expected = base ?? r.draftRevision;
  const [row] = await db
    .update(t)
    .set({ draft, draftRevision: sql`${t.draftRevision} + 1`, updatedBy: actor.id, updatedAt: new Date() })
    .where(and(eq(t.id, id), eq(t.status, "ACTIVE"), eq(t.draftRevision, expected)))
    .returning({ draftRevision: t.draftRevision });
  if (!row) {
    const now = await loadRow(id);
    if (!now || now.status === "ARCHIVED") return pageFail("ARCHIVED", "Trang vừa bị lưu trữ — không sửa được.");
    return revisionConflict(now.draftRevision);
  }
  await audit({ ...auditActor(actor), action: "META_PAGE_DRAFT_SAVE", entity: "META_PAGE", entityId: id, before: r.draft ?? null, after: draft });
  return { ok: true, page, draft, warnings: v.warnings, draftRevision: row.draftRevision };
}

/** JSON với khoá object xếp thứ tự — hai bản cùng nội dung ra cùng một chuỗi dù đi qua jsonb. */
function stableJson(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(sort) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x as Record<string, unknown>).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])])) : x;
  return JSON.stringify(sort(v));
}

function revisionConflict(current: number): PageFailure {
  return { ...pageFail("CONFLICT", "Người khác vừa lưu bản nháp của trang này — tải bản của họ hoặc ghi đè (xác nhận).", "baseRevision"), draftRevision: current };
}

export async function publishPage(id: string, actor: MetadataActor, opts: PageWriteOptions = {}): Promise<{ ok: true; page: PageDefinition; schema: PageSchema; version: number } | PageFailure> {
  const r = await loadRow(id);
  if (!r) return pageFail("NOT_FOUND", "Không có trang này trong tổ chức.");
  if (r.status === "ARCHIVED") return pageFail("ARCHIVED", "Trang đã lưu trữ — không xuất bản được.");
  const page = toDefinition(r);
  const row = await loadConfigRow("PAGE", PAGE_CONFIG_OBJECT, id);
  if (!row || row.draft === null || row.draft === undefined) return pageFail("INVALID", "Chưa có bản nháp để xuất bản.", "draft");

  const modules = await getEnabledModules();
  const pageProblems = pageModuleProblems(page, modules);
  if (pageProblems.length > 0) return pageFail("MODULE_DISABLED", pageProblems);
  // Xuất bản: module tắt là LỖI CHẶN (G7), không phải cảnh báo.
  const catalog = opts.catalog ?? (await effectivePageCatalog());
  const v = validatePageSchema(row.draft, { modules, catalog, moduleIssues: "error" });
  if (!v.ok) return pageFail("INVALID", v.errors);
  const schemaOut = normalizePageSchema(row.draft, { modules, catalog })!;
  if (blockCountOf(schemaOut) === 0) return pageFail("INVALID", "Trang chưa có khối nào — không có gì để người dùng mở.", "sections");
  const custom = await customRefProblems(schemaOut, catalog);
  if (custom.length > 0) return pageFail("INVALID", custom);

  // Ảnh chụp mang cả phần mô tả trang LÚC xuất bản: slug / module / quyền / menu có thể đổi sau.
  const snapshot = { page: { slug: page.slug, name: page.name, moduleKey: page.moduleKey, requiredPermission: page.requiredPermission, nav: page.nav }, schema: schemaOut };
  const version = await publishConfig("PAGE", PAGE_CONFIG_OBJECT, id, schemaOut, row.publishedVersion, snapshot, actor);
  if (version === null) return pageFail("CONFLICT", "Trang vừa được người khác xuất bản hoặc lưu trữ — tải lại rồi thử lại.");
  await audit({
    ...auditActor(actor),
    action: "META_PAGE_PUBLISH",
    entity: "META_PAGE",
    entityId: id,
    before: { version: row.publishedVersion, schema: row.published ?? null },
    after: { version, schema: schemaOut },
  });
  const after = await loadRow(id);
  return { ok: true, page: after ? toDefinition(after) : { ...page, publishedVersion: version }, schema: schemaOut, version };
}

/** Lưu trữ: trang không mở được và rời menu. Không xoá dữ liệu, không xoá ảnh chụp phiên bản. */
export async function archivePage(id: string, actor: MetadataActor): Promise<{ ok: true; page: PageDefinition } | PageFailure> {
  const r = await loadRow(id);
  if (!r) return pageFail("NOT_FOUND", "Không có trang này trong tổ chức.");
  if (r.status === "ARCHIVED") return { ok: true, page: toDefinition(r) };
  const db = await getDb();
  const t = schema.metaPages;
  const [row] = await db
    .update(t)
    .set({ status: "ARCHIVED", updatedBy: actor.id, updatedAt: new Date() })
    .where(and(eq(t.id, id), eq(t.status, "ACTIVE")))
    .returning();
  if (!row) return pageFail("CONFLICT", "Trang vừa đổi trạng thái — tải lại rồi thử lại.");
  await audit({ ...auditActor(actor), action: "META_PAGE_ARCHIVE", entity: "META_PAGE", entityId: id, before: { status: "ACTIVE", slug: r.slug }, after: { status: "ARCHIVED", slug: r.slug } });
  return { ok: true, page: toDefinition(row) };
}

// ═══ Tạo từ mẫu — CHỈ khi người bấm (luật 23) ═══

/**
 * Tạo một trang NHÁP từ mẫu (`lib/pages/templates.ts`). Không xuất bản: người dùng chưa thấy gì cho tới khi
 * quản trị xem trước rồi bấm xuất bản. Khối mà sổ / module / field custom của tổ chức chưa có bị bỏ, và danh
 * sách `skipped` đi về màn hình nguyên văn.
 */
export async function createPageFromTemplate(
  templateKey: string,
  actor: MetadataActor,
  input: { slug?: string; name?: string } = {},
  opts: PageWriteOptions = {},
): Promise<{ ok: true; page: PageDefinition; skipped: { blockId: string; reason: string }[]; warnings: PageIssue[] } | PageFailure> {
  const spec = templateSpec(templateKey);
  if (!spec) return pageFail("NOT_FOUND", `Không có mẫu «${String(templateKey)}».`, "template");
  const modules = await getEnabledModules();
  if (!modules.has(spec.moduleKey)) return pageFail("MODULE_DISABLED", `Mẫu «${spec.name}» cần module «${spec.moduleKey}» — module đang tắt với tổ chức.`, "template");
  const catalog = opts.catalog ?? (await effectivePageCatalog());
  // Field custom mẫu cần: của khách hàng + của mọi đối tượng tuỳ biến trong sổ (mẫu "Bàn làm việc khách hàng" gợi ý
  // bảng của đối tượng tuỳ biến — ưu tiên đối tượng có field liên kết tới khách).
  const objectKeys = [...(objectDef("customer")?.capabilities.customFields ? ["customer"] : []), ...(catalog.objects ?? []).filter((o) => !o.system).map((o) => o.key)];
  const customFields: TemplateCustomField[] = (await Promise.all(objectKeys.map((k) => loadCustomDefs(k, false)))).flat().map((f) => ({ objectKey: f.objectKey, key: f.key, label: f.label, type: f.type, listable: f.listable, relationObject: f.relationObject }));
  const built = buildTemplateSchema(spec.key, { catalog, modules, customFields });
  const created = await createPage(
    { slug: input.slug ?? spec.slug, name: input.name ?? spec.name, moduleKey: spec.moduleKey, requiredPermission: null, nav: { enabled: false, label: input.name ?? spec.name, zone: null, order: 0 }, draft: built.schema },
    actor,
    { catalog },
  );
  if (!created.ok) return created;
  return { ok: true, page: created.page, skipped: built.skipped, warnings: created.warnings };
}

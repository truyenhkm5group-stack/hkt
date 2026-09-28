import { eq, inArray } from "drizzle-orm";
import { getDb, schema as dbSchema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { PERMISSION_LABEL } from "@/lib/auth/permissions";
import { ZONE_LABEL, ZONE_ORDER } from "@/lib/constants/department-modules";
import { OBJECT_REGISTRY } from "@/lib/constants/object-registry";
import { PLATFORM_MODULES, PLATFORM_PERMISSION_KEYS, isModuleKey, moduleOfPermission } from "@/lib/constants/platform-modules";
import { formatDateTime } from "@/lib/format";
import { MetadataError } from "@/lib/metadata/errors";
import { listFields } from "@/lib/metadata/fields";
import type { MetadataActor } from "@/lib/metadata/types";
import { listDataSources } from "@/lib/pages/data-sources";
import { archivePage, createPage, createPageFromTemplate, getPageBySlug, getPageDraft, listPages, pageAdminDenial, publishPage, savePageDraft, updatePageMeta, type PageFailure } from "@/lib/pages/registry";
import { templateSpec, templates } from "@/lib/pages/templates";
import type { PageDefinition, PageSchema } from "@/lib/pages/types";
import { checkEntitlement } from "@/lib/entitlements/check";
import { buildCatalog } from "@/lib/platform-ui/metadata-admin-shared";
import { moduleOn } from "@/lib/platform-ui/module-visibility";
import { blankSchema, suggestSlug, type PageEditorCatalog, type PageMetaInput, type PageMetaOptions, type PageObjectOption, type PagePathError, type PageWriteResult } from "@/lib/platform-ui/page-admin-shared";
import { PERIOD_OPTIONS } from "@/lib/search-params";
import { PAGE_PERIODS } from "@/lib/pages/components";

/**
 * ═══════════ LÕI CỦA TRÌNH SOẠN TRANG TUỲ BIẾN (Phase 4) ═══════════
 *
 * `/settings/pages`, `/settings/pages/new` và `/settings/pages/[id]` đọc qua các hàm `load*` ở đây; MỘT lớp server
 * action (`lib/actions/page-admin.ts`) gọi các hàm `admin*` ở đây. Tệp THƯỜNG (không "use server") để bộ kiểm thử
 * chạy ngoài Next gọi được với một `SessionUser` dựng tay — cùng mẫu với `metadata-admin.ts`, `workflow-admin.ts`.
 *
 * Mỗi lượt: kiểm quyền LẦN HAI (`metadata:manage` — lần một là `requirePermission` của trang / action), phiên phải
 * mang tổ chức ⇒ rồi mới gọi dịch vụ `lib/pages/*` — nơi DUY NHẤT ghi `meta_pages`. Giao diện KHÔNG đọc bảng
 * `meta_pages` trực tiếp. Câu lỗi của dịch vụ (kể cả `validatePageSchema`) đi NGUYÊN VĂN về màn hình kèm `path`.
 *
 * Tổ chức luôn là tổ chức CỦA NGƯỜI XEM (`getDb()` chọn theo ngữ cảnh phiên): không tham số nào nhận mã tổ chức.
 * Cấu hình trang KHÔNG phải ranh giới an ninh (G4, G8): lõi này chỉ gác AI được SỬA trang; ai được XEM dữ liệu của
 * từng khối do trình phân giải kiểm theo người xem ở mỗi lượt đọc.
 */

type Denied = { ok: false; errors: PagePathError[] };
type Loaded<T> = { ok: true; value: T } | Denied;

function denied(message: string, path = "_"): Denied {
  return { ok: false, errors: [{ path, message }] };
}

/** Người thao tác — lấy từ PHIÊN (luật 34), không nhận từ client. */
export function pageActorOf(user: SessionUser): MetadataActor {
  return { id: user.id, email: user.email, permissions: user.permissions, isAdmin: user.role === "ADMIN" };
}

/** Luật "ai được soạn trang" có MỘT chỗ: `lib/pages/registry.ts` — lõi màn hình dùng lại, không khai bản thứ hai. */
export { pageAdminDenial };

export type PageTemplateOption = { key: string; name: string; description: string };

type ServiceWrite = { ok: true; page: PageDefinition; warnings?: PagePathError[]; skipped?: { blockId: string; reason: string }[] } | PageFailure;

/** Kết quả dịch vụ ⇒ kết quả màn hình. Lỗi (kể cả `validatePageSchema`) giữ NGUYÊN câu và `path`. */
function toResult(r: ServiceWrite): PageWriteResult {
  if (r.ok) {
    const skipped = (r.skipped ?? []).map((x) => ({ path: x.blockId, message: `Khối mẫu «${x.blockId}» bị bỏ: ${x.reason}` }));
    return { ok: true, id: r.page.id, notes: [...(r.warnings ?? []), ...skipped] };
  }
  return r.errors.length ? { ok: false, errors: r.errors } : denied(`Không lưu được trang (${r.code}).`);
}

/** Lượt ĐỌC của dịch vụ ném `MetadataError` (trang lạ, module tắt) — đổi thành lời từ chối đọc được. */
async function reading<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | Denied> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (error instanceof MetadataError) return denied(error.message);
    throw error;
  }
}

// ═══════════ ĐỌC ═══════════

/** Một dòng của bảng trang — ngày giờ đã định dạng giờ VN (client không tự đổi múi). */
export type PageListRow = {
  id: string;
  name: string;
  slug: string;
  moduleKey: string;
  moduleLabel: string;
  status: PageDefinition["status"];
  publishedVersion: number;
  publishedAt: string | null;
  nav: PageDefinition["nav"];
};

function moduleLabel(key: string): string {
  return PLATFORM_MODULES.find((m) => m.key === key)?.label ?? key;
}

export async function loadPageList(user: SessionUser): Promise<Loaded<{ pages: PageListRow[]; templates: PageTemplateOption[] }>> {
  const denial = pageAdminDenial(user);
  if (denial) return denied(denial);
  const pages = await listPages({ includeArchived: true });
  const rows = pages.map<PageListRow>((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    moduleKey: p.moduleKey,
    moduleLabel: moduleLabel(p.moduleKey),
    status: p.status,
    publishedVersion: p.publishedVersion,
    publishedAt: p.publishedAt ? formatDateTime(p.publishedAt) : null,
    nav: p.nav,
  }));
  // Trang đang dùng trước, lưu trữ xuống cuối; trong mỗi nhóm theo tên.
  rows.sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name, "vi") : a.status === "ACTIVE" ? -1 : 1));
  return { ok: true, value: { pages: rows, templates: pageTemplates(user) } };
}

/** Mẫu dùng được với tổ chức này: module chủ của mẫu phải đang bật (máy chủ kiểm lại khi tạo). */
function pageTemplates(user: SessionUser): PageTemplateOption[] {
  return templates().filter((t) => {
    const spec = templateSpec(t.key);
    return spec !== null && moduleOn(user, spec.moduleKey);
  });
}

/**
 * Sổ cho trình soạn: nguồn số liệu / chuỗi / danh sách / nhật ký / action mà NGƯỜI SOẠN dùng được (module đang bật +
 * quyền của chính họ — `listDataSources`, cùng luật với trình phân giải: không ghép vào trang một số mình không được
 * xem), và danh mục field của từng đối tượng (bảng, lọc, kanban, form). Đối tượng mà dịch vụ metadata từ chối đọc
 * (module vừa tắt) bị bỏ, không làm hỏng cả trang. Lọc ở đây là UX — máy chủ kiểm lại khi lưu và khi xuất bản (G7).
 */
export async function pageEditorCatalog(user: SessionUser): Promise<PageEditorCatalog> {
  const sources = listDataSources(user);
  const objectKeys = OBJECT_REGISTRY.filter((o) => moduleOn(user, o.module)).map((o) => o.key);
  const objects = await Promise.all(
    objectKeys.map(async (key): Promise<PageObjectOption | null> => {
      const def = OBJECT_REGISTRY.find((o) => o.key === key);
      if (!def) return null;
      try {
        const fields = await listFields(key);
        return { key, label: def.label, catalog: buildCatalog(fields.system, fields.custom), forms: def.capabilities.forms ? def.forms.map((f) => ({ ...f })) : [] };
      } catch (error) {
        if (error instanceof MetadataError) return null;
        throw error;
      }
    }),
  );
  return {
    metrics: sources.metrics.map((x) => ({ ...x, periods: [...x.periods] })),
    series: sources.series.map((x) => ({ ...x, kinds: [...x.kinds], periods: [...x.periods] })),
    lists: sources.lists.map((x) => ({ ...x })),
    timelines: sources.timelines.map((x) => ({ ...x })),
    actions: sources.actions.map((x) => ({ ...x })),
    objects: objects.filter((o): o is PageObjectOption => o !== null),
    // Kỳ khối nhận được = đúng tập `validatePageSchema` nhận (không có "tuỳ chọn": khối không có ô ngày).
    periods: PAGE_PERIODS.map((value) => ({ value, label: PERIOD_OPTIONS.find((p) => p.value === value)?.label ?? value })),
  };
}

/** Ô chọn của phần thông tin trang: module ĐANG BẬT, quyền thuộc module đang bật (hoặc của nền tảng), nhóm menu. */
export function pageMetaOptions(user: SessionUser): PageMetaOptions {
  const modules = PLATFORM_MODULES.filter((m) => moduleOn(user, m.key)).map((m) => ({ key: m.key, label: m.label }));
  const platform = new Set<string>(PLATFORM_PERMISSION_KEYS);
  const permissions = Object.keys(PERMISSION_LABEL)
    .filter((p) => {
      if (platform.has(p)) return true;
      const owner = moduleOfPermission(p);
      return owner === null || moduleOn(user, owner);
    })
    .map((p) => ({ key: p, label: PERMISSION_LABEL[p] ?? p }));
  const zones = [{ key: "", label: "Trang tuỳ biến" }, ...ZONE_ORDER.map((z) => ({ key: z, label: ZONE_LABEL[z] }))];
  return { modules, permissions, zones };
}

/** Trang đang soạn, ở dạng truyền được sang client (ngày đã định dạng, người xuất bản đã đọc thành tên). */
export type PageEditorPage = {
  id: string;
  name: string;
  slug: string;
  moduleKey: PageDefinition["moduleKey"];
  requiredPermission: string | null;
  nav: PageDefinition["nav"];
  status: PageDefinition["status"];
  publishedVersion: number;
  publishedAt: string | null;
  publishedBy: string | null;
};

export type PageEditorView = {
  /** `null` = đang tạo trang mới. */
  page: PageEditorPage | null;
  draft: PageSchema;
  /** Bản ĐÃ XUẤT BẢN — `null` khi chưa xuất bản lần nào (hoặc trang đã lưu trữ). */
  published: PageSchema | null;
  takenSlugs: string[];
  options: PageMetaOptions;
  catalog: PageEditorCatalog;
};

/** Tên người xuất bản: đọc `users` của tổ chức theo KHOÁ (luật 34); không có ⇒ in khoá, không đoán. */
async function userNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const db = await getDb();
  const rows = await db.select({ id: dbSchema.users.id, name: dbSchema.users.name, email: dbSchema.users.email }).from(dbSchema.users).where(ids.length === 1 ? eq(dbSchema.users.id, ids[0]) : inArray(dbSchema.users.id, ids));
  return new Map(rows.map((r) => [r.id, r.name || r.email]));
}

export async function loadPageEditor(user: SessionUser, id: string | null): Promise<Loaded<PageEditorView>> {
  const denial = pageAdminDenial(user);
  if (denial) return denied(denial);
  const [pages, catalog] = await Promise.all([listPages({ includeArchived: true }), pageEditorCatalog(user)]);
  const options = pageMetaOptions(user);
  if (id === null) return { ok: true, value: { page: null, draft: blankSchema(), published: null, takenSlugs: pages.map((p) => p.slug), options, catalog } };
  const loaded = await reading(() => getPageDraft(id));
  if (!loaded.ok) return loaded;
  const { page } = loaded.value;
  // Trang vừa tạo có nháp RỖNG (0 nhóm): trình soạn mở với một nhóm trống để có chỗ thêm khối. Chưa lưu thì chưa ghi gì.
  const draft = loaded.value.draft.sections.length > 0 ? loaded.value.draft : blankSchema();
  const [live, names] = await Promise.all([
    page.publishedVersion > 0 && page.status === "ACTIVE" ? getPageBySlug(page.slug) : Promise.resolve(null),
    userNames(page.publishedBy ? [page.publishedBy] : []),
  ]);
  const view: PageEditorPage = {
    id: page.id,
    name: page.name,
    slug: page.slug,
    moduleKey: page.moduleKey,
    requiredPermission: page.requiredPermission,
    nav: page.nav,
    status: page.status,
    publishedVersion: page.publishedVersion,
    publishedAt: page.publishedAt ? formatDateTime(page.publishedAt) : null,
    publishedBy: page.publishedBy ? (names.get(page.publishedBy) ?? page.publishedBy) : null,
  };
  return { ok: true, value: { page: view, draft, published: live?.schema ?? null, takenSlugs: pages.filter((p) => p.id !== page.id).map((p) => p.slug), options, catalog } };
}

// ═══════════ GHI ═══════════

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Hình tối thiểu của thông tin trang trước khi tới dịch vụ; module chủ phải ĐANG BẬT với tổ chức người bấm
 * ("chỉ module đang bật" — dịch vụ kiểm lại theo CSDL). Dịch vụ là lời cuối cho slug trùng / quyền lạ.
 */
function metaInput(user: SessionUser, input: unknown): { ok: true; value: PageMetaInput } | Denied {
  if (!isRecord(input)) return denied("Thông tin trang không hợp lệ.");
  const moduleKey = typeof input.moduleKey === "string" ? input.moduleKey : "";
  if (!isModuleKey(moduleKey)) return denied(`Module «${moduleKey}» không có trong sổ module.`, "moduleKey");
  if (!moduleOn(user, moduleKey)) return denied(`Module «${moduleLabel(moduleKey)}» đang tắt với tổ chức — trang chỉ gắn được vào module đang bật.`, "moduleKey");
  const nav = isRecord(input.nav) ? input.nav : {};
  return {
    ok: true,
    value: {
      name: typeof input.name === "string" ? input.name : "",
      slug: typeof input.slug === "string" ? input.slug : "",
      moduleKey,
      requiredPermission: typeof input.requiredPermission === "string" && input.requiredPermission.trim() ? input.requiredPermission.trim() : null,
      nav: {
        enabled: nav.enabled === true,
        label: typeof nav.label === "string" ? nav.label : "",
        zone: typeof nav.zone === "string" && nav.zone ? nav.zone : null,
        order: typeof nav.order === "number" && Number.isFinite(nav.order) ? nav.order : 100,
      },
    },
  };
}

function pageId(id: unknown): string | null {
  return typeof id === "string" && id.trim() ? id : null;
}

/** Tạo trang — sinh ở NHÁP (chưa xuất bản, người dùng chưa thấy gì). */
export async function adminCreatePage(user: SessionUser, input: unknown): Promise<PageWriteResult> {
  const denial = pageAdminDenial(user);
  if (denial) return denied(denial);
  const meta = metaInput(user, input);
  if (!meta.ok) return meta;
  const ent = await checkEntitlement("pages", 1);
  if (!ent.ok) return denied(ent.error);
  return toResult(await createPage(meta.value, pageActorOf(user)));
}

/** Tạo trang từ mẫu — chỉ khi NGƯỜI bấm (luật 23), trang sinh ở NHÁP. */
export async function adminCreatePageFromTemplate(user: SessionUser, templateKey: unknown): Promise<PageWriteResult> {
  const denial = pageAdminDenial(user);
  if (denial) return denied(denial);
  const key = typeof templateKey === "string" ? templateKey : "";
  const spec = templateSpec(key);
  if (!spec) return denied(`Không có mẫu trang «${key}».`, "template");
  // Mẫu mang slug đề xuất; bấm lần hai (hoặc slug đã có trang dùng) thì lấy slug trống kế tiếp — không bắt người bấm
  // đi đổi tay một thứ họ chưa từng gõ. Dịch vụ vẫn là lời cuối (chỉ mục duy nhất ⇒ SLUG_TAKEN).
  const taken = new Set((await listPages({ includeArchived: true })).map((p) => p.slug));
  const ent = await checkEntitlement("pages", 1);
  if (!ent.ok) return denied(ent.error);
  return toResult(await createPageFromTemplate(spec.key, pageActorOf(user), { slug: suggestSlug(spec.slug, taken) }));
}

export async function adminUpdatePageMeta(user: SessionUser, id: unknown, input: unknown): Promise<PageWriteResult> {
  const denial = pageAdminDenial(user);
  if (denial) return denied(denial);
  const pid = pageId(id);
  if (!pid) return denied("Thiếu mã trang.");
  const meta = metaInput(user, input);
  if (!meta.ok) return meta;
  return toResult(await updatePageMeta(pid, meta.value, pageActorOf(user)));
}

/** Lưu NHÁP nội dung — dịch vụ chạy `validatePageSchema` trước khi ghi; người dùng chưa thấy gì. */
export async function adminSavePageDraft(user: SessionUser, id: unknown, schema: unknown): Promise<PageWriteResult> {
  const denial = pageAdminDenial(user);
  if (denial) return denied(denial);
  const pid = pageId(id);
  if (!pid) return denied("Thiếu mã trang.");
  if (!isRecord(schema) || !Array.isArray(schema.sections)) return denied("Nội dung trang không hợp lệ.", "sections");
  return toResult(await savePageDraft(pid, schema as PageSchema, pageActorOf(user)));
}

/** Xuất bản bản NHÁP ĐÃ LƯU — có hiệu lực ở lần tải kế tiếp, không deploy. Lỗi cấu hình ⇒ không xuất bản (G9). */
export async function adminPublishPage(user: SessionUser, id: unknown): Promise<PageWriteResult> {
  const denial = pageAdminDenial(user);
  if (denial) return denied(denial);
  const pid = pageId(id);
  if (!pid) return denied("Thiếu mã trang.");
  return toResult(await publishPage(pid, pageActorOf(user)));
}

export async function adminArchivePage(user: SessionUser, id: unknown): Promise<PageWriteResult> {
  const denial = pageAdminDenial(user);
  if (denial) return denied(denial);
  const pid = pageId(id);
  if (!pid) return denied("Thiếu mã trang.");
  return toResult(await archivePage(pid, pageActorOf(user)));
}

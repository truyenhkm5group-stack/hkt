import type { SessionUser } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { MetadataError } from "@/lib/metadata/errors";
import { getPageDraft, pageAdminDenial, publishPage, savePageDraft, updatePageMeta } from "@/lib/pages/registry";
import type { PageNav, PageSchema } from "@/lib/pages/types";
import { loadPageEditor, pageActorOf, type PageEditorView } from "@/lib/platform-ui/page-admin";
import { blankSchema, type PagePathError } from "@/lib/platform-ui/page-admin-shared";

/**
 * ═══════════ LÕI MÁY CHỦ CỦA TRÌNH DỰNG TRANG KÉO-THẢ (Phase 5 · hợp đồng §4) ═══════════
 *
 * Trình kéo-thả KHÔNG có đường ghi riêng (X1): nó lưu nháp, xuất bản và bật menu qua ĐÚNG các dịch vụ của
 * `lib/pages/registry.ts` mà trình soạn Phase 4 dùng — `validatePageSchema` chạy ở đó, khi lưu nháp và khi xuất
 * bản. Tệp này chỉ thêm ba điều mà lõi Phase 4 (`page-admin.ts`) không trả về được:
 *  · MÃ lỗi `CONFLICT` của lượt lưu (tự lưu so `baseRevision` — người khác vừa lưu thì không ghi đè im lặng);
 *  · phiên bản + mốc sau khi xuất bản, để thanh trên cập nhật mà không phải dựng lại cả trình soạn;
 *  · "Thêm vào menu" = bật `nav` qua `updatePageMeta`, không động tới gì khác của thông tin trang.
 *
 * Mỗi lượt: kiểm quyền LẦN HAI (`metadata:manage` + phiên mang tổ chức — lần một là `requirePermission` của trang /
 * action), người thao tác lấy từ PHIÊN (luật 34). Tệp THƯỜNG (không "use server") để bài kiểm gọi được với một
 * `SessionUser` dựng tay.
 */

type Denied = { ok: false; errors: PagePathError[] };

function denied(message: string, path = "_"): Denied {
  return { ok: false, errors: [{ path, message }] };
}

function pageId(id: unknown): string | null {
  return typeof id === "string" && id.trim() ? id : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export type PageBuilderView = PageEditorView & {
  /** Số hiệu bản nháp trình kéo-thả đứng trên — gửi lại làm `baseRevision` ở lượt tự lưu kế tiếp (§2). */
  draftRevision: number;
};

/** Mở trình kéo-thả: dùng lại đúng lượt đọc của trình soạn Phase 4 (sổ lọc theo module + quyền của người soạn). */
export async function loadPageBuilder(user: SessionUser, id: string): Promise<{ ok: true; value: PageBuilderView } | Denied> {
  const loaded = await loadPageEditor(user, id);
  if (!loaded.ok) return loaded;
  if (!loaded.value.page) return denied("Không có trang này trong tổ chức.");
  const { draftRevision } = await getPageDraft(loaded.value.page.id);
  return { ok: true, value: { ...loaded.value, draftRevision } };
}

/**
 * «Tải bản của họ» sau CONFLICT: bản nháp ĐANG LƯU trong CSDL + revision của nó. Trang vừa tạo có nháp rỗng ⇒ một
 * nhóm trống (cùng quy ước với lượt mở trình soạn).
 */
export async function adminLoadBuilderDraft(user: SessionUser, id: unknown): Promise<{ ok: true; draft: PageSchema; draftRevision: number } | Denied> {
  const denial = pageAdminDenial(user);
  if (denial) return denied(denial);
  const pid = pageId(id);
  if (!pid) return denied("Thiếu mã trang.");
  try {
    const r = await getPageDraft(pid);
    return { ok: true, draft: r.draft.sections.length > 0 ? r.draft : blankSchema(), draftRevision: r.draftRevision };
  } catch (error) {
    if (error instanceof MetadataError) return denied(error.message);
    throw error;
  }
}

// ═══════════ TỰ LƯU ═══════════

/** `currentRevision`: chỉ có khi `conflict` — revision đang trong CSDL (bản của người lưu trước), dùng để GHI ĐÈ có chủ ý. */
export type BuilderSaveResult = { ok: true; notes: PagePathError[]; revision: number } | { ok: false; conflict: boolean; currentRevision?: number; errors: PagePathError[] };

/**
 * Lưu NHÁP từ trình kéo-thả. `baseRevision` = số hiệu bản nháp mà trình duyệt đang đứng trên; dịch vụ thấy lệch ⇒
 * `CONFLICT` và KHÔNG ghi. Lỗi kiểm cấu hình về NGUYÊN VĂN kèm `path` (của schema vừa gửi).
 */
export async function adminSaveBuilderDraft(user: SessionUser, id: unknown, schema: unknown, baseRevision: number | null): Promise<BuilderSaveResult> {
  const denial = pageAdminDenial(user);
  if (denial) return { ...denied(denial), conflict: false };
  const pid = pageId(id);
  if (!pid) return { ...denied("Thiếu mã trang."), conflict: false };
  if (!isRecord(schema) || !Array.isArray(schema.sections)) return { ...denied("Nội dung trang không hợp lệ.", "sections"), conflict: false };
  // Trình kéo-thả LUÔN gửi revision nó đứng trên; `null` (không biết) bị từ chối thay vì lặng lẽ lưu đè.
  if (typeof baseRevision !== "number") return { ...denied("Thiếu số hiệu bản nháp — tải lại trình soạn.", "baseRevision"), conflict: false };
  const r = await savePageDraft(pid, schema, pageActorOf(user), { baseRevision });
  if (!r.ok) {
    const errors = r.errors.length ? r.errors : [{ path: "_", message: `Không lưu được trang (${r.code}).` }];
    return r.code === "CONFLICT" ? { ok: false, conflict: true, currentRevision: r.draftRevision, errors } : { ok: false, conflict: false, errors };
  }
  return { ok: true, notes: r.warnings, revision: r.draftRevision };
}

// ═══════════ XUẤT BẢN ═══════════

export type BuilderPublishResult = { ok: true; version: number; publishedAt: string } | Denied;

/** Xuất bản bản NHÁP ĐÃ LƯU (dịch vụ kiểm lại toàn bộ; lỗi ⇒ không xuất bản gì). */
export async function adminPublishFromBuilder(user: SessionUser, id: unknown): Promise<BuilderPublishResult> {
  const denial = pageAdminDenial(user);
  if (denial) return denied(denial);
  const pid = pageId(id);
  if (!pid) return denied("Thiếu mã trang.");
  const r = await publishPage(pid, pageActorOf(user));
  if (!r.ok) return r.errors.length ? { ok: false, errors: r.errors } : denied(`Không xuất bản được (${r.code}).`);
  return { ok: true, version: r.version, publishedAt: r.page.publishedAt ? formatDateTime(r.page.publishedAt) : "" };
}

// ═══════════ THÊM VÀO MENU ═══════════

export type BuilderMenuResult = { ok: true; nav: PageNav } | Denied;

/**
 * Bật mục menu của trang (nhãn trống ⇒ tên trang). Menu chỉ hiện trang ĐÃ XUẤT BẢN và người xem mở được — bật
 * trước khi xuất bản là hợp lệ, mục menu sẽ hiện từ lần xuất bản đầu.
 */
export async function adminAddPageToMenu(user: SessionUser, id: unknown): Promise<BuilderMenuResult> {
  const denial = pageAdminDenial(user);
  if (denial) return denied(denial);
  const pid = pageId(id);
  if (!pid) return denied("Thiếu mã trang.");
  let current: Awaited<ReturnType<typeof getPageDraft>>;
  try {
    current = await getPageDraft(pid);
  } catch (error) {
    if (error instanceof MetadataError) return denied(error.message);
    throw error;
  }
  const nav: PageNav = { ...current.page.nav, enabled: true, label: current.page.nav.label || current.page.name };
  const r = await updatePageMeta(pid, { nav }, pageActorOf(user));
  if (!r.ok) return r.errors.length ? { ok: false, errors: r.errors } : denied(`Không bật được menu (${r.code}).`);
  return { ok: true, nav: r.page.nav };
}

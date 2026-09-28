/**
 * ═══════════ LÕI MÀN HÌNH `/settings/templates` (Phase 7 · §5) — CHỈ MÁY CHỦ ═══════════
 *
 * Trang đọc qua các hàm `load*` / `preview*`, và MỘT server action (`lib/actions/blueprints.ts`) gọi `installTemplate`.
 * Tệp THƯỜNG (không "use server") để bài kiểm gọi được với một `SessionUser` dựng tay — cùng mẫu với
 * `lib/platform-ui/metadata-admin.ts`. Mỗi lượt kiểm quyền LẦN HAI (`metadata:manage`) và phiên phải mang tổ chức;
 * quyền của từng BƯỚC (bật module cần `modules:manage`, vai trò cần `users:manage`, luật cần `workflow:manage`…) do
 * kế hoạch đánh dấu BỊ CHẶN, nên người thiếu quyền thấy trước bước nào không làm được thay vì hỏng giữa chừng.
 */
import { can, type SessionUser } from "@/lib/auth/session";
import { moduleDef } from "@/lib/constants/platform-modules";
import { installHistory, installedVersion } from "@/lib/blueprints/ledger";
import { installBlueprint, planForOrg } from "@/lib/blueprints/install";
import { BLUEPRINT_TEMPLATES, templateBlueprint } from "@/lib/blueprints/templates";
import { blueprintModules, objectOf } from "@/lib/blueprints/validate";
import { compareVersions, type ApplyResult, type Blueprint, type BlueprintIssue, type BlueprintPlan, type InstallHistoryRow, type StepResolution } from "@/lib/blueprints/types";

export type BlueprintDenied = { ok: false; errors: BlueprintIssue[] };

function denied(message: string): BlueprintDenied {
  return { ok: false, errors: [{ path: "", message }] };
}

/** Vì sao người này KHÔNG dùng được màn Mẫu (`null` = được). Hỏng về phía hẹp. */
export function blueprintAdminDenial(user: SessionUser): string | null {
  if (!can(user, "metadata:manage")) return "Bạn không có quyền cài mẫu cấu hình (cần quyền cấu hình dữ liệu).";
  if (!user.organization) return "Phiên chưa gắn tổ chức — đăng nhập lại.";
  return null;
}

export type TemplateSummary = {
  key: string;
  version: string;
  name: string;
  description: string;
  industry: string | null;
  modules: { key: string; label: string }[];
  counts: { roles: number; fields: number; forms: number; lists: number; pages: number; workflows: number; objects: number };
  fieldObjects: string[];
  objects: { key: string; label: string }[];
  pages: { slug: string; name: string }[];
  workflows: { key: string; name: string }[];
  integrations: { connectorKey: string; label: string; reason: string }[];
  installedVersion: string | null;
  updateAvailable: boolean;
};

export function summarize(bp: Blueprint, installed: string | null): TemplateSummary {
  return {
    key: bp.key,
    version: bp.version,
    name: bp.name,
    description: bp.description,
    industry: bp.industry,
    modules: blueprintModules(bp).map((m) => ({ key: m, label: moduleDef(m)?.label ?? m })),
    counts: {
      roles: bp.roles?.length ?? 0,
      fields: bp.fields?.length ?? 0,
      forms: bp.forms?.length ?? 0,
      lists: bp.listViews?.length ?? 0,
      pages: bp.pages?.length ?? 0,
      workflows: bp.workflows?.length ?? 0,
      objects: bp.objects?.length ?? 0,
    },
    fieldObjects: [...new Set((bp.fields ?? []).map((f) => objectOf(bp, f.objectKey)?.label ?? f.objectKey))],
    objects: (bp.objects ?? []).map((o) => ({ key: o.key, label: o.label })),
    pages: (bp.pages ?? []).map((p) => ({ slug: p.slug, name: p.name })),
    workflows: (bp.workflows ?? []).map((w) => ({ key: w.key, name: w.name })),
    integrations: (bp.integrations ?? []).map((i) => ({ connectorKey: i.connectorKey, label: moduleDef(i.connectorKey)?.label ?? i.connectorKey, reason: i.reason })),
    installedVersion: installed,
    updateAvailable: installed !== null && compareVersions(bp.version, installed) > 0,
  };
}

export async function loadTemplateCatalog(user: SessionUser): Promise<{ ok: true; value: { templates: TemplateSummary[]; history: InstallHistoryRow[] } } | BlueprintDenied> {
  const denial = blueprintAdminDenial(user);
  if (denial) return denied(denial);
  const templates: TemplateSummary[] = [];
  for (const bp of BLUEPRINT_TEMPLATES) templates.push(summarize(bp, await installedVersion(bp.key)));
  return { ok: true, value: { templates, history: await installHistory({ limit: 50 }) } };
}

export async function previewTemplate(
  user: SessionUser,
  key: unknown,
  resolutions: Record<string, StepResolution> = {},
): Promise<{ ok: true; value: { template: TemplateSummary; plan: BlueprintPlan; history: InstallHistoryRow[] } } | BlueprintDenied> {
  const denial = blueprintAdminDenial(user);
  if (denial) return denied(denial);
  const bp = typeof key === "string" ? templateBlueprint(key) : null;
  if (!bp) return denied(`Không có mẫu «${String(key)}».`);
  const plan = await planForOrg(bp, user, sanitizeResolutions(resolutions));
  return { ok: true, value: { template: summarize(bp, plan.installedVersion), plan, history: await installHistory({ blueprintKeys: [bp.key], limit: 20 }) } };
}

/** Lựa chọn từ client: chỉ nhận khoá `<loại>:<khoá>` hợp lệ và hai giá trị đóng — không tin gì khác. */
export function sanitizeResolutions(raw: unknown): Record<string, StepResolution> {
  const out: Record<string, StepResolution> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 500)) {
    if (/^[a-z]+:[a-zA-Z0-9_.-]{1,100}$/.test(k) && (v === "overwrite" || v === "skip")) out[k] = v;
  }
  return out;
}

export async function installTemplate(user: SessionUser, key: unknown, input: { planHash?: unknown; resolutions?: unknown }): Promise<ApplyResult> {
  const denial = blueprintAdminDenial(user);
  if (denial) return { ok: false, installId: null, failedStep: null, errors: [{ path: "", message: denial }], outcomes: [] };
  const bp = typeof key === "string" ? templateBlueprint(key) : null;
  if (!bp) return { ok: false, installId: null, failedStep: null, errors: [{ path: "", message: `Không có mẫu «${String(key)}».` }], outcomes: [] };
  if (typeof input.planHash !== "string" || input.planHash.length === 0) {
    return { ok: false, installId: null, failedStep: null, errors: [{ path: "planHash", message: "Thiếu kế hoạch đã xem trước — xem trước rồi mới cài." }], outcomes: [] };
  }
  return installBlueprint(bp, user, { expectedPlanHash: input.planHash, resolutions: sanitizeResolutions(input.resolutions) });
}

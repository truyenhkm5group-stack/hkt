import { can, type SessionUser } from "@/lib/auth/session";
import { MetadataError } from "@/lib/metadata/errors";
import { listFields } from "@/lib/metadata/fields";
import type { FieldError, MetadataActor } from "@/lib/metadata/types";
import { withOrganization } from "@/lib/platform/context";
import { adminObjects, buildCatalog } from "@/lib/platform-ui/metadata-admin-shared";
import { statusFieldsOf, workflowEventOptions, type EventOption, type WorkflowObjectOption } from "@/lib/platform-ui/workflow-admin-shared";
import { listRuns, previewRule, runWorkflows } from "@/lib/workflow/engine";
import { getRule, listRules, saveRule, setRuleMode, setRuleStatus } from "@/lib/workflow/rules";
import type { WorkflowMode, WorkflowRule, WorkflowRunRow } from "@/lib/workflow/types";

/**
 * ═══════════ LÕI CỦA MÀN HÌNH LUẬT TỰ ĐỘNG ═══════════
 *
 * Hai trang `/settings/workflows` và `/settings/workflows/[id]` đọc qua các hàm `load*` ở đây; server action
 * của màn hình gọi các hàm `admin*` ở đây. Tệp THƯỜNG (không "use server") để bộ kiểm thử chạy ngoài Next gọi
 * được với một `SessionUser` dựng tay — cùng mẫu với `metadata-admin.ts`.
 *
 * Mỗi lượt: kiểm quyền LẦN HAI (`workflow:manage` — lần một là `requirePermission` của trang / action), phiên
 * phải mang tổ chức ⇒ rồi mới gọi dịch vụ `lib/workflow/*`. Giao diện KHÔNG đọc bảng `workflow_*` trực tiếp.
 * Câu lỗi của dịch vụ đi NGUYÊN VĂN về màn hình.
 *
 * Tổ chức luôn là tổ chức CỦA NGƯỜI XEM (`getDb()` chọn theo ngữ cảnh phiên): không tham số nào nhận mã tổ chức.
 *
 * Luật chạy THẬT chỉ bật được trên luật ĐANG BẬT: lõi kiểm trước khi gọi dịch vụ (dịch vụ kiểm lại) — một luật
 * nháp không bao giờ nhảy thẳng sang chạy thật, kể cả khi ai đó gọi thẳng action bỏ qua màn hình.
 */

export type WorkflowWriteResult = { ok: true; id: string } | { ok: false; errors: FieldError[] };
type Denied = { ok: false; errors: FieldError[] };
type Loaded<T> = { ok: true; value: T } | Denied;

function denied(message: string, field = "_"): Denied {
  return { ok: false, errors: [{ field, message }] };
}

/** Vì sao người này KHÔNG khai được luật tự động (`null` = được). Hỏng về phía hẹp. */
export function workflowAdminDenial(user: SessionUser): string | null {
  if (!can(user, "workflow:manage")) return "Bạn không có quyền khai luật tự động.";
  if (!user.organization) return "Phiên chưa gắn tổ chức — đăng nhập lại.";
  return null;
}

/** Người thao tác — lấy từ PHIÊN (luật 34), không nhận từ client. */
export function workflowActorOf(user: SessionUser): MetadataActor {
  return { id: user.id, email: user.email, permissions: user.permissions, isAdmin: user.role === "ADMIN" };
}

/** Kết quả ghi của dịch vụ ⇒ kết quả màn hình. Hình lỗi của dịch vụ (`errors: FieldError[]`) giữ nguyên. */
function toResult(r: { ok: true; rule: Pick<WorkflowRule, "id"> } | { ok: false; code: string; errors: FieldError[] }): WorkflowWriteResult {
  if (r.ok) return { ok: true, id: r.rule.id };
  return r.errors.length ? { ok: false, errors: r.errors } : denied(`Không lưu được luật (${r.code}).`);
}

// ═══════════ ĐỌC ═══════════

export type WorkflowListRow = Pick<WorkflowRule, "id" | "key" | "name" | "status" | "mode" | "version" | "trigger">;

export async function loadWorkflowList(user: SessionUser): Promise<Loaded<WorkflowListRow[]>> {
  const denial = workflowAdminDenial(user);
  if (denial) return denied(denial);
  const rules = await listRules();
  return { ok: true, value: rules.map((r) => ({ id: r.id, key: r.key, name: r.name, status: r.status, mode: r.mode, version: r.version, trigger: r.trigger })) };
}

/**
 * Đối tượng chọn được trong form luật: `customizable` + module đang bật (cùng luật với màn hình Mô hình dữ liệu),
 * mỗi đối tượng kèm danh mục field (điều kiện) và field trạng thái custom (trigger). Đối tượng mà dịch vụ metadata
 * từ chối đọc (module vừa tắt) bị bỏ, không làm hỏng cả trang.
 */
export async function workflowObjects(user: SessionUser): Promise<WorkflowObjectOption[]> {
  const out: WorkflowObjectOption[] = [];
  for (const o of adminObjects(user, "customFields")) {
    try {
      const fields = await listFields(o.key);
      const catalog = buildCatalog(fields.system, fields.custom);
      out.push({ key: o.key, label: o.label, catalog, statusFields: statusFieldsOf(catalog) });
    } catch (error) {
      if (error instanceof MetadataError) continue;
      throw error;
    }
  }
  return out;
}

export type WorkflowEditorView = {
  /** `null` = đang tạo luật mới. */
  rule: WorkflowRule | null;
  /** Khoá mọi luật đã có — gợi ý khoá không trùng. */
  takenKeys: string[];
  events: EventOption[];
  objects: WorkflowObjectOption[];
  runs: WorkflowRunRow[];
};

export const RECENT_RUNS_LIMIT = 30;

export async function loadWorkflowEditor(user: SessionUser, id: string | null): Promise<Loaded<WorkflowEditorView>> {
  const denial = workflowAdminDenial(user);
  if (denial) return denied(denial);
  const [rules, objects] = await Promise.all([listRules(), workflowObjects(user)]);
  const events = workflowEventOptions();
  const takenKeys = rules.map((r) => r.key);
  if (id === null) return { ok: true, value: { rule: null, takenKeys, events, objects, runs: [] } };
  const rule = await getRule(id);
  if (!rule) return denied(`Không có luật «${id}» trong tổ chức này.`);
  const runs = await listRuns({ ruleId: rule.id, limit: RECENT_RUNS_LIMIT });
  return { ok: true, value: { rule, takenKeys, events, objects, runs } };
}

// ═══════════ GHI ═══════════

/** Lưu luật — tạo (`id = null`) hoặc sửa. Dịch vụ LUÔN đưa luật về NHÁP (hợp đồng mục 4). */
export async function adminSaveWorkflowRule(user: SessionUser, id: string | null, input: unknown): Promise<WorkflowWriteResult> {
  const denial = workflowAdminDenial(user);
  if (denial) return denied(denial);
  if (id !== null && (typeof id !== "string" || !id)) return denied("Thiếu mã luật.");
  if (typeof input !== "object" || input === null || Array.isArray(input)) return denied("Đầu vào luật không hợp lệ.");
  const payload = id === null ? input : { ...input, id };
  return toResult(await saveRule(payload, workflowActorOf(user)));
}

const STATUS_TARGETS = ["ACTIVE", "PAUSED", "ARCHIVED"] as const;

export async function adminSetWorkflowStatus(user: SessionUser, id: unknown, status: unknown): Promise<WorkflowWriteResult> {
  const denial = workflowAdminDenial(user);
  if (denial) return denied(denial);
  if (typeof id !== "string" || !id) return denied("Thiếu mã luật.");
  const target = STATUS_TARGETS.find((s) => s === status);
  if (!target) return denied(`Trạng thái «${String(status)}» không đặt được từ màn hình này.`);
  return toResult(await setRuleStatus(id, target, workflowActorOf(user)));
}

const MODES: readonly WorkflowMode[] = ["DRY_RUN", "LIVE"];

export async function adminSetWorkflowMode(user: SessionUser, id: unknown, mode: unknown): Promise<WorkflowWriteResult> {
  const denial = workflowAdminDenial(user);
  if (denial) return denied(denial);
  if (typeof id !== "string" || !id) return denied("Thiếu mã luật.");
  const target = MODES.find((m) => m === mode);
  if (!target) return denied(`Chế độ «${String(mode)}» không hợp lệ.`, "mode");
  if (target === "LIVE") {
    const rule = await getRule(id);
    if (!rule) return denied(`Không có luật «${id}» trong tổ chức này.`);
    if (rule.status !== "ACTIVE") return denied("Chỉ luật ĐANG BẬT mới chuyển sang chạy thật — bấm «Bật» và xem lượt chạy thử trước.", "mode");
  }
  return toResult(await setRuleMode(id, target, workflowActorOf(user)));
}

export type PreviewStepView = { action: string; detail: string };
/** `reason`: vì sao KHÔNG khớp (bản ghi không có, luật nói về đối tượng khác…) — câu của dịch vụ, in nguyên văn. */
export type WorkflowPreviewResult = { ok: true; matched: boolean; wouldDo: PreviewStepView[]; reason: string | null } | { ok: false; errors: FieldError[] };

/** Chạy thử luật ĐÃ LƯU trên một bản ghi — dịch vụ KHÔNG ghi gì (hợp đồng mục 4). */
export async function adminPreviewWorkflowRule(user: SessionUser, id: unknown, subject: unknown): Promise<WorkflowPreviewResult> {
  const denial = workflowAdminDenial(user);
  if (denial) return denied(denial);
  if (typeof id !== "string" || !id) return denied("Lưu luật trước khi chạy thử.");
  const s = (subject ?? {}) as { objectKey?: unknown; recordId?: unknown };
  const objectKey = typeof s.objectKey === "string" ? s.objectKey.trim() : "";
  const recordId = typeof s.recordId === "string" ? s.recordId.trim() : "";
  if (!objectKey) return denied("Luật này không gắn đối tượng nào để chạy thử.", "preview.objectKey");
  if (!recordId) return denied("Nhập mã bản ghi để chạy thử.", "preview.recordId");
  const r = await previewRule(id, { objectKey, recordId });
  return { ok: true, matched: r.matched, wouldDo: r.wouldDo.map((w) => ({ action: w.action, detail: w.detail })), reason: r.reason ?? null };
}

export type WorkflowRunNowResult = { ok: true; events: number; runs: number; executed: number; waiting: number; failed: number } | { ok: false; errors: FieldError[] };

/**
 * «Chạy lượt kiểm tra ngay» — một lượt `runWorkflows()` cho ĐÚNG tổ chức của người bấm.
 *
 * Máy chạy ké job `alerts` (10 phút). Tổ chức tắt module Cần xử lý (vd mẫu bán buôn) thì không có lượt tự động nào:
 * nút này là đường chạy cho họ mà KHÔNG đổi lịch scheduler (AGENTS.md §7). Bọc `withOrganization(mã trong phiên)`
 * tường minh — lượt chạy không bao giờ rơi sang tổ chức khác vì ngữ cảnh xung quanh (bài kiểm gọi từ ngữ cảnh nhà).
 * Cùng một hàm với lượt của job: con trỏ chỉ tiến, `dedupe_key` chặn nhân đôi, nên bấm hai lần không làm hai lần.
 */
export async function adminRunWorkflowsNow(user: SessionUser): Promise<WorkflowRunNowResult> {
  const denial = workflowAdminDenial(user);
  if (denial || !user.organization) return denied(denial ?? "Phiên chưa gắn tổ chức — đăng nhập lại.");
  const r = await withOrganization(user.organization.code, () => runWorkflows());
  return { ok: true, events: r.events, runs: r.runs, executed: r.executed, waiting: r.waiting, failed: r.failed };
}

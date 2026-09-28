/**
 * ═══════════ CÀI MỘT BLUEPRINT TỪ TỆP JSON (Phase 11 · H3) — CHỈ MÁY CHỦ ═══════════
 *
 * Đường khôi phục cấu hình: tệp do `/settings/export` tải xuống (hoặc bất kỳ gói đúng định dạng) → tải lên ở màn Mẫu
 * cấu hình → KIỂM (`validateBlueprint`) → XEM TRƯỚC (`planForOrg` — chạy thử, không ghi) → CÀI (`installBlueprint`,
 * lập lại kế hoạch lúc cài và so `planHash`). Không có bộ cài thứ hai: tệp đi đúng đường của mẫu ngành và AI.
 *
 * Tệp là dữ liệu của client nên KHÔNG tin gì: trần kích thước, JSON hỏng / không phải đối tượng ⇒ từ chối rõ ràng;
 * khoá gói trùng một MẪU NGÀNH ⇒ từ chối (cài một "wholesale" tự chế sẽ ghi vào sổ cài của mẫu thật và phép so ba
 * chiều lần nâng mẫu sau so với nhầm gốc). Quyền của từng bước vẫn do kế hoạch đánh dấu BỊ CHẶN.
 */
import type { SessionUser } from "@/lib/auth/session";
import { blueprintAdminDenial, sanitizeResolutions, summarize, type TemplateSummary } from "@/lib/blueprints/admin";
import { isTemplateKey } from "@/lib/blueprints/export";
import { installBlueprint, planForOrg } from "@/lib/blueprints/install";
import { validateBlueprint } from "@/lib/blueprints/validate";
import type { ApplyResult, Blueprint, BlueprintIssue, BlueprintPlan } from "@/lib/blueprints/types";

/** Trần tệp tải lên: gói lớn nhất hợp lệ (30 trang × khối, 300 field…) vẫn dưới mức này nhiều lần. */
export const BLUEPRINT_FILE_MAX_BYTES = 2 * 1024 * 1024;

export type ParsedFile = { ok: true; blueprint: Blueprint } | { ok: false; errors: BlueprintIssue[] };

/** Đọc + kiểm một tệp gói. Thuần (không đọc CSDL). */
export function parseBlueprintFile(text: unknown): ParsedFile {
  if (typeof text !== "string" || text.trim().length === 0) return { ok: false, errors: [{ path: "", message: "Tệp rỗng — chọn tệp .json đã xuất từ màn Xuất cấu hình." }] };
  if (Buffer.byteLength(text, "utf8") > BLUEPRINT_FILE_MAX_BYTES) return { ok: false, errors: [{ path: "", message: `Tệp lớn hơn ${BLUEPRINT_FILE_MAX_BYTES / 1024 / 1024} MB — không phải một gói cấu hình.` }] };
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return { ok: false, errors: [{ path: "", message: "Tệp không phải JSON hợp lệ." }] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: [{ path: "", message: "Tệp không chứa một gói cấu hình (cần một đối tượng JSON)." }] };
  const v = validateBlueprint(raw);
  if (!v.ok) return { ok: false, errors: v.errors };
  const bp = raw as Blueprint;
  if (isTemplateKey(bp.key)) return { ok: false, errors: [{ path: "key", message: `Khoá gói «${bp.key}» trùng một mẫu ngành — cài mẫu ở danh sách mẫu, hoặc đổi khoá của tệp.` }] };
  return { ok: true, blueprint: bp };
}

export async function previewBlueprintFile(
  user: SessionUser,
  text: unknown,
  resolutions: unknown = {},
): Promise<{ ok: true; value: { summary: TemplateSummary; plan: BlueprintPlan } } | { ok: false; errors: BlueprintIssue[] }> {
  const denial = blueprintAdminDenial(user);
  if (denial) return { ok: false, errors: [{ path: "", message: denial }] };
  const parsed = parseBlueprintFile(text);
  if (!parsed.ok) return parsed;
  const plan = await planForOrg(parsed.blueprint, user, sanitizeResolutions(resolutions));
  return { ok: true, value: { summary: summarize(parsed.blueprint, plan.installedVersion), plan } };
}

export async function installBlueprintFile(user: SessionUser, text: unknown, input: { planHash?: unknown; resolutions?: unknown }): Promise<ApplyResult> {
  const denial = blueprintAdminDenial(user);
  if (denial) return { ok: false, installId: null, failedStep: null, errors: [{ path: "", message: denial }], outcomes: [] };
  const parsed = parseBlueprintFile(text);
  if (!parsed.ok) return { ok: false, installId: null, failedStep: null, errors: parsed.errors, outcomes: [] };
  if (typeof input.planHash !== "string" || input.planHash.length === 0) {
    return { ok: false, installId: null, failedStep: null, errors: [{ path: "planHash", message: "Thiếu kế hoạch đã xem trước — xem trước rồi mới cài." }], outcomes: [] };
  }
  return installBlueprint(parsed.blueprint, user, { expectedPlanHash: input.planHash, resolutions: sanitizeResolutions(input.resolutions) });
}

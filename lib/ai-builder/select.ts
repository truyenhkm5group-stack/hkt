/**
 * ═══════════ NGƯỜI BỎ CHỌN TỪNG MỤC (Phase 8 · §3) — THUẦN ═══════════
 *
 * Bản nháp AI soạn được liệt kê theo nhóm; người bỏ chọn mục nào thì MÁY CHỦ lọc mục đó khỏi gói trước khi lập kế hoạch
 * (`filterBlueprint`). Trình duyệt chỉ gửi DANH SÁCH KHOÁ bỏ chọn — không gửi gói — nên người dùng không có cách nào
 * đưa vào bộ cài một mục mà AI chưa soạn hoặc bộ kiểm chưa thấy.
 *
 * Khoá mục = `stepKey` của kế hoạch (`<loại>:<khoá>`) + `integration:<connector>` cho gợi ý tích hợp. Liệt kê chịu được
 * gói SAI HÌNH (AI trả gì cũng phải hiện ra được cho người đọc lỗi), nên đọc phòng thủ thay vì tin kiểu.
 */
import { BLUEPRINT_ITEM_KINDS, stepKey, type Blueprint, type BlueprintIssue } from "@/lib/blueprints/types";
import { SELECTABLE_KIND_LABEL, type SelectableItem, type SelectableKind, type SummaryGroup } from "@/lib/ai-builder/types";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (bp: Rec, k: string): unknown[] => (Array.isArray(bp[k]) ? (bp[k] as unknown[]) : []);

type RawItem = { key: string; kind: SelectableKind; path: string; label: string; detail: string };

/** Mọi mục của một gói (kể cả sai hình), theo đúng thứ tự ghi của bộ cài. */
export function rawItems(input: unknown): RawItem[] {
  if (!isRec(input)) return [];
  const bp = input;
  const out: RawItem[] = [];
  list(bp, "modules").forEach((m, i) => out.push({ key: stepKey("module", str(m)), kind: "module", path: `modules.${i}`, label: str(m), detail: "" }));
  list(bp, "roles").forEach((r, i) => {
    const x = isRec(r) ? r : {};
    const perms = Array.isArray(x.permissions) ? (x.permissions as unknown[]).map(str).join(", ") : "";
    out.push({ key: stepKey("role", str(x.key)), kind: "role", path: `roles.${i}`, label: str(x.label) || str(x.key), detail: `nền ${str(x.base)} · ${perms}` });
  });
  list(bp, "fields").forEach((f, i) => {
    const x = isRec(f) ? f : {};
    out.push({ key: stepKey("field", `${str(x.objectKey)}.${str(x.key)}`), kind: "field", path: `fields.${i}`, label: str(x.label) || str(x.key), detail: `${str(x.objectKey)} · ${str(x.type)}` });
  });
  list(bp, "statuses").forEach((s, i) => {
    const x = isRec(s) ? s : {};
    out.push({ key: stepKey("status", `${str(x.objectKey)}.${str(x.field)}`), kind: "status", path: `statuses.${i}`, label: `${str(x.objectKey)}.${str(x.field)}`, detail: "" });
  });
  list(bp, "forms").forEach((f, i) => {
    const x = isRec(f) ? f : {};
    out.push({ key: stepKey("form", `${str(x.objectKey)}.${str(x.formKey)}`), kind: "form", path: `forms.${i}`, label: `${str(x.objectKey)} · ${str(x.formKey)}`, detail: x.publish === true ? "xuất bản ở lần cài đầu" : "" });
  });
  list(bp, "listViews").forEach((l, i) => {
    const x = isRec(l) ? l : {};
    out.push({ key: stepKey("list", `${str(x.objectKey)}.${str(x.listKey)}`), kind: "list", path: `listViews.${i}`, label: `${str(x.objectKey)} · ${str(x.listKey)}`, detail: x.publish === true ? "xuất bản ở lần cài đầu" : "" });
  });
  list(bp, "pages").forEach((p, i) => {
    const x = isRec(p) ? p : {};
    out.push({ key: stepKey("page", str(x.slug)), kind: "page", path: `pages.${i}`, label: str(x.name) || str(x.slug), detail: `/p/${str(x.slug)}${x.publish === true ? " · xuất bản ở lần cài đầu" : " · vào NHÁP"}` });
  });
  list(bp, "workflows").forEach((w, i) => {
    const x = isRec(w) ? w : {};
    const gate = isRec(x.gate) ? " · có bước duyệt" : "";
    out.push({ key: stepKey("workflow", str(x.key)), kind: "workflow", path: `workflows.${i}`, label: str(x.name) || str(x.key), detail: `NHÁP + CHẠY THỬ${gate}` });
  });
  list(bp, "settings").forEach((s, i) => {
    const x = isRec(s) ? s : {};
    out.push({ key: stepKey("setting", str(x.key)), kind: "setting", path: `settings.${i}`, label: str(x.key), detail: "" });
  });
  if (isRec(bp.ai)) out.push({ key: stepKey("ai", "businessProfile"), kind: "ai", path: "ai", label: "Hồ sơ doanh nghiệp cho AI", detail: str(bp.ai.businessProfile).slice(0, 160) });
  list(bp, "integrations").forEach((it, i) => {
    const x = isRec(it) ? it : {};
    out.push({ key: `integration:${str(x.connectorKey)}`, kind: "integration", path: `integrations.${i}`, label: str(x.connectorKey), detail: str(x.reason) });
  });
  return out;
}

/** Lỗi / cảnh báo của bộ kiểm gắn vào ĐÚNG mục theo tiền tố `path` (cùng cách kế hoạch gắn BỊ CHẶN). */
function issuesFor(items: RawItem[], issues: readonly BlueprintIssue[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const issue of issues) {
    const hit = items.find((it) => issue.path === it.path || issue.path.startsWith(`${it.path}.`));
    if (hit) out.set(hit.key, [...(out.get(hit.key) ?? []), issue.message]);
  }
  return out;
}

const GROUP_ORDER: readonly SelectableKind[] = [...BLUEPRINT_ITEM_KINDS, "integration"];

export function summarizeDraft(bp: unknown, contextKeys: readonly string[], errors: readonly BlueprintIssue[] = []): SummaryGroup[] {
  const items = rawItems(bp);
  const ctx = new Set(contextKeys);
  const byItem = issuesFor(items, errors);
  const groups: SummaryGroup[] = [];
  for (const kind of GROUP_ORDER) {
    const rows: SelectableItem[] = items
      .filter((it) => it.kind === kind)
      .map((it) => ({ key: it.key, kind: it.kind, label: it.label, detail: it.detail, context: ctx.has(it.key), issues: byItem.get(it.key) ?? [] }));
    if (rows.length) groups.push({ kind, label: SELECTABLE_KIND_LABEL[kind], items: rows });
  }
  return groups;
}

/** Danh sách khoá bỏ chọn từ trình duyệt: chỉ khoá CÓ trong gói, không phải mục ngữ cảnh, tối đa 500. */
export function sanitizeExcludedKeys(raw: unknown, bp: unknown, contextKeys: readonly string[]): string[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set(rawItems(bp).map((i) => i.key));
  const ctx = new Set(contextKeys);
  const out = new Set<string>();
  for (const k of raw.slice(0, 500)) if (typeof k === "string" && known.has(k) && !ctx.has(k)) out.add(k);
  return [...out].sort();
}

/**
 * Gói sau khi bỏ các mục người không chọn. Mục ngữ cảnh không bao giờ bị lọc. Không sửa gì khác: mục còn lại trỏ vào
 * mục vừa bị bỏ thì bộ kiểm báo lỗi đúng mục đó và kế hoạch đánh dấu BỊ CHẶN — không có "tự bỏ theo" im lặng.
 */
export function filterBlueprint(bp: Blueprint, excludedKeys: readonly string[], contextKeys: readonly string[] = []): Blueprint {
  const ctx = new Set(contextKeys);
  const drop = new Set(excludedKeys.filter((k) => !ctx.has(k)));
  if (drop.size === 0) return bp;
  const keep = (k: string) => !drop.has(k);
  const out: Blueprint = { ...bp, modules: bp.modules.filter((m) => keep(stepKey("module", m))) };
  if (bp.roles) out.roles = bp.roles.filter((r) => keep(stepKey("role", r.key)));
  if (bp.fields) out.fields = bp.fields.filter((f) => keep(stepKey("field", `${f.objectKey}.${f.key}`)));
  if (bp.statuses) out.statuses = bp.statuses.filter((s) => keep(stepKey("status", `${s.objectKey}.${s.field}`)));
  if (bp.forms) out.forms = bp.forms.filter((f) => keep(stepKey("form", `${f.objectKey}.${f.formKey}`)));
  if (bp.listViews) out.listViews = bp.listViews.filter((l) => keep(stepKey("list", `${l.objectKey}.${l.listKey}`)));
  if (bp.pages) out.pages = bp.pages.filter((p) => keep(stepKey("page", p.slug)));
  if (bp.workflows) out.workflows = bp.workflows.filter((w) => keep(stepKey("workflow", w.key)));
  if (bp.settings) out.settings = bp.settings.filter((s) => keep(stepKey("setting", s.key)));
  if (bp.integrations) out.integrations = bp.integrations.filter((i) => keep(`integration:${i.connectorKey}`));
  if (bp.ai && !keep(stepKey("ai", "businessProfile"))) delete out.ai;
  return out;
}

/**
 * ═══════════ AI SOẠN MỘT BLUEPRINT (Phase 8 · §2) — KHÔNG ĐỌC / GHI CSDL ═══════════
 *
 * `draftBlueprint(prompt, { mode, provider, metadata, org })`: MỘT lời gọi AI với MỘT công cụ; đầu ra qua CHÍNH
 * `validateBlueprint`; lỗi ⇒ gửi lại danh sách `path + message` cho AI sửa, TỐI ĐA `maxRepairRounds` lượt, rồi DỪNG và
 * trả gói kèm lỗi cho người xem. Không có đường ghi nào ở đây: kết quả là dữ liệu, bản nháp do `service.ts` lưu, cài do
 * bộ cài Phase 7.
 *
 * ─── MÁY CHỦ CHỈ LÀM PHÉP CHUẨN HOÁ XÁC ĐỊNH, KHÔNG "SỬA HỘ" AI ───
 *
 *  · điền `format` / `formatVersion` / `key = ai-<ngẫu nhiên>` / `version = 1.0.0` (AI không chọn định danh gói);
 *  · thêm module LÕI và module PHỤ THUỘC còn thiếu của module AI đã khai (sổ module trả lời duy nhất một cách), và ở
 *    chế độ sửa: mọi module ĐANG BẬT (bước cài của chúng là UNCHANGED);
 *  · gắn field ĐÃ CÓ của tổ chức mà gói tham chiếu nhưng không khai (mảnh "thêm luật duyệt đơn" trỏ vào trạng thái đơn
 *    đã có) — bản gắn dựng từ chính định nghĩa đang dùng nên kế hoạch ra UNCHANGED, không ghi gì lên nó.
 * Mọi mục máy chủ thêm là MỤC NGỮ CẢNH (`contextKeys`): hiện cho người thấy, không bỏ chọn được.
 * JSON hỏng / thiếu ô / khoá lạ KHÔNG được vá: chúng quay lại AI như lỗi của bộ kiểm.
 */
import { randomBytes } from "node:crypto";
import { estimateCostUsd, type AiBlock, type AiMessage, type AiProvider, type AiUsage } from "@/lib/ai/provider";
import { DOMAIN_EVENT_BY_NAME } from "@/lib/constants/domain-events";
import { objectDef } from "@/lib/constants/object-registry";
import { isModuleKey, moduleDef, PLATFORM_MODULES, type ModuleKey } from "@/lib/constants/platform-modules";
import type { CustomFieldDef } from "@/lib/metadata/types";
import { validateBlueprint } from "@/lib/blueprints/validate";
import { BLUEPRINT_FORMAT, BLUEPRINT_FORMAT_VERSION, stepKey, type Blueprint, type BlueprintField, type BlueprintIssue, type BlueprintValidation } from "@/lib/blueprints/types";
import { blueprintToolDef, buildSystemPrompt, buildUserMessage, newBoundary, SERVER_FILLED_KEYS, type OrgMetadataSnapshot } from "@/lib/ai-builder/prompt";
import { AI_BUILDER_LIMITS, type AiBuilderMode } from "@/lib/ai-builder/types";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

export type DraftOptions = {
  mode: AiBuilderMode;
  provider: AiProvider;
  /** Tóm tắt cấu hình hiện tại — BẮT BUỘC ở chế độ sửa, bỏ qua ở chế độ dựng mới. */
  metadata: OrgMetadataSnapshot | null;
  /** Trạng thái tổ chức cho phép chuẩn hoá (module đang bật, field đang dùng). */
  org: { enabledModules: readonly ModuleKey[]; customDefs: Record<string, CustomFieldDef[]> };
  /** Khoá gói (kiểm thử truyền để ổn định); mặc định `ai-<8 hex>`. */
  blueprintKey?: string;
};

export type DraftOutcome = {
  /** Gói sau chuẩn hoá (có thể còn lỗi); `null` = AI chưa từng nộp một đối tượng JSON qua công cụ. */
  blueprint: Blueprint | null;
  contextKeys: string[];
  validation: BlueprintValidation;
  /** Câu tổng kết khi không ra gói hợp lệ. */
  error: string | null;
  calls: number;
  usage: AiUsage;
  model: string;
  provider: string;
  costUsd: number | null;
};

const ZERO: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const CUSTOM_REF = /custom:([a-z][a-z0-9_]{1,40})/g;

function refsIn(value: unknown): string[] {
  const text = JSON.stringify(value ?? null);
  return [...text.matchAll(CUSTOM_REF)].map((m) => m[1]);
}

/** (đối tượng, field) tuỳ biến mà gói tham chiếu — đọc phòng thủ vì gói chưa qua bộ kiểm. */
export function referencedCustomFields(bp: Rec): { objectKey: string; fieldKey: string }[] {
  const out: { objectKey: string; fieldKey: string }[] = [];
  const add = (objectKey: unknown, keys: string[]) => {
    if (typeof objectKey !== "string" || !objectDef(objectKey)) return;
    for (const k of keys) out.push({ objectKey, fieldKey: k });
  };
  for (const w of Array.isArray(bp.workflows) ? bp.workflows : []) {
    if (!isRec(w) || !isRec(w.trigger)) continue;
    const t = w.trigger;
    const objectKey = t.kind === "custom_status" ? t.objectKey : typeof t.event === "string" ? DOMAIN_EVENT_BY_NAME[t.event]?.subjectType : null;
    if (t.kind === "custom_status" && typeof t.fieldKey === "string") add(objectKey, [t.fieldKey]);
    add(objectKey, refsIn(w.conditions));
    for (const a of Array.isArray(w.actions) ? w.actions : []) if (isRec(a) && a.kind === "set_custom_value" && typeof a.field === "string") add(objectKey, [a.field]);
  }
  for (const k of ["forms", "listViews"] as const) for (const f of Array.isArray(bp[k]) ? bp[k] : []) if (isRec(f)) add(f.objectKey, refsIn(f.schema));
  for (const p of Array.isArray(bp.pages) ? bp.pages : []) {
    const sections = isRec(p) && isRec(p.schema) && Array.isArray(p.schema.sections) ? p.schema.sections : [];
    for (const s of sections) {
      for (const b of isRec(s) && Array.isArray(s.blocks) ? s.blocks : []) {
        if (!isRec(b) || !isRec(b.config)) continue;
        const objectKey = b.type === "table" ? b.config.source : b.config.objectKey;
        add(objectKey, refsIn(b.config));
      }
    }
  }
  return out;
}

/** Field đang dùng của tổ chức ⇒ mục field của gói, sao cho phép chiếu ra ĐÚNG bằng thực thể hiện tại (UNCHANGED). */
export function fieldFromDef(d: CustomFieldDef): BlueprintField {
  const f: BlueprintField = { objectKey: d.objectKey, key: d.key, label: d.label, type: d.type };
  if (d.options.length) f.options = d.options.map((o) => ({ value: o.value, label: o.label, ...(o.color ? { color: o.color } : {}), active: o.active, position: o.position }));
  if (Object.keys(d.validation ?? {}).length) f.validation = { ...d.validation };
  if (Object.keys(d.transitions ?? {}).length) f.transitions = d.transitions;
  if (d.required) f.required = true;
  f.listable = d.listable;
  f.filterable = d.filterable;
  if (d.helpText) f.helpText = d.helpText;
  return f;
}

type Normalized = { ok: true; bp: Blueprint; contextKeys: string[] } | { ok: false; message: string };

export function normalizeToolInput(input: unknown, mode: AiBuilderMode, key: string, org: DraftOptions["org"]): Normalized {
  if (!isRec(input) || "__raw" in input) return { ok: false, message: "Đầu vào công cụ không phải một đối tượng JSON hợp lệ (JSON hỏng) — nộp lại đúng schema." };
  const body: Rec = structuredClone(input);
  for (const k of SERVER_FILLED_KEYS) delete body[k];
  const bp = { format: BLUEPRINT_FORMAT, formatVersion: BLUEPRINT_FORMAT_VERSION, key, version: "1.0.0", ...body } as Rec;
  const context = new Set<string>();

  if (Array.isArray(bp.modules)) {
    const declared = new Set(bp.modules.filter((m): m is string => typeof m === "string"));
    const want = new Set<ModuleKey>([...declared].filter(isModuleKey));
    for (const m of PLATFORM_MODULES) if (m.core) want.add(m.key);
    if (mode === "edit") for (const m of org.enabledModules) want.add(m);
    // Đóng dưới phụ thuộc: sổ module trả lời "cần gì" đúng một cách; module chỉ-nhà không bao giờ được kéo vào.
    const stack = [...want];
    while (stack.length) {
      const d = moduleDef(stack.pop()!);
      for (const dep of d?.dependsOn ?? []) {
        if (want.has(dep) || moduleDef(dep)?.requiresHomeCredentials) continue;
        want.add(dep);
        stack.push(dep);
      }
    }
    const extra = [...want].filter((m) => !declared.has(m));
    for (const m of extra) context.add(stepKey("module", m));
    // Giữ nguyên thứ tự AI khai (kể cả khoá lạ — bộ kiểm sẽ báo), nối phần máy chủ thêm vào cuối.
    bp.modules = [...(bp.modules as unknown[]), ...extra];
  }

  if (Array.isArray(bp.fields) || bp.fields === undefined) {
    const fields = (Array.isArray(bp.fields) ? [...bp.fields] : []) as unknown[];
    const declared = new Set(fields.filter(isRec).map((f) => `${String(f.objectKey)}.${String(f.key)}`));
    for (const r of referencedCustomFields(bp)) {
      const id = `${r.objectKey}.${r.fieldKey}`;
      if (declared.has(id)) continue;
      const def = (org.customDefs[r.objectKey] ?? []).find((d) => d.key === r.fieldKey && d.status === "ACTIVE");
      if (!def) continue;
      fields.push(fieldFromDef(def));
      declared.add(id);
      context.add(stepKey("field", id));
    }
    if (fields.length) bp.fields = fields;
  }
  return { ok: true, bp: bp as Blueprint, contextKeys: [...context].sort() };
}

function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens };
}

function feedback(errors: readonly BlueprintIssue[]): string {
  const shown = errors.slice(0, AI_BUILDER_LIMITS.maxErrorsFedBack);
  const more = errors.length - shown.length;
  return [
    `Bộ kiểm của máy chủ từ chối gói (${errors.length} lỗi). Sửa ĐÚNG các chỗ dưới đây rồi gọi lại \`${blueprintToolDef().name}\` với TOÀN BỘ gói:`,
    ...shown.map((e) => `- ${e.path || "(gói)"}: ${e.message}`),
    ...(more > 0 ? [`… và ${more} lỗi nữa.`] : []),
  ].join("\n");
}

export function newBlueprintKey(): string {
  return `ai-${randomBytes(4).toString("hex")}`;
}

export async function draftBlueprint(prompt: string, opts: DraftOptions): Promise<DraftOutcome> {
  const tool = blueprintToolDef();
  const system = buildSystemPrompt(opts.mode);
  const key = opts.blueprintKey ?? newBlueprintKey();
  const messages: AiMessage[] = [{ role: "user", content: [{ type: "text", text: buildUserMessage(opts.mode, prompt, opts.mode === "edit" ? opts.metadata : null, newBoundary()) }] }];
  let usage = ZERO;
  let model = opts.provider.model;
  let calls = 0;
  let best: { bp: Blueprint; contextKeys: string[] } | null = null;
  let validation: BlueprintValidation = { ok: false, errors: [], warnings: [] };
  let error: string | null = null;

  for (let round = 0; round <= AI_BUILDER_LIMITS.maxRepairRounds; round += 1) {
    const res = await opts.provider.complete({ system, messages, tools: [tool], maxTokens: AI_BUILDER_LIMITS.maxTokensPerCall });
    calls += 1;
    usage = addUsage(usage, res.usage);
    model = res.model || model;
    const call = res.content.find((b): b is Extract<AiBlock, { type: "tool_use" }> => b.type === "tool_use" && b.name === tool.name);
    if (!call) {
      const other = res.content.find((b) => b.type === "tool_use");
      error =
        res.stopReason === "max_tokens"
          ? "AI hết trần token trước khi nộp gói — rút gọn mô tả hoặc chia làm nhiều lượt sửa."
          : res.stopReason === "refusal"
            ? "AI từ chối yêu cầu."
            : other
              ? "AI gọi một công cụ không có — câu trả lời bị bỏ."
              : "AI trả lời không qua công cụ — câu trả lời bị bỏ (chỉ nhận gói nộp qua công cụ).";
      if (!best) validation = { ok: false, errors: [{ path: "", message: error }], warnings: [] };
      break;
    }
    const n = normalizeToolInput(call.input, opts.mode, key, opts.org);
    if (n.ok) {
      // Vai trò AI đề xuất không được mang quyền của module ngoài gói (pilot P2 #18) — trả về để AI tự bỏ, không cài quyền chết.
      validation = validateBlueprint(n.bp, { roleModulePermissions: "error" });
      best = { bp: n.bp, contextKeys: n.contextKeys };
    } else validation = { ok: false, errors: [{ path: "", message: n.message }], warnings: [] };
    if (validation.ok) {
      error = null;
      break;
    }
    if (round === AI_BUILDER_LIMITS.maxRepairRounds) {
      error = `Gói còn ${validation.errors.length} lỗi sau ${AI_BUILDER_LIMITS.maxRepairRounds} lượt sửa — xem lỗi, bỏ chọn mục hỏng hoặc gửi yêu cầu rõ hơn.`;
      break;
    }
    messages.push({ role: "assistant", content: [call] }, { role: "user", content: [{ type: "tool_result", toolUseId: call.id, content: feedback(validation.errors), isError: true }] });
  }

  return {
    blueprint: best?.bp ?? null,
    contextKeys: best?.contextKeys ?? [],
    validation,
    error,
    calls,
    usage,
    model,
    provider: opts.provider.name,
    costUsd: estimateCostUsd(model, usage),
  };
}

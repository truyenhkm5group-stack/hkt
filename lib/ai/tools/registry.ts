import { z } from "zod";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import type { Permission } from "@/lib/auth/permissions";
import type { CopilotRiskClass, CopilotToolInfo, CopilotToolKind } from "@/lib/ai/contracts";
import type { AiToolDef } from "@/lib/ai/provider";
import type { CareActor } from "@/lib/care/service";
import { isModuleKey, type ModuleKey } from "@/lib/constants/platform-modules";
import { moduleOn } from "@/lib/platform-ui/module-visibility";

/**
 * ═══════════ SỔ ĐĂNG KÝ TOOL — AI KHÔNG BAO GIỜ CHẠM DB TRỰC TIẾP ═══════════
 *
 * Mọi thứ AI "biết" đều đi qua một tool ĐỌC gọi vào `lib/queries/*` (KPI chính thức, không tự tính).
 * Mọi thứ AI "làm" đều đi qua một tool GHI gọi vào lớp nghiệp vụ (`lib/care/service.ts`…) với
 * `actor.source = "AI"`, và CHỈ sau khi người dùng xác nhận (`policy: "confirm"`).
 *
 * Bốn tầng chặn, theo thứ tự:
 *  0. `module`     — module NGUỒN của dữ liệu tool đọc / ghi. Module tắt cho tổ chức của người hỏi ⇒
 *                     tool không được đưa cho model, và gọi thẳng (`run`) thì từ chối `MODULE_DISABLED`
 *                     — kể cả ADMIN, cùng luật với `can()` (target-architecture P8). Không có công cụ
 *                     nào "thuộc mọi module": công cụ tổng hợp khai `core`.
 *  1. `permission` — người dùng không có quyền thì tool không được đưa cho model (không "ẩn hiện").
 *  2. `policy`      — `auto` (đọc) · `confirm` (ghi: đề nghị, chờ người) · `forbidden` (khai ra để
 *                     nói rõ AI KHÔNG được làm, không đưa cho model).
 *  3. `input` zod   — model gõ sai thì tool trả lỗi, không chạy nửa chừng.
 */

export type AiToolPolicy = "auto" | "confirm" | "forbidden";

export type AiToolContext = {
  user: SessionUser;
  /** Actor ghi vào lịch sử case / nhật ký: email người dùng, nguồn AI. */
  actor: CareActor;
  route: string;
  entityType: string;
  entityId: string;
  now: Date;
};

export type AiToolDefinition<I extends z.ZodType = z.ZodType, O = unknown> = {
  name: string;
  /** Nhãn tiếng Việt cho UI / audit. */
  label: string;
  description: string;
  kind: CopilotToolKind;
  riskClass: CopilotRiskClass;
  /** Module nguồn (`lib/constants/platform-modules.ts`) — bắt buộc; khoá lạ ⇒ `defineTool` ném. */
  module: ModuleKey;
  permission: Permission;
  policy: AiToolPolicy;
  input: I;
  /** Một câu mô tả hành động ghi để người xác nhận — chỉ tool ghi. */
  summarize?: (input: z.infer<I>) => string;
  run: (ctx: AiToolContext, input: z.infer<I>) => Promise<O>;
};

/**
 * Chính sách theo NHÓM RỦI RO — sàn tối thiểu; tool có thể chặt hơn, không được lỏng hơn.
 * Tài chính / tồn kho / ĐVVC / phá huỷ: MVP này AI không được ghi. Mở ra là quyết định của chủ shop.
 */
export const RISK_FLOOR: Record<CopilotRiskClass, AiToolPolicy> = {
  general: "auto",
  care: "confirm",
  carrier: "forbidden",
  finance: "forbidden",
  inventory: "forbidden",
  destructive: "forbidden",
};
const POLICY_RANK: Record<AiToolPolicy, number> = { auto: 0, confirm: 1, forbidden: 2 };

const registry = new Map<string, AiToolDefinition>();

/** Mã từ chối khi module nguồn của tool đang tắt — cùng mã với `apiGuard` / `ModuleDisabledError`. */
export const TOOL_MODULE_DISABLED = "MODULE_DISABLED" as const;

export class ToolModuleDisabledError extends Error {
  readonly code = TOOL_MODULE_DISABLED;
  constructor(
    readonly tool: string,
    readonly module: ModuleKey,
  ) {
    super(`Công cụ "${tool}" thuộc module «${module}» — module này chưa được bật cho tổ chức của bạn.`);
    this.name = "ToolModuleDisabledError";
  }
}

/** Module của tool có bật cho người này không. `modules` vắng mặt (người dựng tay trong kiểm thử) ⇒ không cổng module. */
export function toolModuleEnabled(user: Pick<SessionUser, "modules">, tool: Pick<AiToolDefinition, "module">): boolean {
  return moduleOn(user, tool.module);
}

export function defineTool<I extends z.ZodObject, O>(def: AiToolDefinition<I, O>): AiToolDefinition<I, O> {
  if (!/^[a-z][a-z0-9_]{2,40}$/.test(def.name)) throw new Error(`Tên tool không hợp lệ: ${def.name}`);
  if (!isModuleKey(def.module)) throw new Error(`${def.name}: module "${String(def.module)}" không có trong sổ module`);
  if (def.kind === "write" && def.policy === "auto") throw new Error(`${def.name}: tool ghi không được chạy tự động`);
  if (POLICY_RANK[def.policy] < POLICY_RANK[RISK_FLOOR[def.riskClass]]) throw new Error(`${def.name}: nhóm ${def.riskClass} đòi tối thiểu "${RISK_FLOOR[def.riskClass]}"`);
  if (def.kind === "write" && !def.summarize) throw new Error(`${def.name}: tool ghi phải có summarize() để người xác nhận đọc được`);
  if (registry.has(def.name)) throw new Error(`Tool trùng tên: ${def.name}`);
  /*
    CỔNG MODULE Ở CHÍNH `run`, không chỉ ở danh sách: mọi lối gọi (copilot, lượt xác nhận, job tự động
    gọi thẳng `xTool.run(ctx, …)`) đi qua đây. Lọc danh sách mà quên cổng này thì một đường gọi mới
    là một cửa sau vào dữ liệu của module đã tắt.
  */
  const run = def.run;
  const guarded: AiToolDefinition<I, O> = {
    ...def,
    run: async (ctx, input) => {
      if (!toolModuleEnabled(ctx.user, def)) throw new ToolModuleDisabledError(def.name, def.module);
      return run(ctx, input);
    },
  };
  registry.set(def.name, guarded as unknown as AiToolDefinition);
  return guarded;
}

export function getTool(name: string): AiToolDefinition | undefined {
  return registry.get(name);
}

export function allTools(): AiToolDefinition[] {
  return [...registry.values()];
}

/** Tool người dùng này được dùng: module bật, đúng quyền và không bị cấm. `forbidden` không bao giờ tới model. */
export function toolsFor(user: SessionUser): AiToolDefinition[] {
  return allTools().filter((t) => t.policy !== "forbidden" && toolModuleEnabled(user, t) && can(user, t.permission));
}

/** Vì sao một tool không dùng được — để UI / audit nói rõ, không im lặng. */
export function toolAccess(user: SessionUser, tool: AiToolDefinition): { allowed: boolean; reason: string } {
  if (!toolModuleEnabled(user, tool)) return { allowed: false, reason: `${TOOL_MODULE_DISABLED}: module «${tool.module}» chưa được bật cho tổ chức` };
  if (tool.policy === "forbidden") return { allowed: false, reason: `AI không được ${tool.label.toLowerCase()} (nhóm ${tool.riskClass})` };
  if (!can(user, tool.permission)) return { allowed: false, reason: `Thiếu quyền ${tool.permission}` };
  return { allowed: true, reason: tool.policy === "confirm" ? "Chỉ chạy sau khi bạn xác nhận" : "Đọc tự động" };
}

export function describeTools(user: SessionUser): CopilotToolInfo[] {
  return allTools().map((t) => ({ name: t.name, label: t.label, kind: t.kind, riskClass: t.riskClass, description: t.description, ...toolAccess(user, t) }));
}

/**
 * JSON Schema chặt cho model: không cho thêm khoá lạ, mọi khoá đều bắt buộc (khoá "tuỳ chọn" khai
 * `nullable()` trong zod). Nhờ vậy `strict: true` ở provider có nghĩa thật.
 */
export function strictInputSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete raw.$schema;
  const props = (raw.properties ?? {}) as Record<string, unknown>;
  raw.type = "object";
  raw.properties = props;
  raw.required = Object.keys(props);
  raw.additionalProperties = false;
  return raw;
}

export function toProviderTools(tools: AiToolDefinition[]): AiToolDef[] {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: strictInputSchema(t.input), kind: t.kind }));
}

/** Chỉ cho kiểm thử: xoá sổ để đăng ký lại. */
export function resetToolsForTests() {
  registry.clear();
}

/**
 * SỔ ĐĂNG KÝ NHÂN SỰ AI.
 *
 * Khai báo nằm trong mã nguồn (đọc được, xét duyệt được qua pull request); CSDL chỉ giữ phần
 * NGƯỜI chỉnh được: nấc quyền hạn, bật/tắt. `ensureAgents()` đồng bộ một chiều từ mã → CSDL,
 * và tuyệt đối KHÔNG hạ/nâng nấc quyền hạn của dòng đã có — đó là quyết định của chủ shop.
 */
import { eq } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { effectiveMode, getAiSettings, type AiSettings } from "@/lib/ai/config";
import type { AgentMode } from "@/lib/constants/ai";
import type { AiEventType } from "@/lib/constants/ai-events";
import { SALES_AGENT } from "@/lib/ai/agents/sales/definition";
import type { ToolName } from "@/lib/constants/ai-tools";

export type AgentDefinition = {
  /** Khoá ổn định — đã lưu trong `ai_runs`, KHÔNG đổi. */
  key: string;
  name: string;
  description: string;
  /** Số bản hiện tại trong mã nguồn; tăng khi đổi lời dặn / danh sách công cụ / định tuyến. */
  version: number;
  systemPrompt: string;
  allowedTools: ToolName[];
  subscribes: AiEventType[];
  routing: Record<string, unknown>;
  notes: string;
};

/** Mọi nhân sự AI của hệ thống. Thêm nhân sự mới = thêm một dòng ở đây. */
export const AGENT_DEFINITIONS: AgentDefinition[] = [SALES_AGENT];

export function agentDefinition(key: string): AgentDefinition | null {
  return AGENT_DEFINITIONS.find((a) => a.key === key) ?? null;
}

export type RegisteredAgent = {
  id: string;
  key: string;
  name: string;
  mode: AgentMode;
  enabled: boolean;
  versionId: string | null;
  version: number;
  definition: AgentDefinition;
};

/**
 * Đảm bảo mỗi nhân sự trong mã nguồn có một dòng trong CSDL và một bản khớp với mã nguồn.
 * Idempotent: chạy lại không tạo thêm bản nếu nội dung không đổi.
 */
export async function ensureAgents(db?: Db): Promise<void> {
  const conn = db ?? (await getDb());
  for (const definition of AGENT_DEFINITIONS) {
    const existing = await conn.query.aiAgents.findFirst({ where: eq(schema.aiAgents.key, definition.key) });
    let agentId = existing?.id ?? "";
    if (!existing) {
      const [row] = await conn
        .insert(schema.aiAgents)
        .values({
          key: definition.key,
          name: definition.name,
          description: definition.description,
          // Dòng mới luôn sinh ra ở nấc an toàn; nâng nấc là việc của chủ shop.
          mode: "SHADOW",
          enabled: true,
          subscribes: definition.subscribes,
        })
        .returning({ id: schema.aiAgents.id });
      agentId = row.id;
    } else {
      // Chỉ đồng bộ phần MÃ NGUỒN sở hữu. `mode` và `enabled` là của người, không đụng tới.
      await conn
        .update(schema.aiAgents)
        .set({ name: definition.name, description: definition.description, subscribes: definition.subscribes, updatedAt: new Date() })
        .where(eq(schema.aiAgents.id, agentId));
    }

    const version = await conn.query.aiAgentVersions.findFirst({
      where: (v, { and, eq: e }) => and(e(v.agentId, agentId), e(v.version, definition.version)),
    });
    let versionId = version?.id ?? "";
    if (!version) {
      const [row] = await conn
        .insert(schema.aiAgentVersions)
        .values({
          agentId,
          version: definition.version,
          systemPrompt: definition.systemPrompt,
          allowedTools: definition.allowedTools,
          routing: definition.routing,
          notes: definition.notes,
          createdBy: "registry",
        })
        .returning({ id: schema.aiAgentVersions.id });
      versionId = row.id;
    }
    await conn.update(schema.aiAgents).set({ activeVersionId: versionId }).where(eq(schema.aiAgents.id, agentId));
  }
}

/** Nhân sự AI đã đăng ký, kèm nấc quyền hạn CÓ HIỆU LỰC (đã kẹp trần và đã xét cờ tắt tổng). */
export async function getAgent(key: string, settings?: AiSettings, db?: Db): Promise<RegisteredAgent | null> {
  const definition = agentDefinition(key);
  if (!definition) return null;
  const conn = db ?? (await getDb());
  const cfg = settings ?? (await getAiSettings());
  let row = await conn.query.aiAgents.findFirst({ where: eq(schema.aiAgents.key, key) });
  if (!row) {
    await ensureAgents(conn);
    row = await conn.query.aiAgents.findFirst({ where: eq(schema.aiAgents.key, key) });
  }
  if (!row) return null;
  const mode = row.enabled ? effectiveMode(key, row.mode, cfg) : "OFF";
  return { id: row.id, key, name: row.name, mode, enabled: row.enabled, versionId: row.activeVersionId, version: definition.version, definition };
}

/** Nhân sự nào nhận loại sự kiện này (theo khai báo trong mã nguồn). */
export function agentsForEvent(type: AiEventType): AgentDefinition[] {
  return AGENT_DEFINITIONS.filter((a) => a.subscribes.includes(type));
}

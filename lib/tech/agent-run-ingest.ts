import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { isUniqueViolation } from "@/lib/db/unique-violation";
import { AGENT_INGEST, INGESTABLE_STATUSES, type IngestableStatus } from "@/lib/constants/agent-ingest";
import type { TechGateResult } from "@/lib/constants/tech";
import { recordTechTaskEvent } from "@/lib/tech/service";

/**
 * ═══════════ CHÉP MỘT LƯỢT CHẠY AGENT ĐÃ KẾT THÚC VÀO SỔ PRODUCTION ═══════════
 *
 * Đây là TOÀN BỘ đường ghi của cửa `/api/tech/agent-run`. Nó cố ý hẹp tới mức nhàm chán:
 *
 *  · **Không nhận tên bảng, không nhận SQL, không nhận cột tuỳ ý.** Chỉ đúng những trường dưới
 *    đây, và mỗi trường đi vào đúng một cột đã biết. Một cửa nhận được `table` hay `where` thì
 *    không còn là cửa hẹp, dù nó tên gì.
 *  · **Chỉ TẠO, không bao giờ SỬA một dòng đã có.** Gọi lại với cùng khoá ⇒ trả về dòng cũ, không
 *    ghi gì. Nên không có đường nào để viết lại lịch sử qua cửa này.
 *  · **Chỉ nhận trạng thái ĐÃ KẾT THÚC.** `RUNNING` bị từ chối — ERP không quan sát được một lượt
 *    chạy đang diễn ra ở máy khác, nên một dòng `RUNNING` ở đây là lời khai không ai kiểm được, và
 *    nếu máy Actions chết giữa chừng thì nó nằm lại vĩnh viễn.
 *  · **Không đụng `tech_tasks.status`.** Một lượt chạy xong KHÔNG phải một việc xong; chuyển trạng
 *    thái việc là quyết định, và quyết định không đi qua một endpoint máy gọi máy.
 *
 * Chống phát lại nằm ở **khoá duy nhất `tech_agent_runs.external_ref`** trong CSDL, không ở mã —
 * xem `drizzle/0107_agent_run_external_ref.sql`.
 */

export type AgentRunIngestInput = {
  externalRef: string;
  agentKey: string;
  /** Mã việc (`TECH-12`). Rỗng = lượt chạy không gắn việc nào — hợp lệ, không phải thiếu. */
  taskCode?: string;
  status: IngestableStatus;
  branch?: string;
  baseCommit?: string;
  resultCommit?: string;
  summary?: string;
  error?: string;
  testsRun?: string;
  gates?: Partial<Record<"typecheck" | "lint" | "test" | "build", TechGateResult>>;
  filesChanged?: string[];
  startedAt?: Date;
  endedAt?: Date;
  /** Đường dẫn tới lượt chạy bên ngoài, để người đọc mở được bằng chứng gốc. */
  externalUrl?: string;
};

export type AgentRunIngestResult =
  | { ok: true; runId: string; created: boolean; agentKey: string; taskCode: string | null }
  | { error: string; code: "UNKNOWN_AGENT" | "AGENT_DISABLED" | "UNKNOWN_TASK" | "BAD_STATUS" | "WRITE_FAILED" };

const GATE_MAC_DINH: TechGateResult = "UNKNOWN";

export async function ingestAgentRun(input: AgentRunIngestInput): Promise<AgentRunIngestResult> {
  if (!INGESTABLE_STATUSES.includes(input.status)) {
    return { error: `Chỉ nhận lượt chạy ĐÃ KẾT THÚC (${INGESTABLE_STATUSES.join(" · ")}). Nhận được “${input.status}”.`, code: "BAD_STATUS" };
  }
  const db = await getDb();

  /*
    ĐÃ CÓ RỒI THÌ TRẢ VỀ, KHÔNG GHI GÌ.

    Đây là nhánh IDEMPOTENT ở tầng mã — nó làm lượt gọi lặp trở nên RẺ và trả lời đúng. Nhưng nó
    KHÔNG phải thứ bảo đảm: hai gói tin tới cùng lúc đều đọc thấy "chưa có" rồi cùng ghi. Thứ chặn
    ca đó là khoá duy nhất ở CSDL, và nhánh `catch` bên dưới đọc lại đúng dòng mà khoá ấy vừa giữ.
  */
  const daCo = await db.query.techAgentRuns.findFirst({ where: eq(schema.techAgentRuns.externalRef, input.externalRef), columns: { id: true, agentKey: true, taskId: true } });
  if (daCo) return { ok: true, runId: daCo.id, created: false, agentKey: daCo.agentKey, taskCode: null };

  const agent = await db.query.techAgents.findFirst({ where: eq(schema.techAgents.key, input.agentKey), columns: { id: true, key: true, name: true, enabled: true } });
  if (!agent) return { error: `Không có vai agent “${input.agentKey}” trong sổ.`, code: "UNKNOWN_AGENT" };
  /*
    VAI ĐANG TẮT VẪN ĐƯỢC CHÉP SỔ — và đó là chủ ý.

    Cửa này KHÔNG cho phép agent làm gì cả; lượt chạy ĐÃ xảy ra rồi, ở một máy khác, dưới hàng rào
    của chính máy đó. Từ chối ghi vì vai đang tắt là XOÁ BẰNG CHỨNG về một việc đã xảy ra — đúng
    thứ tệ nhất một sổ quan sát có thể làm. Cờ `enabled` chặn ở chỗ MỞ lượt chạy (`startTechAgentRun`),
    không phải ở chỗ ghi lại nó.
  */

  let taskId: string | null = null;
  let taskCode: string | null = null;
  const ma = (input.taskCode ?? "").trim();
  if (ma) {
    const task = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.code, ma), columns: { id: true, code: true } });
    if (!task) return { error: `Không có việc “${ma}” trong sổ.`, code: "UNKNOWN_TASK" };
    taskId = task.id;
    taskCode = task.code;
  }

  const gates = input.gates ?? {};
  const batDau = input.startedAt ?? new Date();
  const ketThuc = input.endedAt ?? new Date();
  try {
    const [row] = await db
      .insert(schema.techAgentRuns)
      .values({
        agentId: agent.id,
        agentKey: agent.key,
        taskId,
        externalRef: input.externalRef,
        status: input.status,
        startedAt: batDau,
        endedAt: ketThuc,
        branch: (input.branch ?? "").trim(),
        baseCommit: (input.baseCommit ?? "").trim(),
        resultCommit: (input.resultCommit ?? "").trim(),
        summary: (input.summary ?? "").trim().slice(0, 4000),
        error: (input.error ?? "").trim().slice(0, 4000),
        testsRun: (input.testsRun ?? "").trim().slice(0, 4000),
        typecheckResult: gates.typecheck ?? GATE_MAC_DINH,
        lintResult: gates.lint ?? GATE_MAC_DINH,
        testResult: gates.test ?? GATE_MAC_DINH,
        buildResult: gates.build ?? GATE_MAC_DINH,
        filesChanged: (input.filesChanged ?? []).slice(0, AGENT_INGEST.maxFilesChanged),
        /*
          `metadata` KHAI RÕ DÒNG NÀY ĐẾN TỪ ĐÂU.

          Một dòng chép về từ máy khác và một dòng do chính ERP mở ra trông giống hệt nhau trong
          bảng. Không phân biệt được thì mọi phép đo "agent chạy thế nào" trộn hai nguồn có độ tin
          cậy khác nhau — cùng lý do `tech_deployments` tách `MANUAL` khỏi `GITHUB_ACTIONS`.
        */
        metadata: { source: "EXTERNAL_INGEST", externalRef: input.externalRef, externalUrl: (input.externalUrl ?? "").trim() || null },
      })
      .returning({ id: schema.techAgentRuns.id });

    if (taskId) {
      await recordTechTaskEvent(
        {
          taskId,
          kind: "RUN",
          note: `Chép lượt chạy ${agent.key} từ máy ngoài (${input.externalRef})`,
          nextValue: input.status,
          payload: { runId: row.id, externalRef: input.externalRef, externalUrl: input.externalUrl ?? null },
        },
        // MÁY làm. `id: null` ở đây có nghĩa rõ ràng, khác hẳn "chưa biết ai" (AGENTS.md mục 34).
        { kind: "SYSTEM", name: "api:agent-run-ingest" },
      );
    }
    await audit({
      userId: null,
      userEmail: "service:agent-run-ingest",
      action: "TECH_AGENT_RUN_INGESTED",
      entity: "TECH_AGENT_RUN",
      entityId: row.id,
      after: { externalRef: input.externalRef, agentKey: agent.key, taskCode, status: input.status },
      reason: "Chép sổ lượt chạy agent từ máy GitHub Actions — máy đó không nối được CSDL production.",
    });
    return { ok: true, runId: row.id, created: true, agentKey: agent.key, taskCode };
  } catch (error) {
    /*
      KHOÁ DUY NHẤT VỪA CHẶN MỘT LƯỢT GHI SONG SONG — ĐỌC LẠI, KHÔNG BÁO HỎNG.

      Hai gói tin cùng khoá tới cùng lúc: một cái thắng, cái kia rơi vào đây. Đó là idempotent
      đang LÀM ĐÚNG VIỆC của nó, không phải một lỗi. Trả về dòng của kẻ thắng.
    */
    if (isUniqueViolation(error, "tech_agent_runs_external_ref_uq")) {
      const lai = await db.query.techAgentRuns.findFirst({ where: eq(schema.techAgentRuns.externalRef, input.externalRef), columns: { id: true, agentKey: true } });
      if (lai) return { ok: true, runId: lai.id, created: false, agentKey: lai.agentKey, taskCode };
    }
    return { error: error instanceof Error ? error.message : String(error), code: "WRITE_FAILED" };
  }
}

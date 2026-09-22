import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { canDispatchTask } from "@/lib/constants/agent-dispatch";
import { writeGlobsForRole } from "@/lib/constants/agent-scopes";

/**
 * ═══════════ NẤC 3B · CỬA ĐỌC HẸP — AGENT NHẬN ĐƯỢC ĐÚNG VIỆC ĐƯỢC GIAO ═══════════
 *
 * ─── CHỖ HỞ NẤC 3 ĐỂ LẠI, VÀ ĐÃ NÓI RA ───
 *
 * `agent-run.yml` tự tạo việc R0 của riêng nó, nên bấm "khởi động lượt chạy" ở `TECH-12` KHÔNG
 * làm `TECH-12`. Nấc 3 thu hẹp lời nói cho khớp mã nguồn; nấc này đóng chỗ hở.
 *
 * ─── VÌ SAO KHÔNG TRUYỀN VIỆC QUA `inputs` CỦA WORKFLOW ───
 *
 * Kho này PUBLIC, và đầu vào của `workflow_dispatch` hiện NGUYÊN VĂN trong giao diện Actions và
 * trong log. Nhét tiêu đề + mô tả việc Tech vào đó là công khai nội dung nội bộ cho mọi người.
 * Nên việc đi qua một cửa ĐỌC, đối xứng với cửa GHI `/api/tech/agent-run` và dùng chung khoá.
 *
 * ─── CỬA NÀY TRẢ VỀ ÍT NHẤT CÓ THỂ ───
 *
 * Chỉ sáu trường agent THẬT SỰ cần để làm việc, cộng phạm vi ghi của vai. KHÔNG trả về: ai duyệt,
 * ghi chú nội bộ, dữ liệu PR, tên người, lịch sử. Một cửa đọc trả về "cả dòng cho tiện" sẽ rò rỉ
 * mọi cột được thêm vào bảng sau này — kể cả cột chưa tồn tại lúc viết cửa.
 *
 * ─── VÀ NÓ CHỈ TRẢ VỀ VIỆC ĐƯỢC PHÉP GIAO ───
 *
 * Dùng LẠI `canDispatchTask()` — đúng bộ luật mà nút "khởi động lượt chạy" dùng. Nếu cửa đọc rộng
 * hơn cổng giao việc thì nó trở thành đường vòng: ai có khoá đọc được mọi việc Tech kể cả R2 và
 * việc chưa duyệt. Hai nơi phải hỏi CÙNG một hàm, không phải hai bản sao của cùng một ý.
 */

export type AgentTaskPayload = {
  code: string;
  title: string;
  description: string;
  taskType: string;
  module: string;
  risk: string;
  agentKey: string;
  /** Phạm vi ghi của vai được gán — để runner dựng hàng rào ĐÚNG cho vai ấy. */
  writeGlobs: readonly string[];
  /**
   * Mức rủi ro CHỦ SHOP đã cấp cho vai này, đọc từ `tech_agents` trên production.
   *
   * Runner chạy trên máy GitHub Actions với một CSDL PGlite DÙNG-MỘT-LẦN, gieo từ
   * `TECH_AGENT_TEMPLATES` trong mã. Mẫu khai `documentation: ["R0"]`, nên bản mirror cục bộ nói
   * MỘT ĐẰNG còn production nói MỘT NẺO — và runner tin bản cục bộ.
   *
   * Đã cắn thật 22/09/2026: chủ shop cấp R2 cho `documentation`, việc TECH-12 đi qua đủ mọi cổng
   * của ERP, rồi runner chặn lại bằng *"agent Tài liệu chỉ được phép R0"* — một câu KHÔNG còn đúng
   * ở nơi có thẩm quyền. Cờ `enabled` xưa nay vẫn đi theo đường này; mức rủi ro thì bị bỏ quên.
   *
   * Đây KHÔNG phải chỗ để "không tin lời ERP": mức được cấp là QUYẾT ĐỊNH của chủ shop, ghi ở
   * production, và runner không có cách nào tự suy ra. Thứ runner tự kiểm lại là MỨC RỦI RO CỦA
   * VIỆC và PHẠM VI GHI — hai thứ suy được từ dữ liệu, và vẫn được kiểm ở `agent-fetch-task.ts`.
   */
  agentAllowedRisks: readonly string[];
};

export type AgentTaskResult = { ok: true; task: AgentTaskPayload } | { error: string; code: "UNKNOWN_TASK" | "NOT_DISPATCHABLE" };

export async function readAgentTask(taskCode: string): Promise<AgentTaskResult> {
  const db = await getDb();
  const ma = taskCode.trim();
  if (!ma) return { error: "Thiếu mã việc.", code: "UNKNOWN_TASK" };

  const task = await db.query.techTasks.findFirst({
    where: eq(schema.techTasks.code, ma),
    columns: {
      code: true,
      title: true,
      description: true,
      taskType: true,
      module: true,
      risk: true,
      status: true,
      approvalRequired: true,
      approvalStatus: true,
      agentId: true,
    },
  });
  /*
    VIỆC LẠ VÀ VIỆC KHÔNG ĐƯỢC GIAO TRẢ HAI MÃ KHÁC NHAU cho NGƯỜI VẬN HÀNH đọc trong log, nhưng
    tầng HTTP trả CÙNG một 404 cho cả hai — xem `app/api/tech/agent-task/route.ts`. Phân biệt ở
    đây để sửa được; không phân biệt ngoài kia để không biến cửa thành máy dò sự tồn tại của việc.
  */
  if (!task) return { error: `Không có việc “${ma}”.`, code: "UNKNOWN_TASK" };

  const agent = task.agentId ? await db.query.techAgents.findFirst({ where: eq(schema.techAgents.id, task.agentId), columns: { key: true, role: true, enabled: true, allowedRisks: true } }) : null;

  const v = canDispatchTask({
    code: task.code,
    risk: task.risk,
    status: task.status,
    approvalRequired: task.approvalRequired,
    approvalStatus: task.approvalStatus,
    agentKey: agent?.key ?? null,
    /*
      CỬA ĐỌC ÁP ĐÚNG CỔNG CỦA ĐƯỜNG GIAO VIỆC — hai nơi, MỘT luật.

      Cửa này là thứ agent trên máy Actions gọi để lấy nội dung việc. Nếu nó hỏi ít điều kiện hơn
      `dispatch-service`, thì một việc không giao được qua nút vẫn đọc được qua cửa — tức hàng rào
      có hai bản và bản lỏng hơn là bản thật.
    */
    agentAllowedRisks: agent ? agent.allowedRisks : null,
    agentWriteGlobs: agent ? writeGlobsForRole(agent.role) : null,
  });
  if (!v.ok) return { error: v.reason, code: "NOT_DISPATCHABLE" };
  if (agent && !agent.enabled) return { error: `Vai “${agent.key}” đang TẮT trong sổ agent.`, code: "NOT_DISPATCHABLE" };

  return {
    ok: true,
    task: {
      code: task.code,
      title: task.title,
      description: task.description,
      taskType: task.taskType,
      module: task.module,
      risk: task.risk,
      agentKey: agent?.key ?? "",
      writeGlobs: writeGlobsForRole(agent?.role ?? null),
      agentAllowedRisks: agent?.allowedRisks ?? [],
    },
  };
}

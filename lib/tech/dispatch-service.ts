import { and, eq, gte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { writeGlobsForRole } from "@/lib/constants/agent-scopes";
import { DISPATCH_AUDIT_ACTION, canDispatchTask, checkDispatchQuota, type DispatchVerdict, type QuotaVerdict } from "@/lib/constants/agent-dispatch";
import { dispatchAgentRun, dispatchConfig } from "@/lib/integrations/github/dispatch";
import { recordTechTaskEvent, setTechTaskStatus, type TechActor } from "@/lib/tech/service";
import { checkRerun } from "@/lib/constants/agent-rerun";
import { TECH_TASK_TRANSITIONS, type TechTaskStatus } from "@/lib/constants/tech";

/**
 * ═══════════ NẤC 3 · GIAO VIỆC CHO AGENT — ĐƯỜNG THỰC THI ═══════════
 *
 * Luật thuần nằm ở `lib/constants/agent-dispatch.ts`. Tệp này ghép chúng với CSDL và với cửa ghi
 * GitHub, theo đúng MỘT thứ tự, và thứ tự ấy là một tính chất chứ không phải một chi tiết:
 *
 *     cấu hình  →  việc  →  hạn mức  →  GỬI  →  ghi vết
 *
 * ─── GIỚI HẠN PHẢI NÓI RA: LƯỢT CHẠY CHƯA NHẬN ĐƯỢC VIỆC NÀY ───
 *
 * `agent-run.yml` hôm nay chỉ nhận MỘT đầu vào: `gates`. Nó tự tạo việc R0 của riêng nó bằng
 * `agent:proof-setup` rồi chạy agent trên việc ấy. Nghĩa là: bấm "giao việc" cho `TECH-12` sẽ
 * KHỞI ĐỘNG một lượt chạy, nhưng lượt chạy đó KHÔNG làm `TECH-12`.
 *
 * Lý do chưa trao được việc: runner nằm trên máy GitHub Actions với một CSDL PGlite dùng-một-lần,
 * nên nó KHÔNG đọc được `tech_tasks` của production. Hai lối trao việc, và lối thứ nhất bị loại:
 *
 *   · truyền tiêu đề/mô tả việc qua `inputs` của `workflow_dispatch` — KHÔNG: kho này PUBLIC, và
 *     đầu vào dispatch hiện nguyên văn trong giao diện Actions. Nội dung việc Tech trở thành công
 *     khai.
 *   · một cửa ĐỌC hẹp trên ERP, đối xứng với cửa ghi `/api/tech/agent-run` — ĐÃ DỰNG (Nấc 3b):
 *     `GET /api/tech/agent-task`, xác thực bằng khoá.
 *
 * Nên từ Nấc 3b, MÃ việc đi kèm dispatch và nội dung đi qua cửa đọc có khoá: nút này giao ĐÚNG
 * việc người vừa bấm. Đoạn văn cũ ở đây còn nói "chưa làm" sau khi nó đã làm xong — một tài liệu
 * nói sai về hệ thống của chính mình còn tệ hơn không có tài liệu, nên sửa luôn ở bản này.
 *
 * ─── VÌ SAO HẠN MỨC ĐẾM SAU CÙNG, NGAY TRƯỚC LÚC GỬI ───
 *
 * Đếm sớm rồi mới kiểm việc nghĩa là một lượt bấm vào việc KHÔNG HỢP LỆ vẫn tiêu một suất trong
 * trần giờ. Người dùng bấm nhầm ba lần là mất ba suất mà chưa lượt chạy nào khởi động.
 *
 * ─── VÌ SAO GHI VẾT SAU KHI GỬI, KHÔNG PHẢI TRƯỚC ───
 *
 * `audit_logs` vừa là nhật ký vừa là SỔ ĐẾM hạn mức. Ghi trước rồi gửi hỏng ⇒ một suất bị tiêu
 * cho một lượt chạy chưa từng tồn tại. Ghi sau ⇒ nếu tiến trình chết đúng giữa hai bước, ta mất
 * một dòng nhật ký nhưng KHÔNG chặn nhầm người dùng. Trong hai kiểu sai, kiểu thứ hai rẻ hơn và
 * tự lộ ra (lượt chạy có trên GitHub mà không có trong sổ), còn kiểu thứ nhất im lặng.
 */

export type DispatchOutcome =
  | { ok: true; taskId: string; taskCode: string; agentKey: string; workflow: string; ref: string; conLaiGio: number; conLaiNgay: number }
  | { ok: false; code: "UNKNOWN_TASK" | "NOT_CONFIGURED" | "TASK" | "QUOTA" | "GITHUB"; reason: string };

/** Đếm lượt đã giao trong N giờ qua, đọc từ `audit_logs` — không thêm bảng mới cho một con số. */
async function demTuNhatKy(gio: number): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.auditLogs)
    .where(and(eq(schema.auditLogs.action, DISPATCH_AUDIT_ACTION), gte(schema.auditLogs.createdAt, new Date(Date.now() - gio * 3600_000))));
  return Number(row?.n ?? 0);
}

export async function dispatchTaskToAgent(input: {
  taskCode: string;
  gates: string;
  actor: { id: string; email: string; name: string };
  /**
   * LƯỢT SỬA theo review: chạy lại trên CHÍNH nhánh của việc, kèm phản hồi.
   *
   * Trước 23/09/2026 vòng "review → agent sửa" chỉ chạy được từ một script trên máy của CTO — ERP
   * chỉ giao được lượt ĐẦU. Chủ shop không tự đóng được vòng review. Nhánh ở đây KHÔNG nhận từ nơi
   * gọi: nó đọc từ sổ việc, vì tên nhánh đi thẳng vào lệnh `git` trên máy runner.
   */
  rerun?: { feedback: string };
}): Promise<DispatchOutcome> {
  /* ───────── 1 · CỔNG CẤU HÌNH — kiểm TRƯỚC khi đụng CSDL ───────── */
  const cfg = dispatchConfig();
  if (!cfg.configured) return { ok: false, code: "NOT_CONFIGURED", reason: cfg.reason ?? "Chưa bật cửa giao việc." };

  const db = await getDb();
  const task = await db.query.techTasks.findFirst({
    where: eq(schema.techTasks.code, input.taskCode),
    columns: { id: true, code: true, risk: true, status: true, approvalRequired: true, approvalStatus: true, agentId: true, branch: true },
  });
  if (!task) return { ok: false, code: "UNKNOWN_TASK", reason: `Không có việc \`${input.taskCode}\`.` };

  /*
    LƯỢT SỬA: việc phải CÓ nhánh, và phải chuyển được về "Đang làm".

    Chuyển trạng thái ở đây là QUYẾT ĐỊNH của người bấm ("review xong, giao lại sửa"), không phải
    một lối tắt: `REVIEW → BUILDING` và `QA → BUILDING` đều là chuyển trạng thái hợp lệ sẵn có.
    Cổng giao việc KHÔNG được nới cho `QA` — trạng thái đổi trước, cổng vẫn hỏi đúng câu cũ.
  */
  const laSua = input.rerun !== undefined;
  if (laSua) {
    if (!task.branch) {
      return { ok: false, code: "TASK", reason: `Việc ${task.code} chưa có nhánh nào — chưa có lượt chạy nào để mà sửa. Dùng nút giao việc lượt đầu.` };
    }
    const duocChuyen = task.status === "BUILDING" || (TECH_TASK_TRANSITIONS[task.status as TechTaskStatus] ?? []).includes("BUILDING");
    if (!duocChuyen) {
      return { ok: false, code: "TASK", reason: `Việc ${task.code} đang ở trạng thái ${task.status} — không chuyển về "Đang làm" được để giao sửa.` };
    }
  }

  const agent = task.agentId ? await db.query.techAgents.findFirst({ where: eq(schema.techAgents.id, task.agentId), columns: { key: true, enabled: true, role: true, allowedRisks: true } }) : null;

  /* ───────── 2 · CỔNG VIỆC — hàm thuần, trả LÝ DO cụ thể ───────── */
  const vTask: DispatchVerdict = canDispatchTask({
    code: task.code,
    risk: task.risk,
    // Lượt sửa: cổng xét ĐÚNG trạng thái việc sẽ có sau khi người bấm quyết định giao lại.
    status: laSua ? "BUILDING" : task.status,
    approvalRequired: task.approvalRequired,
    approvalStatus: task.approvalStatus,
    agentKey: agent?.key ?? null,
    /*
      HAI TRỤC, KHÔNG PHẢI MỘT.

      Cổng cũ chỉ hỏi "việc này rủi ro mức nào". Nó không bao giờ hỏi "vai được gán ghi được vào
      đâu" — mà đó mới là câu quyết định một lượt chạy hỏng thì hỏng tới đâu. Hai câu hỏi ấy nay
      đi cùng nhau, và `writeGlobsForRole` là sổ DUY NHẤT trả lời câu thứ hai.
    */
    agentAllowedRisks: agent ? agent.allowedRisks : null,
    agentWriteGlobs: agent ? writeGlobsForRole(agent.role) : null,
  });
  if (!vTask.ok) return { ok: false, code: "TASK", reason: vTask.reason };
  /*
    VAI ĐANG TẮT THÌ KHÔNG GIAO ĐƯỢC — khác hẳn với việc CHÉP SỔ một lượt đã chạy.

    Ở `agent-run-ingest` ta VẪN ghi lượt chạy của vai đang tắt, vì lượt ấy đã xảy ra rồi và từ
    chối là xoá bằng chứng. Ở đây thì ngược lại: chưa có gì xảy ra, và cờ `enabled` đúng là cổng
    quyết định có được xảy ra hay không (mục 25 — phân việc tự động mặc định TẮT).
  */
  if (agent && !agent.enabled) {
    return { ok: false, code: "TASK", reason: `Vai \`${agent.key}\` đang TẮT trong sổ agent. Bật nó ở /tech/agents trước — mặc định mọi vai đều tắt.` };
  }

  /* ───────── 3 · CỔNG HẠN MỨC — đếm sau cùng, ngay trước lúc gửi ───────── */
  /* Trần số lượt mỗi việc — `checkRerun`, luật DUY NHẤT, cùng luật script trên máy runner dùng. */
  if (laSua) {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.techAgentRuns).where(eq(schema.techAgentRuns.taskId, task.id));
    const vSua = checkRerun({ branch: task.branch ?? "", agentKey: agent?.key ?? "", soLuotDaCo: Number(n) });
    if (!vSua.ok) return { ok: false, code: "TASK", reason: vSua.reason };
  }

  const [trongGio, trongNgay] = await Promise.all([demTuNhatKy(1), demTuNhatKy(24)]);
  const vQuota: QuotaVerdict = checkDispatchQuota(trongGio, trongNgay);
  if (!vQuota.ok) return { ok: false, code: "QUOTA", reason: vQuota.reason };

  /* ───────── 4 · GỬI ───────── */
  /*
    TRUYỀN MÃ VIỆC — ĐÂY LÀ THỨ NẤC 3B DỰNG CỬA ĐỌC ĐỂ PHỤC VỤ.

    Trước bản vá này, nút "khởi động lượt chạy" ở TECH-n gửi dispatch KHÔNG kèm mã việc, nên
    `agent-run.yml` rơi vào nhánh tự-kiểm: nó tự tạo một việc R0 của riêng nó và agent không bao
    giờ nhận được việc người vừa bấm. Ghi chú sự kiện bên dưới từng NÓI RA điều đó như một hạn
    chế đã biết — tức là dây chuyền có một khúc hỏng được ghi thành tài liệu thay vì được vá.

    Chỉ MÃ đi qua ô công khai; nội dung việc vẫn đi cửa đọc có khoá.
  */
  /*
    ĐỔI TRẠNG THÁI SAU KHI MỌI CỔNG ĐÃ ĐỒNG Ý, TRƯỚC KHI GỌI GITHUB.

    Đổi sớm hơn thì một lượt bị hạn mức chặn để lại việc ở "Đang làm" mà không có lượt chạy nào.
    Gọi GitHub trước thì lượt chạy mở ra đọc thấy việc chưa ở trạng thái giao được và tự dừng.
  */
  const nguoi: TechActor = { kind: "HUMAN", id: input.actor.id, name: input.actor.name || input.actor.email };
  if (laSua && task.status !== "BUILDING") {
    const doi = await setTechTaskStatus({ taskId: task.id, to: "BUILDING", note: "Review xong — giao lại cho agent sửa theo phản hồi." }, nguoi);
    if ("error" in doi) return { ok: false, code: "TASK", reason: doi.error };
  }

  const res = await dispatchAgentRun({
    workflow: "agent-run.yml",
    gates: input.gates,
    taskCode: task.code,
    ...(laSua ? { rerunBranch: task.branch ?? "", feedback: input.rerun!.feedback } : {}),
  });
  if (!res.ok) return { ok: false, code: "GITHUB", reason: res.detail };

  /* ───────── 5 · GHI VẾT ─────────
     `audit()` ghi Ở LỚP ACTION, không ở đây. Hai lý do:

     · Luật nhà (`tests/tech-control-plane.test.ts`): MỌI server action Tech phải tự ghi nhật ký.
       Bộ gác ấy quét `lib/actions/tech.ts`, nên ghi ở tầng dưới là lách nó — và một luật lách
       được một lần sẽ lách được lần sau.
     · Dòng audit CŨNG là sổ đếm hạn mức. Để nó ở nơi bộ gác nhìn thấy nghĩa là bộ gác ấy bảo vệ
       luôn sổ đếm: quên ghi audit ⇒ bài kiểm đỏ ⇒ không thể quên trong im lặng.

     Sự kiện của CHÍNH VIỆC thì ở lại đây — nó thuộc về đường thực thi, không thuộc về màn hình. */
  await recordTechTaskEvent(
    {
      taskId: task.id,
      kind: "RUN",
      note: laSua
        ? `Giao lại cho agent ${agent?.key ?? "?"} SỬA theo review, trên chính nhánh ${task.branch} — phản hồi ${input.rerun!.feedback.trim().length} ký tự.`
        : `Khởi động lượt chạy agent ${agent?.key ?? "?"} (${res.workflow} @ ${res.ref}) cho ĐÚNG việc này — mã việc đi kèm dispatch, nội dung đi qua cửa đọc có khoá.`,
      payload: { workflow: res.workflow, ref: res.ref, gates: input.gates, taskCode: task.code, ...(laSua ? { rerunBranch: task.branch } : {}) },
    },
    nguoi,
  );

  return {
    ok: true,
    taskId: task.id,
    taskCode: task.code,
    workflow: res.workflow,
    ref: res.ref,
    agentKey: agent?.key ?? "",
    conLaiGio: vQuota.conLaiGio - 1,
    conLaiNgay: vQuota.conLaiNgay - 1,
  };
}

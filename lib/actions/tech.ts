"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import {
  TECH_GATE_RESULTS,
  TECH_INCIDENT_SEVERITIES,
  TECH_INCIDENT_STATUSES,
  TECH_MODULES,
  TECH_PRIORITIES,
  TECH_RISKS,
  TECH_TASK_SOURCES,
  TECH_TASK_STATUSES,
  TECH_TASK_TYPES,
} from "@/lib/constants/tech";
import {
  addTechTaskNote,
  assignTechTaskAgent,
  createTechIncident,
  createTechTask,
  decideTechApproval,
  linkTechIncidentToTask,
  overrideTechTaskRisk,
  recordTechDeployment,
  seedTechAgents,
  setTechAgentEnabled,
  setTechIncidentStatus,
  setTechTaskBranch,
  setTechTaskPriority,
  setTechTaskStatus,
  updateTechDeployment,
  verifyTechTaskOnProduction,
  type TechActor,
  type TechResult,
} from "@/lib/tech/service";

/**
 * ───────────── SERVER ACTION CỦA PHÒNG TECH ─────────────
 *
 * Lớp vỏ mỏng: **quyền → zod → dịch vụ → nhật ký → làm mới trang**. Luật vòng đời nằm ở
 * `lib/tech/service.ts` để kiểm thử được mà không cần dựng một phiên đăng nhập.
 *
 * MỌI lượt ghi ở đây mang `kind: "HUMAN"` và khoá tài khoản thật. Không có đường nào để một lượt
 * bấm trên giao diện được ghi thành "agent làm" — Phase 2 gọi thẳng vào dịch vụ với danh tính
 * agent của nó (AGENTS.md mục 34 & 36).
 *
 * `tech:manage` là cổng của MỌI hàm ghi, kể cả những hàm trông vô hại như ghi chú: một dòng ghi chú
 * trên việc chạm lương cũng là một dòng người khác sẽ đọc và tin.
 */

const KHONG_QUYEN = "Bạn không có quyền quản trị Phòng Tech AI";

async function nguoiQuanTri() {
  const user = await requireUser();
  if (!can(user, "tech:manage")) return null;
  return user;
}

function actorOf(user: { id: string; name: string; email: string }): TechActor {
  // Tên là ẢNH CHỤP do MÁY CHỦ đọc từ phiên — không nhận từ client (AGENTS.md mục 34).
  return { kind: "HUMAN", id: user.id, name: user.name || user.email };
}

function loi(error: unknown, mac: string) {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? mac;
  return error instanceof Error && error.message ? error.message : mac;
}

function lamMoi(taskId?: string) {
  revalidatePath("/tech");
  revalidatePath("/tech/tasks");
  revalidatePath("/tech/agents");
  revalidatePath("/tech/deployments");
  revalidatePath("/tech/incidents");
  if (taskId) revalidatePath(`/tech/tasks/${taskId}`);
}

const taoSchema = z.object({
  title: z.string().trim().min(5, "Tiêu đề quá ngắn").max(300),
  description: z.string().trim().max(20_000).optional(),
  taskType: z.enum(TECH_TASK_TYPES),
  module: z.enum(TECH_MODULES),
  priority: z.enum(TECH_PRIORITIES),
  source: z.enum(TECH_TASK_SOURCES),
  sourceRef: z.string().trim().max(500).optional(),
  branch: z.string().trim().max(200).optional(),
  worktree: z.string().trim().max(300).optional(),
  parentTaskId: z.string().trim().max(60).nullish(),
  dependsOn: z.array(z.string().trim().max(60)).max(20).optional(),
  agentId: z.string().trim().max(60).nullish(),
  riskOverride: z.object({ risk: z.enum(TECH_RISKS), reason: z.string().trim().min(10, "Đè mức rủi ro thì phải nói vì sao") }).nullish(),
});

export async function createTechTaskAction(input: unknown): Promise<TechResult<{ id: string; code: string }>> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  let data: z.infer<typeof taoSchema>;
  try {
    data = taoSchema.parse(input);
  } catch (e) {
    return { error: loi(e, "Dữ liệu không hợp lệ") };
  }
  const res = await createTechTask({ ...data, riskOverride: data.riskOverride ?? null }, actorOf(user));
  if ("error" in res) return res;
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "TECH_TASK_CREATED",
    entity: "TECH_TASK",
    entityId: res.id,
    after: { code: res.code, title: data.title, risk: res.risk, priority: data.priority, module: data.module },
    reason: `Nguồn: ${data.source}`,
  });
  lamMoi(res.id);
  return { ok: true, id: res.id, code: res.code };
}

const trangThaiSchema = z.object({
  taskId: z.string().min(1),
  to: z.enum(TECH_TASK_STATUSES),
  note: z.string().trim().max(4000).optional(),
});

export async function setTechTaskStatusAction(input: unknown): Promise<TechResult> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  let data: z.infer<typeof trangThaiSchema>;
  try {
    data = trangThaiSchema.parse(input);
  } catch (e) {
    return { error: loi(e, "Dữ liệu không hợp lệ") };
  }
  const res = await setTechTaskStatus(data, actorOf(user));
  if ("error" in res) return res;
  // Bấm lại đúng trạng thái đang có thì KHÔNG ghi nhật ký: một dòng "đổi từ X sang X" làm loãng
  // nhật ký và khiến người đọc tưởng có việc gì đó vừa xảy ra.
  if (!res.skipped) {
    await audit({ userId: user.id, userEmail: user.email, action: "TECH_TASK_STATUS", entity: "TECH_TASK", entityId: data.taskId, after: { status: data.to }, reason: data.note });
    lamMoi(data.taskId);
  }
  return { ok: true };
}

const uuTienSchema = z.object({ taskId: z.string().min(1), priority: z.enum(TECH_PRIORITIES), note: z.string().trim().max(1000).optional() });

export async function setTechTaskPriorityAction(input: unknown): Promise<TechResult> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  let data: z.infer<typeof uuTienSchema>;
  try {
    data = uuTienSchema.parse(input);
  } catch (e) {
    return { error: loi(e, "Dữ liệu không hợp lệ") };
  }
  const res = await setTechTaskPriority(data, actorOf(user));
  if ("error" in res) return res;
  await audit({ userId: user.id, userEmail: user.email, action: "TECH_TASK_PRIORITY", entity: "TECH_TASK", entityId: data.taskId, after: { priority: data.priority }, reason: data.note });
  lamMoi(data.taskId);
  return { ok: true };
}

const ruiRoSchema = z.object({ taskId: z.string().min(1), risk: z.enum(TECH_RISKS), reason: z.string().trim().min(10, "Phải nói vì sao đổi mức rủi ro").max(2000) });

export async function overrideTechTaskRiskAction(input: unknown): Promise<TechResult> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  let data: z.infer<typeof ruiRoSchema>;
  try {
    data = ruiRoSchema.parse(input);
  } catch (e) {
    return { error: loi(e, "Dữ liệu không hợp lệ") };
  }
  const res = await overrideTechTaskRisk(data, actorOf(user));
  if ("error" in res) return res;
  await audit({ userId: user.id, userEmail: user.email, action: "TECH_TASK_RISK_OVERRIDE", entity: "TECH_TASK", entityId: data.taskId, after: { risk: data.risk }, reason: data.reason });
  lamMoi(data.taskId);
  return { ok: true };
}

const giaoSchema = z.object({ taskId: z.string().min(1), agentId: z.string().trim().max(60).nullish(), note: z.string().trim().max(1000).optional() });

export async function assignTechTaskAgentAction(input: unknown): Promise<TechResult> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  let data: z.infer<typeof giaoSchema>;
  try {
    data = giaoSchema.parse(input);
  } catch (e) {
    return { error: loi(e, "Dữ liệu không hợp lệ") };
  }
  const res = await assignTechTaskAgent({ taskId: data.taskId, agentId: data.agentId ?? null, note: data.note }, actorOf(user));
  if ("error" in res) return res;
  await audit({ userId: user.id, userEmail: user.email, action: "TECH_TASK_ASSIGN", entity: "TECH_TASK", entityId: data.taskId, after: { agentId: data.agentId ?? null }, reason: data.note });
  lamMoi(data.taskId);
  return { ok: true };
}

const duyetSchema = z.object({ taskId: z.string().min(1), decision: z.enum(["APPROVED", "REJECTED"]), note: z.string().trim().max(2000).optional() });

export async function decideTechApprovalAction(input: unknown): Promise<TechResult> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  let data: z.infer<typeof duyetSchema>;
  try {
    data = duyetSchema.parse(input);
  } catch (e) {
    return { error: loi(e, "Dữ liệu không hợp lệ") };
  }
  const res = await decideTechApproval(data, actorOf(user));
  if ("error" in res) return res;
  await audit({ userId: user.id, userEmail: user.email, action: "TECH_TASK_APPROVAL", entity: "TECH_TASK", entityId: data.taskId, after: { approval: data.decision }, reason: data.note });
  lamMoi(data.taskId);
  return { ok: true };
}

const xacMinhSchema = z.object({ taskId: z.string().min(1), evidence: z.string().trim().min(10, "Xác minh phải kèm bằng chứng").max(8000) });

export async function verifyTechTaskAction(input: unknown): Promise<TechResult> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  let data: z.infer<typeof xacMinhSchema>;
  try {
    data = xacMinhSchema.parse(input);
  } catch (e) {
    return { error: loi(e, "Dữ liệu không hợp lệ") };
  }
  const res = await verifyTechTaskOnProduction(data, actorOf(user));
  if ("error" in res) return res;
  await audit({ userId: user.id, userEmail: user.email, action: "TECH_TASK_VERIFIED", entity: "TECH_TASK", entityId: data.taskId, after: { evidence: data.evidence.slice(0, 500) } });
  lamMoi(data.taskId);
  return { ok: true };
}

const ghiChuSchema = z.object({ taskId: z.string().min(1), note: z.string().trim().min(1).max(8000) });

export async function addTechTaskNoteAction(input: unknown): Promise<TechResult> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  let data: z.infer<typeof ghiChuSchema>;
  try {
    data = ghiChuSchema.parse(input);
  } catch (e) {
    return { error: loi(e, "Dữ liệu không hợp lệ") };
  }
  const res = await addTechTaskNote(data, actorOf(user));
  if ("error" in res) return res;
  await audit({ userId: user.id, userEmail: user.email, action: "TECH_TASK_NOTE", entity: "TECH_TASK", entityId: data.taskId, after: { note: data.note.slice(0, 500) } });
  lamMoi(data.taskId);
  return { ok: true };
}

const nhanhSchema = z.object({ taskId: z.string().min(1), branch: z.string().trim().max(200), worktree: z.string().trim().max(300).optional() });

export async function setTechTaskBranchAction(input: unknown): Promise<TechResult> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  let data: z.infer<typeof nhanhSchema>;
  try {
    data = nhanhSchema.parse(input);
  } catch (e) {
    return { error: loi(e, "Dữ liệu không hợp lệ") };
  }
  const res = await setTechTaskBranch(data, actorOf(user));
  if ("error" in res) return res;
  await audit({ userId: user.id, userEmail: user.email, action: "TECH_TASK_BRANCH", entity: "TECH_TASK", entityId: data.taskId, after: { branch: data.branch } });
  lamMoi(data.taskId);
  return { ok: true };
}

/* ───────────── Sổ agent ───────────── */

export async function seedTechAgentsAction(): Promise<TechResult<{ created: number }>> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  const res = await seedTechAgents(actorOf(user));
  if ("error" in res) return res;
  await audit({ userId: user.id, userEmail: user.email, action: "TECH_AGENTS_SEEDED", entity: "TECH_AGENT", after: { created: res.created, skipped: res.skipped }, reason: "Khởi tạo sổ agent từ bản khai trong mã nguồn" });
  lamMoi();
  return { ok: true, created: res.created };
}

const batTatSchema = z.object({ agentId: z.string().min(1), enabled: z.boolean() });

export async function setTechAgentEnabledAction(input: unknown): Promise<TechResult> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  let data: z.infer<typeof batTatSchema>;
  try {
    data = batTatSchema.parse(input);
  } catch (e) {
    return { error: loi(e, "Dữ liệu không hợp lệ") };
  }
  const res = await setTechAgentEnabled(data, actorOf(user));
  if ("error" in res) return res;
  await audit({ userId: user.id, userEmail: user.email, action: "TECH_AGENT_TOGGLED", entity: "TECH_AGENT", entityId: data.agentId, after: { enabled: data.enabled } });
  lamMoi();
  return { ok: true };
}

/* ───────── Lượt chạy ─────────

   CỐ Ý KHÔNG CÓ SERVER ACTION Ở ĐÂY.

   `startTechAgentRun` / `finishTechAgentRun` sống ở `lib/tech/service.ts`, và Phase 2 sẽ gọi thẳng
   vào đó với danh tính agent của nó. Bọc chúng thành Server Action ngay bây giờ là dựng một cái
   nút mà Phase 1 không có ai bấm — đúng thứ `tests/action-wiring.test.ts` sinh ra để chặn: tính
   năng có trong mã, không có trong tay người dùng, và không ai biết nó chưa từng chạy.
*/

/* ───────────── Deployment (quan sát) ───────────── */

const ghiDeploySchema = z.object({
  commitSha: z.string().trim().regex(/^[0-9a-f]{7,40}$/i, "Mã commit phải là 7–40 ký tự hex"),
  branch: z.string().trim().max(200).optional(),
  status: z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]).optional(),
  taskId: z.string().trim().max(60).nullish(),
  externalRef: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(4000).optional(),
});

export async function recordTechDeploymentAction(input: unknown): Promise<TechResult<{ id: string }>> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  let data: z.infer<typeof ghiDeploySchema>;
  try {
    data = ghiDeploySchema.parse(input);
  } catch (e) {
    return { error: loi(e, "Dữ liệu không hợp lệ") };
  }
  const res = await recordTechDeployment({ ...data, taskId: data.taskId ?? null }, actorOf(user));
  if ("error" in res) return res;
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "TECH_DEPLOY_RECORDED",
    entity: "TECH_DEPLOYMENT",
    entityId: res.id,
    after: { commit: data.commitSha, branch: data.branch ?? "main", status: data.status ?? "PENDING" },
    reason: "Ghi QUAN SÁT về lượt deploy — GitHub Actions vẫn là bên có thẩm quyền",
  });
  lamMoi(data.taskId ?? undefined);
  return { ok: true, id: res.id };
}

const suaDeploySchema = z.object({
  deploymentId: z.string().min(1),
  status: z.enum(["RUNNING", "SUCCEEDED", "FAILED", "ROLLED_BACK"]).optional(),
  healthResult: z.enum(TECH_GATE_RESULTS).optional(),
  smokeResult: z.enum(TECH_GATE_RESULTS).optional(),
  observationResult: z.enum(TECH_GATE_RESULTS).optional(),
  rollbackOfId: z.string().trim().max(60).nullish(),
  notes: z.string().trim().max(4000).optional(),
});

export async function updateTechDeploymentAction(input: unknown): Promise<TechResult> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  let data: z.infer<typeof suaDeploySchema>;
  try {
    data = suaDeploySchema.parse(input);
  } catch (e) {
    return { error: loi(e, "Dữ liệu không hợp lệ") };
  }
  const res = await updateTechDeployment({ ...data, rollbackOfId: data.rollbackOfId ?? null }, actorOf(user));
  if ("error" in res) return res;
  await audit({ userId: user.id, userEmail: user.email, action: "TECH_DEPLOY_UPDATED", entity: "TECH_DEPLOYMENT", entityId: data.deploymentId, after: { status: data.status ?? null } });
  lamMoi();
  return { ok: true };
}

/* ───────────── Sự cố ───────────── */

const taoSuCoSchema = z.object({
  title: z.string().trim().min(5, "Tiêu đề sự cố quá ngắn").max(300),
  severity: z.enum(TECH_INCIDENT_SEVERITIES),
  module: z.enum(TECH_MODULES),
  source: z.string().trim().max(60).optional(),
  evidence: z.string().trim().max(20_000).optional(),
  taskId: z.string().trim().max(60).nullish(),
  deploymentId: z.string().trim().max(60).nullish(),
});

export async function createTechIncidentAction(input: unknown): Promise<TechResult<{ id: string; code: string }>> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  let data: z.infer<typeof taoSuCoSchema>;
  try {
    data = taoSuCoSchema.parse(input);
  } catch (e) {
    return { error: loi(e, "Dữ liệu không hợp lệ") };
  }
  const res = await createTechIncident({ ...data, taskId: data.taskId ?? null, deploymentId: data.deploymentId ?? null }, actorOf(user));
  if ("error" in res) return res;
  await audit({ userId: user.id, userEmail: user.email, action: "TECH_INCIDENT_OPENED", entity: "TECH_INCIDENT", entityId: res.id, after: { code: res.code, severity: data.severity, module: data.module } });
  lamMoi(data.taskId ?? undefined);
  return { ok: true, id: res.id, code: res.code };
}

const suCoTrangThaiSchema = z.object({
  incidentId: z.string().min(1),
  to: z.enum(TECH_INCIDENT_STATUSES),
  resolution: z.string().trim().max(8000).optional(),
  mitigation: z.string().trim().max(8000).optional(),
  rootCause: z.string().trim().max(8000).optional(),
});

export async function setTechIncidentStatusAction(input: unknown): Promise<TechResult> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  let data: z.infer<typeof suCoTrangThaiSchema>;
  try {
    data = suCoTrangThaiSchema.parse(input);
  } catch (e) {
    return { error: loi(e, "Dữ liệu không hợp lệ") };
  }
  const res = await setTechIncidentStatus(data, actorOf(user));
  if ("error" in res) return res;
  if (!res.skipped) {
    await audit({ userId: user.id, userEmail: user.email, action: "TECH_INCIDENT_STATUS", entity: "TECH_INCIDENT", entityId: data.incidentId, after: { status: data.to }, reason: data.resolution });
    lamMoi();
    revalidatePath(`/tech/incidents/${data.incidentId}`);
  }
  return { ok: true };
}

const noiSuCoSchema = z.object({ incidentId: z.string().min(1), taskId: z.string().trim().max(60).nullish() });

export async function linkTechIncidentAction(input: unknown): Promise<TechResult> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  let data: z.infer<typeof noiSuCoSchema>;
  try {
    data = noiSuCoSchema.parse(input);
  } catch (e) {
    return { error: loi(e, "Dữ liệu không hợp lệ") };
  }
  const res = await linkTechIncidentToTask({ incidentId: data.incidentId, taskId: data.taskId ?? null }, actorOf(user));
  if ("error" in res) return res;
  await audit({ userId: user.id, userEmail: user.email, action: "TECH_INCIDENT_LINKED", entity: "TECH_INCIDENT", entityId: data.incidentId, after: { taskId: data.taskId ?? null } });
  lamMoi(data.taskId ?? undefined);
  revalidatePath(`/tech/incidents/${data.incidentId}`);
  return { ok: true };
}

/* ═════════════════ AI CTO — CHẾ ĐỘ ĐỀ XUẤT ═════════════════ */

/**
 * Bốn hành động, và ba trong số đó là của NGƯỜI.
 *
 * `planTechProposalAction` là hành động duy nhất gọi model. Nó ghi vào `tech_proposals` và DỪNG —
 * không tạo một `tech_tasks` nào. Ba hành động còn lại (duyệt · từ chối · lập lại) là quyết định,
 * và `lib/tech/proposal.ts` từ chối mọi actor không phải người ở cả ba.
 *
 * Không có hành động nào tên "áp tất cả" hay "chạy luôn": mỗi bản kế hoạch phải được một con
 * người đọc rồi bấm.
 */

const deXuatSchema = z.object({ proposalId: z.string().trim().min(1).max(60) });

export async function planTechProposalAction(input: unknown): Promise<TechResult<{ id: string; status: string; tasks: number }>> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  let data: { taskId: string };
  try {
    data = z.object({ taskId: z.string().trim().min(1).max(60) }).parse(input);
  } catch (error) {
    return { error: loi(error, "Dữ liệu không hợp lệ") };
  }

  const { buildCtoPrompt, runCtoPlanning } = await import("@/lib/agents/cto");
  const { createProposal, supersedeOpenProposals } = await import("@/lib/tech/proposal");
  const { getAiProvider } = await import("@/lib/ai/provider");
  const { aiDisabledReason } = await import("@/lib/ai/router");

  const provider = getAiProvider("analysis");
  if (!provider) return { error: `AI chưa cấu hình trên máy chủ: ${aiDisabledReason() ?? "thiếu khoá API"}` };

  const db = await (await import("@/db")).getDb();
  const agent = await db.query.techAgents.findFirst({ where: (a, { eq }) => eq(a.key, "ai-cto") });
  /*
    VAI PHẢI ĐƯỢC BẬT — cùng luật với agent viết mã. Một vai đang TẮT mà vẫn chạy được thì cái nút
    bật/tắt chỉ là trang trí (AGENTS.md mục 23).
  */
  if (!agent) return { error: "Chưa khởi tạo sổ agent — mở /tech/agents và bấm “Khởi tạo sổ agent”." };
  if (!agent.enabled) return { error: "Vai AI CTO đang TẮT. Bật ở /tech/agents rồi thử lại." };

  const ctx = await buildCtoPrompt(data.taskId);
  if (!ctx) return { error: "Không tìm thấy mục tiêu gốc." };

  const res = await runCtoPlanning(provider, ctx);
  const ghi = await createProposal({
    sourceTaskId: data.taskId,
    agentId: agent.id,
    agentKey: agent.key,
    provider: res.provider,
    model: res.model,
    plan: res.ok ? res.plan : null,
    error: res.ok ? "" : res.error,
    rawOutput: res.raw,
    modelCalls: res.modelCalls,
    initialError: res.initialError,
    repairOutcome: res.repairOutcome,
  });
  if (!("ok" in ghi)) return { error: ghi.error };
  // Lập lại kế hoạch ⇒ bản chờ duyệt cũ thôi áp được, nhưng KHÔNG bị xoá: còn đọc để so hai lần nghĩ.
  await supersedeOpenProposals(data.taskId, ghi.id);

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "TECH_PROPOSAL_PLANNED",
    entity: "TECH_PROPOSAL",
    entityId: ghi.id,
    after: { status: ghi.status, provider: res.provider, model: res.model, ok: res.ok },
    reason: res.ok ? "AI CTO lập kế hoạch" : `AI CTO lập kế hoạch KHÔNG đạt: ${res.error.slice(0, 200)}`,
  });
  lamMoi(data.taskId);
  revalidatePath("/tech/cto");
  return { ok: true, id: ghi.id, status: ghi.status, tasks: res.ok ? res.plan.tasks.length : 0 };
}

export async function approveTechProposalAction(input: unknown): Promise<TechResult<{ created: number; skipped: number }>> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  let data: z.infer<typeof deXuatSchema> & { note?: string };
  try {
    data = deXuatSchema.extend({ note: z.string().trim().max(2000).optional() }).parse(input);
  } catch (error) {
    return { error: loi(error, "Dữ liệu không hợp lệ") };
  }
  const { approveProposal } = await import("@/lib/tech/proposal");
  const res = await approveProposal({ proposalId: data.proposalId, note: data.note }, actorOf(user));
  if (!("ok" in res)) return { error: res.error };
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "TECH_PROPOSAL_APPROVED",
    entity: "TECH_PROPOSAL",
    entityId: data.proposalId,
    after: { created: res.created, skipped: res.skipped, tasks: res.tasks.map((t) => ({ code: t.code, suggested: t.suggestedRisk, applied: t.appliedRisk })) },
    reason: "Chủ shop duyệt kế hoạch AI CTO — việc thật được tạo, mức rủi ro do máy xếp lại",
  });
  lamMoi();
  revalidatePath("/tech/cto");
  return { ok: true, created: res.created, skipped: res.skipped };
}

export async function rejectTechProposalAction(input: unknown): Promise<TechResult> {
  const user = await nguoiQuanTri();
  if (!user) return { error: KHONG_QUYEN };
  let data: z.infer<typeof deXuatSchema> & { reason: string };
  try {
    data = deXuatSchema.extend({ reason: z.string().trim().min(10, "Từ chối thì phải nói vì sao") }).parse(input);
  } catch (error) {
    return { error: loi(error, "Dữ liệu không hợp lệ") };
  }
  const { rejectProposal } = await import("@/lib/tech/proposal");
  const res = await rejectProposal({ proposalId: data.proposalId, reason: data.reason }, actorOf(user));
  if (!("ok" in res)) return { error: res.error };
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "TECH_PROPOSAL_REJECTED",
    entity: "TECH_PROPOSAL",
    entityId: data.proposalId,
    after: { reason: data.reason },
    reason: "Chủ shop từ chối kế hoạch AI CTO",
  });
  revalidatePath("/tech/cto");
  return { ok: true };
}

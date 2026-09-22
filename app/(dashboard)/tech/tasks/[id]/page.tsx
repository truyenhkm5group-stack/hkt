import { docChiPhiLuot, nhanChiPhi } from "@/lib/constants/agent-run-cost";
import Link from "next/link";
import { dispatchConfig } from "@/lib/integrations/github/dispatch";
import { notFound } from "next/navigation";
import { TechApprovalBadge, TechDeployBadge, TechGateBadge, TechPriorityBadge, TechRiskBadge, TechSeverityBadge, TechStatusBadge } from "@/app/(dashboard)/tech/badges";
import { TechNav } from "@/app/(dashboard)/tech/tech-nav";
import { TechTaskActions } from "@/app/(dashboard)/tech/tasks/[id]/task-actions";
import { PageHeader } from "@/components/page-header";
import { DescriptionList, EmptyState, SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import {
  TECH_ACTOR_KIND_LABEL,
  TECH_CI_STATE_LABEL,
  TECH_EVENT_KIND_LABEL,
  TECH_MERGE_STATE_LABEL,
  TECH_MODULE_LABEL,
  TECH_PR_STATE_LABEL,
  TECH_REVIEW_STATE_LABEL,
  TECH_RUN_STATUS_LABEL,
  TECH_TASK_SOURCE_LABEL,
  TECH_TASK_STATUS_LABEL,
  TECH_TASK_TYPE_LABEL,
  type TechActorKind,
  type TechApprovalStatus,
  type TechCiState,
  type TechDeployStatus,
  type TechEventKind,
  type TechGateResult,
  type TechIncidentSeverity,
  type TechMergeState,
  type TechModule,
  type TechPrState,
  type TechPriority,
  type TechReviewState,
  type TechRisk,
  type TechRunStatus,
  type TechTaskSource,
  type TechTaskStatus,
  type TechTaskType,
} from "@/lib/constants/tech";
import { TECH_RISK_RULE_BY_KEY } from "@/lib/constants/tech-risk";
import { formatDateTime, formatTimeAgo } from "@/lib/format";
import { getTechTask } from "@/lib/queries/tech";
import { listEnabledTechAgents } from "@/lib/queries/tech-agents";

export const metadata = { title: "Chi tiết việc Tech" };

/** CHƯA BIẾT in ra dấu gạch, không in ra 0 và không in ra ô trống (AGENTS.md mục 42). */
function gach(value: React.ReactNode | null | undefined) {
  return value === null || value === undefined || value === "" ? <span className="text-muted-foreground">—</span> : value;
}

export default async function TechTaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePermission("tech:view");
  const canManage = can(user, "tech:manage");
  const data = await getTechTask(id);
  if (!data) notFound();
  const { task, events, runs, deployments, incidents, dependsOn } = data;
  const agents = canManage ? await listEnabledTechAgents() : [];

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={task.code}
        title={task.title}
        description={`${TECH_TASK_TYPE_LABEL[task.taskType as TechTaskType] ?? task.taskType} · ${TECH_MODULE_LABEL[task.module as TechModule] ?? task.module} · tạo ${formatDateTime(task.createdAt)}`}
        actions={
          <Link href="/tech/tasks" className="text-xs font-semibold text-primary hover:underline">
            ← Về hàng đợi
          </Link>
        }
      />

      <TechNav />

      <div className="flex flex-wrap items-center gap-1.5">
        <TechStatusBadge status={task.status as TechTaskStatus} />
        <TechPriorityBadge priority={task.priority as TechPriority} />
        <TechRiskBadge risk={task.risk as TechRisk} />
        <TechApprovalBadge status={task.approvalStatus as TechApprovalStatus} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <SectionCard title="Nội dung">
            {task.description ? (
              <p className="whitespace-pre-wrap text-sm leading-6">{task.description}</p>
            ) : (
              <p className="text-sm text-muted-foreground">Chưa có mô tả. Một việc không mô tả là một việc người sau phải đoán.</p>
            )}
          </SectionCard>

          <SectionCard
            title="Vì sao mức rủi ro là như vậy"
            description={task.riskOverriddenBy ? "NGƯỜI đã đè lên mức máy xếp" : "Do luật trong lib/constants/tech-risk.ts"}
            hint="Luật chỉ NÂNG mức, không bao giờ hạ. R2 bắt buộc có chữ ký của chủ shop trước khi deploy. Không luật nào khớp ⇒ R0 — nhưng R0 ở đây nghĩa là “chưa thấy rủi ro”, không phải “đã kiểm tra và an toàn”."
          >
            {task.riskOverriddenBy ? (
              <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
                <p className="font-semibold">Mức do người đặt, không phải do luật.</p>
                <p className="mt-0.5 text-muted-foreground">{task.riskOverrideReason}</p>
              </div>
            ) : task.riskRules.length ? (
              <ul className="space-y-2 text-sm">
                {task.riskRules.map((key) => {
                  const rule = TECH_RISK_RULE_BY_KEY[key];
                  return (
                    <li key={key}>
                      <span className="font-medium">{rule?.label ?? key}</span>
                      <p className="text-xs text-muted-foreground">{rule?.why ?? "Luật này không còn trong sổ — mức rủi ro giữ nguyên, nhưng lý do đã mất."}</p>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                Không luật nào khớp với việc này. Đó là “chưa thấy rủi ro”, không phải “đã kiểm tra và an toàn” — nâng mức lên được, kèm lý do.
              </p>
            )}
          </SectionCard>

          <SectionCard title="Dòng thời gian" description={`${events.length} mốc — chỉ thêm, không sửa`}>
            {events.length === 0 ? (
              <EmptyState title="Chưa có mốc nào" description="Nhật ký bắt đầu từ lúc việc được ghi." />
            ) : (
              <ol className="space-y-3">
                {events.map((e) => (
                  <li key={e.id} className="border-l-2 border-hairline pl-3">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-semibold">{TECH_EVENT_KIND_LABEL[e.kind as TechEventKind] ?? e.kind}</span>
                      {e.previousValue || e.nextValue ? (
                        <span className="text-xs text-muted-foreground">
                          {e.previousValue ? `${TECH_TASK_STATUS_LABEL[e.previousValue as TechTaskStatus] ?? e.previousValue} → ` : ""}
                          {TECH_TASK_STATUS_LABEL[e.nextValue as TechTaskStatus] ?? e.nextValue}
                        </span>
                      ) : null}
                      <span className="text-[11px] text-muted-foreground">{formatDateTime(e.createdAt)}</span>
                    </div>
                    {e.note ? <p className="mt-0.5 whitespace-pre-wrap text-xs leading-5">{e.note}</p> : null}
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {/* Ba loại người thao tác không bao giờ gộp: người · hệ thống · agent. */}
                      {TECH_ACTOR_KIND_LABEL[e.actorKind as TechActorKind] ?? e.actorKind}
                      {e.actorName ? ` · ${e.actorName}` : ""}
                      {e.agent ? ` · agent ${e.agent.name}` : ""}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </SectionCard>

          <SectionCard title="Lượt chạy của agent" description={`${runs.length} lượt`}>
            {runs.length === 0 ? (
              <EmptyState title="Chưa có lượt chạy nào" description="Phase 1 chưa có máy thi hành: lượt chạy được ghi vào bằng tay hoặc bởi Phase 2." />
            ) : (
              <ul className="divide-y divide-hairline">
                {runs.map((r) => (
                  <li key={r.id} className="py-2.5 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">
                        {r.agent?.name ?? r.agentKey} · {TECH_RUN_STATUS_LABEL[r.status as TechRunStatus] ?? r.status}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {formatDateTime(r.startedAt)} → {r.endedAt ? formatDateTime(r.endedAt) : "đang chạy"}
                      </span>
                    </div>
                    {/*
                      TIỀN CỦA LƯỢT CHẠY — hiện ngay cạnh kết quả, không giấu trong log.

                      22/09/2026 chủ shop hết sạch tín dụng API và hỏi "tiền đi đâu". Không ai trả
                      lời được: agent chạy trên máy Actions nên không có trong `ai_interactions`.
                      Dữ liệu có mà không ai nhìn thấy thì vẫn là không đo được.

                      `—` nghĩa là CHƯA ĐO ĐƯỢC (lượt trước bản vá), KHÔNG phải $0 (mục 42).
                    */}
                    {(() => {
                      const c = docChiPhiLuot(r.metadata);
                      return (
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                          <span title={c.usd === null ? "Lượt chạy này không ghi lại chi phí — chưa đo được, không phải $0" : "Tiền khoá AI cho lượt chạy này"}>
                            tiền <span className="font-medium text-foreground">{nhanChiPhi(c)}</span>
                          </span>
                          {c.soVong !== null ? <span>· {c.soVong} vòng</span> : null}
                          {r.branch ? <span>· nhánh <code className="text-[10.5px]">{r.branch}</code></span> : null}
                        </div>
                      );
                    })()}
                    {r.summary ? <p className="mt-0.5 text-xs text-muted-foreground">{r.summary}</p> : null}
                    <div className="mt-1 flex flex-wrap gap-1">
                      {/* Bốn cổng đứng RIÊNG và mặc định “Chưa xác minh”. Gộp thành một ô “đã test”
                          là làm mất khả năng biết cái nào chưa chạy. */}
                      <TechGateBadge label="typecheck" result={r.typecheckResult as TechGateResult} />
                      <TechGateBadge label="lint" result={r.lintResult as TechGateResult} />
                      <TechGateBadge label="test" result={r.testResult as TechGateResult} />
                      <TechGateBadge label="build" result={r.buildResult as TechGateResult} />
                    </div>
                    {r.error ? <p className="mt-1 text-xs text-destructive">{r.error}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>

        <div className="space-y-4">
          {canManage ? (
            <SectionCard title="Thao tác">
              <TechTaskActions
                taskId={task.id}
                taskCode={task.code}
                dispatchReason={dispatchConfig().configured ? null : (dispatchConfig().reason ?? "Chưa bật cửa giao việc.")}
                status={task.status as TechTaskStatus}
                priority={task.priority as TechPriority}
                risk={task.risk as TechRisk}
                approvalRequired={task.approvalRequired}
                approvalStatus={task.approvalStatus}
                agentId={task.agentId}
                branch={task.branch}
                worktree={task.worktree}
                verified={Boolean(task.productionVerifiedAt)}
                agents={agents.map((a) => ({ id: a.id, key: a.key, name: a.name, allowedRisks: a.allowedRisks }))}
              />
            </SectionCard>
          ) : null}

          <SectionCard title="Thông tin">
            <DescriptionList
              columns={1}
              items={[
                { label: "Nguồn", value: TECH_TASK_SOURCE_LABEL[task.source as TechTaskSource] ?? task.source },
                { label: "Chứng từ gốc", value: gach(task.sourceRef) },
                { label: "Nhánh git", value: gach(task.branch) },
                { label: "Cây làm việc", value: gach(task.worktree) },
                { label: "Agent phụ trách", value: task.agent ? task.agent.name : <span className="text-muted-foreground">— chưa giao</span> },
                { label: "Người ghi", value: `${TECH_ACTOR_KIND_LABEL[task.createdByKind as TechActorKind]} · ${task.createdByName || "—"}` },
                { label: "Bắt đầu làm", value: task.startedAt ? formatDateTime(task.startedAt) : <span className="text-muted-foreground">— chưa bắt đầu</span> },
                { label: "Hoàn thành", value: task.completedAt ? formatDateTime(task.completedAt) : <span className="text-muted-foreground">— chưa xong</span> },
                {
                  label: "Phê duyệt",
                  value: task.approvalRequired
                    ? `${task.approvalStatus}${task.approvedByName ? ` · ${task.approvedByName}` : ""}${task.approvedAt ? ` · ${formatDateTime(task.approvedAt)}` : ""}`
                    : "Không cần",
                },
                {
                  label: "Xác minh production",
                  value: task.productionVerifiedAt ? (
                    <span>
                      {formatDateTime(task.productionVerifiedAt)}
                      <span className="block text-xs text-muted-foreground">{task.productionEvidence}</span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">— chưa ai xác minh</span>
                  ),
                  span: true,
                },
              ]}
            />
          </SectionCard>

          {/*
            PHÉP CHIẾU PR — ở đây thì CHƯA BIẾT PHẢI IN RA THÀNH CHỮ.

            Khác hẳn cột trong bảng (nhãn tự ẩn để bảng không đầy nhãn xám): trang chi tiết là chỗ
            người ta tới để biết TÌNH TRẠNG ĐẦY ĐỦ, và một ô trống ở đây đọc ra là "không có", chứ
            không phải "chưa đọc được" (AGENTS.md mục 42). Nên bốn chiều luôn in đủ, kèm mốc đọc.
          */}
          {task.prNumber || task.branch ? (
            <SectionCard title="Pull request">
              <DescriptionList
                columns={2}
                items={[
                  {
                    label: "PR",
                    value: task.prNumber ? (
                      task.prUrl ? (
                        <a className="font-mono text-xs underline" href={task.prUrl} target="_blank" rel="noreferrer">
                          #{task.prNumber}
                        </a>
                      ) : (
                        <span className="font-mono text-xs">#{task.prNumber}</span>
                      )
                    ) : (
                      <span className="text-muted-foreground">— chưa mở PR cho nhánh này</span>
                    ),
                  },
                  { label: "Trạng thái PR", value: TECH_PR_STATE_LABEL[task.prState as TechPrState] ?? task.prState },
                  { label: "Cổng CI", value: TECH_CI_STATE_LABEL[task.ciState as TechCiState] ?? task.ciState },
                  { label: "Duyệt", value: TECH_REVIEW_STATE_LABEL[task.reviewState as TechReviewState] ?? task.reviewState },
                  { label: "Gộp", value: TECH_MERGE_STATE_LABEL[task.mergeState as TechMergeState] ?? task.mergeState },
                  { label: "Đỉnh nhánh lúc đọc", value: task.headSha ? <span className="font-mono text-xs">{task.headSha.slice(0, 12)}</span> : <span className="text-muted-foreground">—</span> },
                  {
                    label: "Đọc từ GitHub lúc",
                    value: task.prSyncedAt ? (
                      <span>
                        {formatDateTime(task.prSyncedAt)}
                        <span className="block text-xs text-muted-foreground">GitHub là bên có thẩm quyền; đây là ảnh chụp, không phải tình trạng ngay lúc này.</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">— chưa lượt đồng bộ nào đọc việc này</span>
                    ),
                    span: true,
                  },
                ]}
              />
            </SectionCard>
          ) : null}

          {task.parent || task.children.length > 0 || dependsOn.length > 0 ? (
            <SectionCard title="Liên quan">
              <div className="space-y-2 text-sm">
                {task.parent ? (
                  <p>
                    Việc cha:{" "}
                    <Link href={`/tech/tasks/${task.parent.id}`} className="font-medium hover:underline">
                      {task.parent.code} · {task.parent.title}
                    </Link>
                  </p>
                ) : null}
                {dependsOn.length ? (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Phải xong trước</p>
                    <ul className="mt-1 space-y-1">
                      {dependsOn.map((d) => (
                        <li key={d.id}>
                          <Link href={`/tech/tasks/${d.id}`} className="hover:underline">
                            {d.code} · {d.title} ({TECH_TASK_STATUS_LABEL[d.status as TechTaskStatus] ?? d.status})
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {task.children.length ? (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Việc con</p>
                    <ul className="mt-1 space-y-1">
                      {task.children.map((c) => (
                        <li key={c.id}>
                          <Link href={`/tech/tasks/${c.id}`} className="hover:underline">
                            {c.code} · {c.title}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </SectionCard>
          ) : null}

          {deployments.length > 0 ? (
            <SectionCard title="Lượt deploy đã ghi">
              <ul className="divide-y divide-hairline">
                {deployments.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <span className="font-mono text-xs">{d.commitSha.slice(0, 7)}</span>
                    <span className="flex items-center gap-1.5">
                      <TechDeployBadge status={d.status as TechDeployStatus} />
                      <span className="text-[11px] text-muted-foreground">{formatTimeAgo(d.startedAt)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}

          {incidents.length > 0 ? (
            <SectionCard title="Sự cố liên quan">
              <ul className="divide-y divide-hairline">
                {incidents.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <Link href={`/tech/incidents/${i.id}`} className="min-w-0 flex-1 hover:underline">
                      {i.code} · {i.title}
                    </Link>
                    <TechSeverityBadge severity={i.severity as TechIncidentSeverity} />
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}
        </div>
      </div>
    </div>
  );
}

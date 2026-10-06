import Link from "next/link";
import { notFound } from "next/navigation";
import { CanonicalBadge, ExecutionBadge, ExecutionProgress, MissionStatusBadge } from "@/app/(dashboard)/tech/control-plane-bits";
import { TechEventList } from "@/app/(dashboard)/tech/event-list";
import { PlanStatusControls } from "@/app/(dashboard)/tech/plan-status-controls";
import { TechTaskForm } from "@/app/(dashboard)/tech/tasks/task-form";
import { TechNav } from "@/app/(dashboard)/tech/tech-nav";
import { TechPriorityBadge, TechRiskBadge } from "@/app/(dashboard)/tech/badges";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { TECH_OWNER_ESCALATION_LABEL, type TechOwnerEscalation, type TechPriority, type TechRisk } from "@/lib/constants/tech";
import type { TechMissionStatus } from "@/lib/constants/tech-control-plane";
import { formatDateTime, formatTimeAgo } from "@/lib/format";
import { getTechMission } from "@/lib/queries/tech-control-plane";

export const metadata = { title: "Sứ mệnh · Phòng Tech AI" };

export default async function TechMissionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePermission("tech:view");
  const canManage = can(user, "tech:manage");
  const data = await getTechMission(id);
  if (!data) notFound();
  const { mission, tasks, execution, events } = data;
  const open = mission.status !== "DONE" && mission.status !== "CANCELLED";

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={mission.code}
        title={mission.title}
        description={`${mission.goal ? `${mission.goal.code} · ${mission.goal.title}` : "Sứ mệnh lẻ"} · ${mission.project?.name ?? "chưa gắn dự án"} · tạo ${formatDateTime(mission.createdAt)}`}
        actions={
          <Link href={mission.goal ? `/tech/goals/${mission.goal.id}` : "/tech/missions"} className="text-xs font-semibold text-primary hover:underline">
            ← {mission.goal ? `Về ${mission.goal.code}` : "Mọi sứ mệnh"}
          </Link>
        }
      />
      <TechNav />

      <div className="flex flex-wrap items-center gap-1.5">
        <MissionStatusBadge status={mission.status as TechMissionStatus} />
        <TechPriorityBadge priority={mission.priority as TechPriority} />
        <ExecutionBadge state={execution.state} />
        {mission.registryId ? <span className="text-xs text-muted-foreground">sổ AI Tech Room: {mission.registryId}</span> : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <SectionCard title="Tiến độ">
            <ExecutionProgress execution={execution} />
          </SectionCard>

          <SectionCard
            title="Việc"
            description={`${tasks.length} việc · trạng thái theo vòng đời chuẩn (tính lại mỗi lần mở)`}
            actions={canManage && open ? <TechTaskForm missionId={mission.id} missionLabel={mission.code} /> : null}
          >
            {tasks.length === 0 ? (
              <EmptyState title="Chưa có việc" description="Thêm việc vào sứ mệnh — hoặc mở một việc có sẵn rồi gắn vào sứ mệnh." />
            ) : (
              <ul className="divide-y divide-hairline">
                {tasks.map((t) => (
                  <li key={t.id} className="py-3">
                    <Link href={`/tech/tasks/${t.id}`} className="block hover:opacity-80">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs font-semibold text-muted-foreground">{t.code}</span>
                        <CanonicalBadge state={t.canonical} />
                        <TechPriorityBadge priority={t.priority as TechPriority} />
                        <TechRiskBadge risk={t.risk as TechRisk} />
                        {t.prNumber ? <span className="text-xs text-muted-foreground">PR #{t.prNumber}{t.ciState ? ` · CI ${t.ciState}` : ""}</span> : null}
                      </div>
                      <p className="mt-1 text-sm font-semibold">{t.title}</p>
                      {t.canonical === "NEEDS_OWNER" ? (
                        <p className="mt-1 rounded-md bg-fuchsia-50 px-2 py-1 text-xs text-fuchsia-900 dark:bg-fuchsia-950/40 dark:text-fuchsia-200">
                          {TECH_OWNER_ESCALATION_LABEL[t.ownerEscalation as TechOwnerEscalation] ?? t.ownerEscalation}: {t.ownerAction}
                        </p>
                      ) : null}
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {t.agent ? `Agent ${t.agent.name}` : "Chưa giao agent"} · cập nhật {formatTimeAgo(t.updatedAt)}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title="Dòng thời gian" description="Chỉ thêm, không sửa">
            <TechEventList events={events} />
          </SectionCard>
        </div>

        <div className="space-y-4">
          {canManage ? (
            <SectionCard title="Quyết định">
              <PlanStatusControls kind="mission" id={mission.id} status={mission.status as TechMissionStatus} />
            </SectionCard>
          ) : null}
          <SectionCard title="Nội dung">
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-xs font-semibold text-muted-foreground">Mục đích</p>
                <p className="whitespace-pre-wrap">{mission.objective || "—"}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-muted-foreground">Xong nghĩa là gì</p>
                <p className="whitespace-pre-wrap">{mission.definitionOfDone || <span className="text-muted-foreground">Chưa khai.</span>}</p>
              </div>
              {mission.outcomeNote ? (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground">Kết quả</p>
                  <p className="whitespace-pre-wrap">{mission.outcomeNote}</p>
                </div>
              ) : null}
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

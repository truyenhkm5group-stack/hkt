import Link from "next/link";
import { notFound } from "next/navigation";
import { ExecutionBadge, ExecutionProgress, GoalStatusBadge, MissionStatusBadge } from "@/app/(dashboard)/tech/control-plane-bits";
import { TechEventList } from "@/app/(dashboard)/tech/event-list";
import { MissionForm } from "@/app/(dashboard)/tech/missions/mission-form";
import { PlanStatusControls } from "@/app/(dashboard)/tech/plan-status-controls";
import { TechNav } from "@/app/(dashboard)/tech/tech-nav";
import { TechPriorityBadge } from "@/app/(dashboard)/tech/badges";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import type { TechPriority } from "@/lib/constants/tech";
import { mergeMissionExecutions, type TechGoalStatus, type TechMissionStatus } from "@/lib/constants/tech-control-plane";
import { formatDateTime } from "@/lib/format";
import { getTechGoal, listTechProjects } from "@/lib/queries/tech-control-plane";

export const metadata = { title: "Mục tiêu · Phòng Tech AI" };

export default async function TechGoalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePermission("tech:view");
  const canManage = can(user, "tech:manage");
  const [data, projects] = await Promise.all([getTechGoal(id), listTechProjects()]);
  if (!data) notFound();
  const { goal, missions, events } = data;
  // Tiến độ của mục tiêu = gộp trạng thái chuẩn của MỌI việc bên dưới — cùng hàm với từng sứ mệnh.
  const all = mergeMissionExecutions(missions.map((m) => m.execution));
  const activeProjects = projects.filter((p) => p.active).map((p) => ({ key: p.key, name: p.name }));

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={goal.code}
        title={goal.title}
        description={`${goal.project?.name ?? "Chưa gắn dự án"} · tạo ${formatDateTime(goal.createdAt)} bởi ${goal.createdByName || "—"}`}
        actions={
          <Link href="/tech/goals" className="text-xs font-semibold text-primary hover:underline">
            ← Mọi mục tiêu
          </Link>
        }
      />
      <TechNav />

      <div className="flex flex-wrap items-center gap-1.5">
        <GoalStatusBadge status={goal.status as TechGoalStatus} />
        <TechPriorityBadge priority={goal.priority as TechPriority} />
        <ExecutionBadge state={all.state} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <SectionCard title="Tiến độ">
            <ExecutionProgress execution={all} />
          </SectionCard>

          <SectionCard
            title="Sứ mệnh"
            description={`${missions.length} sứ mệnh`}
            actions={canManage && goal.status !== "ACHIEVED" && goal.status !== "ABANDONED" ? <MissionForm goalId={goal.id} goalCode={goal.code} projects={activeProjects} /> : null}
          >
            {missions.length === 0 ? (
              <EmptyState title="Chưa có sứ mệnh" description="Chia mục tiêu thành vài sứ mệnh giao được — mỗi sứ mệnh có định nghĩa XONG kiểm được." />
            ) : (
              <ul className="divide-y divide-hairline">
                {missions.map((m) => (
                  <li key={m.id} className="py-3">
                    <Link href={`/tech/missions/${m.id}`} className="block hover:opacity-80">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs font-semibold text-muted-foreground">{m.code}</span>
                        <MissionStatusBadge status={m.status as TechMissionStatus} />
                        <ExecutionBadge state={m.execution.state} />
                      </div>
                      <p className="mt-1 font-semibold">{m.title}</p>
                      <div className="mt-2 max-w-md">
                        <ExecutionProgress execution={m.execution} />
                      </div>
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
              <PlanStatusControls kind="goal" id={goal.id} status={goal.status as TechGoalStatus} />
            </SectionCard>
          ) : null}
          <SectionCard title="Nội dung">
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-xs font-semibold text-muted-foreground">Bối cảnh</p>
                <p className="whitespace-pre-wrap">{goal.description || "—"}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-muted-foreground">Đạt được nghĩa là gì</p>
                <p className="whitespace-pre-wrap">{goal.successCriteria || <span className="text-muted-foreground">Chưa khai — không ai chốt được “đã đạt” một cách kiểm chứng.</span>}</p>
              </div>
              {goal.outcomeNote ? (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground">Kết quả</p>
                  <p className="whitespace-pre-wrap">{goal.outcomeNote}</p>
                </div>
              ) : null}
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

import Link from "next/link";
import { ExecutionBadge, ExecutionProgress, GoalStatusBadge } from "@/app/(dashboard)/tech/control-plane-bits";
import { GoalForm, SeedProjects } from "@/app/(dashboard)/tech/goals/goal-form";
import { TechNav } from "@/app/(dashboard)/tech/tech-nav";
import { TechPriorityBadge } from "@/app/(dashboard)/tech/badges";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import type { TechPriority } from "@/lib/constants/tech";
import type { TechGoalStatus } from "@/lib/constants/tech-control-plane";
import { formatTimeAgo } from "@/lib/format";
import { listTechGoals, listTechProjects } from "@/lib/queries/tech-control-plane";

export const metadata = { title: "Mục tiêu · Phòng Tech AI" };

export default async function TechGoalsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePermission("tech:view");
  const canManage = can(user, "tech:manage");
  const sp = await searchParams;
  const includeClosed = sp.all === "1";
  const [goals, projects] = await Promise.all([listTechGoals({ includeClosed }), listTechProjects()]);
  const activeProjects = projects.filter((p) => p.active).map((p) => ({ key: p.key, name: p.name }));

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Phòng Tech AI"
        title="Mục tiêu"
        description="Chủ shop đặt mục tiêu bằng lời thường; hệ thống chia thành sứ mệnh và việc"
        hint={
          <>
            Mục tiêu chỉ lưu QUYẾT ĐỊNH của bạn (bắt đầu · tạm dừng · đã đạt · bỏ). Tiến độ và trạng thái
            “đang chạy / chờ chủ shop / có việc đỏ” luôn tính lại từ các việc bên dưới mỗi lần mở trang — không
            có con số nào được ghi tay. Agent chỉ tạo được bản nháp, không tự bật mục tiêu.
          </>
        }
        actions={
          canManage ? (
            <div className="flex flex-wrap gap-2">
              {activeProjects.length ? null : <SeedProjects />}
              <GoalForm projects={activeProjects} />
            </div>
          ) : null
        }
      />
      <TechNav />

      <div className="flex items-center justify-end text-xs">
        <Link href={includeClosed ? "/tech/goals" : "/tech/goals?all=1"} className="font-semibold text-primary hover:underline">
          {includeClosed ? "Chỉ mục tiêu đang mở" : "Xem cả mục tiêu đã đóng"}
        </Link>
      </div>

      {goals.length === 0 ? (
        <EmptyState title="Chưa có mục tiêu nào" description="Đặt mục tiêu đầu tiên — ví dụ “ChotDonTuDong sẵn sàng cho 10 khách trả tiền đầu tiên”." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {goals.map((g) => (
            <Link key={g.id} href={`/tech/goals/${g.id}`} className="block rounded-xl border bg-card p-4 shadow-[var(--shadow-card)] transition-colors hover:bg-muted/40">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-semibold text-muted-foreground">{g.code}</span>
                <GoalStatusBadge status={g.status as TechGoalStatus} />
                <TechPriorityBadge priority={g.priority as TechPriority} />
                {g.status === "ACTIVE" ? <ExecutionBadge state={g.execution.state} /> : null}
              </div>
              <p className="mt-1.5 font-semibold leading-snug">{g.title}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {g.project?.name ?? "Chưa gắn dự án"} · {g.openMissionCount}/{g.missionCount} sứ mệnh đang mở · cập nhật {formatTimeAgo(g.updatedAt)}
              </p>
              <div className="mt-3">
                <ExecutionProgress execution={g.execution} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

import Link from "next/link";
import { ExecutionBadge, ExecutionProgress, MissionStatusBadge } from "@/app/(dashboard)/tech/control-plane-bits";
import { MissionForm } from "@/app/(dashboard)/tech/missions/mission-form";
import { TechNav } from "@/app/(dashboard)/tech/tech-nav";
import { TechPriorityBadge } from "@/app/(dashboard)/tech/badges";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import type { TechPriority } from "@/lib/constants/tech";
import type { TechMissionStatus } from "@/lib/constants/tech-control-plane";
import { formatTimeAgo } from "@/lib/format";
import { listTechMissions, listTechProjects } from "@/lib/queries/tech-control-plane";

export const metadata = { title: "Sứ mệnh · Phòng Tech AI" };

export default async function TechMissionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePermission("tech:view");
  const canManage = can(user, "tech:manage");
  const sp = await searchParams;
  const includeClosed = sp.all === "1";
  const [missions, projects] = await Promise.all([listTechMissions({ includeClosed }), listTechProjects()]);
  const activeProjects = projects.filter((p) => p.active).map((p) => ({ key: p.key, name: p.name }));

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Phòng Tech AI"
        title="Sứ mệnh"
        description="Nhóm việc giao được, mỗi sứ mệnh có định nghĩa XONG kiểm được"
        hint={
          <>
            Sứ mệnh chỉ lưu QUYẾT ĐỊNH (lập kế hoạch · đang chạy · tạm dừng · xong · huỷ). Trạng thái thi hành
            tính lại từ các việc mỗi lần mở trang, ưu tiên điều bạn cần biết nhất: chờ chủ shop &gt; có việc đỏ &gt;
            bị chặn &gt; đang chạy. Tạm dừng là cái phanh: worker thôi nhận việc mới của sứ mệnh đó.
          </>
        }
        actions={canManage ? <MissionForm projects={activeProjects} /> : null}
      />
      <TechNav />

      <div className="flex items-center justify-end text-xs">
        <Link href={includeClosed ? "/tech/missions" : "/tech/missions?all=1"} className="font-semibold text-primary hover:underline">
          {includeClosed ? "Chỉ sứ mệnh đang mở" : "Xem cả sứ mệnh đã đóng"}
        </Link>
      </div>

      {missions.length === 0 ? (
        <EmptyState title="Chưa có sứ mệnh nào" description="Tạo sứ mệnh từ một mục tiêu, hoặc tạo sứ mệnh lẻ cho việc kỹ thuật không thuộc mục tiêu nào." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {missions.map((m) => (
            <Link key={m.id} href={`/tech/missions/${m.id}`} className="block rounded-xl border bg-card p-4 shadow-[var(--shadow-card)] transition-colors hover:bg-muted/40">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-semibold text-muted-foreground">{m.code}</span>
                <MissionStatusBadge status={m.status as TechMissionStatus} />
                <TechPriorityBadge priority={m.priority as TechPriority} />
              </div>
              <p className="mt-1.5 font-semibold leading-snug">{m.title}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {m.goal ? `${m.goal.code} · ${m.goal.title}` : "Sứ mệnh lẻ"} · {m.project?.name ?? "chưa gắn dự án"} · {formatTimeAgo(m.updatedAt)}
              </p>
              <div className="mt-2">
                <ExecutionBadge state={m.execution.state} />
              </div>
              <div className="mt-2">
                <ExecutionProgress execution={m.execution} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

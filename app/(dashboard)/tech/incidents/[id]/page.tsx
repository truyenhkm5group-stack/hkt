import Link from "next/link";
import { notFound } from "next/navigation";
import { TechDeployBadge, TechIncidentStatusBadge, TechSeverityBadge } from "@/app/(dashboard)/tech/badges";
import { TechIncidentActions } from "@/app/(dashboard)/tech/incidents/[id]/incident-actions";
import { TechNav } from "@/app/(dashboard)/tech/tech-nav";
import { PageHeader } from "@/components/page-header";
import { DescriptionList, SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { TECH_ACTOR_KIND_LABEL, TECH_MODULE_LABEL, type TechActorKind, type TechDeployStatus, type TechIncidentSeverity, type TechIncidentStatus, type TechModule } from "@/lib/constants/tech";
import { formatDateTime } from "@/lib/format";
import { listTechTaskOptions } from "@/lib/queries/tech";
import { getTechIncident } from "@/lib/queries/tech-ops";

export const metadata = { title: "Chi tiết sự cố" };

export default async function TechIncidentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePermission("tech:view");
  const canManage = can(user, "tech:manage");
  const inc = await getTechIncident(id);
  if (!inc) notFound();
  const viecMo = canManage ? await listTechTaskOptions() : [];

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={inc.code}
        title={inc.title}
        description={`${TECH_MODULE_LABEL[inc.module as TechModule] ?? inc.module} · phát hiện ${formatDateTime(inc.detectedAt)}`}
        actions={
          <Link href="/tech/incidents" className="text-xs font-semibold text-primary hover:underline">
            ← Về danh sách
          </Link>
        }
      />

      <TechNav />

      <div className="flex flex-wrap items-center gap-1.5">
        <TechSeverityBadge severity={inc.severity as TechIncidentSeverity} />
        <TechIncidentStatusBadge status={inc.status as TechIncidentStatus} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <SectionCard title="Bằng chứng" description="Thứ quan sát được, không phải thứ suy ra">
            {inc.evidence ? (
              <p className="whitespace-pre-wrap text-sm leading-6">{inc.evidence}</p>
            ) : (
              <p className="text-sm text-muted-foreground">Chưa ghi bằng chứng nào. Một sự cố không bằng chứng là một linh cảm — và linh cảm thì không xếp mức nặng nhẹ được.</p>
            )}
          </SectionCard>

          <SectionCard title="Nguyên nhân gốc" description="Để trống là câu trả lời hợp lệ">
            {inc.rootCause ? (
              <p className="whitespace-pre-wrap text-sm leading-6">{inc.rootCause}</p>
            ) : (
              <p className="text-sm text-muted-foreground">
                — chưa xác định. Chưa chứng minh được thì giữ nguyên chỗ trống: một câu nghe hợp lý điền vào đây sẽ được đọc lại như một sự thật.
              </p>
            )}
          </SectionCard>

          <div className="grid gap-4 sm:grid-cols-2">
            <SectionCard title="Đã giảm thiểu">
              <p className="whitespace-pre-wrap text-sm leading-6">{inc.mitigation || <span className="text-muted-foreground">—</span>}</p>
            </SectionCard>
            <SectionCard title="Đã xử lý">
              <p className="whitespace-pre-wrap text-sm leading-6">{inc.resolution || <span className="text-muted-foreground">—</span>}</p>
            </SectionCard>
          </div>
        </div>

        <div className="space-y-4">
          {canManage ? (
            <SectionCard title="Cập nhật sự cố">
              <TechIncidentActions
                incidentId={inc.id}
                status={inc.status as TechIncidentStatus}
                rootCause={inc.rootCause}
                mitigation={inc.mitigation}
                resolution={inc.resolution}
                taskId={inc.taskId}
                tasks={viecMo.map((t) => ({ id: t.id, code: t.code, title: t.title }))}
              />
            </SectionCard>
          ) : null}

          <SectionCard title="Thông tin">
            <DescriptionList
              columns={1}
              items={[
                { label: "Nguồn phát hiện", value: inc.source },
                { label: "Người mở", value: `${TECH_ACTOR_KIND_LABEL[inc.openedByKind as TechActorKind]} · ${inc.openedByName || "—"}` },
                { label: "Phát hiện lúc", value: formatDateTime(inc.detectedAt) },
                { label: "Đóng lúc", value: inc.resolvedAt ? formatDateTime(inc.resolvedAt) : <span className="text-muted-foreground">— chưa đóng</span> },
                {
                  label: "Việc Tech",
                  value: inc.task ? (
                    <Link href={`/tech/tasks/${inc.task.id}`} className="hover:underline">
                      {inc.task.code} · {inc.task.title}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">— chưa nối việc nào</span>
                  ),
                  span: true,
                },
                {
                  label: "Lượt deploy nghi ngờ",
                  value: inc.deployment ? (
                    <span className="flex items-center gap-1.5">
                      <span className="font-mono text-xs">{inc.deployment.commitSha.slice(0, 7)}</span>
                      <TechDeployBadge status={inc.deployment.status as TechDeployStatus} />
                    </span>
                  ) : (
                    <span className="text-muted-foreground">— chưa nối lượt nào</span>
                  ),
                  span: true,
                },
              ]}
            />
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

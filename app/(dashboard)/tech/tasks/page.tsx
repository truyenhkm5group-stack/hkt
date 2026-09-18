import { TechNav } from "@/app/(dashboard)/tech/tech-nav";
import { TechTaskForm } from "@/app/(dashboard)/tech/tasks/task-form";
import { TechTasksTable } from "@/app/(dashboard)/tech/tasks/tech-tasks-table";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { PageHeader } from "@/components/page-header";
import { can, requirePermission } from "@/lib/auth/session";
import { TECH_TASK_SORTABLE } from "@/lib/constants/tech";
import { formatNumber } from "@/lib/format";
import { listTechTasks, techOverviewCounts, techTaskFacets } from "@/lib/queries/tech";
import { parseListParams, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Hàng đợi việc Tech" };

export default async function TechTasksPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  const user = await requirePermission("tech:view");
  const canManage = can(user, "tech:manage");
  const params = parseListParams(raw, {
    defaultSort: "createdAt",
    filterKeys: ["status", "priority", "risk", "module", "taskType", "source", "agent", "approval", "open"],
    sortable: TECH_TASK_SORTABLE,
    defaultPeriod: "all",
  });

  const [{ rows, total, pageCount }, facets, counts] = await Promise.all([listTechTasks(params), techTaskFacets(params), techOverviewCounts()]);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Phòng Tech AI"
        title="Hàng đợi việc Tech"
        description={`${formatNumber(counts.tasks.open)} việc đang mở · ${formatNumber(counts.tasks.p0)} P0 · ${formatNumber(counts.tasks.waitingApproval)} chờ phê duyệt · ${formatNumber(counts.tasks.blocked)} bị chặn`}
        hint={
          <>
            Mười ba trạng thái, đi theo một đường có luật: phép chuyển nào hợp lệ khai ở
            <code> lib/constants/tech.ts</code> và không màn hình nào lách qua nó. Việc mức
            <b> R2</b> không vào được bước deploy khi chưa có chữ ký của chủ shop; việc đóng lại
            phải có xác minh trên production, hoặc một câu nói rõ vì sao không có gì để xác minh.
          </>
        }
        actions={canManage ? <TechTaskForm /> : null}
      />

      <TechNav />

      <DataTableToolbar
        searchPlaceholder="Mã việc, tiêu đề, nhánh git…"
        period={{ defaultKey: "all" }}
        facets={[
          { key: "status", label: "Trạng thái", options: facets.status },
          { key: "priority", label: "Ưu tiên", options: facets.priority },
          { key: "risk", label: "Rủi ro", options: facets.risk },
          { key: "module", label: "Module", options: facets.module },
          { key: "taskType", label: "Loại việc", options: facets.taskType },
          { key: "source", label: "Nguồn", options: facets.source },
        ]}
        resultLabel={`${formatNumber(total)} việc phù hợp`}
      />

      <TechTasksTable rows={rows} pageCount={pageCount} total={total} />
    </div>
  );
}

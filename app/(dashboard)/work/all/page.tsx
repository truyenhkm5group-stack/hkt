import { WorkList } from "@/components/work/work-list";
import { ManualTaskDialog } from "@/components/work/manual-task-dialog";
import { WorkFilters } from "@/app/(dashboard)/work/all/filters";
import { PageHeader } from "@/components/page-header";
import { StatStrip } from "@/components/stat-tile";
import { SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { type DepartmentCode } from "@/lib/constants/departments";
import { slaStateOf, type SlaState, type WorkStatus } from "@/lib/constants/work";
import type { WorkSource } from "@/lib/constants/work-sources";
import { formatVND } from "@/lib/format";
import { assignableMembers, filterWork, sortForQueue } from "@/lib/queries/work";
import { collectWorkItems } from "@/lib/queries/work-adapters";
import { param, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Tất cả công việc" };

/** Mặc định nạp bấy nhiêu dòng. Hàng đợi là nơi làm việc; cuộn 2.000 dòng không phải là làm việc. */
const PAGE_SIZE = 150;

/**
 * ═══════ TẤT CẢ CÔNG VIỆC — CHÉO PHÒNG BAN ═══════
 *
 * Mặc định CHỈ việc còn phải làm. Việc đã xong nằm sau bộ lọc trạng thái, không bày sẵn: một danh
 * sách mở lên đã có hàng nghìn dòng `DONE` thì người dùng phải lọc trước khi làm được gì.
 */
export default async function AllWorkPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("work:all");
  const raw = await searchParams;
  const filter = {
    department: (param(raw, "dept") || undefined) as DepartmentCode | undefined,
    source: (param(raw, "source") || undefined) as WorkSource | undefined,
    status: (param(raw, "status") || undefined) as WorkStatus | undefined,
    sla: (param(raw, "sla") || undefined) as SlaState | undefined,
    unassignedOnly: param(raw, "unassigned") === "1",
    q: param(raw, "q") || undefined,
  };
  const includeClosed = filter.status === "DONE" || filter.status === "CANCELLED";

  const now = new Date();
  const [{ items, failed }, members] = await Promise.all([collectWorkItems({ includeClosed, now }), assignableMembers()]);
  const filtered = filterWork(items, filter, now).sort(sortForQueue);
  const shown = filtered.slice(0, PAGE_SIZE);

  const overdue = filtered.filter((i) => slaStateOf(i.slaAt ?? i.dueAt, now) === "BREACHED").length;
  const unassigned = filtered.filter((i) => !i.assignee).length;
  const atRisk = filtered.reduce((s, i) => s + (i.money.atRisk ?? 0), 0);
  const unknownMoney = filtered.filter((i) => i.money.atRisk === null).length;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Công việc"
        title="Tất cả công việc"
        description={`${filtered.length} việc khớp bộ lọc${filtered.length > PAGE_SIZE ? ` · đang hiện ${PAGE_SIZE} việc gấp nhất` : ""}`}
        hint="Danh sách gom từ mọi nguồn việc của ERP. Mặc định chỉ hiện việc còn phải làm; chọn trạng thái “Xong” để xem việc đã đóng. Sắp xếp: gấp trước, rồi tới hạn sớm hơn, rồi điểm ưu tiên cao hơn — việc không có hạn không chen lên trước việc có hạn."
        actions={can(user, "work:assign") ? <ManualTaskDialog members={members} /> : null}
      />

      {failed.length ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Chưa đọc được nguồn: {failed.map((f) => `${f.source} (${f.error})`).join(" · ")}. Danh sách đang thiếu việc của các nguồn này.
        </p>
      ) : null}

      <StatStrip
        columns={4}
        items={[
          { label: "Khớp bộ lọc", value: filtered.length },
          { label: "Quá hạn", value: overdue, tone: overdue ? "rose" : "muted" },
          { label: "Chưa ai nhận", value: unassigned, tone: unassigned ? "amber" : "muted" },
          {
            label: "Tiền đang treo",
            value: filtered.length - unknownMoney ? formatVND(atRisk, { compact: true }) : "—",
            note: unknownMoney ? `${unknownMoney} việc chưa tra được` : "đã tra được hết",
            hint: "Chỉ cộng việc TRA ĐƯỢC tiền. Việc chưa tra được không bị coi là 0đ.",
          },
        ]}
      />

      <WorkFilters />

      <SectionCard padded={false}>
        <WorkList items={shown} showDepartment emptyTitle="Không việc nào khớp bộ lọc" emptyDescription="Bỏ bớt bộ lọc, hoặc mừng vì hàng đợi trống." canAct={can(user, "work:manage")} />
      </SectionCard>
    </div>
  );
}

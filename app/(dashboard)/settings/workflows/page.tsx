import Link from "next/link";
import { Plus, TriangleAlert } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { RuleModeBadge, RuleStatusBadge } from "@/components/platform/workflow/badges";
import { RunNowButton } from "@/components/platform/workflow/run-now-button";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { loadStaleWorkflowRuns, loadWorkflowList, loadWorkflowScheduleSentence, type StaleRunView } from "@/lib/platform-ui/workflow-admin";
import { triggerSummary } from "@/lib/platform-ui/workflow-admin-shared";
import { WORKFLOW_MAX_ATTEMPTS } from "@/lib/workflow/types";

export const metadata = { title: "Luật tự động" };

const TITLE = "Luật tự động";

/**
 * LUẬT TỰ ĐỘNG — danh sách luật của tổ chức NGƯỜI XEM (Phase 3).
 *
 * Luật mới luôn ở NHÁP + CHẠY THỬ (luật 23, 25): không luật nào tự chạy thật khi vừa tạo. Bảng chỉ đọc; sửa,
 * bật, chạy thử, chuyển chạy thật ở trang của từng luật.
 */
export default async function WorkflowsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePermission("workflow:manage");
  const sp = await searchParams;
  const showStale = sp.view === "stale";
  const [loaded, stale, schedule] = await Promise.all([loadWorkflowList(user), loadStaleWorkflowRuns(user), loadWorkflowScheduleSentence(user)]);
  const staleRuns = stale.ok ? stale.value : [];
  const newButton = (
    <Button asChild size="sm">
      <Link href="/settings/workflows/new">
        <Plus /> Luật mới
      </Link>
    </Button>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống"
        title={TITLE}
        description={user.organization?.name}
        actions={
          loaded.ok ? (
            <div className="flex flex-wrap items-start gap-2">
              <RunNowButton />
              {newButton}
            </div>
          ) : null
        }
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>Mỗi luật: KHI NÀO (sự kiện hệ thống hoặc trạng thái nghiệp vụ đổi) · ĐIỀU KIỆN · LÀM GÌ (tạo việc, báo trong ERP, ghi giá trị field tuỳ biến) · có cần người duyệt không.</p>
            <p>Luật mới luôn ở NHÁP + CHẠY THỬ. Bật rồi xem lượt chạy thử trước, sau đó mới chuyển CHẠY THẬT. Luật không bao giờ đổi đơn, vận đơn, COD hay tồn kho.</p>
            {/* Câu nhịp đọc CÙNG hằng số / gói mà job `workflows` dùng (`lib/constants/workflow-cadence.ts`) — không gõ số ở đây. */}
            <p>{schedule ? `${schedule} ` : ""}«Chạy lượt kiểm tra ngay» chạy một lượt ngay, không chờ kỳ. Bấm nhiều lần không làm hai lần một việc.</p>
          </div>
        }
      />
      {staleRuns.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <TriangleAlert className="size-4 shrink-0" />
          <span>
            <b className="numeric">{staleRuns.length}</b> lượt chạy đang treo hoặc cần người xem — máy tự chiếm lại lượt quá hạn giữ ở lượt kế tiếp (tối đa {WORKFLOW_MAX_ATTEMPTS} lần), phần còn lại cần người quyết.
          </span>
          <Link href={showStale ? "/settings/workflows" : "/settings/workflows?view=stale"} className="font-medium underline underline-offset-2">
            {showStale ? "Ẩn danh sách" : "Xem các lượt treo"}
          </Link>
        </div>
      ) : null}
      {showStale ? <StaleRunsCard runs={staleRuns} /> : null}
      {!loaded.ok ? (
        <EmptyState title="Không mở được danh sách luật" description={loaded.errors.map((e) => e.message).join(" · ")} />
      ) : loaded.value.length === 0 ? (
        <EmptyState title="Chưa có luật tự động nào" description="Tạo luật đầu tiên — nó sinh ra ở NHÁP + CHẠY THỬ, máy chưa làm gì thật cho tới khi bạn bật và chuyển chạy thật." action={newButton} />
      ) : (
        <SectionCard title="Luật của tổ chức" padded={false} contentClassName="p-3">
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Tên</th>
                  <th className="px-3 py-2">Khoá</th>
                  <th className="px-3 py-2">Khi nào</th>
                  <th className="px-3 py-2">Trạng thái</th>
                  <th className="px-3 py-2">Chế độ</th>
                  <th className="px-3 py-2 text-right">Phiên bản</th>
                </tr>
              </thead>
              <tbody>
                {loaded.value.map((r) => (
                  <tr key={r.id} className="border-t border-hairline">
                    <td className="px-3 py-2">
                      <Link href={`/settings/workflows/${encodeURIComponent(r.id)}`} className="font-medium text-primary underline-offset-2 hover:underline">
                        {r.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2 font-mono text-[12.5px]">{r.key}</td>
                    <td className="max-w-[320px] truncate px-3 py-2" title={triggerSummary(r.trigger)}>
                      {triggerSummary(r.trigger)}
                    </td>
                    <td className="px-3 py-2">
                      <RuleStatusBadge status={r.status} />
                    </td>
                    <td className="px-3 py-2">
                      <RuleModeBadge mode={r.mode} />
                    </td>
                    <td className="numeric px-3 py-2 text-right">{r.version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}
    </div>
  );
}

/** Bảng lượt treo (`?view=stale`) — chỉ đọc; tên luật dẫn về trang của luật, nơi có bảng lượt chạy đầy đủ. */
function StaleRunsCard({ runs }: { runs: StaleRunView[] }) {
  return (
    <SectionCard title="Lượt chạy treo" description="Đang chạy thì dừng · đã có lời duyệt mà chưa xử lý · lời duyệt chưa thanh toán · dừng vì treo" padded={false} contentClassName="p-3">
      {runs.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">Không có lượt chạy nào đang treo.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Cập nhật</th>
                <th className="px-3 py-2">Luật</th>
                <th className="px-3 py-2">Loại</th>
                <th className="px-3 py-2">Bản ghi</th>
                <th className="px-3 py-2 text-right">Lần chiếm</th>
                <th className="px-3 py-2">Lý do</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t border-hairline align-top">
                  <td className="whitespace-nowrap px-3 py-2">{formatDateTime(r.updatedAt)}</td>
                  <td className="px-3 py-2">
                    <Link href={`/settings/workflows/${encodeURIComponent(r.ruleId)}`} className="font-medium text-primary underline-offset-2 hover:underline">
                      {r.ruleName ?? r.ruleId}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{r.kindLabel}</td>
                  <td className="px-3 py-2 font-mono text-[12.5px]">{r.subjectType && r.subjectId ? `${r.subjectType}:${r.subjectId}` : "—"}</td>
                  <td className="numeric px-3 py-2 text-right">{r.attempt}</td>
                  <td className="max-w-[360px] px-3 py-2 text-xs text-muted-foreground">{r.error ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

import Link from "next/link";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { RuleModeBadge, RuleStatusBadge } from "@/components/platform/workflow/badges";
import { RunNowButton } from "@/components/platform/workflow/run-now-button";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { loadWorkflowList } from "@/lib/platform-ui/workflow-admin";
import { triggerSummary } from "@/lib/platform-ui/workflow-admin-shared";

export const metadata = { title: "Luật tự động" };

const TITLE = "Luật tự động";

/**
 * LUẬT TỰ ĐỘNG — danh sách luật của tổ chức NGƯỜI XEM (Phase 3).
 *
 * Luật mới luôn ở NHÁP + CHẠY THỬ (luật 23, 25): không luật nào tự chạy thật khi vừa tạo. Bảng chỉ đọc; sửa,
 * bật, chạy thử, chuyển chạy thật ở trang của từng luật.
 */
export default async function WorkflowsPage() {
  const user = await requirePermission("workflow:manage");
  const loaded = await loadWorkflowList(user);
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
            <p>Máy kiểm luật mỗi lượt của job cảnh báo (10 phút). Tổ chức tắt module Cần xử lý thì không có lượt tự động — bấm «Chạy lượt kiểm tra ngay». Bấm nhiều lần không làm hai lần một việc.</p>
          </div>
        }
      />
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

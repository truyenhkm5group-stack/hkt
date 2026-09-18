import { TechHealthBadge, TechVerificationBadge } from "@/app/(dashboard)/tech/badges";
import { SyncButton } from "@/components/sync-button";
import { TechDeploymentRecordForm, TechDeploymentUpdateForm } from "@/app/(dashboard)/tech/deployments/deployment-form";
import { TechDeploymentsTable } from "@/app/(dashboard)/tech/deployments/deployments-table";
import { TechNav } from "@/app/(dashboard)/tech/tech-nav";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { PageHeader } from "@/components/page-header";
import { DescriptionList, SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { TECH_DEPLOY_SORTABLE, TECH_VERIFICATION_HINT, type TechVerification } from "@/lib/constants/tech";
import { githubConfig } from "@/lib/integrations/github/client";
import { formatDateTime, formatNumber } from "@/lib/format";
import { getTechSystemHealth } from "@/lib/queries/tech-health";
import { lastSuccessfulDeployment, listTechDeployments, recentTechDeployments, techDeploymentFacets } from "@/lib/queries/tech-ops";
import { commitMatches } from "@/lib/tech/health-parse";
import { parseListParams, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Deploy" };

export default async function TechDeploymentsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  const user = await requirePermission("tech:view");
  const canManage = can(user, "tech:manage");
  const params = parseListParams(raw, { defaultSort: "startedAt", filterKeys: ["status", "branch"], sortable: TECH_DEPLOY_SORTABLE, defaultPeriod: "30d" });
  const [{ rows, total, pageCount }, facets, health, last, ganDay] = await Promise.all([
    listTechDeployments(params),
    techDeploymentFacets(params),
    getTechSystemHealth(),
    lastSuccessfulDeployment(),
    recentTechDeployments(10),
  ]);
  const gh = githubConfig();

  const khop = commitMatches(health.version.commit, last?.commitSha ?? null);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Phòng Tech AI"
        title="Deploy"
        description={`${formatNumber(total)} lượt trong ${params.period.label.toLowerCase()}`}
        actions={
          canManage ? (
            <div className="flex flex-wrap gap-2">
              {/* ĐỌC, không phải deploy: nút này nạp lại lượt chạy từ GitHub Actions vào sổ quan sát. */}
              {gh.configured ? <SyncButton job="github-deployments" label="Đọc lại từ GitHub" /> : null}
              <TechDeploymentUpdateForm deployments={ganDay.map((d) => ({ id: d.id, label: `${d.commitSha.slice(0, 7)} · ${d.branch} · ${formatDateTime(d.startedAt)}` }))} />
              <TechDeploymentRecordForm />
            </div>
          ) : null
        }
        hint={
          <>
            ERP <b>không deploy</b> và không dừng được một lượt deploy: workflow{" "}
            <b>Deploy ERP to VPS</b> trên GitHub Actions là bên có thẩm quyền. Bảng này là lớp{" "}
            <b>quan sát</b> để trả lời “lần deploy gần nhất là commit nào, do ai, kết quả ra sao”.
            Commit <i>đang chạy</i> đọc từ <code>/api/health</code> — nếu nó lệch với lượt deploy
            thành công gần nhất thì hai lời khai không thống nhất và phải đi xem.
          </>
        }
      />

      <TechNav />

      <SectionCard title="Bản đang chạy trên production" description="Lời khai của tiến trình, đối chiếu với sổ quan sát">
        <DescriptionList
          items={[
            { label: "Commit đang chạy", value: health.version.commit ? <span className="font-mono">{health.version.commit.slice(0, 7)}</span> : <span className="text-muted-foreground">— chưa khai (ERP_COMMIT trống)</span> },
            { label: "Nhánh", value: health.version.branch ?? <span className="text-muted-foreground">—</span> },
            {
              label: "Lượt deploy thành công gần nhất",
              value: last ? (
                <span>
                  <span className="font-mono">{last.commitSha.slice(0, 7)}</span> · {formatDateTime(last.startedAt)}
                </span>
              ) : (
                <span className="text-muted-foreground">— chưa ghi lượt nào</span>
              ),
            },
            {
              label: "Đọc từ GitHub Actions",
              value: gh.configured ? (
                <span className="text-success">Đã bật · {gh.repo}</span>
              ) : (
                <span className="text-muted-foreground">Chưa bật — {gh.reason} Sổ deploy vẫn ghi tay được.</span>
              ),
              span: true,
            },
            {
              label: "Đối chiếu",
              value:
                khop === null ? (
                  <span className="text-muted-foreground">Chưa đủ căn cứ để so — một trong hai vế còn trống</span>
                ) : khop ? (
                  <span className="text-success">Khớp</span>
                ) : (
                  <span className="font-semibold text-destructive">LỆCH — container có thể chưa khởi động lại, hoặc máy chủ được cập nhật bằng đường khác</span>
                ),
            },
            {
              label: "Xác minh lượt gần nhất",
              value: last ? (
                <span title={TECH_VERIFICATION_HINT[last.verification as TechVerification]}>
                  <TechVerificationBadge verification={last.verification as TechVerification} />
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              ),
            },
            { label: "Sức khoẻ tổng", value: <TechHealthBadge state={health.worst} />, span: true },
          ]}
        />
      </SectionCard>

      <DataTableToolbar
        searchPlaceholder="Commit, nhánh, ghi chú…"
        period={{ defaultKey: "30d" }}
        facets={[
          { key: "status", label: "Kết quả", options: facets.status },
          { key: "branch", label: "Nhánh", options: facets.branch },
        ]}
        resultLabel={`${formatNumber(total)} lượt deploy`}
      />

      <TechDeploymentsTable rows={rows} pageCount={pageCount} total={total} />
    </div>
  );
}

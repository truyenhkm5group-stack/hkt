import Link from "next/link";
import { Activity, AlertTriangle, Bot, GitBranch, ListChecks, Rocket, ShieldCheck } from "lucide-react";
import { TechApprovalBadge, TechDeployBadge, TechHealthBadge, TechPriorityBadge, TechRiskBadge, TechSeverityBadge, TechStatusBadge } from "@/app/(dashboard)/tech/badges";
import { TechNav } from "@/app/(dashboard)/tech/tech-nav";
import { PageHeader } from "@/components/page-header";
import { MetricCard } from "@/components/metric-card";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { TECH_MODULE_LABEL, type TechIncidentSeverity, type TechModule, type TechPriority, type TechRisk, type TechTaskStatus } from "@/lib/constants/tech";
import { formatDateTime, formatNumber, formatTimeAgo } from "@/lib/format";
import { techOverviewCounts, techTasksAwaitingApproval, topTechTasks } from "@/lib/queries/tech";
import { runningTechAgentRuns } from "@/lib/queries/tech-agents";
import { getTechSystemHealth } from "@/lib/queries/tech-health";
import { lastSuccessfulDeployment, openTechIncidents, recentTechDeployments } from "@/lib/queries/tech-ops";
import { commitMatches } from "@/lib/tech/health-parse";

export const metadata = { title: "Phòng Tech AI" };

/** `null` = CHƯA BIẾT. In ra dấu gạch, không in ra 0 và không in ra chuỗi rỗng (AGENTS.md mục 42). */
function hoacGach(value: string | null | undefined) {
  return value && value.trim() ? value : "—";
}

export default async function TechPage() {
  const user = await requirePermission("tech:view");
  const canManage = can(user, "tech:manage");

  const [health, counts, top, cho, chay, deploys, lastDeploy, incidents] = await Promise.all([
    getTechSystemHealth(),
    techOverviewCounts(),
    topTechTasks(8),
    techTasksAwaitingApproval(5),
    runningTechAgentRuns(),
    recentTechDeployments(5),
    lastSuccessfulDeployment(),
    openTechIncidents(6),
  ]);

  /*
    Commit ĐANG CHẠY (lời khai của tiến trình) so với commit của lượt deploy THÀNH CÔNG gần nhất
    (lời khai của sổ quan sát). Hai lời khai lệch nhau là một sự việc có thật — container chưa khởi
    động lại, hoặc ai đó cập nhật máy chủ bằng đường khác — và màn hình phải nói ra thay vì lặng lẽ
    chọn một trong hai. `null` nghĩa là chưa đủ căn cứ để so, KHÔNG phải "khớp".
  */
  const khop = commitMatches(health.version.commit, lastDeploy?.commitSha ?? null);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống"
        title="Phòng Tech AI"
        description="Sức khoẻ hệ thống, hàng đợi việc kỹ thuật, sổ agent, lịch sử deploy và sự cố đang mở"
        hint={
          <>
            Đây là <b>mặt phẳng điều khiển</b> của phần kỹ thuật, không phải máy thi hành: nó không
            tự sửa mã, không tự merge, không tự deploy và không ghi vào dữ liệu production. GitHub
            Actions vẫn là bên có thẩm quyền về deploy; commit đang chạy đọc từ <code>/api/health</code>.
            Việc mức <b>R2</b> (lương, lợi nhuận, tồn kho, kết quả đơn, quyền, migration, secret)
            phải được chủ shop bấm duyệt trước khi đi tiếp.
          </>
        }
      />

      <TechNav />

      {/* ───────── Sáu thẻ dẫn dắt. Mỗi con số mở đúng bộ lọc đã sinh ra nó. ───────── */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard
          label="Production"
          value={<TechHealthBadge state={health.worst} />}
          note={hoacGach(health.version.commit ? `commit ${health.version.commit.slice(0, 7)}${health.version.branch ? ` · ${health.version.branch}` : ""}` : null)}
          hint="Mức XẤU NHẤT trong các tín hiệu bên dưới, không phải trung bình: một chỗ hỏng là hệ thống hỏng. “Chưa xác minh” xếp trên “đang chạy tốt” để một bảng toàn dấu hỏi không bao giờ hiện ra màu xanh."
          icon={ShieldCheck}
          tone={health.worst === "HEALTHY" ? "green" : health.worst === "UNKNOWN" ? "slate" : health.worst === "DEGRADED" ? "amber" : "rose"}
        />
        <MetricCard
          label="Deploy gần nhất"
          value={lastDeploy ? lastDeploy.commitSha.slice(0, 7) : "—"}
          note={
            lastDeploy
              ? khop === null
                ? "Chưa đủ căn cứ để đối chiếu với bản đang chạy"
                : khop
                  ? `Khớp với bản đang chạy · ${formatTimeAgo(lastDeploy.startedAt)}`
                  : `LỆCH với bản đang chạy (${hoacGach(health.version.commit?.slice(0, 7))}) — container có thể chưa khởi động lại`
              : "Chưa ghi lượt deploy nào vào sổ quan sát"
          }
          hint="Lượt deploy THÀNH CÔNG gần nhất trong sổ quan sát của ERP. Nếu nó lệch với commit mà tiến trình đang khai, nghĩa là hai lời khai không thống nhất — phải đi xem, không được bỏ qua."
          icon={Rocket}
          tone={khop === false ? "rose" : "blue"}
          href="/tech/deployments"
        />
        <MetricCard
          label="Việc P0 / P1 đang mở"
          value={formatNumber(counts.tasks.p0 + counts.tasks.p1)}
          note={`P0: ${formatNumber(counts.tasks.p0)} · P1: ${formatNumber(counts.tasks.p1)} · tổng đang mở ${formatNumber(counts.tasks.open)}`}
          hint="P0 là “đang chảy máu” (production hỏng, số liệu sai, tiền đang mất); P1 là “trong ngày” (một phòng ban bị chặn, hoặc một con số ra quyết định đang không tin được)."
          icon={ListChecks}
          tone={counts.tasks.p0 > 0 ? "rose" : counts.tasks.p1 > 0 ? "amber" : "green"}
          goodWhen="down"
          href="/tech/tasks?priority=P0,P1&open=1"
        />
        <MetricCard
          label="Agent đang chạy"
          value={formatNumber(counts.runs.running)}
          note={`${formatNumber(counts.agents.enabled)}/${formatNumber(counts.agents.total)} agent đang bật · ${formatNumber(counts.runs.last24h)} lượt chạy trong 24 giờ`}
          hint="Phase 1 chưa có agent nào tự chạy: sổ agent là DỮ LIỆU ĐIỀU KHIỂN. Con số này chỉ khác 0 khi có lượt chạy được ghi vào — bảng trống là trạng thái đúng, không phải thiếu dữ liệu."
          icon={Bot}
          tone="slate"
          href="/tech/agents"
        />
        <MetricCard
          label="Deploy hôm nay"
          value={formatNumber(counts.deployments.today)}
          note={counts.deployments.failedToday > 0 ? `${formatNumber(counts.deployments.failedToday)} lượt thất bại / quay lui` : counts.deployments.lastAt ? `Gần nhất ${formatTimeAgo(counts.deployments.lastAt)}` : "Chưa có lượt nào"}
          hint="Đếm trên 24 giờ gần nhất theo sổ quan sát của ERP, không phải theo GitHub Actions — hai con số lệch nhau nghĩa là có lượt deploy chưa được ghi vào sổ."
          icon={GitBranch}
          tone={counts.deployments.failedToday > 0 ? "rose" : "blue"}
          href="/tech/deployments"
        />
        <MetricCard
          label="Sự cố đang mở"
          value={formatNumber(counts.incidents.open)}
          note={counts.incidents.sev01 > 0 ? `${formatNumber(counts.incidents.sev01)} sự cố SEV0 / SEV1` : "Không có sự cố nặng"}
          hint="Mở = chưa ở trạng thái “Đã đóng”. Đóng một sự cố bắt buộc kể được ĐÃ LÀM GÌ để nó hết; nguyên nhân gốc thì không bắt buộc — chưa chứng minh được thì để trống, không bịa."
          icon={AlertTriangle}
          tone={counts.incidents.sev01 > 0 ? "rose" : counts.incidents.open > 0 ? "amber" : "green"}
          goodWhen="down"
          href="/tech/incidents?open=1"
        />
      </div>

      {/* ───────── Việc chờ chủ shop bấm duyệt: đứng TRƯỚC mọi thứ khác ───────── */}
      {cho.length > 0 ? (
        <SectionCard
          title={`${formatNumber(counts.tasks.waitingApproval)} việc đang chờ chủ shop phê duyệt`}
          description="Việc mức R2 chạm tới lương, lợi nhuận, tồn kho, kết quả đơn, quyền, migration hoặc secret — không đi tiếp được cho tới khi có người bấm"
        >
          <ul className="divide-y divide-hairline">
            {cho.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <Link href={`/tech/tasks/${t.id}`} className="min-w-0 flex-1 font-medium hover:underline">
                  <span className="text-muted-foreground">{t.code}</span> · {t.title}
                </Link>
                <span className="flex items-center gap-1.5">
                  <TechRiskBadge risk={t.risk as TechRisk} />
                  <TechApprovalBadge status="PENDING" />
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ───────── Hàng đợi ───────── */}
        <SectionCard
          title="Hàng đợi việc Tech"
          description="Việc còn mở, gấp nhất đứng trước"
          actions={
            <Link href="/tech/tasks" className="text-xs font-semibold text-primary hover:underline">
              Xem tất cả →
            </Link>
          }
        >
          {top.length === 0 ? (
            <EmptyState
              title="Chưa có việc Tech nào"
              description={canManage ? "Mở hàng đợi để ghi việc đầu tiên. Mức rủi ro do máy xếp theo luật, người đè được nhưng phải nói lý do." : "Chưa ai ghi việc kỹ thuật nào vào hàng đợi."}
              icon={ListChecks}
            />
          ) : (
            <ul className="divide-y divide-hairline">
              {top.map((t) => (
                <li key={t.id} className="py-2.5">
                  <Link href={`/tech/tasks/${t.id}`} className="block hover:underline">
                    <span className="text-xs text-muted-foreground">{t.code}</span>
                    <span className="ml-1.5 text-sm font-medium">{t.title}</span>
                  </Link>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <TechPriorityBadge priority={t.priority as TechPriority} />
                    <TechStatusBadge status={t.status as TechTaskStatus} />
                    <TechRiskBadge risk={t.risk as TechRisk} />
                    <span className="text-[11px] text-muted-foreground">
                      {TECH_MODULE_LABEL[t.module as TechModule] ?? t.module} · {t.agent ? `agent ${t.agent.name}` : "chưa giao agent"}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        {/* ───────── Sức khoẻ hệ thống ───────── */}
        <SectionCard
          title="Sức khoẻ hệ thống"
          description={`Đo lúc ${formatDateTime(health.checkedAt)}`}
          hint="Bốn mức: đang chạy tốt · chạy nhưng có lỗi · không nhận được dữ liệu · CHƯA XÁC MINH. Mức cuối KHÔNG phải một dạng nhẹ của “khoẻ” — nó nghĩa là chưa có bằng chứng nào, và việc phải làm là đi lấy dữ liệu chứ không phải đi sửa."
        >
          <ul className="divide-y divide-hairline">
            {health.signals.map((s) => (
              <li key={s.key} className="py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {s.href ? (
                      <Link href={s.href} className="hover:underline">
                        {s.label}
                      </Link>
                    ) : (
                      s.label
                    )}
                  </span>
                  <TechHealthBadge state={s.state} />
                </div>
                <p className="mt-0.5 text-[11.5px] leading-5 text-muted-foreground">{s.reason}</p>
                <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                  {/* CHƯA CÓ bằng chứng nào khác hẳn "vừa đo và thấy trống" — nói thẳng ra. */}
                  {s.measuredAt ? `Bằng chứng gần nhất: ${formatDateTime(s.measuredAt)}` : "Chưa có bằng chứng nào"}
                </p>
              </li>
            ))}
          </ul>
        </SectionCard>

        {/* ───────── Lượt chạy agent ───────── */}
        <SectionCard title="Lượt chạy agent đang mở" description="Phase 1 chưa có agent tự chạy — bảng trống là đúng">
          {chay.length === 0 ? (
            <EmptyState
              title="Không có lượt chạy nào đang mở"
              description="Sổ agent ở Phase 1 là dữ liệu điều khiển: nó khai ai được làm gì, chưa có máy thi hành nào gọi vào."
              icon={Activity}
            />
          ) : (
            <ul className="divide-y divide-hairline">
              {chay.map((r) => (
                <li key={r.id} className="py-2.5 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{r.agent?.name ?? r.agentKey}</span>
                    <span className="text-[11px] text-muted-foreground">{formatTimeAgo(r.startedAt)}</span>
                  </div>
                  <p className="text-[11.5px] text-muted-foreground">
                    {r.task ? (
                      <Link href={`/tech/tasks/${r.task.id}`} className="hover:underline">
                        {r.task.code} · {r.task.title}
                      </Link>
                    ) : (
                      "Không gắn với việc nào"
                    )}
                  </p>
                  {/* Một lượt "đang chạy" quá lâu thường là tiến trình đã chết mà không ai đóng sổ.
                      Nói thẳng, vì nếu không thì thẻ “agent đang chạy” sẽ nói dối mãi mãi. */}
                  {r.stale ? <p className="mt-0.5 text-[11px] font-semibold text-amber-600">Mở đã lâu bất thường — nhiều khả năng tiến trình đã chết mà lượt chạy chưa được đóng.</p> : null}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        {/* ───────── Deploy gần đây ───────── */}
        <SectionCard
          title="Deploy gần đây"
          description="Lớp quan sát — GitHub Actions là bên có thẩm quyền"
          actions={
            <Link href="/tech/deployments" className="text-xs font-semibold text-primary hover:underline">
              Xem tất cả →
            </Link>
          }
        >
          {deploys.length === 0 ? (
            <EmptyState title="Chưa ghi lượt deploy nào" description="ERP không tự phát hiện được lượt deploy: sổ này được ghi vào, và lần ghi đầu tiên chưa xảy ra." icon={Rocket} />
          ) : (
            <ul className="divide-y divide-hairline">
              {deploys.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="font-mono text-xs">{d.commitSha.slice(0, 7)}</span>
                    <span className="ml-1.5 text-[11.5px] text-muted-foreground">
                      {d.branch} · {formatTimeAgo(d.startedAt)}
                      {d.task ? ` · ${d.task.code}` : ""}
                    </span>
                  </span>
                  <TechDeployBadge status={d.status as never} />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      {/* ───────── Sự cố đang mở ───────── */}
      <SectionCard
        title="Sự cố đang mở"
        description="Nặng nhất đứng trước"
        actions={
          <Link href="/tech/incidents" className="text-xs font-semibold text-primary hover:underline">
            Xem tất cả →
          </Link>
        }
      >
        {incidents.length === 0 ? (
          <EmptyState title="Không có sự cố nào đang mở" description="Sổ sự cố chỉ ghi thứ CÓ BẰNG CHỨNG. Trống nghĩa là chưa ai mở sự cố nào, không phải hệ thống đã được kiểm tra và thấy ổn." icon={AlertTriangle} />
        ) : (
          <ul className="divide-y divide-hairline">
            {incidents.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <Link href={`/tech/incidents/${i.id}`} className="min-w-0 flex-1 font-medium hover:underline">
                  <span className="text-muted-foreground">{i.code}</span> · {i.title}
                </Link>
                <span className="flex items-center gap-1.5">
                  <TechSeverityBadge severity={i.severity as TechIncidentSeverity} />
                  <span className="text-[11px] text-muted-foreground">{formatTimeAgo(i.detectedAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

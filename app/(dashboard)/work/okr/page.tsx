import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { requirePermission, can } from "@/lib/auth/session";
import { METRIC_TRUST_LABEL, METRIC_UNIT_LABEL } from "@/lib/constants/metric-bindings";
import { formatVND } from "@/lib/format";
import { BSC_PERSPECTIVE_HINT, BSC_PERSPECTIVE_TONE } from "@/lib/constants/bsc";
import { KR_CONFIDENCE_LABEL, KR_CONFIDENCE_TONE, OKR_LEVEL_LABEL } from "@/lib/constants/okr";
import { getScorecard } from "@/lib/queries/bsc";
import { currentQuarter, listObjectives, okrPeriods, quarterRange, type KeyResultView } from "@/lib/queries/okr";
import { param, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { OkrToolbar } from "@/app/(dashboard)/work/okr/toolbar";
import { AddBscMetric, DeleteBscMetric } from "@/components/work/bsc-editor";
import { AddKeyResult, CheckinKeyResult, DeleteKeyResult, DeleteObjective, ObjectiveStatus } from "@/components/work/okr-editor";
import { listDepartments } from "@/lib/queries/work";

export const metadata = { title: "Mục tiêu · OKR & BSC" };

/**
 * ═══════ MỤC TIÊU ═══════
 *
 * Một trang, hai lớp: OKR (định hướng theo quý) và BSC (thẻ điểm cân bằng theo kỳ).
 *
 * Luật hiển thị quan trọng nhất: **KR chưa đo được KHÔNG bao giờ hiện 0%.** Một thanh tiến độ
 * rỗng nói "đang thất bại"; ở đây sự thật là "chưa biết". Hai thứ đó dẫn tới hai hành động khác
 * nhau, nên chúng phải trông khác nhau.
 */
function formatValue(v: number | null, unit: string): string {
  if (v === null) return "chưa đo được";
  if (unit === "VND") return formatVND(v, { compact: true });
  if (unit === "PERCENT") return `${Math.round(v * 10) / 10}%`;
  return new Intl.NumberFormat("vi-VN").format(Math.round(v * 100) / 100);
}

function KrRow({ kr, canManage }: { kr: KeyResultView; canManage: boolean }) {
  const measured = kr.progress !== null;
  return (
    <li className="space-y-1.5 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={kr.title}>{kr.title}</span>
        <Badge variant="secondary" className={cn("text-[11px]", KR_CONFIDENCE_TONE[kr.confidence])}>{KR_CONFIDENCE_LABEL[kr.confidence]}</Badge>
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatValue(kr.current, kr.unit)} / {formatValue(kr.target, kr.unit)}
          {kr.unit !== "PERCENT" && kr.unit !== "VND" ? ` ${METRIC_UNIT_LABEL[kr.unit].toLowerCase()}` : ""}
        </span>
        <span className={cn("w-14 text-right text-sm font-semibold tabular-nums", !measured && "text-muted-foreground")}>
          {measured ? `${Math.round(kr.progress!)}%` : "—"}
        </span>
        {canManage ? (
          <span className="flex items-center gap-0.5">
            <CheckinKeyResult id={kr.id} manual={kr.trust === "MANUAL"} current={kr.current} />
            <DeleteKeyResult id={kr.id} />
          </span>
        ) : null}
      </div>
      {/* Chưa đo được thì KHÔNG vẽ thanh: thanh rỗng trông hệt như đang ở 0%. */}
      {measured ? <Progress value={Math.min(100, kr.progress!)} className="h-1.5" /> : null}
      <p className="text-[11px] text-muted-foreground">
        <span className={cn("mr-1.5 font-medium", kr.trust === "MANUAL" && "text-amber-600 dark:text-amber-400")}>{METRIC_TRUST_LABEL[kr.trust]}</span>
        {kr.basis || (kr.trust === "MANUAL" ? "ERP chưa đo được chỉ số này — người phụ trách tự nhập" : "")}
        {kr.note ? <span className="ml-1 text-amber-600 dark:text-amber-400">· {kr.note}</span> : null}
      </p>
    </li>
  );
}

export default async function OkrPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("okr:view");
  const raw = await searchParams;
  const period = param(raw, "period", currentQuarter());
  const range = quarterRange(period);
  const metricPeriod = { key: "custom" as const, from: range?.start ?? null, to: range?.end ?? null, label: period, fromKey: null, toKey: null };

  const [objectives, periods, departments, company] = await Promise.all([
    listObjectives({ period, includeDraft: can(user, "okr:manage") }, metricPeriod),
    okrPeriods(),
    listDepartments(),
    getScorecard({ scope: "COMPANY", departmentId: null, period }, metricPeriod),
  ]);

  const canManage = can(user, "okr:manage");
  const byLevel = (["COMPANY", "DEPARTMENT", "INDIVIDUAL"] as const).map((level) => ({ level, list: objectives.filter((o) => o.level === level) }));

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Mục tiêu"
        title={`OKR & thẻ điểm · ${period}`}
        description="Objective là định tính; Key Result là định lượng. Chỉ số nối vào sổ đăng ký của ERP, không bịa."
        hint="Key Result nối vào một chỉ số CÓ THẬT thì con số đọc sống mỗi lần mở trang. Chỉ số ERP chưa đo được thì để “Nhập tay” — và nó hiện đúng nhãn đó, chứ không giả vờ là số đo. KR chưa có số hiện “chưa đo được”, KHÔNG hiện 0%."
        actions={<OkrToolbar periods={[...new Set([period, currentQuarter(), ...periods])]} period={period} departments={departments.map((d) => ({ code: d.code, name: d.name }))} canManage={can(user, "okr:manage")} />}
      />

      {byLevel.map(({ level, list }) =>
        list.length ? (
          <SectionCard key={level} title={`Mục tiêu cấp ${OKR_LEVEL_LABEL[level].toLowerCase()}`} padded={false}>
            <div className="divide-y">
              {list.map((o) => (
                <div key={o.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2 bg-muted/40 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{o.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {[o.departmentName, o.ownerName].filter(Boolean).join(" · ") || "Toàn shop"}
                        {o.description ? ` — ${o.description}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="text-right">
                        <p className={cn("text-lg font-bold tabular-nums", o.progress === null && "text-muted-foreground")}>{o.progress === null ? "—" : `${Math.round(o.progress)}%`}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {o.measuredCount}/{o.totalCount} KR đo được
                        </p>
                      </div>
                      <ObjectiveStatus id={o.id} status={o.status} canManage={canManage} />
                      {canManage ? (
                        <span className="flex items-center gap-0.5">
                          <AddKeyResult objectiveId={o.id} />
                          <DeleteObjective id={o.id} title={o.title} />
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {o.keyResults.length ? (
                    <ul className="divide-y">{o.keyResults.map((kr) => <KrRow key={kr.id} kr={kr} canManage={canManage} />)}</ul>
                  ) : (
                    <p className="px-3 py-3 text-xs text-muted-foreground">Chưa có Key Result nào — mục tiêu không có số thì không đo được.</p>
                  )}
                </div>
              ))}
            </div>
          </SectionCard>
        ) : null,
      )}

      {objectives.length === 0 ? (
        <SectionCard>
          <EmptyState
            title={`Chưa có mục tiêu nào cho kỳ ${period}`}
            description={can(user, "okr:manage") ? "Bấm “Thêm mục tiêu” để đặt Objective đầu tiên. Mỗi Objective cần ít nhất một Key Result có số." : "Quản lý chưa đặt mục tiêu cho kỳ này."}
            className="border-0"
          />
        </SectionCard>
      ) : null}

      <SectionCard
        title={company ? `Thẻ điểm cân bằng · ${company.name}` : "Thẻ điểm cân bằng"}
        description={company ? `Điểm tổng ${company.score === null ? "chưa tính được" : `${Math.round(company.score)}%`} · đo được ${Math.round(company.coverage * 100)}% trọng số` : undefined}
        actions={company && canManage ? <AddBscMetric scorecardId={company.id} /> : null}
        hint="Bốn góc nhìn CÂN BẰNG NHAU ở cấp thẻ — đó là ý nghĩa của chữ “cân bằng”. Trọng số chỉ phân biệt các ô bên trong một góc nhìn. Ô chưa đo được rơi khỏi cả tử lẫn mẫu, không bị tính 0 điểm; phần trăm độ phủ nói rõ điểm đang đứng trên bao nhiêu."
        padded={false}
      >
        {company ? (
          <div className="grid gap-px bg-border sm:grid-cols-2">
            {company.perspectives.map((p) => (
              <div key={p.perspective} className="bg-background p-3">
                <div className="flex items-center justify-between gap-2">
                  <Badge variant="secondary" className={cn("text-[11px]", BSC_PERSPECTIVE_TONE[p.perspective])}>{p.label}</Badge>
                  <span className={cn("text-sm font-semibold tabular-nums", p.score === null && "text-muted-foreground")}>{p.score === null ? "chưa đo được" : `${Math.round(p.score)}%`}</span>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">{BSC_PERSPECTIVE_HINT[p.perspective]}{p.coverage < 1 ? ` · đo được ${Math.round(p.coverage * 100)}% trọng số` : ""}</p>
                <ul className="mt-2 space-y-1">
                  {p.metrics.map((m) => (
                    <li key={m.id} className="flex items-center justify-between gap-2 text-xs">
                      <span className="min-w-0 truncate" title={m.basis || m.label}>{m.label}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        <span className={cn("tabular-nums", m.value === null && "text-muted-foreground")}>
                          {formatValue(m.value, m.unit)}
                          {m.target !== null ? <span className="text-muted-foreground"> / {formatValue(m.target, m.unit)}</span> : null}
                        </span>
                        {canManage ? <DeleteBscMetric id={m.id} /> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="Chưa có thẻ điểm cho kỳ này" description={can(user, "okr:manage") ? "Bấm “Thẻ điểm mới” để dựng — có thể dùng mẫu gợi ý rồi sửa. Mẫu chỉ là gợi ý khởi động, không phải chân lý." : "Quản lý chưa dựng thẻ điểm."} className="border-0" />
        )}
      </SectionCard>
    </div>
  );
}

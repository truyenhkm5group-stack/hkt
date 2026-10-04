import Link from "next/link";
import { FieldJobQuoteForm } from "@/components/field-jobs/field-job-forms";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { FIELD_JOB_STATUS_LABEL } from "@/lib/constants/field-jobs";
import { formatDateTime, formatVND, todayVN, vnClock } from "@/lib/format";
import { fieldJobDaySchedule, fieldJobFormOptions, listFieldJobs, type FieldJobFilter } from "@/lib/queries/field-jobs";

export const metadata = { title: "Phiếu công việc" };

/**
 * PHIẾU CÔNG VIỆC HIỆN TRƯỜNG (module `field_jobs`, 0200 · docs/verticals/home-service.md) — lịch thợ hôm nay, danh sách phiếu
 * (đang mở · việc của tôi · đã xong · tất cả), lập phiếu báo giá. Tổng / đã thu / còn nợ tính lúc đọc.
 */

const VIEWS: { key: FieldJobFilter["view"]; label: string }[] = [
  { key: "open", label: "Đang mở" },
  { key: "mine", label: "Việc của tôi" },
  { key: "done", label: "Đã nghiệm thu" },
  { key: "all", label: "Tất cả" },
];

export default async function FieldJobsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePermission("field_jobs:view");
  const sp = await searchParams;
  const view = VIEWS.find((v) => v.key === sp.xem)?.key ?? "open";
  const q = typeof sp.q === "string" ? sp.q.slice(0, 80) : "";
  const today = todayVN();
  const canWrite = can(user, "field_jobs:write");
  const [jobs, schedule, options] = await Promise.all([listFieldJobs({ view, q, userId: user.id }), fieldJobDaySchedule(today), canWrite ? fieldJobFormOptions() : Promise.resolve(null)]);
  const href = (k: string) => `/field-jobs?xem=${k}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Dịch vụ tại nhà"
        title="Phiếu công việc"
        description={`${jobs.length} phiếu · ${schedule.reduce((n, g) => n + g.jobs.length, 0)} lịch hẹn hôm nay`}
        hint="Báo giá → khách đồng ý → hẹn thợ (một thợ không bị hẹn chồng giờ) → bắt đầu → khách ký nghiệm thu. Tiền thu theo đợt ngay trên phiếu, không thu vượt báo giá. Còn nợ để trống nghĩa là chưa báo giá, không phải 0."
      />

      <SectionCard title="Lịch thợ hôm nay">
        {schedule.length ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-field-job-schedule={schedule.length}>
            {schedule.map((g) => (
              <div key={g.assigneeName} className="space-y-1 text-sm">
                <div className="font-medium">{g.assigneeName}</div>
                <ul className="space-y-0.5">
                  {g.jobs.map((j) => (
                    <li key={j.id}>
                      <Link href={`/field-jobs/${j.id}`} className="hover:underline">
                        {vnClock(j.start).slice(0, 5)}–{vnClock(j.end).slice(0, 5)} · {j.code} · {j.title}
                      </Link>
                      <span className="text-muted-foreground"> · {FIELD_JOB_STATUS_LABEL[j.status]}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Hôm nay chưa có lịch hẹn nào.</p>
        )}
      </SectionCard>

      <div className="flex flex-wrap items-center gap-2">
        <nav className="flex flex-wrap gap-1 text-sm" aria-label="Lọc phiếu">
          {VIEWS.map((v) => (
            <Link key={v.key} href={href(v.key)} className={`rounded-md border px-2 py-0.5 ${v.key === view ? "border-primary font-medium" : "text-muted-foreground hover:text-foreground"}`}>
              {v.label}
            </Link>
          ))}
        </nav>
        <form action="/field-jobs" className="flex items-center gap-2">
          <input type="hidden" name="xem" value={view} />
          <input name="q" defaultValue={q} placeholder="Mã phiếu, tên việc, khách, SĐT…" className="h-8 w-64 max-w-full rounded-md border bg-background px-2 text-sm" aria-label="Tra phiếu công việc" />
          <button type="submit" className="h-8 rounded-md border px-3 text-sm hover:bg-muted">
            Tra
          </button>
        </form>
      </div>

      <SectionCard title="Phiếu" description="Xếp theo giờ hẹn gần nhất trước.">
        {jobs.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-field-jobs={jobs.length}>
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3">Phiếu</th>
                  <th className="py-1 pr-3">Khách</th>
                  <th className="py-1 pr-3">Trạng thái</th>
                  <th className="py-1 pr-3">Hẹn</th>
                  <th className="py-1 pr-3 text-right">Báo giá</th>
                  <th className="py-1 text-right">Còn phải thu</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="border-t">
                    <td className="py-1 pr-3">
                      <Link href={`/field-jobs/${j.id}`} className="font-medium hover:underline">
                        {j.code}
                      </Link>{" "}
                      · {j.title}
                      {j.parentJobId ? <span className="text-xs text-muted-foreground"> · bảo hành</span> : null}
                    </td>
                    <td className="py-1 pr-3">
                      {j.customerName}
                      {j.customerPhone ? <span className="text-muted-foreground"> · {j.customerPhone}</span> : null}
                    </td>
                    <td className="py-1 pr-3">{FIELD_JOB_STATUS_LABEL[j.status]}</td>
                    <td className="py-1 pr-3">{j.scheduledStart ? `${formatDateTime(j.scheduledStart)} · ${j.assigneeName ?? "—"}` : "—"}</td>
                    <td className="py-1 pr-3 text-right">{formatVND(j.total)}</td>
                    <td className="py-1 text-right">{formatVND(j.due)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title={q ? "Không có phiếu nào khớp" : "Chưa có phiếu nào"} description={canWrite ? "Lập phiếu ở khung bên dưới." : undefined} />
        )}
      </SectionCard>

      {canWrite && options ? (
        <SectionCard title="Lập phiếu báo giá">
          <FieldJobQuoteForm customers={options.customers} />
        </SectionCard>
      ) : null}
    </div>
  );
}

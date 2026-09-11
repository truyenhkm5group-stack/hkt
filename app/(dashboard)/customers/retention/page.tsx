import { Suspense } from "react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarRange, Repeat, Users } from "lucide-react";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { EmptyState, Money, SectionCard } from "@/components/ui-bits";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/session";
import { CRM_RULE, CRM_SEGMENT_ACTION, CRM_SEGMENT_LABEL, CRM_SEGMENT_TONE } from "@/lib/constants/crm";
import { formatDate, formatNumber } from "@/lib/format";
import { getRetentionCohorts, getRetentionReport } from "@/lib/queries/crm";
import { cn } from "@/lib/utils";

export const metadata = { title: "Giữ chân khách" };
export const dynamic = "force-dynamic";

function pctText(value: number | null) {
  return value === null ? "—" : `${value}%`;
}

export default async function RetentionPage() {
  await requirePermission("customers:view");
  const r = await getRetentionReport();
  const cov = r.coverage;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Vận hành"
        title="Giữ chân khách"
        description="Bao nhiêu khách quay lại, quay lại sau bao lâu, và nhóm nào đang nguội đi."
        hint={
          <>
            Khách mua lại ở đây đếm trên <b>đơn giao thành công</b>, không phải đơn đã đặt. Một khách đặt 5 đơn rồi hoàn cả 5 không phải khách trung thành — đó là khách đang gây lỗ. Ngưỡng đang dùng: còn hoạt động trong {CRM_RULE.activeDays} ngày, quá {CRM_RULE.churnedDays} ngày là đã rời bỏ, từ {CRM_RULE.loyalOrders} đơn đã nhận trở lên là trung thành.
          </>
        }
      />

      <section className="grid gap-4 sm:grid-cols-3">
        <MetricCard
          label="Khách đã nhận hàng"
          value={formatNumber(r.buyers)}
          note={`Mẫu số của mọi tỷ lệ trên trang · ${formatNumber(cov.deliveredWithCustomer)}/${formatNumber(cov.deliveredOrders)} đơn giao thành công có gán khách`}
          icon={Users}
          tone="blue"
        />
        <MetricCard
          label="Tỷ lệ mua lại THẬT"
          value={pctText(r.repeatRate)}
          note={`${formatNumber(r.repeatBuyers)} khách đã nhận hàng từ 2 lần trở lên`}
          hint="Tính trên đơn GIAO THÀNH CÔNG. Đây là con số dùng để quyết định có đáng chi tiền chăm sóc khách cũ hay không."
          icon={Repeat}
          tone="green"
        />
        <MetricCard
          label="Bao lâu thì quay lại"
          value={r.medianDaysToSecond === null ? "—" : `${formatNumber(r.medianDaysToSecond)} ngày`}
          note="Trung vị từ lần nhận hàng thứ nhất tới lần thứ hai · dùng để chọn thời điểm nhắn lại"
          icon={CalendarRange}
          tone="slate"
        />
      </section>

      <SectionCard
        title="Phân khúc khách"
        description="Theo số đơn ĐÃ NHẬN và khoảng cách tới lần nhận gần nhất"
        padded={false}
      >
        {r.buyers ? (
          <div className="overflow-x-auto">
            <Table className="min-w-[860px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Phân khúc</TableHead>
                  <TableHead className="text-right">Khách</TableHead>
                  <TableHead className="text-right">Tỷ trọng</TableHead>
                  <TableHead className="text-right">Doanh thu đã mang lại</TableHead>
                  <TableHead className="text-right">TB / khách</TableHead>
                  <TableHead>Nên làm gì</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.segments.map((s) => (
                  <TableRow key={s.segment}>
                    <TableCell>
                      <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-semibold", CRM_SEGMENT_TONE[s.segment])}>
                        {CRM_SEGMENT_LABEL[s.segment]}
                      </span>
                    </TableCell>
                    <TableCell className="numeric text-right font-medium">{formatNumber(s.customers)}</TableCell>
                    <TableCell className="numeric text-right">{pctText(s.share)}</TableCell>
                    <TableCell className="text-right"><Money value={s.revenue} /></TableCell>
                    <TableCell className="text-right">{s.avgValue === null ? "—" : <Money value={s.avgValue} />}</TableCell>
                    <TableCell className="max-w-[420px] text-xs text-muted-foreground">{CRM_SEGMENT_ACTION[s.segment]}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Chưa có khách nào nhận được hàng" description="Chưa có đơn nào vừa giao thành công vừa gán được khách, nên chưa phân khúc được." />
        )}
      </SectionCard>

      {/* COHORT tách sau ranh giới Suspense riêng: nó là phần nặng nhất và người dùng cuộn xuống
          mới thấy. Bốn thẻ số và bảng phân khúc hiện ngay, cohort điền vào sau. */}
      <Suspense fallback={<Skeleton className="h-64 rounded-xl" />}>
        <CohortCard />
      </Suspense>

      <SectionCard
        title="Khách nguy cơ rời bỏ"
        description="Từng mua đều nhưng đang chững lại — xếp theo tiền đã mang lại"
        hint="Danh sách này là ĐỀ XUẤT để người bấm, ERP không tự nhắn khách. Mở thẻ khách để xem lịch sử trước khi liên hệ."
        padded={false}
      >
        {r.atRisk.length ? (
          <div className="overflow-x-auto">
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Khách</TableHead>
                  <TableHead>Điện thoại</TableHead>
                  <TableHead className="text-right">Đơn đã nhận</TableHead>
                  <TableHead className="text-right">Đã mang lại</TableHead>
                  <TableHead>Lần cuối</TableHead>
                  <TableHead className="text-right">Đã nguội</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.atRisk.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">
                      <Link href={`/customers/${c.id}`} className="hover:text-primary hover:underline">
                        {c.name}
                      </Link>
                    </TableCell>
                    <TableCell className="numeric text-muted-foreground">{c.phone || "—"}</TableCell>
                    <TableCell className="numeric text-right">{formatNumber(c.orders)}</TableCell>
                    <TableCell className="text-right"><Money value={c.revenue} /></TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(c.lastOrderAt)}</TableCell>
                    <TableCell className="numeric text-right">{formatNumber(c.daysSince)} ngày</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Không có khách nào đang ở nhóm nguy cơ" description={`Chưa khách nào từng mua từ 2 lần mà im lặng quá ${CRM_RULE.activeDays} ngày.`} />
        )}
      </SectionCard>

      <SectionCard title="Đọc trước khi tin con số" description="Giới hạn của dữ liệu nền" padded={false}>
        <div className="px-5 py-3 text-xs leading-5 text-muted-foreground">
          <p className="font-medium text-foreground">
            Độ phủ gán khách: {pctText(cov.coveragePercent)} ({formatNumber(cov.deliveredWithCustomer)}/{formatNumber(cov.deliveredOrders)} đơn giao thành công) — đây là trần độ tin của cả trang.
          </p>
          <ul className="mt-1.5 space-y-0.5">
            {r.limitations.map((l, i) => (
              <li key={i}>• {l}</li>
            ))}
          </ul>
        </div>
      </SectionCard>
    </div>
  );
}

async function CohortCard() {
  const cohorts = await getRetentionCohorts();
  return (
      <SectionCard
        title="Cohort giữ chân"
        description={`Theo tháng khách nhận hàng lần đầu · ${CRM_RULE.cohortMonths} tháng gần nhất`}
        hint="Mỗi dòng là một nhóm khách nhận hàng lần đầu trong cùng tháng. Ô trống nghĩa là tháng đó CHƯA TỚI — không phải không ai quay lại."
        padded={false}
      >
        {cohorts.length ? (
          <div className="overflow-x-auto">
            <Table className="min-w-[720px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Tháng đầu mua</TableHead>
                  <TableHead className="text-right">Khách</TableHead>
                  {Array.from({ length: CRM_RULE.cohortMonths }, (_, i) => (
                    <TableHead key={i} className="text-right">
                      +{i + 1} tháng
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...cohorts].reverse().map((c) => (
                  <TableRow key={c.cohort}>
                    <TableCell className="font-medium">{c.cohort}</TableCell>
                    <TableCell className="numeric text-right">{formatNumber(c.size)}</TableCell>
                    {c.months.map((m, i) => (
                      <TableCell key={i} className="numeric text-right">
                        {m === null ? (
                          <span className="text-muted-foreground/50">·</span>
                        ) : c.size ? (
                          <span title={`${m}/${c.size} khách`}>{Math.round((m / c.size) * 1000) / 10}%</span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Chưa đủ dữ liệu để dựng cohort" description="Cần ít nhất một tháng có khách nhận hàng lần đầu." />
        )}
      </SectionCard>
  );
}

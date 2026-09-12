import Link from "next/link";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Lock } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ReviewPanel, ReviewToolbar } from "@/app/(dashboard)/work/review/panel";
import { can, requirePermission } from "@/lib/auth/session";
import { DEPARTMENT_LABEL, type DepartmentCode } from "@/lib/constants/departments";
import { formatDate, formatDateTime, formatVND } from "@/lib/format";
import { getReview, listReviews, REVIEW_KIND_LABEL, type ReviewKind } from "@/lib/queries/reviews";
import { StatStrip } from "@/components/stat-tile";
import { listDepartments } from "@/lib/queries/work";
import { param, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export const metadata = { title: "Kỳ review" };

/**
 * ═══════ KỲ REVIEW — VÀ CÁI KHOÁ ═══════
 *
 * Kỳ `DRAFT` tính sống mỗi lần mở. Kỳ `FINAL` đọc ẢNH CHỤP và không truy vấn lại gì.
 *
 * Đó không phải một tối ưu: AGENTS.md mục 8.9 cấm sửa ngầm kỳ đã chốt. Nếu báo cáo tháng 9 được
 * dựng bằng truy vấn của tháng 11 thì mỗi lần ai đó sửa một công thức, con số tháng 9 âm thầm đổi —
 * và cuộc họp tháng 10 đã diễn ra trên một con số không còn tồn tại.
 */

/**
 * ═══════ MŨI TÊN SO VỚI KỲ TRƯỚC ═══════
 *
 * Hướng TỐT phụ thuộc chỉ số: quá hạn giảm là tốt, việc đóng tăng là tốt. Nên hàm nhận `goodWhen`
 * thay vì tự đoán — đoán sai thì một cột đỏ rực trông như tin mừng.
 *
 * Không có kỳ trước thì KHÔNG vẽ mũi tên nào. Vẽ "0%" khi chưa có gì để so là bịa ra một sự ổn định.
 */
function Delta({ now, before, goodWhen }: { now: number; before: number | undefined; goodWhen: "LOWER" | "HIGHER" }) {
  if (before === undefined) return <span className="text-[11px] text-muted-foreground">chưa có kỳ trước để so</span>;
  const d = now - before;
  if (d === 0) return <span className="text-[11px] text-muted-foreground">không đổi so kỳ trước ({before})</span>;
  const tot = goodWhen === "LOWER" ? d < 0 : d > 0;
  const Icon = d > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-[11px] font-medium", tot ? "text-success" : "text-destructive")} title={`Kỳ trước: ${before}`}>
      <Icon className="size-3" />
      {d > 0 ? "+" : ""}
      {d} so kỳ trước
    </span>
  );
}

export default async function ReviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("performance:view");
  const raw = await searchParams;
  const id = param(raw, "id");
  const [reviews, departments] = await Promise.all([listReviews(), listDepartments()]);
  const current = id ? await getReview(id) : reviews.length ? await getReview(reviews[0].id) : null;
  const canManage = can(user, "review:manage");

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Công việc"
        title="Kỳ review"
        description="Tuần / tháng / quý — mục tiêu, thực tế, điểm nghẽn, việc tiếp theo."
        hint="Chốt kỳ là ĐÓNG BĂNG: sau khi chốt, mọi con số của kỳ đó đọc từ ảnh chụp và không tính lại. Sửa công thức tháng sau không làm đổi con số của kỳ đã chốt — nếu không thì biên bản họp tháng trước sẽ nói về những con số không còn tồn tại."
        actions={canManage ? <ReviewToolbar departments={departments.map((d) => ({ code: d.code, name: d.name }))} /> : null}
      />

      {reviews.length ? (
        <SectionCard title="Các kỳ đã mở" padded={false}>
          <div className="overflow-x-auto">
            <Table className="min-w-[620px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Kỳ</TableHead>
                  <TableHead className="w-[160px]">Phạm vi</TableHead>
                  <TableHead className="w-[190px]">Khoảng thời gian</TableHead>
                  <TableHead className="w-[130px] text-right">Trạng thái</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reviews.map((r) => (
                  <TableRow key={r.id} className={cn(current?.id === r.id && "bg-muted/50")}>
                    <TableCell>
                      <Link href={`/work/review?id=${r.id}`} className="font-medium hover:underline">
                        {REVIEW_KIND_LABEL[r.kind as ReviewKind]} · {r.period}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{r.departmentName ?? "Toàn shop"}</TableCell>
                    <TableCell className="text-sm tabular-nums text-muted-foreground">{formatDate(r.periodStart)} → {formatDate(r.periodEnd)}</TableCell>
                    <TableCell className="text-right">
                      {r.status === "FINAL" ? (
                        <Badge variant="secondary" className="gap-1 bg-emerald-50 text-[11px] text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                          <Lock className="size-3" /> đã chốt
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[11px]">nháp</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      ) : null}

      {current ? (
        <>
          {/*
            ═══════ BẢNG HỌP: MỘT MÀN HÌNH, CHÍN CÂU TRẢ LỜI ═══════

            Mục tiêu · thực tế · thay đổi so kỳ trước · nút thắt · quá hạn · tiền · việc nóng nhất
            kèm người cầm · hành động kỳ tới. Tất cả ở đây, theo đúng thứ tự người ta hỏi trong
            phòng họp — KHÔNG dựng thêm một dashboard nào khác, vì trang này đã là chỗ đúng.
          */}
          <StatStrip
            columns={4}
            items={[
              {
                label: "Việc đang mở",
                value: current.snapshot.totals.open,
                note: current.previous ? `kỳ trước ${current.previous.totals.open}` : "chưa có kỳ trước",
              },
              {
                label: "Quá hạn",
                value: current.snapshot.totals.overdue,
                tone: current.snapshot.totals.overdue ? "rose" : "muted",
                note: current.previous ? `kỳ trước ${current.previous.totals.overdue}` : "chưa có kỳ trước",
                hint: "Con số một mình không nói gì: 38 việc quá hạn là tin mừng nếu kỳ trước là 52, và là báo động nếu kỳ trước là 19.",
              },
              {
                label: "Bị chặn",
                value: current.snapshot.totals.blocked,
                tone: current.snapshot.totals.blocked ? "amber" : "muted",
                note: current.previous ? `kỳ trước ${current.previous.totals.blocked}` : "chưa có kỳ trước",
                hint: "Bị chặn ≠ đang chờ bên ngoài. Bị chặn là nút thắt NỘI BỘ — đúng thứ gỡ được ngay trong cuộc họp này.",
              },
              {
                label: "Tiền đang treo",
                value: current.snapshot.totals.moneyAtRisk ? formatVND(current.snapshot.totals.moneyAtRisk, { compact: true }) : "—",
                note: current.snapshot.totals.moneyUnknown ? `${current.snapshot.totals.moneyUnknown} việc chưa tra được tiền` : "đã tra được hết",
                hint: "Chỉ cộng việc TRA ĐƯỢC số tiền. Việc chưa tra được không bị coi là 0đ — số việc đó hiện ngay cạnh để bạn biết tổng này đứng trên bao nhiêu phần.",
              },
            ]}
          />

          <div className="grid gap-3 lg:grid-cols-2">
            <SectionCard title="Nút thắt của kỳ" description="Phòng đang chặn guồng, chọn theo TỶ LỆ quá hạn — không theo số việc nhiều nhất.">
              {current.snapshot.bottleneck ? (
                <div className="space-y-1">
                  <Link href={`/work/department?dept=${current.snapshot.bottleneck.department}`} className="text-sm font-semibold hover:underline">
                    {current.snapshot.bottleneck.label} <ArrowRight className="inline size-3.5" />
                  </Link>
                  <p className="text-sm text-muted-foreground">{current.snapshot.bottleneck.reason}</p>
                  <p className="text-xs text-muted-foreground">
                    <Delta now={current.snapshot.totals.overdue} before={current.previous?.totals.overdue} goodWhen="LOWER" /> · quá hạn toàn kỳ
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Không phòng nào đang quá hạn hay bị chặn. Cuộc họp này nói về mục tiêu, không về chữa cháy.</p>
              )}
            </SectionCard>

            <SectionCard
              title="Việc nóng nhất · ai đang cầm"
              description="Năm dòng, xếp theo điểm ưu tiên — một cuộc họp tuần không xử lý nổi hơn năm việc."
              padded={false}
            >
              {current.snapshot.topIssues.length ? (
                <ul className="divide-y">
                  {current.snapshot.topIssues.map((it) => (
                    <li key={it.key} className="flex items-start justify-between gap-2 px-3 py-2">
                      <div className="min-w-0">
                        <Link href={it.url || "/work/all"} className="block truncate text-sm hover:underline" title={it.title}>
                          {it.title}
                        </Link>
                        <p className="text-[11px] text-muted-foreground">
                          {DEPARTMENT_LABEL[it.department as DepartmentCode] ?? it.department} · {it.owner || "chưa ai nhận"}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        {it.overdue ? <Badge variant="secondary" className="bg-rose-100 text-[10px] text-rose-800 dark:bg-rose-950/60 dark:text-rose-300">quá hạn</Badge> : null}
                        {/* `null` = CHƯA TRA ĐƯỢC, không phải 0đ. */}
                        <p className="text-[11px] tabular-nums text-muted-foreground">{it.moneyAtRisk === null ? "chưa tra được" : formatVND(it.moneyAtRisk, { compact: true })}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-3 py-4 text-sm text-muted-foreground">
                  {current.frozen && current.snapshot.version < 2
                    ? "Ảnh chụp đời cũ không lưu danh sách này. Không dựng lại từ dữ liệu hôm nay — làm thế là sửa ngầm một kỳ đã chốt."
                    : "Không việc nào đang quá hạn, gấp hoặc bị chặn."}
                </p>
              )}
            </SectionCard>
          </div>

          <SectionCard
            title={`${REVIEW_KIND_LABEL[current.kind]} · ${current.period} · ${current.departmentName}`}
            description={
              current.frozen
                ? `Đã chốt ${current.finalizedAt ? formatDateTime(current.finalizedAt) : ""}${current.finalizedByName ? ` bởi ${current.finalizedByName}` : ""} — số liệu đọc từ ảnh chụp, không tính lại.`
                : "Nháp — số liệu tính sống mỗi lần mở. Chốt kỳ để đóng băng."
            }
            padded={false}
          >
            <div className="overflow-x-auto">
              <Table className="min-w-[720px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Phòng ban</TableHead>
                    <TableHead className="w-[110px] text-right">Việc mở</TableHead>
                    <TableHead className="w-[110px] text-right">Quá hạn</TableHead>
                    <TableHead className="w-[110px] text-right">Bị chặn</TableHead>
                    <TableHead className="w-[120px] text-right">Trong hạn</TableHead>
                    <TableHead className="w-[150px] text-right">Tiền treo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {current.snapshot.departments.map((d) => (
                    <TableRow key={d.department}>
                      <TableCell className="font-medium">{DEPARTMENT_LABEL[d.department as DepartmentCode] ?? d.label}</TableCell>
                      <TableCell className="text-right tabular-nums">{d.open}</TableCell>
                      <TableCell className={cn("text-right tabular-nums", d.overdue && "font-semibold text-destructive")}>{d.overdue}</TableCell>
                      <TableCell className="text-right tabular-nums">{d.blocked}</TableCell>
                      <TableCell className="text-right tabular-nums">{d.slaOnTime === null ? "—" : `${Math.round(d.slaOnTime * 100)}%`}</TableCell>
                      <TableCell className="text-right tabular-nums">{d.money.known ? formatVND(d.money.atRisk, { compact: true }) : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </SectionCard>

          {current.snapshot.objectives.length ? (
            <SectionCard title="Mục tiêu trong kỳ" padded={false}>
              <ul className="divide-y">
                {current.snapshot.objectives.map((o) => (
                  <li key={o.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="min-w-0 truncate text-sm">{o.title}</span>
                    <span className={cn("shrink-0 text-sm font-semibold tabular-nums", o.progress === null && "text-muted-foreground")}>
                      {o.progress === null ? "chưa đo được" : `${Math.round(o.progress)}%`}
                      <span className="ml-1 text-[11px] font-normal text-muted-foreground">{o.measuredCount}/{o.totalCount} KR</span>
                    </span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}

          {current.snapshot.failedSources.length ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              Ảnh chụp thiếu dữ liệu của: {current.snapshot.failedSources.join(" · ")}. Nêu ra ở đây thay vì để một con số thấp trông như sự thật.
            </p>
          ) : null}

          <ReviewPanel
            id={current.id}
            frozen={current.frozen}
            canManage={canManage}
            highlights={current.highlights}
            issues={current.issues}
            nextActions={current.nextActions}
          />
        </>
      ) : (
        <SectionCard>
          <EmptyState
            title="Chưa có kỳ review nào"
            description={canManage ? "Bấm “Mở kỳ review” để bắt đầu. Kỳ mới luôn là nháp; chốt khi họp xong." : "Quản lý chưa mở kỳ review nào."}
            className="border-0"
          />
        </SectionCard>
      )}
    </div>
  );
}

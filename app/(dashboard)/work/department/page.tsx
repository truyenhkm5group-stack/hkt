import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { WorkList } from "@/components/work/work-list";
import { PageHeader } from "@/components/page-header";
import { StatStrip } from "@/components/stat-tile";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can, requirePermission } from "@/lib/auth/session";
import { DEPARTMENT_LABEL, type DepartmentCode } from "@/lib/constants/departments";
import { formatVND } from "@/lib/format";
import { buildDepartmentQueue, CLOSED_WINDOW_DAYS, departmentsOfUser, getDepartmentCockpit, DEPT_HEALTH_LABEL, DEPT_HEALTH_TONE } from "@/lib/queries/work";
import { collectWorkItems } from "@/lib/queries/work-adapters";
import { param, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export const metadata = { title: "Công việc theo phòng ban" };

/**
 * ═══════ PHÒNG BAN — VÀ BUỒNG LÁI ĐIỀU HÀNH ═══════
 *
 * Một trang, hai vai, theo đúng quyền của người mở:
 *
 *  · `work:all` (chủ shop / quản lý) — thấy DẢI SỨC KHOẺ của cả bảy phòng trước, rồi mới tới hàng
 *    đợi của phòng đang chọn. Đây là câu trả lời cho "phòng nào đang kẹt", và nó KHÔNG phải một
 *    dashboard mới: nó dùng chính phép chiếu của hàng đợi.
 *  · `work:department` (trưởng phòng) — vào thẳng phòng của mình.
 *
 * Không nhồi bảng dài ở đầu trang: dải sức khoẻ là bảy ô bấm được, chi tiết nằm sau cú bấm.
 */
export default async function DepartmentWorkPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("work:department");
  const raw = await searchParams;
  const crossDept = can(user, "work:all");

  const mine = await departmentsOfUser(user.id);
  const fallback: DepartmentCode = mine[0]?.code ?? "MANAGEMENT";
  const selected = (param(raw, "dept", fallback) as DepartmentCode) ?? fallback;

  // Trưởng phòng chỉ mở được phòng mình — hàng đợi không được là cửa sau xem việc phòng khác.
  const allowed = crossDept || mine.some((d) => d.code === selected);
  const dept: DepartmentCode = allowed ? selected : fallback;

  const now = new Date();
  /*
    Cửa sổ 30 ngày việc ĐÃ ĐÓNG đi kèm toàn bộ việc đang mở: thước "xử lý nhanh chậm" và "đóng
    đúng hẹn không" không đọc được từ tập việc còn đang mở. Không dùng `includeClosed` — cái đó
    kéo cả lịch sử và làm trung vị nói về chuyện của năm ngoái.
  */
  const [{ items }, cockpit] = await Promise.all([
    collectWorkItems({ now, closedSince: new Date(now.getTime() - CLOSED_WINDOW_DAYS * 24 * 3_600_000) }),
    crossDept ? getDepartmentCockpit({ now }) : Promise.resolve(null),
  ]);
  const all = items.filter((i) => i.department === dept);
  const open = all.filter((i) => i.status !== "DONE" && i.status !== "CANCELLED");
  const queue = buildDepartmentQueue(dept, all, open, now);
  const canAct = can(user, "work:manage");

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Công việc"
        title={crossDept ? "Phòng nào đang kẹt?" : `Việc của ${DEPARTMENT_LABEL[dept]}`}
        description={crossDept ? "Sức khoẻ từng phòng, rồi bấm vào phòng để xem hàng đợi của phòng đó." : "Toàn bộ việc đang mở của phòng, kèm tải theo người."}
        hint="Sức khoẻ KHÔNG tính bằng số lượng việc: một phòng 200 việc đúng hạn đang chạy tốt, một phòng 12 việc mà 8 việc quá hạn thì đang kẹt. Thước đo là TỶ LỆ QUÁ HẠN (≥30% = kẹt, ≥10% = cần để mắt) và SỐ VIỆC BỊ CHẶN (≥5 = kẹt) — hai thứ nói được rằng công việc không chảy."
      />

      {cockpit ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {cockpit.rows.map((r) => (
            <Link
              key={r.department}
              href={`/work/department?dept=${r.department}`}
              className={cn("rounded-lg border p-3 transition-colors hover:bg-accent/50", r.department === dept && "border-primary ring-1 ring-primary/30")}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{r.label}</span>
                <Badge variant="secondary" className={cn("shrink-0 text-[11px]", DEPT_HEALTH_TONE[r.health])}>{DEPT_HEALTH_LABEL[r.health]}</Badge>
              </div>
              <p className="mt-1.5 text-lg font-semibold tabular-nums">
                {r.open}
                <span className="ml-1 text-xs font-normal text-muted-foreground">việc mở</span>
              </p>
              <p className="text-xs text-muted-foreground">
                {r.overdue ? <span className="font-medium text-destructive">{r.overdue} quá hạn</span> : "không việc nào quá hạn"}
                {r.blocked ? ` · ${r.blocked} bị chặn` : ""}
                {r.unassigned ? ` · ${r.unassigned} chưa ai nhận` : ""}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {/* `null` tiền = CHƯA TRA ĐƯỢC. Không in "0đ" cho một phòng chưa tra được đồng nào. */}
                {r.money.known ? formatVND(r.money.atRisk, { compact: true }) : "—"} treo
                {r.money.unknown ? ` · ${r.money.unknown} việc chưa tra được` : ""}
                {r.leadName ? ` · ${r.leadName}` : " · chưa có trưởng phòng"}
              </p>
            </Link>
          ))}
        </div>
      ) : null}

      <StatStrip
        columns={5}
        items={[
          { label: "Đang mở", value: queue.open },
          { label: "Quá hạn", value: queue.overdue, tone: queue.overdue ? "rose" : "muted" },
          { label: "Chưa ai nhận", value: queue.unassigned, tone: queue.unassigned ? "amber" : "muted", note: "việc đang trôi" },
          { label: "Bị chặn", value: queue.blocked, tone: queue.blocked ? "rose" : "muted", hint: "Bị chặn ≠ đang chờ. Bị chặn là thứ trưởng phòng GỠ ĐƯỢC: thiếu thông tin, chờ một quyết định nội bộ. Chờ khách / ĐVVC / ngân hàng nằm ở cột khác." },
          {
            label: "Trong hạn",
            value: queue.slaOnTime === null ? "—" : `${Math.round(queue.slaOnTime * 100)}%`,
            note: queue.slaOnTime === null ? "không việc nào có hạn" : "trên việc CÓ đặt hạn",
            hint: "Mẫu số chỉ gồm việc CÓ ĐẶT HẠN. Gộp cả việc không đặt hạn vào thì tỷ lệ này được thổi lên bằng chính những việc không ai đo.",
          },
        ]}
      />

      {/*
        BA CON SỐ VỀ VIỆC ĐÃ ĐÓNG, ĐỨNG RIÊNG KHỎI ẢNH CHỤP HIỆN TẠI.

        Dải trên nói phòng đang GÁNH gì; dải này nói phòng có XỬ LÝ ĐƯỢC hay không. Gộp chung thì
        một phòng tồn đọng ít vì không ai giao việc trông y hệt một phòng chạy tốt.
      */}
      <StatStrip
        columns={4}
        items={[
          {
            label: "Đã đóng",
            value: queue.closed.count,
            note: `trong ${queue.closed.windowDays} ngày`,
            hint: "Con số này KHÔNG phải thước năng suất và không dùng để xếp hạng ai. Nó là mẫu số của ba ô còn lại: ba ô kia nói lên điều gì phụ thuộc vào việc chúng đứng trên bao nhiêu ca.",
          },
          {
            label: "Thời gian xử lý",
            value: queue.closed.medianHours === null ? "—" : `${queue.closed.medianHours} giờ`,
            note: queue.closed.slowestHours === null ? "chưa đóng ca nào" : `chậm nhất ${queue.closed.slowestHours} giờ`,
            hint: "TRUNG VỊ, không phải trung bình: một ca để quên ba tuần sẽ kéo trung bình của cả tháng lên và che mất việc phòng xử lý phần lớn ca trong vài giờ. Ô “chậm nhất” đứng cạnh để cái đuôi đó không bị giấu.",
          },
          {
            label: "Đóng đúng hẹn",
            value: queue.closed.slaHitRate === null ? "—" : `${Math.round(queue.closed.slaHitRate * 100)}%`,
            tone: queue.closed.slaHitRate !== null && queue.closed.slaHitRate < 0.7 ? "rose" : "muted",
            note: queue.closed.slaSample ? `trên ${queue.closed.slaSample} ca có đặt hạn` : "chưa ca nào có hạn",
            hint: "Khác ô “Trong hạn” ở dải trên: ô kia nói việc ĐANG MỞ chưa vỡ hạn, ô này nói việc ĐÃ ĐÓNG có kịp hẹn không. Một phòng có thể 100% việc đang mở còn trong hạn mà vẫn thường xuyên đóng muộn.",
          },
          {
            label: "Tiền đã cứu được",
            value: queue.closed.moneyRecovered ? formatVND(queue.closed.moneyRecovered, { compact: true }) : "—",
            note: queue.closed.moneyRecoveredUnknown ? `${queue.closed.moneyRecoveredUnknown} ca chưa tra được` : "đã tra được hết",
            hint: "CHỈ cộng phần ĐO ĐƯỢC từ chứng từ. Ước tính không được trộn vào một con số mà chủ shop sẽ đọc như tiền thật — ca chưa tra được hiện ngay cạnh, không bị coi là 0đ.",
          },
        ]}
      />

      <SectionCard
        title="Tải theo người"
        description="Số việc đứng cạnh ĐỘ KHÓ trung bình — 10 ca khó không được đọc thấp hơn 100 ca tầm thường."
        padded={false}
      >
        {queue.workload.length ? (
          <div className="overflow-x-auto">
            <Table className="min-w-[640px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Người</TableHead>
                  <TableHead className="w-[90px] text-right">Đang cầm</TableHead>
                  <TableHead className="w-[90px] text-right">Quá hạn</TableHead>
                  <TableHead className="w-[90px] text-right">Chờ / chặn</TableHead>
                  <TableHead className="w-[110px] text-right">Độ khó TB</TableHead>
                  <TableHead className="w-[130px] text-right">Tiền đang giữ</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {queue.workload.map((w) => (
                  <TableRow key={w.assigneeKey}>
                    <TableCell className="font-medium">{w.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{w.open}</TableCell>
                    <TableCell className={cn("text-right tabular-nums", w.overdue && "font-semibold text-destructive")}>{w.overdue}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{w.waiting} / {w.blocked}</TableCell>
                    <TableCell className="text-right tabular-nums" title="Điểm ưu tiên trung bình của việc đang cầm (0–100)">{w.avgScore}</TableCell>
                    <TableCell className="text-right tabular-nums">{w.money.known ? formatVND(w.money.atRisk, { compact: true }) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Chưa ai trong phòng cầm việc nào" description="Việc chưa có người nằm trong danh sách bên dưới — bấm “Nhận việc” hoặc giao cho thành viên." className="border-0" />
        )}
      </SectionCard>

      <SectionCard
        title={`Hàng đợi ${DEPARTMENT_LABEL[dept]} · ${queue.open} việc`}
        description={queue.bySource.map((s) => `${s.label} ${s.count}${s.overdue ? ` (${s.overdue} quá hạn)` : ""}`).join(" · ") || undefined}
        actions={
          queue.completedRecent ? (
            <span className="text-xs text-muted-foreground">
              {queue.completedRecent} việc đã đóng trong 7 ngày <ArrowRight className="inline size-3" />
            </span>
          ) : null
        }
        padded={false}
      >
        <WorkList items={queue.items} emptyTitle="Phòng này không còn việc nào đang mở" canAct={canAct} />
      </SectionCard>
    </div>
  );
}

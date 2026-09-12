import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can, requirePermission } from "@/lib/auth/session";
import { DEPARTMENT_LABEL, type DepartmentCode } from "@/lib/constants/departments";
import { formatVND } from "@/lib/format";
import { departmentsOfUser } from "@/lib/queries/work";
import { getPerformance, type ScoreAxis } from "@/lib/queries/work-performance";
import { param, resolvePeriod, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export const metadata = { title: "Hiệu suất" };

/**
 * ═══════ HIỆU SUẤT — SÁU TRỤC, KHÔNG MỘT CON SỐ ═══════
 *
 * Bảng này CỐ Ý không có cột "điểm". Yêu cầu nghiệp vụ nói thẳng: không làm một con số điểm nhân
 * viên dựa trên số việc. Nên mỗi trục đứng riêng, và mỗi trục mang theo MẪU SỐ của nó — một tỷ lệ
 * 100% trên 2 quan sát không giống 100% trên 200 quan sát, và người đọc phải thấy được điều đó.
 *
 * Cột "Năng suất" không bao giờ đứng một mình: nó luôn kèm độ khó trung bình. Mười ca khó không
 * được đọc thấp hơn một trăm ca tầm thường.
 */
function AxisCell({ axis, suffix = "%" }: { axis: ScoreAxis; suffix?: string }) {
  if (axis.value === null) {
    return (
      <span className="text-xs text-muted-foreground" title={axis.note || "Chưa có quan sát nào trong kỳ"}>
        chưa đo được
      </span>
    );
  }
  return (
    <span className="whitespace-nowrap tabular-nums" title={axis.note}>
      <span className={cn("font-medium", axis.value >= 90 ? "text-success" : axis.value < 60 ? "text-destructive" : "")}>
        {axis.value}
        {suffix}
      </span>
      <span className="ml-1 text-[11px] text-muted-foreground">/{axis.sample}</span>
    </span>
  );
}

export default async function PerformancePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("performance:view");
  const raw = await searchParams;
  const period = resolvePeriod(raw, "30d");
  const mine = await departmentsOfUser(user.id);

  // Không có `work:all` thì chỉ xem được phòng của mình — thẻ điểm nhân sự là dữ liệu nhạy cảm.
  const crossDept = can(user, "work:all");
  const requested = param(raw, "dept") as DepartmentCode | "";
  const department: DepartmentCode | null = crossDept ? (requested || null) : (mine.find((d) => d.code === requested)?.code ?? mine[0]?.code ?? null);

  const from = period.from ?? new Date(Date.now() - 30 * 24 * 3_600_000);
  const to = period.to ?? new Date();
  const rows = await getPerformance({ from, to, department });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Công việc"
        title="Hiệu suất"
        description={`${period.label} · ${department ? DEPARTMENT_LABEL[department] : "toàn shop"} · ${rows.length} người`}
        hint="KHÔNG có cột điểm tổng. Sáu trục đứng riêng vì chúng nói về sáu thứ khác nhau, và chỉ gộp lại được khi chủ shop tự khai trọng số. Mỗi ô kèm MẪU SỐ (/n) — 100% trên 2 quan sát không giống 100% trên 200. Trục Kết quả chỉ tính việc mà kết quả nằm trong tầm kiểm soát của người xử lý: ĐVVC giao hỏng không phải lỗi CSKH."
      />

      <SectionCard padded={false}>
        {rows.length ? (
          <div className="overflow-x-auto">
            <Table className="min-w-[900px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Người</TableHead>
                  <TableHead className="w-[110px]">Kết quả</TableHead>
                  <TableHead className="w-[110px]">Chất lượng</TableHead>
                  <TableHead className="w-[110px]">Đúng hạn</TableHead>
                  <TableHead className="w-[170px]">Năng suất</TableHead>
                  <TableHead className="w-[110px]">OKR</TableHead>
                  <TableHead className="w-[150px] text-right">Đang cầm</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.key}>
                    <TableCell>
                      <p className="font-medium">{r.name}</p>
                      <p className="text-[11px] text-muted-foreground">{r.departments.map((d) => DEPARTMENT_LABEL[d]).join(", ") || "chưa xếp phòng"}</p>
                    </TableCell>
                    <TableCell><AxisCell axis={r.outcome} /></TableCell>
                    <TableCell><AxisCell axis={r.quality} /></TableCell>
                    <TableCell><AxisCell axis={r.sla} /></TableCell>
                    <TableCell>
                      <span className="tabular-nums">{r.productivity.closed} việc</span>
                      {/* ĐỘ KHÓ LUÔN ĐI CÙNG SỐ LƯỢNG — xem chú thích đầu tệp. */}
                      <span className="block text-[11px] text-muted-foreground">
                        {r.productivity.avgDifficulty === null ? "chưa đo được độ khó" : `độ khó TB ${r.productivity.avgDifficulty}`}
                        {r.productivity.avgMoney !== null ? ` · ${formatVND(r.productivity.avgMoney, { compact: true })}/việc` : ""}
                      </span>
                    </TableCell>
                    <TableCell><AxisCell axis={r.okr} /></TableCell>
                    <TableCell className="text-right">
                      <span className="tabular-nums">{r.openNow}</span>
                      {r.overdueNow ? <Badge variant="secondary" className="ml-1.5 bg-rose-100 text-[11px] text-rose-800 dark:bg-rose-950/60 dark:text-rose-300">{r.overdueNow} quá hạn</Badge> : null}
                      {r.blockedNow ? <Badge variant="outline" className="ml-1 text-[11px]">{r.blockedNow} chặn</Badge> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState
            title="Chưa có đủ dữ liệu để nói về hiệu suất"
            description="Thẻ điểm đọc từ nhật ký công việc (ai đóng việc nào, lúc nào). Kỳ này chưa có ai đóng việc qua hàng đợi và không ai đang cầm việc nào."
            className="border-0"
          />
        )}
      </SectionCard>

      <SectionCard title="Cách đọc bảng này" >
        <ul className="space-y-1.5 text-sm text-muted-foreground">
          <li><strong className="text-foreground">Kết quả</strong> — phần việc đã đóng mà kết quả THUỘC TRÁCH NHIỆM người xử lý. Care vận đơn không tính vào đây: bưu tá giao được hay không là chuyện của ĐVVC.</li>
          <li><strong className="text-foreground">Chất lượng</strong> — phần việc đóng rồi KHÔNG phải mở lại.</li>
          <li><strong className="text-foreground">Đúng hạn</strong> — chỉ tính việc CÓ ĐẶT HẠN. Việc không đặt hạn rơi khỏi cả tử lẫn mẫu.</li>
          <li><strong className="text-foreground">Năng suất</strong> — số việc đã đóng, LUÔN đọc cùng độ khó trung bình. Số lượng một mình không phải năng suất.</li>
          <li><strong className="text-foreground">OKR</strong> — tiến độ Key Result cá nhân, chỉ tính KR đo được.</li>
          <li><strong className="text-foreground">&ldquo;chưa đo được&rdquo;</strong> — chưa có quan sát nào, KHÔNG phải điểm 0.</li>
        </ul>
      </SectionCard>
    </div>
  );
}

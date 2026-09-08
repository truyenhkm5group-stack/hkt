import { AlertTriangle, Filter, TrendingDown, Users } from "lucide-react";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { Money, SectionCard } from "@/components/ui-bits";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/session";
import { ATTRIBUTION_FIELDS, LOW_COVERAGE_PCT, UNASSIGNED_LABEL, type AttributionField } from "@/lib/constants/sales-funnel";
import { formatNumber, formatPercent } from "@/lib/format";
import { getAttributionCoverage, getFunnelBySource, getSalesFunnel } from "@/lib/queries/sales-funnel";
import { getStaffPerformance } from "@/lib/queries/staff-performance";
import { parseListParams, type SearchParams } from "@/lib/search-params";
import { RoleTabs } from "@/app/(dashboard)/reports/funnel/role-tabs";
import { cn } from "@/lib/utils";

export const metadata = { title: "Phễu bán hàng" };

/** Tỷ lệ dạng chữ; `null` = chưa có mẫu số, hiện "—" chứ KHÔNG hiện 0%. */
function pct(value: number | null) {
  return value === null ? "—" : formatPercent(value * 100);
}

export default async function FunnelPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission("reports:returns");
  const raw = await searchParams;
  const params = parseListParams(raw, { defaultSort: "insertedAt", sortable: [], defaultPeriod: "30d" });
  const roleParam = typeof raw.role === "string" ? raw.role : "";
  const role: AttributionField = (ATTRIBUTION_FIELDS.find((f) => f.field === roleParam)?.field ?? "sellerName") as AttributionField;

  const [funnel, coverage, bySource, staff] = await Promise.all([
    getSalesFunnel(params.period),
    getAttributionCoverage(params.period),
    getFunnelBySource(params.period),
    getStaffPerformance(params.period, role),
  ]);

  const created = funnel.stages[0].count;
  const delivered = funnel.stages.find((s) => s.key === "delivered")?.count ?? 0;
  const roleMeta = ATTRIBUTION_FIELDS.find((f) => f.field === role);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Báo cáo"
        title="Phễu bán hàng & hiệu suất nhân sự"
        description="Từ đơn được tạo tới tiền thật đã bán được, và ai làm ra phần nào."
        hint="Phễu tính theo NGÀY TẠO ĐƠN, không theo ngày xảy ra từng bước — nếu mỗi bước đếm theo ngày riêng thì bước sau có thể lớn hơn bước trước và cái hình vẽ ra không còn là cái phễu. Đơn còn đang chạy được đếm riêng, KHÔNG tính là thất bại. Hai bước 'đã liên hệ' và 'đủ điều kiện' không có trong ERP vì không có nguồn dữ liệu nào — xem docs/sales-funnel-contract.md."
      />

      <DataTableToolbar period={{ defaultKey: "30d" }} />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Đơn được tạo" value={formatNumber(created)} note="Toàn bộ đơn phát sinh trong kỳ" icon={Users} tone="slate" />
        <MetricCard label="Giao thành công" value={formatNumber(delivered)} note={`${pct(created > 0 ? delivered / created : null)} số đơn đã tạo`} icon={TrendingDown} tone={delivered > 0 ? "green" : "slate"} />
        <MetricCard
          label="Còn đang chạy"
          value={formatNumber(funnel.unfinished)}
          note="Chưa biết kết quả — KHÔNG tính là thất bại"
          icon={Filter}
          tone={funnel.unfinished ? "amber" : "slate"}
        />
        <MetricCard label="Đơn huỷ" value={formatNumber(funnel.cancelled)} note="Rời phễu, không phải thất bại giao vận" icon={AlertTriangle} tone={funnel.cancelled ? "rose" : "slate"} />
      </section>

      {/* ───────── PHỄU ───────── */}
      <SectionCard
        title="Năm bước đo được"
        description="Mỗi bước kèm tỷ lệ so với bước liền trước và mẫu số của nó."
        hint="Bước 'đã rời kho' dùng mốc lấy hàng của Viettel Post chứ không dùng trạng thái Pancake: Pancake nói 'đã gửi' khi người bán bấm nút, còn hàng rời kho là một sự kiện của đơn vị vận chuyển. Bước 'giao thành công' dùng lại đúng công thức kết quả đơn của toàn ERP."
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bước</TableHead>
                <TableHead className="text-right">Số lượng</TableHead>
                <TableHead className="text-right">So với bước trước</TableHead>
                <TableHead>Mẫu số</TableHead>
                <TableHead className="text-right">So với bước đầu</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {funnel.stages.map((s) => (
                <TableRow key={s.key}>
                  <TableCell className="font-medium">{s.label}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(s.count)}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.key === "created" ? "—" : pct(s.ofPrevious)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{s.key === "created" ? "—" : s.previousLabel}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.key === "created" ? "—" : pct(s.ofStart)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      {/* ───────── THEO KÊNH ───────── */}
      <SectionCard
        title="Chuyển đổi theo kênh đặt hàng"
        description="Tỷ lệ giao thành công của từng kênh, mẫu số là đơn ĐÃ RỜI KHO."
        hint="Kênh nào cũng không chịu trách nhiệm cho đơn chưa từng gửi đi, nên mẫu số là đơn đã rời kho chứ không phải tổng đơn. Gộp chung các kênh thành một con số trung bình sẽ không mô tả đúng kênh nào cả."
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kênh</TableHead>
                <TableHead className="text-right">Đơn tạo</TableHead>
                <TableHead className="text-right">Xác nhận</TableHead>
                <TableHead className="text-right">Rời kho</TableHead>
                <TableHead className="text-right">Giao thành công</TableHead>
                <TableHead className="text-right">Tỷ lệ giao</TableHead>
                <TableHead className="text-right">Doanh thu giao TC</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bySource.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                    Chưa có đơn nào trong kỳ.
                  </TableCell>
                </TableRow>
              ) : (
                bySource.map((r) => (
                  <TableRow key={r.source}>
                    <TableCell className="font-medium">{r.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(r.created)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(r.confirmed)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(r.shipped)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(r.delivered)}</TableCell>
                    <TableCell className="text-right tabular-nums">{pct(r.deliveryRate)}</TableCell>
                    <TableCell className="text-right"><Money value={r.deliveredRevenue} /></TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      {/* ───────── HIỆU SUẤT NHÂN SỰ ───────── */}
      <SectionCard
        title={`Hiệu suất theo ${roleMeta?.label.toLowerCase() ?? "người phụ trách"}`}
        description={`Độ phủ gán người ${formatPercent(staff.coverage * 100)}${staff.lowCoverage ? ` — DƯỚI ${LOW_COVERAGE_PCT}%, mọi so sánh dưới đây chỉ nói về phần đơn có gán` : ""}`}
        hint="Xếp theo DOANH THU GIAO THÀNH CÔNG, không theo số đơn: người lên 100 đơn mà hoàn 70 kém hơn người lên 50 đơn giao trót lọt cả 50. Tỷ lệ tính trên đơn ĐÃ KẾT THÚC, nên người vừa nhận đơn hôm qua không bị tính là đã thất bại. Đơn không gán được cho ai nằm ở dòng 'Chưa gán' cuối bảng, KHÔNG bị chia đều cho nhân viên."
        actions={<RoleTabs current={role} />}
        padded={false}
      >
        {staff.lowCoverage ? (
          <p className="border-b bg-amber-50 px-5 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            Chỉ {formatPercent(staff.coverage * 100)} số đơn trong kỳ có gán {roleMeta?.label.toLowerCase()}. Bảng dưới mô tả đúng phần đó, không mô tả toàn shop.
          </p>
        ) : null}
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{roleMeta?.label ?? "Người"}</TableHead>
                <TableHead className="text-right">Đơn</TableHead>
                <TableHead className="text-right">Giao TC</TableHead>
                <TableHead className="text-right">Hoàn</TableHead>
                <TableHead className="text-right">Đang chạy</TableHead>
                <TableHead className="text-right">Tỷ lệ giao TC</TableHead>
                <TableHead className="text-right">Doanh thu giao TC</TableHead>
                <TableHead className="text-right">TB / đơn</TableHead>
                <TableHead className="text-right">Đóng góp</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {staff.rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">
                    Chưa có đơn nào trong kỳ.
                  </TableCell>
                </TableRow>
              ) : (
                staff.rows.map((r) => (
                  <TableRow key={r.name} className={cn(r.unassigned && "text-muted-foreground")}>
                    <TableCell className="font-medium">
                      {r.name}
                      {r.unassigned ? <span className="ml-1 text-xs">· không gán được, không chia đều</span> : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(r.orders)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(r.delivered)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(r.returned)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(r.unfinished)}</TableCell>
                    <TableCell className="text-right tabular-nums">{pct(r.gtc)}</TableCell>
                    <TableCell className="text-right"><Money value={r.deliveredRevenue} /></TableCell>
                    <TableCell className="text-right">{r.aov === null ? "—" : <Money value={Math.round(r.aov)} />}</TableCell>
                    <TableCell className="text-right">{r.contribution === null ? <span title="Chưa đủ dữ liệu giá vốn — không coi thiếu là 0">—</span> : <Money value={r.contribution} />}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        {staff.cogsCoverage < 1 ? (
          <p className="border-t px-5 py-2 text-xs text-muted-foreground">
            Chỉ {formatPercent(staff.cogsCoverage * 100)} đơn giao thành công tra được giá vốn — cột Đóng góp để trống ở nơi chưa biết, không điền 0.
          </p>
        ) : null}
      </SectionCard>

      {/* ───────── ĐỘ PHỦ GÁN NGƯỜI ───────── */}
      <SectionCard
        title="Độ phủ gán người"
        description="Bao nhiêu phần trăm đơn trong kỳ có ghi từng vai."
        hint="Năm vai KHÔNG thay thế được cho nhau. Chỉ 'người đổi trạng thái' có kèm mốc thời gian, nên chỉ nó trả lời được 'ai xác nhận đơn, lúc nào'. Không có độ phủ thì người xử lý 10 trên 100 đơn trông y hệt người xử lý 10 trên 1.000 đơn."
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vai</TableHead>
                <TableHead>Dùng cho</TableHead>
                <TableHead className="text-right">Đơn có gán</TableHead>
                <TableHead className="text-right">Độ phủ</TableHead>
                <TableHead className="text-right">Số người</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {coverage.map((c) => (
                <TableRow key={c.field}>
                  <TableCell className="font-medium">{c.label}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{ATTRIBUTION_FIELDS.find((f) => f.field === c.field)?.note}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(c.filled)} / {formatNumber(c.total)}</TableCell>
                  <TableCell className={cn("text-right tabular-nums", c.lowCoverage && "font-semibold text-amber-600 dark:text-amber-400")}>{formatPercent(c.coverage * 100)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(c.distinct)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="border-t px-5 py-2 text-xs text-muted-foreground">
          Đơn không gán được luôn hiện thành dòng &ldquo;{UNASSIGNED_LABEL}&rdquo;, không bao giờ chia đều cho nhân viên: chia đều làm tổng khớp trong khi từng người đều sai.
        </p>
      </SectionCard>
    </div>
  );
}

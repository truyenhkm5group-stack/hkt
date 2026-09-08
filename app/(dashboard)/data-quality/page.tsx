import { InfoHint } from "@/components/info-hint";
import {
  AlertTriangle,
  Coins,
  Boxes,
  CircleHelp,
  Link2Off,
  PackageCheck,
  Percent,
  ShoppingBag,
  Truck,
  Undo2,
} from "lucide-react";
import Link from "next/link";
import { ReceiveReturns } from "@/app/(dashboard)/data-quality/receive-returns";
import { pendingReturnedForWarehouse } from "@/lib/returns/warehouse";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { MetricCard } from "@/components/metric-card";
import { OrderOutcomeBadge, VerifiedOutcomeBadge } from "@/components/status-badge";
import { PageHeader } from "@/components/page-header";
import { EmptyState, Money, SectionCard } from "@/components/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/session";
import { DQ_ISSUE_HINT, DQ_ISSUE_LABEL, DQ_ISSUES, type DqIssue } from "@/lib/constants/data-quality";
import { successTone, type OrderOutcome } from "@/lib/constants/returns";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { dataQualityOrders, dataQualitySummary, returnsAwaitingWarehouse, unlinkedShipments } from "@/lib/queries/data-quality";
import { controlTowerDrill, getControlTower } from "@/lib/queries/control-tower";
import { RECONCILIATION_RULES, RECONCILIATION_RULE_ORDER, SEVERITY_LABEL, SEVERITY_TONE, type ReconciliationRuleKey } from "@/lib/constants/reconciliation";
import { param, parseListParams, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export const metadata = { title: "Chất lượng dữ liệu" };

const PAGE_SIZE = 50;

/** Hiển thị số chưa xác minh: KHÔNG bao giờ đổi UNKNOWN thành 0. */
function Unknown({ children }: { children?: React.ReactNode }) {
  return <span className="text-muted-foreground">{children ?? "Chưa xác minh"}</span>;
}

function Rate({ value }: { value: number | null }) {
  if (value === null) return <Unknown>—</Unknown>;
  return <span className={successTone(value)}>{value}%</span>;
}



export default async function DataQualityPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission("dashboard:view");
  const raw = await searchParams;
  const params = parseListParams(raw, { defaultPeriod: "90d", defaultPageSize: PAGE_SIZE, sortable: ["updatedAt", "codAmount", "codCollected", "stage", "vtpOrderNumber"], defaultSort: "updatedAt", defaultDir: "desc" });
  const issue = (DQ_ISSUES as readonly string[]).includes(param(raw, "issue")) ? (param(raw, "issue") as DqIssue) : null;
  const page = Math.max(1, Number(param(raw, "page", "1")) || 1);

  const summary = await dataQualitySummary(params.period);
  const tower = await getControlTower();
  // Luật của trung tâm điều khiển mở danh sách riêng, không dùng chung với 7 nhóm legacy.
  const ruleParam = param(raw, "rule");
  const towerRule = (RECONCILIATION_RULE_ORDER as readonly string[]).includes(ruleParam) ? (ruleParam as ReconciliationRuleKey) : null;
  const towerDrill = towerRule ? await controlTowerDrill(towerRule, page, PAGE_SIZE) : null;

  // Chỉ tải danh sách của nhóm vấn đề đang mở (drill-down).
  const drill = issue === "unlinked-shipment"
    ? { kind: "shipment" as const, ...(await unlinkedShipments(page, PAGE_SIZE, params.q, params.sort, params.dir)) }
    : issue === "return-not-received"
      ? { kind: "shipment" as const, ...(await returnsAwaitingWarehouse(page, PAGE_SIZE, params.q)) }
      : issue
        ? { kind: "order" as const, ...(await dataQualityOrders(issue, params.period, page, PAGE_SIZE, params.q)) }
        : null;

  // Tồn đọng hàng hoàn chờ kho — tính trên TOÀN BỘ, không phải trang đang xem, để biết còn bao nhiêu.
  const backlog = issue === "return-not-received" ? await pendingReturnedForWarehouse() : null;
  const warehouseBacklog = backlog
    ? { count: backlog.count, items: backlog.items, waitingDays: backlog.oldestAt ? Math.floor((Date.now() - new Date(backlog.oldestAt).getTime()) / 86_400_000) : null }
    : undefined;

  const drillHref = (key: DqIssue) => `/data-quality?issue=${key}&period=${params.period.key}`;
  const rule = summary.rule;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Data Truth"
        title="Chất lượng dữ liệu"
        description="Phát hiện chênh lệch giữa đơn hàng, vận đơn và tiền đã ghi nhận."
        hint="Phát hiện chênh lệch trong dữ liệu đơn hàng, vận đơn và tiền đã ghi nhận. Các phép đối chiếu dưới đây vẫn dựa trên dữ liệu legacy."
      />
      <div role="note" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
        Các số đối chiếu vẫn có COD khai báo/fallback và prepaid chưa kiểm chứng chứng từ. Chúng chưa phải tiền thực thu đã xác minh và chưa đủ để chốt doanh thu, lương hoặc đối soát ngân hàng. Cần đối chiếu bảng kê COD, chứng từ thanh toán và chiều giao/hoàn.
      </div>

      <DataTableToolbar period={{ defaultKey: "90d" }} searchPlaceholder={issue ? "Tìm mã đơn, mã vận đơn, tên, SĐT…" : undefined} resultLabel={`Kỳ: ${params.period.label}`} />

      {/* ───────── KPI vận hành theo quy tắc thực tế ───────── */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Tổng đơn (không tính huỷ)" value={formatNumber(summary.total)} icon={ShoppingBag} tone="primary" note={`${formatNumber(summary.cancelled)} đơn huỷ không tính`} />
        <MetricCard label="Giao thành công — đối chiếu tạm" value={formatNumber(summary.delivered)} icon={PackageCheck} tone="amber" note="Chưa xác minh theo chứng từ" />
        <MetricCard label="Đơn hoàn — đối chiếu tạm" value={formatNumber(summary.returned)} icon={Undo2} tone="rose" note="Không đồng nghĩa kho đã nhận hàng" />
        <MetricCard label="Đơn đang giao" value={formatNumber(summary.inTransit)} icon={Truck} tone="blue" note="Chưa kết luận được kết quả" />
        <MetricCard
          label="Đơn chưa đủ dữ liệu xác minh"
          value={formatNumber(summary.unverified)}
          icon={CircleHelp}
          tone="amber"
          note={<Link className="underline underline-offset-2" href={drillHref("unverified")}>Xem danh sách →</Link>}
        />
        <MetricCard label="Tỷ lệ giao — đối chiếu tạm" value={<Rate value={summary.successRate} />} icon={Percent} tone="amber" note="Chưa phải tỷ lệ đã xác minh" />
        <MetricCard label="Tiền legacy — ước tính" value={<Money value={summary.provenCash} />} icon={CircleHelp} tone="amber" note="Có COD fallback và trả trước chưa kiểm chứng" />
        <MetricCard
          label="Giá trị COD chưa xác minh"
          value={summary.unverified ? <Money value={summary.unverifiedCod} /> : <Unknown>—</Unknown>}
          icon={AlertTriangle}
          tone="amber"
          note="COD khai báo của đơn chưa chứng minh được"
        />
      </div>

      {/* ───────── Trung tâm điều khiển: toàn bộ bộ luật đối soát ───────── */}
      <SectionCard
        title="Trung tâm điều khiển"
        description={`${formatNumber(tower.firing)}/${formatNumber(tower.ruleCount)} luật đang có vi phạm · ${formatNumber(tower.totals.ERROR)} nghiêm trọng · ${formatNumber(tower.totals.WARNING)} cảnh báo`}
        hint="Mỗi dòng là một luật đối soát: mức nghiêm trọng, nghĩa thật, bằng chứng cụ thể và việc nên làm. ERP CHỈ tự sửa những luật ghi 'tự sửa được' — lệch giữa tiền và giao hàng thì không bao giờ tự sửa, vì máy không biết bên nào đúng."
      >
        {tower.issues.length === 0 ? (
          <EmptyState title="Không có vi phạm nào" description="Toàn bộ bộ luật đối soát đang sạch." />
        ) : (
          <div className="flex flex-col gap-2">
            {tower.issues.map((i) => (
              <div key={i.rule} className={cn("rounded-xl border p-3", towerRule === i.rule && "border-primary bg-accent/40")}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                      <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold", SEVERITY_TONE[i.severity])}>{SEVERITY_LABEL[i.severity]}</span>
                      {i.label}
                      {i.autoRepairable ? <Badge variant="outline" className="text-[10px]">ERP tự sửa được</Badge> : <Badge variant="outline" className="text-[10px]">Chỉ báo cáo</Badge>}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">{i.reason}</p>
                    <p className="mt-1 text-xs"><span className="text-muted-foreground">Nên làm: </span>{i.suggestedAction}</p>
                    <ul className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
                      {i.sample.map((row) => (
                        <li key={`${i.rule}-${row.code}`} className="truncate">
                          <span className="font-mono">{row.code}</span> — {row.evidence}
                          {row.at ? ` · ${formatDateTime(row.at)}` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <p className="numeric text-2xl font-bold">{formatNumber(i.count)}</p>
                    <Button asChild variant="outline" size="sm">
                      <Link href={towerRule === i.rule ? `/data-quality?period=${params.period.key}` : `/data-quality?rule=${i.rule}&period=${params.period.key}`}>
                        {towerRule === i.rule ? "Đóng" : "Xem danh sách"}
                      </Link>
                    </Button>
                    {i.href ? <Link className="text-[11px] text-primary underline underline-offset-2" href={i.href}>Mở trang xử lý →</Link> : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* ───────── Danh sách đầy đủ của một luật ───────── */}
      {towerRule && towerDrill ? (
        <SectionCard
          title={RECONCILIATION_RULES[towerRule].label}
          description={`${formatNumber(towerDrill.total)} bản ghi · trang ${page}/${towerDrill.pageCount}`}
          hint={RECONCILIATION_RULES[towerRule].reason}
          actions={<Button asChild variant="outline" size="sm"><Link href={`/data-quality?period=${params.period.key}`}>Đóng danh sách</Link></Button>}
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mã</TableHead>
                  <TableHead>Bằng chứng</TableHead>
                  <TableHead>Thời điểm</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {towerDrill.rows.map((r) => (
                  <TableRow key={`${towerRule}-${r.code}-${r.entityId ?? ""}`}>
                    <TableCell className="font-mono text-xs">{r.code}</TableCell>
                    <TableCell className="text-xs">{r.evidence}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{r.at ? formatDateTime(r.at) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {towerDrill.pageCount > 1 ? (
            <div className="mt-3 flex gap-2">
              {page > 1 ? <Button asChild variant="outline" size="sm"><Link href={`/data-quality?rule=${towerRule}&page=${page - 1}&period=${params.period.key}`}>← Trang trước</Link></Button> : null}
              {page < towerDrill.pageCount ? <Button asChild variant="outline" size="sm"><Link href={`/data-quality?rule=${towerRule}&page=${page + 1}&period=${params.period.key}`}>Trang sau →</Link></Button> : null}
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      {/* ───────── Vấn đề dữ liệu, mỗi ô bấm vào xem danh sách ───────── */}
      <SectionCard title="Vấn đề dữ liệu cần xử lý" description="Bấm vào từng nhóm để xem danh sách đơn / vận đơn liên quan.">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {([
            ["unlinked-shipment", summary.unlinkedShipments, Link2Off, `${formatNumber(summary.unlinkedOpen)} vận đơn chưa kết thúc · COD khai báo ${formatVND(summary.unlinkedCod)}`],
            ["status-conflict", summary.statusConflict, AlertTriangle, "Pancake và Viettel Post nói khác nhau"],
            ["pancake-declared", summary.pancakeDeclared, ShoppingBag, "Pancake báo giao nhưng không có tiền"],
            ["vtp-low-cash", summary.vtpLowCash, Truck, `Số tiền legacy < ${formatVND(rule.maxCodForReturn)}`],
            ["return-not-received", summary.returnRiskShipments, Boxes, `${formatNumber(summary.returnRiskUnits)} sản phẩm chưa xác nhận về kho`],
            ["missing-cogs", summary.missingCogs, Coins, `Doanh thu ${formatVND(summary.missingCogsRevenue)} đang tính lãi mà không trừ vốn`],
            ["unverified", summary.unverified, CircleHelp, "Không có số tiền nào để kết luận"],
          ] as const).map(([key, value, Icon, note]) => (
            <Link key={key} href={drillHref(key)} className={cn("rounded-xl border p-4 transition hover:border-primary hover:bg-accent/40", issue === key && "border-primary bg-accent/40")}>
              <div className="flex items-start justify-between gap-3">
                <p className="flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground">
                  {DQ_ISSUE_LABEL[key]}
                  <InfoHint>{DQ_ISSUE_HINT[key]}</InfoHint>
                </p>
                <Icon className="size-[18px] shrink-0 text-muted-foreground" />
              </div>
              <p className="numeric mt-2 text-2xl font-bold">{formatNumber(value)}</p>
              <p className="mt-1 text-xs text-muted-foreground">{note}</p>
            </Link>
          ))}
        </div>
      </SectionCard>

      {/* ───────── Ảnh hưởng đến quyết định ───────── */}
      <SectionCard
        title="Ảnh hưởng đến quyết định"
        description="So sánh hai cách phân loại dữ liệu legacy để tìm vấn đề."
        hint="So sánh hai cách phân loại dữ liệu legacy để tìm vấn đề. Chênh lệch này chưa phải số điều chỉnh kế toán đã xác minh."
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Chỉ số</TableHead>
                <TableHead className="text-right">ERP đang hiển thị</TableHead>
                <TableHead className="text-right">Đối chiếu tạm</TableHead>
                <TableHead className="text-right">Chênh lệch</TableHead>
                <TableHead>Xem chi tiết</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>Doanh thu đơn giao thành công</TableCell>
                <TableCell className="numeric text-right">{formatVND(summary.legacyRevenue)}</TableCell>
                <TableCell className="numeric text-right">{formatVND(summary.verifiedRevenue)}</TableCell>
                <TableCell className="numeric text-right text-destructive">{formatVND(summary.verifiedRevenue - summary.legacyRevenue, { sign: true })}</TableCell>
                <TableCell><Link className="text-primary underline underline-offset-2" href={drillHref("unverified")}>Đơn chưa xác minh</Link></TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Tiền theo legacy (ước tính)</TableCell>
                <TableCell className="text-right"><Unknown>Chưa có chỉ số này</Unknown></TableCell>
                <TableCell className="numeric text-right">{formatVND(summary.provenCash)}</TableCell>
                <TableCell className="text-right">—</TableCell>
                <TableCell>
                  <Link className="text-primary underline underline-offset-2" href="/cod">Đối soát COD → bảng kê Viettel Post</Link>
                  <span className="block text-[11px] text-muted-foreground">Truy về từng đợt tiền về tài khoản và phần còn treo</span>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Giá trị đang chờ xác minh</TableCell>
                <TableCell className="text-right">—</TableCell>
                <TableCell className="numeric text-right text-amber-600 dark:text-amber-400">{summary.unverified ? formatVND(summary.unverifiedCod) : "—"}</TableCell>
                <TableCell className="numeric text-right">{formatNumber(summary.unverified)} đơn</TableCell>
                <TableCell><Link className="text-primary underline underline-offset-2" href={drillHref("unverified")}>Xem đơn</Link></TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Tỷ lệ giao thành công</TableCell>
                <TableCell className="numeric text-right"><Rate value={summary.legacySuccessRate} /></TableCell>
                <TableCell className="numeric text-right"><Rate value={summary.successRate} /></TableCell>
                <TableCell className="numeric text-right">
                  {summary.legacySuccessRate === null || summary.successRate === null ? <Unknown>—</Unknown> : `${(summary.successRate - summary.legacySuccessRate).toFixed(1)} điểm`}
                </TableCell>
                <TableCell><Link className="text-primary underline underline-offset-2" href="/reports/returns">Báo cáo GTC</Link></TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Số đơn bị phân loại khác nhau</TableCell>
                <TableCell className="numeric text-right">{formatNumber(summary.legacyDelivered)} đơn giao TC</TableCell>
                <TableCell className="numeric text-right">{formatNumber(summary.delivered)} đơn giao TC</TableCell>
                <TableCell className="numeric text-right font-semibold text-destructive">{formatNumber(summary.mismatch)} đơn</TableCell>
                <TableCell><Link className="text-primary underline underline-offset-2" href={drillHref("pancake-declared")}>Đơn khai báo suông</Link></TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Tồn kho có nguy cơ sai</TableCell>
                <TableCell className="text-right"><Unknown>Trước đây cộng hết vào tồn</Unknown></TableCell>
                <TableCell className="numeric text-right">{formatNumber(summary.returnRiskUnits)} sản phẩm · {formatNumber(summary.returnRiskSkus)} SKU</TableCell>
                <TableCell className="numeric text-right">{formatNumber(summary.returnRiskShipments)} vận đơn</TableCell>
                <TableCell><Link className="text-primary underline underline-offset-2" href={drillHref("return-not-received")}>Xác nhận về kho</Link></TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Doanh thu marketing có nguy cơ sai</TableCell>
                <TableCell className="numeric text-right">{formatVND(summary.marketingRiskRevenue)}</TableCell>
                <TableCell className="text-right"><Unknown>Không được ghi nhận</Unknown></TableCell>
                <TableCell className="numeric text-right">{formatNumber(summary.mismatch)} đơn</TableCell>
                <TableCell><Link className="text-primary underline underline-offset-2" href="/ads">Hiệu quả quảng cáo</Link></TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Vận đơn chưa đối soát ({formatNumber(summary.unlinkedShipments)}) KHÔNG được tính vào bất kỳ dòng nào ở trên: không doanh thu, không lợi nhuận, không tồn kho, không marketing, không tỷ lệ giao thành công.
        </p>
      </SectionCard>

      {/* ───────── Drill-down ───────── */}
      {issue && drill ? (
        <SectionCard
          title={DQ_ISSUE_LABEL[issue]}
          hint={DQ_ISSUE_HINT[issue]}
          actions={<Button asChild variant="outline" size="sm"><Link href={`/data-quality?period=${params.period.key}`}>Đóng danh sách</Link></Button>}
        >
          {drill.total === 0 ? (
            <EmptyState title="Không có bản ghi nào" description="Nhóm vấn đề này hiện đang sạch trong kỳ đã chọn." />
          ) : (
            <div className="flex flex-col gap-4">
              <p className="text-xs text-muted-foreground">
                {formatNumber(drill.total)} bản ghi · đang xem {formatNumber(drill.rows.length)} dòng (trang {page})
              </p>

              {issue === "return-not-received" && drill.kind === "shipment" ? (
                <ReceiveReturns
                  bulk={warehouseBacklog}
                  rows={drill.rows.map((r) => ({
                    id: r.id,
                    label: `${r.vtpOrderNumber ?? r.orderReference ?? r.id} · ${r.receiverName || "—"} · COD ${formatVND(r.codAmount ?? 0)}`,
                    receivedAt: r.returnReceivedAt ? formatDateTime(r.returnReceivedAt) : null,
                  }))}
                />
              ) : null}

              <div className="overflow-x-auto">
                {drill.kind === "shipment" ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Mã vận đơn</TableHead>
                        <TableHead>Trạng thái VTP</TableHead>
                        <TableHead>Người nhận</TableHead>
                        <TableHead className="text-right">COD khai báo</TableHead>
                        <TableHead className="text-right">Thực thu</TableHead>
                        <TableHead>Cập nhật</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {drill.rows.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell className="numeric font-medium">
                            <Link className="text-primary underline underline-offset-2" href={`/shipments/${row.id}`}>{row.vtpOrderNumber ?? row.orderReference ?? row.id}</Link>
                          </TableCell>
                          <TableCell><Badge variant="secondary">{row.vtpStatusName ?? row.stage}</Badge></TableCell>
                          <TableCell className="max-w-[220px] truncate">{row.receiverName || <Unknown>—</Unknown>} {row.receiverPhone ? <span className="text-muted-foreground">· {row.receiverPhone}</span> : null}</TableCell>
                          <TableCell className="numeric text-right">{formatVND(row.codAmount ?? 0)}</TableCell>
                          <TableCell className="numeric text-right">{row.codCollected ? formatVND(row.codCollected) : <Unknown>Chưa có</Unknown>}</TableCell>
                          <TableCell className="text-muted-foreground">{formatDateTime(row.updatedAt)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Đơn</TableHead>
                        <TableHead>Khách</TableHead>
                        <TableHead>Pancake / Vận đơn</TableHead>
                        <TableHead className="text-right">Doanh thu khai báo</TableHead>
                        <TableHead className="text-right">Tiền legacy (ước tính)</TableHead>
                        <TableHead>ERP đang xếp</TableHead>
                        <TableHead>Thực tế</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {drill.rows.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell className="numeric font-medium">
                            <Link className="text-primary underline underline-offset-2" href={`/orders/${row.id}`}>#{row.id}</Link>
                            <span className="block text-xs text-muted-foreground">{formatDateTime(row.insertedAt)}</span>
                          </TableCell>
                          <TableCell className="max-w-[180px] truncate">{row.customerName || <Unknown>—</Unknown>}</TableCell>
                          <TableCell className="text-xs">
                            <span className="block">{row.orderStage}</span>
                            <span className="block text-muted-foreground">{row.vtpOrderNumber ? `${row.vtpOrderNumber} · ${row.shipmentStage}` : "Chưa có vận đơn"}</span>
                          </TableCell>
                          <TableCell className="numeric text-right">{formatVND(row.declaredRevenue)}</TableCell>
                          <TableCell className="numeric text-right">{row.hasCashProof ? formatVND(row.cash) : <Unknown />}</TableCell>
                          <TableCell><OrderOutcomeBadge outcome={row.legacyOutcome as OrderOutcome} /></TableCell>
                          <TableCell><VerifiedOutcomeBadge outcome={row.verifiedOutcome} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>

              {drill.total > PAGE_SIZE ? (
                <div className="flex items-center justify-between gap-2">
                  <Button asChild variant="outline" size="sm" disabled={page <= 1}>
                    <Link href={`/data-quality?issue=${issue}&period=${params.period.key}&page=${Math.max(1, page - 1)}`}>Trang trước</Link>
                  </Button>
                  <span className="text-xs text-muted-foreground">Trang {page} / {Math.ceil(drill.total / PAGE_SIZE)}</span>
                  <Button asChild variant="outline" size="sm" disabled={page >= Math.ceil(drill.total / PAGE_SIZE)}>
                    <Link href={`/data-quality?issue=${issue}&period=${params.period.key}&page=${page + 1}`}>Trang sau</Link>
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </SectionCard>
      ) : null}
    </div>
  );
}

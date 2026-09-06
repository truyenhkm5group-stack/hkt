import {
  AlertTriangle,
  Boxes,
  CircleHelp,
  Link2Off,
  PackageCheck,
  Percent,
  ShieldCheck,
  ShoppingBag,
  Truck,
  Undo2,
} from "lucide-react";
import Link from "next/link";
import { ReceiveReturns } from "@/app/(dashboard)/data-quality/receive-returns";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { EmptyState, Money, SectionCard } from "@/components/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/session";
import { DQ_ISSUE_HINT, DQ_ISSUE_LABEL, DQ_ISSUES, VERIFIED_OUTCOME_LABEL, type DqIssue, type VerifiedOutcome } from "@/lib/constants/data-quality";
import { OUTCOME_LABEL, successTone, type OrderOutcome } from "@/lib/constants/returns";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { dataQualityOrders, dataQualitySummary, returnsAwaitingWarehouse, unlinkedShipments } from "@/lib/queries/data-quality";
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

function outcomeBadge(outcome: VerifiedOutcome | OrderOutcome, label: string) {
  const tone =
    outcome === "DELIVERED" ? "bg-success/12 text-success"
    : outcome === "UNVERIFIED" ? "bg-warning/15 text-amber-700 dark:text-amber-300"
    : outcome === "RETURNED" || outcome === "RETURNED_BY_RULE" ? "bg-destructive/10 text-destructive"
    : outcome === "IN_TRANSIT" ? "bg-info/12 text-info"
    : "bg-muted text-muted-foreground";
  return <span className={cn("inline-flex rounded-md px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap", tone)}>{label}</span>;
}

export default async function DataQualityPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission("dashboard:view");
  const raw = await searchParams;
  const params = parseListParams(raw, { defaultPeriod: "90d", defaultPageSize: PAGE_SIZE, sortable: ["updatedAt", "codAmount", "codCollected", "stage", "vtpOrderNumber"], defaultSort: "updatedAt", defaultDir: "desc" });
  const issue = (DQ_ISSUES as readonly string[]).includes(param(raw, "issue")) ? (param(raw, "issue") as DqIssue) : null;
  const page = Math.max(1, Number(param(raw, "page", "1")) || 1);

  const summary = await dataQualitySummary(params.period);

  // Chỉ tải danh sách của nhóm vấn đề đang mở (drill-down).
  const drill = issue === "unlinked-shipment"
    ? { kind: "shipment" as const, ...(await unlinkedShipments(page, PAGE_SIZE, params.q, params.sort, params.dir)) }
    : issue === "return-not-received"
      ? { kind: "shipment" as const, ...(await returnsAwaitingWarehouse(page, PAGE_SIZE, params.q)) }
      : issue
        ? { kind: "order" as const, ...(await dataQualityOrders(issue, params.period, page, PAGE_SIZE, params.q)) }
        : null;

  const drillHref = (key: DqIssue) => `/data-quality?issue=${key}&period=${params.period.key}`;
  const rule = summary.rule;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Data Truth"
        title="Chất lượng dữ liệu"
        description={`Đối chiếu số liệu ERP đang chạy với quy tắc tiền thật: giao thành công = thực thu > ${formatVND(rule.maxCodForFakeDelivery)}, dưới ${formatVND(rule.maxCodForReturn)} là đơn hoàn. Thiếu bằng chứng tiền thì ghi "Chưa xác minh", không đoán và không quy về 0.`}
      />

      <DataTableToolbar period={{ defaultKey: "90d" }} searchPlaceholder={issue ? "Tìm mã đơn, mã vận đơn, tên, SĐT…" : undefined} resultLabel={`Kỳ: ${params.period.label}`} />

      {/* ───────── KPI vận hành theo quy tắc thực tế ───────── */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Tổng đơn (không tính huỷ)" value={formatNumber(summary.total)} icon={ShoppingBag} tone="primary" note={`${formatNumber(summary.cancelled)} đơn huỷ không tính`} />
        <MetricCard label="Đơn giao thành công thực tế" value={formatNumber(summary.delivered)} icon={PackageCheck} tone="green" note={`Có tiền thực thu > ${formatVND(rule.maxCodForFakeDelivery)}`} />
        <MetricCard label="Đơn hoàn thực tế" value={formatNumber(summary.returned)} icon={Undo2} tone="rose" note="Gồm cả đơn thu 50K–100K" />
        <MetricCard label="Đơn đang giao" value={formatNumber(summary.inTransit)} icon={Truck} tone="blue" note="Chưa kết luận được kết quả" />
        <MetricCard
          label="Đơn chưa đủ dữ liệu xác minh"
          value={formatNumber(summary.unverified)}
          icon={CircleHelp}
          tone="amber"
          note={<Link className="underline underline-offset-2" href={drillHref("unverified")}>Xem danh sách →</Link>}
        />
        <MetricCard label="Tỷ lệ giao thành công thực tế" value={<Rate value={summary.successRate} />} icon={Percent} tone="green" note="Trên các đơn đã có kết quả" />
        <MetricCard label="Thực thu có bằng chứng" value={<Money value={summary.provenCash} />} icon={ShieldCheck} tone="green" note="COD đã thu + khách chuyển trước" />
        <MetricCard
          label="Giá trị COD chưa xác minh"
          value={summary.unverified ? <Money value={summary.unverifiedCod} /> : <Unknown>—</Unknown>}
          icon={AlertTriangle}
          tone="amber"
          note="COD khai báo của đơn chưa chứng minh được"
        />
      </div>

      {/* ───────── Vấn đề dữ liệu, mỗi ô bấm vào xem danh sách ───────── */}
      <SectionCard title="Vấn đề dữ liệu cần xử lý" description="Bấm vào từng nhóm để xem danh sách đơn / vận đơn liên quan.">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {([
            ["unlinked-shipment", summary.unlinkedShipments, Link2Off, `${formatNumber(summary.unlinkedOpen)} vận đơn chưa kết thúc · COD khai báo ${formatVND(summary.unlinkedCod)}`],
            ["status-conflict", summary.statusConflict, AlertTriangle, "Pancake và Viettel Post nói khác nhau"],
            ["pancake-declared", summary.pancakeDeclared, ShoppingBag, "Pancake báo giao nhưng không có tiền"],
            ["vtp-low-cash", summary.vtpLowCash, Truck, `Thực thu < ${formatVND(rule.maxCodForReturn)}`],
            ["return-not-received", summary.returnRiskShipments, Boxes, `${formatNumber(summary.returnRiskUnits)} sản phẩm chưa xác nhận về kho`],
            ["unverified", summary.unverified, CircleHelp, "Không có số tiền nào để kết luận"],
          ] as const).map(([key, value, Icon, note]) => (
            <Link key={key} href={drillHref(key)} className={cn("rounded-xl border p-4 transition hover:border-primary hover:bg-accent/40", issue === key && "border-primary bg-accent/40")}>
              <div className="flex items-start justify-between gap-3">
                <p className="text-[13px] font-medium text-muted-foreground">{DQ_ISSUE_LABEL[key]}</p>
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
        description="So sánh số liệu ERP đang dùng (legacy) với số liệu theo quy tắc tiền thật. Chênh lệch càng lớn thì rủi ro ra quyết định sai càng cao."
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Chỉ số</TableHead>
                <TableHead className="text-right">ERP đang hiển thị</TableHead>
                <TableHead className="text-right">Theo quy tắc thực tế</TableHead>
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
                <TableCell>Tiền thực thu CÓ BẰNG CHỨNG</TableCell>
                <TableCell className="text-right"><Unknown>Chưa có chỉ số này</Unknown></TableCell>
                <TableCell className="numeric text-right">{formatVND(summary.provenCash)}</TableCell>
                <TableCell className="text-right">—</TableCell>
                <TableCell className="text-muted-foreground">COD đã thu + chuyển khoản trước</TableCell>
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
          description={DQ_ISSUE_HINT[issue]}
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
                        <TableHead className="text-right">Tiền có bằng chứng</TableHead>
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
                          <TableCell>{outcomeBadge(row.legacyOutcome as OrderOutcome, OUTCOME_LABEL[row.legacyOutcome as OrderOutcome] ?? row.legacyOutcome)}</TableCell>
                          <TableCell>{outcomeBadge(row.verifiedOutcome, VERIFIED_OUTCOME_LABEL[row.verifiedOutcome] ?? row.verifiedOutcome)}</TableCell>
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

import Link from "next/link";
import { AlertTriangle, ClipboardList, Download, Factory, PackageSearch, ShoppingCart } from "lucide-react";
import { PlanningForm } from "@/app/(dashboard)/inventory/planning/planning-form";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { Money, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can, requirePermission } from "@/lib/auth/session";
import { PLAN_STATUS_LABEL, PLAN_STATUS_TONE } from "@/lib/constants/planning";
import { formatNumber, formatVND } from "@/lib/format";
import { getReplenishmentPlan } from "@/lib/queries/planning";
import { listProductsForMapping } from "@/lib/queries/ads-mapping";
import { cn } from "@/lib/utils";

export const metadata = { title: "Kế hoạch đặt hàng sản xuất" };

function fmtDate(key: string | null) {
  if (!key) return "—";
  const [y, m, d] = key.split("-");
  return `${d}/${m}/${y}`;
}

export default async function PlanningPage() {
  const user = await requirePermission("planning:view");
  const canWrite = can(user, "planning:write");
  const [report, products] = await Promise.all([getReplenishmentPlan(), listProductsForMapping()]);
  const sm = report.summary;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Kho"
        title="Kế hoạch đặt hàng sản xuất"
        description="Cảnh báo thiếu hàng và lượng cần đặt cho từng mẫu mã: dựa trên tồn khả dụng ERP, đơn đã chốt chưa gửi, tốc độ bán gần đây, thời gian sản xuất và số ngày muốn đủ bán sau khi hàng về. Mẫu mã hết hàng trước khi sản xuất xong sẽ lên chuông cảnh báo và nhóm Lark."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/inventory/planning/orders"><ClipboardList className="size-4" /> Bảng đặt hàng đã chốt</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href="/api/export/planning"><Download className="size-4" /> Xuất CSV</a>
            </Button>
          </div>
        }
      />
      <PlanningForm assumptions={report.assumptions} products={products} canWrite={canWrite} />
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Hết hàng / âm tồn" value={formatNumber(sm.out)} note="Tồn khả dụng ≤ đơn đã chốt — cần sản xuất gấp" icon={AlertTriangle} tone={sm.out ? "rose" : "slate"} />
        <MetricCard label="Hết trước khi SX xong" value={formatNumber(sm.critical)} note={`Số ngày còn bán được < thời gian SX (${report.assumptions.leadTimeDays} ngày)`} icon={Factory} tone={sm.critical ? "amber" : "slate"} />
        <MetricCard label="Sắp thiếu" value={formatNumber(sm.low)} note="Còn bán được dưới thời gian SX + tồn an toàn" icon={PackageSearch} tone={sm.low ? "amber" : "slate"} />
        <MetricCard
          label="Chưa tính được tồn"
          value={formatNumber(sm.unknown)}
          note="Chưa có phiếu nhập trong ERP — KHÔNG đề xuất đặt cho các mẫu mã này"
          icon={PackageSearch}
          tone={sm.unknown ? "amber" : "slate"}
        />
        <MetricCard label="Đề xuất đặt" value={formatNumber(sm.suggestedUnits)} note={`${formatVND(sm.orderCost, { compact: true })} theo giá nhập gần nhất · ${formatNumber(sm.variants)} mẫu mã đang theo dõi`} icon={ShoppingCart} tone="blue" />
      </section>

      {report.products.map((g) => (
        <SectionCard
          key={g.productId}
          title={`${g.productCode ? `${g.productCode} · ` : ""}${g.productName}`}
          description={`${g.rows.length} mẫu mã · đề xuất đặt ${formatNumber(g.suggested)} sp · ${formatVND(g.orderCost)}`}
          actions={
            <div className="flex items-center gap-2">
              {canWrite ? (
                <Button asChild size="sm">
                  <Link href={`/inventory/planning/orders/new?product=${g.productId}`}><ClipboardList className="size-4" /> Tạo bảng chốt đặt hàng</Link>
                </Button>
              ) : null}
              <span className={cn("rounded-md px-2 py-0.5 text-xs font-semibold", PLAN_STATUS_TONE[g.worst])}>{PLAN_STATUS_LABEL[g.worst]}</span>
            </div>
          }
          padded={false}
        >
          <div className="overflow-x-auto">
            <Table className="min-w-[1180px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Mẫu mã</TableHead>
                  <TableHead className="text-right">Tồn ERP</TableHead>
                  <TableHead className="text-right">Tồn Pancake</TableHead>
                  <TableHead className="text-right">Đã chốt chưa gửi</TableHead>
                  <TableHead className="text-right">Khả dụng</TableHead>
                  <TableHead className="text-right">Bán 7 ngày</TableHead>
                  <TableHead className="text-right">Bán {report.assumptions.velocityWindowDays} ngày</TableHead>
                  <TableHead className="text-right">Bán 30 ngày</TableHead>
                  <TableHead className="text-right">Tốc độ / ngày</TableHead>
                  <TableHead className="text-right">Còn bán được</TableHead>
                  <TableHead>Dự kiến hết</TableHead>
                  <TableHead className="text-right">Bán trong lúc SX</TableHead>
                  <TableHead className="text-right">Mục tiêu</TableHead>
                  <TableHead className="text-right">Đề xuất đặt</TableHead>
                  <TableHead className="text-right">Tiền hàng</TableHead>
                  <TableHead>Tình trạng</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {g.rows.map((r) => (
                  <TableRow key={r.variantId} className={cn(r.status === "OUT" && "bg-rose-50/40 dark:bg-rose-950/10", r.status === "CRITICAL" && "bg-orange-50/40 dark:bg-orange-950/10")}>
                    <TableCell>
                      <div className="font-medium">{[r.color, r.size].filter(Boolean).join(" / ") || r.sku || "—"}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">{r.sku}{r.leadTimeDays !== report.assumptions.leadTimeDays ? ` · SX ${r.leadTimeDays} ngày` : ""}</div>
                    </TableCell>
                    <TableCell className={cn("text-right tabular-nums font-semibold", r.stock < 0 && "text-rose-600")}>{formatNumber(r.stock)}</TableCell>
                    <TableCell className={cn("text-right tabular-nums text-muted-foreground", r.pancakeStock !== r.stock && "text-amber-700")} title="Tồn trên Pancake — lệch với ERP thì kiểm tra phiếu nhập / kiểm kê">{formatNumber(r.pancakeStock)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(r.committed)}</TableCell>
                    <TableCell className={cn("text-right tabular-nums font-semibold", r.available <= 0 && "text-rose-600")}>{formatNumber(r.available)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(r.sold7)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(r.soldInWindow)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(r.sold30)}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.velocity.toFixed(1)}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.daysOfCover === null ? "—" : `${Math.floor(r.daysOfCover)} ngày`}</TableCell>
                    <TableCell className="text-xs">{fmtDate(r.stockOutDate)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(r.leadTimeDemand)}</TableCell>
                    <TableCell className="text-right tabular-nums" title="Nhu cầu (SX + đủ bán) + tồn an toàn">{formatNumber(r.target)}</TableCell>
                    <TableCell className="text-right tabular-nums font-bold">{r.suggested ? formatNumber(r.suggested) : <span className="text-muted-foreground">0</span>}</TableCell>
                    <TableCell className="text-right"><Money value={r.orderCost} className={r.orderCost ? "" : "text-muted-foreground"} /></TableCell>
                    <TableCell><span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap", PLAN_STATUS_TONE[r.status])}>{PLAN_STATUS_LABEL[r.status]}</span></TableCell>
                  </TableRow>
                ))}
                {g.rows.length ? (() => {
                  const sum = (f: (r: (typeof g.rows)[number]) => number) => g.rows.reduce((t, r) => t + f(r), 0);
                  const stock = sum((r) => r.stock);
                  const velocity = sum((r) => r.velocity);
                  const available = sum((r) => r.available);
                  const cover = velocity > 0 ? Math.max(0, available) / velocity : null;
                  const outCount = g.rows.filter((r) => r.status === "OUT").length;
                  const critCount = g.rows.filter((r) => r.status === "CRITICAL").length;
                  const lowCount = g.rows.filter((r) => r.status === "LOW").length;
                  return (
                    <TableRow className="bg-muted/40 font-bold hover:bg-muted/40">
                      <TableCell>Tổng {g.productCode || g.productName} · {g.rows.length} mẫu mã</TableCell>
                      <TableCell className={cn("text-right tabular-nums", stock < 0 && "text-rose-600")}>{formatNumber(stock)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{formatNumber(sum((r) => r.pancakeStock))}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(sum((r) => r.committed))}</TableCell>
                      <TableCell className={cn("text-right tabular-nums", available <= 0 && "text-rose-600")}>{formatNumber(available)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(sum((r) => r.sold7))}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(sum((r) => r.soldInWindow))}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(sum((r) => r.sold30))}</TableCell>
                      <TableCell className="text-right tabular-nums">{velocity.toFixed(1)}</TableCell>
                      <TableCell className="text-right tabular-nums" title="Khả dụng cả mã ÷ tốc độ bán cả mã (bình quân, từng mẫu mã có thể hết sớm hơn)">{cover === null ? "—" : `~${Math.floor(cover)} ngày`}</TableCell>
                      <TableCell className="text-xs font-normal text-muted-foreground">{outCount ? `${outCount} hết` : ""}{critCount ? `${outCount ? " · " : ""}${critCount} hết trước SX` : ""}{lowCount ? `${outCount || critCount ? " · " : ""}${lowCount} sắp thiếu` : ""}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(sum((r) => r.leadTimeDemand))}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(sum((r) => r.target))}</TableCell>
                      <TableCell className="text-right tabular-nums text-base">{formatNumber(g.suggested)}</TableCell>
                      <TableCell className="text-right"><Money value={g.orderCost} /></TableCell>
                      <TableCell><span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap", PLAN_STATUS_TONE[g.worst])}>{PLAN_STATUS_LABEL[g.worst]}</span></TableCell>
                    </TableRow>
                  );
                })() : null}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      ))}
      {report.products.length === 0 ? <SectionCard><p className="py-6 text-center text-sm text-muted-foreground">Chưa có mẫu mã nào có tồn hoặc bán trong 30 ngày. Nhập phiếu nhập / kiểm kê ở “Nhập hàng & kiểm kê” trước.</p></SectionCard> : null}
      <p className="text-xs text-muted-foreground">
        Số liệu chính xác khi: (1) phiếu nhập / kiểm kê đầu kỳ đã nhập đủ trên ERP; (2) trạng thái vận đơn Viettel Post được cập nhật (webhook hoặc nhập danh sách vận đơn) để phân biệt giao thật / hoàn / đang giao; (3) giá nhập ghi trên phiếu. Cột “Tồn Pancake” để đối chiếu — lệch nhiều nghĩa là phiếu nhập trên ERP chưa khớp kho thực tế.
      </p>
    </div>
  );
}

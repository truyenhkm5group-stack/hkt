import Link from "next/link";
import { AlertTriangle, Coins, Factory, PackageSearch, Wallet } from "lucide-react";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { Money, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/session";
import { CONFIDENCE_LABEL } from "@/lib/constants/recommendation";
import { DECISION_ACTION, DECISION_LABEL, DECISION_TONE, type InventoryDecisionKind } from "@/lib/constants/inventory-decision";
import { formatNumber, formatVND } from "@/lib/format";
import { backtestInventoryDecisions, getInventoryDecisionReport } from "@/lib/queries/inventory-decision";
import { cn } from "@/lib/utils";

export const metadata = { title: "Quyết định vốn tồn kho" };

/** Thứ tự các nhóm trên bảng — việc mất tiền ngay đứng trước việc tiền nằm chờ. */
const GROUP_ORDER: InventoryDecisionKind[] = ["STOCKOUT_RISK", "REORDER", "OVERSTOCK", "CLEARANCE_CANDIDATE", "DATA_INSUFFICIENT"];

function fmtDate(key: string | null) {
  if (!key) return "—";
  const [y, m, d] = key.split("-");
  return `${d}/${m}/${y}`;
}

export default async function InventoryDecisionsPage() {
  await requirePermission("planning:view");
  const [report, backtest] = await Promise.all([getInventoryDecisionReport(), backtestInventoryDecisions(30)]);
  const sm = report.summary;
  const cov = report.coverage;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Kho"
        title="Quyết định vốn tồn kho"
        description="Với từng mẫu mã: đặt thêm (cần bao nhiêu vốn), giữ nguyên, hay xả để giải phóng vốn"
        hint={
          <>
            Bộ máy này KHÔNG đo lại gì cả — nó ghép các con số đã có: tồn/tốc độ/số nên đặt của <b>Kế hoạch đặt hàng SX</b>, lần bán cuối của bảng <b>hàng bán chậm</b>, và <b>đơn sản xuất đã gửi xưởng</b> (thứ kế hoạch SX không trừ) — rồi ra MỘT kết luận cho mỗi mẫu mã kèm lý do và mức tin cậy. Tiền vốn tính theo GIÁ NHẬP; thiếu giá nhập thì hiện &quot;chưa có giá nhập&quot;, không phải 0đ. Trang CHỈ ĐỀ XUẤT: không tự tạo đơn sản xuất, không tự sửa tồn kho.
          </>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/inventory/planning"><Factory className="size-4" /> Kế hoạch đặt hàng SX</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/inventory/purchasing"><PackageSearch className="size-4" /> Mua hàng &amp; xưởng</Link>
            </Button>
          </div>
        }
      />

      <div
        className={cn(
          "flex items-start gap-3 rounded-xl border px-4 py-3 text-[13px]",
          report.dataGate.state === "DATA_INSUFFICIENT"
            ? "border-amber-300/70 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/20"
            : "border-sky-300/70 bg-sky-50/60 dark:border-sky-900/60 dark:bg-sky-950/20",
        )}
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <div className="space-y-1">
          <p>
            <b>{report.dataGate.state === "DATA_INSUFFICIENT" ? "DỮ LIỆU CHƯA ĐỦ" : "BETA"}</b> — trang chỉ để tham khảo, <b>không phải căn cứ đặt hàng</b>. Mỗi đề xuất
            đặt/xả phải được người quyết định đối chiếu với Kế hoạch SX và thực tế xưởng; ERP không tự tạo đơn sản xuất và không tự sửa tồn.
          </p>
          {report.dataGate.reasons.length ? (
            <ul className="list-disc pl-5 text-muted-foreground">
              {report.dataGate.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">Nền dữ liệu đủ để đọc; chuyển khỏi BETA khi chủ shop đã đối chiếu một chu kỳ đặt hàng thật với đề xuất ở đây.</p>
          )}
        </div>
      </div>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Vốn cần cho đề xuất đặt"
          value={formatVND(sm.capitalRequired, { compact: true })}
          note={`${formatNumber(report.byDecision.STOCKOUT_RISK + report.byDecision.REORDER)} mẫu mã cần đặt${sm.capitalRequiredUnknown ? ` · ${sm.capitalRequiredUnknown} mẫu CHƯA CÓ GIÁ NHẬP nên chưa tính được tiền` : ""}`}
          hint="Số nên đặt (đã trừ tồn khả dụng, hàng sắp quay về kho VÀ hàng đã đặt xưởng chưa nhận) × giá nhập gần nhất. Mẫu thiếu giá nhập không cộng vào đây — thiếu là thiếu, không phải 0đ."
          icon={Wallet}
          tone={sm.capitalRequired ? "blue" : "slate"}
        />
        <MetricCard
          label="Vốn giải phóng được"
          value={formatVND(sm.capitalFreeable, { compact: true })}
          note={`${formatNumber(report.byDecision.OVERSTOCK)} mẫu chôn vốn · ${formatNumber(report.byDecision.CLEARANCE_CANDIDATE)} mẫu nên xả${sm.capitalFreeableUnknown ? ` · ${sm.capitalFreeableUnknown} mẫu chưa có giá nhập` : ""}`}
          hint="Phần tồn vượt mức đủ bán lành mạnh (và toàn bộ tồn của hàng chết), quy theo GIÁ NHẬP — đây là tiền đã bỏ ra đang nằm trong kho, không phải doanh thu sẽ thu được khi xả."
          icon={Coins}
          tone={sm.capitalFreeable ? "amber" : "slate"}
        />
        <MetricCard
          label="Nguy cơ hết hàng"
          value={formatNumber(report.byDecision.STOCKOUT_RISK)}
          note={sm.grossImpactEstimate ? `Ước mất ~${formatVND(sm.grossImpactEstimate, { compact: true })} lãi gộp nếu không đặt (ƯỚC TÍNH)` : "Mẫu hết hoặc hết trước khi lô mới về"}
          hint="Mẫu đã hết hàng hoặc sẽ hết trước khi sản xuất kịp. Ước lãi gộp mất = tốc độ bán × số ngày trống hàng × (giá bán − giá nhập) × tỷ lệ giao thành công — chỉ tính khi biết cả giá bán lẫn giá nhập, và LUÔN là ước tính."
          icon={AlertTriangle}
          tone={report.byDecision.STOCKOUT_RISK ? "rose" : "slate"}
        />
        <MetricCard
          label="Đang cam kết với xưởng"
          value={formatNumber(sm.openPoUnits)}
          note={`${formatVND(sm.openPoCapital, { compact: true })} theo đơn SX đã gửi, chưa nhận${sm.openPoCapitalUnknownOrders ? ` · ${formatNumber(sm.openPoCapitalUnknownOrders)} đơn CHƯA KHAI GIÁ XƯỞNG nên chưa tính tiền` : ""}${sm.openPoUnmappedUnits ? ` · ${formatNumber(sm.openPoUnmappedUnits)} món không ghép được về mẫu mã` : ""}`}
          hint="Đơn sản xuất trạng thái ĐÃ GỬI XƯỞNG. Số này được TRỪ khỏi đề xuất đặt của từng mẫu mã — không trừ thì mẫu đã đặt 500 cái vẫn bị kêu đặt thêm. Món không ghép được (đơn thiếu mã hàng hoặc lệch màu/size) được đếm riêng, không chia đều."
          icon={Factory}
          tone={sm.openPoUnits ? "primary" : "slate"}
        />
      </section>

      <p className="text-xs text-muted-foreground">
        Độ phủ dữ liệu: tồn tính được {cov.stockKnownPct}% mẫu mã · sổ kho đủ {report.used.minHistoryDays} ngày ở {cov.historyKnownPct}% · giá nhập có ở {cov.costKnownPct}% · tỷ lệ hoàn đủ mẫu riêng ở {cov.returnRateOwnPct}% (còn lại dùng số toàn shop {Math.round(report.used.shopReturnRate * 100)}%) · thời gian sản xuất khai riêng ở {cov.leadTimeOverridePct}% (còn lại dùng giả định chung {report.used.leadTimeDays} ngày). {formatNumber(report.holdCount)} mẫu mã đang ổn định (giữ nguyên) không hiện trong bảng.
      </p>

      {GROUP_ORDER.map((kind) => {
        const rows = report.rows.filter((r) => r.decision === kind);
        if (!rows.length) return null;
        return (
          <SectionCard
            key={kind}
            title={`${DECISION_LABEL[kind]} — ${formatNumber(rows.length)} mẫu mã`}
            description={DECISION_ACTION[kind]}
            padded={false}
          >
            <div className="overflow-x-auto">
              <Table className="min-w-[1180px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Mẫu mã</TableHead>
                    <TableHead className="text-right">Tồn / Khả dụng</TableHead>
                    <TableHead className="text-right">Bán/ngày</TableHead>
                    <TableHead className="text-right">Còn bán được</TableHead>
                    <TableHead className="text-right">Đã đặt xưởng</TableHead>
                    <TableHead className="text-right">Đề xuất đặt</TableHead>
                    <TableHead className="text-right">Cần vốn</TableHead>
                    <TableHead className="text-right">Giải phóng được</TableHead>
                    <TableHead>Lý do</TableHead>
                    <TableHead>Tin cậy</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.variantId} className={cn(kind === "STOCKOUT_RISK" && "bg-rose-50/40 dark:bg-rose-950/10")}>
                      <TableCell className="max-w-[230px]">
                        <div className="truncate font-medium" title={`${r.productName} · ${r.sku}`}>
                          {r.productCode ? `${r.productCode} · ` : ""}{r.productName}
                        </div>
                        <div className="font-mono text-[11px] text-muted-foreground">
                          {[r.color, r.size].filter(Boolean).join(" / ") || r.sku}
                          {r.leadTimeSource === "override" ? ` · SX ${r.leadTimeDays} ngày` : ""}
                        </div>
                      </TableCell>
                      <TableCell className={cn("text-right tabular-nums", r.available <= 0 && "font-semibold text-rose-600")}>
                        {formatNumber(r.stock)} / {formatNumber(r.available)}
                        {r.incoming ? <div className="text-[11px] font-normal text-sky-700 dark:text-sky-300">sắp về {formatNumber(r.incoming)}</div> : null}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.velocity.toFixed(1)}
                        {r.velocityTrimmed ? <span className="ml-0.5 text-[10px] text-muted-foreground" title="Đã bỏ một ngày đột biến khỏi tốc độ bán">*</span> : null}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-xs">
                        {r.daysOfCover === null ? "—" : `${Math.floor(r.daysOfCover)} ngày`}
                        {r.stockOutDate ? <span className="block text-[10px] text-muted-foreground">hết ~{fmtDate(r.stockOutDate)}</span> : null}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.openPoQty ? formatNumber(r.openPoQty) : <span className="text-muted-foreground">0</span>}</TableCell>
                      <TableCell className="text-right tabular-nums font-bold">{r.suggestedQty === null ? "—" : formatNumber(r.suggestedQty)}</TableCell>
                      <TableCell className="text-right">
                        {r.suggestedQty ? (
                          r.capitalRequired === null ? <span className="text-xs italic text-muted-foreground">chưa có giá nhập</span> : <Money value={r.capitalRequired} />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.excessQty > 0 ? (
                          r.capitalFreeable === null ? <span className="text-xs italic text-muted-foreground">chưa có giá nhập</span> : <Money value={r.capitalFreeable} />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[330px] text-xs text-muted-foreground">
                        {r.reason}
                        {r.grossImpactEstimate ? <span className="block font-medium text-rose-700 dark:text-rose-300">Ước mất ~{formatVND(r.grossImpactEstimate, { compact: true })} lãi gộp (ước tính)</span> : null}
                      </TableCell>
                      <TableCell className="text-xs">
                        <span className={cn("rounded px-1.5 py-0.5 text-[10.5px] font-semibold whitespace-nowrap", DECISION_TONE[r.decision])} title={r.notes.join(" · ") || undefined}>
                          {CONFIDENCE_LABEL[r.confidence]}
                        </span>
                        {r.notes.length ? <span className="mt-0.5 block max-w-[220px] text-[10.5px] leading-snug text-muted-foreground">{r.notes.join(" · ")}</span> : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </SectionCard>
        );
      })}

      {report.rows.length === 0 ? (
        <SectionCard>
          <p className="py-6 text-center text-sm text-muted-foreground">Không có mẫu mã nào cần hành động — toàn bộ {formatNumber(report.holdCount)} mẫu đang theo dõi ở trạng thái ổn định.</p>
        </SectionCard>
      ) : null}

      <SectionCard
        title={`Đối chứng lịch sử — chạy lại bộ máy tại mốc ${backtest.daysBack} ngày trước`}
        description={`${formatNumber(backtest.evaluated)} mẫu mã đánh giá được tại mốc đó · chân trời kiểm ${backtest.horizonDays} ngày`}
        hint="Toàn bộ là ƯỚC TÍNH trên dữ liệu dựng lại từ phiếu kho và mốc rời kho: tồn quá khứ không gồm phần đã chốt chưa gửi, tốc độ bán không cắt ngày đột biến, và nhu cầu bị mất vì trống hàng thì không nguồn dữ liệu nào ghi lại được."
      >
        <ul className="space-y-1 text-sm">
          <li>
            Báo <b>nguy cơ hết hàng</b>: {formatNumber(backtest.stockout.predicted)} mẫu — {formatNumber(backtest.stockout.confirmed)} mẫu sau đó tồn dựng lại thật sự về ≤ 0
            {backtest.stockout.predicted ? ` (${Math.round((backtest.stockout.confirmed / backtest.stockout.predicted) * 100)}%)` : ""}.
          </li>
          <li>
            Báo <b>đang chôn vốn</b>: {formatNumber(backtest.overstock.predicted)} mẫu — {formatNumber(backtest.overstock.stillExcess)} mẫu sau chân trời vẫn vượt ngưỡng tồn.
          </li>
          <li>
            Báo <b>nên xả / dừng</b>: {formatNumber(backtest.clearance.predicted)} mẫu — {formatNumber(backtest.clearance.noSales)} mẫu tiếp tục không bán được cái nào.
          </li>
        </ul>
      </SectionCard>

      <p className="text-xs text-muted-foreground">
        Nguồn số: tồn/tốc độ/số nên đặt = Kế hoạch đặt hàng SX (sổ kho + sự kiện Viettel Post, kết quả đơn theo ORDER_OUTCOME) · giá nhập = phiếu nhập gần nhất · cam kết xưởng = đơn sản xuất ĐÃ GỬI. Trang chỉ đề xuất — tạo đơn đặt hàng ở &quot;Kế hoạch đặt hàng SX → Tạo bảng chốt&quot;.
      </p>
    </div>
  );
}

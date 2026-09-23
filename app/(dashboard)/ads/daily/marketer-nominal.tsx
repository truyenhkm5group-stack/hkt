import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatPercent, formatVND, pctOrNull } from "@/lib/format";
import type { MarketerDailyNominal, NominalCell } from "@/lib/queries/marketer-daily-nominal";
import { cn } from "@/lib/utils";

export type ProfitKind = "net" | "gross";

/**
 * ═══════════ BÓC TÁCH THEO MKTER — ĐƠN · DOANH THU · LỢI NHUẬN ƯỚC TÍNH, TỪNG NGÀY ═══════════
 *
 * Hai khối, đúng hai câu hỏi của chủ shop:
 *   1. Cả kỳ, từng MKT ra bao nhiêu (bảng tổng — mỗi dòng một người);
 *   2. Mỗi ngày trôi qua, từng MKT ra bao nhiêu (ma trận ngày × người, mới nhất ở trên).
 *
 * Mọi con số tiền là số ƯỚC TÍNH của Báo cáo lợi nhuận danh nghĩa, chia xuống từng đơn — xem
 * `lib/queries/marketer-daily-nominal.ts`. Vì vậy KHÔNG ô nào được tô xanh/đỏ (AGENTS.md mục 44 ·
 * 68): phần lớn giá trị của một ngày mới là tỷ lệ giao chưa xảy ra, và tô màu nó là khẳng định
 * một điều chưa xảy ra.
 *
 * Bảng phải vừa một màn hình: mỗi ô là ô NHIỀU TẦNG thay vì nhiều cột.
 */

const orders = (n: number) => {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1).replace(".", ",");
};

const profitOf = (c: NominalCell, kind: ProfitKind) => (kind === "net" ? c.netProfit : c.expectedProfit);

function weekday(day: string) {
  // Chuỗi ngày là NGÀY LỊCH (giờ VN). Đọc nó ở 12:00 UTC thì mọi múi giờ đều ra cùng một ngày.
  return ["CN", "T2", "T3", "T4", "T5", "T6", "T7"][new Date(`${day}T12:00:00Z`).getUTCDay()];
}

function ddmm(day: string) {
  const [, m, d] = day.split("-");
  return `${d}/${m}`;
}

/** Phần đơn còn đang đi của một ô — nói ô đó dựa vào ƯỚC TÍNH bao nhiêu. */
function openShare(c: NominalCell): number | null {
  return pctOrNull(c.openOrders, c.orders);
}

function MatrixCell({ c, kind }: { c: NominalCell | undefined; kind: ProfitKind }) {
  if (!c || (c.orders === 0 && !c.adSpend)) return <span className="text-muted-foreground/50">·</span>;
  const p = profitOf(c, kind);
  return (
    <div className="leading-tight">
      <div>
        <b>{orders(c.orders)}</b> đơn · {formatVND(c.expectedRevenue, { compact: true })}
      </div>
      <div className="font-semibold" title={kind === "net" ? "LN ròng ước tính" : "LN danh nghĩa ước tính"}>
        LN {formatVND(p, { compact: true })}
      </div>
      <div className="text-[10px] text-muted-foreground">QC {formatVND(c.adSpend, { compact: true })}</div>
    </div>
  );
}

export function MarketerNominalBreakdown({ data, kind, hrefFor, kindHref, reportHref }: { data: MarketerDailyNominal; kind: ProfitKind; hrefFor: (key: string) => string; kindHref: (k: ProfitKind) => string; reportHref: string }) {
  if (!data.days.length) return <div className="px-4 py-6 text-sm text-muted-foreground">Chưa có đơn hay chi quảng cáo nào trong kỳ này.</div>;
  const t = data.total;
  const rc = data.reconcile;
  const attrTotal = Object.values(data.attribution).reduce((s, v) => s + v, 0);
  const attrPct = (v: number) => formatPercent(pctOrNull(v, attrTotal), 0);
  const kindLabel = kind === "net" ? "LN ròng ƯT" : "LN danh nghĩa ƯT";

  return (
    <div className="space-y-3">
      {data.warnings.map((w) => (
        <p key={w} className="px-4 pt-3 text-[11px] text-amber-600 dark:text-amber-400">
          {w}
        </p>
      ))}

      {/* ─── ĐỐI CHIẾU IN RA MÀN HÌNH: người đọc tự kiểm được bảng này có khớp Báo cáo lợi nhuận không ─── */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 pt-3 text-[11px] text-muted-foreground">
        <span>
          Khớp <Link href={reportHref} className="underline">Báo cáo lợi nhuận danh nghĩa</Link> cùng kỳ
          {/* Tab ấy lấp giá vốn DỰ TÍNH, khu quảng cáo thì không — nói ra thay vì để một dấu ✓ hứa quá. */}
          {data.unknownCostQty > 0 ? " (giá vốn thật, CHƯA lấp giá dự tính — xem cảnh báo phía trên)" : ""}:
        </span>
        <Recon label="DT GTC ƯT" ours={rc.expectedRevenue.ours} report={rc.expectedRevenue.report} />
        <Recon label="LN danh nghĩa" ours={rc.expectedProfit.ours} report={rc.expectedProfit.report} />
        <Recon label="LN ròng" ours={rc.netProfit.ours} report={rc.netProfit.report} />
      </div>
      <p className="px-4 text-[11px] text-muted-foreground">
        Mốc: <b>ngày đơn lên</b> (đổi mốc phía trên không đổi bảng này). Cước ƯT {formatVND(data.assumptions.shipFeeDelivered)}/đơn giao · {formatVND(data.assumptions.shipFeeReturned)}/đơn hoàn · thuế{" "}
        {data.assumptions.taxPercent}% DT · CP khác {data.assumptions.otherCostPercentOfAds}% QC. Quy kết doanh số: ảnh chụp fanpage {attrPct(data.attribution.snapshot)} · page gán tay {attrPct(data.attribution.page)} · ad_id{" "}
        {attrPct(data.attribution.ad)} · chia theo QC/chủ mã {attrPct(data.attribution.fallback)} · không ai {attrPct(data.attribution.none)}.
      </p>

      {/* ─── KHỐI 1: CẢ KỲ, MỖI NGƯỜI MỘT DÒNG ─── */}
      <div className="overflow-x-auto">
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[150px]">MKTer</TableHead>
              <TableHead className="text-right">
                Chi QC<div className="text-[10px] font-normal text-muted-foreground">tin nhắn</div>
              </TableHead>
              <TableHead className="text-right">
                Đơn<div className="text-[10px] font-normal text-muted-foreground">giao · hoàn · đang đi</div>
              </TableHead>
              <TableHead className="text-right">
                Doanh số<div className="text-[10px] font-normal text-muted-foreground">CPQC/đơn</div>
              </TableHead>
              <TableHead className="text-right">
                DT GTC ƯT<div className="text-[10px] font-normal text-muted-foreground">% doanh số</div>
              </TableHead>
              <TableHead className="text-right">
                LN danh nghĩa ƯT<div className="text-[10px] font-normal text-muted-foreground">DT − GV − cước − QC</div>
              </TableHead>
              <TableHead className="text-right">
                LN ròng ƯT<div className="text-[10px] font-normal text-muted-foreground">− vận hành · rủi ro · thuế · CP khác</div>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.marketers.map((m) => (
              <SummaryRow key={m.key} label={m.label} href={hrefFor(m.key)} c={m.total} tag={m.spendMapped ? null : "QC chưa ghép"} />
            ))}
            <SummaryRow label="Tổng shop" c={t} bold />
          </TableBody>
        </Table>
      </div>

      {/* ─── KHỐI 2: MỖI NGÀY, TỪNG NGƯỜI ─── */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline px-4 pt-3">
        <div className="text-xs font-semibold">
          Từng ngày × MKTer <span className="font-normal text-muted-foreground">— mỗi ô: đơn · DT GTC ƯT / {kindLabel} / chi QC</span>
        </div>
        <div className="flex gap-1 text-[11px]">
          {(["net", "gross"] as const).map((k) => (
            <Link key={k} href={kindHref(k)} scroll={false} className={cn("rounded border px-2 py-0.5", k === kind ? "border-primary bg-primary/10 font-semibold" : "text-muted-foreground hover:bg-muted")}>
              {k === "net" ? "LN ròng" : "LN danh nghĩa"}
            </Link>
          ))}
        </div>
      </div>
      <div className="max-h-[640px] overflow-auto">
        <Table className="text-[11px]">
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              <TableHead className="sticky left-0 z-20 min-w-[64px] bg-card">Ngày</TableHead>
              {data.marketers.map((m) => (
                <TableHead key={m.key} className="min-w-[112px] text-right">
                  <Link href={hrefFor(m.key)} className="hover:underline">
                    {m.label}
                  </Link>
                  {!m.spendMapped ? <div className="text-[10px] font-normal text-amber-600 dark:text-amber-400">QC chưa ghép</div> : null}
                </TableHead>
              ))}
              <TableHead className="min-w-[120px] text-right">Tổng shop</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.days.map((d) => {
              const open = openShare(d.total);
              return (
                <TableRow key={d.day} className="align-top">
                  <TableCell className="sticky left-0 z-[1] bg-card font-medium">
                    <div>{ddmm(d.day)}</div>
                    <div className="text-[10px] font-normal text-muted-foreground">{weekday(d.day)}</div>
                    {open !== null && open > 0 ? <div className="text-[10px] font-normal text-muted-foreground" title="Phần đơn của ngày còn chưa ngã ngũ — ô tiền dựa vào ước tính đúng bằng phần này">còn {formatPercent(open, 0)} đang đi</div> : null}
                  </TableCell>
                  {data.marketers.map((m) => (
                    <TableCell key={m.key} className="text-right tabular-nums">
                      <MatrixCell c={d.cells[m.key]} kind={kind} />
                    </TableCell>
                  ))}
                  <TableCell className="bg-muted/30 text-right tabular-nums">
                    <MatrixCell c={d.total} kind={kind} />
                  </TableCell>
                </TableRow>
              );
            })}
            <TableRow className="bg-muted/40 align-top font-semibold">
              <TableCell className="sticky left-0 z-[1] bg-muted">Cả kỳ</TableCell>
              {data.marketers.map((m) => (
                <TableCell key={m.key} className="text-right tabular-nums">
                  <MatrixCell c={m.total} kind={kind} />
                </TableCell>
              ))}
              <TableCell className="text-right tabular-nums">
                <MatrixCell c={t} kind={kind} />
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function Recon({ label, ours, report }: { label: string; ours: number; report: number }) {
  const diff = ours - report;
  return (
    <span title={`Bảng này ${formatVND(ours)} · Báo cáo lợi nhuận ${formatVND(report)}`}>
      {label} {formatVND(report, { compact: true })}{" "}
      {diff === 0 ? <b>✓</b> : Math.abs(diff) <= 1_000 ? <span>(lệch {formatVND(diff)} do làm tròn)</span> : <b className="text-amber-600 dark:text-amber-400">lệch {formatVND(diff)}</b>}
    </span>
  );
}

function SummaryRow({ label, c, href, tag, bold }: { label: string; c: NominalCell; href?: string; tag?: string | null; bold?: boolean }) {
  const cpo = c.adSpend === null || c.orders <= 0 ? null : Math.round(c.adSpend / c.orders);
  return (
    <TableRow className={cn(bold && "bg-muted/40 font-semibold hover:bg-muted/40")}>
      <TableCell className="font-medium">
        {href ? (
          <Link href={href} className="hover:underline">
            {label}
          </Link>
        ) : (
          label
        )}
        {tag ? <div className="text-[10px] font-normal text-amber-600 dark:text-amber-400">{tag}</div> : null}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <div>{formatVND(c.adSpend)}</div>
        <div className="text-[10px] text-muted-foreground">{c.messages === null ? "—" : new Intl.NumberFormat("vi-VN").format(c.messages)} tin</div>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <div>{orders(c.orders)}</div>
        <div className="text-[10px] text-muted-foreground">
          {orders(c.deliveredOrders)} · {orders(c.returnedOrders)} · {orders(c.openOrders)}
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <div>{formatVND(c.posSales)}</div>
        <div className="text-[10px] text-muted-foreground">{formatVND(cpo)}</div>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <div>{formatVND(c.expectedRevenue)}</div>
        <div className="text-[10px] text-muted-foreground">{formatPercent(pctOrNull(c.expectedRevenue, c.posSales))}</div>
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatVND(c.expectedProfit)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatVND(c.netProfit)}</TableCell>
    </TableRow>
  );
}

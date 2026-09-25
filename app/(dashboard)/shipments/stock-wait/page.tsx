import Link from "next/link";
import { AlarmClock, ArrowLeft, Lightbulb, MapPin, PackageX, Timer } from "lucide-react";
import { DailyWaitingChart, WaitRateChart } from "@/app/(dashboard)/shipments/stock-wait/charts";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { DataWarnings } from "@/components/data-warnings";
import { InfoHint } from "@/components/info-hint";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { ScopeDenied } from "@/components/scope-denied";
import { Money, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireResource } from "@/lib/auth/scope-guard";
import { listProductCodes } from "@/lib/queries/product-code";
import { successTone } from "@/lib/constants/returns";
import { WAIT_BUCKETS, WAIT_ORIGINS, WAIT_ORIGIN_LABEL, WAIT_ORIGIN_QUESTION, parseWaitOrigin, type RateRow, type RecommendationTone } from "@/lib/constants/stock-wait-report";
import { MIEN_LABEL, VUNG_LABEL } from "@/lib/constants/vn-regions";
import { formatDate, formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { CURRENT_LIST_LIMIT, getStockWaitReport } from "@/lib/queries/stock-wait-report";
import { parseListParams, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export const metadata = { title: "Chờ hàng & giao thành công" };

const TONE: Record<RecommendationTone, string> = {
  danger: "border-rose-200 bg-rose-50/60 dark:border-rose-900 dark:bg-rose-950/20",
  warn: "border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20",
  info: "border-border bg-muted/30",
};

function Rate({ row, minSample }: { row: Pick<RateRow, "successRate" | "finished">; minSample: number }) {
  if (row.successRate === null) {
    return (
      <span className="text-muted-foreground" title={`Mới ${formatNumber(row.finished)} đơn kết thúc — dưới ngưỡng ${minSample}, chưa đủ để kết luận`}>
        —
      </span>
    );
  }
  return <span className={cn("font-bold tabular-nums", successTone(row.successRate))}>{row.successRate.toFixed(1)}%</span>;
}

/** Bảng GTC dùng chung cho khoảng chờ / miền / vùng / tỉnh / nguồn — cùng cột, cùng nghĩa. */
function RateTable({ rows, head, minSample, total }: { rows: RateRow[]; head: string; minSample: number; total?: RateRow }) {
  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[760px]">
        <TableHeader>
          <TableRow>
            <TableHead>{head}</TableHead>
            <TableHead className="text-right">Đơn</TableHead>
            <TableHead className="text-right">Giao TC</TableHead>
            <TableHead className="text-right">Hoàn</TableHead>
            <TableHead className="text-right">Đã kết thúc</TableHead>
            <TableHead className="text-right">GTC</TableHead>
            <TableHead className="text-right">Đang giao</TableHead>
            <TableHead className="text-right">Huỷ trước gửi</TableHead>
            <TableHead className="text-right">DT mất do hoàn</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[...rows, ...(total ? [total] : [])].map((r) => (
            <TableRow key={r.key} className={cn(r === total && "bg-muted/40 font-bold hover:bg-muted/40")}>
              <TableCell className="font-medium whitespace-nowrap">{r.label}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(r.orders)}</TableCell>
              <TableCell className="text-right tabular-nums text-emerald-700 dark:text-emerald-400">{formatNumber(r.delivered)}</TableCell>
              <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">{formatNumber(r.returned)}</TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">{formatNumber(r.finished)}</TableCell>
              <TableCell className="text-right">
                <Rate row={r} minSample={minSample} />
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(r.inTransit)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(r.cancelledBeforeShip)}</TableCell>
              <TableCell className="text-right">
                <Money value={r.returnedValue} className="text-rose-600 dark:text-rose-400" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * ═══════════ CHỜ HÀNG & GIAO THÀNH CÔNG ═══════════
 *
 * Thứ tự khối là thứ tự ra quyết định: số liệu tóm tắt → ĐỀ XUẤT (có căn cứ) → bao nhiêu đơn chờ
 * mỗi ngày → chờ lâu có làm GTC tụt không → vùng nào yếu → tách hai yếu tố (bảng chéo) → đơn nào
 * đang chờ, phải gọi ai trước. Chỉ đọc: không nút nào ở đây ghi dữ liệu.
 */
export default async function StockWaitReportPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  // Nằm trong khu Vận đơn (chủ shop yêu cầu 25/09/2026) ⇒ cùng quyền và phạm vi với trang Vận đơn & care.
  const { decision } = await requireResource("SHIPMENTS", "shipments:view");
  if (decision.allow === "NONE") return <ScopeDenied title="Chờ hàng & giao thành công" reason={decision.reason} fix={decision.fix} />;
  const raw = await searchParams;
  const params = parseListParams(raw, { defaultSort: "wait", defaultDir: "desc", filterKeys: ["origin", "product"], sortable: [], defaultPeriod: "90d", defaultPageSize: 50 });
  // MỐC BẮT ĐẦU TÍNH NGÀY CHỜ là một bộ lọc thật (chủ shop yêu cầu 25/09/2026): lên đơn hay xác nhận đơn.
  const origin = parseWaitOrigin(params.filters.origin?.[0]);
  const codes = params.filters.product ?? [];
  const [d, danhMucMa] = await Promise.all([getStockWaitReport(params.period, { origin, codes }), listProductCodes()]);
  const pf = d.productFilter;
  const originText = WAIT_ORIGIN_LABEL[origin].toLowerCase();
  const { report: r, breakpoint: bp } = d;
  const m = r.minSample;
  const oldest = d.current[0];
  const erpNow = d.current.filter((o) => o.sources.includes("ERP")).length;
  const shown = d.current.slice(0, CURRENT_LIST_LIMIT);
  const matrixHasData = r.matrix.some((row) => row.cells.some((c) => c.finished > 0));

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Giao vận"
        title="Chờ hàng & giao thành công"
        hint={
          <>
            <p>
              <b>Số ngày chờ</b> = từ <b>mốc bắt đầu</b> (chọn ở bộ lọc: lúc lên đơn, hoặc lúc đơn rời nhóm chờ trên Pancake) tới lúc ĐVVC <b>thật sự cầm hàng</b> (mốc bàn giao có chứng từ), bất kể chờ vì thiếu hàng hay vì kho chậm. Đơn chưa gửi, hoặc không có mốc bắt đầu đang chọn, không có số ngày chờ đo được — đếm riêng.
            </p>
            <p className="mt-1.5">
              <b>GTC</b> = giao thành công ÷ (giao thành công + hoàn), theo kết quả đơn chuẩn của ERP. Nhóm dưới {m} đơn đã kết thúc in &ldquo;—&rdquo;: chưa đủ dữ liệu, không phải 0%. Kỳ lọc theo <b>ngày lên đơn</b>.
            </p>
            <p className="mt-1.5">Bảng đo TƯƠNG QUAN. Bảng chéo chờ × miền dùng để tách hiệu ứng ngày chờ khỏi hiệu ứng vùng.</p>
          </>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/shipments">
                <ArrowLeft className="size-4" /> Vận đơn & care
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/inventory/shortage">
                <PackageX className="size-4" /> Thiếu hàng giao đơn
              </Link>
            </Button>
          </div>
        }
      />

      <DataTableToolbar
        period={{ defaultKey: "90d" }}
        facets={[
          { key: "origin", label: "Tính ngày chờ", options: WAIT_ORIGINS.map((x) => ({ value: x, label: WAIT_ORIGIN_LABEL[x] })), single: true },
          // Áp cho MỌI khối bên dưới — một bộ lọc, một tập đơn.
          { key: "product", label: "Mã hàng", options: danhMucMa.map((p) => ({ value: p.code, label: `${p.code} · ${p.name}` })) },
        ]}
        resultLabel={
          <span className="inline-flex flex-wrap items-center gap-1">
            Ngày chờ: <b>{originText}</b> tới lúc ĐVVC cầm hàng
            <InfoHint>{WAIT_ORIGIN_QUESTION[origin]}</InfoHint>
            {pf ? (
              <span className="rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">
                Mã hàng: {pf.codes.join(", ")} · áp cho mọi khối
                {pf.unknown.length ? <span className="ml-1 text-rose-600 dark:text-rose-400">(không tìm thấy mã {pf.unknown.join(", ")})</span> : null}
              </span>
            ) : null}
          </span>
        }
      />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Đơn đang chờ hàng"
          value={formatNumber(d.current.length)}
          note={`ERP ${formatNumber(erpNow)} · chỉ Pancake ${formatNumber(d.pancakeOnlyWaiting)}`}
          hint="ERP = phép phân bổ tồn thực tế kết luận đơn đã chốt không đủ hàng. Pancake = đơn nhân viên đặt ở nhóm trạng thái “Chờ hàng” (nằm ngoài phép phân bổ)."
          icon={PackageX}
          tone={d.current.length ? "rose" : "slate"}
        />
        <MetricCard
          label="Chờ lâu nhất"
          value={oldest && oldest.waitDays !== null ? `${oldest.waitDays.toFixed(1)} ngày` : "—"}
          note={oldest && oldest.waitDays !== null ? `#${oldest.systemId ?? "?"} · ${oldest.customer}` : d.current.length ? "Chưa đơn nào có mốc bắt đầu đang chọn" : "Không đơn nào đang chờ"}
          hint={`Tính ${originText} tới bây giờ.`}
          icon={AlarmClock}
          tone={oldest ? "amber" : "slate"}
        />
        <MetricCard
          label={bp ? `GTC: gửi < ${bp.fromDays} ngày / chờ lâu hơn` : "GTC toàn kỳ"}
          value={bp ? `${bp.beforeRate.toFixed(1)}% / ${bp.afterRate.toFixed(1)}%` : r.overall.successRate === null ? "—" : `${r.overall.successRate.toFixed(1)}%`}
          note={bp ? `Chênh ${(bp.beforeRate - bp.afterRate).toFixed(1)} điểm · z = ${bp.z.toFixed(1)}` : `${formatNumber(r.overall.finished)} đơn đã kết thúc · chưa thấy điểm gãy theo ngày chờ`}
          hint="Điểm gãy = ranh giới ngày chờ mà GTC phía chờ lâu thấp hơn phía gửi sớm có ý nghĩa thống kê (mức tin cậy 95%). Không có ranh giới nào đạt thì không kết luận."
          icon={Timer}
          tone={bp ? "rose" : "slate"}
        />
        <MetricCard
          label="Đơn trong kỳ chưa gửi"
          value={formatNumber(r.openOrders)}
          note={`${formatNumber(r.overall.orders)} đơn lên trong kỳ${r.anomalyOrders ? ` · ${formatNumber(r.anomalyOrders)} đơn thiếu / ngược mốc` : ""}${r.noOriginOrders ? ` · ${formatNumber(r.noOriginOrders)} đơn không có mốc bắt đầu` : ""}`}
          hint="Chưa bàn giao, chưa huỷ: chưa biết sẽ chờ bao lâu nên nằm ngoài mọi khoảng. Thiếu / ngược mốc = đơn đã có kết cục mà không có mốc bàn giao, hoặc mốc bàn giao trước mốc bắt đầu. Không có mốc bắt đầu = đã gửi / đã huỷ mà không có mốc đang chọn (mốc xác nhận cần lịch sử trạng thái Pancake), hoặc bị huỷ khi chưa từng xác nhận — không bị tính theo mốc kia, không tính là chờ 0 ngày."
          icon={MapPin}
          tone="slate"
        />
      </section>

      <SectionCard title="Đề xuất vận hành" description="Mỗi đề xuất kèm căn cứ bằng số của chính trang này" padded={false}>
        <ul className="grid gap-2 p-4 lg:grid-cols-2">
          {d.recommendations.map((x) => (
            <li key={x.key} className={cn("rounded-xl border px-4 py-3", TONE[x.tone])}>
              <div className="flex items-start gap-2">
                <Lightbulb className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-semibold">
                    {x.title}
                    {x.estimated ? <span className="ml-1.5 rounded bg-muted px-1 text-[10.5px] font-medium text-muted-foreground">ước tính</span> : null}
                  </p>
                  <p className="text-xs text-muted-foreground">{x.evidence}</p>
                  <p className="text-xs">
                    <b>Làm gì:</b> {x.action}
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard
        title="Số đơn chờ hàng theo ngày"
        description={d.erpSince ? `Sổ ERP ghi từ ${formatDateTime(d.erpSince)} — ngày trước đó chưa đo` : "Sổ ERP chưa ghi lần nào — cột ERP trống là chưa đo, không phải 0"}
        hint="Một đơn được tính vào một ngày nếu nó ở trạng thái chờ hàng vào bất kỳ lúc nào trong ngày đó. Hai nguồn đứng cạnh nhau, không cộng: một đơn có thể nằm ở cả hai. Tối đa 60 ngày gần nhất của kỳ."
      >
        <DailyWaitingChart data={d.daily.map((x) => ({ day: x.day, erpWaiting: x.erpWaiting, pancakeWaiting: x.pancakeWaiting }))} />
      </SectionCard>

      <SectionCard
        title="GTC theo số ngày khách chờ"
        description={`${WAIT_ORIGIN_LABEL[origin]} tới lúc ĐVVC cầm hàng`}
        hint={`Huỷ trước gửi xếp theo số ngày từ lúc lên đơn tới lúc huỷ (lịch sử trạng thái Pancake) và không vào GTC. Khoảng dưới ${m} đơn đã kết thúc không có cột.`}
        padded={false}
      >
        <div className="border-b p-4">
          <WaitRateChart data={r.byWait.map((x) => ({ label: x.label, rate: x.successRate, finished: x.finished }))} />
        </div>
        <RateTable rows={r.byWait} head="Số ngày chờ" minSample={m} />
      </SectionCard>

      <SectionCard
        title="GTC theo miền, vùng"
        description="Theo tỉnh nhận hàng trên đơn"
        hint="Miền luôn đúng. Vùng theo 6 vùng kinh tế – xã hội; tỉnh mới 2025 gộp qua hai vùng (Gia Lai, Đắk Lắk, Lâm Đồng, Quảng Ngãi, Phú Thọ, Bắc Ninh, Tây Ninh) xếp theo tỉnh cũ cùng tên nên vùng là gần đúng."
        actions={
          r.unknownRegion.orders || r.approxRegionOrders ? (
            <DataWarnings
              align="end"
              items={[
                ...(r.unknownRegion.orders ? [<span key="u">{formatNumber(r.unknownRegion.orders)} đơn chưa quy được về vùng (tỉnh trống / chữ lạ) — nằm ngoài bảng miền, vùng; vẫn có trong bảng theo tỉnh.</span>] : []),
                ...(r.approxRegionOrders ? [<span key="a">{formatNumber(r.approxRegionOrders)} đơn ở tỉnh mới gộp qua hai vùng — vùng gần đúng, miền vẫn đúng.</span>] : []),
              ]}
            />
          ) : undefined
        }
        padded={false}
      >
        <RateTable rows={r.byMien} head="Miền" minSample={m} />
        <div className="border-t" />
        <RateTable rows={r.byVung} head="Vùng" minSample={m} />
        <details className="border-t">
          <summary className="cursor-pointer px-5 py-2.5 text-xs font-medium text-primary">Theo tỉnh ({formatNumber(r.byProvince.length)} tỉnh, nhiều đơn nhất trước)</summary>
          <RateTable rows={r.byProvince.map((p) => ({ ...p, label: `${p.label}${p.mien ? ` · ${MIEN_LABEL[p.mien]}` : " · chưa rõ vùng"}${p.approxRegion ? " *" : ""}` }))} head="Tỉnh" minSample={m} />
        </details>
      </SectionCard>

      <SectionCard
        title="Bảng chéo: số ngày chờ × miền"
        description="GTC trong từng ô · số dưới là đơn đã kết thúc"
        hint="Nếu GTC tụt theo ngày chờ TRONG CÙNG một miền thì đó là hiệu ứng của việc chờ, không phải vùng xa đội lốt. Ô chưa đủ mẫu in “—”."
        padded={false}
      >
        {matrixHasData ? (
          <div className="overflow-x-auto">
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Miền</TableHead>
                  {WAIT_BUCKETS.map((b) => (
                    <TableHead key={b.key} className="text-center">
                      {b.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.matrix.map((row) => (
                  <TableRow key={row.mien}>
                    <TableCell className="font-medium whitespace-nowrap">{row.label}</TableCell>
                    {row.cells.map((c) => (
                      <TableCell key={c.key} className="text-center">
                        <Rate row={c} minSample={m} />
                        <span className="block text-[10.5px] text-muted-foreground">{formatNumber(c.finished)}</span>
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="px-5 py-4 text-sm text-muted-foreground">Chưa có đơn đã kết thúc nào quy được về miền trong kỳ.</p>
        )}
      </SectionCard>

      <SectionCard
        title="GTC theo nguồn ghi nhận thiếu hàng"
        description="Đơn từng chờ hàng so với đơn không ghi nhận"
        hint="ERP = sổ đơn chờ hàng (chỉ có từ ngày sổ được bật). Pancake = đơn từng ở nhóm trạng thái “Chờ hàng”. Đơn ở cả hai nguồn xếp vào ERP."
        padded={false}
      >
        <RateTable rows={r.bySegment} head="Nguồn" minSample={m} total={r.overall} />
      </SectionCard>

      <SectionCard
        title={`Đơn đang chờ hàng — ${formatNumber(d.current.length)} đơn`}
        description={`Chờ lâu nhất trước · đo lúc ${formatDateTime(d.measuredAt)}`}
        hint="GTC lịch sử của nhóm = GTC của đơn đã kết thúc cùng khoảng ngày chờ và cùng miền (rơi về cùng khoảng ngày chờ nếu ô chéo chưa đủ mẫu). Là con số của NHÓM, không phải dự báo cho riêng đơn này."
        padded={false}
      >
        {d.current.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">Không đơn nào đang chờ hàng.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[1000px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Đơn</TableHead>
                  <TableHead className="text-right">Đã chờ</TableHead>
                  <TableHead>Nơi nhận</TableHead>
                  <TableHead>Nguồn</TableHead>
                  <TableHead>Thiếu</TableHead>
                  <TableHead className="text-right">Giá trị</TableHead>
                  <TableHead className="text-right">
                    GTC nhóm <InfoHint label="GTC lịch sử của nhóm">Đơn đã kết thúc cùng khoảng ngày chờ (và cùng miền nếu đủ mẫu). Không phải dự báo cho riêng đơn này.</InfoHint>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((o) => (
                  <TableRow key={o.orderId}>
                    <TableCell className="max-w-[220px]">
                      <Link href={`/orders/${o.orderId}`} className="block truncate font-medium hover:text-primary hover:underline">
                        #{o.systemId ?? "?"} · {o.customer}
                      </Link>
                      <span className="text-[11px] text-muted-foreground">lên {formatDate(o.insertedAt)}</span>
                    </TableCell>
                    <TableCell className={cn("text-right tabular-nums whitespace-nowrap", bp && o.waitDays !== null && o.waitDays >= bp.fromDays && "font-semibold text-rose-600 dark:text-rose-400")}>
                      {o.waitDays === null ? <span className="text-muted-foreground" title="Đơn chưa có mốc bắt đầu đang chọn (vd chưa xác nhận trên Pancake)">chưa xác nhận</span> : `${o.waitDays.toFixed(1)} ngày`}
                    </TableCell>
                    <TableCell className="text-xs">
                      {o.province || <span className="text-muted-foreground">(trống)</span>}
                      <span className="block text-[10.5px] text-muted-foreground">{o.vung ? VUNG_LABEL[o.vung] : "chưa rõ vùng"}</span>
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{o.sources.map((x) => (x === "ERP" ? "ERP" : "Pancake")).join(" + ")}</TableCell>
                    <TableCell className="max-w-[260px] truncate text-xs" title={o.shortText}>
                      {o.shortText || <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-right text-xs">{formatVND(o.value)}</TableCell>
                    <TableCell className="text-right text-xs">
                      {o.expectedRate === null ? <span className="text-muted-foreground">—</span> : <span className="tabular-nums">{o.expectedRate.toFixed(1)}%</span>}
                      {o.expectedBasis === "WAIT" ? <span className="block text-[10px] text-muted-foreground">theo ngày chờ</span> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {d.current.length > shown.length ? (
              <p className="border-t px-5 py-2.5 text-xs text-muted-foreground">
                … và {formatNumber(d.current.length - shown.length)} đơn nữa (chờ ngắn hơn) — xem ở{" "}
                <Link href="/inventory/shortage" className="font-medium text-primary hover:underline">
                  Thiếu hàng giao đơn
                </Link>
                .
              </p>
            ) : null}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

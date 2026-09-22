import Link from "next/link";
import { AlertTriangle, Users } from "lucide-react";
import { SectionCard } from "@/components/ui-bits";
import { CARRIER_SUBSTATE_LABEL, type CarrierSubstate } from "@/lib/constants/carrier-substate";
import { MARKETER_COVERAGE_WARN_PCT, MARKETER_LINK_FIX } from "@/lib/constants/marketer-attribution";
import { ALERT_MIN_SAMPLE, PROBLEM_LABEL, RISK_HINT, RISK_LABEL, RISK_TONE } from "@/lib/constants/return-intelligence";
import { TableToolsFor } from "@/components/data-table/table-tools";
import { STICKY_HEAD, TABLE_SCROLL } from "@/lib/constants/table-ux";
import { formatNumber, formatVND } from "@/lib/format";
import type { ReturnIntelligence } from "@/lib/queries/return-intelligence";
import { cn } from "@/lib/utils";

const PCT = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);

/* ═══════════════════ ĐỘ PHỦ DỮ LIỆU ═══════════════════ */

/**
 * ═══ MỘT BÁO CÁO PHẢI NÓI NÓ ĐANG ĐỨNG TRÊN BAO NHIÊU PHẦN DỮ LIỆU ═══
 *
 * Ba con số này đặt NGAY DƯỚI thẻ KPI chứ không ở chân trang. Đo trên production 14/09/2026:
 * `shipment_return_reasons` RỖNG và `shipments.vtp_reason_code` NULL cho cả 2.108 vận đơn — nghĩa
 * là mọi lý do hoàn hiện nay đều suy từ CHỮ trong sự kiện ĐVVC. Một người đọc không biết điều đó
 * sẽ đọc bảng lý do như một bản kiểm kê, trong khi nó là một bản suy luận trên phần dữ liệu đã thu.
 *
 * Chỗ trống KHÔNG được in ra thành 0 (AGENTS.md mục 42): `null` ⇒ "—".
 */
export function CoverageStrip({ coverage }: { coverage: ReturnIntelligence["coverage"] }) {
  const o = [
    { key: "reason", label: "Độ phủ lý do hoàn", v: coverage.reason, hint: "Đơn hoàn xác định được lý do ÷ tổng đơn hoàn. Nguồn hiện tại là CHỮ trong sự kiện Viettel Post — chưa có mã lý do có cấu trúc và chưa ai xác nhận tay ca nào." },
    { key: "marketer", label: "Độ phủ quy kết marketer", v: coverage.marketer, hint: "Đơn nối được về một chiến dịch có đúng một người phụ trách ÷ tổng đơn trong tập. Phần còn lại nằm ở nhóm “Chưa xác định” — KHÔNG bị ép cho ai." },
    { key: "sku", label: "Độ phủ mã hàng", v: coverage.sku, hint: "Đơn lần được về ít nhất một mã hàng ÷ tổng đơn. Dòng hàng gõ tay không có variant_id nằm ngoài — và KHÔNG được đoán mã từ tên hàng." },
  ];
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {o.map((x) => {
        const thap = x.v.pct !== null && x.v.pct < (x.key === "marketer" ? MARKETER_COVERAGE_WARN_PCT : 70);
        return (
          <div key={x.key} className={cn("rounded-lg border px-3 py-2", thap ? "border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30" : "border-hairline")} title={x.hint}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[12px] text-muted-foreground">{x.label}</span>
              <span className={cn("numeric text-sm font-bold", thap ? "text-amber-700 dark:text-amber-300" : "")}>{PCT(x.v.pct)}</span>
            </div>
            <div className="text-[11px] text-muted-foreground">
              {formatNumber(x.v.known)} / {formatNumber(x.v.total)}
              {thap ? " · thấp — con số bên dưới chỉ đúng cho phần đã thu được" : ""}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════ SO KỲ ═══════════════════ */

export function ComparePeriod({ compare }: { compare: ReturnIntelligence["compare"] }) {
  const { current, previous, successDelta, returnDelta } = compare;
  if (!previous.finished) {
    return <p className="text-[12px] text-muted-foreground">Không có kỳ trước cùng độ dài để so — chọn một kỳ có mốc đầu và mốc cuối (7 ngày · 30 ngày · 90 ngày · tuỳ chọn).</p>;
  }
  const o = (label: string, cur: number | null, prev: number | null, d: number | null, chieuTot: "UP" | "DOWN") => (
    <div className="rounded-lg border border-hairline px-3 py-2">
      <div className="text-[12px] text-muted-foreground">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className="numeric text-[13px] text-muted-foreground">{PCT(prev)}</span>
        <span className="text-muted-foreground">→</span>
        <span className="numeric text-lg font-bold">{PCT(cur)}</span>
        {d !== null ? (
          <span className={cn("numeric text-[12px] font-semibold", d > 0 ? "text-emerald-600 dark:text-emerald-400" : d < 0 ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground")} title={chieuTot === "DOWN" ? "Tỷ lệ hoàn CÀNG THẤP CÀNG TỐT — dấu đã quy theo chiều, dương nghĩa là tốt lên." : "Dương nghĩa là tốt lên."}>
            {d > 0 ? "+" : ""}
            {d.toFixed(1)}pp
          </span>
        ) : null}
      </div>
    </div>
  );
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-3">
        {o("Tỷ lệ giao thành công", current.successRate, previous.successRate, successDelta, "UP")}
        {o("Tỷ lệ hoàn", current.returnRate, previous.returnRate, returnDelta, "DOWN")}
        <div className="rounded-lg border border-hairline px-3 py-2">
          <div className="text-[12px] text-muted-foreground">Đơn đã kết thúc</div>
          <div className="flex items-baseline gap-1.5">
            <span className="numeric text-[13px] text-muted-foreground">{formatNumber(previous.finished)}</span>
            <span className="text-muted-foreground">→</span>
            <span className="numeric text-lg font-bold">{formatNumber(current.finished)}</span>
          </div>
        </div>
      </div>
      {compare.immatureNote ? (
        <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            <b>Cohort chưa chín.</b> {compare.immatureNote}
          </span>
        </p>
      ) : null}
    </div>
  );
}

/* ═══════════════════ RỦI RO THEO MÃ HÀNG ═══════════════════ */

export function ProductRiskTable({ rows, hasTarget }: { rows: ReturnIntelligence["products"]; hasTarget: boolean }) {
  if (!rows.length) return <p className="p-3 text-[12px] text-muted-foreground">Kỳ này chưa có mã hàng nào lần được về một đơn đã kết thúc.</p>;
  return (
    <>
      {!hasTarget ? (
        <p className="mb-2 rounded-md border border-hairline bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">
          Chưa ai đặt mục tiêu cho chỉ số <b>Tỷ lệ giao thành công</b>, nên bảng này <b>hiện thực tế và vẫn xếp hạng</b> nhưng không kết luận mã nào đạt hay không đạt. Đặt mục tiêu ở{" "}
          <Link className="underline underline-offset-2" href="/work/settings#muc-tieu-chi-so">
            Công việc → Cấu hình → Mục tiêu chỉ số
          </Link>
          {" "}— đặt một mức chung cho cả shop, và mức riêng cho từng mã nếu mã đó có đặc thù.
        </p>
      ) : null}
      <TableToolsFor tableId="hoan-canh-bao" />
      <div className={TABLE_SCROLL}>
        <table id="hoan-canh-bao" className="w-full min-w-[880px] text-sm">
          <thead className={cn(STICKY_HEAD, "text-[11.5px] uppercase tracking-wide text-muted-foreground")}>
            <tr>
              <th className="px-3 py-2 text-left font-semibold">Mã hàng</th>
              <th className="px-3 py-2 text-right font-semibold">Đã gửi</th>
              <th className="px-3 py-2 text-right font-semibold">GTC thực tế</th>
              <th className="px-3 py-2 text-right font-semibold">GTC ước tính</th>
              <th className="px-3 py-2 text-right font-semibold">Tỷ lệ hoàn</th>
              <th className="px-3 py-2 text-right font-semibold" title="So với kỳ trước cùng độ dài. Dương = HOÀN NHIỀU HƠN, tức xấu đi.">
                So kỳ trước
              </th>
              <th className="px-3 py-2 text-left font-semibold">Lớp vấn đề chính</th>
              <th className="px-3 py-2 text-left font-semibold">Đánh giá</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((p) => (
              <tr key={p.code}>
                <td className="px-3 py-1.5">
                  <Link href={`/shipments?view=all&period=all&product=${encodeURIComponent(p.code)}`} className="font-mono font-semibold hover:underline">
                    {p.code}
                  </Link>
                  <span className="ml-1.5 text-[11px] text-muted-foreground">{p.name}</span>
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums" title={`${formatNumber(p.delivered)} giao TC · ${formatNumber(p.failed)} hoàn · ${formatNumber(p.active)} chưa kết thúc`}>
                  {formatNumber(p.eligibleSent)}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums font-semibold">{PCT(p.actualRate)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground" title="PROJECTED_GTC_V3 — cùng hợp đồng với cột cùng tên ở bảng theo mẫu mã và ở Báo cáo lợi nhuận.">
                  {PCT(p.projectedRate)}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{PCT(p.returnRate)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {p.returnRateDelta === null ? (
                    <span className="text-muted-foreground" title={`Kỳ trước chưa đủ ${ALERT_MIN_SAMPLE.minFinished} đơn đã kết thúc để so.`}>
                      —
                    </span>
                  ) : (
                    <span className={cn(p.returnRateDelta > 0 ? "text-rose-600 dark:text-rose-400" : p.returnRateDelta < 0 ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")} title={`Kỳ trước ${PCT(p.prevReturnRate)}`}>
                      {p.returnRateDelta > 0 ? "+" : ""}
                      {p.returnRateDelta.toFixed(1)}pp
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-[12px]">
                  {p.dominantProblem ? (
                    <span title={p.topReasons.map((t) => `${t.label}: ${t.count}`).join(" · ")}>
                      {PROBLEM_LABEL[p.dominantProblem.problem]} <span className="text-muted-foreground">({p.dominantProblem.share.toFixed(0)}% ca đã biết lý do)</span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">chưa đủ ca có lý do</span>
                  )}
                </td>
                <td className="px-3 py-1.5">
                  <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap", RISK_TONE[p.risk])} title={`${RISK_HINT[p.risk]} ${p.riskReason}`}>
                    {RISK_LABEL[p.risk]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ═══════════════════ CHẤT LƯỢNG ĐẦU VÀO THEO MARKETER ═══════════════════ */

export function MarketerQualityTable({ rows, coverage }: { rows: ReturnIntelligence["marketers"]; coverage: ReturnIntelligence["marketerCoverage"] }) {
  if (!rows.length) return <p className="p-3 text-[12px] text-muted-foreground">Kỳ này chưa có đơn nào đi tới kết quả cuối.</p>;
  const tong = rows.reduce((n, r) => n + r.finished, 0);
  return (
    <>
      {coverage.warn ? (
        <p className="mb-2 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <Users className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Chỉ <b>{PCT(coverage.pct)}</b> đơn quy kết được về một marketer ({formatNumber(coverage.resolved)}/{formatNumber(coverage.total)}). Bảng vẫn ĐÚNG cho phần quy kết được, nhưng phần ấy có thể không đại
            diện cho toàn shop. {MARKETER_LINK_FIX.NO_CAMPAIGN}
          </span>
        </p>
      ) : null}
      <TableToolsFor tableId="hoan-theo-mau-ma" />
      <div className={TABLE_SCROLL}>
        <table id="hoan-theo-mau-ma" className="w-full min-w-[820px] text-sm">
          <thead className={cn(STICKY_HEAD, "text-[11.5px] uppercase tracking-wide text-muted-foreground")}>
            <tr>
              <th className="px-3 py-2 text-left font-semibold">Marketer</th>
              <th className="px-3 py-2 text-right font-semibold">Đơn đã kết thúc</th>
              <th className="px-3 py-2 text-right font-semibold">Giao TC</th>
              <th className="px-3 py-2 text-right font-semibold">Hoàn</th>
              <th className="px-3 py-2 text-right font-semibold">Tỷ lệ GTC</th>
              <th className="px-3 py-2 text-right font-semibold">Tỷ lệ hoàn</th>
              <th className="px-3 py-2 text-right font-semibold" title="Chênh điểm % của tỷ lệ hoàn so với toàn shop. Chỉ hiện khi đủ mẫu.">
                So mặt bằng
              </th>
              <th className="px-3 py-2 text-right font-semibold">Doanh thu mất</th>
              <th className="px-3 py-2 text-left font-semibold">Lý do nhiều nhất</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((m) => (
              <tr key={m.marketerId ?? "__unresolved__"} className={m.marketerId === null ? "bg-muted/30" : undefined}>
                <td className="px-3 py-1.5 font-medium">
                  {m.label}
                  {m.marketerId === null ? <div className="text-[11px] text-muted-foreground">không nối được về chiến dịch có người phụ trách — KHÔNG ép cho ai</div> : null}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(m.finished)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-emerald-700 dark:text-emerald-400">{formatNumber(m.delivered)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-rose-600 dark:text-rose-400">{formatNumber(m.returned)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums font-semibold">{PCT(m.successRate)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{PCT(m.returnRate)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {m.gapPoints === null ? (
                    <span className="text-muted-foreground" title={m.comparable ? "Toàn shop chưa có tỷ lệ để so." : `Mới ${m.finished} đơn — dưới ${ALERT_MIN_SAMPLE.minMarketerFinished}, chưa đủ để so với mặt bằng. Đây KHÔNG phải kết luận xấu.`}>
                      —
                    </span>
                  ) : (
                    <span className={cn(m.gapPoints > 0 ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400")}>
                      {m.gapPoints > 0 ? "+" : ""}
                      {m.gapPoints.toFixed(1)}pp
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{formatVND(m.lostRevenue, { compact: true })}</td>
                <td className="px-3 py-1.5 text-[12px]">{m.topReason ? `${m.topReason.label} (${m.topReason.count})` : <span className="text-muted-foreground">—</span>}</td>
              </tr>
            ))}
            <tr className="bg-muted/40 font-bold">
              <td className="px-3 py-1.5">Tổng — bằng đúng số đơn đã kết thúc khi KHÔNG chia theo marketer</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(tong)}</td>
              <td colSpan={7} />
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11.5px] text-muted-foreground">
        Quy kết đi bằng <b>khoá chiến dịch</b> (đơn → ad_id / post_id → chiến dịch → người phụ trách khai ở bảng chi tiêu), <b>không dò chữ trong tên chiến dịch</b>. Chiến dịch mang hai người
        phụ trách là nhập nhằng và đơn của nó nằm ở nhóm &ldquo;Chưa xác định&rdquo;. Con số dự báo ở bảng khác <b>không</b> được dùng để thưởng phạt — chỉ kết quả cuối.
      </p>
    </>
  );
}

/* ═══════════════════ CHĂM SÓC KIỆN ═══════════════════ */

export function CarePerformance({ care }: { care: ReturnIntelligence["care"] }) {
  if (!care.totalCases) {
    return <p className="p-3 text-[12px] text-muted-foreground">Kỳ này chưa có ca chăm sóc kiện nào. Hàng đợi chăm sóc chỉ mở ca cho kiện đã có sự cố giao hàng, nên không có ca là một tin tốt — nhưng cũng có thể là chưa ai mở.</p>;
  }
  return (
    <div className="space-y-3">
      <TableToolsFor tableId="hoan-theo-marketer" />
      <div className={TABLE_SCROLL}>
        <table id="hoan-theo-marketer" className="w-full min-w-[760px] text-sm">
          <thead className={cn(STICKY_HEAD, "text-[11.5px] uppercase tracking-wide text-muted-foreground")}>
            <tr>
              <th className="px-3 py-2 text-left font-semibold">Vào care từ trạng thái</th>
              <th className="px-3 py-2 text-right font-semibold">Ca</th>
              <th className="px-3 py-2 text-right font-semibold">Có người cầm</th>
              <th className="px-3 py-2 text-right font-semibold">Có thao tác</th>
              <th className="px-3 py-2 text-right font-semibold" title="Trung vị số giờ từ lúc mở ca tới thao tác đầu tiên.">
                Tới thao tác đầu
              </th>
              <th className="px-3 py-2 text-right font-semibold">Cuối cùng giao TC</th>
              <th className="px-3 py-2 text-right font-semibold">Cuối cùng hoàn</th>
              <th className="px-3 py-2 text-right font-semibold" title="Chỉ tính trên ca ĐÃ NGÃ NGŨ. Ca còn treo nằm ở cột riêng và KHÔNG vào tử/mẫu.">
                Tỷ lệ cứu
              </th>
              <th className="px-3 py-2 text-right font-semibold">Còn treo</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {care.byState.map((s) => (
              <tr key={s.state}>
                <td className="px-3 py-1.5">{CARRIER_SUBSTATE_LABEL[s.state as CarrierSubstate] ?? s.label}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(s.cases)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {formatNumber(s.withOwner)}
                  <span className="ml-1 text-[11px] text-muted-foreground">{s.cases ? `${Math.round((s.withOwner / s.cases) * 100)}%` : ""}</span>
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(s.withAction)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{s.hoursToFirstActionP50 === null ? <span className="text-muted-foreground">—</span> : `${s.hoursToFirstActionP50}h`}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-emerald-700 dark:text-emerald-400">{formatNumber(s.delivered)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-rose-600 dark:text-rose-400">{formatNumber(s.failed)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums font-semibold">{PCT(s.rescueRate)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{formatNumber(s.pending)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {care.byPic.length ? (
        <div>
          <p className="mb-1.5 text-[12px] font-medium">Theo người phụ trách</p>
          <div className="flex flex-wrap gap-2">
            {care.byPic.map((p) => (
              <div key={p.ownerEmail} className="rounded-lg border border-hairline px-3 py-2">
                <div className="text-[12.5px] font-medium">{p.ownerEmail}</div>
                <div className="numeric text-lg font-semibold">{p.comparable ? PCT(p.rescueRate) : "—"}</div>
                <div className="text-[10.5px] text-muted-foreground">
                  {p.comparable ? `${formatNumber(p.delivered)}/${formatNumber(p.delivered + p.failed)} ca đã ngã ngũ` : `mới ${formatNumber(p.delivered + p.failed)} ca ngã ngũ — chưa đủ để chấm`}
                  {p.pending ? ` · ${formatNumber(p.pending)} còn treo (ngoài phép tính)` : ""}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11.5px] text-muted-foreground">
            <b>Chỉ ca đã ngã ngũ mới dùng để chấm người.</b> Ca còn treo đếm riêng vì kết cục của nó chưa tồn tại — đưa vào mẫu số là chấm người bằng thứ chưa xảy ra. Và kết quả giao hàng do
            ĐVVC đồng quyết định, nên con số này là <b>kết quả chung</b>, đọc làm bối cảnh chứ không phải điểm cá nhân.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/* ═══════════════════ XU HƯỚNG ═══════════════════ */

/**
 * Một khối duy nhất, không phải mười biểu đồ. Ba đường trả lời ba câu: lô hàng to hay nhỏ, tỷ lệ
 * đã đo được bao nhiêu, và tỷ lệ cuối cùng dự kiến bao nhiêu.
 *
 * Rổ gần nhất LUÔN mỏng hơn (kiện chưa kịp ngã ngũ) nên cột "đã kết thúc" được in kèm — không có
 * nó thì đường GTC cuối biểu đồ trông như một cú lao dốc trong khi nó chỉ là cohort chưa chín.
 */
export function TrendSection({ trend }: { trend: ReturnIntelligence["trend"] }) {
  if (trend.points.length < 2) return <p className="p-3 text-[12px] text-muted-foreground">Chưa đủ hai mốc thời gian để vẽ xu hướng trong kỳ này.</p>;
  const max = Math.max(...trend.points.map((p) => p.eligibleSent), 1);
  return (
    <>
    <TableToolsFor tableId="hoan-theo-tinh" />
    <div className={TABLE_SCROLL}>
      <table id="hoan-theo-tinh" className="w-full min-w-[620px] text-sm">
        <thead className={cn(STICKY_HEAD, "text-[11.5px] uppercase tracking-wide text-muted-foreground")}>
          <tr>
            <th className="px-3 py-2 text-left font-semibold">{trend.grain === "WEEK" ? "Tuần bắt đầu" : "Ngày"}</th>
            <th className="px-3 py-2 text-left font-semibold">Đã gửi</th>
            <th className="px-3 py-2 text-right font-semibold">Đã kết thúc</th>
            <th className="px-3 py-2 text-right font-semibold">GTC thực tế</th>
            <th className="px-3 py-2 text-right font-semibold">GTC ước tính</th>
            <th className="px-3 py-2 text-right font-semibold">Tỷ lệ hoàn</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {trend.points.map((p) => {
            const ketThuc = p.delivered + p.failed;
            return (
              <tr key={p.at}>
                <td className="px-3 py-1 font-mono text-[12px]">{p.at}</td>
                <td className="px-3 py-1">
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-sky-500" style={{ width: `${Math.max(2, (p.eligibleSent / max) * 100)}%` }} />
                    </div>
                    <span className="numeric text-[12px]">{formatNumber(p.eligibleSent)}</span>
                  </div>
                </td>
                <td className="px-3 py-1 text-right tabular-nums text-muted-foreground" title={`${formatNumber(p.active)} kiện của rổ này còn đang đi`}>
                  {formatNumber(ketThuc)}
                </td>
                <td className="px-3 py-1 text-right tabular-nums font-semibold">{PCT(p.actualRate)}</td>
                <td className="px-3 py-1 text-right tabular-nums text-muted-foreground">{PCT(p.projectedRate)}</td>
                <td className="px-3 py-1 text-right tabular-nums">{PCT(p.returnRate)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    </>
  );
}

/** Khối bọc chung để trang chính gọn lại — tiêu đề + gợi ý + nội dung, không thêm một lớp thẻ nữa. */
export function IntelSection({ title, description, hint, children }: { title: string; description?: string; hint?: string; children: React.ReactNode }) {
  return (
    <SectionCard title={title} description={description} hint={hint} padded={false}>
      <div className="p-3">{children}</div>
    </SectionCard>
  );
}

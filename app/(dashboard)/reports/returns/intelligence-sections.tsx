import Link from "next/link";
import { SectionCard } from "@/components/ui-bits";
import { InfoHint } from "@/components/info-hint";
import { DataWarnings } from "@/components/data-warnings";
import { CARRIER_SUBSTATE_LABEL, type CarrierSubstate } from "@/lib/constants/carrier-substate";
import { MARKETER_COVERAGE_WARN_PCT, MARKETER_EVIDENCE, MARKETER_EVIDENCE_HINT, MARKETER_EVIDENCE_LABEL, MARKETER_LINK_FIX, MARKETER_LINK_LABEL, MARKETER_LINK_STATES, MARKETER_RESOLVED_STATES } from "@/lib/constants/marketer-attribution";
import { ALERT_MIN_SAMPLE, PROBLEM_LABEL, RISK_HINT, RISK_LABEL, RISK_TONE } from "@/lib/constants/return-intelligence";
import { TableToolsFor } from "@/components/data-table/table-tools";
import { STICKY_HEAD, TABLE_SCROLL } from "@/lib/constants/table-ux";
import { formatNumber, formatVND } from "@/lib/format";
import type { ReturnIntelligence } from "@/lib/queries/return-intelligence";
import { cn } from "@/lib/utils";

const PCT = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);

/** Giải thích cả ba đường quy kết, dựng một lần — mỗi dòng người đều treo cùng một câu. */
const EVIDENCE_TITLE = MARKETER_EVIDENCE.map((e) => `${MARKETER_EVIDENCE_LABEL[e]}: ${MARKETER_EVIDENCE_HINT[e]}`).join(`

`);

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
    { key: "marketer", label: "Độ phủ quy kết marketer", v: coverage.marketer, hint: "Đơn quy kết được về đúng một marketer ÷ tổng đơn trong tập — bằng chiến dịch quảng cáo, hoặc bằng fanpage người đó phụ trách TẠI MỐC ĐƠN LÊN. Phần còn lại nằm ở nhóm “Chưa xác định” — KHÔNG bị ép cho ai." },
    { key: "sku", label: "Độ phủ mã hàng", v: coverage.sku, hint: "Đơn lần được về ít nhất một mã hàng ÷ tổng đơn. Dòng hàng gõ tay không có variant_id nằm ngoài — và KHÔNG được đoán mã từ tên hàng." },
  ];
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {o.map((x) => {
        const thap = x.v.pct !== null && x.v.pct < (x.key === "marketer" ? MARKETER_COVERAGE_WARN_PCT : 70);
        return (
          <div key={x.key} className={cn("rounded-lg border px-3 py-2", thap ? "border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30" : "border-hairline")}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
                {x.label}
                <InfoHint>
                  <p>{x.hint}</p>
                  {thap ? <p className="mt-2">Độ phủ thấp — con số bên dưới chỉ đúng cho phần đã thu được.</p> : null}
                </InfoHint>
              </span>
              <span className={cn("numeric text-sm font-bold", thap ? "text-amber-700 dark:text-amber-300" : "")}>{PCT(x.v.pct)}</span>
            </div>
            <div className="text-[11px] text-muted-foreground">
              {formatNumber(x.v.known)} / {formatNumber(x.v.total)}
              {thap ? " · thấp" : ""}
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
      <DataWarnings
        items={[
          compare.immatureNote ? (
            <span key="cohort">
              <b>Cohort chưa chín.</b> {compare.immatureNote}
            </span>
          ) : null,
        ]}
      />
    </div>
  );
}

/* ═══════════════════ RỦI RO THEO MÃ HÀNG ═══════════════════ */

export function ProductRiskTable({ rows, hasTarget }: { rows: ReturnIntelligence["products"]; hasTarget: boolean }) {
  if (!rows.length) return <p className="p-3 text-[12px] text-muted-foreground">Kỳ này chưa có mã hàng nào lần được về một đơn đã kết thúc.</p>;
  return (
    <>
      {!hasTarget ? (
        <div className="mb-2">
          <DataWarnings
            items={[
              <span key="chua-dich">
                Chưa ai đặt mục tiêu cho chỉ số <b>Tỷ lệ giao thành công</b>, nên bảng này <b>hiện thực tế và vẫn xếp hạng</b> nhưng không kết luận mã nào đạt hay không đạt. Đặt mục tiêu ở{" "}
                <Link className="underline underline-offset-2" href="/work/settings#muc-tieu-chi-so">
                  Công việc → Cấu hình → Mục tiêu chỉ số
                </Link>
                {" "}— đặt một mức chung cho cả shop, và mức riêng cho từng mã nếu mã đó có đặc thù.
              </span>,
            ]}
          />
        </div>
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
  // Chỗ trống, chỉ những loại THỰC SỰ có đơn — in một dòng "0 đơn trùng" là thêm nhiễu, không thêm tin.
  const chuaXacDinh = MARKETER_LINK_STATES.filter((st) => !MARKETER_RESOLVED_STATES.includes(st))
    .map((state) => ({ state, n: coverage.byState[state] ?? 0 }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  // Loại chỗ trống LỚN NHẤT quyết định câu "việc phải làm" ở cảnh báo — gửi người đọc đi đúng màn hình.
  const thieuNhieuNhat = chuaXacDinh[0]?.state ?? null;
  return (
    <>
      {/*
        Cảnh báo độ phủ và cảnh báo mâu thuẫn (xem chú thích bên dưới) gom vào MỘT nhãn
        "⚠ n lưu ý dữ liệu" đứng ngay dòng "Quy kết bằng:" — nhìn thấy được, trỏ chuột mới hiện
        nguyên văn (chủ shop chốt 24/09/2026).
      */}
      {(() => {
        const canhBao = [
          coverage.warn ? (
            <span key="do-phu">
              Chỉ <b>{PCT(coverage.pct)}</b> đơn quy kết được về một marketer ({formatNumber(coverage.resolved)}/{formatNumber(coverage.total)}). Bảng vẫn ĐÚNG cho phần quy kết được, nhưng phần ấy có thể không đại
              diện cho toàn shop. {thieuNhieuNhat ? MARKETER_LINK_FIX[thieuNhieuNhat] : MARKETER_LINK_FIX.NO_CAMPAIGN}
            </span>
          ) : null,
          coverage.conflicts > 0 ? (
            <span key="mau-thuan">
              <b>{formatNumber(coverage.conflicts)}</b> đơn có chiến dịch quảng cáo và fanpage phụ trách trỏ về HAI người khác nhau. Bảng này ghi cho người của CHIẾN DỊCH; bảng lương đang ghi cho người
              của FANPAGE. Hai chỗ sẽ nói khác nhau về đúng những đơn này cho tới khi chủ shop chốt một bên.
            </span>
          ) : null,
        ];
        return canhBao.some(Boolean) ? (
          <div className="mb-2">
            <DataWarnings items={canhBao} />
          </div>
        ) : null;
      })()}
      {/*
        ═══ HAI ĐƯỜNG QUY KẾT, ĐẾM RIÊNG — VÀ CHỖ TRỐNG LÀ VIỆC PHẢI LÀM ═══

        Gộp hai đường thành một con số độ phủ là giấu mất điều người quản lý cần biết nhất: đơn đi
        bằng CHIẾN DỊCH nói "tiền của ai tạo ra đơn này", đơn đi bằng FANPAGE nói "đơn rơi vào page
        ai đang phụ trách". Hai mức chắc chắn khác nhau, nên chúng đứng cạnh nhau chứ không cộng
        vào nhau trong một ô duy nhất.

        Chỗ trống cũng vậy: mỗi loại sửa ở một màn hình khác, nên in con số kèm ĐÚNG việc phải làm.
      */}
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
        <span className="inline-flex items-center gap-1 font-medium text-foreground">
          Quy kết bằng:
          <InfoHint>
            Quy kết đi bằng <b>khoá</b>, không dò chữ trong tên chiến dịch hay tên page. Ba đường, xét theo thứ tự: (1) đơn → ad_id / post_id → <b>chiến dịch</b> → người phụ trách khai ở bảng chi tiêu;
            (2) đơn → <b>fanpage</b> → người phụ trách <b>tại mốc đơn lên</b> (ảnh chụp, nên đổi người phụ trách hôm nay không viết lại báo cáo tháng trước); (3) đơn <b>landing</b> không có fanpage → ô{" "}
            <b>UTM</b> của chính dòng form (ad_id → adset_id → campaign_id → tên chiến dịch khớp <b>tuyệt đối</b> từng ký tự). Chiến dịch mang hai người phụ trách là nhập nhằng; fanpage chưa gán người tại
            mốc ấy, và landing có tracking nhưng chưa dẫn về ai, cũng vậy — tất cả nằm ở nhóm &ldquo;Chưa xác định&rdquo; và <b>không</b> bị ép cho ai. Con số dự báo ở bảng khác <b>không</b> được dùng để
            thưởng phạt — chỉ kết quả cuối.
          </InfoHint>
        </span>
        {MARKETER_EVIDENCE.map((e) => (
          <span key={e} title={MARKETER_EVIDENCE_HINT[e]} className={coverage.byEvidence[e] ? undefined : "opacity-60"}>
            <b className="tabular-nums text-foreground">{formatNumber(coverage.byEvidence[e])}</b> {MARKETER_EVIDENCE_LABEL[e]}
          </span>
        ))}
        {chuaXacDinh.map((s) => (
          <span key={s.state} title={MARKETER_LINK_FIX[s.state]}>
            · <b className="tabular-nums text-foreground">{formatNumber(s.n)}</b> {MARKETER_LINK_LABEL[s.state].toLowerCase()}
          </span>
        ))}
      </div>
      {/*
        MÂU THUẪN GIỮA HAI ĐƯỜNG phải hiện, kể cả khi bằng 0 thì ẩn đi. Đo production 22/09/2026:
        0/720 đơn mà cả hai đường cùng lên tiếng bị mâu thuẫn. Ngày con số này khác 0, nó cũng là
        ngày bảng lương (khai thứ tự thẩm quyền NGƯỢC LẠI) bắt đầu nói khác bảng này về cùng một
        đơn — và đó là việc mang lên hỏi chủ shop, không phải việc tự chọn một bên.
      */}
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
                  {m.marketerId === null ? (
                    <span className="inline-flex items-center gap-1">
                      {m.label}
                      <InfoHint>Không nối được về chiến dịch, cũng không về fanpage có người phụ trách — KHÔNG ép cho ai.</InfoHint>
                    </span>
                  ) : (
                    m.label
                  )}
                  {m.marketerId !== null ? (
                    /*
                      CĂN CỨ ĐI THEO TÊN NGƯỜI, không nằm ở một cột riêng: bảng này đã 9 cột và
                      trần một màn hình là ~1.150px. Ô hai tầng giữ được cả hai con số mà không
                      phải bỏ cột nào.
                    */
                    <div className="text-[11px] text-muted-foreground" title={EVIDENCE_TITLE}>
                      {/*
                        Chỉ in loại bằng chứng THỰC SỰ có đơn. Một người chỉ chạy fanpage mà dòng
                        của họ vẫn in "0 theo UTM của landing" là ba con số cho một sự thật, và hai
                        trong ba là nhiễu.
                      */}
                      {MARKETER_EVIDENCE.filter((e) => m.byEvidence[e] > 0)
                        .map((e) => `${formatNumber(m.byEvidence[e])} ${MARKETER_EVIDENCE_LABEL[e]}`)
                        .join(" · ")}
                    </div>
                  ) : null}
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
              <td className="px-3 py-1.5">
                <span className="inline-flex items-center gap-1">
                  Tổng
                  <InfoHint>Bằng đúng số đơn đã kết thúc khi KHÔNG chia theo marketer.</InfoHint>
                </span>
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(tong)}</td>
              <td colSpan={7} />
            </tr>
          </tbody>
        </table>
      </div>
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
          <p className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium">
            Theo người phụ trách
            <InfoHint>
              <b>Chỉ ca đã ngã ngũ mới dùng để chấm người.</b> Ca còn treo đếm riêng vì kết cục của nó chưa tồn tại — đưa vào mẫu số là chấm người bằng thứ chưa xảy ra. Và kết quả giao hàng do
              ĐVVC đồng quyết định, nên con số này là <b>kết quả chung</b>, đọc làm bối cảnh chứ không phải điểm cá nhân.
            </InfoHint>
          </p>
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
export function IntelSection({ title, description, hint, children }: { title: string; description?: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <SectionCard title={title} description={description} hint={hint} padded={false}>
      <div className="p-3">{children}</div>
    </SectionCard>
  );
}

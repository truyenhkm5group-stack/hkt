import { deliveryRateCoverageParts } from "@/lib/constants/delivery-rate";
import { SectionCard } from "@/components/ui-bits";
import { InfoHint } from "@/components/info-hint";
import { formatNumber, formatPercent, formatVND } from "@/lib/format";
import { ArrowRight } from "lucide-react";
import { getAdsDecision, DECISION_METRIC_HINT } from "@/lib/queries/ads-decision";
import { ADS_DIMENSION_HAS_SPEND, type AdsDimension } from "@/lib/constants/ads-decision";
import { LEDGER_WINDOW_DAYS, vnDay } from "@/lib/constants/marketing-decision-ledger";
import { decisionStability } from "@/lib/queries/marketing-ledger";
import type { Stability } from "@/lib/marketing/decision-stability";
import { AdsDecisionTable } from "@/app/(dashboard)/ads/decision-table";
import { AdsDimensionTabs } from "@/app/(dashboard)/ads/dimension-tabs";
import type { Period } from "@/lib/search-params";
import { cn } from "@/lib/utils";

/**
 * ───────────── BỐN CON SỐ, KHÔNG PHẢI MƯỜI CÁI THẺ ─────────────
 *
 * Màn quảng cáo cũ bày ra hàng loạt thẻ bằng nhau, và vì cái nào cũng to như cái nào nên không thẻ
 * nào dẫn được mắt người đọc. Ở đây chỉ giữ đúng bốn số, và chúng là MỘT DÂY CHUYỀN có thứ tự:
 *
 *   đã tiêu bao nhiêu → thu về được bao nhiêu (doanh thu giao thành công) → còn lại bao nhiêu sau
 *   khi trừ hết (lợi nhuận góp sau quảng cáo) → bao nhiêu tiền chưa kết luận được.
 *
 * Con số thứ tư là con số hay bị giấu nhất, nên nó đứng ngang hàng với ba số kia: tiền đã tiêu thật
 * mà kết quả chưa ngã ngũ thì ba số đầu đang đẹp hơn sự thật đúng bằng chừng ấy.
 */
function Kpi({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: string }) {
  return (
    <div className="flex-1 rounded-lg border bg-card px-4 py-3">
      <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        {label}
        <InfoHint>{hint}</InfoHint>
      </p>
      <p className={cn("numeric mt-0.5 text-lg font-semibold", tone)}>{value}</p>
    </div>
  );
}

/**
 * ───────────── DẢI CHUỖI BÁN TRƯỚC — ĐỌC TỪ TRÁI SANG LÀ ĐỌC ĐÚNG ĐƯỜNG ĐI CỦA MỘT ĐƠN ─────────────
 *
 * Bốn thẻ phía trên trả lời "đã tiêu bao nhiêu, còn lại bao nhiêu". Dải này trả lời câu khác:
 * **tiền đang NẰM Ở ĐÂU trong chuỗi**. Với mô hình bán trước, hai câu ấy lệch nhau rất xa — doanh
 * số POS có thể đẹp trong khi phần lớn tiền còn kẹt ở xưởng, và lợi nhuận của kỳ chưa nói gì về nó.
 *
 * Mỗi mốc một chứng từ riêng: rời kho theo `SHIPMENT_LEFT_WAREHOUSE` · giao thành công theo
 * `ORDER_OUTCOME` · tiền về theo bảng kê ĐVVC. Không mốc nào suy ra từ mốc nào.
 */
function ChainStrip({ t }: { t: { bookedOrders: number; bookedRevenue: number; notShippedOrders: number; notShippedRevenue: number; inTransitOrders: number; inTransitRevenue: number; deliveredOrders: number; deliveredRevenue: number; returnedOrders: number; cashReceived: number } }) {
  const steps = [
    { label: "Chốt đơn (POS)", orders: t.bookedOrders, money: t.bookedRevenue, tone: "", hint: "Doanh số POS — khách đã chốt, CHƯA trừ hoàn và huỷ." },
    { label: "Chưa rời kho", orders: t.notShippedOrders, money: t.notShippedRevenue, tone: "text-amber-600 dark:text-amber-400", hint: "Đã chốt nhưng ĐVVC chưa lấy hàng — gồm cả SẢN XUẤT lẫn đóng gói. ERP không đo riêng được khâu xưởng vì phiếu gửi xưởng theo mã hàng chứ không theo đơn." },
    { label: "Đang trên đường", orders: t.inTransitOrders, money: t.inTransitRevenue, tone: "text-sky-600 dark:text-sky-400", hint: "Đã rời kho, chưa ngã ngũ. Tiền nhóm này CHƯA nằm trong lợi nhuận." },
    { label: "Giao thành công", orders: t.deliveredOrders, money: t.deliveredRevenue, tone: "text-emerald-600 dark:text-emerald-400", hint: "Theo ORDER_OUTCOME: chứng từ ĐVVC trước, rồi mới tới tiền thực thu." },
    { label: "Tiền đã về", orders: t.returnedOrders, money: t.cashReceived, tone: "text-foreground", hint: "Thực thu CÓ CHỨNG TỪ (bảng kê ĐVVC + chuyển trước). Số đơn in ở đây là số đơn HOÀN — chênh giữa doanh thu giao thành công và tiền đã về là tiền ĐVVC còn giữ." },
  ];
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card px-4 py-3 sm:flex-row sm:items-stretch">
      {steps.map((st, i) => (
        <div key={st.label} className="flex flex-1 items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              {st.label}
              <InfoHint>{st.hint}</InfoHint>
            </p>
            <p className={cn("numeric mt-0.5 text-sm font-semibold", st.tone)}>{formatVND(st.money)}</p>
            <p className="numeric text-[11px] text-muted-foreground">
              {formatNumber(st.orders)} đơn{i === steps.length - 1 ? " hoàn" : ""}
            </p>
          </div>
          {i < steps.length - 1 ? <ArrowRight className="hidden size-3.5 shrink-0 text-muted-foreground/40 sm:block" /> : null}
        </div>
      ))}
    </div>
  );
}

export async function AdsDecisionSection({ period, dimension }: { period: Period; dimension: AdsDimension }) {
  const d = await getAdsDecision(period, dimension);
  /*
    ─── ĐỘ BỀN ĐỌC TỪ SỔ, VÀ SỔ CÓ THỂ RỖNG ───

    Sổ chỉ đầy lên khi job `marketing-decision-ledger` chạy. Chưa bật thì mọi dòng đều `heldDays = 0`,
    và câu trả lời đúng là NÓI RA MỘT LẦN ở đầu bảng — không phải lặp "chưa đo" trên từng dòng, và
    càng không phải im lặng để người đọc tưởng mọi khuyến nghị đều mới toanh.
  */
  const stabilityMap = await decisionStability(dimension, d.rows.map((r) => r.key), vnDay(new Date()));
  const stability: Record<string, Stability> = Object.fromEntries(stabilityMap);
  const soDaChay = Object.values(stability).some((s) => s.heldDays > 0);
  const daChin = Object.values(stability).filter((s) => s.ready).length;
  const hasSpend = ADS_DIMENSION_HAS_SPEND[dimension];
  const lowCoverage = d.confidence.verdict === "DATA_INSUFFICIENT";
  // Chỉ dòng THẬT SỰ có khuyến nghị mới dùng tới một tỷ lệ; dòng bị từ chối kết luận thì không.
  const soDongTamTinh = d.rows.filter((r) => r.basis === "PROJECTED" && r.action !== "INSUFFICIENT_DATA" && r.action !== "NO_SPEND_DATA").length;
  const pendingSpend = d.pending.spendInsufficientData + d.pending.spendWithoutOrders;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Kpi label="Đã chi quảng cáo" value={hasSpend ? formatVND(d.totals.spend) : "—"} hint={DECISION_METRIC_HINT.spend} />
        <Kpi label="Doanh thu giao thành công" value={formatVND(d.totals.deliveredRevenue)} hint={DECISION_METRIC_HINT.deliveredRevenue} />
        <Kpi
          label="Lợi nhuận góp sau QC"
          value={hasSpend ? formatVND(d.totals.profitAfterAds) : "—"}
          hint={DECISION_METRIC_HINT.profitAfterAds}
          tone={hasSpend ? (d.totals.profitAfterAds >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400") : undefined}
        />
        <Kpi
          label="Tiền chưa kết luận được"
          value={hasSpend ? formatVND(pendingSpend) : "—"}
          hint="Tiền quảng cáo nằm ở những dòng chưa đủ dữ liệu để kết luận (ít tiền, ít đơn đã kết thúc, hoặc phần lớn đơn còn đang đi), cộng với tiền của chiến dịch không có đơn nào gắn vào. Ba con số bên trái đang đẹp hơn sự thật đúng bằng phần này."
          tone={pendingSpend > 0 ? "text-amber-600 dark:text-amber-400" : undefined}
        />
      </div>

      {/*
        DẢI CHUỖI ĐỨNG GIỮA bốn thẻ tiền và bảng quyết định, cố ý: nó là cầu nối giữa "tổng cộng bao
        nhiêu" và "từng dòng thế nào". Người đọc thấy tiền đang kẹt ở đâu TRƯỚC khi đi tìm dòng nào
        gây ra chuyện đó.
      */}
      <ChainStrip t={d.totals} />

      {/*
        Chỉ đếm dòng THẬT SỰ có khuyến nghị: dòng bị từ chối kết luận vẫn mang căn cứ PROJECTED
        (căn cứ là thuộc tính của dữ liệu, không phải của kết luận), nhưng nó không dùng tới tỷ lệ
        nào cả — gộp chúng vào sẽ thổi con số lên và làm dải cảnh báo mất trọng lượng.
      */}
      <SectionCard
        title="Bảng quyết định quảng cáo"
        description={`${period.label} · ${formatNumber(d.rows.length)} dòng · bấm vào dòng để xem đường đi của tiền`}
        hint="Mỗi dòng trả lời đúng một câu: nên làm gì với dòng này, và vì sao. Khuyến nghị đi qua các cổng theo thứ tự — TỪ CHỐI KẾT LUẬN trước, kết luận sau: không có số chi ⇒ không phán về tiền; ít tiền / ít đơn đã kết thúc / phần lớn đơn còn đang đi ⇒ 'chưa đủ dữ liệu'. Ngưỡng đặt ở lib/constants/ads-decision.ts."
        actions={<AdsDimensionTabs current={dimension} />}
        padded={false}
      >
        {/*
          ĐỘ PHỦ QUY KẾT ĐỨNG NGAY TRÊN BẢNG, CỐ Ý.
          Nếu chỉ 30% đơn nối được về quảng cáo thì mọi kết luận dưới đây nói về 30% đó, không phải
          về toàn shop. Con số vẫn đúng; đọc nó như thể nó nói về cả shop mới là tự lừa mình.
        */}
        <p
          className={cn(
            "border-b px-5 py-2 text-xs",
            lowCoverage ? "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300" : "text-muted-foreground",
          )}
        >
          Độ phủ quy kết{" "}
          {d.confidence.coveragePct === null ? "chưa đo được" : `${formatPercent(d.confidence.coveragePct)}`} (
          {formatNumber(d.confidence.attributedOrders)}/{formatNumber(d.confidence.attributableOrders)} đơn CÓ DẤU VẾT
          FACEBOOK nối được về quảng cáo).{" "}
          {d.confidence.notFromAdsOrders > 0 ? (
            <>
              {formatNumber(d.confidence.notFromAdsOrders)} đơn khác trong kỳ không có fanpage, bài viết hay mẩu quảng cáo nào — chúng chưa bao giờ đi
              qua quảng cáo nên đứng NGOÀI mẫu số này.{" "}
            </>
          ) : null}
          {d.confidence.coveragePct === null
            ? "Không có đơn nào trong phạm vi để đo."
            : lowCoverage
              ? `Dưới ngưỡng ${d.confidence.threshold}%: bảng này mô tả đúng PHẦN ĐƠN NỐI ĐƯỢC, không mô tả toàn shop. Phần còn lại cố ý không chia đều cho các chiến dịch.`
              : "Đủ để kết luận ở cấp chiến dịch."}{" "}
          Đây là CẬN DƯỚI: phần chưa nối được vẫn lẫn đơn hữu cơ nhắn thẳng vào fanpage mà ERP không tách ra được.
        </p>

        {/*
          ĐỘ PHỦ CHI TIẾT CẤP MẨU — chỉ nói ở hai cấp dưới, vì chỉ ở đó nó mới đổi cách đọc bảng.

          Lượt đồng bộ Facebook chỉ chạm N ngày gần nhất, nên ngày cũ mãi mãi ở hạt CHIẾN DỊCH và
          tiền của chúng KHÔNG xuất hiện ở cấp nhóm / cấp mẩu. Một bảng đọc thiếu tiền mà im lặng
          thì tệ hơn một bảng rỗng: người đọc tin vào một ROAS tính trên nửa số tiền.
        */}
        {(dimension === "adset" || dimension === "ad") && d.spendDetail.pct !== null && d.spendDetail.pct < 100 ? (
          <p className="border-b bg-sky-50 px-5 py-2 text-xs text-sky-800 dark:bg-sky-950/40 dark:text-sky-300">
            Mới {formatPercent(d.spendDetail.pct)} tiền quảng cáo của kỳ có chi tiết tới cấp mẩu ({formatVND(d.spendDetail.atAdGrain)} /{" "}
            {formatVND(d.spendDetail.total)}). Phần còn lại nằm ở những ngày ERP chỉ có số chi ở cấp CHIẾN DỊCH, và nó KHÔNG có mặt trong bảng này —
            cố ý, vì chia đều tiền chiến dịch xuống nhóm/mẩu sẽ làm tổng khớp trong khi từng dòng đều sai. Xem ở tab Chiến dịch để có đủ tiền của kỳ.
          </p>
        ) : null}

        {/*
          ═══════════ CĂN CỨ TỶ LỆ GTC — BẮT BUỘC ĐỨNG CẠNH MỌI CON SỐ TẠM TÍNH ═══════════

          Dòng nào chưa đủ đơn ngã ngũ thì khuyến nghị của nó đứng trên LỢI NHUẬN TẠM TÍNH, tức
          trên một tỷ lệ giao thành công lấy từ thang bậc (AGENTS.md mục 68). Thang ấy có bậc là
          SỐ ĐO của chính mã, và có bậc là MỤC TIÊU khai chung ở Giả định — hai thứ khác hẳn nhau
          về cách sửa khi sai, nên độ phủ phải in ra chứ không nằm trong một dấu ⓘ.

          Chỉ hiện khi bảng THẬT SỰ có dòng tạm tính: không dòng nào dùng tới tỷ lệ thì dải này chỉ
          là một câu chữ làm loãng màn hình.
        */}
        {soDongTamTinh > 0 ? (
          <p className="border-b px-5 py-2 text-xs text-muted-foreground">
            <b>{formatNumber(soDongTamTinh)}</b> dòng đang quyết trên <b>lợi nhuận tạm tính</b> — phần đơn chưa ngã ngũ được cân theo tỷ lệ giao thành
            công của thang bậc. Độ phủ trong kỳ: <b>{deliveryRateCoverageParts(d.rateBasis.coverage).total}</b> mã —{" "}
            {deliveryRateCoverageParts(d.rateBasis.coverage).parts.map((x, i) => (
              <span key={x.source}>
                {i ? " · " : ""}
                <b>{x.count}</b> {x.label.toLowerCase()}
                {x.source === "default" ? ` (MỤC TIÊU ${formatPercent(d.rateBasis!.fallbackDeliveryRate)})` : ""}
              </span>
            ))}
            .{" "}
            {(d.rateBasis.coverage.default ?? 0) > 0 ? (
              <>
                Mã chạy theo mục tiêu thì lợi nhuận tạm tính của nó đọc là <b>&ldquo;theo kế hoạch&rdquo;</b>, không phải &ldquo;sẽ về ngần ấy&rdquo; —
                mục tiêu không đạt là việc của khâu vận hành, không phải bằng chứng mô hình sai. Sửa mục tiêu ở Báo cáo → Giả định.{" "}
              </>
            ) : null}
            {d.rateBasis.projectionError ? <b>Mô hình dự báo lỗi ({d.rateBasis.projectionError}) — mọi mã đã lùi về lịch sử / mục tiêu.</b> : null}
          </p>
        ) : null}

        {/*
          SỔ QUYẾT ĐỊNH — TRÍ NHỚ CỦA BẢNG NÀY.

          Bảng trên trả lời "lúc này nên làm gì". Sổ trả lời "ERP có đang đổi ý xoành xoạch không" —
          câu mà một người ra quyết định cần, và là điều kiện tồn tại của bất kỳ cỗ máy tự chủ nào.
        */}
        <p className={cn("border-b px-5 py-2 text-xs", soDaChay ? "text-muted-foreground" : "bg-sky-50 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300")}>
          {soDaChay ? (
            <>
              Sổ quyết định: {formatNumber(daChin)}/{formatNumber(d.rows.length)} dòng đã chín (khuyến nghị giữ nguyên đủ số ngày và không đổi ý quá
              số lần cho phép). Sổ chạy trên KỲ CHUẨN {LEDGER_WINDOW_DAYS} ngày kết thúc hôm qua — không phải kỳ đang chọn ở trên, nên hai con số có
              thể nói khác nhau và cả hai đều đúng.
            </>
          ) : (
            <>
              Sổ quyết định CHƯA CHẠY, nên chưa đo được khuyến nghị nào ổn định hay đang nhảy qua nhảy lại. Bật bằng biến môi trường{" "}
              <code>MARKETING_LEDGER_EVERY_MINUTES</code> (gợi ý 30) hoặc chạy tay job <code>marketing-decision-ledger</code>. Sổ không dựng lại được
              quá khứ: mỗi ngày không chạy là một ngày mất hẳn.
            </>
          )}
        </p>

        <AdsDecisionTable rows={d.rows} dimension={dimension} stability={stability} />

        <div className="border-t px-5 py-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Phần chưa kết luận được (hiện riêng, không chia đều):</p>
          <ul className="mt-1 space-y-0.5">
            <li>
              {formatVND(d.pending.spendInsufficientData)} chi ở các dòng chưa đủ dữ liệu — chưa đủ tiền, chưa đủ đơn đã kết thúc, hoặc phần lớn đơn
              còn đang đi.
            </li>
            {d.pending.spendWithoutOrders ? <li>{formatVND(d.pending.spendWithoutOrders)} chi ở chiến dịch KHÔNG có đơn nào gắn vào — tiền đã mất dấu.</li> : null}
            <li>{formatNumber(d.pending.openOrders)} đơn chưa ngã ngũ: kết quả tiền của chúng chưa tính vào bảng này.</li>
          </ul>
        </div>
      </SectionCard>
    </div>
  );
}

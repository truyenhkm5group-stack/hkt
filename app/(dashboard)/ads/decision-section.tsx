import { SectionCard } from "@/components/ui-bits";
import { InfoHint } from "@/components/info-hint";
import { formatNumber, formatPercent, formatVND } from "@/lib/format";
import { getAdsDecision, DECISION_METRIC_HINT } from "@/lib/queries/ads-decision";
import { ADS_DIMENSION_HAS_SPEND, type AdsDimension } from "@/lib/constants/ads-decision";
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

export async function AdsDecisionSection({ period, dimension }: { period: Period; dimension: AdsDimension }) {
  const d = await getAdsDecision(period, dimension);
  const hasSpend = ADS_DIMENSION_HAS_SPEND[dimension];
  const lowCoverage = d.confidence.verdict === "DATA_INSUFFICIENT";
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
          Độ phủ quy kết {formatPercent(d.confidence.coveragePct)} ({formatNumber(d.confidence.attributedOrders)}/
          {formatNumber(d.confidence.totalOrders)} đơn nối được về quảng cáo).{" "}
          {lowCoverage
            ? `Dưới ngưỡng ${d.confidence.threshold}%: bảng này mô tả đúng PHẦN ĐƠN CÓ MÃ QUẢNG CÁO, không mô tả toàn shop. Phần còn lại cố ý không chia đều cho các chiến dịch.`
            : "Đủ để kết luận ở cấp chiến dịch."}
        </p>

        {!hasSpend ? (
          <p className="border-b bg-sky-50 px-5 py-2 text-xs text-sky-800 dark:bg-sky-950/40 dark:text-sky-300">
            Cấp này KHÔNG có số chi quảng cáo: Facebook Insights chỉ đồng bộ ở cấp chiến dịch/ngày. Không có tiền thì không có ROAS, không có lợi
            nhuận và do đó không có khuyến nghị về tiền — bảng xếp theo doanh thu giao thành công để thấy nhóm/mẩu nào thật sự đưa được hàng tới
            tay khách. Cố ý KHÔNG chia đều tiền chiến dịch xuống đây: chia đều làm tổng khớp trong khi từng dòng đều sai.
          </p>
        ) : null}

        <AdsDecisionTable rows={d.rows} dimension={dimension} />

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

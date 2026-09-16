import { InfoHint } from "@/components/info-hint";
import { SectionCard } from "@/components/ui-bits";
import {
  CASE_OUTCOMES,
  CASE_OUTCOME_HAS_HUMAN_CREDIT,
  CASE_OUTCOME_HINT,
  CASE_OUTCOME_IS_FINAL,
  CASE_OUTCOME_LABEL,
  PERIOD_BASIS_HINT,
  PERIOD_BASIS_LABEL,
  type PeriodBasis,
} from "@/lib/constants/care-effect";
import { getCareAudit } from "@/lib/queries/care-case-audit";
import { formatNumber, formatPercent } from "@/lib/format";
import type { Period } from "@/lib/search-params";
import { cn } from "@/lib/utils";

/**
 * ═══════════ KẾT CỤC CA CHĂM SÓC — CÔNG CỦA NGƯỜI TÁCH KHỎI MAY MẮN CỦA ĐVVC ═══════════
 *
 * Đo trên production 16/09/2026: trong 44 ca `care_outcome = RESCUED_DIRECT` ("Cứu được"), chỉ 17
 * ca có một hành động chăm sóc thật của người. Phần còn lại là **ĐVVC tự phục hồi** — kiện đi
 * `Chờ phát lại → Đang giao → Giao thành công` mà không ai gọi một cuộc nào.
 *
 * `care_outcome` không sai: nó đọc chứng từ ĐVVC, và đó đúng là việc của nó. Bảng này trả lời câu
 * còn lại — *ai đã làm gì trước khi điều đó xảy ra* — và cố ý in HAI dòng cạnh nhau để chênh lệch
 * không thể bị bỏ qua.
 *
 * KHÔNG có điểm tổng, KHÔNG có bảng xếp hạng nhân viên. Đây là dữ liệu để quản lý đọc, không phải
 * một con số để chấm người.
 */
export async function CaseOutcomeReport({ period, basis }: { period: Period; basis: PeriodBasis }) {
  const a = await getCareAudit({ from: period.from, to: period.to }, basis);
  const t = a.totals;

  if (!t.opened) {
    return (
      <SectionCard title="Kết cục ca chăm sóc" description={`Kỳ này không có ca nào ${PERIOD_BASIS_LABEL[basis]}.`}>
        <p className="text-sm text-muted-foreground">{PERIOD_BASIS_HINT[basis]}</p>
      </SectionCard>
    );
  }

  const phut = (v: number | null) =>
    v === null ? <span className="text-muted-foreground">chưa đủ mẫu</span> : v >= 120 ? `${(v / 60).toFixed(1)} giờ` : `${formatNumber(v)} phút`;

  return (
    <SectionCard
      title="Kết cục ca chăm sóc"
      description={`${formatNumber(t.opened)} ca ${PERIOD_BASIS_LABEL[basis]}`}
      hint={PERIOD_BASIS_HINT[basis]}
    >
      {/*
        ĐỘ PHỦ ĐỨNG TRƯỚC MỌI CON SỐ. Một trung vị tính trên 2/319 ca không phải một trung vị — và
        người đọc phải thấy điều đó trước khi thấy con số, không phải sau.
      */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <O nhan="Ca có hành động chăm sóc thật" so={`${formatNumber(t.withCareAction)}/${formatNumber(t.opened)}`} phu={`độ phủ ${formatPercent(t.firstActionCoverage * 100, 0)} — gọi · nhắn · sửa địa chỉ · báo bưu cục`} />
        <O nhan="Ca có người động vào" so={`${formatNumber(t.touched)}/${formatNumber(t.opened)}`} phu="rộng hơn: gồm cả đổi trạng thái và ghi chú. Giao việc KHÔNG tính." />
        <O nhan="Ca chưa ai động vào" so={formatNumber(t.untouched)} phu="không ai mở, không ai ghi, không ai gọi" xau={t.untouched > 0} />
        <O nhan="Ca đã chốt kết quả" so={`${formatNumber(t.resolved)}/${formatNumber(t.opened)}`} phu={`độ phủ ${formatPercent(t.outcomeCoverage * 100, 0)} theo chứng từ ĐVVC`} />
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <O nhan="Tới lúc giao người (trung vị)" so={phut(a.medians.toAssign)} phu={`mẫu tối thiểu ${a.minSample} ca`} />
        <O nhan="Tới hành động đầu (trung vị)" so={phut(a.medians.toFirstAction)} phu="từ lúc mở ca tới hành động chăm sóc ĐẦU TIÊN" />
        <O nhan="Tới lúc chốt (trung vị)" so={phut(a.medians.toResolution)} phu="từ lúc mở ca tới khi ĐVVC chốt kết quả" />
      </div>

      <div className="mt-4 overflow-x-auto rounded-md border">
        <table className="w-full text-[12.5px]">
          <thead className="bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="p-2 font-medium">Kết cục</th>
              <th className="p-2 text-right font-medium">Ca</th>
              <th className="p-2 font-medium">Nghĩa là gì</th>
            </tr>
          </thead>
          <tbody>
            {CASE_OUTCOMES.filter((o) => a.counts[o] > 0).map((o) => (
              <tr key={o} className="border-t align-top">
                <td className="p-2">
                  <span className="font-medium">{CASE_OUTCOME_LABEL[o]}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {CASE_OUTCOME_IS_FINAL[o] ? "đã ngã ngũ" : "chưa ngã ngũ — ngoài mọi tỷ lệ"}
                    {CASE_OUTCOME_HAS_HUMAN_CREDIT[o] ? " · có công của người" : ""}
                  </span>
                </td>
                <td className={cn("numeric p-2 text-right font-semibold", o === "DELIVERED_WITHOUT_MANUAL_CARE" && "text-amber-700 dark:text-amber-400")}>
                  {formatNumber(a.counts[o])}
                </td>
                <td className="p-2 text-[11.5px] leading-4 text-muted-foreground">{CASE_OUTCOME_HINT[o]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 flex items-start gap-2 text-[11.5px] text-muted-foreground">
        <InfoHint>
          Bảng này KHÔNG xếp hạng nhân viên và không có điểm tổng. “Giao được SAU khi có người chăm” là QUAN SÁT, không phải nhân quả: người xử lý
          chọn chăm ca nào, và thường chọn đơn to, khách quen, đơn còn cứu được.
        </InfoHint>
        <span>
          Kỳ đang lọc {PERIOD_BASIS_LABEL[basis]}. Đổi mốc lọc sẽ ra một TẬP CA khác, không phải cùng tập với con số khác.
        </span>
      </p>
    </SectionCard>
  );
}

function O({ nhan, so, phu, xau }: { nhan: string; so: React.ReactNode; phu: string; xau?: boolean }) {
  return (
    <div className="rounded-xl border p-3">
      <p className="text-[12.5px] font-medium text-muted-foreground">{nhan}</p>
      <p className={cn("numeric mt-1 text-xl font-bold", xau && "text-amber-700 dark:text-amber-400")}>{so}</p>
      <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{phu}</p>
    </div>
  );
}

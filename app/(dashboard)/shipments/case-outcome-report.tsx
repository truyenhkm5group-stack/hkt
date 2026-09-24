import { InfoHint } from "@/components/info-hint";
import { DataWarnings } from "@/components/data-warnings";
import { TableToolsFor } from "@/components/data-table/table-tools";
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
import { REOPEN_CLASSES, REOPEN_CLASS_HINT, REOPEN_CLASS_LABEL } from "@/lib/constants/care-reopen-class";
import { getCareAudit } from "@/lib/queries/care-case-audit";
import { formatDateTime, formatNumber, formatPercent } from "@/lib/format";
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
      <SectionCard title="Kết cục ca chăm sóc" description={`Kỳ này không có ca nào ${PERIOD_BASIS_LABEL[basis]}.`} hint={PERIOD_BASIS_HINT[basis]} padded={false}>
        {null}
      </SectionCard>
    );
  }

  const phut = (v: number | null) =>
    v === null ? <span className="text-muted-foreground">chưa đủ mẫu</span> : v >= 120 ? `${(v / 60).toFixed(1)} giờ` : `${formatNumber(v)} phút`;

  return (
    <SectionCard
      title="Kết cục ca chăm sóc"
      description={`${formatNumber(t.opened)} ca ${PERIOD_BASIS_LABEL[basis]}`}
      hint={
        <>
          <p className="mb-2">{PERIOD_BASIS_HINT[basis]}</p>
          <p className="mb-2">
            Kỳ đang lọc {PERIOD_BASIS_LABEL[basis]}. Đổi mốc lọc sẽ ra một TẬP CA khác, không phải cùng tập với con số khác.
          </p>
          <p>
            Bảng này KHÔNG xếp hạng nhân viên và không có điểm tổng. “Giao được SAU khi có người chăm” là QUAN SÁT, không phải nhân quả: người xử lý
            chọn chăm ca nào, và thường chọn đơn to, khách quen, đơn còn cứu được.
          </p>
        </>
      }
    >
      {/*
        ĐỘ PHỦ ĐỨNG TRƯỚC MỌI CON SỐ. Một trung vị tính trên 2/319 ca không phải một trung vị — và
        người đọc phải thấy điều đó trước khi thấy con số, không phải sau.
      */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <O nhan="Ca có hành động chăm sóc thật" so={`${formatNumber(t.withCareAction)}/${formatNumber(t.opened)}`} phu={`độ phủ ${formatPercent(t.firstActionCoverage * 100, 0)}`} hint="Gọi · nhắn · sửa địa chỉ · báo bưu cục." />
        <O nhan="Ca có người động vào" so={`${formatNumber(t.touched)}/${formatNumber(t.opened)}`} hint="Rộng hơn: gồm cả đổi trạng thái và ghi chú. Giao việc KHÔNG tính." />
        <O nhan="Ca chưa ai động vào" so={formatNumber(t.untouched)} hint="Không ai mở, không ai ghi, không ai gọi." xau={t.untouched > 0} />
        <O nhan="Ca đã chốt kết quả" so={`${formatNumber(t.resolved)}/${formatNumber(t.opened)}`} phu={`độ phủ ${formatPercent(t.outcomeCoverage * 100, 0)} theo chứng từ ĐVVC`} />
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <O nhan="Tới lúc giao người (trung vị)" so={phut(a.medians.toAssign)} phu={`mẫu tối thiểu ${a.minSample} ca`} />
        <O nhan="Tới hành động đầu (trung vị)" so={phut(a.medians.toFirstAction)} hint="Từ lúc mở ca tới hành động chăm sóc ĐẦU TIÊN." />
        <O nhan="Tới lúc chốt (trung vị)" so={phut(a.medians.toResolution)} hint="Từ lúc mở ca tới khi ĐVVC chốt kết quả." />
      </div>

      <TableToolsFor tableId="shipments-case-outcome-report" />
      <div className="mt-4 overflow-x-auto rounded-md border">
        <table id="shipments-case-outcome-report" className="w-full text-[12.5px]">
          <thead className="bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="p-2 font-medium">Kết cục</th>
              <th className="p-2 text-right font-medium">Ca</th>
            </tr>
          </thead>
          <tbody>
            {CASE_OUTCOMES.filter((o) => a.counts[o] > 0).map((o) => (
              <tr key={o} className="border-t align-top">
                <td className="p-2">
                  <span className="inline-flex items-center gap-1 font-medium">
                    {CASE_OUTCOME_LABEL[o]}
                    <InfoHint>{CASE_OUTCOME_HINT[o]}</InfoHint>
                  </span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {CASE_OUTCOME_IS_FINAL[o] ? "đã ngã ngũ" : "chưa ngã ngũ — ngoài mọi tỷ lệ"}
                    {CASE_OUTCOME_HAS_HUMAN_CREDIT[o] ? " · có công của người" : ""}
                  </span>
                </td>
                <td className={cn("numeric p-2 text-right font-semibold", o === "DELIVERED_WITHOUT_MANUAL_CARE" && "text-amber-700 dark:text-amber-400")}>
                  {formatNumber(a.counts[o])}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/*
        ═══ SỨC KHOẺ LUẬT MỞ LẠI — BA CON SỐ, KHÔNG PHẢI MỘT ═══

        Tới 18/09/2026 bộ đối chiếu dựng lại một đợt MỚI mỗi khi người bấm hoàn tất (luật 59). Các
        bản sao đã trót sinh ra vẫn nằm trong CSDL, nên phải gọi tên chúng — nếu không mọi con số
        care còn nói sai rất lâu sau khi lỗi đã hết. Chúng KHÔNG được đếm ở các ô phía trên.
      */}
      <div className="mt-4 rounded-lg border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="flex items-center gap-1.5 text-[12.5px] font-medium">
            Đợt thứ hai trở đi: thật, bản sao, hay chưa rõ
            {a.reopen.falseReopenAfterFix === 0 ? (
              <InfoHint>
                <strong>Không có bản sao nào sinh ra sau khi luật mới chạy</strong> ({formatDateTime(a.reopen.guardLiveAt)}). Các con số “bản sao” ở trên là DI SẢN đã được vá,
                không phải lỗi đang xảy ra.
              </InfoHint>
            ) : null}
          </p>
          {a.reopen.falseReopenAfterFix !== 0 ? (
            <>
              {/* Lỗi CÒN ĐANG XẢY RA: một dòng ngắn luôn nhìn thấy, chi tiết trong nhãn cảnh báo. */}
              <span className="text-[11.5px] font-semibold text-destructive">{formatNumber(a.reopen.falseReopenAfterFix)} bản sao sinh ra SAU khi luật mới chạy</span>
              <DataWarnings
                tone="danger"
                items={[
                  <span key="ban-sao-moi">
                    <strong>{formatNumber(a.reopen.falseReopenAfterFix)} bản sao sinh ra SAU khi luật mới chạy</strong> ({formatDateTime(a.reopen.guardLiveAt)}) — lỗi vẫn đang xảy ra, phải điều tra ngay.
                  </span>,
                ]}
              />
            </>
          ) : null}
        </div>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {REOPEN_CLASSES.map((k) => (
            <div key={k} className="rounded-md border bg-muted/20 px-2.5 py-2" title={REOPEN_CLASS_HINT[k]}>
              <p className="text-[11.5px] text-muted-foreground">{REOPEN_CLASS_LABEL[k]}</p>
              <p className={cn("numeric text-lg font-bold", k === "FALSE_REOPEN_LEGACY" && a.reopen.byClass[k] > 0 && "text-amber-700 dark:text-amber-400")}>
                {formatNumber(a.reopen.byClass[k])}
              </p>
            </div>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}

/** Ô số: `phu` là dòng DỮ LIỆU ngắn nhìn thấy; `hint` là lời giải thích, chỉ hiện khi trỏ vào ⓘ. */
function O({ nhan, so, phu, hint, xau }: { nhan: string; so: React.ReactNode; phu?: string; hint?: React.ReactNode; xau?: boolean }) {
  return (
    <div className="rounded-xl border p-3">
      <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-muted-foreground">
        {nhan}
        {hint ? <InfoHint>{hint}</InfoHint> : null}
      </p>
      <p className={cn("numeric mt-1 text-xl font-bold", xau && "text-amber-700 dark:text-amber-400")}>{so}</p>
      {phu ? <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{phu}</p> : null}
    </div>
  );
}

import { InfoHint } from "@/components/info-hint";
import { MetricCard } from "@/components/metric-card";
import { SectionCard } from "@/components/ui-bits";
import { formatNumber, formatVND, pct } from "@/lib/format";
import { getCareReport } from "@/lib/queries/care-report";
import type { Period } from "@/lib/search-params";

/**
 * HIỆU QUẢ CARE — cho quản lý. Không xếp hạng theo số lần bấm: cột đầu là COD cứu được, rồi tới
 * kiện cứu được / kiện can thiệp, vỡ SLA, hoàn sau care. Mỗi hàng bấm được vào danh sách kiện của người đó.
 */
export async function CareReportSection({ period }: { period: Period }) {
  const r = await getCareReport(period);
  const rate = (a: number, b: number) => (b ? `${pct(a, b).toFixed(0)}%` : "—");
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Backlog cần care" value={formatNumber(r.backlog.care)} note={`${formatNumber(r.backlog.overdue)} vỡ SLA · ${formatNumber(r.backlog.unassigned)} chưa ai nhận · COD treo ${formatVND(r.backlog.moneyAtRisk, { compact: true })}`} tone={r.backlog.overdue ? "rose" : "amber"} hint="Kiện đang trong điều kiện cần người, tính lúc này (không theo kỳ). Chờ kết quả và Escalated đếm riêng ở tab." />
        <MetricCard label="Phản hồi đầu (trung vị)" value={r.firstResponse.medianHours === null ? "—" : `${r.firstResponse.medianHours} giờ`} note={`${formatNumber(r.firstResponse.withinSla)}/${formatNumber(r.firstResponse.measured)} kiện trong 2 giờ`} tone="slate" hint="Từ lúc kiện được đội mở (dòng care) tới lần đầu có người động vào. Chỉ đo kiện có dòng care trong kỳ." />
        <MetricCard label="Đã đóng trong kỳ" value={formatNumber(r.done.count)} note={`${formatNumber(r.done.withinSla)} trong 24 giờ · ${formatNumber(r.done.reopened)} mở lại · trung vị ${r.done.medianResolveHours === null ? "—" : `${r.done.medianResolveHours} giờ`}`} tone="slate" hint="Đội bấm Đã xong. Không đồng nghĩa kiện đã giao — cột bên phải mới nói kết cục." />
        <MetricCard label="COD cứu được sau can thiệp" value={formatVND(r.recovery.recoveredCod, { compact: true })} note={`${formatNumber(r.recovery.recoveredIntervened)}/${formatNumber(r.recovery.failedIntervened)} kiện giao hụt có người care rồi giao thành công`} tone="green" hint="Kiện giao hụt trong kỳ, có ít nhất một hành động care của người sau lần hụt, rồi ĐVVC xác nhận giao thành công. Tiền là COD của kiện đó — đã tới tay khách, chưa chắc đã về tài khoản." />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Giao hụt → kết cục" hint="So sánh hai nhóm cùng bị giao hụt trong kỳ: có người can thiệp và không ai can thiệp. Khác biệt giữa hai tỷ lệ mới là giá trị của việc care, không phải số cuộc gọi.">
          <table className="w-full text-[12.5px]">
            <thead className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-1">Nhóm</th>
                <th className="py-1 text-right">Kiện</th>
                <th className="py-1 text-right">Giao được</th>
                <th className="py-1 text-right">Hoàn</th>
                <th className="py-1 text-right">Còn chạy</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t">
                <td className="py-1.5 font-medium">Có người care</td>
                <td className="numeric py-1.5 text-right">{formatNumber(r.recovery.failedIntervened)}</td>
                <td className="numeric py-1.5 text-right font-semibold text-emerald-700 dark:text-emerald-300">{formatNumber(r.recovery.recoveredIntervened)} · {rate(r.recovery.recoveredIntervened, r.recovery.failedIntervened)}</td>
                <td className="numeric py-1.5 text-right">{formatNumber(r.recovery.returnedIntervened)} · {rate(r.recovery.returnedIntervened, r.recovery.failedIntervened)}</td>
                <td className="numeric py-1.5 text-right">{formatNumber(r.recovery.failedIntervened - r.recovery.recoveredIntervened - r.recovery.returnedIntervened)}</td>
              </tr>
              <tr className="border-t">
                <td className="py-1.5 font-medium">Không ai care</td>
                <td className="numeric py-1.5 text-right">{formatNumber(r.recovery.failedNotIntervened)}</td>
                <td className="numeric py-1.5 text-right">{formatNumber(r.recovery.recoveredNotIntervened)} · {rate(r.recovery.recoveredNotIntervened, r.recovery.failedNotIntervened)}</td>
                <td className="numeric py-1.5 text-right">{formatNumber(r.recovery.returnedNotIntervened)} · {rate(r.recovery.returnedNotIntervened, r.recovery.failedNotIntervened)}</td>
                <td className="numeric py-1.5 text-right">{formatNumber(r.recovery.failedNotIntervened - r.recovery.recoveredNotIntervened - r.recovery.returnedNotIntervened)}</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-[11.5px] text-muted-foreground">
            Phát lại (hẹn lại / yêu cầu phát tiếp): {formatNumber(r.redelivery.requested)} kiện · giao được {formatNumber(r.redelivery.delivered)} ({rate(r.redelivery.delivered, r.redelivery.requested)}) · hoàn {formatNumber(r.redelivery.returned)} · còn chạy {formatNumber(r.redelivery.pending)}
          </p>
        </SectionCard>

        <SectionCard title="Yêu cầu gửi Viettel Post" hint="SUCCESS chỉ khi sự kiện hành trình xác nhận. ĐVVC đã nhận (ACK) là chưa xong. Phải làm tay = tài khoản API không sở hữu kiện (vận đơn Pancake tạo).">
          <div className="grid grid-cols-2 gap-2 text-[12.5px] sm:grid-cols-3">
            {[
              ["Tổng", r.carrierRequests.total],
              ["ĐVVC xác nhận", r.carrierRequests.success],
              ["Đã nhận, chờ xác nhận", r.carrierRequests.ack],
              ["Từ chối", r.carrierRequests.failed],
              ["Không hỗ trợ", r.carrierRequests.unsupported],
              ["Phải làm tay", r.carrierRequests.manual],
              ["Đã làm tay", r.carrierRequests.manualDone],
            ].map(([k, v]) => (
              <div key={String(k)} className="rounded-lg border px-2.5 py-1.5">
                <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{k}</div>
                <div className="numeric text-base font-bold">{formatNumber(Number(v))}</div>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>

      <SectionCard
        title="Theo nhân viên"
        description="Xếp theo COD cứu được, không theo số lần bấm."
        hint="Cứu được = kiện giao hụt người này can thiệp rồi giao thành công. Hoàn sau care = can thiệp rồi vẫn hoàn. Vỡ SLA = kiện đang cầm mà quá 2 giờ chưa phản hồi. Bấm tên để mở danh sách kiện của người đó."
        padded={false}
      >
        {r.staff.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">Chưa có hành động care nào trong kỳ.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-[12.5px]">
              <thead className="border-b bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">Người</th>
                  <th className="px-3 py-2 text-right">COD cứu được</th>
                  <th className="px-3 py-2 text-right">Cứu / can thiệp</th>
                  <th className="px-3 py-2 text-right">Hoàn sau care</th>
                  <th className="px-3 py-2 text-right">Đã đóng</th>
                  <th className="px-3 py-2 text-right">Phản hồi đầu</th>
                  <th className="px-3 py-2 text-right">Vỡ SLA đang cầm</th>
                  <th className="px-3 py-2 text-right">
                    Hành động <InfoHint>Tổng số lần ghi nhận, và trong đó bao nhiêu lần tiếp xúc được khách. Chỉ để tham khảo khối lượng — không dùng để xếp hạng.</InfoHint>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {r.staff.map((s) => (
                  <tr key={s.actor}>
                    <td className="px-4 py-2 font-medium">{s.actor}</td>
                    <td className="numeric px-3 py-2 text-right font-semibold">{formatVND(s.recoveredCod, { compact: true })}</td>
                    <td className="numeric px-3 py-2 text-right">
                      {formatNumber(s.recovered)}/{formatNumber(s.intervened)} · {rate(s.recovered, s.intervened)}
                    </td>
                    <td className="numeric px-3 py-2 text-right">{formatNumber(s.returnedAfterCare)}</td>
                    <td className="numeric px-3 py-2 text-right">{formatNumber(s.casesDone)}</td>
                    <td className="numeric px-3 py-2 text-right">{s.medianFirstResponseHours === null ? "—" : `${s.medianFirstResponseHours} giờ`}</td>
                    <td className={`numeric px-3 py-2 text-right ${s.overdueOwned ? "font-semibold text-rose-600 dark:text-rose-400" : ""}`}>{formatNumber(s.overdueOwned)}</td>
                    <td className="numeric px-3 py-2 text-right text-muted-foreground">
                      {formatNumber(s.actions)} · tiếp xúc {formatNumber(s.reached)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

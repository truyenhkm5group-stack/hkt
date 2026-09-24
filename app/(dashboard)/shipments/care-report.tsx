import { InfoHint } from "@/components/info-hint";
import { TableToolsFor } from "@/components/data-table/table-tools";
import { MetricCard } from "@/components/metric-card";
<TableToolsFor tableId="shipments-care-report-1" />
import { STICKY_HEAD, TABLE_SCROLL } from "@/lib/constants/table-ux";
import { SectionCard } from "@/components/ui-bits";
import { CARE_SLA } from "@/lib/constants/care";
import { CARE_BACKLOG_GROUP_HINT, CARE_ROUND_MERGE_MINUTES } from "@/lib/constants/care-rounds";
import { formatNumber, formatVND, pct } from "@/lib/format";
import { getCareReport } from "@/lib/queries/care-report";
import type { Period } from "@/lib/search-params";
import { cn } from "@/lib/utils";

/**
 * HIỆU QUẢ CARE — cho quản lý. Không xếp hạng theo số lần bấm: cột đầu là COD cứu được, rồi tới
 * kiện cứu được / kiện can thiệp, vỡ SLA, hoàn sau care. Mỗi hàng bấm được vào danh sách kiện của người đó.
 */
export async function CareReportSection({ period }: { period: Period }) {
  const r = await getCareReport(period);
  const rate = (a: number, b: number) => (b ? `${pct(a, b).toFixed(0)}%` : "—");
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {/*
          ═══ CON SỐ LỚN PHẢI TRẢ LỜI ĐÚNG CÂU NGƯỜI ĐỌC ĐANG HỎI ═══

          Trước bản này thẻ in `backlog.care` — TỔNG kiện đang ở góc nhìn "Cần care" — dưới nhãn
          "Backlog cần care". Chủ shop đọc nó là "còn bấy nhiêu case chưa được care", nhưng trong
          đó có cả kiện đã gọi khách ba lượt và đang chờ tới giờ hẹn. Đội trông như không làm gì
          trong khi họ đã làm ba lượt, và con số càng chăm chỉ càng không chịu giảm.

          Nay con số lớn là CHƯA AI ĐỤNG — nhóm duy nhất trả lời đúng câu đó. Hai nhóm còn lại
          đứng ngay dưới, không bị giấu: chúng vẫn là việc (hoặc sẽ là việc), chỉ không phải cùng
          một việc. Tổng ba nhóm bằng đúng `backlog.care`, và dòng cuối in ra tổng ấy để không ai
          phải nghi ngờ rằng một nhóm đã bị bỏ quên.
        */}
        <MetricCard
          label="Chưa ai đụng"
          value={formatNumber(r.backlog.groups.UNTOUCHED.count)}
          note={`+${formatNumber(r.backlog.groups.WORKED_DUE.count)} đã xử lý, tới lượt lại · +${formatNumber(r.backlog.groups.WORKED_SCHEDULED.count)} đã xử lý, đang trong hẹn — tổng ${formatNumber(r.backlog.care)} kiện còn trong điều kiện care · ${formatNumber(r.backlog.overdue)} vỡ SLA · COD treo ${formatVND(r.backlog.moneyAtRisk, { compact: true })}`}
          tone={r.backlog.groups.UNTOUCHED.count ? "rose" : "green"}
          hint={`${CARE_BACKLOG_GROUP_HINT.UNTOUCHED}\n\nĐã xử lý, tới lượt lại: ${CARE_BACKLOG_GROUP_HINT.WORKED_DUE}\n\nĐã xử lý, đang trong hẹn: ${CARE_BACKLOG_GROUP_HINT.WORKED_SCHEDULED}\n\nMột LƯỢT XỬ LÝ = một lần người ghi việc đã làm (gọi / nhắn / sửa) hoặc bấm một kết quả (Đã hoàn / Phát tiếp / Xử lý sau); hai ghi nhận của cùng một người trong ${CARE_ROUND_MERGE_MINUTES} phút tính là MỘT lượt. Đổi trạng thái và giao việc KHÔNG tính — chúng là “chạm vào”, không phải “đã xử lý”. Tính lúc này, không theo kỳ.`}
        />
        <MetricCard
          label="Phản hồi đầu (trung vị)"
          value={r.firstResponse.medianHours === null ? "—" : `${r.firstResponse.medianHours} giờ`}
          note={`${formatNumber(r.firstResponse.withinSla)}/${formatNumber(r.firstResponse.measured)} ca trong ${formatNumber(CARE_SLA.firstResponseHours)} giờ${r.firstResponse.assignedOnly ? ` · ${formatNumber(r.firstResponse.assignedOnly)} ca đang mở đã giao mà chưa ai bắt đầu` : ""}`}
          tone={r.firstResponse.assignedOnly ? "amber" : "slate"}
          hint={`Từ lúc kiện vào điều kiện cần care tới LƯỢT XỬ LÝ ĐẦU TIÊN — một lần gọi / nhắn / sửa, hoặc một lần bấm kết quả.\n\nGIAO VIỆC KHÔNG TÍNH. Cột “phản hồi đầu” trong CSDL được ghi ngay lúc giao việc, nên trước bản 22/09/2026 con số này đo tốc độ BẤM GIAO VIỆC: đo production cùng ngày, 22 trong 25 ca chưa ai đụng vẫn mang mốc ấy và vì thế không bao giờ bị tính vỡ hạn. Nay phép đo đọc theo lượt xử lý thật — cột cũ giữ nguyên trong CSDL, không xoá một dòng nào.\n\nCa chưa có lượt nào nằm NGOÀI phép đo (không vào mẫu số với giá trị 0), nên mẫu số ${formatNumber(r.firstResponse.measured)} ở trên chính là độ phủ. Con số cảnh báo bên cạnh đếm ca đang mở đã có người nhận mà chưa ai bắt đầu.`}
        />
        {/*
          ═══ HAI ĐỒNG HỒ, HAI CÂU HỎI — KHÔNG GỘP ═══

          "Phản hồi đầu" hỏi *đội bắt đầu nhanh không*. Thẻ này hỏi *đội có bỏ ca giữa chừng
          không*. Một đội gọi trong 20 phút rồi im ba ngày và một đội gọi sau 3 giờ rồi gọi lại mỗi
          sáng cho ra CÙNG một con số ở thẻ bên trái — nên thẻ bên trái một mình không trả lời được
          câu hỏi quan trọng hơn.

          Mẫu dưới ngưỡng thì in "—" VÀ NÓI RA VÌ SAO (luật 63): một con số nhỏ dựng trên 3 ca
          trông y hệt một con số dựng trên 300 ca, và không ai đi kiểm lại.
        */}
        <MetricCard
          label="Độ nguội giữa hai lượt"
          value={r.roundGap.median === null ? "—" : `${r.roundGap.median.toFixed(1)} giờ`}
          note={
            r.roundGap.median === null
              ? `Chưa đủ mẫu: ${formatNumber(r.roundGap.sample)}/${formatNumber(r.roundGap.population)} ca đang mở có từ 2 lượt trở lên (cần ${formatNumber(r.roundGap.minSample)})`
              : `${formatNumber(r.roundGap.sample)}/${formatNumber(r.roundGap.population)} ca đang mở có từ 2 lượt trở lên`
          }
          tone="slate"
          hint={`Trung vị khoảng cách giữa hai LƯỢT XỬ LÝ liên tiếp, trên các ca đang mở. Trả lời câu “đội có bỏ ca giữa chừng không” — KHÁC HẲN thẻ “Phản hồi đầu” bên cạnh, thẻ đó chỉ hỏi đội bắt đầu nhanh không.\n\nMỗi ca đóng góp ĐÚNG MỘT phiếu (trung vị các khoảng của chính nó), để một ca được gọi tám lượt không lấn át bảy ca chỉ có một khoảng.\n\nCa mới có một lượt nằm NGOÀI phép đo — chưa có khoảng nào để đo, và đó không phải “độ nguội bằng 0”. Dưới ${formatNumber(r.roundGap.minSample)} ca thì KHÔNG phát biểu trung vị: một con số dựng trên vài ca trông y hệt con số dựng trên vài trăm ca.`}
        />
        <MetricCard label="Đã đóng trong kỳ" value={formatNumber(r.done.count)} note={`${formatNumber(r.done.withinSla)} trong 24 giờ · ${formatNumber(r.done.reopened)} mở lại · trung vị ${r.done.medianResolveHours === null ? "—" : `${r.done.medianResolveHours} giờ`}`} tone="slate" hint="Đội bấm Đã xong. Không đồng nghĩa kiện đã giao — cột bên phải mới nói kết cục." />
        <MetricCard label="COD cứu được sau can thiệp" value={formatVND(r.recovery.recoveredCod, { compact: true })} note={`${formatNumber(r.recovery.recoveredIntervened)}/${formatNumber(r.recovery.failedIntervened)} kiện giao hụt có người care rồi giao thành công · doanh thu ${formatVND(r.recovery.recoveredRevenue, { compact: true })}`} tone="green" hint="Kiện giao hụt trong kỳ, có ít nhất một hành động care của người SAU lần hụt và TRƯỚC kết cục, rồi ĐVVC xác nhận giao thành công. COD là tiền của kiện đó — đã tới tay khách, chưa chắc đã về tài khoản; doanh thu là giá trị đơn được cứu." />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Giao hụt → kết cục" hint="So sánh hai nhóm cùng bị giao hụt trong kỳ: có người can thiệp và không ai can thiệp. Khác biệt giữa hai tỷ lệ mới là giá trị của việc care, không phải số cuộc gọi.">
          <table id="shipments-care-report-1" className="w-full text-[12.5px]">
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

      {r.backlog.byOwner.length ? (
        <SectionCard title="Khối lượng đang cầm" hint="Kiện đang mở (kể cả đang chờ / escalated) theo người nhận, tính lúc này. Để chia lại việc, không phải để xếp hạng." padded={false}>
          <TableToolsFor tableId="shipments-care-report-2" />
          <div className={TABLE_SCROLL}>
            <table id="shipments-care-report-2" className="w-full min-w-[560px] text-[12.5px]">
              <thead className={cn(STICKY_HEAD, "border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground")}>
                <tr>
                  <th className="px-4 py-2">Người</th>
                  <th className="px-3 py-2 text-right">Đang mở</th>
                  {/*
                    CỘT NÀY TRẢ LỜI CÂU "ĐANG MỞ" KHÔNG TRẢ LỜI ĐƯỢC: việc đã nằm trong tay mà chưa
                    ai mở ra. Một người cầm 10 việc và làm cả 10 trông y hệt một người cầm 10 việc
                    và chưa đụng cái nào — cho tới khi có cột này. Đo 22/09/2026: 22 đợt `ASSIGNED`
                    với 0 lượt xử lý.
                  */}
                  <th className="px-3 py-2 text-right" title="Việc đã giao (hoặc đã nhận) mà chưa có một lượt xử lý nào: chưa gọi, chưa nhắn, chưa bấm kết quả. Giao việc KHÔNG tính là một lượt.">
                    Chưa bắt đầu
                  </th>
                  <th className="px-3 py-2 text-right">Vỡ SLA</th>
                  <th className="px-3 py-2 text-right">COD đang treo</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {r.backlog.byOwner.map((o) => (
                  <tr key={o.ownerId ?? "none"}>
                    <td className={`px-4 py-2 font-medium ${o.ownerId ? "" : "text-rose-600 dark:text-rose-400"}`}>{o.name}</td>
                    <td className="numeric px-3 py-2 text-right">{formatNumber(o.open)}</td>
                    <td className={`numeric px-3 py-2 text-right ${o.notStarted ? "font-semibold text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}>{formatNumber(o.notStarted)}</td>
                    <td className={`numeric px-3 py-2 text-right ${o.overdue ? "font-semibold text-rose-600 dark:text-rose-400" : ""}`}>{formatNumber(o.overdue)}</td>
                    <td className="numeric px-3 py-2 text-right">{formatVND(o.money, { compact: true })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Theo nhân viên"
        hint={
          <>
            <p className="mb-2">Cứu được = kiện giao hụt người này can thiệp rồi giao thành công. Hoàn sau care = can thiệp rồi vẫn hoàn. Vỡ SLA = kiện đang cầm mà quá 2 giờ chưa phản hồi. Bấm tên để mở danh sách kiện của người đó.</p>
            <p>Xếp theo COD cứu được, không theo số lần bấm.</p>
          </>
        }
        padded={false}
      >
        {r.staff.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">Chưa có hành động care nào trong kỳ.</p>
        ) : (
          <>
            <TableToolsFor tableId="shipments-care-report-3" />
            <div className={TABLE_SCROLL}>
              <table id="shipments-care-report-3" className="w-full min-w-[820px] text-[12.5px]">
                <thead className={cn(STICKY_HEAD, "border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground")}>
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
                    <tr key={s.userId ?? "none"}>
                      <td className={s.userId ? "px-4 py-2 font-medium" : "px-4 py-2 italic text-muted-foreground"} title={s.userId ? undefined : "Hành động / ca chỉ có ô chữ, không nối được về tài khoản — không ghi công cho ai"}>{s.actor}</td>
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
          </>
        )}
      </SectionCard>
    </div>
  );
}

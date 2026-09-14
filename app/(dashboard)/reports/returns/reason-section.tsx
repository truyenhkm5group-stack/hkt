import Link from "next/link";
import { SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { ReasonGroupTable } from "@/app/(dashboard)/reports/returns/reason-group-table";
import { REASON_CONFIDENCE_LABEL, RETURN_REASON_LABEL, type ReturnReason } from "@/lib/constants/return-reason";
import { MARKETER_UNRESOLVED_LABEL } from "@/lib/constants/marketer-attribution";
import { TIME_BASIS_LABEL } from "@/lib/constants/report-time-basis";
import { STICKY_HEAD, TABLE_SCROLL } from "@/lib/constants/table-ux";
import { cn } from "@/lib/utils";
import { formatDateTime, formatNumber, formatPercent } from "@/lib/format";
import { listReasonShipments, type ReasonFilter, type ReturnReasonReport } from "@/lib/queries/return-reason-report";
import { marketerLabel, marketerNames } from "@/lib/queries/order-marketer";

/**
 * ═══════════ BÁO CÁO HOÀN THEO LÝ DO VÀ THEO MÃ HÀNG ═══════════
 *
 * Đặt TRONG trang Tỷ lệ giao thành công chứ không dựng trang mới: mẫu số, kỳ lọc và công thức
 * đều là của báo cáo này. Một trang thứ hai nói về cùng một thứ là cách chắc chắn nhất để hai
 * con số "tỷ lệ hoàn" cùng tồn tại và không ai biết tin cái nào.
 *
 * ─── BÁO CÁO ĐÃ DỰNG SẴN, TRUYỀN VÀO ───
 *
 * `report` do trang cha dựng MỘT lần rồi truyền xuống cả khối này lẫn tầng quyết định. Bản trước
 * khối này tự gọi `getReturnReasonReport`, nên cùng một tập ca bị dựng hai lần trong một lượt mở
 * trang — chậm gấp đôi, và hai bản có thể rơi vào hai mốc `now()` khác nhau.
 */
export async function ReturnReasonSection({
  report,
  filter,
  hrefWith,
  openReason,
}: {
  report: ReturnReasonReport;
  filter: ReasonFilter;
  /** Dựng URL giữ nguyên mọi bộ lọc đang bật, chỉ đổi các tham số truyền vào. */
  hrefWith: (extra: Record<string, string | null>) => string;
  /** Lý do đang mở drilldown (từ URL). `null` = không mở. */
  openReason: ReturnReason | null;
}) {
  const bc = report;

  if (!bc.finished) {
    return (
      <SectionCard title="Phân tích lý do hoàn" description="Kỳ này chưa có đơn nào đi tới kết quả cuối.">
        <p className="text-xs text-muted-foreground">Đơn đang giao, đơn huỷ và đơn chưa rõ kết quả không nằm trong mẫu số — không ở tử, không ở mẫu.</p>
      </SectionCard>
    );
  }

  const [drilldown, ten] = await Promise.all([
    openReason ? listReasonShipments({ ...filter, reason: openReason, limit: 300 }) : Promise.resolve([]),
    marketerNames(),
  ]);

  return (
    <>
      <SectionCard
        title="Phân tích lý do hoàn"
        description={`${formatNumber(bc.returned)} đơn hoàn / ${formatNumber(bc.finished)} đơn có kết quả cuối · tỷ lệ hoàn ${formatPercent(bc.returnRate)} · GTC ${formatPercent(bc.successRate)} · trên ${formatNumber(bc.eligibleSent)} kiện đã gửi`}
        hint={`Mẫu số là đơn ĐÃ CÓ KẾT QUẢ CUỐI (giao thành công · hoàn · hoàn theo luật). Đơn đang giao, đơn huỷ, đơn 'shop huỷ lấy', đơn 'lấy không thành công' và vận đơn chiều về (…1P1) đều KHÔNG nằm trong tử lẫn mẫu — đúng hợp đồng ORDER_OUTCOME đang chạy, không tính lại ở đây. Kỳ lọc theo ${TIME_BASIS_LABEL[bc.basis].toUpperCase()}.${bc.missingBasis ? ` ${bc.missingBasis} ca không có mốc này nên nằm ngoài kỳ — KHÔNG bị gán bừa một ngày khác.` : ""}`}
        padded={false}
      >
        <div className="p-3">
          {/*
            ĐỘ PHỦ ĐỨNG TRƯỚC BẢNG, KHÔNG PHẢI Ở CHÂN TRANG.

            Đo production 14/09/2026: bảng `shipment_return_reasons` RỖNG và `shipments.vtp_reason_code`
            NULL cho cả 2.108 vận đơn. Nghĩa là 100% lý do dưới đây suy từ CHỮ trong sự kiện Viettel
            Post — chưa một ca nào được người xác nhận, chưa một mã lý do có cấu trúc nào. Nếu con số
            đó nằm cuối trang thì người đọc đã kịp kết luận từ bảng phía trên rồi.
          */}
          <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
            Xác định được lý do: <strong>{formatNumber(bc.reasonCoverage.known)}</strong> / {formatNumber(bc.returned)} đơn hoàn ({formatPercent(bc.reasonCoverage.pct)}). Phần còn lại không có mã lý do và
            không có sự kiện nào nêu lý do — ĐVVC chỉ báo kiện đã chuyển hoàn. <strong>Chưa xác định được không phải là một lý do</strong>; nó là chỗ dữ liệu còn thiếu. Cột{" "}
            <strong>Tỷ trọng trên hoàn</strong> tính trên {formatNumber(bc.reasonCoverage.known)} đơn ĐÃ BIẾT lý do (cộng lại đúng 100%); cột <strong>Tỷ lệ trên đã gửi</strong> tính trên cả{" "}
            {formatNumber(bc.eligibleSent)} kiện đã bàn giao ĐVVC — hai mẫu số cho hai câu hỏi khác nhau.
          </p>

          {/*
            BẢNG HAI TẦNG: nhóm lý do mở sẵn, lý do chi tiết xổ ra khi bấm.

            Tầng nhóm là tầng RA QUYẾT ĐỊNH — "hoàn vì chất lượng" đi tới xưởng, "hoàn vì sai size"
            đi tới bảng size. Ba mươi dòng chi tiết là thứ người XỬ LÝ cần, không phải thứ chủ shop
            đọc để quyết.
          */}
          <ReasonGroupTable groups={bc.groups} known={bc.reasonCoverage.known} eligibleSent={bc.eligibleSent} drilldownHref={(reason) => `${hrefWith({ reason })}#ly-do-chi-tiet`} />
        </div>
      </SectionCard>

      {openReason ? (
        <div id="ly-do-chi-tiet">
          <SectionCard
            title={`Vận đơn hoàn vì “${RETURN_REASON_LABEL[openReason]}”`}
            description={`${formatNumber(drilldown.length)} vận đơn · giữ nguyên mọi bộ lọc đang bật (kỳ · mốc · mã hàng · marketer). Tối đa 300 dòng.`}
            hint="Danh sách này dựng từ CHÍNH tập ca mà bảng phía trên đã đếm — không có truy vấn thứ hai, nên số dòng ở đây bằng đúng con số trên bảng."
            actions={
              <Button asChild variant="ghost" size="sm">
                <Link href={hrefWith({ reason: null })}>Đóng</Link>
              </Button>
            }
            padded={false}
          >
            <div className={TABLE_SCROLL}>
              <table className="w-full min-w-[1040px] text-sm">
                <thead className={cn(STICKY_HEAD, "text-[11.5px] uppercase tracking-wide text-muted-foreground")}>
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">Vận đơn</th>
                    <th className="px-3 py-2 text-left font-semibold">Đơn</th>
                    <th className="px-3 py-2 text-left font-semibold">Khách</th>
                    <th className="px-3 py-2 text-left font-semibold">Mã hàng / SKU</th>
                    <th className="px-3 py-2 text-left font-semibold">Marketer</th>
                    <th className="px-3 py-2 text-left font-semibold">Trạng thái ĐVVC cuối</th>
                    <th className="px-3 py-2 text-left font-semibold">Căn cứ lý do</th>
                    <th className="px-3 py-2 text-left font-semibold">Chăm sóc</th>
                    <th className="px-3 py-2 text-left font-semibold">Mốc</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {drilldown.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="py-8 text-center text-sm text-muted-foreground">
                        Không có vận đơn nào khớp bộ lọc hiện tại.
                      </td>
                    </tr>
                  ) : (
                    drilldown.map((r) => (
                      <tr key={r.orderId}>
                        <td className="px-3 py-1.5 font-mono text-[12px]">{r.tracking ?? "—"}</td>
                        <td className="px-3 py-1.5">
                          <Link href={`/orders/${r.orderId}`} className="font-semibold hover:text-primary hover:underline">
                            #{r.systemId ?? r.orderId}
                          </Link>
                        </td>
                        <td className="px-3 py-1.5">
                          <div className="max-w-[150px] truncate">{r.customer || "—"}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {r.phone}
                            {r.province ? ` · ${r.province}` : ""}
                          </div>
                        </td>
                        <td className="px-3 py-1.5 text-[12px]">
                          <div className="font-mono font-semibold">{r.productCodes || "—"}</div>
                          <div className="max-w-[170px] truncate text-[11px] text-muted-foreground">{r.skus}</div>
                        </td>
                        <td className="px-3 py-1.5 text-[12px]">{r.marketerId ? marketerLabel(r.marketerId, ten) : <span className="text-muted-foreground">{MARKETER_UNRESOLVED_LABEL}</span>}</td>
                        <td className="max-w-[180px] truncate px-3 py-1.5 text-[12px]">{r.carrierStatus || "—"}</td>
                        <td className="px-3 py-1.5 text-[12px]">
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] font-medium">{REASON_CONFIDENCE_LABEL[r.confidence]}</span>
                          <div className="max-w-[220px] truncate text-[11px] text-muted-foreground" title={r.evidence}>
                            {r.evidence}
                          </div>
                        </td>
                        <td className="px-3 py-1.5 text-[12px]">
                          {r.careOwner || <span className="text-muted-foreground">chưa ai cầm</span>}
                          {r.careActions ? <div className="text-[11px] text-muted-foreground">{r.careActions} thao tác</div> : null}
                        </td>
                        <td className="px-3 py-1.5 text-[11px] text-muted-foreground">{r.basisAt ? formatDateTime(r.basisAt) : "—"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </div>
      ) : null}

      <SectionCard
        title="Hoàn theo mã hàng"
        description={bc.multiSkuOrders ? `${formatNumber(bc.multiSkuOrders)} đơn có nhiều mã hàng — được đếm cho MỌI mã, nên cộng cột "đơn có kết quả" sẽ lớn hơn tổng thật đúng bằng phần đó.` : "Mỗi đơn thuộc đúng một mã hàng trong kỳ này."}
        hint="Một đơn nhiều mã hàng mà bị hoàn thì KHÔNG có gì trong dữ liệu nói mã nào gây hoàn. Đơn đó được tính cho cả hai mã (cả hai đều bị ảnh hưởng) và lý do của nó xếp vào nhóm 'lý do khác' thay vì gán bừa cho một mã."
        padded={false}
      >
        <div className={TABLE_SCROLL}>
          <table className="w-full min-w-[720px] text-sm">
            <thead className={cn(STICKY_HEAD, "text-[11.5px] uppercase tracking-wide text-muted-foreground")}>
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Mã hàng</th>
                <th className="px-3 py-2 text-right font-semibold">Đơn có kết quả</th>
                <th className="px-3 py-2 text-right font-semibold">Giao TC</th>
                <th className="px-3 py-2 text-right font-semibold">Hoàn</th>
                <th className="px-3 py-2 text-right font-semibold">Tỷ lệ hoàn</th>
                <th className="px-3 py-2 text-left font-semibold">Lý do hoàn nhiều nhất</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {bc.products.map((p) => (
                <tr key={p.code}>
                  <td className="px-3 py-1.5">
                    {/* Drilldown: mở đúng danh sách vận đơn của mã này, dùng CHÍNH bộ lọc mã hàng ở /shipments. */}
                    <Link href={`/shipments?view=all&period=all&product=${encodeURIComponent(p.code)}`} className="font-mono font-semibold hover:underline">
                      {p.code}
                    </Link>
                    <span className="ml-1.5 text-[11px] text-muted-foreground">{p.name}</span>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(p.finished)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(p.delivered)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(p.returned)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-medium">{formatPercent(p.returnRate)}</td>
                  <td className="px-3 py-1.5 text-[12px]">
                    {p.topReason ? (
                      <>
                        {p.topReason.label} <span className="text-muted-foreground">({formatNumber(p.topReason.count)} · {formatPercent(p.topReason.share)})</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </>
  );
}

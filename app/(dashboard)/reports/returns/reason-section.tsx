import Link from "next/link";
import { SectionCard } from "@/components/ui-bits";
import { ReasonGroupTable } from "@/app/(dashboard)/reports/returns/reason-group-table";
import { TIME_BASIS_LABEL } from "@/lib/constants/report-time-basis";
import { formatNumber, formatPercent } from "@/lib/format";

import { getReturnReasonReport } from "@/lib/queries/return-reason-report";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ BÁO CÁO HOÀN THEO LÝ DO VÀ THEO MÃ HÀNG ═══════════
 *
 * Đặt TRONG trang Tỷ lệ giao thành công chứ không dựng trang mới: mẫu số, kỳ lọc và công thức
 * đều là của báo cáo này. Một trang thứ hai nói về cùng một thứ là cách chắc chắn nhất để hai
 * con số "tỷ lệ hoàn" cùng tồn tại và không ai biết tin cái nào.
 */
export async function ReturnReasonSection({ period, codes }: { period: Period; codes?: string[] }) {
  const bc = await getReturnReasonReport({ period, codes });

  if (!bc.finished) {
    return (
      <SectionCard title="Vì sao đơn bị hoàn" description="Kỳ này chưa có đơn nào đi tới kết quả cuối.">
        <p className="text-xs text-muted-foreground">Đơn đang giao, đơn huỷ và đơn chưa rõ kết quả không nằm trong mẫu số — không ở tử, không ở mẫu.</p>
      </SectionCard>
    );
  }

  return (
    <>
      <SectionCard
        title="Vì sao đơn bị hoàn"
        description={`${formatNumber(bc.returned)} đơn hoàn / ${formatNumber(bc.finished)} đơn có kết quả cuối · tỷ lệ hoàn ${formatPercent(bc.returnRate)} · GTC ${formatPercent(bc.successRate)}`}
        hint={`Mẫu số là đơn ĐÃ CÓ KẾT QUẢ CUỐI (giao thành công · hoàn · hoàn theo luật). Đơn đang giao, đơn huỷ, đơn 'shop huỷ lấy', đơn 'lấy không thành công' và vận đơn chiều về (…1P1) đều KHÔNG nằm trong tử lẫn mẫu — đúng hợp đồng ORDER_OUTCOME đang chạy, không tính lại ở đây. Kỳ lọc theo ${TIME_BASIS_LABEL[bc.basis].toUpperCase()}: một ca đóng hôm nay có thể là đơn của tháng trước, nên lọc theo ngày đặt đơn sẽ trả lời sai câu hỏi "tháng này xử lý xong bao nhiêu ca".${bc.missingBasis ? ` ${bc.missingBasis} ca không có mốc kết quả cuối nên nằm ngoài kỳ — KHÔNG bị gán bừa một ngày khác.` : ""}`}
      >
        {/*
          ĐỘ PHỦ ĐỨNG TRƯỚC BẢNG, KHÔNG PHẢI Ở CHÂN TRANG.

          Đo production 13/09: chỉ ~22% vận đơn hoàn có chứng từ nêu lý do. Nếu con số đó nằm cuối
          trang thì người đọc đã kịp kết luận từ bảng phía trên rồi. Nó phải là câu đầu tiên.
        */}
        <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          Xác định được lý do: <strong>{formatNumber(bc.reasonCoverage.known)}</strong> / {formatNumber(bc.returned)} đơn hoàn ({formatPercent(bc.reasonCoverage.pct)}). Phần còn lại
          không có mã lý do và không có sự kiện nào nêu lý do — ĐVVC chỉ báo kiện đã chuyển hoàn.{" "}
          <strong>Chưa xác định được không phải là một lý do</strong>; nó là chỗ dữ liệu còn thiếu.{" "}
          Cột <strong>Tỷ trọng</strong> bên dưới tính trên {formatNumber(bc.reasonCoverage.known)} đơn ĐÃ BIẾT lý do (cộng lại đúng 100%), không trên tổng đơn hoàn —
          lấy tổng làm mẫu số thì mọi tỷ trọng bị kéo xuống bởi phần chưa ai hỏi.
        </p>

        {/*
          BẢNG HAI TẦNG: nhóm lý do mở sẵn, lý do chi tiết xổ ra khi bấm.

          Tầng nhóm là tầng RA QUYẾT ĐỊNH — "hoàn vì chất lượng" đi tới xưởng, "hoàn vì sai size"
          đi tới bảng size. Ba mươi dòng chi tiết là thứ người XỬ LÝ cần, không phải thứ chủ shop
          đọc để quyết.
        */}
        <ReasonGroupTable groups={bc.groups} known={bc.reasonCoverage.known} />
      </SectionCard>

      <SectionCard
        title="Hoàn theo mã hàng"
        description={bc.multiSkuOrders ? `${formatNumber(bc.multiSkuOrders)} đơn có nhiều mã hàng — được đếm cho MỌI mã, nên cộng cột "đơn có kết quả" sẽ lớn hơn tổng thật đúng bằng phần đó.` : "Mỗi đơn thuộc đúng một mã hàng trong kỳ này."}
        hint="Một đơn nhiều mã hàng mà bị hoàn thì KHÔNG có gì trong dữ liệu nói mã nào gây hoàn. Đơn đó được tính cho cả hai mã (cả hai đều bị ảnh hưởng) và lý do của nó xếp vào nhóm 'lý do khác' thay vì gán bừa cho một mã."
        padded={false}
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b bg-muted/50 text-[11.5px] uppercase tracking-wide text-muted-foreground">
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

import { IntradayScaleAction } from "@/app/(dashboard)/ads/intraday-action";
import { SectionCard } from "@/components/ui-bits";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { INTRADAY_SCALE_RULE } from "@/lib/constants/ads-intraday";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { getIntradayBoard } from "@/lib/queries/ads-intraday";

/** Dòng in ra: mọi dòng ĐẠT ngưỡng, cộng vài dòng suýt đạt để người đọc thấy ranh giới đang ở đâu. */
const NEAR_MISS_LIMIT = 5;

const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(1).replace(".", ",")}%`);

/**
 * ═══════════ TĂNG NGÂN SÁCH TRONG NGÀY ═══════════
 *
 * Làn nhanh chủ shop chốt 24/09/2026 — luật ở `lib/constants/ads-intraday.ts`. Đứng TRÊN bảng quyết
 * định vì đây là thứ làm được NGAY bây giờ; bảng quyết định là thứ nói về lãi thật, cần thời gian.
 */
export async function AdsIntradaySection({ canWrite }: { canWrite: boolean }) {
  const b = await getIntradayBoard();
  const dat = b.rows.filter((r) => r.verdict.eligible);
  const suyt = b.rows.filter((r) => r.verdict.blocker === "TOO_EXPENSIVE").slice(0, NEAR_MISS_LIMIT);
  const R = INTRADAY_SCALE_RULE;

  return (
    <SectionCard
      title={`Tăng ngân sách trong ngày · ${formatNumber(dat.length)} chiến dịch đạt ngưỡng`}
      description={`%CPQC hôm nay ≤ ${Math.round(R.maxCpqcPct * 100)}% doanh số chốt · chi ≥ ${formatVND(R.minSpendVnd)} · ≥ ${R.minBookedOrders} đơn — cập nhật ${formatDateTime(b.measuredAt)}`}
      hint={
        <>
          <p className="mb-1">
            Ngưỡng chủ shop chốt 24/09/2026. Mỗi lượt +{Math.round(R.stepPct * 100)}% ngân sách ngày, hai lượt cách ≥ {R.minGapHours} giờ, tối đa {R.maxPerDay} lượt/ngày
            một chiến dịch. Máy đề nghị, người bấm xác nhận.
          </p>
          <p className="mb-1">
            Số của HÔM NAY: chi quảng cáo (đồng bộ mỗi giờ) và doanh số CHỐT (chưa trừ hoàn). Đây là làn nhanh chỉ biết TĂNG — cắt hay tạm dừng vẫn đi qua bảng
            quyết định bên dưới, nơi kết luận đứng trên tiền thật.
          </p>
          Vẫn giữ mọi chốt an toàn của đường ghi: công tắc máy chủ, phanh, chiến dịch phải đang chạy, trần mỗi lượt và trần tiền cả shop mỗi ngày.
        </>
      }
      padded={false}
    >
      <p className="border-b px-5 py-2 text-xs text-muted-foreground">
        Chưa đạt: {formatNumber(b.blocked.TOO_EXPENSIVE)} chưa đủ rẻ · {formatNumber(b.blocked.SMALL_SAMPLE)} chưa đủ mẫu · {formatNumber(b.blocked.NO_SPEND_DATA)} chưa có số chi hôm nay
      </p>
      <div className="overflow-x-auto">
        <Table className="min-w-[820px]">
          <TableHeader>
            <TableRow>
              <TableHead>Chiến dịch</TableHead>
              <TableHead className="w-[120px] text-right">Chi hôm nay</TableHead>
              <TableHead className="w-[150px] text-right">Đơn chốt · doanh số</TableHead>
              <TableHead className="w-[90px] text-right">%CPQC</TableHead>
              <TableHead className="w-[230px] text-right">Tăng</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...dat, ...suyt].map((r) => (
              <TableRow key={r.campaignId} className={r.verdict.eligible ? "" : "opacity-60"}>
                <TableCell className="font-medium">
                  {r.name}
                  {!r.verdict.eligible ? <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">suýt đạt</span> : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatVND(r.spend)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(r.bookedOrders)} · {formatVND(r.bookedRevenue, { compact: true })}
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{pct(r.verdict.cpqcPct)}</TableCell>
                <TableCell className="text-right">
                  {!r.verdict.eligible ? (
                    <span className="text-[11px] text-muted-foreground">{r.verdict.reason}</span>
                  ) : r.rate && !r.rate.ok ? (
                    <span className="text-[11px] text-muted-foreground">{r.rate.reason}</span>
                  ) : canWrite ? (
                    <IntradayScaleAction campaignId={r.campaignId} />
                  ) : (
                    <span className="text-[11px] text-muted-foreground">Cần quyền sửa chi phí để bấm</span>
                  )}
                  {r.appliedToday ? <p className="text-[10.5px] text-muted-foreground">đã tăng {r.appliedToday}/{R.maxPerDay} lượt hôm nay</p> : null}
                </TableCell>
              </TableRow>
            ))}
            {!dat.length && !suyt.length ? (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                  Chưa chiến dịch nào có đủ số hôm nay để xét — thường đủ mẫu từ giữa buổi sáng.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </SectionCard>
  );
}

import Link from "next/link";
import { ArrowRight, PackageOpen } from "lucide-react";
import { SectionCard } from "@/components/ui-bits";
import { formatNumber, formatVND } from "@/lib/format";
import { getReturnPipeline, worstReturnStage } from "@/lib/queries/return-pipeline";
import { cn } from "@/lib/utils";

/**
 * ───────────── TOÀN BỘ HÀNG HOÀN ĐANG Ở ĐÂU ─────────────
 *
 * Trạm kiểm đếm bên dưới chỉ hiện những kiện SẴN SÀNG ĐẾM. Khối này hiện **toàn bộ dân số**, kể cả
 * phần chưa tới lượt — vì con số quan trọng nhất của kho không phải "hôm nay đếm mấy kiện" mà là
 * "bao nhiêu vốn đang nằm ngoài sổ, và nằm bao lâu rồi".
 *
 * Tuổi tính theo THỜI GIAN NẰM Ở KHÂU HIỆN TẠI, không phải tuổi vận đơn: một kiện của đơn ba tháng
 * trước mà kho vừa nhận hôm qua thì tuổi ở đây là một ngày.
 */
export async function ReturnPipelineSection() {
  const p = await getReturnPipeline();
  const nang = worstReturnStage(p);
  if (!p.totalParcels) return null;

  const ngay = (gio: number) => (gio >= 24 ? `${(gio / 24).toFixed(1)} ngày` : `${Math.round(gio)} giờ`);

  return (
    <SectionCard
      title="Hàng hoàn đang ở đâu"
      description={
        nang
          ? `Nặng nhất: ${nang.label} — ${formatNumber(nang.parcels)} kiện giữ ${formatVND(nang.goodsCost)} vốn.`
          : "Không khâu nào đang tồn đọng."
      }
      hint="Giá vốn là SỐ THẬT lấy từ giá vốn đơn hàng, không phải giá bán. Hàng hoàn quay về kho là lấy lại VỐN — doanh thu của đơn đó đã mất từ lúc khách không nhận. Gọi giá bán của hàng hoàn là 'tiền thu hồi' sẽ thổi con số lên nhiều lần."
      padded={false}
    >
      <div className="grid gap-3 border-b px-4 py-3 sm:grid-cols-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Vốn đang kẹt</div>
          <div className="numeric text-lg font-bold text-amber-700 dark:text-amber-300">{formatVND(p.capitalLocked)}</div>
          <div className="text-[11.5px] text-muted-foreground">{formatNumber(p.totalParcels)} kiện chưa vào lại tồn</div>
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Vốn đã giải phóng</div>
          <div className="numeric text-lg font-bold text-emerald-700 dark:text-emerald-300">{formatVND(p.capitalReleased)}</div>
          <div className="text-[11.5px] text-muted-foreground">Đã lập phiếu tái nhập — số thật, đã xảy ra</div>
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Cước chiều hoàn</div>
          <div className={cn("numeric text-lg font-bold", p.returnShipping === null && "text-muted-foreground")}>
            {p.returnShipping === null ? "chưa đo được" : formatVND(p.returnShipping)}
          </div>
          <div className="text-[11.5px] text-muted-foreground">
            {p.returnShipping === null ? "Nguồn chưa ghi cước hoàn cho đơn nào — không phải bằng 0" : "Đã phát sinh trên đơn"}
          </div>
        </div>
      </div>

      <ul className="divide-y">
        {p.stages
          .filter((s) => s.parcels > 0)
          .map((s) => (
            <li key={s.key} className="flex flex-wrap items-start gap-x-4 gap-y-1.5 px-4 py-3">
              <div className="min-w-[220px] flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-4 shrink-0 text-[11px] text-muted-foreground">{s.order}</span>
                  <span className="text-[13.5px] font-semibold">{s.label}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium">{s.teamLabel}</span>
                  {s.actionable ? null : <span className="text-[11px] text-muted-foreground">chỉ theo dõi</span>}
                </div>
                <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">{s.moneyMeaning}</p>
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
                <span>
                  <b className="numeric">{formatNumber(s.parcels)}</b> kiện
                  {s.orders !== s.parcels ? <span className="text-muted-foreground"> · {formatNumber(s.orders)} đơn</span> : null}
                </span>
                <span className="numeric font-semibold">{formatVND(s.goodsCost)}</span>
                <span className="text-muted-foreground">
                  giữa {ngay(s.medianAgeHours)} · p90 {ngay(s.p90AgeHours)} · cũ nhất {s.oldestLabel}
                </span>
                {s.slaBreach > 0 ? (
                  <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[11px] font-semibold text-rose-800 dark:bg-rose-950/60 dark:text-rose-300">
                    {formatNumber(s.slaBreach)} quá hạn
                  </span>
                ) : null}
                {s.actionableCount > 0 ? (
                  <Link href={s.href} className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11.5px] font-medium hover:bg-accent">
                    Xử lý <ArrowRight className="size-3" />
                  </Link>
                ) : null}
              </div>
            </li>
          ))}
      </ul>

      {p.conditions.some((c) => c.parcels > 0) ? (
        <div className="flex flex-wrap items-center gap-3 border-t px-4 py-2.5 text-[12px]">
          <PackageOpen className="size-3.5 shrink-0 text-muted-foreground" />
          {p.conditions
            .filter((c) => c.parcels > 0)
            .map((c) => (
              <span key={c.condition}>
                {c.label}: <b className="numeric">{formatNumber(c.parcels)}</b> kiện · {formatVND(c.goodsCost)}
              </span>
            ))}
        </div>
      ) : (
        <div className="border-t px-4 py-2.5 text-[12px] text-muted-foreground">
          Chưa kiện nào được đếm xong, nên chưa có kết luận nào để chia theo tình trạng hàng.
        </div>
      )}
    </SectionCard>
  );
}

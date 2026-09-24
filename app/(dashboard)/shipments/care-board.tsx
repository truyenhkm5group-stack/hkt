"use client";

import { Lock } from "lucide-react";
import { CareOpenButton } from "@/app/(dashboard)/shipments/care-drawer";
import { InfoHint } from "@/components/info-hint";
import type { CareCase } from "@/lib/care/contracts";
import { customerNameForDisplay } from "@/lib/constants/customer-name";
import { CARRIER_SUBSTATES, CARRIER_SUBSTATE_LABEL, type CarrierSubstate } from "@/lib/constants/carrier-substate";
import { formatNumber, formatVND } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ═══════════ BÀN CARE XEM THEO CHẶNG (giao diện Bento) ═══════════
 *
 * CÙNG TẬP KIỆN với bảng — nhận đúng `visible` mà bảng đang vẽ, nên mọi bộ lọc, mọi chip và con số
 * ở dải tóm tắt nói về đúng những thẻ đang thấy. Không có truy vấn thứ hai, không có luật lọc thứ hai.
 *
 * CỘT = ĐVVC ĐANG LÀM GÌ (`carrier.substate`), tức CHỨNG TỪ Viettel Post — không phải trạng thái
 * care của đội và không phải nhãn Pancake. Vì vậy KHÔNG kéo thả được: kéo một thẻ sang cột "Đã
 * giao" là bịa ra một chứng từ. Việc của người (nhận ca, gọi, xin phát tiếp) làm trong ngăn chi
 * tiết, mở bằng cách bấm vào thẻ.
 *
 * Đồng hồ trên thẻ là THỜI GIAN KỂ TỪ TIN ĐVVC CUỐI (độ im lặng), không phải tuổi chặng — hai đồng
 * hồ khác nhau (AGENTS mục 54), nên nhãn nói rõ nó là cái nào.
 */

const SUBSTATE_DOT: Record<CarrierSubstate, string> = {
  AWAITING_PICKUP: "bg-sky-400",
  PICKUP_FAILED: "bg-sky-600",
  PICKED_UP: "bg-blue-500",
  IN_TRANSIT: "bg-blue-500",
  OUT_FOR_DELIVERY: "bg-teal-500",
  WAITING_REDELIVERY: "bg-amber-500",
  WAITING_PROCESSING: "bg-orange-500",
  DELIVERY_EXCEPTION: "bg-rose-500",
  DELIVERED: "bg-emerald-500",
  RETURNING: "bg-red-500",
  RETURNED: "bg-red-700",
  CANCELLED: "bg-zinc-400",
  UNKNOWN: "bg-zinc-400",
};

function imLang(h: number | null): string {
  if (h === null) return "chưa có tin ĐVVC";
  if (h < 1) return "tin ĐVVC <1 giờ";
  if (h < 48) return `tin ĐVVC ${Math.round(h)} giờ trước`;
  return `tin ĐVVC ${Math.round(h / 24)} ngày trước`;
}

export function CareBoard({ cases }: { cases: CareCase[] }) {
  const cot = CARRIER_SUBSTATES.map((s) => ({ s, items: cases.filter((c) => c.carrier.substate === s) })).filter((c) => c.items.length > 0);
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Lock className="size-3.5" aria-hidden />
        Cột theo chứng từ Viettel Post
        <InfoHint>
          Mỗi cột là điều Viettel Post đang báo cho kiện, nên thẻ không kéo sang cột khác được — chuyển cột là việc của chứng từ ĐVVC, không phải của người. Bấm vào thẻ để mở ngăn care: nhận ca, ghi cuộc gọi, xin phát tiếp. Bộ lọc phía trên áp nguyên cho bảng này.
        </InfoHint>
      </p>
      <div className="grid auto-cols-[minmax(280px,320px)] grid-flow-col justify-start gap-3 overflow-x-auto pb-2">
        {cot.map(({ s, items }) => {
          const cod = items.reduce((a, c) => a + c.codAmount, 0);
          return (
            <section key={s} aria-label={CARRIER_SUBSTATE_LABEL[s]} className="flex max-h-[calc(100dvh-var(--app-header-height)-14rem)] min-h-40 flex-col gap-2 rounded-3xl bg-surface-sunken p-2.5">
              <header className="flex flex-col gap-1 px-2 pt-1">
                <div className="flex items-center gap-2">
                  <span className={cn("size-2.5 rounded-[3px]", SUBSTATE_DOT[s])} aria-hidden />
                  <h3 className="text-[13.5px] font-bold">{CARRIER_SUBSTATE_LABEL[s]}</h3>
                  <span className="numeric ml-auto rounded-full bg-card px-2 py-0.5 text-[12px] font-extrabold">{formatNumber(items.length)}</span>
                </div>
                <span className="numeric text-[12px] text-muted-foreground">
                  <b className="text-foreground">{formatVND(cod, { compact: true })}</b> COD
                </span>
              </header>
              <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
                {items.map((c) => {
                  const voHan = c.sla.firstResponseBreached || c.sla.resolveBreached;
                  // Tên khách đi qua CÙNG hàm của bảng: tên giữ chỗ (SĐT, "Khách") không được in như tên thật.
                  const ten = customerNameForDisplay(c.customer, c.phone);
                  return (
                    <CareOpenButton
                      key={c.shipmentId}
                      shipmentId={c.shipmentId}
                      className="flex w-full flex-col gap-1.5 rounded-2xl bg-card p-3 shadow-[var(--shadow-card)] transition-[transform,box-shadow] hover:no-underline hover:-translate-y-px hover:shadow-[var(--shadow-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-[12px] font-semibold">{c.tracking}</span>
                        <span className="numeric ml-auto text-[14px] font-extrabold">{formatVND(c.codAmount, { compact: true })}</span>
                      </span>
                      <span className={cn("truncate text-[12.5px] text-muted-foreground", ten.isPlaceholder && "italic")}>{ten.text}</span>
                      <span className="flex flex-wrap gap-1">
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium" title={c.reasonDetail}>
                          {c.reasonLabel}
                        </span>
                        {voHan ? <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">vỡ SLA</span> : null}
                        {c.carrier.failedAttempts > 0 ? (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px]" title="Số lần phát hụt, đếm từ chứng từ hành trình">
                            hụt {formatNumber(c.carrier.failedAttempts)} lần
                          </span>
                        ) : null}
                      </span>
                      <span className="flex items-center gap-2 border-t border-hairline pt-1.5 text-[11.5px] text-muted-foreground">
                        {c.care.owner ? (
                          <span className="truncate font-medium text-foreground">{c.care.owner.name}</span>
                        ) : (
                          <span className="rounded-full border border-dashed border-amber-500/70 px-1.5 text-amber-700 dark:text-amber-300">Chưa ai nhận</span>
                        )}
                        <span className="ml-auto shrink-0" title="Thời gian kể từ tin cuối của Viettel Post — khác với tuổi chặng">
                          {imLang(c.carrier.ageHours)}
                        </span>
                      </span>
                    </CareOpenButton>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

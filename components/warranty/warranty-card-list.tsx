import Link from "next/link";
import { OpenWarrantyClaimForm, VoidWarrantyCardButton, WarrantyClaimActions } from "@/components/warranty/warranty-forms";
import { WARRANTY_CARD_STATE_LABEL, WARRANTY_CLAIM_STATUS_LABEL, WARRANTY_RESOLUTION_LABEL } from "@/lib/constants/warranty";
import { formatDate, formatVND } from "@/lib/format";
import type { WarrantyCardView } from "@/lib/queries/warranty";
import { cn } from "@/lib/utils";

const STATE_TONE = {
  IN_WARRANTY: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200",
  EXPIRED: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
  VOID: "border-muted bg-muted/40 text-muted-foreground",
} as const;

/** Danh sách phiếu bảo hành + ca của từng phiếu. Dùng ở /warranty và trang khách. */
export function WarrantyCardList({ cards, canWrite, staff, showCustomer = true }: { cards: WarrantyCardView[]; canWrite: boolean; staff: { id: string; name: string }[]; showCustomer?: boolean }) {
  return (
    <ul className="space-y-2" data-warranty-cards={cards.length}>
      {cards.map((c) => (
        <li key={c.id} className="rounded-lg border px-3 py-2 text-sm" data-warranty-card={c.state}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-semibold">
              {c.productName}
              {c.serial ? <span className="ml-1 font-mono text-xs font-normal text-muted-foreground">· {c.serial}</span> : null}
            </span>
            <span className={cn("rounded-full border px-2 py-0.5 text-xs", STATE_TONE[c.state])}>
              {WARRANTY_CARD_STATE_LABEL[c.state]}
              {c.state === "IN_WARRANTY" ? ` · còn ${c.daysLeft} ngày` : c.state === "EXPIRED" ? ` · hết ${-c.daysLeft} ngày` : ""}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {showCustomer ? (
              <>
                <Link href={`/customers/${encodeURIComponent(c.customerId)}`} className="font-medium text-foreground hover:underline">
                  {c.customerName}
                </Link>
                {c.customerPhone ? ` · ${c.customerPhone}` : ""} ·{" "}
              </>
            ) : null}
            mua {formatDate(c.purchasedOn)} · {c.months} tháng · hạn {formatDate(c.expiresOn)}
            {c.note ? ` · ${c.note}` : ""}
            {c.voidReason ? ` · huỷ: ${c.voidReason}` : ""}
          </div>
          {c.claims.length ? (
            <ul className="mt-1.5 space-y-1 border-l-2 pl-2">
              {c.claims.map((x) => (
                <li key={x.id} className="text-xs" data-warranty-claim={x.status}>
                  <span className="font-medium">{WARRANTY_CLAIM_STATUS_LABEL[x.status]}</span> · {formatDate(x.openedAt)} · {x.issue}
                  {x.inWarrantyWhenOpened ? "" : <span className="text-amber-700 dark:text-amber-300"> · ngoài hạn bảo hành</span>}
                  {x.assigneeName ? ` · ${x.assigneeName}` : ""}
                  {x.resolution ? ` · ${WARRANTY_RESOLUTION_LABEL[x.resolution]}` : ""}
                  {x.rejectReason ? ` · từ chối: ${x.rejectReason}` : ""}
                  {x.costVnd !== null ? ` · chi phí ${formatVND(x.costVnd)}` : ""}
                  {x.chargedVnd !== null ? ` · thu khách ${formatVND(x.chargedVnd)}` : ""}
                  {canWrite ? (
                    <div className="mt-0.5">
                      <WarrantyClaimActions id={x.id} status={x.status} customerId={c.customerId} />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {canWrite && c.status === "ACTIVE" ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <OpenWarrantyClaimForm cardId={c.id} customerId={c.customerId} staff={staff} />
              <VoidWarrantyCardButton id={c.id} customerId={c.customerId} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

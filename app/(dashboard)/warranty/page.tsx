import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { WarrantyCardList } from "@/components/warranty/warranty-card-list";
import { WarrantyCardForm } from "@/components/warranty/warranty-forms";
import { can, requirePermission } from "@/lib/auth/session";
import { WARRANTY_CLAIM_STATUS_LABEL } from "@/lib/constants/warranty";
import { formatDate, todayVN } from "@/lib/format";
import { openWarrantyClaims, searchWarrantyCards, warrantyFormOptions } from "@/lib/queries/warranty";

export const metadata = { title: "Bảo hành" };

/**
 * BẢO HÀNH (module `warranty`, 0196 · docs/verticals/household.md) — tra phiếu theo SĐT / serial / tên, hàng đợi ca đang mở,
 * lập phiếu. «Còn bảo hành» tính lúc đọc từ hạn — không cột nào lưu nó.
 */
export default async function WarrantyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePermission("warranty:view");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 80) : "";
  const today = todayVN();
  const canWrite = can(user, "warranty:write");
  const [cards, open, options] = await Promise.all([searchWarrantyCards(q, today), openWarrantyClaims(today), canWrite ? warrantyFormOptions() : Promise.resolve(null)]);
  const staff = options?.staff ?? [];
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Sau bán"
        title="Bảo hành"
        description={`${open.length} ca đang mở`}
        hint="Tra theo số điện thoại, serial / IMEI, tên khách hoặc tên sản phẩm. Một serial chỉ thuộc một phiếu đang hiệu lực. Ca đã xong / từ chối không đổi nữa — ghi nhầm thì mở ca mới. Chi phí và tiền thu khách để trống nghĩa là chưa biết, không phải 0."
      />
      <form className="flex flex-wrap items-center gap-2" action="/warranty">
        <input name="q" defaultValue={q} placeholder="SĐT, serial, tên khách, tên sản phẩm…" className="h-9 w-80 max-w-full rounded-md border bg-background px-3 text-sm" aria-label="Tra phiếu bảo hành" />
        <button type="submit" className="h-9 rounded-md border px-3 text-sm hover:bg-muted">
          Tra
        </button>
        {q ? (
          <Link href="/warranty" className="text-sm text-muted-foreground hover:underline">
            Bỏ lọc
          </Link>
        ) : null}
      </form>

      {open.length ? (
        <SectionCard title="Ca đang mở" description="Cũ nhất trước — ca mở lâu là khách đang chờ.">
          <ul className="divide-y text-sm" data-open-claims={open.length}>
            {open.map((x) => (
              <li key={x.id} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
                <span>
                  <b>{x.card.productName}</b>
                  {x.card.serial ? <span className="font-mono text-xs text-muted-foreground"> · {x.card.serial}</span> : null} · {x.card.customerName}
                  {x.card.customerPhone ? ` · ${x.card.customerPhone}` : ""} — {x.issue}
                  {x.inWarrantyWhenOpened ? "" : <span className="text-amber-700 dark:text-amber-300"> · ngoài hạn</span>}
                </span>
                <span className="text-xs text-muted-foreground">
                  {WARRANTY_CLAIM_STATUS_LABEL[x.status]} · mở {formatDate(x.openedAt)}
                  {x.assigneeName ? ` · ${x.assigneeName}` : " · chưa giao"}
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {canWrite && options ? (
        <SectionCard title="Lập phiếu bảo hành">
          <WarrantyCardForm options={options} today={today} />
        </SectionCard>
      ) : null}

      <SectionCard title={q ? `Kết quả cho «${q}»` : "Phiếu mới nhất"} description={`${cards.length} phiếu`}>
        {cards.length ? <WarrantyCardList cards={cards} canWrite={canWrite} staff={staff} /> : <EmptyState title={q ? "Không có phiếu nào khớp" : "Chưa có phiếu bảo hành nào"} description={canWrite ? "Lập phiếu ở khung phía trên." : undefined} />}
      </SectionCard>
    </div>
  );
}

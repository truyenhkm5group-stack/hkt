import { SectionCard } from "@/components/ui-bits";
import { WarrantyCardList } from "@/components/warranty/warranty-card-list";
import { WarrantyCardForm } from "@/components/warranty/warranty-forms";
import { can, type SessionUser } from "@/lib/auth/session";
import { todayVN } from "@/lib/format";
import { customerWarrantyCards, warrantyFormOptions } from "@/lib/queries/warranty";

/** Khung «Bảo hành» trên trang khách (module `warranty`): phiếu + ca của khách, lập phiếu nhanh cho khách này. */
export async function CustomerWarrantySection({ user, customerId }: { user: SessionUser; customerId: string }) {
  const today = todayVN();
  const canWrite = can(user, "warranty:write");
  const [cards, options] = await Promise.all([customerWarrantyCards(customerId, today), canWrite ? warrantyFormOptions() : Promise.resolve(null)]);
  return (
    <SectionCard id="warranty" title="Bảo hành" description={`${cards.length} phiếu`}>
      <div className="space-y-3">
        {cards.length ? <WarrantyCardList cards={cards} canWrite={canWrite} staff={options?.staff ?? []} showCustomer={false} /> : <p className="text-sm text-muted-foreground">Khách chưa có phiếu bảo hành nào.</p>}
        {canWrite && options ? <WarrantyCardForm options={options} today={today} presetCustomerId={customerId} /> : null}
      </div>
    </SectionCard>
  );
}

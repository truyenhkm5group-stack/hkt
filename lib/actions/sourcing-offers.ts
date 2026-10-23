"use server";

/**
 * Kho mẫu nguồn nhập tay (SRC-3) — server action MỎNG: phiên + quyền `sourcing:write` → lõi `lib/sourcing/offer-service.ts`
 * (zod → CSDL tổ chức → audit) → revalidatePath. Không logic nghiệp vụ nào ở đây.
 */
import { revalidatePath } from "next/cache";
import { can, requireUser } from "@/lib/auth/session";
import {
  addSourcingSnapshot,
  createSourcingOffer,
  setSourcingOfferArchived,
  updateSourcingOffer,
  updateSourcingSupplier,
  type SourcingActor,
  type SourcingOfferResult,
} from "@/lib/sourcing/offer-service";

export type { SourcingOfferResult };

const NO_RIGHT: SourcingOfferResult = { ok: false, errors: [{ message: "Bạn chưa có quyền «Tìm hàng: lưu & sửa mẫu»." }] };

async function withWriter(fn: (actor: SourcingActor) => Promise<SourcingOfferResult>, paths: (r: Extract<SourcingOfferResult, { ok: true }>) => string[]): Promise<SourcingOfferResult> {
  const user = await requireUser();
  if (!can(user, "sourcing:write")) return NO_RIGHT;
  const r = await fn({ id: user.id, email: user.email });
  if (r.ok) for (const p of ["/sourcing", ...paths(r)]) revalidatePath(p);
  return r;
}

export async function createSourcingOfferAction(input: Parameters<typeof createSourcingOffer>[1]): Promise<SourcingOfferResult> {
  return withWriter((a) => createSourcingOffer(a, input), () => []);
}

export async function addSourcingSnapshotAction(input: Parameters<typeof addSourcingSnapshot>[1]): Promise<SourcingOfferResult> {
  return withWriter((a) => addSourcingSnapshot(a, input), () => [`/sourcing/offers/${input.offerId}`]);
}

export async function updateSourcingOfferAction(input: Parameters<typeof updateSourcingOffer>[1]): Promise<SourcingOfferResult> {
  return withWriter((a) => updateSourcingOffer(a, input), () => [`/sourcing/offers/${input.offerId}`]);
}

export async function updateSourcingSupplierAction(input: Parameters<typeof updateSourcingSupplier>[1]): Promise<SourcingOfferResult> {
  return withWriter((a) => updateSourcingSupplier(a, input), () => [`/sourcing/offers/${input.offerId}`]);
}

export async function setSourcingOfferArchivedAction(input: Parameters<typeof setSourcingOfferArchived>[1]): Promise<SourcingOfferResult> {
  return withWriter((a) => setSourcingOfferArchived(a, input), () => [`/sourcing/offers/${input.offerId}`]);
}

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
  type SourcingOfferResult,
} from "@/lib/sourcing/offer-service";

export type { SourcingOfferResult };

const NO_RIGHT: SourcingOfferResult = { ok: false, errors: [{ message: "Bạn chưa có quyền «Tìm hàng: lưu & sửa mẫu»." }] };

function refresh(r: SourcingOfferResult, offerId: string | null): SourcingOfferResult {
  if (!r.ok) return r;
  revalidatePath("/sourcing");
  if (offerId) revalidatePath(`/sourcing/offers/${offerId}`);
  return r;
}

export async function createSourcingOfferAction(input: Parameters<typeof createSourcingOffer>[1]): Promise<SourcingOfferResult> {
  const user = await requireUser();
  if (!can(user, "sourcing:write")) return NO_RIGHT;
  return refresh(await createSourcingOffer({ id: user.id, email: user.email }, input), null);
}

export async function addSourcingSnapshotAction(input: Parameters<typeof addSourcingSnapshot>[1]): Promise<SourcingOfferResult> {
  const user = await requireUser();
  if (!can(user, "sourcing:write")) return NO_RIGHT;
  return refresh(await addSourcingSnapshot({ id: user.id, email: user.email }, input), input.offerId);
}

export async function updateSourcingOfferAction(input: Parameters<typeof updateSourcingOffer>[1]): Promise<SourcingOfferResult> {
  const user = await requireUser();
  if (!can(user, "sourcing:write")) return NO_RIGHT;
  return refresh(await updateSourcingOffer({ id: user.id, email: user.email }, input), input.offerId);
}

export async function updateSourcingSupplierAction(input: Parameters<typeof updateSourcingSupplier>[1]): Promise<SourcingOfferResult> {
  const user = await requireUser();
  if (!can(user, "sourcing:write")) return NO_RIGHT;
  return refresh(await updateSourcingSupplier({ id: user.id, email: user.email }, input), input.offerId);
}

export async function setSourcingOfferArchivedAction(input: Parameters<typeof setSourcingOfferArchived>[1]): Promise<SourcingOfferResult> {
  const user = await requireUser();
  if (!can(user, "sourcing:write")) return NO_RIGHT;
  return refresh(await setSourcingOfferArchived({ id: user.id, email: user.email }, input), input.offerId);
}

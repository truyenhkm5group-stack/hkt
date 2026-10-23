"use server";

/**
 * Lưu mẫu (TEST-) + mua thử (SRC-5a) — server action MỎNG: phiên + quyền `sourcing:write` → lõi `lib/sourcing/trial-service.ts`
 * → revalidatePath. Duyệt / từ chối KHÔNG ở đây: đó là trang Duyệt của lõi (`/approvals`, quyền `approvals:decide`).
 */
import { revalidatePath } from "next/cache";
import { can, requireUser } from "@/lib/auth/session";
import { cancelSourcingTrial, markSourcingTrialOrdered, markSourcingTrialReceived, requestSourcingTrial, saveOfferToShortlist, type TrialResult } from "@/lib/sourcing/trial-service";

export type { TrialResult };

const NO_RIGHT: TrialResult = { ok: false, errors: [{ message: "Bạn chưa có quyền «Tìm hàng: lưu & sửa mẫu»." }] };

function refresh(r: TrialResult, paths: string[]): TrialResult {
  if (r.ok) for (const p of ["/sourcing", ...paths]) revalidatePath(p);
  return r;
}

export async function saveOfferToShortlistAction(input: Parameters<typeof saveOfferToShortlist>[1]): Promise<TrialResult> {
  const user = await requireUser();
  if (!can(user, "sourcing:write")) return NO_RIGHT;
  return refresh(await saveOfferToShortlist({ id: user.id, email: user.email }, input), [`/sourcing/offers/${input.offerId}`, "/models"]);
}

export async function requestSourcingTrialAction(input: Parameters<typeof requestSourcingTrial>[1]): Promise<TrialResult> {
  const user = await requireUser();
  if (!can(user, "sourcing:write")) return NO_RIGHT;
  return refresh(await requestSourcingTrial({ id: user.id, email: user.email }, input), [`/sourcing/offers/${input.offerId}`, "/approvals"]);
}

export async function markSourcingTrialOrderedAction(input: Parameters<typeof markSourcingTrialOrdered>[1]): Promise<TrialResult> {
  const user = await requireUser();
  if (!can(user, "sourcing:write")) return NO_RIGHT;
  return refresh(await markSourcingTrialOrdered({ id: user.id, email: user.email }, input), [`/sourcing/trials/${input.trialId}`, "/approvals"]);
}

export async function markSourcingTrialReceivedAction(input: Parameters<typeof markSourcingTrialReceived>[1]): Promise<TrialResult> {
  const user = await requireUser();
  if (!can(user, "sourcing:write")) return NO_RIGHT;
  return refresh(await markSourcingTrialReceived({ id: user.id, email: user.email }, input), [`/sourcing/trials/${input.trialId}`]);
}

export async function cancelSourcingTrialAction(input: Parameters<typeof cancelSourcingTrial>[1]): Promise<TrialResult> {
  const user = await requireUser();
  if (!can(user, "sourcing:write")) return NO_RIGHT;
  return refresh(await cancelSourcingTrial({ id: user.id, email: user.email }, input), [`/sourcing/trials/${input.trialId}`]);
}

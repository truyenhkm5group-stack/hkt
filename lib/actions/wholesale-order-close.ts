"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import type { CoreResult } from "@/lib/wholesale/campaigns";
import { createOrderFromQuotationCore, type OrderFromQuotation } from "@/lib/wholesale/order-close";
import { saveWholesaleReorderSettingsCore } from "@/lib/wholesale/reorder";

/** Vỏ Next của chốt đơn sỉ + nhắc mua lại sỉ. Nối chuyển khoản dùng thẳng `linkBankTransaction` của sổ ngân hàng (lib/actions/bank.ts). */

export async function createOrderFromQuotationAction(quotationId: string): Promise<CoreResult<OrderFromQuotation>> {
  const user = await requireUser();
  const r = await createOrderFromQuotationCore(user, quotationId);
  if ("ok" in r) {
    revalidatePath(`/wholesale/quotations/${quotationId}`);
    revalidatePath("/orders");
  }
  return r;
}

export async function saveWholesaleReorderSettingsAction(input: unknown): Promise<CoreResult> {
  const user = await requireUser();
  const r = await saveWholesaleReorderSettingsCore(user, input);
  if ("ok" in r) {
    revalidatePath("/wholesale/quotations");
    revalidatePath("/work");
  }
  return r;
}

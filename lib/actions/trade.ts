"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { collectCustomerDebtCore, deactivatePriceListCore, savePriceListCore, setCustomerTermsCore, type CollectDebtInput, type CustomerTermsInput, type PriceListInput, type TradeResult } from "@/lib/records/trade";

/**
 * Vỏ Next của bảng giá · điều khoản bán · thu nợ gộp. Lõi (`lib/records/trade.ts`) tự kiểm quyền từng việc — vỏ chỉ đọc
 * phiên và làm mới đúng các trang có số đổi theo.
 */

function refresh(paths: string[]) {
  for (const p of paths) revalidatePath(p);
}

export async function savePriceListAction(id: string | null, input: PriceListInput): Promise<TradeResult> {
  const user = await requireUser();
  const r = await savePriceListCore(user, id, input);
  if (r.ok) refresh(["/products/price-lists", `/products/price-lists/${r.id}`]);
  return r;
}

export async function deactivatePriceListAction(id: string): Promise<TradeResult> {
  const user = await requireUser();
  const r = await deactivatePriceListCore(user, id);
  if (r.ok) refresh(["/products/price-lists", `/products/price-lists/${id}`]);
  return r;
}

export async function setCustomerTermsAction(customerId: string, input: CustomerTermsInput): Promise<TradeResult> {
  const user = await requireUser();
  const r = await setCustomerTermsCore(user, customerId, input);
  if (r.ok) refresh([`/customers/${customerId}`, "/customers/receivables"]);
  return r;
}

export async function collectCustomerDebtAction(customerId: string, input: CollectDebtInput): Promise<TradeResult> {
  const user = await requireUser();
  const r = await collectCustomerDebtCore(user, customerId, input);
  if (r.ok) refresh([`/customers/${customerId}`, "/customers/receivables", "/orders"]);
  return r.ok ? { ok: true, id: r.id, message: r.message } : r;
}

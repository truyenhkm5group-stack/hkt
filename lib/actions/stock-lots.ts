"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { createStockLotCore, deleteStockLotCore, type LotResult, type StockLotInput } from "@/lib/records/stock-lots";

/** Vỏ Next của lô & hạn dùng. Lõi (`lib/records/stock-lots.ts`) tự kiểm `lots:write`. */

export async function createStockLotAction(input: StockLotInput): Promise<LotResult> {
  const user = await requireUser();
  const r = await createStockLotCore(user, input);
  if (r.ok) revalidatePath("/inventory/lots");
  return r;
}

export async function deleteStockLotAction(id: string, reason: string): Promise<LotResult> {
  const user = await requireUser();
  const r = await deleteStockLotCore(user, id, reason);
  if (r.ok) revalidatePath("/inventory/lots");
  return r;
}

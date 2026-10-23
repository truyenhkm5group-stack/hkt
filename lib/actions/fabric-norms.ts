"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { requireUser } from "@/lib/auth/session";
import { importFabricNormsAs, saveFabricNormAs, type FabricNormImportReport, type FabricNormResult } from "@/lib/inventory/fabric-norms";

/**
 * Lớp mỏng: phiên → dịch vụ (`lib/inventory/fabric-norms.ts`, nơi giữ quyền + lược đồ + nhật ký) →
 * làm mới đúng một trang. Không `router.refresh()` phía client: `revalidatePath` đã dựng lại trang.
 */
export async function saveFabricNorm(input: unknown): Promise<FabricNormResult> {
  const user = await requireUser();
  const r = await saveFabricNormAs(await getDb(), user, input);
  if ("ok" in r) revalidatePath("/inventory/shortage");
  return r;
}

export async function importFabricNorms(input: unknown): Promise<FabricNormImportReport | { error: string }> {
  const user = await requireUser();
  const r = await importFabricNormsAs(await getDb(), user, input);
  if (!("error" in r)) revalidatePath("/inventory/shortage");
  return r;
}

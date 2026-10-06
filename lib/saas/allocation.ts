/**
 * ═══════════ PHÂN BỔ CHI PHÍ NỀN TẢNG VỀ WORKSPACE — THUẦN (docs/saas/COST_BILLING.md §2) ═══════════
 *
 * Mỗi khoản chi khai CĂN CỨ trước khi nhân (cùng tinh thần AGENTS mục 14):
 *  · `DIRECT` — đúng workspace / tài khoản ghi trên dòng;
 *  · `EQUAL_ACTIVE_WORKSPACES` — chia đều cho workspace ĐANG CHẠY trong phạm vi (cả nền tảng, hoặc workspace thuê sản phẩm,
 *    hoặc workspace của tài khoản);
 *  · `AI_COST_SHARE` — chia theo tỷ trọng chi phí AI nền tảng trả của từng workspace trong phạm vi.
 *
 * Khai báo hạ tầng / hỗ trợ NỀN theo tháng (`platform.economics.costs`, 0203) chia `EQUAL_ACTIVE_WORKSPACES` trên mọi workspace
 * đang chạy — kể cả workspace nhà: hạ tầng chung phục vụ cả khách nội bộ, miễn cho nó là đẩy chi phí của mình sang khách.
 *
 * Chưa khai ⇒ `amountVnd = null` (CHƯA BIẾT, luật 42), không phải 0. Làm tròn: phần dư đồng lẻ dồn về các phần đầu để tổng
 * phân bổ BẰNG ĐÚNG số khai — không đồng nào sinh ra hay biến mất trong phép chia.
 */
export type AllocationBasis = "DIRECT" | "EQUAL_ACTIVE_WORKSPACES" | "AI_COST_SHARE";
export type CostScope = "PLATFORM" | "PRODUCT" | "ACCOUNT" | "WORKSPACE";

export const ALLOCATION_BASIS_LABEL: Record<AllocationBasis, string> = {
  DIRECT: "Trực tiếp",
  EQUAL_ACTIVE_WORKSPACES: "Chia đều workspace đang chạy",
  AI_COST_SHARE: "Theo tỷ trọng chi phí AI",
};

export type AllocWorkspace = { orgCode: string; accountId: string | null; active: boolean; products: readonly string[]; aiCostVnd: number };
export type AllocEntry = { id: string; label: string; category: string; scope: CostScope; productKey: string | null; accountId: string | null; orgCode: string | null; basis: AllocationBasis; amountVnd: number };
export type AllocatedLine = { entryId: string; label: string; category: string; basis: AllocationBasis; productKey: string | null; amountVnd: number | null; note: string | null };
export type AllocationResult = { byWorkspace: Map<string, AllocatedLine[]>; byAccount: Map<string, AllocatedLine[]>; unallocated: AllocatedLine[] };

/** Chia `total` theo trọng số, số nguyên, tổng bằng đúng `total`. Trọng số toàn 0 ⇒ `null` (không có căn cứ để chia). */
export function splitInteger(total: number, weights: readonly number[]): number[] | null {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!weights.length || sum <= 0) return null;
  const raw = weights.map((w) => (total * w) / sum);
  const floor = raw.map((x) => Math.floor(x));
  let rest = total - floor.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const o of order) {
    if (rest <= 0) break;
    floor[o.i] += 1;
    rest -= 1;
  }
  return floor;
}

function push<K>(m: Map<K, AllocatedLine[]>, k: K, line: AllocatedLine) {
  m.set(k, [...(m.get(k) ?? []), line]);
}

export function allocateCosts(input: { workspaces: readonly AllocWorkspace[]; declared: { infraMonthlyVnd: number | null; supportMonthlyVnd: number | null }; entries: readonly AllocEntry[] }): AllocationResult {
  const out: AllocationResult = { byWorkspace: new Map(), byAccount: new Map(), unallocated: [] };
  const active = input.workspaces.filter((w) => w.active);

  const spread = (entry: Omit<AllocEntry, "amountVnd"> & { amountVnd: number | null }, pool: readonly AllocWorkspace[]) => {
    const base = { entryId: entry.id, label: entry.label, category: entry.category, basis: entry.basis, productKey: entry.productKey };
    if (!pool.length) {
      out.unallocated.push({ ...base, amountVnd: entry.amountVnd, note: "không có workspace đang chạy trong phạm vi để chia" });
      return;
    }
    if (entry.amountVnd === null) {
      for (const w of pool) push(out.byWorkspace, w.orgCode, { ...base, amountVnd: null, note: "chưa khai số tiền" });
      return;
    }
    const weights = entry.basis === "AI_COST_SHARE" ? pool.map((w) => Math.max(0, w.aiCostVnd)) : pool.map(() => 1);
    const parts = splitInteger(entry.amountVnd, weights);
    if (!parts) {
      out.unallocated.push({ ...base, amountVnd: entry.amountVnd, note: "không có chi phí AI trong phạm vi để chia theo tỷ trọng" });
      return;
    }
    pool.forEach((w, i) => push(out.byWorkspace, w.orgCode, { ...base, amountVnd: parts[i], note: null }));
  };

  // Khai báo nền theo tháng (0203).
  for (const [id, label, amount] of [
    ["declared:infra", "Hạ tầng nền tảng (khai theo tháng)", input.declared.infraMonthlyVnd],
    ["declared:support", "Hỗ trợ khách (khai theo tháng)", input.declared.supportMonthlyVnd],
  ] as const) {
    spread({ id, label, category: id === "declared:infra" ? "INFRA" : "SUPPORT", scope: "PLATFORM", productKey: null, accountId: null, orgCode: null, basis: "EQUAL_ACTIVE_WORKSPACES", amountVnd: amount }, active);
  }

  for (const e of input.entries) {
    const base = { entryId: e.id, label: e.label, category: e.category, basis: e.basis, productKey: e.productKey };
    if (e.scope === "WORKSPACE") {
      push(out.byWorkspace, e.orgCode as string, { ...base, amountVnd: e.amountVnd, note: null });
      continue;
    }
    if (e.scope === "ACCOUNT" && e.basis === "DIRECT") {
      push(out.byAccount, e.accountId as string, { ...base, amountVnd: e.amountVnd, note: null });
      continue;
    }
    const pool = e.scope === "PLATFORM" ? active : e.scope === "PRODUCT" ? active.filter((w) => w.products.includes(e.productKey as string)) : active.filter((w) => w.accountId === e.accountId);
    spread(e, pool);
  }
  return out;
}

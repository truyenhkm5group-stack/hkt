"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { clearMemo } from "@/lib/cache";
import {
  activePlannedEntry,
  appendPlannedCosts,
  ESTIMATED_COST_KEY,
  ESTIMATED_UNIT_COST_MAX,
  parsePlannedCostHistory,
  plannedCostImpact,
  serializePlannedEntry,
  vnDateKey,
  type PlannedCostEntry,
  type PlannedCostImpact,
} from "@/lib/constants/estimated-cost";
import { NO_ORDER_VALUE_FILTER } from "@/lib/constants/order-value";
import { getNominalProfitReport } from "@/lib/queries/profit-nominal";
import { resolvePeriod } from "@/lib/search-params";
import { getSettingJson, setSettingJson } from "@/lib/settings";

/**
 * ═══════════ GIÁ VỐN KẾ HOẠCH — MỘT ĐƯỜNG GHI, MỘT KHOÁ ═══════════
 *
 * Trung tâm giá vốn (`/inventory/cost-center`), nút bút trên Báo cáo lợi nhuận và nút "Dùng làm giá
 * ước tính" của bảng giá thành ĐỀU ghi qua `setPlannedCosts` — không có đường ghi thứ hai, không có
 * bảng giá thứ hai (`docs/cost-center.md`).
 *
 * Đọc bản lưu TỪ MÁY CHỦ rồi chỉ THÊM dòng cho đúng các mã được sửa: client không gửi những mã nó
 * không sửa, nên không có cách nào xoá chúng (cùng bài học với `setDeliveryRateOverride`). Lịch sử
 * KHÔNG BAO GIỜ bị xoá — "bỏ giá" cũng là một dòng (luật 6, `lib/constants/estimated-cost.ts`).
 *
 * KHÔNG qua cổng người thứ hai: giá kế hoạch chỉ đi vào báo cáo lợi nhuận DANH NGHĨA (và trang kế
 * hoạch), không vào lương, không vào dòng tiền thực, không vào phiếu kho, không vào kỳ đã chốt.
 *
 * `clearMemo()` vì người vừa bấm lưu phải thấy NGAY con số mới: báo cáo được nhớ đệm 120 giây, và
 * `revalidatePath` chỉ dựng lại trang chứ không xoá đệm — trang sẽ vẽ lại đúng con số cũ.
 */
const NGAY = /^\d{4}-\d{2}-\d{2}$/;

const itemSchema = z.object({
  productId: z.string().min(1, "Thiếu mã hàng"),
  /** `null` = bỏ giá kế hoạch từ ngày hiệu lực. */
  unitCost: z.number().int("Giá vốn là số nguyên VND").min(1, "Giá vốn kế hoạch phải lớn hơn 0").max(ESTIMATED_UNIT_COST_MAX, "Giá vốn quá lớn — kiểm tra lại số 0").nullable(),
});

const bulkSchema = z.object({
  items: z.array(itemSchema).min(1, "Chưa có mã nào để lưu").max(1000, "Tối đa 1.000 mã mỗi lượt"),
  /** Ngày bắt đầu hiệu lực (giờ VN). `null` = áp cho mọi kỳ. */
  effectiveFrom: z.string().regex(NGAY, "Ngày hiệu lực dạng YYYY-MM-DD").nullable().default(null),
  reason: z.string().trim().min(3, "Phải ghi vì sao đặt con số này"),
});

const REVALIDATE = ["/reports", "/inventory/cost-center", "/inventory/workshop", "/ads/daily", "/reports/target"];

function lamMoi() {
  clearMemo();
  for (const p of REVALIDATE) revalidatePath(p);
}

/** Ghi một lượt giá kế hoạch cho nhiều mã — đường ghi DUY NHẤT. */
export async function setPlannedCosts(input: unknown): Promise<{ ok: true; saved: number } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "reports:assumptions")) return { error: "Không có quyền đặt giá vốn kế hoạch" };
  const parsed = bulkSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { items, effectiveFrom, reason } = parsed.data;
  const ids = new Set<string>();
  for (const it of items) {
    if (ids.has(it.productId)) return { error: "Một mã xuất hiện hai lần trong cùng một lượt lưu" };
    ids.add(it.productId);
  }

  const raw = await getSettingJson<Record<string, unknown>>(ESTIMATED_COST_KEY, {});
  const before = parsePlannedCostHistory(raw);
  const now = new Date();
  const add: Record<string, PlannedCostEntry> = {};
  for (const it of items) {
    add[it.productId] = { unitCost: it.unitCost, effectiveFrom, reason, setAt: now.toISOString(), setBy: user.email, setByUserId: user.id };
  }
  const next = appendPlannedCosts(raw, add);
  const stored: Record<string, { history: Record<string, unknown>[] }> = {};
  for (const [pid, v] of Object.entries(next)) stored[pid] = { history: v.history.map(serializePlannedEntry) };
  await setSettingJson(ESTIMATED_COST_KEY, stored);
  for (const it of items) {
    await audit({
      userId: user.id,
      userEmail: user.email,
      action: "SETTINGS_UPDATE",
      entity: "SETTINGS",
      entityId: `${ESTIMATED_COST_KEY}#${it.productId}`,
      detail: { productId: it.productId, before: activePlannedEntry(before[it.productId] ?? [], now), after: add[it.productId], kind: "PLANNED_COST" },
    });
  }
  lamMoi();
  return { ok: true, saved: items.length };
}

const singleSchema = z.object({
  productId: z.string().min(1, "Thiếu mã hàng"),
  unitCost: z.number(),
  reason: z.string(),
  effectiveFrom: z.string().nullable().optional(),
});

/** Ô bút trên BCLN và nút của bảng giá thành — cùng đường ghi, một mã. */
export async function setEstimatedCost(input: unknown): Promise<{ ok: true } | { error: string }> {
  const p = singleSchema.safeParse(input);
  if (!p.success) return { error: "Dữ liệu không hợp lệ" };
  const r = await setPlannedCosts({ items: [{ productId: p.data.productId, unitCost: p.data.unitCost }], effectiveFrom: p.data.effectiveFrom ?? null, reason: p.data.reason });
  return "error" in r ? r : { ok: true };
}

/** Bỏ giá kế hoạch — mã quay về giá thật / "chưa biết giá vốn". Lịch sử giữ nguyên (luật 6). */
export async function clearEstimatedCost(productId: string, reason = "Bỏ giá vốn kế hoạch"): Promise<{ ok: true } | { error: string }> {
  if (!productId) return { error: "Thiếu mã hàng" };
  const r = await setPlannedCosts({ items: [{ productId, unitCost: null }], effectiveFrom: null, reason });
  return "error" in r ? r : { ok: true };
}

const previewSchema = z.object({
  items: z.array(itemSchema).min(1).max(1000),
  effectiveFrom: z.string().regex(NGAY).nullable().default(null),
  period: z.string().default("30d"),
  from: z.string().optional(),
  to: z.string().optional(),
});

export type PlannedCostPreview = {
  periodLabel: string;
  rows: (PlannedCostImpact & { code: string; productName: string; expectedQty: number; currentUnit: number | null; newUnit: number | null })[];
  totalDeltaNominal: number | null;
  totalDeltaNet: number | null;
};

/**
 * XEM TRƯỚC tác động lên lợi nhuận DỰ TÍNH (chế độ kế hoạch) của kỳ chọn — CHỈ ĐỌC, không ghi gì.
 * Đứng trên đúng báo cáo BCLN dùng (`getNominalProfitReport`, hai chế độ) nên con số xem trước là
 * con số BCLN sẽ in sau khi lưu (`plannedCostImpact`).
 */
export async function previewPlannedCostImpact(input: unknown): Promise<PlannedCostPreview | { error: string }> {
  const user = await requireUser();
  if (!can(user, "reports:assumptions")) return { error: "Không có quyền" };
  const parsed = previewSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { items, effectiveFrom } = parsed.data;
  const period = resolvePeriod({ period: parsed.data.period, from: parsed.data.from, to: parsed.data.to });
  const [keHoach, thucTe] = await Promise.all([
    getNominalProfitReport(period, "ORDERED", NO_ORDER_VALUE_FILTER, true, true, false, "PLANNED"),
    getNominalProfitReport(period, "ORDERED", NO_ORDER_VALUE_FILTER, true, true, false, "ACTUAL"),
  ]);
  const cuoiKy = vnDateKey(period.to ?? new Date());
  const applies = effectiveFrom === null || effectiveFrom <= cuoiKy;
  const riskPct = Number(keHoach.assumptions.inventoryRiskPercent ?? 0);
  const kh = new Map(keHoach.rows.map((r) => [r.productId, r]));
  const tt = new Map(thucTe.rows.map((r) => [r.productId, r]));
  let totalN: number | null = 0;
  let totalR: number | null = 0;
  const rows: PlannedCostPreview["rows"] = items.map((it) => {
    const a = kh.get(it.productId);
    const b = tt.get(it.productId);
    const qty = a?.expectedQty ?? 0;
    const imp = plannedCostImpact(
      { productId: it.productId, expectedQty: qty, currentCogs: a?.expectedCogs ?? 0, currentKnown: a ? a.cogsKnown : true, actualCogs: b?.expectedCogs ?? 0, actualKnown: b ? b.cogsKnown : true },
      it.unitCost,
      { inventoryRiskPercent: riskPct, applies },
    );
    totalN = totalN === null || imp.deltaNominalProfit === null ? null : totalN + imp.deltaNominalProfit;
    totalR = totalR === null || imp.deltaNetProfit === null ? null : totalR + imp.deltaNetProfit;
    const currentUnit = a && a.expectedQty > 0 && a.cogsKnown ? Math.round(a.expectedCogs / a.expectedQty) : (a?.plannedCost?.unitCost ?? null);
    return { ...imp, code: a?.code ?? "", productName: a?.productName ?? "", expectedQty: qty, currentUnit, newUnit: it.unitCost };
  });
  return { periodLabel: period.label, rows, totalDeltaNominal: totalN, totalDeltaNet: totalR };
}

import { cellKey, sizeRank } from "@/lib/constants/production";
import type { PendingVariant } from "@/lib/constants/stock-shortage";

/**
 * ═══════════ HÀNG CHỜ XUẤT THEO MÃ × MÀU × SIZE — ĐỂ TÍNH VẢI CẦN ĐẶT ═══════════
 *
 * Chủ shop yêu cầu (28/09/2026): *"làm chi tiết số lượng hàng chờ xuất theo mã hàng, theo màu, theo
 * size để tính toán lượng vải cần đặt"*.
 *
 * Vải mua theo MÀU của một MÃ hàng, còn lượng vải một chiếc tốn thì đổi theo SIZE. Nên đơn vị trình
 * bày là một bảng cho mỗi mã: hàng = màu, cột = size, cuối hàng = tổng của màu (đúng số đem nhân định
 * mức), cuối cột = tổng của size.
 *
 * ─── BA CON SỐ, KHÔNG GỘP ───
 *
 *   · CHỜ XUẤT — số cái đơn đã chốt đang giữ, hàng chưa rời kho. Cùng vị ngữ `RESERVED_IN_WAREHOUSE`
 *     với cột "đã chốt" của sổ kho; cộng cả mẫu đủ hàng lẫn mẫu chưa biết tồn.
 *   · THIẾU — phần chờ xuất mà tồn thực tế không phân được (`allocateStock`, đơn lên trước được hàng
 *     trước). Đây mới là số phải SẢN XUẤT.
 *   · CẦN ĐẶT THÊM — thiếu trừ hàng đã đặt xưởng chưa về (`stillShortAfterOrder`, cùng phép trừ với
 *     Lark và trang Quyết định vốn). Đây là số phải MUA VẢI thêm; đặt theo "chờ xuất" là mua vải cho
 *     cả những chiếc đang nằm sẵn trên kệ.
 *
 * Mẫu CHƯA CÓ PHIẾU NHẬP thì không biết thiếu bao nhiêu: số chờ xuất của nó đứng riêng ở `unknown`
 * của từng ô, KHÔNG được cộng vào thiếu (thành "thiếu hết") cũng không được coi là 0 (thành "đủ").
 * Màn hình in chúng ra thành "+?" — AGENTS.md mục 42.
 *
 * Hàm THUẦN: không đọc CSDL, không đọc đồng hồ; chạy hai lần ra một.
 */

export const PENDING_MEASURES = ["pending", "short", "toOrder"] as const;
export type PendingMeasure = (typeof PENDING_MEASURES)[number];

export const PENDING_MEASURE_LABEL: Record<PendingMeasure, string> = {
  pending: "Chờ xuất",
  short: "Thiếu",
  toOrder: "Cần đặt thêm",
};

export const PENDING_MEASURE_HINT: Record<PendingMeasure, string> = {
  pending: "Số cái các đơn đã chốt đang giữ, hàng chưa rời kho — gồm cả phần kho đang có sẵn.",
  short: "Phần chờ xuất mà tồn thực tế không đủ phân (đơn lên trước được hàng trước) — số phải sản xuất.",
  toOrder: "Thiếu trừ hàng đã đặt xưởng chưa về — số cần mua vải / đặt may THÊM.",
};

/** Ô trống màu / size trong danh mục. */
export const NO_OPTION = "—";

export type PendingCell = {
  pending: number;
  /** Tổng thiếu của các mẫu ĐÃ BIẾT tồn. */
  short: number;
  /** Tổng cần đặt thêm của các mẫu ĐÃ BIẾT tồn. */
  toOrder: number;
  /** Số cái chờ xuất của mẫu CHƯA BIẾT tồn — thiếu / cần đặt của chúng không tính được. */
  unknown: number;
};

export type PendingMatrix = {
  productId: string;
  productCode: string;
  productName: string;
  colors: string[];
  sizes: string[];
  cells: Record<string, PendingCell>;
  byColor: Record<string, PendingCell>;
  bySize: Record<string, PendingCell>;
  total: PendingCell;
};

const zero = (): PendingCell => ({ pending: 0, short: 0, toOrder: 0, unknown: 0 });

function add(into: PendingCell, v: PendingVariant): void {
  into.pending += v.pending;
  if (v.shortQty === null || v.toOrder === null) into.unknown += v.pending;
  else {
    into.short += v.shortQty;
    into.toOrder += v.toOrder;
  }
}

const opt = (s: string) => s.trim() || NO_OPTION;

/** Mỗi mã hàng một bảng màu × size; mã nhiều hàng chờ xuất nhất đứng đầu. */
export function buildPendingMatrices(variants: readonly PendingVariant[]): PendingMatrix[] {
  const groups = new Map<string, PendingVariant[]>();
  for (const v of variants) {
    if (!(v.pending > 0)) continue;
    groups.set(v.productId, [...(groups.get(v.productId) ?? []), v]);
  }
  const out: PendingMatrix[] = [];
  for (const [productId, list] of groups) {
    const cells: Record<string, PendingCell> = {};
    const byColor: Record<string, PendingCell> = {};
    const bySize: Record<string, PendingCell> = {};
    const total = zero();
    for (const v of list) {
      const c = opt(v.color);
      const s = opt(v.size);
      // Hai mẫu cùng màu/size (danh mục trùng) dồn vào MỘT ô — xưởng may theo màu/size, không theo mã mẫu.
      for (const cell of [(cells[cellKey(c, s)] ??= zero()), (byColor[c] ??= zero()), (bySize[s] ??= zero()), total]) add(cell, v);
    }
    const colors = Object.keys(byColor).sort((a, b) => byColor[b].pending - byColor[a].pending || a.localeCompare(b, "vi"));
    const sizes = Object.keys(bySize).sort((a, b) => sizeRank(a) - sizeRank(b) || a.localeCompare(b, "vi"));
    const head = [...list].sort((a, b) => (a.variantId < b.variantId ? -1 : 1))[0];
    out.push({ productId, productCode: head.productCode, productName: head.productName, colors, sizes, cells, byColor, bySize, total });
  }
  return out.sort((a, b) => b.total.pending - a.total.pending || (a.productCode || a.productName).localeCompare(b.productCode || b.productName, "vi") || (a.productId < b.productId ? -1 : 1));
}

/** Giá trị của một ô theo con số đang xem, kèm phần CHƯA BIẾT (chỉ có ở Thiếu / Cần đặt thêm). */
export function measureOf(c: PendingCell | undefined, m: PendingMeasure): { qty: number; unknown: number } {
  if (!c) return { qty: 0, unknown: 0 };
  if (m === "pending") return { qty: c.pending, unknown: 0 };
  return { qty: m === "short" ? c.short : c.toOrder, unknown: c.unknown };
}

/** "12", "12 +?" hoặc "?" — CHƯA BIẾT không bao giờ in thành 0. */
export function measureText(v: { qty: number; unknown: number }, fmt: (n: number) => string = String): string {
  if (v.unknown > 0) return v.qty > 0 ? `${fmt(v.qty)} +?` : "?";
  return fmt(v.qty);
}

/* ═══════════════════ TÍNH VẢI ═══════════════════ */

/**
 * Định mức vải do người đặt vải gõ — ERP KHÔNG có định mức (chưa có bảng định mức nguyên liệu), nên
 * không đoán hộ. Định mức theo size ghi đè định mức chung; hao hụt cộng thêm theo phần trăm.
 */
export type FabricNorm = {
  /** Lượng vải / cái áp cho size chưa khai riêng. */
  common: number | null;
  bySize: Record<string, number | null>;
  /** Hao hụt %, ví dụ 5 = cộng thêm 5%. */
  wastePct: number | null;
  unit: string;
};

export const EMPTY_FABRIC_NORM: FabricNorm = { common: null, bySize: {}, wastePct: null, unit: "m" };

const positive = (n: number | null | undefined): number | null => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null);

export function normForSize(norm: FabricNorm, size: string): number | null {
  return positive(norm.bySize[size]) ?? positive(norm.common);
}

export type FabricLine = {
  color: string;
  /** Số cái ĐÃ BIẾT của màu theo con số đang xem. */
  qty: number;
  /** Số cái chưa biết tồn — không vào phép tính vải. */
  unknown: number;
  /** Lượng vải đã cộng hao hụt. `null` = còn size có hàng mà chưa khai định mức. */
  fabric: number | null;
};

export type FabricPlan = {
  lines: FabricLine[];
  /** `null` khi còn một màu chưa tính được — không in một tổng thiếu mà trông như đủ. */
  total: number | null;
  /** Size có hàng mà chưa khai định mức (kể cả định mức chung). */
  missingSizes: string[];
  unknown: number;
};

/**
 * Vải cần cho từng màu = Σ theo size (số cái × định mức size) × (1 + hao hụt%). Làm tròn lên 0,1
 * đơn vị — mua thiếu vài phân vải là thiếu một chiếc áo.
 */
export function fabricPlan(m: PendingMatrix, measure: PendingMeasure, norm: FabricNorm): FabricPlan {
  const waste = 1 + Math.max(0, positive(norm.wastePct) ?? 0) / 100;
  const missing = new Set<string>();
  let unknownAll = 0;
  const lines = m.colors.map((color): FabricLine => {
    let qty = 0;
    let unknown = 0;
    let raw = 0;
    let complete = true;
    for (const size of m.sizes) {
      const v = measureOf(m.cells[cellKey(color, size)], measure);
      qty += v.qty;
      unknown += v.unknown;
      if (!(v.qty > 0)) continue;
      const per = normForSize(norm, size);
      if (per === null) {
        complete = false;
        missing.add(size);
      } else raw += v.qty * per;
    }
    unknownAll += unknown;
    return { color, qty, unknown, fabric: complete ? Math.ceil(raw * waste * 10 - 1e-9) / 10 : null };
  });
  const total = lines.every((l) => l.fabric !== null) ? Math.round(lines.reduce((t, l) => t + (l.fabric ?? 0), 0) * 10) / 10 : null;
  return { lines, total, missingSizes: m.sizes.filter((s) => missing.has(s)), unknown: unknownAll };
}

/**
 * Văn bản dạng bảng (tab) để dán vào Excel / Google Sheet / Zalo. Ô chưa biết in "?" giống màn hình.
 */
export function pendingMatrixAsText(m: PendingMatrix, measure: PendingMeasure, norm?: FabricNorm | null): string {
  const plan = norm ? fabricPlan(m, measure, norm) : null;
  const withFabric = plan && plan.lines.some((l) => l.fabric !== null);
  const head = `${m.productCode || m.productName}${m.productCode ? ` · ${m.productName}` : ""} — ${PENDING_MEASURE_LABEL[measure]}`;
  const lines = [head, ["Màu", ...m.sizes, "Tổng", ...(withFabric ? [`Vải (${norm?.unit || "m"})`] : [])].join("\t")];
  m.colors.forEach((c, i) => {
    const row = m.sizes.map((s) => measureText(measureOf(m.cells[cellKey(c, s)], measure)));
    const fab = withFabric ? [plan.lines[i].fabric === null ? "?" : String(plan.lines[i].fabric)] : [];
    lines.push([c, ...row, measureText(measureOf(m.byColor[c], measure)), ...fab].join("\t"));
  });
  const fabTotal = withFabric ? [plan.total === null ? "?" : String(plan.total)] : [];
  lines.push(["Tổng", ...m.sizes.map((s) => measureText(measureOf(m.bySize[s], measure))), measureText(measureOf(m.total, measure)), ...fabTotal].join("\t"));
  return lines.join("\n");
}

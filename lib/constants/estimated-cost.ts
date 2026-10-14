import { breakEvenSpend, spendPerOrder } from "@/lib/constants/break-even-cpo";
import { receiptPriceEntry, type MarketerPriceEntry } from "@/lib/constants/marketer-price";

/**
 * ═══════════ GIÁ VỐN DỰ TÍNH — CHỖ TRỐNG ĐƯỢC LẤP BẰNG MỘT CON SỐ CÓ TÊN NGƯỜI ĐẶT ═══════════
 *
 * Chủ shop yêu cầu 23/09/2026: *"tự đặt giá vốn hàng nhập dự tính cho những mã chưa có giá nhập
 * thực tế, để xem lợi nhuận mã và margin theo giá nhập dự tính, tỷ lệ GTC dự tính, từ đó căn % CPQC
 * khi chạy ads"*.
 *
 * Trước bản này, sản phẩm không có giá vốn (không phiếu nhập, không giá Pancake) bị
 * `LINE_UNIT_COST` tính **0 ₫** — ô giá vốn in "—", nhưng LỢI NHUẬN vẫn trừ 0 đồng, nên đúng những
 * mã mới đang cần căn quảng cáo nhất lại trông như lãi trọn tiền hàng. Trần CPQC tính trên con số đó
 * sẽ bảo chủ shop được đốt quá tay.
 *
 * ─── BỐN LUẬT ───
 *
 *   1. GIÁ THẬT LUÔN THẮNG. Giá dự tính chỉ lấp ĐÚNG những sản phẩm mà `LINE_UNIT_COST` ra 0 —
 *      có phiếu nhập hay giá Pancake là con số đặt tay tự đứng sang một bên, không cần ai gỡ.
 *   2. CHỈ BÁO CÁO LỢI NHUẬN DANH NGHĨA đọc nó (`getNominalProfitReport(…, withEstimatedCost)`,
 *      mặc định TẮT). Bảng lương, báo cáo marketer, dòng tiền thực, sổ kho, tồn kho đều không đọc:
 *      một con số đoán không được đi vào tiền của ai (AGENTS.md mục 7) hay vào chứng từ nào.
 *      NGOẠI LỆ DUY NHẤT (chủ shop chốt 23/09/2026): bảng "Bóc tách theo MKTer" ở /ads/daily
 *      (`lib/queries/marketer-daily-nominal.ts`) đọc giá dự tính, vì nó phải nói CÙNG con số với
 *      tab Lợi nhuận danh nghĩa — đo production: 522 sản phẩm/30 ngày chưa có giá vốn, trừ 0 ₫ thì
 *      LN ròng lệch −150,7% (lãi thành lỗ). Bảng ấy không vào lương và mang nhãn "dự tính".
 *   3. LƯU Ở KHOÁ RIÊNG (`profit.estimatedCosts`), không trong `profit.assumptions`: lược đồ của
 *      `saveProfitAssumptions` bỏ mọi trường nó không biết, nên để chung là mỗi lần sửa khối Giả
 *      định thì toàn bộ giá dự tính biến mất, im lặng.
 *   4. MANG NHÃN Ở MỌI CHỖ NÓ ĐI QUA (AGENTS.md mục 8.6): phần tiền dự tính là một trường riêng
 *      (`expectedCogsEstimated`) chứ không tan vào tổng.
 *   5. GIÁ DỰ TÍNH = GIÁ BÁO MKT (chủ shop chốt 26/09/2026, "mọi chỗ đang dùng giá dự tính"). Mã
 *      đã khai giá báo thì giá dự tính của nó LÀ giá báo đang hiệu lực vào cuối kỳ — cùng phép chọn
 *      dòng với phiếu nhập kho (`receiptPriceEntry`); giá báo 0 ₫ coi là chưa định giá, như ở kho.
 *      Mã chưa khai giá báo mới dùng con số đặt tay ở Bàn dự tính. Nhất quán với quyết định
 *      25/09/2026 "luôn lấy giá báo MKT" làm giá nhập kho: hàng đã nhập mang giá báo, hàng chưa có
 *      giá thì dự tính cũng bằng giá báo. Giá THẬT vẫn luôn thắng (luật 1).
 *      Ngoại lệ thứ hai của luật 2 (cùng ngày): trang Kế hoạch mục tiêu lợi nhuận
 *      (`lib/queries/profit-target.ts`) bật giá dự tính, để kịch bản "giữ nguyên" nói cùng lợi
 *      nhuận với tab Lợi nhuận danh nghĩa. Trang ấy không vào lương.
 *
 * ─── SỬA 13/10/2026 (chủ shop, P0 "Hợp nhất giá vốn") — `docs/cost-center.md` ───
 *
 * Con số này nay mang tên **GIÁ VỐN KẾ HOẠCH** và có ĐÚNG MỘT nơi đặt: Trung tâm giá vốn
 * (`/inventory/cost-center`); nút bút trên BCLN và nút "Dùng làm giá ước tính" của bảng giá thành
 * đi qua CÙNG đường ghi. Ba luật đổi, có tên người quyết:
 *
 *   5'. GIÁ KẾ HOẠCH ĐẶT TAY THẮNG GIÁ BÁO MKT. Luật 5 cũ để giá báo thắng, nên chủ shop sửa giá
 *       Q004 trên BCLN mà con số không đổi — ô sửa "không có tác dụng" (gốc của lỗi P0). Giá báo MKT
 *       nay chỉ là THAM CHIẾU LÙI cho mã CHƯA đặt giá kế hoạch, mang nguồn `MARKETER_PRICE` và nhãn
 *       riêng ở mọi màn hình; nó không bao giờ ghi đè một con số người đã đặt. Lương MKT vẫn đọc giá
 *       báo như cũ — đó là cơ sở hoa hồng, không phải giá vốn của shop.
 *   6.  CÓ NGÀY HIỆU LỰC VÀ KHÔNG XOÁ LỊCH SỬ. Mỗi lần đặt là MỘT dòng thêm vào lịch sử của mã
 *       (`PlannedCostEntry`), "bỏ giá" cũng là một dòng (`unitCost = null`). Tại một thời điểm, mỗi mã
 *       có ĐÚNG MỘT dòng hiệu lực: ngày hiệu lực muộn nhất ≤ thời điểm, hoà thì dòng ghi sau. Bản lưu
 *       cũ (một dòng không ngày) đọc như hiệu lực từ đầu — không cần migration, không backfill.
 *   7.  HAI CHẾ ĐỘ BÁO CÁO (`CostMode`). `ACTUAL` = giá thật (bậc thang `LINE_UNIT_COST`) và chỉ lấp
 *       chỗ trống bằng giá kế hoạch, nhãn "Tạm tính" — đúng hành vi cũ. `PLANNED` = mọi sản phẩm của
 *       mã đã đặt giá kế hoạch tính theo giá kế hoạch, kể cả khi có phiếu nhập: đó là chế độ trả lời
 *       "nếu giá vốn là X thì lãi bao nhiêu". Mã chưa có giá kế hoạch thì đứng trên giá thật và mang
 *       nhãn nói ra điều đó. Không trộn hai nguồn mà không gắn nhãn (AGENTS.md mục 8.6).
 */
export const ESTIMATED_COST_KEY = "profit.estimatedCosts";

/** Chế độ giá vốn của báo cáo lợi nhuận danh nghĩa — luật 7. */
export type CostMode = "ACTUAL" | "PLANNED";

export const COST_MODE_LABEL: Record<CostMode, string> = {
  ACTUAL: "Giá vốn thực tế",
  PLANNED: "Giá vốn kế hoạch",
};

/** `?gv=kehoach` ⇒ PLANNED; mọi thứ khác ⇒ ACTUAL (mặc định cũ — mở trang không con số nào xê dịch). */
export function parseCostMode(v: string | null | undefined): CostMode {
  return v === "kehoach" ? "PLANNED" : "ACTUAL";
}

/** Nguồn giá vốn của MỘT mã trên một dòng báo cáo — nhãn bắt buộc ở mọi ô giá vốn. */
export type CostBasis =
  /** Giá thật đủ cho mọi sản phẩm (phiếu nhập / giá Pancake). */
  | "ACTUAL"
  /** Chế độ thực tế, có sản phẩm chưa có giá thật được lấp bằng giá kế hoạch / tham chiếu. */
  | "PROVISIONAL"
  /** Chế độ kế hoạch, mã đã đặt giá kế hoạch. */
  | "PLANNED"
  /** Chế độ kế hoạch, mã CHƯA đặt giá kế hoạch ⇒ đứng trên giá thật. */
  | "ACTUAL_NO_PLAN"
  /** Còn sản phẩm không có giá nào (đang tính 0 ₫). */
  | "UNKNOWN";

export const COST_BASIS_LABEL: Record<CostBasis, string> = {
  ACTUAL: "Thực tế",
  PROVISIONAL: "Tạm tính",
  PLANNED: "Kế hoạch",
  ACTUAL_NO_PLAN: "Thực tế (chưa đặt kế hoạch)",
  UNKNOWN: "Chưa biết",
};

export type EstimatedCost = {
  /** Giá vốn dự tính cho MỘT sản phẩm (VND, số nguyên dương). */
  unitCost: number;
  /** Vì sao đặt con số này — báo giá xưởng, lô thử… Bắt buộc: con số không lý do là con số không ai kiểm lại được. */
  reason: string;
  setAt: string | null;
  /** Email người đặt — MÁY CHỦ đọc từ phiên đăng nhập, không nhận từ client (mục 34). */
  setBy: string | null;
  /** Nguồn của con số: giá kế hoạch đặt tay, hay tham chiếu lùi giá báo MKT (luật 5'). Thiếu = đặt tay. */
  source?: "MANUAL" | "MARKETER_PRICE";
  /** Ngày bắt đầu hiệu lực (YYYY-MM-DD, giờ VN). `null` = hiệu lực từ đầu (mọi kỳ). */
  effectiveFrom?: string | null;
};

export type EstimatedCostMap = Record<string, EstimatedCost>;

/** Trần hợp lý cho một đơn giá nhập: chặn gõ nhầm thêm ba số 0, không phải một ngưỡng nghiệp vụ. */
export const ESTIMATED_UNIT_COST_MAX = 100_000_000;

/**
 * MỘT DÒNG LỊCH SỬ giá vốn kế hoạch của một mã (luật 6). `unitCost = null` = dòng "bỏ giá kế hoạch"
 * từ ngày ấy — giữ lại để lịch sử không bao giờ mất một lần sửa.
 */
export type PlannedCostEntry = {
  unitCost: number | null;
  effectiveFrom: string | null;
  reason: string;
  setAt: string | null;
  setBy: string | null;
  /** `users.id` do máy chủ đọc từ phiên (AGENTS.md mục 34). Bản lưu cũ không có ⇒ `null`. */
  setByUserId?: string | null;
};

export type PlannedCostHistory = Record<string, PlannedCostEntry[]>;

const NGAY = /^\d{4}-\d{2}-\d{2}$/;

/** Ngày lịch VN (YYYY-MM-DD) của một thời điểm — so ngày hiệu lực theo giờ Việt Nam, không theo UTC. */
export function vnDateKey(at: Date): string {
  return new Date(at.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

function docMotDong(v: unknown): PlannedCostEntry | null {
  if (!v || typeof v !== "object") return null;
  const x = v as Record<string, unknown>;
  const eff = typeof x.effectiveFrom === "string" && NGAY.test(x.effectiveFrom) ? x.effectiveFrom : null;
  const base = {
    effectiveFrom: eff,
    reason: typeof x.reason === "string" ? x.reason : "",
    setAt: typeof x.setAt === "string" ? x.setAt : null,
    setBy: typeof x.setBy === "string" ? x.setBy : null,
    setByUserId: typeof x.setByUserId === "string" ? x.setByUserId : null,
  };
  // Dòng "bỏ giá" phải KHAI RÕ (`cleared: true`) — một ô hỏng không được hiểu nhầm thành lệnh bỏ giá.
  if (x.cleared === true) return { ...base, unitCost: null };
  const unitCost = Math.round(Number(x.unitCost));
  if (!Number.isFinite(unitCost) || unitCost <= 0 || unitCost > ESTIMATED_UNIT_COST_MAX) return null;
  return { ...base, unitCost };
}

/**
 * Đọc bản lưu thành LỊCH SỬ theo mã. Nhận cả hai dáng: bản cũ `{ [mã]: {unitCost,…} }` (một dòng,
 * hiệu lực từ đầu) và bản mới `{ [mã]: { history: [...] } }`. Dòng hỏng bị BỎ, không thành 0 ₫.
 */
export function parsePlannedCostHistory(raw: unknown): PlannedCostHistory {
  const out: PlannedCostHistory = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [productId, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!productId || !v || typeof v !== "object") continue;
    const list = Array.isArray((v as { history?: unknown }).history) ? ((v as { history: unknown[] }).history) : [v];
    const entries = list.map(docMotDong).filter((e): e is PlannedCostEntry => e !== null);
    if (entries.length) out[productId] = entries;
  }
  return out;
}

/** Thứ tự quyết định của luật 6: ngày hiệu lực (không ngày = sớm nhất), rồi lúc ghi. */
function sauHon(a: PlannedCostEntry, b: PlannedCostEntry): boolean {
  const ea = a.effectiveFrom ?? "";
  const eb = b.effectiveFrom ?? "";
  if (ea !== eb) return ea > eb;
  return (a.setAt ?? "") >= (b.setAt ?? "");
}

/**
 * Dòng ĐANG HIỆU LỰC của một mã vào thời điểm `at` (luật 6). Hàm THUẦN. `null` = không có giá kế
 * hoạch (chưa đặt, đã bỏ, hoặc mọi dòng đều hiệu lực SAU `at`).
 */
export function activePlannedEntry(entries: readonly PlannedCostEntry[], at: Date): PlannedCostEntry | null {
  const ngay = vnDateKey(at);
  let best: PlannedCostEntry | null = null;
  for (const e of entries) {
    if (e.effectiveFrom !== null && e.effectiveFrom > ngay) continue;
    if (!best || sauHon(e, best)) best = e;
  }
  return best && best.unitCost !== null ? best : null;
}

/** Bảng giá kế hoạch đang hiệu lực vào `at` của mọi mã. */
export function activePlannedCosts(history: PlannedCostHistory, at: Date): EstimatedCostMap {
  const out: EstimatedCostMap = {};
  for (const [productId, entries] of Object.entries(history)) {
    const e = activePlannedEntry(entries, at);
    if (!e || e.unitCost === null) continue;
    out[productId] = { unitCost: e.unitCost, reason: e.reason, setAt: e.setAt, setBy: e.setBy, effectiveFrom: e.effectiveFrom };
  }
  return out;
}

/**
 * Đọc bản lưu một cách PHÒNG THỦ: dòng hỏng thì BỎ dòng đó, không bao giờ biến nó thành 0 ₫ —
 * một giá vốn 0 ₫ đặt tay còn tệ hơn chỗ trống, vì nó mang nhãn "đã có người đặt". Trả bảng giá
 * kế hoạch ĐANG HIỆU LỰC vào `at` (mặc định bây giờ).
 */
export function parseEstimatedCosts(raw: unknown, at: Date = new Date()): EstimatedCostMap {
  return activePlannedCosts(parsePlannedCostHistory(raw), at);
}

/**
 * Bản lưu mới sau khi THÊM các dòng (luật 6) — không bao giờ xoá dòng cũ, KỂ CẢ dòng đọc không hiểu
 * (giữ nguyên văn: đọc hỏng hôm nay không được thành mất dữ liệu ngày mai). Mã ở dáng cũ được chuyển
 * sang dáng lịch sử với chính dòng cũ đứng đầu. Hàm THUẦN.
 */
export function appendPlannedCosts(raw: unknown, add: Record<string, PlannedCostEntry>): Record<string, unknown> {
  const goc: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  for (const [pid, e] of Object.entries(add)) {
    const cu = goc[pid];
    const lichSu: unknown[] =
      cu && typeof cu === "object" && Array.isArray((cu as { history?: unknown }).history) ? [...(cu as { history: unknown[] }).history] : cu && typeof cu === "object" ? [cu] : [];
    goc[pid] = { history: [...lichSu, serializePlannedEntry(e)] };
  }
  return goc;
}

/** Dạng lưu của một dòng: dòng bỏ giá mang `cleared: true`, không mang `unitCost`. */
export function serializePlannedEntry(e: PlannedCostEntry): Record<string, unknown> {
  const { unitCost, ...rest } = e;
  return unitCost === null ? { ...rest, cleared: true } : { ...rest, unitCost };
}

export type MarketerPriceForEstimate = MarketerPriceEntry & { reason: string; setBy: string };

/**
 * LUẬT 5' (13/10/2026) — giá kế hoạch của từng mã, có tham chiếu lùi giá báo MKT. Hàm THUẦN.
 *
 *  · Mã ĐÃ ĐẶT giá kế hoạch (đang hiệu lực) ⇒ giá kế hoạch, nguồn `MANUAL`. Giá báo KHÔNG ghi đè.
 *  · Chưa đặt mà có giá báo áp được (> 0) vào `at` ⇒ giá báo, nguồn `MARKETER_PRICE` (tham chiếu).
 *  · Không cái nào ⇒ mã không có trong bảng: CHƯA BIẾT, không bao giờ 0 ₫.
 */
export function estimatedCostsWithMarketerPrice(manual: EstimatedCostMap, prices: Record<string, readonly MarketerPriceForEstimate[]>, at: Date): EstimatedCostMap {
  const out: EstimatedCostMap = {};
  for (const [productId, v] of Object.entries(manual)) out[productId] = { ...v, source: "MANUAL" };
  for (const [productId, entries] of Object.entries(prices)) {
    if (out[productId]) continue;
    const e = receiptPriceEntry(entries, at);
    if (!e || !(e.price > 0) || e.price > ESTIMATED_UNIT_COST_MAX) continue;
    const tu = e.effectiveFrom.toISOString().slice(0, 10).split("-").reverse().join("/");
    out[productId] = {
      unitCost: Math.round(e.price),
      reason: `Giá báo MKT hiệu lực từ ${tu}${e.reason ? ` — ${e.reason}` : ""}`,
      setAt: e.effectiveFrom.toISOString(),
      setBy: e.setBy || null,
      source: "MARKETER_PRICE",
    };
  }
  return out;
}

/**
 * ═══════════ XEM TRƯỚC TÁC ĐỘNG KHI SỬA GIÁ KẾ HOẠCH ═══════════
 *
 * Trả lời "đổi giá kế hoạch thành X thì lợi nhuận DỰ TÍNH (chế độ kế hoạch) của kỳ đổi bao nhiêu"
 * TRƯỚC khi lưu. Hàm THUẦN, đứng trên đúng hai dòng báo cáo của mã (chế độ kế hoạch = hiện tại,
 * chế độ thực tế = đích khi BỎ giá kế hoạch), nên nó nói cùng con số với BCLN sau khi lưu.
 *
 *   giá vốn mới   = SL giao TC ước tính × giá mới       (bỏ giá ⇒ giá vốn chế độ thực tế)
 *   Δ LN danh nghĩa = −(giá vốn mới − giá vốn hiện tại)
 *   Δ LN ròng       = Δ LN danh nghĩa × (1 + % dự phòng rủi ro tồn kho)   — dự phòng đi theo giá vốn (mục 14)
 *
 * Giá ĐÍCH không biết được (bỏ giá mà mã chưa có giá thật) ⇒ Δ là `null`, KHÔNG phải 0.
 * Ngày hiệu lực SAU cuối kỳ xem trước ⇒ `applies = false`, Δ = 0 thật (kỳ đó không đổi).
 */
export type PlannedCostImpactInput = {
  productId: string;
  /** SL giao TC ước tính của mã trong kỳ (cùng phép cân với BCLN). */
  expectedQty: number;
  /** Giá vốn chế độ KẾ HOẠCH hiện tại của mã. */
  currentCogs: number;
  currentKnown: boolean;
  /** Giá vốn chế độ THỰC TẾ (đích khi bỏ giá kế hoạch). */
  actualCogs: number;
  actualKnown: boolean;
};

export type PlannedCostImpact = {
  productId: string;
  applies: boolean;
  newCogs: number | null;
  deltaCogs: number | null;
  deltaNominalProfit: number | null;
  deltaNetProfit: number | null;
};

export function plannedCostImpact(row: PlannedCostImpactInput, newUnit: number | null, opts: { inventoryRiskPercent: number; applies: boolean }): PlannedCostImpact {
  if (!opts.applies) return { productId: row.productId, applies: false, newCogs: row.currentKnown ? row.currentCogs : null, deltaCogs: 0, deltaNominalProfit: 0, deltaNetProfit: 0 };
  const newCogs = newUnit !== null ? Math.round(Math.max(0, row.expectedQty) * newUnit) : row.actualKnown ? row.actualCogs : null;
  if (newCogs === null || !row.currentKnown) return { productId: row.productId, applies: true, newCogs, deltaCogs: null, deltaNominalProfit: null, deltaNetProfit: null };
  const deltaCogs = newCogs - row.currentCogs;
  const risk = Math.max(0, opts.inventoryRiskPercent) / 100;
  return { productId: row.productId, applies: true, newCogs, deltaCogs, deltaNominalProfit: -deltaCogs, deltaNetProfit: -Math.round(deltaCogs * (1 + risk)) };
}

/**
 * Phép chọn ĐÍCH của bản xem trước cho MỘT mã — hàm THUẦN (dùng ở `previewPlannedCostImpact`).
 *
 *  · Giá đích = dòng hiệu lực vào `at` của lịch sử SAU khi thêm; không đổi so với trước ⇒ Δ 0.
 *  · Đích là "bỏ giá" ⇒ giá thật; chỉ biết chắc khi mã KHÔNG còn sản phẩm chưa có giá thật, vì chỗ
 *    trống sẽ được lấp bằng giá tham chiếu mà bản xem trước không tính lại ⇒ Δ `null`.
 */
export function previewImpactForItem(input: {
  productId: string;
  before: readonly PlannedCostEntry[];
  after: readonly PlannedCostEntry[];
  at: Date;
  planned: { expectedQty: number; expectedCogs: number; cogsKnown: boolean } | null;
  actual: { expectedCogs: number; cogsKnown: boolean; cogsUnknownQty: number } | null;
  inventoryRiskPercent: number;
}): PlannedCostImpact {
  const giaTruoc = activePlannedEntry(input.before, input.at)?.unitCost ?? null;
  const giaSau = activePlannedEntry(input.after, input.at)?.unitCost ?? null;
  const a = input.planned;
  const b = input.actual;
  return plannedCostImpact(
    { productId: input.productId, expectedQty: a?.expectedQty ?? 0, currentCogs: a?.expectedCogs ?? 0, currentKnown: a ? a.cogsKnown : true, actualCogs: b?.expectedCogs ?? 0, actualKnown: b ? b.cogsUnknownQty === 0 && b.cogsKnown : true },
    giaSau,
    { inventoryRiskPercent: input.inventoryRiskPercent, applies: giaSau !== giaTruoc },
  );
}

/**
 * ═══════════ TRẦN CPQC — CHI BAO NHIÊU QUẢNG CÁO THÌ MÃ CÒN ĐẠT BIÊN MUỐN CÓ ═══════════
 *
 * Mọi khoản trong lợi nhuận danh nghĩa của một mã KHÔNG phụ thuộc quảng cáo, trừ hai: chính CPQC và
 * "chi phí khác" (= CPQC × %, phí thẻ ngoại tệ). Nên:
 *
 *     LN trước QC   = LN danh nghĩa + CPQC + CP khác
 *     LN(chi = A)   = LN trước QC − A × (1 + %khác)
 *     Trần(biên m)  = (LN trước QC − m × DT GTC ƯT) ÷ (1 + %khác)          m = 0 ⇒ hoà vốn
 *
 * rồi quy ra hai đơn vị người chạy quảng cáo dùng hằng ngày: **% doanh số POS** (cùng mẫu số với cột
 * CPQC "DS" của bảng — so thẳng được) và **CPQC tối đa trên mỗi đơn chốt** (so với "chi phí mỗi kết
 * quả" trên Trình quản lý quảng cáo).
 *
 * ─── GIỚI HẠN PHẢI NÓI RA ───
 *
 * Đây là phép tính TẠI ĐIỂM HIỆN TẠI: giữ nguyên tỷ lệ GTC, giá bán bình quân và phần vận hành đã
 * phân bổ. Vận hành cố định không nở ra khi đơn tăng, nên chạy mạnh hơn thì trần thật nhích lên
 * chút ít — con số này nghiêng về phía THẬN TRỌNG, không phía liều.
 *
 * Trần ≤ 0 là một câu trả lời thật: mã LỖ (hoặc dưới biên muốn có) ngay cả khi không tiêu đồng
 * quảng cáo nào. Màn hình in đúng câu đó, không in "0%" như thể còn được chạy tới 0.
 *
 * Biên mục tiêu KHÔNG có mặc định (AGENTS.md mục 38): người xem gõ, không gõ thì chỉ có trần hoà vốn.
 */
export type AdsCeilingPoint = {
  /** Số tiền CPQC tối đa của kỳ (VND). ≤ 0 ⇒ không còn chỗ cho quảng cáo. */
  spend: number;
  /** Trần tính theo % doanh số POS. `null` khi chưa có doanh số để chia. */
  overPosSales: number | null;
  /** Trần trên mỗi đơn chốt (VND). `null` khi chưa có đơn. */
  perOrder: number | null;
};

export type AdsCeiling = {
  profitBeforeAds: number;
  breakEven: AdsCeilingPoint;
  /** `null` khi người xem chưa gõ biên mục tiêu. */
  target: AdsCeilingPoint | null;
  /**
   * Khoảng cách từ CPQC hiện tại tới trần HOÀ VỐN, tính theo điểm % doanh số POS. Dương = còn dư,
   * âm = đang vượt. `null` khi không có mẫu số.
   */
  headroomPoints: number | null;
};

export function adsCeiling(input: {
  netProfit: number;
  adSpend: number;
  otherCost: number;
  expectedRevenue: number;
  posSales: number;
  orders: number;
  /** Chi phí khác theo % CPQC (Giả định `otherCostPercentOfAds`), đơn vị %. */
  otherCostPercentOfAds: number;
  /** Biên lợi nhuận mong muốn trên DT GTC ước tính (%). `null` = chưa đặt. */
  targetMarginPct: number | null;
}): AdsCeiling {
  const profitBeforeAds = input.netProfit + input.adSpend + input.otherCost;
  // Chia cho (1 + %khác) và chia cho số đơn đi qua ĐƯỜNG DUY NHẤT `lib/constants/break-even-cpo.ts`
  // — bảng quyết định `/ads` gọi cùng hàm, nên "CPO hoà vốn" không có công thức thứ hai.
  const diem = (spend: number): AdsCeilingPoint => ({
    spend: Math.round(spend),
    overPosSales: input.posSales > 0 ? (spend / input.posSales) * 100 : null,
    perOrder: spendPerOrder(spend, input.orders),
  });
  const breakEven = diem(breakEvenSpend(profitBeforeAds, input.otherCostPercentOfAds));
  const target =
    input.targetMarginPct === null || !Number.isFinite(input.targetMarginPct)
      ? null
      : diem(breakEvenSpend(profitBeforeAds - (input.targetMarginPct / 100) * input.expectedRevenue, input.otherCostPercentOfAds));
  const hienTai = input.posSales > 0 ? (input.adSpend / input.posSales) * 100 : null;
  return {
    profitBeforeAds,
    breakEven,
    target,
    headroomPoints: breakEven.overPosSales === null || hienTai === null ? null : breakEven.overPosSales - hienTai,
  };
}

/** Đọc biên mục tiêu từ URL (`?bien=12.5`). Rỗng / sai / ngoài (−100, 100) ⇒ `null`, không đoán. */
export function parseTargetMargin(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v.trim() === "") return null;
  const n = Number(v.replace(",", "."));
  if (!Number.isFinite(n) || n <= -100 || n >= 100) return null;
  return n;
}

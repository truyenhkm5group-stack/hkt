import type { CostLineInput } from "@/lib/constants/production-os";
import { openQtyAfterReceived } from "@/lib/constants/workshop-ledger";
import { formatVND } from "@/lib/format";

/**
 * ═══════════ LỐI TẮT SẢN XUẤT — ĐIỀN SẴN, NGƯỜI LƯU (Company OS · Agent SC, 27/09/2026) ═══════════
 *
 * Đo production 27/09: đội làm sản xuất NGOÀI ERP (0 topic · 0 giá thành · 0 mẫu · 0 bản duyệt · 0/8
 * phiếu nhập nối lệnh). Từng bước đã có trên ERP nhưng đi từ bước này sang bước kia là nhiều màn hình và
 * gõ lại. Ba lối tắt ở đây chỉ RÚT NGẮN ĐƯỜNG ĐI:
 *
 *  1. Bản duyệt → "Lập lệnh SX": mở ĐÚNG trình sửa lệnh có sẵn, chọn sẵn bản duyệt + xưởng, ô số lượng
 *     là gợi ý của Kế hoạch SX (`buildMatrixForProduct` — đúng thứ máy chủ tính lại và lưu vào
 *     `suggested_cells` lúc bấm Chốt, nên luật "lệch gợi ý phải ghi lý do" vẫn đứng nguyên).
 *  2. Lệnh SX ĐÃ GỬI → "Nhập kho theo lệnh SX": mở ĐÚNG hộp thoại Nhập hàng, điền sẵn xưởng · lệnh ·
 *     số còn phải nhập = ô của lệnh − đã nhập qua phiếu nối lệnh (MỘT phép trừ `openQtyAfterReceived`).
 *  3. Topic ĐÃ CHỐT → "Lập giá thành V1": tạo bảng NHÁP qua đúng lõi giá thành, dòng chỉ lấy từ thứ
 *     topic ĐANG CÓ (giá xưởng báo, hoặc giá SX mong muốn — gắn nhãn đúng là gì); không bịa cơ cấu.
 *
 * KHÔNG lối tắt nào tự ghi thay người: (1) và (2) chỉ mở màn hình có sẵn, người sửa rồi bấm lưu qua
 * server action có sẵn; (3) ghi một bảng NHÁP (sửa / xoá dòng được, chốt vẫn cần `production:approve`).
 * Tệp này THUẦN: không đọc CSDL, không đồng hồ — cùng đầu vào luôn ra cùng kết quả.
 */

export type ShortcutState = { enabled: true; href?: string } | { enabled: false; reason: string; href?: string; hrefLabel?: string };

// ───────────────────────── 1. BẢN DUYỆT → LẬP LỆNH SX ─────────────────────────

/** Trạng thái lệnh coi là "đang mở" — đúng định nghĩa `openOrders` của `getModelProductionSummary`. */
export const OPEN_PO_STATUSES = ["DRAFT", "SENT"] as const;

export const PO_SHORTCUT_REASON = {
  NO_PERMISSION: "Cần quyền lập bảng đặt hàng (planning:write)",
  NO_DESIGN: "Chưa có bản thiết kế đã duyệt — duyệt mẫu trước",
  NO_PRODUCT: "Mẫu chưa có mã sản phẩm Pancake — chốt mã chính thức ở trang mẫu trước khi đặt xưởng",
  OPEN_PO: (code: string) => `Đã có lệnh ${code} đang mở trỏ bản duyệt này — mở lệnh đó thay vì lập lệnh thứ hai`,
} as const;

export function newPoHref(productId: string, designVersionId: string | null): string {
  return `/inventory/planning/orders/new?product=${encodeURIComponent(productId)}${designVersionId ? `&design=${encodeURIComponent(designVersionId)}` : ""}`;
}

/**
 * Nút "Lập lệnh SX" của MỘT bản duyệt. Thứ tự lý do là thứ tự người đọc sửa được: quyền → có bản duyệt
 * chưa → có sản phẩm chưa → đã có lệnh đang mở trỏ bản này chưa (bấm lần hai không đẻ lệnh thứ hai:
 * nút thành đường tới lệnh đã có).
 */
export function poShortcutState(i: {
  canWrite: boolean;
  productId: string | null;
  designVersionId: string | null;
  openOrders: readonly { id: string; code: string; status: string; designVersionId: string | null }[];
}): ShortcutState {
  if (!i.canWrite) return { enabled: false, reason: PO_SHORTCUT_REASON.NO_PERMISSION };
  if (!i.designVersionId) return { enabled: false, reason: PO_SHORTCUT_REASON.NO_DESIGN };
  if (!i.productId) return { enabled: false, reason: PO_SHORTCUT_REASON.NO_PRODUCT };
  const dangMo = i.openOrders.find((o) => o.designVersionId === i.designVersionId && (OPEN_PO_STATUSES as readonly string[]).includes(o.status));
  if (dangMo) return { enabled: false, reason: PO_SHORTCUT_REASON.OPEN_PO(dangMo.code), href: `/inventory/planning/orders/${dangMo.id}`, hrefLabel: `Mở lệnh ${dangMo.code}` };
  return { enabled: true, href: newPoHref(i.productId, i.designVersionId) };
}

/**
 * Bản duyệt chọn sẵn trên trình sửa lệnh khi mở từ lối tắt: CHỈ khi mã trên URL nằm trong danh sách bản
 * duyệt của CHÍNH mẫu đang đặt (máy chủ `validatePoPlan` vẫn kiểm lại lúc lưu). Mã lạ ⇒ không chọn gì.
 */
export function prefillDesignId(options: readonly { id: string }[], requested: string | null | undefined): string | null {
  const id = (requested ?? "").trim();
  return id && options.some((o) => o.id === id) ? id : null;
}

export type SupplierPrefill = { name: string; source: "TOPIC" | "SAMPLE" };

/**
 * Xưởng điền sẵn: xưởng khai trên TOPIC của mẫu đã duyệt, không có thì xưởng đã làm CHÍNH mẫu được
 * duyệt. Cả hai là chứng từ đã có; không có cái nào ⇒ để trống (người gõ), không đoán theo lệnh cũ.
 */
export function prefillSupplier(i: { topicSupplier: string | null; sampleSupplier: string | null }): SupplierPrefill | null {
  const t = (i.topicSupplier ?? "").trim();
  if (t) return { name: t, source: "TOPIC" };
  const s = (i.sampleSupplier ?? "").trim();
  if (s) return { name: s, source: "SAMPLE" };
  return null;
}

// ───────────────────────── 2. LỆNH SX ĐÃ GỬI → NHẬP KHO THEO LỆNH ─────────────────────────

export const RECEIPT_SHORTCUT_REASON = {
  NO_PERMISSION: "Cần quyền nhập kho (inventory:write)",
  NOT_SENT: "Lệnh SX chưa gửi xưởng — bấm “Đánh dấu đã gửi xưởng” trước",
  RECEIVED: "Lệnh đã đóng (đã nhận hàng) — hàng về thêm thì lập phiếu Nhập hàng thường",
  CANCELLED: "Lệnh đã huỷ",
  NO_PRODUCT: "Lệnh không gắn sản phẩm — không biết mẫu mã nào để điền",
  NOTHING_LEFT: "Phiếu nối lệnh này đã nhập đủ số của lệnh — hàng về thêm thì lập phiếu Nhập hàng thường",
} as const;

export const RECEIPT_PREFILL_PARAM = "nhap-lenh";

export function receiptShortcutHref(poId: string): string {
  return `/inventory/receipts?${RECEIPT_PREFILL_PARAM}=${encodeURIComponent(poId)}`;
}

/** Nút "Nhập kho theo lệnh SX". `remainingTotal = null` = chưa tính (danh sách lệnh) — nút vẫn mở, trang phiếu tự nói ra. */
export function receiptShortcutState(i: { canWrite: boolean; status: string; productId: string | null; poId: string; remainingTotal: number | null }): ShortcutState {
  if (!i.canWrite) return { enabled: false, reason: RECEIPT_SHORTCUT_REASON.NO_PERMISSION };
  if (i.status === "DRAFT") return { enabled: false, reason: RECEIPT_SHORTCUT_REASON.NOT_SENT };
  if (i.status === "RECEIVED") return { enabled: false, reason: RECEIPT_SHORTCUT_REASON.RECEIVED };
  if (i.status !== "SENT") return { enabled: false, reason: RECEIPT_SHORTCUT_REASON.CANCELLED };
  if (!i.productId) return { enabled: false, reason: RECEIPT_SHORTCUT_REASON.NO_PRODUCT };
  if (i.remainingTotal !== null && i.remainingTotal <= 0) return { enabled: false, reason: RECEIPT_SHORTCUT_REASON.NOTHING_LEFT };
  return { enabled: true, href: receiptShortcutHref(i.poId) };
}

/** Ghép ô "màu|size" với mẫu mã — cùng phép chuẩn hoá (trim + chữ thường) với `openPoQtyByVariant`. */
const norm = (v: string) => v.trim().toLowerCase();

export type ReceiptPrefillRow = { variantId: string; cells: string[]; planned: number; received: number; remaining: number };
export type ReceiptPrefill = {
  rows: ReceiptPrefillRow[];
  /** Ô của lệnh không ghép được mẫu mã nào — KHÔNG điền (không biết điền vào đâu), in ra cho người nhập tay. */
  unmapped: { cell: string; qty: number }[];
  remainingTotal: number;
};

/**
 * Số còn phải nhập theo lệnh, theo từng mẫu mã = ô của lệnh − đã nhập qua phiếu NHẬP HÀNG nối lệnh.
 * MỘT phép trừ: `openQtyAfterReceived(planned, 0, received)` của sổ đặt xưởng (không bao giờ âm — nhập
 * vượt thì mẫu mã đó còn 0). Hai ô ghép về CÙNG một mẫu mã được cộng TRƯỚC rồi mới trừ, để số đã nhập
 * không bị trừ hai lần. Hàm THUẦN.
 */
export function receiptPrefillFromPo(
  po: { productId: string | null; cells: Record<string, number> },
  variants: readonly { id: string; productId: string; color: string; size: string }[],
  receivedByVariant: ReadonlyMap<string, number>,
): ReceiptPrefill {
  const byKey = new Map<string, string>();
  for (const v of variants) if (v.productId === po.productId) byKey.set(`${norm(v.color)}|${norm(v.size)}`, v.id);
  const planned = new Map<string, { qty: number; cells: string[] }>();
  const unmapped: { cell: string; qty: number }[] = [];
  for (const [cell, raw] of Object.entries(po.cells ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const qty = Math.max(0, Math.trunc(Number(raw) || 0));
    if (!qty) continue;
    const sep = cell.indexOf("|");
    const color = sep >= 0 ? cell.slice(0, sep) : cell;
    const size = sep >= 0 ? cell.slice(sep + 1) : "";
    const variantId = po.productId ? byKey.get(`${norm(color)}|${norm(size)}`) : undefined;
    if (!variantId) {
      unmapped.push({ cell, qty });
      continue;
    }
    const cur = planned.get(variantId) ?? { qty: 0, cells: [] };
    planned.set(variantId, { qty: cur.qty + qty, cells: [...cur.cells, cell] });
  }
  const rows: ReceiptPrefillRow[] = [];
  for (const [variantId, p] of planned) {
    const received = Math.max(0, receivedByVariant.get(variantId) ?? 0);
    rows.push({ variantId, cells: p.cells, planned: p.qty, received, remaining: openQtyAfterReceived(p.qty, 0, received) });
  }
  return { rows, unmapped, remainingTotal: rows.reduce((t, r) => t + r.remaining, 0) };
}

// ───────────────────────── 3. TOPIC ĐÃ CHỐT → LẬP GIÁ THÀNH V1 ─────────────────────────

export const COST_V1_REASON = {
  NO_PERMISSION: "Cần quyền lập bảng giá thành (production:write)",
  NOT_SELECTED: "Topic chưa chốt phương án — chốt phương án rồi mới lập giá thành từ topic",
  HAS_SHEET: "Mẫu đã có bảng giá thành — sửa bảng nháp hoặc tạo phiên bản mới ở bảng dưới",
} as const;

export function costV1ShortcutState(i: { canWrite: boolean; topicStatus: string; costSheetCount: number }): ShortcutState {
  if (!i.canWrite) return { enabled: false, reason: COST_V1_REASON.NO_PERMISSION };
  if (i.costSheetCount > 0) return { enabled: false, reason: COST_V1_REASON.HAS_SHEET };
  if (i.topicStatus !== "SELECTED") return { enabled: false, reason: COST_V1_REASON.NOT_SELECTED };
  return { enabled: true };
}

export const QUOTE_LINE_LABEL = "Giá xưởng báo";
export const TARGET_LINE_LABEL = "Giá SX mong muốn của shop (chưa phải giá xưởng báo)";

export type CostV1Prefill = {
  /** `QUOTE` = xưởng đã báo đúng MỘT mức giá · `TARGET` = chưa có báo giá, dùng giá SX shop mong muốn · `NONE` = mở bảng trống. */
  source: "QUOTE" | "TARGET" | "NONE";
  lines: CostLineInput[];
  /** Câu nói ra vì sao điền như vậy (in cạnh nút và vào ghi chú bảng). */
  note: string;
};

/**
 * Dòng khởi tạo của giá thành V1 — CHỈ từ thứ topic đang giữ, và luôn là MỘT dòng `OTHER` (không bịa
 * cơ cấu vải / công / phụ liệu):
 *
 *  · Lượt trao đổi "Báo giá" mang giá: nếu mọi lượt báo CÙNG một mức ⇒ dòng "Giá xưởng báo".
 *    Nhiều mức khác nhau ⇒ KHÔNG chọn hộ (mức nào ứng với phương án đã chốt là điều máy không biết) —
 *    mở bảng trống và liệt kê các mức đã báo cho người chọn.
 *  · Chưa có báo giá nào mà topic có "Giá SX mong muốn" ⇒ dòng mang nhãn rõ đó là giá SHOP MUỐN, không
 *    phải giá xưởng báo.
 *  · Không có giá nào ⇒ bảng trống.
 */
export function costV1Prefill(i: { quotes: readonly { price: number | null }[]; targetPrice: number | null }): CostV1Prefill {
  const prices = i.quotes.map((q) => q.price).filter((p): p is number => typeof p === "number" && Number.isFinite(p) && p > 0);
  const distinct = [...new Set(prices.map((p) => Math.round(p)))];
  if (distinct.length === 1) {
    return {
      source: "QUOTE",
      lines: [{ kind: "OTHER", description: QUOTE_LINE_LABEL, qty: 1, unit: "sp", unitCost: distinct[0] }],
      note: `Điền từ báo giá của xưởng trong topic (${prices.length} lượt, cùng một mức). Tách vải / công / phụ liệu khi xưởng gửi chi tiết.`,
    };
  }
  if (distinct.length > 1) {
    return { source: "NONE", lines: [], note: `Xưởng đã báo ${distinct.length} mức giá khác nhau (${[...distinct].sort((a, b) => a - b).map((p) => formatVND(p)).join(" · ")}) — chọn mức của phương án đã chốt và gõ vào bảng.` };
  }
  const t = i.targetPrice;
  if (typeof t === "number" && Number.isFinite(t) && t > 0) {
    return {
      source: "TARGET",
      lines: [{ kind: "OTHER", description: TARGET_LINE_LABEL, qty: 1, unit: "sp", unitCost: Math.round(t) }],
      note: "Chưa có báo giá của xưởng — dòng này là giá SX shop MONG MUỐN ghi ở topic, sửa khi xưởng báo giá.",
    };
  }
  return { source: "NONE", lines: [], note: "Topic chưa có giá nào (không báo giá, không giá SX mong muốn) — mở bảng trống." };
}

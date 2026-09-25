/**
 * ═══════════ SỔ ĐẶT XƯỞNG — LUẬT TÍNH (hàm thuần, không đọc/ghi CSDL) ═══════════
 *
 * Thay bảng tính "BÁO CÁO ĐẶT HÀNG". Mỗi con số trên màn hình đi qua đúng một hàm ở đây — trang lô,
 * trang vải, trang thanh toán và bảng giá sản xuất thực tế không tự cộng lại.
 *
 * ─── BA CHỖ BẢNG TÍNH CŨ NÓI SAI MÀ KHÔNG AI THẤY ───
 *
 * 1. **Ô trống bị đọc thành 0.** "Đơn giá" để trống thì TỔNG = 0đ, "Còn phải thanh toán" = 0đ và
 *    "Trạng thái thanh toán" trông như đã xong. Ở đây đơn giá chưa có ⇒ tiền công `null` ⇒ còn phải
 *    trả `null` ⇒ trạng thái "Chưa có đơn giá" (AGENTS.md mục 3, mục 42).
 * 2. **Chưa chốt số lượng mà đã ra tổng tiền.** Khi SL chốt thanh toán còn trống, tiền công TẠM TÍNH
 *    theo số xưởng đã thực trả và mang nhãn tạm tính — không lặng lẽ lấy số ĐẶT (đặt 400 mà xưởng
 *    trả 240 là chuyện có thật: Q003 lô 1).
 * 3. **"Chưa gán vải" và "vải do xưởng lo" cùng ra 0đ tiền vải.** Cái đầu là THIẾU dữ liệu, cái sau
 *    là giá trọn gói. Lô phải khai ai lo vải; shop lo vải mà chưa gán đợt vải nào thì giá SX thực tế
 *    là CHƯA BIẾT, không phải một con số rẻ bất thường.
 *
 * ─── ĐÂY KHÔNG PHẢI GIÁ VỐN TRONG BÁO CÁO LỢI NHUẬN ───
 *
 * Giá vốn vào lợi nhuận có đúng một nguồn là phiếu kho (mục 13, 15). Giá SX thực tế ở đây là THƯỚC ĐO
 * để người nhập phiếu kho biết ghi giá nào, và để thấy phiếu kho đang ghi lệch — nó KHÔNG tự sửa
 * giá trên phiếu nào.
 */

export const BATCH_STATUSES = ["OPEN", "DONE", "CANCELLED"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];
export const BATCH_STATUS_LABEL: Record<BatchStatus, string> = { OPEN: "Đang sản xuất", DONE: "Xưởng đã trả xong", CANCELLED: "Huỷ" };

export const FABRIC_SOURCES = ["SHOP", "WORKSHOP"] as const;
export type FabricSource = (typeof FABRIC_SOURCES)[number];
export const FABRIC_SOURCE_LABEL: Record<FabricSource, string> = {
  SHOP: "Shop mua vải, xưởng may công",
  WORKSHOP: "Xưởng lo vải (giá trọn gói)",
};

export const PAYMENT_KINDS = ["DEPOSIT", "PAYMENT", "REFUND"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];
export const PAYMENT_KIND_LABEL: Record<PaymentKind, string> = { DEPOSIT: "Đặt cọc", PAYMENT: "Thanh toán", REFUND: "Bên kia hoàn tiền" };

export const PAYMENT_METHODS = ["BANK", "CASH", "OTHER"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = { BANK: "Chuyển khoản", CASH: "Tiền mặt", OTHER: "Khác" };

/** Đơn vị vải hay dùng — chỉ là GỢI Ý cho ô nhập, ô vẫn gõ tự do. */
export const FABRIC_UNITS = ["m", "kg", "cây", "cuộn", "yard"] as const;

/** Chuẩn hoá mã hàng: cắt khoảng trắng, IN HOA. "q002 " và "Q002" là một mã. */
export function normalizeProductCode(raw: string): string {
  return raw.trim().replace(/\s+/g, "").toUpperCase();
}

// ─────────────────────────── TIỀN ĐÃ TRẢ ───────────────────────────

export type PaymentLike = { kind: string; amount: number };

/** Đã trả = cọc + thanh toán − tiền bên kia hoàn lại. `deposit` là riêng phần cọc (cột "Số tiền cọc"). */
export function paidTotals(payments: readonly PaymentLike[]): { paid: number; deposit: number; count: number } {
  let paid = 0;
  let deposit = 0;
  for (const p of payments) {
    if (p.kind === "REFUND") paid -= p.amount;
    else {
      paid += p.amount;
      if (p.kind === "DEPOSIT") deposit += p.amount;
    }
  }
  return { paid, deposit, count: payments.length };
}

// ─────────────────────────── TIỀN CÔNG ───────────────────────────

export type LaborInput = {
  agreedQty: number | null;
  laborUnitPrice: number | null;
  /** Thưởng (+) / phạt khác (−). */
  adjustment: number;
  /** Phạt xưởng vì sai sót / trả chậm ("Hoàn phạt MKT") — luôn ≥ 0, TRỪ vào tiền công. */
  penalty?: number;
};

export type LaborCost = {
  /** Tiền công phải trả xưởng. `null` = CHƯA BIẾT (thiếu đơn giá, hoặc chưa chốt SL mà xưởng chưa trả chiếc nào). */
  amount: number | null;
  /** Số lượng làm căn cứ nhân đơn giá. */
  qtyBasis: number | null;
  /** AGREED = theo SL đã chốt · DELIVERED_ESTIMATE = tạm tính theo số xưởng đã trả (chưa chốt) */
  basis: "AGREED" | "DELIVERED_ESTIMATE" | null;
  reason: string;
};

/** Tiền công = SL chốt × đơn giá + thưởng/phạt − phạt xưởng. Chưa chốt SL ⇒ tạm tính theo số đã trả, có nhãn. */
export function laborCost(b: LaborInput, deliveredQty: number): LaborCost {
  const extra = b.adjustment - Math.max(0, b.penalty ?? 0);
  if (b.laborUnitPrice == null) return { amount: null, qtyBasis: null, basis: null, reason: "Chưa nhập đơn giá công" };
  if (b.agreedQty != null) return { amount: b.agreedQty * b.laborUnitPrice + extra, qtyBasis: b.agreedQty, basis: "AGREED", reason: "SL chốt × đơn giá + thưởng/phạt − phạt xưởng" };
  if (deliveredQty > 0)
    return { amount: deliveredQty * b.laborUnitPrice + extra, qtyBasis: deliveredQty, basis: "DELIVERED_ESTIMATE", reason: "TẠM TÍNH theo số xưởng đã trả — chưa chốt SL thanh toán" };
  return { amount: null, qtyBasis: null, basis: null, reason: "Chưa chốt SL thanh toán và xưởng chưa trả chiếc nào" };
}

// ─────────────────────────── TRẠNG THÁI THANH TOÁN ───────────────────────────

export const PAYMENT_STATES = ["NO_PRICE", "UNPAID", "DEPOSITED", "PARTIAL", "PAID", "OVERPAID"] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];
export const PAYMENT_STATE_LABEL: Record<PaymentState, string> = {
  NO_PRICE: "Chưa có số phải trả",
  UNPAID: "Chưa thanh toán",
  DEPOSITED: "Đã cọc",
  PARTIAL: "Trả một phần",
  PAID: "Đã xong",
  OVERPAID: "Trả thừa",
};
export const PAYMENT_STATE_TONE: Record<PaymentState, string> = {
  NO_PRICE: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  UNPAID: "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  DEPOSITED: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  PARTIAL: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  PAID: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  OVERPAID: "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
};

export type PaymentStatus = { state: PaymentState; payable: number | null; paid: number; deposit: number; remaining: number | null };

/**
 * `payable` là số PHẢI TRẢ (tiền công của lô, hoặc thành tiền của đợt vải). `null` ⇒ còn phải trả
 * cũng `null` — không bao giờ in "0đ" cho một khoản chưa biết là bao nhiêu.
 */
export function paymentStatus(payable: number | null, payments: readonly PaymentLike[]): PaymentStatus {
  const { paid, deposit } = paidTotals(payments);
  if (payable == null) return { state: "NO_PRICE", payable, paid, deposit, remaining: null };
  const remaining = payable - paid;
  let state: PaymentState;
  if (paid <= 0) state = payable === 0 ? "PAID" : "UNPAID";
  else if (remaining === 0) state = "PAID";
  else if (remaining < 0) state = "OVERPAID";
  else state = paid === deposit ? "DEPOSITED" : "PARTIAL";
  return { state, payable, paid, deposit, remaining };
}

// ─────────────────────────── TRẠNG THÁI TRẢ HÀNG ───────────────────────────

export const DELIVERY_STATES = ["NOT_STARTED", "IN_PROGRESS", "DONE", "CANCELLED"] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];
export const DELIVERY_STATE_LABEL: Record<DeliveryState, string> = {
  NOT_STARTED: "Chưa trả hàng",
  IN_PROGRESS: "Đang trả hàng",
  DONE: "Đã xong",
  CANCELLED: "Huỷ",
};
export const DELIVERY_STATE_TONE: Record<DeliveryState, string> = {
  NOT_STARTED: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  IN_PROGRESS: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  DONE: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  CANCELLED: "bg-zinc-100 text-zinc-500 line-through dark:bg-zinc-800 dark:text-zinc-400",
};

const DAY_MS = 86_400_000;

/**
 * "Đã xong" là do NGƯỜI bấm (xưởng báo trả xong), không suy ra từ việc đủ số đặt: Q003 lô 1 đặt 400,
 * xưởng trả 240 rồi dừng — đó vẫn là một lô đã xong. Trễ hạn chỉ tính cho lô còn đang sản xuất.
 */
export function deliveryStatus(
  b: { status: string; orderedQty: number; agreedQty: number | null; dueDate: Date | null },
  deliveredQty: number,
  now: Date,
): { state: DeliveryState; delivered: number; target: number; overdueDays: number | null } {
  const target = b.agreedQty ?? b.orderedQty;
  const state: DeliveryState = b.status === "CANCELLED" ? "CANCELLED" : b.status === "DONE" ? "DONE" : deliveredQty > 0 ? "IN_PROGRESS" : "NOT_STARTED";
  const overdueDays = (state === "IN_PROGRESS" || state === "NOT_STARTED") && b.dueDate && b.dueDate.getTime() < now.getTime() ? Math.floor((now.getTime() - b.dueDate.getTime()) / DAY_MS) : null;
  return { state, delivered: deliveredQty, target, overdueDays: overdueDays && overdueDays > 0 ? overdueDays : null };
}

// ─────────────────────────── GIÁ SẢN XUẤT THỰC TẾ ───────────────────────────

export type ActualCost = {
  fabricCost: number | null;
  laborCost: number | null;
  total: number | null;
  delivered: number;
  /** (tiền vải + tiền công) / tổng số hàng xưởng thực tế trả. `null` = CHƯA TÍNH ĐƯỢC, kèm `reason`. */
  unitCost: number | null;
  /** Có vế nào đang TẠM TÍNH (SL chưa chốt, hoặc lô chưa trả xong) — số có thể còn đổi. */
  provisional: boolean;
  reason: string;
};

/**
 * Giá SX thực tế của MỘT lô = (tiền vải gán vào lô + tiền công) / tổng số hàng xưởng thực tế trả.
 *
 * `fabricOrderCount` là số đợt vải gán vào lô: shop lo vải mà 0 đợt ⇒ tiền vải CHƯA BIẾT. Lô chưa bấm
 * "xưởng đã trả xong" thì số chia còn tăng ⇒ `provisional`.
 */
export function batchActualCost(input: {
  fabricSource: string;
  fabricAmount: number;
  fabricOrderCount: number;
  labor: LaborCost;
  delivered: number;
  status: string;
}): ActualCost {
  const fabricCost = input.fabricSource === "WORKSHOP" ? input.fabricAmount : input.fabricOrderCount > 0 ? input.fabricAmount : null;
  const laborCost = input.labor.amount;
  const provisional = input.labor.basis === "DELIVERED_ESTIMATE" || input.status === "OPEN";
  const total = fabricCost != null && laborCost != null ? fabricCost + laborCost : null;
  let reason = "";
  if (input.status === "CANCELLED") reason = "Lô đã huỷ";
  else if (input.delivered <= 0) reason = "Xưởng chưa trả chiếc nào";
  else if (laborCost == null) reason = input.labor.reason;
  else if (fabricCost == null) reason = "Shop lo vải nhưng chưa gán đợt vải nào vào lô";
  const unitCost = !reason && total != null ? Math.round(total / input.delivered) : null;
  if (!reason) reason = provisional ? (input.labor.basis === "DELIVERED_ESTIMATE" ? "Tạm tính: chưa chốt SL thanh toán" : "Tạm tính: lô chưa trả xong") : "Đã chốt";
  return { fabricCost, laborCost, total, delivered: input.delivered, unitCost, provisional, reason };
}

/**
 * Giá SX thực tế cấp MÃ HÀNG = (MỌI tiền vải của mã, kể cả đợt chưa gán lô + tiền công mọi lô) /
 * tổng hàng xưởng trả của mọi lô. Trả lời "một chiếc Q002 thật sự tốn bao nhiêu" khi vải mua một lần
 * dùng cho nhiều lô. Có lô đã nhận hàng mà tiền công chưa biết ⇒ cả mã CHƯA TÍNH ĐƯỢC, vì chia tổng
 * thiếu một vế cho tổng đủ số lượng là ra một giá rẻ giả.
 */
export function productActualCost(input: {
  batches: { status: string; fabricSource: string; delivered: number; labor: LaborCost }[];
  fabricAmount: number;
  fabricOrderCount: number;
}): ActualCost {
  const live = input.batches.filter((b) => b.status !== "CANCELLED");
  const delivered = live.reduce((s, b) => s + b.delivered, 0);
  const unknownLabor = live.some((b) => b.delivered > 0 && b.labor.amount == null);
  const laborCost = unknownLabor ? null : live.reduce((s, b) => s + (b.labor.amount ?? 0), 0);
  const needsFabric = live.some((b) => b.fabricSource === "SHOP" && b.delivered > 0);
  const fabricCost = needsFabric && input.fabricOrderCount === 0 ? null : input.fabricAmount;
  const provisional = live.some((b) => b.status === "OPEN" || b.labor.basis === "DELIVERED_ESTIMATE");
  const total = fabricCost != null && laborCost != null ? fabricCost + laborCost : null;
  let reason = "";
  if (delivered <= 0) reason = "Xưởng chưa trả chiếc nào";
  else if (laborCost == null) reason = "Có lô đã nhận hàng mà chưa có tiền công";
  else if (fabricCost == null) reason = "Shop lo vải nhưng mã chưa có đợt vải nào";
  const unitCost = !reason && total != null ? Math.round(total / delivered) : null;
  if (!reason) reason = provisional ? "Tạm tính: còn lô chưa chốt" : "Đã chốt";
  return { fabricCost, laborCost, total, delivered, unitCost, provisional, reason };
}

// ─────────────────────────── HÀNG ĐÃ ĐẶT MÀ CHƯA VỀ, THEO TỪNG MẪU ───────────────────────────

/** Tổng các ô số lượng `{ [variantId]: số cái }` — ô âm / không phải số bị bỏ. */
export function cellsTotal(cells: Record<string, number> | null | undefined): number {
  return Object.values(cells ?? {}).reduce((t, n) => t + (Number.isFinite(n) ? Math.trunc(n) : 0), 0);
}

export type OpenBatchInput = {
  id: string;
  status: string;
  cells: Record<string, number>;
  orderedQty: number;
  agreedQty: number | null;
  dueDate: Date | null;
  productionOrderId: string | null;
};
export type DeliveryCellsInput = { batchId: string; quantity: number; cells: Record<string, number> };

export type OpenBatchQty = {
  /** Số cái đã đặt mà xưởng CHƯA trả, theo mẫu — chỉ lô ĐANG SẢN XUẤT có chia màu/size. */
  qtyByVariant: Map<string, number>;
  /** Hạn xưởng trả SỚM NHẤT trong các lô đang mở của mẫu. */
  earliestDueByVariant: Map<string, Date>;
  /** Bảng màu × size đã có lô nối vào — KHÔNG được đếm lần hai ở phía lệnh sản xuất. */
  linkedProductionOrderIds: Set<string>;
  /**
   * Lô đang sản xuất KHÔNG góp được vào số theo mẫu, kèm lý do: chưa chia màu/size, hoặc có đợt trả
   * hàng không chia mẫu nên không biết mẫu nào đã về. Đếm riêng, KHÔNG đoán chia hộ.
   */
  unsplit: { batchId: string; remaining: number; reason: "NO_CELLS" | "DELIVERY_NOT_SPLIT" }[];
};

/**
 * ═══ PHẦN CÒN MỞ CỦA MỘT LẦN ĐẶT = SỐ ĐẶT − SỐ ĐÃ VỀ (Company OS · QA B1) ═══
 *
 * MỘT phép trừ cho mọi nơi đọc "đang sản xuất" (lệnh SX lẫn lô xưởng). Hai chứng cứ "đã về":
 *  · đợt xưởng trả (sổ đặt xưởng) — sổ CÔNG NỢ với xưởng, nghĩa không đổi;
 *  · phiếu NHẬP HÀNG nối về lần đặt đó (`stock_receipts.production_order_id` / cột nối lô)
 *    — chứng từ TỒN KHO.
 * Hai chứng cứ có thể nói về CÙNG những món (xưởng trả rồi kho đếm nhập), nên lấy SỐ LỚN HƠN, không
 * cộng: cộng là trừ hai lần và "đang sản xuất" về 0 sớm, đúng lúc Lark phải còn nhắc. Không có phiếu
 * nối nào (toàn bộ dữ liệu hiện nay) ⇒ dùng đúng số đã trả ⇒ kết quả y như trước.
 */
export function openQtyAfterReceived(planned: number, delivered: number, receivedViaLinkedReceipts = 0): number {
  // Không phiếu nối ⇒ ĐÚNG phép tính cũ, kể cả khi số đã trả ÂM (shop trả lại xưởng hàng lỗi): kẹp
  // về 0 ở đây là đổi âm thầm số của lô đang có đợt trả âm.
  const done = receivedViaLinkedReceipts > 0 ? Math.max(delivered, receivedViaLinkedReceipts) : delivered;
  return Math.max(0, planned - done);
}

/** Số đã nhận qua phiếu NHẬP nối về từng lô: `lô → (mẫu mã → số cái)`. */
export type LinkedReceiptQty = ReadonlyMap<string, ReadonlyMap<string, number>>;

/**
 * Hàng đặt xưởng chưa về, theo mẫu. Hàm THUẦN.
 *
 * Chỉ lô `OPEN`: lô đã bấm "xưởng đã trả xong" thì phần chưa trả sẽ KHÔNG bao giờ về (Q003 lô 1 đặt
 * 400, xưởng trả 240 rồi dừng) — đếm nó là giấu đi 160 cái thiếu thật.
 *
 * Lô có đợt trả hàng không chia mẫu thì cả lô KHÔNG góp số theo mẫu: không biết 100 cái đã về là màu
 * nào thì mọi cách chia đều là đoán, và đoán sai theo hướng "đủ rồi" làm Lark im đúng lúc cần nhắc.
 * Sai theo hướng an toàn là nhắc thêm một lần.
 */
export function openBatchQtyByVariant(batches: readonly OpenBatchInput[], deliveries: readonly DeliveryCellsInput[], receivedByBatch: LinkedReceiptQty = new Map()): OpenBatchQty {
  const qtyByVariant = new Map<string, number>();
  const earliestDueByVariant = new Map<string, Date>();
  const linkedProductionOrderIds = new Set<string>();
  const unsplit: OpenBatchQty["unsplit"] = [];
  const byBatch = new Map<string, DeliveryCellsInput[]>();
  for (const d of deliveries) byBatch.set(d.batchId, [...(byBatch.get(d.batchId) ?? []), d]);

  for (const b of batches) {
    if (b.productionOrderId) linkedProductionOrderIds.add(b.productionOrderId);
    if (b.status !== "OPEN") continue;
    const ds = byBatch.get(b.id) ?? [];
    const deliveredTotal = ds.reduce((t, d) => t + d.quantity, 0);
    const rec = receivedByBatch.get(b.id);
    const receivedTotal = rec ? [...rec.values()].reduce((t, n) => t + n, 0) : 0;
    const target = cellsTotal(b.cells) || (b.agreedQty ?? b.orderedQty);
    if (!cellsTotal(b.cells)) {
      unsplit.push({ batchId: b.id, remaining: openQtyAfterReceived(target, deliveredTotal, receivedTotal), reason: "NO_CELLS" });
      continue;
    }
    if (ds.some((d) => cellsTotal(d.cells) !== d.quantity)) {
      unsplit.push({ batchId: b.id, remaining: openQtyAfterReceived(target, deliveredTotal, receivedTotal), reason: "DELIVERY_NOT_SPLIT" });
      continue;
    }
    const got = new Map<string, number>();
    for (const d of ds) for (const [v, n] of Object.entries(d.cells)) got.set(v, (got.get(v) ?? 0) + n);
    for (const [v, n] of Object.entries(b.cells)) {
      const left = openQtyAfterReceived(Math.trunc(n), got.get(v) ?? 0, rec?.get(v) ?? 0);
      if (!left) continue;
      qtyByVariant.set(v, (qtyByVariant.get(v) ?? 0) + left);
      const cur = earliestDueByVariant.get(v);
      if (b.dueDate && (!cur || b.dueDate < cur)) earliestDueByVariant.set(v, b.dueDate);
    }
  }
  return { qtyByVariant, earliestDueByVariant, linkedProductionOrderIds, unsplit };
}

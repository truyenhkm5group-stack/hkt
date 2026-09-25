import type { CaseTeam } from "@/lib/constants/action-queue";
import { suggestedNetOfOpenPo } from "@/lib/constants/inventory-decision";
import { promiseSuppressesInternalSla } from "@/lib/constants/promised-delivery";
import { formatNumber, formatVND, vnDateKey } from "@/lib/format";

/**
 * ═══════════ THIẾU HÀNG GIAO ĐƠN ĐÃ CHỐT — ĐƠN NÀO CHỜ, MẪU NÀO THIẾU, AI PHẢI LÀM GÌ ═══════════
 *
 * Chủ shop yêu cầu (24/09/2026): *"khi thiếu hàng tồn kho để giao đơn đã xác nhận, bắn cảnh báo về
 * Lark: mã nào thiếu, thiếu bao nhiêu, màu nào, size nào (lập bảng), link vào báo cáo tồn kho và đề
 * xuất đặt sản xuất — để không bị tình trạng đơn đã quá lâu mà không có hàng giao"*.
 *
 * ─── VÌ SAO PHẢI PHÂN BỔ TỪNG ĐƠN, KHÔNG CHỈ LẤY `khả dụng < 0` ───
 *
 * `computePlan` đã có `shortage = max(0, −khả dụng)` theo MẪU MÃ — trả lời được "thiếu bao nhiêu
 * cái". Nó KHÔNG trả lời được hai câu mà người vận hành cần:
 *
 *   · ĐƠN NÀO đang chờ hàng? Có 10 đơn giữ Q005 Đen/M mà kho còn 6 cái thì 6 đơn đầu đóng gói được
 *     NGAY, 4 đơn sau phải chờ. Không tách được thì hàng đợi fulfillment bảo kho "đóng gói cả 10"
 *     (đúng câu `NOT_YET_SHIPPED` đang in: *"hàng còn nguyên trong kho, chỉ thiếu thao tác"*) — và
 *     kho đi tìm 4 cái áo không tồn tại.
 *   · Đơn chờ LÂU NHẤT là bao lâu? Đó mới là con số làm mất khách, không phải số cái thiếu.
 *
 * Nên ở đây phân bổ TỒN THỰC TẾ (sổ kho: phiếu kho − đã xuất qua ĐVVC, AGENTS.md mục 3.10) cho các
 * dòng đơn ĐÃ CHỐT CÒN NẰM TRONG KHO theo thứ tự **ai lên đơn trước được hàng trước**. Đơn khách hẹn
 * giao ngày xa (`promiseSuppressesInternalSla`) xếp CUỐI: nó chưa cần hàng, không được giành hàng của
 * đơn đang phải đi.
 *
 * ─── BA RANH GIỚI ───
 *
 * 1. **Tồn CHƯA BIẾT không phải tồn 0.** Mẫu chưa có phiếu nhập (`stockKnown = false`) thì không
 *    phân bổ được; đơn giữ nó mang trạng thái `STOCK_UNKNOWN` và được ĐẾM RIÊNG — không bị tính là
 *    thiếu, cũng không được tính là đủ.
 * 2. **Tồn Pancake chỉ là GỢI Ý KIỂM ĐẾM.** ERP thấy thiếu mà Pancake báo còn đủ thì nhiều khả năng
 *    kho thiếu phiếu nhập — việc là KIỂM ĐẾM, không phải đặt sản xuất. Con số Pancake không bao giờ
 *    đi vào phép phân bổ.
 * 3. **Chỉ đề xuất.** Không tạo lệnh sản xuất, không sửa tồn, không huỷ đơn. Mỗi dòng nói AI (phòng
 *    nào) làm GÌ; người bấm.
 */

/* ═══════════════════ ĐẦU VÀO ═══════════════════ */

export type ShortageVariantInput = {
  variantId: string;
  productId: string;
  productCode: string;
  productName: string;
  color: string;
  size: string;
  sku: string;
  /** Tồn thực tế theo sổ kho = tổng phiếu kho − đã xuất qua ĐVVC. Có thể ÂM khi sổ lệch. */
  onHand: number;
  /** `false` = chưa có phiếu nhập nào ⇒ tồn CHƯA BIẾT. */
  stockKnown: boolean;
  /** Tồn Pancake — CHỈ để gợi ý kiểm đếm. `null` = không có số. */
  pancakeStock: number | null;
  /** Đề xuất đặt của Kế hoạch SX (chưa trừ hàng đã đặt xưởng). `null` = mẫu không có trong kế hoạch. */
  planSuggested: number | null;
  /** Hàng dự kiến quay lại kho (hoàn) theo Kế hoạch SX. */
  incoming: number;
  /**
   * Đã đặt xưởng mà chưa về: lệnh SX ĐÃ GỬI (bảng màu × size) + phần CHƯA TRẢ của các lô đang sản
   * xuất ở Sổ đặt xưởng có chia màu/size (`openBatchQtyByVariant`). Lô nối với một bảng màu × size
   * thì chỉ đếm lô — không đếm hai lần.
   */
  openPoQty: number;
  /** Hạn xưởng giao SỚM NHẤT trong các lệnh đang mở. `null` = lệnh không ghi hạn / không có lệnh. */
  openPoDueAt: Date | null;
  /** Mẫu khác CÙNG mã hàng, CÙNG size, đang còn khả dụng — để CSKH đề nghị khách đổi màu. */
  alternatives: { label: string; available: number }[];
};

/** Một dòng đơn đã chốt, hàng CHƯA rời kho — đúng vị ngữ `RESERVED_IN_WAREHOUSE` của sổ kho. */
export type ReservedLine = {
  orderId: string;
  systemId: number | null;
  variantId: string;
  qty: number;
  insertedAt: Date;
  promisedAt: Date | null;
  customer: string;
  value: number;
};

/* ═══════════════════ ĐẦU RA ═══════════════════ */

export type OrderStockState = "READY" | "WAITING_STOCK" | "STOCK_UNKNOWN";

export const ORDER_STOCK_STATE_LABEL: Record<OrderStockState, string> = {
  READY: "Đủ hàng · đóng gói được",
  WAITING_STOCK: "Chờ hàng · kho không đủ",
  STOCK_UNKNOWN: "Chưa biết tồn · mẫu chưa có phiếu nhập",
};

export type ShortageAction = "COUNT_STOCK" | "CHASE_FACTORY" | "ORDER_PRODUCTION";

export const SHORTAGE_ACTION_LABEL: Record<ShortageAction, string> = {
  COUNT_STOCK: "Kho kiểm đếm",
  CHASE_FACTORY: "Giục xưởng",
  ORDER_PRODUCTION: "Đặt sản xuất",
};

/** Phòng chịu trách nhiệm — dùng lại phân loại chung, không đặt tên riêng. */
export const SHORTAGE_ACTION_TEAM: Record<ShortageAction, CaseTeam> = {
  COUNT_STOCK: "WAREHOUSE",
  CHASE_FACTORY: "PRODUCTION",
  ORDER_PRODUCTION: "PRODUCTION",
};

export type OrderShortLine = { variantId: string; label: string; qty: number; short: number };

export type OrderStockVerdict = {
  orderId: string;
  systemId: number | null;
  state: OrderStockState;
  /** Dòng thiếu hàng (chỉ có khi `WAITING_STOCK`). */
  shortLines: OrderShortLine[];
  /** Dòng giữ mẫu CHƯA BIẾT tồn. */
  unknownLines: OrderShortLine[];
  insertedAt: Date;
  customer: string;
  value: number;
};

export type ShortageVariantRow = ShortageVariantInput & {
  /** Tổng số cái các đơn đã chốt đang giữ (chưa rời kho). */
  reserved: number;
  /** Số cái các đơn đang chờ mà kho KHÔNG có = max(0, giữ − max(0, tồn)). */
  shortQty: number;
  /** Số đơn có ít nhất một cái của mẫu này chưa được phân hàng. */
  waitingOrders: number;
  /** Giá trị các đơn đang chờ mẫu này — KHAI BÁO trên đơn, không phải tiền đã thu. */
  waitingValue: number;
  oldestWaitingAt: Date;
  oldestWaitHours: number;
  /** Sổ kho ÂM — phiếu kho lệch với hàng đã xuất. */
  ledgerNegative: boolean;
  /** Thiếu chưa có nguồn bù = thiếu − đã đặt xưởng − hàng hoàn sắp về. */
  uncoveredQty: number;
  /**
   * CÒN THIẾU SAU KHI ĐÃ ĐẶT = thiếu − đã đặt xưởng (chưa về). Đây là con số Lark nhắc: đặt bổ sung
   * đủ thì về 0 và thôi nhắc; đặt rồi mà vẫn thiếu thì nhắc đúng phần còn thiếu. Hàng hoàn sắp về
   * KHÔNG được trừ ở đây — hàng hoàn chưa kiểm thì chưa chắc bán lại được (AGENTS.md mục 0.4).
   */
  stillShortAfterOrder: number;
  /** Đã đặt xưởng ĐỦ số thiếu ⇒ tự thôi nhắc trên Lark (vẫn hiện trên trang, đơn vẫn ở hàng đợi CSKH). */
  coveredByOrder: boolean;
  /** Đề xuất đặt thêm (Kế hoạch SX đã trừ hàng đặt xưởng). `null` = mẫu không có trong kế hoạch. */
  proposeQty: number | null;
  action: ShortageAction;
  actionText: string;
  team: CaseTeam;
  /** Đơn chờ quá ngưỡng "để lâu" của cảnh báo (`alerts.config.pendingHours`). */
  urgent: boolean;
  /** Quyết định của người phụ trách đặt hàng cho mẫu này (`applyShortageDecisions`). `null` = chưa ai quyết. */
  decision: ShortageDecision | null;
  /** `true` = KHÔNG nhắc trên Lark nữa (đã đặt xưởng đủ số thiếu, đã xác nhận đặt đủ mức lúc bấm, hoặc đã quyết ngừng đặt). Vẫn hiện trên trang. */
  muted: boolean;
};

export type StockShortageSnapshot = {
  /** Mẫu đang thiếu hàng cho đơn đã chốt, đơn chờ lâu nhất đứng đầu. */
  variants: ShortageVariantRow[];
  /** Kết luận cho TỪNG đơn đã chốt còn trong kho. */
  orders: Map<string, OrderStockVerdict>;
  totals: {
    variants: number;
    shortUnits: number;
    waitingOrders: number;
    waitingValue: number;
    urgentOrders: number;
    readyOrders: number;
    /** Đơn giữ mẫu chưa có phiếu nhập — không biết còn hay thiếu. */
    unknownOrders: number;
    unknownVariants: number;
    /** Mẫu thiếu mà sổ kho đang ÂM — số thiếu của chúng chưa đáng tin tới khi kiểm kê. */
    ledgerNegativeVariants: number;
    /** Mẫu thiếu KHÔNG nhắc trên Lark (đã đặt xưởng đủ, đã xác nhận "đã đặt" / "không đặt nữa"). */
    mutedVariants: number;
    /** Trong số đó: mẫu đã đặt xưởng ĐỦ số thiếu (số thật ghi trong ERP, không phải lời xác nhận). */
    coveredVariants: number;
    /** Tổng số cái còn thiếu sau khi đã trừ hàng đặt xưởng chưa về. */
    stillShortUnits: number;
  };
  urgentAfterHours: number;
  measuredAt: Date;
  /**
   * Lô đang sản xuất ở Sổ đặt xưởng mà KHÔNG trừ được vào mẫu nào (chưa chia màu/size, hoặc có đợt
   * trả hàng ghi tổng). Nói ra để người đọc biết vì sao đã đặt mà Lark vẫn nhắc — không đoán chia hộ.
   */
  unsplitOrdered?: { batches: number; units: number };
};

/* ═══════════════════ PHÂN BỔ ═══════════════════ */

/**
 * Còn thiếu sau khi đã đặt xưởng. Chủ shop chốt 25/09/2026: *"không cảnh báo nữa nếu đã đặt bổ sung
 * đủ rồi, chỉ cảnh báo khi đặt bổ sung rồi mà vẫn thiếu"*. "Đã đặt" là số THẬT ghi trong ERP (lệnh
 * đã gửi / lô đang sản xuất chia màu-size), không phải một lời "đã đặt rồi" không kèm số.
 */
export function stillShortAfterOrder(shortQty: number, openPoQty: number): number {
  return Math.max(0, shortQty - Math.max(0, openPoQty));
}

export function variantLabel(v: Pick<ShortageVariantInput, "productCode" | "productName" | "color" | "size" | "sku">): string {
  const opt = [v.color, v.size].filter(Boolean).join("/") || v.sku;
  return `${v.productCode || v.productName} ${opt}`.trim();
}

function fmtDay(d: Date | null): string {
  if (!d) return "chưa ghi hạn";
  const [, m, day] = vnDateKey(d).split("-");
  return `${day}/${m}`;
}

/** "3 ngày 4 giờ" / "5 giờ" — tuổi đơn đọc được bằng mắt, không phải số thập phân. */
export function waitLabel(hours: number): string {
  const h = Math.max(0, Math.floor(hours));
  if (h < 24) return `${h} giờ`;
  const d = Math.floor(h / 24);
  const r = h % 24;
  return r ? `${d} ngày ${r} giờ` : `${d} ngày`;
}

/**
 * VIỆC CẦN LÀM cho một mẫu thiếu — xét theo thứ tự, mỗi bước chặn một kiểu sai:
 *
 *  1. Sổ kho ÂM ⇒ kho kiểm kê. Đặt sản xuất theo một con số tồn sai là đổ vốn theo lỗi ghi chép.
 *  2. Pancake báo còn ĐỦ cho mọi đơn đang giữ ⇒ kho kiểm đếm: gần như chắc chắn thiếu phiếu nhập.
 *  3. Đã đặt xưởng đủ bù phần thiếu ⇒ giục xưởng, KHÔNG đặt thêm (đặt thêm là đặt trùng).
 *  4. Còn lại ⇒ đặt sản xuất theo số đề xuất của Kế hoạch SX.
 */
export function decideShortageAction(v: Pick<ShortageVariantRow, "ledgerNegative" | "pancakeStock" | "reserved" | "openPoQty" | "openPoDueAt" | "shortQty" | "proposeQty" | "uncoveredQty" | "onHand">, now: Date): { action: ShortageAction; text: string } {
  if (v.ledgerNegative) {
    return { action: "COUNT_STOCK", text: `Sổ kho đang ÂM (${v.onHand}) — kho kiểm kê và lập phiếu điều chỉnh trước; chưa đặt SX theo con số này.` };
  }
  if (v.pancakeStock !== null && v.pancakeStock >= v.reserved && v.reserved > 0) {
    return { action: "COUNT_STOCK", text: `ERP thiếu nhưng Pancake báo còn ${v.pancakeStock} — kho đếm thực tế; có hàng thì lập phiếu nhập còn thiếu rồi đóng gói ngay.` };
  }
  if (v.openPoQty >= v.shortQty) {
    const overdue = v.openPoDueAt && v.openPoDueAt.getTime() < now.getTime();
    const due = v.openPoDueAt ? `${overdue ? "ĐÃ QUÁ hạn" : "hạn"} ${fmtDay(v.openPoDueAt)}` : "lệnh chưa ghi hạn giao";
    return { action: "CHASE_FACTORY", text: `Đã đặt xưởng ${v.openPoQty} cái (${due}) — đủ bù ${v.shortQty} cái thiếu; giục xưởng giao sớm, KHÔNG đặt thêm.` };
  }
  const qty = v.proposeQty === null ? v.uncoveredQty : v.proposeQty;
  if (v.openPoQty > 0) {
    return { action: "ORDER_PRODUCTION", text: `Đã đặt xưởng ${v.openPoQty} cái nhưng VẪN THIẾU ${stillShortAfterOrder(v.shortQty, v.openPoQty)} cái — đặt bổ sung (đề xuất ${qty} cái, đã trừ hàng đang đặt).` };
  }
  return { action: "ORDER_PRODUCTION", text: `Tạo lệnh sản xuất ${qty} cái; ${v.uncoveredQty} cái thiếu hiện chưa có nguồn bù nào.` };
}

/**
 * PHÂN BỔ TỒN THỰC TẾ CHO ĐƠN ĐÃ CHỐT. Hàm THUẦN: cùng đầu vào → cùng đầu ra, chạy hai lần ra một.
 *
 * Thứ tự ưu tiên: đơn KHÔNG có hẹn xa trước, rồi lên đơn sớm trước, rồi mã đơn (để ổn định khi hai
 * đơn cùng giây). Hàng của một mẫu đi hết cho đơn đứng trước rồi mới tới đơn sau — không chia đều,
 * không nhảy cóc để "lấp" đơn nhỏ, vì nhảy cóc là để đơn cũ nhất chờ mãi.
 *
 * Một đơn nhiều mẫu mà chỉ thiếu MỘT mẫu vẫn giữ hàng của các mẫu còn lại: kho có thể giao thiếu hay
 * chờ đủ là quyết định của người, máy không tự nhả hàng của đơn này cho đơn khác.
 */
export function allocateStock(variants: ShortageVariantInput[], lines: ReservedLine[], opts: { now: Date; urgentAfterHours: number }): StockShortageSnapshot {
  const { now, urgentAfterHours } = opts;
  const byId = new Map(variants.map((v) => [v.variantId, v]));

  // Gộp nhiều dòng cùng mẫu trong một đơn: một đơn là MỘT lượt nhận hàng.
  const merged = new Map<string, ReservedLine>();
  for (const l of lines) {
    if (!(l.qty > 0)) continue;
    const k = `${l.orderId}\u0000${l.variantId}`;
    const cur = merged.get(k);
    if (cur) cur.qty += l.qty;
    else merged.set(k, { ...l });
  }
  const queue = [...merged.values()].sort((a, b) => {
    const fa = promiseSuppressesInternalSla(a.promisedAt, now) ? 1 : 0;
    const fb = promiseSuppressesInternalSla(b.promisedAt, now) ? 1 : 0;
    return fa - fb || a.insertedAt.getTime() - b.insertedAt.getTime() || (a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0) || (a.variantId < b.variantId ? -1 : 1);
  });

  const remaining = new Map<string, number>();
  for (const v of variants) remaining.set(v.variantId, v.stockKnown ? Math.max(0, v.onHand) : 0);

  const orders = new Map<string, OrderStockVerdict>();
  type Acc = { reserved: number; short: number; orders: Set<string>; value: Map<string, number>; oldest: Date | null };
  const acc = new Map<string, Acc>();
  const unknownVariants = new Set<string>();

  for (const l of queue) {
    const v = byId.get(l.variantId);
    const verdict = orders.get(l.orderId) ?? { orderId: l.orderId, systemId: l.systemId, state: "READY" as OrderStockState, shortLines: [], unknownLines: [], insertedAt: l.insertedAt, customer: l.customer, value: l.value };
    orders.set(l.orderId, verdict);
    const label = v ? variantLabel(v) : "(mẫu không còn trong danh mục)";
    // Mẫu không có trong danh mục đang bán, hoặc chưa có phiếu nhập: tồn CHƯA BIẾT.
    if (!v || !v.stockKnown) {
      unknownVariants.add(l.variantId);
      verdict.unknownLines.push({ variantId: l.variantId, label, qty: l.qty, short: 0 });
      continue;
    }
    const left = remaining.get(l.variantId) ?? 0;
    const got = Math.min(l.qty, left);
    remaining.set(l.variantId, left - got);
    const short = l.qty - got;
    const a = acc.get(l.variantId) ?? { reserved: 0, short: 0, orders: new Set<string>(), value: new Map<string, number>(), oldest: null };
    a.reserved += l.qty;
    if (short > 0) {
      a.short += short;
      a.orders.add(l.orderId);
      a.value.set(l.orderId, l.value);
      if (!a.oldest || l.insertedAt < a.oldest) a.oldest = l.insertedAt;
      verdict.shortLines.push({ variantId: l.variantId, label, qty: l.qty, short });
    }
    acc.set(l.variantId, a);
  }

  for (const o of orders.values()) o.state = o.shortLines.length ? "WAITING_STOCK" : o.unknownLines.length ? "STOCK_UNKNOWN" : "READY";

  const rows: ShortageVariantRow[] = [];
  for (const [variantId, a] of acc) {
    if (a.short <= 0) continue;
    const v = byId.get(variantId) as ShortageVariantInput;
    const oldestWaitingAt = a.oldest as Date;
    const oldestWaitHours = Math.max(0, (now.getTime() - oldestWaitingAt.getTime()) / 3_600_000);
    const base = {
      ...v,
      reserved: a.reserved,
      shortQty: a.short,
      waitingOrders: a.orders.size,
      waitingValue: [...a.value.values()].reduce((t, x) => t + x, 0),
      oldestWaitingAt,
      oldestWaitHours,
      ledgerNegative: v.onHand < 0,
      uncoveredQty: Math.max(0, a.short - Math.max(0, v.openPoQty) - Math.max(0, v.incoming)),
      stillShortAfterOrder: stillShortAfterOrder(a.short, v.openPoQty),
      coveredByOrder: stillShortAfterOrder(a.short, v.openPoQty) === 0,
      proposeQty: v.planSuggested === null ? null : suggestedNetOfOpenPo(v.planSuggested, v.openPoQty),
      urgent: oldestWaitHours >= urgentAfterHours,
    };
    const { action, text } = decideShortageAction(base, now);
    rows.push({ ...base, action, actionText: text, team: SHORTAGE_ACTION_TEAM[action], decision: null, muted: base.coveredByOrder });
  }
  rows.sort((x, y) => y.oldestWaitHours - x.oldestWaitHours || y.shortQty - x.shortQty || (x.variantId < y.variantId ? -1 : 1));

  const all = [...orders.values()];
  const waiting = all.filter((o) => o.state === "WAITING_STOCK");
  return {
    variants: rows,
    orders,
    totals: {
      variants: rows.length,
      shortUnits: rows.reduce((t, r) => t + r.shortQty, 0),
      waitingOrders: waiting.length,
      waitingValue: waiting.reduce((t, o) => t + o.value, 0),
      urgentOrders: waiting.filter((o) => (now.getTime() - o.insertedAt.getTime()) / 3_600_000 >= urgentAfterHours).length,
      readyOrders: all.filter((o) => o.state === "READY").length,
      unknownOrders: all.filter((o) => o.state === "STOCK_UNKNOWN").length,
      unknownVariants: unknownVariants.size,
      ledgerNegativeVariants: rows.filter((r) => r.ledgerNegative).length,
      mutedVariants: rows.filter((r) => r.muted).length,
      coveredVariants: rows.filter((r) => r.coveredByOrder).length,
      stillShortUnits: rows.reduce((t, r) => t + r.stillShortAfterOrder, 0),
    },
    urgentAfterHours,
    measuredAt: now,
  };
}

/**
 * VIỆC CỦA CSKH CHO MỘT ĐƠN ĐANG CHỜ HÀNG — câu cụ thể của đơn đó, không phải câu chung của cả loại.
 * `variants` là các dòng thiếu của snapshot (để lấy lô xưởng + mẫu thay thế cùng size).
 */
export function waitingOrderDetail(order: OrderStockVerdict, variants: Map<string, ShortageVariantRow>, now: Date): string {
  const parts = order.shortLines.map((l) => {
    const v = variants.get(l.variantId);
    const po = v && v.openPoQty > 0 ? ` · xưởng đang làm ${v.openPoQty} cái (${v.openPoDueAt ? `${v.openPoDueAt.getTime() < now.getTime() ? "đã quá hạn " : "hạn "}${fmtDay(v.openPoDueAt)}` : "chưa ghi hạn"})` : " · CHƯA có lệnh sản xuất";
    const alt = v && v.alternatives.length ? ` · còn hàng cùng size: ${v.alternatives.slice(0, 3).map((a) => `${a.label} (${a.available})`).join(", ")}` : "";
    if (v?.decision?.decision === "STOP") return `Thiếu ${l.label} ×${l.short} · mẫu đã NGỪNG đặt sản xuất — đề nghị khách đổi mẫu hoặc huỷ${alt}`;
    return `Thiếu ${l.label} ×${l.short}${po}${alt}`;
  });
  return `${parts.join(". ")}.`;
}

export const WAITING_STOCK_NEXT_ACTION =
  "Báo khách thời gian chờ hàng (theo hạn lô xưởng), hoặc đề nghị đổi sang màu/size còn hàng; khách không chờ được thì huỷ đơn. KHÔNG đóng gói/tạo vận đơn khi kho chưa có hàng — phòng Sản xuất đã nhận việc theo mẫu mã.";

/* ═══════════════════ QUYẾT ĐỊNH CỦA NGƯỜI ĐẶT HÀNG ═══════════════════ */

/**
 * BA NÚT TRÊN TIN LARK (chủ shop yêu cầu 24/09/2026):
 *
 *   ORDERED    — "Đã đặt rồi": thôi nhắc mẫu này. Nhưng CHỈ cho mức thiếu lúc bấm: có thêm đơn chờ
 *                làm thiếu VƯỢT con số đó thì nhắc lại — lượt đặt ấy không tính tới những đơn này.
 *   WILL_ORDER — "Sẽ đặt thêm": ghi nhận người nhận việc, VẪN nhắc tiếp cho tới khi hết thiếu.
 *   STOP       — "Không đặt nữa": thôi nhắc hẳn (tới khi người bỏ quyết định trên trang).
 *
 * TẮT NHẮC KHÔNG PHẢI GIẤU VIỆC. Mẫu đã tắt nhắc VẪN nằm trên trang `/inventory/shortage`, và đơn
 * chờ của nó VẪN ở hàng đợi fulfillment cho CSKH — mẫu ngừng đặt còn gấp hơn, vì khách đang chờ một
 * món sẽ không bao giờ về. Nút chỉ quyết định Lark có nhắc phòng Sản xuất nữa hay không.
 *
 * "Đã đặt" / "Sẽ đặt" gắn với MỘT ĐỢT THIẾU: mẫu hết thiếu thì quyết định tự rơi
 * (`pruneShortageDecisions`), lần thiếu sau là chuyện mới. "Không đặt nữa" thì giữ.
 *
 * Custom Bot của Lark KHÔNG nhận được lượt bấm nút trong khung chat (cần một Lark App có địa chỉ
 * callback). Nên "nút" trên tin là LINK mở ERP đúng dòng, người bấm xác nhận một lần ở đó — và vì
 * thế quyết định luôn mang khoá tài khoản của người bấm.
 */
export const SHORTAGE_DECISIONS = ["ORDERED", "WILL_ORDER", "STOP"] as const;
export type ShortageDecisionKind = (typeof SHORTAGE_DECISIONS)[number];

export const SHORTAGE_DECISION_LABEL: Record<ShortageDecisionKind, string> = {
  ORDERED: "Đã đặt rồi",
  WILL_ORDER: "Sẽ đặt thêm",
  STOP: "Không đặt nữa",
};

export const SHORTAGE_DECISION_HINT: Record<ShortageDecisionKind, string> = {
  ORDERED: "Thôi nhắc mẫu này trên Lark. Nhắc lại nếu có thêm đơn làm thiếu vượt mức lúc bấm.",
  WILL_ORDER: "Ghi nhận sẽ đặt. Lark vẫn nhắc tiếp cho tới khi hết thiếu.",
  STOP: "Ngừng đặt mẫu này, thôi nhắc hẳn. Đơn đang chờ vẫn ở hàng đợi CSKH để đề nghị khách đổi hoặc huỷ.",
};

export const SHORTAGE_DECISIONS_KEY = "inventory.shortage.decisions";

export type ShortageDecision = {
  decision: ShortageDecisionKind;
  at: string;
  /** `users.id` do máy chủ đọc từ phiên đăng nhập — không nhận từ client (AGENTS.md mục 34). */
  byUserId: string;
  /** Ảnh chụp tên để người đọc, không phải khoá. */
  byName: string;
  /** Mức thiếu lúc bấm — "đã đặt" chỉ tắt nhắc tới mức này. */
  shortQtyAtDecision: number;
  note: string;
};

export type ShortageDecisionBook = Record<string, ShortageDecision>;

/** Lark có còn nhắc mẫu này không, với mức thiếu hiện tại. */
export function isShortageMuted(d: ShortageDecision | null | undefined, shortQty: number): boolean {
  if (!d) return false;
  if (d.decision === "STOP") return true;
  if (d.decision === "ORDERED") return shortQty <= d.shortQtyAtDecision;
  return false;
}

function fmtDecisionAt(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? fmtDay(d) : "?";
}

/** Gắn quyết định vào từng dòng thiếu. Hàm THUẦN — không đọc/ghi sổ. */
export function applyShortageDecisions(s: StockShortageSnapshot, book: ShortageDecisionBook): StockShortageSnapshot {
  const variants = s.variants.map((r): ShortageVariantRow => {
    const d = book[r.variantId] ?? null;
    if (!d) return r;
    const muted = r.coveredByOrder || isShortageMuted(d, r.shortQty);
    const who = `${d.byName || "?"} ${fmtDecisionAt(d.at)}`;
    if (d.decision === "STOP") {
      return { ...r, decision: d, muted, proposeQty: 0, actionText: `Đã quyết KHÔNG ĐẶT NỮA (${who}) — không đề xuất sản xuất; ${r.waitingOrders} đơn đang chờ: CSKH đề nghị khách đổi mẫu hoặc huỷ.` };
    }
    if (d.decision === "ORDERED") {
      const po = r.openPoQty > 0 ? "" : " ERP chưa ghi số đã đặt cho mẫu này — ghi lô đặt xưởng có chia màu/size để ERP tự trừ vào số thiếu và theo dõi hạn giao.";
      const text = muted
        ? `Đã xác nhận đặt (${who}) khi thiếu ${d.shortQtyAtDecision} — chỉ nhắc lại nếu thiếu vượt mức đó.${po}`
        : `Đã xác nhận đặt (${who}) khi thiếu ${d.shortQtyAtDecision}, nay thiếu ${r.shortQty} — phần tăng thêm CHƯA ai đặt. ${r.actionText}`;
      return { ...r, decision: d, muted, actionText: text };
    }
    return { ...r, decision: d, muted, actionText: `${SHORTAGE_DECISION_LABEL.WILL_ORDER} (${who}). ${r.actionText}` };
  });
  return { ...s, variants, totals: { ...s.totals, mutedVariants: variants.filter((r) => r.muted).length } };
}

/**
 * Dọn sổ: "đã đặt" / "sẽ đặt" của mẫu KHÔNG còn thiếu thì bỏ — đợt thiếu đã hết. "Không đặt nữa" giữ.
 * Trả `null` khi không có gì đổi (để khỏi ghi sổ vô ích).
 */
export function pruneShortageDecisions(book: ShortageDecisionBook, shortNow: Record<string, number>): ShortageDecisionBook | null {
  const next: ShortageDecisionBook = {};
  let changed = false;
  for (const [k, d] of Object.entries(book)) {
    if (d.decision !== "STOP" && !((shortNow[k] ?? 0) > 0)) {
      changed = true;
      continue;
    }
    next[k] = d;
  }
  return changed ? next : null;
}

/** Link mở ERP đúng dòng và đúng nút. */
export function decisionLink(variantId: string, decision: ShortageDecisionKind): string {
  return `/inventory/shortage?variant=${encodeURIComponent(variantId)}&decide=${decision}#v-${encodeURIComponent(variantId)}`;
}

/* ═══════════════════ GỬI LARK: KHI NÀO ═══════════════════ */

/**
 * CHỐNG ĐỔ TIN. Job cảnh báo chạy 10 phút/lần; gửi lại cả bảng mỗi lượt thì sau một buổi sáng không
 * ai đọc nữa, và lần thật sự cần báo cũng trôi. Ba lý do được gửi, ngoài ra im lặng:
 *
 *   MORNING — bảng tổng hợp đầu ngày làm việc (lượt đầu tiên từ `morningHourVN` giờ VN), nếu còn thiếu.
 *   WORSE   — xuất hiện mẫu thiếu MỚI, hoặc một mẫu thiếu NHIỀU HƠN lần báo trước; cách lần gửi trước
 *             ít nhất `minGapMinutes`; chỉ trong giờ làm việc.
 *   CLEARED — lần trước còn thiếu, giờ hết: một tin "đã đủ hàng" để người đọc không phải đoán.
 *
 * Thiếu GIẢM thì không gửi, nhưng sổ ghi mức thấp hơn — để nếu nó tăng lại thì vẫn báo.
 */
export const SHORTAGE_DIGEST_RULE = {
  morningHourVN: 8,
  /** Giờ làm việc (VN): ngoài khung này chỉ ghi sổ, không nhắn — sáng hôm sau bảng tổng hợp gom lại. */
  workStartVN: 7,
  workEndVN: 22,
  minGapMinutes: 60,
  /** Số dòng tối đa trên thẻ Lark; phần còn lại mở trang. */
  maxRows: 30,
} as const;

export const SHORTAGE_DIGEST_KEY = "inventory.shortage.lark";

export type ShortageDigestLedger = {
  /** Ngày VN đã gửi bảng tổng hợp buổi sáng. */
  morningDay: string | null;
  lastSentAt: string | null;
  /** Mức thiếu theo mẫu đã BÁO (hoặc thấp hơn nếu đã giảm). */
  lastShort: Record<string, number>;
};

export const EMPTY_DIGEST_LEDGER: ShortageDigestLedger = { morningDay: null, lastSentAt: null, lastShort: {} };

export type DigestReason = "MORNING" | "WORSE" | "CLEARED";

export type DigestDecision = {
  send: DigestReason | null;
  /** Mẫu mới / nặng thêm so với lần báo trước — in đậm trên thẻ. */
  changed: string[];
  /** Sổ sau lượt này NẾU gửi thành công. */
  ledgerIfSent: ShortageDigestLedger;
  /** Sổ sau lượt này nếu KHÔNG gửi (hoặc gửi hỏng) — chỉ hạ mức, không bao giờ nâng. */
  ledgerIfSkipped: ShortageDigestLedger;
};

function vnHour(at: Date): number {
  return (at.getUTCHours() + 7) % 24;
}

export function decideShortageDigest(prev: ShortageDigestLedger | null, current: Record<string, number>, now: Date): DigestDecision {
  const p = prev ?? EMPTY_DIGEST_LEDGER;
  const today = vnDateKey(now);
  const hour = vnHour(now);
  const inWork = hour >= SHORTAGE_DIGEST_RULE.workStartVN && hour < SHORTAGE_DIGEST_RULE.workEndVN;
  const cur = Object.fromEntries(Object.entries(current).filter(([, q]) => q > 0));
  const changed = Object.keys(cur).filter((k) => !(k in p.lastShort) || cur[k] > p.lastShort[k]).sort();

  const lowered: Record<string, number> = {};
  for (const [k, q] of Object.entries(p.lastShort)) if (k in cur) lowered[k] = Math.min(q, cur[k]);
  const ledgerIfSkipped: ShortageDigestLedger = { ...p, lastShort: lowered };

  const sentAt = now.toISOString();
  const nothingNow = Object.keys(cur).length === 0;
  if (nothingNow) {
    const hadBefore = Object.keys(p.lastShort).length > 0;
    return { send: hadBefore && inWork ? "CLEARED" : null, changed: [], ledgerIfSent: { ...p, lastSentAt: sentAt, lastShort: {} }, ledgerIfSkipped };
  }
  if (p.morningDay !== today && hour >= SHORTAGE_DIGEST_RULE.morningHourVN && inWork) {
    return { send: "MORNING", changed, ledgerIfSent: { morningDay: today, lastSentAt: sentAt, lastShort: cur }, ledgerIfSkipped };
  }
  const gapOk = !p.lastSentAt || now.getTime() - new Date(p.lastSentAt).getTime() >= SHORTAGE_DIGEST_RULE.minGapMinutes * 60_000;
  if (changed.length && gapOk && inWork) {
    return { send: "WORSE", changed, ledgerIfSent: { ...p, lastSentAt: sentAt, lastShort: cur }, ledgerIfSkipped };
  }
  return { send: null, changed, ledgerIfSent: ledgerIfSkipped, ledgerIfSkipped };
}

/* ═══════════════════ GỬI LARK: NỘI DUNG ═══════════════════ */

export const SHORTAGE_LINKS = {
  shortage: "/inventory/shortage",
  stock: "/inventory",
  planning: "/inventory/planning",
  newProductionOrder: (productId: string) => `/inventory/planning/orders/new?product=${encodeURIComponent(productId)}`,
} as const;

export type LarkCard = Record<string, unknown>;

function title(s: StockShortageSnapshot, reason: DigestReason): string {
  if (reason === "CLEARED") return "✅ Đã đủ hàng cho mọi đơn đã chốt";
  const head = reason === "MORNING" ? `📦 Thiếu hàng giao đơn · ${fmtDay(s.measuredAt)}` : "🚨 Phát sinh thiếu hàng giao đơn";
  return `${head} · ${s.totals.variants} mẫu · ${s.totals.waitingOrders} đơn chờ`;
}

function summaryMd(s: StockShortageSnapshot): string {
  const oldest = s.variants.reduce((m, r) => Math.max(m, r.oldestWaitHours), 0);
  const lines = [
    `**${formatNumber(s.totals.waitingOrders)} đơn** đã chốt đang chờ hàng · thiếu **${formatNumber(s.totals.shortUnits)} cái** trên **${formatNumber(s.totals.variants)} mẫu mã** · đơn chờ lâu nhất **${waitLabel(oldest)}**`,
    `Đã trừ hàng đặt xưởng chưa về: **còn thiếu ${formatNumber(s.totals.stillShortUnits)} cái** chưa có ai đặt`,
    `Giá trị đơn đang treo (khai báo trên đơn): ${formatVND(s.totals.waitingValue)}${s.totals.urgentOrders ? ` · <font color='red'>${formatNumber(s.totals.urgentOrders)} đơn đã chờ quá ${s.urgentAfterHours} giờ</font>` : ""}`,
  ];
  return lines.join("\n");
}

function footerNotes(s: StockShortageSnapshot): string[] {
  const notes = ["Số liệu: sổ kho ERP (phiếu kho − đã xuất qua ĐVVC), phân bổ cho đơn lên trước. Tồn Pancake chỉ dùng để gợi ý kiểm đếm."];
  if (s.totals.unknownOrders) notes.push(`⚠️ ${formatNumber(s.totals.unknownOrders)} đơn giữ ${formatNumber(s.totals.unknownVariants)} mẫu CHƯA CÓ PHIẾU NHẬP — không biết còn hay thiếu; kho lập phiếu nhập để ERP tính được.`);
  if (s.totals.coveredVariants) notes.push(`🔕 ${formatNumber(s.totals.coveredVariants)} mẫu thiếu đã ĐẶT XƯỞNG ĐỦ số thiếu nên không nhắc ở đây — vẫn xem được trên trang, đơn chờ vẫn ở hàng đợi CSKH.`);
  const byDecision = s.variants.filter((r) => r.muted && !r.coveredByOrder).length;
  if (byDecision) notes.push(`🔕 ${formatNumber(byDecision)} mẫu thiếu đã được xác nhận "đã đặt" / "không đặt nữa" nên không nhắc ở đây — vẫn xem được trên trang, đơn chờ vẫn ở hàng đợi CSKH.`);
  notes.push("Cột Xác nhận mở ERP để bấm (cần đăng nhập, quyền lập bảng đặt hàng).");
  if (s.totals.ledgerNegativeVariants) notes.push(`⚠️ ${formatNumber(s.totals.ledgerNegativeVariants)} mẫu có sổ kho ÂM — số thiếu của chúng chưa đáng tin tới khi kho kiểm kê.`);
  return notes;
}

/**
 * THẺ LARK CÓ BẢNG. Custom Bot của Lark nhận `msg_type: "interactive"`; thành phần `table` cho bảng
 * có tiêu đề cột và phân trang ngay trong khung chat. Hàm THUẦN — kiểm được mà không cần gọi Lark.
 */
export function buildShortageLarkCard(s: StockShortageSnapshot, opts: { appUrl: string; reason: DigestReason; changed?: string[] }): LarkCard {
  const url = (path: string) => `${opts.appUrl}${path}`;
  const changed = new Set(opts.changed ?? []);
  const buttons = {
    tag: "action",
    actions: [
      { tag: "button", text: { tag: "plain_text", content: "Bảng thiếu hàng & đơn chờ" }, type: "primary", url: url(SHORTAGE_LINKS.shortage) },
      { tag: "button", text: { tag: "plain_text", content: "Báo cáo tồn kho" }, type: "default", url: url(SHORTAGE_LINKS.stock) },
      { tag: "button", text: { tag: "plain_text", content: "Đề xuất đặt sản xuất" }, type: "default", url: url(SHORTAGE_LINKS.planning) },
    ],
  };
  if (opts.reason === "CLEARED") {
    return {
      config: { wide_screen_mode: true },
      header: { template: "green", title: { tag: "plain_text", content: title(s, "CLEARED") } },
      elements: [
        { tag: "markdown", content: `Mọi đơn đã chốt còn trong kho đều đã có hàng phân bổ${s.totals.unknownOrders ? ` (trừ ${formatNumber(s.totals.unknownOrders)} đơn giữ mẫu chưa có phiếu nhập — không biết tồn)` : ""}. Kho đóng gói theo hàng đợi Fulfillment.` },
        buttons,
      ],
    };
  }
  const active = s.variants.filter((r) => !r.muted);
  const shown = active.slice(0, SHORTAGE_DIGEST_RULE.maxRows);
  const rows = shown.map((r) => ({
    code: `[${r.productCode || r.productName}](${url(SHORTAGE_LINKS.newProductionOrder(r.productId))})${changed.has(r.variantId) ? " 🆕" : ""}`,
    product: r.productName,
    color: r.color || "—",
    size: r.size || "—",
    short: r.shortQty,
    still: r.stillShortAfterOrder,
    orders: r.waitingOrders,
    wait: r.urgent ? `⏰ ${waitLabel(r.oldestWaitHours)}` : waitLabel(r.oldestWaitHours),
    stock: r.ledgerNegative ? `${r.onHand} (âm)` : String(r.onHand),
    po: r.openPoQty ? `${r.openPoQty} · ${fmtDay(r.openPoDueAt)}` : "—",
    propose: r.proposeQty === null ? "—" : String(r.proposeQty),
    action: r.decision?.decision === "WILL_ORDER" ? `${SHORTAGE_DECISION_LABEL.WILL_ORDER} · ${r.decision.byName}` : SHORTAGE_ACTION_LABEL[r.action],
    decide: SHORTAGE_DECISIONS.map((d) => `[${SHORTAGE_DECISION_LABEL[d]}](${url(decisionLink(r.variantId, d))})`).join(" · "),
  }));
  const col = (name: string, display: string, type: "text" | "lark_md" | "number", width = "auto") => ({ name, display_name: display, data_type: type, width, ...(type === "number" ? { format: { precision: 0 } } : {}) });
  const elements: unknown[] = [
    { tag: "markdown", content: summaryMd(s) },
    ...(opts.reason === "WORSE" && changed.size ? [{ tag: "markdown", content: `🆕 Mới / nặng thêm: ${shown.filter((r) => changed.has(r.variantId)).map((r) => `**${variantLabel(r)}** (thiếu ${r.shortQty})`).join(" · ") || `${changed.size} mẫu`}` }] : []),
    {
      tag: "table",
      page_size: 10,
      row_height: "low",
      header_style: { text_align: "left", text_size: "normal", background_style: "grey", bold: true, lines: 1 },
      columns: [
        col("code", "Mã", "lark_md"),
        col("product", "Sản phẩm", "text"),
        col("color", "Màu", "text"),
        col("size", "Size", "text"),
        col("short", "Thiếu", "number"),
        col("still", "Còn thiếu sau đặt", "number"),
        col("orders", "Đơn chờ", "number"),
        col("wait", "Chờ lâu nhất", "text"),
        col("stock", "Tồn ERP", "text"),
        col("po", "Đã đặt xưởng", "text"),
        col("propose", "Đề xuất đặt", "text"),
        col("action", "Việc cần làm", "text"),
        col("decide", "Xác nhận", "lark_md"),
      ],
      rows,
    },
    ...(active.length > shown.length ? [{ tag: "markdown", content: `… và ${active.length - shown.length} mẫu nữa — mở bảng đầy đủ.` }] : []),
    buttons,
    { tag: "note", elements: footerNotes(s).map((t) => ({ tag: "plain_text", content: t })) },
  ];
  return {
    config: { wide_screen_mode: true },
    header: { template: s.totals.urgentOrders ? "red" : "orange", title: { tag: "plain_text", content: title(s, opts.reason) } },
    elements,
  };
}

/**
 * BẢN DỰ PHÒNG DẠNG VĂN BẢN (`msg_type: "post"`) — dùng khi Lark từ chối thẻ (bản Lark cũ không có
 * thành phần bảng). Cùng dữ liệu, cùng thứ tự; chỉ khác cách trình bày.
 */
export function shortageAsPostLines(s: StockShortageSnapshot, opts: { appUrl: string; reason: DigestReason; changed?: string[] }): { title: string; lines: { text: string; href?: string }[][] } {
  const url = (path: string) => `${opts.appUrl}${path}`;
  const changed = new Set(opts.changed ?? []);
  const links = [
    [{ text: "→ Bảng thiếu hàng & đơn chờ", href: url(SHORTAGE_LINKS.shortage) }],
    [{ text: "→ Báo cáo tồn kho", href: url(SHORTAGE_LINKS.stock) }, { text: " · " }, { text: "Đề xuất đặt sản xuất", href: url(SHORTAGE_LINKS.planning) }],
  ];
  if (opts.reason === "CLEARED") return { title: title(s, "CLEARED"), lines: [[{ text: "Mọi đơn đã chốt còn trong kho đều đã có hàng phân bổ." }], ...links] };
  const active = s.variants.filter((r) => !r.muted);
  const shown = active.slice(0, SHORTAGE_DIGEST_RULE.maxRows);
  const lines: { text: string; href?: string }[][] = [
    [{ text: summaryMd(s).replace(/\*\*/g, "").replace(/<[^>]+>/g, "") }],
    [{ text: "Mã · Màu/Size · Thiếu · Còn thiếu sau đặt · Đơn chờ · Chờ lâu nhất · Đã đặt xưởng · Đề xuất đặt · Việc" }],
    ...shown.map((r) => [
      { text: `${changed.has(r.variantId) ? "🆕 " : "• "}${r.productCode || r.productName}`, href: url(SHORTAGE_LINKS.newProductionOrder(r.productId)) },
      { text: ` · ${[r.color, r.size].filter(Boolean).join("/") || r.sku} · thiếu ${r.shortQty} · còn thiếu sau đặt ${r.stillShortAfterOrder} · ${r.waitingOrders} đơn · ${waitLabel(r.oldestWaitHours)} · xưởng ${r.openPoQty || 0} · đặt ${r.proposeQty ?? "—"} · ${SHORTAGE_ACTION_LABEL[r.action]} · ` },
      ...SHORTAGE_DECISIONS.flatMap((d, i) => [...(i ? [{ text: " · " }] : []), { text: SHORTAGE_DECISION_LABEL[d], href: url(decisionLink(r.variantId, d)) }]),
    ]),
  ];
  if (active.length > shown.length) lines.push([{ text: `… và ${active.length - shown.length} mẫu nữa` }]);
  for (const n of footerNotes(s)) lines.push([{ text: n }]);
  return { title: title(s, opts.reason), lines: [...lines, ...links] };
}

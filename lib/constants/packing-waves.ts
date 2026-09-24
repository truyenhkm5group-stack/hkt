/**
 * ═══════════ ĐÓNG GÓI THEO LƯỢT — GOM ĐƠN THEO MẪU MÃ ═══════════
 *
 * Bản đồ phòng ban (Kho · Đề nghị) khai từ 23/09/2026: *"chưa có đề nghị cho việc tốn người nhất
 * của kho: gom đơn theo mẫu mã để đóng gói một lượt"*. Kho có MỘT người (đo production 24/09/2026)
 * và hàng đợi fulfillment in từng đơn một theo thứ tự tắc — đúng cho câu "đơn nào đang trễ", sai cho
 * câu "đi lấy hàng thế nào cho ít vòng nhất".
 *
 * Hàm THUẦN: nhận các đơn ĐỦ HÀNG cần đóng, trả ba thứ:
 *
 *  1. **Phiếu lấy hàng tổng** — mỗi mẫu cần bao nhiêu cái, cho bao nhiêu đơn. Một vòng đi kho thay
 *     vì một vòng cho mỗi đơn.
 *  2. **Lượt giống hệt nhau** — nhóm đơn có ĐÚNG cùng danh sách hàng (cùng mẫu, cùng số lượng). 12
 *     đơn "1× Đầm Q005 Đen/M" đóng liền tay như một dây chuyền, dán nhãn theo lô.
 *  3. **Đơn lẻ** — phần còn lại, vẫn theo thứ tự ai lên trước.
 *
 * ─── HAI RANH GIỚI ───
 *
 *  · **Chỉ đơn ĐỦ HÀNG.** Kết luận đủ/thiếu là của `allocateStock` (`lib/constants/stock-shortage.ts`)
 *    — cùng phép phân bổ "ai lên trước được hàng trước". Đơn chờ hàng hoặc tồn chưa biết KHÔNG vào
 *    lượt nào: gom chúng là bảo kho đi tìm cái áo không tồn tại. Chúng được ĐẾM RIÊNG, không biến mất.
 *  · **Chỉ đề nghị.** Không đổi trạng thái đơn, không tạo vận đơn, không in nhãn. Thứ tự đóng vẫn do
 *    người quyết; trang chỉ bày sẵn cách đi ít vòng nhất.
 */

export type PackLine = { variantId: string; label: string; qty: number };

export type PackOrder = {
  orderId: string;
  systemId: number | null;
  customer: string;
  insertedAt: Date;
  lines: PackLine[];
};

export type PickListRow = { variantId: string; label: string; qty: number; orders: number };

export type PackBatch = {
  /** Khoá danh sách hàng — `variantId×qty` đã sắp. Hai đơn cùng khoá là hai gói giống hệt nhau. */
  key: string;
  lines: PackLine[];
  /** Đơn trong lượt, ai lên trước đứng trước. */
  orders: PackOrder[];
};

export type PackingPlan = {
  pickList: PickListRow[];
  /** Nhóm từ `PACK_BATCH_MIN` đơn giống hệt nhau trở lên — nhóm to nhất trước. */
  batches: PackBatch[];
  /** Đơn không trùng danh sách hàng với đơn nào khác — ai lên trước đứng trước. */
  singles: PackOrder[];
  totals: { orders: number; units: number; variants: number; ordersInBatches: number };
};

/** Từ ngần này đơn giống hệt nhau trở lên mới gọi là một lượt — hai đơn giống nhau đã đủ để đóng liền tay. */
export const PACK_BATCH_MIN = 2;

/** Gộp dòng trùng mẫu trong CÙNG một đơn (Pancake có thể ghi một mẫu thành hai dòng) và bỏ dòng số lượng ≤ 0. */
export function normalizeLines(lines: PackLine[]): PackLine[] {
  const m = new Map<string, PackLine>();
  for (const l of lines) {
    if (!(l.qty > 0)) continue;
    const cur = m.get(l.variantId);
    if (cur) cur.qty += l.qty;
    else m.set(l.variantId, { ...l });
  }
  return [...m.values()].sort((a, b) => (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0));
}

export function lineKey(lines: PackLine[]): string {
  return normalizeLines(lines)
    .map((l) => `${l.variantId}×${l.qty}`)
    .join("|");
}

const truocSau = (a: PackOrder, b: PackOrder) => a.insertedAt.getTime() - b.insertedAt.getTime() || (a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0);

export function planPackingWaves(orders: PackOrder[]): PackingPlan {
  const sach = orders.map((o) => ({ ...o, lines: normalizeLines(o.lines) })).filter((o) => o.lines.length > 0);

  const pick = new Map<string, PickListRow>();
  for (const o of sach) {
    for (const l of o.lines) {
      const cur = pick.get(l.variantId) ?? { variantId: l.variantId, label: l.label, qty: 0, orders: 0 };
      cur.qty += l.qty;
      cur.orders += 1;
      pick.set(l.variantId, cur);
    }
  }
  const pickList = [...pick.values()].sort((a, b) => b.qty - a.qty || b.orders - a.orders || a.label.localeCompare(b.label, "vi"));

  const theoKhoa = new Map<string, PackOrder[]>();
  for (const o of sach) {
    const k = lineKey(o.lines);
    theoKhoa.set(k, [...(theoKhoa.get(k) ?? []), o]);
  }
  const batches: PackBatch[] = [];
  const singles: PackOrder[] = [];
  for (const [key, list] of theoKhoa) {
    const sorted = [...list].sort(truocSau);
    if (sorted.length >= PACK_BATCH_MIN) batches.push({ key, lines: sorted[0].lines, orders: sorted });
    else singles.push(...sorted);
  }
  // Lượt to nhất trước (tiết kiệm nhiều thao tác nhất); bằng nhau thì lượt có đơn chờ lâu nhất trước.
  batches.sort((a, b) => b.orders.length - a.orders.length || truocSau(a.orders[0], b.orders[0]) || (a.key < b.key ? -1 : 1));
  singles.sort(truocSau);

  return {
    pickList,
    batches,
    singles,
    totals: {
      orders: sach.length,
      units: pickList.reduce((s, r) => s + r.qty, 0),
      variants: pickList.length,
      ordersInBatches: batches.reduce((s, b) => s + b.orders.length, 0),
    },
  };
}

import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { legBaseCode } from "@/lib/integrations/viettelpost/statement";

/**
 * ═══════════ KIỆN HOÀN NÀY LÀ HÀNG GÌ? ═══════════
 *
 * Kho cầm một kiện trên tay và chỉ đọc được mã vận đơn. Câu hỏi duy nhất của họ là "trong này lẽ
 * ra có món gì" — nhưng trả lời sai còn tệ hơn không trả lời: đếm nhầm hàng vào tồn thì kế hoạch
 * sản xuất lệch đúng bằng phần nhầm đó, và không ai tìm ra cho tới kỳ kiểm kê.
 *
 * ───────── BẬC THANG CĂN CỨ (chỉ đi theo ĐỊNH DANH, không bao giờ theo người) ─────────
 *
 *  1. DIRECT      — `shipments.order_id` có sẵn. Vận đơn tự nó mang khoá đơn, do khâu đồng bộ gắn
 *                   theo mã vận đơn. Đây là căn cứ chắc nhất.
 *  2. RETURN_LEG  — vận đơn chiều về (mã gốc + `1P1`) có `order_id` NULL theo đúng quy ước của kho
 *                   mã. Lần ngược MÃ GỐC (`order_reference`, hoặc bóc từ chính mã vận đơn) về vận
 *                   đơn chiều đi, rồi lấy đơn của vận đơn đó. Vẫn là định danh: mã → mã → đơn.
 *  3. AMBIGUOUS   — mã gốc lần ra NHIỀU đơn khác nhau. Không chọn bừa cái nào.
 *  4. UNRESOLVED  — không có căn cứ nào.
 *
 * TUYỆT ĐỐI KHÔNG dò theo số điện thoại hay tên khách. Một khách mua mười lần thì mười đơn cùng
 * SĐT; ghép theo người là ghép bừa, và cái sai đó trông y như thật.
 *
 * ───────── BIẾT ĐƠN KHÁC VỚI BIẾT MÓN NÀO QUAY VỀ ─────────
 *
 * Biết kiện thuộc đơn nào KHÔNG có nghĩa là biết món nào thực sự nằm trong kiện: khách trả một
 * phần là chuyện thường. Nên phần món hàng có bậc căn cứ riêng:
 *
 *  · ITEM_EVIDENCE — đơn có dòng `order_items.return_quantity > 0`: đây là phiếu trả ghi rõ món và
 *                    số lượng. Hiện ĐÚNG những dòng đó với đúng số đó.
 *  · ORDER_ONLY    — chỉ biết đơn. Hiện "đơn gốc gồm…" nhưng phải gắn nhãn CHƯA XÁC NHẬN mặt hàng
 *                    hoàn, để kho đối chiếu bằng mắt chứ không tin sẵn.
 *
 * ───────── KHÔNG CỘNG TỒN ─────────
 *
 * Mọi con số ở đây là HÀNG KỲ VỌNG, không phải hàng đã có. Tồn chỉ đổi khi kho đếm thật và lập
 * phiếu tái nhập — xem `lib/returns/inspection.ts`. Module này chỉ đọc.
 */

const s = schema.shipments;
const o = schema.orders;
const oi = schema.orderItems;
const pv = schema.productVariants;

/** Vì sao ERP dám (hoặc không dám) nói kiện này thuộc đơn nào. */
export type OrderLinkBasis = "DIRECT" | "RETURN_LEG" | "AMBIGUOUS" | "UNRESOLVED";

/** Vì sao ERP dám (hoặc không dám) nói món nào nằm trong kiện. */
export type ItemsBasis = "ITEM_EVIDENCE" | "ORDER_ONLY" | "NONE";

export type ReturnItem = {
  /** Nối dòng hàng với sổ kho. Thiếu nó thì món đếm được không biết cộng vào mẫu mã nào. */
  variantId: string | null;
  sku: string;
  name: string;
  color: string;
  size: string;
  /** Số món KỲ VỌNG quay về — chưa ai đếm. */
  quantity: number;
  isBonus: boolean;
};

export type ReturnProductContext = {
  shipmentId: string;
  orderId: string | null;
  /** Mã đơn hiển thị cho người (custom_id, không có thì system_id). */
  orderCode: string | null;
  orderedAt: Date | null;
  /** COD khai báo trên đơn gốc — chỉ để kho nhận ra kiện, KHÔNG phải tiền đã thu. */
  orderCod: number | null;
  basis: OrderLinkBasis;
  itemsBasis: ItemsBasis;
  items: ReturnItem[];
  /** Tổng số món kỳ vọng. `null` khi chưa đủ căn cứ — CHƯA BIẾT, không phải 0. */
  expectedQty: number | null;
  /** Mã vận đơn gốc đã lần ra (chỉ có ở bậc RETURN_LEG) — để nói được vì sao ghép như vậy. */
  viaBaseCode: string | null;
  /** Khi AMBIGUOUS: những đơn cùng lần ra, để người xử lý tự quyết chứ ERP không chọn hộ. */
  candidateOrderIds: string[];
};

export const EMPTY_CONTEXT = (shipmentId: string): ReturnProductContext => ({
  shipmentId,
  orderId: null,
  orderCode: null,
  orderedAt: null,
  orderCod: null,
  basis: "UNRESOLVED",
  itemsBasis: "NONE",
  items: [],
  expectedQty: null,
  viaBaseCode: null,
  candidateOrderIds: [],
});

const up = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();

/**
 * Ghép sản phẩm cho MỘT LOẠT vận đơn bằng ĐÚNG BỐN truy vấn, bất kể danh sách dài bao nhiêu.
 *
 * Trước đây mỗi dòng tự đi hỏi đơn của mình bằng truy vấn con trong `select` — với 530 kiện là 530
 * lần quét `order_items`. Ở đây: lấy vận đơn → lần mã gốc một lượt → lấy đơn một lượt → lấy dòng
 * hàng một lượt. Không có truy vấn nào nằm trong vòng lặp.
 */
export async function returnProductContext(shipmentIds: string[]): Promise<Map<string, ReturnProductContext>> {
  const ids = [...new Set(shipmentIds.filter(Boolean))];
  const out = new Map<string, ReturnProductContext>();
  if (!ids.length) return out;
  const db = await getDb();

  // ── 1. Chính các vận đơn đang hỏi ──
  const legs = await db
    .select({ id: s.id, orderId: s.orderId, orderReference: s.orderReference, vtpOrderNumber: s.vtpOrderNumber, trackingCode: s.trackingCode })
    .from(s)
    .where(inArray(s.id, ids));

  /** Mã gốc cần lần ngược, theo từng vận đơn chưa có đơn. */
  const baseOf = new Map<string, string>();
  for (const leg of legs) {
    if (leg.orderId) continue;
    // `order_reference` là nơi khâu nhập đặt mã gốc cho vận đơn chiều về; nếu trống thì bóc từ
    // chính mã vận đơn bằng đúng hàm mà khâu đối soát dùng — không tự chế lại regex.
    const base = up(leg.orderReference) || up(legBaseCode(leg.vtpOrderNumber ?? "")) || up(legBaseCode(leg.trackingCode ?? ""));
    if (base) baseOf.set(leg.id, base);
  }

  // ── 2. Lần mã gốc → đơn (một truy vấn cho tất cả mã gốc) ──
  const bases = [...new Set(baseOf.values())];
  /** mã gốc → tập đơn lần ra được. Nhiều hơn một đơn ⇒ mơ hồ, không chọn hộ. */
  const ordersByBase = new Map<string, Set<string>>();
  if (bases.length) {
    const originals = await db
      .select({ orderId: s.orderId, vtpOrderNumber: s.vtpOrderNumber, trackingCode: s.trackingCode })
      .from(s)
      .where(
        and(
          or(inArray(sql`upper(${s.vtpOrderNumber})`, bases), inArray(sql`upper(${s.trackingCode})`, bases)),
          isNotNull(s.orderId),
        ),
      );
    for (const row of originals) {
      if (!row.orderId) continue;
      for (const code of [up(row.vtpOrderNumber), up(row.trackingCode)]) {
        if (!code || !bases.includes(code)) continue;
        const set = ordersByBase.get(code) ?? new Set<string>();
        set.add(row.orderId);
        ordersByBase.set(code, set);
      }
    }
  }

  // ── 3. Chốt đơn cho từng vận đơn ──
  type Resolved = { orderId: string | null; basis: OrderLinkBasis; via: string | null; candidates: string[] };
  const resolved = new Map<string, Resolved>();
  for (const leg of legs) {
    if (leg.orderId) {
      resolved.set(leg.id, { orderId: leg.orderId, basis: "DIRECT", via: null, candidates: [] });
      continue;
    }
    const base = baseOf.get(leg.id);
    const found = base ? [...(ordersByBase.get(base) ?? [])] : [];
    if (found.length === 1) resolved.set(leg.id, { orderId: found[0], basis: "RETURN_LEG", via: base ?? null, candidates: found });
    else if (found.length > 1) resolved.set(leg.id, { orderId: null, basis: "AMBIGUOUS", via: base ?? null, candidates: found });
    else resolved.set(leg.id, { orderId: null, basis: "UNRESOLVED", via: base ?? null, candidates: [] });
  }

  // ── 4. Đơn + dòng hàng, mỗi thứ một truy vấn ──
  const orderIds = [...new Set([...resolved.values()].map((r) => r.orderId).filter((x): x is string => Boolean(x)))];
  const orderInfo = new Map<string, { code: string | null; orderedAt: Date | null; cod: number | null }>();
  const itemsByOrder = new Map<string, ReturnItem[]>();
  /** Đơn có dòng nào ghi số lượng trả > 0 ⇒ có bằng chứng mức món. */
  const hasItemEvidence = new Set<string>();

  if (orderIds.length) {
    const [orderRows, itemRows] = await Promise.all([
      db
        .select({ id: o.id, customId: o.customId, systemId: o.systemId, insertedAt: o.insertedAt, cod: o.cod })
        .from(o)
        .where(inArray(o.id, orderIds)),
      db
        .select({
          orderId: oi.orderId,
          variantId: oi.variantId,
          sku: oi.sku,
          productName: oi.productName,
          variationDetail: oi.variationDetail,
          quantity: oi.quantity,
          returnQuantity: oi.returnQuantity,
          isBonus: oi.isBonus,
          color: pv.color,
          size: pv.size,
        })
        .from(oi)
        .leftJoin(pv, eq(pv.id, oi.variantId))
        .where(inArray(oi.orderId, orderIds)),
    ]);

    for (const r of orderRows) {
      orderInfo.set(r.id, {
        code: (r.customId ?? "").trim() || (r.systemId !== null && r.systemId !== undefined ? String(r.systemId) : null),
        orderedAt: r.insertedAt ?? null,
        cod: r.cod ?? null,
      });
    }
    for (const r of itemRows) if (Number(r.returnQuantity ?? 0) > 0) hasItemEvidence.add(r.orderId);

    for (const r of itemRows) {
      const evidence = hasItemEvidence.has(r.orderId);
      // Có phiếu trả ⇒ CHỈ lấy dòng thực sự bị trả, và lấy đúng số đã trả. Không có ⇒ lấy cả đơn,
      // nhưng bên ngoài sẽ gắn nhãn "chưa xác nhận mặt hàng hoàn".
      const qty = evidence ? Number(r.returnQuantity ?? 0) : Number(r.quantity ?? 0);
      if (evidence && qty <= 0) continue;
      const list = itemsByOrder.get(r.orderId) ?? [];
      list.push({
        variantId: r.variantId ?? null,
        sku: (r.sku ?? "").trim(),
        // Mẫu mã bị xoá / đổi tên: `product_variants` mất dòng thì màu·size trống, nhưng tên và
        // SKU chụp tại lúc bán vẫn nằm trong `order_items` — dùng `variation_detail` làm phương án
        // hai để kho vẫn đọc được "Đỏ / L" thay vì một ô trống.
        name: (r.productName ?? "").trim(),
        color: (r.color ?? "").trim(),
        size: (r.size ?? "").trim(),
        quantity: qty,
        isBonus: Boolean(r.isBonus),
      });
      if (!r.color && !r.size && (r.variationDetail ?? "").trim()) list[list.length - 1].size = (r.variationDetail ?? "").trim();
      itemsByOrder.set(r.orderId, list);
    }
  }

  // ── 5. Lắp lại ──
  for (const id of ids) {
    const r = resolved.get(id);
    if (!r) {
      out.set(id, EMPTY_CONTEXT(id));
      continue;
    }
    const info = r.orderId ? orderInfo.get(r.orderId) : null;
    const items = r.orderId ? (itemsByOrder.get(r.orderId) ?? []) : [];
    const itemsBasis: ItemsBasis = !r.orderId ? "NONE" : hasItemEvidence.has(r.orderId) ? "ITEM_EVIDENCE" : items.length ? "ORDER_ONLY" : "NONE";
    out.set(id, {
      shipmentId: id,
      orderId: r.orderId,
      orderCode: info?.code ?? null,
      orderedAt: info?.orderedAt ?? null,
      orderCod: info?.cod ?? null,
      basis: r.basis,
      itemsBasis,
      items: items.sort((a, b) => a.name.localeCompare(b.name, "vi") || a.sku.localeCompare(b.sku)),
      // CHƯA BIẾT thì để NULL. Trả 0 ở đây là nói dối "kiện này không có món nào".
      expectedQty: itemsBasis === "NONE" ? null : items.reduce((a, x) => a + x.quantity, 0),
      viaBaseCode: r.via,
      candidateOrderIds: r.candidates,
    });
  }
  return out;
}

/**
 * Tổng hợp cho đầu trang kho: bao nhiêu món dự kiến, theo mã hàng nào.
 *
 * CHỈ cộng những kiện đã ghép được đơn. Kiện chưa ghép được đếm riêng ở `unmapped` và KHÔNG được
 * ước lượng thành món — một con số "946 sản phẩm" trộn cả phần đoán sẽ bị đọc thành sự thật tồn
 * kho ngay ngày hôm sau.
 */
export function summarizeReturnItems(contexts: Iterable<ReturnProductContext>) {
  const bySku = new Map<string, { sku: string; name: string; qty: number }>();
  let expectedUnits = 0;
  let mapped = 0;
  let unmapped = 0;
  let unconfirmedItems = 0;
  for (const c of contexts) {
    if (c.expectedQty === null) {
      unmapped += 1;
      continue;
    }
    mapped += 1;
    if (c.itemsBasis === "ORDER_ONLY") unconfirmedItems += 1;
    expectedUnits += c.expectedQty;
    for (const it of c.items) {
      const key = it.sku || it.name || "—";
      const cur = bySku.get(key) ?? { sku: it.sku, name: it.name, qty: 0 };
      cur.qty += it.quantity;
      if (!cur.name) cur.name = it.name;
      bySku.set(key, cur);
    }
  }
  return {
    mapped,
    unmapped,
    unconfirmedItems,
    expectedUnits,
    topSkus: [...bySku.values()].sort((a, b) => b.qty - a.qty),
  };
}

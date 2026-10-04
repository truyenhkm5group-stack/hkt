import { and, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { chayKhongJit, getDb, schema } from "@/db";
import { estimateLotRemaining, fefoPickOrder, lotExpiryState, type InboundLine, type LotExpiryState } from "@/lib/constants/lots";
import { vnDateKey } from "@/lib/format";
import { erpStockExpr, stockKnownExpr, variantReceiptsSubquery, variantSalesSubquery } from "@/lib/queries/stock";

/**
 * ═══════════ LÔ & HẠN DÙNG — ĐỌC (docs/verticals/food-lots.md) ═══════════
 *
 * Tồn của mẫu mã đọc ĐÚNG biểu thức của sổ kho (`erpStockExpr` / `stockKnownExpr` — luật 10), rồi rải vào lô bằng hàm thuần
 * `estimateLotRemaining`. Không có cột «lô còn bao nhiêu» nào: số là ƯỚC TÍNH lúc đọc và màn hình dán nhãn như vậy.
 */

const INBOUND_KINDS = ["RECEIPT", "RETURN", "ADJUSTMENT"];

export type LotView = {
  id: string;
  lotCode: string;
  expiresOn: string;
  producedOn: string | null;
  quantity: number;
  remaining: number | null;
  state: LotExpiryState;
  daysLeft: number;
  receiptReference: string;
  receivedOn: string;
  note: string;
};

export type LotVariantView = {
  variantId: string;
  label: string;
  stockKnown: boolean;
  onHand: number | null;
  lots: LotView[];
  /** Thứ tự lấy hàng: lô còn hàng, hạn gần nhất trước. */
  pickOrder: string[];
  untracked: number | null;
  unexplained: number | null;
};

export type LotBoard = {
  today: string;
  windowDays: number;
  variants: LotVariantView[];
  expired: (LotView & { variantLabel: string })[];
  near: (LotView & { variantLabel: string })[];
};

const variantLabel = (name: string, detail: string, size: string, color: string) => [name, detail.trim() || [size, color].filter((x) => x.trim()).join(" / ")].filter(Boolean).join(" · ");

export async function lotBoard(today: string, windowDays: number): Promise<LotBoard> {
  const db = await getDb();
  const l = schema.stockLots;
  const ri = schema.stockReceiptItems;
  const r = schema.stockReceipts;
  const pv = schema.productVariants;
  const p = schema.products;
  const lots = await db
    .select({ lot: l, receiptReference: r.reference, receivedAt: r.receivedAt, name: p.name, detail: pv.detail, size: pv.size, color: pv.color })
    .from(l)
    .innerJoin(ri, eq(ri.id, l.receiptItemId))
    .innerJoin(r, eq(r.id, ri.receiptId))
    .innerJoin(pv, eq(pv.id, l.variantId))
    .innerJoin(p, eq(p.id, pv.productId))
    .limit(5000);
  const variantIds = [...new Set(lots.map((x) => x.lot.variantId))];
  if (!variantIds.length) return { today, windowDays, variants: [], expired: [], near: [] };

  const [inbound, ledger] = await Promise.all([
    db
      .select({ itemId: ri.id, variantId: ri.variantId, quantity: ri.quantity, receivedAt: r.receivedAt, createdAt: r.createdAt })
      .from(ri)
      .innerJoin(r, eq(r.id, ri.receiptId))
      .where(and(inArray(ri.variantId, variantIds), gt(ri.quantity, 0), inArray(r.kind, INBOUND_KINDS))),
    // Cùng dạng truy vấn với sổ kho (họ `vsales`) — tắt JIT như mọi chỗ khác đọc nó.
    chayKhongJit(db, async (tx) => {
      const sales = variantSalesSubquery(tx, variantIds);
      const receipts = variantReceiptsSubquery(tx, variantIds);
      return await tx
        .select({ variantId: pv.id, stockKnown: stockKnownExpr(receipts), stock: erpStockExpr(sales, receipts) })
        .from(pv)
        .leftJoin(sales, eq(sales.variantId, pv.id))
        .leftJoin(receipts, eq(receipts.variantId, pv.id))
        .where(inArray(pv.id, variantIds));
    }),
  ]);
  const stockOf = new Map(ledger.map((x) => [x.variantId, { known: Boolean(x.stockKnown), stock: Number(x.stock ?? 0) }]));
  const lotsByItem = new Map<string, { id: string; expiresOn: string; quantity: number }[]>();
  for (const x of lots) lotsByItem.set(x.lot.receiptItemId, [...(lotsByItem.get(x.lot.receiptItemId) ?? []), { id: x.lot.id, expiresOn: x.lot.expiresOn, quantity: x.lot.quantity }]);
  const linesByVariant = new Map<string, InboundLine[]>();
  for (const it of inbound) {
    // Khoá thứ tự: mốc nhập (đầu ngày VN) rồi lúc lập phiếu — hai phiếu cùng ngày không đổi chỗ cho nhau giữa hai lượt đọc.
    const line: InboundLine = { itemId: it.itemId, receivedAt: `${it.receivedAt.toISOString()}|${it.createdAt.toISOString()}`, quantity: it.quantity, lots: lotsByItem.get(it.itemId) ?? [] };
    linesByVariant.set(it.variantId, [...(linesByVariant.get(it.variantId) ?? []), line]);
  }

  const variants: LotVariantView[] = variantIds.map((vid) => {
    const st = stockOf.get(vid);
    const onHand = st && st.known ? st.stock : null;
    const est = estimateLotRemaining(linesByVariant.get(vid) ?? [], onHand);
    const mine = lots.filter((x) => x.lot.variantId === vid);
    const views: LotView[] = mine
      .map((x) => {
        const s = lotExpiryState(x.lot.expiresOn, today, windowDays);
        return {
          id: x.lot.id,
          lotCode: x.lot.lotCode,
          expiresOn: x.lot.expiresOn,
          producedOn: x.lot.producedOn,
          quantity: x.lot.quantity,
          remaining: est.remaining.get(x.lot.id) ?? null,
          state: s.state,
          daysLeft: s.daysLeft,
          receiptReference: x.receiptReference,
          receivedOn: vnDateKey(x.receivedAt),
          note: x.lot.note,
        };
      })
      .sort((a, b) => a.expiresOn.localeCompare(b.expiresOn) || a.lotCode.localeCompare(b.lotCode));
    const first = mine[0];
    return {
      variantId: vid,
      label: first ? variantLabel(first.name, first.detail, first.size, first.color) : vid,
      stockKnown: Boolean(st?.known),
      onHand,
      lots: views,
      pickOrder: fefoPickOrder(views, today).map((v) => v.id),
      untracked: est.untracked,
      unexplained: est.unexplained,
    };
  });
  variants.sort((a, b) => (a.lots[0]?.expiresOn ?? "").localeCompare(b.lots[0]?.expiresOn ?? "") || a.label.localeCompare(b.label));
  const flat = variants.flatMap((v) => v.lots.map((x) => ({ ...x, variantLabel: v.label })));
  return {
    today,
    windowDays,
    variants,
    expired: flat.filter((x) => x.state === "EXPIRED" && (x.remaining ?? 0) > 0),
    near: flat.filter((x) => x.state === "NEAR" && (x.remaining ?? 0) > 0).sort((a, b) => a.expiresOn.localeCompare(b.expiresOn)),
  };
}

export type LotItemOption = { itemId: string; label: string; free: number };

/** Dòng phiếu đưa hàng vào kho trong `days` ngày gần nhất mà còn phần CHƯA gắn lô — lựa chọn của form gắn lô. */
export async function lotItemOptions(today: string, days = 120): Promise<LotItemOption[]> {
  const db = await getDb();
  const ri = schema.stockReceiptItems;
  const r = schema.stockReceipts;
  const pv = schema.productVariants;
  const p = schema.products;
  const since = new Date(Date.parse(`${today}T00:00:00+07:00`) - days * 86_400_000);
  const rows = await db
    .select({
      itemId: ri.id,
      quantity: ri.quantity,
      // Câu con tương quan viết TƯỜNG MINH tên bảng — cột drizzle trần trong câu con có thể in ra không kèm bảng.
      used: sql<number>`coalesce((select sum(sl.quantity) from stock_lots sl where sl.receipt_item_id = "stock_receipt_items"."id"), 0)::int`,
      kind: r.kind,
      reference: r.reference,
      receivedAt: r.receivedAt,
      name: p.name,
      detail: pv.detail,
      size: pv.size,
      color: pv.color,
    })
    .from(ri)
    .innerJoin(r, eq(r.id, ri.receiptId))
    .innerJoin(pv, eq(pv.id, ri.variantId))
    .innerJoin(p, eq(p.id, pv.productId))
    .where(and(gt(ri.quantity, 0), inArray(r.kind, INBOUND_KINDS), gte(r.receivedAt, since)))
    .orderBy(desc(r.receivedAt), desc(r.createdAt))
    .limit(500);
  const kindLabel: Record<string, string> = { RECEIPT: "Nhập", RETURN: "Tái nhập", ADJUSTMENT: "Điều chỉnh" };
  return rows
    .map((x) => ({ x, free: x.quantity - Number(x.used ?? 0) }))
    .filter((y) => y.free > 0)
    .map(({ x, free }) => ({
      itemId: x.itemId,
      free,
      label: `${vnDateKey(x.receivedAt).split("-").reverse().join("/")} · ${kindLabel[x.kind] ?? x.kind}${x.reference ? ` ${x.reference}` : ""} · ${variantLabel(x.name, x.detail, x.size, x.color)} · ${x.quantity} cái (còn ${free} chưa gắn lô)`,
    }));
}

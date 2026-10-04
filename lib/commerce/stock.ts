/**
 * ═══════════ TỒN KHẢ DỤNG ĐỌC TRONG GIAO DỊCH GHI ĐƠN (docs/productization/TECH_DEBT.md TD-02 · M3) ═══════════
 *
 * Trước: công cụ chốt đơn của bot đọc tồn (`stockFor`, một kết nối) RỒI lõi đơn mở giao dịch khác để ghi — hai hội thoại cùng
 * chốt món cuối thì cả hai đơn đều qua. Nay chốt đơn của AGENT khoá theo từng mẫu mã (`pg_advisory_xact_lock`, theo thứ tự
 * mã để không khoá chéo) rồi đọc tồn bằng CHÍNH giao dịch đó: lượt thứ hai phải đợi lượt đầu xong, và khi tới lượt nó thấy
 * đơn vừa chốt đã trừ vào khả dụng.
 *
 * Đọc bằng giao dịch, KHÔNG bằng `stockFor()`: bể kết nối mỗi tổ chức chỉ có 2 — giữ một kết nối trong giao dịch rồi xin
 * thêm một kết nối để đọc tồn là hai lượt chốt đồng thời tự khoá chết bể.
 *
 * Công thức tồn KHÔNG đổi (AGENTS §3.10): `availableStockExpr` của `lib/queries/stock.ts`. Mẫu mã chưa có phiếu nhập
 * (`stockKnown = false`) ⇒ không chặn — bot đã ghi chú «tồn chưa xác nhận, kho kiểm trước khi giao» vào đơn.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { availableStockExpr, stockKnownExpr, variantReceiptsSubquery, variantSalesSubquery } from "@/lib/queries/stock";

export type StockTx = Pick<Db, "select" | "execute">;
export type Shortfall = { variantId: string; need: number; available: number };

/** Khoá theo mẫu mã trong giao dịch hiện tại — thứ tự mã tăng dần để hai giao dịch không khoá chéo nhau. */
export async function lockVariants(tx: StockTx, variantIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(variantIds)].filter(Boolean).sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`stock:${id}`}, 0))`);
  }
}

/**
 * Mẫu mã KHÔNG ĐỦ hàng khả dụng cho `need` (số cần THÊM so với phần đơn này đã giữ). Mẫu mã chưa biết tồn ⇒ không tính là
 * thiếu. Gọi SAU `lockVariants` trong cùng giao dịch.
 */
export async function shortfalls(tx: StockTx, need: ReadonlyMap<string, number>): Promise<Shortfall[]> {
  const ids = [...need.entries()].filter(([, n]) => n > 0).map(([id]) => id);
  if (!ids.length) return [];
  const pv = schema.productVariants;
  const sales = variantSalesSubquery(tx, ids);
  const receipts = variantReceiptsSubquery(tx, ids);
  const rows = await tx
    .select({ id: pv.id, known: stockKnownExpr(receipts), available: availableStockExpr(sales, receipts) })
    .from(pv)
    .leftJoin(sales, eq(sales.variantId, pv.id))
    .leftJoin(receipts, eq(receipts.variantId, pv.id))
    .where(inArray(pv.id, ids));
  const out: Shortfall[] = [];
  for (const r of rows) {
    if (!r.known) continue;
    const available = Number(r.available ?? 0);
    const n = need.get(r.id) ?? 0;
    if (available < n) out.push({ variantId: r.id, need: n, available });
  }
  return out;
}

/** Số cần THÊM của từng mẫu mã: dòng mới − phần đơn này đang giữ (đơn đã chốt trước đó). HÀM THUẦN. */
export function additionalNeed(next: readonly { variantId: string; quantity: number }[], held: readonly { variantId: string; quantity: number }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of next) m.set(l.variantId, (m.get(l.variantId) ?? 0) + l.quantity);
  for (const l of held) m.set(l.variantId, (m.get(l.variantId) ?? 0) - l.quantity);
  return m;
}

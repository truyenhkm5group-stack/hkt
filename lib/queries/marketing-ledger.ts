import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { type AdsDimension } from "@/lib/constants/ads-decision";
import { FLIP_WINDOW_DAYS, shiftDay } from "@/lib/constants/marketing-decision-ledger";
import { stabilityOf, type LedgerPoint, type Stability } from "@/lib/marketing/decision-stability";

/**
 * ═══════════ ĐỌC SỔ QUYẾT ĐỊNH QUẢNG CÁO ═══════════
 *
 * Đặc tả: `docs/marketing-ai-department.md`. Ngưỡng: `lib/constants/marketing-decision-ledger.ts`.
 * Đường GHI nằm ở `lib/marketing/decision-ledger.ts` — `lib/queries/*` là chỉ-đọc, và
 * `tests/advisory-safety.test.ts` canh điều đó ở mức mã nguồn.
 *
 * Tệp này không tính lại gì: nó đọc ảnh chụp và giao phần suy luận cho hàm thuần `stabilityOf`.
 */

const ledger = schema.adsDecisionLedger;

/**
 * Lịch sử của một chiều, đủ dài để tính độ bền.
 *
 * Lấy `FLIP_WINDOW_DAYS + 1` ngày: cửa sổ nhịp cần đúng bấy nhiêu quan sát, và một ngày dư để chuỗi
 * giữ nguyên không bị cắt oan ở mép.
 */
export async function ledgerHistory(dimension: AdsDimension, asOfDay: string): Promise<Map<string, LedgerPoint[]>> {
  const db = await getDb();
  const since = shiftDay(asOfDay, -(FLIP_WINDOW_DAYS + 1));
  const rows = await db
    .select({ entityKey: ledger.entityKey, decisionDay: ledger.decisionDay, action: ledger.action, ruleVersion: ledger.ruleVersion })
    .from(ledger)
    .where(and(eq(ledger.dimension, dimension), gte(ledger.decisionDay, since)));

  const byKey = new Map<string, LedgerPoint[]>();
  for (const r of rows) {
    const list = byKey.get(r.entityKey) ?? [];
    list.push({ decisionDay: r.decisionDay, action: r.action as LedgerPoint["action"], ruleVersion: r.ruleVersion });
    byKey.set(r.entityKey, list);
  }
  return byKey;
}

/**
 * Độ bền cho từng dòng của bảng quyết định đang hiển thị.
 *
 * ─── VÌ SAO KHÔNG GỘP VÀO `getAdsDecision` ───
 *
 * Bảng trên màn hình chạy theo kỳ NGƯỜI DÙNG chọn; sổ chỉ tồn tại trên KỲ CHUẨN. Nhồi độ bền vào
 * trong bộ quyết định sẽ làm hai thứ có kỳ khác nhau trông như cùng một phép tính. Ở đây chúng đứng
 * cạnh nhau và giao diện nói rõ cái nào là cái nào.
 *
 * Mục chưa có dòng sổ nào nhận `NO_HISTORY` — CHƯA ĐO, không phải "mới" và cũng không phải "ổn định".
 */
export async function decisionStability(dimension: AdsDimension, keys: string[], asOfDay: string): Promise<Map<string, Stability>> {
  const out = new Map<string, Stability>();
  if (!keys.length) return out;
  const history = await ledgerHistory(dimension, asOfDay);
  for (const key of keys) out.set(key, stabilityOf(history.get(key) ?? [], asOfDay));
  return out;
}

export type LedgerEntry = typeof schema.adsDecisionLedger.$inferSelect;

/** Toàn bộ lịch sử của MỘT mục, mới nhất trước — dùng khi người dùng mở một dòng ra xem. */
export async function entryHistory(dimension: AdsDimension, entityKey: string, limit = 30): Promise<LedgerEntry[]> {
  const db = await getDb();
  return db
    .select()
    .from(ledger)
    .where(and(eq(ledger.dimension, dimension), eq(ledger.entityKey, entityKey)))
    .orderBy(desc(ledger.decisionDay))
    .limit(limit);
}

/** Dòng sổ của một ngày, cho một danh sách mục — dùng để đối chiếu, không dùng để tính tiền. */
export async function ledgerOfDay(dimension: AdsDimension, decisionDay: string, keys?: string[]): Promise<LedgerEntry[]> {
  const db = await getDb();
  const where = keys?.length
    ? and(eq(ledger.dimension, dimension), eq(ledger.decisionDay, decisionDay), inArray(ledger.entityKey, keys))
    : and(eq(ledger.dimension, dimension), eq(ledger.decisionDay, decisionDay));
  return db.select().from(ledger).where(where);
}

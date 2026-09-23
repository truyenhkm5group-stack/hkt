import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
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

/**
 * ───────── TIỀN TRONG KỲ KẾT LUẬN VÀ TIỀN SAU NÓ ─────────
 *
 * Cả hai vế đọc từ `ad_spends` — CÙNG bảng, cùng khoá chiến dịch với `spendByKey` — chứ không lấy
 * vế trong kỳ từ dòng sổ. Hai vế từ hai nguồn thì phép so "sau lớn hơn trong" sẽ đo cả độ lệch giữa
 * hai nguồn, và một ngày nào đó nó chặn (hoặc thả) vì một lý do không liên quan gì tới chiến dịch.
 *
 * Trả `null` cho vế SAU khi không đọc được — không phải 0. Một chiến dịch "không chi gì sau kỳ" và
 * một chiến dịch "ERP không biết đã chi gì sau kỳ" dẫn tới hai quyết định ngược nhau.
 */
export async function spendAroundWindow(campaignKey: string, periodFrom: string, periodTo: string): Promise<{ inWindow: number; afterWindow: number | null }> {
  try {
    const db = await getDb();
    const [r] = await db
      .select({
        inWindow: sql<number>`coalesce(sum(${schema.adSpends.spend}) filter (where ${schema.adSpends.spendDate}::date between ${periodFrom}::date and ${periodTo}::date), 0)`,
        afterWindow: sql<number>`coalesce(sum(${schema.adSpends.spend}) filter (where ${schema.adSpends.spendDate}::date > ${periodTo}::date), 0)`,
      })
      .from(schema.adSpends)
      .where(and(eq(schema.adSpends.excluded, false), sql`coalesce(${schema.adSpends.campaignId}, ${schema.adSpends.campaign}) = ${campaignKey}`));
    return { inWindow: Number(r?.inWindow ?? 0), afterWindow: Number(r?.afterWindow ?? 0) };
  } catch {
    return { inWindow: 0, afterWindow: null };
  }
}

/**
 * ───────── ỨNG VIÊN: CHIẾN DỊCH NÀO CỦA MÃ NÀY CÓ THỂ ĐANG CHẠY ─────────
 *
 * Đây là phép LỌC ỨNG VIÊN, không phải phép thử sự thật. Nó chỉ trả lời "nên hỏi Facebook về chiến
 * dịch nào", để một cú bấm không phải gọi API cho hàng trăm chiến dịch đã tắt từ tháng trước. Câu
 * "chiến dịch còn chạy không" do Facebook trả lời (`status === "ACTIVE"`) ở `subjectFreshness`.
 *
 * Nên `NGAY_UNG_VIEN` rộng rãi cố ý: bỏ sót một chiến dịch đang chạy thì nó nằm ngoài kế hoạch mà
 * không ai biết; lấy thừa một chiến dịch đã tắt thì Facebook tự loại nó, và kế hoạch in ra lý do.
 */
const NGAY_UNG_VIEN = 7;

export async function productCampaignCandidates(productId: string): Promise<{ campaignId: string; name: string; spend: number }[]> {
  const db = await getDb();
  const khoa = sql`coalesce(${schema.adSpends.campaignId}, ${schema.adSpends.campaign})`;
  const rows = await db
    .select({ campaignId: sql<string>`${khoa}`, name: sql<string>`max(${schema.adSpends.campaign})`, spend: sql<number>`coalesce(sum(${schema.adSpends.spend}), 0)` })
    .from(schema.adSpends)
    .where(
      and(
        eq(schema.adSpends.excluded, false),
        eq(schema.adSpends.productId, productId),
        sql`${schema.adSpends.spendDate}::date >= current_date - ${NGAY_UNG_VIEN}`,
        // Chỉ dòng CÓ mã chiến dịch thật: dòng gõ tay mang tên chiến dịch làm khoá thì Facebook không tra được.
        sql`${schema.adSpends.campaignId} is not null`,
      ),
    )
    .groupBy(khoa)
    .having(sql`sum(${schema.adSpends.spend}) > 0`);
  return rows.map((r) => ({ campaignId: String(r.campaignId), name: r.name ?? "", spend: Number(r.spend) })).sort((a, b) => b.spend - a.spend);
}

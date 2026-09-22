import { and, gte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { KHOA_TRAN_NGAY, TRAN_NGAY_USD_MAC_DINH } from "@/lib/constants/ai-budget";

/**
 * ═══════════ ĐỌC TIỀN AI ĐÃ TIÊU HÔM NAY ═══════════
 *
 * Luật thuần nằm ở `lib/constants/ai-budget.ts`; tệp này chỉ làm phần I/O.
 *
 * ─── VÌ SAO PHẢI `nullif(cost_usd,'')` ───
 *
 * `ai_interactions.cost_usd` lưu dạng CHỮ (`text`), và những lượt KHÔNG định giá được ghi chuỗi
 * RỖNG. `sum(cost_usd::numeric)` ném lỗi `invalid input syntax for type numeric: ""` ngay lượt
 * đầu — đã cắn thật 22/09/2026, và đó là bằng chứng con số này chưa từng được ai cộng.
 *
 * Chuỗi rỗng = CHƯA ĐO ĐƯỢC, không phải 0 (mục 42). Ở đây nó bị BỎ QUA khỏi tổng, và số lượt bỏ
 * qua được đếm riêng để nơi gọi nói ra được — chứ không lặng lẽ cộng thiếu.
 */

export type TienHomNay = {
  /** Tổng đã định giá được. `null` = không đọc được sổ (KHÔNG phải 0). */
  usd: number | null;
  /** Số lượt gọi KHÔNG định giá được — tổng ở trên đang thiếu chừng ấy lượt. */
  chuaDoDuoc: number;
};

/** Mốc 00:00 hôm nay theo giờ Việt Nam, trả về dạng UTC để so với `created_at`. */
export function dauNgayVN(now: Date): Date {
  const vn = new Date(now.getTime() + 7 * 3_600_000);
  return new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()) - 7 * 3_600_000);
}

export async function tienAiHomNay(now: Date = new Date()): Promise<TienHomNay> {
  try {
    const db = await getDb();
    const [r] = await db
      .select({
        usd: sql<string>`coalesce(sum(nullif(${schema.aiInteractions.costUsd}, '')::numeric), 0)`,
        chuaDo: sql<number>`count(*) filter (where nullif(${schema.aiInteractions.costUsd}, '') is null)`,
      })
      .from(schema.aiInteractions)
      .where(and(gte(schema.aiInteractions.createdAt, dauNgayVN(now))));
    return { usd: Number(r?.usd ?? 0), chuaDoDuoc: Number(r?.chuaDo ?? 0) };
  } catch {
    // Không đọc được sổ ⇒ CHƯA BIẾT. Nơi gọi quyết, và phải nói ra.
    return { usd: null, chuaDoDuoc: 0 };
  }
}

/** Trần hôm nay: chủ shop đổi ở `settings`, không cần deploy. */
export async function tranNgayUsd(): Promise<number> {
  try {
    const db = await getDb();
    const row = await db.query.settings.findFirst({ where: (t, { eq }) => eq(t.key, KHOA_TRAN_NGAY) });
    const n = Number(row?.value ?? "");
    return Number.isFinite(n) && n > 0 ? n : TRAN_NGAY_USD_MAC_DINH;
  } catch {
    return TRAN_NGAY_USD_MAC_DINH;
  }
}

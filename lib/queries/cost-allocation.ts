import { sql, type SQL } from "drizzle-orm";
import { schema } from "@/db";

const e = schema.expenses;

/**
 * ───────── PHÂN BỔ CHI PHÍ TRONG SQL — bản song sinh của `allocateExpenseToRange` ─────────
 *
 * Báo cáo cộng tiền bằng SQL nên phải có bản SQL; hai bản BẮT BUỘC cho cùng con số, và kiểm thử
 * khoá điều đó (`tests/cost-allocation.test.ts`).
 *
 * Ngày tính theo lịch Việt Nam: mốc lưu là `timestamptz`, quy về `Asia/Ho_Chi_Minh` rồi mới lấy
 * phần ngày. Không làm bước này thì một khoản ghi 23:30 giờ VN sẽ rơi sang ngày hôm trước.
 */
const VN = (col: SQL | string) => sql`((${typeof col === "string" ? sql.raw(col) : col}) at time zone 'Asia/Ho_Chi_Minh')::date`;

/**
 * Số tiền của khoản chi thuộc về khoảng báo cáo `[from, to]` (tính cả hai đầu).
 *
 * Khoản theo kỳ tính bằng HIỆU HAI SỐ LUỸ KẾ chứ không nhân phân số: nhờ vậy hai khoảng liền nhau
 * cộng lại luôn đúng bằng tổng khoản, không lệch một đồng vì làm tròn.
 */
export function allocatedExpenseAmount(from: Date | null, to: Date | null): SQL<number> {
  const start = from ? sql`${from}` : sql`null::timestamptz`;
  const end = to ? sql`${to}` : sql`null::timestamptz`;
  const pStart = VN(sql`${e.periodStart}`);
  const pEnd = VN(sql`${e.periodEnd}`);
  // Ngày cuối của phần chồng lấn, và ngày ngay TRƯỚC ngày đầu của phần chồng lấn.
  const clipTo = sql`least(${pEnd}, coalesce(${VN(end)}, ${pEnd}))`;
  const clipFromPrev = sql`greatest(${pStart}, coalesce(${VN(start)}, ${pStart})) - 1`;
  const totalDays = sql`(${pEnd} - ${pStart} + 1)`;
  /** Luỹ kế từ đầu kỳ tới hết ngày d: 0 nếu trước kỳ, trọn khoản nếu hết kỳ. */
  const cum = (d: SQL) => sql`(case
    when (${d} - ${pStart} + 1) <= 0 then 0
    when (${d} - ${pStart} + 1) >= ${totalDays} then ${e.amount}
    else round((${e.amount}::numeric * (${d} - ${pStart} + 1)) / ${totalDays})
  end)`;
  return sql<number>`(case
    when ${e.allocationMethod} = 'PERIOD_PRORATA' and ${e.periodStart} is not null and ${e.periodEnd} is not null
      then greatest(0, ${cum(clipTo)} - ${cum(clipFromPrev)})
    else ${e.amount}
  end)`;
}

/**
 * Khoản chi có thuộc khoảng báo cáo hay không.
 * Khoản một lần xét theo NGÀY PHÁT SINH; khoản theo kỳ xét theo KỲ CÓ CHỒNG LẤN hay không —
 * đây chính là chỗ mà bản cũ bỏ sót, nên khoản thuê tháng biến mất khỏi mọi tuần trừ tuần đầu.
 */
export function expenseInRange(from: Date | null, to: Date | null): SQL {
  const conds: SQL[] = [];
  if (from) {
    conds.push(sql`(case when ${e.allocationMethod} = 'PERIOD_PRORATA' and ${e.periodEnd} is not null
      then ${e.periodEnd} >= ${from} else ${e.occurredAt} >= ${from} end)`);
  }
  if (to) {
    conds.push(sql`(case when ${e.allocationMethod} = 'PERIOD_PRORATA' and ${e.periodStart} is not null
      then ${e.periodStart} <= ${to} else ${e.occurredAt} <= ${to} end)`);
  }
  if (!conds.length) return sql`true`;
  return sql`(${sql.join(conds, sql` and `)})`;
}

/** Tổng chi phí vận hành đã phân bổ đúng khoảng — dùng chung cho mọi báo cáo. */
export function allocatedExpenseSum(from: Date | null, to: Date | null): SQL<number> {
  return sql<number>`coalesce(sum(${allocatedExpenseAmount(from, to)}), 0)`;
}

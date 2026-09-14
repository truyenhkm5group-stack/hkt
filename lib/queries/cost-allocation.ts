import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { allocateExpenseToRange, type AllocatableExpense } from "@/lib/constants/cost-allocation";
import { COVERAGE_GATED_EXPENSE_CATEGORIES, EVIDENCE_ONLY_EXPENSE_CATEGORIES, HARD_EXCLUDED_EXPENSE_CATEGORIES } from "@/lib/constants/cost-authority";

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

/**
 * ─────────── CHI PHÍ ĐÃ PHÂN BỔ THEO TỪNG NGÀY (cho biểu đồ / bảng theo ngày) ───────────
 *
 * Biểu đồ theo ngày là chỗ bug phân bổ lộ ra rõ nhất: tiền thuê cả tháng đổ vào đúng ngày ghi sổ
 * tạo một cột dựng đứng, những ngày còn lại chi phí bằng 0. Nhìn biểu đồ đó sẽ kết luận "ngày 01
 * lỗ nặng" — sai hoàn toàn.
 *
 * Cộng bằng TypeScript chứ không bằng SQL vì bảng chi phí là sổ nhập tay, số dòng nhỏ, và như vậy
 * chỉ có ĐÚNG MỘT công thức phân bổ (`allocateExpenseToRange`) thay vì thêm một bản SQL thứ ba phải
 * đi khoá bằng kiểm thử. Vòng lặp bị chặn bởi chính kỳ hiệu lực của từng khoản nên không bao giờ
 * chạy vô hạn dù báo cáo chọn "Toàn bộ".
 */
export async function allocatedExpenseByDay(
  db: Db,
  from: Date | null,
  to: Date | null,
): Promise<Map<string, { ads: number; other: number }>> {
  const rows = await db
    .select({
      category: e.category,
      amount: e.amount,
      occurredAt: e.occurredAt,
      allocationMethod: e.allocationMethod,
      periodStart: e.periodStart,
      periodEnd: e.periodEnd,
    })
    .from(e)
    .where(expenseInRange(from, to));

  const out = new Map<string, { ads: number; other: number }>();
  const add = (day: string, isAds: boolean, amount: number) => {
    if (!amount) return;
    const cur = out.get(day) ?? { ads: 0, other: 0 };
    if (isAds) cur.ads += amount;
    else cur.other += amount;
    out.set(day, cur);
  };

  for (const row of rows) {
    const item: AllocatableExpense = {
      amount: Number(row.amount),
      occurredAt: row.occurredAt,
      allocationMethod: row.allocationMethod as AllocatableExpense["allocationMethod"],
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
    };
    const isAds = row.category === "ADS";
    const prorata = item.allocationMethod === "PERIOD_PRORATA" && item.periodStart && item.periodEnd;
    if (!prorata) {
      add(vnDayKey(item.occurredAt), isAds, allocateExpenseToRange(item, from, to));
      continue;
    }
    // Chỉ quét phần chồng lấn giữa kỳ hiệu lực và khoảng báo cáo — không quét cả khoảng báo cáo.
    const start = from && from > item.periodStart! ? from : item.periodStart!;
    const end = to && to < item.periodEnd! ? to : item.periodEnd!;
    for (let day = startOfVnDay(start); day <= end; day = new Date(day.getTime() + 86_400_000)) {
      const dayEnd = new Date(day.getTime() + 86_400_000 - 1);
      add(vnDayKey(day), isAds, allocateExpenseToRange(item, day, dayEnd > end ? end : dayEnd));
    }
  }
  return out;
}

/** Khoá ngày theo lịch Việt Nam, khớp `to_char(... at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')` của SQL. */
function vnDayKey(value: Date): string {
  return new Date(value.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

/** 00:00 giờ Việt Nam của ngày chứa mốc này. */
function startOfVnDay(value: Date): Date {
  const shifted = value.getTime() + 7 * 3_600_000;
  return new Date(Math.floor(shifted / 86_400_000) * 86_400_000 - 7 * 3_600_000);
}

/**
 * ─────────── KHOẢN CHI THUỘC "CHI PHÍ VẬN HÀNH" CỦA BÁO CÁO ───────────
 *
 * Tra sổ đăng ký thẩm quyền (`lib/constants/cost-authority.ts`) thay vì gõ tay danh sách nhóm. Ba
 * chính sách khác nhau, và gộp chúng làm một là nguồn gốc của hai lỗi đã xảy ra:
 *
 *  1. LOẠI HẲN (`ADS`, `PURCHASE`) — tài khoản quảng cáo và phiếu kho bao trọn khoản này.
 *  2. CHỈ NHẬN KHOẢN ĐIỀU CHỈNH CÓ CHỨNG CỨ (`SHIPPING`, `RETURN_FEE`) — cước từng đơn đã tính theo
 *     vận đơn, nhưng đền bù / phí ngoại lệ / cước chuyến gom hàng KHÔNG gắn được vận đơn nào vẫn là
 *     tiền thật. Loại sạch cả nhóm là làm mất tiền thật; nhận hết là trừ hai lần. Nên chỉ nhận khoản
 *     khai rõ `cost_source = 'MANUAL_ADJUSTMENT'` kèm lý do (CSDL bắt buộc có lý do).
 *  3. LOẠI CÓ ĐIỀU KIỆN (`SALARY`) — chỉ khi bảng Lương đã phủ đủ dữ liệu. Chưa đủ mà loại thì lương
 *     thành 0, và 0 nhìn giống một con số hợp lệ.
 */
export function operatingExpenseCond(opts: { payrollCovered?: boolean } = {}): SQL {
  const conds: SQL[] = [sql`${e.category} not in ${HARD_EXCLUDED_EXPENSE_CATEGORIES}`];
  if (EVIDENCE_ONLY_EXPENSE_CATEGORIES.length) {
    conds.push(sql`(${e.category} not in ${EVIDENCE_ONLY_EXPENSE_CATEGORIES} or ${e.costSource} = 'MANUAL_ADJUSTMENT')`);
  }
  if (opts.payrollCovered && COVERAGE_GATED_EXPENSE_CATEGORIES.length) {
    conds.push(sql`${e.category} not in ${COVERAGE_GATED_EXPENSE_CATEGORIES}`);
  }
  return sql`(${sql.join(conds, sql` and `)})`;
}

/** Khoản trong nhóm "chỉ nhận điều chỉnh" mà KHÔNG khai là điều chỉnh — tức phần bị loại vì trùng nguồn. */
export function logisticsDuplicateCond(): SQL {
  return sql`(${e.category} in ${EVIDENCE_ONLY_EXPENSE_CATEGORIES} and ${e.costSource} <> 'MANUAL_ADJUSTMENT')`;
}

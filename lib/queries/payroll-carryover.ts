/**
 * ═══════════ ĐỌC SỔ LỖ LŨY KẾ — PHẦN CHẠM CSDL ═══════════
 *
 * Phép tính nằm ở `lib/payroll/profit-carryover.ts` (hàm thuần, không biết CSDL). File này chỉ trả
 * lời đúng một câu: **số dư đầu tháng của người này là bao nhiêu, và căn cứ ở đâu.**
 *
 * Bốn câu trả lời có thể, và chúng KHÁC NHAU — gộp lại là cách một con số không có căn cứ đi thẳng
 * vào bảng lương:
 *
 *  · `PREV_MONTH_FINAL`      — tháng trước đã CHỐT, lấy số dư cuối của nó. Đủ căn cứ để chốt tiếp.
 *  · `OPENING_DECLARATION`   — chủ shop khai số dư mở sổ, có ngày và có lý do. Đủ căn cứ.
 *  · `PREV_MONTH_DRAFT`      — tháng trước mới là NHÁP. Dùng được để XEM, không đủ để chốt.
 *  · `NONE`                  — chưa có gì. CHƯA BIẾT, không phải 0.
 *
 * `NOT_APPLICABLE` là thứ thứ năm và cũng phải tách riêng: kỳ đang xem không phải một tháng lịch,
 * hoặc sổ chưa được bật. "Không áp dụng" khác "chưa biết" khác "bằng 0" (AGENTS.md mục 42).
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  DEFAULT_PAYROLL_CARRYOVER,
  LEGACY_CARRY_COMPONENT,
  PAYROLL_CARRYOVER_KEY,
  isMonthKey,
  prevMonthKey,
  compareMonthKey,
  type PayrollCarryoverConfig,
} from "@/lib/constants/payroll-carryover";
import { getSettingJson } from "@/lib/settings";

export type OpeningBasis =
  | "PREV_MONTH_FINAL"
  | "OPENING_DECLARATION"
  | "PREV_MONTH_DRAFT"
  | "NONE"
  | "NOT_APPLICABLE";

export type OpeningResolution = {
  /** `null` = CHƯA BIẾT hoặc KHÔNG ÁP DỤNG — đọc `basis` để phân biệt. */
  balance: number | null;
  basis: OpeningBasis;
  /** Đủ căn cứ để CHỐT kỳ hay không. Xem được không có nghĩa là chốt được. */
  established: boolean;
  reason: string;
};

const KHONG_AP_DUNG = (reason: string): OpeningResolution => ({
  balance: null,
  basis: "NOT_APPLICABLE",
  established: false,
  reason,
});

export async function getCarryoverConfig(): Promise<PayrollCarryoverConfig> {
  const raw = await getSettingJson<PayrollCarryoverConfig>(PAYROLL_CARRYOVER_KEY, DEFAULT_PAYROLL_CARRYOVER);
  return {
    enabled: Boolean(raw?.enabled),
    startMonth: isMonthKey(raw?.startMonth) ? raw.startMonth : null,
    startNote: String(raw?.startNote ?? ""),
  };
}

export type CarryoverRow = typeof schema.marketerProfitCarryover.$inferSelect;

/** Mọi dòng sổ của một tháng, theo từng nhân sự. */
export async function carryoverRowsForMonth(
  monthKey: string,
  employeeIds?: string[],
  /*
    MỘT CHUỖI SỐ DƯ MỘT THÀNH PHẦN.

    Sổ nay mang khoá (nhân sự, tháng, THÀNH PHẦN). Không lọc ở đây thì một người mang hai khoản bù
    lỗ sẽ có hai dòng cùng tháng, `new Map(...)` giữ dòng cuối, và số dư của khoản này lặng lẽ trở
    thành số dư của khoản kia. Mặc định là khoản của đường tính cũ, nên mọi lời gọi đang có giữ
    nguyên hành vi.
  */
  componentCode: string = LEGACY_CARRY_COMPONENT,
): Promise<Map<string, CarryoverRow>> {
  const db = await getDb();
  const t = schema.marketerProfitCarryover;
  const conds = [eq(t.monthKey, monthKey), eq(t.componentCode, componentCode)];
  if (employeeIds && employeeIds.length) conds.push(inArray(t.employeeId, employeeIds));
  const rows = await db.select().from(t).where(and(...conds));
  return new Map(rows.map((r) => [r.employeeId, r]));
}

/**
 * SỐ DƯ ĐẦU THÁNG CỦA MỘT NGƯỜI, kèm căn cứ.
 *
 * Thứ tự tra cứu cố ý: dòng của CHÍNH tháng đang hỏi trước (nó đã ghi số dư đầu và nguồn của số dư
 * ấy), rồi mới tới tháng trước. Làm ngược lại thì một tháng đã chốt sẽ bị tính lại số dư đầu theo
 * dữ liệu hôm nay — đúng thứ mà bảng này sinh ra để chặn.
 */
export async function resolveOpening(
  employeeId: string,
  monthKey: string,
  config: PayrollCarryoverConfig,
  /** Khoản bù lỗ nào — xem `carryoverRowsForMonth`. Mặc định là khoản của đường tính cũ. */
  componentCode: string = LEGACY_CARRY_COMPONENT,
): Promise<OpeningResolution> {
  if (!config.enabled) {
    return KHONG_AP_DUNG("Sổ lỗ lũy kế chưa được bật. Bật ở Cấu hình lương → Lỗ lũy kế, kèm tháng mở sổ.");
  }
  if (!config.startMonth) {
    return KHONG_AP_DUNG("Đã bật sổ lỗ lũy kế nhưng chưa khai THÁNG MỞ SỔ, nên chưa có mốc nào để bắt đầu chuỗi số dư.");
  }
  if (compareMonthKey(monthKey, config.startMonth) < 0) {
    return KHONG_AP_DUNG(
      `Tháng ${monthKey} nằm TRƯỚC mốc mở sổ ${config.startMonth} nên sổ lỗ lũy kế không áp dụng — đây là “không áp dụng”, không phải “số dư bằng 0”.`,
    );
  }

  const db = await getDb();
  const t = schema.marketerProfitCarryover;

  // 1 · Dòng của chính tháng này đã ghi số dư đầu và nguồn của nó.
  const [chinhThang] = await db
    .select()
    .from(t)
    .where(and(eq(t.employeeId, employeeId), eq(t.monthKey, monthKey), eq(t.componentCode, componentCode)));
  if (chinhThang) {
    return {
      balance: chinhThang.openingBalance,
      basis: chinhThang.openingSource === "OPENING_DECLARATION" ? "OPENING_DECLARATION" : "PREV_MONTH_FINAL",
      established: true,
      reason:
        chinhThang.openingSource === "OPENING_DECLARATION"
          ? "Số dư mở sổ do chủ shop khai đích danh."
          : "Lấy từ số dư cuối của tháng trước đã chốt.",
    };
  }

  // 2 · Chính tháng mở sổ mà chưa có dòng nào: số dư đầu là 0 THEO KHAI BÁO của chủ shop (mốc mở
  //     sổ là một quyết định có chủ, có ngày), không phải máy tự điền 0 cho mọi người.
  if (monthKey === config.startMonth) {
    return {
      balance: 0,
      basis: "OPENING_DECLARATION",
      established: true,
      reason: `Tháng ${monthKey} là mốc MỞ SỔ do chủ shop khai${config.startNote ? ` (“${config.startNote}”)` : ""}, nên số dư đầu bằng 0 theo khai báo — không phải một con số máy tự đặt.`,
    };
  }

  // 3 · Tháng trước.
  const truoc = prevMonthKey(monthKey);
  const [dongTruoc] = await db
    .select()
    .from(t)
    .where(and(eq(t.employeeId, employeeId), eq(t.monthKey, truoc), eq(t.componentCode, componentCode)));
  if (dongTruoc && dongTruoc.status === "FINAL") {
    return {
      balance: dongTruoc.closingBalance,
      basis: "PREV_MONTH_FINAL",
      established: true,
      reason: `Số dư cuối tháng ${truoc} đã chốt.`,
    };
  }
  if (dongTruoc) {
    return {
      balance: dongTruoc.closingBalance,
      basis: "PREV_MONTH_DRAFT",
      established: false,
      reason: `Tháng ${truoc} MỚI LÀ NHÁP nên số dư này là mô phỏng — xem được, chưa đủ căn cứ để chốt tháng ${monthKey}.`,
    };
  }
  return {
    balance: null,
    basis: "NONE",
    established: false,
    reason: `Chưa có dòng sổ nào cho tháng ${truoc}, nên số dư đầu tháng ${monthKey} là CHƯA BIẾT — không được coi là 0.`,
  };
}

/** Giải số dư đầu tháng cho NHIỀU người cùng lúc (một lượt đọc mỗi tháng thay vì mỗi người). */
export async function resolveOpeningMany(
  employeeIds: readonly string[],
  monthKey: string,
  config: PayrollCarryoverConfig,
  componentCode: string = LEGACY_CARRY_COMPONENT,
): Promise<Map<string, OpeningResolution>> {
  const out = new Map<string, OpeningResolution>();
  if (!employeeIds.length) return out;
  if (!config.enabled || !config.startMonth || compareMonthKey(monthKey, config.startMonth) < 0) {
    // Một lời giải thích chung, không đi hỏi CSDL — chưa bật thì không có gì để đọc.
    const chung = await resolveOpening(employeeIds[0], monthKey, config, componentCode);
    for (const id of employeeIds) out.set(id, chung);
    return out;
  }
  const [thisMonth, prevRows] = await Promise.all([
    carryoverRowsForMonth(monthKey, [...employeeIds], componentCode),
    carryoverRowsForMonth(prevMonthKey(monthKey), [...employeeIds], componentCode),
  ]);
  const truoc = prevMonthKey(monthKey);
  for (const id of employeeIds) {
    const here = thisMonth.get(id);
    if (here) {
      out.set(id, {
        balance: here.openingBalance,
        basis: here.openingSource === "OPENING_DECLARATION" ? "OPENING_DECLARATION" : "PREV_MONTH_FINAL",
        established: true,
        reason:
          here.openingSource === "OPENING_DECLARATION"
            ? "Số dư mở sổ do chủ shop khai đích danh."
            : "Lấy từ số dư cuối của tháng trước đã chốt.",
      });
      continue;
    }
    if (monthKey === config.startMonth) {
      out.set(id, {
        balance: 0,
        basis: "OPENING_DECLARATION",
        established: true,
        reason: `Tháng ${monthKey} là mốc MỞ SỔ do chủ shop khai${config.startNote ? ` (“${config.startNote}”)` : ""}, nên số dư đầu bằng 0 theo khai báo.`,
      });
      continue;
    }
    const before = prevRows.get(id);
    if (before && before.status === "FINAL") {
      out.set(id, { balance: before.closingBalance, basis: "PREV_MONTH_FINAL", established: true, reason: `Số dư cuối tháng ${truoc} đã chốt.` });
    } else if (before) {
      out.set(id, {
        balance: before.closingBalance,
        basis: "PREV_MONTH_DRAFT",
        established: false,
        reason: `Tháng ${truoc} MỚI LÀ NHÁP nên số dư này là mô phỏng — xem được, chưa đủ căn cứ để chốt tháng ${monthKey}.`,
      });
    } else {
      out.set(id, {
        balance: null,
        basis: "NONE",
        established: false,
        reason: `Chưa có dòng sổ nào cho tháng ${truoc}, nên số dư đầu tháng ${monthKey} là CHƯA BIẾT — không được coi là 0.`,
      });
    }
  }
  return out;
}

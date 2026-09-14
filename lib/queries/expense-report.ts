import { and, count, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { NON_EXPENSE_GROUPS } from "@/lib/constants/cashflow-sections";
import { EXPENSE_CATEGORY_LABEL } from "@/lib/constants/expenses";
import { allocatedExpenseSum, expenseInRange, operatingExpenseCond } from "@/lib/queries/cost-allocation";
import { getRecognizedCosts, type CostEngineWarning } from "@/lib/queries/cost-engine";
import { previousPeriod, type Period } from "@/lib/search-params";
import { rowsOf } from "@/lib/sql-rows";
import type { ExpenseCategory } from "@/db/schema";

/**
 * ═══════════ BÁO CÁO CHI PHÍ — "KHOẢN NÀO ĐANG TĂNG BẤT THƯỜNG" ═══════════
 *
 * Trang Chi phí hiện là một BIỂU MẪU NHẬP: nhập khoản chi, xem danh sách, sửa, xoá. Nó trả lời
 * được "tháng này đã ghi những khoản gì" và không trả lời được câu duy nhất đáng hỏi — "khoản nào
 * đang tăng, tăng bao nhiêu, và vì sao".
 *
 * ─── HAI CƠ SỞ, GỌI TÊN RÕ, KHÔNG BAO GIỜ CỘNG VỚI NHAU ───
 *
 * Đây là quyết định thiết kế quan trọng nhất của tệp, và nó theo đúng chủ đề "lợi nhuận ≠ tiền":
 *
 *   · CHI PHÍ GHI NHẬN (`byCategory`, `recognized`) — theo KỲ HƯỞNG LỢI ÍCH, đã phân bổ theo số
 *     ngày chồng lấn, đã áp luật thẩm quyền nguồn. Đây là con số vào lợi nhuận. Lấy qua
 *     `cost-engine`, KHÔNG tự cộng (AGENTS.md mục 18).
 *   · TIỀN ĐÃ RA (`trend`, `topVendors`) — theo NGÀY NGÂN HÀNG GHI, từ sao kê. Đây là con số làm
 *     tài khoản vơi đi.
 *
 * Một khoản thuê năm trả một lần nằm gọn trong một ngày ở cơ sở thứ hai và rải đều 365 ngày ở cơ sở
 * thứ nhất. Cả hai đều đúng. Vẽ chúng trên cùng một trục rồi cộng lại là sai, nên ở đây chúng là
 * hai khối riêng có nhãn riêng.
 *
 * Biểu đồ theo ngày cố ý dùng TIỀN ĐÃ RA: một đường "chi phí đã phân bổ theo ngày" thì phẳng theo
 * thiết kế (tiền thuê chia đều mỗi ngày) nên không phát hiện được gì; còn đường tiền thật có đỉnh,
 * và đỉnh là thứ cần nhìn.
 */

export type ExpenseCategoryLine = {
  category: ExpenseCategory | "UNKNOWN";
  label: string;
  amount: number;
  count: number;
  /** Cùng nhóm ở kỳ trước cùng độ dài. `null` = kỳ không có biên để so. */
  previous: number | null;
  delta: number | null;
  /** `null` khi kỳ trước bằng 0 — chia cho 0 không phải "tăng 100%", mà là KHÔNG SO ĐƯỢC. */
  deltaPct: number | null;
  /** Chiếm bao nhiêu phần trăm tổng chi phí ghi nhận của kỳ. */
  share: number;
};

export type VendorLine = { counterparty: string; amount: number; count: number };

export type ExpenseTrendPoint = { day: string; cashOut: number; ads: number };

export type ExpenseReport = {
  period: Period;
  /** Chi phí VẬN HÀNH ghi nhận trong kỳ — con số của lợi nhuận, lấy từ cost-engine. */
  recognized: number;
  recognizedPrevious: number | null;
  byCategory: ExpenseCategoryLine[];
  /** Nhóm biến động mạnh nhất theo GIÁ TRỊ TUYỆT ĐỐI, không theo phần trăm. */
  largestChanges: ExpenseCategoryLine[];
  /** Tiền thật đã ra theo ngày, từ sao kê — KHÁC cơ sở với `byCategory`. */
  trend: ExpenseTrendPoint[];
  /** Trả cho ai nhiều nhất, theo sao kê. Rỗng khi chưa nhập sao kê. */
  topVendors: VendorLine[];
  /** Tiền RA chưa phân loại: việc cần làm, vì chưa biết nó thuộc chi phí nào. */
  unclassifiedOutflow: { count: number; amount: number };
  /** Cảnh báo của cost-engine (trừ hai lần / nguồn chưa phủ đủ) — lấy lại, không tự đánh giá. */
  warnings: CostEngineWarning[];
  hasBankData: boolean;
};

export async function getExpenseReport(period: Period): Promise<ExpenseReport> {
  return memo(`expense-report:${periodKey(period)}`, 90_000, () => build(period));
}

async function build(period: Period): Promise<ExpenseReport> {
  const db = await getDb();
  const prev = previousPeriod(period);
  const e = schema.expenses;

  /**
   * Chi phí theo NHÓM, đã phân bổ đúng khoảng.
   *
   * `operatingExpenseCond()` thay cho một danh sách nhóm bị loại gõ tay — AGENTS.md mục 15 cấm
   * hard-code danh sách đó, vì quảng cáo có nguồn riêng (tài khoản QC) và tiền hàng có nguồn riêng
   * (phiếu kho); cộng lại ở đây là trừ hai lần.
   */
  const theoNhom = async (from: Date | null, to: Date | null) =>
    db
      .select({ category: e.category, amount: allocatedExpenseSum(from, to), n: count() })
      .from(e)
      .where(and(expenseInRange(from, to), operatingExpenseCond()))
      .groupBy(e.category);

  const [rows, prevRows, costs, prevCosts, bankRows, vendorRows, unclassifiedRow] = await Promise.all([
    theoNhom(period.from, period.to),
    prev.from ? theoNhom(prev.from, prev.to) : Promise.resolve([]),
    getRecognizedCosts(period),
    prev.from
      ? getRecognizedCosts({ ...period, key: "custom", from: prev.from, to: prev.to, fromKey: null, toKey: null, label: "Kỳ trước" })
      : Promise.resolve(null),
    tienRaTheoNgay(period),
    topVendors(period),
    tienRaChuaPhanLoai(period),
  ]);

  const prevByCategory = new Map(prevRows.map((r) => [r.category, Number(r.amount ?? 0)]));
  const total = rows.reduce((t, r) => t + Number(r.amount ?? 0), 0);

  const byCategory: ExpenseCategoryLine[] = rows
    .map((r) => {
      const amount = Number(r.amount ?? 0);
      const previous = prev.from ? (prevByCategory.get(r.category) ?? 0) : null;
      const delta = previous === null ? null : amount - previous;
      return {
        category: r.category,
        label: EXPENSE_CATEGORY_LABEL[r.category] ?? r.category,
        amount,
        count: Number(r.n),
        previous,
        delta,
        // Kỳ trước 0đ thì KHÔNG so được bằng phần trăm. "Tăng ∞%" hay "tăng 100%" đều là bịa.
        deltaPct: previous === null || previous === 0 ? null : ((amount - previous) / previous) * 100,
        share: total > 0 ? (amount / total) * 100 : 0,
      };
    })
    .sort((a, b) => b.amount - a.amount);

  /**
   * BIẾN ĐỘNG MẠNH NHẤT XẾP THEO SỐ TIỀN, KHÔNG THEO PHẦN TRĂM.
   *
   * Một khoản 50.000đ tăng thành 150.000đ là +200% và đứng đầu mọi bảng xếp theo phần trăm, trong
   * khi một khoản 40 triệu tăng thành 52 triệu chỉ +30% và nằm dưới. Khoản thứ hai mới là khoản
   * làm chủ shop mất tiền. Phần trăm vẫn hiện để đọc, nhưng KHÔNG dùng để xếp hạng.
   */
  const largestChanges = byCategory
    .filter((c) => c.delta !== null && c.delta !== 0)
    .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0))
    .slice(0, 6);

  return {
    period,
    recognized: costs.operatingTotal,
    recognizedPrevious: prevCosts ? prevCosts.operatingTotal : null,
    byCategory,
    largestChanges,
    trend: bankRows,
    topVendors: vendorRows,
    unclassifiedOutflow: unclassifiedRow,
    warnings: costs.warnings,
    hasBankData: bankRows.some((p) => p.cashOut > 0) || vendorRows.length > 0,
  };
}

/**
 * TIỀN RA THEO NGÀY: sao kê (mọi khoản chi) + tài khoản quảng cáo (tách riêng).
 *
 * Quảng cáo tách thành đường riêng vì nó là khoản chi lớn nhất, biến động nhanh nhất, và là khoản
 * duy nhất chủ shop có thể tắt trong một phút. Gộp nó vào tổng thì mọi đỉnh trên biểu đồ đều là
 * đỉnh quảng cáo và không còn thấy gì khác.
 *
 * Ngày quy về lịch Việt Nam trước khi gom: mốc lưu là `timestamptz`, không quy đổi thì khoản chi
 * 23:30 giờ VN rơi sang ngày hôm trước (xem `lib/queries/cost-allocation.ts`).
 */
async function tienRaTheoNgay(period: Period): Promise<ExpenseTrendPoint[]> {
  const db = await getDb();
  const tu = period.from ? sql`and b.txn_at >= ${period.from}` : sql``;
  const den = period.to ? sql`and b.txn_at <= ${period.to}` : sql``;
  const tuQc = period.from ? sql`and a.spend_date >= ${period.from}` : sql``;
  const denQc = period.to ? sql`and a.spend_date <= ${period.to}` : sql``;
  const rows = rowsOf<{ day: string; cash_out: number; ads: number }>(
    await db.execute(sql`
      with tien_ra as (
        select (b.txn_at at time zone 'Asia/Ho_Chi_Minh')::date as ngay,
               coalesce(-sum(b.amount), 0) as tien
        from bank_transactions b
        where b.amount < 0
          -- Chuyển nội bộ / trả gốc / rút vốn KHÔNG phải chi phí: tính vào thì biểu đồ chi phí có
          -- những đỉnh không tương ứng khoản chi nào, và người đọc đi tìm một khoản không tồn tại.
          and b.accounting_group not in ${NON_EXPENSE_GROUPS}
          ${tu} ${den}
        group by 1
      ),
      qc as (
        select (a.spend_date at time zone 'Asia/Ho_Chi_Minh')::date as ngay,
               coalesce(sum(a.spend), 0) as tien
        from ad_spends a
        where a.excluded = false ${tuQc} ${denQc}
        group by 1
      )
      select to_char(coalesce(t.ngay, q.ngay), 'YYYY-MM-DD') as day,
             coalesce(t.tien, 0) as cash_out,
             coalesce(q.tien, 0) as ads
      from tien_ra t full outer join qc q on q.ngay = t.ngay
      order by 1
    `),
  );
  return rows.map((r) => ({ day: r.day, cashOut: Number(r.cash_out ?? 0), ads: Number(r.ads ?? 0) }));
}

/** Trả cho ai nhiều nhất trong kỳ, theo sao kê. */
async function topVendors(period: Period): Promise<VendorLine[]> {
  const db = await getDb();
  const tu = period.from ? sql`and b.txn_at >= ${period.from}` : sql``;
  const den = period.to ? sql`and b.txn_at <= ${period.to}` : sql``;
  const rows = rowsOf<{ counterparty: string; amount: number; n: number }>(
    await db.execute(sql`
      select
        coalesce(nullif(trim(b.counterparty), ''), '(không ghi tên)') as counterparty,
        coalesce(-sum(b.amount), 0) as amount,
        count(*) as n
      from bank_transactions b
      where b.amount < 0
        and b.accounting_group not in ${NON_EXPENSE_GROUPS}
        ${tu} ${den}
      group by 1
      order by amount desc
      limit 10
    `),
  );
  return rows.map((r) => ({ counterparty: r.counterparty, amount: Number(r.amount ?? 0), count: Number(r.n ?? 0) }));
}

/** Tiền RA chưa phân loại — chưa biết thuộc chi phí nào, nên chưa khoản nào trong báo cáo có nó. */
async function tienRaChuaPhanLoai(period: Period): Promise<{ count: number; amount: number }> {
  const db = await getDb();
  const tu = period.from ? sql`and b.txn_at >= ${period.from}` : sql``;
  const den = period.to ? sql`and b.txn_at <= ${period.to}` : sql``;
  const rows = rowsOf<{ n: number; amount: number }>(
    await db.execute(sql`
      select count(*) as n, coalesce(-sum(b.amount), 0) as amount
      from bank_transactions b
      where b.amount < 0 and b.accounting_group = 'UNCLASSIFIED' ${tu} ${den}
    `),
  );
  return { count: Number(rows[0]?.n ?? 0), amount: Number(rows[0]?.amount ?? 0) };
}

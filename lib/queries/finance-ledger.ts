/**
 * ═══════════ SỔ TIỀN HỢP NHẤT: MỘT CÂU TRẢ LỜI CHO MỖI CÂU HỎI VỀ TIỀN ═══════════
 *
 * Hợp đồng: `docs/finance-truth-contract.md`.
 *
 * Trước tệp này, sáu màn hình cùng hỏi "tiền vào ra bao nhiêu" và mỗi màn hình tự cộng một kiểu:
 * Sổ ngân hàng cộng theo bộ lọc danh sách, Đối soát COD cộng theo bảng kê, Dòng tiền dự phóng theo
 * nhịp chi, Lợi nhuận cộng theo kỳ hưởng lợi ích. Không phép cộng nào SAI, nhưng không hai phép nào
 * so được với nhau — nên không ai trả lời được câu hỏi thật sự của chủ shop: **lãi trên giấy thì có,
 * mà tiền đâu?**
 *
 * Tệp này KHÔNG tính lại cái gì đã có nguồn. Nó ĐỌC LẠI: `getRecognizedCosts` cho chi phí,
 * `getFinancialTruth` cho doanh thu/COD, `getCashPosition` cho số dư, `bank_transactions` cho tổng
 * phát sinh. Việc của nó là ĐẶT CHÚNG CẠNH NHAU mà không cộng chồng.
 *
 * ─── RANH GIỚI VỚI BUỒNG LÁI TÀI CHÍNH ───
 *
 * Ba tệp cùng nói về tiền, và mỗi tệp trả lời ĐÚNG MỘT câu hỏi:
 *
 *   `cash-position.ts`      → "còn bao nhiêu, ở tài khoản nào" (số dư, ba mức chắc chắn).
 *   `cashflow-statement.ts` → "kỳ vừa rồi tiền vào ra thế nào" (báo cáo dòng tiền theo bốn khoang).
 *   `profit-cash-bridge.ts` → "vì sao lợi nhuận khác tiền".
 *   tệp này                 → "NGHĨA VỤ đã phát sinh đã được tiền thật phủ tới đâu", cộng độ phủ
 *                             mối nối và tình trạng ghép cặp chuyển nội bộ.
 *
 * Không tệp nào trong bốn tệp được trả lời câu của tệp kia. Bản đầu của tệp này có cả số dư lẫn
 * cầu nối riêng; cả hai đã bị gỡ khi gộp, vì hai cách tính cho một câu hỏi là hai con số khác nhau
 * trên hai màn hình.
 *
 * ─── HAI ĐIỀU TỆP NÀY TUYỆT ĐỐI KHÔNG LÀM ───
 *  · Không biến một dòng tiền thành chi phí hay doanh thu. Tiền ra đã nối với khoản chi vẫn chỉ là
 *    TIỀN; khoản chi vẫn được ghi nhận theo kỳ hưởng lợi ích ở Profit Engine.
 *  · Không suy ra kết quả giao hàng. Tiền COD về không chứng minh đơn nào đã tới tay khách.
 */
import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { BANK_CASH_CLASS_LABEL, BANK_GROUP_SPEC, isBankGroup, type BankCashClass, type BankGroup } from "@/lib/constants/bank";
import { getCashPosition, type AccountBalance } from "@/lib/queries/cash-position";
import { getRecognizedCosts } from "@/lib/queries/cost-engine";
import { getFinancialTruth } from "@/lib/queries/financial-truth";
import type { Period } from "@/lib/search-params";

const b = schema.bankTransactions;
const l = schema.bankTransactionLinks;

function khoangThoiGian(column: AnyPgColumn, from: Date | null, to: Date | null): SQL[] {
  const conds: SQL[] = [];
  if (from) conds.push(gte(column, from));
  if (to) conds.push(lte(column, to));
  return conds;
}

/** Nhóm KHÔNG thuộc dòng tiền kinh doanh — chuyển nội bộ, vốn/vay, rút vốn, ngoài kinh doanh. */
const NON_BUSINESS: BankGroup[] = (Object.keys(BANK_GROUP_SPEC) as BankGroup[]).filter((g) => {
  const c = BANK_GROUP_SPEC[g].cashClass;
  return c !== "BUSINESS_INFLOW" && c !== "BUSINESS_OUTFLOW" && c !== "TAX" && c !== "UNCLASSIFIED";
});

export type CashLedger = {
  period: Period;
  /** 0 giao dịch nghĩa là CHƯA CÓ DỮ LIỆU, không phải "kỳ này không phát sinh". */
  hasData: boolean;
  txnCount: number;
  /** Mọi dòng, kể cả chuyển nội bộ — dùng để đối chiếu với sao kê giấy. */
  inflow: number;
  outflow: number;
  net: number;
  /** Đã loại chuyển nội bộ, vốn/vay, rút vốn, ngoài kinh doanh. Đây là con số để ra quyết định. */
  businessInflow: number;
  businessOutflow: number;
  businessNet: number;
  /**
   * Chuyển nội bộ. `net` PHẢI bằng 0 khi cả hai chân đã về sổ — một đồng đổi túi không được vừa là
   * tiền ra vừa là tiền vào. Lệch khác 0 nghĩa là còn chân chưa nhập hoặc gán nhóm sai.
   */
  internalTransfer: { in: number; out: number; net: number; count: number; pairedCount: number; unpairedCount: number };
  classified: { count: number; amount: number };
  unclassified: { count: number; amount: number };
  byCashClass: { cashClass: BankCashClass; label: string; in: number; out: number; count: number }[];
  /**
   * Số dư — ĐỌC LẠI từ `lib/queries/cash-position.ts`, không tính ở đây.
   * `total = null` khi chưa tài khoản nào biết được số dư; `complete = false` nghĩa là con số chỉ
   * là CẬN DƯỚI vì còn tài khoản chưa biết, và màn hình phải nói ra điều đó.
   */
  balance: { total: number | null; knownAccounts: number; totalAccounts: number; complete: boolean; accounts: AccountBalance[] };
  /** Phân bổ mối nối: bao nhiêu tiền đã đối chiếu được với chứng từ. */
  linkage: { linkedAmount: number; linkedTxns: number; unlinkedTxns: number };
};

async function cashLedgerUncached(period: Period): Promise<CashLedger> {
  const db = await getDb();
  const conds = khoangThoiGian(b.txnAt, period.from, period.to);
  const where = conds.length ? and(...conds) : undefined;
  const business = sql`${b.accountingGroup} not in ${NON_BUSINESS}`;

  const [tong] = await db
    .select({
      n: sql<number>`count(*)`,
      inflow: sql<number>`coalesce(sum(${b.amount}) filter (where ${b.amount} > 0), 0)`,
      outflow: sql<number>`coalesce(-sum(${b.amount}) filter (where ${b.amount} < 0), 0)`,
      bizIn: sql<number>`coalesce(sum(${b.amount}) filter (where ${b.amount} > 0 and ${business}), 0)`,
      bizOut: sql<number>`coalesce(-sum(${b.amount}) filter (where ${b.amount} < 0 and ${business}), 0)`,
      transferIn: sql<number>`coalesce(sum(${b.amount}) filter (where ${b.amount} > 0 and ${b.accountingGroup} = 'INTERNAL_TRANSFER'), 0)`,
      transferOut: sql<number>`coalesce(-sum(${b.amount}) filter (where ${b.amount} < 0 and ${b.accountingGroup} = 'INTERNAL_TRANSFER'), 0)`,
      transferCount: sql<number>`count(*) filter (where ${b.accountingGroup} = 'INTERNAL_TRANSFER')`,
      unclassifiedN: sql<number>`count(*) filter (where ${b.accountingGroup} = 'UNCLASSIFIED')`,
      unclassifiedAmt: sql<number>`coalesce(sum(abs(${b.amount})) filter (where ${b.accountingGroup} = 'UNCLASSIFIED'), 0)`,
      classifiedN: sql<number>`count(*) filter (where ${b.accountingGroup} <> 'UNCLASSIFIED')`,
      classifiedAmt: sql<number>`coalesce(sum(abs(${b.amount})) filter (where ${b.accountingGroup} <> 'UNCLASSIFIED'), 0)`,
    })
    .from(b)
    .where(where);

  /*
    ĐẾM "ĐÃ CÓ MỐI NỐI" BẰNG `where exists`, KHÔNG BẰNG `count(*) filter (where exists …)`.

    Không phải chuyện phong cách. Trong DANH SÁCH CỘT, drizzle dựng cột KHÔNG kèm tên bảng, nên
    `${b.id}` ra đúng chữ `"id"`; đặt vào truy vấn con `from bank_transaction_links tl` thì chữ đó
    bám vào `tl.id`, điều kiện thành `tl.txn_id = tl.id` và bộ đếm luôn ra 0. Không lỗi, không cảnh
    báo — chỉ là sổ báo "chưa ai đối chiếu gì" trong khi kế toán vừa đối chiếu xong. Dựng lại được
    bằng `.toSQL()` ngày 12/09/2026.

    Ở `where` drizzle CÓ kèm tên bảng, nên cùng biểu thức đó đặt trong `where` là đúng.
  */
  const coNoi = sql`exists (select 1 from bank_transaction_links tl where tl.txn_id = ${b.id})`;
  const [demNoi] = await db
    .select({ linkedTxns: sql<number>`count(*)` })
    .from(b)
    .where(where ? and(where, coNoi) : coNoi);
  const [demGhep] = await db
    .select({ paired: sql<number>`count(*)` })
    .from(b)
    .where(
      and(
        ...(where ? [where] : []),
        eq(b.accountingGroup, "INTERNAL_TRANSFER"),
        sql`exists (select 1 from bank_transaction_links tl where tl.txn_id = ${b.id} and tl.target_type = 'BANK_TRANSACTION')`,
      ),
    );

  const nhomRows = await db
    .select({
      group: b.accountingGroup,
      in: sql<number>`coalesce(sum(${b.amount}) filter (where ${b.amount} > 0), 0)`,
      out: sql<number>`coalesce(-sum(${b.amount}) filter (where ${b.amount} < 0), 0)`,
      n: sql<number>`count(*)`,
    })
    .from(b)
    .where(where)
    .groupBy(b.accountingGroup);

  const theoLoai = new Map<BankCashClass, { in: number; out: number; count: number }>();
  for (const r of nhomRows) {
    const g: BankGroup = isBankGroup(r.group) ? r.group : "UNCLASSIFIED";
    const c = BANK_GROUP_SPEC[g].cashClass;
    const cur = theoLoai.get(c) ?? { in: 0, out: 0, count: 0 };
    cur.in += Number(r.in);
    cur.out += Number(r.out);
    cur.count += Number(r.n);
    theoLoai.set(c, cur);
  }

  const [linkRow] = await db
    .select({ amount: sql<number>`coalesce(sum(${l.amount}), 0)` })
    .from(l)
    .innerJoin(b, eq(b.id, l.txnId))
    .where(where);

  /*
    SỐ DƯ: KHÔNG TÍNH Ở ĐÂY.

    `lib/queries/cash-position.ts` là nguồn DUY NHẤT cho "tài khoản còn bao nhiêu", và nó phân ba
    mức chắc chắn (CONFIRMED / DERIVED / UNKNOWN) cùng phép kiểm chuỗi số dư. Bản đầu của tệp này
    tự đọc `balance_after` mới nhất — cùng câu hỏi, cách tính khác, nên hai màn hình sẽ hiện HAI số
    dư khác nhau cho cùng một tài khoản ngay khi giao dịch gần nhất không mang số dư ngân hàng.

    Đó đúng là thứ bản gộp này phải loại: một con số, một cách tính.
  */
  const viTri = await getCashPosition();

  const transferIn = Number(tong?.transferIn ?? 0);
  const transferOut = Number(tong?.transferOut ?? 0);
  const transferCount = Number(tong?.transferCount ?? 0);
  const transferPaired = Number(demGhep?.paired ?? 0);
  const inflow = Number(tong?.inflow ?? 0);
  const outflow = Number(tong?.outflow ?? 0);
  const bizIn = Number(tong?.bizIn ?? 0);
  const bizOut = Number(tong?.bizOut ?? 0);
  const txnCount = Number(tong?.n ?? 0);
  const linkedTxns = Number(demNoi?.linkedTxns ?? 0);

  return {
    period,
    hasData: txnCount > 0,
    txnCount,
    inflow,
    outflow,
    net: inflow - outflow,
    businessInflow: bizIn,
    businessOutflow: bizOut,
    businessNet: bizIn - bizOut,
    internalTransfer: {
      in: transferIn,
      out: transferOut,
      net: transferIn - transferOut,
      count: transferCount,
      pairedCount: transferPaired,
      unpairedCount: transferCount - transferPaired,
    },
    classified: { count: Number(tong?.classifiedN ?? 0), amount: Number(tong?.classifiedAmt ?? 0) },
    unclassified: { count: Number(tong?.unclassifiedN ?? 0), amount: Number(tong?.unclassifiedAmt ?? 0) },
    byCashClass: [...theoLoai.entries()]
      .map(([cashClass, v]) => ({ cashClass, label: BANK_CASH_CLASS_LABEL[cashClass], ...v }))
      .sort((x, y) => y.in + y.out - (x.in + x.out)),
    balance: {
      total: viTri.total,
      knownAccounts: viTri.knownAccounts,
      totalAccounts: viTri.knownAccounts + viTri.unknownAccounts,
      complete: viTri.complete,
      accounts: viTri.accounts,
    },
    linkage: { linkedAmount: Number(linkRow?.amount ?? 0), linkedTxns, unlinkedTxns: txnCount - linkedTxns },
  };
}

export async function getCashLedger(period: Period): Promise<CashLedger> {
  return memo(`cashLedger:${periodKey(period)}`, 90_000, () => cashLedgerUncached(period));
}

/**
 * ═══════ NGHĨA VỤ ĐÃ PHÁT SINH ↔ TIỀN ĐÃ TRẢ ═══════
 *
 * Ba cặp câu hỏi mà trước đây không màn hình nào đặt cạnh nhau được:
 *
 *   CHI PHÍ: kỳ này ghi nhận bao nhiêu ↔ đã có bao nhiêu đồng tiền thật nối vào.
 *   COD:     ĐVVC phải trả bao nhiêu   ↔ đã về tài khoản bao nhiêu.
 *   LƯƠNG:   kỳ này nợ nhân sự bao nhiêu ↔ đã chi trả bao nhiêu.
 *
 * PHẦN CHÊNH KHÔNG PHẢI LỖI. Lương tháng 9 trả ngày 05/10 thì tháng 9 luôn có nghĩa vụ chưa trả —
 * đó là hoạt động bình thường, không phải cảnh báo. Con số này trả lời "còn phải chi bao nhiêu",
 * không phán xét ai sai.
 *
 * `settled` đọc từ MỐI NỐI, không từ nhóm kế toán: nhóm nói dòng tiền *thuộc loại* gì, mối nối mới
 * nói nó ứng với *chứng từ nào*. Suy "đã trả" từ nhóm là quay lại đúng lối tắt mà cả hợp đồng này
 * sinh ra để chặn.
 */
export type ObligationLine = {
  key: "EXPENSE" | "COD" | "PAYROLL";
  label: string;
  /** Nghĩa vụ đã phát sinh trong kỳ, theo sổ có thẩm quyền. */
  obligation: number;
  /** Tiền thật đã nối vào nghĩa vụ đó. */
  settled: number;
  /** Còn lại. Âm nghĩa là đã trả nhiều hơn nghĩa vụ của kỳ (trả cho kỳ trước) — bình thường. */
  outstanding: number;
  obligationSource: string;
  settledSource: string;
  note: string;
};

export type ObligationLedger = { period: Period; lines: ObligationLine[]; hasBankData: boolean };

async function obligationLedgerUncached(period: Period): Promise<ObligationLedger> {
  const db = await getDb();
  const [chiPhi, truth, ledger] = await Promise.all([getRecognizedCosts(period), getFinancialTruth(period), getCashLedger(period)]);

  const daNoi = async (types: readonly string[]) => {
    const conds: SQL[] = [sql`${l.targetType} in ${types}`, ...khoangThoiGian(b.txnAt, period.from, period.to)];
    const [row] = await db
      .select({ amount: sql<number>`coalesce(sum(${l.amount}), 0)` })
      .from(l)
      .innerJoin(b, eq(b.id, l.txnId))
      .where(and(...conds));
    return Number(row?.amount ?? 0);
  };

  const [chiPhiTra, codVe, luongTra] = await Promise.all([
    daNoi(["EXPENSE", "STOCK_RECEIPT", "AD_SPEND"]),
    daNoi(["COD_BATCH"]),
    daNoi(["PAYROLL_PERIOD"]),
  ]);

  // ĐVVC phải trả: tiền COD của đơn GIAO THÀNH CÔNG chưa thấy đồng nào trên bảng kê, cộng phần đã
  // lên bảng kê trong kỳ. Đây là sổ ĐỐI SOÁT ĐVVC, không phải sổ tiền.
  const codPhaiTra = truth.cod.outstanding + truth.cash.received;

  const lines: ObligationLine[] = [
    {
      key: "EXPENSE",
      label: "Chi phí vận hành",
      obligation: chiPhi.operatingTotal,
      settled: chiPhiTra,
      outstanding: chiPhi.operatingTotal - chiPhiTra,
      obligationSource: "Profit Engine (kỳ hưởng lợi ích)",
      settledSource: "Mối nối tới khoản chi / phiếu nhập / chi tiêu QC",
      note: "Chi phí ghi theo kỳ HƯỞNG LỢI ÍCH, tiền đi theo ngày TRẢ. Hai mốc lệch nhau là bình thường — phần chênh là khoản còn phải chi, không phải lỗi.",
    },
    {
      key: "COD",
      label: "Tiền COD ĐVVC",
      obligation: codPhaiTra,
      settled: codVe > 0 ? codVe : truth.cash.received,
      outstanding: codPhaiTra - (codVe > 0 ? codVe : truth.cash.received),
      obligationSource: "Kết quả đơn + tiền thu hộ khai báo",
      settledSource: codVe > 0 ? "Mối nối tới đợt nhận tiền COD" : "Bảng kê ĐVVC (chưa có mối nối nào)",
      note: "ĐVVC giữ tiền hàng tuần. Phần chưa về KHÔNG chứng minh đơn chưa giao, và tiền về KHÔNG chứng minh đơn đã giao.",
    },
    {
      key: "PAYROLL",
      label: "Lương & hoa hồng",
      obligation: chiPhi.payroll.totalPayrollCost,
      settled: luongTra,
      outstanding: chiPhi.payroll.totalPayrollCost - luongTra,
      obligationSource: chiPhi.payroll.mode === "PAYROLL" ? "Bảng Lương (chia theo ngày)" : "Bảng Chi phí (bảng Lương chưa cầm quyền)",
      settledSource: "Mối nối tới kỳ lương",
      note: "Nghĩa vụ lương phát sinh theo THÁNG LÀM VIỆC; tiền thường ra vào tháng sau. Chênh dương ở đây là chuyện thường, không phải nợ xấu.",
    },
  ];

  return { period, lines, hasBankData: ledger.hasData };
}

export async function getObligationLedger(period: Period): Promise<ObligationLedger> {
  return memo(`obligationLedger:${periodKey(period)}`, 90_000, () => obligationLedgerUncached(period));
}

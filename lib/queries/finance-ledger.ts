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
 * `getFinancialTruth` cho doanh thu/COD, `getRecognizedPayrollCost` cho nghĩa vụ lương,
 * `bank_transactions` cho tiền. Việc của nó là ĐẶT CHÚNG CẠNH NHAU mà không cộng chồng.
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

export type AccountBalance = {
  id: string;
  label: string;
  accountNumber: string;
  status: string;
  /** `null` = CHƯA BIẾT. Ngân hàng/SePay không phải lúc nào cũng gửi số dư luỹ kế. */
  balance: number | null;
  balanceAt: Date | null;
  txnCount: number;
};

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
  /** Số dư. `total = null` khi CHƯA tài khoản nào có số dư luỹ kế — không được hiển thị thành 0đ. */
  balance: { total: number | null; knownAccounts: number; totalAccounts: number; accounts: AccountBalance[] };
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

  /**
   * SỐ DƯ: dòng MỚI NHẤT của mỗi tài khoản CÓ số dư luỹ kế.
   *
   * Đọc TOÀN BỘ lịch sử chứ không chỉ trong kỳ: số dư là trạng thái tại một thời điểm, không phải
   * một phép cộng của kỳ. Lọc theo kỳ thì một tài khoản không phát sinh trong kỳ sẽ hiện "chưa
   * biết" trong khi ERP biết rõ số dư của nó.
   */
  const accountRows = await db
    .select({
      id: schema.bankAccounts.id,
      label: schema.bankAccounts.label,
      accountNumber: schema.bankAccounts.accountNumber,
      status: schema.bankAccounts.status,
      /*
        VIẾT NGUYÊN `"bank_accounts"."id"`, KHÔNG dùng `${schema.bankAccounts.id}`.

        Trong DANH SÁCH CỘT, drizzle dựng cột KHÔNG kèm tên bảng — `${schema.bankAccounts.id}` ra
        đúng chữ `"id"`. Đặt vào một truy vấn con tương quan có `from bank_transactions t`, chữ
        `"id"` đó bám vào `t.id` chứ không phải tài khoản đang xét, nên điều kiện thành
        `t.bank_account_id = t.id` — KHÔNG BAO GIỜ đúng, KHÔNG báo lỗi, và mọi tài khoản hiện
        "chưa biết số dư". Đã dựng lại được bằng `.toSQL()` ngày 12/09/2026.

        (Ở `where` drizzle có kèm tên bảng nên chỗ đó an toàn — chỉ danh sách cột mới dính.)
      */
      balance: sql<number | null>`(select t.balance_after from bank_transactions t
        where t.bank_account_id = "bank_accounts"."id" and t.balance_after is not null
        order by t.txn_at desc, t.created_at desc limit 1)`,
      balanceAt: sql<Date | null>`(select t.txn_at from bank_transactions t
        where t.bank_account_id = "bank_accounts"."id" and t.balance_after is not null
        order by t.txn_at desc, t.created_at desc limit 1)`,
      txnCount: sql<number>`(select count(*) from bank_transactions t where t.bank_account_id = "bank_accounts"."id")`,
    })
    .from(schema.bankAccounts);

  const accounts: AccountBalance[] = accountRows.map((r) => ({
    id: r.id,
    label: r.label || r.accountNumber,
    accountNumber: r.accountNumber,
    status: r.status,
    balance: r.balance === null || r.balance === undefined ? null : Number(r.balance),
    balanceAt: r.balanceAt ? new Date(r.balanceAt) : null,
    txnCount: Number(r.txnCount),
  }));
  const coSoDu = accounts.filter((a) => a.balance !== null);

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
      total: coSoDu.length ? coSoDu.reduce((t, a) => t + (a.balance ?? 0), 0) : null,
      knownAccounts: coSoDu.length,
      totalAccounts: accounts.length,
      accounts,
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

/**
 * ═══════ CẦU NỐI LỢI NHUẬN → TIỀN MẶT ═══════
 *
 * Câu hỏi này chủ shop hỏi mỗi tháng và ERP chưa bao giờ trả lời được: **"báo lãi 40 triệu mà tài
 * khoản có 6 triệu, tiền đi đâu?"**
 *
 * Bảng dưới đi từ LỢI NHUẬN ƯỚC TÍNH (theo đơn, theo kỳ hưởng lợi ích) xuống DÒNG TIỀN KINH DOANH
 * RÒNG (tiền thật vào ra trong kỳ), nêu tên từng khoản chênh. Mỗi dòng là một lý do cụ thể, không
 * phải một số dư ép cho khớp.
 *
 * KHÔNG ÉP KHỚP. Phần không giải thích được hiện nguyên ở dòng cuối với nhãn "chưa giải thích được"
 * — bịa một dòng "điều chỉnh khác" để tổng bằng nhau là biến một công cụ chẩn đoán thành một công
 * cụ trấn an.
 */
export type BridgeLine = { key: string; label: string; amount: number; note: string; subtotal?: boolean };

export type CashProfitBridge = {
  period: Period;
  lines: BridgeLine[];
  estimatedProfit: number;
  businessNetCash: number;
  /** Phần chênh KHÔNG giải thích được bằng các dòng ở trên. Càng gần 0 thì hai sổ càng khớp. */
  unexplained: number;
  hasBankData: boolean;
  limitations: string[];
};

async function bridgeUncached(period: Period): Promise<CashProfitBridge> {
  const [truth, ledger, ngh] = await Promise.all([getFinancialTruth(period), getCashLedger(period), getObligationLedger(period)]);

  const codChuaVe = ngh.lines.find((x) => x.key === "COD")?.outstanding ?? 0;
  const chiChuaTra = ngh.lines.find((x) => x.key === "EXPENSE")?.outstanding ?? 0;
  const luongChuaTra = ngh.lines.find((x) => x.key === "PAYROLL")?.outstanding ?? 0;

  const lines: BridgeLine[] = [
    {
      key: "profit",
      label: "Lợi nhuận ước tính (theo đơn trong kỳ)",
      amount: truth.estimatedProfit,
      note: "Doanh thu giao thành công trừ giá vốn, cước, quảng cáo, vận hành. Là LỢI ÍCH KINH TẾ của kỳ, không phải tiền trong tài khoản.",
      subtotal: true,
    },
    {
      key: "cod_held",
      label: "− Tiền COD ĐVVC còn giữ",
      amount: -codChuaVe,
      note: "Hàng đã tới tay khách, doanh thu đã ghi, nhưng tiền còn nằm ở ĐVVC. Đây thường là khoản chênh LỚN NHẤT của shop bán COD.",
    },
    {
      key: "unpaid_expense",
      label: "+ Chi phí đã ghi nhận nhưng chưa chi tiền",
      amount: chiChuaTra,
      note: "Chi phí thuộc kỳ này mà tiền chưa ra (trả sau, trả gối đầu). Lợi nhuận đã trừ, tài khoản thì chưa.",
    },
    {
      key: "unpaid_payroll",
      label: "+ Lương đã ghi nhận nhưng chưa trả",
      amount: luongChuaTra,
      note: "Lương tháng làm việc thường trả sang tháng sau.",
    },
    {
      key: "non_operating",
      label: "± Dòng tiền không thuộc lãi lỗ",
      amount: -(ledger.byCashClass.find((c) => c.cashClass === "CAPITAL")?.in ?? 0) + (ledger.byCashClass.find((c) => c.cashClass === "OWNER")?.out ?? 0),
      note: "Góp vốn, vay, rút vốn: tiền thật vào ra nhưng không phải lãi lỗ. Đưa vào đây để hai vế nói cùng một ngôn ngữ.",
    },
  ];

  const giaiThich = lines.reduce((t, x) => t + x.amount, 0);
  const unexplained = ledger.businessNet - giaiThich;

  lines.push({
    key: "business_net_cash",
    label: "= Dòng tiền kinh doanh ròng (tiền thật)",
    amount: ledger.businessNet,
    note: "Tiền thật vào trừ tiền thật ra trong kỳ, đã loại chuyển nội bộ. Đây là con số quyết định tuần sau có tiền chạy quảng cáo hay không.",
    subtotal: true,
  });

  return {
    period,
    lines,
    estimatedProfit: truth.estimatedProfit,
    businessNetCash: ledger.businessNet,
    unexplained,
    hasBankData: ledger.hasData,
    limitations: [
      ...(ledger.hasData
        ? []
        : ["Kỳ này CHƯA có giao dịch ngân hàng nào trong ERP, nên vế tiền mặt đang là 0 vì THIẾU DỮ LIỆU, không phải vì không phát sinh."]),
      ...(ledger.unclassified.count > 0
        ? [`${ledger.unclassified.count} giao dịch chưa phân loại (${ledger.unclassified.amount.toLocaleString("vi-VN")} ₫) vẫn nằm trong dòng tiền kinh doanh — phân loại xong con số sẽ đổi.`]
        : []),
      ...(ledger.internalTransfer.unpairedCount > 0
        ? [`${ledger.internalTransfer.unpairedCount} chân chuyển nội bộ chưa ghép đôi; chênh ${ledger.internalTransfer.net.toLocaleString("vi-VN")} ₫ đang lọt vào số dư thay vì triệt tiêu.`]
        : []),
      "Phần “chưa giải thích được” KHÔNG bị ép về 0. Nó lớn nghĩa là còn nghĩa vụ hoặc dòng tiền chưa được nối với chứng từ, không phải một khoản tiền bị mất.",
    ],
  };
}

export async function getCashProfitBridge(period: Period): Promise<CashProfitBridge> {
  return memo(`cashProfitBridge:${periodKey(period)}`, 90_000, () => bridgeUncached(period));
}

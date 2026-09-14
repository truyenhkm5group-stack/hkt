/**
 * ═══════ SỔ GIAO DỊCH NGÂN HÀNG — TRUY VẤN ═══════
 *
 * Sao kê trả lời câu hỏi khác hẳn báo cáo lợi nhuận: "tiền thật đã vào ra bao nhiêu", chứ không
 * phải "kỳ này lãi bao nhiêu". Hai câu hỏi đó KHÔNG bao giờ ra cùng một số, và đó là chuyện bình
 * thường — tiền hàng trả trước cho xưởng là tiền ra hôm nay nhưng là giá vốn của tháng sau.
 *
 * Vì vậy mọi tổng hợp ở đây đều theo NGÀY GIAO DỊCH TRÊN SAO KÊ, không phân bổ theo kỳ hiệu lực.
 * Phân bổ là việc của bảng Chi phí sau khi giao dịch được đẩy sang (`lib/queries/cost-allocation.ts`).
 */
import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import { BANK_GROUPS, BANK_GROUP_SPEC, isBankGroup, isBusinessCash, type BankGroup } from "@/lib/constants/bank";
import { getRecognizedCosts } from "@/lib/queries/cost-engine";
import type { ListParams, Period } from "@/lib/search-params";

const b = schema.bankTransactions;

export const BANK_SORTABLE = ["txnAt", "amount", "counterparty", "accountingGroup"];

/** Nhóm KHÔNG phải dòng tiền kinh doanh (chuyển nội bộ, trả gốc, rút vốn…) — loại khỏi mọi tổng dòng tiền */
export const NON_BUSINESS_GROUPS = BANK_GROUPS.filter((g) => !isBusinessCash(g));

function periodCond(column: AnyPgColumn, from: Date | null, to: Date | null): SQL[] {
  const conds: SQL[] = [];
  if (from) conds.push(gte(column, from));
  if (to) conds.push(lte(column, to));
  return conds;
}

export type BankFilters = {
  /** Nhóm kế toán */
  group?: string[];
  /** Mã danh mục chi tiết của app sao kê */
  category?: string[];
  /** Lọc theo một tài khoản ngân hàng cụ thể (bank_accounts.id) */
  account?: string[];
};

export type BankListOptions = {
  direction: "ANY" | "IN" | "OUT";
  onlyUnclassified: boolean;
};

export function bankListWhere(params: ListParams, options: BankListOptions): SQL | undefined {
  const conds: SQL[] = periodCond(b.txnAt, params.period.from, params.period.to);
  const groups = (params.filters.group ?? []).filter(isBankGroup);
  if (groups.length) conds.push(inArray(b.accountingGroup, groups));
  if (params.filters.category?.length) conds.push(inArray(b.categoryCode, params.filters.category));
  if (params.filters.account?.length) conds.push(inArray(b.bankAccountId, params.filters.account));
  if (options.direction === "IN") conds.push(sql`${b.amount} > 0`);
  if (options.direction === "OUT") conds.push(sql`${b.amount} < 0`);
  if (options.onlyUnclassified) conds.push(eq(b.accountingGroup, "UNCLASSIFIED"));
  const term = params.q.trim();
  if (term) {
    const like = `%${term}%`;
    const found = or(ilike(b.description, like), ilike(b.counterparty, like), ilike(b.bankRef, like), ilike(b.note, like));
    if (found) conds.push(found);
  }
  return conds.length ? and(...conds) : undefined;
}

export async function listBankTransactions(params: ListParams, options: BankListOptions) {
  const db = await getDb();
  const where = bankListWhere(params, options);
  const sortMap: Record<string, AnyPgColumn> = {
    txnAt: b.txnAt,
    amount: b.amount,
    counterparty: b.counterparty,
    accountingGroup: b.accountingGroup,
  };
  const column = sortMap[params.sort] ?? b.txnAt;
  const order = params.dir === "asc" ? asc(column) : desc(column);
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: b.id,
        txnAt: b.txnAt,
        amount: b.amount,
        description: b.description,
        counterparty: b.counterparty,
        bankRef: b.bankRef,
        accountingGroup: b.accountingGroup,
        categoryCode: b.categoryCode,
        note: b.note,
        classifiedBy: b.classifiedBy,
        source: b.source,
        ruleId: b.ruleId,
        linkedType: b.linkedType,
        linkedId: b.linkedId,
        /** Đã nối với chứng từ nào chưa — ĐỐI CHIẾU, không phải ghi nhận chi phí */
        linked: sql<boolean>`${b.linkedType} <> ''`,
      })
      .from(b)
      .where(where)
      .orderBy(order, desc(b.bankRef))
      .limit(params.pageSize)
      .offset((params.page - 1) * params.pageSize),
    db.select({ n: count() }).from(b).where(where),
  ]);
  const n = Number(total?.n ?? 0);
  return { rows, total: n, pageCount: Math.max(1, Math.ceil(n / params.pageSize)) };
}

export type BankTxnRow = Awaited<ReturnType<typeof listBankTransactions>>["rows"][number];

/**
 * Tổng tiền vào / ra của bộ lọc hiện tại.
 *
 * `businessIn` / `businessOut` LOẠI các nhóm không phải dòng tiền kinh doanh: chuyển giữa tài khoản
 * của mình mà tính vào thì cùng một đồng vừa là tiền ra vừa là tiền vào, chênh lệch vẫn đúng nhưng
 * hai con số tổng đều bị thổi phồng — nhìn vào sẽ tưởng shop quay vòng gấp đôi thực tế.
 */
export async function bankSummary(params: ListParams, options: BankListOptions) {
  const db = await getDb();
  const where = bankListWhere(params, options);
  const business = sql`${b.accountingGroup} not in ${NON_BUSINESS_GROUPS}`;
  const [row] = await db
    .select({
      count: count(),
      moneyIn: sql<number>`coalesce(sum(${b.amount}) filter (where ${b.amount} > 0), 0)`,
      moneyOut: sql<number>`coalesce(-sum(${b.amount}) filter (where ${b.amount} < 0), 0)`,
      businessIn: sql<number>`coalesce(sum(${b.amount}) filter (where ${b.amount} > 0 and ${business}), 0)`,
      businessOut: sql<number>`coalesce(-sum(${b.amount}) filter (where ${b.amount} < 0 and ${business}), 0)`,
      unclassified: sql<number>`count(*) filter (where ${b.accountingGroup} = 'UNCLASSIFIED')`,
      unclassifiedAmount: sql<number>`coalesce(sum(abs(${b.amount})) filter (where ${b.accountingGroup} = 'UNCLASSIFIED'), 0)`,
    })
    .from(b)
    .where(where);
  const moneyIn = Number(row?.moneyIn ?? 0);
  const moneyOut = Number(row?.moneyOut ?? 0);
  const businessIn = Number(row?.businessIn ?? 0);
  const businessOut = Number(row?.businessOut ?? 0);
  return {
    count: Number(row?.count ?? 0),
    moneyIn,
    moneyOut,
    net: moneyIn - moneyOut,
    businessIn,
    businessOut,
    businessNet: businessIn - businessOut,
    unclassified: Number(row?.unclassified ?? 0),
    unclassifiedAmount: Number(row?.unclassifiedAmount ?? 0),
  };
}

/** Tổng theo nhóm kế toán trong kỳ — bảng đối chiếu "tiền thật đi đâu" */
export async function bankByGroup(period: Period) {
  const db = await getDb();
  const rows = await db
    .select({
      group: b.accountingGroup,
      count: count(),
      moneyIn: sql<number>`coalesce(sum(${b.amount}) filter (where ${b.amount} > 0), 0)`,
      moneyOut: sql<number>`coalesce(-sum(${b.amount}) filter (where ${b.amount} < 0), 0)`,
    })
    .from(b)
    .where(and(...periodCond(b.txnAt, period.from, period.to)))
    .groupBy(b.accountingGroup);
  return rows
    .map((r) => ({
      group: (isBankGroup(r.group) ? r.group : "UNCLASSIFIED") as BankGroup,
      label: isBankGroup(r.group) ? BANK_GROUP_SPEC[r.group].label : r.group,
      count: Number(r.count),
      moneyIn: Number(r.moneyIn),
      moneyOut: Number(r.moneyOut),
    }))
    .sort((x, y) => y.moneyOut + y.moneyIn - (x.moneyOut + x.moneyIn));
}

/** Số giao dịch chưa phân loại (toàn bộ, không theo kỳ) — huy hiệu trên tab */
export async function unclassifiedBankCount(): Promise<number> {
  const db = await getDb();
  const [row] = await db.select({ n: count() }).from(b).where(eq(b.accountingGroup, "UNCLASSIFIED"));
  return Number(row?.n ?? 0);
}


/**
 * ═══════ DANH SÁCH TÀI KHOẢN NGÂN HÀNG ═══════
 *
 * Một truy vấn, gộp sẵn số liệu theo tài khoản. CỐ Ý gộp ở CSDL thay vì đếm từng tài khoản ở
 * TypeScript: số tài khoản thì ít, nhưng `bank_transactions` sẽ lớn dần, và một vòng lặp gọi N+1
 * câu lệnh là cách một trang nhẹ biến thành trang chậm sau vài tháng.
 *
 * `lastIn` / `lastOut` là MỐC của giao dịch gần nhất mỗi chiều, không phải số tiền cộng dồn —
 * người xem cần biết "tài khoản này còn sống không", và một con số tổng không trả lời được câu đó.
 */
export async function listBankAccounts() {
  const db = await getDb();
  const a = schema.bankAccounts;
  const b = schema.bankTransactions;

  const soLieu = db
    .select({
      bankAccountId: b.bankAccountId,
      soGiaoDich: sql<number>`count(*)`.as("so_giao_dich"),
      tienVao: sql<number>`coalesce(sum(case when ${b.amount} > 0 then ${b.amount} else 0 end), 0)`.as("tien_vao"),
      tienRa: sql<number>`coalesce(sum(case when ${b.amount} < 0 then -${b.amount} else 0 end), 0)`.as("tien_ra"),
      lanVaoGanNhat: sql<Date | null>`max(${b.txnAt}) filter (where ${b.amount} > 0)`.as("lan_vao_gan_nhat"),
      lanRaGanNhat: sql<Date | null>`max(${b.txnAt}) filter (where ${b.amount} < 0)`.as("lan_ra_gan_nhat"),
      // Đếm riêng cho TÀI KHOẢN này — số tổng ở `unclassifiedBankCount()` là của cả sổ, không giúp
      // chủ shop biết tài khoản nào đang tồn đọng việc phân loại.
      chuaPhanLoai: sql<number>`count(*) filter (where ${b.accountingGroup} = 'UNCLASSIFIED')`.as("chua_phan_loai"),
    })
    .from(b)
    .where(isNotNull(b.bankAccountId))
    .groupBy(b.bankAccountId)
    .as("so_lieu");

  const rows = await db
    .select({
      id: a.id,
      provider: a.provider,
      gateway: a.gateway,
      accountNumber: a.accountNumber,
      subAccount: a.subAccount,
      label: a.label,
      currency: a.currency,
      status: a.status,
      note: a.note,
      lastSeenAt: a.lastSeenAt,
      createdAt: a.createdAt,
      soGiaoDich: sql<number>`coalesce(${soLieu.soGiaoDich}, 0)`,
      tienVao: sql<number>`coalesce(${soLieu.tienVao}, 0)`,
      tienRa: sql<number>`coalesce(${soLieu.tienRa}, 0)`,
      lanVaoGanNhat: soLieu.lanVaoGanNhat,
      lanRaGanNhat: soLieu.lanRaGanNhat,
      chuaPhanLoai: sql<number>`coalesce(${soLieu.chuaPhanLoai}, 0)`,
    })
    .from(a)
    .leftJoin(soLieu, eq(soLieu.bankAccountId, a.id))
    // Chưa xác nhận lên đầu: đó là việc cần người làm, không phải thông tin để đọc cho biết.
    .orderBy(sql`case when ${a.status} = 'UNCONFIRMED' then 0 when ${a.status} = 'ACTIVE' then 1 else 2 end`, asc(a.gateway), asc(a.accountNumber));

  return rows.map((r) => ({
    ...r,
    soGiaoDich: Number(r.soGiaoDich),
    tienVao: Number(r.tienVao),
    tienRa: Number(r.tienRa),
    chuaPhanLoai: Number(r.chuaPhanLoai),
  }));
}

export type BankAccountRow = Awaited<ReturnType<typeof listBankAccounts>>[number];

/**
 * Lần đối chiếu API SePay gần nhất — job `sepay_reconcile` quét TOÀN BỘ giao dịch của mọi tài
 * khoản SePay trong một lượt (không tách theo từng tài khoản), nên đây là một mốc DÙNG CHUNG cho
 * mọi tài khoản `provider = 'SEPAY'`. Tài khoản khai tay (sao kê tải file) không có đối chiếu tự
 * động — `null` ở đó nghĩa là "không áp dụng", không phải "chưa từng chạy".
 */
export async function sepayLastReconciliation(): Promise<{ finishedAt: Date; status: string } | null> {
  const db = await getDb();
  const row = await db.query.syncRuns.findFirst({
    where: and(eq(schema.syncRuns.source, "SEPAY"), eq(schema.syncRuns.job, "sepay_reconcile"), isNotNull(schema.syncRuns.finishedAt)),
    orderBy: [desc(schema.syncRuns.finishedAt)],
    columns: { status: true, finishedAt: true },
  });
  return row?.finishedAt ? { finishedAt: row.finishedAt, status: row.status } : null;
}

/** Số tài khoản đang chờ người xác nhận — để gắn số lên tab, đúng cách `giao-dich` đang làm. */
export async function unconfirmedBankAccountCount(): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.bankAccounts)
    .where(eq(schema.bankAccounts.status, "UNCONFIRMED"));
  return Number(row?.n ?? 0);
}

/** Các mã danh mục chi tiết đang có trong dữ liệu — để dựng bộ lọc mà không hard-code danh sách */
export async function bankFacets(params: ListParams, options: BankListOptions) {
  const db = await getDb();
  const base = bankListWhere({ ...params, filters: {} }, { ...options, onlyUnclassified: false });
  const [groups, categories] = await Promise.all([
    db.select({ value: b.accountingGroup, n: count() }).from(b).where(base).groupBy(b.accountingGroup),
    db.select({ value: b.categoryCode, n: count() }).from(b).where(and(base, ne(b.categoryCode, ""))).groupBy(b.categoryCode),
  ]);
  const groupCounts = new Map(groups.map((g) => [g.value, Number(g.n)]));
  return {
    groups: BANK_GROUPS.filter((g) => groupCounts.has(g) || params.filters.group?.includes(g)).map((g) => ({
      value: g as string,
      label: BANK_GROUP_SPEC[g].label,
      count: groupCounts.get(g) ?? 0,
    })),
    categories: categories
      .map((c) => ({ value: c.value, label: c.value, count: Number(c.n) }))
      .sort((x, y) => y.count - x.count)
      .slice(0, 40),
  };
}

export async function listBankRules() {
  const db = await getDb();
  return db.select().from(schema.bankRules).orderBy(asc(schema.bankRules.priority), asc(schema.bankRules.name));
}

export type BankRuleRow = Awaited<ReturnType<typeof listBankRules>>[number];

/**
 * ĐỐI CHIẾU SAO KÊ ↔ SỔ SÁCH ERP theo kỳ.
 *
 * Với mỗi nhóm có nguồn chuyên biệt, so tiền thật trên sao kê với con số ERP đang dùng trong báo
 * cáo. Lệch KHÔNG có nghĩa là sai — trả tiền xưởng tháng này cho hàng nhập tháng trước thì lệch là
 * đúng. Bảng này để chủ shop NHÌN THẤY khoảng lệch và tự phán đoán, chứ ERP không tự sửa bên nào.
 */
/**
 * Một dòng đối soát. `bankAmount = null` nghĩa là **CHƯA NHẬP SAO KÊ**, không phải "chi 0đ".
 *
 * Phân biệt này không phải chuyện chữ nghĩa. Sổ ngân hàng rỗng mà hiện 0đ thì bảng đối soát báo
 * "sao kê nói bạn chi 0đ quảng cáo, chênh lệch −64,5 triệu" — một báo động do THIẾU DỮ LIỆU, trình
 * bày y như một báo động do LỆCH SỔ. Đo trên production 10/09/2026: `bank_transactions` có 0 dòng,
 * nên toàn bộ ba dòng đối soát đang ở đúng tình trạng đó.
 */
export type BankReconLine = {
  key: string;
  label: string;
  /** Tiền thật trên sao kê. `null` = kỳ này chưa nhập sao kê nào. */
  bankAmount: number | null;
  erpAmount: number;
  erpLabel: string;
  /** `null` khi chưa có sao kê để so — không được hiểu là "khớp". */
  diff: number | null;
  note: string;
};

export async function bankReconciliation(period: Period): Promise<{ lines: BankReconLine[]; hasBankData: boolean }> {
  const db = await getDb();
  const inPeriod = and(...periodCond(b.txnAt, period.from, period.to));
  const sumOf = (groups: BankGroup[]) =>
    sql<number>`coalesce(-sum(${b.amount}) filter (where ${b.accountingGroup} in ${groups} and ${b.amount} < 0), 0)`;
  const [bankRow] = await db
    .select({
      ads: sumOf(["ADS_SPEND"]),
      purchase: sumOf(["PURCHASE"]),
      shipping: sumOf(["SHIPPING_FEE", "RETURN_FEE"]),
      payroll: sumOf(["PAYROLL_SALARY", "PAYROLL_COMMISSION"]),
      codIn: sql<number>`coalesce(sum(${b.amount}) filter (where ${b.accountingGroup} = 'COD_SETTLEMENT' and ${b.amount} > 0), 0)`,
      // Có dòng nào trong kỳ không — để phân biệt "chưa nhập" với "đã nhập và bằng 0".
      n: sql<number>`count(*)`,
    })
    .from(b)
    .where(inPeriod);
  const hasBankData = Number(bankRow?.n ?? 0) > 0;

  const [adsRow] = await db
    .select({ amount: sql<number>`coalesce(sum(${schema.adSpends.spend}), 0)` })
    .from(schema.adSpends)
    .where(and(eq(schema.adSpends.excluded, false), ...periodCond(schema.adSpends.spendDate, period.from, period.to)));
  const [purchaseRow] = await db
    .select({ amount: sql<number>`coalesce(sum(${schema.stockReceipts.totalCost}), 0)` })
    .from(schema.stockReceipts)
    .where(and(eq(schema.stockReceipts.kind, "RECEIPT"), ...periodCond(schema.stockReceipts.receivedAt, period.from, period.to)));
  const [codRow] = await db
    .select({ amount: sql<number>`coalesce(sum(${schema.codBatches.totalAmount}), 0)` })
    .from(schema.codBatches)
    .where(and(...periodCond(schema.codBatches.receivedAt, period.from, period.to)));

  // CƯỚC và LƯƠNG lấy thẳng từ Profit Engine, không tự cộng lại.
  //
  // Trước đây hai nhóm này được TÍNH ở trên rồi bỏ đó không dùng, nên sao kê có cước và lương mà
  // bảng đối soát vẫn im. Và tự cộng lại ở đây sẽ là nguồn thứ hai cho cùng một khoản — đúng thứ
  // `lib/constants/cost-sources.ts` sinh ra để cấm.
  const chiPhi = await getRecognizedCosts(period);

  const line = (key: string, label: string, bankAmount: number, erpAmount: number, erpLabel: string, note: string): BankReconLine => ({
    key,
    label,
    bankAmount: hasBankData ? bankAmount : null,
    erpAmount,
    erpLabel,
    diff: hasBankData ? bankAmount - erpAmount : null,
    note,
  });

  const lines = [
    line("ads", "Chi quảng cáo", Number(bankRow?.ads ?? 0), Number(adsRow?.amount ?? 0), "Tài khoản quảng cáo", "Meta thu thẻ trễ vài ngày so với ngày chạy nên lệch nhỏ là bình thường."),
    line("purchase", "Nhập hàng", Number(bankRow?.purchase ?? 0), Number(purchaseRow?.amount ?? 0), "Phiếu nhập kho", "Trả trước / trả sau cho xưởng khiến tiền và hàng rơi vào hai kỳ khác nhau."),
    line(
      "shipping",
      "Cước & phí hoàn",
      Number(bankRow?.shipping ?? 0),
      chiPhi.components.SHIPPING.amount + chiPhi.components.RETURN_COST.amount,
      "Vận đơn & bảng kê ĐVVC",
      "ĐVVC thường cấn trừ cước vào tiền COD trả về, nên phần cước có thể không hiện thành dòng chi riêng trên sao kê.",
    ),
    line(
      "payroll",
      "Lương & hoa hồng",
      Number(bankRow?.payroll ?? 0),
      chiPhi.components.SALARY.amount + chiPhi.components.COMMISSION.amount,
      "Bảng Lương",
      "Lương tháng này thường trả vào tháng sau; hoa hồng đi theo ĐƠN nên không rơi đều theo ngày.",
    ),
    line("cod", "Tiền COD về", Number(bankRow?.codIn ?? 0), Number(codRow?.amount ?? 0), "Bảng kê Viettel Post", "Lệch lớn nghĩa là có đợt nhận tiền chưa nhập bảng kê, hoặc dòng sao kê gán sai nhóm."),
  ];
  return { lines, hasBankData };
}

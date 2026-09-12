import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { BANK_GROUP_SPEC, isBankGroup, type BankGroup } from "@/lib/constants/bank";
import { CASHFLOW_SECTIONS, CASHFLOW_SECTION_LABEL, sectionOf, type CashflowSection } from "@/lib/constants/cashflow-sections";
import { balanceAsOf, type BalanceConfidence } from "@/lib/queries/cash-position";
import { previousPeriod, type Period } from "@/lib/search-params";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ BÁO CÁO DÒNG TIỀN THẬT (không phải dự phóng) ═══════════
 *
 * Phân biệt với `lib/queries/cashflow.ts`, và sự phân biệt này là cả lý do tệp này tồn tại:
 *
 *   · `cashflow.ts`          → DỰ PHÓNG. "7 ngày tới thu hơn chi bao nhiêu", suy từ nhịp chi.
 *   · `cashflow-statement.ts`→ ĐÃ XẢY RA. "Kỳ vừa rồi tiền thật đã vào ra thế nào", từ sao kê.
 *
 * Trộn hai thứ đó vào một màn hình là cách chắc chắn nhất để chủ shop đọc một con số ước lượng như
 * một con số chứng từ. Chúng nằm hai tab riêng, có nhãn riêng, và không bao giờ được cộng với nhau.
 *
 * ─── ĐẲNG THỨC PHẢI KHỚP, VÀ KHI KHÔNG KHỚP THÌ PHẢI NÓI ───
 *
 *   số dư đầu kỳ + tổng phát sinh trong kỳ = số dư cuối kỳ
 *
 * Đây không phải một phép trình bày cho đẹp mà là một PHÉP KIỂM. Đầu kỳ và cuối kỳ đọc từ
 * `balance_after` — số do NGÂN HÀNG ghi. Phần giữa là tổng `amount` của các dòng ERP có. Hai bên
 * lệch nhau nghĩa là sổ thiếu giao dịch (hoặc có dòng trùng), và mọi con số tiền của kỳ đó đều
 * đang sai. Lệch thì nêu ra ngay trên đầu báo cáo, không chôn vào một trang đối chiếu riêng.
 *
 * `null` ở đầu kỳ / cuối kỳ = CHƯA BIẾT (chưa có mốc số dư nào từ ngân hàng), không phải 0đ — nên
 * phép kiểm cũng trả `null` chứ không trả "khớp".
 */

export type CashflowGroupLine = {
  group: BankGroup;
  label: string;
  hint: string;
  moneyIn: number;
  moneyOut: number;
  net: number;
  count: number;
  /** Nhóm này đã có nguồn chuyên biệt trong lợi nhuận, dòng sao kê chỉ để đối chiếu. */
  reconcileOnly: boolean;
};

export type CashflowSectionBlock = {
  section: CashflowSection;
  label: string;
  moneyIn: number;
  moneyOut: number;
  net: number;
  count: number;
  lines: CashflowGroupLine[];
};

export type CashflowStatement = {
  period: Period;
  /** `null` = CHƯA BIẾT. Không thay bằng 0. */
  opening: number | null;
  closing: number | null;
  openingConfidence: BalanceConfidence;
  closingConfidence: BalanceConfidence;
  sections: CashflowSectionBlock[];
  /** Tiền vào / ra KINH DOANH (đã loại chuyển nội bộ) — hai con số dùng để so kỳ. */
  moneyIn: number;
  moneyOut: number;
  net: number;
  /** Tổng phát sinh của MỌI dòng, kể cả chuyển nội bộ — dùng cho phép kiểm đẳng thức. */
  movementAll: number;
  txnCount: number;
  /** Dòng chưa phân loại: vẫn là tiền thật, nhưng chưa biết thuộc việc gì. */
  unclassified: { count: number; moneyIn: number; moneyOut: number };
  /**
   * Đầu kỳ + phát sinh − cuối kỳ. `0` = sổ liền mạch. `null` = chưa đủ mốc số dư để kiểm.
   *
   * DẤU NÓI RA LOẠI HỎNG, và đó là nửa giá trị của con số này:
   *   · DƯƠNG — ERP cộng được nhiều hơn mức ngân hàng thật sự đổi ⇒ sổ THIẾU một khoản tiền RA,
   *     hoặc THỪA một dòng tiền vào (nhập sao kê hai lần).
   *   · ÂM    — chiều ngược lại: thiếu một khoản tiền VÀO, hoặc thừa một dòng tiền ra.
   *
   * Khác 0 nghĩa là con số nào của kỳ cũng đang sai theo đúng chừng đó.
   */
  integrityGap: number | null;
  /** Kỳ trước cùng độ dài — để so sánh, `null` khi kỳ không có biên (kỳ "Toàn bộ"). */
  previous: { moneyIn: number; moneyOut: number; net: number } | null;
  /** Sổ ngân hàng có dòng nào trong kỳ hay không — rỗng thì mọi số 0 ở trên là CHƯA NHẬP. */
  hasData: boolean;
};

export async function getCashflowStatement(period: Period): Promise<CashflowStatement> {
  return memo(`cashflow-statement:${periodKey(period)}`, 90_000, () => build(period));
}

async function build(period: Period): Promise<CashflowStatement> {
  const db = await getDb();
  const prev = previousPeriod(period);

  const doKy = async (from: Date | null, to: Date | null) => {
    const conds = [
      sql`(b.bank_account_id is null or a.status <> 'DISABLED')`,
      ...(from ? [sql`b.txn_at >= ${from}`] : []),
      ...(to ? [sql`b.txn_at <= ${to}`] : []),
    ];
    return rowsOf<{ accounting_group: string; money_in: number; money_out: number; n: number }>(
      await db.execute(sql`
        select b.accounting_group,
          coalesce(sum(b.amount) filter (where b.amount > 0), 0)  as money_in,
          coalesce(-sum(b.amount) filter (where b.amount < 0), 0) as money_out,
          count(*) as n
        from bank_transactions b
          left join bank_accounts a on a.id = b.bank_account_id
        where ${sql.join(conds, sql` and `)}
        group by b.accounting_group
      `),
    );
  };

  /*
    BỐN CÂU SONG SONG, KHÔNG PHẢI BẢY.

    Bể kết nối chỉ có 5 (xem `lib/queries/cost-engine.ts`). Hai phép gộp theo nhóm + hai mốc số dư
    là bốn — vừa đủ, và mỗi câu là một phép gộp ở CSDL chứ không kéo giao dịch về máy chủ rồi cộng
    bằng TypeScript. Trang này phải mở được khi sổ đã có hàng trăm nghìn dòng.
  */
  const [rows, prevRows, opening, closing] = await Promise.all([
    doKy(period.from, period.to),
    prev.from ? doKy(prev.from, prev.to) : Promise.resolve([]),
    // Đầu kỳ = số dư tại thời điểm ngay TRƯỚC ngày đầu kỳ.
    period.from ? balanceAsOf(new Date(period.from.getTime() - 1)) : Promise.resolve({ balance: null, confidence: "UNKNOWN" as BalanceConfidence, accounts: 0, knownAccounts: 0 }),
    balanceAsOf(period.to),
  ]);

  const n = (v: unknown) => Number(v ?? 0);
  const lines: CashflowGroupLine[] = rows.map((r) => {
    const group = (isBankGroup(r.accounting_group) ? r.accounting_group : "UNCLASSIFIED") as BankGroup;
    const spec = BANK_GROUP_SPEC[group];
    const moneyIn = n(r.money_in);
    const moneyOut = n(r.money_out);
    return {
      group,
      label: spec.label,
      hint: spec.hint,
      moneyIn,
      moneyOut,
      net: moneyIn - moneyOut,
      count: n(r.n),
      reconcileOnly: spec.linkTo !== null && ["ADS_SPEND", "PURCHASE", "SHIPPING_FEE", "RETURN_FEE"].includes(group),
    };
  });

  const sections: CashflowSectionBlock[] = CASHFLOW_SECTIONS.map((section) => {
    const own = lines.filter((l) => sectionOf(l.group) === section).sort((a, b) => b.moneyIn + b.moneyOut - (a.moneyIn + a.moneyOut));
    return {
      section,
      label: CASHFLOW_SECTION_LABEL[section],
      moneyIn: own.reduce((t, l) => t + l.moneyIn, 0),
      moneyOut: own.reduce((t, l) => t + l.moneyOut, 0),
      net: own.reduce((t, l) => t + l.net, 0),
      count: own.reduce((t, l) => t + l.count, 0),
      lines: own,
    };
  }).filter((s) => s.count > 0);

  /**
   * TIỀN VÀO / RA loại khoang EXCLUDED.
   *
   * Chuyển 10 triệu giữa hai tài khoản của mình mà tính vào thì "tiền vào" và "tiền ra" mỗi bên
   * cộng thêm 10 triệu: chênh lệch vẫn đúng nhưng cả hai con số tổng đều bị thổi phồng, và người
   * đọc tưởng shop quay vòng gấp đôi thực tế. Luật này đã có ở `isBusinessCash()`; ở đây dùng lại
   * đúng nó qua `sectionOf`.
   */
  const business = sections.filter((s) => s.section !== "EXCLUDED");
  const moneyIn = business.reduce((t, s) => t + s.moneyIn, 0);
  const moneyOut = business.reduce((t, s) => t + s.moneyOut, 0);
  const movementAll = lines.reduce((t, l) => t + l.net, 0);

  const prevBusiness = prevRows
    .map((r) => ({ group: (isBankGroup(r.accounting_group) ? r.accounting_group : "UNCLASSIFIED") as BankGroup, moneyIn: n(r.money_in), moneyOut: n(r.money_out) }))
    .filter((r) => sectionOf(r.group) !== "EXCLUDED");
  const prevIn = prevBusiness.reduce((t, r) => t + r.moneyIn, 0);
  const prevOut = prevBusiness.reduce((t, r) => t + r.moneyOut, 0);

  const unclassifiedLine = lines.find((l) => l.group === "UNCLASSIFIED");

  return {
    period,
    opening: opening.balance,
    closing: closing.balance,
    openingConfidence: opening.confidence,
    closingConfidence: closing.confidence,
    sections,
    moneyIn,
    moneyOut,
    net: moneyIn - moneyOut,
    movementAll,
    txnCount: lines.reduce((t, l) => t + l.count, 0),
    unclassified: {
      count: unclassifiedLine?.count ?? 0,
      moneyIn: unclassifiedLine?.moneyIn ?? 0,
      moneyOut: unclassifiedLine?.moneyOut ?? 0,
    },
    /*
      Kỳ "Toàn bộ" KHÔNG có đầu kỳ để so: `period.from = null` nên `opening` là CHƯA BIẾT theo định
      nghĩa, không phải 0đ. Trả `null` thay vì tính ra một khoảng lệch bằng chính số dư cuối kỳ —
      con số đó sẽ trông y như một sổ hỏng nặng.
      Điều kiện là `period.from`, KHÔNG phải `opening !== null`: một kỳ có đầu kỳ thật mà chưa có
      mốc số dư nào trước đó cũng là chưa kiểm được, và `opening === null` bắt đúng trường hợp đó.
    */
    integrityGap: period.from && opening.balance !== null && closing.balance !== null ? opening.balance + movementAll - closing.balance : null,
    previous: prev.from ? { moneyIn: prevIn, moneyOut: prevOut, net: prevIn - prevOut } : null,
    hasData: lines.length > 0,
  };
}

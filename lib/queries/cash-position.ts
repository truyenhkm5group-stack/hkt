import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import { BANK_ACCOUNT_STATUS_LABEL, maskAccountNumber, type BankAccountStatus } from "@/lib/constants/bank";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ TIỀN ĐANG CÓ, VÀ ĐANG NẰM Ở TÀI KHOẢN NÀO ═══════════
 *
 * Hai câu hỏi đầu tiên của chủ shop mỗi sáng, và cho tới nay ERP KHÔNG trả lời được câu nào.
 * `lib/queries/cashflow.ts` nói thẳng điều đó: "ERP KHÔNG có số dư ngân hàng". Câu đó ĐÚNG vào lúc
 * viết, và nay đã lỗi thời.
 *
 * `bank_transactions.balance_after` — số dư luỹ kế sau mỗi giao dịch, do CHÍNH NGÂN HÀNG ghi — đã
 * được `lib/integrations/bank/sepay-ingest.ts` lưu từ lâu. Không một truy vấn hay màn hình nào đọc
 * nó. Cả sổ ngân hàng chỉ cộng `amount` để ra "tiền vào / tiền ra", nên trả lời được "kỳ này quay
 * vòng bao nhiêu" mà vẫn không trả lời được "còn bao nhiêu".
 *
 * ─── BA MỨC CHẮC CHẮN, KHÔNG TRỘN LẪN ───
 *
 *  · `CONFIRMED` — giao dịch gần nhất của tài khoản CÓ `balance_after`. Đây là số dư do ngân hàng
 *    ghi, không phải do ERP cộng. Chắc chắn nhất.
 *  · `DERIVED`   — mốc `balance_after` gần nhất CỘNG các giao dịch phát sinh sau đó. Đúng KHI VÀ
 *    CHỈ KHI không thiếu giao dịch nào ở giữa — nên mức này luôn đi kèm số giao dịch đã cộng thêm
 *    để người đọc tự định giá độ tin.
 *  · `UNKNOWN`   — tài khoản CHƯA BAO GIỜ có `balance_after` (sao kê tải tay đời cũ). KHÔNG hiện
 *    số. Không suy ra bằng cách cộng dồn từ 0: cộng từ 0 nghĩa là giả định tài khoản mở ra với 0đ
 *    và ERP thấy đủ mọi giao dịch kể từ đó — hai giả định đều sai, và cái giá là một con số "số dư"
 *    trông rất thuyết phục mà lệch hàng trăm triệu.
 *
 * TỔNG TIỀN vì thế là tổng của phần BIẾT ĐƯỢC, kèm số tài khoản chưa biết. Một con số kèm mức độ
 * đầy đủ (AGENTS.md mục 8.11), không phải một con số trần.
 *
 * ─── VÌ SAO ĐO ĐƯỢC ĐỘ TIN: BẤT BIẾN CHUỖI SỐ DƯ ───
 *
 * Xếp giao dịch của một tài khoản theo thời gian thì `balance_after[i] − balance_after[i−1]` PHẢI
 * bằng `amount[i]`. `db/schema.ts` gọi đây là "mỏ neo đối chiếu mạnh nhất của cả sổ" và cũng chưa
 * có ai kiểm. Chuỗi đứt = thiếu giao dịch (tiền đã đi mà sổ không thấy); bước không khớp = trùng
 * giao dịch. Cả hai đều làm mọi con số tiền phía sau sai, nên phải nêu THẲNG cạnh số dư chứ không
 * phải chôn trong một trang đối chiếu riêng.
 */

/** Mức chắc chắn của một số dư. Thứ tự có ý nghĩa: chắc chắn giảm dần. */
export type BalanceConfidence = "CONFIRMED" | "DERIVED" | "UNKNOWN";

export const BALANCE_CONFIDENCE_LABEL: Record<BalanceConfidence, string> = {
  CONFIRMED: "Ngân hàng ghi",
  DERIVED: "ERP cộng thêm",
  UNKNOWN: "Chưa biết",
};

export const BALANCE_CONFIDENCE_HINT: Record<BalanceConfidence, string> = {
  CONFIRMED: "Số dư do chính ngân hàng ghi trên giao dịch gần nhất. Không qua phép cộng nào của ERP.",
  DERIVED: "Mốc số dư ngân hàng gần nhất cộng các giao dịch phát sinh sau đó. Đúng nếu không thiếu giao dịch nào ở giữa.",
  UNKNOWN: "Tài khoản chưa bao giờ có số dư từ ngân hàng. KHÔNG suy ra bằng cách cộng dồn từ 0 — cộng từ 0 là giả định tài khoản mở với 0đ và ERP thấy đủ mọi giao dịch.",
};

export const BALANCE_CONFIDENCE_TONE: Record<BalanceConfidence, string> = {
  CONFIRMED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  DERIVED: "bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  UNKNOWN: "bg-muted text-muted-foreground",
};

export type AccountBalance = {
  accountId: string;
  label: string;
  gateway: string;
  /** Đã che, chỉ còn bốn số cuối. */
  accountMasked: string;
  /** Tài khoản ảo (VA) của SePay — '' là tài khoản gốc. */
  subAccount: string;
  status: BankAccountStatus;
  statusLabel: string;
  currency: string;
  /** `null` = CHƯA BIẾT. Không bao giờ thay bằng 0. */
  balance: number | null;
  confidence: BalanceConfidence;
  /** Mốc của số dư ngân hàng gần nhất — `null` khi chưa bao giờ có. */
  balanceAt: Date | null;
  /** Số giao dịch phát sinh SAU mốc đó mà ERP đã cộng thêm (chỉ > 0 khi `DERIVED`). */
  derivedFrom: number;
  /** Mốc giao dịch gần nhất của tài khoản, bất kể có số dư hay không. */
  lastTxnAt: Date | null;
  txnCount: number;
  unclassified: number;
  /** Số chỗ chuỗi số dư không khớp — mỗi chỗ là một dấu hiệu thiếu hoặc trùng giao dịch. */
  chainBreaks: number;
};

export type CashPosition = {
  /** Tổng số dư của phần BIẾT ĐƯỢC. `null` khi không tài khoản nào biết được số dư. */
  total: number | null;
  /** Số tài khoản đã tính vào tổng / chưa biết số dư. */
  knownAccounts: number;
  unknownAccounts: number;
  /** Tổng có đầy đủ hay không — `false` thì con số là CẬN DƯỚI, phải nói ra. */
  complete: boolean;
  accounts: AccountBalance[];
  /** Tài khoản chờ người xác nhận "đúng là tài khoản của shop". */
  unconfirmedAccounts: number;
  /** Tổng số chỗ chuỗi số dư đứt trên toàn sổ. */
  chainBreaks: number;
  /** Mốc số dư mới nhất trong các tài khoản biết được — "số này cũ tới mức nào". */
  freshestAt: Date | null;
  /** Mốc số dư CŨ NHẤT trong các tài khoản đã tính vào tổng — tổng chỉ đáng tin tới mốc này. */
  stalestAt: Date | null;
};

/**
 * Số dư từng tài khoản, tính TRONG CSDL bằng một câu lệnh.
 *
 * CỐ Ý không lặp từng tài khoản rồi hỏi từng câu: số tài khoản thì ít, nhưng `bank_transactions`
 * lớn dần, và bể kết nối chỉ có 5 — một vòng lặp N+1 ở đây là cách trang Tổng quan tài chính tự
 * lấy hết bể của chính nó (xem chú thích `chayKhongJit` trong `lib/queries/cost-engine.ts`).
 *
 * `neo` = giao dịch gần nhất CÓ `balance_after` của mỗi tài khoản. `sau_neo` = tổng phát sinh sau
 * mốc đó. Xếp theo `(txn_at, id)` chứ không chỉ `txn_at`: sao kê ghi nhiều giao dịch cùng một dấu
 * thời gian là chuyện thường, và thứ tự không xác định sẽ làm số dư nhảy qua nhảy lại giữa hai lần
 * mở trang.
 */
export async function getCashPosition(): Promise<CashPosition> {
  return memo("cash-position", 60_000, build);
}

async function build(): Promise<CashPosition> {
  const db = await getDb();

  const rows = rowsOf<{
    id: string;
    label: string;
    gateway: string;
    account_number: string;
    sub_account: string;
    status: string;
    currency: string;
    neo_balance: number | null;
    neo_at: Date | null;
    sau_neo_tong: number | null;
    sau_neo_so: number | null;
    last_txn_at: Date | null;
    txn_count: number;
    unclassified: number;
    chain_breaks: number;
  }>(
    await db.execute(sql`
      with xep as (
        select
          bank_account_id,
          txn_at,
          id,
          amount,
          balance_after,
          accounting_group,
          row_number() over (partition by bank_account_id order by txn_at desc, id desc) as mdt,
          -- Số dư của giao dịch CÓ số dư liền trước, để kiểm bất biến chuỗi.
          lag(balance_after) over (
            partition by bank_account_id order by txn_at asc, id asc
          ) as balance_truoc
        from bank_transactions
        where bank_account_id is not null
      ),
      -- Mốc neo: giao dịch MỚI NHẤT còn giữ số dư của ngân hàng.
      neo as (
        select distinct on (bank_account_id) bank_account_id, balance_after, txn_at, id
        from xep
        where balance_after is not null
        order by bank_account_id, txn_at desc, id desc
      ),
      goc as (
        select
          x.bank_account_id,
          count(*) as txn_count,
          count(*) filter (where x.accounting_group = 'UNCLASSIFIED') as unclassified,
          max(x.txn_at) as last_txn_at,
          -- Chuỗi đứt: hai giao dịch liền nhau ĐỀU có số dư mà bước nhảy không bằng số tiền.
          count(*) filter (
            where x.balance_after is not null and x.balance_truoc is not null
              and x.balance_after - x.balance_truoc <> x.amount
          ) as chain_breaks
        from xep x
        group by x.bank_account_id
      ),
      -- Phát sinh SAU mốc neo, để suy ra số dư hiện tại khi giao dịch mới nhất thiếu số dư.
      sau_neo as (
        select x.bank_account_id, coalesce(sum(x.amount), 0) as tong, count(*) as so
        from xep x
        join neo n on n.bank_account_id = x.bank_account_id
        where (x.txn_at, x.id) > (n.txn_at, n.id)
        group by x.bank_account_id
      )
      select
        a.id, a.label, a.gateway, a.account_number, a.sub_account, a.status, a.currency,
        n.balance_after as neo_balance,
        n.txn_at        as neo_at,
        s.tong          as sau_neo_tong,
        s.so            as sau_neo_so,
        g.last_txn_at, coalesce(g.txn_count, 0) as txn_count,
        coalesce(g.unclassified, 0) as unclassified,
        coalesce(g.chain_breaks, 0) as chain_breaks
      from bank_accounts a
        left join goc g     on g.bank_account_id = a.id
        left join neo n     on n.bank_account_id = a.id
        left join sau_neo s on s.bank_account_id = a.id
      order by
        case when a.status = 'UNCONFIRMED' then 0 when a.status = 'ACTIVE' then 1 else 2 end,
        a.gateway, a.account_number, a.sub_account
    `),
  );

  const n = (v: unknown) => Number(v ?? 0);
  const accounts: AccountBalance[] = rows.map((r) => {
    const neoBalance = r.neo_balance === null || r.neo_balance === undefined ? null : n(r.neo_balance);
    const sauNeoSo = n(r.sau_neo_so);
    /**
     * Chưa bao giờ có số dư ngân hàng ⇒ CHƯA BIẾT, và dừng ở đó.
     *
     * Đây là chỗ dễ sai nhất của cả tệp: cộng `sum(amount)` từ 0 cho ra một con số trông y như số
     * dư thật. Nó chỉ đúng nếu tài khoản mở ra với 0đ VÀ ERP thấy đủ mọi giao dịch kể từ đó — với
     * một sổ nhập từ sao kê tải tay thì cả hai đều sai.
     */
    const confidence: BalanceConfidence = neoBalance === null ? "UNKNOWN" : sauNeoSo > 0 ? "DERIVED" : "CONFIRMED";
    const balance = neoBalance === null ? null : neoBalance + n(r.sau_neo_tong);
    const status = (r.status as BankAccountStatus) ?? "UNCONFIRMED";
    return {
      accountId: r.id,
      label: r.label?.trim() || `${r.gateway || "Ngân hàng"} ${maskAccountNumber(r.account_number)}`,
      gateway: r.gateway,
      accountMasked: maskAccountNumber(r.account_number),
      subAccount: r.sub_account ?? "",
      status,
      statusLabel: BANK_ACCOUNT_STATUS_LABEL[status] ?? status,
      currency: r.currency || "VND",
      balance,
      confidence,
      balanceAt: r.neo_at ? new Date(r.neo_at) : null,
      derivedFrom: confidence === "DERIVED" ? sauNeoSo : 0,
      lastTxnAt: r.last_txn_at ? new Date(r.last_txn_at) : null,
      txnCount: n(r.txn_count),
      unclassified: n(r.unclassified),
      chainBreaks: n(r.chain_breaks),
    };
  });

  /**
   * TÀI KHOẢN NGỪNG DÙNG KHÔNG VÀO TỔNG, nhưng vẫn hiện trong danh sách.
   *
   * `DISABLED` nghĩa là thôi dùng để nhận tiền, không nghĩa là tài khoản đã rỗng. Cộng nó vào
   * "tiền hiện có" thì chủ shop tưởng mình còn tiền ở chỗ đã đóng; ẩn hẳn nó đi thì tiền biến mất
   * khỏi màn hình mà không ai biết vì sao. Nên: ngoài tổng, trong danh sách.
   */
  const inTotal = accounts.filter((a) => a.status !== "DISABLED");
  const known = inTotal.filter((a) => a.balance !== null);
  const withBalanceAt = known.filter((a): a is AccountBalance & { balanceAt: Date } => a.balanceAt !== null);
  const moc = withBalanceAt.map((a) => a.balanceAt.getTime());

  return {
    total: known.length ? known.reduce((t, a) => t + (a.balance ?? 0), 0) : null,
    knownAccounts: known.length,
    unknownAccounts: inTotal.length - known.length,
    complete: inTotal.length > 0 && known.length === inTotal.length,
    accounts,
    unconfirmedAccounts: accounts.filter((a) => a.status === "UNCONFIRMED").length,
    chainBreaks: accounts.reduce((t, a) => t + a.chainBreaks, 0),
    freshestAt: moc.length ? new Date(Math.max(...moc)) : null,
    stalestAt: moc.length ? new Date(Math.min(...moc)) : null,
  };
}

/**
 * SỐ DƯ TẠI MỘT MỐC THỜI GIAN — để báo cáo dòng tiền có số dư ĐẦU KỲ và CUỐI KỲ thật.
 *
 * Một báo cáo dòng tiền không có số dư đầu / cuối kỳ thì chỉ là một phép trừ hai con số tổng: nó
 * nói kỳ này thu hơn chi bao nhiêu, không nói shop còn lại bao nhiêu. Đầu kỳ = số dư của giao dịch
 * cuối cùng TRƯỚC mốc; suy theo đúng ba mức chắc chắn ở trên.
 *
 * `null` = CHƯA BIẾT. Với `to = null` (kỳ "Toàn bộ") thì đây chính là số dư hiện tại.
 */
export async function balanceAsOf(at: Date | null): Promise<{ balance: number | null; confidence: BalanceConfidence; accounts: number; knownAccounts: number }> {
  const db = await getDb();
  const moc = at ? sql`and b.txn_at <= ${at}` : sql``;
  const rows = rowsOf<{ balance: number | null; accounts: number; known: number; derived: number }>(
    await db.execute(sql`
      with neo as (
        select distinct on (b.bank_account_id)
          b.bank_account_id, b.balance_after, b.txn_at, b.id
        from bank_transactions b
          join bank_accounts a on a.id = b.bank_account_id
        where b.balance_after is not null and a.status <> 'DISABLED' ${moc}
        order by b.bank_account_id, b.txn_at desc, b.id desc
      ),
      sau_neo as (
        select n.bank_account_id, coalesce(sum(b.amount), 0) as tong, count(*) as so
        from bank_transactions b
          join neo n on n.bank_account_id = b.bank_account_id
        where (b.txn_at, b.id) > (n.txn_at, n.id) ${moc}
        group by n.bank_account_id
      )
      select
        coalesce(sum(n.balance_after + coalesce(s.tong, 0)), 0) as balance,
        (select count(*) from bank_accounts where status <> 'DISABLED') as accounts,
        count(*) as known,
        count(*) filter (where coalesce(s.so, 0) > 0) as derived
      from neo n left join sau_neo s on s.bank_account_id = n.bank_account_id
    `),
  );
  const r = rows[0];
  const known = Number(r?.known ?? 0);
  const accounts = Number(r?.accounts ?? 0);
  return {
    // Không tài khoản nào có mốc số dư trước thời điểm này ⇒ CHƯA BIẾT, không phải 0đ.
    balance: known ? Number(r?.balance ?? 0) : null,
    confidence: known === 0 ? "UNKNOWN" : Number(r?.derived ?? 0) > 0 ? "DERIVED" : "CONFIRMED",
    accounts,
    knownAccounts: known,
  };
}

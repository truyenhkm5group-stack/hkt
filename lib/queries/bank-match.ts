import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { BANK_LINK_TYPE_LABEL } from "@/lib/constants/bank";
import {
  MATCH_CONFIDENCE_LABEL,
  matchTransaction,
  type BankTxnForMatch,
  type MatchCandidate,
  type MatchConfidence,
  type MatchTargetType,
} from "@/lib/integrations/bank/match";

/**
 * ═══════ GỢI Ý ĐỐI KHỚP: NẠP ỨNG VIÊN, CHẠY MÁY ĐỐI KHỚP THUẦN ═══════
 *
 * Tệp này CHỈ làm hai việc: lấy dữ liệu, và đưa cho `matchTransaction` quyết định. Mọi luật đối
 * khớp nằm ở `lib/integrations/bank/match.ts` — một hàm thuần, kiểm thử được từng luật mà không cần
 * dựng cơ sở dữ liệu.
 *
 * Tách như vậy không phải để cho đẹp: luật đối khớp là chỗ dễ nới nhất khi ai đó muốn "tăng tỷ lệ
 * khớp". Để nó ở một hàm thuần có kiểm thử riêng thì mỗi lần nới đều phải sửa một bài kiểm nói rõ
 * vì sao luật cũ tồn tại.
 *
 * PHẠM VI ỨNG VIÊN: chỉ nạp chứng từ trong cửa sổ ±30 ngày quanh giao dịch. Rộng hơn thì số ứng
 * viên trùng tiền tăng vọt và mọi thứ thành NHẬP NHẰNG; hẹp hơn thì bỏ sót khoản trả trễ.
 */

const CUA_SO_NGAY = 30;

export type Suggestion = {
  txnId: string;
  txnAt: Date;
  amount: number;
  description: string;
  counterparty: string;
  accountingGroup: string;
  confidence: MatchConfidence;
  confidenceLabel: string;
  target: { type: MatchTargetType; typeLabel: string; id: string; label: string; amount: number; at: Date } | null;
  others: { type: MatchTargetType; id: string; label: string; amount: number; at: Date }[];
  reasons: string[];
};

export type MatchOverview = {
  suggestions: Suggestion[];
  /** Đếm theo mức tin cậy — người dùng cần biết còn bao nhiêu việc thuộc loại nào. */
  counts: Record<MatchConfidence, number>;
  /** Giao dịch đã nối chứng từ. */
  reconciled: number;
  /** Tổng giao dịch trong sổ. 0 nghĩa là CHƯA NHẬP sao kê, không phải "không có gì để đối khớp". */
  total: number;
};

function rowsOf<T>(r: unknown): T[] {
  return (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as T[];
}

export async function getMatchOverview(limit = 100): Promise<MatchOverview> {
  const db = await getDb();

  const [dem] = rowsOf<{ total: number; reconciled: number }>(
    await db.execute(sql`select count(*)::int as total, count(*) filter (where linked_type <> '')::int as reconciled from bank_transactions`),
  );
  const total = Number(dem?.total ?? 0);
  const reconciled = Number(dem?.reconciled ?? 0);
  const counts: Record<MatchConfidence, number> = { EXACT: 0, HIGH_CONFIDENCE: 0, AMBIGUOUS: 0, UNMATCHED: 0 };
  if (!total) return { suggestions: [], counts, reconciled: 0, total: 0 };

  // Giao dịch CHƯA nối chứng từ — đã nối rồi thì không cần gợi ý nữa.
  const txns = rowsOf<{ id: string; txn_at: string; amount: string | number; description: string; counterparty: string; accounting_group: string }>(
    await db.execute(sql`
      select id, txn_at, amount, coalesce(description, '') as description, coalesce(counterparty, '') as counterparty, accounting_group
      from bank_transactions
      where linked_type = ''
      order by txn_at desc
      limit ${limit}
    `),
  );
  if (!txns.length) return { suggestions: [], counts, reconciled, total };

  const moc = txns.map((t) => new Date(t.txn_at).getTime());
  const tuNgay = new Date(Math.min(...moc) - CUA_SO_NGAY * 86_400_000);
  const denNgay = new Date(Math.max(...moc) + CUA_SO_NGAY * 86_400_000);

  /**
   * Ứng viên từ BỐN nguồn chứng từ, đúng bốn loại `bank_transactions.linked_type` cho phép.
   *
   * `identifiers` là những mã CÓ THỂ xuất hiện trong nội dung chuyển khoản. Máy đối khớp chỉ nhận mã
   * dài từ 5 ký tự, nên mã ngắn đưa vào cũng vô hại.
   */
  const [codBatches, expenses, receipts, adSpends] = await Promise.all([
    db.execute(sql`
      select id, total_amount as amount, received_at as at, coalesce(nullif(reference, ''), id) as code,
             coalesce(nullif(reference, ''), 'Đợt COD') as label
      from cod_batches where received_at between ${tuNgay} and ${denNgay}
    `),
    db.execute(sql`
      select id, amount, occurred_at as at, coalesce(nullif(reference, ''), id) as code, coalesce(description, '') as label
      from expenses where occurred_at between ${tuNgay} and ${denNgay}
    `),
    db.execute(sql`
      select id, total_cost as amount, received_at as at, coalesce(nullif(reference, ''), id) as code,
             coalesce(nullif(supplier, ''), coalesce(reference, '')) as label
      from stock_receipts where kind = 'RECEIPT' and received_at between ${tuNgay} and ${denNgay}
    `),
    db.execute(sql`
      select id::text as id, spend as amount, spend_date as at, id::text as code,
             coalesce(nullif(campaign, ''), nullif(account_name, ''), 'Chi tiêu quảng cáo') as label
      from ad_spends where excluded = false and spend_date between ${tuNgay} and ${denNgay}
    `),
  ]);

  const gom = (r: unknown, type: MatchTargetType): MatchCandidate[] =>
    rowsOf<{ id: string; amount: string | number; at: string; code: string; label: string }>(r).map((x) => ({
      type,
      id: String(x.id),
      amount: Number(x.amount ?? 0),
      at: new Date(x.at),
      identifiers: [String(x.code ?? "")].filter(Boolean),
      label: String(x.label || x.code || x.id),
    }));

  const theoLoai: Record<MatchTargetType, MatchCandidate[]> = {
    COD_BATCH: gom(codBatches, "COD_BATCH"),
    EXPENSE: gom(expenses, "EXPENSE"),
    STOCK_RECEIPT: gom(receipts, "STOCK_RECEIPT"),
    AD_SPEND: gom(adSpends, "AD_SPEND"),
  };

  const suggestions: Suggestion[] = txns.map((t) => {
    const amount = Number(t.amount ?? 0);
    const txn: BankTxnForMatch = {
      id: t.id,
      amount,
      txnAt: new Date(t.txn_at),
      description: t.description,
      counterparty: t.counterparty,
    };
    /**
     * TIỀN VÀO chỉ đối với bảng kê COD; TIỀN RA đối với ba nguồn chi.
     *
     * Không phải tối ưu tốc độ mà là tránh khớp bậy: một khoản chi 5 triệu và một đợt COD về 5 triệu
     * trùng số tiền là chuyện hoàn toàn bình thường, và nối nhầm hai chiều tiền là sai nặng nhất.
     */
    const ungVien = amount > 0 ? theoLoai.COD_BATCH : [...theoLoai.EXPENSE, ...theoLoai.STOCK_RECEIPT, ...theoLoai.AD_SPEND];
    const kq = matchTransaction(txn, ungVien);
    counts[kq.confidence] += 1;
    return {
      txnId: t.id,
      txnAt: txn.txnAt,
      amount,
      description: t.description,
      counterparty: t.counterparty,
      accountingGroup: t.accounting_group,
      confidence: kq.confidence,
      confidenceLabel: MATCH_CONFIDENCE_LABEL[kq.confidence],
      target: kq.target
        ? { type: kq.target.type, typeLabel: BANK_LINK_TYPE_LABEL[kq.target.type], id: kq.target.id, label: kq.target.label, amount: kq.target.amount, at: kq.target.at }
        : null,
      others: kq.others.map((c) => ({ type: c.type, id: c.id, label: c.label, amount: c.amount, at: c.at })),
      reasons: kq.reasons,
    };
  });

  // Việc cần người quyết đứng trước; đã chắc chắn thì để sau vì nó tự xử lý được.
  const uuTien: Record<MatchConfidence, number> = { AMBIGUOUS: 0, EXACT: 1, HIGH_CONFIDENCE: 2, UNMATCHED: 3 };
  suggestions.sort((a, b) => uuTien[a.confidence] - uuTien[b.confidence] || b.txnAt.getTime() - a.txnAt.getTime());

  return { suggestions, counts, reconciled, total };
}

/**
 * ═══════════ GHI GIAO DỊCH SEPAY VÀO SỔ NGÂN HÀNG CANONICAL ═══════════
 *
 * KHÔNG có sổ thứ hai. Webhook ghi vào đúng bảng `bank_transactions` mà sao kê tải tay vẫn ghi, qua
 * đúng khoá tự nhiên `bank_ref` mà luồng nhập file vẫn dùng. Nhờ vậy một giao dịch đã nhập bằng file
 * rồi mới nhận webhook (hoặc ngược lại) vẫn chỉ là MỘT dòng.
 *
 * ─── THỨ BẬC THẨM QUYỀN ───
 *
 *   SAO KÊ FILE  >  API ĐỐI CHIẾU  >  WEBHOOK
 *   (chứng từ)      (truy vấn)        (thông báo)
 *
 * Sao kê là chứng từ ngân hàng phát hành; webhook chỉ là thông báo và có thể thiếu, trễ hoặc cắt
 * gọn. Nên webhook được phép TẠO dòng mới, nhưng gặp dòng đã có thì chỉ BỔ SUNG chỗ còn trống —
 * không sửa số tiền, không sửa mốc, và tuyệt đối không chạm nhãn người dùng đã gán.
 *
 * ─── RANH GIỚI TIỀN ↔ CHI PHÍ ───
 *
 * Dòng mới luôn vào với `accounting_group = 'UNCLASSIFIED'`. Sổ ngân hàng là SỰ THẬT VỀ TIỀN; việc
 * quy nó thành doanh thu / quảng cáo / lương đi qua quy tắc và bảng thẩm quyền chi phí sẵn có
 * (`lib/constants/cost-authority.ts`). Webhook không được tự sinh chi phí — xem `lib/constants/bank.ts`.
 */
import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { bankMatchKey, normalizeBankRef, sepayBankRef, type SepayTransaction } from "@/lib/integrations/bank/sepay";

const b = schema.bankTransactions;
const acc = schema.bankAccounts;

export const SEPAY_PROVIDER = "SEPAY";

/** Một mục provenance: đường vào nào, lúc nào, mang theo mã gì. */
export type SeenSource = { source: string; provider: string; at: string; ref: string };

export type IngestOutcome = {
  transactionId: string;
  /** Dòng canonical vừa được TẠO trong lượt này. */
  created: boolean;
  /**
   * Gói tin nói về một giao dịch ERP ĐÃ CÓ — do gửi lại, hoặc do sao kê đã nhập trước.
   * Không phải lỗi: trả thành công idempotently.
   */
  duplicate: boolean;
  /** Tài khoản ngân hàng lần đầu xuất hiện ⇒ ERP tự khai và chờ người đặt tên. */
  accountUnmapped: boolean;
  /** Có dòng khác cùng tài khoản + số tiền + phút nhưng KHÁC mã giao dịch. Nêu ra, không tự gộp. */
  duplicateSuspect: boolean;
  /** Mâu thuẫn giữa hai nguồn trên cùng một dòng (số tiền / mốc / mã nhà cung cấp khác nhau). */
  conflict: string | null;
  bankAccountId: string;
  bankRef: string;
};

/**
 * Tìm hoặc tự khai tài khoản ngân hàng.
 *
 * TỰ KHAI, KHÔNG CHẶN. Gói tin đã qua HMAC nghĩa là nó đến từ chính tài khoản SePay của shop, nên
 * tài khoản mà nó nhắc tới là tài khoản có thật của shop. Chặn tiền lại để chờ người "map" thì sổ
 * thiếu tiền mà không ai biết; tự khai rồi gắn cờ `UNCONFIRMED` thì tiền đủ và việc còn lại chỉ là
 * đặt tên. Đây là lý do trạng thái mặc định là UNCONFIRMED chứ không phải ACTIVE.
 */
export async function resolveBankAccount(
  db: Db,
  input: { provider: string; gateway: string; accountNumber: string; subAccount: string; seenAt: Date },
): Promise<{ id: string; unmapped: boolean }> {
  const key = {
    provider: input.provider,
    gateway: input.gateway,
    accountNumber: input.accountNumber,
    subAccount: input.subAccount,
  };
  const existing = await db
    .select({ id: acc.id, status: acc.status })
    .from(acc)
    .where(
      and(
        eq(acc.provider, key.provider),
        eq(acc.gateway, key.gateway),
        eq(acc.accountNumber, key.accountNumber),
        eq(acc.subAccount, key.subAccount),
      ),
    )
    .limit(1);

  if (existing.length) {
    await db.update(acc).set({ lastSeenAt: input.seenAt }).where(eq(acc.id, existing[0].id));
    return { id: existing[0].id, unmapped: existing[0].status === "UNCONFIRMED" };
  }

  const label = [key.gateway || "Ngân hàng", key.accountNumber, key.subAccount && `· VA ${key.subAccount}`]
    .filter(Boolean)
    .join(" ");
  const [row] = await db
    .insert(acc)
    .values({ ...key, label, status: "UNCONFIRMED", lastSeenAt: input.seenAt })
    .onConflictDoUpdate({
      target: [acc.provider, acc.gateway, acc.accountNumber, acc.subAccount],
      set: { lastSeenAt: input.seenAt },
    })
    .returning({ id: acc.id, status: acc.status });
  return { id: row.id, unmapped: row.status === "UNCONFIRMED" };
}

function seenEntry(source: string, provider: string, at: Date, ref: string): SeenSource {
  return { source, provider, at: at.toISOString(), ref };
}

/**
 * Ghi một giao dịch SePay vào sổ.
 *
 * CHỐNG TRÙNG BA TẦNG, và tầng quyết định nằm ở CSDL chứ không ở đây:
 *
 *  1. `bank_txn_provider_uq` — UNIQUE(provider, provider_txn_id). Hai gói tin cùng `id` tới CÙNG
 *     LÚC vẫn không thể đẻ hai dòng; một cái thắng, cái kia thấy xung đột. Mã ứng dụng tự kiểm tra
 *     "đã có chưa" rồi mới ghi thì luôn thua điều kiện tranh chấp.
 *  2. `bank_txn_ref_idx` — UNIQUE(bank_ref). Đây là chỗ webhook hội tụ với sao kê đã nhập bằng file:
 *     cùng mã bút toán ngân hàng ⇒ cùng một dòng.
 *  3. `match_key` — KHÔNG unique, chỉ để PHÁT HIỆN nghi ngờ trùng rồi báo người xem.
 */
export async function ingestSepayTransaction(
  db: Db,
  txn: SepayTransaction,
  options: { source?: "WEBHOOK" | "API"; now?: Date } = {},
): Promise<IngestOutcome> {
  const source = options.source ?? "WEBHOOK";
  const now = options.now ?? new Date();
  const bankRef = sepayBankRef(txn);
  const matchKey = bankMatchKey({ amount: txn.amount, txnAt: txn.txnAt });

  const account = await resolveBankAccount(db, {
    provider: SEPAY_PROVIDER,
    gateway: txn.gateway,
    accountNumber: txn.accountNumber,
    subAccount: txn.subAccount,
    seenAt: now,
  });

  // Gói tin gửi lại: dòng đã mang đúng mã SePay này. Không ghi gì thêm, trả thành công ngay.
  const already = await db
    .select({ id: b.id, bankRef: b.bankRef })
    .from(b)
    .where(and(eq(b.provider, SEPAY_PROVIDER), eq(b.providerTxnId, txn.providerTxnId)))
    .limit(1);
  if (already.length) {
    return {
      transactionId: already[0].id,
      created: false,
      duplicate: true,
      accountUnmapped: account.unmapped,
      duplicateSuspect: false,
      conflict: null,
      bankAccountId: account.id,
      bankRef: already[0].bankRef,
    };
  }

  const entry = seenEntry(source, SEPAY_PROVIDER, now, txn.providerTxnId);
  const description = txn.content.replace(/\s+/g, " ").trim().slice(0, 1000);

  /**
   * Một câu lệnh làm cả hai việc: tạo mới, hoặc bổ sung lên dòng sao kê đã có.
   *
   * Mệnh đề `set` CỐ Ý HẸP. `amount`, `txn_at`, `accounting_group`, `note`, `classified_by`,
   * `rule_id`, `linked_*` KHÔNG có mặt ở đây — nên kể cả khi mã phía trên sai, webhook cũng không
   * thể sửa số tiền hay xoá phân loại người dùng đã làm. Đây là lớp khoá cấu trúc, không phải kỷ luật.
   *
   * `xmax = 0` là cách Postgres cho biết hàng vừa được CHÈN (chứ không phải cập nhật).
   */
  const [row] = await db
    .insert(b)
    .values({
      txnAt: txn.txnAt,
      amount: txn.amount,
      description,
      counterparty: "",
      bankRef,
      account: txn.accountNumber,
      bankAccountId: account.id,
      categoryCode: "",
      source,
      provider: SEPAY_PROVIDER,
      providerTxnId: txn.providerTxnId,
      lastSeenSource: source,
      seenSources: [entry],
      balanceAfter: txn.balanceAfter,
      matchKey,
    })
    .onConflictDoUpdate({
      target: b.bankRef,
      set: {
        // Người đầu tiên thắng: sao kê đã ghi mô tả thì webhook không đè lên.
        description: sql`case when ${b.description} = '' then excluded.description else ${b.description} end`,
        account: sql`case when ${b.account} = '' then excluded.account else ${b.account} end`,
        bankAccountId: sql`coalesce(${b.bankAccountId}, excluded.bank_account_id)`,
        providerTxnId: sql`case when ${b.providerTxnId} = '' then excluded.provider_txn_id else ${b.providerTxnId} end`,
        provider: sql`case when ${b.provider} = '' then excluded.provider else ${b.provider} end`,
        balanceAfter: sql`coalesce(${b.balanceAfter}, excluded.balance_after)`,
        matchKey: sql`case when ${b.matchKey} = '' then excluded.match_key else ${b.matchKey} end`,
        lastSeenSource: source,
        seenSources: sql`${b.seenSources} || ${JSON.stringify([entry])}::jsonb`,
        updatedAt: now,
      },
    })
    .returning({
      id: b.id,
      inserted: sql<boolean>`(xmax = 0)`,
      amount: b.amount,
      txnAt: b.txnAt,
      providerTxnId: b.providerTxnId,
    });

  const created = Boolean(row.inserted);

  /**
   * MÂU THUẪN — nêu ra, không tự sửa.
   *
   * Cùng mã bút toán ngân hàng mà hai nguồn nói hai số tiền là dấu hiệu ghép nhầm hoặc lỗi tích hợp.
   * Ghi đè im lặng sẽ giấu mất nó; giữ giá trị của nguồn thẩm quyền cao hơn rồi báo ra mới đúng.
   */
  const conflicts: string[] = [];
  if (!created) {
    if (row.amount !== txn.amount) conflicts.push(`số tiền sổ ${row.amount} ≠ gói tin ${txn.amount}`);
    const drift = Math.abs(new Date(row.txnAt).getTime() - txn.txnAt.getTime());
    if (drift > 5 * 60_000) conflicts.push(`mốc lệch ${Math.round(drift / 60_000)} phút`);
    if (row.providerTxnId && row.providerTxnId !== txn.providerTxnId) {
      conflicts.push(`đã mang mã SePay ${row.providerTxnId}, gói tin này là ${txn.providerTxnId}`);
    }
  }

  // Nghi ngờ trùng: cùng tài khoản + số tiền + phút nhưng KHÁC mã giao dịch. Chỉ báo, không gộp.
  const suspects = await db
    .select({ id: b.id })
    .from(b)
    .where(and(eq(b.matchKey, matchKey), ne(b.id, row.id), ne(b.matchKey, "")))
    .limit(1);

  return {
    transactionId: row.id,
    created,
    duplicate: !created,
    accountUnmapped: account.unmapped,
    duplicateSuspect: suspects.length > 0,
    conflict: conflicts.length ? conflicts.join(" · ") : null,
    bankAccountId: account.id,
    bankRef,
  };
}

/** Mã bút toán ngân hàng đã chuẩn hoá — để luồng khác (đối chiếu API, nhập file) dùng chung. */
export { normalizeBankRef };

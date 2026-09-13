/**
 * ═══════ GHI SAO KÊ TẢI TAY VÀO SỔ — CHỨNG TỪ ĐÃ CÓ THÌ KHÔNG BỊ VIẾT LẠI ═══════
 *
 * Tách khỏi Server Action (`lib/actions/bank.ts::importBankStatement`) để kiểm thử được trên CSDL
 * thật mà không cần phiên đăng nhập. Action chỉ lo quyền, zod, kiểm toán, làm mới trang.
 *
 * BA LUẬT, đều từng bị vi phạm ở bản trước (13/09/2026):
 *
 *  1. **Cùng khoá tự nhiên với webhook.** Mã bút toán trong file đi qua `normalizeBankRef` y như gói
 *     tin SePay. Không chuẩn hoá thì "ft26246948262000 " (file) và "FT26246948262000" (webhook) là
 *     HAI dòng — một giao dịch bị đếm hai lần, và lưới `match_key` chỉ nêu ra chứ không gộp.
 *  2. **Dòng đã có KHÔNG bị đổi số tiền / mốc giờ.** Bản trước `ON CONFLICT … SET amount, txn_at`:
 *     một sao kê tải nhầm (hoặc bị sửa tay) viết lại số tiền của dòng webhook đã nối chứng từ, và
 *     mối nối thành nối vượt mà không ai thấy. Nay số tiền lệch ⇒ GIỮ dòng cũ, ghi MÂU THUẪN vào
 *     kết quả + kiểm toán để người xem; chỉ làm giàu mô tả và provenance.
 *  3. **Mỗi dòng biết mình thuộc tài khoản nào.** 80 dòng IMPORT trên production có `bank_account_id`
 *     NULL, nên số dư theo tài khoản và đối chiếu SePay không tra được. Người nhập phải chọn tài
 *     khoản khi sổ đã có tài khoản; chưa có tài khoản nào thì cho nhập kèm cảnh báo.
 */
import { inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { BankImportRow } from "@/lib/integrations/bank/statement";
import type { SeenSource } from "@/lib/integrations/bank/sepay-ingest";

const b = schema.bankTransactions;

export const STATEMENT_IMPORT_SOURCE = "IMPORT";

export type StatementConflict = {
  bankRef: string;
  /** Số tiền đang có trong sổ (giữ nguyên). */
  existingAmount: number;
  /** Số tiền file nói. */
  incomingAmount: number;
  /** Tài khoản của dòng đang có, khi lệch với tài khoản người nhập chọn. */
  existingAccountId: string | null;
  reason: "AMOUNT_MISMATCH" | "ACCOUNT_MISMATCH";
};

export type StatementImportResult = {
  inserted: number;
  /** Dòng đã có, chỉ làm giàu mô tả / provenance. */
  updated: number;
  /** Dòng đã có nhưng file nói KHÁC — giữ dòng cũ, không ghi. */
  conflicts: StatementConflict[];
  warnings: string[];
};

export type StatementImportOptions = {
  bankAccountId: string | null;
  /** Tên tệp — vào `seen_sources.ref` để truy nguyên lượt nhập. */
  filename: string;
  now?: Date;
};

/** Ghi một mẻ dòng đã gộp trùng (`dedupeByRef`) vào sổ. */
export async function importStatementRows(db: Db, rows: BankImportRow[], options: StatementImportOptions): Promise<StatementImportResult> {
  const now = options.now ?? new Date();
  const warnings: string[] = [];
  if (!options.bankAccountId) warnings.push("Sao kê được nhập mà không gắn tài khoản ngân hàng — số dư theo tài khoản sẽ không tra được cho các dòng này.");

  const refs = rows.map((r) => r.bankRef);
  const existing = new Map(
    (
      await db
        .select({ bankRef: b.bankRef, amount: b.amount, bankAccountId: b.bankAccountId })
        .from(b)
        .where(inArray(b.bankRef, refs))
    ).map((r) => [r.bankRef, r] as const),
  );

  const conflicts: StatementConflict[] = [];
  const ghi: BankImportRow[] = [];
  for (const r of rows) {
    const cu = existing.get(r.bankRef);
    if (!cu) {
      ghi.push(r);
      continue;
    }
    if (Number(cu.amount) !== r.amount) {
      conflicts.push({ bankRef: r.bankRef, existingAmount: Number(cu.amount), incomingAmount: r.amount, existingAccountId: cu.bankAccountId, reason: "AMOUNT_MISMATCH" });
      continue;
    }
    if (options.bankAccountId && cu.bankAccountId && cu.bankAccountId !== options.bankAccountId) {
      conflicts.push({ bankRef: r.bankRef, existingAmount: Number(cu.amount), incomingAmount: r.amount, existingAccountId: cu.bankAccountId, reason: "ACCOUNT_MISMATCH" });
      continue;
    }
    ghi.push(r);
  }

  const entry: SeenSource = { source: STATEMENT_IMPORT_SOURCE, provider: "", at: now.toISOString(), ref: options.filename.slice(0, 200) };
  // Ghi theo mẻ để một sao kê vài nghìn dòng không dựng câu lệnh dài quá giới hạn tham số của driver.
  const CHUNK = 500;
  for (let i = 0; i < ghi.length; i += CHUNK) {
    const chunk = ghi.slice(i, i + CHUNK);
    await db
      .insert(b)
      .values(
        chunk.map((r) => ({
          ...r,
          source: STATEMENT_IMPORT_SOURCE,
          bankAccountId: options.bankAccountId,
          lastSeenSource: STATEMENT_IMPORT_SOURCE,
          seenSources: [entry],
        })),
      )
      .onConflictDoUpdate({
        target: b.bankRef,
        set: {
          // CHỈ làm giàu phần MÔ TẢ. Số tiền, mốc giờ, nhãn (`accounting_group`, `note`,
          // `classified_by`) và mối nối KHÔNG đụng tới — dòng đã là chứng từ.
          description: sql`case when excluded.description <> '' then excluded.description else ${b.description} end`,
          counterparty: sql`case when excluded.counterparty <> '' then excluded.counterparty else ${b.counterparty} end`,
          bankAccountId: sql`coalesce(${b.bankAccountId}, excluded.bank_account_id)`,
          matchKey: sql`case when ${b.matchKey} = '' then excluded.match_key else ${b.matchKey} end`,
          lastSeenSource: STATEMENT_IMPORT_SOURCE,
          seenSources: sql`${b.seenSources} || ${JSON.stringify([entry])}::jsonb`,
          updatedAt: now,
        },
      });
  }

  const inserted = ghi.filter((r) => !existing.has(r.bankRef)).length;
  if (conflicts.length) {
    warnings.push(`${conflicts.length} dòng đã có trong sổ nhưng file nói khác (số tiền hoặc tài khoản) — GIỮ dòng cũ, không ghi đè. Xem chi tiết trong nhật ký.`);
  }
  return { inserted, updated: ghi.length - inserted, conflicts, warnings };
}

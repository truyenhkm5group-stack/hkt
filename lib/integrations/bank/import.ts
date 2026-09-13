/**
 * ═══════ NHẬP SAO KÊ THÀNH KHOẢN CHI — ĐƯỜNG DUY NHẤT CÒN LẠI LÀ SCRIPT / OPS ═══════
 *
 * AGENTS.md mục 3.17: **sao kê KHÔNG tạo chi phí**. Nhóm kế toán chỉ quyết định LOẠI DÒNG TIỀN; nối
 * tiền với chứng từ là ĐỐI CHIẾU. Vì thế nút "Nhập sao kê" trên trang Chi phí và hai Server Action
 * `previewBankLedger` / `importBankLedger` đã bị gỡ (13/09/2026): chúng để MARKETING / LEADER có
 * `expenses:write` đọc trọn sao kê mà không cần `bank:view`, và biến mỗi dòng tiền ra thành một
 * khoản chi rơi vào kỳ TRẢ TIỀN thay vì kỳ HƯỞNG LỢI ÍCH.
 *
 * Tệp này chỉ còn phục vụ `scripts/import-bank-ledger.ts` (ops `import-bank-ledger`) — chủ shop
 * chạy TƯỜNG MINH khi muốn dựng nhanh bảng Chi phí từ một sao kê cũ. Ba ràng buộc, cả ba có kiểm thử:
 *  (a) KHÔNG Server Action / route nào được import tệp này (`tests/bank-ledger.test.ts` quét mã nguồn);
 *  (b) mọi dòng ghi mang `cost_source = 'BANK_IMPORT'` để Cost Engine và Tổng quan tài chính nhận ra
 *      nguồn gốc (khoản BANK_IMPORT không bị đòi "đối khớp lại" với chính sao kê đã sinh ra nó);
 *  (c) TỪ CHỐI nhóm mà bảng Chi phí không có thẩm quyền (quảng cáo, tiền hàng, cước, phí hoàn —
 *      `EXPENSE_CATEGORIES_NOT_OWNED`): nguồn chuyên biệt đã tính, ghi thêm là trừ hai lần.
 *
 * Người dùng bình thường đi đường /bank?tab=nhap-sao-ke → phân loại → nối chứng từ.
 */
import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { ExpenseCategory } from "@/db/schema";
import { EXPENSE_CATEGORIES_NOT_OWNED } from "@/lib/constants/cost-sources";
import { vnStartOfDay } from "@/lib/format";
import { REFERENCE_PREFIX } from "@/lib/integrations/bank/ledger";

export type ImportRow = { reference: string; date: string; amount: number; category: ExpenseCategory; description: string };

/** Nguồn ghi vào `expenses.cost_source` cho mọi dòng sinh từ sao kê. */
export const BANK_IMPORT_COST_SOURCE = "BANK_IMPORT";

/** Các tham chiếu sao kê đã tồn tại trong bảng chi phí (để bỏ qua dòng trùng) */
export async function existingLedgerReferences(references: string[]) {
  if (!references.length) return new Set<string>();
  const db = await getDb();
  const rows = await db.select({ reference: schema.expenses.reference }).from(schema.expenses).where(inArray(schema.expenses.reference, references));
  return new Set(rows.map((r) => r.reference));
}

export type LedgerInsertResult = {
  inserted: number;
  /** Trùng tham chiếu (đã có trong ERP hoặc lặp trong cùng mẻ). */
  skipped: number;
  /** Bị từ chối vì nhóm chi phí thuộc nguồn khác (quảng cáo, tiền hàng, cước, phí hoàn). */
  refused: number;
  ids: string[];
};

/**
 * Ghi các dòng đã chọn vào bảng chi phí với `cost_source = 'BANK_IMPORT'`.
 * Bỏ qua dòng trùng tham chiếu; TỪ CHỐI (không ghi, không ném lỗi) dòng thuộc nhóm không có thẩm quyền.
 */
export async function insertLedgerExpenses(rows: ImportRow[], createdBy: string): Promise<LedgerInsertResult> {
  const refused = rows.filter((r) => EXPENSE_CATEGORIES_NOT_OWNED.includes(r.category));
  const valid = rows.filter(
    (r) => !EXPENSE_CATEGORIES_NOT_OWNED.includes(r.category) && r.reference.startsWith(REFERENCE_PREFIX) && r.amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(r.date),
  );
  const existing = await existingLedgerReferences(valid.map((r) => r.reference));
  const seen = new Set<string>();
  const fresh = valid.filter((r) => {
    if (existing.has(r.reference) || seen.has(r.reference)) return false;
    seen.add(r.reference);
    return true;
  });
  if (!fresh.length) return { inserted: 0, skipped: rows.length - refused.length, refused: refused.length, ids: [] };
  const db = await getDb();
  const inserted = await db
    .insert(schema.expenses)
    .values(
      fresh.map((r) => ({
        category: r.category,
        description: r.description.slice(0, 500),
        amount: r.amount,
        occurredAt: vnStartOfDay(r.date),
        reference: r.reference,
        costSource: BANK_IMPORT_COST_SOURCE,
        createdBy,
      })),
    )
    .returning({ id: schema.expenses.id });
  return { inserted: inserted.length, skipped: rows.length - refused.length - inserted.length, refused: refused.length, ids: inserted.map((r) => r.id) };
}

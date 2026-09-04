import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { ExpenseCategory } from "@/db/schema";
import { vnStartOfDay } from "@/lib/format";
import { REFERENCE_PREFIX } from "@/lib/integrations/bank/ledger";

export type ImportRow = { reference: string; date: string; amount: number; category: ExpenseCategory; description: string };

/** Các tham chiếu sao kê đã tồn tại trong bảng chi phí (để bỏ qua dòng trùng) */
export async function existingLedgerReferences(references: string[]) {
  if (!references.length) return new Set<string>();
  const db = await getDb();
  const rows = await db.select({ reference: schema.expenses.reference }).from(schema.expenses).where(inArray(schema.expenses.reference, references));
  return new Set(rows.map((r) => r.reference));
}

/** Ghi các dòng đã chọn vào bảng chi phí; bỏ qua dòng đã có cùng tham chiếu. */
export async function insertLedgerExpenses(rows: ImportRow[], createdBy: string) {
  const valid = rows.filter((r) => r.reference.startsWith(REFERENCE_PREFIX) && r.amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(r.date));
  const existing = await existingLedgerReferences(valid.map((r) => r.reference));
  const seen = new Set<string>();
  const fresh = valid.filter((r) => {
    if (existing.has(r.reference) || seen.has(r.reference)) return false;
    seen.add(r.reference);
    return true;
  });
  if (!fresh.length) return { inserted: 0, skipped: rows.length, ids: [] as string[] };
  const db = await getDb();
  const inserted = await db
    .insert(schema.expenses)
    .values(fresh.map((r) => ({ category: r.category, description: r.description.slice(0, 500), amount: r.amount, occurredAt: vnStartOfDay(r.date), reference: r.reference, createdBy })))
    .returning({ id: schema.expenses.id });
  return { inserted: inserted.length, skipped: rows.length - inserted.length, ids: inserted.map((r) => r.id) };
}

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { EXPENSE_CATEGORY_ORDER } from "@/lib/constants/expenses";
import { existingLedgerReferences, insertLedgerExpenses } from "@/lib/integrations/bank/import";
import { parseLedger, planImport, referenceFor, type PlannedRow } from "@/lib/integrations/bank/ledger";
import { listEmployees } from "@/lib/queries/payroll";

const MAX_TEXT = 5_000_000;

/** Đọc file sao kê (JSON/CSV) và trả về kế hoạch nhập để người dùng duyệt */
export async function previewBankLedger(text: string): Promise<{ rows: PlannedRow[] } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  if (typeof text !== "string" || text.length > MAX_TEXT) return { error: "File quá lớn (tối đa 5MB)" };
  try {
    const txns = parseLedger(text);
    if (!txns.length) return { error: "Không tìm thấy giao dịch nào trong file" };
    const [existing, employees] = await Promise.all([existingLedgerReferences(txns.map(referenceFor)), listEmployees()]);
    return { rows: planImport(txns, existing, employees) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Không đọc được file" };
  }
}

const rowSchema = z.object({
  reference: z.string().trim().min(1).max(200),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.number().int().min(1).max(2_000_000_000),
  category: z.enum(EXPENSE_CATEGORY_ORDER),
  description: z.string().trim().min(1).max(500),
});

export async function importBankLedger(input: unknown): Promise<{ ok: true; inserted: number; skipped: number } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  const parsed = z.array(rowSchema).min(1, "Chưa chọn dòng nào").max(5000, "Tối đa 5000 dòng mỗi lần").safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const result = await insertLedgerExpenses(parsed.data, user.email);
  await audit({ userId: user.id, userEmail: user.email, action: "EXPENSE_IMPORT_BANK", entity: "EXPENSE", detail: { inserted: result.inserted, skipped: result.skipped, references: parsed.data.map((r) => r.reference) } });
  revalidatePath("/expenses");
  revalidatePath("/reports");
  revalidatePath("/");
  return { ok: true, inserted: result.inserted, skipped: result.skipped };
}

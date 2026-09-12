"use server";

/**
 * ═══════ HÀNG ĐỢI TÁC VỤ TÀI CHÍNH — HÀNH ĐỘNG ═══════
 *
 * Mọi hành động GHI của hàng đợi đi thẳng qua các Server Action đã có sẵn quyền, zod và `audit()`
 * riêng: `classifyBankTransactions` / `linkBankTransaction` / `updateBankAccount` ở lib/actions/bank.ts,
 * `createExpense` ở lib/actions/expenses.ts. Tệp này chỉ có ĐÚNG một việc mà chưa nơi nào làm: TÌM
 * chứng từ có sẵn để nối tay, vì `lib/queries/finance-ops.ts` chạy CSDL nên client component không
 * import thẳng được (quy ước: client không import lib/queries/*).
 */
import { z } from "zod";
import { can, requireUser } from "@/lib/auth/session";
import { searchCodBatchesForLink, searchExpensesForLink, type LinkCandidate } from "@/lib/queries/finance-ops";

const searchSchema = z.object({
  type: z.enum(["EXPENSE", "COD_BATCH"]),
  q: z.string().trim().max(200).default(""),
});

/** Tìm khoản chi / đợt COD để nối tay từ hộp thoại "Liên kết khoản có sẵn" của hàng đợi. */
export async function searchLinkCandidates(input: unknown): Promise<{ ok: true; rows: LinkCandidate[] } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "bank:view")) return { error: "Không có quyền" };
  const parsed = searchSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { type, q } = parsed.data;
  const rows = type === "EXPENSE" ? await searchExpensesForLink(q) : await searchCodBatchesForLink(q);
  return { ok: true, rows };
}

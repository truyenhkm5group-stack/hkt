/**
 * ═══ SỬA MỘT KHOẢN CHI — LÕI GHI DÙNG CHUNG CỦA MÀN HÌNH VÀ JOB ═══
 *
 * `lib/actions/expenses.ts::updateExpense` (màn hình Chi phí) và `scripts/payroll-owner-apply.ts` đi qua ĐÚNG hàm
 * này: cùng luật khoản điều chỉnh phải có lý do, cùng cổng duyệt người thứ hai nhóm `EXPENSE_EDIT` (ngưỡng so số
 * LỚN HƠN giữa cũ và mới), cùng nhật ký trước / sau. KHÔNG phải server action: chỗ gọi đã kiểm quyền
 * `expenses:write`, đã chạy `expenseSchema`, và truyền CỔNG DUYỆT.
 */
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { vnStartOfDay } from "@/lib/format";
import type { GuardInput, GuardResult } from "@/lib/approvals/service";
import type { expenseSchema } from "@/lib/validation/expenses";

export type ExpenseActor = { id: string | null; email: string };
export type ExpenseServiceOptions = { guard: (input: GuardInput) => Promise<GuardResult>; /** Lý do ghi vào nhật ký (vd «Chủ shop ủy quyền …»). */ auditNote?: string };

export async function updateExpenseAs(user: ExpenseActor, id: string, data: z.infer<typeof expenseSchema>, opts: ExpenseServiceOptions): Promise<{ ok: true; id: string } | { error: string }> {
  {
    // Khoản ĐIỀU CHỈNH là khoản DUY NHẤT được phép vượt qua luật chống trừ hai lần (cước / phí hoàn),
    // nên nó bắt buộc phải nói vì sao. CSDL cũng chặn, đây là lớp báo lỗi thân thiện hơn.
    if (data.costSource === "MANUAL_ADJUSTMENT" && !data.reason.trim()) {
      return { error: "Khoản điều chỉnh phải ghi rõ lý do vì sao nó không nằm trong cước theo vận đơn" };
    }
    const db = await getDb();
    const existing = await db.query.expenses.findFirst({ where: eq(schema.expenses.id, id) });
    if (!existing) return { error: "Không tìm thấy khoản chi phí" };
    {
      // Sửa một khoản chi là đổi kết quả kinh doanh của cả kỳ — so ngưỡng bằng số LỚN HƠN giữa giá trị
      // cũ và mới, vì hạ một khoản lớn xuống nhỏ cũng rủi ro y như dựng một khoản lớn lên.
      const cong = await opts.guard({
        group: "EXPENSE_EDIT",
        action: "expense.update",
        entity: "EXPENSE",
        entityId: id,
        summary: `Sửa khoản chi ${existing.description} · ${existing.amount}đ → ${data.amount}đ`,
        amount: Math.max(Math.abs(existing.amount), Math.abs(data.amount)),
        payload: { truoc: existing, sau: data },
      });
      if (cong.mode === "NEEDS_APPROVAL") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}). Đã gửi yêu cầu — xem ở trang Cảnh báo.` };
      if (cong.mode === "BLOCKED_NO_APPROVER") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}), nhưng chưa có ai khác đủ tư cách duyệt.` };
    }
    await db
      .update(schema.expenses)
      .set({ category: data.category, description: data.description, amount: data.amount, occurredAt: vnStartOfDay(data.occurredAt), reference: data.reference, costSource: data.costSource, reason: data.reason })
      .where(eq(schema.expenses.id, id));
    await audit({ userId: user.id, userEmail: user.email, action: "EXPENSE_UPDATE", entity: "EXPENSE", entityId: id, detail: { before: { category: existing.category, description: existing.description, amount: existing.amount, occurredAt: existing.occurredAt, reference: existing.reference, costSource: existing.costSource, reason: existing.reason }, after: data }, ...(opts.auditNote ? { reason: opts.auditNote } : {}) });
    return { ok: true, id };
  }
}

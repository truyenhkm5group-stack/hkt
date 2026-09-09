"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { vnStartOfDay } from "@/lib/format";
import { adSpendSchema, allocationSchema, expenseSchema } from "@/lib/validation/expenses";

export type ActionResult = { ok: true; id?: string } | { error: string };

function firstIssue(error: { issues: { message: string }[] }) {
  return error.issues[0]?.message ?? "Dữ liệu không hợp lệ";
}

// ───────────────────────── Chi phí ─────────────────────────

export async function createExpense(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  const parsed = expenseSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const data = parsed.data;
  // Khoản ĐIỀU CHỈNH là khoản DUY NHẤT được phép vượt qua luật chống trừ hai lần (cước / phí hoàn),
  // nên nó bắt buộc phải nói vì sao. CSDL cũng chặn, đây là lớp báo lỗi thân thiện hơn.
  if (data.costSource === "MANUAL_ADJUSTMENT" && !data.reason.trim()) {
    return { error: "Khoản điều chỉnh phải ghi rõ lý do vì sao nó không nằm trong cước theo vận đơn" };
  }
  const db = await getDb();
  const [row] = await db
    .insert(schema.expenses)
    .values({ category: data.category, description: data.description, amount: data.amount, occurredAt: vnStartOfDay(data.occurredAt), reference: data.reference, costSource: data.costSource, reason: data.reason, createdBy: user.email })
    .returning({ id: schema.expenses.id });
  await audit({ userId: user.id, userEmail: user.email, action: "EXPENSE_CREATE", entity: "EXPENSE", entityId: row.id, detail: data });
  for (const p of ["/expenses", "/ads"]) revalidatePath(p);
  revalidatePath("/reports");
  revalidatePath("/");
  return { ok: true, id: row.id };
}

export async function updateExpense(id: string, input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  if (!id) return { error: "Thiếu mã chi phí" };
  const parsed = expenseSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const data = parsed.data;
  // Khoản ĐIỀU CHỈNH là khoản DUY NHẤT được phép vượt qua luật chống trừ hai lần (cước / phí hoàn),
  // nên nó bắt buộc phải nói vì sao. CSDL cũng chặn, đây là lớp báo lỗi thân thiện hơn.
  if (data.costSource === "MANUAL_ADJUSTMENT" && !data.reason.trim()) {
    return { error: "Khoản điều chỉnh phải ghi rõ lý do vì sao nó không nằm trong cước theo vận đơn" };
  }
  const db = await getDb();
  const existing = await db.query.expenses.findFirst({ where: eq(schema.expenses.id, id) });
  if (!existing) return { error: "Không tìm thấy khoản chi phí" };
  await db
    .update(schema.expenses)
    .set({ category: data.category, description: data.description, amount: data.amount, occurredAt: vnStartOfDay(data.occurredAt), reference: data.reference, costSource: data.costSource, reason: data.reason })
    .where(eq(schema.expenses.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "EXPENSE_UPDATE", entity: "EXPENSE", entityId: id, detail: { before: { category: existing.category, description: existing.description, amount: existing.amount, occurredAt: existing.occurredAt, reference: existing.reference }, after: data } });
  for (const p of ["/expenses", "/ads"]) revalidatePath(p);
  revalidatePath("/reports");
  revalidatePath("/");
  return { ok: true, id };
}

/**
 * KHAI KỲ HIỆU LỰC cho một khoản chi.
 *
 * Vì sao cần một hành động riêng thay vì gộp vào form sửa chi phí: đây là việc của TÀI CHÍNH, làm
 * theo lô, trên đúng những khoản đang được đánh dấu cần xem lại — và người làm chỉ cần điền hai
 * ngày, không phải mở lại toàn bộ form.
 *
 * KHÔNG ĐOÁN KỲ. ERP không tự suy kỳ từ ngày ghi sổ hay từ nội dung chuyển khoản; người khai phải
 * biết hoá đơn/hợp đồng nói gì. Khai xong thì cờ "cần xem lại" tự tắt.
 *
 * Chọn `EVENT_DATE` là một câu trả lời hợp lệ: nghĩa là "khoản này đúng là chi một lần cho ngày
 * đó", và cũng làm tắt cờ — khác hẳn với việc bỏ mặc không trả lời.
 */
export async function setExpenseAllocation(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  const parsed = allocationSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { id, allocationMethod, periodStart, periodEnd } = parsed.data;

  if (allocationMethod === "PERIOD_PRORATA") {
    if (!periodStart || !periodEnd) return { error: "Phân bổ theo kỳ thì phải khai đủ ngày bắt đầu và ngày kết thúc" };
    if (vnStartOfDay(periodEnd) < vnStartOfDay(periodStart)) return { error: "Ngày kết thúc kỳ không được trước ngày bắt đầu" };
  }

  const db = await getDb();
  const [before] = await db
    .select({ description: schema.expenses.description, amount: schema.expenses.amount, method: schema.expenses.allocationMethod, from: schema.expenses.periodStart, to: schema.expenses.periodEnd })
    .from(schema.expenses)
    .where(eq(schema.expenses.id, id));
  if (!before) return { error: "Không tìm thấy khoản chi" };

  await db
    .update(schema.expenses)
    .set({
      allocationMethod,
      periodStart: allocationMethod === "PERIOD_PRORATA" && periodStart ? vnStartOfDay(periodStart) : null,
      periodEnd: allocationMethod === "PERIOD_PRORATA" && periodEnd ? vnStartOfDay(periodEnd) : null,
      // Đã có người trả lời thì không cần hỏi lại nữa.
      needsAllocationReview: false,
      updatedAt: new Date(),
    })
    .where(eq(schema.expenses.id, id));

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "EXPENSE_ALLOCATION_SET",
    entity: "EXPENSE",
    entityId: id,
    detail: {
      description: before.description,
      amount: before.amount,
      truoc: { phuongPhap: before.method, tu: before.from, den: before.to },
      sau: { phuongPhap: allocationMethod, tu: periodStart ?? null, den: periodEnd ?? null },
    },
  });
  for (const p of ["/expenses", "/reports", "/data-quality", "/"]) revalidatePath(p);
  return { ok: true, id };
}

export async function deleteExpense(id: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  if (!id) return { error: "Thiếu mã chi phí" };
  const db = await getDb();
  const existing = await db.query.expenses.findFirst({ where: eq(schema.expenses.id, id) });
  if (!existing) return { error: "Không tìm thấy khoản chi phí" };
  await db.delete(schema.expenses).where(eq(schema.expenses.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "EXPENSE_DELETE", entity: "EXPENSE", entityId: id, detail: { category: existing.category, description: existing.description, amount: existing.amount, occurredAt: existing.occurredAt } });
  for (const p of ["/expenses", "/ads"]) revalidatePath(p);
  revalidatePath("/reports");
  revalidatePath("/");
  return { ok: true };
}

// ───────────────────────── Quảng cáo ─────────────────────────

export async function createAdSpend(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  const parsed = adSpendSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const data = parsed.data;
  const db = await getDb();
  const [row] = await db
    .insert(schema.adSpends)
    .values({ platform: data.platform, campaign: data.campaign, spend: data.spend, leads: data.leads, orders: data.orders, revenue: data.revenue, spendDate: vnStartOfDay(data.spendDate), note: data.note, createdBy: user.email })
    .returning({ id: schema.adSpends.id });
  await audit({ userId: user.id, userEmail: user.email, action: "AD_SPEND_CREATE", entity: "AD_SPEND", entityId: row.id, detail: data });
  for (const p of ["/expenses", "/ads"]) revalidatePath(p);
  revalidatePath("/reports");
  revalidatePath("/");
  return { ok: true, id: row.id };
}

export async function updateAdSpend(id: string, input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  if (!id) return { error: "Thiếu mã chi tiêu" };
  const parsed = adSpendSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const data = parsed.data;
  const db = await getDb();
  const existing = await db.query.adSpends.findFirst({ where: eq(schema.adSpends.id, id) });
  if (!existing) return { error: "Không tìm thấy dòng chi tiêu quảng cáo" };
  await db
    .update(schema.adSpends)
    .set({ platform: data.platform, campaign: data.campaign, spend: data.spend, leads: data.leads, orders: data.orders, revenue: data.revenue, spendDate: vnStartOfDay(data.spendDate), note: data.note })
    .where(eq(schema.adSpends.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "AD_SPEND_UPDATE", entity: "AD_SPEND", entityId: id, detail: { before: { platform: existing.platform, campaign: existing.campaign, spend: existing.spend, leads: existing.leads, orders: existing.orders, revenue: existing.revenue, spendDate: existing.spendDate }, after: data } });
  for (const p of ["/expenses", "/ads"]) revalidatePath(p);
  revalidatePath("/reports");
  revalidatePath("/");
  return { ok: true, id };
}

export async function deleteAdSpend(id: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  if (!id) return { error: "Thiếu mã chi tiêu" };
  const db = await getDb();
  const existing = await db.query.adSpends.findFirst({ where: eq(schema.adSpends.id, id) });
  if (!existing) return { error: "Không tìm thấy dòng chi tiêu quảng cáo" };
  await db.delete(schema.adSpends).where(eq(schema.adSpends.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "AD_SPEND_DELETE", entity: "AD_SPEND", entityId: id, detail: { platform: existing.platform, campaign: existing.campaign, spend: existing.spend, spendDate: existing.spendDate } });
  for (const p of ["/expenses", "/ads"]) revalidatePath(p);
  revalidatePath("/reports");
  revalidatePath("/");
  return { ok: true };
}

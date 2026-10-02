import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { PAYMENT_LIMITS, PAYMENT_METHODS, PAYMENT_METHOD_LABEL, manualOrderAmountDue, manualPaymentStatus, sumConfirmedPayments } from "@/lib/constants/order-payments";
import { allocatePayment, PRICE_LIST_LIMITS, validateTiers, type PriceListBook, type PriceTier } from "@/lib/constants/price-lists";
import { formatVND } from "@/lib/format";
import { fail, type MetaFailure } from "@/lib/metadata/errors";
import type { FieldError } from "@/lib/metadata/types";
import { manualOrderGate } from "@/lib/records/order-create";
import { openDebtOrders, toOpenDebts } from "@/lib/queries/receivables";

/**
 * ═══════════ BẢNG GIÁ · ĐIỀU KHOẢN BÁN · THU NỢ GỘP — ĐƯỜNG GHI (docs/verticals/price-lists-receivables.md) ═══════════
 *
 *  · Bảng giá: `products:write`. Lưu cả bảng một lần (tên, mặc định, các bậc) — các bậc cũ thay bằng bậc mới trong MỘT
 *    giao dịch. Ngừng dùng thay cho xoá: khách đang gán bảng vẫn thấy tên bảng, đơn cũ không đổi giá.
 *  · Điều khoản bán của khách: `customers:write`. Hạn mức / số ngày được nợ để trống = CHƯA KHAI, không phải 0.
 *  · Thu nợ gộp: cùng cổng với phiếu thu của đơn tay (`manualOrderGate` — `orders:write`). Một khoản tiền khách trả
 *    được chia vào các đơn còn nợ (cũ nhất trước) và ghi ĐÚNG các phiếu THU theo từng đơn ở `order_payments` — không
 *    có bảng tiền thứ hai, nên mọi màn hình đọc chứng từ (trạng thái thanh toán đơn, Thực thu đơn tay) tự đúng.
 */

export type TradeResult = { ok: true; id: string; message: string } | MetaFailure;

function zodErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((i) => ({ field: i.path.map(String).join(".") || "_", message: i.message }));
}

// ─────────────────────────── Bảng giá ───────────────────────────

const tierZ = z
  .object({
    variantId: z.string().trim().min(1, "Chọn mẫu mã").max(200),
    minQuantity: z.number({ error: "Nhập «mua từ»" }).int("«Mua từ» là số nguyên").min(1).max(PRICE_LIST_LIMITS.maxQuantity),
    unitPrice: z.number({ error: "Nhập đơn giá" }).int("Đơn giá là số tiền nguyên (đồng)").min(1, "Đơn giá phải lớn hơn 0").max(PRICE_LIST_LIMITS.maxPrice),
  })
  .strict();
const priceListZ = z
  .object({
    name: z.string().trim().min(1, "Đặt tên bảng giá").max(PRICE_LIST_LIMITS.nameMax),
    note: z.string().max(PRICE_LIST_LIMITS.noteMax).default(""),
    isDefault: z.boolean().default(false),
    tiers: z.array(tierZ).max(PRICE_LIST_LIMITS.maxTiers),
  })
  .strict();

export type PriceListInput = z.input<typeof priceListZ>;

/** Tạo (`id` rỗng) hoặc sửa một bảng giá. Bậc tham chiếu mẫu mã không tồn tại / đã gỡ ⇒ từ chối, chỉ đúng ô đó. */
export async function savePriceListCore(user: SessionUser, id: string | null, raw: unknown): Promise<TradeResult> {
  if (!can(user, "products:write")) return fail("FORBIDDEN", "Bạn không có quyền sửa bảng giá (products:write).");
  const parsed = priceListZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const v = parsed.data;
  const tierErrors = validateTiers(v.tiers);
  if (tierErrors.length) return fail("INVALID", tierErrors);
  const db = await getDb();
  const variantIds = [...new Set(v.tiers.map((t) => t.variantId))];
  if (variantIds.length) {
    const found = await db.select({ id: schema.productVariants.id }).from(schema.productVariants).where(and(inArray(schema.productVariants.id, variantIds), eq(schema.productVariants.isRemoved, false)));
    const ok = new Set(found.map((f) => f.id));
    const bad = v.tiers.map((t, i) => (ok.has(t.variantId) ? null : { field: `tiers.${i}.variantId`, message: "Mẫu mã không còn — chọn lại." })).filter((x): x is FieldError => x !== null);
    if (bad.length) return fail("INVALID", bad);
  }
  const pl = schema.priceLists;
  const clash = await db.select({ id: pl.id }).from(pl).where(and(eq(pl.name, v.name), id ? ne(pl.id, id) : undefined)).limit(1);
  if (clash.length) return fail("INVALID", [{ field: "name", message: "Đã có bảng giá cùng tên." }]);
  let before: { name: string; isDefault: boolean; tiers: number } | null = null;
  if (id) {
    const [row] = await db.select().from(pl).where(eq(pl.id, id)).limit(1);
    if (!row) return fail("NOT_FOUND", "Không có bảng giá này.");
    const n = await db.select({ id: schema.priceListItems.id }).from(schema.priceListItems).where(eq(schema.priceListItems.priceListId, id));
    before = { name: row.name, isDefault: row.isDefault, tiers: n.length };
  }
  const listId = id ?? crypto.randomUUID();
  const now = new Date();
  await db.transaction(async (tx) => {
    // Chỉ MỘT bảng mặc định đang bật: bật cái này ⇒ tắt cờ của cái kia trong CÙNG giao dịch (chỉ mục duy nhất chặn đua).
    if (v.isDefault) await tx.update(pl).set({ isDefault: false, updatedAt: now }).where(and(eq(pl.isDefault, true), ne(pl.id, listId)));
    if (id) await tx.update(pl).set({ name: v.name, note: v.note.trim(), isDefault: v.isDefault, active: true, updatedAt: now }).where(eq(pl.id, id));
    else await tx.insert(pl).values({ id: listId, name: v.name, note: v.note.trim(), isDefault: v.isDefault, createdByUserId: user.id });
    await tx.delete(schema.priceListItems).where(eq(schema.priceListItems.priceListId, listId));
    if (v.tiers.length) await tx.insert(schema.priceListItems).values(v.tiers.map((t) => ({ priceListId: listId, variantId: t.variantId, minQuantity: t.minQuantity, unitPrice: t.unitPrice })));
  });
  await audit({ userId: user.id, userEmail: user.email, action: id ? "PRICE_LIST_UPDATE" : "PRICE_LIST_CREATE", entity: "PRICE_LIST", entityId: listId, before, after: { name: v.name, isDefault: v.isDefault, tiers: v.tiers.length }, reason: "Bảng giá theo nhóm khách — áp cho đơn tạo từ bây giờ, đơn cũ giữ giá đã lưu" });
  return { ok: true, id: listId, message: `Đã lưu bảng giá «${v.name}» (${v.tiers.length} bậc). Đơn cũ giữ nguyên giá đã lưu.` };
}

/** Ngừng dùng một bảng giá (không xoá): không còn gợi ý giá, không còn là mặc định; khách đang gán rơi về bảng mặc định. */
export async function deactivatePriceListCore(user: SessionUser, id: string): Promise<TradeResult> {
  if (!can(user, "products:write")) return fail("FORBIDDEN", "Bạn không có quyền sửa bảng giá (products:write).");
  const db = await getDb();
  const pl = schema.priceLists;
  const [row] = await db.select().from(pl).where(eq(pl.id, id)).limit(1);
  if (!row) return fail("NOT_FOUND", "Không có bảng giá này.");
  if (!row.active) return { ok: true, id, message: "Bảng giá đã ngừng dùng từ trước." };
  await db.update(pl).set({ active: false, isDefault: false, updatedAt: new Date() }).where(eq(pl.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "PRICE_LIST_DEACTIVATE", entity: "PRICE_LIST", entityId: id, before: { active: true, isDefault: row.isDefault }, after: { active: false }, reason: "Ngừng dùng bảng giá — giữ dữ liệu, đơn cũ không đổi" });
  return { ok: true, id, message: `Đã ngừng dùng «${row.name}».` };
}

/** Bảng giá đang bật (kèm bậc) — đầu vào của `quoteUnitPrice` ở form đơn tay, máy chủ và chatbot. */
export async function loadActivePriceBooks(): Promise<PriceListBook[]> {
  const db = await getDb();
  const lists = await db.select().from(schema.priceLists).where(eq(schema.priceLists.active, true));
  if (lists.length === 0) return [];
  const items = await db.select().from(schema.priceListItems).where(inArray(schema.priceListItems.priceListId, lists.map((l) => l.id)));
  return lists.map((l) => ({ id: l.id, name: l.name, isDefault: l.isDefault, tiers: items.filter((i) => i.priceListId === l.id).map((i): PriceTier => ({ variantId: i.variantId, minQuantity: i.minQuantity, unitPrice: i.unitPrice })) }));
}

// ─────────────────────────── Điều khoản bán ───────────────────────────

const termsZ = z
  .object({
    priceListId: z.string().trim().max(200).nullable().default(null),
    creditLimit: z.number().int("Hạn mức là số tiền nguyên (đồng)").min(0, "Hạn mức không âm").max(PRICE_LIST_LIMITS.maxPrice).nullable().default(null),
    paymentTermsDays: z.number().int("Số ngày là số nguyên").min(0).max(365, "Tối đa 365 ngày").nullable().default(null),
  })
  .strict();

export type CustomerTermsInput = z.input<typeof termsZ>;

export async function setCustomerTermsCore(user: SessionUser, customerId: string, raw: unknown): Promise<TradeResult> {
  if (!can(user, "customers:write")) return fail("FORBIDDEN", "Bạn không có quyền sửa điều khoản bán của khách (customers:write).");
  const parsed = termsZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const v = parsed.data;
  const db = await getDb();
  const [customer] = await db.select({ id: schema.customers.id, name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, customerId)).limit(1);
  if (!customer) return fail("NOT_FOUND", "Không có khách này.");
  if (v.priceListId) {
    const [list] = await db.select({ active: schema.priceLists.active }).from(schema.priceLists).where(eq(schema.priceLists.id, v.priceListId)).limit(1);
    if (!list?.active) return fail("INVALID", [{ field: "priceListId", message: "Bảng giá không còn dùng — chọn bảng khác." }]);
  }
  const t = schema.customerTradeTerms;
  const [before] = await db.select().from(t).where(eq(t.customerId, customerId)).limit(1);
  const next = { priceListId: v.priceListId || null, creditLimit: v.creditLimit, paymentTermsDays: v.paymentTermsDays };
  await db
    .insert(t)
    .values({ customerId, ...next, updatedByUserId: user.id })
    .onConflictDoUpdate({ target: t.customerId, set: { ...next, updatedByUserId: user.id, updatedAt: new Date() } });
  await audit({ userId: user.id, userEmail: user.email, action: "CUSTOMER_TERMS_SET", entity: "CUSTOMER", entityId: customerId, before: before ? { priceListId: before.priceListId, creditLimit: before.creditLimit, paymentTermsDays: before.paymentTermsDays } : null, after: next, reason: "Điều khoản bán của khách (bảng giá · hạn mức nợ · số ngày được nợ)" });
  return { ok: true, id: customerId, message: `Đã lưu điều khoản bán của «${customer.name}».` };
}

// ─────────────────────────── Thu nợ gộp ───────────────────────────

const collectZ = z
  .object({
    amount: z.number({ error: "Nhập số tiền" }).int("Số tiền là số nguyên (đồng)").min(1, "Số tiền phải lớn hơn 0").max(PAYMENT_LIMITS.maxAmount),
    method: z.enum(PAYMENT_METHODS, { error: "Chọn phương thức thanh toán" }).refine((m) => m !== "COD", "Thu nợ gộp không nhận COD — COD đi theo từng đơn."),
    paidAt: z.iso.datetime({ offset: true, error: "Nhập mốc tiền đổi tay (ngày giờ)" }),
    reference: z.string().trim().max(PAYMENT_LIMITS.referenceMax).default(""),
    note: z.string().max(PAYMENT_LIMITS.noteMax).default(""),
  })
  .strict();

export type CollectDebtInput = z.input<typeof collectZ>;

/**
 * Khách trả MỘT khoản cho nhiều đơn ⇒ chia vào các đơn còn nợ, cũ nhất trước, và ghi một phiếu THU cho mỗi đơn — trong
 * MỘT giao dịch có khoá dòng các đơn, kiểm lại số còn nợ SAU khi khoá (hai người thu cùng lúc không thu vượt nợ).
 */
export async function collectCustomerDebtCore(user: SessionUser, customerId: string, raw: unknown): Promise<TradeResult & { allocations?: { orderId: string; amount: number }[] }> {
  const gate = await manualOrderGate(user);
  if (!gate.allowed) return fail(gate.code, gate.reason);
  const parsed = collectZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const v = parsed.data;
  const paidAt = new Date(v.paidAt);
  const now = new Date();
  if (paidAt.getTime() > now.getTime() + PAYMENT_LIMITS.futureSkewMs) return fail("INVALID", [{ field: "paidAt", message: "Mốc thanh toán ở tương lai — nhập đúng ngày giờ trên chứng từ." }]);
  const db = await getDb();
  const [customer] = await db.select({ name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, customerId)).limit(1);
  if (!customer) return fail("NOT_FOUND", "Không có khách này.");
  const plan = allocatePayment(v.amount, toOpenDebts(await openDebtOrders({ customerIds: [customerId] })));
  if (!plan.ok) return fail("INVALID", [{ field: "amount", message: plan.error }]);
  const out = await db.transaction(async (tx) => {
    const ids = plan.allocations.map((a) => a.orderId);
    const locked = await tx.select().from(schema.orders).where(inArray(schema.orders.id, ids)).for("update");
    const pays = await tx.select({ orderId: schema.orderPayments.orderId, kind: schema.orderPayments.kind, amount: schema.orderPayments.amount, status: schema.orderPayments.status }).from(schema.orderPayments).where(inArray(schema.orderPayments.orderId, ids));
    const paymentIds: string[] = [];
    for (const a of plan.allocations) {
      const row = locked.find((r) => r.id === a.orderId);
      if (!row || (row.stage !== "CONFIRMED" && row.stage !== "DELIVERED")) return { error: fail("CONFLICT", "Một đơn vừa đổi trạng thái — tải lại trang rồi thu lại.") };
      const state = manualPaymentStatus(sumConfirmedPayments(pays.filter((p) => p.orderId === a.orderId)), manualOrderAmountDue(row));
      if (a.amount > state.outstanding) return { error: fail("CONFLICT", "Có người vừa ghi phiếu thu cho đơn của khách này — tải lại trang rồi thu lại.") };
      const [ins] = await tx
        .insert(schema.orderPayments)
        .values({ orderId: a.orderId, kind: "RECEIPT", method: v.method, amount: a.amount, paidAt, reference: v.reference, note: `Thu nợ gộp ${formatVND(v.amount)}${v.note.trim() ? ` — ${v.note.trim()}` : ""}`.slice(0, PAYMENT_LIMITS.noteMax), createdByUserId: user.id, createdByName: user.name, createdAt: now })
        .returning({ id: schema.orderPayments.id });
      paymentIds.push(ins.id);
    }
    return { paymentIds };
  });
  if ("error" in out && out.error) return out.error;
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CUSTOMER_DEBT_COLLECT",
    entity: "CUSTOMER",
    entityId: customerId,
    before: null,
    after: { amount: v.amount, method: v.method, paidAt: paidAt.toISOString(), reference: v.reference || null, allocations: plan.allocations },
    reason: `Thu nợ gộp — ${plan.allocations.length} phiếu thu theo từng đơn, cũ nhất trước (ORDER_OUTCOME.md mục 11.1)`,
  });
  return { ok: true, id: customerId, allocations: plan.allocations, message: `Đã thu ${formatVND(v.amount)} (${PAYMENT_METHOD_LABEL[v.method]}) của «${customer.name}» — chia vào ${plan.allocations.length} đơn.` };
}

/**
 * Dữ liệu GỢI Ý giá + hạn mức cho form đơn tạo tay: bảng giá đang bật, điều khoản của khách đã khai, và dư nợ hiện tại
 * của những khách CÓ hạn mức (khách chưa khai hạn mức không cần đếm nợ ở đây — trang của khách có số đầy đủ).
 */
export async function manualOrderPricing(): Promise<{ books: PriceListBook[]; terms: Record<string, { priceListId: string | null; creditLimit: number | null; exposure: number }> }> {
  const db = await getDb();
  const [books, rows] = await Promise.all([loadActivePriceBooks(), db.select().from(schema.customerTradeTerms)]);
  const limited = rows.filter((r) => r.creditLimit !== null).map((r) => r.customerId);
  const debts = await openDebtOrders({ customerIds: limited });
  const exposure = new Map<string, number>();
  for (const d of debts) exposure.set(d.customerId, (exposure.get(d.customerId) ?? 0) + d.outstanding);
  return { books, terms: Object.fromEntries(rows.map((r) => [r.customerId, { priceListId: r.priceListId, creditLimit: r.creditLimit, exposure: exposure.get(r.customerId) ?? 0 }])) };
}

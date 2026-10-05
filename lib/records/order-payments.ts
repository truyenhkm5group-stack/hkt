/**
 * ═══════════ CHỨNG TỪ THANH TOÁN CỦA ĐƠN TẠO TAY — LÕI GHI (ORDER_OUTCOME.md mục 11, 0181) ═══════════
 *
 * LÕI của `recordManualPaymentAction` / `voidManualPaymentAction` — tách khỏi tệp "use server" cùng lẽ với
 * `order-create.ts`: bài kiểm gọi đúng hàm action gọi mà không cần cookie của Next. Luật thuần:
 * `lib/constants/order-payments.ts`.
 *
 * HÀNG RÀO, theo thứ tự (khuôn requireUser/can → zod → drizzle → audit):
 *  1. `manualOrderGate` — CÙNG cổng của đơn tay: module Đơn hàng bật + tổ chức KHÔNG đồng bộ đơn (nhà bật Pancake ⇒
 *     NOT_SUPPORTED, kể cả Quản trị) + quyền `orders:write`.
 *  2. Đơn phải là đơn tạo tay (id `erp-` + lời khai ERP_MANUAL) trong CSDL của PHIÊN — không nhận mã tổ chức từ client.
 *     CSDL còn CHECK `order_id LIKE 'erp-%'` phòng khi một action lỗi quên kiểm.
 *  3. zod; mốc tiền không ở tương lai; phương thức `COD` không nhận cho đơn CÓ vận đơn (COD của ĐVVC đi theo bảng kê —
 *     ghi thêm phiếu là đếm một khoản tiền hai lần).
 *  4. Luật trạng thái: đơn đã HUỶ chỉ nhận phiếu HOÀN (`canRecordPayment`). KHÔNG phụ thuộc phiếu giao — thu trước khi
 *     giao là hợp lệ (chiều tiền độc lập chiều logistics, AGENTS 0.1).
 *  5. MỘT giao dịch, khoá dòng đơn (`for update`): phiếu HOÀN không vượt số đang thu ròng; HUỶ phiếu THU không được làm
 *     số hoàn vượt số thu. Hai người bấm cùng lúc thì lượt sau thấy số của lượt trước.
 *  6. Nhật ký `ORDER_PAYMENT_RECORD` / `ORDER_PAYMENT_VOID` kèm trạng thái thanh toán TRƯỚC / SAU.
 *
 * KHÔNG ghi phiếu giao, KHÔNG đổi `orders.stage`, KHÔNG chạm tồn kho, KHÔNG chạm `ORDER_OUTCOME` (logistics): chứng từ
 * tiền chỉ đổi chiều tiền (`ORDER_OUTCOME_VERIFIED`, trạng thái thanh toán, dòng «Thực thu đơn tay»).
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { publish } from "@/lib/realtime/bus";
import type { SessionUser } from "@/lib/auth/session";
import { isManualOrderId, manualOrderRaw } from "@/lib/constants/manual-orders";
import {
  canRecordPayment,
  manualOrderAmountDue,
  manualPaymentStatus,
  PAYMENT_KIND_LABEL,
  PAYMENT_KINDS,
  PAYMENT_LIMITS,
  PAYMENT_METHODS,
  sumConfirmedPayments,
} from "@/lib/constants/order-payments";
import { fail, type MetaFailure } from "@/lib/metadata/errors";
import type { FieldError } from "@/lib/metadata/types";
import { formatVND } from "@/lib/format";
import { manualOrderGate } from "@/lib/records/order-create";

export type PaymentResult = { ok: true; id: string; paymentId: string } | MetaFailure;

const recordZ = z
  .object({
    kind: z.enum(PAYMENT_KINDS, { error: "Chọn loại chứng từ (thu / hoàn tiền)" }),
    method: z.enum(PAYMENT_METHODS, { error: "Chọn phương thức thanh toán" }),
    amount: z.number({ error: "Nhập số tiền" }).int("Số tiền là số nguyên (đồng)").min(1, "Số tiền phải lớn hơn 0").max(PAYMENT_LIMITS.maxAmount, "Số tiền quá lớn"),
    paidAt: z.iso.datetime({ offset: true, error: "Nhập mốc tiền đổi tay (ngày giờ)" }),
    reference: z.string().trim().max(PAYMENT_LIMITS.referenceMax, "Số tham chiếu quá dài").default(""),
    note: z.string().max(PAYMENT_LIMITS.noteMax, "Ghi chú quá dài").default(""),
  })
  .strict();
export type ManualPaymentInput = z.input<typeof recordZ>;

const voidZ = z
  .object({
    paymentId: z.string({ error: "Thiếu chứng từ" }).trim().min(1, "Thiếu chứng từ").max(200),
    reason: z.string().trim().min(PAYMENT_LIMITS.reasonMin, "nói vì sao huỷ chứng từ").max(PAYMENT_LIMITS.reasonMax),
  })
  .strict();

function zodErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((i) => ({ field: i.path.map(String).join(".") || "_", message: i.message }));
}

type OrderRow = typeof schema.orders.$inferSelect;

async function loadManualOrder(orderId: unknown): Promise<{ ok: true; row: OrderRow } | MetaFailure> {
  if (typeof orderId !== "string" || !orderId || orderId.length > 200) return fail("NOT_FOUND", "Không có đơn này.");
  const db = await getDb();
  const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
  if (!row) return fail("NOT_FOUND", "Không có đơn này.");
  if (!isManualOrderId(row.id) || !manualOrderRaw(row.raw)) return fail("NOT_SUPPORTED", "Đơn đồng bộ từ nguồn khác — tiền theo chứng từ đơn vị vận chuyển / sao kê, không ghi phiếu thu tay.");
  return { ok: true, row };
}

type Db = Awaited<ReturnType<typeof getDb>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Chứng từ CÒN HIỆU LỰC của đơn trong giao dịch (sau khi đã khoá dòng đơn). */
async function sumsInTx(tx: Tx, orderId: string) {
  const rows = await tx.select({ kind: schema.orderPayments.kind, amount: schema.orderPayments.amount, status: schema.orderPayments.status }).from(schema.orderPayments).where(eq(schema.orderPayments.orderId, orderId));
  return sumConfirmedPayments(rows);
}

/**
 * GHI MỘT CHỨNG TỪ (phiếu thu / phiếu hoàn tiền). Người ghi đi bằng khoá `users.id`; tên do máy chủ lấy từ phiên.
 */
export async function recordManualPaymentCore(user: SessionUser, orderId: unknown, rawInput: unknown): Promise<PaymentResult> {
  const gate = await manualOrderGate(user);
  if (!gate.allowed) return fail(gate.code, gate.reason);
  const existing = await loadManualOrder(orderId);
  if (!existing.ok) return existing;
  const row = existing.row;
  const parsed = recordZ.safeParse(rawInput);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const v = parsed.data;
  if (!canRecordPayment(v.kind, row.stage)) return fail("CONFLICT", "Đơn đã huỷ — chỉ ghi được phiếu HOÀN TIỀN (trả lại số đã thu), không nhận tiền mới.");
  const paidAt = new Date(v.paidAt);
  const now = new Date();
  if (paidAt.getTime() > now.getTime() + PAYMENT_LIMITS.futureSkewMs) return fail("INVALID", [{ field: "paidAt", message: "Mốc thanh toán ở tương lai — nhập đúng ngày giờ trên chứng từ." }]);
  const db = await getDb();
  if (v.method === "COD") {
    const [ship] = await db.select({ id: schema.shipments.id }).from(schema.shipments).where(eq(schema.shipments.orderId, row.id)).limit(1);
    if (ship) return fail("INVALID", [{ field: "method", message: "Đơn đã có vận đơn — COD do đơn vị vận chuyển thu đi theo bảng kê, không ghi phiếu thu tay (tránh đếm hai lần)." }]);
  }
  const amountDue = manualOrderAmountDue(row);
  const out = await db.transaction(async (tx) => {
    // Khoá dòng đơn: mọi lượt ghi / huỷ chứng từ của CÙNG đơn đi tuần tự — phép kiểm trần hoàn tiền không bị hai lượt vượt.
    const [locked] = await tx.select({ stage: schema.orders.stage }).from(schema.orders).where(eq(schema.orders.id, row.id)).for("update");
    if (!locked || !canRecordPayment(v.kind, locked.stage)) return { error: fail("CONFLICT", "Đơn vừa đổi trạng thái (đã huỷ) — tải lại trang rồi thử lại.") };
    const before = await sumsInTx(tx, row.id);
    const net = before.receipts - before.refunds;
    if (v.kind === "REFUND" && v.amount > net) return { error: fail("INVALID", [{ field: "amount", message: `Hoàn tiền không được vượt số đang thu ròng (${formatVND(Math.max(0, net))}).` }]) };
    const [ins] = await tx
      .insert(schema.orderPayments)
      .values({ orderId: row.id, kind: v.kind, method: v.method, amount: v.amount, paidAt, reference: v.reference, note: v.note.trim(), createdByUserId: user.id, createdByName: user.name, createdAt: now })
      .returning({ id: schema.orderPayments.id });
    const after = { receipts: before.receipts + (v.kind === "RECEIPT" ? v.amount : 0), refunds: before.refunds + (v.kind === "REFUND" ? v.amount : 0) };
    return { paymentId: ins.id, before: manualPaymentStatus(before, amountDue), after: manualPaymentStatus(after, amountDue) };
  });
  if (out.error) return out.error;
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "ORDER_PAYMENT_RECORD",
    entity: "ORDER",
    entityId: row.id,
    before: { paymentStatus: out.before.status, net: out.before.net },
    after: { paymentId: out.paymentId, kind: v.kind, method: v.method, amount: v.amount, paidAt: paidAt.toISOString(), reference: v.reference || null, paymentStatus: out.after.status, net: out.after.net },
    reason: `${PAYMENT_KIND_LABEL[v.kind]} — chứng từ thanh toán của đơn tạo tay (ORDER_OUTCOME.md mục 11)`,
  });
  publish({ type: "order", orderId: row.id, action: "updated", source: "ERP" });
  return { ok: true, id: row.id, paymentId: out.paymentId };
}

/**
 * HUỶ MỘT CHỨNG TỪ ghi nhầm: bắt buộc lý do; phiếu giữ nguyên làm vết (`status = 'VOIDED'` + mốc + người), thôi vào mọi
 * phép tính. Phiếu đã huỷ ⇒ CONFLICT, không ghi gì (bấm hai lần — mục 61).
 */
export async function voidManualPaymentCore(user: SessionUser, orderId: unknown, rawInput: unknown): Promise<PaymentResult> {
  const gate = await manualOrderGate(user);
  if (!gate.allowed) return fail(gate.code, gate.reason);
  const existing = await loadManualOrder(orderId);
  if (!existing.ok) return existing;
  const row = existing.row;
  const parsed = voidZ.safeParse(rawInput);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const { paymentId, reason } = parsed.data;
  const amountDue = manualOrderAmountDue(row);
  const now = new Date();
  const db = await getDb();
  const p = schema.orderPayments;
  const out = await db.transaction(async (tx) => {
    await tx.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.id, row.id)).for("update");
    const [pay] = await tx.select().from(p).where(and(eq(p.id, paymentId), eq(p.orderId, row.id))).limit(1);
    if (!pay) return { error: fail("NOT_FOUND", "Không có chứng từ này trên đơn.") };
    if (pay.status !== "CONFIRMED") return { error: fail("CONFLICT", "Chứng từ đã huỷ trước đó.") };
    const before = await sumsInTx(tx, row.id);
    const after = { receipts: before.receipts - (pay.kind === "RECEIPT" ? pay.amount : 0), refunds: before.refunds - (pay.kind === "REFUND" ? pay.amount : 0) };
    if (after.receipts - after.refunds < 0) return { error: fail("CONFLICT", "Huỷ phiếu thu này thì số đã hoàn cho khách vượt số đã thu — huỷ phiếu hoàn tiền trước.") };
    const moved = await tx
      .update(p)
      .set({ status: "VOIDED", voidedAt: now, voidedByUserId: user.id, voidedByName: user.name, voidReason: reason })
      .where(and(eq(p.id, pay.id), eq(p.status, "CONFIRMED")))
      .returning({ id: p.id });
    if (!moved.length) return { error: fail("CONFLICT", "Chứng từ vừa đổi — tải lại trang rồi thử lại.") };
    return { pay, before: manualPaymentStatus(before, amountDue), after: manualPaymentStatus(after, amountDue) };
  });
  if (out.error) return out.error;
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "ORDER_PAYMENT_VOID",
    entity: "ORDER",
    entityId: row.id,
    before: { paymentId: out.pay.id, kind: out.pay.kind, method: out.pay.method, amount: out.pay.amount, paidAt: out.pay.paidAt.toISOString(), paymentStatus: out.before.status, net: out.before.net },
    after: { paymentId: out.pay.id, voided: true, paymentStatus: out.after.status, net: out.after.net },
    reason,
  });
  publish({ type: "order", orderId: row.id, action: "updated", source: "ERP" });
  return { ok: true, id: row.id, paymentId: out.pay.id };
}

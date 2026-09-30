/**
 * CHỨNG TỪ THANH TOÁN CỦA ĐƠN TẠO TAY — ĐỌC (CHỈ MÁY CHỦ). Đường ghi: `lib/records/order-payments.ts`; luật thuần và
 * bảng chân lý trạng thái: `lib/constants/order-payments.ts`. Tính lúc đọc, không lưu cột nào.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { isManualOrderId } from "@/lib/constants/manual-orders";
import {
  manualOrderAmountDue,
  manualPaymentStatus,
  sumConfirmedPayments,
  type ManualPaymentState,
  type PaymentKind,
  type PaymentMethod,
  type PaymentRecordStatus,
} from "@/lib/constants/order-payments";

export type PaymentView = {
  id: string;
  kind: PaymentKind;
  method: PaymentMethod;
  amount: number;
  paidAt: Date;
  status: PaymentRecordStatus;
  reference: string;
  note: string;
  createdByName: string;
  createdAt: Date;
  voidedAt: Date | null;
  voidedByName: string;
  voidReason: string | null;
};

/** Chứng từ của MỘT đơn tay (mới nhất trước) + trạng thái thanh toán tính lúc đọc. Đơn không tạo tay ⇒ `null` (N/A). */
export async function manualOrderPaymentView(order: { id: string; totalPriceAfterDiscount: number; shippingFee: number }): Promise<{ payments: PaymentView[]; state: ManualPaymentState } | null> {
  if (!isManualOrderId(order.id) || order.id.length > 200) return null;
  const db = await getDb();
  const p = schema.orderPayments;
  const rows = await db.select().from(p).where(eq(p.orderId, order.id)).orderBy(desc(p.paidAt), desc(p.createdAt));
  const payments = rows.map((r) => ({
    id: r.id,
    kind: r.kind as PaymentKind,
    method: r.method as PaymentMethod,
    amount: r.amount,
    paidAt: r.paidAt,
    status: r.status as PaymentRecordStatus,
    reference: r.reference,
    note: r.note,
    createdByName: r.createdByName,
    createdAt: r.createdAt,
    voidedAt: r.voidedAt,
    voidedByName: r.voidedByName,
    voidReason: r.voidReason,
  }));
  return { payments, state: manualPaymentStatus(sumConfirmedPayments(rows), manualOrderAmountDue(order)) };
}

/**
 * Trạng thái thanh toán cho MỘT TRANG đơn (danh sách / trang khách) — một câu gộp cho các đơn tay trong trang. Đơn không
 * tạo tay KHÔNG có mục trong kết quả (hiển thị `N/A`); trang không có đơn tay ⇒ không chạy câu nào.
 */
export async function manualPaymentStates(orders: readonly { id: string; totalPriceAfterDiscount: number; shippingFee: number }[]): Promise<Map<string, ManualPaymentState>> {
  const manual = orders.filter((o) => isManualOrderId(o.id));
  const out = new Map<string, ManualPaymentState>();
  if (!manual.length) return out;
  const db = await getDb();
  const p = schema.orderPayments;
  const rows = await db
    .select({ orderId: p.orderId, kind: p.kind, amount: p.amount, status: p.status })
    .from(p)
    .where(and(inArray(p.orderId, manual.map((o) => o.id)), eq(p.status, "CONFIRMED")));
  for (const o of manual) out.set(o.id, manualPaymentStatus(sumConfirmedPayments(rows.filter((r) => r.orderId === o.id)), manualOrderAmountDue(o)));
  return out;
}

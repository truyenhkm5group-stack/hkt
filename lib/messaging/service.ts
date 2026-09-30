/**
 * ═══════════ SỔ GỬI TIN — ĐÚNG MỘT LẦN THEO KHOÁ, THÀ THIẾU CÒN HƠN TRÙNG (0180) — CHỈ MÁY CHỦ ═══════════
 *
 * `deliverMessage` là đường DUY NHẤT đưa một tin ra nhóm chat của tổ chức (hành động `send_message` của luật, nút "Gửi
 * thử"). Thứ tự là luật, không phải chi tiết:
 *
 *   1. Chèn dòng `messaging_deliveries` trạng thái `PENDING` với `dedupe_key` UNIQUE — TRƯỚC khi gọi nhà cung cấp.
 *   2. Chèn thua (khoá đã có) ⇒ đọc dòng cũ:
 *        · `SENT`             ⇒ KHÔNG gửi lại (`DUPLICATE`) — luật chạy lại / người bấm hai lần không đẻ tin thứ hai;
 *        · `FAILED`           ⇒ nhà cung cấp đã TỪ CHỐI rõ ràng (tin chắc chắn chưa tới) ⇒ giành lại dòng bằng một câu
 *                               điều kiện `status = 'FAILED'` rồi gửi lại;
 *        · `PENDING`/`UNKNOWN` ⇒ lượt trước chết GIỮA lúc gọi nhà cung cấp — không biết tin đã tới chưa ⇒ KHÔNG tự gửi lại
 *                               (`UNKNOWN`). Hai tin "đơn mới" cho cùng một đơn làm kho đóng hai lần; thiếu một tin thì
 *                               người trực thấy dòng UNKNOWN trên màn hình và tự quyết.
 *   3. Gọi nhà cung cấp ⇒ ghi `SENT` (+ mã tin) hoặc `FAILED` (+ câu lỗi đã che bí mật).
 *
 * Tin của hộp thử (`sandbox-messaging`) đi đúng đường này: dòng sổ CHÍNH LÀ hộp thư.
 */
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { messagingProvider, type MessagingDeps } from "@/lib/messaging/providers";
import type { MessagingConnectorKey } from "@/lib/messaging/types";

export type DeliverInput = {
  connectorKey: MessagingConnectorKey;
  destination?: string | null;
  title?: string | null;
  body: string;
  dedupeKey: string;
  event?: string | null;
  subject?: { type: string; id: string } | null;
  runId?: string | null;
  isTest?: boolean;
  createdBy?: string | null;
};

export type DeliverResult =
  | { status: "SENT"; deliveryId: string; destination: string | null; providerMessageId: string | null }
  | { status: "DUPLICATE"; deliveryId: string }
  | { status: "UNKNOWN"; deliveryId: string }
  | { status: "FAILED"; deliveryId: string | null; error: string };

const MAX_BODY = 4000;

export async function deliverMessage(input: DeliverInput, deps: MessagingDeps = {}): Promise<DeliverResult> {
  const db = await getDb();
  const t = schema.messagingDeliveries;
  const body = input.body.length > MAX_BODY ? `${input.body.slice(0, MAX_BODY - 1)}…` : input.body;
  const [inserted] = await db
    .insert(t)
    .values({
      dedupeKey: input.dedupeKey,
      connectorKey: input.connectorKey,
      destination: input.destination ?? null,
      event: input.event ?? null,
      subjectType: input.subject?.type ?? null,
      subjectId: input.subject?.id ?? null,
      runId: input.runId ?? null,
      isTest: input.isTest ?? false,
      title: input.title ?? null,
      body,
      status: "PENDING",
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoNothing({ target: t.dedupeKey })
    .returning({ id: t.id });

  let id: string;
  if (inserted) id = inserted.id;
  else {
    const [existing] = await db.select({ id: t.id, status: t.status }).from(t).where(eq(t.dedupeKey, input.dedupeKey)).limit(1);
    if (!existing) return { status: "FAILED", deliveryId: null, error: "Không đọc được dòng sổ gửi tin vừa va khoá." };
    if (existing.status === "SENT") return { status: "DUPLICATE", deliveryId: existing.id };
    if (existing.status !== "FAILED") {
      await db.update(t).set({ status: "UNKNOWN" }).where(and(eq(t.id, existing.id), eq(t.status, "PENDING")));
      return { status: "UNKNOWN", deliveryId: existing.id };
    }
    const [reclaimed] = await db.update(t).set({ status: "PENDING", error: null, body }).where(and(eq(t.id, existing.id), eq(t.status, "FAILED"))).returning({ id: t.id });
    if (!reclaimed) return { status: "UNKNOWN", deliveryId: existing.id };
    id = reclaimed.id;
  }

  const provider = await messagingProvider(input.connectorKey, deps);
  if (!provider.ok) {
    await db.update(t).set({ status: "FAILED", error: provider.error.slice(0, 500) }).where(eq(t.id, id));
    return { status: "FAILED", deliveryId: id, error: provider.error };
  }
  const sent = await provider.provider.send({ title: input.title ?? null, text: body, destination: input.destination ?? null });
  if (!sent.ok) {
    await db.update(t).set({ status: "FAILED", error: sent.error.slice(0, 500) }).where(eq(t.id, id));
    return { status: "FAILED", deliveryId: id, error: sent.error };
  }
  await db.update(t).set({ status: "SENT", providerMessageId: sent.providerMessageId, destination: sent.destination, sentAt: new Date(), error: null }).where(eq(t.id, id));
  return { status: "SENT", deliveryId: id, destination: sent.destination, providerMessageId: sent.providerMessageId };
}

export type DeliveryRow = typeof schema.messagingDeliveries.$inferSelect;

/** Tin gần nhất của tổ chức (hộp thư của chế độ thử + lịch sử gửi). */
export async function listDeliveries(opts: { limit?: number; connectorKey?: MessagingConnectorKey; subjectId?: string } = {}): Promise<DeliveryRow[]> {
  const db = await getDb();
  const t = schema.messagingDeliveries;
  const conds = [opts.connectorKey ? eq(t.connectorKey, opts.connectorKey) : undefined, opts.subjectId ? eq(t.subjectId, opts.subjectId) : undefined].filter(Boolean);
  return db
    .select()
    .from(t)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(t.createdAt))
    .limit(Math.min(Math.max(opts.limit ?? 30, 1), 200));
}

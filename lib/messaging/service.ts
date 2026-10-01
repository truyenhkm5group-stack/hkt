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
 *   4. (0186) `FAILED` vì mạng TRƯỚC KHI yêu cầu rời máy (`SendResult.retryable`) ⇒ hẹn `next_retry_at` theo
 *      `RETRY_SCHEDULE_MIN`, trong `RETRY_WINDOW_MS` kể từ lúc tạo; job `messaging-retry` gọi lại ĐÚNG hàm này với cùng
 *      `dedupe_key` (bước 2 giành lại dòng `FAILED`). Tin thử không hẹn gửi lại.
 *
 * Tin của hộp thử (`sandbox-messaging`) đi đúng đường này: dòng sổ CHÍNH LÀ hộp thư.
 */
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
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

/** Phút chờ trước lần gửi lại thứ 1, 2, 3… (0186). Hết lịch ⇒ dừng, dòng ở `FAILED` cho người trực xem. */
export const RETRY_SCHEDULE_MIN = [2, 5, 15, 30, 60, 120] as const;
/** Không gửi lại tin cũ hơn chừng này — «đơn mới» tới trễ nửa ngày là gây rối hơn là giúp. */
export const RETRY_WINDOW_MS = 6 * 3_600_000;

/** Mốc gửi lại sau lần thử thứ `attempts` (đã hỏng) — `null` khi hết lịch hoặc quá cửa sổ 6 giờ. HÀM THUẦN. */
export function nextRetryAt(createdAt: Date, attempts: number, now: Date): Date | null {
  const m = RETRY_SCHEDULE_MIN[attempts - 1];
  if (m === undefined) return null;
  const at = new Date(now.getTime() + m * 60_000);
  return at.getTime() - createdAt.getTime() <= RETRY_WINDOW_MS ? at : null;
}

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
    const [reclaimed] = await db.update(t).set({ status: "PENDING", error: null, body, nextRetryAt: null, attempts: sql`${t.attempts} + 1` }).where(and(eq(t.id, existing.id), eq(t.status, "FAILED"))).returning({ id: t.id });
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
    const [row] = await db.select({ attempts: t.attempts, createdAt: t.createdAt }).from(t).where(eq(t.id, id)).limit(1);
    const retryAt = sent.retryable && !input.isTest && row ? nextRetryAt(row.createdAt, row.attempts, (deps.now ?? (() => new Date()))()) : null;
    await db.update(t).set({ status: "FAILED", error: sent.error.slice(0, 500), nextRetryAt: retryAt }).where(eq(t.id, id));
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

export type RetryRunResult = { due: number; sent: number; failed: number; skipped: number };

/**
 * Job `messaging-retry` (0186): tin `FAILED` tới mốc gửi lại ⇒ GIÀNH dòng (xoá đúng mốc — hai lượt chồng nhau không gửi hai
 * lần) ⇒ gọi lại `deliverMessage` với CÙNG khoá chống trùng (giành lại dòng `FAILED` ở bước 2). Hỏng tiếp vì mạng ⇒ hàm ấy
 * tự hẹn mốc kế; hết lịch ⇒ dừng.
 */
export async function retryFailedDeliveries(deps: MessagingDeps = {}): Promise<RetryRunResult> {
  const now = (deps.now ?? (() => new Date()))();
  const db = await getDb();
  const t = schema.messagingDeliveries;
  const due = await db
    .select()
    .from(t)
    .where(and(eq(t.status, "FAILED"), eq(t.isTest, false), lte(t.nextRetryAt, now)))
    .orderBy(asc(t.nextRetryAt))
    .limit(20);
  const out: RetryRunResult = { due: due.length, sent: 0, failed: 0, skipped: 0 };
  for (const row of due) {
    const [mine] = await db.update(t).set({ nextRetryAt: null }).where(and(eq(t.id, row.id), eq(t.status, "FAILED"), eq(t.nextRetryAt, row.nextRetryAt!))).returning({ id: t.id });
    if (!mine) {
      out.skipped += 1;
      continue;
    }
    const r = await deliverMessage(
      {
        connectorKey: row.connectorKey as MessagingConnectorKey,
        destination: row.destination,
        title: row.title,
        body: row.body,
        dedupeKey: row.dedupeKey,
        event: row.event,
        subject: row.subjectType && row.subjectId ? { type: row.subjectType, id: row.subjectId } : null,
        runId: row.runId,
        createdBy: row.createdBy,
      },
      deps,
    );
    if (r.status === "SENT") out.sent += 1;
    else out.failed += 1;
  }
  return out;
}

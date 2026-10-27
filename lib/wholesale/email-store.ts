import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getSettingJson } from "@/lib/settings";
import { EMAIL_CANCELLABLE, mergeEmailSettings, WHOLESALE_EMAIL_SETTING_KEY, type EmailEventKind, type EmailSettings } from "@/lib/wholesale/email-constants";

/**
 * ═══════════ EMAIL BÁN SỈ — ĐỌC / GHI DÙNG CHUNG (CHỈ MÁY CHỦ, E1) ═══════════
 *
 * Mọi hàm đọc `getDb()` — CSDL của tổ chức đang chạy. Sổ sự kiện CHỈ THÊM: tệp này là đường ghi DUY NHẤT vào
 * `wholesale_email_events`, và nó chỉ có `insert`.
 */

/** Bảng email chưa có (CSDL chưa áp 0264) — SQLSTATE 42P01, có thể nằm trong `cause` của lỗi drizzle. */
export function isMissingEmailTable(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return (e?.code ?? e?.cause?.code) === "42P01";
}

export async function getEmailSettings(): Promise<EmailSettings> {
  return mergeEmailSettings(await getSettingJson<unknown>(WHOLESALE_EMAIL_SETTING_KEY, null));
}

export type EmailEventInput = {
  leadId: string;
  outboxId: string | null;
  kind: EmailEventKind;
  /** Khoá chống trùng của nguồn sự kiện (webhook / thư đọc lại). `null` = sự kiện nội bộ, không cần chống trùng. */
  providerEventId?: string | null;
  meta?: Record<string, unknown> | null;
  actorUserId?: string | null;
  at: Date;
};

/** Ghi MỘT sự kiện. Trùng `provider_event_id` ⇒ không ghi, trả `false` (người gọi dừng mọi hiệu ứng phụ). */
export async function recordEmailEvent(e: EmailEventInput): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .insert(schema.wholesaleEmailEvents)
    .values({ leadId: e.leadId, outboxId: e.outboxId, kind: e.kind, providerEventId: e.providerEventId ?? null, meta: e.meta ?? null, actorUserId: e.actorUserId ?? null, createdAt: e.at })
    .onConflictDoNothing()
    .returning({ id: schema.wholesaleEmailEvents.id });
  return rows.length > 0;
}

/**
 * Dừng mọi thư CHƯA ra khỏi tay người của một lead (chờ duyệt · đã duyệt · đang xếp hàng) — khi khách trả lời / huỷ đăng ký /
 * thư trả về. Thư đang SENDING không động vào (đang ở tay nhà cung cấp); thư đã gửi giữ nguyên. Trả số thư đã dừng.
 */
export async function stopPendingEmails(leadId: string, reason: string, now: Date): Promise<number> {
  const db = await getDb();
  const o = schema.wholesaleEmailOutbox;
  const rows = await db
    .update(o)
    .set({ status: "CANCELLED", lastError: reason.slice(0, 500), cancelledAt: now, updatedAt: now })
    .where(and(eq(o.leadId, leadId), inArray(o.status, [...EMAIL_CANCELLABLE])))
    .returning({ id: o.id });
  return rows.length;
}

/** Loại sự kiện đã có của một lead (mọi thư) — đầu vào «lead đã dừng chưa» của cổng chính sách. */
export async function leadEmailEventKinds(leadId: string): Promise<string[]> {
  const db = await getDb();
  const e = schema.wholesaleEmailEvents;
  const rows = await db.selectDistinct({ kind: e.kind }).from(e).where(eq(e.leadId, leadId));
  return rows.map((r) => r.kind);
}

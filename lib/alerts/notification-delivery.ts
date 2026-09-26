import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { schema } from "@/db";
import type { DbOrTx } from "@/lib/db-transaction";
import { sendLark } from "@/lib/alerts/lark";
import { escapeHtml, sendTelegram } from "@/lib/alerts/telegram";
import { NOTIFICATION_KIND_LABEL, type AlertConfig } from "@/lib/constants/alerts";
import { maskDeliveryError, NOTIFY_BACKOFF_BASE_MINUTES, NOTIFY_MAX_ATTEMPTS, NOTIFY_RETRY_WINDOW_MINUTES } from "@/lib/constants/notification-retry";
import { env } from "@/lib/env";

/**
 * ═══════ GỬI TIN CẢNH BÁO — LẦN ĐẦU VÀ GỬI LẠI, MỘT ĐƯỜNG (Company OS · Agent N) ═══════
 *
 * Trước bản này `evaluateAlerts` gửi đúng những dòng VỪA TẠO; gửi hỏng thì `notified_at` nằm NULL mãi
 * mãi. Nay mọi lần gửi — lần đầu lẫn lần thử lại — đi qua `deliverNotifications`:
 *
 *  1. **NHẬN TRƯỚC, GỬI SAU (so-sánh-rồi-đổi).** Một dòng chỉ được gửi bởi lượt chạy đã NHẬN được nó:
 *     `UPDATE … SET notify_attempts = +1, notify_last_attempt_at = now WHERE <còn đủ điều kiện> RETURNING`.
 *     Điều kiện nằm TRONG câu UPDATE, nên hai lượt `alerts` chạy chồng (lịch 10 phút + lượt sau webhook)
 *     cùng thấy một dòng nhưng chỉ một lượt nhận được — lượt kia thấy mốc vừa ghi, nhịp lùi chưa tới.
 *  2. **ĐÃ GỬI LÀ XONG.** Gửi được ở ít nhất một kênh ⇒ `notified_at`; dòng có `notified_at` không bao
 *     giờ được nhận lại. (Tiến trình chết đúng giữa lúc Lark nhận tin và lúc ghi `notified_at` là khe
 *     duy nhất còn gửi trùng được — nhỏ hơn nhiều so với "không bao giờ gửi".)
 *  3. **CHỈ GỬI LẠI DÒNG ĐÃ TỪNG THỬ.** `notify_attempts IS NULL` = chưa từng thử (dòng trước 0146, dòng
 *     do đường khác tạo, dòng không có kênh) ⇒ không bao giờ được "gửi lại" — gửi lại một tin chưa từng
 *     định gửi là gửi mới lén.
 *  4. **CÓ CỬA SỔ, CÓ TRẦN, CÓ NHỊP LÙI** (`lib/constants/notification-retry.ts`). Dòng đã đóng không gửi
 *     lại; dòng quá cửa sổ không gửi lại (vẫn nằm trên `/alerts`); tới trần ⇒ bỏ cuộc và ĐẾM.
 *  5. **CÂU LỖI ĐÃ CHE.** `notify_last_error` và câu lỗi trả về job đi qua `maskDeliveryError` — không URL,
 *     không token.
 */

type SendResult = { ok: boolean; error?: string };

/** Hai kênh gửi — tiêm được để kiểm thử KHÔNG gọi mạng. */
export type NotificationSenders = {
  telegram: (token: string, chatId: string, html: string) => Promise<SendResult>;
  lark: (webhookUrl: string, secret: string, title: string, lines: { text: string; href?: string }[][]) => Promise<SendResult>;
};

const DEFAULT_SENDERS: NotificationSenders = { telegram: sendTelegram, lark: sendLark };

export type DeliveryConfig = Pick<AlertConfig, "telegramBotToken" | "telegramChatId" | "larkWebhookUrl" | "larkSecret" | "larkBillingWebhookUrl" | "larkBillingSecret">;

export type DeliveryResult = {
  /** Số dòng mỗi kênh đã nhận (lần đầu + gửi lại) và câu lỗi gần nhất của kênh (đã che). */
  telegram: { sent: number; error?: string };
  lark: { sent: number; error?: string };
  /** Dòng gửi được ngay LẦN ĐẦU. */
  sent: number;
  /** Dòng gửi được ở một lần THỬ LẠI. */
  retried: number;
  /** Dòng hỏng ở lượt này nhưng còn lượt sau. */
  failed: number;
  /** Dòng hỏng ở lần thử CUỐI (tới trần) — bỏ cuộc, không gõ nữa; vẫn mở trên `/alerts`. */
  gaveUp: number;
};

/** Định dạng thời điểm ngắn gọn cho tin Lark/Telegram (giờ Việt Nam) */
export function fmtAt(d: Date | string | null | undefined) {
  if (!d) return "";
  return new Date(d).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
}

/** Webhook Lark cho một loại cảnh báo: thanh toán QC đi nhóm riêng nếu có, còn lại nhóm chính. Trống ⇒ không có kênh Lark. */
function larkTarget(kind: string, cfg: DeliveryConfig): { url: string; secret: string } | null {
  if (kind === "ADS_BILLING" && cfg.larkBillingWebhookUrl) return { url: cfg.larkBillingWebhookUrl, secret: cfg.larkBillingSecret };
  return cfg.larkWebhookUrl ? { url: cfg.larkWebhookUrl, secret: cfg.larkSecret } : null;
}

function hasTelegram(cfg: DeliveryConfig): boolean {
  return Boolean(cfg.telegramBotToken && cfg.telegramChatId);
}

/** Loại cảnh báo này có ít nhất MỘT kênh để gửi không. Không có ⇒ không nhận dòng (không đốt lượt thử). */
export function hasDestination(kind: string, cfg: DeliveryConfig): boolean {
  return hasTelegram(cfg) || larkTarget(kind, cfg) !== null;
}

/** Mốc mà dòng tạo TRƯỚC nó là đã ra khỏi cửa sổ gửi lại. */
export function notifyRetryWindowStart(now: Date): Date {
  return new Date(now.getTime() - NOTIFY_RETRY_WINDOW_MINUTES * 60_000);
}

type Row = typeof schema.notifications.$inferSelect;

/**
 * Gửi dòng vừa tạo (`created`) và thử lại dòng đã hỏng còn trong cửa sổ. Không ném vì lỗi gửi — lỗi
 * nằm trong kết quả và trong `notify_last_error`.
 */
export async function deliverNotifications(
  db: DbOrTx,
  cfg: DeliveryConfig,
  opts: { created: readonly { id: string; kind: string }[]; now?: Date; senders?: NotificationSenders; appUrl?: string },
): Promise<DeliveryResult> {
  const n = schema.notifications;
  const now = opts.now ?? new Date();
  const senders = opts.senders ?? DEFAULT_SENDERS;
  const appUrl = opts.appUrl ?? env.appUrl;
  const out: DeliveryResult = { telegram: { sent: 0 }, lark: { sent: 0 }, sent: 0, retried: 0, failed: 0, gaveUp: 0 };

  // Kênh nào đang có: không kênh nào ⇒ không nhận dòng nào (lượt thử không bị đốt vì thiếu cấu hình).
  const allKinds = hasTelegram(cfg) || Boolean(cfg.larkWebhookUrl);
  const onlyBilling = !allKinds && Boolean(cfg.larkBillingWebhookUrl);
  if (!allKinds && !onlyBilling) return out;

  // ── 1. LẦN ĐẦU: nhận dòng vừa tạo (chưa từng thử) ──
  const moi = opts.created.filter((c) => hasDestination(c.kind, cfg)).map((c) => c.id);
  const lanDau: Row[] = moi.length
    ? await db
        .update(n)
        .set({ notifyAttempts: 1, notifyLastAttemptAt: now })
        .where(and(inArray(n.id, moi), isNull(n.notifyAttempts), isNull(n.notifiedAt), isNull(n.resolvedAt)))
        .returning()
    : [];

  // ── 2. GỬI LẠI: dòng đã thử mà hỏng, còn mở, còn trong cửa sổ, chưa tới trần, nhịp lùi đã qua ──
  //
  // Điều kiện nằm TRONG câu UPDATE (không đọc trước rồi lật): Postgres khoá dòng và kiểm lại điều kiện
  // trên phiên bản mới nhất, nên lượt chạy chồng thấy `notify_last_attempt_at` vừa ghi và bỏ qua.
  const nhipLuiDaQua = sql`${n.notifyLastAttemptAt} <= ${now.toISOString()}::timestamptz - (${NOTIFY_BACKOFF_BASE_MINUTES} * power(2, ${n.notifyAttempts} - 1)) * interval '1 minute'`;
  const dieuKienGuiLai = and(
    isNull(n.notifiedAt),
    isNull(n.resolvedAt),
    isNotNull(n.notifyAttempts),
    lt(n.notifyAttempts, NOTIFY_MAX_ATTEMPTS),
    gt(n.createdAt, notifyRetryWindowStart(now)),
    nhipLuiDaQua,
    onlyBilling ? eq(n.kind, "ADS_BILLING") : undefined,
  );
  const ungVien = await db.select({ id: n.id }).from(n).where(dieuKienGuiLai).orderBy(asc(n.createdAt)).limit(500);
  const guiLai: Row[] = ungVien.length
    ? await db
        .update(n)
        .set({ notifyAttempts: sql`${n.notifyAttempts} + 1`, notifyLastAttemptAt: now })
        .where(and(inArray(n.id, ungVien.map((u) => u.id)), dieuKienGuiLai))
        .returning()
    : [];

  // ── 3. Gửi theo nhóm (loại cảnh báo × lần đầu / gửi lại): một tin cho mỗi nhóm ──
  const nhom = new Map<string, { kind: string; retry: boolean; rows: Row[] }>();
  for (const [rows, retry] of [[lanDau, false], [guiLai, true]] as const) {
    for (const r of rows) {
      const key = `${retry ? "R" : "N"}:${r.kind}`;
      const g = nhom.get(key) ?? { kind: r.kind, retry, rows: [] };
      g.rows.push(r);
      nhom.set(key, g);
    }
  }

  for (const { kind, retry, rows } of nhom.values()) {
    const nhan = NOTIFICATION_KIND_LABEL[kind] ?? kind;
    const duoi = retry ? " · gửi lại sau lỗi" : "";
    const loi: string[] = [];
    let ok = false;

    if (hasTelegram(cfg)) {
      const lines = rows.slice(0, 15).map((c) => `• <b>${escapeHtml(c.title)}</b>\n  ${escapeHtml(c.body)}${c.occurredAt ? ` · ⏱ ${fmtAt(c.occurredAt)}` : ""}\n  ${appUrl}${c.href}`);
      const more = rows.length > 15 ? `\n… và ${rows.length - 15} mục nữa` : "";
      const r = await senders.telegram(cfg.telegramBotToken, cfg.telegramChatId, `⚠️ <b>${escapeHtml(nhan)}</b> (${rows.length})${escapeHtml(duoi)}\n${lines.join("\n")}${more}`).catch((e: unknown): SendResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      if (r.ok) {
        ok = true;
        out.telegram.sent += rows.length;
      } else {
        const m = maskDeliveryError(r.error);
        out.telegram.error = m;
        loi.push(`Telegram: ${m}`);
      }
    }

    const lark = larkTarget(kind, cfg);
    if (lark) {
      const lines = rows.slice(0, 15).map((c) => [{ text: `• ${c.title}`, href: `${appUrl}${c.href}` }, { text: `${c.body ? `  ${c.body}` : ""}${c.occurredAt ? ` · ⏱ cập nhật ${fmtAt(c.occurredAt)}` : ""}` }]);
      if (rows.length > 15) lines.push([{ text: `… và ${rows.length - 15} mục nữa` }]);
      const r = await senders.lark(lark.url, lark.secret, `${kind === "ADS_BILLING" ? "💳" : "⚠️"} ${nhan} (${rows.length})${duoi}`, lines).catch((e: unknown): SendResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      if (r.ok) {
        ok = true;
        out.lark.sent += rows.length;
      } else {
        const m = maskDeliveryError(r.error);
        out.lark.error = m;
        loi.push(`Lark: ${m}`);
      }
    }

    const ids = rows.map((r) => r.id);
    if (ok) {
      // `notified_at IS NULL` trong điều kiện: không bao giờ ghi đè mốc gửi của một lượt khác.
      await db.update(n).set({ notifiedAt: now, notifyLastError: null }).where(and(inArray(n.id, ids), isNull(n.notifiedAt)));
      if (retry) out.retried += rows.length;
      else out.sent += rows.length;
    } else {
      await db.update(n).set({ notifyLastError: maskDeliveryError(loi.join(" · ")) }).where(and(inArray(n.id, ids), isNull(n.notifiedAt)));
      for (const r of rows) {
        if ((r.notifyAttempts ?? 0) >= NOTIFY_MAX_ATTEMPTS) out.gaveUp++;
        else out.failed++;
      }
    }
  }
  return out;
}

/**
 * SỨC KHOẺ ĐƯỜNG GỬI TIN — cho trang Cần xử lý. Dòng BỎ CUỘC (tới trần mà vẫn hỏng) còn trong cửa sổ và
 * còn mở; dòng ĐANG CHỜ GỬI LẠI; câu lỗi gần nhất (đã che lúc ghi). Không có gì ⇒ trang không in gì.
 */
export async function notificationDeliveryHealth(db: DbOrTx, now: Date = new Date()): Promise<{ gaveUp: number; pendingRetry: number; lastError: string | null; lastAttemptAt: Date | null }> {
  const n = schema.notifications;
  const [r] = await db
    .select({
      gaveUp: sql<number>`count(*) filter (where ${n.notifyAttempts} >= ${NOTIFY_MAX_ATTEMPTS})::int`,
      pendingRetry: sql<number>`count(*) filter (where ${n.notifyAttempts} < ${NOTIFY_MAX_ATTEMPTS})::int`,
    })
    .from(n)
    .where(and(isNull(n.notifiedAt), isNull(n.resolvedAt), isNotNull(n.notifyAttempts), gt(n.createdAt, notifyRetryWindowStart(now))));
  const [last] = await db
    .select({ error: n.notifyLastError, at: n.notifyLastAttemptAt })
    .from(n)
    .where(and(isNull(n.notifiedAt), isNull(n.resolvedAt), isNotNull(n.notifyLastError), gt(n.createdAt, notifyRetryWindowStart(now))))
    .orderBy(sql`${n.notifyLastAttemptAt} desc nulls last`)
    .limit(1);
  return { gaveUp: Number(r?.gaveUp ?? 0), pendingRetry: Number(r?.pendingRetry ?? 0), lastError: last?.error ?? null, lastAttemptAt: last?.at ?? null };
}

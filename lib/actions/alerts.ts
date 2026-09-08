"use server";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { evaluateAlerts } from "@/lib/alerts/rules";
import { loadAlertConfig } from "@/lib/alerts/config";
import { sendLark } from "@/lib/alerts/lark";
import { setAdAccountThreshold } from "@/lib/integrations/facebook/billing";
import { sendTelegram } from "@/lib/alerts/telegram";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { ALERT_CONFIG_KEY } from "@/lib/constants/alerts";
import { setSettingJson } from "@/lib/settings";

const configSchema = z.object({
  telegramBotToken: z.string().trim().max(200),
  telegramChatId: z.string().trim().max(100),
  larkWebhookUrl: z.string().trim().max(300).refine((v) => !v || /^https:\/\/open\.(larksuite|feishu)\.(com|cn)\/open-apis\/bot\/v2\/hook\//.test(v), "Webhook Lark phải có dạng https://open.larksuite.com/open-apis/bot/v2/hook/…"),
  larkSecret: z.string().trim().max(200),
  pendingHours: z.number().int().min(1).max(720),
  staleDays: z.number().int().min(1).max(60),
  lookbackDays: z.number().int().min(1).max(365).default(14),
  larkBillingWebhookUrl: z.string().trim().max(300).refine((v) => !v || /^https:\/\/open\.(larksuite|feishu)\.(com|cn)\/open-apis\/bot\/v2\/hook\//.test(v), "Webhook Lark phải có dạng https://open.larksuite.com/open-apis/bot/v2/hook/…").default(""),
  larkBillingSecret: z.string().trim().max(200).default(""),
  billingWarnPercent: z.number().int().min(10).max(100).default(80),
  riskMinReturned: z.number().int().min(1).max(50).default(2),
  riskReturnRatePct: z.number().int().min(1).max(100).default(40),
  enabled: z.object({ failed: z.boolean(), pending: z.boolean(), stale: z.boolean(), returning: z.boolean(), cs: z.boolean().default(true), stock: z.boolean().default(true), billing: z.boolean().default(true), risk: z.boolean().default(true) }),
});

export async function saveAlertConfig(input: unknown): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "alerts:manage")) return { error: "Không có quyền" };
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  await setSettingJson(ALERT_CONFIG_KEY, parsed.data);
  await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: ALERT_CONFIG_KEY, detail: { ...parsed.data, telegramBotToken: parsed.data.telegramBotToken ? "***" : "", larkSecret: parsed.data.larkSecret ? "***" : "" } });
  revalidatePath("/integrations");
  return { ok: true };
}

export async function sendTestTelegram(): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "alerts:manage")) return { error: "Không có quyền" };
  const cfg = await loadAlertConfig();
  const result = await sendTelegram(cfg.telegramBotToken, cfg.telegramChatId, `✅ <b>Shop Control ERP</b>: kết nối Telegram thành công. Cảnh báo đơn chờ xử lý / giao thất bại sẽ gửi vào đây.`);
  return result.ok ? { ok: true } : { error: result.error ?? "Gửi thất bại" };
}

export async function sendTestLark(): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "alerts:manage")) return { error: "Không có quyền" };
  const cfg = await loadAlertConfig();
  const result = await sendLark(cfg.larkWebhookUrl, cfg.larkSecret, "✅ Shop Control ERP đã kết nối Lark", [[{ text: "Cảnh báo đơn chờ xử lý, giao thất bại chờ phát lại, case CSKH sẽ gửi vào nhóm này. " }, { text: "Mở ERP", href: `${process.env.APP_URL ?? ""}/alerts` }]]);
  return result.ok ? { ok: true } : { error: result.error ?? "Gửi thất bại" };
}

/** Chạy quy tắc cảnh báo ngay */
export async function runAlertsNow(): Promise<{ ok: true; created: number; resolved: number; open: number; telegramError?: string; larkError?: string } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "shipments:view")) return { error: "Không có quyền" };
  const r = await evaluateAlerts();
  revalidatePath("/alerts");
  return { ok: true, created: r.created, resolved: r.resolved, open: r.open, telegramError: r.telegram.error, larkError: r.lark.error };
}

/** Đánh dấu đã đọc (ids rỗng = tất cả đang mở) */
export async function markNotificationsRead(ids: string[]): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  const db = await getDb();
  const n = schema.notifications;
  const cond = ids?.length ? and(isNull(n.resolvedAt), inArray(n.id, ids.slice(0, 500))) : isNull(n.resolvedAt);
  await db
    .update(n)
    .set({ readBy: sql`(select coalesce(jsonb_agg(distinct v), '[]'::jsonb) from jsonb_array_elements(${n.readBy} || ${JSON.stringify([user.id])}::jsonb) v)` })
    .where(cond);
  revalidatePath("/alerts");
  return { ok: true };
}

/** Đóng tay một thông báo (đã xử lý) */
export async function resolveNotification(id: string): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "shipments:view")) return { error: "Không có quyền" };
  const db = await getDb();
  const [before] = await db.select({ title: schema.notifications.title, kind: schema.notifications.kind }).from(schema.notifications).where(eq(schema.notifications.id, id));
  await db.update(schema.notifications).set({ resolvedAt: new Date() }).where(inArray(schema.notifications.id, [id]));
  // Đóng việc bằng tay là quyết định vận hành: ai đóng, đóng việc gì, lúc nào.
  await audit({ userId: user.id, userEmail: user.email, action: "case.resolve", entity: "NOTIFICATION", entityId: id, detail: { title: before?.title ?? "", kind: before?.kind ?? "" } });
  revalidatePath("/alerts");
  return { ok: true };
}

/**
 * NHẬN VIỆC — gán việc cho một người. Không có người cầm thì việc trôi.
 * `userId` rỗng = trả việc về hàng đợi chung.
 */
export async function assignCase(id: string, userId: string | null): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "shipments:view")) return { error: "Không có quyền" };
  const db = await getDb();
  const n = schema.notifications;
  const [before] = await db.select({ assignedTo: n.assignedTo, title: n.title }).from(n).where(eq(n.id, id));
  if (!before) return { error: "Không tìm thấy việc" };
  await db.update(n).set({ assignedTo: userId, assignedAt: userId ? new Date() : null }).where(eq(n.id, id));
  // Việc đổi người là thay đổi trách nhiệm — phải truy nguyên được.
  await audit({ userId: user.id, userEmail: user.email, action: "case.assign", entity: "NOTIFICATION", entityId: id, detail: { from: before.assignedTo, to: userId, title: before.title } });
  revalidatePath("/alerts");
  return { ok: true };
}

/**
 * TIẾP NHẬN — "tôi đang làm việc này". Khác ĐÃ ĐỌC (chỉ nhìn thấy) và khác ĐÃ XONG.
 * Tiếp nhận mà chưa có người nhận thì tự gán cho chính người bấm.
 */
export async function acknowledgeCase(id: string): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "shipments:view")) return { error: "Không có quyền" };
  const db = await getDb();
  const n = schema.notifications;
  const [before] = await db.select({ assignedTo: n.assignedTo, acknowledgedAt: n.acknowledgedAt, title: n.title }).from(n).where(eq(n.id, id));
  if (!before) return { error: "Không tìm thấy việc" };
  if (before.acknowledgedAt) return { ok: true };
  await db
    .update(n)
    .set({ acknowledgedBy: user.id, acknowledgedAt: new Date(), assignedTo: before.assignedTo ?? user.id, assignedAt: before.assignedTo ? undefined : new Date() })
    .where(eq(n.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "case.acknowledge", entity: "NOTIFICATION", entityId: id, detail: { title: before.title } });
  revalidatePath("/alerts");
  return { ok: true };
}

/** Gửi tin thử vào nhóm Lark nhận cảnh báo ngưỡng thanh toán QC */
export async function sendTestLarkBilling(): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "alerts:manage")) return { error: "Không có quyền" };
  const cfg = await loadAlertConfig();
  const url = cfg.larkBillingWebhookUrl || cfg.larkWebhookUrl;
  if (!url) return { error: "Chưa cấu hình webhook Lark" };
  const result = await sendLark(url, cfg.larkBillingWebhookUrl ? cfg.larkBillingSecret : cfg.larkSecret, "💳 Shop Control ERP · cảnh báo ngưỡng thanh toán quảng cáo", [[{ text: `Nhóm này sẽ nhận cảnh báo khi dư nợ tài khoản quảng cáo đạt ${cfg.billingWarnPercent}% ngưỡng thanh toán hoặc tài khoản bị vô hiệu hoá. ` }, { text: "Mở ERP", href: `${process.env.APP_URL ?? ""}/ads` }]]);
  return result.ok ? { ok: true } : { error: result.error ?? "Gửi thất bại" };
}

/** Nhập ngưỡng thanh toán của một tài khoản quảng cáo (0 / trống = dùng ngưỡng tự học) */
export async function saveAdAccountThreshold(accountId: string, threshold: number | null): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  if (!accountId) return { error: "Thiếu tài khoản" };
  const value = threshold && Number.isFinite(threshold) && threshold > 0 ? Math.round(threshold) : null;
  await setAdAccountThreshold(accountId, value);
  await audit({ userId: user.id, userEmail: user.email, action: "AD_ACCOUNT_THRESHOLD", entity: "AD_ACCOUNT", entityId: accountId, detail: { threshold: value } });
  for (const p of ["/expenses", "/ads"]) revalidatePath(p);
  return { ok: true };
}

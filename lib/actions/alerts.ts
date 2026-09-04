"use server";

import { and, inArray, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { evaluateAlerts } from "@/lib/alerts/rules";
import { loadAlertConfig } from "@/lib/alerts/config";
import { sendTelegram } from "@/lib/alerts/telegram";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { ALERT_CONFIG_KEY } from "@/lib/constants/alerts";
import { setSettingJson } from "@/lib/settings";

const configSchema = z.object({
  telegramBotToken: z.string().trim().max(200),
  telegramChatId: z.string().trim().max(100),
  pendingHours: z.number().int().min(1).max(720),
  staleDays: z.number().int().min(1).max(60),
  enabled: z.object({ failed: z.boolean(), pending: z.boolean(), stale: z.boolean(), returning: z.boolean() }),
});

export async function saveAlertConfig(input: unknown): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "settings:manage")) return { error: "Không có quyền" };
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  await setSettingJson(ALERT_CONFIG_KEY, parsed.data);
  await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: ALERT_CONFIG_KEY, detail: { ...parsed.data, telegramBotToken: parsed.data.telegramBotToken ? "***" : "" } });
  revalidatePath("/integrations");
  return { ok: true };
}

export async function sendTestTelegram(): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "settings:manage")) return { error: "Không có quyền" };
  const cfg = await loadAlertConfig();
  const result = await sendTelegram(cfg.telegramBotToken, cfg.telegramChatId, `✅ <b>Shop Control ERP</b>: kết nối Telegram thành công. Cảnh báo đơn chờ xử lý / giao thất bại sẽ gửi vào đây.`);
  return result.ok ? { ok: true } : { error: result.error ?? "Gửi thất bại" };
}

/** Chạy quy tắc cảnh báo ngay */
export async function runAlertsNow(): Promise<{ ok: true; created: number; resolved: number; open: number; telegramError?: string } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "shipments:view")) return { error: "Không có quyền" };
  const r = await evaluateAlerts();
  revalidatePath("/alerts");
  return { ok: true, created: r.created, resolved: r.resolved, open: r.open, telegramError: r.telegram.error };
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
  await db.update(schema.notifications).set({ resolvedAt: new Date() }).where(inArray(schema.notifications.id, [id]));
  revalidatePath("/alerts");
  return { ok: true };
}

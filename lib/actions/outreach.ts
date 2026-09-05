"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { OUTREACH_KEY, renderTemplate } from "@/lib/constants/outreach";
import { buildOutreachTargets, loadOutreachConfig } from "@/lib/outreach/build";
import { sendOutreachTargets } from "@/lib/outreach/send";
import { setSettingJson } from "@/lib/settings";

type Result<T = object> = ({ ok: true } & T) | { error: string };

async function authorize() {
  const user = await requireUser();
  return { user, error: can(user, "cs:manage") ? null : "Bạn không có quyền chăm sóc khách hàng" };
}

const configSchema = z.object({
  shopName: z.string().trim().max(100),
  discountCode: z.string().trim().max(50),
  nurtureDiscount: z.string().trim().max(60),
  nurtureWindowHours: z.number().int().min(1).max(24 * 30),
  nurtureSteps: z.array(z.string().trim().min(10).max(1500)).min(1, "Cần ít nhất một bước").max(15),
  nurtureStepGapDays: z.number().int().min(1).max(14),
  crossSellFromDays: z.number().int().min(0).max(60),
  crossSellToDays: z.number().int().min(1).max(120),
  cooldownDays: z.number().int().min(1).max(365),
  dailyLimit: z.number().int().min(1).max(5000),
  crossSellMap: z.record(z.string(), z.array(z.string())).default({}),
  crossSellMedia: z.record(z.string(), z.array(z.string().trim().url("URL ảnh/video phải là đường dẫn https công khai").max(500))).default({}),
  attachProductImages: z.boolean().default(true),
  maxMediaPerMessage: z.number().int().min(1).max(6).default(3),
  crossSellDiscount: z.string().trim().max(40).default("50K"),
  clearanceDiscount: z.string().trim().max(40).default("100K"),
  clearanceReturnRatePct: z.number().min(0).max(100).default(35),
  clearanceStockDays: z.number().int().min(0).max(365).default(45),
  clearanceProductIds: z.array(z.string()).default([]),
  crossSellClearanceTemplate: z.string().trim().min(10).max(1500),
  crossSellTemplate: z.string().trim().min(10).max(1500),
});

export async function saveOutreachConfig(input: unknown): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "settings:manage")) return { error: "Không có quyền" };
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  await setSettingJson(OUTREACH_KEY, parsed.data);
  await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: OUTREACH_KEY, detail: parsed.data });
  revalidatePath("/outreach");
  return { ok: true };
}

export async function buildOutreach(segment?: "NURTURE" | "CROSS_SELL", windowHours?: number): Promise<Result<{ nurture: number; crossSell: number; scanned: number; converted: number; replied: number; errors: string[] }>> {
  const { user, error } = await authorize();
  if (error) return { error };
  const hours = windowHours && Number.isFinite(windowHours) ? Math.min(24 * 30, Math.max(1, Math.round(windowHours))) : undefined;
  const r = await buildOutreachTargets({ segments: segment ? [segment] : undefined, windowHours: hours });
  await audit({ userId: user.id, userEmail: user.email, action: "OUTREACH_BUILD", entity: "OUTREACH", detail: r });
  revalidatePath("/outreach");
  return { ok: true, ...r };
}

export async function sendOutreach(ids: string[]): Promise<Result<{ sent: number; failed: number; skipped: number; notDue: number; remainingToday: number }>> {
  const { user, error } = await authorize();
  if (error) return { error };
  const list = z.array(z.string().min(1)).min(1, "Chưa chọn khách nào").max(500, "Tối đa 500 mỗi lần").safeParse(ids);
  if (!list.success) return { error: list.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const r = await sendOutreachTargets(list.data, user.email);
  await audit({ userId: user.id, userEmail: user.email, action: "OUTREACH_SEND", entity: "OUTREACH", detail: { ids: list.data, ...r } });
  revalidatePath("/outreach");
  return { ok: true, ...r };
}

export async function skipOutreach(ids: string[]): Promise<Result> {
  const { user, error } = await authorize();
  if (error) return { error };
  if (!ids?.length) return { error: "Chưa chọn khách nào" };
  const db = await getDb();
  await db.update(schema.outreachTargets).set({ status: "SKIPPED", updatedAt: new Date() }).where(and(inArray(schema.outreachTargets.id, ids.slice(0, 500)), eq(schema.outreachTargets.status, "PENDING")));
  await audit({ userId: user.id, userEmail: user.email, action: "OUTREACH_SKIP", entity: "OUTREACH", detail: { ids } });
  revalidatePath("/outreach");
  return { ok: true };
}

/** Sửa nội dung tin của một mục trước khi gửi */
export async function updateOutreachMessage(id: string, message: string): Promise<Result> {
  const { error } = await authorize();
  if (error) return { error };
  const text = message.trim();
  if (text.length < 5 || text.length > 1500) return { error: "Nội dung 5–1500 ký tự" };
  const db = await getDb();
  await db.update(schema.outreachTargets).set({ message: text, updatedAt: new Date() }).where(and(eq(schema.outreachTargets.id, id), eq(schema.outreachTargets.status, "PENDING")));
  revalidatePath("/outreach");
  return { ok: true };
}

/** Xem trước mẫu với dữ liệu giả */
export async function previewOutreachTemplate(segment: "NURTURE" | "CROSS_SELL", template: string): Promise<Result<{ text: string }>> {
  const { error } = await authorize();
  if (error) return { error };
  const cfg = await loadOutreachConfig();
  return { ok: true, text: renderTemplate(template, { ten: "chị Lan", san_pham: segment === "NURTURE" ? "Đầm Q002" : "Đầm Q003 màu đỏ", goi_y: "Đầm Q004, Quần định hình", shop: cfg.shopName, discountCode: cfg.discountCode, giam: segment === "NURTURE" ? cfg.nurtureDiscount : /siêu hời/.test(template) ? cfg.clearanceDiscount : cfg.crossSellDiscount }) };
}

/** Sửa danh sách ảnh/video gửi kèm của một mục trước khi gửi */
export async function updateOutreachMedia(id: string, urls: string[]): Promise<Result> {
  const { error } = await authorize();
  if (error) return { error };
  const parsed = z.array(z.string().trim().url("URL ảnh/video không hợp lệ").max(500)).max(6, "Tối đa 6 tệp").safeParse(urls.map((u) => u.trim()).filter(Boolean));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const db = await getDb();
  await db.update(schema.outreachTargets).set({ mediaUrls: parsed.data, updatedAt: new Date() }).where(and(eq(schema.outreachTargets.id, id), eq(schema.outreachTargets.status, "PENDING")));
  revalidatePath("/outreach");
  return { ok: true };
}

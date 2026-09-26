"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import type { Actor } from "@/lib/constants/actor";
import { broadcastFiltersSchema, broadcastStartSchema, type BroadcastPreviewResult } from "@/lib/constants/outreach-broadcast";
import { createBroadcast, resumeBroadcast, runBroadcast, stopBroadcast } from "@/lib/outreach/broadcast";
import { previewBroadcast } from "@/lib/queries/outreach-broadcast";

/**
 * Gửi tin hàng loạt theo bộ lọc. Luật ở `lib/constants/outreach-broadcast.ts`, đường ghi ở
 * `lib/outreach/broadcast.ts`. Tệp này chỉ: kiểm quyền → lược đồ → người thao tác đọc từ MÁY CHỦ
 * (AGENTS.md mục 34) → gọi đường ghi → nhật ký. Vòng gửi chạy trong `after()` để nút bấm không treo.
 */

const PATH = "/outreach/broadcast";
type Fail = { error: string };

async function actorOf(userId: string, fallback: string): Promise<Actor> {
  const db = await getDb();
  const who = await db.query.users.findFirst({ where: eq(schema.users.id, userId), columns: { name: true, email: true } });
  return { id: userId, label: who?.name?.trim() || who?.email || fallback };
}

const SAMPLE = 100;

export async function previewBroadcastAction(raw: unknown): Promise<BroadcastPreviewResult | Fail> {
  const user = await requireUser();
  if (!can(user, "outreach:view")) return { error: "Không có quyền" };
  const parsed = broadcastFiltersSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Bộ lọc không hợp lệ" };
  const p = await previewBroadcast(parsed.data);
  return {
    total: p.eligible.length,
    sample: p.eligible.slice(0, SAMPLE).map((c) => ({
      pageName: c.pageName,
      pageId: c.pageId,
      customerName: c.customerName,
      hasPhone: Boolean(c.phone),
      tags: c.tags,
      lastCustomerAt: c.lastCustomerMessageAt?.toISOString() ?? null,
      lastShopAt: c.lastShopMessageAt?.toISOString() ?? null,
      seenAt: c.customerSeenAt?.toISOString() ?? null,
    })),
    excluded: p.excluded,
    truncatedPages: p.truncatedPages.map((t) => t.pageName || t.pageId),
    lastScanAt: p.lastScanAt?.toISOString() ?? null,
  };
}

/** Vòng gửi SAU phản hồi. Lỗi ở đây không mất gì: dòng còn `PENDING`, bấm "Tiếp tục" là chạy nốt. */
function runAfterResponse(broadcastId: string) {
  after(async () => {
    try {
      await runBroadcast(broadcastId);
    } catch (e) {
      console.error("[outreach-broadcast] vòng gửi lỗi:", e instanceof Error ? e.message : String(e));
    }
  });
}

export async function startBroadcastAction(raw: unknown): Promise<{ ok: true; broadcastId: string; total: number } | Fail> {
  const user = await requireUser();
  if (!can(user, "outreach:send")) return { error: "Bạn không có quyền gửi tin cho khách" };
  const parsed = broadcastStartSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const actor = await actorOf(user.id, user.email);
  const r = await createBroadcast(parsed.data, actor);
  if (!r.ok) return { error: r.error };
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "OUTREACH_BROADCAST_START",
    entity: "OUTREACH_BROADCAST",
    entityId: r.broadcastId,
    after: { total: r.total, filters: parsed.data.filters, messages: parsed.data.messages.length, media: parsed.data.mediaUrls.length, gapSeconds: parsed.data.gapSeconds },
  });
  runAfterResponse(r.broadcastId);
  revalidatePath(PATH);
  return { ok: true, broadcastId: r.broadcastId, total: r.total };
}

const idSchema = z.object({ id: z.string().trim().min(1) }).strict();

export async function stopBroadcastAction(raw: unknown): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  if (!can(user, "outreach:send")) return { error: "Không có quyền" };
  const parsed = idSchema.safeParse(raw);
  if (!parsed.success) return { error: "Đầu vào không hợp lệ" };
  const stopped = await stopBroadcast(parsed.data.id, await actorOf(user.id, user.email));
  if (!stopped) return { error: "Lượt này không còn đang chạy" };
  await audit({ userId: user.id, userEmail: user.email, action: "OUTREACH_BROADCAST_STOP", entity: "OUTREACH_BROADCAST", entityId: parsed.data.id });
  revalidatePath(PATH);
  return { ok: true };
}

export async function resumeBroadcastAction(raw: unknown): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  if (!can(user, "outreach:send")) return { error: "Không có quyền" };
  const parsed = idSchema.safeParse(raw);
  if (!parsed.success) return { error: "Đầu vào không hợp lệ" };
  const r = await resumeBroadcast(parsed.data.id);
  if (!r.ok) return { error: r.error };
  await audit({ userId: user.id, userEmail: user.email, action: "OUTREACH_BROADCAST_RESUME", entity: "OUTREACH_BROADCAST", entityId: parsed.data.id });
  runAfterResponse(parsed.data.id);
  revalidatePath(PATH);
  return { ok: true };
}

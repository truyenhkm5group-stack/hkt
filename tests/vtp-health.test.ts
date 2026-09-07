import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { viettelPostHealth } from "@/lib/queries/integrations";
import { runSyncJob } from "@/lib/sync/runner";

/**
 * Hai sự thật vận hành mà production đã từng che mất:
 *  · deploy giữa chừng để lại sync_runs kẹt RUNNING vĩnh viễn;
 *  · đối chiếu Viettel Post chạy 383 lượt, cập nhật 0, vẫn ghi SUCCESS — đối chiếu chết âm thầm.
 */
export async function testVtpHealth(db: Db) {
  // ───────── 1. Lần chạy mồ côi bị đóng lại, lần chạy đang sống thì không ─────────
  const [mocoi] = await db
    .insert(schema.syncRuns)
    .values({ source: "VIETTELPOST", job: "tracking_poll", status: "RUNNING", startedAt: new Date(Date.now() - 2 * 3600_000) })
    .returning({ id: schema.syncRuns.id });
  const [dangChay] = await db
    .insert(schema.syncRuns)
    .values({ source: "VIETTELPOST", job: "orders_import", status: "RUNNING", startedAt: new Date(Date.now() - 60_000) })
    .returning({ id: schema.syncRuns.id });

  const ok = await runSyncJob({ source: "VIETTELPOST", job: "test_reaper" }, async (ctx) => {
    ctx.summary.updated = 1;
    return 1;
  });
  assert.equal(ok.run.status, "SUCCESS");

  const [daDong] = await db.select().from(schema.syncRuns).where(eq(schema.syncRuns.id, mocoi.id));
  assert.equal(daDong.status, "FAILED", "lần chạy RUNNING quá 30 phút phải bị đóng lại");
  assert.match(daDong.error ?? "", /tiến trình bị dừng/);
  assert.ok(daDong.finishedAt, "phải có mốc kết thúc để không kẹt trong bảng nữa");
  const [conSong] = await db.select().from(schema.syncRuns).where(eq(schema.syncRuns.id, dangChay.id));
  assert.equal(conSong.status, "RUNNING", "lần chạy mới bắt đầu không được đụng tới");

  // ───────── 2. Chạy xong nhưng không đạt mục đích ⇒ PARTIAL, không phải SUCCESS ─────────
  const degraded = await runSyncJob({ source: "VIETTELPOST", job: "test_warning" }, async (ctx) => {
    ctx.summary.skipped = 300;
    ctx.summary.warning = "API không thấy vận đơn nào";
    return 300;
  });
  assert.equal(degraded.run.status, "PARTIAL", "cập nhật 0 vì API mù thì không được báo thành công");
  const [warned] = await db.select().from(schema.syncRuns).where(eq(schema.syncRuns.id, degraded.run.id));
  assert.match(warned.error ?? "", /API không thấy vận đơn nào/, "lý do phải hiện ra chứ không nuốt mất");

  // ───────── 3. Sức khoẻ tích hợp đọc đúng nguồn ─────────
  await db.insert(schema.webhookEvents).values([
    { source: "VIETTELPOST", eventType: "tracking", externalId: "PKE-HEALTH-1", status: "PROCESSED", payload: { DATA: { ORDER_NUMBER: "PKE-HEALTH-1", STATUS_NAME: "Giao bưu tá đi phát" } }, headers: {} },
    { source: "VIETTELPOST", eventType: "tracking", externalId: "PKE-HEALTH-2", status: "FAILED", payload: { DATA: { ORDER_NUMBER: "PKE-HEALTH-2" } }, headers: {} },
  ]);
  await db.insert(schema.syncState).values({ key: "viettelpost:api-scope", value: { missingStreak: 5, lastFoundAt: null, lastCheckedAt: new Date().toISOString() } })
    .onConflictDoUpdate({ target: schema.syncState.key, set: { value: { missingStreak: 5, lastFoundAt: null, lastCheckedAt: new Date().toISOString() } } });

  const health = await viettelPostHealth();
  assert.ok(health.lastWebhook, "phải nêu được webhook gần nhất ERP nhận được");
  assert.ok(health.webhooks.total >= 2);
  assert.ok(health.webhooks.failed >= 1, "webhook xử lý lỗi phải đếm được");
  assert.equal(health.apiBlind, true, "3 lượt liên tiếp API không thấy gì ⇒ coi như đối chiếu API không dùng được");
  assert.equal(typeof health.openShipments.total, "number");
  assert.equal(typeof health.stageMismatch, "number");

  // Lệch trạng thái: sự kiện Viettel Post mới nhất nói RETURNED mà vận đơn vẫn DELIVERED.
  const before = health.stageMismatch;
  await db.insert(schema.orders).values({ id: "vtp-health-order", insertedAt: new Date() });
  const [sp] = await db.insert(schema.shipments).values({ orderId: "vtp-health-order", vtpOrderNumber: "PKE-HEALTH-9", stage: "DELIVERED", isFinal: true })
    .returning({ id: schema.shipments.id });
  await db.insert(schema.shipmentEvents).values({ shipmentId: sp.id, source: "VTP_WEBHOOK", status: "504", statusName: "Chuyển hoàn thành công", occurredAt: new Date(), normalizedStage: "RETURNED" });
  const after = await viettelPostHealth();
  assert.equal(after.stageMismatch, before + 1, "phải phát hiện ERP nói khác Viettel Post");

  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(schema.syncRuns)
    .where(and(eq(schema.syncRuns.source, "VIETTELPOST"), eq(schema.syncRuns.status, "RUNNING")));
  console.log(`✓ Sức khoẻ Viettel Post: đóng lần chạy mồ côi (còn ${Number(n)} đang chạy thật) · đối chiếu không đạt ghi PARTIAL · phát hiện ${after.stageMismatch} vận đơn lệch trạng thái`);
}

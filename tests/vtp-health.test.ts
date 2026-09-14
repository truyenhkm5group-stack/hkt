import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { viettelPostHealth } from "@/lib/queries/integrations";
import { clearMemo } from "@/lib/cache";
import { getIntegrationHealth } from "@/lib/queries/integration-health";
import { isJobRunning, runSyncJob, runningJobKeys } from "@/lib/sync/runner";
import { STATEMENT_MAIL_HEARTBEAT_KEY, STATEMENT_MAIL_SILENCE_HOURS, recordStatementMailContact } from "@/lib/integrations/viettelpost/statement-mail";

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

  // ───────── 4. Webhook về mà không đổi được gì phải hiện ra ─────────
  // Ca thật trên production (PKE1511633408): hai webhook 05/09 đều ghi PROCESSED nhưng trạng thái
  // vận đơn vẫn mang mốc từ 02/09 — 30/228 vận đơn ở tình trạng này mà không có chỗ nào báo.
  const truocKhiLech = (await viettelPostHealth()).webhookNotApplied;
  await db.insert(schema.orders).values({ id: "vtp-chua-ap-dung", insertedAt: new Date() });
  const [cham] = await db.insert(schema.shipments)
    .values({ orderId: "vtp-chua-ap-dung", vtpOrderNumber: "PKE-CHUA-AP-DUNG", stage: "PENDING", vtpStatusDate: new Date("2026-09-02T17:00:00Z") })
    .returning({ id: schema.shipments.id });
  await db.insert(schema.shipmentEvents).values({
    shipmentId: cham.id, source: "VTP_WEBHOOK", status: "500", statusName: "Giao bưu tá đi phát",
    occurredAt: new Date("2026-09-05T03:48:44Z"), normalizedStage: "OUT_FOR_DELIVERY",
  });
  const sauKhiLech = await viettelPostHealth();
  assert.equal(sauKhiLech.webhookNotApplied, truocKhiLech + 1, "webhook mới hơn trạng thái đang lưu phải được đếm ra");

  // ───────── Sức khoẻ cho MỌI connector, không chỉ Viettel Post ─────────
  clearMemo();
  const connectors = await getIntegrationHealth();
  assert.deepEqual(
    connectors.map((c) => c.key).sort(),
    ["BANK", "FACEBOOK", "PANCAKE", "VIETTELPOST"],
    "phải theo dõi mọi connector, không chỉ Viettel Post",
  );
  for (const c of connectors) {
    assert.ok(["HEALTHY", "DEGRADED", "DOWN", "UNKNOWN"].includes(c.state), `${c.key}: phải có mức sức khoẻ`);
    assert.ok(c.reason.length > 10, `${c.key}: phải nói được VÌ SAO xếp vào mức đó`);
    assert.ok(c.eventsPerHour >= 0 && c.events24h >= 0);
    assert.ok(c.reprocessHint.length > 20, `${c.key}: phải nói rõ vì sao xử lý lại là an toàn`);
    // Chưa từng nhận gì và chưa từng chạy thì KHÔNG được coi là khoẻ.
    if (!c.lastEventAt && !c.lastReconciliation?.at) assert.equal(c.state, "UNKNOWN", `${c.key}: thiếu căn cứ phải là CHƯA ĐỦ CĂN CỨ, không phải ĐANG CHẠY TỐT`);
    if (c.lastEventAt) assert.ok(c.lagHours !== null, `${c.key}: có sự kiện thì phải đo được độ trễ`);
  }
  const vtpConnector = connectors.find((c) => c.key === "VIETTELPOST")!;
  assert.notEqual(vtpConnector.state, "HEALTHY", "fixture có gói tin kẹt và mã lạ nên Viettel Post không thể là ĐANG CHẠY TỐT");

  await testSoNganHangVaBangKe(db);

    const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(schema.syncRuns)
    .where(and(eq(schema.syncRuns.source, "VIETTELPOST"), eq(schema.syncRuns.status, "RUNNING")));
  // ───────── KHOÁ JOB PHẢI ĐƯỢC NHẢ, KỂ CẢ KHI JOB HỎNG ─────────
  // Khoá nằm trong bộ nhớ tiến trình và chỉ nhả trong `finally`. Nếu một lần chạy hỏng mà khoá
  // không nhả thì job đó KHÔNG CÒN CHẠY ĐƯỢC NỮA cho tới khi khởi động lại container — im lặng và
  // rất khó phát hiện, vì giao diện vẫn báo "đang chạy".
  const key = "VIETTELPOST:test_lock";
  await runSyncJob({ source: "VIETTELPOST", job: "test_lock" }, async () => {
    assert.ok(isJobRunning(key), "trong lúc chạy thì khoá phải đang giữ");
    throw new Error("hỏng có chủ đích");
  }).catch(() => undefined);
  assert.equal(isJobRunning(key), false, "job hỏng vẫn PHẢI nhả khoá, nếu không nó tự chặn chính mình vĩnh viễn");

  // Chạy lại được ngay sau khi hỏng — đó là điều mà việc nhả khoá bảo đảm.
  const lanHai = await runSyncJob({ source: "VIETTELPOST", job: "test_lock" }, async () => "xong");
  assert.equal(lanHai.result, "xong", "sau lần hỏng, job phải chạy lại được ngay");
  assert.equal(isJobRunning(key), false, "chạy xong cũng phải nhả khoá");
  assert.ok(!runningJobKeys().includes(key), "khoá không được sót lại trong danh sách job đang chạy");

  console.log(`✓ Sức khoẻ Viettel Post: đóng lần chạy mồ côi (còn ${Number(n)} đang chạy thật) · đối chiếu không đạt ghi PARTIAL · phát hiện ${after.stageMismatch} vận đơn lệch trạng thái`);
}

/**
 * ═══════════ SỔ NGÂN HÀNG / BẢNG KÊ: IM LẶNG PHẢI GIẢI THÍCH ĐƯỢC ═══════════
 *
 * Ca thật 12/09/2026: thẻ báo "3 ngày trước · trễ 67,6h · Đối chiếu gần nhất: Chưa chạy lần nào"
 * trong khi trình kích hoạt Gmail vẫn chạy đủ mỗi 15 phút. Ba chỗ sai cùng lúc:
 *
 *   1. ô "Đối chiếu gần nhất" được truyền cứng `null` nên không bao giờ hiện lần chạy nào, dù mỗi
 *      lượt Gmail đẩy tệp sang đều ghi một `sync_runs` job `vtp-statement-mail`;
 *   2. mốc "nhận tin" lấy theo `received_at`, mà khoá tự nhiên là TÊN TỆP — gửi lại đúng tệp cũ
 *      thì mốc đứng im dù đường dẫn vẫn chảy;
 *   3. không có nhịp tim nên "Viettel Post chưa gửi bảng kê" và "script đã tắt" trông giống hệt.
 */
async function testSoNganHangVaBangKe(db: Db) {
  const gioTruoc = (h: number) => new Date(Date.now() - h * 3600_000);

  // Tệp bảng kê nhận cách đây 3 ngày, nhưng ĐƯỢC ĐỌC LẠI cách đây 1 giờ (script gửi lại tệp cũ).
  await db.insert(schema.vtpStatementFiles).values({
    filename: "BangKeChiCOD-health.xlsx",
    content: "",
    kind: "STATEMENT_DETAIL",
    actor: "GMAIL:gmail",
    receivedAt: gioTruoc(72),
    lastImportedAt: gioTruoc(1),
  });
  await db.insert(schema.syncRuns).values({
    source: "VIETTELPOST",
    job: "vtp-statement-mail",
    status: "SUCCESS",
    trigger: "WEBHOOK",
    actor: "GMAIL:gmail",
    startedAt: gioTruoc(1),
    finishedAt: gioTruoc(1),
  });

  clearMemo();
  const bank = (await getIntegrationHealth()).find((c) => c.key === "BANK")!;
  assert.ok(bank.lastEventAt, "phải nêu được mốc nhận tin gần nhất");
  assert.ok(
    (bank.lagHours ?? 99) < 2,
    `gửi lại tệp cũ vẫn là một lần nhận: mốc phải theo lần ĐỌC gần nhất, không phải lần đầu thấy tên tệp (đang là ${bank.lagHours}h)`,
  );
  assert.ok(bank.lastReconciliation?.at, "mỗi lượt Gmail đẩy tệp đều ghi sync_runs — không được hiện 'Chưa chạy lần nào'");
  assert.match(bank.reason, /Bảng kê Viettel Post gần nhất/, "phải tách bạch nửa bảng kê để một nửa chết không bị nửa kia che");
  assert.ok(bank.senders?.some((s) => /Bảng kê/.test(s.label)), "phải liệt kê từng đường vào của kết nối tiền");

  // ───────── Nhịp tim: chưa từng báo sống là CHƯA BIẾT, không phải đã chết ─────────
  assert.equal(bank.heartbeat?.at, null, "chưa chạy script bản mới thì chưa có nhịp tim");
  assert.equal(bank.heartbeat?.stale, false, "chưa từng báo sống KHÔNG được suy ra là đã chết");

  await recordStatementMailContact({ actor: "GMAIL:gmail", files: 0, imported: 0, outcome: "PING" });
  clearMemo();
  const conSong = (await getIntegrationHealth()).find((c) => c.key === "BANK")!;
  assert.ok(conSong.heartbeat?.at, "lượt chạy không có thư mới vẫn phải ghi được nhịp tim");
  assert.equal(conSong.heartbeat?.stale, false, "vừa báo sống thì không thể là im lặng");

  // Script tắt: nhịp tim cũ hơn ngưỡng ⇒ hạ mức, kể cả khi dữ liệu cũ vẫn còn nguyên.
  const cu = { at: gioTruoc(STATEMENT_MAIL_SILENCE_HOURS + 1).toISOString(), actor: "GMAIL:gmail", files: 0, imported: 0, outcome: "PING" };
  await db.update(schema.syncState).set({ value: cu }).where(eq(schema.syncState.key, STATEMENT_MAIL_HEARTBEAT_KEY));
  clearMemo();
  const daTat = (await getIntegrationHealth()).find((c) => c.key === "BANK")!;
  assert.equal(daTat.heartbeat?.stale, true, "quá ngưỡng im lặng phải nhận ra");
  assert.notEqual(daTat.state, "HEALTHY", "script lấy bảng kê đã tắt thì kết nối tiền không thể là ĐANG CHẠY TỐT");
  assert.match(daTat.reason, /ngừng liên lạc/, "phải nói rõ vì sao hạ mức");

  console.log(`✓ Sổ ngân hàng / bảng kê: mốc theo lần đọc (${bank.lagHours}h) · hiện được lần chạy vtp-statement-mail · nhịp tim script Gmail phân biệt "chưa có bảng kê" với "script đã tắt"`);
}

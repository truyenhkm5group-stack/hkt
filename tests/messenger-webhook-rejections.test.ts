/**
 * ═══════════ SỔ GÓI WEBHOOK BỊ TỪ CHỐI — platform_webhook_rejections (0251 · M4 mục 4, 21/10/2026) ═══════════
 *
 * Khoá:
 *  1. Gói cùng (nguồn, lý do, phút) CỘNG vào một dòng — gói dồn dập không đẻ thêm dòng; phút khác ⇒ dòng khác.
 *  2. 24 giờ / 7 ngày tính LÚC ĐỌC từ xô phút; quá 7 ngày không vào số; quá 30 ngày bị lượt ghi kế tiếp xoá.
 *  3. Đường ghi KHÔNG BAO GIỜ ném: đầu vào lạ ⇒ false; bảng chưa có ⇒ false; đường đọc bảng chưa có ⇒ null (CHƯA ĐO ≠ 0).
 *  4. `messengerWebhookLog` cộng đúng: gói bị từ chối theo lý do của nó; page lạ theo SỐ page lạ của gói.
 *  5. Sổ không mang mã page / PSID / nội dung — chỉ nguồn + mã lý do + số đếm.
 */
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { noteWebhookRejection, rejectionBucket, WEBHOOK_REJECTION_RETENTION_DAYS, webhookRejectionSummary } from "@/lib/platform/webhook-rejections";
import { messengerWebhookLog } from "@/lib/sales-chatbot/messenger-observability";

const DAY = 86_400_000;

export async function testMessengerWebhookRejections() {
  const pdb = await getPlatformDb();
  const t = schema.platformWebhookRejections;
  const wipe = () => pdb.delete(t).where(eq(t.provider, "MESSENGER"));
  await wipe();
  try {
    const now = new Date("2026-10-21T08:30:20Z");
    assert.equal(rejectionBucket(now).toISOString(), "2026-10-21T08:30:00.000Z", "xô = đầu phút");

    // 1 · cộng dồn theo phút.
    assert.equal(await noteWebhookRejection("MESSENGER", "SIGNATURE", now), true);
    assert.equal(await noteWebhookRejection("MESSENGER", "SIGNATURE", new Date(now.getTime() + 15_000)), true);
    assert.equal(await noteWebhookRejection("MESSENGER", "SIGNATURE", new Date(now.getTime() + 90_000)), true);
    const rows = await pdb.select().from(t).where(eq(t.reason, "SIGNATURE"));
    assert.deepEqual(rows.map((r) => r.count).sort(), [1, 2], "cùng phút ⇒ một dòng count 2; phút sau ⇒ dòng mới");

    // 2 · cửa sổ đọc + hạn giữ.
    await noteWebhookRejection("MESSENGER", "NOT_JSON", new Date(now.getTime() - 3 * DAY));
    await noteWebhookRejection("MESSENGER", "NOT_JSON", new Date(now.getTime() - 9 * DAY));
    const sum = await webhookRejectionSummary("MESSENGER", now);
    assert.ok(sum);
    assert.deepEqual(sum.map((r) => [r.reason, r.count24h, r.count7d]), [["SIGNATURE", 3, 3], ["NOT_JSON", 0, 1]], "24 giờ / 7 ngày lúc đọc; quá 7 ngày không vào số; nặng 24 giờ đứng trước");
    assert.equal(sum[0].lastAt, new Date(now.getTime() + 90_000).toISOString(), "lần cuối = gói muộn nhất");
    await pdb.insert(t).values({ provider: "MESSENGER", reason: "BODY_TOO_LARGE", bucket: rejectionBucket(new Date(now.getTime() - (WEBHOOK_REJECTION_RETENTION_DAYS + 1) * DAY)), count: 4 });
    await noteWebhookRejection("MESSENGER", "SIGNATURE", now);
    assert.equal((await pdb.select().from(t).where(eq(t.reason, "BODY_TOO_LARGE"))).length, 0, `xô quá ${WEBHOOK_REJECTION_RETENTION_DAYS} ngày bị lượt ghi kế tiếp xoá`);
    assert.equal((await pdb.select().from(t).where(eq(t.reason, "NOT_JSON"))).length, 2, "xô 9 ngày (trong hạn giữ) vẫn còn");

    // 3 · không bao giờ ném.
    for (const bad of ["", "chu-thuong", "PAGE 123", "A".repeat(50)]) assert.equal(await noteWebhookRejection("MESSENGER", bad, now), false, `lý do lạ «${bad.slice(0, 12)}» ⇒ false`);
    assert.equal(await noteWebhookRejection("MESSENGER", "SIGNATURE", now, 0), false, "số đếm < 1 ⇒ false");
    await pdb.execute(sql`ALTER TABLE platform_webhook_rejections RENAME TO platform_webhook_rejections_tam`);
    try {
      assert.equal(await noteWebhookRejection("MESSENGER", "SIGNATURE", now), false, "bảng chưa có ⇒ false, KHÔNG ném");
      assert.equal(await webhookRejectionSummary("MESSENGER", now), null, "bảng chưa có ⇒ null (CHƯA ĐO), không phải []");
      await messengerWebhookLog("messenger_webhook_rejected", { reason: "SIGNATURE" });
    } finally {
      await pdb.execute(sql`ALTER TABLE platform_webhook_rejections_tam RENAME TO platform_webhook_rejections`);
    }
    await wipe();
    assert.deepEqual(await webhookRejectionSummary("MESSENGER", now), [], "đo được mà không gói nào ⇒ []");

    // 4 · đường log cộng đúng.
    await messengerWebhookLog("messenger_webhook_rejected", { reason: "SIGNATURE" });
    await messengerWebhookLog("messenger_webhook_anomaly", { events: 3, queued: 1, duplicates: 0, ignored: 0, unknownPages: ["3000000001", "3000000002"] });
    await messengerWebhookLog("messenger_webhook_anomaly", { events: 2, queued: 0, duplicates: 2, ignored: 0, unknownPages: [] });
    await messengerWebhookLog("messenger_process_failed", { org: "x", pageId: "3000000001", stage: "SEND", error: "lỗi" });
    const live = await webhookRejectionSummary("MESSENGER");
    assert.deepEqual(live?.map((r) => [r.reason, r.count24h]).sort(), [["SIGNATURE", 1], ["UNKNOWN_PAGE", 2]], "rejected theo lý do; page lạ theo số page; trùng / lỗi xử lý KHÔNG vào sổ");

    // 5 · không mã page / PSID / nội dung trong sổ.
    const cols = Object.keys((await pdb.select().from(t))[0] ?? {});
    assert.deepEqual(cols.sort(), ["bucket", "count", "lastAt", "provider", "reason"]);
    assert.ok(!JSON.stringify(await pdb.select().from(t)).includes("3000000001"), "mã page không vào sổ");
    console.log("✓ Sổ gói webhook bị từ chối: cộng theo phút · 24 giờ / 7 ngày lúc đọc · giữ 30 ngày · không ném, chưa đo ≠ 0 · log cộng đúng lý do / số page lạ · không mã page");
  } finally {
    await wipe();
  }
}

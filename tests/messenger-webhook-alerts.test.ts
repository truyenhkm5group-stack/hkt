/**
 * ═══════════ CẢNH BÁO WEBHOOK MESSENGER — NGƯỠNG CHỦ SHOP DUYỆT 21/10/2026 ═══════════
 * Khoá: biên ngưỡng (SIGNATURE 20 ⇒ không báo, 21 ⇒ báo; ORG_LOOKUP_FAILED 0 ⇒ không, 1 ⇒ báo NGAY) · MỘT tin mỗi ngày giờ Việt Nam
 * mỗi loại · đường ghi sổ tự báo (không cần job) · không bao giờ ném.
 */
import assert from "node:assert/strict";
import { and, eq, like } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { messengerWebhookAlertKey, messengerWebhookAlertsDue, vnDay } from "@/lib/constants/messenger-webhook-alerts";
import { alertWebhookRejections, noteWebhookRejection, resetWebhookAlertThrottleForTests } from "@/lib/platform/webhook-rejections";

export async function testMessengerWebhookAlerts() {
  // Hàm thuần — biên.
  const due = (rows: { reason: string; count24h: number }[]) => messengerWebhookAlertsDue(rows).map((d) => d.rule.reason);
  assert.deepEqual(due([{ reason: "SIGNATURE", count24h: 20 }]), [], "SIGNATURE 20 / 24 giờ ⇒ CHƯA báo (ngưỡng là > 20)");
  assert.deepEqual(due([{ reason: "SIGNATURE", count24h: 21 }]), ["SIGNATURE"], "SIGNATURE 21 ⇒ báo");
  assert.deepEqual(due([{ reason: "ORG_LOOKUP_FAILED", count24h: 0 }]), []);
  assert.deepEqual(due([{ reason: "ORG_LOOKUP_FAILED", count24h: 1 }]), ["ORG_LOOKUP_FAILED"], "≥ 1 không tra được page ⇒ báo ngay");
  assert.deepEqual(due([{ reason: "NOT_JSON", count24h: 999 }, { reason: "UNKNOWN_PAGE", count24h: 999 }]), [], "lý do khác không có ngưỡng ⇒ không báo");
  assert.equal(vnDay(new Date("2026-10-21T16:59:59Z")), "2026-10-21");
  assert.equal(vnDay(new Date("2026-10-21T17:00:00Z")), "2026-10-22", "ngày theo giờ Việt Nam (UTC+7)");

  const pdb = await getPlatformDb();
  const wipe = async () => {
    await pdb.delete(schema.platformWebhookRejections).where(eq(schema.platformWebhookRejections.provider, "MESSENGER"));
    await pdb.delete(schema.notifications).where(like(schema.notifications.dedupeKey, "messenger-webhook:%"));
  };
  const alerts = () => pdb.select().from(schema.notifications).where(like(schema.notifications.dedupeKey, "messenger-webhook:%"));
  await wipe();
  resetWebhookAlertThrottleForTests();
  try {
    // Mốc CỐ ĐỊNH (17:00 giờ Việt Nam) — mọi phép trong bài nhận `now` làm tham số (ghi sổ, đọc 24 giờ, khoá ngày), không cửa sổ nào
    // đọc đồng hồ thật (AGENTS mục 50) ⇒ «ngày mới» luôn là ngày mới, không tuỳ giờ chạy.
    const now = new Date("2026-10-21T10:00:00Z");
    // 20 gói sai chữ ký ⇒ chưa báo; gói thứ 21 ⇒ báo (đường ghi tự kiểm — không cần job).
    assert.equal(await noteWebhookRejection("MESSENGER", "SIGNATURE", now, 20), true);
    assert.equal((await alerts()).length, 0, "20 gói ⇒ chưa có cảnh báo");
    resetWebhookAlertThrottleForTests();
    assert.equal(await noteWebhookRejection("MESSENGER", "SIGNATURE", now), true);
    const a1 = await alerts();
    assert.equal(a1.length, 1, "gói thứ 21 ⇒ một cảnh báo");
    assert.ok(a1[0].dedupeKey === messengerWebhookAlertKey("SIGNATURE", now) && a1[0].severity === "critical" && a1[0].kind === "SYSTEM" && a1[0].href === "/platform" && /21 gói sai chữ ký/.test(a1[0].title), JSON.stringify(a1[0]));

    // Cùng ngày: thêm gói ⇒ KHÔNG thêm tin.
    resetWebhookAlertThrottleForTests();
    await noteWebhookRejection("MESSENGER", "SIGNATURE", now, 5);
    assert.deepEqual(await alertWebhookRejections("MESSENGER", now), [], "một tin / ngày / loại");
    assert.equal((await alerts()).length, 1);

    // ORG_LOOKUP_FAILED: MỘT gói ⇒ báo ngay, loại riêng.
    resetWebhookAlertThrottleForTests();
    await noteWebhookRejection("MESSENGER", "ORG_LOOKUP_FAILED", now);
    assert.ok((await alerts()).some((x) => x.dedupeKey === messengerWebhookAlertKey("ORG_LOOKUP_FAILED", now)), "một gói không tra được page ⇒ báo ngay");

    // Ngày Việt Nam sau (sổ vẫn còn trong 24 giờ) ⇒ được báo lại một lần.
    const tomorrow = new Date(now.getTime() + 20 * 3_600_000);
    assert.notEqual(vnDay(tomorrow), vnDay(now));
    const again = await alertWebhookRejections("MESSENGER", tomorrow);
    assert.ok(again.includes(messengerWebhookAlertKey("SIGNATURE", tomorrow)), `ngày mới ⇒ một tin mới: ${JSON.stringify(again)}`);

    // Trần tần suất: lượt kiểm thứ hai trong cùng phút bị bỏ qua (ghi sổ vẫn được).
    await pdb.delete(schema.notifications).where(and(like(schema.notifications.dedupeKey, "messenger-webhook:%")));
    await noteWebhookRejection("MESSENGER", "ORG_LOOKUP_FAILED", now);
    assert.equal((await alerts()).length, 0, "trong một phút kể từ lượt kiểm trước ⇒ không kiểm lại (chặn bão)");
    console.log("✓ Cảnh báo webhook Messenger: SIGNATURE 20 không báo / 21 báo · ORG_LOOKUP_FAILED 1 báo ngay · một tin mỗi ngày giờ Việt Nam mỗi loại · đường ghi tự báo, có trần tần suất");
  } finally {
    await wipe();
    resetWebhookAlertThrottleForTests();
  }
}

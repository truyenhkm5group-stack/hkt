/**
 * ═══════════ PANCAKE QUA API — LỊCH ĐỒNG BỘ (lib/sales-chatbot/pancake-poll-shared.ts) — THUẦN ═══════════
 *
 * Khoá: chưa có mốc ⇒ đọc 30 phút; có mốc ⇒ đọc từ mốc trừ 2 phút chồng lấn (không quá 30 phút); webhook có tin trong 2 giờ
 * ⇒ lưới an toàn (5 hội thoại), không ⇒ chế độ API (25); lỗi / 429 ⇒ lùi 5 → 10 → 20 … trần 60 phút, đạt ⇒ xoá bộ đếm;
 * mốc KHÔNG vượt «bây giờ − 60 giây» và không vượt hội thoại chưa kịp đọc; page yên 6 giờ ⇒ 15 phút mới hỏi một lần;
 * đổi page ⇒ trạng thái page cũ không dùng; ghi mốc webhook thưa (5 phút một lần).
 * Phần chạy trên tổ chức thật (mốc lưu CSDL, webhook + API cùng một tin, 429 dừng gọi Pancake) ở tests/self-service-journey.test.ts.
 */
import assert from "node:assert/strict";
import { afterPoll, EMPTY_POLL_STATE, noteWebhook, PANCAKE_POLL, parsePollState, pollDecision, type PancakePollState } from "@/lib/sales-chatbot/pancake-poll-shared";

export function testPancakePoll() {
  const now = Date.parse("2026-10-05T10:00:00Z");
  const base: PancakePollState = { ...EMPTY_POLL_STATE, pageId: "p1" };

  const first = pollDecision(base, now);
  assert.ok(first.run && first.mode === "API" && first.threadBudget === PANCAKE_POLL.threadsApi && first.windowStartMs === now - PANCAKE_POLL.windowMs, JSON.stringify(first));
  const withCursor = pollDecision({ ...base, cursorMs: now - 5 * 60_000, lastActivityAt: now - 60_000, lastOkAt: now - 5 * 60_000 }, now);
  assert.ok(withCursor.run && withCursor.windowStartMs === now - 7 * 60_000, "đọc từ mốc trừ 2 phút chồng lấn");
  const oldCursor = pollDecision({ ...base, cursorMs: now - 5 * 3_600_000 }, now);
  assert.ok(oldCursor.run && oldCursor.windowStartMs === now - PANCAKE_POLL.windowMs, "mốc quá cũ ⇒ không đọc quá 30 phút (tin cũ hơn không còn được trả lời bù)");
  const hooked = pollDecision({ ...base, lastWebhookAt: now - 3_600_000 }, now);
  assert.ok(hooked.run && hooked.mode === "SAFETY_NET" && hooked.threadBudget === PANCAKE_POLL.threadsSafetyNet, "webhook có tin trong 2 giờ ⇒ lưới an toàn");
  assert.ok(pollDecision({ ...base, lastWebhookAt: now - 3 * 3_600_000 }, now).run && (pollDecision({ ...base, lastWebhookAt: now - 3 * 3_600_000 }, now) as { mode: string }).mode === "API", "webhook im 3 giờ ⇒ chế độ API, không đợi webhook");

  // Lỗi / 429 ⇒ lùi dần có trần; trong lúc lùi KHÔNG hỏi.
  let s = afterPoll(base, { ok: false, rateLimited: true, error: "x" }, now);
  assert.ok(s.failures === 1 && s.nextAllowedAt === now + 5 * 60_000 && /429/.test(s.lastError ?? ""), JSON.stringify(s));
  assert.equal(pollDecision(s, now + 60_000).run, false, "đang lùi ⇒ không gọi Pancake");
  s = afterPoll(s, { ok: false, rateLimited: false, error: "x" }, now);
  assert.equal(s.nextAllowedAt, now + 10 * 60_000);
  for (let i = 0; i < 10; i++) s = afterPoll(s, { ok: false, rateLimited: false, error: "x" }, now);
  assert.equal(s.nextAllowedAt, now + PANCAKE_POLL.backoffMaxMs, "trần 60 phút");
  const ok = afterPoll(s, { ok: true, listed: 3, maxUpdatedMs: now - 10_000, oldestUnprocessedMs: null, allNewerThanWindow: false }, now);
  assert.ok(ok.failures === 0 && ok.nextAllowedAt === null && ok.lastError === null, "lượt đạt ⇒ xoá bộ đếm");
  assert.equal(ok.cursorMs, now - PANCAKE_POLL.minAgeMs, "mốc không vượt (bây giờ − 60 giây): tin quá mới lượt sau phải còn thấy");
  const partial = afterPoll(base, { ok: true, listed: 40, maxUpdatedMs: now - 2 * 60_000, oldestUnprocessedMs: now - 9 * 60_000, allNewerThanWindow: false }, now);
  assert.equal(partial.cursorMs, now - 9 * 60_000 - 1, "hết ngân sách ⇒ mốc dừng TRƯỚC hội thoại chưa đọc");
  assert.equal(afterPoll({ ...base, cursorMs: now - 60_000 }, { ok: true, listed: 0, maxUpdatedMs: null, oldestUnprocessedMs: null, allNewerThanWindow: false }, now).cursorMs, now - 60_000, "không có hội thoại ⇒ mốc không lùi");
  assert.equal(afterPoll(base, { ok: true, listed: PANCAKE_POLL.listLimit, maxUpdatedMs: now - 120_000, oldestUnprocessedMs: null, allNewerThanWindow: true }, now).truncated, true, "danh sách đầy và đều mới ⇒ báo có thể sót");

  // Page yên ⇒ hỏi thưa.
  const idle = { ...base, lastActivityAt: now - 7 * 3_600_000, lastOkAt: now - 5 * 60_000 };
  assert.equal(pollDecision(idle, now).run, false);
  assert.equal(pollDecision({ ...idle, lastOkAt: now - 16 * 60_000 }, now).run, true, "15 phút sau vẫn hỏi");

  // Đổi page ⇒ trạng thái cũ không dùng; giá trị lạ bị bỏ.
  assert.deepEqual(parsePollState({ ...ok, pageId: "p1" }, "p2"), { ...EMPTY_POLL_STATE, pageId: "p2" });
  assert.equal(parsePollState({ pageId: "p1", cursorMs: "x", failures: -3 }, "p1").cursorMs, null);
  assert.equal(parsePollState({ pageId: "p1", failures: -3 }, "p1").failures, 0);

  // Mốc webhook ghi thưa.
  const w = noteWebhook(base, now);
  assert.ok(w && w.lastWebhookAt === now);
  assert.equal(noteWebhook(w!, now + 60_000), null, "trong 5 phút không ghi lại");
  assert.ok(noteWebhook(w!, now + 6 * 60_000));
  assert.ok(!JSON.stringify(ok).includes("token"), "trạng thái không mang bí mật nào");
  console.log("✓ Pancake qua API · lịch đồng bộ: mốc + chồng lấn 2 phút, trần 30 phút · webhook sống ⇒ lưới an toàn, im ⇒ chế độ API · lỗi / 429 lùi 5→10→…→60 phút, trong lúc lùi không gọi · mốc không vượt (bây giờ − 60 giây) và không vượt hội thoại chưa đọc · page yên hỏi thưa · đổi page bỏ trạng thái cũ · mốc webhook ghi thưa");
}

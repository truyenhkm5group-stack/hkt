/**
 * ═══════════ BOT HSLC SÓT TIN VÌ PANCAKE 429 (10/10/2026) ═══════════
 *
 * Đo production (ops `org-order-audit --replies`): sáng 10/10 có 39/145 tin khách bot ĐÃ soạn câu trả lời mà Pancake trả «Too many
 * requests» lúc gửi ⇒ tin DEAD, không gửi lại, trong khi hộp thư vẫn hiện bong bóng «Bot» (dòng BOT_SENT ghi TRƯỚC khi gửi).
 *
 *  · 429 ⇒ gửi lại ĐÚNG đoạn đó (chờ 3 · 8 · 15 giây, Retry-After thắng); lỗi khác ⇒ KHÔNG gửi lại (có thể đã tới nơi).
 *  · Kết quả gửi hỏng nói rõ đã gửi bao nhiêu đoạn (để xoá đúng dòng ghi sẵn của phần CHƯA tới khách) và có phải 429.
 *  · 429 ⇒ đường đọc nền (nhập lịch sử) nhường hạn mức của page cho lời gửi của bot.
 *  · Gửi bù: đọc `state.pendingSend` an toàn; bỏ khi quá giờ / hết lượt / khách nhắn thêm / page đã trả lời / người đang cầm.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fanpageBotSendersForTests, isPancakeRateLimited, pendingSendOf, RESEND_MAX_TRIES, RESEND_WINDOW_MS, resendVerdict, SEND_RATE_LIMIT_WAITS_MS } from "@/lib/sales-chatbot/fanpage";
import { noteSendRateLimited, resetSendPressureForTests, SEND_PRIORITY_MS, sendRecentlyLimited } from "@/lib/sales-chatbot/pancake-send-pressure";

type Reply = { status: number; body: Record<string, unknown>; retryAfter?: string };

function fakePancake(script: Reply[]) {
  const calls: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(String((JSON.parse(String(init?.body ?? "{}")) as { message?: string }).message ?? ""));
    const r = script.shift() ?? { status: 200, body: { success: true, id: `m-${calls.length}` } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", ...(r.retryAfter ? { "retry-after": r.retryAfter } : {}) } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const TOO_MANY: Reply = { status: 200, body: { success: false, message: "Too many requests" } };

export async function testPancakeSendRetry() {
  assert.equal(isPancakeRateLimited(429, ""), true);
  assert.equal(isPancakeRateLimited(200, "Too many requests"), true, "Pancake trả 429 trong phong bì, HTTP 200");
  assert.equal(isPancakeRateLimited(400, "(#551) Người này hiện không có mặt."), false);
  assert.equal(isPancakeRateLimited(200, "(#10) Tin nhắn này được gửi ngoài khoảng thời gian cho phép"), false);

  const send = fanpageBotSendersForTests.sendInbox;
  // (a) 429 hai lần rồi nhận ⇒ GỬI ĐƯỢC, đúng một tin tới khách, chờ 3 rồi 8 giây.
  resetSendPressureForTests();
  {
    const waits: number[] = [];
    const p = fakePancake([TOO_MANY, { status: 429, body: {} }]);
    const r = await send("pg-retry", "th-1", "Dạ chả cá thu 280.000đ/kg ạ", p.fetchImpl, "STAFF", async (ms) => void waits.push(ms));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(p.calls.length, 3, "hai lần bị từ chối + một lần nhận");
    assert.deepEqual(waits, [SEND_RATE_LIMIT_WAITS_MS[0], SEND_RATE_LIMIT_WAITS_MS[1]]);
    assert.equal(sendRecentlyLimited("pg-retry"), true, "429 ⇒ báo cho đường đọc nền nhường");
    assert.equal(sendRecentlyLimited("pg-khac"), false, "chỉ đúng page bị giới hạn");
  }
  // (b) Retry-After của Pancake thắng (trần 20 giây).
  {
    const waits: number[] = [];
    const p = fakePancake([{ status: 429, body: {}, retryAfter: "60" }]);
    assert.equal((await send("pg-retry", "th-1", "Dạ", p.fetchImpl, "STAFF", async (ms) => void waits.push(ms))).ok, true);
    assert.deepEqual(waits, [20_000]);
  }
  // (c) 429 mãi ⇒ hỏng, rateLimited, 0 đoạn đã gửi, đúng 1 + 3 lần gọi (không bão request).
  {
    const p = fakePancake([TOO_MANY, TOO_MANY, TOO_MANY, TOO_MANY, TOO_MANY]);
    const r = await send("pg-retry", "th-1", "Dạ", p.fetchImpl, "STAFF", async () => undefined);
    assert.deepEqual(r, { ok: false, error: "Pancake không nhận tin: Too many requests", sentParts: 0, rateLimited: true });
    assert.equal(p.calls.length, 1 + SEND_RATE_LIMIT_WAITS_MS.length);
  }
  // (d) Câu dài hai đoạn: đoạn 1 tới, đoạn 2 bị 429 mãi ⇒ sentParts = 1 (chỉ xoá dòng ghi sẵn của đoạn 2).
  {
    const p = fakePancake([{ status: 200, body: { success: true, id: "p1" } }, TOO_MANY, TOO_MANY, TOO_MANY, TOO_MANY]);
    const r = await send("pg-retry", "th-1", `${"a".repeat(1990)} ${"b".repeat(500)}`, p.fetchImpl, "STAFF", async () => undefined);
    assert.equal(!r.ok && r.sentParts, 1, JSON.stringify(r));
    assert.equal(!r.ok && r.rateLimited, true);
  }
  // (e) Lỗi KHÁC 429 ⇒ không gửi lại (lời gọi có thể đã tới nơi / khách không nhận được tin của page).
  {
    const p = fakePancake([{ status: 400, body: { success: false, message: "(#551) Người này hiện không có mặt." } }]);
    const r = await send("pg-retry", "th-1", "Dạ", p.fetchImpl, "STAFF", async () => assert.fail("không được chờ để gửi lại"));
    assert.deepEqual(r, { ok: false, error: "Pancake không nhận tin: (#551) Người này hiện không có mặt.", sentParts: 0, rateLimited: false });
    assert.equal(p.calls.length, 1);
  }
  // (f) Mốc nhường hết hạn sau SEND_PRIORITY_MS.
  resetSendPressureForTests();
  noteSendRateLimited("pg-x", 1_000);
  assert.equal(sendRecentlyLimited("pg-x", 1_000 + SEND_PRIORITY_MS - 1), true);
  assert.equal(sendRecentlyLimited("pg-x", 1_000 + SEND_PRIORITY_MS), false);
  resetSendPressureForTests();

  // Gửi bù — đọc state an toàn + phán quyết.
  assert.equal(pendingSendOf({}), null);
  assert.equal(pendingSendOf({ pendingSend: { texts: [], at: "2026-10-10T02:00:00Z" } }), null, "không có câu nào ⇒ không có gì gửi bù");
  assert.equal(pendingSendOf({ pendingSend: { texts: ["Dạ"], at: "hôm qua" } }), null);
  const ps = pendingSendOf({ pendingSend: { texts: ["Dạ chả cá 280k ạ", 7, ""], inboundIds: ["i1", null], at: "2026-10-10T02:00:00Z", tries: 1 } });
  assert.deepEqual(ps, { texts: ["Dạ chả cá 280k ạ"], inboundIds: ["i1"], at: "2026-10-10T02:00:00Z", tries: 1 });
  const at = Date.parse("2026-10-10T02:00:00Z");
  const free = { newerCustomer: false, pageReplied: false, humanHolds: false };
  assert.equal(resendVerdict(ps!, at + 60_000, free), "SEND");
  assert.equal(resendVerdict(ps!, at + RESEND_WINDOW_MS + 1, free), "STALE", "hội thoại đã nguội ⇒ không nhắn bù");
  assert.equal(resendVerdict({ ...ps!, tries: RESEND_MAX_TRIES }, at + 60_000, free), "TRIES");
  assert.equal(resendVerdict(ps!, at + 60_000, { ...free, newerCustomer: true }), "SUPERSEDED", "khách nhắn thêm ⇒ lượt mới trả lời theo ngữ cảnh mới, không gửi câu cũ");
  assert.equal(resendVerdict(ps!, at + 60_000, { ...free, pageReplied: true }), "ANSWERED");
  assert.equal(resendVerdict(ps!, at + 60_000, { ...free, humanHolds: true }), "HUMAN");

  // Mã nguồn: nhập lịch sử nhường trước MỖI lời đọc Pancake; job 5 phút + sau webhook đều chạy gửi bù; gửi hỏng xoá dòng ghi sẵn.
  const history = readFileSync("lib/sales-chatbot/history.ts", "utf8");
  assert.equal((history.match(/const yielded = await yieldToBot\(\);\s+if \(yielded\) return yielded;\s+const r = await pancakeGet\(/g) ?? []).length, 2, "hai chỗ đọc Pancake của nhập lịch sử đều nhường bot");
  assert.match(readFileSync("lib/sync/jobs.ts", "utf8"), /await resendPendingFanpageReplies\(\)/);
  const fp = readFileSync("lib/sales-chatbot/fanpage.ts", "utf8");
  assert.match(fp, /await resendPendingFanpageReplies\(deps\);\s+return stale\.length;/, "sau mỗi webhook");
  assert.match(fp, /if \(sent\.sentParts < preIds\.length\) await db\.delete\(t\)\.where\(inArray\(t\.messageId, preIds\.slice\(sent\.sentParts\)\)\);/, "câu chưa tới khách không được nằm lại hộp thư như đã gửi");
  console.log("✓ Pancake 429: gửi lại đúng đoạn bị từ chối (3 · 8 · 15 s, Retry-After thắng) · lỗi khác không gửi lại · nhập lịch sử nhường bot · gửi bù có điều kiện");
}

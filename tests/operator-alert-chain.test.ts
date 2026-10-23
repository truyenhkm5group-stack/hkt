/**
 * ═══ P0 CẠN CREDIT AI (24/10/2026): BÁO TỚI ĐƯỢC NGƯỜI — CHUỖI LÙI KÊNH + VẾT GỬI + BANNER + RÀO BENCH ═══
 *
 * Đo 23/10/2026: `sales-health` phát hiện hslc AI = CRITICAL · CREDIT lúc 19:52Z (2′ sau lỗi đầu) — phát hiện không chậm; nhưng
 * kết quả gửi tin cho nhóm VNX không truy được, và Lark hỏng thì không lùi sang Telegram. Khoá:
 *  1. chuỗi kênh thử LẦN LƯỢT, dừng ở kênh đầu tiên nhận; Lark FAILED ⇒ Telegram SENT; mọi kênh hỏng ⇒ FAILED kèm lỗi đã che;
 *  2. vết theo (tổ chức, khoá chống trùng) ở CSDL nhà; lượt kế thử lại tin FAILED, KHÔNG gửi lại tin đã SENT, khoá không lẫn giữa
 *     hai tổ chức; CSDL chưa áp 0259 ⇒ vẫn gửi, chỉ thiếu vết (SERVE-COMPAT);
 *  3. banner / rào đọc ĐÚNG gương platform_org_health (AI · CRITICAL · lớp cần người), không câu đếm mới, không ngưỡng mới;
 *  4. rào bench / probe: CREDIT đang mở ⇒ từ chối (exit 3) TRƯỚC mọi lời gọi AI; đọc không được ⇒ cũng từ chối.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { benchGuard, listAiProviderIncidents, type AiProviderIncident } from "@/lib/ai-usage/credit-incidents";
import { deliverThroughChain, readOperatorAlertResult, recordOperatorAlert, redactChannelError, type ChannelAttempt } from "@/lib/platform/operator-alerts";
import { notifyPlatformOperator, retryFailedOperatorAlert, type OperatorChannelSource } from "@/lib/sales-chatbot/alerts";

const P = "opal-";

/** Kênh giả: đếm số lần được gọi, trả kết quả theo kịch bản. */
function fake(channel: ChannelAttempt["channel"], script: (() => { ok: boolean; error?: string })[]) {
  let i = 0;
  const calls = { n: 0 };
  const attempt: ChannelAttempt = {
    channel,
    send: async () => {
      calls.n++;
      const step = script[Math.min(i++, script.length - 1)];
      return step();
    },
  };
  return { attempt, calls };
}
const ok = () => ({ ok: true });
const bad = (error: string) => () => ({ ok: false, error });

async function testChain() {
  const lark = fake("LARK_MANAGER", [bad("HTTP 403 https://open.larksuite.com/open-apis/bot/v2/hook/abcdefabcdefabcdefabcdefabcdefab")]);
  const tg = fake("TELEGRAM", [ok]);
  const r = await deliverThroughChain([lark.attempt, tg.attempt]);
  assert.deepEqual([r.result, r.channel, r.errors.map((e) => e.channel)], ["SENT", "TELEGRAM", ["LARK_MANAGER"]], "Lark FAILED ⇒ lùi sang Telegram");
  assert.ok(!r.errors[0].error.includes("larksuite") && r.errors[0].error.includes("<url>"), `lỗi lưu đã che URL webhook: ${r.errors[0].error}`);

  const first = fake("LARK_MANAGER", [ok]);
  const never = fake("TELEGRAM", [ok]);
  assert.equal((await deliverThroughChain([first.attempt, never.attempt])).channel, "LARK_MANAGER");
  assert.equal(never.calls.n, 0, "kênh đầu đã nhận ⇒ KHÔNG gửi trùng sang kênh sau");

  assert.deepEqual(await deliverThroughChain([]), { result: "NO_CHANNEL", channel: null, errors: [] });
  const throws: ChannelAttempt = { channel: "LARK", send: async () => Promise.reject(new Error("ETIMEDOUT")) };
  const allBad = await deliverThroughChain([throws, fake("TELEGRAM", [bad("chat not found")]).attempt]);
  assert.deepEqual([allBad.result, allBad.errors.length], ["FAILED", 2], "mọi kênh hỏng ⇒ FAILED, lỗi từng kênh (kể cả ném)");
  assert.equal(redactChannelError("token 1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA hỏng"), "token <token> hỏng");
}

async function testTrail() {
  const pdb = await getPlatformDb();
  const t = schema.platformOperatorAlerts;
  const key = "sales-health:new:PROVIDER:2026-10-23T19:52:00.000Z+0";
  const A = `${P}a`;
  const B = `${P}b`;
  const channels = (scripts: Record<string, ReturnType<typeof fake>>): OperatorChannelSource => async () => Object.values(scripts).map((s) => s.attempt);

  // Lượt 1: cả hai kênh hỏng ⇒ FAILED, có vết.
  const l1 = fake("LARK_MANAGER", [bad("HTTP 500"), ok]);
  const t1 = fake("TELEGRAM", [bad("ETIMEDOUT"), ok]);
  const src = channels({ l1, t1 });
  assert.equal(await notifyPlatformOperator("🔴 AI bán hàng: Đang hỏng — tổ chức A", ["🔴 Nhà cung cấp AI: hết tiền"], { dedupeKey: key, orgCode: A, channels: src }), "FAILED");
  assert.equal(await readOperatorAlertResult(A, key), "FAILED");
  // Lượt kế (5 phút): thử lại tin FAILED ⇒ lần này Lark nhận.
  assert.equal(await retryFailedOperatorAlert(A, key, "🔴 AI bán hàng: Đang hỏng — tổ chức A", ["…"], src), "SENT");
  const [row] = await pdb.select().from(t).where(and(eq(t.orgCode, A), eq(t.dedupeKey, key)));
  assert.deepEqual([row.result, row.channel, row.attempts], ["SENT", "LARK_MANAGER", 2], "vết: SENT qua Lark quản lý, 2 lượt thử");
  // Lượt sau nữa: đã SENT ⇒ KHÔNG gửi lại (cả hai đường).
  const before = l1.calls.n + t1.calls.n;
  assert.equal(await retryFailedOperatorAlert(A, key, "x", ["x"], src), null);
  assert.equal(await notifyPlatformOperator("x", ["x"], { dedupeKey: key, orgCode: A, channels: src }), "SENT");
  assert.equal(l1.calls.n + t1.calls.n, before, "tin đã SENT không bị gửi lần hai");
  assert.equal((await pdb.select().from(t).where(and(eq(t.orgCode, A), eq(t.dedupeKey, key))))[0].attempts, 2, "không thêm lượt thử nào");

  // Cùng khoá quyết định ở tổ chức KHÁC là một tin khác.
  const lb = fake("LARK_MANAGER", [ok]);
  assert.equal(await notifyPlatformOperator("B", ["B"], { dedupeKey: key, orgCode: B, channels: channels({ lb }) }), "SENT");
  assert.equal(lb.calls.n, 1, "khoá vết kèm mã tổ chức — tin của B không bị coi là «đã báo» vì A");
  // Chưa có vết / NO_CHANNEL ⇒ lượt thử lại không gửi gì.
  assert.equal(await retryFailedOperatorAlert(A, "khoa-chua-co", "x", ["x"], channels({ lb })), null);
  await recordOperatorAlert({ orgCode: A, dedupeKey: "nochan", title: "x", outcome: { result: "NO_CHANNEL", channel: null, errors: [] } });
  assert.equal(await retryFailedOperatorAlert(A, "nochan", "x", ["x"], channels({ lb })), null);
  assert.equal(lb.calls.n, 1);
  // Tin KHÔNG mang khoá ⇒ không ghi vết (hai đường cũ: hạn mức gói, ngưỡng khách AI).
  assert.equal(await notifyPlatformOperator("không khoá", ["x"], { channels: channels({ lb }) }), "SENT");

  // SERVE-COMPAT 0259: chưa có bảng ⇒ vẫn gửi qua chuỗi, chỉ thiếu vết.
  await pdb.execute(sql.raw(`ALTER TABLE platform_operator_alerts RENAME TO platform_operator_alerts_tam`));
  try {
    const lc = fake("TELEGRAM", [ok]);
    assert.equal(await notifyPlatformOperator("x", ["x"], { dedupeKey: "k2", orgCode: A, channels: channels({ lc }) }), "SENT");
    assert.equal(lc.calls.n, 1, "chưa áp 0259 ⇒ tin vẫn đi");
    assert.equal(await readOperatorAlertResult(A, "k2"), null);
    assert.equal(await retryFailedOperatorAlert(A, "k2", "x", ["x"], channels({ lc })), null);
  } finally {
    await pdb.execute(sql.raw(`ALTER TABLE platform_operator_alerts_tam RENAME TO platform_operator_alerts`));
  }
  await pdb.delete(t).where(sql`${t.orgCode} like ${`${P}%`}`);
}

async function testIncidentsAndGuard() {
  const pdb = await getPlatformDb();
  const h = schema.platformOrgHealth;
  const since = new Date("2026-10-23T19:52:00Z");
  await pdb.insert(h).values([
    { orgCode: `${P}cr`, checkKey: "AI", level: "CRITICAL", lastReason: "CREDIT", since, measuredAt: new Date(), detail: "nhà cung cấp: CRITICAL (14 lỗi gần đây)" },
    { orgCode: `${P}au`, checkKey: "AI", level: "CRITICAL", lastReason: "AUTH", since },
    { orgCode: `${P}wa`, checkKey: "AI", level: "WARNING", lastReason: "CREDIT", since },
    { orgCode: `${P}rl`, checkKey: "AI", level: "CRITICAL", lastReason: "RATE_LIMIT", since },
    { orgCode: `${P}qu`, checkKey: "QUOTA", level: "CRITICAL", lastReason: "CREDIT", since },
  ]);
  try {
    const mine = (await listAiProviderIncidents()).filter((i) => i.orgCode.startsWith(P));
    assert.deepEqual(mine.map((i) => [i.orgCode, i.reason]).sort(), [[`${P}au`, "AUTH"], [`${P}cr`, "CREDIT"]], "chỉ dòng AI · CRITICAL · lớp cần người (hết tiền / khoá bị từ chối)");
    const g = benchGuard(mine);
    assert.ok(!g.ok && g.message.includes(`${P}cr`) && /KHÔNG đọc được từ ERP/.test(g.message), "CREDIT đang mở ⇒ rào từ chối và nói ERP không đọc được số dư");
    const onlyAuth: AiProviderIncident[] = mine.filter((i) => i.reason === "AUTH");
    const g2 = benchGuard(onlyAuth);
    assert.ok(g2.ok && /KHÔNG đọc được từ ERP/.test(g2.note), "khoá bị từ chối không làm bench tiêu tiền — không chặn, nhưng vẫn in câu cảnh báo số dư");
    assert.ok(!benchGuard(null).ok, "không đọc được gương ⇒ từ chối (rơi về phía hẹp)");
  } finally {
    await pdb.delete(h).where(sql`${h.orgCode} like ${`${P}%`}`);
  }
}

function testSourceFences() {
  const alerts = readFileSync("lib/sales-chatbot/alerts.ts", "utf8");
  assert.ok(!/else if \(cfg\.telegramBotToken/.test(alerts), "không còn if / else chọn MỘT kênh");
  assert.ok(alerts.includes("notifyPlatformOperator(opTitle, opLines, { dedupeKey: decision.dedupe, orgCode: org.code })"), "tin sức khoẻ mang khoá của quyết định ⇒ có vết");
  assert.ok(/if \(!inserted\.length\) \{\n\s+await retryFailedOperatorAlert\(org\.code, decision\.dedupe/.test(alerts), "lượt kế thử lại tin vận hành FAILED");
  for (const [f, firstAiCall] of [
    ["scripts/platform-ai-bench.ts", "platformAiConfig()"],
    ["scripts/platform-ai-model-probe.ts", "applyPlatformAiPolicyAsScript({"],
  ] as const) {
    const src = readFileSync(f, "utf8");
    const g = src.indexOf("await benchGuardNow()");
    assert.ok(g > 0 && g < src.indexOf(firstAiCall, src.indexOf("async function main")), `${f}: rào đứng TRƯỚC lời gọi AI đầu tiên`);
    assert.match(src.slice(g, g + 200), /process\.exit\(3\)/, `${f}: bị chặn ⇒ exit 3`);
  }
  const ci = readFileSync("lib/ai-usage/credit-incidents.ts", "utf8");
  assert.ok(!/platformAiUsage|platform_ai_usage/.test(ci.replace(/\/\*[\s\S]*?\*\//g, "")), "banner / rào đọc gương, không đếm lại sổ AI");
  assert.ok(!/fetch\(|billing|getAiProvider/.test(ci.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "không gọi API thanh toán / AI");
}

export async function testOperatorAlertChain() {
  await testChain();
  await testTrail();
  await testIncidentsAndGuard();
  testSourceFences();
  console.log("  ✓ P0 cạn credit: chuỗi kênh Lark quản lý → Lark → Telegram dừng ở kênh nhận đầu · Lark hỏng ⇒ Telegram · mọi kênh hỏng ⇒ vết FAILED, lượt kế thử lại, đã SENT thì không gửi lại · vết theo (tổ chức, khoá) · banner / rào đọc gương sức khoẻ · bench / probe từ chối khi CREDIT đang mở · chưa áp 0259 vẫn gửi");
}

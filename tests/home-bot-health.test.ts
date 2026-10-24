/**
 * ═══ SỨC KHOẺ BOT NHÀ VÀO CHUỖI BÁO VẬN HÀNH (24/10/2026 — bot nhà im 6 giờ vì Gemini 403 mà không ai biết) ═══
 *
 * Khoá: phân loại bằng ĐÚNG classifyAiError (403 «denied access» ⇒ AUTH) · một tin mỗi sự cố, một tin hồi phục · 429 lẻ / lỗi mạng không
 * mở sự cố · «có khách mà bot im» ≥ 30′ mới báo, đêm vắng KHÔNG báo · mất nhịp > 15′ báo một lần, nhịp quay lại báo hồi phục · thân đóng ·
 * bot thưa báo cáo, che khoá · một nhịp KHÔNG xoá mục đệm nào của tổ chức nhà (không audit / clearMemo — lỗi #1036) · route khai đủ.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import {
  applyHomeBotReport,
  EMPTY_HOME_BOT_STATE,
  HOME_BOT_HEALTH,
  HOME_BOT_HEALTH_KEY,
  homeBotBannerLines,
  homeBotReportSchema,
  homeBotStaleCheck,
  parseHomeBotState,
  type HomeBotHealthState,
  type HomeBotReport,
} from "@/lib/constants/home-bot-health";
import { recordHomeBotReport } from "@/lib/home-bot/health";

const T0 = Date.parse("2026-10-24T11:21:36Z");
const at = (min: number) => new Date(T0 + min * 60_000);
const DENIED: HomeBotReport = { type: "PROVIDER_ERROR", status: 403, message: "Your project has been denied access. Please contact support." };

function testPure() {
  // Sự cố nhà cung cấp: 403 ⇒ AUTH (classifyAiError), MỘT tin; lặp lại chỉ đếm; OK ⇒ MỘT tin hồi phục.
  const r = applyHomeBotReport(EMPTY_HOME_BOT_STATE, DENIED, at(0));
  assert.equal(r.state.incident?.kind, "AUTH");
  assert.equal(r.alerts.length, 1);
  assert.match(r.alerts[0].dedupeKey, /^home-bot:new:AUTH:/);
  const again = applyHomeBotReport(r.state, DENIED, at(1));
  assert.deepEqual([again.alerts.length, again.state.incident?.count], [0, 2], "cùng lớp lặp lại ⇒ không tin thứ hai");
  const ok = applyHomeBotReport(again.state, { type: "PROVIDER_OK" }, at(30));
  assert.deepEqual([ok.state.incident, ok.alerts.length], [null, 1]);
  assert.match(ok.alerts[0].dedupeKey, /^home-bot:ok:AUTH:/);
  assert.equal(applyHomeBotReport(ok.state, { type: "PROVIDER_OK" }, at(31)).alerts.length, 0, "OK khi không có sự cố ⇒ không tin");
  // Hết tiền trả trước (chữ thật của Gemini) ⇒ CREDIT.
  assert.equal(applyHomeBotReport(EMPTY_HOME_BOT_STATE, { type: "PROVIDER_ERROR", status: 429, message: "Your prepayment credits are depleted." }, at(0)).state.incident?.kind, "CREDIT");
  // Lỗi máy chủ / mạng không phải sự cố cần người.
  assert.equal(applyHomeBotReport(EMPTY_HOME_BOT_STATE, { type: "PROVIDER_ERROR", status: 500, message: "Internal error" }, at(0)).state.incident, null);
  // 429 lẻ không mở sự cố; đủ ngưỡng trong cửa sổ mới mở.
  let s: HomeBotHealthState = EMPTY_HOME_BOT_STATE;
  const rate: HomeBotReport = { type: "PROVIDER_ERROR", status: 429, message: "Resource has been exhausted (e.g. check quota)." };
  for (let i = 0; i < HOME_BOT_HEALTH.rateLimitBurst - 1; i += 1) s = applyHomeBotReport(s, rate, at(i)).state;
  assert.equal(s.incident, null, "429 lẻ ⇒ không sự cố");
  const third = applyHomeBotReport(s, rate, at(HOME_BOT_HEALTH.rateLimitBurst - 1));
  assert.deepEqual([third.state.incident?.kind, third.alerts.length], ["RATE_LIMIT", 1]);
  assert.equal(applyHomeBotReport(applyHomeBotReport(EMPTY_HOME_BOT_STATE, rate, at(0)).state, rate, at(HOME_BOT_HEALTH.rateLimitWindowMinutes + 5)).state.rateErrors.length, 1, "429 ngoài cửa sổ không cộng dồn");

  // Nhịp: đêm vắng (0 lượt khách) ⇒ KHÔNG im lặng; có khách mà 0 trả lời ≥ 30′ ⇒ MỘT tin; có trả lời ⇒ hồi phục.
  const beat = (turns: number, replies: number): HomeBotReport => ({ type: "BEAT", customerTurns5m: turns, replies5m: replies, lastReplyAt: null });
  let b = EMPTY_HOME_BOT_STATE;
  for (let m = 5; m <= 120; m += 5) {
    const x = applyHomeBotReport(b, beat(0, 0), at(m));
    assert.equal(x.alerts.length, 0, "đêm vắng không báo");
    b = x.state;
  }
  assert.equal(b.silentSince, null);
  const silentAlerts: string[] = [];
  for (let m = 5; m <= 60; m += 5) {
    const x = applyHomeBotReport(b, beat(2, 0), at(m));
    silentAlerts.push(...x.alerts.map((a) => a.dedupeKey));
    b = x.state;
  }
  assert.equal(silentAlerts.length, 1, `có khách mà bot im ⇒ ĐÚNG một tin: ${silentAlerts.join(", ")}`);
  assert.match(silentAlerts[0], /^home-bot:silent:/);
  const back = applyHomeBotReport(b, beat(3, 2), at(65));
  assert.deepEqual([back.state.silentSince, back.alerts.map((a) => a.dedupeKey.split(":").slice(0, 2).join(":"))], [null, ["home-bot:silent-ok"]]);
  // Im lặng ngắn (< 30′) rồi trả lời ⇒ không tin nào.
  let short = applyHomeBotReport(EMPTY_HOME_BOT_STATE, beat(1, 0), at(5)).state;
  short = applyHomeBotReport(short, beat(1, 0), at(10)).state;
  assert.equal(applyHomeBotReport(short, beat(1, 1), at(15)).alerts.length, 0);

  // Mất nhịp: > 15′ ⇒ MỘT tin; không lặp; nhịp quay lại ⇒ hồi phục. Chưa từng có nhịp (bot bản cũ) ⇒ không kết luận.
  const live = applyHomeBotReport(EMPTY_HOME_BOT_STATE, beat(0, 0), at(0)).state;
  assert.equal(homeBotStaleCheck(live, at(HOME_BOT_HEALTH.beatStaleMinutes)).alerts.length, 0, "đúng ngưỡng chưa báo");
  const stale = homeBotStaleCheck(live, at(HOME_BOT_HEALTH.beatStaleMinutes + 1));
  assert.equal(stale.alerts.length, 1);
  assert.equal(homeBotStaleCheck(stale.state, at(60)).alerts.length, 0, "mất nhịp chỉ báo một lần");
  const resumed = applyHomeBotReport(stale.state, beat(0, 0), at(61));
  assert.deepEqual([resumed.alerts.length, resumed.state.staleAlerted], [1, null]);
  assert.match(resumed.alerts[0].dedupeKey, /^home-bot:stale-ok:/);
  assert.equal(homeBotStaleCheck(EMPTY_HOME_BOT_STATE, at(999)).alerts.length, 0, "chưa từng có nhịp ⇒ không kết luận");

  // Thân đóng: chỉ loại đã khai, không trường lạ, chữ lỗi ≤ 160.
  assert.ok(homeBotReportSchema.safeParse(DENIED).success);
  for (const bad of [{ type: "CHAT", text: "khách" }, { ...DENIED, customer: "Ngọc" }, { ...DENIED, message: "x".repeat(161) }, { type: "BEAT", replies5m: -1, customerTurns5m: 0, lastReplyAt: null }]) {
    assert.ok(!homeBotReportSchema.safeParse(bad).success, `thân phải bị từ chối: ${JSON.stringify(bad).slice(0, 60)}`);
  }
  assert.deepEqual(parseHomeBotState({ incident: { kind: "LẠ", since: "x" }, rateErrors: "x" }), EMPTY_HOME_BOT_STATE, "dữ liệu lạ ⇒ trạng thái rỗng");
  assert.equal(homeBotBannerLines(r.state, at(1)).length, 1, "banner: sự cố đang mở");
  assert.deepEqual(homeBotBannerLines(EMPTY_HOME_BOT_STATE, at(1)), []);
  console.log("  ✓ thuần: 403 ⇒ AUTH một tin + hồi phục · CREDIT · 500 / 429 lẻ không sự cố · đêm vắng không báo · im ≥ 30′ một tin · mất nhịp một tin + hồi phục · thân đóng");
}

type Tracker = {
  providerError: (s: number, m: string) => Record<string, unknown> | null;
  providerOk: () => Record<string, unknown> | null;
  customerTurn: () => void;
  reply: () => void;
  beat: () => Record<string, unknown>;
};
async function testBotTracker() {
  const m = (await import(pathToFileURL(path.resolve("chatbot/src/health-tracker.js")).href)) as { createHealthTracker: (o: { now: () => number }) => Tracker; scrubProviderMessage: (s: string) => string; ERROR_REPORT_GAP_MS: number };
  let clock = 0;
  const t = m.createHealthTracker({ now: () => clock });
  assert.equal(t.providerOk(), null, "OK khi chưa lỗi ⇒ không gửi");
  assert.deepEqual(t.providerError(403, "Your project has been denied access."), { type: "PROVIDER_ERROR", status: 403, message: "Your project has been denied access." });
  clock += 1_000;
  assert.equal(t.providerError(403, "lại"), null, "cùng mã trong 60 s ⇒ không gửi lại");
  assert.ok(t.providerError(429, "quota"), "mã khác ⇒ gửi");
  clock += m.ERROR_REPORT_GAP_MS + 1;
  assert.ok(t.providerError(429, "quota"), "hết khoảng thưa ⇒ gửi lại");
  assert.deepEqual(t.providerOk(), { type: "PROVIDER_OK" });
  assert.equal(t.providerOk(), null);
  t.customerTurn();
  t.customerTurn();
  t.reply();
  const b = t.beat();
  assert.deepEqual([b.type, b.customerTurns5m, b.replies5m, typeof b.lastReplyAt], ["BEAT", 2, 1, "string"]);
  assert.deepEqual([t.beat().customerTurns5m, t.beat().replies5m], [0, 0], "nhịp đặt lại bộ đếm");
  assert.ok(!m.scrubProviderMessage("API key AIzaSyA1234567890abcdefghijKLMNOPQ invalid").includes("AIza"), "che khoá API");
  assert.ok(m.scrubProviderMessage("x".repeat(500)).length <= 160);
  assert.doesNotMatch(readFileSync("chatbot/src/health-tracker.js", "utf8"), /^import /m, "module thuần");
  console.log("  ✓ bot: thưa lỗi theo mã 60 s · OK chỉ sau lỗi · nhịp đếm + đặt lại · che khoá · module thuần");
}

function testSource() {
  const route = readFileSync("app/api/internal/bot-health/route.ts", "utf8");
  assert.match(route, /secretEquals\(request\.headers\.get\(HOME_BOT_HEALTH_TOKEN_HEADER\), chatbotConfig\(\)\.token\)/, "khoá qua HEADER, so thời gian hằng");
  assert.match(route, /admit\(fullAt,/, "xô giới hạn tần suất");
  assert.match(route, /homeBotReportSchema\.safeParse/, "thân đóng");
  assert.doesNotMatch(route, /searchParams/, "khoá không bao giờ từ URL");
  const svc = readFileSync("lib/home-bot/health.ts", "utf8");
  assert.doesNotMatch(svc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""), /\baudit\(|clearMemo|staleMemo/, "nhịp không đi qua audit() / clearMemo (lỗi #1036)");
  assert.match(svc, /notifyPlatformOperator/, "báo qua chuỗi vận hành có chống lặp");
  assert.ok(readFileSync("middleware.ts", "utf8").includes("HOME_BOT_HEALTH_PATH];"), "PUBLIC_EXACT có đường bot-health");
  assert.ok(readFileSync("lib/constants/platform-modules.ts", "utf8").includes('"/api/internal/bot-health"'));
  const gem = readFileSync("chatbot/src/gemini.js", "utf8");
  assert.equal((gem.match(/botHealth\.providerError\(res\.status/g) ?? []).length, 2, "cả hai đường gọi Gemini báo lỗi");
  assert.equal((gem.match(/botHealth\.providerOk\(\)/g) ?? []).length, 2);
  const server = readFileSync("chatbot/src/server.js", "utf8");
  assert.ok(server.includes("startHealthcheck();") && server.includes("startHealthBeat();"), "healthchecks.io GIỮ nguyên, nhịp ERP là thêm");
  assert.match(readFileSync("chatbot/src/queue.js", "utf8"), /botHealth\.customerTurn\(\)/);
  assert.match(readFileSync("chatbot/src/bot.js", "utf8"), /store\.bumpStat\(pageId, "replies"\);\n\s*botHealth\.reply\(\);/);
  assert.match(readFileSync("lib/sync/jobs.ts", "utf8"), /\(await currentOrganization\(\)\)\.isHome \? await checkHomeBotStale\(\)/, "job 5′ kiểm mất nhịp ở tổ chức nhà");
  console.log("  ✓ mã nguồn: route khoá header + xô + thân đóng · dịch vụ không audit / clearMemo · khai PUBLIC_EXACT + module · hai đường Gemini · healthchecks.io giữ nguyên");
}

/** Một nhịp KHÔNG được xoá mục đệm nào của tổ chức nhà (điều kiện cứng của Tech Lead, lỗi #1036). */
async function testNoMemoClear() {
  let calls = 0;
  const key = `home-bot-health-test-${Date.now()}`;
  const load = () => memo(key, 60_000, async () => ++calls);
  await load();
  const sent: string[] = [];
  const notify = async (_t: string, _l: string[], o: { dedupeKey: string }) => void sent.push(o.dedupeKey);
  const db = await getDb();
  await db.delete(schema.settings).where(eq(schema.settings.key, HOME_BOT_HEALTH_KEY));
  try {
    await recordHomeBotReport({ type: "BEAT", replies5m: 4, customerTurns5m: 4, lastReplyAt: at(0).toISOString() }, at(0), { notify });
    await recordHomeBotReport(DENIED, at(1), { notify });
    await recordHomeBotReport(DENIED, at(2), { notify });
    await load();
    assert.equal(calls, 1, "nhịp + báo lỗi không xoá mục đệm nào của nhà");
    assert.equal(sent.length, 1, `một tin cho sự cố: ${sent.join(", ")}`);
    const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, HOME_BOT_HEALTH_KEY));
    const st = parseHomeBotState(JSON.parse(String(row?.value ?? "null")));
    assert.deepEqual([st.incident?.kind, st.incident?.count, st.lastBeatAt], ["AUTH", 2, at(0).toISOString()]);
  } finally {
    await db.delete(schema.settings).where(eq(schema.settings.key, HOME_BOT_HEALTH_KEY));
  }
  console.log("  ✓ CSDL nhà: nhịp + lỗi ghi khoá home-bot.health, một tin cho sự cố, KHÔNG mất mục đệm nào");
}

export async function testHomeBotHealth(): Promise<void> {
  testPure();
  await testBotTracker();
  testSource();
  await testNoMemoClear();
  console.log("✓ Sức khoẻ bot nhà vào chuỗi báo vận hành: phân loại một chỗ · một tin / sự cố + hồi phục · im lặng có khách ≥ 30′ · mất nhịp > 15′ · không xoá đệm nhà");
}

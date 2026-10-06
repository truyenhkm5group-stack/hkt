import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq, like } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { DEFAULT_AI_SALES_SLO, resolveAiSalesSlo } from "@/lib/constants/ai-sales-slo";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { AI_DOWN_HANDOFF_REASON } from "@/lib/sales-chatbot/engine";
import { readSalesHealthSnapshot, runSalesHealthCheck, salesHealthDrilldown, vnDayStart } from "@/lib/sales-chatbot/health";
import { decideHealthAlert, evaluateSalesHealth, type SalesHealthSnapshot } from "@/lib/sales-chatbot/health-shared";
import { setSettingJson } from "@/lib/settings";

/**
 * ═══════════ GIÁM SÁT AI BÁN HÀNG — SỰ CỐ P0 06/10/2026 PHẢI BỊ BẮT TRONG VÀI PHÚT ═══════════
 *
 * 11:38 tài khoản trả trước Google AI Studio cạn ⇒ mọi lượt AI hỏng ⇒ lượt chat vẫn trả «ok» kèm chuyển nhân viên ⇒ tin khách
 * chốt DONE, hàng chờ TRỐNG — không bộ đếm nào đổi màu. Bot im ~2 giờ, người phát hiện là chủ shop.
 * Bài kiểm dựng lại đúng hình dạng đó (hàng chờ trống · tin khách DONE · không câu bot nào · provider lỗi lớp hết tiền) và
 * đòi trạng thái ĐỎ với nguyên nhân đúng. Mốc thời gian đi theo đồng hồ thật (luật 50/65): mọi dữ liệu gieo TƯƠNG ĐỐI với `now`.
 */

const ORG = "ai-health";
const now = new Date();
const ago = (min: number) => new Date(now.getTime() - min * 60_000);
const iso = (min: number) => ago(min).toISOString();

function base(p: Partial<SalesHealthSnapshot> = {}): SalesHealthSnapshot {
  return {
    at: now.toISOString(),
    botEnabled: true,
    mode: "AUTOPILOT",
    orderSyncEnabled: true,
    channels: { pancake: { configured: true, lastWebhookAt: iso(1) }, messenger: { pages: 0, lastEventAt: null, lastErrorAt: null, lastError: null } },
    lastCustomerMessageAt: iso(1),
    lastAiReplyAt: iso(1),
    lastAiOrderAt: iso(30),
    queue: { pending: 0, retrying: 0, oldestPendingAt: null, failedAiDown24h: 0, failedSend24h: 0, abandoned24h: 0, deadLetter: null },
    silent: { customerHandled: 6, botSent: 9, windowMinutes: 30 },
    latency: { p50Seconds: 12, p95Seconds: 31, sample: 40, unanswered: 2 },
    provider: { okInWindow: 20, errorsInWindow: 0, blockedInWindow: 0, lastOkAt: iso(1), lastErrorAt: null, lastErrorKind: null, lastErrorLabel: null },
    traffic: { lastHour: 14, baselineSameHour: 12, baselineDays: 14 },
    followup: { lastRunAt: iso(3), lastStatus: "SUCCESS", lastError: null },
    orderSyncErrors24h: 0,
    orderSync: { errorsInWindow: 0, lastOkAt: iso(4), lastErrorAt: null },
    today: { conversationsAi: 20, ordersAi: 4, ordersSync: 3, orderValueAi: 1_200_000, conversionPct: 20 },
    errors24h: 0,
    ...p,
  };
}

function testPure() {
  const slo = resolveAiSalesSlo(null);
  assert.deepEqual(slo, { ...DEFAULT_AI_SALES_SLO }, "không ghi đè ⇒ đúng số chủ shop chốt");
  assert.equal(slo.replyTargetSeconds, 60);
  assert.equal(slo.backlogWarnMinutes, 5);
  assert.equal(slo.backlogCriticalMinutes, 10);
  const o = resolveAiSalesSlo({ replyTargetSeconds: 45, backlogWarnMinutes: 20, backlogCriticalMinutes: 15, silentWindowMinutes: "abc", la: 1 });
  assert.equal(o.replyTargetSeconds, 45, "ghi đè thưa: ô hợp lệ được nhận");
  assert.equal(o.silentWindowMinutes, DEFAULT_AI_SALES_SLO.silentWindowMinutes, "ô sai kiểu bị bỏ RIÊNG ô đó");
  assert.deepEqual([o.backlogWarnMinutes, o.backlogCriticalMinutes], [5, 10], "cặp cảnh báo ≥ nguy cấp ⇒ bỏ CẢ CẶP về mặc định, không sửa hộ");

  // Khoẻ.
  const ok = evaluateSalesHealth(base(), slo);
  assert.equal(ok.status, "GREEN", JSON.stringify(ok.checks.filter((c) => c.level !== "OK")));

  // SỰ CỐ 06/10: hàng chờ trống, tin khách đã chốt, không câu bot nào, provider lỗi lớp hết tiền.
  const incident = evaluateSalesHealth(
    base({
      lastAiReplyAt: iso(42),
      silent: { customerHandled: 7, botSent: 0, windowMinutes: 30 },
      queue: { pending: 0, retrying: 0, oldestPendingAt: null, failedAiDown24h: 7, failedSend24h: 0, abandoned24h: 0, deadLetter: null },
      provider: { okInWindow: 0, errorsInWindow: 9, blockedInWindow: 0, lastOkAt: iso(42), lastErrorAt: iso(1), lastErrorKind: "CREDIT", lastErrorLabel: "Tài khoản AI của shop đã hết tiền — nạp thêm ở trang của nhà cung cấp AI" },
      orderSyncErrors24h: 5,
      orderSync: { errorsInWindow: 3, lastOkAt: iso(42), lastErrorAt: iso(2) },
    }),
    slo,
  );
  assert.equal(incident.status, "RED", "sự cố 06/10 phải ĐỎ — hàng chờ trống không được che nó");
  const crit = incident.checks.filter((c) => c.level === "CRITICAL").map((c) => c.key).sort();
  assert.deepEqual(crit, ["BOT_SILENT", "ORDER_SYNC", "PROVIDER"]);
  assert.ok(incident.headline.includes("hết tiền"), `câu tổng phải nói NGUYÊN NHÂN (hết tiền), không chỉ triệu chứng: ${incident.headline}`);

  // Một lượt lỗi lớp hết tiền là đủ (không tự khỏi); một lượt quá tải thì chưa.
  const oneCredit = evaluateSalesHealth(base({ provider: { okInWindow: 3, errorsInWindow: 1, blockedInWindow: 0, lastOkAt: iso(5), lastErrorAt: iso(1), lastErrorKind: "CREDIT", lastErrorLabel: "hết tiền" } }), slo);
  assert.equal(oneCredit.checks.find((c) => c.key === "PROVIDER")?.level, "CRITICAL");
  const oneRate = evaluateSalesHealth(base({ provider: { okInWindow: 3, errorsInWindow: 1, blockedInWindow: 0, lastOkAt: iso(5), lastErrorAt: iso(1), lastErrorKind: "RATE_LIMIT", lastErrorLabel: "quá tải" } }), slo);
  assert.equal(oneRate.checks.find((c) => c.key === "PROVIDER")?.level, "WARNING", "một lượt quá tải: cảnh báo, chưa kết luận hỏng");
  const recovered = evaluateSalesHealth(base({ provider: { okInWindow: 3, errorsInWindow: 4, blockedInWindow: 0, lastOkAt: iso(0.5), lastErrorAt: iso(2), lastErrorKind: "RATE_LIMIT", lastErrorLabel: "quá tải" } }), slo);
  assert.equal(recovered.checks.find((c) => c.key === "PROVIDER")?.level, "OK", "đã có lượt thành công SAU lỗi cuối ⇒ hồi phục");
  const blocked = evaluateSalesHealth(base({ provider: { okInWindow: 0, errorsInWindow: 0, blockedInWindow: 4, lastOkAt: iso(30), lastErrorAt: iso(1), lastErrorKind: null, lastErrorLabel: null } }), slo);
  assert.equal(blocked.checks.find((c) => c.key === "PROVIDER")?.level, "CRITICAL", "hết hạn mức gói / công tắc khẩn cấp chặn mọi lượt ⇒ ĐỎ");

  // HÀNG CHỜ: 5 / 10 phút.
  const q = (min: number) => evaluateSalesHealth(base({ queue: { pending: 3, retrying: 1, oldestPendingAt: iso(min), failedAiDown24h: 0, failedSend24h: 0, abandoned24h: 0, deadLetter: null } }), slo);
  assert.equal(q(3).status, "GREEN");
  assert.equal(q(6).status, "YELLOW", "> 5 phút ⇒ CẢNH BÁO");
  assert.equal(q(11).status, "RED", "> 10 phút ⇒ NGUY CẤP");

  // Tin bị bỏ sót (PENDING quá cửa sổ tự xử lý) ⇒ CẢNH BÁO, không làm hàng chờ đỏ mãi.
  const ab = evaluateSalesHealth(base({ queue: { pending: 0, retrying: 0, oldestPendingAt: null, failedAiDown24h: 0, failedSend24h: 0, abandoned24h: 2, deadLetter: null } }), slo);
  assert.equal(ab.status, "YELLOW");
  assert.equal(ab.checks.find((c) => c.key === "BACKLOG")?.level, "OK");
  // Ghi đơn: lỗi sáng nay đã hồi phục ⇒ không vàng suốt 24 giờ.
  const syncHealed = evaluateSalesHealth(base({ orderSyncErrors24h: 40, orderSync: { errorsInWindow: 0, lastOkAt: iso(3), lastErrorAt: iso(120) } }), slo);
  assert.equal(syncHealed.checks.find((c) => c.key === "ORDER_SYNC")?.level, "OK", "sự cố đã hồi phục không vàng suốt 24 giờ");
  const syncBroken = evaluateSalesHealth(base({ orderSync: { errorsInWindow: 2, lastOkAt: iso(30), lastErrorAt: iso(1) } }), slo);
  assert.equal(syncBroken.checks.find((c) => c.key === "ORDER_SYNC")?.level, "WARNING");

  // Chế độ QUAN SÁT: bot im là đúng thiết kế ⇒ không có kiểm «bot im».
  const observe = evaluateSalesHealth(base({ mode: "OBSERVE", silent: { customerHandled: 9, botSent: 0, windowMinutes: 30 } }), slo);
  assert.equal(observe.checks.find((c) => c.key === "BOT_SILENT"), undefined);
  assert.equal(observe.status, "GREEN");

  // Bot TẮT + ghi đơn TẮT ⇒ OFF, không báo động.
  assert.equal(evaluateSalesHealth(base({ botEnabled: false, orderSyncEnabled: false }), slo).status, "OFF");

  // CHƯA BIẾT không in thành khoẻ: nền webhook < 5 ngày, mẫu độ trễ < 10.
  const thin = evaluateSalesHealth(base({ traffic: { lastHour: 0, baselineSameHour: 9, baselineDays: 3 }, latency: { p50Seconds: 5, p95Seconds: 7, sample: 4, unanswered: 0 } }), slo);
  assert.equal(thin.checks.find((c) => c.key === "WEBHOOK")?.level, "UNKNOWN");
  assert.equal(thin.checks.find((c) => c.key === "LATENCY")?.level, "UNKNOWN");
  // Webhook im so với nền.
  assert.equal(evaluateSalesHealth(base({ traffic: { lastHour: 0, baselineSameHour: 9, baselineDays: 14 } }), slo).checks.find((c) => c.key === "WEBHOOK")?.level, "WARNING");
  assert.equal(evaluateSalesHealth(base({ traffic: { lastHour: 0, baselineSameHour: 1, baselineDays: 14 } }), slo).checks.find((c) => c.key === "WEBHOOK")?.level, "OK", "khung giờ vắng (3 giờ sáng) im là bình thường");
  // Độ trễ P95 vượt SLO.
  assert.equal(evaluateSalesHealth(base({ latency: { p50Seconds: 20, p95Seconds: 95, sample: 30, unanswered: 1 } }), slo).checks.find((c) => c.key === "LATENCY")?.level, "WARNING");
  // Job lưới an toàn ngừng.
  assert.equal(evaluateSalesHealth(base({ followup: { lastRunAt: iso(45), lastStatus: "SUCCESS", lastError: null } }), slo).checks.find((c) => c.key === "SAFETY_NET")?.level, "WARNING");

  // BÁO KHI NÀO.
  const red = incident;
  const d1 = decideHealthAlert(null, red, now, 60);
  assert.equal(d1.kind, "ALERT");
  assert.equal(d1.kind === "ALERT" && d1.reason, "NEW_PROBLEM", "sự cố mới ⇒ báo NGAY");
  const prevRed = { status: red.status, bad: ["BOT_SILENT:CRITICAL", "ORDER_SYNC:CRITICAL", "PROVIDER:CRITICAL"], since: iso(5) };
  const d2 = decideHealthAlert(prevRed, red, now, 60);
  const d3 = decideHealthAlert(prevRed, red, new Date(now.getTime() + 5 * 60_000), 60);
  assert.equal(d2.kind === "ALERT" && d2.reason, "REMINDER", "còn ĐỎ ⇒ nhắc");
  assert.ok(d2.kind === "ALERT" && d3.kind === "ALERT" && (d2.dedupe === d3.dedupe || Math.floor(now.getTime() / 3_600_000) !== Math.floor((now.getTime() + 300_000) / 3_600_000)), "trong cùng khung 60 phút ⇒ CÙNG khoá chống trùng (một tin)");
  const yellow = q(6);
  const prevYellow = { status: yellow.status, bad: ["BACKLOG:WARNING"], since: iso(5) };
  assert.equal(decideHealthAlert(prevYellow, yellow, now, 60).kind, "NONE", "vàng kéo dài không nhắc lại");
  const back = decideHealthAlert(prevRed, ok, now, 60);
  assert.equal(back.kind, "RECOVERED", "từng đỏ, nay xanh ⇒ một tin hồi phục");
  assert.equal(decideHealthAlert({ status: "GREEN", bad: [], since: iso(60) }, ok, now, 60).kind, "NONE");
  console.log("✓ Giám sát AI bán hàng (thuần): SLO 60s · 5/10 phút · sự cố 06/10 ĐỎ đúng nguyên nhân · chưa biết ≠ khoẻ · báo ngay / nhắc / hồi phục");
}

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, code));
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, code));
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

async function testRealOrg() {
  await withOrganization(ORG, async () => {
    const db = await getDb();
    await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: true });
    const t = schema.salesChatInbound;
    const P = "page-1";
    let n = 0;
    const cust = (thread: string, min: number, status: string, note: string | null = null) => ({ pageId: P, threadId: thread, messageId: `m-${++n}`, text: `tin ${n}`, customerName: `Khách ${thread}`, status, note, createdAt: ago(min), processedAt: status === "PENDING" ? null : ago(min) });
    const bot = (thread: string, min: number) => ({ pageId: P, threadId: thread, messageId: `bot-out:${++n}`, text: "dạ", status: "DONE", note: "BOT_SENT", createdAt: ago(min), processedAt: ago(min) });
    // Hội thoại khoẻ hôm qua (độ trễ đo được) + sự cố: 4 hội thoại trong 20 phút qua, tin chốt DONE, KHÔNG câu bot nào.
    await db.insert(t).values([
      cust("ok-1", 120, "DONE"), bot("ok-1", 119.7),
      cust("ok-2", 100, "DONE"), bot("ok-2", 99.5),
      cust("down-1", 20, "DONE", "Chuyển nhân viên — bot không nhắn gì, chờ người trả lời"),
      cust("down-2", 15, "DONE", "Chuyển nhân viên — bot không nhắn gì, chờ người trả lời"),
      cust("down-3", 10, "DONE", "Chuyển nhân viên — bot không nhắn gì, chờ người trả lời"),
      cust("send-1", 8, "DONE", "lỗi gửi — Pancake không nhận tin: conversation_id not found"),
      cust("wait-1", 12, "PENDING"),
      // Tin PENDING quá cửa sổ tự xử lý (bị bỏ sót) — đếm riêng, không làm tuổi hàng chờ.
      cust("old-1", 300, "PENDING"),
      // Tin NHẬP LỊCH SỬ đang PENDING không bao giờ là việc của bot — không được đếm.
      { ...cust("hist", 600, "PENDING"), importedAt: ago(1) },
    ]);
    const c = schema.salesChatConversations;
    await db.insert(c).values([
      { channel: "FANPAGE", visitorKey: `${P}:down-1`, pageId: P, threadId: "down-1", status: "HANDOFF", handoffReason: AI_DOWN_HANDOFF_REASON, lastError: "Gemini trả lỗi HTTP 429: Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.", updatedAt: ago(19) },
      { channel: "FANPAGE", visitorKey: `${P}:ok-1`, pageId: P, threadId: "ok-1", status: "WAITING", lastBotAt: vnDayStart(now) > ago(119.7) ? vnDayStart(now) : ago(119.7) },
    ]);
    await db.insert(schema.orders).values({ id: `ai-health-o1`, insertedAt: ago(90), origin: "AI_AGENT", totalPriceAfterDiscount: 540000, stage: "NEW" } as typeof schema.orders.$inferInsert);
    await db.insert(schema.syncRuns).values({ source: "ERP", job: "sales-followup", status: "SUCCESS", startedAt: ago(4), finishedAt: ago(4) });
    const pdb = await getPlatformDb();
    const row = (min: number, status: "OK" | "ERROR", ref: string) => ({ at: ago(min), orgCode: ORG, feature: "sales_chatbot", billingSource: "BYOK", provider: "gemini", model: "m", requests: 1, status, ref });
    await pdb.insert(schema.platformAiUsage).values([row(119, "OK", "c1"), row(99, "OK", "c2"), row(20, "ERROR", "c3"), row(15, "ERROR", "c4"), row(10, "ERROR", "c5"), row(6, "ERROR", "order-sync:c6")]);

    const snap = await readSalesHealthSnapshot(now);
    assert.equal(snap.queue.pending, 1, "tin nhập lịch sử không vào hàng chờ của bot");
    assert.equal(snap.queue.abandoned24h, 1, "tin chờ 5 giờ là BỎ SÓT, không phải hàng chờ");
    assert.ok(snap.queue.oldestPendingAt && Math.abs(Date.parse(snap.queue.oldestPendingAt) - ago(12).getTime()) < 2000);
    assert.equal(snap.queue.failedSend24h, 1);
    assert.equal(snap.queue.failedAiDown24h, 1);
    assert.equal(snap.silent.botSent, 0);
    assert.ok(snap.silent.customerHandled >= 3, `bot im: ${snap.silent.customerHandled} hội thoại`);
    assert.equal(snap.provider.errorsInWindow, 3, "cửa sổ 15 phút: lỗi ở phút 15 · 10 · 6 (phút 20 nằm ngoài)");
    assert.equal(snap.provider.lastErrorKind, "CREDIT", "câu lỗi thật của Google ⇒ lớp HẾT TIỀN");
    assert.equal(snap.orderSyncErrors24h, 1);
    assert.equal(snap.orderSync.errorsInWindow, 1);
    assert.equal(snap.latency.sample, 2);
    assert.ok(snap.latency.p95Seconds !== null && snap.latency.p95Seconds <= 31, `P95 ${snap.latency.p95Seconds}`);
    assert.ok(snap.lastAiOrderAt && Math.abs(Date.parse(snap.lastAiOrderAt) - ago(90).getTime()) < 2000);

    const drill = await salesHealthDrilldown(now);
    assert.deepEqual(new Set(drill.map((r) => r.kind)), new Set(["PENDING", "SEND_FAILED", "AI_DOWN"]), "drill-down chỉ ra từng loại tin gây lỗi");

    // Job: lượt đầu báo NGAY (một dòng notifications), lượt sau trong cùng khung KHÔNG báo trùng.
    const r1 = await runSalesHealthCheck(now);
    assert.equal(r1.status, "RED");
    assert.equal(r1.alerted, "báo sự cố mới");
    const r2 = await runSalesHealthCheck(new Date(now.getTime() + 60_000));
    assert.equal(r2.status, "RED");
    const notes = await db.select({ id: schema.notifications.id }).from(schema.notifications).where(like(schema.notifications.dedupeKey, "sales-health:%"));
    assert.ok(notes.length <= 2 && notes.length >= 1, `mỗi khung một tin, không một tin mỗi lượt kiểm (có ${notes.length})`);
    const r3 = await runSalesHealthCheck(new Date(now.getTime() + 2 * 60_000));
    const notes3 = await db.select({ id: schema.notifications.id }).from(schema.notifications).where(like(schema.notifications.dedupeKey, "sales-health:%"));
    assert.equal(notes3.length, notes.length, "lượt kiểm thứ ba trong cùng khung: không thêm tin");
    assert.equal(r3.status, "RED");
  });
  console.log("✓ Giám sát AI bán hàng (CSDL thật): hàng chờ bỏ tin lịch sử · bot im · lớp lỗi hết tiền · drill-down · báo một lần mỗi khung");
}

export async function testAiSalesHealth() {
  testPure();
  await cleanupOrg(ORG);
  await provisionOrganization({ code: ORG, name: "Shop giám sát AI", plan: "trial", modules: ["customers", "products", "orders", "ai_sales"], admin: { email: "chu@ai-health.local", name: "Chủ shop", password: "GiamSat@2026!" }, source: "TEST", actor: null });
  try {
    await testRealOrg();
  } finally {
    await cleanupOrg(ORG);
  }
}

if (/ai-sales-health\.test\.ts$/.test(process.argv[1] ?? "")) testAiSalesHealth().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

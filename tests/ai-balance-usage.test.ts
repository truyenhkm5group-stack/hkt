/**
 * TRỪ SỐ DƯ AI CHO KHÁCH AI VƯỢT PHẦN GỒM + CỔNG HẾT SỐ DƯ (docs/saas/AI_BALANCE_V1.md · chủ shop 08/10/2026).
 *
 * Vòng thật trên hội thoại FANPAGE của một tổ chức gói Growth (V1: gồm 3.000 khách AI, vượt 49.000đ / 100 ⇒ 490đ / khách):
 *  · còn trong phần gồm ⇒ không trừ · vượt ⇒ trừ ĐÚNG 490đ mỗi khách MỚI, một lần mỗi khách mỗi kỳ (gọi lại / khoá trùng ⇒ không
 *    trừ hai lần), dòng sổ mang phiên bản giá + đơn giá + khoá khách;
 *  · hết số dư ⇒ CHẶN khách mới (`BALANCE_EXHAUSTED`) nhưng khách đã tính trong kỳ vẫn được trả lời; số dư còn dương dù nhỏ hơn
 *    đơn giá ⇒ cho, âm tối đa đúng một đơn giá; tiền TẶNG trừ trước khi đủ;
 *  · hộp thư nói đúng lý do + lối «Nạp tiền» cho khách mới, không báo oan khách cũ;
 *  · báo số dư thấp / hết — một chuông mỗi mức mỗi ngày;
 *  · tắt cờ ⇒ không trừ, không chặn; dùng thử ⇒ không trừ số dư (luật L5);
 *  · REVIEW ĐỘC LẬP 08/10/2026 — H2: khách AI đã trừ vào số dư KHÔNG nằm lại trong «Hoá đơn ước tính» của khách lẫn bảng kê kỳ
 *    (thu hai lần); cờ tắt ⇒ như cũ. M2: bình luận đếm theo NGƯỜI bình luận ⇒ cổng (và thanh trạng thái hộp thư) hỏi đúng khoá
 *    ấy — người bình luận đã tính trong tháng không bị chặn oan, người bình luận mới thì bị chặn khi hết số dư.
 *  · khung kinh tế đơn vị /platform/saas đọc lại đúng sổ: doanh thu = MRR + tiền THẬT đã trừ (tiền tặng không vào), cờ đã tắt
 *    vẫn hiện tiền đã thu, tổ chức chưa từng dùng Số dư giữ cách tính cũ.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { initWorkspaceBilling } from "@/lib/billing/service";
import { invalidateSubscriptions } from "@/lib/billing/standing";
import { adjustAiBalance, loadAiBalanceOperatorView, readAiBalance, readAiBalancePeriod } from "@/lib/billing/ai-balance";
import { EMPTY_AI_BALANCE_PERIOD } from "@/lib/billing/ai-balance-rules";
import { balanceOverageTerms, chargeAiCustomerUsage, runAiBalanceAlerts } from "@/lib/billing/ai-usage-charge";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { setAiBalanceEnabled } from "@/lib/platform/kill-switches";
import { invalidateOrgFlags } from "@/lib/platform/org-flags";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { captureSaasSnapshot } from "@/lib/platform/saas-ledger";
import { loadPricingEconomics } from "@/lib/pricing/admin";
import { aiBalanceTotals, platformGrossMargin, projectToPeriodEnd } from "@/lib/pricing/economics";
import { usagePeriodOf } from "@/lib/pricing/meter";
import { loadCustomerPlan } from "@/lib/pricing/customer";
import { loadCommercialSnapshot, productEconomics } from "@/lib/saas/customers";
import { noteAiCustomerReply, resetAiCustomerSeenForTests } from "@/lib/pricing/ai-customer";
import { aiCustomerKeys } from "@/lib/pricing/ai-customer-identity";
import { invalidateAiEntitlement, salesAiPlanGate } from "@/lib/pricing/ai-gate";
import { invalidatePricing } from "@/lib/pricing/entitlements";
import { AI_CUSTOMER_METER_LIVE_KEY, invalidatePriceBook, loadPriceBook } from "@/lib/pricing/price-book";
import { currentCatalogVersion, meterMonthOf, priceOf } from "@/lib/pricing/versions";
import { conversationAiBlocks, forgetAiStatus } from "@/lib/sales-chatbot/ai-status";
import { fanpageVisitorKey } from "@/lib/sales-chatbot/fanpage";

const U = "aibu-growth";
const TR = "aibu-trial";
const ORGS = [U, TR] as const;
const PAGE = "667788990011";
const OP_EMAIL = "op@aibu.local";

function sessionUser(over: Partial<SessionUser>): SessionUser {
  return { id: "aibu-user", email: "aibu@local", name: "AIBU", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, ...over };
}

async function cleanup() {
  const pdb = await getPlatformDb();
  await pdb.delete(schema.platformUsageEvents).where(inArray(schema.platformUsageEvents.orgCode, [...ORGS]));
  await pdb.delete(schema.platformAiLedgerEntries).where(inArray(schema.platformAiLedgerEntries.orgCode, [...ORGS]));
  await pdb.delete(schema.platformAiAccounts).where(inArray(schema.platformAiAccounts.orgCode, [...ORGS]));
  await pdb.delete(schema.platformSaasDaily).where(inArray(schema.platformSaasDaily.orgCode, [...ORGS]));
  await pdb.delete(schema.platformPricePins).where(inArray(schema.platformPricePins.orgCode, [...ORGS]));
  await pdb.delete(schema.platformSubscriptions).where(inArray(schema.platformSubscriptions.orgCode, [...ORGS]));
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.actorEmail, OP_EMAIL));
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [...ORGS]));
  for (const code of ORGS) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    await pdb.delete(schema.platformProductSubscriptions).where(eq(schema.platformProductSubscriptions.orgCode, code));
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  invalidateOrganizations();
  invalidateCapabilities();
  invalidateSubscriptions();
  invalidatePricing();
  invalidatePriceBook();
  invalidateAiEntitlement();
  invalidateOrgFlags();
  resetAiCustomerSeenForTests();
}

async function seedAiCustomers(org: string, n: number, at: Date) {
  const pdb = await getPlatformDb();
  await pdb.execute(sql`
    insert into platform_usage_events (id, occurred_at, org_code, product_key, metric, quantity, unit, source, event_key, metadata)
    select gen_random_uuid()::text, ${at.toISOString()}::timestamptz, ${org}, 'chotdon', 'ai_customers', 1, 'khách AI', 'test', ${`aic:${meterMonthOf(at)}:seed-aibu:`} || g::text, '{}'::jsonb
    from generate_series(1, ${n}) g`);
}

function testSource() {
  const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
  assert.match(read("lib/pricing/ai-customer.ts"), /if \(r\.recorded && r\.key\)[\s\S]{0,400}chargeAiCustomerUsage\(/, "điểm ghi khách AI MỚI gọi trừ số dư tường minh");
  assert.match(read("lib/sales-chatbot/engine.ts"), /salesAiPlanGate\(\{ now, conversation: \{ channel: conv\.channel/, "lượt chat hỏi cổng Số dư AI theo đúng hội thoại");
  assert.match(read("lib/sync/jobs.ts"), /runAiBalanceAlerts\(\)/, "báo số dư đi cùng lịch sales-health sẵn có");
  // M2: lượt trả lời BÌNH LUẬN đưa NGƯỜI bình luận vào cổng — cùng dòng mà đồng hồ ghi sau khi gửi.
  assert.match(read("lib/sales-chatbot/engine.ts"), /visitorKey: conv\.visitorKey, \.\.\.\(opts\.aiCustomer \?\? \{\}\) \} \}\);/, "cổng lượt chat nhận gợi ý người bình luận");
  assert.match(read("lib/sales-chatbot/fanpage.ts"), /aiCustomer: \{ threadKind: "COMMENT" as const, commenterId: commenter\.fromId \}/, "Pancake: bình luận ⇒ cổng hỏi theo người bình luận");
  assert.match(read("lib/sales-chatbot/messenger.ts"), /aiCustomer: \{ threadKind: "COMMENT" as const, commenterId: commentRow\.fromId \?\? null \}/, "Meta: bình luận ⇒ cổng hỏi theo người bình luận");
}

async function run() {
  const now = new Date();
  const pdb = await getPlatformDb();
  const home = await getHomeOrganization();
  const op = sessionUser({ id: "aibu-op", email: OP_EMAIL, organization: { code: home.code, name: home.name, isHome: true } });

  // ── Gói Growth ghim bảng giá V1 hiện hành.
  const book = await loadPriceBook({ fresh: true });
  const catalog = currentCatalogVersion(book, now);
  assert.ok(catalog, "sổ giá có bảng giá niêm yết");
  const growth = priceOf(book, catalog.key, "growth")!.price;
  const included = growth.included.aiCustomers as number;
  const unit = Math.ceil((growth.overage.aiCustomerBlockVnd as number) / (growth.overage.aiCustomerBlockSize as number));
  assert.equal(unit, 490, "V1 Growth: 49.000đ / 100 khách ⇒ 490đ / khách");
  await pdb.update(schema.platformOrganizations).set({ plan: "growth" }).where(eq(schema.platformOrganizations.code, U));
  invalidateOrganizations();
  invalidatePricing();
  await initWorkspaceBilling(U, { selfService: false, now });
  assert.deepEqual(await balanceOverageTerms(U), { included, unitPriceVnd: unit, priceVersionKey: catalog.key });
  assert.equal(await balanceOverageTerms(TR), null, "dùng thử không trừ số dư (luật L5: hết lượt ⇒ chọn gói)");

  // ── Hội thoại FANPAGE thật (PSID) của tổ chức U.
  const conv = async (psid: string) =>
    withOrganization(U, async () => {
      const [r] = await (await getDb()).insert(schema.salesChatConversations).values({ channel: "FANPAGE", pageId: PAGE, threadId: psid, visitorKey: fanpageVisitorKey(PAGE, psid) }).returning();
      return r;
    });
  const gateOf = (c: { channel: string; pageId: string | null; threadId: string | null; visitorKey: string | null }) =>
    withOrganization(U, () => salesAiPlanGate({ now, conversation: { channel: c.channel, pageId: c.pageId, threadId: c.threadId, visitorKey: c.visitorKey } }));
  const note = (id: string) => withOrganization(U, () => noteAiCustomerReply(id, now));
  const usage = async () => pdb.select().from(schema.platformAiLedgerEntries).where(and(eq(schema.platformAiLedgerEntries.orgCode, U), eq(schema.platformAiLedgerEntries.entryType, "AI_USAGE")));

  // Cờ TẮT: không trừ, không chặn — kể cả khi đã vượt phần gồm.
  await seedAiCustomers(U, included - 1, now);
  const c0 = await conv("4100000000301");
  assert.deepEqual(await gateOf(c0), { ok: true });

  assert.ok("ok" in (await setAiBalanceEnabled(op, { orgCode: U, enabled: true, reason: "Canary số dư AI" })));
  invalidateOrgFlags();

  // ── Khách thứ `included` (vẫn TRONG phần gồm) ⇒ cổng cho, ghi khách không trừ.
  const c1 = await conv("4100000000302");
  assert.deepEqual(await gateOf(c1), { ok: true }, "còn trong phần gồm ⇒ cho dù số dư 0");
  await note(c1.id);
  assert.equal((await usage()).length, 0, "khách thứ 3.000 nằm trong phần gói gồm ⇒ không trừ");

  // ── Đã chạm phần gồm + số dư 0 ⇒ khách MỚI bị chặn, khách ĐÃ tính vẫn được trả lời.
  const c2 = await conv("4100000000303");
  const blocked = await gateOf(c2);
  assert.ok(!blocked.ok && blocked.reason === "BALANCE_EXHAUSTED", `khách mới khi hết số dư ⇒ chặn: ${JSON.stringify(blocked)}`);
  assert.deepEqual(await gateOf(c1), { ok: true }, "khách đã tính trong kỳ vẫn được AI trả lời");
  await withOrganization(U, async () => {
    await forgetAiStatus();
    const b2 = await conversationAiBlocks({ ...c2, state: {} });
    assert.ok(b2.some((b) => b.code === "BALANCE_EXHAUSTED" && b.fixHref === "/settings/ai-balance"), `hộp thư nói lý do + lối nạp tiền: ${JSON.stringify(b2)}`);
    const b1 = await conversationAiBlocks({ ...c1, state: {} });
    assert.ok(!b1.some((b) => b.code === "BALANCE_EXHAUSTED"), "không báo chặn oan khách cũ");
  });

  // ── Hoá đơn ước tính + bảng kê kỳ: mới CHẠM phần gồm ⇒ dòng khách AI 0đ (chưa vượt). Phần trừ theo sổ cái kiểm ở cuối.
  const aiLineOf = (o: { lines: { key: string; overUnits: number | null; blocks: number | null; amountVnd: number | null; note: string | null }[] } | null | undefined) => o?.lines.find((l) => l.key === "aiCustomers") ?? null;
  const planOn = await loadCustomerPlan(U);
  assert.ok(planOn?.meter?.aiBalance === true && aiLineOf(planOn.meter.estimate?.overage)?.amountVnd === 0, JSON.stringify(planOn?.meter?.estimate?.overage.lines));
  const wsOf = async () => (await loadCommercialSnapshot({ now })).customers.flatMap((c) => c.workspaces).find((w) => w.code === U);
  assert.equal(aiLineOf((await wsOf())?.pricing.overage)?.amountVnd, 0, "chưa vượt phần gồm ⇒ bảng kê 0đ dòng khách AI");

  // ── Nạp 1.000đ (điều chỉnh tiền thật) ⇒ khách mới được trả lời; vượt phần gồm ⇒ trừ ĐÚNG 490đ, một lần.
  assert.ok("ok" in (await adjustAiBalance(op, { orgCode: U, kind: "ADJUST_CASH", amountVnd: 1_000, reason: "Nạp thử canary", requestKey: "rkaibu00001" })));
  assert.deepEqual(await gateOf(c2), { ok: true });
  await note(c2.id);
  const u1 = await usage();
  assert.equal(u1.length, 1, "một khách vượt ⇒ một dòng trừ");
  const k2 = aiCustomerKeys(meterMonthOf(now), { channel: "FANPAGE", pageId: PAGE, threadId: c2.threadId, visitorKey: c2.visitorKey })!.key;
  assert.deepEqual(
    [u1[0].amountVnd, u1[0].fundsClass, u1[0].unitPriceVnd, u1[0].units, u1[0].priceVersionKey, u1[0].sourceRef, u1[0].idempotencyKey],
    [-unit, "CASH", unit, 1, catalog.key, k2, `aic-charge:${U}:${k2}`],
    "dòng trừ mang phiên bản giá + đơn giá + khoá khách",
  );
  await note(c2.id);
  assert.equal((await usage()).length, 1, "khách đã tính nhắn tiếp ⇒ không trừ thêm");
  assert.deepEqual(await chargeAiCustomerUsage({ orgCode: U, eventKey: k2, at: now, periodCount: included + 1 }), { charged: false, reason: "ALREADY_CHARGED" }, "khoá trùng ⇒ không trừ hai lần");
  assert.equal((await readAiBalance(U)).totalVnd, 1_000 - unit);

  // ── Số dư dương nhỏ hơn đơn giá ⇒ vẫn cho, lượt trừ làm ÂM tối đa đúng một đơn giá; âm rồi ⇒ chặn khách mới.
  const c3 = await conv("4100000000304");
  await note(c3.id); // 510 − 490 = 20
  const c4 = await conv("4100000000305");
  assert.deepEqual(await gateOf(c4), { ok: true }, "còn 20đ (> 0) ⇒ cho");
  await note(c4.id); // 20 − 490 = −470
  const bal = (await readAiBalance(U)).totalVnd;
  assert.ok(bal < 0 && bal > -unit, `âm tối đa một đơn giá: ${bal}`);
  const c5 = await conv("4100000000306");
  assert.equal((await gateOf(c5)).ok, false, "âm ⇒ chặn khách mới");
  assert.deepEqual(await gateOf(c4), { ok: true }, "khách vừa tính vẫn được trả lời");

  // ── Tặng 1.000đ ⇒ khách mới được trả lời và bị trừ vào tiền TẶNG trước.
  assert.ok("ok" in (await adjustAiBalance(op, { orgCode: U, kind: "PROMO_CREDIT", amountVnd: 1_000, reason: "Tặng canary", requestKey: "rkaibu00002" })));
  assert.deepEqual(await gateOf(c5), { ok: true });
  await note(c5.id);
  const promoUse = (await usage()).filter((r) => r.fundsClass === "PROMO");
  assert.equal(promoUse.length, 1, "đủ tiền tặng ⇒ trừ tiền tặng trước");
  const after = await readAiBalance(U);
  assert.deepEqual([after.promoVnd, after.cashVnd], [1_000 - unit, 1_000 - 3 * unit]);

  // ── Báo số dư: dưới ngưỡng ⇒ «sắp hết» một lần mỗi ngày; hết ⇒ «hết» (mức riêng).
  await withOrganization(U, async () => {
    const a1 = await runAiBalanceAlerts(now);
    assert.equal(a1.sent, "LOW", JSON.stringify(a1));
    assert.equal((await runAiBalanceAlerts(now)).sent, null, "cùng ngày ⇒ không báo lần hai");
    await adjustAiBalance(op, { orgCode: U, kind: "ADJUST_PROMO", amountVnd: -(1_000 - unit), reason: "Thu hồi tiền tặng thử", requestKey: "rkaibu00003" });
    const a2 = await runAiBalanceAlerts(now);
    assert.equal(a2.sent, "EXHAUSTED", JSON.stringify(a2));
    const rows = await (await getDb()).select().from(schema.notifications).where(like(schema.notifications.dedupeKey, `ai-balance:${U}:%`));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.href === "/settings/ai-balance" && !/token|usd|model/i.test(`${r.title} ${r.body}`)), "chuông dẫn tới trang nạp tiền, không lộ số nội bộ");
  });

  // ── M2: BÌNH LUẬN — khách AI là NGƯỜI bình luận (đồng hồ ghi theo người bình luận). Hết số dư: người đã tính trong tháng vẫn
  //    được trả lời, người bình luận MỚI bị chặn; dựng khoá thiếu người bình luận (lỗi cũ) thì chặn oan cả người đã trả tiền.
  const cC = await conv("4100000000399");
  await withOrganization(U, () => noteAiCustomerReply(cC.id, now, { threadKind: "COMMENT", commenterId: "cmt-aibu-1" }));
  const commenterGate = (commenterId: string | null) =>
    withOrganization(U, () => salesAiPlanGate({ now, conversation: { channel: cC.channel, pageId: cC.pageId, threadId: cC.threadId, visitorKey: cC.visitorKey, threadKind: "COMMENT", commenterId } }));
  assert.deepEqual(await commenterGate("cmt-aibu-1"), { ok: true }, "người bình luận đã tính trong tháng vẫn được AI trả lời");
  assert.equal((await commenterGate("cmt-aibu-2")).ok, false, "người bình luận MỚI khi hết số dư ⇒ chặn");
  assert.equal((await gateOf(cC)).ok, false, "khoá thiếu người bình luận là khoá KHÁC — chính lỗi M2 nếu engine không truyền gợi ý");
  // Thanh trạng thái hộp thư đọc tin khách MỚI NHẤT của luồng: bình luận của người đã tính ⇒ không báo chặn; người mới ⇒ báo.
  await withOrganization(U, async () => {
    const db = await getDb();
    const inbound = (fromId: string, minutesAgo: number) =>
      db.insert(schema.salesChatInbound).values({ pageId: PAGE, threadId: cC.threadId!, messageId: `aibu-cmt-${fromId}-${minutesAgo}`, text: "Giá bao nhiêu ạ", kind: "COMMENT", fromId, status: "DONE", createdAt: new Date(now.getTime() - minutesAgo * 60_000) });
    await inbound("cmt-aibu-1", 2);
    await forgetAiStatus();
    assert.ok(!(await conversationAiBlocks({ ...cC, state: {} })).some((b) => b.code === "BALANCE_EXHAUSTED"), "bình luận của người đã tính ⇒ không báo chặn oan");
    await inbound("cmt-aibu-2", 1);
    await forgetAiStatus();
    assert.ok((await conversationAiBlocks({ ...cC, state: {} })).some((b) => b.code === "BALANCE_EXHAUSTED"), "người bình luận mới ⇒ báo đúng lý do");
  });

  // ── 5 khách vượt (4 tiền thật · 1 tiền tặng) đều đã thu qua Số dư ⇒ hoá đơn ước tính + bảng kê KHÔNG thu lại (thu hai lần).
  const per = usagePeriodOf(now);
  const spent = (await readAiBalancePeriod(per.from, per.to)).get(U);
  assert.equal(spent?.aiCustomerUnits, 5, "sổ: 5 khách AI đã thu qua Số dư trong kỳ");
  const onEst = aiLineOf((await loadCustomerPlan(U))?.meter?.estimate?.overage);
  assert.ok(onEst?.overUnits === 0 && onEst.amountVnd === 0 && /đã thu qua Số dư AI 5 khách/.test(onEst.note ?? ""), `hoá đơn ước tính không thu lại khách đã trừ số dư: ${JSON.stringify(onEst)}`);
  const onSt = aiLineOf((await wsOf())?.pricing.overage);
  assert.ok(onSt?.overUnits === 0 && onSt.amountVnd === 0, `bảng kê kỳ không thu lại khách đã trừ số dư: ${JSON.stringify(onSt)}`);

  // ── Tắt cờ ⇒ không chặn, không trừ.
  assert.ok("ok" in (await setAiBalanceEnabled(op, { orgCode: U, enabled: false, reason: "Tắt canary" })));
  invalidateOrgFlags();
  const c6 = await conv("4100000000307");
  assert.deepEqual(await gateOf(c6), { ok: true }, "cờ tắt ⇒ không chặn");
  const before = (await usage()).length;
  await note(c6.id);
  assert.equal((await usage()).length, before, "cờ tắt ⇒ không trừ");
  // N2 (review 08/10/2026): tắt cờ rồi mới dựng / chốt bảng kê ⇒ 5 khách ĐÃ trừ số dư KHÔNG quay lại (từng thu hai lần, đóng băng
  // trong bảng kê FINAL); khách vượt MỚI sau khi tắt cờ (chưa trừ) tính theo khối như cũ — đúng 1 khối cho 1 khách.
  const block = growth.overage.aiCustomerBlockVnd as number;
  const planOff = await loadCustomerPlan(U);
  const offEst = aiLineOf(planOff?.meter?.estimate?.overage);
  assert.ok(planOff?.meter?.aiBalance === false && offEst?.overUnits === 1 && offEst.blocks === 1 && offEst.amountVnd === block && /đã thu qua Số dư AI 5 khách/.test(offEst.note ?? ""), `cờ tắt: hoá đơn ước tính chỉ tính khách chưa trừ: ${JSON.stringify(offEst)}`);
  const offSt = aiLineOf((await wsOf())?.pricing.overage);
  assert.deepEqual([offSt?.overUnits, offSt?.blocks, offSt?.amountVnd], [1, 1, block], "cờ tắt: bảng kê không thu lại 5 khách đã trừ số dư, chỉ khách vượt chưa trừ");

  // ── Khung kinh tế đơn vị /platform/saas (ảnh chụp MRR hôm nay như trang thật): doanh thu = MRR + tiền THẬT đã trừ (4 khách: 3 tin nhắn + 1 người bình luận),
  // tiền tặng đã trừ (1 khách) không vào; cờ đã tắt vẫn hiện tiền đã thu; tổ chức chưa từng dùng Số dư giữ cách tính cũ.
  // Khách trả tiền thật: thu phí bật, đã trả tới 30 ngày sau (mốc theo đồng hồ thật — cùng nhịp với ảnh chụp MRR hôm nay).
  const paidThrough = new Date(Date.now() + 30 * 86_400_000 + 7 * 3_600_000).toISOString().slice(0, 10);
  await pdb.update(schema.platformSubscriptions).set({ billingEnabled: true, paidThrough }).where(eq(schema.platformSubscriptions.orgCode, U));
  invalidateSubscriptions();
  // Mốc đọc = `now` + 1 giây: các khoản trừ ghi ở `now`, mốc cuối không tính — đọc theo đồng hồ thật thì lượt chạy vắt qua nửa đêm
  // ngày cuối tháng (giờ VN) đọc nhầm kỳ mới và đỏ (review #648 L7, AGENTS mục 50).
  const readAt = new Date(now.getTime() + 1_000);
  await captureSaasSnapshot(readAt);
  const econ = await loadPricingEconomics(op, readAt);
  assert.ok(econ.ok, JSON.stringify(econ));
  if (econ.ok) {
    const v = econ.value;
    const r = v.tenants.find((t) => t.code === U);
    assert.ok(r?.aiBalance, "tổ chức đã có dòng sổ ⇒ có khung Số dư");
    assert.deepEqual(
      r.aiBalance,
      { ...EMPTY_AI_BALANCE_PERIOD, usageCashVnd: 4 * unit, usagePromoVnd: unit, aiCustomerUnits: 5, adjustCashVnd: 1_000, balanceCashVnd: 1_000 - 4 * unit, balancePromoVnd: 0, enabled: false },
      "điều chỉnh tiền thật 1.000đ là tiền giữ, không phải nạp QR hay doanh thu; tiền tặng đã thu hồi hết",
    );
    assert.ok(r.mrrVnd !== null && r.mrrVnd > 0, `gói Growth đang tính tiền: ${r.mrrVnd}`);
    assert.equal(r.economics.revenueVnd, r.mrrVnd + 4 * unit, "doanh thu = MRR + tiền thật đã dùng AI; tiền tặng không vào");
    const rAi = aiLineOf(r.overage);
    assert.deepEqual([rAi?.overUnits, rAi?.amountVnd], [1, block], "khung /platform/saas in CÙNG phần vượt với bảng kê (sau khi trừ khách đã thu qua Số dư)");
    const aiProj = projectToPeriodEnd(4 * unit, v.elapsedDays, v.totalDays);
    assert.equal(r.projectedRevenueVnd, r.overage?.totalVnd === null || r.overage === null || aiProj === null ? null : r.mrrVnd + r.overage.totalVnd + Math.round(aiProj), "doanh thu chiếu = MRR + phần vượt chưa thu + doanh thu Số dư chiếu");
    // Tổng nền tảng = đúng hàm thuần trên sổ đọc lại độc lập (tập tổ chức trong khung · trừ nhà) — không phải «≥».
    const fresh = await readAiBalancePeriod(usagePeriodOf(readAt).from, readAt);
    assert.deepEqual(v.totals.aiBalance, aiBalanceTotals({ balances: fresh, tenantCodes: new Set(v.tenants.map((t) => t.code)), homeCode: home.code }));
    assert.ok(v.totals.aiBalance.revenueVnd >= 4 * unit && v.totals.aiBalance.heldOrgs >= 1, JSON.stringify(v.totals.aiBalance));
    const gm = platformGrossMargin({ mrrPayingVnd: v.totals.revenueVnd, aiBalanceRevenueToDateVnd: v.totals.aiBalance.revenueVnd, elapsedDays: v.elapsedDays, totalDays: v.totalDays, projectedAiCostVnd: v.totals.projectedPlatformAiCostVnd, infraVnd: v.totals.infraVnd });
    assert.deepEqual([v.totals.marginRevenueVnd, v.totals.grossProfitVnd, v.totals.grossMarginPct], [gm.marginRevenueVnd, gm.grossProfitVnd, gm.grossMarginPct], "lãi gộp tính lại được từ chính các ô trên màn");
    assert.equal(v.tenants.find((t) => t.code === TR)?.aiBalance, null, "chưa từng dùng Số dư, cờ tắt ⇒ không có khung");
  }
  // Cờ BẬT mà chưa có dòng sổ ⇒ khung Số dư 0đ THẬT (không phải «không dùng»), doanh thu theo đúng một công thức.
  assert.ok("ok" in (await setAiBalanceEnabled(op, { orgCode: TR, enabled: true, reason: "Canary chưa nạp" })));
  invalidateOrgFlags();
  const econ2 = await loadPricingEconomics(op, readAt);
  assert.ok(econ2.ok && econ2.value.tenants.find((t) => t.code === TR)?.aiBalance !== undefined);
  if (econ2.ok) assert.deepEqual(econ2.value.tenants.find((t) => t.code === TR)?.aiBalance, { ...EMPTY_AI_BALANCE_PERIOD, enabled: true });
  // Màn vận hành: dùng 30 ngày tách phần tiền thật (doanh thu) khỏi tiền tặng (review #648 L10).
  const opView = await loadAiBalanceOperatorView(op, readAt);
  assert.ok(!("error" in opView), JSON.stringify(opView));
  if (!("error" in opView)) {
    const row = opView.rows.find((x) => x.orgCode === U);
    assert.deepEqual([row?.usage30dVnd, row?.usage30dCashVnd], [5 * unit, 4 * unit], "dùng 30 ngày: 5 khách, trong đó 4 trừ tiền thật");
  }

  // ── M4: doanh thu Số dư vào phần KINH TẾ của /platform/customers + sản phẩm Chốt Đơn — KHÔNG thành dòng bảng kê.
  const snapEnd = await loadCommercialSnapshot({ now: readAt });
  const cust = snapEnd.customers.find((c) => c.workspaces.some((w) => w.code === U));
  assert.ok(cust && cust.economics.marginApplicable, "tổ chức U thuộc một tài khoản khách ngoài");
  assert.deepEqual([cust.economics.aiBalanceRevenueVnd, cust.economics.revenueVnd], [4 * unit, cust.statement.revenueKnownVnd + 4 * unit], "doanh thu kinh tế = bảng kê + doanh thu Số dư (tiền thật đã dùng)");
  assert.ok(!cust.statement.lines.some((l) => /số dư/i.test(l.label)), "doanh thu Số dư KHÔNG thành dòng bảng kê (đã thu qua số dư)");
  const chot = productEconomics(snapEnd).find((p) => p.product.key === "chotdon");
  const ownChot = snapEnd.customers.filter((c) => c.economics.marginApplicable).flatMap((c) => c.statement.lines.filter((l) => (l.kind === "PRODUCT_PLAN" || l.kind === "OVERAGE") && l.productKey === "chotdon"));
  const balanceAll = snapEnd.customers.filter((c) => c.economics.marginApplicable).reduce((s, c) => s + c.economics.aiBalanceRevenueVnd, 0);
  assert.ok(balanceAll >= 4 * unit);
  if (!ownChot.some((l) => l.amountVnd === null)) assert.equal(chot?.revenueVnd, ownChot.reduce((s, l) => s + (l.amountVnd ?? 0), 0) + balanceAll, "sản phẩm Chốt Đơn gồm doanh thu Số dư");

  // ── M3: ĐẢO một khoản trừ oan — trả lại số dư, TRỪ khỏi doanh thu, không tính lại khách ở bảng kê; trần = tiền thật đã trừ chưa đảo.
  const revOk = await adjustAiBalance(op, { orgCode: U, kind: "REVERSE_USAGE", amountVnd: unit, reason: "Trừ oan khách thử", requestKey: "rkaibu00009" });
  assert.ok("ok" in revOk, JSON.stringify(revOk));
  const pAfter = (await readAiBalancePeriod(per.from, per.to)).get(U);
  assert.deepEqual([pAfter?.reversalCashVnd, pAfter?.usageCashVnd, pAfter?.aiCustomerUnits, pAfter?.adjustCashVnd], [unit, 4 * unit, 5, 1_000], "khoản đảo tách khỏi điều chỉnh tay; số khách đã thu KHÔNG giảm");
  assert.equal((await readAiBalance(U)).cashVnd, 1_000 - 4 * unit + unit, "đảo ⇒ tiền thật trở lại số dư");
  assert.equal((await loadCommercialSnapshot({ now: readAt })).customers.find((c) => c.workspaces.some((w) => w.code === U))?.economics.aiBalanceRevenueVnd, 3 * unit, "doanh thu kỳ = tiền thật đã dùng − khoản đảo");
  assert.equal(aiLineOf((await wsOf())?.pricing.overage)?.overUnits, 1, "khách bị trừ oan không bị tính lại ở bảng kê");
  const tooMuch = await adjustAiBalance(op, { orgCode: U, kind: "REVERSE_USAGE", amountVnd: 4 * unit, reason: "Đảo vượt số đã trừ", requestKey: "rkaibu00010" });
  assert.ok("error" in tooMuch && /tối đa/.test(tooMuch.error), `đảo vượt tiền thật đã trừ chưa đảo ⇒ từ chối: ${JSON.stringify(tooMuch)}`);
  assert.ok("error" in (await adjustAiBalance(op, { orgCode: U, kind: "REVERSE_USAGE", amountVnd: -unit, reason: "Số âm không hợp lệ", requestKey: "rkaibu00011" })), "đảo nhập số dương");
}

export async function testAiBalanceUsage() {
  testSource();
  await cleanup();
  for (const code of ORGS) await provisionOrganization({ code, name: `Tổ chức ${code}`, plan: "trial", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "AiBalanceU@12345" }, source: "TEST", actor: null });
  // Đồng hồ khách AI ĐO TRỌN kỳ (bật từ trước đầu tháng) — máy thử dựng sổ giá hôm nay nên mặc định là «đo chưa trọn kỳ» và
  // dòng khách AI là CHƯA BIẾT; khi ấy không kiểm được phần trừ theo sổ cái. Trả lại đúng giá trị cũ sau bài.
  const pdb = await getPlatformDb();
  const savedLive = (await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, AI_CUSTOMER_METER_LIVE_KEY) }))?.value;
  const live = { at: new Date(usagePeriodOf(new Date()).from.getTime() - 86_400_000).toISOString() };
  await pdb.insert(schema.platformSettings).values({ key: AI_CUSTOMER_METER_LIVE_KEY, value: live }).onConflictDoUpdate({ target: schema.platformSettings.key, set: { value: live } });
  try {
    await run();
  } finally {
    await cleanup();
    if (savedLive === undefined) await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, AI_CUSTOMER_METER_LIVE_KEY));
    else await pdb.update(schema.platformSettings).set({ value: savedLive }).where(eq(schema.platformSettings.key, AI_CUSTOMER_METER_LIVE_KEY));
  }
  console.log(
    "✓ Trừ Số dư AI: trong phần gồm ⇒ không trừ · vượt ⇒ 490đ (Growth V1) mỗi khách MỚI, một lần mỗi kỳ, dòng sổ mang phiên bản giá · hết số dư ⇒ chặn khách mới, khách đã tính vẫn được trả lời · dương nhỏ hơn đơn giá ⇒ cho, âm tối đa một đơn giá · tiền tặng trừ trước · hộp thư nói lý do + lối nạp tiền · báo sắp hết / hết một lần mỗi ngày · tắt cờ ⇒ không chặn không trừ · dùng thử không trừ số dư · khách AI đã trừ số dư không nằm lại trong hoá đơn ước tính / bảng kê kỳ · bình luận: cổng + thanh trạng thái hỏi đúng NGƯỜI bình luận · khung /platform/saas: doanh thu = MRR + tiền thật đã trừ, tiền tặng không vào",
  );
}

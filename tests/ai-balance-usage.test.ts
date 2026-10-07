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
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { initWorkspaceBilling } from "@/lib/billing/service";
import { invalidateSubscriptions } from "@/lib/billing/standing";
import { adjustAiBalance, readAiBalance } from "@/lib/billing/ai-balance";
import { balanceOverageTerms, chargeAiCustomerUsage, runAiBalanceAlerts } from "@/lib/billing/ai-usage-charge";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { setAiBalanceEnabled } from "@/lib/platform/kill-switches";
import { invalidateOrgFlags } from "@/lib/platform/org-flags";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { loadCustomerPlan } from "@/lib/pricing/customer";
import { loadCommercialSnapshot } from "@/lib/saas/customers";
import { noteAiCustomerReply, resetAiCustomerSeenForTests } from "@/lib/pricing/ai-customer";
import { aiCustomerKeys } from "@/lib/pricing/ai-customer-identity";
import { invalidateAiEntitlement, salesAiPlanGate } from "@/lib/pricing/ai-gate";
import { invalidatePricing } from "@/lib/pricing/entitlements";
import { invalidatePriceBook, loadPriceBook } from "@/lib/pricing/price-book";
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

  // ── H2: khách AI vượt phần gồm trừ vào Số dư ⇒ KHÔNG nằm lại trong hoá đơn ước tính của khách lẫn bảng kê kỳ (thu hai lần).
  const planOn = await loadCustomerPlan(U);
  assert.ok(planOn?.meter?.aiBalance === true && planOn.meter.estimate && !planOn.meter.estimate.overage.lines.some((l) => l.key === "aiCustomers"), JSON.stringify(planOn?.meter?.estimate?.overage.lines));
  const wsOf = async () => (await loadCommercialSnapshot({ now })).customers.flatMap((c) => c.workspaces).find((w) => w.code === U);
  const wsOn = await wsOf();
  assert.ok(wsOn?.pricing.overage && !wsOn.pricing.overage.lines.some((l) => l.key === "aiCustomers"), `bảng kê kỳ không thu lại khách AI đã trừ số dư: ${JSON.stringify(wsOn?.pricing.overage)}`);

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

  // ── Tắt cờ ⇒ không chặn, không trừ.
  assert.ok("ok" in (await setAiBalanceEnabled(op, { orgCode: U, enabled: false, reason: "Tắt canary" })));
  invalidateOrgFlags();
  const c6 = await conv("4100000000307");
  assert.deepEqual(await gateOf(c6), { ok: true }, "cờ tắt ⇒ không chặn");
  const before = (await usage()).length;
  await note(c6.id);
  assert.equal((await usage()).length, before, "cờ tắt ⇒ không trừ");
  // Cờ tắt ⇒ phần vượt khách AI quay lại hoá đơn ước tính / bảng kê như cũ (không còn đường trừ số dư).
  const planOff = await loadCustomerPlan(U);
  assert.ok(planOff?.meter?.aiBalance === false && planOff.meter.estimate?.overage.lines.some((l) => l.key === "aiCustomers"), "cờ tắt ⇒ hoá đơn ước tính như cũ");
  assert.ok((await wsOf())?.pricing.overage?.lines.some((l) => l.key === "aiCustomers"), "cờ tắt ⇒ bảng kê như cũ");
}

export async function testAiBalanceUsage() {
  testSource();
  await cleanup();
  for (const code of ORGS) await provisionOrganization({ code, name: `Tổ chức ${code}`, plan: "trial", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "AiBalanceU@12345" }, source: "TEST", actor: null });
  try {
    await run();
  } finally {
    await cleanup();
  }
  console.log(
    "✓ Trừ Số dư AI: trong phần gồm ⇒ không trừ · vượt ⇒ 490đ (Growth V1) mỗi khách MỚI, một lần mỗi kỳ, dòng sổ mang phiên bản giá · hết số dư ⇒ chặn khách mới, khách đã tính vẫn được trả lời · dương nhỏ hơn đơn giá ⇒ cho, âm tối đa một đơn giá · tiền tặng trừ trước · hộp thư nói lý do + lối nạp tiền · báo sắp hết / hết một lần mỗi ngày · tắt cờ ⇒ không chặn không trừ · dùng thử không trừ số dư · khách AI đã trừ số dư không nằm lại trong hoá đơn ước tính / bảng kê kỳ · bình luận: cổng + thanh trạng thái hỏi đúng NGƯỜI bình luận",
  );
}

/**
 * HARDENING SỐ DƯ AI (review độc lập #644, các mục LOW):
 *  1. Báo «hết số dư» tách theo mức CHẶN: bản «chưa chặn» buổi sáng không nuốt bản «AI đã ngừng nhận khách mới» trong cùng ngày.
 *  2. Thanh trạng thái hộp thư: gợi ý người bình luận đọc tin KHÁCH mới nhất — dòng bot / page tự gửi (BOT_SENT · PAGE_REPLY,
 *     loại INBOX mặc định) không che tin bình luận.
 *  3. Job `sepay-reconcile` chỉ đối chiếu sổ thu phí ở tổ chức NHÀ, có trần ngày (quét mã nguồn — job chạy theo lịch).
 * Tài khoản nhận đọc hỏng ⇒ không khoá «giữ lại»: cuối `tests/ai-balance.test.ts`. Nhập sao kê không đè mô tả dòng SePay:
 * `tests/bank-ledger.test.ts` (6c).
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { eq, inArray, like, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { initWorkspaceBilling } from "@/lib/billing/service";
import { invalidateSubscriptions } from "@/lib/billing/standing";
import { balanceOverageTerms, runAiBalanceAlerts } from "@/lib/billing/ai-usage-charge";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { setAiBalanceEnabled } from "@/lib/platform/kill-switches";
import { invalidateOrgFlags } from "@/lib/platform/org-flags";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { resetAiCustomerSeenForTests } from "@/lib/pricing/ai-customer";
import { invalidateAiEntitlement } from "@/lib/pricing/ai-gate";
import { invalidatePricing } from "@/lib/pricing/entitlements";
import { invalidatePriceBook } from "@/lib/pricing/price-book";
import { meterMonthOf } from "@/lib/pricing/versions";
import { commenterHint } from "@/lib/sales-chatbot/ai-status";
import { PAGE_REPLY } from "@/lib/sales-chatbot/fanpage";

const X = "aibh-growth";
const OP_EMAIL = "op@aibh.local";
const PAGE = "667788990022";

function sessionUser(over: Partial<SessionUser>): SessionUser {
  return { id: "aibh-user", email: "aibh@local", name: "AIBH", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, ...over };
}

async function cleanup() {
  const pdb = await getPlatformDb();
  await pdb.delete(schema.platformUsageEvents).where(eq(schema.platformUsageEvents.orgCode, X));
  await pdb.delete(schema.platformAiLedgerEntries).where(eq(schema.platformAiLedgerEntries.orgCode, X));
  await pdb.delete(schema.platformAiAccounts).where(eq(schema.platformAiAccounts.orgCode, X));
  await pdb.delete(schema.platformPricePins).where(eq(schema.platformPricePins.orgCode, X));
  await pdb.delete(schema.platformSubscriptions).where(eq(schema.platformSubscriptions.orgCode, X));
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.actorEmail, OP_EMAIL));
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [X]));
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, X) });
  await pdb.delete(schema.platformProductSubscriptions).where(eq(schema.platformProductSubscriptions.orgCode, X));
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  rmSync(organizationDatabaseUrl({ code: X, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  invalidateOrganizations();
  invalidateCapabilities();
  invalidateSubscriptions();
  invalidatePricing();
  invalidatePriceBook();
  invalidateAiEntitlement();
  invalidateOrgFlags();
  resetAiCustomerSeenForTests();
}

async function seedAiCustomers(n: number, at: Date, tag: string) {
  const pdb = await getPlatformDb();
  await pdb.execute(sql`
    insert into platform_usage_events (id, occurred_at, org_code, product_key, metric, quantity, unit, source, event_key, metadata)
    select gen_random_uuid()::text, ${at.toISOString()}::timestamptz, ${X}, 'chotdon', 'ai_customers', 1, 'khách AI', 'test', ${`aic:${meterMonthOf(at)}:seed-aibh-${tag}:`} || g::text, '{}'::jsonb
    from generate_series(1, ${n}) g`);
}

function testSource() {
  const jobs = readFileSync(path.join(process.cwd(), "lib/sync/jobs.ts"), "utf8");
  assert.match(jobs, /apply === "1" && \(await currentOrganization\(\)\)\.isHome\) await reconcileBillingPayments\(\{ lookbackDays: Math\.min\(BILLING_RECONCILE_MAX_DAYS, /, "đối chiếu sổ thu phí chỉ ở tổ chức NHÀ, lùi có trần");
  assert.match(jobs, /const BILLING_RECONCILE_MAX_DAYS = \d+;/);
}

async function run() {
  const now = new Date();
  const pdb = await getPlatformDb();
  const home = await getHomeOrganization();
  const op = sessionUser({ id: "aibh-op", email: OP_EMAIL, organization: { code: home.code, name: home.name, isHome: true } });
  await pdb.update(schema.platformOrganizations).set({ plan: "growth" }).where(eq(schema.platformOrganizations.code, X));
  invalidateOrganizations();
  invalidatePricing();
  await initWorkspaceBilling(X, { selfService: false, now });
  const terms = await balanceOverageTerms(X);
  assert.ok(terms, "gói Growth trừ số dư");
  assert.ok("ok" in (await setAiBalanceEnabled(op, { orgCode: X, enabled: true, reason: "Canary hardening" })));
  invalidateOrgFlags();

  // ── 1. Số dư 0đ, khách AI CHƯA chạm phần gồm ⇒ «hết — nạp trước khi vượt»; chạm phần gồm cùng ngày ⇒ báo thêm «AI tạm không
  //       nhận khách mới» (khoá chống trùng tách theo mức chặn); mỗi bản một lần mỗi ngày.
  await seedAiCustomers(terms.included - 1, now, "a");
  const alert = () => withOrganization(X, () => runAiBalanceAlerts(now));
  assert.equal((await alert()).sent, "EXHAUSTED");
  assert.equal((await alert()).sent, null, "cùng ngày, cùng mức ⇒ không báo lần hai");
  await seedAiCustomers(1, now, "b");
  const blocking = await alert();
  assert.equal(blocking.sent, "EXHAUSTED", `chạm phần gồm ⇒ báo «đã ngừng nhận khách mới» dù sáng đã báo «hết»: ${JSON.stringify(blocking)}`);
  assert.equal((await alert()).sent, null);
  await withOrganization(X, async () => {
    const rows = await (await getDb()).select({ key: schema.notifications.dedupeKey, title: schema.notifications.title }).from(schema.notifications).where(like(schema.notifications.dedupeKey, `ai-balance:${X}:%`));
    assert.deepEqual(rows.map((r) => r.title).sort(), ["Số dư AI đã hết — AI tạm không nhận khách mới", "Số dư AI đã hết — nạp trước khi vượt phần gói gồm"], JSON.stringify(rows));
  });

  // ── 2. Gợi ý người bình luận bỏ dòng bot / page tự gửi.
  await withOrganization(X, async () => {
    const db = await getDb();
    const t = schema.salesChatInbound;
    const threadId = "aibh-post_1";
    const at = (min: number) => new Date(now.getTime() - min * 60_000);
    await db.insert(t).values([
      { pageId: PAGE, threadId, messageId: "aibh-c1", text: "Giá sao ạ", kind: "COMMENT", fromId: "cmt-aibh-1", status: "DONE", createdAt: at(5) },
      { pageId: PAGE, threadId, messageId: "aibh-b1", text: "Dạ 280k ạ", status: "DONE", note: "BOT_SENT", createdAt: at(4) },
      { pageId: PAGE, threadId, messageId: "aibh-p1", text: "Shop gửi thêm ảnh ạ", status: "DONE", note: PAGE_REPLY, createdAt: at(3) },
    ]);
    const conv = { channel: "FANPAGE", pageId: PAGE, threadId };
    assert.deepEqual(await commenterHint(conv), { threadKind: "COMMENT", commenterId: "cmt-aibh-1" }, "dòng bot / page tự gửi KHÔNG che tin bình luận của khách");
    await db.insert(t).values({ pageId: PAGE, threadId, messageId: "aibh-i1", text: "Em nhắn riêng nhé", kind: "INBOX", status: "DONE", createdAt: at(2) });
    assert.deepEqual(await commenterHint(conv), {}, "tin KHÁCH mới nhất là hộp thư ⇒ không gợi ý người bình luận");
    assert.deepEqual(await commenterHint({ channel: "WEB", pageId: null, threadId: null }), {});
  });
}

export async function testAiBalanceHardening() {
  testSource();
  await cleanup();
  await provisionOrganization({ code: X, name: `Tổ chức ${X}`, plan: "trial", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${X}.local`, name: `QT ${X}`, password: "AiBalanceH@12345" }, source: "TEST", actor: null });
  try {
    await run();
  } finally {
    await cleanup();
  }
  console.log("✓ Hardening Số dư AI: báo «hết» tách theo mức chặn (cùng ngày vẫn báo khi AI bắt đầu ngừng nhận khách mới) · gợi ý người bình luận bỏ dòng bot / page tự gửi · đối chiếu sổ thu phí chỉ ở tổ chức nhà, có trần ngày");
}

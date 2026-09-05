/**
 * Ngưỡng thanh toán tài khoản quảng cáo Facebook.
 * Meta thu tiền khi dư nợ chạm "ngưỡng thanh toán" (billing threshold) hoặc đến ngày lập hoá đơn. API không trả ngưỡng này,
 * nên ERP: (1) cho người dùng nhập ngưỡng từ Trung tâm thanh toán Meta; (2) tự học = dư nợ ngay trước lần thu tiền gần nhất
 * (dư nợ giảm mạnh giữa hai lần đọc). Cảnh báo khi dư nợ ≥ N% ngưỡng, và khi tài khoản bị vô hiệu hoá / chưa thanh toán.
 */
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { FacebookAdsClient } from "@/lib/integrations/facebook/client";
import { env } from "@/lib/env";

export type BillingRow = typeof schema.adAccountBilling.$inferSelect;

/** Học ngưỡng: dư nợ mới giảm ≥ 50% so với lần trước và lần trước đáng kể → coi lần trước là ngưỡng (Meta vừa thu tiền) */
export function learnThreshold(prev: { balance: number; learnedThreshold: number | null }, nextBalance: number, minAmount = 100_000) {
  if (prev.balance >= minAmount && nextBalance <= prev.balance * 0.5) return { learnedThreshold: prev.balance, paid: true };
  return { learnedThreshold: prev.learnedThreshold, paid: false };
}

export function effectiveThreshold(row: { threshold: number | null; learnedThreshold: number | null }) {
  return row.threshold && row.threshold > 0 ? row.threshold : row.learnedThreshold && row.learnedThreshold > 0 ? row.learnedThreshold : null;
}

/** Tài khoản đang bị chặn chạy quảng cáo (vì thanh toán hoặc lý do khác)? */
export function isBillingBlocked(row: { accountStatus: number; disableReason: number }) {
  return [2, 3, 8, 9].includes(row.accountStatus) || row.disableReason > 0;
}

/** Bị chặn vì thanh toán (chưa thanh toán / ân hạn / rủi ro thanh toán) chứ không phải vì chính sách */
export function isPaymentIssue(row: { accountStatus: number; disableReason: number }) {
  return [3, 8, 9].includes(row.accountStatus) || row.disableReason === 3;
}

export async function syncAdAccountBilling() {
  if (!env.facebook.accessToken) return { accounts: 0, paid: 0, skipped: "Chưa cấu hình FACEBOOK_ACCESS_TOKEN" };
  const db = await getDb();
  const client = new FacebookAdsClient();
  const accounts = await client.listAdAccountsBilling();
  const t = schema.adAccountBilling;
  let paid = 0;
  const now = new Date();
  for (const a of accounts) {
    const existing = await db.query.adAccountBilling.findFirst({ where: eq(t.accountId, a.accountId) });
    const learned = existing ? learnThreshold(existing, a.balance) : { learnedThreshold: null, paid: false };
    if (learned.paid) paid += 1;
    const values = {
      accountId: a.accountId,
      name: a.name,
      currency: a.currency,
      relation: a.relation,
      accountStatus: a.status,
      disableReason: a.disableReason,
      balance: a.balance,
      amountSpent: a.amountSpent,
      spendCap: a.spendCap,
      fundingSource: a.fundingSource,
      isPrepay: a.isPrepay,
      nextBillDate: a.nextBillDate,
      learnedThreshold: learned.learnedThreshold,
      prevBalance: existing?.balance ?? a.balance,
      lastPaidAt: learned.paid ? now : (existing?.lastPaidAt ?? null),
      fetchedAt: now,
      updatedAt: now,
    };
    await db
      .insert(t)
      .values(values)
      .onConflictDoUpdate({ target: t.accountId, set: { ...values, accountId: undefined } });
  }
  return { accounts: accounts.length, paid };
}

export async function listAdAccountBilling(): Promise<BillingRow[]> {
  const db = await getDb();
  return db.select().from(schema.adAccountBilling).orderBy(sql`${schema.adAccountBilling.balance} desc`);
}

export async function setAdAccountThreshold(accountId: string, threshold: number | null) {
  const db = await getDb();
  await db.update(schema.adAccountBilling).set({ threshold, updatedAt: new Date() }).where(eq(schema.adAccountBilling.accountId, accountId));
}

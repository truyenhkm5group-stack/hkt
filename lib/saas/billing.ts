/**
 * ═══════════ CHỐT BẢNG KÊ KỲ — CHỈ MÁY CHỦ (docs/saas/COST_BILLING.md §4) ═══════════
 *
 * Bảng kê NHÁP tính lúc đọc (`loadCommercialSnapshot`). Chốt = đóng băng ĐÚNG bảng kê người vận hành đang nhìn vào
 * `platform_billing_statements.snapshot` (dòng, nguồn, số dòng chưa biết, phiên bản bộ máy). Sau khi chốt, mọi màn hình đọc
 * ảnh chụp — sửa công thức tháng sau không đổi số kỳ đã chốt (AGENTS luật 21). Một tài khoản một kỳ một bảng kê.
 *
 * Chỉ chốt KỲ ĐÃ QUA: kỳ đang chạy còn đổi (tiền AI, ngày dùng thử…) — chốt sớm là đóng băng một con số chưa xong.
 */
import { and, eq } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { platformAudit, type PlatformActor } from "@/lib/platform/audit";
import { getHomeOrganization } from "@/lib/platform/organizations";
import { findAccountByCode } from "@/lib/saas/accounts";
import { loadCommercialSnapshot } from "@/lib/saas/customers";
import { currentPeriodMonth } from "@/lib/saas/ledger";
import { isPeriodMonth } from "@/lib/saas/statement";

export async function finalizeStatement(accountCode: string, periodMonth: string, ctx: { actor: PlatformActor; email: string | null; reason: string; source: "UI" | "SCRIPT" | "TEST"; now?: Date }): Promise<{ ok: true; id: string } | { error: string }> {
  if (!isPeriodMonth(periodMonth)) return { error: "Kỳ phải có dạng YYYY-MM-01." };
  if (periodMonth >= currentPeriodMonth(ctx.now)) return { error: "Chỉ chốt kỳ ĐÃ QUA — kỳ đang chạy còn đổi số." };
  if (ctx.reason.trim().length < 5) return { error: "Chốt bảng kê cần lý do (ít nhất 5 ký tự)." };
  const account = await findAccountByCode(accountCode);
  if (!account) return { error: "Không có tài khoản này." };
  const pdb = await getPlatformDb();
  const had = await pdb.query.platformBillingStatements.findFirst({ where: and(eq(schema.platformBillingStatements.accountId, account.id), eq(schema.platformBillingStatements.periodMonth, periodMonth)) });
  if (had) return { error: "Kỳ này đã chốt — bảng kê đã chốt không sửa được." };
  const snap = await loadCommercialSnapshot({ periodMonth, now: ctx.now });
  const view = snap.customers.find((c) => c.account.id === account.id);
  if (!view) return { error: "Không dựng được bảng kê của tài khoản." };
  const st = view.statement;
  const [row] = await pdb
    .insert(schema.platformBillingStatements)
    .values({
      accountId: account.id,
      periodMonth,
      billingMode: account.billingMode,
      status: "FINAL",
      totalKnownVnd: st.totalKnownVnd,
      unknownLines: st.unknownLines,
      snapshot: { lines: st.lines, revenueKnownVnd: st.revenueKnownVnd, costKnownVnd: st.costKnownVnd, economics: view.economics, workspaces: view.workspaces.map((w) => ({ code: w.code, planKey: w.planKey, priceVersionKey: w.pricing.versionKey, priceVersionPinned: w.pricing.pinned, subscriptions: w.subscriptions.map((s) => ({ productKey: s.productKey, status: s.status, planKey: s.planKey })) })), usdToVnd: snap.usdToVnd },
      engineVersion: st.engineVersion,
      finalizedByEmail: ctx.email,
    })
    .onConflictDoNothing()
    .returning({ id: schema.platformBillingStatements.id });
  if (!row) return { error: "Kỳ này vừa được chốt bởi người khác." };
  const home = await getHomeOrganization();
  await platformAudit({ action: "STATEMENT_FINALIZE", targetOrgCode: view.workspaces[0]?.code ?? home.code, targetAccountId: account.id, subject: `statement:${periodMonth}`, after: { totalKnownVnd: st.totalKnownVnd, unknownLines: st.unknownLines, billingMode: account.billingMode }, reason: ctx.reason, source: ctx.source, actor: ctx.actor });
  return { ok: true, id: row.id };
}

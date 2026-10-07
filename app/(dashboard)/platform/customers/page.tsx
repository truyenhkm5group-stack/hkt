import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { CostEntryForm, CreateCustomerForm } from "@/components/saas/operator-actions";
import { SaasConsoleNav, StatusPill } from "@/components/saas/console-bits";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { formatNumber, formatPercent, formatVND } from "@/lib/format";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { PRODUCT_LABEL, PRODUCTS } from "@/lib/saas/catalog";
import { loadCustomersConsole } from "@/lib/saas/console";
import { HEALTH_FLAG_LABEL } from "@/lib/saas/customers";
import { ACCOUNT_STATUS_LABEL, ACCOUNT_TYPE_LABEL, ACCOUNT_TYPE_TONE, SUBSCRIPTION_STATUS_LABEL, type AccountStatus, type AccountType } from "@/lib/saas/policy";
import { cn } from "@/lib/utils";

export const metadata = { title: "Khách hàng SaaS" };

const th = "px-3 py-2";
const thead = "bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground";

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-hairline bg-card px-3 py-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="numeric mt-0.5 text-xl font-bold">{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

/**
 * KHÁCH HÀNG SAAS — danh sách tài khoản (khách nội bộ và khách ngoài, CÙNG một bảng, cùng cột). Chỉ người vận hành nền tảng.
 * Số của kỳ tháng hiện tại (giờ VN): MRR = phần khách trả (gói · mua thêm · vượt) theo bảng kê nháp; chargeback nội bộ in
 * ở cột riêng vì nó không phải doanh thu thị trường. Chi phí = AI nền tảng trả + phần phân bổ. Ô `—` = chưa biết.
 */
export default async function SaasCustomersPage({ searchParams }: { searchParams: Promise<{ ky?: string }> }) {
  const user = await requirePermission("platform:operate");
  if (platformOperatorDenial(user)) redirect("/?forbidden=1");
  const { ky } = await searchParams;
  const data = await loadCustomersConsole(user, ky);
  if ("error" in data) redirect("/?forbidden=1");
  const { customers } = data;
  const external = customers.filter((c) => c.economics.marginApplicable);
  const internal = customers.filter((c) => !c.economics.marginApplicable);
  const statuses = customers.flatMap((c) => c.workspaces.flatMap((w) => w.subscriptions.map((s) => s.status)));
  const mrrKnown = external.filter((c) => c.economics.revenueVnd !== null);
  const mrr = mrrKnown.reduce((a, c) => a + (c.economics.revenueVnd ?? 0), 0);
  const cost = customers.reduce((a, c) => a + c.economics.costVnd, 0);
  const gp = mrrKnown.reduce((a, c) => a + (c.economics.grossProfitVnd ?? 0), 0);
  const balanceRev = mrrKnown.reduce((a, c) => a + c.economics.aiBalanceRevenueVnd, 0);
  const alerts = customers.filter((c) => c.flags.length);
  const label = `${data.periodMonth.slice(5, 7)}/${data.periodMonth.slice(0, 4)}`;

  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Hệ thống" title="Khách hàng SaaS" actions={<SaasConsoleNav active="/platform/customers" />} description={`${customers.length} tài khoản · ${internal.length} nội bộ · kỳ ${label}`} />

      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Tài khoản" value={formatNumber(customers.length)} sub={`${external.length} ngoài · ${internal.length} nội bộ`} />
        <Tile label="Thuê bao sống" value={formatNumber(statuses.length)} sub={`${statuses.filter((s) => s === "TRIAL").length} dùng thử · ${statuses.filter((s) => s === "PAST_DUE" || s === "EXPIRED").length} quá hạn`} />
        <Tile label="Doanh thu kỳ (khách ngoài)" value={formatVND(mrr)} sub={mrrKnown.length < external.length ? `${external.length - mrrKnown.length} khách có gói không niêm yết giá` : balanceRev ? `gồm Số dư AI ${formatVND(balanceRev)}` : "gói · mua thêm · vượt"} />
        <Tile label="Chi phí kỳ" value={formatVND(cost)} sub="AI nền tảng trả + phân bổ" />
        <Tile label="Lãi gộp (khách ngoài)" value={formatVND(gp)} sub={mrr ? formatPercent((gp / mrr) * 100) : "—"} />
        <Tile label="Cần xử lý" value={formatNumber(alerts.length)} sub="khách có cờ cảnh báo" />
      </div>

      {alerts.length ? (
        <SectionCard title="Cảnh báo" description="Lỗ gộp · quá hạn · cấp phát hỏng · chi phí chưa biết">
          <ul className="space-y-1 text-sm">
            {alerts.map((c) => (
              <li key={c.account.id} className="flex flex-wrap items-center gap-2">
                <Link href={`/platform/customers/${c.account.code}`} className="font-medium text-primary hover:underline">
                  {c.account.name}
                </Link>
                {c.flags.map((f) => (
                  <StatusPill key={f} tone={f === "UNKNOWN_COST" ? "muted" : "bad"}>
                    {HEALTH_FLAG_LABEL[f]}
                  </StatusPill>
                ))}
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <SectionCard title="Tài khoản khách" padded={false}>
        {customers.length === 0 ? (
          <EmptyState title="Chưa có tài khoản nào" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-sm">
              <thead className={thead}>
                <tr>
                  <th className={th}>Khách</th>
                  <th className={th}>Sản phẩm · gói</th>
                  <th className={cn(th, "text-right")}>MRR / chargeback</th>
                  <th className={cn(th, "text-right")}>Chi phí</th>
                  <th className={cn(th, "text-right")}>Biên gộp</th>
                  <th className={th}>Dùng</th>
                  <th className={th}>Tình trạng</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => {
                  const subs = c.workspaces.flatMap((w) => w.subscriptions);
                  const conv = c.workspaces.flatMap((w) => w.usage).filter((u) => u.metric === "conversations_started").reduce((a, u) => (u.value === null ? a : (a ?? 0) + u.value), null as number | null);
                  return (
                    <tr key={c.account.id} className="border-t border-hairline align-top">
                      <td className={th}>
                        <Link href={`/platform/customers/${c.account.code}`} className="font-medium text-primary hover:underline">
                          {c.account.name}
                        </Link>
                        <div className="mt-0.5 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
                          <StatusPill tone={ACCOUNT_TYPE_TONE[c.account.accountType as AccountType]}>{ACCOUNT_TYPE_LABEL[c.account.accountType as AccountType]}</StatusPill>
                          <span>
                            {c.workspaces.length} workspace · {ACCOUNT_STATUS_LABEL[c.account.status as AccountStatus]}
                          </span>
                        </div>
                      </td>
                      <td className={th}>
                        {subs.length ? (
                          subs.map((s) => (
                            <div key={s.id} className="text-xs">
                              {PRODUCT_LABEL[s.productKey] ?? s.productKey} · {s.planName}
                            </div>
                          ))
                        ) : (
                          <span className="text-xs text-muted-foreground">chưa thuê sản phẩm nào</span>
                        )}
                      </td>
                      <td className={cn(th, "numeric text-right")}>{c.economics.marginApplicable ? formatVND(c.economics.revenueVnd) : <span title="Chargeback nội bộ: chi phí biến đổi khách nội bộ tiêu">{formatVND(c.statement.totalKnownVnd)}</span>}</td>
                      <td className={cn(th, "numeric text-right")}>{formatVND(c.economics.costVnd)}</td>
                      <td className={cn(th, "numeric text-right", c.economics.grossProfitVnd !== null && c.economics.grossProfitVnd < 0 && "text-rose-700 dark:text-rose-400")}>{c.economics.marginApplicable ? formatPercent(c.economics.marginPct) : "N/A"}</td>
                      <td className={cn(th, "text-xs")}>{conv === null ? "—" : `${formatNumber(conv)} hội thoại`}</td>
                      <td className={th}>
                        <div className="flex flex-wrap gap-1">
                          {[...new Set(subs.map((s) => s.status))].map((st) => (
                            <StatusPill key={st} tone={st === "ACTIVE" ? "good" : st === "TRIAL" ? "info" : "bad"}>
                              {SUBSCRIPTION_STATUS_LABEL[st]}
                            </StatusPill>
                          ))}
                          {c.failedJobs ? <StatusPill tone="bad">{c.failedJobs} job hỏng</StatusPill> : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {data.orphanWorkspaces.length || data.mergeCandidates.length ? (
        <SectionCard title="Cần người vận hành quyết">
          <ul className="space-y-1 text-sm">
            {data.orphanWorkspaces.map((w) => (
              <li key={w.code}>
                Workspace <b>{w.code}</b> chưa gắn tài khoản — tạo khách cho nó (chọn «Tài khoản mới») hoặc chuyển nó vào tài khoản có sẵn.
              </li>
            ))}
            {data.mergeCandidates.map((m) => (
              <li key={m.stem}>
                Có thể cùng một khách: {m.accounts.join(", ")} — máy KHÔNG tự gộp; nếu đúng, mở từng tài khoản và «Chuyển sang tài khoản khác».
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <SectionCard title="Tạo khách mới" description="Tài khoản → workspace → thuê bao → module → quản trị, qua job cấp phát có vết. Không sửa CSDL tay.">
        <CreateCustomerForm plans={data.plans.map((p) => ({ key: p.key, name: p.name, priceVnd: p.priceVnd }))} products={PRODUCTS.map((p) => ({ key: p.key, name: p.name }))} accounts={customers.map((c) => ({ id: c.account.id, code: c.account.code, name: c.account.name }))} />
      </SectionCard>

      <SectionCard title="Chi phí cấp nền tảng / sản phẩm" description="Khoản chi ngoài AI chia theo căn cứ khai (hạ tầng / hỗ trợ nền theo tháng khai ở Kinh tế nền tảng).">
        <CostEntryForm periodMonth={data.periodMonth} workspaces={[]} products={PRODUCTS.map((p) => ({ key: p.key, name: p.name }))} />
      </SectionCard>
    </div>
  );
}

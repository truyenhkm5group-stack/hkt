import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { SaasConsoleNav, StatusPill } from "@/components/saas/console-bits";
import { AccountEditForm, CostEntryForm, FinalizeStatementButton, MoveWorkspaceForm, ReconcileButton, RetryJobButton, SubscribeProductForm, SubscriptionButtons, VoidCostButton } from "@/components/saas/operator-actions";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { BILLING_STANDING_LABEL } from "@/lib/billing/rules";
import { formatDate, formatDateTime, formatNumber, formatPercent, formatVND } from "@/lib/format";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { ALLOCATION_BASIS_LABEL } from "@/lib/saas/allocation";
import { PRODUCT_LABEL, PRODUCTS } from "@/lib/saas/catalog";
import { loadCustomerDetail } from "@/lib/saas/console";
import { HEALTH_FLAG_LABEL, readPlans } from "@/lib/saas/customers";
import { ACCOUNT_STATUS_LABEL, ACCOUNT_TYPE_LABEL, ACCOUNT_TYPE_TONE, BILLING_MODE_LABEL, SUBSCRIPTION_STATUS_LABEL, statementLabel, type AccountStatus, type AccountType, type BillingMode } from "@/lib/saas/policy";
import { JOB_KIND_LABEL, JOB_STATUS_LABEL, type JobStatus, type JobStep, type ProvisioningKind } from "@/lib/saas/provisioning";
import { STATEMENT_LINE_LABEL } from "@/lib/saas/statement";
import { runningVersion } from "@/lib/version";
import { cn } from "@/lib/utils";

export const metadata = { title: "Khách hàng" };

const th = "px-3 py-2";
const thead = "bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground";

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-hairline px-3 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="numeric text-lg font-bold">{value}</p>
      {sub ? <p className="text-[11px] text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

function prevMonth(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, "0")}-01`;
}

/**
 * MỘT KHÁCH — control center. Cùng trang, cùng component cho khách nội bộ (VNXCommerce) và khách ngoài; chỗ khác nhau
 * duy nhất là nhãn loại tài khoản + nhóm dòng của bảng kê (do `billing_mode`). Chỉ người vận hành nền tảng.
 */
export default async function SaasCustomerPage({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<{ ky?: string }> }) {
  const user = await requirePermission("platform:operate");
  if (platformOperatorDenial(user)) redirect("/?forbidden=1");
  const [{ code }, { ky }] = await Promise.all([params, searchParams]);
  const d = await loadCustomerDetail(user, code, ky);
  if (!d) notFound();
  if ("error" in d) redirect("/?forbidden=1");
  const { customer: c } = d;
  const a = c.account;
  const mode = a.billingMode as BillingMode;
  const version = runningVersion();
  const allProducts = PRODUCTS.map((p) => ({ key: p.key, name: p.name }));
  const planList = (await readPlans()).map((p) => ({ key: p.key, name: p.name }));
  const label = `${d.periodMonth.slice(5, 7)}/${d.periodMonth.slice(0, 4)}`;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Khách hàng SaaS"
        title={a.name}
        actions={<SaasConsoleNav active="/platform/customers" />}
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            <StatusPill tone={ACCOUNT_TYPE_TONE[a.accountType as AccountType]}>{ACCOUNT_TYPE_LABEL[a.accountType as AccountType]}</StatusPill>
            <span>
              {a.code} · {BILLING_MODE_LABEL[mode]} · {ACCOUNT_STATUS_LABEL[a.status as AccountStatus]} · kỳ {label}
            </span>
            {c.flags.map((f) => (
              <StatusPill key={f} tone={f === "UNKNOWN_COST" ? "muted" : "bad"}>
                {HEALTH_FLAG_LABEL[f]}
              </StatusPill>
            ))}
          </span>
        }
      />

      {/* Tổng quan */}
      <SectionCard title="Tổng quan">
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label={c.economics.marginApplicable ? "Doanh thu kỳ" : "Chargeback kỳ"} value={c.economics.marginApplicable ? formatVND(c.economics.revenueVnd) : formatVND(c.statement.totalKnownVnd)} sub={c.statement.unknownLines ? `${c.statement.unknownLines} dòng chưa biết số` : undefined} />
          <Stat label="Chi phí kỳ" value={formatVND(c.economics.costVnd)} sub="AI nền tảng trả + phân bổ" />
          <Stat label="Lãi gộp" value={c.economics.marginApplicable ? formatVND(c.economics.grossProfitVnd) : "N/A"} sub={c.economics.marginApplicable ? formatPercent(c.economics.marginPct) : "trung tâm chi phí nội bộ"} />
          <Stat label="AI khoá riêng (BYOK)" value={`$${c.economics.byokUsd.toFixed(2)}`} sub="tiền của khách, không trừ vào biên" />
          <Stat label="Sản phẩm đang dùng" value={formatNumber(c.products.length)} sub={c.products.map((p) => PRODUCT_LABEL[p] ?? p).join(" · ") || "—"} />
          <Stat label="Workspace" value={formatNumber(c.workspaces.length)} />
        </div>
        <div className="mt-3">
          <AccountEditForm account={{ code: a.code, name: a.name, accountType: a.accountType, billingMode: a.billingMode, status: a.status, legalName: a.legalName, taxCode: a.taxCode, billingEmail: a.billingEmail }} />
        </div>
      </SectionCard>

      {/* Workspace · sản phẩm · thuê bao · entitlement */}
      {c.workspaces.length === 0 ? (
        <EmptyState title="Tài khoản chưa có workspace" description="Tạo khách ở danh sách với «Tài khoản khách» = tài khoản này để thêm workspace." />
      ) : (
        c.workspaces.map((w) => {
          const reach = d.reach.get(w.code);
          const drift = d.drift[w.code];
          const ents = d.entitlements[w.code] ?? [];
          const missingProducts = allProducts.filter((p) => !w.subscriptions.some((s) => s.productKey === p.key));
          return (
            <SectionCard
              key={w.code}
              title={
                <span>
                  Workspace {w.name} <span className="text-xs font-normal text-muted-foreground">({w.code})</span>
                </span>
              }
              description={`Gói ${w.planKey} · ${BILLING_STANDING_LABEL[w.standing]} · ${w.status}`}
              actions={
                <Link href={`/platform/org/${w.code}`} className="text-sm text-primary hover:underline">
                  Sức khoẻ · module · kết nối →
                </Link>
              }
            >
              <div className="grid gap-2 text-xs sm:grid-cols-3">
                <Stat label="Người đã đăng nhập" value={formatNumber(reach?.identities ?? 0)} sub={`chỉ mục danh tính · lần cuối ${reach?.lastLoginAt ? formatDateTime(reach.lastLoginAt) : "—"}`} />
                <Stat label="Kênh Messenger nối thẳng" value={formatNumber(reach?.messengerPages ?? 0)} sub="page ⇒ workspace (platform_messenger_pages)" />
                <Stat label="Tạo lúc" value={formatDate(w.createdAt)} />
              </div>

              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead className={thead}>
                    <tr>
                      <th className={th}>Sản phẩm</th>
                      <th className={th}>Gói</th>
                      <th className={th}>Tình trạng</th>
                      <th className={th}>Khả năng (module)</th>
                      <th className={th}>Tính năng hiệu lực</th>
                      <th className={th}>Thao tác</th>
                    </tr>
                  </thead>
                  <tbody>
                    {w.subscriptions.map((s) => {
                      const e = ents.find((x) => x.productKey === s.productKey);
                      return (
                        <tr key={s.id} className="border-t border-hairline align-top">
                          <td className={th}>
                            <div className="font-medium">{PRODUCT_LABEL[s.productKey] ?? s.productKey}</div>
                            <div className="text-[11px] text-muted-foreground">từ {formatDate(s.startedAt)}</div>
                          </td>
                          <td className={cn(th, "text-xs")}>
                            {s.planName}
                            <div className="text-[11px] text-muted-foreground">{s.planSource === "WORKSPACE" ? "gói gộp của workspace" : "gói riêng"}</div>
                            {s.scheduledPlanKey ? <div className="text-[11px]">hẹn đổi {s.scheduledPlanKey} ngày {s.scheduledAt}</div> : null}
                          </td>
                          <td className={th}>
                            <StatusPill tone={s.status === "ACTIVE" ? "good" : s.status === "TRIAL" ? "info" : "bad"}>{SUBSCRIPTION_STATUS_LABEL[s.status]}</StatusPill>
                          </td>
                          <td className={cn(th, "text-xs")}>
                            {e?.capabilities.map((cap) => (
                              <div key={cap.key} className={cap.modulesOn ? "" : "text-muted-foreground line-through"} title={cap.missingModules.length ? `thiếu module: ${cap.missingModules.join(", ")}` : undefined}>
                                {cap.label}
                              </div>
                            ))}
                          </td>
                          <td className={cn(th, "text-xs")}>
                            {e && e.features.length ? (
                              <span title={e.features.map((f) => `${f.key}: ${f.effective ? "có" : "không"} (${f.source})`).join("\n")}>
                                {e.features.filter((f) => f.effective).length}/{e.features.length} tính năng
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className={th}>
                            <SubscriptionButtons accountCode={a.code} subscriptionId={s.id} state={s.state} productName={PRODUCT_LABEL[s.productKey] ?? s.productKey} />
                          </td>
                        </tr>
                      );
                    })}
                    {w.endedSubscriptions.map((s) => (
                      <tr key={s.id} className="border-t border-hairline text-muted-foreground">
                        <td className={th}>{PRODUCT_LABEL[s.productKey] ?? s.productKey}</td>
                        <td className={cn(th, "text-xs")} colSpan={5}>
                          Đã huỷ {s.endedAt ? formatDateTime(s.endedAt) : ""} — {s.endReason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {drift && (drift.missingSubscription.length || drift.subscribedButOff.length) ? (
                <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs dark:border-amber-800 dark:bg-amber-950">
                  {drift.missingSubscription.length ? <p>Module đang bật nhưng chưa có thuê bao: {drift.missingSubscription.map((p) => PRODUCT_LABEL[p] ?? p).join(", ")}.</p> : null}
                  {drift.subscribedButOff.length ? <p>Có thuê bao nhưng module của sản phẩm đang tắt: {drift.subscribedButOff.map((p) => PRODUCT_LABEL[p] ?? p).join(", ")} — bật module ở trang workspace.</p> : null}
                  {drift.missingSubscription.length ? (
                    <div className="mt-2">
                      <ReconcileButton accountCode={a.code} orgCode={w.code} />
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                <SubscribeProductForm accountCode={a.code} orgCode={w.code} products={missingProducts} plans={planList} />
                <MoveWorkspaceForm accountCode={a.code} orgCode={w.code} accounts={d.accounts} />
              </div>

              {/* Dùng */}
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead className={thead}>
                    <tr>
                      <th className={th}>Dùng kỳ {label}</th>
                      <th className={cn(th, "text-right")}>Số</th>
                      <th className={th}>Nguồn</th>
                    </tr>
                  </thead>
                  <tbody>
                    {w.usage
                      .filter((u) => w.subscriptions.some((s) => s.productKey === u.productKey))
                      .map((u) => (
                        <tr key={`${u.productKey}-${u.metric}`} className="border-t border-hairline">
                          <td className={th}>
                            {PRODUCT_LABEL[u.productKey] ?? u.productKey} · {u.label}
                          </td>
                          <td className={cn(th, "numeric text-right")}>{u.value === null ? "—" : u.unit === "USD" ? `$${u.value.toFixed(2)}` : formatNumber(u.value)}</td>
                          <td className={cn(th, "text-[11px] text-muted-foreground")}>
                            {u.source}
                            {u.note ? ` · ${u.note}` : ""}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          );
        })
      )}

      {/* Bảng kê */}
      <SectionCard title={`${statementLabel(mode)} — kỳ ${label} (nháp, tính lúc đọc)`} padded={false}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className={thead}>
              <tr>
                <th className={th}>Dòng</th>
                <th className={th}>Workspace · sản phẩm</th>
                <th className={cn(th, "text-right")}>Số tiền</th>
                <th className={th}>Ghi chú</th>
              </tr>
            </thead>
            <tbody>
              {c.statement.lines.map((l, i) => (
                <tr key={i} className="border-t border-hairline">
                  <td className={th}>
                    <div className="text-xs text-muted-foreground">{STATEMENT_LINE_LABEL[l.kind]}</div>
                    {l.label}
                  </td>
                  <td className={cn(th, "text-xs")}>
                    {l.orgCode ?? "tài khoản"}
                    {l.productKey ? ` · ${PRODUCT_LABEL[l.productKey] ?? l.productKey}` : ""}
                  </td>
                  <td className={cn(th, "numeric text-right")}>{formatVND(l.amountVnd)}</td>
                  <td className={cn(th, "text-xs text-muted-foreground")}>{l.note ?? ""}</td>
                </tr>
              ))}
              <tr className="border-t border-hairline font-semibold">
                <td className={th} colSpan={2}>
                  Tổng đã biết{c.statement.unknownLines ? ` (${c.statement.unknownLines} dòng chưa biết số — tổng là cận dưới)` : ""}
                </td>
                <td className={cn(th, "numeric text-right")}>{formatVND(c.statement.totalKnownVnd)}</td>
                <td className={th} />
              </tr>
            </tbody>
          </table>
        </div>
        <div className="space-y-2 px-5 py-3 text-sm">
          <FinalizeStatementButton accountCode={a.code} periodMonth={prevMonth(d.periodMonth)} />
          {d.statements.length ? (
            <ul className="space-y-0.5 text-xs">
              {d.statements.map((s) => (
                <li key={s.id}>
                  Đã chốt kỳ {s.periodMonth.slice(5, 7)}/{s.periodMonth.slice(0, 4)}: {formatVND(s.totalKnownVnd)}
                  {s.unknownLines ? ` · ${s.unknownLines} dòng chưa biết` : ""} · {formatDateTime(s.finalizedAt)} · {s.finalizedByEmail ?? "máy"} · {s.engineVersion}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">Chưa chốt kỳ nào.</p>
          )}
          {c.economics.marginApplicable ? <p className="text-xs text-muted-foreground">Thu tiền vẫn đi đường hoá đơn gia hạn / VietQR ở trang workspace — bảng kê không phải lệnh thu thứ hai.</p> : null}
        </div>
      </SectionCard>

      {/* Chi phí & biên */}
      <SectionCard title="Chi phí & biên" description="AI nền tảng trả theo sản phẩm, phần phân bổ có căn cứ, khoản chi trực tiếp.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className={thead}>
              <tr>
                <th className={th}>Khoản</th>
                <th className={th}>Workspace</th>
                <th className={th}>Căn cứ</th>
                <th className={cn(th, "text-right")}>VND</th>
              </tr>
            </thead>
            <tbody>
              {c.workspaces.flatMap((w) => [
                ...w.aiCost.map((x) => (
                  <tr key={`${w.code}-ai-${x.productKey}`} className="border-t border-hairline">
                    <td className={th}>
                      AI nền tảng trả · {x.productKey ? (PRODUCT_LABEL[x.productKey] ?? x.productKey) : "chưa gán sản phẩm"}
                      {x.unpricedCalls ? <span className="text-xs text-muted-foreground"> · {x.unpricedCalls} lượt chưa định giá</span> : null}
                    </td>
                    <td className={cn(th, "text-xs")}>{w.code}</td>
                    <td className={cn(th, "text-xs")}>{formatNumber(x.requests)} lượt</td>
                    <td className={cn(th, "numeric text-right")}>{formatVND(x.platformVnd)}</td>
                  </tr>
                )),
                ...w.allocated.map((l) => (
                  <tr key={`${w.code}-${l.entryId}`} className="border-t border-hairline">
                    <td className={th}>{l.label}</td>
                    <td className={cn(th, "text-xs")}>{w.code}</td>
                    <td className={cn(th, "text-xs")}>{ALLOCATION_BASIS_LABEL[l.basis]}</td>
                    <td className={cn(th, "numeric text-right")}>{formatVND(l.amountVnd)}</td>
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </div>
        {d.costEntries.length ? (
          <ul className="mt-3 space-y-1 text-xs">
            {d.costEntries.map((e) => (
              <li key={e.id} className={cn("flex flex-wrap items-center gap-2", e.voidedAt && "text-muted-foreground line-through")}>
                {e.description} · {formatVND(Number(e.amountVnd))} · {e.scope}
                {e.voidedAt ? null : <VoidCostButton id={e.id} accountCode={a.code} />}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-3">
          <CostEntryForm periodMonth={d.periodMonth} accountCode={a.code} workspaces={c.workspaces.map((w) => ({ code: w.code, name: w.name }))} products={allProducts} />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Tỷ giá USD → VND: {formatNumber(d.usdToVnd)} (FACEBOOK_USD_VND).</p>
      </SectionCard>

      {/* Triển khai */}
      <SectionCard title="Triển khai" description="Mọi workspace chạy CÙNG một mã nguồn, cùng một bản — khách mới không cần nhân bản mã.">
        <p className="text-sm">
          Bản đang chạy: <code>{version.commit ? version.commit.slice(0, 12) : "—"}</code> {version.branch ? `(${version.branch})` : ""} · mỗi workspace một CSDL, migration tự áp khi mở.
        </p>
      </SectionCard>

      {/* Job cấp phát */}
      <SectionCard title="Job cấp phát" padded={false}>
        {d.jobs.length === 0 ? (
          <p className="px-5 py-3 text-xs text-muted-foreground">Chưa có job nào (tài khoản từ backfill 0224 hoặc tự đăng ký).</p>
        ) : (
          <ul className="divide-y divide-hairline text-sm">
            {d.jobs.map((j) => (
              <li key={j.id} className="space-y-1 px-5 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <b>{JOB_KIND_LABEL[j.kind as ProvisioningKind]}</b>
                  <StatusPill tone={j.status === "SUCCEEDED" ? "good" : j.status === "FAILED" ? "bad" : "info"}>{JOB_STATUS_LABEL[j.status as JobStatus]}</StatusPill>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(j.createdAt)} · lần {j.attempts} · {j.requestedByEmail ?? "máy"}
                  </span>
                  {j.status === "FAILED" ? <RetryJobButton accountCode={a.code} jobId={j.id} /> : null}
                </div>
                {j.lastError ? <p className="text-xs text-destructive">{j.lastError}</p> : null}
                <p className="text-[11px] text-muted-foreground">{(j.steps as JobStep[]).map((s) => `${s.key}:${s.status}${s.detail ? ` (${s.detail})` : ""}`).join(" → ")}</p>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {/* Nhật ký */}
      <SectionCard title="Nhật ký" padded={false}>
        {d.audit.length === 0 ? (
          <p className="px-5 py-3 text-xs text-muted-foreground">Chưa có dòng nào.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className={thead}>
                <tr>
                  <th className={th}>Lúc</th>
                  <th className={th}>Ai</th>
                  <th className={th}>Việc</th>
                  <th className={th}>Lý do</th>
                </tr>
              </thead>
              <tbody>
                {d.audit.map((r) => (
                  <tr key={r.id} className="border-t border-hairline">
                    <td className={cn(th, "text-xs")}>{formatDateTime(r.at)}</td>
                    <td className={cn(th, "text-xs")}>{r.actorEmail ?? "máy"}</td>
                    <td className={cn(th, "text-xs")}>
                      {r.action} · {r.subject} · {r.targetOrgCode}
                    </td>
                    <td className={cn(th, "text-xs text-muted-foreground")}>{r.reason ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

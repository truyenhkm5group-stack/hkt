import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { AiCell, ChannelCell, HealthColumnsHint, HealthFilterBar, HealthPill, HealthReasonList, LoginCell, OrderCell, Two, UsageCell } from "@/components/saas/customer-health";
import { CostEntryForm, CreateCustomerForm } from "@/components/saas/operator-actions";
import { SaasConsoleNav, StatusPill } from "@/components/saas/console-bits";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { CUSTOMER_HEALTH_LEVELS, CUSTOMER_HEALTH_RANK, isCustomerHealthLevel, type CustomerHealthLevel } from "@/lib/constants/customer-health";
import { formatNumber, formatPercent, formatVND, NOT_APPLICABLE_TEXT, vnShortStamp } from "@/lib/format";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { PRODUCT_LABEL, PRODUCTS } from "@/lib/saas/catalog";
import { loadCustomersConsole } from "@/lib/saas/console";
import type { CustomerHealth, WorkspaceHealth } from "@/lib/saas/customer-health";
import type { CustomerView, WorkspaceView } from "@/lib/saas/customers";
import { ACCOUNT_TYPE_LABEL, ACCOUNT_TYPE_TONE, SUBSCRIPTION_STATUS_LABEL, type AccountType } from "@/lib/saas/policy";
import { cn } from "@/lib/utils";

export const metadata = { title: "Khách hàng SaaS" };

const td = "px-2.5 py-2 align-top";
const thead = "bg-muted/40 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";
const ORG_STATUS_LABEL: Record<string, string> = { ACTIVE: "đang chạy", SUSPENDED: "đình chỉ", ARCHIVED: "lưu trữ", SETUP_FAILED: "dựng hỏng" };

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-hairline bg-card px-3 py-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="numeric mt-0.5 text-xl font-bold">{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

const rankOf = (h: CustomerHealth | undefined) => CUSTOMER_HEALTH_RANK[h?.level ?? "UNKNOWN"];

/** Một dòng = một workspace (tài khoản chưa có workspace = một dòng). Cột tài khoản (tên · tiền) chỉ in ở dòng đầu. */
type Row = { c: CustomerView; h: CustomerHealth | undefined; w: WorkspaceView | null; wh: WorkspaceHealth | null; first: boolean };

/**
 * KHÁCH HÀNG SAAS — danh sách tài khoản (khách nội bộ và khách ngoài, CÙNG một bảng, cùng cột). Chỉ người vận hành nền tảng.
 *
 * Câu hỏi của màn: «khách nào đang chạy được, khách nào cần người xem» trong < 30 giây. Mỗi khách một MỨC (Nguy cấp · Cần chú ý ·
 * Chưa đủ dữ liệu · Khoẻ · Đã dừng) kèm LÝ DO cụ thể — hàm phân loại thuần `lib/saas/customer-health.ts`, tín hiệu đọc gom một
 * lượt ở CSDL nhà (`lib/saas/customer-signals.ts`). Thiếu dữ liệu không bao giờ in thành «Khoẻ» (luật 42). Lọc nhanh bằng `?muc=`.
 * Tiền: số của kỳ tháng hiện tại (giờ VN) như trước — MRR = phần khách trả theo bảng kê nháp; chargeback nội bộ không phải doanh thu.
 */
export default async function SaasCustomersPage({ searchParams }: { searchParams: Promise<{ ky?: string; muc?: string }> }) {
  const user = await requirePermission("platform:operate");
  if (platformOperatorDenial(user)) redirect("/?forbidden=1");
  const { ky, muc } = await searchParams;
  const data = await loadCustomersConsole(user, ky);
  if ("error" in data) redirect("/?forbidden=1");
  const { customers, health, healthAt: now } = data;
  const filter: CustomerHealthLevel | null = isCustomerHealthLevel(muc) ? muc : null;

  const external = customers.filter((c) => c.economics.marginApplicable);
  const internal = customers.filter((c) => !c.economics.marginApplicable);
  const statuses = customers.flatMap((c) => c.workspaces.flatMap((w) => w.subscriptions.map((s) => s.status)));
  const mrrKnown = external.filter((c) => c.economics.revenueVnd !== null);
  const mrr = mrrKnown.reduce((a, c) => a + (c.economics.revenueVnd ?? 0), 0);
  const cost = customers.reduce((a, c) => a + c.economics.costVnd, 0);
  const gp = mrrKnown.reduce((a, c) => a + (c.economics.grossProfitVnd ?? 0), 0);
  const balanceRev = mrrKnown.reduce((a, c) => a + c.economics.aiBalanceRevenueVnd, 0);
  const label = `${data.periodMonth.slice(5, 7)}/${data.periodMonth.slice(0, 4)}`;

  const counts = Object.fromEntries(CUSTOMER_HEALTH_LEVELS.map((l) => [l, customers.filter((c) => (health[c.account.id]?.level ?? "UNKNOWN") === l).length])) as Record<CustomerHealthLevel, number>;
  const hrefOf = Object.fromEntries(
    (["ALL", ...CUSTOMER_HEALTH_LEVELS] as const).map((k) => {
      const q = new URLSearchParams();
      if (ky) q.set("ky", ky);
      if (k !== "ALL") q.set("muc", k);
      const s = q.toString();
      return [k, `/platform/customers${s ? `?${s}` : ""}`];
    }),
  ) as Record<CustomerHealthLevel | "ALL", string>;

  const shown = customers
    .filter((c) => !filter || (health[c.account.id]?.level ?? "UNKNOWN") === filter)
    .sort((a, b) => rankOf(health[a.account.id]) - rankOf(health[b.account.id]) || a.account.name.localeCompare(b.account.name, "vi"));
  const rows: Row[] = shown.flatMap<Row>((c) => {
    const h = health[c.account.id];
    if (!c.workspaces.length) return [{ c, h, w: null, wh: null, first: true }];
    // Thứ tự workspace theo mức của nó (nặng trước) — cùng thứ tự với hàm phân loại.
    const order = h ? h.workspaces.map((x) => x.code) : c.workspaces.map((w) => w.code);
    const ws = [...c.workspaces].sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));
    return ws.map((w, i) => ({ c, h, w, wh: h?.workspaces.find((x) => x.code === w.code) ?? null, first: i === 0 }));
  });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống"
        title="Khách hàng SaaS"
        actions={<SaasConsoleNav active="/platform/customers" />}
        description={`${customers.length} tài khoản · ${internal.length} nội bộ · kỳ ${label} · sức khoẻ đọc lúc ${vnShortStamp(now)}`}
      />

      <HealthFilterBar counts={counts} total={customers.length} active={filter} hrefOf={hrefOf} />

      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Tile label="Tài khoản" value={formatNumber(customers.length)} sub={`${external.length} ngoài · ${internal.length} nội bộ`} />
        <Tile label="Thuê bao sống" value={formatNumber(statuses.length)} sub={`${statuses.filter((s) => s === "TRIAL").length} dùng thử · ${statuses.filter((s) => s === "PAST_DUE" || s === "EXPIRED").length} quá hạn`} />
        <Tile label="Doanh thu kỳ (khách ngoài)" value={formatVND(mrr)} sub={mrrKnown.length < external.length ? `${external.length - mrrKnown.length} khách có gói không niêm yết giá` : balanceRev ? `gồm Số dư AI ${formatVND(balanceRev)}` : "gói · mua thêm · vượt"} />
        <Tile label="Chi phí kỳ" value={formatVND(cost)} sub="AI nền tảng trả + phân bổ" />
        <Tile label="Lãi gộp (khách ngoài)" value={formatVND(gp)} sub={mrr ? formatPercent((gp / mrr) * 100) : "—"} />
      </div>

      <SectionCard title="Tài khoản khách" description={filter ? `Đang lọc: ${shown.length}/${customers.length} tài khoản` : "Nặng trước — bấm tên để xem chi tiết"} hint={<HealthColumnsHint />} padded={false}>
        {customers.length === 0 ? (
          <EmptyState title="Chưa có tài khoản nào" className="m-4" />
        ) : shown.length === 0 ? (
          <EmptyState title="Không có khách nào ở mức này" description="Bấm «Tất cả» để xem toàn bộ." className="m-4" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1060px] max-w-[1150px] table-fixed text-[12.5px]">
              <colgroup>
                <col className="w-[170px]" />
                <col className="w-[220px]" />
                <col className="w-[130px]" />
                <col className="w-[110px]" />
                <col className="w-[95px]" />
                <col className="w-[115px]" />
                <col className="w-[95px]" />
                <col className="w-[105px]" />
                <col className="w-[105px]" />
              </colgroup>
              <thead className={thead}>
                <tr>
                  <th className={td}>Khách · workspace</th>
                  <th className={td}>Sức khoẻ · lý do</th>
                  <th className={td}>Sản phẩm · gói</th>
                  <th className={td}>Đăng nhập · hoạt động</th>
                  <th className={td}>Kênh</th>
                  <th className={td}>AI · 24 giờ</th>
                  <th className={td}>Đơn</th>
                  <th className={td}>Dùng / hạn mức</th>
                  <th className={cn(td, "text-right")}>Doanh thu · biên</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ c, h, w, wh, first }) => {
                  const multi = c.workspaces.length > 1;
                  // Một workspace: mức của TÀI KHOẢN (gồm lý do cấp tài khoản). Nhiều workspace: mức của từng workspace; mức tài khoản in ở cột đầu.
                  const level: CustomerHealthLevel = !multi ? (h?.level ?? "UNKNOWN") : (wh?.level ?? "UNKNOWN");
                  const reasons = [...(first ? (h?.accountReasons ?? []) : []), ...(wh?.reasons ?? [])];
                  const gaps = wh?.gaps ?? [];
                  const subs = w?.subscriptions ?? [];
                  return (
                    <tr key={`${c.account.id}:${w?.code ?? "-"}`} className={cn("border-hairline", first ? "border-t" : "border-t border-dashed")}>
                      <td className={td}>
                        {first ? (
                          <>
                            <Link href={`/platform/customers/${c.account.code}`} className="block truncate font-semibold text-primary hover:underline" title={c.account.name}>
                              {c.account.name}
                            </Link>
                            <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                              <StatusPill tone={ACCOUNT_TYPE_TONE[c.account.accountType as AccountType]}>{ACCOUNT_TYPE_LABEL[c.account.accountType as AccountType]}</StatusPill>
                              {multi && h ? <HealthPill level={h.level} /> : null}
                            </div>
                          </>
                        ) : (
                          <span className="text-muted-foreground">↳</span>
                        )}
                        <div className="truncate font-mono text-[11px] text-muted-foreground" title={w ? `${w.name} · tạo ${vnShortStamp(w.createdAt)}` : undefined}>
                          {w ? `${w.code}${w.isHome ? " · nhà" : ""}${w.status !== "ACTIVE" ? ` · ${ORG_STATUS_LABEL[w.status] ?? w.status}` : ""}` : "chưa có workspace"}
                        </div>
                      </td>
                      <td className={td}>
                        <HealthPill level={level} />
                        <HealthReasonList reasons={reasons} gaps={gaps} />
                      </td>
                      <td className={td}>
                        {subs.length ? (
                          <Two
                            top={subs.map((s) => `${PRODUCT_LABEL[s.productKey] ?? s.productKey} · ${s.planName}`).join(" + ")}
                            title={subs.map((s) => `${PRODUCT_LABEL[s.productKey] ?? s.productKey} · ${s.planName} · ${SUBSCRIPTION_STATUS_LABEL[s.status]}`).join("\n")}
                            sub={
                              <span className="flex flex-wrap gap-1">
                                {[...new Set(subs.map((s) => s.status))].map((st) => (
                                  <StatusPill key={st} tone={st === "ACTIVE" ? "good" : st === "TRIAL" ? "info" : st === "PAUSED" ? "muted" : "bad"}>
                                    {SUBSCRIPTION_STATUS_LABEL[st]}
                                  </StatusPill>
                                ))}
                              </span>
                            }
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">{w ? "chưa thuê sản phẩm nào" : "—"}</span>
                        )}
                      </td>
                      <td className={td}>{wh ? <LoginCell f={wh.facts} now={now} /> : "—"}</td>
                      <td className={td}>{wh ? <ChannelCell f={wh.facts} /> : "—"}</td>
                      <td className={td}>{wh ? <AiCell f={wh.facts} now={now} /> : "—"}</td>
                      <td className={td}>{wh ? <OrderCell f={wh.facts} /> : "—"}</td>
                      <td className={td}>{wh && w ? <UsageCell f={wh.facts} conversations={periodConversations(w)} /> : "—"}</td>
                      <td className={cn(td, "text-right")}>{first ? <MoneyCell c={c} /> : null}</td>
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

/** Hội thoại mới của KỲ (sổ dùng — cùng số cột «Dùng» cũ). Chưa đo ⇒ `null`, không phải 0. */
function periodConversations(w: WorkspaceView): number | null {
  const vals = w.usage.filter((u) => u.metric === "conversations_started").map((u) => u.value);
  return vals.length && vals.every((v) => v !== null) ? vals.reduce<number>((a, v) => a + (v ?? 0), 0) : null;
}

/** Tiền của tài khoản trong kỳ: doanh thu (khách ngoài) hoặc chargeback (nội bộ) · biên gộp. «—» chưa biết, N/A không áp dụng. */
function MoneyCell({ c }: { c: CustomerView }) {
  const e = c.economics;
  const losing = e.grossProfitVnd !== null && e.grossProfitVnd < 0;
  const unknownCost = c.flags.includes("UNKNOWN_COST");
  return (
    <Two
      className="numeric"
      top={e.marginApplicable ? formatVND(e.revenueVnd) : <span title="Chargeback nội bộ: chi phí biến đổi khách nội bộ tiêu — không phải doanh thu thị trường">{formatVND(c.statement.totalKnownVnd)}</span>}
      sub={
        <span className={cn(losing && "font-semibold text-rose-700 dark:text-rose-400")}>
          {e.marginApplicable ? `biên ${formatPercent(e.marginPct)}` : `nội bộ · biên ${NOT_APPLICABLE_TEXT}`}
          {unknownCost ? " · ⚠ chi phí chưa biết" : ""}
        </span>
      }
      title={`Chi phí kỳ ${formatVND(e.costVnd)} (AI nền tảng trả + phân bổ)${unknownCost ? " — có lượt AI chưa định giá / khoản phân bổ chưa biết số: chi phí là cận dưới" : ""}`}
    />
  );
}

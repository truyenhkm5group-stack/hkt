import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { AiCell, ChannelCell, HealthColumnsHint, HealthFilterBar, HealthPill, HealthReasonList, LoginCell, OrderCell, Two, UsageCell } from "@/components/saas/customer-health";
import { CostEntryForm, CreateCustomerForm } from "@/components/saas/operator-actions";
import { SaasConsoleNav, StatusPill } from "@/components/saas/console-bits";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { templateBlueprint } from "@/lib/blueprints/templates";
import { CUSTOMER_HEALTH_LEVELS, CUSTOMER_HEALTH_RANK, isCustomerHealthLevel, type CustomerHealthLevel } from "@/lib/constants/customer-health";
import { formatNumber, formatPercent, formatVND, NOT_APPLICABLE_TEXT, vnShortStamp } from "@/lib/format";
import { ORG_BRAND_LABEL, ORG_BRANDS } from "@/lib/platform/org-brand";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { loadPriceBook } from "@/lib/pricing/price-book";
import { PRODUCT_LABEL, PRODUCTS } from "@/lib/saas/catalog";
import { loadCustomersConsole } from "@/lib/saas/console";
import { createCustomerPlanOptions, SALES_AGENT_TEMPLATE, templateSummary } from "@/lib/saas/create-customer-rules";
import { rowLevel, type CustomerHealth, type WorkspaceHealth } from "@/lib/saas/customer-health";
import type { CustomerView, WorkspaceView } from "@/lib/saas/customers";
import { ACCOUNT_TYPE_LABEL, ACCOUNT_TYPE_TONE, losingMoneyApplies, SUBSCRIPTION_STATUS_LABEL, type AccountType } from "@/lib/saas/policy";
import { cn } from "@/lib/utils";

export const metadata = { title: "Khách hàng SaaS" };

const td = "px-2 py-2 align-top";
const thead = "bg-muted/40 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";
const ORG_STATUS_LABEL: Record<string, string> = { ACTIVE: "đang chạy", SUSPENDED: "đình chỉ", ARCHIVED: "lưu trữ", SETUP_FAILED: "dựng hỏng" };
/** Tên sản phẩm gọn cho ô bảng (tên đầy đủ ở `title`). */
const PRODUCT_SHORT: Record<string, string> = { chotdon: "Chốt Đơn", erp: "ERP" };

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
 * Hai mốc, không trộn: TIỀN (ô tổng, cột «Doanh thu · biên») theo kỳ đang xem `?ky=` (mặc định tháng hiện tại, giờ VN) — MRR =
 * phần khách trả theo bảng kê nháp, chargeback nội bộ không phải doanh thu; SỨC KHOẺ (mức, lý do, năm cột tín hiệu) luôn của HIỆN
 * TẠI — mốc đọc + khách AI của kỳ hiện tại — dù đang xem tiền kỳ khác. Tài khoản chưa có workspace: năm cột tín hiệu là N/A.
 */
export default async function SaasCustomersPage({ searchParams }: { searchParams: Promise<{ ky?: string; muc?: string }> }) {
  const user = await requirePermission("platform:operate");
  if (platformOperatorDenial(user)) redirect("/?forbidden=1");
  const { ky, muc } = await searchParams;
  const data = await loadCustomersConsole(user, ky);
  if ("error" in data) redirect("/?forbidden=1");
  const { customers, health, healthAt: now } = data;
  const periodLabel = (pm: string) => `${pm.slice(5, 7)}/${pm.slice(0, 4)}`;
  const filter: CustomerHealthLevel | null = isCustomerHealthLevel(muc) ? muc : null;

  const external = customers.filter((c) => c.economics.marginApplicable);
  const internal = customers.filter((c) => !c.economics.marginApplicable);
  const statuses = customers.flatMap((c) => c.workspaces.flatMap((w) => w.subscriptions.map((s) => s.status)));
  const mrrKnown = external.filter((c) => c.economics.revenueVnd !== null);
  const mrr = mrrKnown.reduce((a, c) => a + (c.economics.revenueVnd ?? 0), 0);
  const cost = customers.reduce((a, c) => a + c.economics.costVnd, 0);
  const gp = mrrKnown.reduce((a, c) => a + (c.economics.grossProfitVnd ?? 0), 0);
  const balanceRev = mrrKnown.reduce((a, c) => a + c.economics.aiBalanceRevenueVnd, 0);
  const label = periodLabel(data.periodMonth);
  // Đang xem tiền của kỳ khác kỳ hiện tại ⇒ nói rõ sức khoẻ vẫn là của hiện tại.
  const healthNote = data.healthPeriodMonth === data.periodMonth ? `sức khoẻ đọc lúc ${vnShortStamp(now)}` : `sức khoẻ của HIỆN TẠI (đọc lúc ${vnShortStamp(now)}, khách AI kỳ ${periodLabel(data.healthPeriodMonth)}) — không theo kỳ ${label}`;

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
  // «Tạo khách mới»: gói theo bảng giá ĐANG NIÊM YẾT (sổ giá đã đệm từ ảnh chụp ở trên), mẫu Chốt Đơn kể từ CHÍNH gói mẫu.
  const createPlans = createCustomerPlanOptions(data.plans, await loadPriceBook(), new Date());
  const salesBlueprint = SALES_AGENT_TEMPLATE ? templateBlueprint(SALES_AGENT_TEMPLATE.templateKey) : null;
  const salesTemplate = SALES_AGENT_TEMPLATE && salesBlueprint ? { label: SALES_AGENT_TEMPLATE.label, summary: templateSummary(salesBlueprint) } : null;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống"
        title="Khách hàng SaaS"
        actions={<SaasConsoleNav active="/platform/customers" />}
        description={`${customers.length} tài khoản · ${internal.length} nội bộ · tiền kỳ ${label} · ${healthNote}`}
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
            <table className="w-full min-w-[1080px] max-w-[1150px] table-fixed text-[12px]">
              {/* 9 cột hai tầng, tổng 1.150 px — vừa một màn hình (trần ~1.150 px, tests/customer-health.test.ts khoá). */}
              <colgroup>
                <col className="w-[140px]" />
                <col className="w-[225px]" />
                <col className="w-[140px]" />
                <col className="w-[105px]" />
                <col className="w-[115px]" />
                <col className="w-[125px]" />
                <col className="w-[95px]" />
                <col className="w-[110px]" />
                <col className="w-[95px]" />
              </colgroup>
              <thead className={thead}>
                <tr>
                  <th className={td}>Khách · workspace</th>
                  <th className={td}>Sức khoẻ · lý do</th>
                  <th className={td}>Sản phẩm · gói</th>
                  <th className={td}>Đăng nhập · hoạt động</th>
                  <th className={td}>Kênh · khách AI</th>
                  <th className={td}>AI · 24 giờ</th>
                  <th className={td}>Đơn AI</th>
                  <th className={td}>Khách AI / gói</th>
                  <th className={cn(td, "text-right")}>Doanh thu · biên</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ c, h, w, wh, first }) => {
                  const multi = c.workspaces.length > 1;
                  // Một workspace: mức của TÀI KHOẢN (gồm lý do cấp tài khoản). Nhiều workspace: mức của từng workspace NÂNG theo lý do
                  // cấp tài khoản in trên cùng dòng (dòng đầu) — nhãn dòng không bao giờ nhẹ hơn lý do nó in; mức tài khoản in ở cột đầu.
                  const accountReasons = first ? (h?.accountReasons ?? []) : [];
                  const level: CustomerHealthLevel = !multi ? (h?.level ?? "UNKNOWN") : rowLevel(wh?.level ?? "UNKNOWN", accountReasons);
                  const reasons = [...accountReasons, ...(wh?.reasons ?? [])];
                  const gaps = wh?.gaps ?? [];
                  const subs = w?.subscriptions ?? [];
                  // Không workspace ⇒ tín hiệu workspace KHÔNG ÁP DỤNG (N/A); có workspace mà chưa có kết quả ⇒ chưa biết (—).
                  const signal = (cell: (wh: WorkspaceHealth) => React.ReactNode) => (w === null ? <span className="text-muted-foreground">{NOT_APPLICABLE_TEXT}</span> : wh ? cell(wh) : "—");
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
                        {wh?.level === "INACTIVE" && wh.inactiveReason && !reasons.length ? (
                          <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground" title={wh.inactiveReason}>
                            {wh.inactiveReason}
                          </p>
                        ) : null}
                      </td>
                      <td className={td}>
                        {subs.length ? (
                          <Two
                            top={`${subs.map((s) => PRODUCT_SHORT[s.productKey] ?? PRODUCT_LABEL[s.productKey] ?? s.productKey).join(" + ")} · ${[...new Set(subs.map((s) => s.planName))].join(" · ")}`}
                            title={subs.map((s) => `${PRODUCT_LABEL[s.productKey] ?? s.productKey} · gói ${s.planName} · ${SUBSCRIPTION_STATUS_LABEL[s.status]}`).join("\n")}
                            sub={
                              <span className="flex items-center gap-1">
                                {[...new Set(subs.map((s) => s.status))].map((st) => (
                                  <span key={st} className="shrink-0 whitespace-nowrap">
                                    <StatusPill tone={st === "ACTIVE" ? "good" : st === "TRIAL" ? "info" : st === "PAUSED" ? "muted" : "bad"}>{SUBSCRIPTION_STATUS_LABEL[st]}</StatusPill>
                                  </span>
                                ))}
                              </span>
                            }
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">{w ? "chưa thuê sản phẩm nào" : "—"}</span>
                        )}
                      </td>
                      <td className={td}>{signal((x) => <LoginCell f={x.facts} now={now} />)}</td>
                      <td className={td}>{signal((x) => <ChannelCell f={x.facts} />)}</td>
                      <td className={td}>{signal((x) => <AiCell f={x.facts} now={now} />)}</td>
                      <td className={td}>{signal((x) => <OrderCell f={x.facts} />)}</td>
                      <td className={td}>{signal((x) => <UsageCell f={x.facts} />)}</td>
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
        <CreateCustomerForm
          plans={createPlans}
          products={PRODUCTS.map((p) => ({ key: p.key, name: p.name }))}
          accounts={customers.map((c) => ({ id: c.account.id, code: c.account.code, name: c.account.name, accountType: c.account.accountType }))}
          brands={ORG_BRANDS.map((k) => ({ key: k, label: ORG_BRAND_LABEL[k] }))}
          salesTemplate={salesTemplate}
        />
      </SectionCard>

      <SectionCard title="Chi phí cấp nền tảng / sản phẩm" description="Khoản chi ngoài AI chia theo căn cứ khai (hạ tầng / hỗ trợ nền theo tháng khai ở Kinh tế nền tảng).">
        <CostEntryForm periodMonth={data.periodMonth} workspaces={[]} products={PRODUCTS.map((p) => ({ key: p.key, name: p.name }))} />
      </SectionCard>
    </div>
  );
}

/** Tiền của tài khoản trong kỳ: doanh thu (khách ngoài) hoặc chargeback (nội bộ) · biên gộp. «—» chưa biết, N/A không áp dụng. */
function MoneyCell({ c }: { c: CustomerView }) {
  const e = c.economics;
  // Cùng vị từ với cờ «Đang lỗ gộp» (chỉ khách TRẢ TIỀN) — dùng thử lỗ gộp là đúng thiết kế, không tô đỏ.
  const losing = losingMoneyApplies(e.revenueVnd, e.grossProfitVnd);
  const unknownCost = c.flags.includes("UNKNOWN_COST");
  return (
    <Two
      className="numeric"
      top={e.marginApplicable ? formatVND(e.revenueVnd) : <span title="Chargeback nội bộ: chi phí biến đổi khách nội bộ tiêu — không phải doanh thu thị trường">{formatVND(c.statement.totalKnownVnd)}</span>}
      sub={
        <span className={cn(losing && "font-semibold text-rose-700 dark:text-rose-400")}>
          {e.marginApplicable ? `biên ${formatPercent(e.marginPct)}` : "nội bộ"}
          {unknownCost ? " ⚠" : ""}
        </span>
      }
      title={[`${e.marginApplicable ? "Doanh thu kỳ" : "Chargeback nội bộ (không phải doanh thu)"}: ${formatVND(e.marginApplicable ? e.revenueVnd : c.statement.totalKnownVnd)}`, `Chi phí kỳ ${formatVND(e.costVnd)} (AI nền tảng trả + phân bổ)`, `Biên gộp: ${e.marginApplicable ? formatPercent(e.marginPct) : NOT_APPLICABLE_TEXT}`, unknownCost ? "⚠ Có lượt AI chưa định giá / khoản phân bổ chưa biết số — chi phí là cận dưới" : null].filter(Boolean).join("\n")}
    />
  );
}

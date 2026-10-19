import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { PayrollTabs } from "@/app/(dashboard)/payroll/tabs";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { TableToolsFor } from "@/components/data-table/table-tools";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { can, requireUser } from "@/lib/auth/session";
import { canAdministerPayroll } from "@/lib/auth/payroll-scope";
import { payrollPeriodKey } from "@/lib/constants/payroll";
import { formatDate, formatVND } from "@/lib/format";
import { PROFIT_GATE_STATUS_LABEL } from "@/lib/payroll/profit-gate";
import { describeFingerprint } from "@/lib/payroll/code-ledger";
import { getPayrollReport } from "@/lib/queries/payroll";
import { periodFinalized } from "@/lib/queries/payroll-engine";
import { paramList, resolvePeriod, type SearchParams } from "@/lib/search-params";
import { ConfirmWeightsButton, RevokeConfirmationButton } from "@/app/(dashboard)/payroll/codes/confirm-weights-button";

export const metadata = { title: "Lợi nhuận theo mã" };

const v = (n: number | null | undefined) => formatVND(n ?? null);

/**
 * ═══ SỔ LỢI NHUẬN THEO MÃ · ĐÓNG GÓP MKTer · ĐỐI SOÁT (Payroll V2) ═══
 *
 * Đặc tả `docs/payroll-code-ledger.md`. Mọi con số lấy thẳng từ `getPayrollReport().profitGate`
 * (sổ mã, phân bổ, khoản thưởng, khoản chờ đối soát) và `marketers` (lợi nhuận mã tính MỘT lần) —
 * màn hình không cộng trừ lại thứ gì ngoài phép cộng để đối soát, và phép ấy in cả chênh lệch.
 */
export default async function PayrollCodesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  const user = await requireUser();
  if (!canAdministerPayroll(user, can(user, "payroll:manage"))) redirect("/payroll?forbidden=1");
  const period = resolvePeriod(raw, "month");
  const key = payrollPeriodKey(period.from, period.to);
  const report = await getPayrollReport(period, "profit1");
  const locked = key ? await periodFinalized(key) : false;
  const gate = report.profitGate;
  const led = gate.codeLedger;
  const names = new Map(report.lines.map((l) => [l.employee.id, l.employee.shortName || l.employee.name] as const));
  const ten = (id: string | null) => (id ? (names.get(id) ?? id) : "—");
  const alloc = new Map(gate.result.allocations.map((a) => [a.key, a] as const));
  // Dấu vân tay lấy từ TOÀN BỘ khoản chờ (không phải danh sách đã lọc) — server đòi bằng đúng tập này.
  const vanTayCua = (pid: string) => [...new Set(led.pending.filter((q) => q.kind === "WEIGHT_PARTIAL" && q.productId === pid && q.fingerprint).map((q) => q.fingerprint as string))].sort();

  const product = new Map(report.marketers.products.map((p) => [p.productId, p] as const));
  const ledgerRow = new Map((led.rows ?? []).map((r) => [r.productId, r] as const));

  // ─── Bộ lọc ───
  const fMk = paramList(raw, "mkter");
  const fCode = paramList(raw, "code");
  const fRole = paramList(raw, "role");
  const fPolicy = paramList(raw, "policy");
  const claims = led.claims.filter(
    (c) => (!fMk.length || fMk.includes(c.employeeId)) && (!fCode.length || fCode.includes(c.productId)) && (!fRole.length || fRole.includes(c.role)) && (!fPolicy.length || fPolicy.includes(c.policyRef)),
  );
  const pending = led.pending.filter((p) => (!fMk.length || (p.employeeId !== null && fMk.includes(p.employeeId))) && (!fCode.length || fCode.includes(p.productId)));
  const facets = [
    { key: "mkter", label: "MKTer", options: [...new Set(led.claims.map((c) => c.employeeId))].map((id) => ({ value: id, label: ten(id) })) },
    { key: "code", label: "Mã", options: [...new Set(led.claims.map((c) => c.productId))].map((id) => ({ value: id, label: product.get(id)?.code || id })) },
    { key: "role", label: "Vai trò", options: [{ value: "OWNER", label: "OWNER" }, { value: "SUPPORT", label: "SUPPORT" }] },
    { key: "policy", label: "Chính sách", options: [...new Set(led.claims.map((c) => c.policyRef))].map((p) => ({ value: p, label: p || "(không ghi)" })) },
  ];

  // ─── Đóng góp theo MKTer ───
  const byMk = new Map<string, { codes: Set<string>; owner: number; support: number; adSpend: number; revenue: number; provisional: number; approved: number | null; pending: number }>();
  for (const c of led.claims) {
    const o = byMk.get(c.employeeId) ?? { codes: new Set<string>(), owner: 0, support: 0, adSpend: 0, revenue: 0, provisional: 0, approved: 0, pending: 0 };
    // Căn cứ trọng số đo TRONG ĐOẠN của khoản — các đoạn rời nhau nên cộng lại không đếm trùng.
    o.adSpend += c.basisAdSpend;
    o.revenue += c.basisRevenue;
    o.codes.add(c.productId);
    if (c.role === "OWNER") o.owner += 1;
    else o.support += 1;
    o.provisional += c.provisional;
    const a = alloc.get(c.key);
    o.approved = o.approved === null || !gate.result.established || a?.eligible === null || a?.eligible === undefined ? null : o.approved + a.eligible;
    byMk.set(c.employeeId, o);
  }
  for (const p of led.pending) {
    if (!p.employeeId) continue;
    const o = byMk.get(p.employeeId) ?? { codes: new Set<string>(), owner: 0, support: 0, adSpend: 0, revenue: 0, provisional: 0, approved: 0, pending: 0 };
    o.pending += 1;
    o.approved = null;
    byMk.set(p.employeeId, o);
  }

  // ─── Đối soát: Σ lợi nhuận mã ↔ lợi nhuận công ty ───
  const t = report.marketers.totals;
  const sumCodes = report.marketers.products.reduce((s, p) => s + p.profit, 0);
  const reconciled = sumCodes - t.testSpend - t.sharedUnallocated - t.logisticsAdjustmentUnallocated;
  const gap = t.profit - reconciled;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Lợi nhuận theo mã"
        description="Sổ lũy kế và mốc cao nhất (HWM) RIÊNG từng mã, phân bổ lợi nhuận đủ điều kiện của công ty xuống mã, rồi chia OWNER X% / SUPPORT Y% × trọng số. Lãi của một mã không bao giờ vượt qua lỗ của công ty."
      />
      <PayrollTabs canManage />
      <DataTableToolbar facets={facets} period={{ defaultKey: "month" }} />

      {locked ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          Tháng này đã khoá lương. Số dưới đây là TÍNH LẠI để đối chiếu — tiền đã duyệt là ảnh chụp lúc khoá (tab Lịch sử kỳ), không đổi theo trang này.
        </p>
      ) : null}

      <SectionCard
        title="Tổng quan"
        description={
          <>
            Cổng công ty: <b>{PROFIT_GATE_STATUS_LABEL[gate.result.status]}</b> · {gate.result.message}
          </>
        }
      >
        {!led.applicable ? (
          <EmptyState title="Sổ mã chỉ xét theo trọn một tháng lịch, cơ sở “Lợi nhuận tính lương”" description="Chọn một tháng ở thanh trên. Lũy kế của mã là một chuỗi theo tháng — cộng theo kỳ khác là làm mất phần lỗ phải bù." />
        ) : (
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">LN đủ điều kiện của công ty</dt>
              <dd className="font-semibold tabular-nums">{v(gate.result.eligibleProfit)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Σ LN đủ điều kiện của các mã</dt>
              <dd className="font-semibold tabular-nums">{led.rows ? v(led.rows.reduce((s, r) => s + r.eligible, 0)) : "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Đã phân bổ xuống mã</dt>
              <dd className="font-semibold tabular-nums">{led.allocated ? v(Object.values(led.allocated).reduce((s, x) => s + x, 0)) : "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Phân công / điều khoản hiệu lực</dt>
              <dd className="font-semibold tabular-nums">
                {led.assignmentCount} / {led.termsCount}
                {pending.length ? <span className="ml-2 text-amber-700">· {pending.length} chờ đối soát</span> : null}
              </dd>
            </div>
          </dl>
        )}
        {led.problem ? <p className="mt-2 text-sm text-amber-800">{led.problem}</p> : null}
        {led.confirmations.length ? (
          <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
            {led.confirmations.map((c) => (
              <li key={c.id}>
                Đã xác nhận trọng số mã {product.get(c.productId)?.code || c.productId} tháng {c.monthKey} ({c.fingerprints.length} đoạn) — {c.reason} · gửi: {c.requestedByEmail || "—"} · duyệt: {c.approvedByEmail || "—"} · {formatDate(c.confirmedAt)}
                {!locked ? <RevokeConfirmationButton id={c.id} /> : null}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="mt-3">
          <Link href="/payroll/codes/assignments" className="text-sm text-primary hover:underline">
            Quản lý phân công MKTer ↔ mã và điều khoản thưởng →
          </Link>
        </p>
      </SectionCard>

      {led.applicable ? (
        <SectionCard title="Thưởng theo mã" description="Mỗi dòng là MỘT khoản: một MKTer, một vai trò, một đoạn hiệu lực trên một mã. Bấm mã để xem nguồn giao dịch.">
          {claims.length === 0 ? (
            <EmptyState
              title="Chưa có khoản thưởng theo mã nào"
              description={led.assignmentCount === 0 ? "Chưa khai phân công OWNER / SUPPORT nào có hiệu lực trong kỳ — sổ mã bên dưới chỉ để xem." : "Không mã nào được phân công có lợi nhuận đủ điều kiện trong kỳ (còn lỗ lũy kế, hoặc chưa vượt mốc cao nhất)."}
            />
          ) : (
            <>
              <TableToolsFor tableId="payroll-code-claims" />
              <div className="overflow-x-auto">
                <table id="payroll-code-claims" className="w-full min-w-[1000px] text-[13px]">
                  <thead className="text-left text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Mã</th>
                      <th className="py-1 pr-3 font-medium">MKTer · Vai trò</th>
                      <th className="py-1 pr-3 font-medium">Thời gian</th>
                      <th className="py-1 pr-3 text-right font-medium">Chi phí Ads · Doanh thu (trong đoạn)</th>
                      <th className="py-1 pr-3 text-right font-medium">LN mã · LN lũy kế</th>
                      <th className="py-1 pr-3 text-right font-medium">LN đủ điều kiện · phân bổ</th>
                      <th className="py-1 pr-3 text-right font-medium">% thưởng</th>
                      <th className="py-1 text-right font-medium">Tạm tính · Được duyệt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {claims.map((c) => {
                      const r = ledgerRow.get(c.productId);
                      const a = alloc.get(c.key);
                      const phanBo = led.allocated ? (led.allocated[c.productId] ?? 0) : null;
                      const duyet = gate.result.established ? (a?.eligible ?? null) : null;
                      return (
                        <tr key={c.key} className="border-t align-top">
                          <td className="py-1.5 pr-3">
                            <Link href={`/products/${c.productId}`} className="font-medium hover:text-primary hover:underline">
                              {c.code || c.productId}
                            </Link>
                            <div className="text-xs text-muted-foreground">{product.get(c.productId)?.productName}</div>
                          </td>
                          <td className="py-1.5 pr-3">
                            <div className="font-medium">{ten(c.employeeId)}</div>
                            <div className="text-xs text-muted-foreground">
                              {c.role} · {c.policyRef || "—"}
                            </div>
                          </td>
                          <td className="py-1.5 pr-3 whitespace-nowrap">
                            {formatDate(c.segment.from)} → {formatDate(c.segment.to)}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">
                            {v(c.basisAdSpend)}
                            <div className="text-xs text-muted-foreground">{v(c.basisRevenue)}</div>
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">
                            {v(r?.profit)}
                            <div className="text-xs text-muted-foreground">{v(r?.cumulative)}</div>
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">
                            {v(r?.eligible)}
                            <div className="text-xs text-muted-foreground">{v(phanBo)}</div>
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{c.ratePercent.toLocaleString("vi-VN", { maximumFractionDigits: 2 })}%</td>
                          <td className="py-1.5 text-right tabular-nums">
                            <span className="text-muted-foreground">{v(c.provisional)}</span>
                            <div className="font-semibold">{v(duyet)}</div>
                            <details className="text-left text-xs text-muted-foreground">
                              <summary className="cursor-pointer text-right">công thức</summary>
                              <p className="mt-1 max-w-[260px]">
                                Lũy kế mã {v(r?.openingCumulative)} + LN tháng {v(r?.profit)} = {v(r?.cumulative)}; HWM trước {v(r?.openingHighWater)} ⇒ đủ điều kiện {v(r?.eligible)}. Phân bổ từ quỹ công ty {v(phanBo)} × {c.ratePercent.toLocaleString("vi-VN", { maximumFractionDigits: 2 })}% (phần đoạn) = đề nghị {v(c.demand)}; sau trần quỹ công ty: {v(duyet)}.
                                {a?.reason ? ` ${a.reason}` : ""}
                              </p>
                            </details>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </SectionCard>
      ) : null}

      {led.applicable && pending.length ? (
        <SectionCard title="Chờ đối soát (PENDING_RECONCILIATION)" description="Những khoản ERP KHÔNG kết luận được. Không chia đều, không bỏ qua: còn dòng nào ở đây thì kỳ lương không duyệt được.">
          <ul className="space-y-1.5 text-sm">
            {pending.map((p, i) => (
              <li key={`${p.productId}:${p.employeeId}:${i}`} className="rounded border border-amber-200 px-3 py-1.5">
                <b>{p.code || p.productId}</b> · {ten(p.employeeId)} · {formatDate(p.segment.from)} → {formatDate(p.segment.to)}
                {p.provisional !== null ? <span className="text-muted-foreground"> · đang treo {v(p.provisional)}</span> : null}
                <div className="text-muted-foreground">{p.reason}</div>
                {p.kind === "WEIGHT_PARTIAL" && !locked && gate.result.monthKey && !pending.slice(0, i).some((q) => q.kind === "WEIGHT_PARTIAL" && q.productId === p.productId) ? (
                  <ConfirmWeightsButton
                    monthKey={gate.result.monthKey}
                    productId={p.productId}
                    code={p.code || p.productId}
                    fingerprints={vanTayCua(p.productId)}
                    details={vanTayCua(p.productId).map((f) => describeFingerprint(f, (x) => ten(x)))}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {led.applicable && byMk.size ? (
        <SectionCard title="Đóng góp theo MKTer" description="Một MKTer có thể là OWNER mã này và SUPPORT mã khác — mỗi vai trò là một khoản riêng, cộng lại ở đây.">
          <TableToolsFor tableId="payroll-code-mkter" />
          <div className="overflow-x-auto">
            <table id="payroll-code-mkter" className="w-full min-w-[760px] text-[13px]">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">MKTer</th>
                  <th className="py-1 pr-3 text-right font-medium">Số mã · OWNER / SUPPORT</th>
                  <th className="py-1 pr-3 text-right font-medium">Chi phí Ads</th>
                  <th className="py-1 pr-3 text-right font-medium">Doanh thu quy kết</th>
                  <th className="py-1 pr-3 text-right font-medium">Thưởng tạm tính</th>
                  <th className="py-1 text-right font-medium">Thưởng được duyệt</th>
                </tr>
              </thead>
              <tbody>
                {[...byMk.entries()].map(([id, o]) => (
                  <tr key={id} className="border-t">
                    <td className="py-1.5 pr-3 font-medium">
                      <Link href={`/payroll/codes?mkter=${encodeURIComponent(id)}${period.key === "custom" ? "" : `&period=${period.key}`}`} className="hover:text-primary hover:underline">
                        {ten(id)}
                      </Link>
                      {o.pending ? <span className="ml-2 text-xs text-amber-700">{o.pending} chờ đối soát</span> : null}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {o.codes.size} · {o.owner} / {o.support}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{v(o.adSpend)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{v(o.revenue)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{v(o.provisional)}</td>
                    <td className="py-1.5 text-right font-semibold tabular-nums">{v(o.approved)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ) : null}

      {led.applicable ? (
        <SectionCard title="Sổ lũy kế từng mã" description="Mã nào cũng có sổ, kể cả mã chưa ai được phân công. Đổi OWNER không reset sổ: sổ đi theo mã, không theo người.">
          {!led.rows ? (
            <EmptyState title="Lũy kế của mã chưa dựng được" description={led.problem ?? "Thiếu số dư đầu kỳ."} />
          ) : (
            <>
              <TableToolsFor tableId="payroll-code-ledger" />
              <div className="overflow-x-auto">
                <table id="payroll-code-ledger" className="w-full min-w-[900px] text-[13px]">
                  <thead className="text-left text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Mã</th>
                      <th className="py-1 pr-3 text-right font-medium">Doanh thu · Ads</th>
                      <th className="py-1 pr-3 text-right font-medium">Giá vốn · Vận chuyển · Vận hành</th>
                      <th className="py-1 pr-3 text-right font-medium">LN tháng</th>
                      <th className="py-1 pr-3 text-right font-medium">Lũy kế đầu · cuối</th>
                      <th className="py-1 pr-3 text-right font-medium">HWM đầu · lỗ cần bù</th>
                      <th className="py-1 pr-3 text-right font-medium">Đủ điều kiện</th>
                      <th className="py-1 text-right font-medium">Phân bổ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {led.rows
                      .filter((r) => !fCode.length || fCode.includes(r.productId))
                      .slice()
                      .sort((a, b) => b.profit - a.profit)
                      .map((r) => {
                        const p = product.get(r.productId);
                        return (
                          <tr key={r.productId} className="border-t">
                            <td className="py-1.5 pr-3">
                              <Link href={`/products/${r.productId}`} className="font-medium hover:text-primary hover:underline">
                                {r.code || r.productId}
                              </Link>
                              <div className="max-w-[220px] truncate text-xs text-muted-foreground">{p?.productName}</div>
                            </td>
                            <td className="py-1.5 pr-3 text-right tabular-nums">
                              {v(p?.revenue)}
                              <div className="text-xs text-muted-foreground">{v(p?.adSpend)}</div>
                            </td>
                            <td className="py-1.5 pr-3 text-right tabular-nums text-xs">
                              {v(p?.cogs)} · {v(p?.shipping)} · {v(p?.operatingAlloc)}
                            </td>
                            <td className={`py-1.5 pr-3 text-right tabular-nums ${r.profit < 0 ? "text-rose-600" : ""}`}>{v(r.profit)}</td>
                            <td className="py-1.5 pr-3 text-right tabular-nums">
                              {v(r.openingCumulative)}
                              <div className="text-xs text-muted-foreground">{v(r.cumulative)}</div>
                            </td>
                            <td className="py-1.5 pr-3 text-right tabular-nums">
                              {v(r.openingHighWater)}
                              <div className="text-xs text-muted-foreground">{v(r.lossToRecover)}</div>
                            </td>
                            <td className="py-1.5 pr-3 text-right tabular-nums">{v(r.eligible)}</td>
                            <td className="py-1.5 text-right tabular-nums">{led.allocated ? v(led.allocated[r.productId] ?? 0) : "—"}</td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </SectionCard>
      ) : null}

      <SectionCard title="Đối soát với lợi nhuận công ty" description="Lợi nhuận mã tính MỘT lần; phần không chia được xuống mã nào đứng riêng ở đây, không biến mất.">
        <dl className="grid max-w-xl grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm tabular-nums">
          <dt>Σ lợi nhuận các mã ({report.marketers.products.length} mã)</dt>
          <dd className="text-right">{v(sumCodes)}</dd>
          <dt>− Quảng cáo chưa thuộc mã nào (test)</dt>
          <dd className="text-right">{v(t.testSpend)}</dd>
          <dt>− Chi phí chung không chia được xuống mã</dt>
          <dd className="text-right">{v(t.sharedUnallocated)}</dd>
          <dt>− Điều chỉnh vận chuyển không chia được xuống mã</dt>
          <dd className="text-right">{v(t.logisticsAdjustmentUnallocated)}</dd>
          <dt className="font-medium">= Lợi nhuận dựng lại từ mã</dt>
          <dd className="text-right font-medium">{v(reconciled)}</dd>
          <dt className="font-medium">Lợi nhuận công ty (báo cáo marketer)</dt>
          <dd className="text-right font-medium">{v(t.profit)}</dd>
          <dt className={gap === 0 ? "" : "font-semibold text-rose-700"}>Chênh lệch {gap === 0 ? "(khớp)" : "— CHƯA GIẢI THÍCH, kiểm trước khi duyệt"}</dt>
          <dd className={`text-right ${gap === 0 ? "" : "font-semibold text-rose-700"}`}>{v(gap)}</dd>
          <dt>Lợi nhuận tính lương đem xét cổng (sau hoa hồng thông thường)</dt>
          <dd className="text-right">{v(gate.ownBase)}</dd>
        </dl>
      </SectionCard>
    </div>
  );
}

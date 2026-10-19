import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { PayrollTabs } from "@/app/(dashboard)/payroll/tabs";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { TableToolsFor } from "@/components/data-table/table-tools";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { can, requireUser } from "@/lib/auth/session";
import { canAdministerPayroll } from "@/lib/auth/payroll-scope";
import { wholeMonthKey } from "@/lib/constants/payroll-carryover";
import { formatVND } from "@/lib/format";
import { COST_CLASS_LABEL, PROFIT_BONUS_STAGE_LABEL, RECON_STATUS_LABEL, profitBonusStage, reconFingerprintKey, signableFingerprint, type CostClass, type ReconStatus } from "@/lib/payroll/profit-reconciliation";
import { getPayrollReport } from "@/lib/queries/payroll";
import { getPayrollPeriodState, type PayrollSnapshot } from "@/lib/queries/payroll-period";
import { getMonthReconciliation, loadProfitSignoffs } from "@/lib/queries/payroll-reconciliation";
import { resolvePeriod, type SearchParams } from "@/lib/search-params";
import { SignoffPanel } from "@/app/(dashboard)/payroll/reconciliation/signoff-panel";
import { cn } from "@/lib/utils";

export const metadata = { title: "Đối soát lợi nhuận lương" };

const v = (n: number | null | undefined) => formatVND(n ?? null);
const phanTram = (x: number | null) => (x === null ? "—" : `${(x * 100).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`);
const MAU: Record<ReconStatus, string> = {
  MATCHED: "text-emerald-700 dark:text-emerald-400",
  EXPLAINED: "text-sky-700 dark:text-sky-400",
  ESTIMATED: "text-amber-700 dark:text-amber-400",
  UNRECONCILED: "font-semibold text-rose-700 dark:text-rose-400",
};

/**
 * ═══ ĐỐI SOÁT LỢI NHUẬN TÍNH LƯƠNG MỘT THÁNG + DUYỆT HAI CẤP CHO THƯỞNG % LỢI NHUẬN ═══
 *
 * Đặc tả `docs/payroll-code-ledger.md` §9. Mọi số lấy từ `getMonthReconciliation` — trang không cộng
 * trừ thêm. Thưởng % lợi nhuận đủ điều kiện > 0 thì kỳ lương không chốt được khi chưa có chữ ký cấp 1
 * khớp số hiện tại, và người ký cấp 1 không được duyệt cấp 2.
 */
export default async function PayrollReconciliationPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  const user = await requireUser();
  if (!canAdministerPayroll(user, can(user, "payroll:manage"))) redirect("/payroll?forbidden=1");
  const period = resolvePeriod(raw, "last_month");
  const monthKey = wholeMonthKey(period.from, period.to);

  if (!monthKey) {
    return (
      <div className="space-y-5">
        <PageHeader title="Đối soát lợi nhuận lương" description="Đối soát theo TRỌN một tháng lịch — lũy kế lỗ và thưởng % lợi nhuận đi theo tháng." />
        <PayrollTabs canManage />
        <DataTableToolbar period={{ defaultKey: "last_month" }} />
        <EmptyState title="Chọn trọn một tháng lịch" description="Kỳ đang chọn không phải một tháng trọn vẹn. Chọn «Tháng trước» hoặc một khoảng từ ngày 1 tới ngày cuối tháng." />
      </div>
    );
  }

  const [report, state, signoffs] = await Promise.all([getPayrollReport(period, "profit1"), getPayrollPeriodState(period, "profit1"), loadProfitSignoffs(monthKey, { includeRevoked: true })]);
  const live = await getMonthReconciliation(monthKey, { report });
  const gate = report.profitGate.result;
  const runStatus = state.status === "NONE" ? null : state.status;
  /*
    KỲ ĐÃ TÍNH ⇒ ĐỌC ẢNH CHỤP. Thứ được ký là bảng trong ảnh chụp (số sống đổi theo từng webhook);
    trạng thái thưởng cũng đọc từ ảnh vì đó là con số được duyệt. Số sống vẫn hiện bên dưới để so.
  */
  const snap = state.snapshot ? (state.snapshot as PayrollSnapshot) : null;
  const anh = snap?.profitRecon ?? null;
  const recon = anh
    ? { ...live, lines: anh.lines as typeof live.lines, issues: anh.issues.map((i) => ({ ...i, href: live.issues.find((x) => x.code === i.code)?.href ?? null })), status: anh.status, coverage: anh.coverage, classes: anh.classes as typeof live.classes, codes: anh.codes, fingerprint: anh.fingerprint }
    : live;
  const key = anh ? anh.fingerprintKey : reconFingerprintKey(signableFingerprint(live.fingerprint, gate));
  const required = ((snap ? snap.profitGate?.allocatedTotal : gate.allocatedTotal) ?? 0) > 0;
  const claims = snap
    ? snap.lines.flatMap((l) => (l.profitShare?.claims ?? []).map((c) => ({ key: c.key, label: c.label, provisional: c.provisional, eligible: c.eligible, withheld: c.withheld })))
    : gate.allocations.map((a) => ({ key: a.key, label: a.label, provisional: a.provisional, eligible: a.eligible, withheld: a.withheld }));
  const established = snap ? snap.profitGate?.established === true : gate.established;
  const lechSong = anh !== null && anh.fingerprint !== signableFingerprint(live.fingerprint, gate);
  const stageOf = (eligible: number | null) => profitBonusStage({ eligible, established, runStatus, paid: runStatus === "PAID" });
  const theoNac = new Map<string, { n: number; provisional: number; eligible: number }>();
  for (const c of claims) {
    const s = stageOf(c.eligible);
    const o = theoNac.get(s) ?? { n: 0, provisional: 0, eligible: 0 };
    o.n += 1;
    o.provisional += c.provisional ?? 0;
    o.eligible += c.eligible ?? 0;
    theoNac.set(s, o);
  }
  const prevMonth = (() => {
    const [y, m] = monthKey.split("-").map(Number);
    const d = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
    const last = new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0)).getUTCDate();
    return `/payroll/reconciliation?period=custom&from=${d}-01&to=${d}-${String(last).padStart(2, "0")}`;
  })();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Đối soát lợi nhuận lương"
        description="Đặt cạnh nhau lợi nhuận tính lương và nguồn của nó (máy chi phí, chứng từ tiền, kết quả đơn). Dòng chưa đối soát hoặc ước tính thì thưởng % lợi nhuận không được tự duyệt."
      />
      <PayrollTabs canManage />
      <DataTableToolbar period={{ defaultKey: "last_month" }} />
      <p className="text-sm">
        <Link href={prevMonth} className="text-primary hover:underline">
          ← Tháng trước
        </Link>
      </p>

      <SectionCard
        title={`Tháng ${monthKey} · ${recon.status === "RECONCILED" ? "ĐÃ ĐỐI SOÁT ĐỦ" : `CHƯA ĐỐI SOÁT — ${recon.issues.length} khoản`}`}
        description={
          anh
            ? `Bảng trong ẢNH CHỤP kỳ (${runStatus}) — đây là thứ được ký và duyệt.${lechSong ? " Số hiện tại ĐÃ KHÁC ảnh chụp (đơn chốt kết quả / chi phí nhập thêm): tính lại kỳ để chụp số mới, rồi ký lại." : " Số hiện tại vẫn khớp ảnh chụp."}`
            : `Chưa tính kỳ lương tháng này — bảng dưới là SỐ SỐNG (để xem, không ký được). Lợi nhuận tính lương ${v(report.totalProfit)} · ${gate.message}`
        }
      >
        <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Doanh thu đã giao có chứng từ tiền</dt>
            <dd className="font-semibold tabular-nums">{phanTram(recon.coverage.revenueWithMoneyPct)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Giá trị đơn đã có kết quả</dt>
            <dd className="font-semibold tabular-nums">{phanTram(recon.coverage.revenueSettledPct)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Chi phí khớp nguồn / đã giải thích</dt>
            <dd className="font-semibold tabular-nums">{phanTram(recon.coverage.costReconciledPct)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Mã: đủ dữ liệu · có phân công / tổng</dt>
            <dd className="font-semibold tabular-nums">
              {recon.codes.profitComplete} · {recon.codes.assigned} / {recon.codes.total}
            </dd>
          </div>
        </dl>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          {(Object.keys(COST_CLASS_LABEL) as CostClass[]).map((c) => (
            <div key={c}>
              <dt className="text-muted-foreground">{COST_CLASS_LABEL[c]}</dt>
              <dd className={cn("tabular-nums", c === "UNKNOWN_SOURCE" || c === "NOT_IN_BASIS" ? (recon.classes[c] > 0 ? "font-semibold text-rose-700" : "") : "")}>{v(recon.classes[c])}</dd>
            </div>
          ))}
        </dl>
      </SectionCard>

      <SectionCard title="Đối chiếu từng dòng" description="Cơ sở lương = số bảng lương dùng. Nguồn = máy chi phí / chứng từ trên đơn. Bấm dòng để mở dữ liệu nguồn.">
        <TableToolsFor tableId="payroll-recon-lines" />
        <div className="overflow-x-auto">
          <table id="payroll-recon-lines" className="w-full min-w-[960px] text-[13px]">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-medium">Khoản</th>
                <th className="py-1 pr-3 text-right font-medium">Cơ sở lương</th>
                <th className="py-1 pr-3 text-right font-medium">Nguồn</th>
                <th className="py-1 pr-3 text-right font-medium">Chênh</th>
                <th className="py-1 pr-3 font-medium">Trạng thái · Nhóm</th>
                <th className="py-1 font-medium">Giải thích</th>
              </tr>
            </thead>
            <tbody>
              {recon.lines.map((l) => (
                <tr key={l.key} className="border-t align-top">
                  <td className="py-1.5 pr-3 font-medium">{l.href ? <Link href={l.href} className="hover:text-primary hover:underline">{l.label}</Link> : l.label}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{v(l.basis)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{v(l.source)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{v(l.diff)}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    <span className={MAU[l.status]}>{RECON_STATUS_LABEL[l.status]}</span>
                    <div className="text-xs text-muted-foreground">{l.cls === "REVENUE" ? "Doanh thu" : COST_CLASS_LABEL[l.cls]}</div>
                  </td>
                  <td className="max-w-[420px] py-1.5 text-xs text-muted-foreground">{l.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {recon.issues.length ? (
        <SectionCard title="Khoản chưa đối soát được" description="Mỗi khoản dẫn tới đúng chỗ sửa. Còn khoản nào ở đây thì chữ ký cấp 1 phải nói rõ vì sao vẫn chấp nhận.">
          <ul className="space-y-1.5 text-sm">
            {recon.issues.map((i) => (
              <li key={i.code} className="rounded border border-rose-200 px-3 py-1.5">
                <b>{i.label}</b>
                {i.count !== null ? ` · ${i.count.toLocaleString("vi-VN")} mục` : ""}
                {i.amount !== null ? ` · ${v(i.amount)}` : ""}
                {i.href ? (
                  <Link href={i.href} className="ml-2 text-primary hover:underline">
                    mở →
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <SectionCard title="Thưởng % lợi nhuận theo trạng thái" description={`Kỳ lương tháng ${monthKey}: ${runStatus ?? "chưa tính"}${snap ? " · đọc từ ảnh chụp đã khoá" : ""}.`}>
        {claims.length === 0 ? (
          <EmptyState title="Tháng này không có khoản thưởng % lợi nhuận nào" description="Không ai có thành phần lương tính trên lợi nhuận trong tháng." />
        ) : (
          <>
            <dl className="mb-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
              {(Object.keys(PROFIT_BONUS_STAGE_LABEL) as (keyof typeof PROFIT_BONUS_STAGE_LABEL)[]).map((s) => (
                <div key={s}>
                  <dt className="text-muted-foreground">{PROFIT_BONUS_STAGE_LABEL[s]}</dt>
                  <dd className="tabular-nums">
                    {theoNac.get(s)?.n ?? 0} khoản · {v(s === "PROVISIONAL" || s === "NOT_ELIGIBLE" ? (theoNac.get(s)?.provisional ?? 0) : (theoNac.get(s)?.eligible ?? 0))}
                  </dd>
                </div>
              ))}
            </dl>
            <TableToolsFor tableId="payroll-recon-bonus" />
            <div className="overflow-x-auto">
              <table id="payroll-recon-bonus" className="w-full min-w-[720px] text-[13px]">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Khoản</th>
                    <th className="py-1 pr-3 text-right font-medium">Tạm tính</th>
                    <th className="py-1 pr-3 text-right font-medium">Chưa đủ ĐK</th>
                    <th className="py-1 pr-3 text-right font-medium">Đủ ĐK</th>
                    <th className="py-1 font-medium">Trạng thái</th>
                  </tr>
                </thead>
                <tbody>
                  {claims.map((c) => (
                    <tr key={c.key} className="border-t">
                      <td className="py-1.5 pr-3">{c.label}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{v(c.provisional)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{v(c.withheld)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{v(c.eligible)}</td>
                      <td className="py-1.5">{PROFIT_BONUS_STAGE_LABEL[stageOf(c.eligible)]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </SectionCard>

      <SectionCard
        title="Duyệt hai cấp"
        description={required ? "Tháng có thưởng % lợi nhuận ĐỦ ĐIỀU KIỆN: cấp 1 ký đối soát (dưới đây), rồi một NGƯỜI KHÁC duyệt kỳ lương ở tab Bảng lương (cấp 2)." : "Tháng chưa có thưởng % lợi nhuận đủ điều kiện nên chốt kỳ không cần chữ ký đối soát — vẫn ký được để lưu vết đã đối chiếu."}
      >
        <SignoffPanel
          monthKey={monthKey}
          fingerprintKey={key}
          canSign={anh !== null && (runStatus === "CALCULATED" || runStatus === "UNDER_REVIEW")}
          cannotSignWhy={!anh ? "Chưa có ảnh chụp kỳ — bấm “Tính & chụp ảnh kỳ” ở tab Bảng lương trước. Chữ ký ký trên ảnh chụp, không trên số sống." : runStatus === "CALCULATED" || runStatus === "UNDER_REVIEW" ? null : `Kỳ đang ở trạng thái “${runStatus}” — chỉ ký khi kỳ Đã tính / Đang soát.`}
          locked={state.frozen}
          issues={recon.issues.map((i) => i.label)}
          signoffs={signoffs.map((s) => ({ id: s.id, current: !s.revokedAt && s.fingerprint === recon.fingerprint, revoked: Boolean(s.revokedAt), signedByEmail: s.signedByEmail, signedAt: s.signedAt, reason: s.reason, status: s.status }))}
        />
      </SectionCard>
    </div>
  );
}

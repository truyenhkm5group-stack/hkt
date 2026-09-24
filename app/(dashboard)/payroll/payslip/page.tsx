import Link from "next/link";
import { TableToolsFor } from "@/components/data-table/table-tools";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { PayrollTabs } from "@/app/(dashboard)/payroll/tabs";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { InfoHint } from "@/components/info-hint";
import { EmptyState, Money, SectionCard } from "@/components/ui-bits";
import { can, requireUser } from "@/lib/auth/session";
import { canOpenPayroll, payrollLineVisible, resolvePayrollScope } from "@/lib/auth/payroll-scope";
import { PAYROLL_BASIS_NAME, parsePayrollBasis, type PayrollBasis } from "@/lib/constants/payroll";
import { PAYROLL_COMPONENT_KIND_LABEL, PAYROLL_COMPONENT_SIGN, type PayrollComponentKind } from "@/lib/constants/payroll-components";
import { PAYROLL_RUN_STATUS_LABEL } from "@/lib/constants/payroll-lifecycle";
import { DEFAULT_STATUTORY, STATUTORY_DEDUCTION_KEY, statutoryDisplay, type StatutoryConfig } from "@/lib/constants/payroll-statutory";
import { MISSING_TEXT, formatDateTime, formatVND } from "@/lib/format";
import { employeeMatchesUser, getPayrollReport } from "@/lib/queries/payroll";
import { getPayrollPeriodState } from "@/lib/queries/payroll-period";
import { param, resolvePeriod, type SearchParams } from "@/lib/search-params";
import { getSettingJson } from "@/lib/settings";
import { cn } from "@/lib/utils";

export const metadata = { title: "Phiếu lương" };

/**
 * ═══ PHIẾU LƯƠNG MỘT NGƯỜI ═══
 *
 * ─── ĐỌC ĐÂU RA CON SỐ: ẢNH CHỤP TRƯỚC, BẢN TÍNH SỐNG SAU ───
 *
 * Kỳ đã ĐÓNG BĂNG đọc ảnh chụp — đó là con số đã dùng để trả tiền, và nó phải đứng yên kể cả khi
 * chính sách hôm nay đã đổi. Kỳ chưa đóng băng đọc bản tính sống và NÓI RÕ rằng nó còn đổi: in
 * một phiếu lương nháp mà không ghi "nháp" là đưa cho người ta một tờ giấy họ sẽ cầm đi đòi tiền.
 *
 * ─── QUYỀN: NGƯỜI CHỈ XEM CỦA MÌNH THÌ CHỈ XEM ĐƯỢC CỦA MÌNH ───
 *
 * Khớp bằng KHOÁ TÀI KHOẢN (`employeeMatchesUser`), không so tên — hai người trùng tên sẽ đọc
 * được phiếu lương của nhau.
 */
export default async function PayslipPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  const user = await requireUser();
  const scope = resolvePayrollScope(user);
  if (!canOpenPayroll(scope)) redirect("/?forbidden=1");
  const period = resolvePeriod(raw, "month");
  const basis: PayrollBasis = parsePayrollBasis(param(raw, "basis"));
  const wanted = param(raw, "employee");

  const [report, state, statutoryConfig] = await Promise.all([
    getPayrollReport(period, basis),
    getPayrollPeriodState(period, basis),
    getSettingJson<StatutoryConfig>(STATUTORY_DEDUCTION_KEY, DEFAULT_STATUTORY),
  ]);
  const statutory = statutoryDisplay(statutoryConfig);
  /*
    LỌC TRƯỚC, CHỌN SAU — và cả hai bước đi qua `filterPayrollLines`. `wanted` đến từ THANH ĐỊA CHỈ
    nên nó chỉ được phép chọn TRONG danh sách đã lọc; đổi `?employee=` sang người khác thì không có
    dòng nào khớp, không phải "thấy dòng của người ấy".
  */
  const visible = report.lines.filter((l) => payrollLineVisible(scope, l.employee, user, employeeMatchesUser));
  const line = wanted ? visible.find((l) => l.employee.id === wanted) : visible.length === 1 ? visible[0] : undefined;
  const qs = new URLSearchParams({ period: period.key, basis, ...(period.key === "custom" ? { from: period.fromKey ?? "", to: period.toKey ?? "" } : {}) }).toString();

  /* Kỳ đã đóng băng: lấy dòng TỪ ẢNH CHỤP, không lấy từ bản tính sống. */
  const snapLine = state.frozen && state.snapshot && line ? state.snapshot.lines.find((l) => l.employeeId === line.employee.id) : undefined;
  const engine = snapLine?.engine ?? (line?.engine ? { ...line.engine.result, policy: [] } : null);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Phiếu lương"
        description={`${period.label} · cơ sở “${PAYROLL_BASIS_NAME[basis]}” · ${state.status === "NONE" ? "kỳ chưa được tính" : PAYROLL_RUN_STATUS_LABEL[state.status]}`}
      />
      <PayrollTabs canManage={can(user, "payroll:manage")} />
      <DataTableToolbar period={{ defaultKey: "month" }} />

      {visible.length > 1 ? (
        <div className="flex flex-wrap gap-1.5">
          {visible.map((l) => (
            <Link
              key={l.employee.id}
              href={`/payroll/payslip?${qs}&employee=${l.employee.id}`}
              className={cn("rounded-md border px-2.5 py-1 text-[13px] hover:bg-muted", l.employee.id === line?.employee.id ? "border-primary bg-muted font-medium" : "")}
            >
              {l.employee.shortName || l.employee.name}
            </Link>
          ))}
        </div>
      ) : null}

      {!line ? (
        <EmptyState
          title={visible.length ? "Chọn một nhân sự" : "Không có dòng lương nào bạn xem được"}
          description={
            visible.length
              ? "Bấm một tên ở trên để mở phiếu lương của người đó."
              : "Quyền “Lương: xem của mình” khớp bằng KHOÁ TÀI KHOẢN — ô “Email đăng nhập ERP” trong hồ sơ nhân sự phải trùng email phiên đăng nhập. Chưa khai thì nhờ quản trị khai giúp."
          }
        />
      ) : (
        <SectionCard
          title={`${line.employee.name}${line.employee.shortName ? ` · ${line.employee.shortName}` : ""}`}
          description={`${line.employee.department} · kỳ ${period.label}`}
          hint={`Phiếu này đọc từ CÙNG một phép tính với bảng lương và tệp xuất — không có công thức riêng nào ở đây.${
            state.frozen ? " Kỳ đã khoá nên con số lấy từ ảnh chụp lúc khoá, kể cả khi chính sách hôm nay đã đổi." : " Kỳ chưa khoá nên con số còn đổi theo dữ liệu nguồn."
          }`}
          actions={
            state.frozen ? (
              <span className="rounded bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
                Số đã chốt · đọc từ ảnh chụp {state.lockedAt ? formatDateTime(state.lockedAt) : ""}
              </span>
            ) : (
              <span className="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                BẢN NHÁP — kỳ chưa khoá, con số còn đổi
              </span>
            )
          }
        >
          <TableToolsFor tableId="payroll-payslip-page" />
          <div className="overflow-x-auto">
            <table id="payroll-payslip-page" className="w-full min-w-[560px] text-[13px]">
              <tbody>
                {engine && "components" in engine && engine.components.length ? (
                  <>
                    {[...engine.components, ...engine.adjustments].map((c) => {
                      const sign = PAYROLL_COMPONENT_SIGN[c.kind as PayrollComponentKind] ?? 1;
                      return (
                        <tr key={c.code} className="border-b">
                          <td className="py-1.5 pr-3">
                            {c.label}
                            <span className="ml-2 text-[11px] text-muted-foreground">{PAYROLL_COMPONENT_KIND_LABEL[c.kind as PayrollComponentKind] ?? c.kind}</span>
                          </td>
                          <td className={cn("py-1.5 text-right tabular-nums", sign < 0 ? "text-rose-700 dark:text-rose-400" : "")}>
                            {c.amount === null ? <span className="text-muted-foreground">{MISSING_TEXT}</span> : <Money value={c.amount} sign />}
                          </td>
                        </tr>
                      );
                    })}
                    <tr className="border-b">
                      <td className="py-1.5 pr-3 text-right font-medium">Tổng thu nhập</td>
                      <td className="py-1.5 text-right tabular-nums font-medium">
                        <Money value={engine.grossEarnings} />
                      </td>
                    </tr>
                    <tr className="border-b">
                      <td className="py-1.5 pr-3 text-right font-medium">Tổng khấu trừ</td>
                      <td className="py-1.5 text-right tabular-nums font-medium">
                        <Money value={engine.totalDeductions} />
                      </td>
                    </tr>
                    <StatutoryRow statutory={statutory} />
                    <tr className="border-t-2">
                      <td className="py-2 pr-3 text-right font-semibold">Thực nhận</td>
                      <td className="py-2 text-right tabular-nums font-semibold">
                        <Money value={engine.netPay} className="text-base" />
                      </td>
                    </tr>
                  </>
                ) : (
                  <>
                    {/*
                      ĐƯỜNG TÍNH CŨ: bốn ô trên hồ sơ nhân sự. Vẫn in ra phiếu được — người chưa
                      chuyển sang máy chung vẫn phải nhận được phiếu lương của mình.
                    */}
                    <tr className="border-b">
                      <td className="py-1.5 pr-3">Lương cứng (phần thuộc kỳ)</td>
                      <td className="py-1.5 text-right tabular-nums">{line.fixed === null ? MISSING_TEXT : formatVND(line.fixed)}</td>
                    </tr>
                    <tr className="border-b">
                      <td className="py-1.5 pr-3">Thưởng % lợi nhuận toàn shop</td>
                      <td className="py-1.5 text-right tabular-nums">{formatVND(line.bonusTotal)}</td>
                    </tr>
                    <tr className="border-b">
                      <td className="py-1.5 pr-3">Hoa hồng % lợi nhuận cá nhân</td>
                      <td className="py-1.5 text-right tabular-nums">{line.bonusPersonal === null ? MISSING_TEXT : formatVND(line.bonusPersonal)}</td>
                    </tr>
                    <tr className="border-b">
                      <td className="py-1.5 pr-3">Hoa hồng % doanh thu cá nhân</td>
                      <td className="py-1.5 text-right tabular-nums">{formatVND(line.bonusRevenue)}</td>
                    </tr>
                    {/* Điều chỉnh (tạm ứng, thưởng, quyết toán kỳ trước…) — kỳ đã khoá đọc từ ảnh chụp. */}
                    {((snapLine ? snapLine.legacyAdjustments : line.legacyAdjustments)?.items ?? []).map((a, i) => (
                      <tr key={`adj-${i}`} className="border-b">
                        <td className="py-1.5 pr-3">
                          <span className="inline-flex items-center gap-1">
                            {a.label}
                            {a.reason ? <InfoHint>{a.reason}</InfoHint> : null}
                          </span>
                        </td>
                        <td className={cn("py-1.5 text-right tabular-nums", a.amount < 0 ? "text-rose-700 dark:text-rose-400" : "")}>
                          <Money value={a.amount} sign />
                        </td>
                      </tr>
                    ))}
                    <StatutoryRow statutory={statutory} />
                    <tr className="border-t-2">
                      <td className="py-2 pr-3 text-right font-semibold">Thực nhận</td>
                      <td className="py-2 text-right tabular-nums font-semibold">
                        <Money value={line.salary} className="text-base" />
                      </td>
                    </tr>
                  </>
                )}
              </tbody>
            </table>
          </div>

          {line.carry ? (
            <p className="mt-3 text-[11px] text-muted-foreground">
              {`Bù lỗ lũy kế tháng ${line.carry.monthKey}: lỗ đầu kỳ ${formatVND(line.carry.openingBalance)}, chuyển sang kỳ sau ${formatVND(line.carry.closingBalance)}.`}
            </p>
          ) : null}
        </SectionCard>
      )}
    </div>
  );
}

/**
 * DÒNG KHẤU TRỪ THEO LUẬT — VÀ VÌ SAO NÓ KHÔNG BAO GIỜ IN "0 ₫" KHI CHƯA KHAI.
 *
 * `statutoryDisplay` trả `amount: null` khi chưa cấu hình, nên nhánh CHƯA BIẾT ở đây là bắt buộc
 * chứ không phải một lựa chọn trình bày. Một phiếu lương in "0 ₫" ở dòng thuế là một lời khẳng
 * định rằng khoản khấu trừ đã được tính và bằng không — trong khi sự thật là chưa ai tính
 * (AGENTS.md mục 42). Người cầm phiếu phải phân biệt được hai điều đó.
 */
function StatutoryRow({ statutory }: { statutory: { amount: number | null; label: string; hint: string } }) {
  return (
    <tr className="border-b">
      <td className="py-1.5 pr-3">
        <span className="inline-flex items-center gap-1">
          Khấu trừ theo luật (thuế TNCN · BHXH · BHYT · BHTN)
          <InfoHint>{statutory.hint}</InfoHint>
        </span>
      </td>
      <td className="py-1.5 text-right tabular-nums">
        {statutory.amount === null ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">{statutory.label}</span>
        ) : (
          <Money value={statutory.amount} sign />
        )}
      </td>
    </tr>
  );
}

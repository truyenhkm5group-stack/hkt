import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { PayrollTabs } from "@/app/(dashboard)/payroll/tabs";
import { EmptyState, Money, SectionCard } from "@/components/ui-bits";
import { can, requireUser } from "@/lib/auth/session";
import { canAdministerPayroll, canSeeAllPayroll, resolvePayrollScope } from "@/lib/auth/payroll-scope";
import {
  PAYROLL_APPROVAL_REMIND_DAY,
  PAYROLL_CLOSE_DAY,
  PAYROLL_PAY_DAY,
  PAYSLIP_CONFIRM_WINDOW_HOURS,
  PAYSLIP_STATE_LABEL,
} from "@/lib/constants/payroll-autopilot";
import { PAYROLL_RUN_STATUS_LABEL } from "@/lib/constants/payroll-lifecycle";
import { formatDateTime } from "@/lib/format";
import { periodLabelOf } from "@/lib/payroll/payslip-delivery";
import { getAutopilotCockpit } from "@/lib/queries/payroll-autopilot";
import { cn } from "@/lib/utils";
import { ApproveLockButton, AutopilotToggle, ManualMatchButton, PayoutQrButton, RerunSettlementButton, ResendButton, RunNowButton } from "./controls";

export const metadata = { title: "Trả lương tự động" };

const TONE: Record<string, string> = {
  CONFIRMED: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  DISPUTED: "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200",
  PENDING: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  NO_RESPONSE: "bg-muted text-muted-foreground",
  NOT_DELIVERED: "bg-muted text-muted-foreground",
};

const STEPS = [
  { day: `Ngày ${String(PAYROLL_CLOSE_DAY).padStart(2, "0")}`, what: "Máy quyết toán tháng trước nữa, tính & chụp ảnh tháng trước, gửi phiếu vào hộp thư từng người" },
  { day: `+${PAYSLIP_CONFIRM_WINDOW_HOURS} giờ`, what: "Nhân viên bấm Xác nhận hoặc Khiếu nại. Hết hạn mà im lặng ghi là “không phản hồi”, không phải “đã xác nhận”" },
  { day: "Khi đủ trả lời", what: `Anh nhận MỘT tin: bấm “Duyệt & khoá”. Từ ngày ${PAYROLL_APPROVAL_REMIND_DAY} nếu chưa duyệt, mỗi ngày nhắc một lần` },
  { day: `Ngày ${PAYROLL_PAY_DAY}`, what: "Quét mã QR chuyển từng người. Tiền ra vào sổ ngân hàng thì dòng tự thành “Đã trả”; đủ mọi dòng thì kỳ tự thành ĐÃ TRẢ" },
];

/**
 * ═══ TRẢ LƯƠNG TỰ ĐỘNG — MÀN HÌNH CỦA NGƯỜI DUYỆT ═══
 *
 * Đặc tả: `docs/payroll-autopilot.md`. Số của kỳ đọc từ ẢNH CHỤP (không tính lại). Kế hoạch "hôm nay
 * máy làm gì" là CHÍNH hàm job dùng. Không có nút "đánh dấu đã trả" suông: đã trả đi bằng sao kê.
 */
export default async function PayrollAutopilotPage() {
  const user = await requireUser();
  const scope = resolvePayrollScope(user);
  // Số của CẢ công ty (tổng lương, lương từng người, tài khoản nhận) — đòi phạm vi toàn công ty.
  if (!canSeeAllPayroll(scope)) redirect("/payroll?forbidden=1");
  const canManage = canAdministerPayroll(user, can(user, "payroll:manage"));
  const canApprove = can(user, "payroll:approve") && canAdministerPayroll(user, true);
  const v = await getAutopilotCockpit(user.id);
  const reviewing = v.status === "UNDER_REVIEW" || v.status === "APPROVED";
  const warn =
    v.summary && (v.summary.DISPUTED || v.summary.PENDING || v.summary.NOT_DELIVERED)
      ? `Còn ${v.summary.DISPUTED} khiếu nại · ${v.summary.PENDING} người chưa trả lời · ${v.summary.NOT_DELIVERED} người chưa gửi được phiếu.`
      : null;
  const payoutByPeriod = new Map<string, typeof v.payoutLines>();
  for (const l of v.payoutLines) payoutByPeriod.set(l.periodKey, [...(payoutByPeriod.get(l.periodKey) ?? []), l]);

  return (
    <div className="space-y-5">
      <PageHeader title="Trả lương tự động" description={`Chốt số ngày ${String(PAYROLL_CLOSE_DAY).padStart(2, "0")} · trả lương ngày ${PAYROLL_PAY_DAY} · phiếu gửi riêng từng người`} />
      <PayrollTabs canManage={can(user, "payroll:manage")} />

      <SectionCard
        title="Lịch trả lương"
        hint="Máy làm: mở kỳ, quyết toán, tính, gửi phiếu, nhắc, lập lệnh chuyển, khớp tiền ra với sao kê. Máy KHÔNG BAO GIỜ duyệt, khoá, hay tự khai “đã trả” khi chưa có dòng sao kê — duyệt là chữ ký của anh, và bước OTP trên app ngân hàng là lớp bảo vệ tiền của shop."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <AutopilotToggle enabled={v.config.enabled} canApprove={canApprove} />
            {canManage ? <RunNowButton /> : null}
          </div>
        }
      >
        <ol className="grid gap-2 sm:grid-cols-4">
          {STEPS.map((s, i) => (
            <li key={s.day} className="rounded-xl border p-3">
              <div className="text-[11px] font-semibold text-muted-foreground">
                {i + 1}. {s.day}
              </div>
              <div className="mt-1 text-[13px] leading-5">{s.what}</div>
            </li>
          ))}
        </ol>
        <div className="mt-4 rounded-xl bg-muted/50 p-3 text-[13px]">
          <div className="mb-1 font-medium">Máy sẽ làm gì ở lượt chạy tới (mỗi giờ):</div>
          <ul className="list-disc space-y-0.5 pl-5">
            {v.plan.map((s, i) => (
              <li key={i}>{s.why}</li>
            ))}
          </ul>
        </div>
      </SectionCard>

      {v.setup.some((x) => !x.ok) ? (
        <SectionCard title="Cài đặt một lần" description="Làm xong các mục dưới đây trước ngày chốt để máy chạy không vấp.">
          <ul className="space-y-2 text-[13px]">
            {v.setup.map((x) => (
              <li key={x.key} className="flex items-start gap-2">
                <span className={cn("mt-0.5 rounded px-1.5 text-[11px] font-semibold", x.ok ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200" : "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200")}>{x.ok ? "Xong" : "Cần làm"}</span>
                <div>
                  <Link href={x.href} className="font-medium hover:underline">
                    {x.title}
                  </Link>
                  <div className="text-muted-foreground">{x.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <SectionCard
        title={`Kỳ lương ${v.period.label}`}
        description={`${v.status === "NONE" ? "Chưa tính" : PAYROLL_RUN_STATUS_LABEL[v.status]} · hạn trả ${v.payDay.split("-").reverse().join("/")}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {v.status === "CALCULATED" && canManage ? <ResendButtonForCalculated /> : null}
            {v.status === "UNDER_REVIEW" && canManage ? <ResendButton periodKey={v.period.periodKey} /> : null}
            {reviewing && canApprove ? <ApproveLockButton periodKey={v.period.periodKey} warn={warn} /> : null}
          </div>
        }
      >
        <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
          <span>
            Tổng thực nhận: <Money value={v.totalSalary} className="font-semibold" />
          </span>
          <span>Số người: {v.people ?? "—"}</span>
          {v.approvedAt ? <span>Duyệt {formatDateTime(v.approvedAt)}</span> : null}
          {v.lockedAt ? <span>Khoá {formatDateTime(v.lockedAt)}</span> : null}
          {v.paidAt ? <span>Đã trả {formatDateTime(v.paidAt)}</span> : null}
        </div>
        {v.lastBlocked ? (
          <div className="mb-3 whitespace-pre-line rounded-md bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <b>Lần thử tính gần nhất ({formatDateTime(v.lastBlocked.createdAt)}) chưa được:</b>
            {"\n"}
            {v.lastBlocked.body}
          </div>
        ) : null}
        {v.confirmations.length === 0 ? (
          <EmptyState title="Chưa gửi phiếu nào cho kỳ này" description="Phiếu được gửi khi kỳ chuyển sang bước soát — máy tự làm sau giờ chốt, hoặc bấm “Chạy ngay một lượt”." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[13px]">
              <thead className="text-left text-muted-foreground">
                <tr className="border-b">
                  <th className="px-2 py-1.5 font-medium">Nhân sự</th>
                  <th className="px-2 py-1.5 text-right font-medium">Thực nhận (đã gửi)</th>
                  <th className="px-2 py-1.5 font-medium">Trạng thái</th>
                  <th className="px-2 py-1.5 font-medium">Trả lời</th>
                </tr>
              </thead>
              <tbody>
                {v.confirmations.map((r) => (
                  <tr key={r.id} className="border-b last:border-b-0">
                    <td className="px-2 py-1.5 font-medium">{r.employeeName}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      <Money value={r.amount} />
                    </td>
                    <td className="px-2 py-1.5">
                      <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", TONE[r.state])}>{PAYSLIP_STATE_LABEL[r.state]}</span>
                    </td>
                    <td className="px-2 py-1.5 text-[12px] text-muted-foreground">
                      {r.respondedAt ? `${formatDateTime(r.respondedAt)}${r.note ? ` — “${r.note}”` : ""}` : `hạn ${formatDateTime(r.deadlineAt)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Quyết toán kỳ trước (đơn có kết cục sau ngày chốt)"
        hint="Lương tháng M chốt ngày 01 theo đơn đã có kết cục. Ngày 01 tháng sau nữa máy tính lại tháng M bằng TỶ LỆ ĐÃ CHỐT; phần chênh vào phiếu lương kỳ này thành một dòng “Quyết toán … — truy lĩnh / truy thu”, kèm căn cứ. Lương cứng không quyết toán. Người có sổ lỗ lũy kế phải quyết toán tay."
        actions={canManage ? <RerunSettlementButton /> : null}
      >
        {!v.settlement ? (
          <p className="text-[13px] text-muted-foreground">Chưa chạy quyết toán cho kỳ này — máy chạy ngay trước khi tính kỳ, khi kỳ trước đã khoá.</p>
        ) : (
          <>
            <p className="mb-2 text-[12px] text-muted-foreground">
              Tính lúc {formatDateTime(v.settlement.computedAt)} · kỳ được quyết toán: {periodLabelOf(v.settlement.previousPeriodKey)} · {v.settlement.written} dòng điều chỉnh
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-[13px]">
                <tbody>
                  {v.settlement.results.map((r) => (
                    <tr key={r.employeeId} className="border-b align-top last:border-b-0">
                      <td className="px-2 py-1.5 font-medium">{r.name}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.status === "OK" ? <Money value={r.delta} sign className={r.delta < 0 ? "text-rose-700 dark:text-rose-400" : ""} /> : <span className="text-[11px] text-amber-700 dark:text-amber-400">{r.status === "MANUAL" ? "Cần quyết toán tay" : "Chưa biết"}</span>}</td>
                      <td className="px-2 py-1.5 text-[12px] text-muted-foreground">
                        {r.status === "OK"
                          ? r.explain.map((x) => (
                              <div key={x.label}>
                                {x.label}: <Money value={x.before} /> → <Money value={x.after} />
                              </div>
                            ))
                          : r.reason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </SectionCard>

      <SectionCard
        title="Lệnh chuyển lương"
        hint="Lập tự động khi kỳ được KHOÁ, từ ảnh chụp đã duyệt. Mã QR mang sẵn ngân hàng, số tài khoản, số tiền và nội dung riêng của từng người. “Đã trả” chỉ có khi một dòng sao kê chứng minh — máy khớp theo nội dung + số tiền; nội dung gõ khác thì bấm “Khớp tay” và chọn đúng dòng sao kê."
      >
        {v.payoutLines.length === 0 ? (
          <EmptyState title="Chưa có lệnh chuyển" description="Lệnh chuyển được lập khi anh bấm “Duyệt & khoá”." />
        ) : (
          [...payoutByPeriod.entries()].map(([periodKey, lines]) => (
            <div key={periodKey} className="mb-4 last:mb-0">
              <div className="mb-1 text-[12px] font-semibold text-muted-foreground">{periodLabelOf(periodKey)}</div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-[13px]">
                  <thead className="text-left text-muted-foreground">
                    <tr className="border-b">
                      <th className="px-2 py-1.5 font-medium">Người nhận</th>
                      <th className="px-2 py-1.5 font-medium">Tài khoản</th>
                      <th className="px-2 py-1.5 text-right font-medium">Số tiền</th>
                      <th className="px-2 py-1.5 font-medium">Nội dung</th>
                      <th className="px-2 py-1.5 font-medium">Trạng thái</th>
                      <th className="px-2 py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.id} className="border-b last:border-b-0">
                        <td className="px-2 py-1.5 font-medium">{l.employeeName}</td>
                        <td className="px-2 py-1.5 text-[12px]">
                          {l.accountNumber ? (
                            <>
                              {l.bankName} · {l.accountNumber}
                              <div className="text-muted-foreground">{l.accountName}</div>
                            </>
                          ) : (
                            <span className="text-rose-700 dark:text-rose-400">Chưa khai STK</span>
                          )}
                          {l.accountChanged ? <div className="font-semibold text-rose-700 dark:text-rose-400">⚠ STK khác lần trả trước</div> : null}
                        </td>
                        <td className="px-2 py-1.5 text-right font-semibold tabular-nums">
                          <Money value={l.amount} />
                        </td>
                        <td className="px-2 py-1.5 font-mono text-[12px]">{l.transferNote}</td>
                        <td className="px-2 py-1.5 text-[12px]">
                          {l.status === "PAID" ? (
                            <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">Đã trả {formatDateTime(l.paidAt)}</span>
                          ) : (
                            <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">Chờ chuyển</span>
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          {l.status === "PENDING" && canApprove ? (
                            <div className="flex items-center justify-end gap-1">
                              <PayoutQrButton line={{ id: l.id, employeeName: l.employeeName, amount: l.amount, bankBin: l.bankBin, bankName: l.bankName, accountNumber: l.accountNumber, accountName: l.accountName, transferNote: l.transferNote, accountChanged: l.accountChanged }} />
                              <ManualMatchButton lineId={l.id} />
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))
        )}
      </SectionCard>
    </div>
  );
}

/** Kỳ bị trả về rồi tính lại: người sửa gửi lại phiếu bằng bước “Chuyển soát” ở tab Lịch sử kỳ. */
function ResendButtonForCalculated() {
  return <span className="text-[12px] text-muted-foreground">Kỳ vừa được tính lại — bấm “Chuyển soát” ở bảng lương để gửi phiếu mới.</span>;
}

import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { PageHeader } from "@/components/page-header";
import { PayslipBreakdown } from "@/components/payroll/payslip-breakdown";
import { EmptyState, Money, SectionCard } from "@/components/ui-bits";
import { requireUser } from "@/lib/auth/session";
import { PAYSLIP_STATE_LABEL, payslipState } from "@/lib/constants/payroll-autopilot";
import { DEFAULT_STATUTORY, STATUTORY_DEDUCTION_KEY, statutoryDisplay, type StatutoryConfig } from "@/lib/constants/payroll-statutory";
import { formatDateTime } from "@/lib/format";
import { listMyPayslips, payslipOwnerGate, payslipSnapshotLine, periodLabelOf } from "@/lib/payroll/payslip-delivery";
import { param, type SearchParams } from "@/lib/search-params";
import { getSettingJson } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { PayslipRespondForm } from "./respond-form";

export const metadata = { title: "Phiếu lương của tôi" };

const TONE: Record<string, string> = {
  CONFIRMED: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  DISPUTED: "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200",
  PENDING: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  NO_RESPONSE: "bg-muted text-muted-foreground",
  NOT_DELIVERED: "bg-muted text-muted-foreground",
};

/**
 * ═══ PHIẾU LƯƠNG CỦA TÔI ═══
 *
 * Trang của NGƯỜI NHẬN phiếu. Cổng là QUYỀN SỞ HỮU phiếu (`payslipOwnerGate`) chứ không phải một khoá
 * quyền lương: người được gửi phiếu thì xem được đúng phiếu ấy — không xem được bảng lương, không xem
 * được dòng của ai khác, không đổi được `?c=` sang phiếu người khác.
 *
 * Số in ra là ẢNH CHỤP lúc gửi — đúng thứ người ấy xác nhận — không phải bản tính sống.
 */
export default async function MyPayslipPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  const user = await requireUser();
  const mine = await listMyPayslips(user.id, 12);
  const wanted = param(raw, "c");
  const chosen = wanted ? mine.find((r) => r.id === wanted) : mine[0];
  // `?c=` trỏ tới phiếu không phải của mình ⇒ cổng từ chối, trang in như "không có phiếu" — không lộ gì.
  const gate = chosen ? await payslipOwnerGate(user, chosen.id) : { ok: false as const, error: "" };
  const now = new Date();

  const detail = chosen && gate.ok ? await payslipSnapshotLine(chosen.periodKey, chosen.basis, chosen.employeeId) : null;
  const statutory = statutoryDisplay(await getSettingJson<StatutoryConfig>(STATUTORY_DEDUCTION_KEY, DEFAULT_STATUTORY));
  const db = await getDb();
  const L = schema.payrollPayoutLines;
  const [payout] =
    chosen && gate.ok
      ? await db
          .select({ status: L.status, paidAt: L.paidAt, transferNote: L.transferNote, bankName: L.bankName, accountNumber: L.accountNumber })
          .from(L)
          .where(and(eq(L.periodKey, chosen.periodKey), eq(L.basis, chosen.basis), eq(L.employeeId, chosen.employeeId)))
          .limit(1)
      : [];
  const state = chosen ? payslipState(chosen, now) : null;
  const stale = Boolean(detail && chosen && detail.calcRuns !== chosen.round);
  const canRespond = Boolean(chosen && gate.ok && detail && !stale && (detail.status === "UNDER_REVIEW" || detail.status === "APPROVED"));

  return (
    <div className="space-y-5">
      <PageHeader title="Phiếu lương của tôi" description="Phiếu lương ERP gửi riêng cho bạn. Kiểm tra từng dòng, rồi bấm Xác nhận hoặc Khiếu nại." />

      {mine.length > 1 ? (
        <div className="flex flex-wrap gap-1.5">
          {mine.map((r) => (
            <Link
              key={r.id}
              href={`/my-payslip?c=${r.id}`}
              className={cn("rounded-md border px-2.5 py-1 text-[13px] hover:bg-muted", r.id === chosen?.id ? "border-primary bg-muted font-medium" : "")}
            >
              {periodLabelOf(r.periodKey)}
              {r.round > 1 ? ` · lượt ${r.round}` : ""}
            </Link>
          ))}
        </div>
      ) : null}

      {!chosen || !gate.ok || !detail?.line ? (
        <EmptyState
          title="Chưa có phiếu lương nào gửi cho bạn"
          description="Phiếu lương được gửi vào đây sau ngày chốt số (mùng 1 hằng tháng). Nếu đồng nghiệp đã nhận mà bạn chưa, nhờ người phụ trách lương kiểm lại ô “Email đăng nhập ERP” trong hồ sơ nhân sự của bạn."
        />
      ) : (
        <>
          <SectionCard
            title={`Phiếu lương ${detail.periodLabel}`}
            description={`Gửi lúc ${formatDateTime(chosen.sentAt)} · hạn xác nhận ${formatDateTime(chosen.deadlineAt)}`}
            hint="Con số là ẢNH CHỤP lúc gửi phiếu — không đổi theo dữ liệu hôm nay. Đơn giao thành công SAU ngày chốt sẽ được quyết toán vào phiếu tháng sau (dòng “Quyết toán … — truy lĩnh”)."
            actions={state ? <span className={cn("rounded px-2 py-0.5 text-[11px] font-medium", TONE[state])}>{PAYSLIP_STATE_LABEL[state]}</span> : null}
          >
            {stale ? (
              <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-[13px] text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                Kỳ này đã được tính lại sau khi gửi phiếu này. Phiếu mới (nếu có) nằm ở danh sách phía trên — hãy xác nhận trên phiếu mới nhất.
              </p>
            ) : null}
            <PayslipBreakdown line={detail.line} statutory={statutory} />
            <p className="mt-3 text-[12px] text-muted-foreground">
              Số đã gửi: <Money value={chosen.amount} className="font-medium text-foreground" />
            </p>
          </SectionCard>

          <SectionCard title="Trả lời">
            {canRespond ? (
              <PayslipRespondForm confirmationId={chosen.id} status={chosen.status} note={chosen.note} />
            ) : (
              <p className="text-[13px] text-muted-foreground">
                {chosen.status === "CONFIRMED" ? "Bạn đã xác nhận phiếu này." : chosen.status === "DISPUTED" ? `Bạn đã khiếu nại: “${chosen.note}”.` : "Kỳ này không còn ở bước soát nên không nhận trả lời nữa."}{" "}
                Có sai sót thì nhắn người phụ trách lương — phần sai được sửa bằng khoản điều chỉnh ở kỳ sau.
              </p>
            )}
          </SectionCard>

          <SectionCard title="Chuyển khoản">
            {payout ? (
              payout.status === "PAID" ? (
                <p className="text-[13px]">
                  Đã chuyển lúc <b>{formatDateTime(payout.paidAt)}</b> vào {payout.bankName} ···{payout.accountNumber.slice(-4)} · nội dung <code>{payout.transferNote}</code>.
                </p>
              ) : (
                <p className="text-[13px] text-muted-foreground">
                  Lệnh chuyển đã lập, chờ chuyển (hạn ngày 15). Nội dung chuyển khoản sẽ là <code>{payout.transferNote}</code>.
                  {!payout.accountNumber ? " Hồ sơ của bạn CHƯA có số tài khoản nhận lương — báo người phụ trách lương khai giúp." : ""}
                </p>
              )
            ) : (
              <p className="text-[13px] text-muted-foreground">Chưa lập lệnh chuyển — lệnh được lập sau khi kỳ lương được duyệt và khoá.</p>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}

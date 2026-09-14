import Link from "next/link";
import { AlertTriangle, ArrowLeftRight, Banknote, HandCoins, Landmark, Link2 as Link2Icon, ReceiptText, ShieldQuestion } from "lucide-react";
import { RuleFromTxnButton } from "@/app/(dashboard)/bank/rule-from-txn";
import { MatchActions } from "@/app/(dashboard)/bank/match-actions";
import { CreateAndLinkExpenseDialog } from "@/app/(dashboard)/finance-ops/create-and-link-expense-dialog";
import { LinkExistingDialog } from "@/app/(dashboard)/finance-ops/link-existing-dialog";
import { ConfirmAccountButton, ConfirmInternalTransferButton, IgnoreOrTransferMenu, PayrollClassifyButton, QueueClassifySelect } from "@/app/(dashboard)/finance-ops/queue-actions";
import { Badge } from "@/components/ui/badge";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { BANK_GROUP_SPEC } from "@/lib/constants/bank";
import { EXPENSE_CATEGORY_LABEL } from "@/lib/constants/expenses";
import { FINANCE_OPS_COD_STATUS_HINT, FINANCE_OPS_COD_STATUS_LABEL, type FinanceOpsCodStatus } from "@/lib/constants/finance-ops";
import { maskAccountNumber } from "@/lib/constants/bank";
import { formatDate, formatVND } from "@/lib/format";
import {
  codMatchQueue,
  expensesWithoutPayment,
  internalTransferCandidateRows,
  paymentsWithoutExpense,
  payrollUnmatched,
  unclassifiedBankRows,
  unconfirmedAccountRows,
} from "@/lib/queries/finance-ops";

/**
 * ═══════ CÁC KHỐI CỦA HÀNG ĐỢI TÁC VỤ TÀI CHÍNH ═══════
 *
 * Mỗi hàm là một Server Component tự lấy dữ liệu của mình — cùng kiểu với các tab của Sổ ngân hàng
 * (`app/(dashboard)/bank/match-tab.tsx`). `page.tsx` chỉ quyết định BLOCK nào được hiện theo quyền,
 * không truyền dữ liệu tay qua tay.
 */

const AMOUNT_TONE = (amount: number) => (amount > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400");

export async function BankUnclassifiedSection({ canWrite, canExpense }: { canWrite: boolean; canExpense: boolean }) {
  const rows = await unclassifiedBankRows(100);
  return (
    <SectionCard
      title="Giao dịch ngân hàng chưa phân loại"
      description="Mỗi dòng tiền vào/ra chưa được gán nhóm kế toán."
      hint="Phân loại KHÔNG tự tạo chi phí — chi phí chỉ được ghi nhận khi có khoản chi thật và nối chứng từ. Chuyển nội bộ và không thuộc kinh doanh không cần nối gì cả."
      padded={false}
    >
      {rows.length === 0 ? (
        <EmptyState title="Không còn giao dịch nào chờ phân loại" description="Sổ ngân hàng đã gán nhóm cho toàn bộ giao dịch hiện có." className="m-4" icon={Landmark} />
      ) : (
        <ul className="divide-y">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <div className="min-w-[220px] flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`numeric text-sm font-semibold ${AMOUNT_TONE(r.amount)}`}>{formatVND(r.amount, { sign: true })}</span>
                  <span className="text-[12px] text-muted-foreground">{formatDate(r.txnAt)}</span>
                  {r.employeeSuggestion ? (
                    <Badge variant="outline" className="text-[10.5px] text-indigo-700 dark:text-indigo-300">
                      Có thể là lương của {r.employeeSuggestion.name}
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-0.5 line-clamp-2 text-[12.5px] text-muted-foreground">
                  {r.counterparty ? <b className="text-foreground">{r.counterparty}</b> : null} {r.description || "(không có nội dung)"}
                </p>
              </div>
              {canWrite ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <QueueClassifySelect id={r.id} value={r.accountingGroup} />
                  {r.amount < 0 && canExpense ? (
                    <>
                      <CreateAndLinkExpenseDialog txnId={r.id} amount={r.amount} txnAt={r.txnAt} description={r.counterparty || r.description} defaultCategory={r.employeeSuggestion ? "SALARY" : "OTHER"} />
                      <LinkExistingDialog txnId={r.id} type="EXPENSE" label="Liên kết khoản có sẵn" />
                    </>
                  ) : null}
                  {r.amount > 0 ? <LinkExistingDialog txnId={r.id} type="COD_BATCH" label="Liên kết đợt COD" /> : null}
                  <IgnoreOrTransferMenu id={r.id} />
                  <RuleFromTxnButton txn={r} />
                </div>
              ) : (
                <Badge variant="outline" className="text-[11px]">
                  {BANK_GROUP_SPEC.UNCLASSIFIED.label}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

const COD_TONE: Record<FinanceOpsCodStatus, string> = {
  MATCHED: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200",
  PARTIAL: "bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200",
  REVIEW: "bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200",
  UNMATCHED: "bg-muted text-muted-foreground",
};

export async function CodMatchSection({ canWrite }: { canWrite: boolean }) {
  const { rows, counts } = await codMatchQueue(100);
  return (
    <SectionCard
      title="Tiền COD chưa đối khớp"
      description="Tiền ĐVVC trả về, đối chiếu với đợt COD đã lập — không tạo doanh thu mới."
      hint="MATCHED: có đúng một đợt COD khớp mã hoặc khớp tiền + ngày. PARTIAL: khớp đúng một đợt nhưng lệch số tiền (thường do cước/phí hoàn bị trừ thẳng). REVIEW: nhiều đợt cùng khớp, cần người chọn. UNMATCHED: chưa có đợt COD nào khớp."
      padded={false}
    >
      {rows.length === 0 ? (
        <EmptyState title="Không còn tiền COD nào chờ đối khớp" description="Mọi khoản tiền ĐVVC trả về đã được nối với một đợt COD." className="m-4" icon={Banknote} />
      ) : (
        <ul className="divide-y">
          {rows.map((r) => (
            <li key={r.txnId} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <div className="min-w-[220px] flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span title={FINANCE_OPS_COD_STATUS_HINT[r.status]} className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${COD_TONE[r.status]}`}>
                    {FINANCE_OPS_COD_STATUS_LABEL[r.status]}
                  </span>
                  <span className="numeric text-sm font-semibold text-emerald-600 dark:text-emerald-400">{formatVND(r.bankAmount)}</span>
                  <span className="text-[12px] text-muted-foreground">{formatDate(r.txnAt)}</span>
                </div>
                <p className="mt-0.5 line-clamp-2 text-[12.5px] text-muted-foreground">
                  {r.counterparty ? <b className="text-foreground">{r.counterparty}</b> : null} {r.description || "(không có nội dung)"}
                </p>
                {r.settlementAmount !== null ? (
                  <p className="mt-1 text-[11.5px] text-muted-foreground">
                    Đợt COD: <b className="text-foreground">{r.reference}</b> · {formatVND(r.settlementAmount)}
                    {r.difference !== null && r.difference !== 0 ? <span className={r.difference > 0 ? "text-emerald-600" : "text-rose-600"}> · lệch {formatVND(r.difference, { sign: true })}</span> : null}
                  </p>
                ) : null}
              </div>
              {canWrite ? (
                r.target ? (
                  <MatchActions txnId={r.txnId} type={r.target.type} targetId={r.target.id} />
                ) : r.others.length ? (
                  <div className="space-y-1">
                    {r.others.slice(0, 4).map((o) => (
                      <div key={`${o.type}-${o.id}`} className="flex items-center gap-2 rounded-md border bg-card px-2 py-1">
                        <span className="truncate text-[12px]">{o.label}</span>
                        <span className="numeric ml-auto shrink-0 text-[11.5px] text-muted-foreground">{formatVND(o.amount)}</span>
                        <MatchActions txnId={r.txnId} type={o.type} targetId={o.id} compact />
                      </div>
                    ))}
                  </div>
                ) : (
                  <LinkExistingDialog txnId={r.txnId} type="COD_BATCH" label="Tìm đợt COD" />
                )
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2 border-t px-4 py-2 text-[11px] text-muted-foreground">
        {(Object.keys(counts) as FinanceOpsCodStatus[]).map((s) => (
          <span key={s}>
            {FINANCE_OPS_COD_STATUS_LABEL[s]}: <b className="text-foreground">{counts[s]}</b>
          </span>
        ))}
      </div>
    </SectionCard>
  );
}

export async function PaymentNoExpenseSection({ canWrite }: { canWrite: boolean }) {
  const rows = await paymentsWithoutExpense(100);
  return (
    <SectionCard
      title="Đã phân loại chi phí nhưng chưa nối chứng từ"
      description="Dòng sao kê đã gán nhóm chi phí (lương, mặt bằng, phần mềm…) nhưng chưa nối với khoản chi nào ở bảng Chi phí."
      hint="Nối để đối chiếu 'tiền đã ra' với 'chi phí đã ghi sổ'. Nhóm đã có nguồn chuyên biệt (quảng cáo, tiền hàng, cước ĐVVC) không hiện ở đây vì chúng đối chiếu bằng loại chứng từ khác."
      padded={false}
    >
      {rows.length === 0 ? (
        <EmptyState title="Không còn khoản nào" description="Mọi dòng đã phân loại chi phí đều đã nối chứng từ." className="m-4" icon={ReceiptText} />
      ) : (
        <ul className="divide-y">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-[220px] flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`numeric text-sm font-semibold ${AMOUNT_TONE(r.amount)}`}>{formatVND(r.amount, { sign: true })}</span>
                  <span className="text-[12px] text-muted-foreground">{formatDate(r.txnAt)}</span>
                  <Badge variant="outline" className="text-[10.5px]">
                    {BANK_GROUP_SPEC[r.accountingGroup as keyof typeof BANK_GROUP_SPEC]?.label ?? r.accountingGroup}
                  </Badge>
                </div>
                <p className="mt-0.5 line-clamp-1 text-[12.5px] text-muted-foreground">
                  {r.counterparty ? <b className="text-foreground">{r.counterparty}</b> : null} {r.description}
                </p>
              </div>
              {canWrite ? <LinkExistingDialog txnId={r.id} type="EXPENSE" label="Liên kết khoản có sẵn" /> : null}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

export async function PayrollUnmatchedSection({ canWrite }: { canWrite: boolean }) {
  const rows = await payrollUnmatched(100);
  return (
    <SectionCard
      title="Lương / hoa hồng chưa đối khớp"
      description="Gợi ý theo tên/bí danh đã khai ở trang Lương — người vẫn phải bấm xác nhận."
      hint="Không có sổ trả lương theo từng nhân sự trong ERP: 'đã đối khớp' ở đây nghĩa là dòng tiền đã được gán đúng nhóm Lương cố định / Hoa hồng và (nếu có khoản chi tương ứng) đã nối chứng từ."
      padded={false}
    >
      {rows.length === 0 ? (
        <EmptyState title="Không còn việc lương/hoa hồng nào chờ xử lý" icon={HandCoins} className="m-4" />
      ) : (
        <ul className="divide-y">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-[220px] flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`numeric text-sm font-semibold ${AMOUNT_TONE(r.amount)}`}>{formatVND(r.amount, { sign: true })}</span>
                  <span className="text-[12px] text-muted-foreground">{formatDate(r.txnAt)}</span>
                  <Badge variant="outline" className="text-[10.5px]">
                    {r.reason === "CLASSIFIED_NOT_LINKED" ? "Đã gán nhóm, chưa nối chứng từ" : `Gợi ý: ${r.employeeSuggestion?.name}`}
                  </Badge>
                </div>
                <p className="mt-0.5 line-clamp-1 text-[12.5px] text-muted-foreground">
                  {r.counterparty ? <b className="text-foreground">{r.counterparty}</b> : null} {r.description}
                </p>
              </div>
              {canWrite ? (
                r.reason === "CLASSIFIED_NOT_LINKED" ? (
                  <LinkExistingDialog txnId={r.id} type="EXPENSE" label="Liên kết khoản có sẵn" />
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <PayrollClassifyButton id={r.id} group="PAYROLL_SALARY" label="Lương cố định" />
                    <PayrollClassifyButton id={r.id} group="PAYROLL_COMMISSION" label="Hoa hồng / thưởng" />
                  </div>
                )
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

export async function InternalTransferSection({ canWrite }: { canWrite: boolean }) {
  const pairs = await internalTransferCandidateRows(200);
  return (
    <SectionCard
      title="Nghi ngờ chuyển khoản nội bộ"
      description="Tiền ra ở một tài khoản của shop và tiền vào cùng số ở một tài khoản khác của shop."
      hint="Chỉ ghép khi số tiền khớp tuyệt đối và mỗi bên chỉ có đúng một ứng viên — nhiều ứng viên cùng số tiền thì không đoán, dòng đó vẫn nằm ở mục 'chưa phân loại' để người xem."
      padded={false}
    >
      {pairs.length === 0 ? (
        <EmptyState title="Không có cặp nào nghi ngờ chuyển nội bộ" icon={ArrowLeftRight} className="m-4" />
      ) : (
        <ul className="divide-y">
          {pairs.map((p) => (
            <li key={`${p.out.id}-${p.in.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-[260px] flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="numeric text-sm font-semibold">{formatVND(p.amount)}</span>
                  <span className="text-[12px] text-muted-foreground">cách nhau {p.dayDiff} ngày</span>
                </div>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  Ra {formatDate(p.out.txnAt)} · {p.out.counterparty || p.out.description || "(không có nội dung)"}
                </p>
                <p className="text-[12px] text-muted-foreground">
                  Vào {formatDate(p.in.txnAt)} · {p.in.counterparty || p.in.description || "(không có nội dung)"}
                </p>
              </div>
              {canWrite ? <ConfirmInternalTransferButton outId={p.out.id} inId={p.in.id} /> : null}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

export async function ExpenseNoPaymentSection() {
  const rows = await expensesWithoutPayment(100);
  return (
    <SectionCard
      title="Khoản chi chưa có chứng từ tiền"
      description="Đã ghi ở bảng Chi phí nhưng chưa có dòng sao kê nào nối tới."
      hint="Có thể vì chưa tới ngày trả, trả bằng tài khoản chưa xác nhận, hoặc sao kê có nhưng máy đối khớp chưa tìm ra (khác mã, khác tiền vài đồng phí ngân hàng) — xem thêm ở Sổ ngân hàng → Đối khớp."
      actions={
        <Link href="/bank?tab=doi-khop" className="text-[11.5px] text-primary hover:underline">
          Mở Đối khớp
        </Link>
      }
      padded={false}
    >
      {rows.length === 0 ? (
        <EmptyState title="Mọi khoản chi đều có chứng từ tiền" icon={AlertTriangle} className="m-4" />
      ) : (
        <ul className="divide-y">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <span className="numeric text-sm font-semibold text-rose-600 dark:text-rose-400">{formatVND(r.amount)}</span>
              <span className="text-[12px] text-muted-foreground">{formatDate(r.occurredAt)}</span>
              <Badge variant="outline" className="text-[10.5px]">
                {EXPENSE_CATEGORY_LABEL[r.category as keyof typeof EXPENSE_CATEGORY_LABEL] ?? r.category}
              </Badge>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">{r.description}</span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

export async function UnconfirmedAccountsSection() {
  const rows = await unconfirmedAccountRows();
  return (
    <SectionCard
      title="Tài khoản ngân hàng chưa xác nhận"
      description="ERP tự khai tài khoản mới để không mất giao dịch — cần người xác nhận đây đúng là tài khoản của shop."
      hint="Xác nhận không đụng tới giao dịch nào đã có, chỉ đổi trạng thái tài khoản."
      padded={false}
    >
      {rows.length === 0 ? (
        <EmptyState title="Không có tài khoản nào chờ xác nhận" icon={ShieldQuestion} className="m-4" />
      ) : (
        <ul className="divide-y">
          {rows.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <Link2Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="text-[13px] font-medium">{a.gateway || "Ngân hàng"}</span>
              <span className="numeric text-[12.5px] text-muted-foreground">{maskAccountNumber(a.accountNumber)}</span>
              {a.subAccount ? <span className="text-[11.5px] text-muted-foreground">TK ảo {a.subAccount}</span> : null}
              <span className="ml-auto shrink-0">
                <ConfirmAccountButton id={a.id} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

import Link from "next/link";
import { FileSpreadsheet, Link2, ShieldQuestion, Sparkles } from "lucide-react";
import { MatchActions, AutoConfirmButton } from "@/app/(dashboard)/bank/match-actions";
import { MetricCard } from "@/components/metric-card";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { Badge } from "@/components/ui/badge";
import { MATCH_CONFIDENCE_NOTE, type MatchConfidence } from "@/lib/integrations/bank/match";
import { formatDate, formatNumber, formatVND } from "@/lib/format";
import { getMatchOverview } from "@/lib/queries/bank-match";
import { cn } from "@/lib/utils";

/**
 * ───────────── ĐỐI KHỚP SAO KÊ VỚI CHỨNG TỪ ─────────────
 *
 * Thứ tự trên màn hình đi theo thứ tự VIỆC PHẢI LÀM, không theo thứ tự bảng chữ cái: việc cần người
 * quyết đứng trước, việc máy tự làm được để sau.
 *
 * Mỗi dòng luôn kèm LÝ DO bằng tiếng Việt. Người dùng phải đọc được vì sao máy đề xuất — một mức tin
 * cậy không giải thích được thì hoặc bị tin mù, hoặc bị bỏ qua hoàn toàn, và cả hai đều tệ.
 */

const TONE: Record<MatchConfidence, string> = {
  EXACT: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200",
  HIGH_CONFIDENCE: "bg-sky-100 text-sky-900 dark:bg-sky-950/50 dark:text-sky-200",
  AMBIGUOUS: "bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200",
  UNMATCHED: "bg-muted text-muted-foreground",
};

export async function BankMatchTab({ canWrite }: { canWrite: boolean }) {
  const { suggestions, counts, reconciled, total } = await getMatchOverview(100);

  /**
   * SỔ RỖNG LÀ "CHƯA NHẬP", KHÔNG PHẢI "KHÔNG CÓ GÌ ĐỂ ĐỐI KHỚP".
   *
   * Production hiện chưa có giao dịch nào. Hiện một bảng trống kèm "0 khớp" sẽ khiến người dùng
   * tưởng máy đối khớp hỏng. Nói thẳng là chưa có dữ liệu, và chỉ đúng chỗ để bắt đầu.
   */
  if (total === 0) {
    return (
      <SectionCard>
        <EmptyState
          title="Chưa có giao dịch ngân hàng"
          description="Nhập sao kê để bắt đầu đối soát. Máy sẽ tự tìm chứng từ khớp với từng dòng tiền — bảng kê COD, khoản chi, phiếu nhập hàng, chi tiêu quảng cáo."
          action={
            <Link
              href="/bank?tab=nhap-sao-ke"
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              <FileSpreadsheet className="size-4" /> Nhập sao kê
            </Link>
          }
        />
      </SectionCard>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard label="Đã nối chứng từ" value={formatNumber(reconciled)} note={`trên tổng ${formatNumber(total)} giao dịch`} icon={Link2} tone="green" />
        <MetricCard label="Cần người quyết" value={formatNumber(counts.AMBIGUOUS)} note="Nhiều chứng từ cùng khớp" icon={ShieldQuestion} tone={counts.AMBIGUOUS ? "amber" : "slate"} />
        <MetricCard label="Khớp định danh" value={formatNumber(counts.EXACT)} note="Có mã chứng từ, tự nối được" icon={Sparkles} tone={counts.EXACT ? "green" : "slate"} />
        <MetricCard label="Gần như chắc" value={formatNumber(counts.HIGH_CONFIDENCE)} note="Máy đề xuất, người xác nhận" icon={Sparkles} tone={counts.HIGH_CONFIDENCE ? "blue" : "slate"} />
        <MetricCard label="Chưa khớp" value={formatNumber(counts.UNMATCHED)} note="Không tìm thấy chứng từ nào" icon={ShieldQuestion} tone="slate" />
      </div>

      {canWrite && counts.EXACT > 0 ? <AutoConfirmButton count={counts.EXACT} /> : null}

      <SectionCard
        title="Gợi ý đối khớp"
        description="Việc cần người quyết đứng trước. Chỉ khớp định danh (có mã chứng từ trong nội dung chuyển khoản) mới được tự nối — mọi mức khác đều phải có người bấm."
        padded={false}
      >
        {suggestions.length === 0 ? (
          <EmptyState title="Mọi giao dịch đã được nối chứng từ" description="Không còn dòng nào chờ đối khớp." className="m-4" />
        ) : (
          <ul className="divide-y">
            {suggestions.map((s) => (
              <li key={s.txnId} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <div className="min-w-[240px] flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold", TONE[s.confidence])} title={MATCH_CONFIDENCE_NOTE[s.confidence]}>
                      {s.confidenceLabel}
                    </span>
                    <span className={cn("numeric text-sm font-semibold", s.amount > 0 ? "text-emerald-600" : "text-rose-600")}>{formatVND(s.amount, { sign: true })}</span>
                    <span className="text-[12px] text-muted-foreground">{formatDate(s.txnAt)}</span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-[12.5px] text-muted-foreground">
                    {s.counterparty ? <b className="text-foreground">{s.counterparty}</b> : null} {s.description || "(không có nội dung)"}
                  </p>
                  {/* LÝ DO — thứ khiến người dùng tin được hoặc bác bỏ được đề xuất. */}
                  <ul className="mt-1 space-y-0.5">
                    {s.reasons.map((r, i) => (
                      <li key={i} className="text-[11.5px] leading-snug text-muted-foreground">
                        · {r}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="min-w-[210px] flex-1">
                  {s.target ? (
                    <div className="rounded-lg border bg-muted/40 p-2">
                      <div className="text-[11px] text-muted-foreground">{s.target.typeLabel}</div>
                      <div className="truncate text-[13px] font-medium">{s.target.label}</div>
                      <div className="numeric text-[12px] text-muted-foreground">
                        {formatVND(s.target.amount)} · {formatDate(s.target.at)}
                      </div>
                    </div>
                  ) : s.others.length ? (
                    <div className="space-y-1">
                      <div className="text-[11px] font-medium text-amber-700 dark:text-amber-300">{s.others.length} chứng từ cùng khớp — chọn một:</div>
                      {s.others.slice(0, 4).map((o) => (
                        <div key={`${o.type}-${o.id}`} className="flex items-center gap-2 rounded-md border bg-card px-2 py-1">
                          <span className="truncate text-[12px]">{o.label}</span>
                          <span className="numeric ml-auto shrink-0 text-[11.5px] text-muted-foreground">{formatVND(o.amount)}</span>
                          {canWrite ? <MatchActions txnId={s.txnId} type={o.type} targetId={o.id} compact /> : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Badge variant="outline" className="text-[11px]">
                      Không có chứng từ nào khớp
                    </Badge>
                  )}
                </div>

                {canWrite && s.target ? (
                  <div className="shrink-0 self-center">
                    <MatchActions txnId={s.txnId} type={s.target.type} targetId={s.target.id} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

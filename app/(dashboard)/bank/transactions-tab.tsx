import { ArrowDownLeft, ArrowUpRight, ReceiptText, TriangleAlert } from "lucide-react";
import { BankDirectionFilter, BankUnclassifiedToggle } from "@/app/(dashboard)/bank/bank-filters";
import { ManualTxnDialog } from "@/app/(dashboard)/bank/manual-dialog";
import { BankTransactionsTable } from "@/app/(dashboard)/bank/transactions-table";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { MetricCard } from "@/components/metric-card";
import { BANK_SORTABLE, bankFacets, bankSummary, listBankTransactions, type BankListOptions } from "@/lib/queries/bank";
import { formatNumber, formatVND } from "@/lib/format";
import { param, parseListParams, type Period, type SearchParams } from "@/lib/search-params";
import type { BankDirection } from "@/lib/constants/bank";

export async function BankTransactionsTab({ raw, period, canWrite }: { raw: SearchParams; period: Period; canWrite: boolean }) {
  const params = parseListParams(raw, { defaultSort: "txnAt", filterKeys: ["group", "category"], sortable: BANK_SORTABLE, defaultPeriod: "month", defaultPageSize: 50 });
  const direction = (["IN", "OUT"].includes(param(raw, "chieu")) ? param(raw, "chieu") : "ANY") as BankDirection;
  const onlyUnclassified = param(raw, "chuaphanloai") === "1";
  const options: BankListOptions = { direction, onlyUnclassified };

  const [{ rows, total, pageCount }, summary, facets, unfilteredSummary] = await Promise.all([
    listBankTransactions(params, options),
    bankSummary(params, options),
    bankFacets(params, options),
    // Số "chưa phân loại" trên nút bấm phải là số của CẢ KỲ, không phải của bộ lọc đang bật —
    // nếu không, bật nút xong con số tự đổi và không ai hiểu mình còn bao nhiêu việc.
    bankSummary({ ...params, filters: {}, q: "" }, { direction: "ANY", onlyUnclassified: false }),
  ]);

  return (
    <div className="space-y-5">
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label={`Tiền vào · ${period.label.toLowerCase()}`}
          value={formatVND(summary.businessIn, { compact: true })}
          note={summary.businessIn !== summary.moneyIn ? `Đã loại ${formatVND(summary.moneyIn - summary.businessIn, { compact: true })} chuyển nội bộ / vốn vay` : `${formatNumber(summary.count)} giao dịch`}
          icon={ArrowDownLeft}
          tone="green"
        />
        <MetricCard
          label="Tiền ra"
          value={formatVND(summary.businessOut, { compact: true })}
          note={summary.businessOut !== summary.moneyOut ? `Đã loại ${formatVND(summary.moneyOut - summary.businessOut, { compact: true })} chuyển nội bộ / trả gốc` : "Chi thực từ tài khoản"}
          icon={ArrowUpRight}
          tone="rose"
        />
        <MetricCard
          label="Chênh lệch"
          value={<span className={summary.businessNet >= 0 ? "text-success" : "text-destructive"}>{formatVND(summary.businessNet, { compact: true })}</span>}
          note="Tiền vào − tiền ra của dòng tiền kinh doanh. Đây KHÔNG phải lợi nhuận: tiền hàng trả trước và tiền COD về trễ đều rơi vào kỳ khác."
          icon={ReceiptText}
          tone={summary.businessNet >= 0 ? "green" : "rose"}
        />
        <MetricCard
          label="Chưa phân loại"
          value={formatNumber(unfilteredSummary.unclassified)}
          note={unfilteredSummary.unclassified ? `${formatVND(unfilteredSummary.unclassifiedAmount, { compact: true })} chưa vào báo cáo nào — đây là CHƯA BIẾT, không phải bằng 0` : "Đã phân loại hết trong kỳ"}
          icon={TriangleAlert}
          tone={unfilteredSummary.unclassified ? "amber" : "slate"}
        />
      </section>

      <DataTableToolbar
        searchPlaceholder="Nội dung, đối tác, mã GD…"
        period={{ defaultKey: "month" }}
        facets={[
          { key: "group", label: "Nhóm kế toán", options: facets.groups },
          ...(facets.categories.length ? [{ key: "category", label: "Mã danh mục", options: facets.categories }] : []),
        ]}
        resultLabel={`${formatNumber(total)} giao dịch phù hợp · tiền vào ${formatVND(summary.moneyIn)} · tiền ra ${formatVND(summary.moneyOut)}`}
      >
        <BankDirectionFilter value={direction} />
        <BankUnclassifiedToggle active={onlyUnclassified} count={unfilteredSummary.unclassified} />
        {canWrite ? <ManualTxnDialog /> : null}
      </DataTableToolbar>

      <BankTransactionsTable rows={rows} pageCount={pageCount} total={total} canWrite={canWrite} />
    </div>
  );
}

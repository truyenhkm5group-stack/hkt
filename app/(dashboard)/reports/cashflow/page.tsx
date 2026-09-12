import { BridgeTab } from "@/app/(dashboard)/reports/cashflow/bridge-tab";
import { CashflowTabs } from "@/app/(dashboard)/reports/cashflow/cashflow-tabs";
import { ForecastTab } from "@/app/(dashboard)/reports/cashflow/forecast-tab";
import { StatementTab } from "@/app/(dashboard)/reports/cashflow/statement-tab";
import { PeriodFilter } from "@/components/data-table/toolbar";
import { FinanceNav } from "@/components/finance-nav";
import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth/session";
import { isCashflowTab, type CashflowTab } from "@/lib/constants/cashflow-tabs";
import { param, resolvePeriod, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Dòng tiền" };

/**
 * ═══════════ DÒNG TIỀN — BA CƠ SỞ ĐO, BA TAB ═══════════
 *
 * Trước đây trang này CHỈ có phần dự phóng, và nó nói thẳng lý do: "ERP KHÔNG có số dư ngân hàng".
 * Câu đó đúng vào lúc viết và nay đã lỗi thời — `bank_transactions.balance_after` (số dư do chính
 * ngân hàng ghi trên mỗi giao dịch) đã được lưu từ lâu mà không truy vấn nào đọc tới.
 *
 * Nên trang nay có ba tab, và chúng là ba CƠ SỞ ĐO khác nhau — không bao giờ được cộng với nhau:
 *
 *   · Tiền thật đã vào ra — ĐÃ XẢY RA. Từ sao kê, có đầu kỳ / cuối kỳ ngân hàng ghi, có phép kiểm.
 *   · Dự phóng kỳ tới     — CHƯA XẢY RA. Suy từ nhịp chi. Nội dung nguyên bản, giữ nguyên công thức.
 *   · Lợi nhuận ≠ tiền    — GIẢI THÍCH vì sao hai con số trên khác nhau.
 *
 * Mỗi tab chỉ chạy truy vấn của CHÍNH NÓ: mở tab dự phóng không phải trả giá cho báo cáo tiền thật
 * và ngược lại. Đây là lý do phần thân là ba thành phần riêng chứ không phải một trang gọi hết.
 */
export default async function CashflowPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  await requirePermission("reports:cash");
  const period = resolvePeriod(raw, "month");
  const requested = param(raw, "tab", "thuc-te");
  const tab = (isCashflowTab(requested) ? requested : "thuc-te") as CashflowTab;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Tài chính"
        title="Dòng tiền"
        description="Lợi nhuận không phải tiền — trang này đo tiền"
        hint="Một shop bán COD có thể lãi trên giấy mà vẫn hết tiền mặt: hàng đã giao nhưng Viettel Post giữ tiền cả tuần, còn tiền quảng cáo và tiền hàng thì trả ngay. Ba tab là ba cơ sở đo khác nhau (đã xảy ra / chưa xảy ra / giải thích khoảng lệch) và không bao giờ được cộng với nhau."
        actions={tab === "du-phong" ? undefined : <PeriodFilter defaultKey="month" />}
      />
      <FinanceNav />
      <CashflowTabs active={tab} />

      {tab === "thuc-te" ? <StatementTab period={period} /> : null}
      {/* Dự phóng luôn nhìn về PHÍA TRƯỚC (7/14/30 ngày tới) nên nó không nhận kỳ báo cáo —
          ô chọn kỳ vì thế được ẩn ở tab này thay vì hiện ra rồi không làm gì. */}
      {tab === "du-phong" ? <ForecastTab /> : null}
      {tab === "doi-chieu" ? <BridgeTab period={period} /> : null}
    </div>
  );
}

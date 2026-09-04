import Link from "next/link";
import { Megaphone, ReceiptText } from "lucide-react";
import { AdSpendDialog } from "@/app/(dashboard)/expenses/ad-spend-dialog";
import { AdsTab } from "@/app/(dashboard)/expenses/ads-tab";
import { ExpenseDialog } from "@/app/(dashboard)/expenses/expense-dialog";
import { ExpensesTab } from "@/app/(dashboard)/expenses/expenses-tab";
import { PageHeader } from "@/components/page-header";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { can, requireUser } from "@/lib/auth/session";
import { param, resolvePeriod, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Chi phí & quảng cáo" };

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  const user = await requireUser();
  const canWrite = can(user.role, "expenses:write");
  const tab = param(raw, "tab") === "ads" ? "ads" : "expenses";
  const period = resolvePeriod(raw, "month");
  const periodQuery = period.key === "month" ? "" : `&period=${period.key}${period.key === "custom" ? `&from=${period.fromKey}&to=${period.toKey}` : ""}`;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Kho & tài chính"
        title="Chi phí & quảng cáo"
        description={tab === "ads" ? "Chi tiêu quảng cáo theo ngày và nền tảng · ROAS, CPO và đơn từ quảng cáo" : "Chi phí vận hành ngoài Pancake: lương, mặt bằng, phần mềm, đóng gói, nhập hàng…"}
        actions={canWrite ? tab === "ads" ? <AdSpendDialog /> : <ExpenseDialog /> : null}
      />

      <Tabs value={tab}>
        <TabsList>
          <TabsTrigger value="expenses" asChild>
            <Link href={`/expenses?tab=expenses${periodQuery}`} className="px-3">
              <ReceiptText /> Chi phí vận hành
            </Link>
          </TabsTrigger>
          <TabsTrigger value="ads" asChild>
            <Link href={`/expenses?tab=ads${periodQuery}`} className="px-3">
              <Megaphone /> Quảng cáo
            </Link>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "ads" ? <AdsTab raw={raw} period={period} canWrite={canWrite} /> : <ExpensesTab raw={raw} period={period} canWrite={canWrite} />}
    </div>
  );
}

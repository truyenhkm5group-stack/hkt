import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui-bits";
import { PageHeader } from "@/components/page-header";
import { AiBalancePanel } from "@/components/billing/ai-balance-panel";
import { requirePermission } from "@/lib/auth/session";
import { loadAiBalanceView } from "@/lib/billing/ai-balance";

export const metadata = { title: "Số dư AI" };

/**
 * SỐ DƯ AI (docs/saas/AI_BALANCE_V1.md) — mã tổ chức lấy từ PHIÊN. Cờ `ai_balance.enabled` chưa bật cho tổ chức ⇒ một câu
 * «chưa mở cho cửa hàng của bạn» kèm lối về Gói (trang này nằm dưới mục «Gói dịch vụ» của vỏ, nên 404 ở đây đọc như lỗi quyền).
 */
export default async function AiBalancePage() {
  const user = await requirePermission("settings:manage");
  const orgCode = user.organization?.code;
  if (!orgCode) notFound();
  const view = await loadAiBalanceView(orgCode);
  if (!view.enabled) {
    // Cờ canary chưa bật cho cửa hàng này: nói ra một câu, không 404 — trang 404 của dashboard in «không có quyền xem» (sai).
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <PageHeader title="Số dư AI" refresh={false} />
        <EmptyState
          title="Số dư AI chưa mở cho cửa hàng của bạn"
          description="Khi được mở, bạn nạp tiền trả trước bằng mã QR để AI chăm khách vượt phần gói đã gồm. Hiện tại gói của cửa hàng vẫn hoạt động bình thường."
          action={
            <Button asChild variant="outline">
              <Link href="/settings/plan">Xem gói dịch vụ</Link>
            </Button>
          }
        />
      </div>
    );
  }
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <PageHeader title="Số dư AI" description="Tiền trả trước để AI chăm khách vượt phần gói đã gồm. Nạp bằng mã QR — tiền về là số dư tăng ngay." />
      <AiBalancePanel view={view} />
    </div>
  );
}

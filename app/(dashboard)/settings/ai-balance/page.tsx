import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { AiBalancePanel } from "@/components/billing/ai-balance-panel";
import { requirePermission } from "@/lib/auth/session";
import { loadAiBalanceView } from "@/lib/billing/ai-balance";

export const metadata = { title: "Số dư AI" };

/**
 * SỐ DƯ AI (docs/saas/AI_BALANCE_V1.md) — mã tổ chức lấy từ PHIÊN. Cờ `ai_balance.enabled` chưa bật cho tổ chức ⇒ 404:
 * không có trang «đang xây» nào cho khách thấy trong lúc canary.
 */
export default async function AiBalancePage() {
  const user = await requirePermission("settings:manage");
  const orgCode = user.organization?.code;
  if (!orgCode) notFound();
  const view = await loadAiBalanceView(orgCode);
  if (!view.enabled) notFound();
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <PageHeader title="Số dư AI" description="Tiền trả trước để AI chăm khách vượt phần gói đã gồm. Nạp bằng mã QR — tiền về là số dư tăng ngay." />
      <AiBalancePanel view={view} />
    </div>
  );
}

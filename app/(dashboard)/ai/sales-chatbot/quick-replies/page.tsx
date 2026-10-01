import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { can, requirePermission } from "@/lib/auth/session";
import { formatNumber, pctOrNull } from "@/lib/format";
import { listQuickReplies, loadQuickReplySettings, quickReplyStats } from "@/lib/sales-chatbot/quick-replies";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";
import { QuickRepliesManager } from "./quick-replies-manager";

export const metadata = { title: "Câu trả lời mẫu" };

/**
 * CÂU TRẢ LỜI MẪU (0183) — câu hỏi phổ biến của khách trả lời bằng câu soạn sẵn + ảnh, không tốn token AI. AI chỉ đọc hiểu
 * câu khó để chọn câu mẫu, hoặc trả lời khi không câu mẫu nào hợp. Giá / tồn / phí ship là chỗ trống, đọc ERP lúc gửi.
 */
export default async function QuickRepliesPage() {
  const user = await requirePermission("ai_sales:view");
  const manage = can(user, SALES_CHATBOT_MANAGE);
  const [rows, settings, stats] = await Promise.all([listQuickReplies(), loadQuickReplySettings(), quickReplyStats()]);
  const share = pctOrNull(stats.quickTurns, stats.totalTurns);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Câu trả lời mẫu"
        description={`30 ngày: ${formatNumber(stats.quickTurns)} / ${formatNumber(stats.totalTurns)} lượt fanpage + web trả lời bằng câu mẫu${share === null ? "" : ` (${share.toFixed(0)}%)`} · ${rows.filter((r) => r.active).length} câu đang bật`}
        actions={
          <Link href="/ai/sales-chatbot" className="text-sm underline underline-offset-2">
            ← Chatbot bán hàng
          </Link>
        }
      />
      <QuickRepliesManager
        manage={manage}
        settings={settings}
        rows={rows.map((r) => ({ ...r, lastUsedAt: r.lastUsedAt?.toISOString() ?? null, updatedAt: r.updatedAt.toISOString() }))}
      />
    </div>
  );
}

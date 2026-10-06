import Link from "next/link";
import { canUseModule } from "@/lib/platform/capabilities";
import { PRODUCT_LABEL } from "@/lib/saas/catalog";

/**
 * ERP `/chatbot` là CỬA VÀO, không phải nơi sở hữu miền AI bán hàng (docs/saas/OWNERSHIP.md): hội thoại, cấu hình AI, tri
 * thức, nhắn lại, phân tích hội thoại thuộc sản phẩm Chốt Đơn Tự Động. Workspace đã bật Chốt Đơn ⇒ đưa thẳng sang đó;
 * workspace còn chạy runtime cũ (bot Pancake trong container `erp-chatbot`) ⇒ nói rõ đây là runtime chuyển tiếp.
 * Module đọc theo ngữ cảnh phiên (máy chủ) — không tham số workspace nào từ trình duyệt.
 */
export async function ChatbotProductEntry() {
  const onChotDon = await canUseModule("ai_sales");
  return (
    <div className="rounded-xl border border-sky-300 bg-sky-50 px-4 py-3 text-sm dark:border-sky-800 dark:bg-sky-950">
      <p>
        <b>Chatbot thuộc sản phẩm {PRODUCT_LABEL.chotdon}.</b> Hội thoại, cấu hình AI, tri thức và báo cáo hội thoại do {PRODUCT_LABEL.chotdon} làm nguồn sự thật; ERP giữ sản phẩm, giá, tồn kho và đơn — bot hỏi ERP qua lõi thương mại.
      </p>
      {onChotDon ? (
        <div className="mt-2 flex flex-wrap gap-3">
          <Link href="/ai/sales-chatbot/inbox" className="font-medium text-primary hover:underline">
            Mở hộp thư {PRODUCT_LABEL.chotdon} →
          </Link>
          <Link href="/ai/sales-chatbot" className="font-medium text-primary hover:underline">
            Cấu hình AI bán hàng →
          </Link>
        </div>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">Workspace này đang chạy runtime CŨ (bot Pancake trong container) trong lúc chuyển sang {PRODUCT_LABEL.chotdon}. Chuyển từng page một, chạy bóng trước — kế hoạch và điều kiện ở docs/saas/OWNERSHIP.md.</p>
      )}
    </div>
  );
}

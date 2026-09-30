import { SalesChatPanel } from "@/components/sales-chat/chat-panel";
import { HOST_NOT_FOUND_MESSAGE } from "@/lib/platform/host-org";
import { publicChatPage } from "@/lib/sales-chatbot/public";

export const dynamic = "force-dynamic";
export const metadata = { title: "Chat với shop" };

/**
 * TRANG CHAT CÔNG KHAI (0180) — `https://<slug>.<miền gốc>/chat`. Không cần đăng nhập. Tổ chức lấy từ HOST (chỉ tổ chức
 * ĐÃ XUẤT BẢN), mọi lượt đọc trong ngữ cảnh tường minh của nó (`lib/sales-chatbot/public.ts`) — miền chính / tên miền lạ /
 * bot tắt ⇒ "không có", không bao giờ rơi về tổ chức nhà.
 */
export default async function PublicChatPage() {
  const { org, botName } = await publicChatPage();
  if (!org || !botName) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md space-y-2 text-center">
          <h1 className="text-xl font-semibold">Chưa mở chat</h1>
          <p className="text-sm text-muted-foreground">{org ? "Shop chưa bật chatbot bán hàng." : HOST_NOT_FOUND_MESSAGE}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="mx-auto flex min-h-screen max-w-xl flex-col gap-3 p-4">
      <header>
        <h1 className="text-lg font-semibold">{org.name}</h1>
        <p className="text-xs text-muted-foreground">Chat với {botName} — hỏi giá, tồn và đặt hàng. Giá và tồn đọc trực tiếp từ hệ thống của shop.</p>
      </header>
      <SalesChatPanel mode="public" title={botName} />
    </div>
  );
}

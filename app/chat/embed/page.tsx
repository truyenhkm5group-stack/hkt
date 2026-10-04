import { SalesChatPanel } from "@/components/sales-chat/chat-panel";
import { HOST_NOT_FOUND_MESSAGE } from "@/lib/platform/host-org";
import { publicChatPage } from "@/lib/sales-chatbot/public";

export const dynamic = "force-dynamic";
export const metadata = { title: "Chat với shop", robots: { index: false, follow: false } };

/**
 * KHUNG CHAT NHÚNG (`/chat/embed`) — trang mà `widget.js` mở trong iframe trên website của shop (lib/sales-chatbot/widget.ts).
 * Cùng lõi với trang `/chat` (tổ chức từ HOST, chỉ tổ chức ĐÃ XUẤT BẢN, bot bật), chỉ khác bố cục: phủ kín khung, không đầu
 * trang. Đường này được phép nằm trong khung của trang khác (deploy/Caddyfile — `frame-ancestors *` chỉ cho đúng đường này).
 */
export default async function EmbeddedChatPage() {
  const { org, botName } = await publicChatPage();
  if (!org || !botName) {
    return (
      <div className="flex h-dvh items-center justify-center p-6">
        <p className="text-center text-sm text-muted-foreground">{org ? "Shop chưa bật chatbot bán hàng." : HOST_NOT_FOUND_MESSAGE}</p>
      </div>
    );
  }
  return (
    <div className="h-dvh bg-background">
      <SalesChatPanel mode="public" title={`${botName} · ${org.name}`} className="h-dvh rounded-none border-0" />
    </div>
  );
}

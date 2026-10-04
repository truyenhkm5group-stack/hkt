import { publicChatPage } from "@/lib/sales-chatbot/public";
import { widgetDisabledScript, widgetScript } from "@/lib/sales-chatbot/widget";

export const dynamic = "force-dynamic";

/**
 * `https://<slug>.<miền ERP>/chat/widget.js` — script shop dán vào website (lib/sales-chatbot/widget.ts). Công khai như trang
 * `/chat`: tổ chức lấy từ HOST, chỉ tổ chức ĐÃ XUẤT BẢN có bot đang bật mới nhận script vẽ nút; còn lại ⇒ script rỗng (không
 * lỗi trên website của shop). Không đọc / trả dữ liệu nào của tổ chức.
 */
export async function GET() {
  const { org, botName } = await publicChatPage();
  const body = org && botName ? widgetScript() : widgetDisabledScript(org ? "shop chưa bật chatbot" : "không có cửa hàng ở địa chỉ này");
  return new Response(body, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      // Ngắn: shop vừa bật / tắt bot thì website đổi theo trong vài phút.
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}

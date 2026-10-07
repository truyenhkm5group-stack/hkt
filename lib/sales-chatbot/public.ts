/**
 * ═══════════ LÕI TRANG CHAT CÔNG KHAI (0180) — CHỈ MÁY CHỦ ═══════════
 *
 * Tổ chức lấy từ HOST (`<slug>.<miền gốc>` → CHỈ tổ chức đã xuất bản, `hostOrganization`), không bao giờ từ client; mọi
 * lượt đọc / ghi chạy trong `withOrganization(mã đó)` TƯỜNG MINH — request không phiên mặc định là tổ chức NHÀ
 * (lib/platform/context.ts), thiếu bước này là để khách lạ nói chuyện với dữ liệu của nhà. Miền chính / tên miền lạ / module
 * tắt / bot tắt ⇒ "không có". Server action (`lib/actions/public-chat.ts`) chỉ lo cookie khách truy cập rồi gọi vào đây.
 */
import { canUseModule } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { HOST_NOT_FOUND_MESSAGE, hostOrganization } from "@/lib/platform/host-org";
import { noteAiCustomerReply } from "@/lib/pricing/ai-customer";
import type { ChatView } from "@/lib/sales-chatbot/config";
import { chatTurn, conversationView, loadSalesChatbotConfig, openConversation } from "@/lib/sales-chatbot/engine";

async function inHostOrg<T>(fn: (orgName: string) => Promise<T | { error: string }>): Promise<T | { error: string }> {
  const host = await hostOrganization();
  if (!host.slug || !host.org) return { error: HOST_NOT_FOUND_MESSAGE };
  const org = host.org;
  return withOrganization(org.code, async () => {
    if (!(await canUseModule("ai_sales"))) return { error: "Shop chưa mở chat." };
    const cfg = await loadSalesChatbotConfig();
    if (!cfg.enabled) return { error: "Shop chưa mở chat." };
    return fn(org.name);
  });
}

export type PublicChatOpened = { ok: true; shopName: string; botName: string; view: ChatView } | { error: string };

export async function startPublicChat(visitorKey: string | null): Promise<PublicChatOpened> {
  return inHostOrg<{ ok: true; shopName: string; botName: string; view: ChatView }>(async (shopName) => {
    const conv = await openConversation("WEB", { visitorKey });
    const view = await conversationView(conv.id);
    return view ? { ok: true, shopName, botName: conv.botName, view } : { error: "Không mở được hội thoại." };
  });
}

export async function sendPublicChat(visitorKey: string, conversationId: string, text: string): Promise<{ ok: true; view: ChatView } | { error: string; view?: ChatView | null }> {
  return inHostOrg<{ ok: true; view: ChatView }>(async () => {
    const r = await chatTurn(conversationId, text, { channel: "WEB", visitorKey });
    // Đồng hồ khách AI (L5): câu DO MODEL SINH trả về trình duyệt của khách = đã gửi thành công (kênh web không có bước gửi
    // riêng). Câu mẫu / im lặng ⇒ không đếm. Lỗi ghi sổ bị nuốt trong `noteAiCustomerReply`.
    if (r.ok && (r.aiTexts?.length ?? 0) > 0) await noteAiCustomerReply(conversationId, new Date());
    return r.ok ? { ok: true as const, view: r.view } : { error: r.error, view: r.view ?? null };
  });
}

/** Trang `/chat`: tổ chức của host + bot có đang mở không (để dựng trang, không mở hội thoại). */
export async function publicChatPage(): Promise<{ org: { name: string } | null; botName: string | null }> {
  const host = await hostOrganization();
  if (!host.org) return { org: null, botName: null };
  const org = host.org;
  const botName = await withOrganization(org.code, async () => {
    if (!(await canUseModule("ai_sales"))) return null;
    const cfg = await loadSalesChatbotConfig();
    return cfg.enabled ? cfg.botName : null;
  });
  return { org: { name: org.name }, botName };
}

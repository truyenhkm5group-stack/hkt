/**
 * ═══════════ LÕI TRANG CHAT CÔNG KHAI (0180) — CHỈ MÁY CHỦ ═══════════
 *
 * Tổ chức lấy từ HOST (`<slug>.<miền gốc>` → CHỈ tổ chức đã xuất bản, `hostOrganization`), không bao giờ từ client; mọi
 * lượt đọc / ghi chạy trong `withOrganization(mã đó)` TƯỜNG MINH — request không phiên mặc định là tổ chức NHÀ
 * (lib/platform/context.ts), thiếu bước này là để khách lạ nói chuyện với dữ liệu của nhà. Miền chính / tên miền lạ / module
 * tắt / bot tắt ⇒ "không có". Server action (`lib/actions/public-chat.ts`) chỉ lo cookie khách truy cập + IP rồi gọi vào đây.
 *
 * TRẦN TẦN SUẤT (`lib/sales-chatbot/public-chat-limits.ts`): mở hội thoại và gửi tin đi qua cổng theo khách · IP · tổ chức NGAY
 * SAU khi biết tổ chức của host, TRƯỚC mọi lượt đọc / ghi của tổ chức — lượt bị chặn không gọi AI, không ghi tin, không tạo hội
 * thoại. Đọc lại hội thoại (`refreshPublicChat`, khung chat tự làm mới) không qua cổng: chỉ đọc, không AI, không ghi.
 */
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { canUseModule } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { HOST_NOT_FOUND_MESSAGE, hostOrganization } from "@/lib/platform/host-org";
import { noteAiCustomerReply } from "@/lib/pricing/ai-customer";
import type { ChatView } from "@/lib/sales-chatbot/config";
import { chatTurn, conversationView, loadSalesChatbotConfig, openConversation, TURN_NO_CONVERSATION_ERROR } from "@/lib/sales-chatbot/engine";
import { publicChatGate, type PublicChatGateInput } from "@/lib/sales-chatbot/public-chat-limits";

/** Thông tin của request mà chỉ server action đọc được: IP do Caddy ghi (`clientIpFrom`), không bao giờ phần client tự khai. */
export type PublicChatRequest = { ip?: string | null };

async function inHostOrg<T>(fn: (orgName: string) => Promise<T | { error: string }>, gate?: Omit<PublicChatGateInput, "orgCode">): Promise<T | { error: string }> {
  const host = await hostOrganization();
  if (!host.slug || !host.org) return { error: HOST_NOT_FOUND_MESSAGE };
  const org = host.org;
  if (gate) {
    const g = publicChatGate({ ...gate, orgCode: org.code });
    if (!g.ok) return { error: g.error };
  }
  return withOrganization(org.code, async () => {
    if (!(await canUseModule("ai_sales"))) return { error: "Shop chưa mở chat." };
    const cfg = await loadSalesChatbotConfig();
    if (!cfg.enabled) return { error: "Shop chưa mở chat." };
    return fn(org.name);
  });
}

export type PublicChatOpened = { ok: true; shopName: string; botName: string; view: ChatView } | { error: string };

/**
 * Bản xem cho trình duyệt CÔNG KHAI: bỏ vết công cụ (`tools` — tóm tắt nội bộ như «Khách cũ (SĐT có trong sổ)», giá theo bảng
 * riêng). Ô chat công khai không hiện chúng, nhưng gửi qua mạng là ai mở công cụ trình duyệt cũng đọc được (review bảo mật).
 */
export function publicView(v: ChatView): ChatView {
  return { ...v, messages: v.messages.map((m) => ({ role: m.role, text: m.text })) };
}

export async function startPublicChat(visitorKey: string | null, req: PublicChatRequest = {}): Promise<PublicChatOpened> {
  return inHostOrg<{ ok: true; shopName: string; botName: string; view: ChatView }>(
    async (shopName) => {
      const conv = await openConversation("WEB", { visitorKey });
      const view = await conversationView(conv.id);
      return view ? { ok: true, shopName, botName: conv.botName, view: publicView(view) } : { error: "Không mở được hội thoại." };
    },
    { action: "start", visitorKey, ip: req.ip },
  );
}

export async function sendPublicChat(visitorKey: string, conversationId: string, text: string, req: PublicChatRequest = {}): Promise<{ ok: true; view: ChatView } | { error: string; view?: ChatView | null }> {
  return inHostOrg<{ ok: true; view: ChatView }>(
    async () => {
      const r = await chatTurn(conversationId, text, { channel: "WEB", visitorKey });
      // Đồng hồ khách AI (L5): câu DO MODEL SINH trả về trình duyệt của khách = đã gửi thành công (kênh web không có bước gửi
      // riêng). Câu mẫu / im lặng ⇒ không đếm. Lỗi ghi sổ bị nuốt trong `noteAiCustomerReply`.
      if (r.ok && (r.aiTexts?.length ?? 0) > 0) await noteAiCustomerReply(conversationId, new Date());
      return r.ok ? { ok: true as const, view: publicView(r.view) } : { error: r.error, view: r.view ? publicView(r.view) : null };
    },
    { action: "send", visitorKey, ip: req.ip },
  );
}

/**
 * Khung chat công khai tự ĐỌC LẠI hội thoại đang mở mỗi 15 giây (để thấy tin nhân viên trả lời từ hộp thư ERP). CHỈ ĐỌC: không
 * mở hội thoại, không gọi AI, không ghi. Hội thoại phải là kênh WEB và đúng khách truy cập đã mở nó (băm cookie) — đoán được id
 * cũng không đọc được hội thoại của người khác. Trước bản này khung chat gọi `startPublicChat` để "đọc lại": mỗi 15 giây một hội
 * thoại + một tin chào MỚI trong CSDL của shop cho mỗi tab đang mở, và tin nhân viên không bao giờ hiện ra (id luôn khác).
 */
export async function refreshPublicChat(visitorKey: string, conversationId: string): Promise<{ ok: true; view: ChatView } | { error: string }> {
  return inHostOrg<{ ok: true; view: ChatView }>(async () => {
    const c = schema.salesChatConversations;
    const [row] = await (await getDb()).select({ channel: c.channel, visitorKey: c.visitorKey }).from(c).where(eq(c.id, conversationId)).limit(1);
    if (!row || row.channel !== "WEB" || row.visitorKey !== visitorKey) return { error: TURN_NO_CONVERSATION_ERROR };
    const view = await conversationView(conversationId);
    return view ? { ok: true as const, view: publicView(view) } : { error: TURN_NO_CONVERSATION_ERROR };
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

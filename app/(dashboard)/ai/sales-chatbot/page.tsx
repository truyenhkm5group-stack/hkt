import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { SalesChatPanel } from "@/components/sales-chat/chat-panel";
import { SectionCard } from "@/components/ui-bits";
import { connectionStatusRows } from "@/lib/connectors/service";
import { can, requirePermission } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { publicationOf } from "@/lib/platform/publish";
import { productCustomFieldOptions } from "@/lib/sales-chatbot/catalog";
import { SALES_BOT_CONNECTORS } from "@/lib/sales-chatbot/config";
import { listConversations, loadSalesChatbotConfig } from "@/lib/sales-chatbot/engine";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";
import { ChatbotConfigForm } from "./config-form";

export const metadata = { title: "Chatbot bán hàng" };

const STATUS_LABEL: Record<string, string> = { OPEN: "Đang chat", HANDOFF: "Chuyển nhân viên", CLOSED: "Đã đóng" };

/**
 * CHATBOT BÁN HÀNG (0180) — AI → Sales Chatbot. Cấu hình (khoá AI BYOK của chính tổ chức, giọng, giờ làm việc, chuyển
 * người, chốt đơn, công cụ được dùng), KHUNG THỬ (lượt ghi mô phỏng) và danh sách hội thoại. Trang chat công khai chạy ở
 * `/chat` trên tên miền con khi ERP đã xuất bản và bot đang bật.
 */
export default async function SalesChatbotPage() {
  const user = await requirePermission("ai_sales:view");
  const manage = can(user, SALES_CHATBOT_MANAGE);
  const [cfg, fields, conversations, connections, pub] = await Promise.all([
    loadSalesChatbotConfig(),
    productCustomFieldOptions(),
    listConversations(30),
    connectionStatusRows(),
    publicationOf(user.organization?.code ?? ""),
  ]);
  const aiConnections = SALES_BOT_CONNECTORS.map((k) => {
    const row = connections.find((c) => c.connectorKey === k);
    return { key: k, ready: Boolean(row && row.status === "ACTIVE" && row.lastTestOk === true), configured: Boolean(row) };
  });
  const publicUrl = pub.state === "PUBLISHED" && pub.url ? `${pub.url}/chat` : null;
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="AI"
        title="Chatbot bán hàng"
        description={user.organization?.name}
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>Bot trả lời khách của shop: tìm sản phẩm, báo giá và tồn ĐỌC TỪ ERP ngay lúc hỏi (không nằm trong lời nhắc), tính tiền giỏ, lên đơn nháp, đọc lại tóm tắt và CHỈ chốt khi khách xác nhận. Đơn chốt ⇒ giữ hàng ở kho + báo nhóm vận hành (nếu đã cấu hình Thông báo nhóm).</p>
            <p>Khoá AI là của CHÍNH tổ chức (Cài đặt → Kết nối → Anthropic / OpenAI) — tổ chức trả tiền token. Khung thử bên phải dùng giá / tồn thật nhưng KHÔNG tạo khách, đơn hay tin nhóm thật.</p>
          </div>
        }
      />
      <div className="grid gap-5 xl:grid-cols-[1fr_440px]">
        <div className="space-y-5">
          {manage ? (
            <ChatbotConfigForm config={cfg} fields={fields} connections={aiConnections} />
          ) : (
            <SectionCard title="Cấu hình">
              <p className="text-sm text-muted-foreground">Bạn xem được hội thoại; cấu hình bot cần quyền «AI bán hàng: cấu hình & xuất bản chatbot».</p>
            </SectionCard>
          )}
          <SectionCard title="Trang chat công khai">
            {publicUrl ? (
              <p className="text-sm">
                Khách chat tại{" "}
                <a href={publicUrl} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2" data-testid="public-chat-url">
                  {publicUrl.replace(/^https?:\/\//, "")}
                </a>
                {cfg.enabled ? "" : " — bot đang TẮT: trang báo «chưa mở chat»."}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Trang chat công khai có sau khi ERP được xuất bản với tên miền con — <Link href="/setup" className="underline underline-offset-2">Thiết lập & xuất bản</Link>.
              </p>
            )}
          </SectionCard>
          <SectionCard title="Hội thoại gần đây">
            {conversations.length === 0 ? (
              <p className="text-sm text-muted-foreground">Chưa có hội thoại nào.</p>
            ) : (
              <ul className="divide-y text-sm" data-testid="conversation-list">
                {conversations.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-channel={c.channel} data-status={c.status}>
                    <span>
                      {c.channel === "WEB" ? "Khách web" : "Khung thử"} · {STATUS_LABEL[c.status] ?? c.status} · {c.turns} lượt
                      {c.handoffReason ? ` · ${c.handoffReason}` : ""}
                    </span>
                    <span className="flex items-center gap-3 text-xs text-muted-foreground">
                      {c.orderId ? (
                        <Link href={`/orders/${encodeURIComponent(c.orderId)}`} className="underline underline-offset-2">
                          Đơn đã chốt
                        </Link>
                      ) : c.draftOrderId ? (
                        <Link href={`/orders/${encodeURIComponent(c.draftOrderId)}`} className="underline underline-offset-2">
                          Đơn nháp
                        </Link>
                      ) : null}
                      {c.lastError ? <span className="text-destructive">Lỗi: {c.lastError.slice(0, 80)}</span> : null}
                      {formatDateTime(c.updatedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
        {manage ? (
          <div className="space-y-2">
            <p className="text-sm font-semibold">Khung thử (TEST)</p>
            <SalesChatPanel mode="test" title={`${cfg.botName} · thử`} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

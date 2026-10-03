import Link from "next/link";
import { moduleOn } from "@/lib/platform-ui/module-visibility";
import { PageHeader } from "@/components/page-header";
import { SalesChatPanel } from "@/components/sales-chat/chat-panel";
import { SectionCard } from "@/components/ui-bits";
import { connectionStatusRows } from "@/lib/connectors/service";
import { can, requirePermission } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { publicationOf } from "@/lib/platform/publish";
import { productCustomFieldOptions } from "@/lib/sales-chatbot/catalog";
import { CHAT_CHANNEL_LABEL, SALES_BOT_CONNECTORS, salesBotError, type ChatChannel } from "@/lib/sales-chatbot/config";
import { platformChatAi } from "@/lib/ai-builder/provider";
import { fanpageSetupView } from "@/lib/sales-chatbot/fanpage";
import { loadPlaybook, loadPlaybookRun } from "@/lib/sales-chatbot/playbook";
import { loadLessons } from "@/lib/sales-chatbot/lessons";
import { listConversations, loadSalesChatbotConfig } from "@/lib/sales-chatbot/engine";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";
import { ChatbotConfigForm } from "./config-form";
import { PlaybookPanel } from "./playbook-panel";
import { LessonsPanel } from "./lessons-panel";
import { FollowupPanel } from "./followup-panel";
import { OrderSyncPanel } from "./order-sync-panel";
import { orderSyncView } from "@/lib/sales-chatbot/order-sync";
import { loadFollowupSettings } from "@/lib/sales-chatbot/followup-settings";
import { countWaitingConversations } from "@/lib/sales-chatbot/engine";
import { ResumeToAiButton } from "./resume-button";
import { ChatCostPanel } from "./cost-panel";
import { loadChatCostReport } from "@/lib/sales-chatbot/cost-report";
import { SALES_STAGE_LABEL, type SalesStage } from "@/lib/sales-chatbot/stages";

export const metadata = { title: "Chatbot bán hàng" };

const STATUS_LABEL: Record<string, string> = { OPEN: "Đang chat", WAITING: "Chờ khách (follow-up)", HANDOFF: "Cần người xử lý", CLOSED: "Đã đóng" };

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
  const fanpage = manage && user.organization?.code ? await fanpageSetupView(user.organization.code) : null;
  const [playbook, playbookRun, lessons] = manage ? await Promise.all([loadPlaybook(), loadPlaybookRun(), loadLessons()]) : [null, null, null];
  // Chi phí AI theo ngày — tiền là vùng nhạy cảm, chỉ người cấu hình bot thấy. Sổ AI ở CSDL nhà hỏng ⇒ ẩn bảng, không sập trang.
  const costReport = manage && user.organization?.code ? await loadChatCostReport(user.organization.code).catch(() => null) : null;
  const [followup, waitingCount] = fanpage ? await Promise.all([loadFollowupSettings(), countWaitingConversations()]) : [null, 0];
  const orderSync = fanpage ? await orderSyncView() : null;
  // «AI dùng chung của nền tảng» (0193) không phải một kết nối của tổ chức: sẵn sàng = nền tảng bật + gói có credit + còn credit.
  const platformAi = user.organization?.code ? await platformChatAi(user.organization.code) : { ok: false as const, reason: "Không xác định được tổ chức." };
  const aiConnections = SALES_BOT_CONNECTORS.map((k) => {
    if (k === "platform") return { key: k, ready: platformAi.ok, configured: platformAi.ok, reason: platformAi.ok ? null : platformAi.reason };
    const row = connections.find((c) => c.connectorKey === k);
    return { key: k, ready: Boolean(row && row.status === "ACTIVE" && row.lastTestOk === true), configured: Boolean(row), reason: null };
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
        actions={
          <Link href="/ai/sales-chatbot/quick-replies" className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted" data-testid="quick-replies-link">
            Câu trả lời mẫu (Q&amp;A)
          </Link>
        }
      />
      <div className="grid gap-5 xl:grid-cols-[1fr_440px]">
        <div className="space-y-5">
          {orderSync ? <OrderSyncPanel view={orderSync} manage={manage} /> : null}
          {fanpage ? (
            <SectionCard title="Fanpage (qua Pancake)" description="Bot trả lời tin nhắn khách gửi vào fanpage của shop — cùng cấu hình, cùng giá / tồn, cùng luật chốt đơn với trang chat web.">
              <div className="space-y-2 text-sm" data-testid="fanpage-setup">
                <p>
                  Trạng thái:{" "}
                  <b data-testid="fanpage-status">{{ NOT_CONFIGURED: "CHƯA KHAI", DRAFT: "CHƯA BẬT", ACTIVE: "ĐANG BẬT", FAILED: "KIỂM TRA HỎNG" }[fanpage.status]}</b>
                  {fanpage.pageId ? ` · page ${fanpage.pageId}` : ""} · bot đã trả lời {fanpage.counts.done} tin · chờ {fanpage.counts.pending} · bỏ qua {fanpage.counts.skipped}
                </p>
                {fanpage.counts.skippedReasons.length ? (
                  <p className="text-xs text-muted-foreground" data-testid="fanpage-skip-reasons">
                    Lý do bỏ qua: {fanpage.counts.skippedReasons.map((r) => `${r.reason} (${r.count})`).join(" · ")}
                  </p>
                ) : null}
                <ol className="list-decimal space-y-1 pl-5 text-xs leading-5 text-muted-foreground">
                  <li>
                    <Link href="/settings/connections" className="underline underline-offset-2">Cài đặt → Kết nối</Link> → «Fanpage qua Pancake»: nhập Page ID và page access token (Pancake → Cài đặt page → Công cụ) → Lưu → Kiểm tra → Bật.
                  </li>
                  <li>Trong Pancake: Cài đặt page → Webhook → bật sự kiện tin nhắn (messaging) → dán URL dưới đây.</li>
                  <li>Bật bot ở khung Cấu hình bên dưới. Bot trả lời sau khoảng 5 giây (tin đầu của hội thoại mới: tối đa 10 giây để nhường trả lời tự động của Meta); page đã trả lời thì bot không chen; nhân viên trả lời trên fanpage ⇒ bot nhường hội thoại đó 30 phút.</li>
                </ol>
                {fanpage.webhookUrl ? (
                  <div className="space-y-1">
                    <p className="text-xs font-medium">URL webhook của shop (giữ kín — ai có URL này gửi được tin giả vào bot):</p>
                    <code className="block break-all rounded-md bg-muted px-2 py-1.5 text-[11px]" data-testid="fanpage-webhook-url">{fanpage.webhookUrl}</code>
                  </div>
                ) : (
                  <p className="text-xs text-amber-700 dark:text-amber-400">Máy chủ chưa có khoá bí mật nền tảng — chưa dựng được URL webhook. Báo người vận hành nền tảng.</p>
                )}
              </div>
            </SectionCard>
          ) : null}
          {costReport ? <ChatCostPanel report={costReport} /> : null}
          {followup ? <FollowupPanel settings={followup} waiting={waitingCount} manage={manage} /> : null}
          {lessons ? <LessonsPanel key={`${lessons.version}-${lessons.updatedAt ?? ""}`} state={lessons} /> : null}
          {playbook && playbookRun ? <PlaybookPanel key={playbook.draft?.createdAt ?? "chua-co-nhap"} state={playbook} run={playbookRun} fanpageReady={fanpage?.status === "ACTIVE"} /> : null}
          {manage ? (
            <ChatbotConfigForm config={cfg} fields={fields} connections={aiConnections} appointmentsOn={moduleOn(user, "appointments")} />
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
                      {CHAT_CHANNEL_LABEL[c.channel as ChatChannel] ?? c.channel} · <b className={c.status === "HANDOFF" ? "text-destructive" : undefined}>{STATUS_LABEL[c.status] ?? c.status}</b> · {c.turns} lượt
                      {c.stage && c.stage in SALES_STAGE_LABEL ? ` · ${SALES_STAGE_LABEL[c.stage as SalesStage]}` : ""}
                      {c.handoffReason ? ` · ${c.handoffReason}` : ""}
                    </span>
                    <span className="flex items-center gap-3 text-xs text-muted-foreground">
                      {manage && c.status === "HANDOFF" ? <ResumeToAiButton id={c.id} /> : null}
                      {c.orderId ? (
                        <Link href={`/orders/${encodeURIComponent(c.orderId)}`} className="underline underline-offset-2">
                          Đơn đã chốt
                        </Link>
                      ) : c.draftOrderId ? (
                        <Link href={`/orders/${encodeURIComponent(c.draftOrderId)}`} className="underline underline-offset-2">
                          Đơn nháp
                        </Link>
                      ) : null}
                      {c.lastError ? (
                        <span className="text-destructive">
                          Lỗi: {salesBotError(c.lastError)?.label}
                        </span>
                      ) : null}
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

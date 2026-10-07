import Link from "next/link";
import { EmbedSnippet } from "@/components/sales-chat/embed-snippet";
import { widgetSnippet } from "@/lib/sales-chatbot/widget";
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
import { zaloSetupView } from "@/lib/sales-chatbot/zalo";
import { loadInboxHistoryView } from "@/lib/sales-chatbot/history";
import { loadPlaybook, loadPlaybookRun } from "@/lib/sales-chatbot/playbook";
import { loadLessons } from "@/lib/sales-chatbot/lessons";
import { listConversations, loadSalesChatbotConfig } from "@/lib/sales-chatbot/engine";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";
import { ChatbotConfigForm } from "./config-form";
import { loadProviderHealth } from "@/lib/sales-chatbot/provider-failover";
import { InboxHistoryPanel } from "./history-panel";
import { MessengerHistoryPanel } from "./messenger-history-panel";
import { loadMessengerHistoryView } from "@/lib/sales-chatbot/messenger-history";
import { PlaybookPanel } from "./playbook-panel";
import { LessonsPanel } from "./lessons-panel";
import { LevelScriptsPanel } from "./level-scripts-panel";
import { levelCounts, loadLevelScripts, organizationLevelPack } from "@/lib/sales-chatbot/levels";
import { levelsForPack } from "@/lib/sales-chatbot/levels-shared";
import { FollowupPanel } from "./followup-panel";
import { OrderSyncPanel } from "./order-sync-panel";
import { orderSyncView } from "@/lib/sales-chatbot/order-sync";
import { loadFollowupSettings } from "@/lib/sales-chatbot/followup-settings";
import { countWaitingConversations } from "@/lib/sales-chatbot/engine";
import { ResumeToAiButton } from "./resume-button";
import { ModePanel } from "./mode-panel";
import { loadModeConfig } from "@/lib/sales-chatbot/operating-mode";
import { ChatCostPanel } from "./cost-panel";
import { loadChatCostReport } from "@/lib/sales-chatbot/cost-report";
import { SALES_STAGE_LABEL, type SalesStage } from "@/lib/sales-chatbot/stages";
import { loadReadiness } from "@/lib/sales-chatbot/readiness";
import { READINESS_VERDICT_LABEL } from "@/lib/sales-chatbot/readiness-shared";
import { PageRuntimePanel } from "./page-runtime-panel";
import { pageRuntimeView } from "@/lib/sales-chatbot/page-runtime";

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
  const zalo = manage && user.organization?.code ? await zaloSetupView(user.organization.code) : null;
  const providerHealth = manage ? Object.entries(await loadProviderHealth()).map(([key, h]) => ({ key, lastSuccessAt: h.lastSuccessAt, lastFailureAt: h.lastFailureAt, lastErrorClass: h.lastErrorClass, openUntil: h.openUntil })) : [];
  const [playbook, playbookRun, lessons] = manage ? await Promise.all([loadPlaybook(), loadPlaybookRun(), loadLessons()]) : [null, null, null];
  const [levelScripts, levelPack, levelCountMap] = manage ? await Promise.all([loadLevelScripts(), organizationLevelPack(), levelCounts()]) : [null, null, null];
  // Chi phí AI theo ngày — tiền là vùng nhạy cảm, chỉ người cấu hình bot thấy. Sổ AI ở CSDL nhà hỏng ⇒ ẩn bảng, không sập trang.
  const costReport = manage && user.organization?.code ? await loadChatCostReport(user.organization.code).catch(() => null) : null;
  const [followup, waitingCount] = fanpage ? await Promise.all([loadFollowupSettings(), countWaitingConversations()]) : [null, 0];
  const orderSync = fanpage ? await orderSyncView() : null;
  // Đồng bộ lịch sử hộp thư — chỉ khi tổ chức có khối Fanpage (qua Pancake) và người xem quản lý được chatbot.
  const inboxHistory = fanpage ? await loadInboxHistoryView(user) : null;
  // Hội thoại gần đây của page nối THẲNG Meta — chỉ khi có page trực tiếp và người xem quản lý được chatbot.
  const messengerHistory = await loadMessengerHistoryView(user);
  const modeConfig = fanpage ? await loadModeConfig() : null;
  // Workspace NHÀ: bot Chốt Đơn chỉ chạm page có trong danh sách (Tắt / Bóng / Chạy thật) — page-runtime.ts. Khách: không có khối này.
  const pageRuntime = user.organization?.isHome ? await pageRuntimeView().catch(() => null) : null;
  // «AI dùng chung của nền tảng» (0193) không phải một kết nối của tổ chức: sẵn sàng = nền tảng bật + gói có credit + còn credit.
  const platformAi = user.organization?.code ? await platformChatAi(user.organization.code) : { ok: false as const, reason: "Không xác định được tổ chức." };
  const aiConnections = SALES_BOT_CONNECTORS.map((k) => {
    // `vendor` = nhà cung cấp AI thật sau khoá (AI dùng chung: theo khoá nền tảng) — để form cảnh báo khoá dự phòng CÙNG nhà.
    if (k === "platform") return { key: k, ready: platformAi.ok, configured: platformAi.ok, reason: platformAi.ok ? null : platformAi.reason, vendor: platformAi.ok ? platformAi.provider.name.split("-")[0] : null };
    const row = connections.find((c) => c.connectorKey === k);
    return { key: k, ready: Boolean(row && row.status === "ACTIVE" && row.lastTestOk === true), configured: Boolean(row), reason: null, vendor: k.split("-")[0] };
  });
  const publicUrl = pub.state === "PUBLISHED" && pub.url ? `${pub.url}/chat` : null;
  // Sẵn sàng tự trả lời (P8): chỉ đếm số thật; THÔNG TIN, không chặn đổi chế độ.
  const selectedAi = aiConnections.find((a) => a.key === cfg.connectorKey);
  const readiness = manage ? await loadReadiness(cfg, { ready: Boolean(selectedAi?.ready), reason: selectedAi?.reason ?? null }) : null;
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
          <>
            <Link href="/ai/sales-chatbot/performance" className="mr-2 inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted" data-testid="ai-perf-link">
              Hiệu quả
            </Link>
            <Link href="/ai/sales-chatbot/replay" className="mr-2 inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted" data-testid="replay-link">
              Phát lại hội thoại cũ
            </Link>
            <Link href="/ai/sales-chatbot/quick-replies" className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted" data-testid="quick-replies-link">
              Câu trả lời mẫu (Q&amp;A)
            </Link>
          </>
        }
      />
      <div className="grid gap-5 xl:grid-cols-[1fr_440px]">
        <div className="space-y-5">
          {orderSync ? <OrderSyncPanel view={orderSync} manage={manage} /> : null}
          {readiness ? (
            <SectionCard
              title={`AI đã sẵn sàng tự trả lời khách? — ${READINESS_VERDICT_LABEL[readiness.verdict]}`}
              description="Đọc từ dữ liệu thật của shop. Đây là bảng kiểm, không chặn bạn đổi chế độ."
            >
              <ul className="space-y-1.5 text-sm" data-testid="ai-readiness" data-verdict={readiness.verdict}>
                {readiness.checks.map((c) => (
                  <li key={c.key} className="flex items-start gap-2">
                    <span className={`mt-0.5 shrink-0 rounded px-1.5 text-[11px] font-semibold ${c.status === "PASS" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" : c.status === "WARN" ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200" : "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200"}`}>
                      {c.status === "PASS" ? "Đạt" : c.status === "WARN" ? "Lưu ý" : "Hỏng"}
                    </span>
                    <span className="min-w-0">
                      {c.href ? (
                        <Link href={c.href} className="font-medium hover:underline">
                          {c.label}
                        </Link>
                      ) : (
                        <span className="font-medium">{c.label}</span>
                      )}
                      <span className="block text-xs text-muted-foreground">{c.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}
          {pageRuntime?.isHome ? (
            <SectionCard id="page-runtime" title="Bot Chốt Đơn theo page (workspace nhà)" description="Mặc định mọi page TẮT. Bóng = bot soạn câu để so, không gửi. Chạy thật là quyết định của chủ shop.">
              <PageRuntimePanel pages={pageRuntime.pages} manage={manage} />
            </SectionCard>
          ) : null}
          {modeConfig ? (
            <SectionCard id="operating-mode" title="Chế độ vận hành" description="Quan sát → Copilot → Thử nghiệm AI vs Người → Tự động: đo người trước, rồi mới để AI tự trả lời.">
              <ModePanel config={modeConfig} manage={manage} />
            </SectionCard>
          ) : null}
          {manage ? (
            <SectionCard title="Messenger trực tiếp (không cần Pancake)" description="Nối fanpage thẳng với bot bằng một nút cấp quyền của Facebook — cho shop không dùng Pancake.">
              <Link href="/ai/sales-chatbot/messenger" className="text-sm font-medium text-primary underline underline-offset-2" data-testid="messenger-link">
                Mở cài đặt Messenger trực tiếp
              </Link>
            </SectionCard>
          ) : null}
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
          {zalo ? (
            <SectionCard title="Zalo OA" description="Bot trả lời tin nhắn khách gửi vào Zalo Official Account của shop — không cần Pancake. Cùng cấu hình, giá / tồn, luật chốt đơn.">
              <div className="space-y-2 text-sm" data-testid="zalo-setup">
                <p>
                  Trạng thái: <b data-testid="zalo-status">{{ NOT_CONFIGURED: "CHƯA KHAI", DRAFT: "CHƯA BẬT", ACTIVE: "ĐANG BẬT", FAILED: "KIỂM TRA HỎNG" }[zalo.status]}</b>
                  {zalo.oaId ? ` · OA ${zalo.oaId}` : ""} · bot đã xử lý {zalo.counts.done} tin · chờ {zalo.counts.pending} · bỏ qua {zalo.counts.skipped}
                </p>
                {zalo.counts.lastSkipReason ? <p className="text-xs text-muted-foreground">Lần bỏ qua gần nhất: {zalo.counts.lastSkipReason}</p> : null}
                <ol className="list-decimal space-y-1 pl-5 text-xs leading-5 text-muted-foreground">
                  <li>developers.zalo.me: tạo ứng dụng, liên kết OA của shop, lấy App ID · App Secret · OA Secret Key (mục Webhook); lấy refresh token ở API Explorer (loại OA Access Token).</li>
                  <li>
                    <Link href="/settings/connections" className="underline underline-offset-2">Cài đặt → Kết nối</Link> → «Zalo OA»: nhập đủ các ô → Lưu → Kiểm tra → Bật. Máy tự làm mới token và lưu cặp mới.
                  </li>
                  <li>Trong Zalo Developers → Webhook: dán URL dưới đây, bật sự kiện «Người dùng gửi tin nhắn» và «OA gửi tin nhắn» (để bot biết nhân viên đang trả lời).</li>
                  <li>Bot chỉ trả lời trong 48 giờ từ tin cuối của khách — ngoài đó Zalo tính phí tin tư vấn nên bot không gửi. Nhân viên trả lời trong OA ⇒ bot nhường hội thoại 30 phút. Ảnh của câu trả lời mẫu chưa gửi được qua Zalo (chỉ phần chữ).</li>
                </ol>
                {zalo.webhookUrl ? (
                  <div className="space-y-1">
                    <p className="text-xs font-medium">URL webhook Zalo của shop (giữ kín):</p>
                    <code className="block break-all rounded-md bg-muted px-2 py-1.5 text-[11px]" data-testid="zalo-webhook-url">{zalo.webhookUrl}</code>
                  </div>
                ) : (
                  <p className="text-xs text-amber-700 dark:text-amber-400">Máy chủ chưa có khoá bí mật nền tảng — chưa dựng được URL webhook. Báo người vận hành nền tảng.</p>
                )}
              </div>
            </SectionCard>
          ) : null}
          {inboxHistory ? <InboxHistoryPanel run={inboxHistory.run} fanpageReady={inboxHistory.fanpageReady} /> : null}
          {messengerHistory ? <MessengerHistoryPanel run={messengerHistory.run} pages={messengerHistory.pages} /> : null}
          {costReport ? <ChatCostPanel report={costReport} /> : null}
          {followup ? <FollowupPanel settings={followup} waiting={waitingCount} manage={manage} /> : null}
          {lessons ? <LessonsPanel key={`${lessons.version}-${lessons.updatedAt ?? ""}`} state={lessons} /> : null}
          {levelScripts && levelPack && levelCountMap ? <LevelScriptsPanel key={JSON.stringify(levelScripts)} scripts={levelScripts} levels={levelsForPack(levelPack)} counts={levelCountMap} /> : null}
          {playbook && playbookRun ? <PlaybookPanel key={playbook.draft?.createdAt ?? "chua-co-nhap"} state={playbook} run={playbookRun} fanpageReady={fanpage?.status === "ACTIVE"} /> : null}
          {manage ? (
            <ChatbotConfigForm config={cfg} fields={fields} connections={aiConnections} appointmentsOn={moduleOn(user, "appointments")} health={providerHealth} />
          ) : (
            <SectionCard id="bot-config" title="Cấu hình">
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
            ) : null}
            {publicUrl && pub.url ? <EmbedSnippet snippet={widgetSnippet(pub.url)} /> : null}
            {publicUrl ? null : (
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
                      {/* Trả lời khách + tạo đơn ở Hộp thư khách (M8) — form tạo đơn (P5) nằm cạnh khung chat ở đó. */}
                      {c.channel !== "TEST" ? (
                        <Link href={`/ai/sales-chatbot/inbox?c=${encodeURIComponent(c.id)}`} className="font-medium text-primary underline underline-offset-2">
                          Mở hộp thư
                        </Link>
                      ) : null}
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

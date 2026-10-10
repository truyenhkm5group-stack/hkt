import Link from "next/link";
import { EmbedSnippet } from "@/components/sales-chat/embed-snippet";
import { widgetSnippet } from "@/lib/sales-chatbot/widget";
import { moduleOn } from "@/lib/platform-ui/module-visibility";
import { PageHeader } from "@/components/page-header";
import { SalesChatPanel } from "@/components/sales-chat/chat-panel";
import { SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { COMPANY } from "@/lib/constants/company";
import { isSalesAgentUser, shellAllows } from "@/lib/constants/saas-nav";
import { directConnectFor } from "@/lib/channels/direct-connect";
import { formatDateTime } from "@/lib/format";
import { publicationOf } from "@/lib/platform/publish";
import { productCustomFieldOptions } from "@/lib/sales-chatbot/catalog";
import { CHAT_CHANNEL_LABEL, salesBotError, type ChatChannel } from "@/lib/sales-chatbot/config";
import { fanpageSetupView } from "@/lib/sales-chatbot/fanpage";
import { zaloSetupView } from "@/lib/sales-chatbot/zalo";
import { loadInboxHistoryView } from "@/lib/sales-chatbot/history";
import { loadPlaybook, loadPlaybookRun } from "@/lib/sales-chatbot/playbook";
import { loadLessons } from "@/lib/sales-chatbot/lessons";
import { listConversations, loadSalesChatbotConfig } from "@/lib/sales-chatbot/engine";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";
import { ChatbotConfigForm } from "./config-form";
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
import { loadChatbotAiView } from "@/lib/saas/visibility-loaders";
import { CUSTOMER_AI_INCIDENT_LABEL, customerFacing, customerLessons, customerOrderSyncView, customerPlaybookRun, customerPlaybookState, customerReadinessChecks } from "@/lib/saas/visibility";
import { SALES_STAGE_LABEL, type SalesStage } from "@/lib/sales-chatbot/stages";
import { loadReadiness } from "@/lib/sales-chatbot/readiness";
import { READINESS_STATUS_LABEL, READINESS_VERDICT_LABEL, readinessVerdict } from "@/lib/sales-chatbot/readiness-shared";
import { PageRuntimePanel } from "./page-runtime-panel";
import { SettingsStatusCard } from "./settings-status-card";
import { channelLinkOf, settingsStatus } from "@/lib/sales-chatbot/settings-status";
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
  // Workspace KHÁCH (chủ shop 07/10/2026): không model / nguồn AI / chi phí / sức khoẻ khoá trong props — lib/saas/visibility.ts.
  const customer = customerFacing(user.organization);
  const shell = isSalesAgentUser(user);
  // Nối thẳng Facebook chờ Meta duyệt quyền Page (lib/channels/direct-connect.ts).
  const directConnect = await directConnectFor(user);
  const [cfg, fields, conversations, pub] = await Promise.all([loadSalesChatbotConfig(), productCustomFieldOptions(), listConversations(30), publicationOf(user.organization?.code ?? "")]);
  const fanpage = manage && user.organization?.code ? await fanpageSetupView(user.organization.code) : null;
  const zalo = manage && user.organization?.code ? await zaloSetupView(user.organization.code) : null;
  const [playbook, playbookRun, lessons] = manage ? await Promise.all([loadPlaybook(), loadPlaybookRun(), loadLessons()]) : [null, null, null];
  const [levelScripts, levelPack, levelCountMap] = manage ? await Promise.all([loadLevelScripts(), organizationLevelPack(), levelCounts()]) : [null, null, null];
  // Phần AI (động cơ, sức khoẻ khoá, chi phí AI theo ngày) — ĐÃ LỌC theo người xem: khách không nhận khoá nội bộ nào; chi phí
  // chỉ người cấu hình bot ở workspace nhà thấy, sổ AI hỏng ⇒ ẩn bảng, không sập trang.
  const ai = await loadChatbotAiView(user, cfg, { manage });
  const costReport = ai.audience === "INTERNAL" ? ai.costReport : null;
  const [followup, waitingCount] = fanpage ? await Promise.all([loadFollowupSettings(), countWaitingConversations()]) : [null, 0];
  const orderSync = fanpage ? await orderSyncView() : null;
  // Đồng bộ lịch sử hộp thư — chỉ khi tổ chức có khối Fanpage (qua Pancake) và người xem quản lý được chatbot.
  const inboxHistory = fanpage ? await loadInboxHistoryView(user) : null;
  // Hội thoại gần đây của page nối THẲNG Meta — chỉ khi có page trực tiếp và người xem quản lý được chatbot.
  const messengerHistory = await loadMessengerHistoryView(user);
  const modeConfig = fanpage ? await loadModeConfig() : null;
  // Workspace NHÀ: bot Chốt Đơn chỉ chạm page có trong danh sách (Tắt / Bóng / Chạy thật) — page-runtime.ts. Khách: không có khối này.
  const pageRuntime = user.organization?.isHome ? await pageRuntimeView().catch(() => null) : null;
  const publicUrl = pub.state === "PUBLISHED" && pub.url ? `${pub.url}/chat` : null;
  // Sẵn sàng tự trả lời (P8): chỉ đếm số thật; THÔNG TIN, không chặn đổi chế độ.
  const rawReadiness = manage ? await loadReadiness(cfg, { ready: ai.aiReady, reason: ai.audience === "INTERNAL" ? ai.aiReason : null }) : null;
  // Khách: dòng AI đổi theo trạng thái khách (hết lượt ⇒ «Cần làm», chưa sẵn sàng ⇒ «Đang chuẩn bị») — kết luận tính lại trên
  // ĐÚNG các dòng khách thấy, để đầu bảng không nói «sẵn sàng» khi một dòng bên dưới nói ngược lại.
  const customerChecks = rawReadiness && ai.audience === "CUSTOMER" ? customerReadinessChecks(rawReadiness.checks, ai.aiState) : null;
  const readiness = rawReadiness && customerChecks ? { verdict: readinessVerdict(customerChecks), checks: customerChecks } : rawReadiness;
  const readinessTodo = readiness ? [[readiness.checks.filter((c) => c.status === "FAIL").length, "việc cần làm"] as const, [readiness.checks.filter((c) => c.status === "WARN").length, "việc nên làm"] as const].filter(([n]) => n > 0).map(([n, t]) => `${n} ${t}`).join(" · ") : "";
  // Ô trạng thái đầu trang (lib/sales-chatbot/settings-status.ts): CHỈ dữ kiện trang đã nạp ở trên. Người xem không cấu hình được bot
  // thì trang không đọc kênh / sản phẩm ⇒ `null` ⇒ «Chưa rõ», không bao giờ «Đang chạy» dựng trên chỗ trống (luật 42).
  const pricedCheck = rawReadiness?.checks.find((c) => c.key === "PRICES");
  const status = settingsStatus(
    {
      audience: ai.audience,
      botEnabled: cfg.enabled,
      aiReady: ai.aiReady,
      quotaExhausted: ai.audience === "CUSTOMER" && ai.aiState === "OUT_OF_QUOTA",
      mode: modeConfig?.mode ?? null,
      channels: manage ? { fanpage: fanpage ? channelLinkOf(fanpage.status) : null, zalo: zalo ? channelLinkOf(zalo.status) : null, messengerPages: messengerHistory?.pages ?? 0, webChat: publicUrl !== null } : null,
      hasPricedProducts: pricedCheck ? pricedCheck.status === "PASS" : null,
      aiReason: ai.audience === "INTERNAL" ? ai.aiReason : null,
    },
    { allows: (href) => shellAllows(user, href), supportHref: customer ? COMPANY.zaloHref : null },
  );
  const hasTools = Boolean(followup || lessons || (levelScripts && levelPack && levelCountMap) || (playbook && playbookRun) || inboxHistory || messengerHistory || costReport);
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={shell ? undefined : "AI"}
        title={shell ? "AI Sales" : "Chatbot bán hàng"}
        description={user.organization?.name}
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>Bot trả lời khách của shop: tìm sản phẩm, báo giá và tồn ĐỌC TỪ {shell ? "SỔ SẢN PHẨM CỦA SHOP" : "ERP"} ngay lúc hỏi (không nằm trong lời nhắc), tính tiền giỏ, lên đơn nháp, đọc lại tóm tắt và CHỈ chốt khi khách xác nhận. Đơn chốt ⇒ giữ hàng ở kho + báo nhóm vận hành (nếu đã cấu hình Thông báo nhóm).</p>
            {customer ? (
              <p>Khung thử bên phải dùng giá / tồn thật nhưng KHÔNG tạo khách, đơn hay tin nhóm thật.</p>
            ) : (
              <p>Khoá AI là của CHÍNH tổ chức (Cài đặt → Kết nối → Anthropic / OpenAI) — tổ chức trả tiền token. Khung thử bên phải dùng giá / tồn thật nhưng KHÔNG tạo khách, đơn hay tin nhóm thật.</p>
            )}
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
      <SettingsStatusCard status={status}>
        {readiness ? (
          <details className="group" data-testid="ai-readiness-details">
            <summary className="cursor-pointer text-sm font-medium">
              Bảng kiểm «AI đã sẵn sàng tự trả lời khách?» — {READINESS_VERDICT_LABEL[readiness.verdict]}
              {readinessTodo ? <span className="text-muted-foreground"> · {readinessTodo}</span> : null}
            </summary>
            <p className="mt-2 text-xs text-muted-foreground">Đọc từ dữ liệu thật của shop. Đây là bảng kiểm, không chặn bạn đổi chế độ.</p>
            <div className="mt-2">
              <ul className="space-y-1.5 text-sm" data-testid="ai-readiness" data-verdict={readiness.verdict}>
                {readiness.checks.map((c) => (
                  <li key={c.key} className="flex items-start gap-2">
                    {/* Việc CHƯA LÀM không phải lỗi (docs/design-system.md §9): «Cần làm» tô cam, «Nên làm» tô xám, «Xong» tô xanh — không đỏ.
                        «Đang chuẩn bị» (đội hỗ trợ đang làm, không phải việc của người đọc) tô xám viền đứt — không cam như việc phải làm. */}
                    <span className={`mt-0.5 shrink-0 rounded px-1.5 text-[11px] font-semibold ${c.status === "PASS" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" : c.status === "WARN" ? "bg-muted text-foreground/70" : c.status === "PENDING" ? "border border-dashed border-foreground/25 bg-muted/60 text-muted-foreground" : "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"}`} data-status={c.status}>
                      {READINESS_STATUS_LABEL[c.status]}
                    </span>
                    <span className="min-w-0">
                      {c.href && shellAllows(user, c.href) ? (
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
              {customer && readiness.verdict === "NOT_READY" ? (
                <p className="mt-3 text-xs text-muted-foreground" data-testid="ai-readiness-support">
                  Cần người hỗ trợ? Nhắn Zalo{" "}
                  <a href={COMPANY.zaloHref} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
                    {COMPANY.zalo}
                  </a>{" "}
                  hoặc email <a href={`mailto:${COMPANY.email}`} className="font-medium text-primary hover:underline">{COMPANY.email}</a> — ghi kèm tên cửa hàng.
                </p>
              ) : null}
            </div>
          </details>
        ) : null}
      </SettingsStatusCard>
      <div className="grid gap-5 xl:grid-cols-[1fr_440px]">
        <div className="space-y-5">
          {pageRuntime?.isHome ? (
            <SectionCard id="page-runtime" title="Bot Chốt Đơn theo page (workspace nhà)" description="Mặc định mọi page TẮT. Bóng = bot soạn câu để so, không gửi. Chạy thật là quyết định của chủ shop.">
              <PageRuntimePanel pages={pageRuntime.pages} manage={manage} />
            </SectionCard>
          ) : null}
          {manage ? (
            ai.audience === "INTERNAL" ? (
              <ChatbotConfigForm config={ai.config} fields={fields} engine={ai.engine} appointmentsOn={moduleOn(user, "appointments")} />
            ) : (
              <ChatbotConfigForm config={ai.config} fields={fields} appointmentsOn={moduleOn(user, "appointments")} shell={shell} />
            )
          ) : (
            <SectionCard id="bot-config" title="Cấu hình">
              <p className="text-sm text-muted-foreground">Bạn xem được hội thoại; cấu hình bot cần quyền «AI bán hàng: cấu hình & xuất bản chatbot».</p>
            </SectionCard>
          )}
          {modeConfig ? (
            <SectionCard id="operating-mode" title="Chế độ vận hành" description="Quan sát → Copilot → Thử nghiệm AI vs Người → Tự động: đo người trước, rồi mới để AI tự trả lời.">
              <ModePanel config={modeConfig} manage={manage} />
            </SectionCard>
          ) : null}
          <div className="pt-2">
            <h2 className="text-base font-semibold">Kênh chat</h2>
            <p className="text-xs text-muted-foreground">Nơi bot nhận tin khách. Chỉ cần một kênh đang bật là bot làm việc được.</p>
          </div>
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
                    <Link href="/settings/connections" className="underline underline-offset-2">{shell ? "Trang Kết nối" : "Cài đặt → Kết nối"}</Link> → «Fanpage qua Pancake»: {shell ? "nhập mã page và mã truy cập page (lấy ở Pancake → Cài đặt page → Công cụ)" : "nhập Page ID và page access token (Pancake → Cài đặt page → Công cụ)"} → Lưu → Kiểm tra → Bật.
                  </li>
                  <li>{shell ? "Trong Pancake: Cài đặt page → mục «Webhook» (tên mục của Pancake) → bật sự kiện tin nhắn → dán địa chỉ dưới đây." : "Trong Pancake: Cài đặt page → Webhook → bật sự kiện tin nhắn (messaging) → dán URL dưới đây."}</li>
                  <li>Bật bot ở khung «Cấu hình bot». Bot trả lời sau khoảng 5 giây (tin đầu của hội thoại mới: tối đa 10 giây để nhường trả lời tự động của Meta); page đã trả lời thì bot không chen; nhân viên trả lời trên fanpage ⇒ bot nhường hội thoại đó 30 phút.</li>
                </ol>
                {fanpage.webhookUrl ? (
                  <div className="space-y-1">
                    <p className="text-xs font-medium">{shell ? "Địa chỉ nhận tin của shop — dán ở bước 2 (giữ kín: ai có địa chỉ này gửi được tin giả vào bot):" : "URL webhook của shop (giữ kín — ai có URL này gửi được tin giả vào bot):"}</p>
                    <code className="block break-all rounded-md bg-muted px-2 py-1.5 text-[11px]" data-testid="fanpage-webhook-url">{fanpage.webhookUrl}</code>
                  </div>
                ) : (
                  <p className="text-xs text-amber-700 dark:text-amber-400">{shell ? "Chưa tạo được địa chỉ nhận tin của shop — báo đội hỗ trợ." : "Máy chủ chưa có khoá bí mật nền tảng — chưa dựng được URL webhook. Báo người vận hành nền tảng."}</p>
                )}
              </div>
            </SectionCard>
          ) : null}
          {orderSync ? <OrderSyncPanel view={customer ? customerOrderSyncView(orderSync) : orderSync} manage={manage} shell={shell} /> : null}
          {manage ? (
            <SectionCard title="Messenger trực tiếp (không cần Pancake)" description={directConnect ? "Nối fanpage thẳng với bot bằng một nút cấp quyền của Facebook — cho shop không dùng Pancake." : "Sắp mở — đang chờ Facebook duyệt quyền. Hôm nay nối fanpage qua thẻ «Fanpage (qua Pancake)» bên trên."}>
              <Link href="/ai/sales-chatbot/messenger" className="text-sm font-medium text-primary underline underline-offset-2" data-testid="messenger-link">
                Mở cài đặt Messenger trực tiếp
              </Link>
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
                  <li>
                    {shell
                      ? "Trang nhà phát triển của Zalo (developers.zalo.me): tạo ứng dụng, liên kết OA của shop, chép ba mã «App ID» · «App Secret» · «OA Secret Key» (mã cuối nằm ở mục «Webhook» — tên mục của Zalo) và mã làm mới quyền truy cập (lấy ở công cụ «API Explorer» của Zalo, chọn loại mã truy cập dành cho OA)."
                      : "developers.zalo.me: tạo ứng dụng, liên kết OA của shop, lấy App ID · App Secret · OA Secret Key (mục Webhook); lấy refresh token ở API Explorer (loại OA Access Token)."}
                  </li>
                  <li>
                    <Link href="/settings/connections" className="underline underline-offset-2">{shell ? "Trang Kết nối" : "Cài đặt → Kết nối"}</Link> → «Zalo OA»: nhập đủ các ô → Lưu → Kiểm tra → Bật. {shell ? "Máy tự gia hạn quyền truy cập Zalo." : "Máy tự làm mới token và lưu cặp mới."}
                  </li>
                  <li>
                    {shell
                      ? "Trong trang nhà phát triển của Zalo → mục «Webhook» (tên mục của Zalo): dán địa chỉ dưới đây, bật sự kiện «Người dùng gửi tin nhắn» và «OA gửi tin nhắn» (để bot biết nhân viên đang trả lời)."
                      : "Trong Zalo Developers → Webhook: dán URL dưới đây, bật sự kiện «Người dùng gửi tin nhắn» và «OA gửi tin nhắn» (để bot biết nhân viên đang trả lời)."}
                  </li>
                  <li>Bot chỉ trả lời trong 48 giờ từ tin cuối của khách — ngoài đó Zalo tính phí tin tư vấn nên bot không gửi. Nhân viên trả lời trong OA ⇒ bot nhường hội thoại 30 phút. Ảnh của câu trả lời mẫu chưa gửi được qua Zalo (chỉ phần chữ).</li>
                </ol>
                {zalo.webhookUrl ? (
                  <div className="space-y-1">
                    <p className="text-xs font-medium">{shell ? "Địa chỉ nhận tin Zalo của shop — dán ở bước 3 (giữ kín):" : "URL webhook Zalo của shop (giữ kín):"}</p>
                    <code className="block break-all rounded-md bg-muted px-2 py-1.5 text-[11px]" data-testid="zalo-webhook-url">{zalo.webhookUrl}</code>
                  </div>
                ) : (
                  <p className="text-xs text-amber-700 dark:text-amber-400">{shell ? "Chưa tạo được địa chỉ nhận tin của shop — báo đội hỗ trợ." : "Máy chủ chưa có khoá bí mật nền tảng — chưa dựng được URL webhook. Báo người vận hành nền tảng."}</p>
                )}
              </div>
            </SectionCard>
          ) : null}
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
                Trang chat công khai có sau khi {shell ? "cửa hàng" : "ERP"} được xuất bản với tên miền con — <Link href="/setup" className="underline underline-offset-2">Thiết lập & xuất bản</Link>.
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
                          Lỗi: {customer ? CUSTOMER_AI_INCIDENT_LABEL : salesBotError(c.lastError)?.label}
                        </span>
                      ) : null}
                      {formatDateTime(c.updatedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
          {hasTools ? (
            <details className="group rounded-2xl bg-card shadow-[var(--shadow-card)]" data-testid="ai-settings-more">
              <summary className="cursor-pointer px-5 py-3.5 text-sm font-semibold">
                Công cụ thêm
                <span className="block text-xs font-normal text-muted-foreground">Nhắc lại khách · học từ hội thoại cũ · kịch bản theo mức khách · sổ tay bán hàng · nhập lịch sử tin nhắn{costReport ? " · chi phí AI" : ""}</span>
              </summary>
              <div className="space-y-5 p-3 pt-0 sm:p-5 sm:pt-0">
                {followup ? <FollowupPanel settings={followup} waiting={waitingCount} manage={manage} /> : null}
                {lessons ? <LessonsPanel key={`${lessons.version}-${lessons.updatedAt ?? ""}`} state={customer ? customerLessons(lessons) : lessons} shell={shell} /> : null}
                {levelScripts && levelPack && levelCountMap ? <LevelScriptsPanel key={JSON.stringify(levelScripts)} scripts={levelScripts} levels={levelsForPack(levelPack)} counts={levelCountMap} /> : null}
                {playbook && playbookRun ? <PlaybookPanel key={playbook.draft?.createdAt ?? "chua-co-nhap"} state={customer ? customerPlaybookState(playbook) : playbook} run={customer ? customerPlaybookRun(playbookRun) : playbookRun} fanpageReady={fanpage?.status === "ACTIVE"} shell={shell} /> : null}
                {inboxHistory ? <InboxHistoryPanel run={inboxHistory.run} fanpageReady={inboxHistory.fanpageReady} shell={shell} /> : null}
                {messengerHistory ? <MessengerHistoryPanel run={messengerHistory.run} pages={messengerHistory.pages} shell={shell} /> : null}
                {costReport ? <ChatCostPanel report={costReport} /> : null}
              </div>
            </details>
          ) : null}
        </div>
        {manage ? (
          <div id="khung-thu" className="scroll-mt-24 space-y-2">
            <p className="text-sm font-semibold">{shell ? "Khung thử" : "Khung thử (TEST)"}</p>
            <SalesChatPanel mode="test" title={`${cfg.botName} · thử`} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

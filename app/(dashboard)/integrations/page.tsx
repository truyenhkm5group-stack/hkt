import { InfoHint } from "@/components/info-hint";
import { AlertTriangle, CheckCircle2, Clock3, Loader2, RefreshCw, XCircle } from "lucide-react";
import { BackfillForm } from "@/app/(dashboard)/integrations/backfill-form";
import { SyncRunsTable } from "@/app/(dashboard)/integrations/sync-runs-table";
import { TestConnectionButton } from "@/app/(dashboard)/integrations/test-connection-button";
import { WebhookEventsTable } from "@/app/(dashboard)/integrations/webhook-events-table";
import { WebhookHealthPanel } from "@/app/(dashboard)/integrations/webhook-health";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { CopyButton } from "@/components/misc";
import { PageHeader } from "@/components/page-header";
import { SyncButton } from "@/components/sync-button";
import { DescriptionList, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can, requirePermission } from "@/lib/auth/session";
import { JOB_RUN_KEYS, SYNC_SOURCE_LABEL } from "@/lib/constants/sync";
import { env, integrationStatus } from "@/lib/env";
import { formatDate, formatDateTime, formatNumber, formatTimeAgo } from "@/lib/format";
import { getIntegrationTokenInfo, listRecentWebhooks, listSyncRuns, SYNC_RUN_SORTABLE, syncRunFacets, viettelPostHealth } from "@/lib/queries/integrations";
import { HEALTH_LABEL, HEALTH_TONE, getIntegrationHealth } from "@/lib/queries/integration-health";
import { paramList, parseListParams, type SearchParams } from "@/lib/search-params";
import { JOB_DEFINITIONS } from "@/lib/sync/jobs";
import { getSyncState, runningJobKeys } from "@/lib/sync/runner";
import { cn } from "@/lib/utils";

export const metadata = { title: "Kết nối dữ liệu" };

function maskKey(key: string) {
  if (!key) return "";
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 4)}••••••••${key.slice(-4)}`;
}

function minutesEnv(name: string, fallback: number) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

type BackfillState = { nextStart?: string; days?: number; done?: boolean; finishedAt?: string } | null;

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  const user = await requirePermission("integrations:view");
  const canSync = can(user, "sync:run");
  const status = integrationStatus();
  const running = runningJobKeys();
  const runParams = parseListParams(raw, { defaultSort: "startedAt", filterKeys: ["source", "status"], sortable: SYNC_RUN_SORTABLE, defaultPeriod: "7d" });
  const webhookFilters = { source: paramList(raw, "whSource"), status: paramList(raw, "whStatus") };

  const [vtpToken, cursor, backfill, runs, runFacets, webhooks, vtpHealth, connectors] = await Promise.all([
    getIntegrationTokenInfo("viettelpost"),
    getSyncState<{ cursor: string }>("pancake.orders.updated_at.cursor"),
    getSyncState<BackfillState>("pancake.orders.backfill"),
    listSyncRuns(runParams),
    syncRunFacets(runParams),
    listRecentWebhooks(webhookFilters, 30),
    viettelPostHealth(),
    getIntegrationHealth(),
  ]);

  const appUrl = env.appUrl;
  const canManageSettings = can(user, "integrations:manage");
  const webhookCount = (source: string) => webhooks.facets.sources.find((s) => s.value === source)?.count ?? 0;
  const pancakeWebhookUrl = `${appUrl}/api/webhooks/pancake/${env.pancake.webhookSecret || "<PANCAKE_WEBHOOK_SECRET>"}`;
  const vtpWebhookUrl = `${appUrl}/api/webhooks/viettelpost`;
  const vtpStatementMailUrl = `${appUrl}/api/webhooks/vtp-statement`;
  const isLocal = /localhost|127\.0\.0\.1|^http:\/\//.test(appUrl);
  const backfillDays = backfill?.days ?? env.pancake.backfillDays;
  const backfillProgress = (() => {
    if (!backfill?.nextStart || !backfill.days) return null;
    if (backfill.done) return 100;
    const total = backfill.days * 86_400_000;
    const start = Date.now() - total;
    return Math.max(0, Math.min(99, Math.round(((new Date(backfill.nextStart).getTime() - start) / total) * 100)));
  })();
  const backfillRunning = running.includes("PANCAKE:orders_backfill");

  const scheduleRows = [
    { job: "pancake-orders", every: minutesEnv("SYNC_ORDERS_EVERY_MINUTES", 3), envName: "SYNC_ORDERS_EVERY_MINUTES" },
    { job: "vtp-tracking", every: minutesEnv("SYNC_VTP_EVERY_MINUTES", 10), envName: "SYNC_VTP_EVERY_MINUTES" },
    { job: "pancake-products", every: minutesEnv("SYNC_PRODUCTS_EVERY_MINUTES", 30), envName: "SYNC_PRODUCTS_EVERY_MINUTES" },
    { job: "pancake-returns", every: minutesEnv("SYNC_RETURNS_EVERY_MINUTES", 30), envName: "SYNC_RETURNS_EVERY_MINUTES" },
    { job: "pancake-customers", every: minutesEnv("SYNC_CUSTOMERS_EVERY_MINUTES", 60), envName: "SYNC_CUSTOMERS_EVERY_MINUTES" },
    { job: "pancake-inventory", every: minutesEnv("SYNC_INVENTORY_EVERY_MINUTES", 60), envName: "SYNC_INVENTORY_EVERY_MINUTES" },
    { job: "facebook-ads", every: minutesEnv("SYNC_ADS_EVERY_MINUTES", 60), envName: "SYNC_ADS_EVERY_MINUTES" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Hệ thống"
        title="Kết nối dữ liệu"
        description="Pancake POS, Viettel Post, webhook thời gian thực và lịch đồng bộ tự động"
        actions={canSync ? <SyncButton job="all" label="Đồng bộ tất cả" variant="default" /> : null}
      />

      {/* Sức khoẻ đường truyền đứng TRƯỚC cấu hình: câu hỏi thường gặp là "có đang chạy không", không phải "khoá là gì". */}
      <WebhookHealthPanel />

      {!status.pancake || !status.viettelPost ? (
        <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <div>
            <p className="font-semibold">Chưa cấu hình đủ kết nối</p>
            <p className="text-muted-foreground">
              {!status.pancake ? "Thiếu PANCAKE_API_KEY / PANCAKE_SHOP_ID. " : ""}
              {!status.viettelPost ? "Thiếu VIETTELPOST_API_KEY (hoặc VIETTELPOST_USERNAME / VIETTELPOST_PASSWORD). " : ""}
              Sửa file .env rồi khởi động lại ứng dụng.
            </p>
          </div>
        </div>
      ) : null}

      {/* ───────── Kết nối API ───────── */}
      <section className="grid gap-5 lg:grid-cols-2">
        <ConnectionCard
          initials="PC"
          tone="bg-rose-500"
          title="Pancake POS"
          description="Đơn hàng, khách hàng, sản phẩm, tồn kho, đổi trả"
          configured={status.pancake}
          items={[
            { label: "API key", value: status.pancake ? <span className="font-mono">{maskKey(env.pancake.apiKey)}</span> : <span className="text-muted-foreground">Chưa cấu hình PANCAKE_API_KEY</span> },
            { label: "Shop ID", value: env.pancake.shopId ? <span className="font-mono">{env.pancake.shopId}</span> : <span className="text-muted-foreground">Chưa cấu hình PANCAKE_SHOP_ID</span> },
            { label: "Base URL", value: <span className="font-mono text-xs">{env.pancake.baseUrl}</span>, span: true },
            { label: "Webhook secret", value: status.pancakeWebhook ? <span className="font-mono">{maskKey(env.pancake.webhookSecret)}</span> : <span className="text-muted-foreground">Chưa đặt PANCAKE_WEBHOOK_SECRET</span> },
            { label: "Mốc đồng bộ đơn", value: cursor?.cursor ? `${formatDateTime(cursor.cursor)} (${formatTimeAgo(cursor.cursor)})` : <span className="text-muted-foreground">Chưa đồng bộ lần nào</span> },
          ]}
          footer={<TestConnectionButton provider="pancake" disabled={!status.pancake} />}
        />
        <ConnectionCard
          initials="VT"
          tone="bg-red-600"
          title="Viettel Post"
          description="Hành trình vận đơn, COD và đối soát"
          configured={status.viettelPost}
          items={[
            {
              label: "Token / tài khoản",
              value: env.viettelPost.apiKey ? <span className="font-mono">{maskKey(env.viettelPost.apiKey)}</span> : env.viettelPost.username ? `Tài khoản ${env.viettelPost.username}` : <span className="text-muted-foreground">Chưa cấu hình VIETTELPOST_API_KEY</span>,
            },
            {
              label: "Token phiên hiện tại",
              value: vtpToken ? (
                <span>
                  {vtpToken.expiresAt ? `Hết hạn ${formatDateTime(vtpToken.expiresAt)}` : "Token dài hạn"} · cấp lúc {formatDateTime(vtpToken.updatedAt)}
                  {vtpToken.expiresAt && vtpToken.expiresAt.getTime() < Date.now() ? <span className="ml-1 text-destructive">(đã hết hạn, sẽ tự làm mới)</span> : null}
                </span>
              ) : (
                <span className="text-muted-foreground">Chưa lấy token — sẽ tự đăng nhập khi đồng bộ</span>
              ),
            },
            { label: "Base URL", value: <span className="font-mono text-xs">{env.viettelPost.baseUrl}</span>, span: true },
            {
              // Hiện ĐẦY ĐỦ để dán sang partner2.viettelpost.vn → Cấu hình webhook → Secret parameter.
              // Che đi thì không ai lấy được giá trị (ops rotate-webhook-secrets cố ý không in ra log
              // vì kho mã nguồn là công khai), mà sai một ký tự là Viettel Post báo "Thất bại" (401).
              // Trang này đã sau đăng nhập và cần quyền xem kết nối; URL webhook Pancake bên trên cũng
              // hiện nguyên secret trong đường dẫn nên mức lộ là như nhau.
              label: "Tham số bí mật webhook (Secret parameter)",
              value: status.viettelPostWebhook ? (
                <span className="inline-flex items-center gap-1">
                  <span className="font-mono break-all">{env.viettelPost.webhookSecret}</span>
                  <CopyButton value={env.viettelPost.webhookSecret} />
                </span>
              ) : (
                <span className="text-muted-foreground">Chưa đặt VIETTELPOST_WEBHOOK_SECRET</span>
              ),
              span: true,
            },
            {
              label: "Bảng kê COD tự lấy từ Gmail",
              value: (
                <span className="text-xs text-muted-foreground">
                  Viettel Post gửi thư “BẢNG KÊ ĐỐI SOÁT THANH TOÁN” kèm tệp BangKeChiCOD….xlsx về hộp thư shop. Đoạn Apps Script chạy trong chính Gmail
                  (hướng dẫn: <span className="font-mono">docs/GMAIL-BANG-KE-VTP.md</span>) gửi tệp sang{" "}
                  <span className="font-mono break-all">{vtpStatementMailUrl}</span> <CopyButton value={vtpStatementMailUrl} /> — ERP xử lý y như tải tay lên trang Nhập dữ liệu
                  Viettel Post. ERP KHÔNG giữ mật khẩu hộp thư. Lần chạy hiện ở bảng lịch sử đồng bộ với job{" "}
                  <span className="font-mono">vtp-statement-mail</span>.
                </span>
              ),
              span: true,
            },
          ]}
          footer={<TestConnectionButton provider="viettelpost" disabled={!status.viettelPost} />}
        />
        <ConnectionCard
          initials="FB"
          tone="bg-blue-600"
          title="Facebook Ads"
          description="Chi tiêu quảng cáo theo ngày × chiến dịch của mọi tài khoản trong Business Manager"
          configured={status.facebook}
          items={[
            { label: "Token System User", value: status.facebook ? <span className="font-mono">{maskKey(env.facebook.accessToken)}</span> : <span className="text-muted-foreground">Chưa cấu hình FACEBOOK_ACCESS_TOKEN</span> },
            { label: "Business Manager", value: <span className="font-mono">{env.facebook.businessId}</span> },
            { label: "Phiên bản API", value: <span className="font-mono text-xs">{env.facebook.apiVersion}</span> },
            { label: "Lịch", value: `Mỗi ${minutesEnv("SYNC_ADS_EVERY_MINUTES", 60)} phút · đối chiếu lại 30 ngày lúc 04:00` },
            {
              label: "Cách lấy token",
              value: <span className="text-xs text-muted-foreground">business.facebook.com → Business Settings → Users → System Users → Add (Admin) → Assign Assets: chọn tất cả tài khoản quảng cáo → Generate New Token: quyền ads_read, business_management, thời hạn Never expire.</span>,
              span: true,
            },
          ]}
          footer={<TestConnectionButton provider="facebook" disabled={!status.facebook} />}
        />
        <ConnectionCard
          initials="PG"
          tone="bg-pink-600"
          title="Pancake Pages (chat)"
          description="Đọc hội thoại và thẻ chat Pancake để tự tạo case CSKH."
          hint="Đọc hội thoại & thẻ chat để tự tạo case CSKH: tư vấn size chưa đúng, chốt sai giá, giục giao hàng, đổi size/màu, sai địa chỉ/SĐT…"
          configured={status.pancakePages}
          items={[
            { label: "Access token", value: status.pancakePages ? <span className="font-mono">{maskKey(env.pancake.pagesAccessToken)}</span> : <span className="text-muted-foreground">Chưa cấu hình PANCAKE_ACCESS_TOKEN</span> },
            { label: "Base URL", value: <span className="font-mono text-xs">{env.pancake.pagesBaseUrl}</span> },
            { label: "Lịch", value: `Mỗi ${minutesEnv("SYNC_CHAT_EVERY_MINUTES", 15)} phút · đọc hội thoại 48 giờ gần nhất` },
            { label: "Cách lấy token", value: <span className="text-xs text-muted-foreground">pancake.vn → Cài đặt → Công cụ (Tools) → API / Access token → sao chép token người dùng có quyền trên các page bán hàng.</span>, span: true },
          ]}
          footer={
            <div className="flex flex-wrap gap-2">
              <TestConnectionButton provider="pancake-pages" disabled={!status.pancakePages} />
              <SyncButton job="cs-chat" label="Quét hội thoại ngay" />
            </div>
          }
        />
      </section>

      {/* ───────── Sức khoẻ TẤT CẢ tích hợp ───────── */}
      <SectionCard
        title="Sức khoẻ tích hợp"
        description="Cùng một bộ câu hỏi cho mọi kết nối: còn chảy dữ liệu không, trễ bao lâu, có gì kẹt lại."
        hint="Trạng thái CHƯA ĐỦ CĂN CỨ không đồng nghĩa với ĐANG CHẠY TỐT: kết nối chưa từng nhận dữ liệu và chưa từng chạy đối chiếu thì ERP không có cơ sở để nói nó khoẻ. Một tích hợp chết âm thầm là chuyện đã xảy ra thật."
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[860px]">
            <TableHeader>
              <TableRow>
                <TableHead>Kết nối</TableHead>
                <TableHead>Tình trạng</TableHead>
                <TableHead>Nhận tin gần nhất</TableHead>
                <TableHead className="text-right">Sự kiện/giờ</TableHead>
                <TableHead className="text-right">Kẹt lại</TableHead>
                <TableHead>Đối chiếu gần nhất</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {connectors.map((c) => (
                <TableRow key={c.key}>
                  <TableCell className="font-medium whitespace-nowrap">{c.label}</TableCell>
                  <TableCell>
                    <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap", HEALTH_TONE[c.state])}>{HEALTH_LABEL[c.state]}</span>
                    <span className="block max-w-[320px] text-[11px] text-muted-foreground">{c.reason}</span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {c.lastEventAt ? formatTimeAgo(c.lastEventAt) : "—"}
                    {c.lagHours === null ? null : <span className="block text-[11px] text-muted-foreground">trễ {c.lagHours}h</span>}
                  </TableCell>
                  <TableCell className="numeric text-right text-xs">
                    {c.eventsPerHour}
                    {/*
                      Tách theo TỪNG BÊN GỬI. Gộp chung thì một đường chết vẫn thấy "có dữ liệu" —
                      đúng chuyện đã xảy ra: Poscake bị 401 gần ba ngày mà tổng số vẫn khác 0.
                    */}
                    {c.senders?.length ? (
                      <span className="block text-left text-[11px] font-normal text-muted-foreground">
                        {c.senders.map((s) => (
                          <span key={s.label} className="block whitespace-nowrap">
                            {s.label}: {formatNumber(s.events24h)}/24h · {s.lastAt ? formatTimeAgo(s.lastAt) : "chưa từng"}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {c.failed || c.unprocessed || c.unknownMappings ? (
                      <span className="text-warning">
                        {c.failed ? `${formatNumber(c.failed)} lỗi ` : ""}
                        {c.unprocessed ? `${formatNumber(c.unprocessed)} chưa khớp ` : ""}
                        {c.unknownMappings ? `${formatNumber(c.unknownMappings)} mã lạ` : ""}
                      </span>
                    ) : (
                      "—"
                    )}
                    {c.retries ? <span className="block text-[11px] text-muted-foreground">{formatNumber(c.retries)} lần gửi lại</span> : null}
                  </TableCell>
                  <TableCell className="max-w-[260px] text-xs">
                    {c.lastReconciliation?.at ? (
                      <>
                        {formatTimeAgo(c.lastReconciliation.at)} · {c.lastReconciliation.status}
                        {c.lastReconciliation.detail ? <span className="block truncate text-[11px] text-muted-foreground" title={c.lastReconciliation.detail}>{c.lastReconciliation.detail}</span> : null}
                      </>
                    ) : (
                      "Chưa chạy lần nào"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="border-t px-5 py-3 text-xs text-muted-foreground">
          Xử lý lại được cho mọi kết nối ở trên vì luồng nạp dữ liệu là idempotent: {connectors.map((c) => c.reprocessHint).find(Boolean)}
        </p>
      </SectionCard>

      {/* ───────── Sức khoẻ Viettel Post ───────── */}
      <SectionCard
        title="Viettel Post đang chảy dữ liệu thế nào"
        description="Hai nguồn tách bạch: webhook nhận được và đối chiếu chủ động."
        hint="Hai nguồn tách bạch: webhook là dữ liệu ERP thực sự nhận được; đối chiếu là ERP chủ động tra lại qua API để vá webhook rơi."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border p-4">
            <p className="text-[13px] font-medium text-muted-foreground">Webhook gần nhất</p>
            <p className="mt-1 text-2xl font-bold">{vtpHealth.lastWebhook ? formatTimeAgo(vtpHealth.lastWebhook.at) : "—"}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {vtpHealth.lastWebhook ? (
                <>
                  <span className="font-mono">{vtpHealth.lastWebhook.orderNumber || "(không có mã)"}</span>
                  {vtpHealth.lastWebhook.statusName ? ` · ${vtpHealth.lastWebhook.statusName}` : ""}
                </>
              ) : (
                "Chưa nhận webhook nào từ Viettel Post"
              )}
            </p>
          </div>
          <div className="rounded-xl border p-4">
            <p className="text-[13px] font-medium text-muted-foreground">Webhook đã nhận</p>
            <p className="numeric mt-1 text-2xl font-bold">{formatNumber(vtpHealth.webhooks.last24h)}<span className="text-base font-normal text-muted-foreground"> / 24h</span></p>
            <p className="mt-1 text-xs text-muted-foreground">
              {formatNumber(vtpHealth.webhooks.last7d)} trong 7 ngày · tổng {formatNumber(vtpHealth.webhooks.total)}
              {vtpHealth.webhooks.failed ? <span className="text-destructive"> · {formatNumber(vtpHealth.webhooks.failed)} xử lý lỗi</span> : null}
              {vtpHealth.webhooks.ignored ? <span className="text-warning"> · {formatNumber(vtpHealth.webhooks.ignored)} không khớp vận đơn</span> : null}
              {vtpHealth.webhooks.redelivered ? <span className="block">{formatNumber(vtpHealth.webhooks.redelivered)} lần Viettel Post gửi lại (đã gộp, không đếm trùng)</span> : null}
            </p>
          </div>
          <div className="rounded-xl border p-4">
            <p className="text-[13px] font-medium text-muted-foreground">Đối chiếu qua API</p>
            <p className={cn("mt-1 text-2xl font-bold", vtpHealth.apiBlind && "text-destructive")}>{vtpHealth.apiBlind ? "Không dùng được" : vtpHealth.lastPoll ? formatTimeAgo(vtpHealth.lastPoll.finishedAt) : "—"}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {vtpHealth.apiBlind
                ? "Tài khoản API không sở hữu các vận đơn này — xem cảnh báo bên dưới."
                : vtpHealth.lastPoll?.detail || "Chưa chạy đối chiếu lần nào"}
            </p>
          </div>
          <div className="rounded-xl border p-4">
            <p className="text-[13px] font-medium text-muted-foreground">Vận đơn chưa kết thúc</p>
            <p className="numeric mt-1 text-2xl font-bold">{formatNumber(vtpHealth.openShipments.total)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {vtpHealth.openShipments.stale48h ? <span className="text-warning">{formatNumber(vtpHealth.openShipments.stale48h)} vận đơn đã hơn 48h không có tin mới</span> : "Tất cả đều có tin trong 48h"}
              {vtpHealth.stageMismatch ? <span className="text-destructive"> · {formatNumber(vtpHealth.stageMismatch)} lệch trạng thái</span> : null}
              {vtpHealth.webhookNotApplied ? <span className="block text-destructive">{formatNumber(vtpHealth.webhookNotApplied)} vận đơn có webhook mới hơn trạng thái đang lưu</span> : null}
              {vtpHealth.unresolvedWebhooks ? <span className="block text-warning">{formatNumber(vtpHealth.unresolvedWebhooks)} gói tin chưa xử lý được — chờ xử lý lại</span> : null}
              {vtpHealth.unknownStatuses.length ? (
                <span className="block text-warning">
                  {vtpHealth.unknownStatuses.length} mã trạng thái ERP chưa hiểu: {vtpHealth.unknownStatuses.slice(0, 5).map((u) => `${u.status} (${formatNumber(u.count)})`).join(", ")}
                  {vtpHealth.unknownStatuses.length > 5 ? "…" : ""}
                </span>
              ) : null}
            </p>
          </div>
        </div>

        {vtpHealth.apiBlind || vtpHealth.lastPoll?.error ? (
          <div className="mt-4 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="text-xs leading-5">
              <p className="font-medium text-foreground">Đối chiếu qua API Viettel Post không chạy được</p>
              <p className="mt-1 text-muted-foreground">{vtpHealth.lastPoll?.error || "Tài khoản API không thấy vận đơn nào của shop."}</p>
              <p className="mt-1 text-muted-foreground">
                Trong lúc chờ Viettel Post gắn mã khách hàng vào tài khoản API, nguồn thật là <strong className="text-foreground">webhook</strong> (thời gian thực) và{" "}
                <strong className="text-foreground">file bảng kê / danh sách vận đơn</strong> tải từ viettelpost.vn. ERP đã tự giảm nhịp gọi API và sẽ chạy lại đầy đủ ngay khi API thấy vận đơn.
              </p>
            </div>
          </div>
        ) : null}
      </SectionCard>

      {/* ───────── Webhook ───────── */}
      <SectionCard
        title="Webhook — cập nhật thời gian thực"
        description="Dán URL dưới đây vào Pancake và Viettel Post"
        hint={
          <>
            Webhook giúp ERP nhận thay đổi ngay thay vì chờ lịch đồng bộ. Chỉ hoạt động khi ERP có tên miền công khai
            HTTPS — hiện tại <span className="font-mono">{appUrl}</span>
            {isLocal ? <span className="text-amber-600"> (đang là localhost/http nên Pancake và Viettel Post không gọi tới được)</span> : null}.
            Chạy thử trên máy cá nhân thì mở tunnel: <code className="rounded bg-muted px-1 py-0.5 font-mono">cloudflared tunnel --url http://localhost:3000</code> rồi đặt APP_URL bằng địa chỉ https nhận được.
          </>
        }
      >
        <div className="grid gap-5 lg:grid-cols-2">
          <WebhookGuide
            title="Pancake POS"
            url={pancakeWebhookUrl}
            configured={status.pancakeWebhook}
            received={webhookCount("PANCAKE")}
            warning={!status.pancakeWebhook ? "Đặt PANCAKE_WEBHOOK_SECRET trong .env (chuỗi ngẫu nhiên) rồi thay vào cuối URL." : null}
            steps={[
              "Đăng nhập Pancake POS → Cấu hình → Nâng cao → Kết nối bên thứ 3.",
              "Chọn Webhook/API → tab Webhook URL → bật Webhook.",
              "Dán URL bên trên vào ô Webhook URL.",
              "Tick các sự kiện: Đơn hàng / Khách hàng / Tồn kho (variations_warehouses).",
              "Bấm Lưu. Tạo thử một đơn trên Pancake và kiểm tra bảng “Webhook đã nhận” bên dưới.",
            ]}
          />
          <WebhookGuide
            title="Viettel Post"
            url={vtpWebhookUrl}
            configured={status.viettelPostWebhook}
            secret={{ value: canManageSettings ? env.viettelPost.webhookSecret : maskKey(env.viettelPost.webhookSecret), masked: !canManageSettings }}
            received={webhookCount("VIETTELPOST")}
            warning={!status.viettelPostWebhook ? "Đặt VIETTELPOST_WEBHOOK_SECRET trong .env — giá trị này chính là “Tham số bí mật” bạn khai báo với Viettel Post." : null}
            steps={[
              "Cách nhanh nhất khi vận đơn do Pancake tạo: Pancake → Cấu hình → Giao vận → Đối tác vận chuyển → VTP → “Cấu hình chuyển tiếp Webhook”, nhập URL bên trên kèm ?token=<Tham số bí mật> (Pancake không có ô secret riêng). Pancake sẽ chuyển tiếp mọi hành trình Viettel Post về ERP.",
              "Cách trực tiếp (khi tài khoản partner2 đã được Viettel Post cấp Mã đối tác và gắn mã khách hàng): đăng nhập partner2.viettelpost.vn bằng tài khoản đang tạo vận đơn.",
              "Vào Bảng điều khiển → Thông tin tài khoản → Cấu hình webhook: Webhook Endpoints = URL bên trên; Secret parameter = Tham số bí mật bên trên (sao chép nguyên văn). Bấm Kiểm tra kết nối (ERP trả HTTP 200 khi secret đúng) rồi Lưu.",
              "Gửi yêu cầu duyệt webhook cho Viettel Post (b2b@viettelpost.com.vn / 0862 235 888), kèm mã khách hàng và URL. Viettel Post chỉ đẩy dữ liệu sau khi duyệt.",
              "Kiểm tra: mở một vận đơn trong ERP → “Lịch sử đẩy webhook” / “Gửi lại webhook”, hoặc đợi vận đơn mới thay đổi trạng thái rồi xem bảng “Webhook đã nhận” bên dưới. ERP trả HTTP 200 ngay và xử lý nền theo yêu cầu của Viettel Post.",
              "Mỗi lần Viettel Post gọi tới, ERP cập nhật trạng thái vận đơn (mã ORDER_STATUS 100–515), tiền thu hộ, cước, lý do phát thất bại, tự tạo vận đơn chưa có, rồi chạy cảnh báo và cập nhật đơn Pancake liên quan.",
            ]}
          />
        </div>
      </SectionCard>

      {/* ───────── Đồng bộ thủ công ───────── */}
      <SectionCard
        title="Đồng bộ dữ liệu"
        description="Chạy từng job hoặc kéo toàn bộ lịch sử."
        hint="Chạy từng job hoặc kéo toàn bộ lịch sử. Mỗi job chỉ chạy một tiến trình tại một thời điểm; kết quả ghi vào Lịch sử đồng bộ."
        padded={false}
      >
        <div className="grid gap-4 border-b p-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)]">
          <div className="space-y-3">
            <div>
              <p className="text-sm font-semibold">Đồng bộ toàn bộ Pancake (lịch sử)</p>
              <p className="text-xs text-muted-foreground">Kho → sản phẩm → toàn bộ đơn trong N ngày → khách hàng → đổi trả → nhật ký kho. Có thể chạy lại để tiếp tục nếu bị gián đoạn.</p>
            </div>
            {canSync ? <BackfillForm defaultDays={backfillDays} running={backfillRunning} /> : <p className="text-xs text-muted-foreground">Bạn không có quyền chạy đồng bộ (cần vai trò Quản lý hoặc Quản trị).</p>}
          </div>
          <div className="rounded-lg border bg-muted/30 p-4 text-xs">
            <p className="font-semibold uppercase tracking-wide text-muted-foreground">Trạng thái đồng bộ</p>
            <dl className="mt-2 space-y-2">
              <div>
                <dt className="text-muted-foreground">Mốc cập nhật đơn (pancake.orders.updated_at.cursor)</dt>
                <dd className="font-medium">{cursor?.cursor ? `${formatDateTime(cursor.cursor)} · ${formatTimeAgo(cursor.cursor)}` : "Chưa có — lần đồng bộ đầu sẽ lấy 7 ngày gần nhất"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Đồng bộ lịch sử (pancake.orders.backfill)</dt>
                <dd className="font-medium">
                  {backfill?.nextStart ? (
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2">
                        {backfill.done ? <CheckCircle2 className="size-3.5 text-success" /> : backfillRunning ? <Loader2 className="size-3.5 animate-spin text-info" /> : <Clock3 className="size-3.5 text-amber-600" />}
                        <span>
                          {backfill.done ? `Hoàn tất ${formatNumber(backfill.days ?? 0)} ngày` : `${backfillRunning ? "Đang chạy" : "Tạm dừng"} · ${formatNumber(backfill.days ?? 0)} ngày · đã tới ${formatDate(backfill.nextStart)}`}
                          {backfill.finishedAt ? ` · ${formatTimeAgo(backfill.finishedAt)}` : ""}
                        </span>
                      </div>
                      {backfillProgress !== null ? <Progress value={backfillProgress} className="h-1.5" /> : null}
                    </div>
                  ) : (
                    "Chưa chạy đồng bộ lịch sử"
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Job đang chạy</dt>
                <dd className="font-medium">{running.length ? running.map((k) => <span key={k} className="mr-1 inline-flex items-center gap-1 rounded bg-sky-50 px-1.5 py-0.5 font-mono text-[10.5px] text-sky-700 dark:bg-sky-950/60 dark:text-sky-300"><Loader2 className="size-3 animate-spin" />{k}</span>) : "Không có"}</dd>
              </div>
            </dl>
          </div>
        </div>
        <div className="overflow-x-auto">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead>Job</TableHead>
                <TableHead>Nguồn</TableHead>
                <TableHead>Mô tả</TableHead>
                <TableHead>Trạng thái</TableHead>
                <TableHead className="text-right">Chạy</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(JOB_DEFINITIONS).map(([key, job]) => {
                const isRunning = (JOB_RUN_KEYS[key] ?? []).some((k) => running.includes(k)) || (key === "all" && running.length > 0);
                const disabled = (job.source === "PANCAKE" && !status.pancake) || (job.source === "VIETTELPOST" && !status.viettelPost);
                return (
                  <TableRow key={key}>
                    <TableCell>
                      <div className="font-semibold">{job.label}</div>
                      <div className="font-mono text-[10.5px] text-muted-foreground">/api/sync/{key}</div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs font-medium">{SYNC_SOURCE_LABEL[job.source] ?? job.source}</TableCell>
                    <TableCell className="max-w-[360px] text-xs text-muted-foreground">{job.description}</TableCell>
                    <TableCell>
                      {isRunning ? (
                        <span className="inline-flex items-center gap-1.5 rounded-md bg-sky-50 px-2 py-0.5 text-[11.5px] font-semibold text-sky-700 dark:bg-sky-950/60 dark:text-sky-300">
                          <Loader2 className="size-3 animate-spin" /> Đang chạy
                        </span>
                      ) : disabled ? (
                        <span className="text-xs text-muted-foreground">Chưa cấu hình</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">Sẵn sàng</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {!canSync ? null : disabled ? (
                        <Button variant="outline" size="sm" className="h-8" disabled>
                          <RefreshCw className="size-4" /> Chạy
                        </Button>
                      ) : (
                        <SyncButton job={key} label="Chạy" className="h-8" />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      {/* ───────── Lịch sử đồng bộ ───────── */}
      <SectionCard title="Lịch sử đồng bộ" description="Mỗi lần chạy job (thủ công, theo lịch hoặc do webhook) được ghi lại tại đây" padded={false}>
        <div className="space-y-3 p-4">
          <DataTableToolbar
            period={{ defaultKey: "7d" }}
            facets={[
              { key: "source", label: "Nguồn", options: runFacets.sources },
              { key: "status", label: "Kết quả", options: runFacets.statuses },
            ]}
            resultLabel={`${formatNumber(runs.total)} lần chạy`}
          />
          <SyncRunsTable rows={runs.rows} pageCount={runs.pageCount} total={runs.total} />
        </div>
      </SectionCard>

      {/* ───────── Webhook đã nhận ───────── */}
      <SectionCard title="Webhook đã nhận" description={`${formatNumber(webhooks.total)} sự kiện · hiển thị 30 sự kiện gần nhất · bấm vào dòng để xem dữ liệu JSON`} padded={false}>
        <div className="border-b p-4">
          <DataTableToolbar
            period={false}
            facets={[
              { key: "whSource", label: "Nguồn", options: webhooks.facets.sources },
              { key: "whStatus", label: "Trạng thái", options: webhooks.facets.statuses },
            ]}
          />
        </div>
        <WebhookEventsTable rows={webhooks.rows} />
      </SectionCard>

      {/* ───────── Scheduler ───────── */}
      <SectionCard title="Lịch đồng bộ tự động (scheduler)" description="Tiến trình chạy nền gọi các API đồng bộ theo chu kỳ."
 hint="Service “scheduler” (scripts/scheduler.mjs) chạy như một tiến trình riêng và gọi các API /api/sync/<job> theo chu kỳ cấu hình trong .env">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.7fr)]">
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Biến môi trường</TableHead>
                  <TableHead className="text-right">Chu kỳ</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scheduleRows.map((row) => (
                  <TableRow key={row.job}>
                    <TableCell>
                      <div className="text-sm font-medium">{JOB_DEFINITIONS[row.job]?.label ?? row.job}</div>
                      <div className="font-mono text-[10.5px] text-muted-foreground">{row.job}</div>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{row.envName}</TableCell>
                    <TableCell className="text-right text-sm font-semibold">mỗi {row.every} phút</TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell>
                    <div className="text-sm font-medium">Đối chiếu lại đơn gần đây</div>
                    <div className="font-mono text-[10.5px] text-muted-foreground">pancake-reconcile</div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">cố định</TableCell>
                  <TableCell className="text-right text-sm font-semibold">02:15 hằng ngày</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>
                    <div className="text-sm font-medium">Quét lại toàn bộ vận đơn Viettel Post</div>
                    <div className="font-mono text-[10.5px] text-muted-foreground">vtp-tracking?all=1&limit=2000</div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">cố định</TableCell>
                  <TableCell className="text-right text-sm font-semibold">03:00 hằng ngày</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>
                    <div className="text-sm font-medium">Danh sách kho</div>
                    <div className="font-mono text-[10.5px] text-muted-foreground">pancake-warehouses</div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">cố định</TableCell>
                  <TableCell className="text-right text-sm font-semibold">03:30 hằng ngày</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
          <div className="space-y-3 text-xs leading-5 text-muted-foreground">
            <p>
              Scheduler gọi ERP tại <span className="font-mono text-foreground">{process.env.ERP_INTERNAL_URL || "http://localhost:3000"}</span> (ERP_INTERNAL_URL) với header <span className="font-mono">x-cron-secret</span> = CRON_SECRET{env.cronSecret ? " (đã cấu hình)" : <span className="text-amber-600"> (chưa cấu hình — scheduler sẽ bị từ chối)</span>}.
            </p>
            <p>
              Khi chạy bằng Docker Compose, service <span className="font-mono text-foreground">scheduler</span> tự khởi động cùng ERP. Chạy thủ công: <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">npm run scheduler</code>.
            </p>
            <p>Đổi chu kỳ bằng cách sửa các biến SYNC_*_EVERY_MINUTES trong .env rồi khởi động lại service scheduler. Lịch chạy hằng ngày tính theo giờ Việt Nam.</p>
            <p>Webhook vẫn là nguồn cập nhật nhanh nhất; lịch đồng bộ chỉ để bù các sự kiện bị bỏ lỡ.</p>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

function ConnectionCard({ initials, tone, title, description, hint, configured, items, footer }: { initials: string; tone: string; title: string; description: string; hint?: React.ReactNode; configured: boolean; items: { label: string; value: React.ReactNode; span?: boolean }[]; footer: React.ReactNode }) {
  return (
    <SectionCard padded={false}>
      <div className="flex items-start gap-3 border-b px-5 py-4">
        <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl text-sm font-black text-white", tone)}>{initials}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-bold">{title}</h2>
            {hint ? <InfoHint>{hint}</InfoHint> : null}
            {configured ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-[11.5px] font-semibold text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                <CheckCircle2 className="size-3" /> Đã cấu hình
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-0.5 text-[11.5px] font-semibold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
                <XCircle className="size-3" /> Chưa cấu hình
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="p-5">
        <DescriptionList items={items} />
      </div>
      <div className="border-t px-5 py-4">{footer}</div>
    </SectionCard>
  );
}

function WebhookGuide({ title, url, configured, warning, steps, secret, received }: { title: string; url: string; configured: boolean; warning: string | null; steps: string[]; secret?: { value: string; masked: boolean } | null; received?: number }) {
  return (
    <div className="rounded-xl border bg-background p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-bold">{title}</p>
        <div className="flex items-center gap-2">
          {received === undefined ? null : received > 0 ? <span className="text-[11px] font-semibold text-success">Đã nhận {received} webhook</span> : <span className="text-[11px] font-semibold text-amber-600">Chưa nhận webhook nào</span>}
          {configured ? <span className="text-[11px] font-semibold text-success">Secret đã cấu hình</span> : <span className="text-[11px] font-semibold text-amber-600">Thiếu secret</span>}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1 rounded-lg border bg-muted/40 pl-3">
        <code className="min-w-0 flex-1 truncate py-2 font-mono text-[11.5px]">{url}</code>
        <CopyButton value={url} />
      </div>
      {secret ? (
        <div className="mt-2 flex items-center gap-1 rounded-lg border bg-muted/40 pl-3">
          <span className="shrink-0 text-[11px] text-muted-foreground">Tham số bí mật:</span>
          <code className="min-w-0 flex-1 truncate py-2 font-mono text-[11.5px]">{secret.value || "—"}</code>
          {secret.masked || !secret.value ? <span className="pr-2 text-[10.5px] text-muted-foreground">{secret.value ? "cần quyền Quản trị để xem đủ" : ""}</span> : <CopyButton value={secret.value} />}
        </div>
      ) : null}
      {warning ? <p className="mt-2 text-[11px] text-amber-600">{warning}</p> : null}
      {/* Hướng dẫn cấu hình là việc làm MỘT LẦN — cất sau dấu ⓘ để màn hình vận hành hằng ngày
          không bị lấp bởi sáu đoạn chữ. */}
      <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
        Hướng dẫn cấu hình ({steps.length} bước)
        <InfoHint label={`Hướng dẫn cấu hình webhook ${title}`}>
          <ol className="space-y-2">
            {steps.map((step, i) => (
              <li key={i} className="flex gap-2">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10.5px] font-bold text-foreground">{i + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </InfoHint>
      </p>
    </div>
  );
}

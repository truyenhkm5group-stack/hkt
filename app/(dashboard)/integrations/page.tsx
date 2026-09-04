import { AlertTriangle, CheckCircle2, Clock3, Globe, Loader2, RefreshCw, XCircle } from "lucide-react";
import { BackfillForm } from "@/app/(dashboard)/integrations/backfill-form";
import { SyncRunsTable } from "@/app/(dashboard)/integrations/sync-runs-table";
import { TestConnectionButton } from "@/app/(dashboard)/integrations/test-connection-button";
import { WebhookEventsTable } from "@/app/(dashboard)/integrations/webhook-events-table";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { CopyButton } from "@/components/misc";
import { PageHeader } from "@/components/page-header";
import { SyncButton } from "@/components/sync-button";
import { DescriptionList, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can, requireUser } from "@/lib/auth/session";
import { JOB_RUN_KEYS, SYNC_SOURCE_LABEL } from "@/lib/constants/sync";
import { env, integrationStatus } from "@/lib/env";
import { formatDate, formatDateTime, formatNumber, formatTimeAgo } from "@/lib/format";
import { getIntegrationTokenInfo, listRecentWebhooks, listSyncRuns, SYNC_RUN_SORTABLE, syncRunFacets } from "@/lib/queries/integrations";
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
  const user = await requireUser();
  const canSync = can(user.role, "sync:run");
  const status = integrationStatus();
  const running = runningJobKeys();
  const runParams = parseListParams(raw, { defaultSort: "startedAt", filterKeys: ["source", "status"], sortable: SYNC_RUN_SORTABLE, defaultPeriod: "7d" });
  const webhookFilters = { source: paramList(raw, "whSource"), status: paramList(raw, "whStatus") };

  const [vtpToken, cursor, backfill, runs, runFacets, webhooks] = await Promise.all([
    getIntegrationTokenInfo("viettelpost"),
    getSyncState<{ cursor: string }>("pancake.orders.updated_at.cursor"),
    getSyncState<BackfillState>("pancake.orders.backfill"),
    listSyncRuns(runParams),
    syncRunFacets(runParams),
    listRecentWebhooks(webhookFilters, 30),
  ]);

  const appUrl = env.appUrl;
  const pancakeWebhookUrl = `${appUrl}/api/webhooks/pancake/${env.pancake.webhookSecret || "<PANCAKE_WEBHOOK_SECRET>"}`;
  const vtpWebhookUrl = `${appUrl}/api/webhooks/viettelpost`;
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
            { label: "Tham số bí mật webhook", value: status.viettelPostWebhook ? <span className="font-mono">{maskKey(env.viettelPost.webhookSecret)}</span> : <span className="text-muted-foreground">Chưa đặt VIETTELPOST_WEBHOOK_SECRET</span> },
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
      </section>

      {/* ───────── Webhook ───────── */}
      <SectionCard title="Webhook — cập nhật thời gian thực" description="Dán các URL dưới đây vào Pancake và Viettel Post để ERP nhận thay đổi ngay lập tức, không cần chờ lịch đồng bộ">
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-info/30 bg-info/5 p-3 text-sm">
          <Globe className="mt-0.5 size-4 shrink-0 text-info" />
          <div className="text-xs leading-5 text-muted-foreground">
            <p>
              Webhook chỉ hoạt động khi ERP có <strong className="text-foreground">tên miền công khai HTTPS</strong> (APP_URL hiện tại: <span className="font-mono">{appUrl}</span>
              {isLocal ? <span className="text-amber-600"> — đang là localhost / http, Pancake và Viettel Post sẽ không gọi tới được</span> : null}).
            </p>
            <p>
              Khi chạy thử trên máy cá nhân, mở tunnel bằng ngrok hoặc cloudflared: <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">cloudflared tunnel --url http://localhost:3000</code> rồi đặt APP_URL bằng địa chỉ https nhận được.
            </p>
          </div>
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <WebhookGuide
            title="Pancake POS"
            url={pancakeWebhookUrl}
            configured={status.pancakeWebhook}
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
            warning={!status.viettelPostWebhook ? "Đặt VIETTELPOST_WEBHOOK_SECRET trong .env — giá trị này chính là “Tham số bí mật” bạn khai báo với Viettel Post." : null}
            steps={[
              "Đăng nhập partner.viettelpost.vn → Cấu hình tài khoản → Thông tin nhận hành trình.",
              "Nhập API URL = URL bên trên.",
              "Nhập Tham số bí mật = VIETTELPOST_WEBHOOK_SECRET trong .env (ERP dùng giá trị này để xác thực mỗi lần Viettel Post gọi tới).",
              "Bấm Cập nhật.",
              "Liên hệ Viettel Post (b2b@viettelpost.com.vn / 0862 235 888) để duyệt webhook cho tài khoản; sau khi duyệt, mọi thay đổi hành trình sẽ được đẩy về ERP.",
            ]}
          />
        </div>
      </SectionCard>

      {/* ───────── Đồng bộ thủ công ───────── */}
      <SectionCard
        title="Đồng bộ dữ liệu"
        description="Chạy từng job hoặc kéo toàn bộ lịch sử. Mỗi job chỉ chạy một tiến trình tại một thời điểm; kết quả ghi vào Lịch sử đồng bộ."
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
      <SectionCard title="Lịch đồng bộ tự động (scheduler)" description="Service “scheduler” (scripts/scheduler.mjs) chạy như một tiến trình riêng và gọi các API /api/sync/<job> theo chu kỳ cấu hình trong .env">
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

function ConnectionCard({ initials, tone, title, description, configured, items, footer }: { initials: string; tone: string; title: string; description: string; configured: boolean; items: { label: string; value: React.ReactNode; span?: boolean }[]; footer: React.ReactNode }) {
  return (
    <SectionCard padded={false}>
      <div className="flex items-start gap-3 border-b px-5 py-4">
        <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl text-sm font-black text-white", tone)}>{initials}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-bold">{title}</h2>
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

function WebhookGuide({ title, url, configured, warning, steps }: { title: string; url: string; configured: boolean; warning: string | null; steps: string[] }) {
  return (
    <div className="rounded-xl border bg-background p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-bold">{title}</p>
        {configured ? <span className="text-[11px] font-semibold text-success">Secret đã cấu hình</span> : <span className="text-[11px] font-semibold text-amber-600">Thiếu secret</span>}
      </div>
      <div className="mt-2 flex items-center gap-1 rounded-lg border bg-muted/40 pl-3">
        <code className="min-w-0 flex-1 truncate py-2 font-mono text-[11.5px]">{url}</code>
        <CopyButton value={url} />
      </div>
      {warning ? <p className="mt-2 text-[11px] text-amber-600">{warning}</p> : null}
      <ol className="mt-3 space-y-1.5 text-xs leading-5 text-muted-foreground">
        {steps.map((step, i) => (
          <li key={i} className="flex gap-2">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10.5px] font-bold text-foreground">{i + 1}</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

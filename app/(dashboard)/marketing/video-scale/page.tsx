import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { InfoHint } from "@/components/info-hint";
import { getDb } from "@/db";
import { can, requirePermission } from "@/lib/auth/session";
import { VIDEO_PRICE_SOURCE, VIDEO_PROVIDER_LABEL, fakeProviderAllowed, variantReserveUsd, type VideoScaleConfig } from "@/lib/constants/video-scale";
import { env } from "@/lib/env";
import { listJobs, listMusic, listPageConfigs, listPosts, listRuns, listVariants, listWinProducts, loadVideoScaleCounts, videoSpendOnDay } from "@/lib/queries/video-scale";
import { listAdAccountOptions, listFanpageOptions } from "@/lib/queries/creative-manual-gen";
import { readTokenPages } from "@/lib/queries/facebook-pages";
import { activeAdsDailyVnd, listAdActions, listAds } from "@/lib/queries/video-scale";
import { killRuleCount, templateAdIdFor } from "@/lib/video-scale/ads";
import { AdsPanel } from "./ads-panel";
import { getFbTokenScopes } from "@/lib/queries/fb-token-scopes";
import { adsWriteDisabledReason } from "@/lib/integrations/facebook/ads-write";
import { FB_PAGE_PUBLISH_SCOPES } from "@/lib/constants/video-scale";
import { readVideoAutomation } from "@/lib/video-scale/publish";
import { PublishPanel, type PublishReadiness } from "./publish-panel";
import { param, resolvePeriod, type SearchParams } from "@/lib/search-params";
import { getVideoScaleReport, modelComparison } from "@/lib/queries/video-scale";
import { getNominalProfitReport } from "@/lib/queries/profit-nominal";
import { NO_ORDER_VALUE_FILTER } from "@/lib/constants/order-value";
import { lastOptimizeAt } from "@/lib/video-scale/optimize";
import { ReportPanel, type SkuProfit } from "./report-panel";
import { cn } from "@/lib/utils";
import { ffmpegVersion } from "@/lib/video-scale/ffmpeg";
import { readVideoScaleConfig, videoScaleBlockers } from "@/lib/video-scale/pipeline";
import { ConfigPanel } from "./config-panel";
import { QueuePanel } from "./queue-panel";
import { ProgressPanel } from "./progress-panel";
import { AutoRefresh } from "./auto-refresh";
import { listRunProgress } from "@/lib/queries/video-scale";
import { ReviewPanel } from "./review-panel";
import { WinPanel } from "./win-panel";
import { ArrowRight, CircleAlert, Clapperboard, Hourglass, OctagonAlert, Sparkles } from "lucide-react";
import { nextVideoScaleStep, type NextStep } from "@/lib/constants/video-scale-next";

export const metadata = { title: "Video Scale" };

/** Năm BƯỚC theo đúng thứ tự làm việc (đánh số) + hai tab phụ sau vạch ngăn. Khoá tab giữ nguyên để link cũ vẫn mở đúng. */
const TABS = [
  { value: "ma-win", label: "① Mã win", step: true },
  { value: "hang-doi", label: "② Đang tạo", step: true },
  { value: "duyet", label: "③ Duyệt video", step: true },
  { value: "dang-reel", label: "④ Đăng Reel", step: true },
  { value: "quang-cao", label: "⑤ Quảng cáo", step: true },
  { value: "bao-cao", label: "Báo cáo", step: false },
  { value: "cau-hinh", label: "Cấu hình", step: false },
] as const;

const TONE: Record<NextStep["tone"], { box: string; icon: typeof Sparkles }> = {
  danger: { box: "border-destructive/60 bg-destructive/5", icon: OctagonAlert },
  warn: { box: "border-amber-500/60 bg-amber-500/5", icon: CircleAlert },
  action: { box: "border-primary/50 bg-primary/5", icon: Sparkles },
  wait: { box: "border-sky-500/50 bg-sky-500/5", icon: Hourglass },
  idle: { box: "border-border bg-muted/30", icon: Clapperboard },
};

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warn" }) {
  return (
    <div className={cn("bg-card px-3 py-1.5", tone === "warn" && "bg-amber-500/10")}>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="flex items-baseline gap-1.5">
        <span className="text-[15px] font-semibold tabular-nums">{value}</span>
        {sub ? <span className="truncate text-[11px] text-muted-foreground">{sub}</span> : null}
      </dd>
    </div>
  );
}

/**
 * VIDEO SCALE CHO MÃ WIN — từ ảnh sản phẩm thật tới video 9:16 đã duyệt. Đặc tả: `docs/video-scale.md`.
 * Tab mặc định: có video chờ duyệt ⇒ Duyệt video; còn việc đang chạy ⇒ Hàng đợi; không thì Mã win.
 */
export default async function VideoScalePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("ideas:view");
  const raw = await searchParams;
  const db = await getDb();
  // Fanpage = sổ fanpage (page từng ra đơn Pancake) GỘP page token ERP được giao — page mới share chưa ra đơn vẫn chọn được.
  const tokenPages = await readTokenPages();
  const [counts, cfg, ff, spend, automation, fanpages] = await Promise.all([loadVideoScaleCounts(db), readVideoScaleConfig(db), ffmpegVersion(), videoSpendOnDay(db), readVideoAutomation(db), listFanpageOptions(db, new Date(), "", tokenPages.pages)]);
  const pageName = new Map(fanpages.map((p) => [p.id, p.name]));
  const defaultTab = counts.review > 0 ? "duyet" : counts.activeJobs > 0 ? "hang-doi" : "ma-win";
  const tabRaw = param(raw, "tab");
  const tab = TABS.some((t) => t.value === tabRaw) ? tabRaw : defaultTab;
  const blockers = await videoScaleBlockers(cfg, ff);
  const canEdit = can(user, "ideas:write");
  const canSpend = canEdit && can(user, "expenses:write");
  const canConfig = can(user, "settings:manage");
  const canMode = canConfig || can(user, "expenses:write");
  const canEngage = canEdit || can(user, "expenses:write");
  const canRelease = can(user, "expenses:write") || canConfig;
  const canMoney = can(user, "expenses:write");
  const badge: Record<string, number> = { duyet: counts.review, "hang-doi": counts.activeJobs + counts.blockedJobs, "dang-reel": counts.approvedUnposted };
  const winProducts = await listWinProducts(db);
  const next = nextVideoScaleStep({ paused: automation.paused, blockers, blockedJobs: counts.blockedJobs, failedJobs24h: counts.failedJobs24h, review: counts.review, activeJobs: counts.activeJobs, approvedUnposted: counts.approvedUnposted, winProducts: winProducts.length, winWithPhotos: winProducts.filter((p) => p.photoCount > 0).length });
  const NextIcon = TONE[next.tone].icon;

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Marketing"
        title="Video Scale"
        description="Mã win → video 9:16 (clip + bảng màu) → duyệt → Reel → quảng cáo."
        hint={
          <>
            Video = cảnh clip mở đầu (từ ảnh sản phẩm thật) + đoạn bảng màu (ảnh thật từng màu của mã) + chữ, giọng đọc, nhạc có quyền, CTA → QC → duyệt. Máy chỉ nói điều có trong ERP (giá, màu, size đang bán, chính sách đã khai) — không bịa chất liệu hay khuyến mãi. Video bị QC loại không duyệt
            được. Tiền sinh video là <b>ước tính theo bảng giá công bố</b>: {VIDEO_PRICE_SOURCE} Đặc tả: <code>docs/video-scale.md</code>.
          </>
        }
      />

      {tokenPages.error ? (
        <p className="rounded-lg border border-amber-500/60 bg-amber-500/5 p-2.5 text-[12.5px]">
          Không đọc được danh sách fanpage của token ERP ({tokenPages.error}) — ô chọn fanpage chỉ còn page từng ra đơn trên Pancake.
        </p>
      ) : null}

      {/* VIỆC TIẾP THEO + SỐ LIỆU — MỘT khối (chủ shop 29/09/2026: "gọn gàng hơn"). */}
      <div className={cn("rounded-lg border", TONE[next.tone].box)}>
        <div className="flex flex-wrap items-center gap-3 p-3">
          <NextIcon className="size-5 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1 text-[14px] font-semibold">
              {next.title}
              {blockers.length > 1 ? (
                <InfoHint label="Mọi lý do chưa sinh được video">
                  <ul className="list-disc space-y-0.5 pl-4">
                    {blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </InfoHint>
              ) : null}
            </p>
            <p className="text-[12.5px] text-muted-foreground">
              {next.detail}
              {automation.paused && automation.reason ? ` Lý do dừng: ${automation.reason}.` : ""}
            </p>
          </div>
          {tab !== next.tab ? (
            <Link href={`?tab=${next.tab}`} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90">
              {next.cta} <ArrowRight className="size-4" aria-hidden />
            </Link>
          ) : null}
        </div>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-b-lg border-t bg-border text-[12px] sm:grid-cols-4">
          <Stat
            label="Chi hôm nay"
            value={`${spend.reservedUsd.toFixed(2)}${cfg.dailyUsdCap === null ? "" : ` / ${cfg.dailyUsdCap.toFixed(2)}`} USD`}
            sub={`${spend.clips} clip${cfg.dailyUsdCap === null ? " · chưa khai trần" : ""}`}
            tone={cfg.dailyUsdCap !== null && spend.reservedUsd >= cfg.dailyUsdCap * 0.9 ? "warn" : undefined}
          />
          <Stat label="Đang tạo" value={`${counts.activeJobs}`} sub={`${counts.blockedJobs} bị chặn · ${counts.failedJobs24h} hỏng 24h`} tone={counts.blockedJobs ? "warn" : undefined} />
          <Stat label="Chờ duyệt" value={`${counts.review}`} sub="video" />
          <Stat label="Chưa đăng" value={`${counts.approvedUnposted}`} sub={`video đã duyệt · ${winProducts.length} mã win`} />
        </dl>
      </div>
      {cfg.provider === "FAKE" && fakeProviderAllowed(process.env.NODE_ENV, env.videoScale.fakeProviderFlag) ? (
        <p className="rounded-lg border border-amber-500/60 bg-amber-500/10 px-2.5 py-1.5 text-[12.5px] font-medium">BỘ SINH GIẢ — mọi video là DỮ LIỆU THỬ, không đăng, không quảng cáo.</p>
      ) : null}

      <nav className="flex flex-wrap items-center gap-1.5 border-b pb-2" aria-label="Các bước Video Scale">
        {TABS.map((t, i) => [
          i > 0 && !t.step && TABS[i - 1].step ? <span key={`sep-${t.value}`} className="mx-1 h-5 w-px bg-border" aria-hidden /> : null,
          <Link
            key={t.value}
            href={`?tab=${t.value}`}
            className={cn("rounded-md px-3 py-1.5 text-[13px] font-medium", tab === t.value ? "bg-primary text-primary-foreground" : t.step ? "bg-muted hover:bg-muted/70" : "text-muted-foreground hover:bg-muted")}
            aria-current={tab === t.value ? "page" : undefined}
          >
            {t.label}
            {badge[t.value] ? <span className={cn("ml-1.5 rounded-full px-1.5 text-[11px] tabular-nums", tab === t.value ? "bg-background/30" : "bg-brand text-white")}>{badge[t.value]}</span> : null}
          </Link>,
        ])}
      </nav>

      {tab === "ma-win" ? (
        <WinPanel products={winProducts} runs={await listRuns(db)} music={(await listMusic(db)).filter((m) => m.active)} pages={fanpages} accounts={canMoney ? await listAdAccountOptions(db, new Date(), "") : []} canSpend={canSpend} canEdit={canEdit} canMode={canMode} canMoney={canMoney} canEngage={canEngage} canRelease={canRelease} perVideoUsd={variantReserveUsd(cfg)} costNote={costNoteOf(cfg)} introSeconds={cfg.scenesPerVariant * cfg.clipSeconds} />
      ) : tab === "hang-doi" ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px]">
              Kết quả: mỗi clip xem được ngay khi xong; video hoàn chỉnh hiện ở đây và ở tab <b>Duyệt video</b>.
            </p>
            <AutoRefresh active={counts.activeJobs > 0} />
          </div>
          <ProgressPanel runs={await listRunProgress(db)} now={new Date()} canEdit={canEdit} canSpend={canSpend} />
          <details className="rounded-lg border p-3">
            <summary className="cursor-pointer text-[13px] font-medium">Chi tiết kỹ thuật từng việc trong hàng đợi</summary>
            <div className="mt-3">
              <QueuePanel active={await listJobs(db, { active: true })} recent={await listJobs(db, { active: false, limit: 40 })} variants={await listVariants(db, { statuses: ["SCRIPTED", "GENERATING", "RENDERING", "QC", "FAILED", "QC_FAILED"], limit: 40 })} canEdit={canEdit} canSpend={canSpend} />
            </div>
          </details>
        </div>
      ) : tab === "duyet" ? (
        <ReviewPanel review={await listVariants(db, { statuses: ["REVIEW"] })} decided={await listVariants(db, { statuses: ["APPROVED", "REJECTED", "QC_FAILED"], limit: 24 })} pageOf={Object.fromEntries(winProducts.map((p) => [p.productId, p.pageId ? (pageName.get(p.pageId) ?? p.pageId) : null]))} canEdit={canEdit} canSpend={canSpend} music={(await listMusic(db)).filter((m) => m.active).map((m) => ({ id: m.id, title: m.title, assetId: m.assetId }))} />
      ) : tab === "quang-cao" ? (
        <AdsPanel ads={await listAds(db)} actions={await listAdActions(db)} activeVnd={await activeAdsDailyVnd(db)} globalCapVnd={cfg.adsGlobalDailyCapVnd} killRules={await killRuleCount(db)} templateAdId={await templateAdIdFor(db, cfg)} writeBlocked={adsWriteDisabledReason()} canSpend={canMoney} canPause={canEngage} />
      ) : tab === "bao-cao" ? (
        await reportTab(raw, canMoney || canConfig)
      ) : tab === "dang-reel" ? (
        <PublishPanel readiness={await publishReadiness()} automation={automation} pages={await listPageConfigs(db, fanpages)} posts={await listPosts(db)} canEngage={canEngage} canRelease={canRelease} canConfigure={canMode} canEdit={canEdit} />
      ) : (
        <ConfigPanel config={cfg} ffmpeg={ff} music={await listMusic(db)} canConfig={canConfig} canEdit={canEdit} canSpendAi={canMoney} />
      )}
    </div>
  );
}

/** Đường ghi Facebook có mở không + token có quyền đăng Reel không (hỏi Facebook, chỉ đọc; không hỏi được ⇒ CHƯA BIẾT). */
async function publishReadiness(): Promise<PublishReadiness> {
  const scopes = await getFbTokenScopes();
  const missing = FB_PAGE_PUBLISH_SCOPES.filter((s) => !scopes.granted.includes(s));
  return {
    writeBlocked: adsWriteDisabledReason(),
    scopes: { state: scopes.state === "UNKNOWN" ? "UNKNOWN" : missing.length ? "MISSING" : "READY", missing, reason: scopes.reason },
  };
}

const REPORT_PERIODS = [
  { key: "7d", label: "7 ngày" },
  { key: "30d", label: "30 ngày" },
  { key: "90d", label: "90 ngày" },
] as const;

/**
 * Tab Báo cáo. Lợi nhuận của MÃ đọc từ ĐÚNG công thức của Báo cáo lợi nhuận danh nghĩa (không tính lại ở đây); tắt đọc tồn
 * kho vì tab này không in tồn.
 */
async function reportTab(raw: SearchParams, canOptimize: boolean) {
  const db = await getDb();
  const key = REPORT_PERIODS.some((p) => p.key === param(raw, "period")) ? param(raw, "period") : "30d";
  const period = resolvePeriod({ period: key }, "30d");
  const includeTest = param(raw, "test") === "1";
  const [skus, nominal, beat, models] = await Promise.all([getVideoScaleReport(db, { includeTest }), getNominalProfitReport(period, "ORDERED", NO_ORDER_VALUE_FILTER, true, false, false), lastOptimizeAt(db), modelComparison(db)]);
  const ids = new Set(skus.map((s) => s.productId));
  const profit: Record<string, SkuProfit> = {};
  for (const r of nominal.rows) {
    if (ids.has(r.productId)) profit[r.productId] = { expectedProfit: r.expectedProfit, margin: r.margin, adSpend: r.adSpend, orders: r.orders, delivered: r.delivered };
  }
  return (
    <ReportPanel
      skus={skus}
      profit={profit}
      periodLabel={period.label.toLowerCase()}
      periods={REPORT_PERIODS.map((p) => ({ key: p.key, label: p.label, active: p.key === key }))}
      includeTest={includeTest}
      lastOptimizeAt={beat}
      canOptimize={canOptimize}
      models={models}
    />
  );
}

/** Câu cấu hình đang áp cho lượt mới — người bấm "Tạo" biết mình đang trả cho cái gì. */
function costNoteOf(cfg: VideoScaleConfig): string {
  const ai = cfg.aiScenes === null ? cfg.scenesPerVariant : Math.min(cfg.aiScenes, cfg.scenesPerVariant);
  return `${VIDEO_PROVIDER_LABEL[cfg.provider]} · ${cfg.model} · ${cfg.scenesPerVariant} cảnh / video, ${ai} cảnh AI${ai < cfg.scenesPerVariant ? `, ${cfg.scenesPerVariant - ai} cảnh ảnh động (miễn phí)` : ""}. Đổi ở tab Cấu hình.`;
}


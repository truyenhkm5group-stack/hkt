import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getDb } from "@/db";
import { can, requirePermission } from "@/lib/auth/session";
import { VIDEO_PRICE_SOURCE, fakeProviderAllowed } from "@/lib/constants/video-scale";
import { env } from "@/lib/env";
import { listJobs, listMusic, listPageConfigs, listPosts, listRuns, listVariants, listWinProducts, loadVideoScaleCounts, videoSpendOnDay } from "@/lib/queries/video-scale";
import { listFanpageOptions } from "@/lib/queries/creative-manual-gen";
import { getFbTokenScopes } from "@/lib/queries/fb-token-scopes";
import { adsWriteDisabledReason } from "@/lib/integrations/facebook/ads-write";
import { FB_PAGE_PUBLISH_SCOPES } from "@/lib/constants/video-scale";
import { readVideoAutomation } from "@/lib/video-scale/publish";
import { PublishPanel, type PublishReadiness } from "./publish-panel";
import { param, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { ffmpegVersion } from "@/lib/video-scale/ffmpeg";
import { readVideoScaleConfig, videoScaleBlockers } from "@/lib/video-scale/pipeline";
import { ConfigPanel } from "./config-panel";
import { QueuePanel } from "./queue-panel";
import { ReviewPanel } from "./review-panel";
import { WinPanel } from "./win-panel";

export const metadata = { title: "Video Scale" };

const TABS = [
  { value: "ma-win", label: "Mã win" },
  { value: "hang-doi", label: "Hàng đợi render" },
  { value: "duyet", label: "Duyệt video" },
  { value: "dang-reel", label: "Đăng Reel" },
  { value: "cau-hinh", label: "Cấu hình" },
] as const;

/**
 * VIDEO SCALE CHO MÃ WIN — từ ảnh sản phẩm thật tới video 9:16 đã duyệt. Đặc tả: `docs/video-scale.md`.
 * Tab mặc định: có video chờ duyệt ⇒ Duyệt video; còn việc đang chạy ⇒ Hàng đợi; không thì Mã win.
 */
export default async function VideoScalePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("ideas:view");
  const raw = await searchParams;
  const db = await getDb();
  const [counts, cfg, ff, spend, automation, fanpages] = await Promise.all([loadVideoScaleCounts(db), readVideoScaleConfig(db), ffmpegVersion(), videoSpendOnDay(db), readVideoAutomation(db), listFanpageOptions(db, new Date(), "")]);
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
  const badge: Record<string, number> = { duyet: counts.review, "hang-doi": counts.activeJobs + counts.blockedJobs };

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Marketing"
        title="Video Scale"
        description="Mã win + ảnh sản phẩm thật → kịch bản theo góc bán → clip Veo 9:16 → hậu kỳ (chữ, giọng đọc, nhạc có quyền, CTA) → QC → duyệt."
        hint={
          <>
            Máy chỉ nói điều có trong ERP (giá, màu, size đang bán, chính sách đã khai) — không bịa chất liệu hay khuyến mãi. Video bị QC loại không duyệt
            được. Tiền sinh video là <b>ước tính theo bảng giá công bố</b>: {VIDEO_PRICE_SOURCE} Đặc tả: <code>docs/video-scale.md</code>.
          </>
        }
      />

      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg border p-3 text-[13px]">
          <p className="text-muted-foreground">Chi sinh video hôm nay ({spend.day})</p>
          <p className="text-lg font-semibold tabular-nums">
            {spend.reservedUsd.toFixed(2)} USD <span className="text-sm font-normal text-muted-foreground">/ {cfg.dailyUsdCap === null ? "chưa khai trần" : `${cfg.dailyUsdCap.toFixed(2)} USD`}</span>
          </p>
          <p className="text-[12px] text-muted-foreground">
            {spend.clips} clip · {spend.estimatedUsd.toFixed(2)} USD của clip đã xong (giữ chỗ gồm cả lượt hỏng)
          </p>
        </div>
        <div className="rounded-lg border p-3 text-[13px]">
          <p className="text-muted-foreground">Hàng đợi</p>
          <p className="text-lg font-semibold tabular-nums">
            {counts.activeJobs} đang chạy · {counts.blockedJobs} bị chặn
          </p>
          <p className="text-[12px] text-muted-foreground">{counts.failedJobs24h} việc hỏng trong 24 giờ</p>
        </div>
        <div className={cn("rounded-lg border p-3 text-[13px]", blockers.length ? "border-amber-500/60 bg-amber-500/5" : "")}>
          <p className="text-muted-foreground">Sẵn sàng sinh video thật?</p>
          {blockers.length ? (
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12.5px]">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          ) : (
            <p className="text-lg font-semibold">Sẵn sàng</p>
          )}
          {cfg.provider === "FAKE" && fakeProviderAllowed(process.env.NODE_ENV, env.videoScale.fakeProviderFlag) ? (
            <p className="mt-1 rounded bg-amber-500/15 px-2 py-1 text-[12px] font-medium">BỘ SINH GIẢ — mọi video là DỮ LIỆU THỬ, không đăng, không quảng cáo.</p>
          ) : null}
        </div>
      </div>

      {automation.paused ? (
        <p className="rounded-lg border border-destructive/60 bg-destructive/5 p-2 text-[13px] font-medium">
          Video Scale đang DỪNG mọi tự động (không đăng Reel, không tạo / bật quảng cáo){automation.reason ? ` — ${automation.reason}` : ""}. Mở lại ở tab Đăng Reel.
        </p>
      ) : null}

      <nav className="flex flex-wrap gap-1.5 border-b pb-2" aria-label="Các bước Video Scale">
        {TABS.map((t) => (
          <Link
            key={t.value}
            href={`?tab=${t.value}`}
            className={cn("rounded-md px-3 py-1.5 text-[13px] font-medium", tab === t.value ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-muted/70")}
            aria-current={tab === t.value ? "page" : undefined}
          >
            {t.label}
            {badge[t.value] ? <span className="ml-1.5 rounded-full bg-background/30 px-1.5 text-[11px] tabular-nums">{badge[t.value]}</span> : null}
          </Link>
        ))}
      </nav>

      {tab === "ma-win" ? (
        <WinPanel products={await listWinProducts(db)} runs={await listRuns(db)} music={(await listMusic(db)).filter((m) => m.active)} pages={fanpages} canSpend={canSpend} canEdit={canEdit} canMode={canMode} canEngage={canEngage} canRelease={canRelease} />
      ) : tab === "hang-doi" ? (
        <QueuePanel active={await listJobs(db, { active: true })} recent={await listJobs(db, { active: false, limit: 40 })} variants={await listVariants(db, { statuses: ["SCRIPTED", "GENERATING", "RENDERING", "QC", "FAILED", "QC_FAILED"], limit: 40 })} canEdit={canEdit} canSpend={canSpend} />
      ) : tab === "duyet" ? (
        <ReviewPanel review={await listVariants(db, { statuses: ["REVIEW"] })} decided={await listVariants(db, { statuses: ["APPROVED", "REJECTED", "QC_FAILED"], limit: 24 })} pageOf={Object.fromEntries((await listWinProducts(db)).map((p) => [p.productId, p.pageId ? (pageName.get(p.pageId) ?? p.pageId) : null]))} canEdit={canEdit} canSpend={canSpend} />
      ) : tab === "dang-reel" ? (
        <PublishPanel readiness={await publishReadiness()} automation={automation} pages={await listPageConfigs(db, fanpages)} posts={await listPosts(db)} canEngage={canEngage} canRelease={canRelease} canConfigure={canMode} canEdit={canEdit} />
      ) : (
        <ConfigPanel config={cfg} ffmpeg={ff} music={await listMusic(db)} canConfig={canConfig} canEdit={canEdit} />
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

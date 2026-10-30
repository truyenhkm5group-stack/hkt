import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { decideScope } from "@/lib/auth/scope-guard";
import { can, requirePermission } from "@/lib/auth/session";
import { openActiveConnection } from "@/lib/connectors/service";
import { formatDate, formatNumber } from "@/lib/format";
import { apiUsageSummary, campaignProgressList, type CampaignProgress } from "@/lib/queries/wholesale";
import { activityLog } from "@/lib/queries/wholesale-activity";
import { provinceScanTier, SEARCH_PROVINCES, scanTier, type SearchProvince } from "@/lib/wholesale/areas";
import { INTL_SEARCH_PROVINCES } from "@/lib/wholesale/areas-intl";
import { ALL_KEYWORD_GROUPS } from "@/lib/wholesale/keywords-intl";
import { campaignCostEstimate, ensureTemplateCampaign, hslcTemplateValues, intlPilotTemplateValues, vietKieuTemplateValues } from "@/lib/wholesale/campaigns";
import { microsToVnd, type DiscoveryTier, type LeadHunterConfig } from "@/lib/wholesale/config";
import { PAUSE_REASON_LABEL, type PauseReason } from "@/lib/wholesale/constants";
import { runProgress } from "@/lib/wholesale/run-progress";
import type { LeadSegment } from "@/lib/wholesale/segments";
import { getLeadHunterConfig } from "@/lib/wholesale/store";
import { GoogleAttribution, WholesaleNav } from "@/app/(dashboard)/wholesale/wholesale-nav";
import { ActivityLog, ProgressCard, ResultTiles } from "@/app/(dashboard)/wholesale/run-widgets";
import { AutoRefresh } from "@/app/(dashboard)/wholesale/lead-hunter/auto-refresh";
import { CampaignStateButtons } from "@/app/(dashboard)/wholesale/lead-hunter/campaign-card";
import { CampaignTable } from "@/app/(dashboard)/wholesale/lead-hunter/campaign-table";
import { StartScan, type StartPreset } from "@/app/(dashboard)/wholesale/lead-hunter/start-scan";

export const metadata = { title: "Săn khách sỉ" };

const DOCS_URL = "https://github.com/truyenhkm5group-stack/hkt/blob/main/docs/verticals/wholesale-lead-hunter.md";

function usd(micros: number): string {
  return `${(micros / 1_000_000).toLocaleString("vi-VN", { maximumFractionDigits: 2 })} US$`;
}

type TemplateValues = { name: string; productFocus: string; provinces: SearchProvince[]; keywordGroups: { key: string; enabled: boolean }[]; excludeKeywords: string[]; targetSegments: LeadSegment[]; maxLeads: number; requirePhone: boolean; requireWebsite: boolean; discoveryTier: DiscoveryTier; searchMode: "TEXT" };

/** Mẫu chiến dịch ⇒ thẻ «Bắt đầu quét mới»: giá trị mặc định của form + ước tính chi phí của phạm vi mẫu. */
function preset(key: StartPreset["key"], title: string, subtitle: string, v: TemplateValues, focus: "DOMESTIC" | "INTL", cfg: LeadHunterConfig, tier: DiscoveryTier): StartPreset {
  const e = campaignCostEstimate({ ...v, discoveryTier: tier, nearbyLat: null, nearbyLng: null, radiusM: null }, cfg);
  return {
    key,
    title,
    subtitle,
    estimate: `${formatNumber(e.cellsToScan)} truy vấn · ${usd(e.minMicros)}–${usd(e.maxMicros)}`,
    defaults: {
      name: `${v.name} · ${formatDate(new Date())}`,
      productFocus: v.productFocus,
      excludeKeywords: v.excludeKeywords.join(", "),
      targetSegments: [...v.targetSegments],
      maxLeads: v.maxLeads,
      discoveryTier: tier,
      focus,
      selProv: v.provinces.map((p) => p.key),
      areas: Object.fromEntries(v.provinces.map((p) => [p.key, p.areas.map((a) => a.code)])),
      groups: Object.fromEntries(v.keywordGroups.map((g) => [g.key, g.enabled])),
      requirePhone: v.requirePhone,
      requireWebsite: v.requireWebsite,
    },
  };
}

function RunningCampaign({ c, usdToVnd }: { c: CampaignProgress; usdToVnd: number }) {
  const done = c.cellsDone + c.cellsFresh + c.cellsFailed;
  const skipped = Math.max(0, c.filtered) + c.duplicatesRemoved;
  const p = runProgress({ success: c.newLeads, failed: c.cellsFailed, skipped, pending: c.cellsPending, processed: done, startedAt: c.startedAt });
  return (
    <div className="space-y-2 rounded-xl border p-2">
      <ProgressCard
        title={
          <>
            {c.name} <span className="font-normal text-muted-foreground">· {c.market}</span>
          </>
        }
        p={p}
        unit="ô quét"
        note={c.status === "PAUSED" ? `Tạm dừng: ${PAUSE_REASON_LABEL[c.pauseReason as PauseReason] ?? c.pauseReason ?? "bấm Tiếp tục"}` : `${formatNumber(c.newLeads)} lead · ${formatNumber(c.withEmail)} có email · ${usd(c.costMicros)} (≈ ${formatNumber(Math.round((c.costMicros / 1e6) * usdToVnd))} ₫)`}
        actions={<CampaignStateButtons c={c} />}
      />
      <ResultTiles
        ok={{ label: "Lead nhận", value: c.newLeads, of: c.uniquePlaces, hint: "trên số địa điểm khác nhau đã thấy" }}
        fail={{ label: "Ô lỗi API", value: c.cellsFailed, of: c.cells, hint: "trên tổng ô của chiến dịch" }}
        skip={{ label: "Lọc bỏ / trùng", value: skipped, of: c.uniquePlaces, hint: "đóng cửa · sai nhóm · từ khoá loại trừ · chuỗi · trùng · đã chặn" }}
      />
    </div>
  );
}

export default async function LeadHunterPage() {
  const user = await requirePermission("wholesale:scan");
  // Dựng mẫu HSLC nếu chưa có (idempotent). CSDL chỉ đọc / lỗi ghi không được làm hỏng trang.
  await ensureTemplateCampaign().catch(() => undefined);
  const cfg = await getLeadHunterConfig();
  const decision = await decideScope("WHOLESALE_LEADS", user);
  const [campaigns, usage, conn, log] = await Promise.all([campaignProgressList(cfg), apiUsageSummary(), openActiveConnection("google-places"), decision.allow === "NONE" ? Promise.resolve([]) : activityLog(decision, ["DISCOVERED", "ENRICHED"], 20)]);
  const live = campaigns.filter((c) => !c.isTemplate && (c.status === "RUNNING" || c.status === "PAUSED"));
  const vnd = (m: number) => {
    const v = microsToVnd(m, cfg.usdToVnd);
    return v == null ? "—" : `≈ ${formatNumber(v)} ₫`;
  };
  const presets: StartPreset[] = [
    preset("domestic", "Khách sỉ trong nước", "Nhà hàng · quán · khách sạn · cửa hàng thực phẩm — 34 tỉnh / thành, nhắn Zalo.", { ...hslcTemplateValues(1, cfg.scanPriority), requirePhone: true, requireWebsite: false }, "DOMESTIC", cfg, cfg.discoveryTier),
    preset("viet-kieu", "Việt Kiều ở nước ngoài", "Cửa hàng / chợ / nhà phân phối thực phẩm Việt — 9 nước đông người Việt, tìm email qua website.", vietKieuTemplateValues(), "INTL", cfg, "ENTERPRISE"),
    preset("importers", "Nhà nhập khẩu / phân phối nước ngoài", "Nhập khẩu · bán sỉ hải sản và thực phẩm châu Á — mẫu thử Singapore · Kuala Lumpur · Sydney · Melbourne.", intlPilotTemplateValues(), "INTL", cfg, "ENTERPRISE"),
  ];
  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Săn khách sỉ"
        title="Săn khách"
        description={
          <>
            Tìm khách sỉ trên Google Maps theo từ khoá × khu vực, chạy nền và tự dừng ở trần chi phí; lead chỉ vào hàng đợi liên hệ khi người duyệt.{" "}
            <a href={DOCS_URL} target="_blank" rel="noreferrer" className="underline">
              Cách hoạt động
            </a>
          </>
        }
        actions={<AutoRefresh active={live.some((c) => c.status === "RUNNING")} seconds={10} />}
      />
      <WholesaleNav user={user} active="hunter" />

      {!conn.ok ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <b>Chưa bật kết nối Google Places.</b> {conn.reason} — vào <Link className="underline" href="/settings/connections">Cài đặt → Kết nối</Link>, mục «Google Places (tìm doanh nghiệp)», dán khoá API, bấm Kiểm tra rồi Bật. Chưa có kết nối thì chiến dịch bắt đầu được nhưng sẽ tự tạm dừng ở lượt quét đầu tiên. Nhập tệp CSV (trang Khách tiềm năng) vẫn dùng được.
        </div>
      ) : null}

      <SectionCard id="dang-quet" title="Đang quét" description="Chiến dịch đang chạy hoặc tạm dừng — tiến độ ô, kết quả và nút điều khiển.">
        <div className="space-y-3">
          {live.length ? (
            live.map((c) => <RunningCampaign key={c.id} c={c} usdToVnd={cfg.usdToVnd} />)
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed p-3 text-sm">
              <span className="text-muted-foreground">Không có chiến dịch nào đang quét.</span>
              <Button size="sm" asChild>
                <a href="#bat-dau">Bắt đầu quét mới</a>
              </Button>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            Chi phí API hôm nay {usd(usage.todayMicros)} ({vnd(usage.todayMicros)}) · tháng này {usd(usage.monthMicros)} · {formatNumber(usage.callsToday)} lượt gọi · {formatNumber(usage.errorsToday)} lỗi hôm nay
            {can(user, "wholesale:config") ? (
              <>
                {" "}— trần & chi tiết ở{" "}
                <Link href="/wholesale/settings" className="underline">
                  Cấu hình & chi phí
                </Link>
              </>
            ) : null}
            .
          </p>
        </div>
      </SectionCard>

      <SectionCard id="bat-dau" title="Bắt đầu quét mới" description="Chọn một mẫu — form ba bước: khu vực → xem trước số truy vấn và chi phí → lưu nháp hoặc bắt đầu.">
        <StartScan
          presets={presets}
          form={{
            provinces: SEARCH_PROVINCES.map((p) => ({ key: p.key, label: p.label, tier: provinceScanTier(p, cfg.scanPriority), areas: p.areas.map((a) => ({ code: a.code, name: a.name, tier: scanTier(p.key, a, cfg.scanPriority) })) })),
            intlCountries: INTL_SEARCH_PROVINCES.map((p) => ({ key: p.key, label: p.label, areas: p.areas.map((a) => ({ code: a.code, name: a.name })) })),
            keywordGroups: ALL_KEYWORD_GROUPS.map((g) => ({ key: g.key, label: g.label, keywords: [...g.keywords], enabled: g.enabled, lang: g.lang ?? null })),
          }}
        />
      </SectionCard>

      <SectionCard title="Chiến dịch" description="Mẫu, nháp, đang chạy và đã xong — bấm một dòng để mở chi tiết (Dùng mẫu · Bắt đầu quét · Nhân bản · Xem lead). Mẫu KHÔNG tự chạy.">
        <CampaignTable rows={campaigns} usdToVnd={cfg.usdToVnd} />
      </SectionCard>

      <SectionCard title="Nhật ký quét" description="Lead vừa tìm thấy / vừa đọc website — mới nhất trên cùng. SĐT và email đã che.">
        <ActivityLog rows={log} empty="Chưa có lead nào được tìm thấy." />
        <GoogleAttribution className="mt-2 block" />
      </SectionCard>
    </div>
  );
}

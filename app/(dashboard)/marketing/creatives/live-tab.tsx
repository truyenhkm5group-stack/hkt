import { Download } from "lucide-react";
import { AdsKillSwitchCard } from "@/app/(dashboard)/marketing/creatives/kill-switch";
import { LiveTable } from "@/app/(dashboard)/marketing/creatives/live-table";
import type { RepublishSource } from "@/app/(dashboard)/marketing/creatives/manual-gen";
import { ScalePanel } from "@/app/(dashboard)/marketing/creatives/scale-panel";
import { DataTableToolbar, type FacetDef } from "@/components/data-table/toolbar";
import { InfoHint } from "@/components/info-hint";
import { StatStrip } from "@/components/stat-tile";
import { SyncButton } from "@/components/sync-button";
import { getDb } from "@/db";
import { LIVE_BOARD_DEFAULT_PERIOD, LIVE_BOARD_PARAMS, LIVE_STATES, LIVE_STATE_LABEL } from "@/lib/constants/creative-live-board";
import { CREATIVE_VERDICT_LABEL, SLOT_MODE_LABEL, type CreativeVerdict, type SlotMode } from "@/lib/constants/creative-loop";
import { REPUBLISHABLE_STATUSES } from "@/lib/creative/manual-gen";
import { formatNumber, formatVND, vnShortStamp } from "@/lib/format";
import { readAdsKillSwitch } from "@/lib/integrations/facebook/ads-write";
import { loadLiveBoard, parseLiveBoardQuery } from "@/lib/queries/creative-live-board";
import { loadRepublishCtx } from "@/lib/queries/creative-manual-gen";
import { hrefWith, searchParamsQuery, type SearchParams } from "@/lib/search-params";

/**
 * ═══════════ TAB ④ ĐANG CHẠY — BẢNG ĐIỀU KHIỂN CAMP ═══════════
 *
 * Thiết kế lại 30/09/2026 (chủ shop: "dễ quản lý hơn, tên campaign sync với trình quản lý quảng cáo, bộ lọc ngày
 * tháng, tìm kiếm"). Thứ tự trên màn hình = thứ tự người quản lý hỏi:
 *   1. lọc gì (tìm · kỳ · trạng thái · phán quyết · mã SP · kiểu mẫu) — mọi bộ lọc nằm trên URL, gửi link là gửi đúng góc nhìn;
 *   2. tổng của tập đang lọc — ô nào bấm được thì bấm là lọc ngay theo nó;
 *   3. bảng camp (tên như Ads Manager gọi, bấm mở đúng camp; chọn nhiều ⇒ tắt hàng loạt / chép tên + ID);
 *   4. scale mẫu thắng — việc của camp đã có kết luận, đứng SAU bảng.
 * Công tắc khẩn cấp thu về một dòng khi chưa kéo.
 *
 * Số đo trong bảng là số TRONG KỲ; phán quyết là của TOÀN ĐỜI camp (`lib/constants/creative-live-board.ts`, luật 2).
 */

const FACET_KEYS: string[] = Object.values(LIVE_BOARD_PARAMS);

/** `canRepublish` = soạn bài VÀ duyệt chi (ideas:write + expenses:write) — "Đăng lại camp" là một lượt chi mới. */
export async function LiveTab({
  raw,
  canWrite,
  canKill,
  canRelease,
  canRepublish = false,
  canSync = false,
}: {
  raw: SearchParams;
  canWrite: boolean;
  canKill: boolean;
  canRelease: boolean;
  canRepublish?: boolean;
  canSync?: boolean;
}) {
  const db = await getDb();
  const now = new Date();
  const q = parseLiveBoardQuery(raw);
  const [data, kill] = await Promise.all([loadLiveBoard(db, now, q), readAdsKillSwitch()]);

  // "Đăng lại camp" (chủ shop 29/09/2026: scale mẫu sang TKQC / fanpage khác) — bộ đồ nghề chỉ đọc khi người xem bấm được, và chỉ cho dòng của TRANG đang xem.
  const eligible = canRepublish ? data.rows.filter((r) => r.imageAvailable && (REPUBLISHABLE_STATUSES as readonly string[]).includes(r.status)) : [];
  const rp = eligible.length ? await loadRepublishCtx(db, now, eligible.map((r) => r.productId).filter((x): x is string => !!x)) : null;
  const sources: Record<string, RepublishSource> = {};
  if (rp) {
    for (const r of eligible) {
      const v = data.judged.get(r.id);
      if (!v) continue;
      sources[r.id] = { id: v.id, slot: v.slot, headline: v.headline, primaryText: v.primaryText, imageId: v.imageId, imageAvailable: v.imageAvailable, videoAssetId: v.videoAssetId, productId: v.productId, productName: v.productName, designDna: v.design?.dna ?? null, campaignName: v.campaignName };
    }
  }

  const facets: FacetDef[] = [
    { key: LIVE_BOARD_PARAMS.state, label: "Trạng thái", options: LIVE_STATES.filter((st) => data.facets.states[st] > 0).map((st) => ({ value: st, label: LIVE_STATE_LABEL[st], count: data.facets.states[st] })) },
    {
      key: LIVE_BOARD_PARAMS.verdict,
      label: "Phán quyết",
      options: (Object.entries(data.facets.verdicts) as [CreativeVerdict, number][]).map(([v, n]) => ({ value: v, label: CREATIVE_VERDICT_LABEL[v], count: n })),
    },
    { key: LIVE_BOARD_PARAMS.product, label: "Sản phẩm", options: data.facets.products },
    { key: LIVE_BOARD_PARAMS.mode, label: "Kiểu mẫu", options: (Object.entries(data.facets.modes) as [SlotMode, number][]).map(([m, n]) => ({ value: m, label: SLOT_MODE_LABEL[m], count: n })) },
  ].filter((f) => f.options.length > 0);

  // Ô tổng hợp bấm để lọc: giữ nguyên kỳ + tìm kiếm, THAY bộ lọc cùng khoá, về trang 1.
  const locTheo = (key: string, value: string) => hrefWith({ ...raw, page: undefined }, key, value);
  const s = data.summary;
  const fbAge = data.fbSyncedAt ? Math.round((now.getTime() - new Date(data.fbSyncedAt).getTime()) / 60_000) : null;

  return (
    <div className="space-y-3">
      <AdsKillSwitchCard state={kill} canEngage={canKill} canRelease={canRelease} compact />

      <DataTableToolbar
        searchPlaceholder="Tìm tên chiến dịch, mã SP, ID…"
        period={{ defaultKey: LIVE_BOARD_DEFAULT_PERIOD }}
        facets={facets}
        extraResetKeys={FACET_KEYS.filter((k) => !facets.some((f) => f.key === k))}
        resultLabel={
          <span className="inline-flex flex-wrap items-center gap-x-1.5">
            <span>
              {formatNumber(data.total)} / {formatNumber(data.periodTotal)} camp · {data.windowed ? `số đo trong kỳ “${q.period.label}”` : "số đo toàn đời camp"} · phán quyết tính trên toàn đời camp
            </span>
            <InfoHint>
              Camp hiện trong kỳ = camp ĐÃ CHẠY trong kỳ: bắt đầu trước cuối kỳ và (còn đang chạy · tắt / hết khung sau đầu kỳ · có chi trong kỳ). Camp đang chạy luôn hiện khi kỳ chứa
              hôm nay, kể cả camp hẹn giờ chưa tới giờ. Chi · hiển thị · nhấp · tin nhắn đọc từ dòng chi hạt AD theo ngày chi; đơn theo ngày lên đơn, quy về mẩu bằng ad_id Pancake
              gửi hoặc qua bài viết (có thể đếm THIẾU ~1/4). Phán quyết và luật tắt luôn đọc số đo TOÀN ĐỜI camp — đổi kỳ không đổi phán quyết. Tên chiến dịch đọc từ lượt đồng
              bộ chi tiêu Facebook gần nhất; đổi tên trên Ads Manager thì ERP thấy ở lượt kế tiếp. Tìm kiếm không phân biệt dấu, khớp cả tên ERP đặt lúc đăng.
            </InfoHint>
            <span aria-hidden>·</span>
            <span
              title={data.fbSyncedAt ? `Lượt đồng bộ chi tiêu Facebook thành công gần nhất: ${vnShortStamp(data.fbSyncedAt)}` : "Chưa có lượt đồng bộ chi tiêu Facebook thành công nào"}
              className={fbAge === null || fbAge > 180 ? "font-medium text-destructive" : undefined}
            >
              {data.fbSyncedAt ? `Facebook đồng bộ lúc ${vnShortStamp(data.fbSyncedAt)}${fbAge !== null ? ` (${fbAge < 60 ? `${fbAge} phút` : `${Math.round(fbAge / 60)} giờ`} trước)` : ""}` : "Chưa đồng bộ Facebook"}
            </span>
          </span>
        }
      >
        {canSync ? <SyncButton job="facebook-ads" label="Đồng bộ Facebook" /> : null}
        <a href={`/api/export/creatives-live${searchParamsQuery(raw)}`} className="inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] font-medium hover:bg-muted" title="Tải CSV đúng tập đang lọc (mọi trang)">
          <Download className="size-3.5" aria-hidden />
          CSV
        </a>
      </DataTableToolbar>

      <StatStrip
        columns={5}
        items={[
          {
            label: "Đang chạy",
            value: formatNumber(s.running),
            note: s.scheduled ? `+ ${formatNumber(s.scheduled)} chờ tới giờ` : `trên ${formatNumber(s.total)} camp`,
            href: locTheo(LIVE_BOARD_PARAMS.state, "RUNNING"),
          },
          {
            label: data.windowed ? "Đã chi trong kỳ" : "Đã chi",
            value: formatVND(s.spendVnd),
            note: `${formatNumber(s.messages)} tin · ${formatVND(s.costPerMessage)}/tin`,
            hint: "Cộng dòng chi hạt AD của các camp đang lọc. Camp chưa có dòng chi nào không được cộng như 0 — không camp nào có số chi thì in “—”. Chi/tin là tổng chi ÷ tổng tin của các camp có cả hai số.",
          },
          {
            label: "Đơn chốt",
            value: formatNumber(s.bookedOrders),
            note: `${formatVND(s.costPerOrder)}/đơn · DT ${formatVND(s.bookedRevenueVnd, { compact: true })}`,
            hint: "Đơn không huỷ quy về mẩu của các camp đang lọc (ad_id hoặc bài viết). Chi/đơn = tổng chi ÷ tổng đơn của các camp có cả hai số — không phải trung bình các tỷ số.",
          },
          {
            label: "Hứa hẹn · thắng",
            value: `${formatNumber(s.promising)} · ${formatNumber(s.win)}`,
            note: "đề nghị cho tiêu thêm / scale",
            href: locTheo(LIVE_BOARD_PARAMS.verdict, "PROMISING,WIN"),
          },
          {
            label: "Tắt sớm · chưa kết luận",
            value: `${formatNumber(s.killed)} · ${formatNumber(s.undecided)}`,
            note: "luật tắt · đang test / chờ đơn",
            tone: "muted",
            href: locTheo(LIVE_BOARD_PARAMS.verdict, "KILL"),
          },
        ]}
      />

      <LiveTable rows={data.rows} total={data.total} pageCount={data.pageCount} canWrite={canWrite} republish={rp ? { ctx: { ...rp.ctx, canPublish: true }, sources, winCodes: rp.winCodes } : null} />

      <ScalePanel canWrite={canWrite} />
    </div>
  );
}

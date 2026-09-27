import { Badge } from "@/components/ui/badge";
import { VIDEO_ADS_HARD_LIMITS, VIDEO_AD_STATUS_LABEL, VIDEO_ADS_MODE_LABEL, type VideoAdStatus, type VideoAdsMode } from "@/lib/constants/video-scale";
import { formatDateTime, formatVND } from "@/lib/format";
import type { AdActionView, AdRowView } from "@/lib/queries/video-scale";
import { cn } from "@/lib/utils";
import { AdRowActions } from "./ads-controls";

const OUTCOME_LABEL: Record<string, string> = { APPLIED: "đã áp", DENIED: "bị chặn", FAILED: "lỗi" };
const ACTION_LABEL: Record<string, string> = { CREATE: "Dựng", ACTIVATE: "Bật", PAUSE: "Tắt", SET_BUDGET: "Đổi ngân sách" };

/** Tab "Quảng cáo": tổng đang chạy so trần, điều kiện bật, danh sách quảng cáo, sổ mọi lượt ghi (kể cả lượt bị chặn). */
export function AdsPanel({ ads, actions, activeVnd, globalCapVnd, killRules, templateAdId, writeBlocked, canSpend, canPause }: { ads: AdRowView[]; actions: AdActionView[]; activeVnd: number; globalCapVnd: number | null; killRules: number; templateAdId: string | null; writeBlocked: string | null; canSpend: boolean; canPause: boolean }) {
  return (
    <div className="space-y-5 text-[13px]">
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg border p-3">
          <p className="text-muted-foreground">Ngân sách ngày đang chạy</p>
          <p className="text-lg font-semibold tabular-nums">
            {formatVND(activeVnd)} <span className="text-sm font-normal text-muted-foreground">/ {globalCapVnd === null ? "chưa khai trần" : formatVND(globalCapVnd)}</span>
          </p>
          <p className="text-[12px] text-muted-foreground">Trần cứng {formatVND(VIDEO_ADS_HARD_LIMITS.maxGlobalDailyVnd)} · mỗi quảng cáo ≤ {formatVND(VIDEO_ADS_HARD_LIMITS.maxDailyBudgetPerAdVnd)}</p>
        </div>
        <div className={cn("rounded-lg border p-3", killRules === 0 || !templateAdId ? "border-amber-500/60 bg-amber-500/5" : "")}>
          <p className="text-muted-foreground">Điều kiện bật quảng cáo</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12.5px]">
            <li>{killRules > 0 ? `${killRules} luật TẮT đang khai (tự dừng quảng cáo đắt)` : "CHƯA có luật TẮT — không bật được quảng cáo nào"}</li>
            <li>{templateAdId ? `Mẩu quảng cáo mẫu: ${templateAdId}` : "CHƯA khai mẩu quảng cáo mẫu (tab Cấu hình)"}</li>
            <li>{writeBlocked ? `Đường ghi Facebook đóng: ${writeBlocked}` : "Đường ghi Facebook mở"}</li>
          </ul>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-muted-foreground">Quảng cáo</p>
          <p className="text-lg font-semibold tabular-nums">
            {ads.filter((a) => a.status === "ACTIVE").length} chạy · {ads.filter((a) => a.status === "PAUSED").length} tắt · {ads.filter((a) => a.status === "DRAFT").length} nháp
          </p>
          <p className="text-[12px] text-muted-foreground">Mỗi quảng cáo một chiến dịch riêng, dựng TẮT, tên mang mã hàng (tiền ads quy về đúng mã).</p>
        </div>
      </div>

      <section className="space-y-2">
        <h2 className="text-[14px] font-semibold">Quảng cáo video ({ads.length})</h2>
        {ads.length === 0 ? (
          <p className="text-muted-foreground">Chưa có — quảng cáo được lập khi Reel của video đã đăng và mã đã gán tài khoản + ngân sách.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[860px] text-[12.5px]">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-2 py-1.5">Video</th>
                  <th className="px-2 py-1.5">Chế độ / trạng thái</th>
                  <th className="px-2 py-1.5 text-right">Ngân sách ngày</th>
                  <th className="px-2 py-1.5">Chiến dịch</th>
                  <th className="px-2 py-1.5">Ai cho</th>
                  <th className="px-2 py-1.5">Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {ads.map((a) => (
                  <tr key={a.id} className="border-t align-top">
                    <td className="px-2 py-1.5">
                      {a.productName} #{a.seq}
                      <span className="block text-[11px] text-muted-foreground">TK {a.adAccountId}</span>
                    </td>
                    <td className="px-2 py-1.5">
                      <Badge variant={a.status === "ACTIVE" ? "default" : a.status === "FAILED" ? "destructive" : "secondary"}>{VIDEO_AD_STATUS_LABEL[a.status as VideoAdStatus] ?? a.status}</Badge>
                      <span className="block text-[11px] text-muted-foreground">{VIDEO_ADS_MODE_LABEL[a.mode as VideoAdsMode] ?? a.mode}</span>
                      {a.error ? <span className="block text-[11.5px] text-destructive">{a.error}</span> : null}
                      {a.stopReason && a.status !== "ACTIVE" ? <span className="block text-[11.5px] text-muted-foreground">Tắt: {a.stopReason}</span> : null}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatVND(a.dailyBudgetVnd)}</td>
                    <td className="px-2 py-1.5">
                      {a.campaignName}
                      {a.fbCampaignId ? <span className="block text-[11px] text-muted-foreground">id {a.fbCampaignId}</span> : null}
                    </td>
                    <td className="px-2 py-1.5">
                      {a.authorizedBy}
                      {a.activatedAt ? <span className="block text-[11px] text-muted-foreground">bật {formatDateTime(a.activatedAt)} · {a.activatedBy}</span> : null}
                    </td>
                    <td className="px-2 py-1.5">
                      <AdRowActions adId={a.id} status={a.status} budgetVnd={a.dailyBudgetVnd} canSpend={canSpend} canPause={canPause} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-[14px] font-semibold">Sổ ghi quảng cáo (kể cả lượt bị chặn)</h2>
        {actions.length === 0 ? (
          <p className="text-muted-foreground">Chưa có lượt nào.</p>
        ) : (
          <ul className="space-y-1 text-[12.5px]">
            {actions.map((x) => (
              <li key={x.id} className="rounded border px-2 py-1">
                <span className="text-muted-foreground">{formatDateTime(x.createdAt)}</span> · <b>{ACTION_LABEL[x.action] ?? x.action}</b> · {OUTCOME_LABEL[x.outcome] ?? x.outcome}
                {x.denial ? ` (${x.denial})` : ""} · {x.actor}
                {x.before !== null || x.after !== null ? ` · ${x.before === null ? "—" : formatVND(x.before)} → ${x.after === null ? "—" : formatVND(x.after)}` : ""}
                {x.detail ? <span className="block text-muted-foreground">{x.detail}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

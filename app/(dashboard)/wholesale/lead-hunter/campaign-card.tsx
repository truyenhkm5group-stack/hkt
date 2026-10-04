"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { changeCampaignStateAction, cloneCampaignAction, runLeadHunterNowAction, startCampaignAction } from "@/lib/actions/wholesale";
import { formatNumber, formatTimeAgo } from "@/lib/format";
import type { CampaignProgress } from "@/lib/queries/wholesale";
import { CAMPAIGN_STATUS_LABEL, PAUSE_REASON_LABEL, type CampaignStatus, type PauseReason } from "@/lib/wholesale/constants";
import { DISCOVERY_TIER_LABEL, type DiscoveryTier } from "@/lib/wholesale/config";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-muted text-foreground",
  RUNNING: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  PAUSED: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  STOPPED: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
  COMPLETED: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
};

export function CampaignCard({ c, usdToVnd }: { c: CampaignProgress; usdToVnd: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ error: string } | ({ ok: true } & object)>, ok: (r: object) => string) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(ok(r));
        router.refresh();
      }
    });
  const done = c.cellsDone + c.cellsFresh + c.cellsFailed;
  const pct = c.cells ? Math.round((done / c.cells) * 100) : 0;
  const metrics: [string, string][] = [
    ["Truy vấn đã chạy", `${formatNumber(done)}/${formatNumber(c.cells)}`],
    ["Địa điểm tìm thấy", formatNumber(c.placesDiscovered)],
    ["Địa điểm khác nhau", formatNumber(c.uniquePlaces)],
    ["Có SĐT", formatNumber(c.phoneFound)],
    ["Đủ điều kiện", formatNumber(c.qualified)],
    ["Trùng đã loại", formatNumber(c.duplicatesRemoved)],
    ["Lượt gọi API", formatNumber(c.apiCalls)],
    ["Chi phí ước tính", `${(c.costMicros / 1e6).toLocaleString("vi-VN", { maximumFractionDigits: 2 })} US$ ≈ ${formatNumber(Math.round((c.costMicros / 1e6) * usdToVnd))} ₫`],
  ];
  return (
    <div className={cn("space-y-2 rounded-lg border p-3", c.isTemplate && "border-dashed")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-semibold">
            {c.isTemplate ? "Mẫu · " : ""}
            {c.name}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {DISCOVERY_TIER_LABEL[c.discoveryTier as DiscoveryTier] ?? c.discoveryTier} · tối đa {formatNumber(c.maxLeads)} lead{c.lastTickAt ? ` · lượt quét gần nhất ${formatTimeAgo(c.lastTickAt)}` : ""}
          </div>
        </div>
        <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium", STATUS_TONE[c.status])}>{CAMPAIGN_STATUS_LABEL[c.status as CampaignStatus] ?? c.status}</span>
      </div>
      {!c.isTemplate && c.cells ? (
        <div className="space-y-1">
          <Progress value={pct} />
          <div className="text-[11px] text-muted-foreground">
            {pct}% truy vấn · {formatNumber(c.cellsPending)} chờ{c.cellsFresh ? ` · ${formatNumber(c.cellsFresh)} bỏ qua vì vừa quét` : ""}
            {c.cellsFailed ? ` · ${formatNumber(c.cellsFailed)} lỗi` : ""}
            {c.pendingDetails ? ` · ${formatNumber(c.pendingDetails)} lead đang lấy SĐT` : ""}
          </div>
        </div>
      ) : null}
      {!c.isTemplate && c.status !== "DRAFT" ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs sm:grid-cols-4">
          {metrics.map(([k, v]) => (
            <div key={k}>
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="font-medium tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {c.pauseReason ? <p className="text-xs text-amber-700 dark:text-amber-300">{PAUSE_REASON_LABEL[c.pauseReason as PauseReason] ?? c.pauseReason}</p> : null}
      {c.lastError && c.status !== "COMPLETED" ? <p className="truncate text-[11px] text-muted-foreground" title={c.lastError}>Lỗi gần nhất: {c.lastError}</p> : null}
      <div className="flex flex-wrap gap-1.5">
        {c.isTemplate ? (
          <Button size="sm" disabled={pending} onClick={() => run(() => cloneCampaignAction(c.id), () => "Đã tạo chiến dịch nháp từ mẫu — xem lại rồi bấm «Bắt đầu quét»")}>
            Dùng mẫu
          </Button>
        ) : null}
        {c.status === "DRAFT" && !c.isTemplate ? (
          <Button size="sm" disabled={pending} onClick={() => run(() => startCampaignAction(c.id), (r) => { const x = r as { queued?: number; skippedFresh?: number }; return `Đã xếp ${formatNumber(x.queued ?? 0)} truy vấn${x.skippedFresh ? ` · bỏ qua ${formatNumber(x.skippedFresh)} vừa quét` : ""} — đang quét nền`; })}>
            Bắt đầu quét
          </Button>
        ) : null}
        {c.status === "RUNNING" ? (
          <>
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => changeCampaignStateAction(c.id, "pause"), () => "Đã tạm dừng — tiến độ được giữ")}>
              Tạm dừng
            </Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => runLeadHunterNowAction(), () => "Đã chạy một lượt quét nền")}>
              Chạy ngay một lượt
            </Button>
          </>
        ) : null}
        {c.status === "PAUSED" ? (
          <Button size="sm" disabled={pending} onClick={() => run(() => changeCampaignStateAction(c.id, "resume"), () => "Đã tiếp tục từ đúng chỗ dừng")}>
            Tiếp tục
          </Button>
        ) : null}
        {c.status === "RUNNING" || c.status === "PAUSED" ? (
          <Button size="sm" variant="ghost" className="text-destructive" disabled={pending} onClick={() => run(() => changeCampaignStateAction(c.id, "stop"), () => "Đã dừng hẳn — lead đã có vẫn giữ")}>
            Dừng
          </Button>
        ) : null}
        {!c.isTemplate && (c.status === "STOPPED" || c.status === "COMPLETED") ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => cloneCampaignAction(c.id), () => "Đã nhân bản thành chiến dịch nháp")}>
            Nhân bản
          </Button>
        ) : null}
        {!c.isTemplate && c.status !== "DRAFT" ? (
          <Button size="sm" variant="link" asChild>
            <Link href={`/wholesale/leads?campaign=${c.id}`}>Xem lead</Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

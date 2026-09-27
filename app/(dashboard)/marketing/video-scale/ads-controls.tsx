"use client";

import { Loader2, OctagonX, Play, Rocket, Save } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { activateVideoAdAction, pauseVideoAdAction, queueCreateVideoAdAction, setVideoAdBudgetAction, setVideoSkuAdsAction } from "@/lib/actions/video-scale";
import { VIDEO_ADS_HARD_LIMITS, VIDEO_ADS_MODES, VIDEO_ADS_MODE_LABEL, type VideoAdsMode } from "@/lib/constants/video-scale";

function useAct() {
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: true } | { error: string }>, ok: string) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) toast.error(r.error);
      else toast.success(ok);
    });
  return [pending, run] as const;
}

/** Nút trên một dòng quảng cáo — đúng những việc hợp lệ với trạng thái của nó. */
export function AdRowActions({ adId, status, budgetVnd, canSpend, canPause }: { adId: string; status: string; budgetVnd: number; canSpend: boolean; canPause: boolean }) {
  const [pending, run] = useAct();
  const [budget, setBudget] = useState(String(budgetVnd));
  const spin = pending ? <Loader2 className="size-4 animate-spin" /> : null;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {canSpend && (status === "DRAFT" || status === "FAILED") ? (
        <>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => queueCreateVideoAdAction({ adId, activate: false }), "Đã xếp dựng quảng cáo (TẮT).")}>
            {spin} Dựng (tắt)
          </Button>
          <Button size="sm" disabled={pending} onClick={() => confirm("Dựng xong sẽ BẬT quảng cáo (tiêu tiền) nếu cổng ngân sách cho phép. Tiếp tục?") && run(() => queueCreateVideoAdAction({ adId, activate: true }), "Đã xếp dựng + bật.")}>
            <Rocket className="size-4" /> Dựng và bật
          </Button>
        </>
      ) : null}
      {canSpend && status === "PAUSED" ? (
        <Button size="sm" disabled={pending} onClick={() => confirm("Bật quảng cáo này (bắt đầu tiêu tiền)?") && run(() => activateVideoAdAction({ adId }), "Đã bật quảng cáo.")}>
          <Play className="size-4" /> Bật
        </Button>
      ) : null}
      {canPause && status === "ACTIVE" ? (
        <Button
          size="sm"
          variant="destructive"
          disabled={pending}
          onClick={() => {
            const why = prompt("Vì sao tắt quảng cáo này?");
            if (why && why.trim().length >= 3) run(() => pauseVideoAdAction({ adId, reason: why }), "Đã tắt quảng cáo.");
          }}
        >
          <OctagonX className="size-4" /> Tắt
        </Button>
      ) : null}
      {canSpend && (status === "ACTIVE" || status === "PAUSED") ? (
        <>
          <Input aria-label="Ngân sách ngày (VND)" className="h-8 w-28" inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value)} />
          <Button size="sm" variant="outline" disabled={pending || Number(budget) === budgetVnd} onClick={() => run(() => setVideoAdBudgetAction({ adId, budgetVnd: budget }), "Đã đổi ngân sách ngày.")}>
            <Save className="size-4" /> Ngân sách
          </Button>
        </>
      ) : null}
    </span>
  );
}

/** Cấu hình quảng cáo của MỘT mã: tài khoản, chế độ, ngân sách ngày mỗi quảng cáo, trần mã / ngày, tự tăng ngân sách. */
export function SkuAdsForm({ productId, accounts, value, disabled }: { productId: string; accounts: { id: string; name: string }[]; value: { adAccountId: string | null; adsMode: string; dailyBudgetPerAdVnd: number | null; skuDailyCapVnd: number | null; autoScale: boolean; autoNextRound: boolean; adsModeBy: string }; disabled: boolean }) {
  const [pending, run] = useAct();
  const [acc, setAcc] = useState(value.adAccountId ?? "");
  const [mode, setMode] = useState(value.adsMode as VideoAdsMode);
  const [budget, setBudget] = useState(value.dailyBudgetPerAdVnd ? String(value.dailyBudgetPerAdVnd) : "");
  const [cap, setCap] = useState(value.skuDailyCapVnd ? String(value.skuDailyCapVnd) : "");
  const [autoScale, setAutoScale] = useState(value.autoScale);
  const [autoNextRound, setAutoNextRound] = useState(value.autoNextRound);
  const save = () => {
    if (autoNextRound && !value.autoNextRound && !confirm("Bật VÒNG TỰ ĐỘNG: mỗi ngày máy tạo một vòng video mới cho mã này (tốn tiền sinh video, vẫn trong trần USD / ngày) khi mã đã có bài học quảng cáo. Tiếp tục?")) return;
    if (mode === "AUTO_LAUNCH" && value.adsMode !== "AUTO_LAUNCH" && !confirm("Bật TỰ BẬT QUẢNG CÁO: máy sẽ dựng và bật quảng cáo cho video đã đăng của mã này, trong ngân sách + trần đã khai, không cần người bấm từng lần. Bạn đứng tên quyết định này. Tiếp tục?")) return;
    run(() => setVideoSkuAdsAction({ productId, adAccountId: acc, adsMode: mode, dailyBudgetPerAdVnd: budget, skuDailyCapVnd: cap, autoScale, autoNextRound }), "Đã lưu cấu hình quảng cáo của mã.");
  };
  return (
    <details className="w-full rounded border p-2 text-[12px]">
      <summary className="cursor-pointer font-medium">
        Quảng cáo: {VIDEO_ADS_MODE_LABEL[value.adsMode as VideoAdsMode] ?? value.adsMode}
        {value.adsMode === "AUTO_LAUNCH" && value.adsModeBy ? ` · bật bởi ${value.adsModeBy}` : ""}
      </summary>
      <div className="mt-2 grid gap-1.5">
        <select aria-label="Tài khoản quảng cáo" className="h-8 rounded border px-1.5" value={acc} disabled={disabled || pending} onChange={(e) => setAcc(e.target.value)}>
          <option value="">— Chưa gán tài khoản —</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.id})
            </option>
          ))}
        </select>
        <select aria-label="Chế độ quảng cáo" className="h-8 rounded border px-1.5" value={mode} disabled={disabled || pending} onChange={(e) => setMode(e.target.value as VideoAdsMode)}>
          {VIDEO_ADS_MODES.map((m) => (
            <option key={m} value={m}>
              {VIDEO_ADS_MODE_LABEL[m]}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5">
          Ngân sách ngày KHỞI ĐIỂM / quảng cáo
          <Input className="h-8 w-28" inputMode="numeric" placeholder={`≤ ${VIDEO_ADS_HARD_LIMITS.maxDailyBudgetPerAdVnd}`} value={budget} disabled={disabled || pending} onChange={(e) => setBudget(e.target.value)} />
        </label>
        <label className="flex items-center gap-1.5">
          Trần mã / ngày
          <Input className="h-8 w-28" inputMode="numeric" placeholder={`≤ ${VIDEO_ADS_HARD_LIMITS.maxSkuDailyVnd}`} value={cap} disabled={disabled || pending} onChange={(e) => setCap(e.target.value)} />
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={autoScale} disabled={disabled || pending} onChange={(e) => setAutoScale(e.target.checked)} />
          Cho máy tăng ngân sách quảng cáo tốt (tối đa +30%/ngày, trong trần; cần khai &ldquo;số đơn tối thiểu&rdquo; ở Cấu hình)
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={autoNextRound} disabled={disabled || pending} onChange={(e) => setAutoNextRound(e.target.checked)} />
          Vòng tự động: mỗi ngày một vòng video mới dùng bài học (tốn tiền sinh video)
        </label>
        {!disabled ? (
          <Button size="sm" className="w-fit" disabled={pending} onClick={save}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Lưu
          </Button>
        ) : (
          <span className="text-muted-foreground">Cần quyền chi phí: sửa.</span>
        )}
      </div>
    </details>
  );
}

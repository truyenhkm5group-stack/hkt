"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { saveEmailSettingsAction, setEmailPauseAction } from "@/lib/actions/wholesale-email";
import { EMAIL_HARD_LIMITS, EMAIL_MODE_LABEL, EMAIL_MODES, type EmailMode, type EmailSettings } from "@/lib/wholesale/email-constants";

type Result = { error: string } | ({ ok: true } & object);

export function EmailSettingsPanel({ settings, campaigns, canConfigure, isOwner, liveAvailable }: { settings: EmailSettings; campaigns: { id: string; name: string }[]; canConfigure: boolean; isOwner: boolean; liveAvailable: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<EmailMode>(settings.mode);
  const [sender, setSender] = useState(settings.sender);
  const [limits, setLimits] = useState(settings.limits);
  const [reason, setReason] = useState("");
  const [campaign, setCampaign] = useState(campaigns[0]?.id ?? "");
  const [domain, setDomain] = useState("");
  const run = (fn: () => Promise<Result>, ok: string) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(ok);
        router.refresh();
      }
    });
  const campaignName = (id: string) => campaigns.find((c) => c.id === id)?.name ?? id.slice(0, 8);

  return (
    <div className="space-y-5 text-sm">
      {/* ── Nút dừng khẩn ── */}
      <div className="space-y-2">
        <div className="font-medium">Nút dừng khẩn</div>
        <div className="flex flex-wrap items-center gap-2">
          {settings.paused ? (
            <Button size="sm" variant="outline" disabled={pending || !canConfigure} onClick={() => run(() => setEmailPauseAction({ scope: "ORG", paused: false }), "Đã mở lại gửi email")} title={canConfigure ? undefined : "Chỉ người cấu hình mở lại được"}>
              Mở lại gửi email toàn tổ chức
            </Button>
          ) : (
            <>
              <Input className="h-9 max-w-xs" placeholder="Lý do dừng (không bắt buộc)" value={reason} onChange={(e) => setReason(e.target.value)} />
              <Button size="sm" variant="destructive" disabled={pending} onClick={() => run(() => setEmailPauseAction({ scope: "ORG", paused: true, reason }), "Đã DỪNG mọi thư email")}>
                DỪNG mọi thư email
              </Button>
            </>
          )}
        </div>
        {campaigns.length ? (
          <div className="flex flex-wrap items-center gap-2">
            <select className="h-9 rounded-md border bg-background px-2" value={campaign} onChange={(e) => setCampaign(e.target.value)} aria-label="Chiến dịch">
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <Button size="sm" variant="outline" disabled={pending || !campaign} onClick={() => run(() => setEmailPauseAction({ scope: "CAMPAIGN", target: campaign, paused: true }), "Đã dừng email của chiến dịch")}>
              Dừng email chiến dịch này
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Input className="h-9 max-w-xs" placeholder="Tên miền nhận, vd nhahang.vn" value={domain} onChange={(e) => setDomain(e.target.value)} />
          <Button size="sm" variant="outline" disabled={pending || !domain.trim()} onClick={() => run(() => setEmailPauseAction({ scope: "DOMAIN", target: domain, paused: true }), "Đã dừng gửi tới tên miền này")}>
            Dừng gửi tới tên miền
          </Button>
        </div>
        {settings.pausedCampaignIds.length || settings.blockedDomains.length ? (
          <ul className="flex flex-wrap gap-1.5 text-xs">
            {settings.pausedCampaignIds.map((id) => (
              <li key={id} className="flex items-center gap-1 rounded bg-rose-50 px-2 py-0.5 text-rose-900 dark:bg-rose-950 dark:text-rose-200">
                Chiến dịch «{campaignName(id)}» đang dừng
                {canConfigure ? (
                  <button type="button" className="underline" disabled={pending} onClick={() => run(() => setEmailPauseAction({ scope: "CAMPAIGN", target: id, paused: false }), "Đã mở lại chiến dịch")}>
                    mở
                  </button>
                ) : null}
              </li>
            ))}
            {settings.blockedDomains.map((d) => (
              <li key={d} className="flex items-center gap-1 rounded bg-rose-50 px-2 py-0.5 text-rose-900 dark:bg-rose-950 dark:text-rose-200">
                @{d} đang dừng
                {canConfigure ? (
                  <button type="button" className="underline" disabled={pending} onClick={() => run(() => setEmailPauseAction({ scope: "DOMAIN", target: d, paused: false }), "Đã mở lại tên miền")}>
                    mở
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* ── Chế độ · người gửi · hạn mức ── */}
      <fieldset disabled={!canConfigure || pending} className="space-y-3">
        <div className="font-medium">Chế độ gửi {canConfigure ? null : <span className="font-normal text-muted-foreground">(chỉ người cấu hình sửa được)</span>}</div>
        <div className="flex flex-wrap gap-3">
          {EMAIL_MODES.map((m) => (
            <label key={m} className="flex items-center gap-1.5">
              <input type="radio" name="email-mode" value={m} checked={mode === m} onChange={() => setMode(m)} disabled={m === "LIVE" && (!liveAvailable || !isOwner)} />
              {EMAIL_MODE_LABEL[m]}
              {m === "LIVE" && !liveAvailable ? <span className="text-xs text-muted-foreground">(chưa có nhà cung cấp email)</span> : null}
              {m === "LIVE" && liveAvailable && !isOwner ? <span className="text-xs text-muted-foreground">(chỉ chủ shop)</span> : null}
            </label>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Input placeholder="Tên người gửi (vd Hải sản Hà My)" value={sender.name} onChange={(e) => setSender({ ...sender, name: e.target.value })} aria-label="Tên người gửi" />
          <Input placeholder="Email người gửi" value={sender.email} onChange={(e) => setSender({ ...sender, email: e.target.value })} aria-label="Email người gửi" />
          <Input placeholder="Tên doanh nghiệp (in ở chân thư)" value={sender.companyName} onChange={(e) => setSender({ ...sender, companyName: e.target.value })} aria-label="Tên doanh nghiệp" />
          <Input placeholder="Địa chỉ doanh nghiệp (in ở chân thư)" value={sender.address} onChange={(e) => setSender({ ...sender, address: e.target.value })} aria-label="Địa chỉ doanh nghiệp" />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5">
            Thư / giờ
            <Input type="number" className="h-9 w-24" min={1} max={EMAIL_HARD_LIMITS.perHour} value={limits.perHour} onChange={(e) => setLimits({ ...limits, perHour: Number(e.target.value) })} />
          </label>
          <label className="flex items-center gap-1.5">
            Thư / ngày
            <Input type="number" className="h-9 w-24" min={1} max={EMAIL_HARD_LIMITS.perDay} value={limits.perDay} onChange={(e) => setLimits({ ...limits, perDay: Number(e.target.value) })} />
          </label>
          <label className="flex items-center gap-1.5">
            Thư / tên miền nhận / ngày
            <Input type="number" className="h-9 w-24" min={1} max={EMAIL_HARD_LIMITS.perRecipientDomainPerDay} value={limits.perRecipientDomainPerDay} onChange={(e) => setLimits({ ...limits, perRecipientDomainPerDay: Number(e.target.value) })} />
          </label>
        </div>
        <Button size="sm" onClick={() => run(() => saveEmailSettingsAction({ mode, sender, limits }), "Đã lưu cấu hình email")}>
          Lưu cấu hình email
        </Button>
      </fieldset>
    </div>
  );
}

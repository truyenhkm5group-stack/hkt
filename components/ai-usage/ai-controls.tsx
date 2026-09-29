"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setOrgAiControlAction, setPlatformAiEnabledAction } from "@/lib/actions/ai-usage";
import { AI_LIMIT_OVERRIDE_KEYS, AI_LIMIT_OVERRIDE_LABEL, type AiLimitOverrideKey, type AiLimitsOverride } from "@/lib/ai-usage/types";

/**
 * Công tắc AI (docs/platform/ai-usage.md §4) — chỉ ở màn người vận hành nền tảng. Mọi kiểm quyền ở server action; lý do
 * bắt buộc, vào nhật ký nền tảng. Có hiệu lực không cần deploy (tiến trình khác trễ tối đa `cacheSeconds`).
 */

export function PlatformAiSwitchControl(props: { enabled: boolean; stored: boolean; readError: boolean; updatedAt: string | null; updatedByEmail: string | null; cacheSeconds: number }) {
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const next = !props.enabled;

  const apply = () =>
    start(async () => {
      setError(null);
      const r = await setPlatformAiEnabledAction({ enabled: next, reason });
      setConfirming(false);
      if ("error" in r) return setError(r.error);
      setReason("");
      toast.success(next ? "Đã BẬT lại AI Builder toàn nền tảng" : "Đã TẮT AI Builder toàn nền tảng");
    });

  return (
    <div className="space-y-2" data-ai-switch={props.enabled ? "on" : "off"}>
      <p className="text-xs">
        Đang: <span className={props.enabled ? "font-semibold text-emerald-700 dark:text-emerald-300" : "font-semibold text-destructive"}>{props.enabled ? "BẬT" : "TẮT"}</span>
        <span className="text-muted-foreground">{props.readError ? " · không đọc được công tắc ⇒ coi như TẮT" : props.stored ? ` · ${props.updatedAt ?? "—"} · ${props.updatedByEmail ?? "máy"}` : " (chưa từng đặt ⇒ BẬT)"}</span>
      </p>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="space-y-1">
          <Label htmlFor="ai-switch-reason">Lý do (vào nhật ký nền tảng)</Label>
          <Input id="ai-switch-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={next ? "Đã xử lý xong sự cố chi phí" : "Chi phí AI tăng bất thường"} maxLength={500} />
        </div>
        <Button type="button" variant={next ? "outline" : "destructive"} disabled={pending || reason.trim().length < 5} onClick={() => setConfirming(true)}>
          {next ? "Bật AI…" : "Tắt AI…"}
        </Button>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <p className="text-[11px] text-muted-foreground">Chỉ AI Builder (mọi tổ chức). Copilot và job AI của tổ chức nhà có trần tiền riêng. Hiệu lực ngay ở máy chủ này, tiến trình khác trễ tối đa {props.cacheSeconds} giây.</p>
      <AlertDialog open={confirming} onOpenChange={(o) => !pending && setConfirming(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{next ? "Bật lại AI Builder cho toàn nền tảng?" : "Tắt AI Builder cho toàn nền tảng?"}</AlertDialogTitle>
            <AlertDialogDescription>{next ? "Mọi tổ chức (trừ tổ chức đang bị tắt riêng) soạn được bản nháp AI trở lại." : "Mọi tổ chức, kể cả tổ chức nhà, sẽ thấy «AI đang bị tắt bởi người vận hành» — không lời gọi model nào được gửi."}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Huỷ</AlertDialogCancel>
            <AlertDialogAction disabled={pending} onClick={apply}>
              Xác nhận
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function OrgAiControlForm(props: { orgCode: string; orgName: string; disabled: boolean; limits: AiLimitsOverride; cacheSeconds: number }) {
  const init = Object.fromEntries(
    AI_LIMIT_OVERRIDE_KEYS.map((k) => {
      const v = props.limits[k];
      return [k, v === undefined || v === null ? "" : String(v)];
    }),
  ) as Record<AiLimitOverrideKey, string>;
  const [values, setValues] = useState(init);
  const [disabled, setDisabled] = useState(props.disabled);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      setError(null);
      const r = await setOrgAiControlAction({ orgCode: props.orgCode, disabled, limits: values, reason });
      if ("error" in r) return setError(r.error);
      setReason("");
      toast.success(r.changed ? "Đã lưu cài đặt AI của tổ chức" : "Không đổi gì — cài đặt đã là như vậy");
    });

  return (
    <div className="space-y-3" data-org-ai-control={props.orgCode}>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
        <span>
          Tắt AI Builder của <span className="font-semibold">{props.orgName}</span>
        </span>
      </label>
      <div className="grid gap-2 sm:grid-cols-5">
        {AI_LIMIT_OVERRIDE_KEYS.map((k) => (
          <div key={k} className="space-y-1">
            <Label htmlFor={`ai-limit-${k}`} className="text-[11px]">
              {AI_LIMIT_OVERRIDE_LABEL[k]}
            </Label>
            <Input id={`ai-limit-${k}`} inputMode="decimal" value={values[k]} onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))} placeholder="theo gói" />
          </div>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="space-y-1">
          <Label htmlFor="org-ai-reason">Lý do (vào nhật ký nền tảng)</Label>
          <Input id="org-ai-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Khách xin nâng trần thử nghiệm" maxLength={500} />
        </div>
        <Button type="button" variant="outline" disabled={pending || reason.trim().length < 5} onClick={save}>
          Lưu
        </Button>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <p className="text-[11px] text-muted-foreground">Ô trống = theo gói. Ghi đè chỉ thắng gói ở ô có số. Hiệu lực không cần deploy, tiến trình khác trễ tối đa {props.cacheSeconds} giây.</p>
    </div>
  );
}

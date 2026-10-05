"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setPhoneOtpSettingAction, testPhoneOtpAction } from "@/lib/actions/onboarding";

/**
 * Bật mã xác minh SĐT qua Zalo ZNS cho đăng ký nhanh (lib/onboarding/phone-otp.ts). Gửi thử tới số của chính người vận hành
 * TRƯỚC khi bật — bật rồi mà mẫu sai thì mọi khách đăng ký đều kẹt ở bước mã.
 */
export function PhoneOtpControl({
  enabled,
  templateId,
  param,
  zaloConnected,
  summary,
}: {
  enabled: boolean;
  templateId: string;
  param: string;
  zaloConnected: boolean;
  summary: { sent24h: number; failed24h: number; lastError: { at: string; error: string } | null };
}) {
  const [tpl, setTpl] = useState(templateId);
  const [prm, setPrm] = useState(param);
  const [phone, setPhone] = useState("");
  const [pending, start] = useTransition();

  const save = (on: boolean) =>
    start(async () => {
      const r = await setPhoneOtpSettingAction({ enabled: on, templateId: tpl, param: prm });
      if ("error" in r) toast.error(r.error);
      else toast.success(r.setting.enabled ? "Đã bật mã xác minh qua Zalo." : "Đã lưu — mã xác minh đang TẮT.");
    });

  const test = () =>
    start(async () => {
      const r = await testPhoneOtpAction({ phone, templateId: tpl, param: prm });
      if ("error" in r) toast.error(r.error);
      else toast.success(r.message);
    });

  return (
    <div className="space-y-2 text-sm" data-phone-otp-control>
      <p>
        Trạng thái: <strong>{enabled ? "BẬT — khách phải nhập mã Zalo khi đăng ký" : "TẮT"}</strong>
        {!zaloConnected ? <span className="text-amber-700 dark:text-amber-300"> · tổ chức nhà chưa nối Zalo OA (Kết nối dữ liệu → Zalo OA)</span> : null}
      </p>
      <p className="text-xs text-muted-foreground">
        24 giờ qua: {summary.sent24h} mã đã gửi · {summary.failed24h} lần Zalo từ chối
        {summary.lastError ? ` · lỗi gần nhất: ${summary.lastError.error}` : ""}
      </p>
      <div className="grid gap-2 sm:grid-cols-[1fr_8rem]">
        <div className="space-y-1">
          <Label htmlFor="otp-tpl">Mã mẫu ZNS (đã được Zalo duyệt)</Label>
          <Input id="otp-tpl" inputMode="numeric" value={tpl} onChange={(e) => setTpl(e.target.value.trim())} placeholder="vd 312345" maxLength={20} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="otp-param">Tham số mã</Label>
          <Input id="otp-param" value={prm} onChange={(e) => setPrm(e.target.value.trim())} maxLength={30} />
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="otp-test-phone">Gửi thử tới SĐT</Label>
          <Input id="otp-test-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0912 345 678" className="w-40" />
        </div>
        <Button variant="outline" onClick={test} disabled={pending || !tpl || !phone}>
          Gửi thử
        </Button>
        {enabled ? (
          <Button variant="outline" onClick={() => save(false)} disabled={pending}>
            Tắt
          </Button>
        ) : (
          <Button onClick={() => save(true)} disabled={pending || !tpl || !zaloConnected}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null} Bật
          </Button>
        )}
        {enabled ? (
          <Button variant="ghost" onClick={() => save(true)} disabled={pending || !tpl}>
            Lưu mẫu
          </Button>
        ) : null}
      </div>
    </div>
  );
}

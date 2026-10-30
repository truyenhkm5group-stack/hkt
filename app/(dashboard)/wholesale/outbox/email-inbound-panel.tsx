"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { runEmailInboundNowAction, saveEmailInboundSettingsAction } from "@/lib/actions/wholesale-email-inbound";
import type { EmailInboundSettings } from "@/lib/wholesale/email-reply";

/** Cấu hình E3: đọc thư trả lời qua IMAP (cùng kết nối Google Workspace) + phân loại AI có trần. Mặc định TẮT cả hai. */
export function EmailInboundSettingsForm({ settings }: { settings: EmailInboundSettings }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [aiClassify, setAiClassify] = useState(settings.aiClassify);
  const [maxPerDay, setMaxPerDay] = useState(settings.dailyMaxClassify === null ? "" : String(settings.dailyMaxClassify));
  const [capUsd, setCapUsd] = useState(settings.dailyCostCapUsd === null ? "" : String(settings.dailyCostCapUsd));
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const save = () =>
    start(async () => {
      const r = await saveEmailInboundSettingsAction({ enabled, aiClassify, dailyMaxClassify: num(maxPerDay), dailyCostCapUsd: num(capUsd) });
      if ("error" in r) toast.error(r.error);
      else {
        toast.success("Đã lưu cấu hình đọc thư trả lời");
        router.refresh();
      }
    });
  const runNow = () =>
    start(async () => {
      const r = await runEmailInboundNowAction();
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(r.detail);
        router.refresh();
      }
    });
  return (
    <div className="space-y-2 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={pending} />
        Đọc thư trả lời trong hộp thư Google Workspace (IMAP, chỉ đọc — chỉ thư nối luồng / khớp đúng một lead, không tải đính kèm)
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={aiClassify} onChange={(e) => setAiClassify(e.target.checked)} disabled={pending} />
        AI phân loại thư (Quan tâm · Hỏi giá · Từ chối · Huỷ đăng ký · Khác) — Hỏi giá ⇒ NHÁP báo giá, không tự gửi
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5">
          Trần thư / ngày
          <Input type="number" className="h-9 w-24" min={1} max={500} value={maxPerDay} onChange={(e) => setMaxPerDay(e.target.value)} />
        </label>
        <label className="flex items-center gap-1.5">
          Trần USD / ngày
          <Input type="number" className="h-9 w-24" min={0.01} max={100} step={0.01} value={capUsd} onChange={(e) => setCapUsd(e.target.value)} />
        </label>
        <Button size="sm" disabled={pending} onClick={save}>
          Lưu
        </Button>
        <Button size="sm" variant="outline" disabled={pending || !settings.enabled} onClick={runNow}>
          Đọc hộp thư ngay
        </Button>
      </div>
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { saveAdBotAction, setAdBotsEnabledAction, syncAdBotsAction } from "@/lib/actions/chatbot-ad-bots";
import { AD_BOT_INSTRUCTIONS_MAX } from "@/lib/constants/chatbot-ad-bots";

type Result = { ok: true; message: string } | { error: string };

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<Result>) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) toast.error(r.error);
      else toast.success(r.message);
      router.refresh();
    });
  return { pending, run };
}

export function AdBotsGlobalControls({ enabled }: { enabled: boolean }) {
  const { pending, run } = useRun();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={enabled} disabled={pending} onCheckedChange={(v) => run(() => setAdBotsEnabledAction(v))} />
        Bật bot riêng theo quảng cáo
      </label>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => syncAdBotsAction())}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        Gửi lại sang bot
      </Button>
    </div>
  );
}

export function AdBotEditor({ adId, enabled, productCode, defaultCode, instructions }: { adId: string; enabled: boolean; productCode: string; defaultCode: string; instructions: string }) {
  const { pending, run } = useRun();
  const [on, setOn] = useState(enabled);
  const [code, setCode] = useState(productCode);
  const [text, setText] = useState(instructions);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={on} onCheckedChange={setOn} />
          Dùng bot riêng cho quảng cáo này
        </label>
        <label className="flex items-center gap-2 text-sm">
          Mã mẫu
          <Input className="h-8 w-28 font-mono" value={code} placeholder={defaultCode || "vd Q004"} onChange={(e) => setCode(e.target.value)} />
        </label>
        <span className="text-xs text-muted-foreground">{defaultCode ? `Để trống = theo mẫu gắn trên quảng cáo (${defaultCode}).` : "Quảng cáo chưa gắn mã — nhập mã mẫu để bot biết khách hỏi mẫu nào."}</span>
      </div>
      <Textarea
        rows={3}
        maxLength={AD_BOT_INSTRUCTIONS_MAX}
        value={text}
        placeholder="Hướng dẫn riêng cho camp này, vd: xưng em gọi chị; nhấn mạnh chất liệu co giãn; khách hỏi size thì xin chiều cao cân nặng trước…"
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex justify-end">
        <Button size="sm" disabled={pending} onClick={() => run(() => saveAdBotAction({ adId, enabled: on, productCode: code, instructions: text }))}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Lưu &amp; gửi sang bot
        </Button>
      </div>
    </div>
  );
}

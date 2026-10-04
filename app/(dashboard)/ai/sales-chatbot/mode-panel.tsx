"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { saveModeAction } from "@/lib/actions/sales-mode";
import { OPERATING_MODE_LABEL, OPERATING_MODES, type ModeConfig, type OperatingMode } from "@/lib/sales-chatbot/operating-mode-shared";

/** Chọn chế độ vận hành của bot trên fanpage (quan sát → copilot → thử nghiệm → tự động). */
export function ModePanel({ config, manage }: { config: ModeConfig; manage: boolean }) {
  const [mode, setMode] = useState<OperatingMode>(config.mode);
  const [share, setShare] = useState(String(config.aiSharePct));
  const [restart, setRestart] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const changed = mode !== config.mode || Number(share) !== config.aiSharePct || restart;
  return (
    <div className="space-y-2 text-sm" data-testid="mode-panel">
      <div className="flex flex-wrap items-center gap-2">
        <select value={mode} onChange={(e) => setMode(e.target.value as OperatingMode)} disabled={!manage} className="h-8 rounded-md border bg-background px-2 text-sm" data-testid="mode-select">
          {OPERATING_MODES.map((m) => (
            <option key={m} value={m}>
              {OPERATING_MODE_LABEL[m]}
            </option>
          ))}
        </select>
        {mode === "EXPERIMENT" ? (
          <label className="flex items-center gap-1.5">
            AI nhận
            <Input value={share} onChange={(e) => setShare(e.target.value)} inputMode="numeric" className="h-8 w-16" disabled={!manage} />% hội thoại mới
          </label>
        ) : null}
        {mode === "EXPERIMENT" && config.mode === "EXPERIMENT" ? (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} disabled={!manage} /> Chia lại từ đầu (thử nghiệm mới)
          </label>
        ) : null}
        {manage ? (
          <Button
            size="sm"
            disabled={!changed || pending}
            onClick={() =>
              start(async () => {
                const r = await saveModeAction({ mode, aiSharePct: Number(share), restartExperiment: restart });
                if ("error" in r) toast.error(r.error);
                else {
                  toast.success(r.message);
                  setRestart(false);
                  router.refresh();
                }
              })
            }
          >
            {pending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Lưu
          </Button>
        ) : null}
        <Link href="/ai/sales-chatbot/copilot" className="text-xs font-medium text-primary hover:underline">
          Gợi ý Copilot & thử nghiệm →
        </Link>
      </div>
      <p className="text-xs text-muted-foreground">
        Áp cho fanpage (kênh có người trả lời song song). Trang chat web luôn tự động. Quan sát / nhánh người: bot không gọi AI, không tốn tiền. Copilot: bot soạn gợi ý ở hội thoại bóng, không gửi — câu thật của page tới sau được đem so.
      </p>
    </div>
  );
}

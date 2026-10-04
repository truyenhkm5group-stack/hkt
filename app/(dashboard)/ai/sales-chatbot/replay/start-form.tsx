"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { startReplayAction } from "@/lib/actions/sales-replay";
import { REPLAY_LIMITS } from "@/lib/sales-chatbot/replay-shared";

const field = "h-8 rounded-md border bg-background px-2 text-sm";

export function ReplayStartForm({ disabled }: { disabled: boolean }) {
  const [points, setPoints] = useState<number>(REPLAY_LIMITS.pointChoices[1]);
  const [days, setDays] = useState<number>(REPLAY_LIMITS.dayChoices[1]);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="replay-start">
      <label className="flex items-center gap-1.5">
        Số điểm
        <select value={points} onChange={(e) => setPoints(Number(e.target.value))} className={field}>
          {REPLAY_LIMITS.pointChoices.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5">
        trong
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={field}>
          {REPLAY_LIMITS.dayChoices.map((n) => (
            <option key={n} value={n}>
              {n} ngày
            </option>
          ))}
        </select>
      </label>
      <Button
        size="sm"
        disabled={disabled || pending}
        onClick={() =>
          start(async () => {
            const r = await startReplayAction({ points, days });
            if ("error" in r) toast.error(r.error);
            else {
              toast.success(r.message);
              router.push(`/ai/sales-chatbot/replay?run=${r.runId}`);
            }
          })
        }
      >
        {pending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
        Phát lại
      </Button>
      <Button size="sm" variant="outline" onClick={() => router.refresh()}>
        Làm mới
      </Button>
    </div>
  );
}

"use client";

import { Loader2, Sparkles } from "lucide-react";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { seedTechAgentsAction, setTechAgentEnabledAction } from "@/lib/actions/tech";

/**
 * Nút khởi tạo sổ agent.
 *
 * Mẫu KHÔNG tự chạy lúc migration (AGENTS.md mục 23): sổ chỉ đầy khi có người bấm. Bấm lại chỉ
 * THÊM khoá còn thiếu — agent đã bị tắt bằng tay thì không bị bật lại.
 */
export function SeedAgentsButton({ label }: { label: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await seedTechAgentsAction();
          if ("error" in res) {
            toast.error(res.error);
            return;
          }
          toast.success(res.created ? `Đã thêm ${res.created} định nghĩa agent (tất cả ở trạng thái TẮT)` : "Sổ đã đủ — không thêm gì");
          router.refresh();
        })
      }
    >
      {pending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} {label}
    </Button>
  );
}

/** Bật / tắt một định nghĩa agent. Phase 1 chặn bật agent mang quyền merge / deploy / ghi production. */
export function AgentEnableSwitch({ agentId, enabled, name }: { agentId: string; enabled: boolean; name: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Switch
      checked={enabled}
      disabled={pending}
      aria-label={`Bật hoặc tắt agent ${name}`}
      onCheckedChange={(v) =>
        start(async () => {
          const res = await setTechAgentEnabledAction({ agentId, enabled: v });
          if ("error" in res) {
            toast.error(res.error);
            return;
          }
          toast.success(v ? `Đã bật ${name}` : `Đã tắt ${name}`);
          router.refresh();
        })
      }
    />
  );
}

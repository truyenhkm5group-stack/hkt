"use client";

import { Loader2, Sparkles } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { seedTechAgentsAction, setTechAgentEnabledAction, setTechAgentRisksAction } from "@/lib/actions/tech";
import { TECH_RISKS } from "@/lib/constants/tech";
import { useState } from "react";

/**
 * Nút khởi tạo sổ agent.
 *
 * Mẫu KHÔNG tự chạy lúc migration (AGENTS.md mục 23): sổ chỉ đầy khi có người bấm. Bấm lại chỉ
 * THÊM khoá còn thiếu — agent đã bị tắt bằng tay thì không bị bật lại.
 */
export function SeedAgentsButton({ label }: { label: string }) {
  const [pending, start] = useTransition();
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
        })
      }
    />
  );
}

/**
 * Cấp / thu mức rủi ro cho một vai.
 *
 * Cổng giao việc từ chối một việc R2 bằng câu *"Cấp mức cho vai ở /tech/agents"* — mà màn hình này
 * trước đó chỉ IN cột rủi ro, không có chỗ sửa. Đo 22/09/2026: chủ shop bật đủ 12 vai rồi mà 0/12
 * vai đổi được mức, vì không có cách nào. Một cổng người có quyền không mở được thì là cổng hỏng.
 *
 * `R2` đứng riêng và BẮT BUỘC nêu lý do: đó là mức chạm tiền, và một lượt nới không ai đọc lại
 * được sau này thì sổ quyền chỉ còn là một bảng số.
 */
export function AgentRiskPicker({ agentId, name, allowedRisks }: { agentId: string; name: string; allowedRisks: string[] }) {
  const [pending, start] = useTransition();
  const [chon, setChon] = useState<string[]>(allowedRisks);
  const [lyDo, setLyDo] = useState("");

  const themR2 = chon.includes("R2") && !allowedRisks.includes("R2");
  const doi = chon.length !== allowedRisks.length || chon.some((r) => !allowedRisks.includes(r));

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {TECH_RISKS.map((r) => (
          <label key={r} className="flex cursor-pointer items-center gap-1 text-[11px]">
            <input
              type="checkbox"
              checked={chon.includes(r)}
              disabled={pending}
              onChange={(e) => setChon((cu) => (e.target.checked ? [...cu, r] : cu.filter((x) => x !== r)))}
              aria-label={`Cho vai ${name} làm việc mức ${r}`}
            />
            <span className={r === "R2" ? "font-semibold text-destructive" : ""}>{r}</span>
          </label>
        ))}
      </div>
      {themR2 ? (
        <input
          value={lyDo}
          onChange={(e) => setLyDo(e.target.value)}
          placeholder="Vì sao cấp R2 cho vai này? (bắt buộc)"
          className="w-full rounded-lg border bg-background px-2 py-1 text-[11px]"
        />
      ) : null}
      {doi ? (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await setTechAgentRisksAction({ agentId, allowedRisks: chon, reason: lyDo || undefined });
              if ("error" in res) {
                toast.error(res.error);
                return;
              }
              toast.success(`Vai ${name}: ${res.truoc.join("/") || "(chưa khai)"} → ${res.sau.join("/") || "(không mức nào)"}`);
              setLyDo("");
            })
          }
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : null} Lưu mức
        </Button>
      ) : null}
      {chon.includes("R2") ? (
        <p className="text-[10.5px] leading-4 text-muted-foreground">
          R2 chỉ mở cho vai CHỈ GHI RA CHỮ (<span className="font-mono">docs/</span>) và việc đã được
          chủ shop ký duyệt. Vai ghi được <span className="font-mono">tests/</span> vẫn không qua cửa.
        </p>
      ) : null}
    </div>
  );
}

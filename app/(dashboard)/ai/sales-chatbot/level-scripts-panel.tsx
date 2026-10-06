"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SectionCard } from "@/components/ui-bits";
import { saveLevelScriptsAction } from "@/lib/actions/sales-chatbot";
import { CUSTOMER_LEVEL_CLASS, CUSTOMER_LEVEL_LABEL, LEVEL_SCRIPT_HINT, LEVEL_SCRIPT_MAX, type CustomerLevel, type LevelScripts } from "@/lib/sales-chatbot/levels-shared";
import { cn } from "@/lib/utils";

/**
 * KỊCH BẢN THEO LEVEL KHÁCH — trang Chatbot bán hàng. Máy tự xếp level cho mỗi hội thoại (đọc tin khách + đơn); shop viết cho mỗi
 * level MỘT đoạn hướng dẫn, bot đọc đúng đoạn của level khách đang ở. Ô trống = level đó bot làm như bình thường. Không
 * `router.refresh()` sau action (action đã `revalidatePath`).
 */
export function LevelScriptsPanel({ scripts, levels, counts }: { scripts: LevelScripts; levels: CustomerLevel[]; counts: Record<string, number> }) {
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState<LevelScripts>(scripts);
  const dirty = JSON.stringify(draft) !== JSON.stringify(scripts);

  const save = () =>
    start(async () => {
      const r = await saveLevelScriptsAction(draft);
      if ("error" in r) toast.error(r.error);
      else toast.success(r.message);
    });

  return (
    <SectionCard title="Kịch bản theo level khách" description="Máy tự xếp level cho từng hội thoại (theo tin khách gửi và đơn đã có). Viết hướng dẫn cho bot ở mỗi level — bot đọc đúng đoạn của level khách đang ở. Lọc hội thoại theo level ở Hộp thư khách.">
      <div className="space-y-2" data-testid="level-scripts">
        {levels.map((l) => (
          <label key={l} className="block space-y-1">
            <span className="flex items-center gap-2 text-[13px]">
              <span className={cn("rounded px-1.5 py-0.5 text-[12px] font-medium", CUSTOMER_LEVEL_CLASS[l])}>{CUSTOMER_LEVEL_LABEL[l]}</span>
              <span className="text-[12px] text-muted-foreground">{counts[l] ?? 0} hội thoại</span>
            </span>
            <Textarea
              rows={2}
              maxLength={LEVEL_SCRIPT_MAX}
              value={draft[l] ?? ""}
              placeholder={`Gợi ý: ${LEVEL_SCRIPT_HINT[l]}`}
              onChange={(e) => setDraft((d) => ({ ...d, [l]: e.target.value }))}
              className="text-[13px]"
              aria-label={`Kịch bản level ${CUSTOMER_LEVEL_LABEL[l]}`}
            />
          </label>
        ))}
        <Button size="sm" disabled={!dirty || pending} onClick={save}>
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : null} Lưu kịch bản
        </Button>
      </div>
    </SectionCard>
  );
}

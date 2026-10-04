"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { saveHumanCostAction } from "@/lib/actions/ai-sales-performance";

/**
 * Chủ shop khai «chi phí một hội thoại do người làm» (₫) + cách tính — đầu vào DUY NHẤT của «tiết kiệm nhân sự (ước tính)».
 * Không có số mặc định (luật 38): để trống là CHƯA KHAI, ô tiết kiệm hiện «—».
 */
export function HumanCostForm({ current, reason, setBy, at }: { current: number | null; reason: string | null; setBy: string | null; at: string | null }) {
  const [value, setValue] = useState(current === null ? "" : String(current));
  const [why, setWhy] = useState(reason ?? "");
  const [pending, start] = useTransition();
  const submit = (clear: boolean) =>
    start(async () => {
      const raw = value.replace(/[^\d]/g, "");
      const r = await saveHumanCostAction({ humanCostPerConversationVnd: clear || !raw ? null : Number(raw), reason: why });
      if ("error" in r) toast.error(r.error);
      else toast.success(r.message);
    });
  return (
    <div className="mt-4 rounded-lg border p-3" data-testid="ai-perf-human-cost">
      <div className="text-sm font-medium">Chi phí một hội thoại do nhân viên làm</div>
      <p className="mb-2 text-xs text-muted-foreground">
        Ví dụ: lương nhân viên chat một tháng ÷ số hội thoại họ xử lý một tháng. Con số và cách tính được in cạnh «tiết kiệm ước tính».
        {current !== null && setBy ? ` Đang dùng: ${current.toLocaleString("vi-VN")} ₫ — ${setBy}${at ? `, ${new Date(at).toLocaleDateString("vi-VN")}` : ""}.` : ""}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input className="h-8 w-40" inputMode="numeric" placeholder="vd 15000" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Chi phí một hội thoại (₫)" />
        <Input className="h-8 min-w-60 flex-1" placeholder="Cách tính / lý do" value={why} onChange={(e) => setWhy(e.target.value)} aria-label="Cách tính" />
        <Button size="sm" className="h-8" disabled={pending} onClick={() => submit(false)}>
          Lưu
        </Button>
        {current !== null ? (
          <Button size="sm" variant="outline" className="h-8" disabled={pending} onClick={() => submit(true)}>
            Gỡ
          </Button>
        ) : null}
      </div>
    </div>
  );
}

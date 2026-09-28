"use client";

import { useState } from "react";
import { IDEA_PRESET_GROUPS, appendIdeaPreset } from "@/lib/constants/idea-presets";
import { cn } from "@/lib/utils";

/**
 * Gợi ý chọn nhanh cho ô "Ý tưởng / câu lệnh": chọn nhóm (người mẫu, bối cảnh, chất vải…) rồi bấm cụm muốn thêm — cụm được NỐI vào
 * ô ý tưởng, người vẫn đọc và sửa trước khi bấm Gen. `design = false` (ảnh cho mã có sẵn) ẩn các nhóm đổi chính sản phẩm (chất
 * vải, màu, dáng, thiết kế, chi tiết) — máy luôn giữ đúng món hàng thật.
 */
export function IdeaPresets({ idea, onChange, maxChars, design, disabled }: { idea: string; onChange: (v: string) => void; maxChars: number; design: boolean; disabled?: boolean }) {
  const groups = IDEA_PRESET_GROUPS.filter((g) => design || g.scope === "ALL");
  const [open, setOpen] = useState(groups[0]?.key ?? "");
  const current = groups.find((g) => g.key === open) ?? groups[0];
  return (
    <div className="space-y-1.5 rounded-md border bg-muted/30 p-2">
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Nhóm gợi ý">
        {groups.map((g) => (
          <button
            key={g.key}
            type="button"
            role="tab"
            aria-selected={g.key === current?.key}
            className={cn("rounded-full border px-2.5 py-0.5 text-[11.5px]", g.key === current?.key ? "border-brand bg-brand/10 font-semibold text-brand" : "bg-background hover:bg-muted")}
            onClick={() => setOpen(g.key)}
          >
            {g.label}
          </button>
        ))}
      </div>
      {current ? (
        <div className="flex flex-wrap gap-1">
          {current.options.map((o) => {
            const used = idea.includes(`${current.label}: ${o}`);
            return (
              <button
                key={o}
                type="button"
                disabled={disabled || used}
                className={cn("rounded border px-2 py-0.5 text-[12px]", used ? "border-emerald-500/60 bg-emerald-500/10 text-foreground" : "bg-background hover:border-brand hover:text-brand")}
                onClick={() => onChange(appendIdeaPreset(idea, current.label, o, maxChars))}
                title={used ? "Đã có trong ô ý tưởng" : "Thêm vào ô ý tưởng"}
              >
                {used ? "✓ " : "+ "}
                {o}
              </button>
            );
          })}
        </div>
      ) : null}
      <p className="text-[11px] text-muted-foreground">Bấm để thêm vào ô ý tưởng — sửa lại tuỳ ý trước khi Gen.{design ? "" : " Ảnh cho mã có sẵn luôn giữ đúng món hàng thật nên không có nhóm chất vải / màu / dáng."}</p>
    </div>
  );
}

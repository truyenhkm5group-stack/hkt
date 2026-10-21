"use client";

import * as React from "react";
import { parseAsString, useQueryState } from "nuqs";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNavTransition } from "@/components/nav-progress";
import { POST_OFFICE_QUERY_MAX, REASON_FILTER_KEYS } from "@/lib/constants/return-reason-filters";

/**
 * 2b — ô TÌM bưu cục (vị trí lần phát cuối do ĐVVC báo). KHÔNG danh sách gợi ý / thả xuống: chữ của ĐVVC có thể mang tên / SĐT bưu tá, và
 * 671 giá trị tự do không chọn được (đo 21/10/2026). Độ phủ in ngay cạnh ô — kiện thiếu bưu cục KHÔNG bị coi là «không khớp» khi ô trống.
 * Áp khi bấm Enter / rời ô, không theo từng phím (mỗi lần áp là một lượt đi máy chủ).
 */
export function PostOfficeFilter({ value, coverage }: { value: string; coverage: { withValue: number; total: number } }) {
  const [, startTransition] = useNavTransition();
  const [, setQ] = useQueryState(REASON_FILTER_KEYS.postOffice, parseAsString.withOptions({ shallow: false, history: "push", startTransition }));
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  const apply = (v: string) => {
    const t = v.trim().slice(0, POST_OFFICE_QUERY_MAX);
    if (t !== value) void setQ(t ? t : null);
  };
  const pct = coverage.total ? Math.round((coverage.withValue / coverage.total) * 100) : null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={draft}
          maxLength={POST_OFFICE_QUERY_MAX}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") apply(draft);
          }}
          onBlur={() => apply(draft)}
          placeholder="Bưu cục chứa chữ…"
          aria-label="Tìm theo bưu cục"
          className="h-8 w-[180px] pl-7 text-[13px]"
          autoComplete="off"
        />
      </div>
      {value ? (
        <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => (setDraft(""), apply(""))} aria-label="Bỏ lọc bưu cục">
          <X className="size-3.5" />
        </Button>
      ) : null}
      <span className="text-[12px] text-muted-foreground">
        {pct === null ? "Chưa có kiện để đo độ phủ bưu cục" : `${pct}% kiện có bưu cục (${coverage.withValue}/${coverage.total}) — ${100 - pct}% còn lại không lọc được theo bưu cục`}
      </span>
    </div>
  );
}

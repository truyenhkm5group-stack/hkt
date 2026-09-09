"use client";

import { parseAsString, useQueryStates } from "nuqs";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { BANK_DIRECTIONS, BANK_DIRECTION_LABEL, type BankDirection } from "@/lib/constants/bank";
import { cn } from "@/lib/utils";

/**
 * Hai bộ lọc riêng của sổ ngân hàng: chiều tiền và "chỉ chưa phân loại".
 *
 * Tách khỏi bộ lọc facet chung vì cả hai đều là câu hỏi về CHÍNH dòng tiền chứ không phải về một
 * trường dữ liệu — và "chỉ chưa phân loại" là nút được bấm nhiều nhất khi dọn sổ cuối tháng.
 */
export function BankDirectionFilter({ value }: { value: BankDirection }) {
  const [dangChuyen, startTransition] = useTransition();
  const [, setState] = useQueryStates({ chieu: parseAsString, page: parseAsString }, { shallow: false, history: "push", startTransition });
  return (
    <select
      value={value}
      disabled={dangChuyen}
      onChange={(e) => void setState({ chieu: e.target.value === "ANY" ? null : e.target.value, page: null })}
      className={cn("h-8 rounded-md border bg-background px-2 text-xs", dangChuyen && "opacity-60")}
    >
      {BANK_DIRECTIONS.map((d) => (
        <option key={d} value={d}>
          {BANK_DIRECTION_LABEL[d]}
        </option>
      ))}
    </select>
  );
}

export function BankUnclassifiedToggle({ active, count }: { active: boolean; count: number }) {
  const [dangChuyen, startTransition] = useTransition();
  const [, setState] = useQueryStates({ chuaphanloai: parseAsString, page: parseAsString }, { shallow: false, history: "push", startTransition });
  return (
    <Button
      variant={active ? "default" : "outline"}
      size="sm"
      disabled={dangChuyen}
      className="h-8"
      onClick={() => void setState({ chuaphanloai: active ? null : "1", page: null })}
    >
      Chỉ chưa phân loại
      <span className={cn("ml-1 rounded-full px-1.5 font-mono text-[10.5px]", active ? "bg-primary-foreground/20" : "bg-muted-foreground/10 text-muted-foreground")}>{count}</span>
    </Button>
  );
}

import type { PagePathError } from "@/lib/platform-ui/page-admin-shared";
import { cn } from "@/lib/utils";

/**
 * `tone="warning"`: cảnh báo của một lượt ghi ĐÃ thành công (vd module tắt khi lưu nháp — sẽ chặn lúc xuất bản).
 *
 * Lỗi của máy chủ (`validatePageSchema`, dịch vụ trang) in NGUYÊN VĂN kèm `path` — người soạn biết đúng ô nào
 * sai mà giao diện không phải viết lại câu. `path` nội bộ (`_`) không in.
 */
export function PathErrors({ errors, className, tone = "error" }: { errors: readonly PagePathError[]; className?: string; tone?: "error" | "warning" }) {
  if (errors.length === 0) return null;
  const warn = tone === "warning";
  return (
    <ul className={cn("mt-1 space-y-0.5 text-xs", warn ? "text-amber-800 dark:text-amber-300" : "text-destructive", className)} role={warn ? "status" : "alert"}>
      {errors.map((e, i) => (
        <li key={`${e.path}-${i}`}>
          {e.path && e.path !== "_" ? <code className={cn("mr-1.5 rounded px-1 font-mono text-[11px]", warn ? "bg-amber-500/10" : "bg-destructive/10")}>{e.path}</code> : null}
          {e.message}
        </li>
      ))}
    </ul>
  );
}

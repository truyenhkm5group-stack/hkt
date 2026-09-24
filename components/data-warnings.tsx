import { TriangleAlert } from "lucide-react";
import { InfoHint } from "@/components/info-hint";
import { cn } from "@/lib/utils";

/**
 * ═══════════ CẢNH BÁO DỮ LIỆU: THU GỌN, KHÔNG BIẾN MẤT ═══════════
 *
 * Chủ shop chốt 24/09/2026: trang báo cáo chỉ hiện SỐ và BIỂU ĐỒ; mọi đoạn chữ diễn giải ẩn vào
 * hover. Nhưng cảnh báo chất lượng dữ liệu (số chưa biết, nguồn chưa đồng bộ, chiến dịch chưa ghép,
 * giá vốn dự tính…) KHÔNG được biến mất: AGENTS.md mục 42 / 67 bắt màn hình NÓI RA điều nó chưa
 * biết, nếu không người đọc sẽ tin con số là đủ.
 *
 * Nên nó thu thành MỘT nhãn nhỏ có đếm — "⚠ 3 lưu ý dữ liệu" — vẫn luôn nhìn thấy, trỏ chuột
 * (hoặc chạm) mới hiện nguyên văn. Không có cảnh báo nào ⇒ không vẽ gì.
 *
 * `tone="danger"` cho cảnh báo làm con số KHÔNG DÙNG ĐƯỢC (mô hình lỗi, cơ sở lương chưa chốt được…):
 * nhãn đổi màu đỏ để không lẫn với lưu ý thường.
 */
export function DataWarnings({
  items,
  tone = "warn",
  label,
  className,
  align = "start",
}: {
  items: React.ReactNode[];
  tone?: "warn" | "danger";
  /** Chữ trên nhãn. Mặc định: "{n} lưu ý dữ liệu". */
  label?: string;
  className?: string;
  align?: "start" | "center" | "end";
}) {
  const list = items.filter((x) => x !== null && x !== undefined && x !== false && x !== "");
  if (!list.length) return null;
  return (
    <InfoHint
      label={label ?? `${list.length} lưu ý dữ liệu`}
      align={align}
      className={className}
      trigger={
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
            tone === "danger"
              ? "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
              : "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
          )}
        >
          <TriangleAlert className="size-3" />
          {label ?? `${list.length} lưu ý dữ liệu`}
        </span>
      }
    >
      <ul className="space-y-1.5">
        {list.map((x, i) => (
          <li key={i} className="border-l-2 border-amber-300 pl-2 dark:border-amber-700">
            {x}
          </li>
        ))}
      </ul>
    </InfoHint>
  );
}

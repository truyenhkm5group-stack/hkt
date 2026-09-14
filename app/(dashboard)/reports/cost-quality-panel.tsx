import { TriangleAlert } from "lucide-react";
import { costQualityIssues } from "@/lib/queries/cost-quality";
import { formatVND } from "@/lib/format";
import type { Period } from "@/lib/search-params";
import { cn } from "@/lib/utils";

/**
 * Bảng cảnh báo chất lượng dữ liệu chi phí, đặt NGAY TRÊN báo cáo lợi nhuận.
 *
 * Đặt ở đây chứ không giấu trong một trang riêng: người đang nhìn con số lợi nhuận chính là người
 * cần biết con số đó đang có vấn đề gì. Cảnh báo ở trang khác thì đến lúc ra quyết định không ai
 * nhớ mở.
 */
export async function CostQualityPanel({ period }: { period: Period }) {
  const issues = await costQualityIssues(period);
  if (!issues.length) return null;

  return (
    <div className="space-y-2">
      {issues.map((issue) => (
        <div
          key={`${issue.rule}:${issue.title}`}
          className={cn(
            "rounded-lg border px-4 py-3 text-xs",
            issue.severity === "high"
              ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
              : "border-border bg-muted/50 text-muted-foreground",
          )}
        >
          <div className="flex items-start gap-2">
            {issue.severity === "high" ? <TriangleAlert className="mt-0.5 size-4 shrink-0" /> : null}
            <div>
              <p className="font-semibold">
                {issue.title}
                {issue.amount > 0 ? <span className="ml-1 font-normal">· {formatVND(issue.amount, { compact: true })}</span> : null}
                <span className="ml-2 rounded bg-black/5 px-1 font-mono text-[10px] font-normal dark:bg-white/10">{issue.rule}</span>
              </p>
              <p className="mt-1">{issue.detail}</p>
              <p className="mt-1 font-medium">Cần làm: {issue.action}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ArrowUpRight, CheckCircle2, ClipboardPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DEPARTMENT_LABEL, DEPARTMENT_TONE } from "@/lib/constants/departments";
import { PROBLEM_HINT, PROBLEM_LABEL, SEVERITY_LABEL, SEVERITY_TONE, type ReturnAction } from "@/lib/constants/return-intelligence";
import { saveManualTask } from "@/lib/actions/work";
import { cn } from "@/lib/utils";

/**
 * ═══════════ MỘT DÒNG CẢNH BÁO CHỈ CÓ GIÁ TRỊ KHI NÓ ĐI ĐƯỢC ĐẾN MỘT NGƯỜI ═══════════
 *
 * ─── VÌ SAO KHÔNG TỰ GIAO CHO MỘT CÁ NHÂN ───
 *
 * Nút này tạo việc cho PHÒNG BAN, không cho một người (AGENTS.md mục 22 và 25). Máy không biết hôm
 * nay ai nghỉ, ai đang gánh gấp đôi trần việc; một việc mang tên người không làm được nó sẽ biến
 * mất khỏi hàng đợi phòng và không ai đi tìm. Trưởng phòng nhận rồi mới giao.
 *
 * ─── VÌ SAO TIÊU ĐỀ CÓ MÃ VIỆC ───
 *
 * Bấm hai lần vào cùng một cảnh báo trong hai lần mở trang là chuyện sẽ xảy ra. Tiêu đề mang khoá
 * ổn định của chính cảnh báo (`action.key`), nên hai việc trùng nhìn ra ngay ở hàng đợi thay vì
 * nằm lẫn thành hai việc khác nhau. Máy KHÔNG tự chặn: chặn ở đây nghĩa là im lặng nuốt một lần
 * bấm, và người bấm sẽ tưởng hệ thống hỏng.
 */
export function ActionBoard({ actions, periodLabel }: { actions: ReturnAction[]; periodLabel: string }) {
  const [pending, startTransition] = useTransition();
  const [daTao, setDaTao] = useState<Record<string, boolean>>({});

  const taoViec = (a: ReturnAction) =>
    startTransition(async () => {
      const r = await saveManualTask({
        title: `[Hoàn · ${periodLabel}] ${a.title}`,
        summary: [
          `Nguồn: Báo cáo tỷ lệ giao thành công → khối "Cần chú ý" (${a.key}).`,
          `Chứng cứ: ${a.evidence}.`,
          `Cỡ mẫu: ${a.sample} đơn.`,
          `Lớp vấn đề: ${PROBLEM_LABEL[a.problem]}.`,
          `Việc phải làm: ${a.action}`,
          a.href ? `Xem dữ liệu: ${a.href}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        department: a.department,
        // KHÔNG gán người: trưởng phòng nhận rồi mới giao (AGENTS.md mục 22).
        assigneeId: null,
        priority: a.severity === "HIGH" ? "HIGH" : "NORMAL",
        businessEntity: a.productCode ? "PRODUCT" : "REPORT",
        businessEntityId: a.productCode ?? "reports/returns",
      });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã tạo việc cho phòng — chưa gán người, trưởng phòng nhận rồi giao.");
      setDaTao((x) => ({ ...x, [a.key]: true }));
    });

  if (!actions.length) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-[13px] text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100">
        <CheckCircle2 className="size-4 shrink-0" />
        <span>
          Không có mã hàng, marketer hay hàng đợi nào vượt ngưỡng đủ mẫu trong kỳ này. <b>Đây không phải lời khen</b> — nó chỉ nói không có gì đủ lớn và đủ chắc để nêu tên.
        </span>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-hairline">
      {actions.map((a) => (
        <li key={a.key} className="flex flex-wrap items-start gap-x-3 gap-y-2 py-2.5 first:pt-0 last:pb-0">
          <span className={cn("mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap", SEVERITY_TONE[a.severity])}>{SEVERITY_LABEL[a.severity]}</span>
          <div className="min-w-[240px] flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-[13.5px] font-semibold">{a.title}</span>
              <span className={cn("rounded px-1.5 py-0.5 text-[10.5px] font-medium whitespace-nowrap", DEPARTMENT_TONE[a.department])} title={PROBLEM_HINT[a.problem]}>
                {DEPARTMENT_LABEL[a.department]}
              </span>
            </div>
            <p className="mt-0.5 text-[12px] leading-[1.45] text-muted-foreground">{a.evidence}</p>
            <p className="mt-0.5 text-[12px] leading-[1.45]">→ {a.action}</p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {a.href ? (
              <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
                <Link href={a.href}>
                  Xem <ArrowUpRight className="size-3.5" />
                </Link>
              </Button>
            ) : null}
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={pending || daTao[a.key]} onClick={() => taoViec(a)}>
              <ClipboardPlus className="size-3.5" /> {daTao[a.key] ? "Đã tạo" : "Tạo công việc"}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

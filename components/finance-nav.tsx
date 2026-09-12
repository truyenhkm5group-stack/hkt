"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { LinkPending } from "@/components/nav-progress";
import { FINANCE_NAV, type FinanceNavItem } from "@/lib/constants/finance-nav";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ═══════════ THANH ĐIỀU HƯỚNG CỦA NHÓM TIỀN ═══════════
 *
 * Bảy trang của nhóm Tiền trước nay chỉ nối với nhau qua thanh bên. Đi từ Tổng quan sang Sổ ngân
 * hàng là mất kỳ báo cáo đang xem: trang mới mở ra ở kỳ mặc định của chính nó, và người dùng đọc
 * hai màn hình nói về hai khoảng thời gian khác nhau mà không có dấu hiệu nào báo.
 *
 * Đây là kiểu sai tệ nhất vì trông vẫn hợp lý — cùng lỗi mà `tests/drilldown-contract.test.ts`
 * sinh ra để chặn ở bảng điều khiển. Nên thanh này MANG THEO `period` / `from` / `to` qua mọi
 * liên kết, và cố ý KHÔNG mang theo `page` / `sort` / `tab`: chúng thuộc về màn hình cũ.
 *
 * CỐ Ý KHÔNG thay thanh bên. Thanh bên trả lời "tôi đi đâu được trong cả ứng dụng"; thanh này trả
 * lời "trong việc tiền, tôi còn màn hình nào" — hai câu hỏi khác nhau, và người làm kế toán ở lại
 * trong nhóm này cả buổi.
 */
export function FinanceNav({ badges }: { badges?: Partial<Record<FinanceNavItem["key"], number>> }) {
  const pathname = usePathname();
  const params = useSearchParams();

  // Chỉ giữ tham số KỲ. `page`/`sort`/`tab` của màn hình cũ mang sang màn hình mới là vô nghĩa.
  const ky = new URLSearchParams();
  for (const key of ["period", "from", "to"]) {
    const value = params.get(key);
    if (value) ky.set(key, value);
  }
  const qs = ky.toString();

  return (
    <nav aria-label="Điều hướng nhóm Tài chính" className="-mx-1 overflow-x-auto pb-0.5">
      <ul className="flex w-max min-w-full items-center gap-1 px-1">
        {FINANCE_NAV.map((item) => {
          // Đường dẫn DÀI NHẤT khớp mới được tô sáng: /reports/cashflow không được tô cả /reports.
          const active =
            pathname === item.href ||
            (pathname.startsWith(`${item.href}/`) && !FINANCE_NAV.some((o) => o !== item && o.href.length > item.href.length && (pathname === o.href || pathname.startsWith(`${o.href}/`))));
          const badge = badges?.[item.key] ?? 0;
          return (
            <li key={item.key}>
              <Link
                href={qs ? `${item.href}?${qs}` : item.href}
                aria-current={active ? "page" : undefined}
                title={item.hint}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[13px] font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <item.icon className="size-3.5 shrink-0" aria-hidden />
                {item.label}
                {badge > 0 ? (
                  <span
                    className="rounded-full bg-amber-500/20 px-1.5 font-mono text-[10.5px] text-amber-700 dark:text-amber-300"
                    title={item.badgeHint}
                  >
                    {formatNumber(badge)}
                  </span>
                ) : null}
                {/* Chấm chờ hiện đúng mục vừa bấm — cùng cơ chế với thanh bên. */}
                <LinkPending />
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

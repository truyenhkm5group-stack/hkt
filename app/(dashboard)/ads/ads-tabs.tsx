"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * ───────────── HAI GÓC NHÌN CỦA CÙNG MỘT MÀN QUẢNG CÁO ─────────────
 *
 * `/ads` trả lời "chiến dịch nào nên tăng, nên cắt" — nhìn theo CẢ KỲ.
 * `/ads/daily` trả lời "hôm nào lãi, hôm nào lỗ, và vì sao" — nhìn theo TỪNG NGÀY.
 *
 * Cố ý là TAB chứ không phải hai mục sidebar: thanh bên trái là bản đồ của cả ERP, nhét hai mục
 * của một module vào đó làm loãng bản đồ của mọi module khác (cùng quy ước với /work và /payroll).
 *
 * Giữ nguyên chuỗi truy vấn khi chuyển tab: người đang xem kỳ "30 ngày" mà bấm sang tab kia rồi
 * thấy kỳ nhảy về mặc định sẽ tưởng số liệu đổi.
 */
const TABS = [
  { href: "/ads", label: "Theo chiến dịch", hint: "Nên tăng tiền, giữ, theo dõi hay cắt — nhìn theo cả kỳ." },
  { href: "/ads/daily", label: "Hiệu quả theo ngày", hint: "Mỗi ngày tiêu bao nhiêu → ra bao nhiêu đơn → lãi hay lỗ. Mốc mặc định: ngày phát sinh đơn." },
];

export function AdsTabs() {
  const pathname = usePathname();
  const params = useSearchParams();
  const qs = params.toString();
  return (
    <div className="flex flex-wrap items-center gap-1 border-b pb-2">
      {TABS.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={qs ? `${t.href}?${qs}` : t.href}
            title={t.hint}
            className={cn("rounded-md px-2.5 py-1 text-xs font-medium transition-colors", active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}

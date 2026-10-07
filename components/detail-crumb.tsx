"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { NAV_TITLES } from "@/components/app-sidebar";
import { DYNAMIC_PAGE_PREFIX } from "@/lib/pages/nav";

/**
 * ĐƯỜNG QUAY LẠI CHO TRANG CHI TIẾT.
 *
 * Thanh bên cũ có breadcrumb "Đơn hàng / 48210" ở đầu trang. Thanh menu viên thuốc không còn chỗ cho
 * nó, nhưng người đang xem MỘT đơn vẫn cần một cú bấm để về danh sách — nên dòng này chỉ hiện ở
 * trang chi tiết (đường dẫn sâu hơn trang có mục menu), và không chiếm chỗ ở mọi trang khác.
 */
/** Khu vực tự vẽ đường quay lại của chính nó (giao diện điện thoại) — không in dòng vị trí. */
const OWN_NAV_PREFIXES = ["/wholesale/mobile"];

/** `skip`: trang đứng trên thanh tám mục của vỏ app Chốt Đơn — là trang gốc, không phải trang chi tiết, nên không in đường quay lại. */
export function DetailCrumb({ skip = [] }: { skip?: readonly string[] }) {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  if (skip.includes(pathname)) return null;
  // Trang tuỳ biến `/p/<slug>` (Phase 4) không phải trang chi tiết: không có trang `/p` trần để quay về, và trang
  // động tự in tên của nó. "/p" có trong NAV_TITLES chỉ để làm khoá đếm lượt mở.
  if (`/${segments[0]}` === DYNAMIC_PAGE_PREFIX) return null;
  // Màn điện thoại của sale sỉ tự có nút quay lại to bằng ngón tay — dòng vị trí in «queue» / mã lead chỉ chiếm chỗ.
  if (OWN_NAV_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;
  const twoLevel = `/${segments.slice(0, 2).join("/")}`;
  // Trang có mục menu riêng (vd /reports/returns) KHÔNG phải trang chi tiết.
  if (NAV_TITLES[twoLevel] && segments.length === 2) return null;
  const parentHref = NAV_TITLES[twoLevel] ? twoLevel : `/${segments[0]}`;
  const parentTitle = NAV_TITLES[parentHref];
  if (!parentTitle) return null;
  const detail = decodeURIComponent(segments.slice(parentHref.split("/").length - 1).join(" / "));
  return (
    <nav aria-label="Vị trí" className="-mb-2 flex items-center gap-1 text-[13px] text-muted-foreground print:hidden">
      <Link href={parentHref} className="flex items-center gap-1 rounded-full px-2 py-1 font-medium hover:bg-card hover:text-foreground">
        <ChevronLeft className="size-4" aria-hidden />
        {parentTitle}
      </Link>
      <span aria-hidden>/</span>
      <span className="max-w-[240px] truncate px-1">{detail}</span>
    </nav>
  );
}

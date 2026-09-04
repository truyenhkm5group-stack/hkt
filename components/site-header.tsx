"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_TITLES } from "@/components/app-sidebar";
import { RealtimeIndicator } from "@/components/realtime-provider";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { GlobalSearch } from "@/components/global-search";

export function SiteHeader() {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);
  const first = segments.length ? `/${segments[0]}` : "/";
  const firstTitle = NAV_TITLES[`/${segments.slice(0, 2).join("/")}`] ?? NAV_TITLES[first] ?? "Trang";
  const detail = segments.length > 1 && !NAV_TITLES[`/${segments.slice(0, 2).join("/")}`] ? segments.slice(1).join(" / ") : null;

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/60 sm:px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 h-4" />
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem className="hidden sm:block">
            <BreadcrumbLink asChild>
              <Link href="/">Shop Control</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator className="hidden sm:block" />
          <BreadcrumbItem>
            {detail ? (
              <BreadcrumbLink asChild>
                <Link href={first}>{firstTitle}</Link>
              </BreadcrumbLink>
            ) : (
              <BreadcrumbPage>{pathname === "/" ? "Tổng quan" : firstTitle}</BreadcrumbPage>
            )}
          </BreadcrumbItem>
          {detail ? (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage className="max-w-[200px] truncate">{decodeURIComponent(detail)}</BreadcrumbPage>
              </BreadcrumbItem>
            </>
          ) : null}
        </BreadcrumbList>
      </Breadcrumb>
      <div className="ml-auto flex items-center gap-2">
        <GlobalSearch />
        <RealtimeIndicator />
      </div>
    </header>
  );
}

"use client";

import Link from "next/link";
import { useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { allowedCreateKeys } from "@/lib/actions/quick-create";
import { CREATE_ACTIONS, type CreateAction, type CreateKey } from "@/lib/constants/command-catalog";

/**
 * Hỏi máy chủ MỘT lần mỗi phiên trang những loại người này tạo được. Dùng chung cho nút «+ Tạo mới» và ô lệnh ⌘K, để
 * hai chỗ không bao giờ hiện hai danh sách khác nhau.
 */
let cache: Promise<CreateKey[]> | null = null;
export function loadCreateActions(): Promise<CreateAction[]> {
  cache ??= allowedCreateKeys().catch(() => {
    cache = null;
    return [] as CreateKey[];
  });
  return cache.then((keys) => CREATE_ACTIONS.filter((a) => keys.includes(a.key)));
}

/** «+ Tạo mới» trên thanh trên: tạo đơn / khách / sản phẩm… mà không phải đi tìm module trước. */
export function QuickCreate() {
  const [items, setItems] = useState<CreateAction[] | null>(null);
  return (
    <DropdownMenu onOpenChange={(open) => (open && !items ? void loadCreateActions().then(setItems) : undefined)}>
      <DropdownMenuTrigger asChild>
        <Button size="sm" className="h-10 gap-1.5 rounded-full px-3 sm:px-4" aria-label="Tạo mới">
          <Plus className="size-4" />
          <span className="hidden sm:inline">Tạo mới</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={10} className="w-60 rounded-2xl p-2">
        <DropdownMenuLabel className="px-2.5 text-[13px] font-bold">Tạo mới</DropdownMenuLabel>
        {items === null ? (
          <div className="flex items-center gap-2 px-2.5 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Đang tải…
          </div>
        ) : items.length === 0 ? (
          <p className="px-2.5 py-2 text-sm text-muted-foreground">Tài khoản của bạn chưa được tạo mới ở đây.</p>
        ) : (
          items.map((a) => (
            <DropdownMenuItem key={a.key} asChild className="rounded-xl px-2.5 py-2 text-[14px]">
              <Link href={a.href}>
                <Plus className="size-4 text-muted-foreground" /> {a.label}
              </Link>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

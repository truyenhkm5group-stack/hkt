"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, ShoppingBag, Truck, Users, Shirt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Kbd } from "@/components/kbd";

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const router = useRouter();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };
  const q = query.trim();

  return (
    <>
      <Button variant="outline" size="sm" className="h-8 w-8 justify-start gap-2 px-0 text-muted-foreground sm:w-56 sm:px-3" onClick={() => setOpen(true)}>
        <Search className="size-4" />
        <span className="hidden flex-1 text-left text-xs font-normal sm:inline">Tìm đơn, SĐT, mã vận đơn…</span>
        <Kbd className="hidden sm:inline-flex">⌘K</Kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen} title="Tìm kiếm" description="Tìm nhanh đơn hàng, vận đơn, khách hàng, sản phẩm">
        <CommandInput placeholder="Nhập mã đơn, số điện thoại, tên khách, mã vận đơn…" value={query} onValueChange={setQuery} />
        <CommandList>
          <CommandEmpty>Nhập từ khoá rồi chọn nơi cần tìm.</CommandEmpty>
          <CommandGroup heading={q ? `Tìm "${q}" trong` : "Đi tới"}>
            <CommandItem value={`orders ${q}`} onSelect={() => go(q ? `/orders?q=${encodeURIComponent(q)}` : "/orders")}>
              <ShoppingBag className="size-4" /> Đơn hàng
            </CommandItem>
            <CommandItem value={`shipments ${q}`} onSelect={() => go(q ? `/shipments?q=${encodeURIComponent(q)}` : "/shipments")}>
              <Truck className="size-4" /> Vận đơn
            </CommandItem>
            <CommandItem value={`customers ${q}`} onSelect={() => go(q ? `/customers?q=${encodeURIComponent(q)}` : "/customers")}>
              <Users className="size-4" /> Khách hàng
            </CommandItem>
            <CommandItem value={`products ${q}`} onSelect={() => go(q ? `/products?q=${encodeURIComponent(q)}` : "/products")}>
              <Shirt className="size-4" /> Sản phẩm
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}

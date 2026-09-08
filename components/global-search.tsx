"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search, ShoppingBag, Truck, Users, Shirt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Kbd } from "@/components/kbd";
import { globalSearch } from "@/lib/actions/search";
import type { SearchHit, SearchResult } from "@/lib/queries/search";

const ICON = { ORDER: ShoppingBag, SHIPMENT: Truck, CUSTOMER: Users, PRODUCT: Shirt } as const;
const GROUP_LABEL = { ORDER: "Đơn hàng", SHIPMENT: "Vận đơn", CUSTOMER: "Khách hàng", PRODUCT: "Sản phẩm" } as const;
const LIST_HREF = { ORDER: "/orders", SHIPMENT: "/shipments", CUSTOMER: "/customers", PRODUCT: "/products" } as const;

/**
 * Ô LỆNH ⌘K.
 *
 * Trước đây nó chỉ ĐIỀU HƯỚNG: gõ số điện thoại rồi phải tự chọn "tìm trong Đơn hàng". Người dùng
 * buộc phải đoán trước dữ liệu nằm ở module nào, trong khi câu hỏi thật thường là "số này có gì?".
 *
 * Nay hiện KẾT QUẢ THẬT. Và khi một số điện thoại khớp nhiều đơn / nhiều vận đơn — chuyện hoàn toàn
 * bình thường vì khách mua nhiều lần và vận đơn chiều hoàn là dòng riêng — nó nói thẳng ra, để
 * không ai tưởng bản ghi đầu tiên là bản ghi duy nhất.
 */
export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [pending, startTransition] = useTransition();
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

  const q = query.trim();

  // Chờ 250ms sau lần gõ cuối rồi mới tra — gõ một số điện thoại 10 chữ số không nên tạo 10 truy vấn.
  useEffect(() => {
    if (q.length < 2) {
      setResult(null);
      return;
    }
    const timer = setTimeout(() => {
      startTransition(async () => {
        const r = await globalSearch(q).catch(() => null);
        // Bỏ qua kết quả về muộn của một từ khoá đã cũ.
        setResult((prev) => (r && r.query === q ? r : prev));
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  const go = (href: string) => {
    setOpen(false);
    setQuery("");
    setResult(null);
    router.push(href);
  };

  const grouped = (kind: SearchHit["kind"]) => (result?.hits ?? []).filter((h) => h.kind === kind);
  const countOf = (kind: SearchHit["kind"]) =>
    kind === "ORDER" ? result?.counts.orders : kind === "SHIPMENT" ? result?.counts.shipments : kind === "CUSTOMER" ? result?.counts.customers : result?.counts.products;

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
          {/* Một số điện thoại KHÔNG phải một đơn — nói thẳng khi nó khớp nhiều bản ghi. */}
          {result?.ambiguous ? (
            <div className="border-b bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">{result.ambiguous}</div>
          ) : null}

          <CommandEmpty>
            {q.length < 2 ? "Nhập ít nhất 2 ký tự." : pending ? "Đang tìm…" : "Không tìm thấy bản ghi nào khớp."}
          </CommandEmpty>

          {(["ORDER", "SHIPMENT", "CUSTOMER", "PRODUCT"] as const).map((kind) => {
            const hits = grouped(kind);
            if (!hits.length) return null;
            const total = countOf(kind) ?? hits.length;
            const Icon = ICON[kind];
            return (
              <CommandGroup key={kind} heading={`${GROUP_LABEL[kind]}${total > hits.length ? ` — hiện ${hits.length}/${total}` : ` (${total})`}`}>
                {hits.map((h) => (
                  <CommandItem key={`${h.kind}-${h.id}`} value={`${h.kind} ${h.id} ${h.title} ${h.subtitle}`} onSelect={() => go(h.href)}>
                    <Icon className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{h.title}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{h.subtitle}</span>
                    </span>
                  </CommandItem>
                ))}
                {total > hits.length ? (
                  <CommandItem value={`more-${kind}-${q}`} onSelect={() => go(`${LIST_HREF[kind]}?q=${encodeURIComponent(q)}`)}>
                    <Search className="size-4" /> Xem tất cả {total} {GROUP_LABEL[kind].toLowerCase()}
                  </CommandItem>
                ) : null}
              </CommandGroup>
            );
          })}

          <CommandGroup heading={q ? `Mở danh sách đầy đủ` : "Đi tới"}>
            <CommandItem value={`orders-list ${q}`} onSelect={() => go(q ? `/orders?q=${encodeURIComponent(q)}` : "/orders")}>
              <ShoppingBag className="size-4" /> Đơn hàng
            </CommandItem>
            <CommandItem value={`shipments-list ${q}`} onSelect={() => go(q ? `/shipments?q=${encodeURIComponent(q)}` : "/shipments")}>
              <Truck className="size-4" /> Vận đơn
            </CommandItem>
            <CommandItem value={`customers-list ${q}`} onSelect={() => go(q ? `/customers?q=${encodeURIComponent(q)}` : "/customers")}>
              <Users className="size-4" /> Khách hàng
            </CommandItem>
            <CommandItem value={`products-list ${q}`} onSelect={() => go(q ? `/products?q=${encodeURIComponent(q)}` : "/products")}>
              <Shirt className="size-4" /> Sản phẩm
            </CommandItem>
          </CommandGroup>

          {pending ? (
            <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Đang tìm…
            </div>
          ) : null}
        </CommandList>
      </CommandDialog>
    </>
  );
}

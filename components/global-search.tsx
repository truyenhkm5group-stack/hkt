"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Clock, ListTodo, Loader2, Pin, PinOff, Plus, Search, ShoppingBag, Shirt, Sparkles, Truck, UserRound, Users, Zap } from "lucide-react";
import { allowedNavItems, type NavUserLike } from "@/components/app-sidebar";
import { Button } from "@/components/ui/button";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { openCopilot } from "@/components/ai-copilot";
import { useNavMemory } from "@/components/nav-memory";
import { loadCreateActions } from "@/components/quick-create";
import { pageSearchText, QUICK_VIEWS, type CreateAction } from "@/lib/constants/command-catalog";
import { Kbd } from "@/components/kbd";
import { cn } from "@/lib/utils";
import { CareDrawer } from "@/app/(dashboard)/shipments/care-drawer";
import { globalSearch } from "@/lib/actions/search";
import type { SearchHit, SearchResult } from "@/lib/queries/search";

const ICON = { ORDER: ShoppingBag, SHIPMENT: Truck, CUSTOMER: Users, PRODUCT: Shirt, WORK: ListTodo, EMPLOYEE: UserRound } as const;
const GROUP_LABEL = { ORDER: "Đơn hàng", SHIPMENT: "Vận đơn", CUSTOMER: "Khách hàng", PRODUCT: "Sản phẩm", WORK: "Công việc", EMPLOYEE: "Nhân sự" } as const;
const LIST_HREF = { ORDER: "/orders", SHIPMENT: "/shipments", CUSTOMER: "/customers", PRODUCT: "/products", WORK: "/work/all", EMPLOYEE: "/work/all" } as const;

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
export function GlobalSearch({ user }: { user: NavUserLike }) {
  const [open, setOpen] = useState(false);
  /*
    ĐI TỚI BẤT KỲ TRANG NÀO TỪ BÀN PHÍM.

    Thanh bên có hơn ba mươi mục; ô lệnh trước đây chỉ có bốn lối tắt. Người dùng biết tên trang
    ("kiểm đếm hàng hoàn", "đối soát") nhưng phải rê chuột tìm trong bốn nhóm. Nay gõ vài chữ của
    tên trang là tới — danh sách lọc theo đúng quyền của người đang đăng nhập, cùng luật với thanh bên.
  */
  const pages = useMemo(() => allowedNavItems(user), [user]);
  const pageByHref = useMemo(() => new Map(pages.map((p) => [p.href, p])), [pages]);
  // LỐI ĐI NHANH chỉ hiện khi trang gốc nằm trong menu đã lọc quyền của người này — sổ lệnh không cấp quyền gì.
  const quickViews = useMemo(() => QUICK_VIEWS.filter((v) => pageByHref.has(v.base)), [pageByHref]);
  const { recent, pinned, togglePin } = useNavMemory();
  const [creates, setCreates] = useState<CreateAction[]>([]);
  useEffect(() => {
    if (open) void loadCreateActions().then(setCreates);
  }, [open]);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  /*
    Chọn một VẬN ĐƠN thì mở NGĂN KÉO, không rời trang.

    Ô lệnh thường được gọi ra giữa lúc đang làm việc khác — tra một mã vận đơn rồi bị ném sang trang
    khác là làm mất chỗ đang đứng, và người dùng phải bấm quay lại. Đơn / khách / sản phẩm vẫn điều
    hướng như cũ: ở đó người ta thường MUỐN sang trang đó làm tiếp.
  */
  const [xemVanDon, setXemVanDon] = useState<string | null>(null);
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
    kind === "ORDER"
      ? result?.counts.orders
      : kind === "SHIPMENT"
        ? result?.counts.shipments
        : kind === "CUSTOMER"
          ? result?.counts.customers
          : kind === "WORK"
            ? result?.counts.work
            : kind === "EMPLOYEE"
              ? result?.counts.employees
              : result?.counts.products;

  return (
    <>
      {/*
        Ô LỆNH LÀ CỬA CHÍNH, KHÔNG PHẢI NÚT KÍNH LÚP. Từ 1024px nó là một ô rộng có chữ "Tìm hoặc gõ việc cần làm" — người
        ít rành máy không biết bấm ⌘K, nhưng biết bấm vào một ô tìm kiếm.
      */}
      <Button variant="ghost" size="sm" aria-label="Tìm kiếm hoặc gõ việc cần làm" className="h-10 w-10 justify-center gap-2 rounded-full bg-muted px-0 text-muted-foreground hover:bg-muted/70 lg:w-60 lg:justify-start lg:px-4 2xl:w-72" onClick={() => setOpen(true)}>
        <Search className="size-4" />
        <span className="hidden flex-1 truncate text-left text-[13px] font-normal lg:inline">Tìm hoặc gõ việc cần làm…</span>
        <Kbd className="hidden lg:inline-flex">Ctrl K</Kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen} title="Tìm kiếm" description="Tìm dữ liệu, đi tới trang, tạo mới hoặc hỏi AI">
        <CommandInput placeholder="Gõ SĐT, mã đơn, tên khách… hoặc việc cần làm: «đơn hoàn», «tạo khách», «bảng lương»" value={query} onValueChange={setQuery} />
        <CommandList>
          {/* Một số điện thoại KHÔNG phải một đơn — nói thẳng khi nó khớp nhiều bản ghi. */}
          {result?.ambiguous ? (
            <div className="border-b bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">{result.ambiguous}</div>
          ) : null}

          <CommandEmpty>
            {q.length < 2 ? "Nhập ít nhất 2 ký tự." : pending ? "Đang tìm…" : "Không tìm thấy. Thử hỏi AI ở dưới, hoặc gõ ít chữ hơn."}
          </CommandEmpty>

          {/* Ô còn trống: hiện thứ người này hay dùng TRƯỚC, không bắt họ nhớ tên trang. */}
          {!q && pinned.some((h) => pageByHref.has(h)) ? (
            <CommandGroup heading="Đã ghim">
              {pinned.filter((h) => pageByHref.has(h)).map((h) => {
                const p = pageByHref.get(h)!;
                return (
                  <CommandItem key={`pin-${h}`} value={`ghim ${p.label} ${h}`} onSelect={() => go(h)}>
                    <Pin className="size-4 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1 truncate text-sm">{p.label}</span>
                    <span className="text-xs text-muted-foreground">{p.group}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ) : null}
          {!q && recent.some((h) => pageByHref.has(h) && !pinned.includes(h)) ? (
            <CommandGroup heading="Gần đây">
              {recent.filter((h) => pageByHref.has(h) && !pinned.includes(h)).map((h) => {
                const p = pageByHref.get(h)!;
                return (
                  <CommandItem key={`recent-${h}`} value={`gần đây ${p.label} ${h}`} onSelect={() => go(h)}>
                    <Clock className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm">{p.label}</span>
                    <span className="text-xs text-muted-foreground">{p.group}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ) : null}
          {quickViews.length ? (
            <CommandGroup heading="Việc cần xem nhanh">
              {quickViews.map((v) => (
                <CommandItem key={v.key} value={`nhanh ${v.label} ${v.hint} ${v.keywords.join(" ")}`} onSelect={() => go(v.href)}>
                  <Zap className="size-4 shrink-0 text-amber-500" />
                  <span className="min-w-0 flex-1 truncate text-sm">{v.label}</span>
                  <span className="truncate text-xs text-muted-foreground">{v.hint}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {creates.length ? (
            <CommandGroup heading="Tạo mới">
              {creates.map((a) => (
                <CommandItem key={`create-${a.key}`} value={`tạo mới ${a.label} ${a.keywords.join(" ")}`} onSelect={() => go(a.href)}>
                  <Plus className="size-4 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate text-sm">Tạo {a.label.toLowerCase()}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}

          {(["ORDER", "SHIPMENT", "CUSTOMER", "PRODUCT", "WORK", "EMPLOYEE"] as const).map((kind) => {
            const hits = grouped(kind);
            if (!hits.length) return null;
            const total = countOf(kind) ?? hits.length;
            const Icon = ICON[kind];
            return (
              <CommandGroup key={kind} heading={`${GROUP_LABEL[kind]}${total > hits.length ? ` — hiện ${hits.length}/${total}` : ` (${total})`}`}>
                {hits.map((h) => (
                  <CommandItem
                    key={`${h.kind}-${h.id}`}
                    value={`${h.kind} ${h.id} ${h.title} ${h.subtitle}`}
                    onSelect={() => {
                      if (kind === "SHIPMENT") {
                        setOpen(false);
                        setXemVanDon(h.id);
                        return;
                      }
                      go(h.href);
                    }}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{h.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">{h.subtitle}</span>
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

          {q.length >= 2 ? (
            <CommandGroup heading="Hỏi AI">
              {/* Câu hỏi về số liệu ("hôm nay bao nhiêu đơn chưa gửi?") — trợ lý trả lời kèm liên kết; thao tác ghi luôn chờ người xác nhận. */}
              <CommandItem
                value={`hỏi ai ${q}`}
                onSelect={() => {
                  setOpen(false);
                  setQuery("");
                  openCopilot({ message: q, send: true });
                }}
              >
                <Sparkles className="size-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate text-sm">Hỏi AI: «{q}»</span>
              </CommandItem>
            </CommandGroup>
          ) : null}

          {q ? (
            <CommandGroup heading="Mở danh sách đầy đủ với từ khoá này">
              <CommandItem value={`orders-list ${q}`} onSelect={() => go(`/orders?q=${encodeURIComponent(q)}`)}>
                <ShoppingBag className="size-4" /> Đơn hàng
              </CommandItem>
              <CommandItem value={`shipments-list ${q}`} onSelect={() => go(`/shipments?q=${encodeURIComponent(q)}`)}>
                <Truck className="size-4" /> Vận đơn
              </CommandItem>
              <CommandItem value={`customers-list ${q}`} onSelect={() => go(`/customers?q=${encodeURIComponent(q)}`)}>
                <Users className="size-4" /> Khách hàng
              </CommandItem>
              <CommandItem value={`products-list ${q}`} onSelect={() => go(`/products?q=${encodeURIComponent(q)}`)}>
                <Shirt className="size-4" /> Sản phẩm
              </CommandItem>
            </CommandGroup>
          ) : null}

          {/* Mọi trang được phép — so khớp cả BÍ DANH ("bảng lương", "kết nối page"); ghim bằng nút cuối dòng. */}
          <CommandGroup heading="Đi tới trang">
            {pages.map((p) => {
              const isPinned = pinned.includes(p.href);
              return (
                <CommandItem key={p.href} value={`trang ${pageSearchText(p.href, p.label, p.group)} ${p.href}`} onSelect={() => go(p.href)} className="group/page">
                  <p.icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm">{p.label}</span>
                  <span className="text-xs text-muted-foreground">{p.group}</span>
                  <button
                    type="button"
                    aria-label={isPinned ? `Bỏ ghim ${p.label}` : `Ghim ${p.label}`}
                    title={isPinned ? "Bỏ ghim" : "Ghim lên đầu"}
                    className={cn("rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground", isPinned ? "text-primary" : "opacity-0 group-hover/page:opacity-100 group-data-[selected=true]/page:opacity-100 focus-visible:opacity-100")}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      togglePin(p.href);
                    }}
                  >
                    {isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                  </button>
                </CommandItem>
              );
            })}
          </CommandGroup>

          {pending ? (
            <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Đang tìm…
            </div>
          ) : null}
        </CommandList>
      </CommandDialog>

      {xemVanDon ? <CareDrawer shipmentId={xemVanDon} open onOpenChange={(v) => !v && setXemVanDon(null)} /> : null}
    </>
  );
}

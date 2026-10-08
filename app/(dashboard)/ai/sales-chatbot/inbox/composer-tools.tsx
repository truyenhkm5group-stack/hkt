"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ImageIcon, Loader2, MessageSquareText, Package } from "lucide-react";
import { toast } from "sonner";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { composerProductPickAction, composerProductSearchAction, composerQuickRepliesAction, composerQuickReplyTextAction } from "@/lib/actions/sales-inbox";
import type { ComposerProductHit, ComposerQuickReply } from "@/lib/sales-chatbot/inbox-composer";
import { COMPOSER_QUERY } from "@/lib/sales-chatbot/inbox-composer-shared";
import { cn } from "@/lib/utils";

/**
 * ═══════════ CÔNG CỤ Ô SOẠN: «CÂU MẪU» · «SẢN PHẨM» (Master Mission P0.2 «Unified Inbox») ═══════════
 *
 * Hai nút cạnh «AI gợi ý câu trả lời». Bấm một dòng ⇒ CHÈN chữ vào ô soạn (tại con trỏ, hoặc nối cuối) để nhân viên sửa rồi bấm
 * «Gửi» có sẵn — không bao giờ tự gửi. Mọi con số (giá, tồn, phí ship) do máy chủ đọc từ ERP LÚC BẤM
 * (`lib/sales-chatbot/inbox-composer.ts`); trang chỉ giữ chữ đang gõ trong ô tìm. Bàn phím: ↑ ↓ chọn · Enter chèn · Esc đóng.
 *
 * CHÈN CHỈ KHI BẢNG CÒN MỞ: lượt bấm chờ máy chủ trả chữ; trong lúc đó nhân viên có thể bấm Esc, bấm ra ô soạn để gõ tiếp, hay
 * bấm một dòng khác. Mỗi lượt mở / đóng / bấm đánh một số lượt (`pickSeq`) — kết quả về mà số đã đổi thì BỎ, không chèn.
 */

type Props = { conversationId: string; disabled: boolean; onInsert: (snippet: string) => boolean };

/** Gõ xong chừng này mới hỏi máy chủ. */
const QUICK_DEBOUNCE_MS = 200;
const PRODUCT_DEBOUNCE_MS = 300;

const TRIGGER = "inline-flex items-center gap-1 rounded py-1 text-foreground/80 hover:text-foreground hover:underline disabled:opacity-50";
// Điện thoại: bảng không rộng quá màn hình, không cao quá phần còn thấy (bàn phím ảo mở thì danh sách co lại, ô tìm + chân vẫn hiện).
const PANEL = "flex max-h-(--radix-popover-content-available-height) w-[min(26rem,calc(100vw-1.5rem))] flex-col p-0";
const LIST = "max-h-[min(20rem,40dvh)] min-h-0";
const FOOT = "shrink-0 space-y-0.5 border-t px-3 py-2 text-[11.5px] leading-snug text-muted-foreground";

function Status({ children, tone }: { children: ReactNode; tone?: "error" }) {
  return <div className={cn("px-3 py-4 text-center text-[12.5px]", tone === "error" ? "text-destructive" : "text-muted-foreground")}>{children}</div>;
}

export function ComposerTools(props: Props) {
  return (
    <>
      <QuickReplyPicker {...props} />
      <ProductPicker {...props} />
    </>
  );
}

function QuickReplyPicker({ conversationId, disabled, onInsert }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ComposerQuickReply[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const seq = useRef(0);
  const pickSeq = useRef(0);
  const inserted = useRef(false);

  // Danh sách đọc lại MỖI lần mở (câu vừa tắt / vừa thêm có hiệu lực ngay); gõ lọc ⇒ hỏi lại sau một nhịp, câu trả lời cũ bị bỏ.
  useEffect(() => {
    if (!open) return;
    const my = ++seq.current;
    setLoading(true);
    const timer = window.setTimeout(() => {
      composerQuickRepliesAction(conversationId, query)
        .then((r) => {
          if (my !== seq.current) return;
          if ("error" in r) {
            setError(r.error);
            setItems([]);
            return;
          }
          setError(null);
          setItems(r.items);
          setTotal(r.total);
          setSelected(r.items[0]?.id ?? "");
        })
        .catch(() => {
          if (my === seq.current) setError("Không tải được câu mẫu — thử lại.");
        })
        .finally(() => {
          if (my === seq.current) setLoading(false);
        });
    }, query ? QUICK_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
  }, [open, query, conversationId]);

  /**
   * Đóng ⇒ bỏ câu trả lời còn trên đường — của danh sách lẫn của lượt bấm (bảng giữ nguyên nội dung trong lúc mờ dần). Mở ⇒ bắt
   * đầu SẠCH, vòng chờ hiện ngay — không loé danh sách của lần lọc trước.
   */
  const toggle = (v: boolean) => {
    seq.current += 1;
    pickSeq.current += 1;
    setBusy(null);
    setOpen(v);
    if (!v) return;
    setQuery("");
    setItems([]);
    setTotal(null);
    setError(null);
    setLoading(true);
  };

  const pick = async (q: ComposerQuickReply) => {
    const my = ++pickSeq.current;
    setBusy(q.id);
    try {
      const r = await composerQuickReplyTextAction(conversationId, q.id);
      if (my !== pickSeq.current) return;
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      if (!onInsert(r.text)) return;
      inserted.current = true;
      toggle(false);
      if (r.imageCount > 0) toast.message(`Đã chèn chữ của «${r.title}». ${r.imageCount} ảnh của câu mẫu KHÔNG đi kèm — cần ảnh thì bấm nút ảnh cạnh ô soạn.`);
    } catch {
      if (my === pickSeq.current) toast.error("Không đọc được câu mẫu — thử lại.");
    } finally {
      if (my === pickSeq.current) setBusy(null);
    }
  };

  const active = items.find((i) => i.id === selected) ?? null;
  const q = query.trim();

  return (
    <Popover open={open} onOpenChange={toggle}>
      <PopoverTrigger asChild>
        <button type="button" className={TRIGGER} disabled={disabled} aria-label="Chèn câu trả lời mẫu vào ô soạn" data-testid="inbox-composer-quick-replies">
          <MessageSquareText className="size-3.5" /> Câu mẫu
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className={PANEL}
        onCloseAutoFocus={(e) => {
          // Vừa chèn ⇒ con trỏ ở lại ô soạn (đã đặt sau đoạn chèn), không nhảy về nút.
          if (inserted.current) e.preventDefault();
          inserted.current = false;
        }}
      >
        <Command shouldFilter={false} loop value={selected} onValueChange={setSelected} label="Câu trả lời mẫu" className="min-h-0">
          <CommandInput value={query} onValueChange={(v) => setQuery(v.slice(0, COMPOSER_QUERY.max))} maxLength={COMPOSER_QUERY.max} placeholder="Lọc câu mẫu — không dấu cũng được…" aria-label="Lọc câu trả lời mẫu" />
          <CommandList className={LIST}>
            {loading && !items.length ? (
              <Status>
                <Loader2 className="mx-auto size-4 animate-spin" />
              </Status>
            ) : null}
            {error ? <Status tone="error">{error}</Status> : null}
            {!loading && !error && total === 0 ? (
              <Status>
                Chưa có câu mẫu nào đang bật — người quản lý chatbot thêm ở{" "}
                <Link href="/ai/sales-chatbot/quick-replies" className="text-primary hover:underline">
                  Câu trả lời mẫu
                </Link>
                .
              </Status>
            ) : null}
            {!loading && !error && total !== null && total > 0 && !items.length ? <Status>Không có câu mẫu nào khớp «{q}».</Status> : null}
            {items.map((it) => (
              <CommandItem key={it.id} value={it.id} onSelect={() => void pick(it)} className="flex-col items-stretch gap-0.5">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{it.title}</span>
                  {it.imageCount ? (
                    <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground" title="Ảnh của câu mẫu không đi kèm khi chèn">
                      <ImageIcon className="size-3" />
                      {it.imageCount}
                    </span>
                  ) : null}
                  {busy === it.id ? <Loader2 className="size-3.5 animate-spin" /> : null}
                </div>
                <p className="line-clamp-2 text-[12px] text-muted-foreground">{it.preview}</p>
              </CommandItem>
            ))}
          </CommandList>
          <div className={FOOT}>
            {active?.imageCount ? <p className="text-amber-700 dark:text-amber-300">Câu này có {active.imageCount} ảnh — ảnh KHÔNG đi kèm khi chèn (chỉ chữ). Cần ảnh thì bấm nút ảnh cạnh ô soạn.</p> : null}
            {active?.needsErp ? <p>Giá / tồn / phí ship trong câu điền từ ERP lúc bấm — ERP chưa có số thì không chèn.</p> : null}
            <p>Chèn chữ vào ô soạn để sửa rồi bấm Gửi — không tự gửi · Enter chèn · Esc đóng.</p>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ProductPicker({ conversationId, disabled, onInsert }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ComposerProductHit[]>([]);
  const [searched, setSearched] = useState<string | null>(null);
  const [priceNote, setPriceNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const seq = useRef(0);
  const pickSeq = useRef(0);
  const inserted = useRef(false);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    const my = ++seq.current;
    // Dưới ngưỡng ký tự ⇒ không hỏi máy chủ: mỗi lượt tìm đọc cả danh mục, và server action xếp hàng trước nút «Gửi».
    if (q.length < COMPOSER_QUERY.productMin) {
      setItems([]);
      setSearched(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = window.setTimeout(() => {
      composerProductSearchAction(conversationId, q)
        .then((r) => {
          if (my !== seq.current) return;
          setSearched(q);
          if ("error" in r) {
            setError(r.error);
            setItems([]);
            return;
          }
          setError(null);
          setItems(r.items);
          setPriceNote(r.priceNote);
          setSelected(r.items[0]?.variantId ?? "");
        })
        .catch(() => {
          if (my === seq.current) setError("Không tìm được — thử lại.");
        })
        .finally(() => {
          if (my === seq.current) setLoading(false);
        });
    }, PRODUCT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, query, conversationId]);

  /** Đóng ⇒ bỏ câu trả lời còn trên đường, của lượt tìm lẫn lượt bấm (bảng giữ nội dung trong lúc mờ dần). Mở ⇒ lượt tìm mới, sạch. */
  const toggle = (v: boolean) => {
    seq.current += 1;
    pickSeq.current += 1;
    setBusy(null);
    setOpen(v);
    if (!v) return;
    setQuery("");
    setItems([]);
    setSearched(null);
    setPriceNote(null);
    setError(null);
    setLoading(false);
  };

  const pick = async (p: ComposerProductHit) => {
    const my = ++pickSeq.current;
    setBusy(p.variantId);
    try {
      // Đọc lại lúc bấm — đích danh mẫu mã này: giá có thể vừa đổi, mẫu mã có thể vừa thôi bán, và tồn chỉ đọc ở đây.
      const r = await composerProductPickAction(conversationId, p.variantId);
      if (my !== pickSeq.current) return;
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      if (!onInsert(r.product.line)) return;
      inserted.current = true;
      toggle(false);
      const notes = [
        r.product.priceText !== p.priceText ? `Giá trong ERP vừa đổi — đã chèn giá mới: ${r.product.priceText ?? "chưa có giá"}.` : r.product.price === null ? "Mẫu mã chưa có giá trong ERP — dòng chèn không kèm giá." : null,
        r.product.stockNote,
      ].filter((x): x is string => Boolean(x));
      if (notes.length) toast.message(notes.join(" "));
    } catch {
      if (my === pickSeq.current) toast.error("Không đọc được mẫu mã — thử lại.");
    } finally {
      if (my === pickSeq.current) setBusy(null);
    }
  };

  const active = items.find((i) => i.variantId === selected) ?? null;
  const q = query.trim();

  return (
    <Popover open={open} onOpenChange={toggle}>
      <PopoverTrigger asChild>
        <button type="button" className={TRIGGER} disabled={disabled} aria-label="Chèn dòng sản phẩm (giá đọc từ ERP) vào ô soạn" data-testid="inbox-composer-products">
          <Package className="size-3.5" /> Sản phẩm
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className={PANEL}
        onCloseAutoFocus={(e) => {
          if (inserted.current) e.preventDefault();
          inserted.current = false;
        }}
      >
        <Command shouldFilter={false} loop value={selected} onValueChange={setSelected} label="Sản phẩm" className="min-h-0">
          <CommandInput value={query} onValueChange={(v) => setQuery(v.slice(0, COMPOSER_QUERY.max))} maxLength={COMPOSER_QUERY.max} placeholder="Tìm sản phẩm — không dấu cũng được…" aria-label="Tìm sản phẩm" />
          <CommandList className={LIST}>
            {q.length < COMPOSER_QUERY.productMin ? <Status>Gõ ít nhất {COMPOSER_QUERY.productMin} ký tự: tên sản phẩm, quy cách hoặc mã SKU.</Status> : null}
            {q.length >= COMPOSER_QUERY.productMin && loading && !items.length ? (
              <Status>
                <Loader2 className="mx-auto size-4 animate-spin" />
              </Status>
            ) : null}
            {q.length >= COMPOSER_QUERY.productMin && error ? <Status tone="error">{error}</Status> : null}
            {q.length >= COMPOSER_QUERY.productMin && !loading && !error && searched === q && !items.length ? <Status>Không có sản phẩm đang bán nào khớp «{q}».</Status> : null}
            {items.map((p) => (
              <CommandItem key={p.variantId} value={p.variantId} onSelect={() => void pick(p)} className="flex-col items-stretch gap-0.5">
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {p.name}
                    {p.variant ? <span className="font-normal text-muted-foreground"> · {p.variant}</span> : null}
                  </span>
                  <span className={cn("shrink-0 tabular-nums", !p.priceText && "text-amber-700 dark:text-amber-300")}>{p.priceText ?? "chưa có giá"}</span>
                </div>
                <div className="flex items-center justify-between gap-2 text-[11.5px] text-muted-foreground">
                  <span className="min-w-0 truncate">{p.sku}</span>
                  {busy === p.variantId ? <Loader2 className="size-3 animate-spin" /> : null}
                </div>
              </CommandItem>
            ))}
          </CommandList>
          <div className={FOOT}>
            {active ? <p className="break-words text-foreground">Sẽ chèn: «{active.line}» — tồn (nếu đọc được) thêm lúc bấm.</p> : null}
            {active && active.price === null ? <p className="text-amber-700 dark:text-amber-300">Mẫu mã chưa có giá trong ERP — dòng chèn không kèm giá.</p> : null}
            {priceNote && items.length ? <p>{priceNote}</p> : null}
            <p>Giá · tồn đọc lại từ ERP lúc bấm · Enter chèn · Esc đóng.</p>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

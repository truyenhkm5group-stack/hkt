"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { ImageIcon, Loader2, MessageSquareText, Package, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { composerProductPickAction, composerProductSearchAction, composerQuickRepliesAction, composerQuickReplyTextAction, suggestReplyAction } from "@/lib/actions/sales-inbox";
import type { ComposerProductHit, ComposerQuickReply } from "@/lib/sales-chatbot/inbox-composer";
import { COMPOSER_QUERY } from "@/lib/sales-chatbot/inbox-composer-shared";
import { cn } from "@/lib/utils";

/**
 * ═══════════ CÔNG CỤ Ô SOẠN: «CÂU MẪU» · «SẢN PHẨM» · «AI GỢI Ý» (Master Mission P0.2 «Unified Inbox» · INBOX-V2-A) ═══════════
 *
 * BA THẺ TRONG MỘT BẢNG, mở ngay từ ô soạn: gõ «/» khi ô soạn trống, hoặc bấm một thẻ dưới ô soạn. Bấm một dòng ⇒ CHÈN chữ vào ô
 * soạn (tại con trỏ, hoặc nối cuối) để nhân viên sửa rồi bấm «Gửi» có sẵn — không bao giờ tự gửi. Mọi con số (giá, tồn, phí ship)
 * do máy chủ đọc từ ERP LÚC BẤM (`lib/sales-chatbot/inbox-composer.ts`); trang chỉ giữ chữ đang gõ trong ô tìm. Bàn phím: gõ để
 * lọc · ↑ ↓ chọn · Enter chèn · ← → đổi thẻ (khi ô lọc trống) · Esc đóng (con trỏ về ô soạn). Không có đường máy chủ mới: ba thẻ
 * gọi ĐÚNG các action đã có (câu mẫu · sản phẩm · `suggestReplyAction`).
 *
 * CHÈN CHỈ KHI BẢNG CÒN MỞ: lượt bấm chờ máy chủ trả chữ; trong lúc đó nhân viên có thể bấm Esc, đổi thẻ, hay bấm một dòng khác.
 * Mỗi thẻ là một bảng GẮN khi mở và GỠ khi đóng / đổi thẻ; mỗi lượt bấm đánh một số lượt (`pickSeq`) — kết quả về mà số đã đổi
 * (hoặc bảng đã gỡ) thì BỎ, không chèn.
 */

export type ComposerTab = "quick" | "product" | "ai";
const TABS: { key: ComposerTab; label: string; testId: string }[] = [
  { key: "quick", label: "Câu mẫu", testId: "inbox-composer-quick-replies" },
  { key: "product", label: "Sản phẩm", testId: "inbox-composer-products" },
  { key: "ai", label: "AI gợi ý", testId: "inbox-composer-ai" },
];
function TabIcon({ tab }: { tab: ComposerTab }) {
  if (tab === "quick") return <MessageSquareText className="size-3.5" />;
  if (tab === "product") return <Package className="size-3.5" />;
  return <Sparkles className="size-3.5" />;
}

/** `shell`: vỏ Chốt Đơn — chỉ đổi CHỮ («sổ sản phẩm» thay «ERP»), câu của ERP giữ nguyên. */
type Props = { conversationId: string; disabled: boolean; onInsert: (snippet: string) => boolean; shell?: boolean };
type PanelProps = Props & { onDone: () => void; onTabKey: (e: KeyboardEvent, query: string) => void };

/** Nơi giá / tồn được đọc ra, theo người đọc. */
const priceSource = (shell: boolean | undefined) => (shell ? "sổ sản phẩm" : "ERP");

/** Gõ xong chừng này mới hỏi máy chủ. */
const QUICK_DEBOUNCE_MS = 200;
const PRODUCT_DEBOUNCE_MS = 300;

const TRIGGER = "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-foreground/75 hover:bg-muted hover:text-foreground disabled:opacity-50";
// Điện thoại: bảng không rộng quá màn hình, không cao quá phần còn thấy (bàn phím ảo mở thì danh sách co lại, ô tìm + chân vẫn hiện).
const PANEL = "flex max-h-(--radix-popover-content-available-height) w-[min(28rem,calc(100vw-1.5rem))] flex-col p-0";
const LIST = "max-h-[min(20rem,40dvh)] min-h-0";
const FOOT = "shrink-0 space-y-0.5 border-t px-3 py-2 text-[11.5px] leading-snug text-muted-foreground";

function Status({ children, tone }: { children: ReactNode; tone?: "error" }) {
  return <div className={cn("px-3 py-4 text-center text-[12.5px]", tone === "error" ? "text-destructive" : "text-muted-foreground")}>{children}</div>;
}

/**
 * Thẻ đang mở do ô soạn giữ (`tab` / `onTabChange`) — để phím «/» trong ô soạn mở được bảng. `onReplace` = «Dùng câu này» của thẻ
 * AI (thay cả ô soạn, như nút «AI gợi ý câu trả lời» cũ); `onClosed` trả con trỏ về ô soạn.
 */
export function ComposerTools({ tab, onTabChange, onReplace, onClosed, ...props }: Props & { tab: ComposerTab | null; onTabChange: (t: ComposerTab | null) => void; onReplace: (text: string) => void; onClosed: () => void }) {
  const done = () => onTabChange(null);
  const anchor = useRef<HTMLDivElement>(null);
  const onTabKey = (e: KeyboardEvent, query: string) => {
    if (query || (e.key !== "ArrowLeft" && e.key !== "ArrowRight") || !tab) return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.key === tab);
    onTabChange(TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length].key);
  };
  return (
    <Popover
      open={tab !== null}
      onOpenChange={(v) => {
        if (!v) done();
      }}
    >
      <PopoverAnchor asChild>
        <div ref={anchor} className="flex items-center gap-0.5" role="tablist" aria-label="Chèn nhanh vào ô soạn">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={cn(TRIGGER, tab === t.key && "bg-muted text-foreground")}
              disabled={props.disabled}
              onClick={() => onTabChange(tab === t.key ? null : t.key)}
              data-testid={t.testId}
            >
              <TabIcon tab={t.key} /> {t.label}
            </button>
          ))}
          <span className="ml-1 hidden text-[11.5px] text-muted-foreground sm:inline" aria-hidden>
            gõ <kbd className="rounded border px-1 font-mono">/</kbd> để mở
          </span>
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className={PANEL}
        onOpenAutoFocus={(e) => e.preventDefault()}
        // Bấm lại thẻ đang mở dưới ô soạn = đóng (nút tự xử lý) — không để «bấm ra ngoài» đóng trước rồi nút mở lại.
        onInteractOutside={(e) => {
          if (anchor.current?.contains(e.target as Node)) e.preventDefault();
        }}
        onCloseAutoFocus={(e) => {
          // Đóng (Esc, bấm ra ngoài, vừa chèn) ⇒ con trỏ về ô soạn, không nhảy về nút.
          e.preventDefault();
          onClosed();
        }}
        data-testid="inbox-composer-panel"
      >
        <div className="flex shrink-0 items-center gap-1 border-b px-2 pt-1.5" role="tablist" aria-label="Loại nội dung chèn">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => onTabChange(t.key)}
              className={cn("-mb-px inline-flex items-center gap-1 border-b-2 px-2 pb-1.5 pt-1 text-[12.5px] font-medium", tab === t.key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
            >
              <TabIcon tab={t.key} /> {t.label}
            </button>
          ))}
        </div>
        {tab === "quick" ? <QuickReplyPanel {...props} onDone={done} onTabKey={onTabKey} /> : null}
        {tab === "product" ? <ProductPanel {...props} onDone={done} onTabKey={onTabKey} /> : null}
        {tab === "ai" ? <AiSuggestPanel {...props} onDone={done} onTabKey={onTabKey} onReplace={onReplace} /> : null}
      </PopoverContent>
    </Popover>
  );
}

/** Thẻ «AI gợi ý»: AI soạn MỘT câu (tốn một lượt AI — chỉ khi người bấm, không tự gọi); xem trước rồi chọn dùng / chèn. */
function AiSuggestPanel({ conversationId, onInsert, onDone, onTabKey, onReplace }: PanelProps & { onReplace: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
  }, [text]);
  useEffect(
    () => () => {
      seq.current += 1;
    },
    [],
  );
  const run = async () => {
    const my = ++seq.current;
    setBusy(true);
    setError(null);
    try {
      const r = await suggestReplyAction(conversationId);
      if (my !== seq.current) return;
      if ("error" in r) setError(r.error);
      else setText(r.suggestion);
    } catch {
      if (my === seq.current) setError("Không soạn được gợi ý — thử lại.");
    } finally {
      if (my === seq.current) setBusy(false);
    }
  };
  return (
    <div className="flex min-h-0 flex-col" onKeyDown={(e) => onTabKey(e, "")}>
      <div className="min-h-0 space-y-2 overflow-y-auto p-3 text-[13px]">
        {text === null ? (
          <button ref={first} type="button" disabled={busy} onClick={() => void run()} className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-violet-600 px-3 font-medium text-white hover:bg-violet-700 disabled:opacity-60 dark:bg-violet-700">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Soạn câu trả lời gợi ý
          </button>
        ) : (
          <>
            <p className="whitespace-pre-wrap break-words rounded-md border border-violet-200 bg-violet-50 p-2.5 text-foreground dark:border-violet-900 dark:bg-violet-950/30" data-testid="inbox-composer-ai-text">
              {text}
            </p>
            <div className="flex flex-wrap gap-1.5">
              <button
                ref={first}
                type="button"
                className="h-8 rounded-md bg-foreground px-3 text-[12.5px] font-medium text-background hover:opacity-90"
                onClick={() => {
                  onReplace(text);
                  onDone();
                }}
              >
                Dùng câu này
              </button>
              <button
                type="button"
                className="h-8 rounded-md border px-3 text-[12.5px] hover:bg-muted"
                onClick={() => {
                  if (onInsert(text)) onDone();
                }}
              >
                Chèn tại con trỏ
              </button>
              <button type="button" disabled={busy} className="h-8 rounded-md px-2 text-[12.5px] text-muted-foreground hover:text-foreground disabled:opacity-50" onClick={() => void run()}>
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Soạn câu khác"}
              </button>
            </div>
          </>
        )}
        {error ? <p className="text-destructive">{error}</p> : null}
      </div>
      <div className={FOOT}>
        <p>«Dùng câu này» thay cả ô soạn — sửa lại rồi bấm Gửi, không tự gửi · ← → đổi thẻ · Esc đóng.</p>
      </div>
    </div>
  );
}

function QuickReplyPanel({ conversationId, onInsert, shell, onDone, onTabKey }: PanelProps) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ComposerQuickReply[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const seq = useRef(0);
  const pickSeq = useRef(0);

  // Danh sách đọc lại MỖI lần mở (câu vừa tắt / vừa thêm có hiệu lực ngay); gõ lọc ⇒ hỏi lại sau một nhịp, câu trả lời cũ bị bỏ.
  useEffect(() => {
    const my = ++seq.current;
    setLoading(true);
    const timer = window.setTimeout(
      () => {
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
      },
      query ? QUICK_DEBOUNCE_MS : 0,
    );
    return () => window.clearTimeout(timer);
  }, [query, conversationId]);

  // Bảng gỡ (đóng / đổi thẻ) ⇒ bỏ câu trả lời còn trên đường — của danh sách lẫn của lượt bấm.
  useEffect(
    () => () => {
      seq.current += 1;
      pickSeq.current += 1;
    },
    [],
  );

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
      onDone();
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
    <Command shouldFilter={false} loop value={selected} onValueChange={setSelected} label="Câu trả lời mẫu" className="min-h-0" onKeyDown={(e) => onTabKey(e, query)}>
      <CommandInput autoFocus value={query} onValueChange={(v) => setQuery(v.slice(0, COMPOSER_QUERY.max))} maxLength={COMPOSER_QUERY.max} placeholder="Lọc câu mẫu — không dấu cũng được…" aria-label="Lọc câu trả lời mẫu" />
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
        {active?.needsErp ? <p>{shell ? "Giá / tồn / phí ship trong câu điền từ sổ sản phẩm của shop lúc bấm — sổ chưa có số thì không chèn." : "Giá / tồn / phí ship trong câu điền từ ERP lúc bấm — ERP chưa có số thì không chèn."}</p> : null}
        <p>Chèn chữ vào ô soạn để sửa rồi bấm Gửi — không tự gửi · Enter chèn · ← → đổi thẻ · Esc đóng.</p>
      </div>
    </Command>
  );
}

function ProductPanel({ conversationId, onInsert, shell, onDone, onTabKey }: PanelProps) {
  const src = priceSource(shell);
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

  useEffect(() => {
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
  }, [query, conversationId]);

  useEffect(
    () => () => {
      seq.current += 1;
      pickSeq.current += 1;
    },
    [],
  );

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
      onDone();
      const notes = [
        r.product.priceText !== p.priceText ? `Giá trong ${src} vừa đổi — đã chèn giá mới: ${r.product.priceText ?? "chưa có giá"}.` : r.product.price === null ? `Mẫu mã chưa có giá trong ${src} — dòng chèn không kèm giá.` : null,
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
    <Command shouldFilter={false} loop value={selected} onValueChange={setSelected} label="Sản phẩm" className="min-h-0" onKeyDown={(e) => onTabKey(e, query)}>
      <CommandInput autoFocus value={query} onValueChange={(v) => setQuery(v.slice(0, COMPOSER_QUERY.max))} maxLength={COMPOSER_QUERY.max} placeholder="Tìm sản phẩm — không dấu cũng được…" aria-label="Tìm sản phẩm" />
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
        {active && active.price === null ? <p className="text-amber-700 dark:text-amber-300">Mẫu mã chưa có giá trong {src} — dòng chèn không kèm giá.</p> : null}
        {priceNote && items.length ? <p>{priceNote}</p> : null}
        <p>Giá · tồn đọc lại từ {src} lúc bấm · Enter chèn · ← → đổi thẻ · Esc đóng.</p>
      </div>
    </Command>
  );
}

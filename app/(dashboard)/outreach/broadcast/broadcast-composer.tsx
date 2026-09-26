"use client";

import { useEffect, useState, useTransition } from "react";
import { AlertTriangle, Eye, Plus, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { InfoHint } from "@/components/info-hint";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { previewBroadcastAction, startBroadcastAction } from "@/lib/actions/outreach-broadcast";
import {
  BROADCAST_SKIP_LABEL,
  BROADCAST_SKIP_REASONS,
  MAX_MEDIA,
  MAX_MESSAGES,
  MAX_RECIPIENTS,
  MIN_GAP_SECONDS,
  ORDER_FILTER_LABEL,
  ORDER_FILTERS,
  PHONE_FILTER_LABEL,
  PHONE_FILTERS,
  REPLY_STATE_LABEL,
  REPLY_STATES,
  type BroadcastFilters,
  type BroadcastPreviewResult,
} from "@/lib/constants/outreach-broadcast";
import { formatDateTime, formatNumber, formatTimeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

type PageOption = { id: string; name: string; count: number };
type TagOption = { tag: string; count: number };

const DEFAULT_FILTERS: BroadcastFilters = {
  pageIds: [],
  from: "",
  to: "",
  tagsAny: [],
  tagsNone: [],
  replyState: "SHOP_LAST",
  minSilenceHours: 1,
  phone: "ANY",
  order: "NO_ORDER",
  skipRecentHours: 24,
  limit: 500,
};

/** Số từ ô nhập: rỗng / không phải số ⇒ giá trị mặc định; dấu phẩy thập phân kiểu Việt được nhận. */
const num = (v: string, d: number) => {
  const n = Number(v.replace(",", ".").trim());
  return v.trim() === "" || Number.isNaN(n) ? d : n;
};

export function BroadcastComposer({ pages, tags, canSend, defaultMessage }: { pages: PageOption[]; tags: TagOption[]; canSend: boolean; defaultMessage: string }) {
  const [filters, setFilters] = useState<BroadcastFilters>(DEFAULT_FILTERS);
  const [messages, setMessages] = useState<string[]>([defaultMessage || ""]);
  const [mediaText, setMediaText] = useState("");
  const [gap, setGap] = useState("2");
  const [preview, setPreview] = useState<BroadcastPreviewResult | null>(null);
  const [previewStale, setPreviewStale] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  // Đổi bộ lọc ⇒ con số xem trước không còn đúng; phải xem lại trước khi gửi.
  const patch = (p: Partial<BroadcastFilters>) => {
    setFilters((f) => ({ ...f, ...p }));
    if (preview) setPreviewStale(true);
    setConfirming(false);
  };

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 6000);
    return () => clearTimeout(t);
  }, [confirming]);

  const togglePage = (id: string) => patch({ pageIds: filters.pageIds.includes(id) ? filters.pageIds.filter((x) => x !== id) : [...filters.pageIds, id] });
  /** Thẻ: bấm lần 1 = PHẢI có · lần 2 = KHÔNG được có · lần 3 = bỏ. */
  const cycleTag = (tag: string) => {
    if (filters.tagsAny.includes(tag)) patch({ tagsAny: filters.tagsAny.filter((t) => t !== tag), tagsNone: [...filters.tagsNone, tag] });
    else if (filters.tagsNone.includes(tag)) patch({ tagsNone: filters.tagsNone.filter((t) => t !== tag) });
    else patch({ tagsAny: [...filters.tagsAny, tag] });
  };

  const mediaUrls = mediaText.split(/[\n,]/).map((u) => u.trim()).filter(Boolean);
  const cleanMessages = messages.map((m) => m.trim()).filter(Boolean);

  const doPreview = () =>
    startTransition(async () => {
      const r = await previewBroadcastAction(filters);
      if ("error" in r) return void toast.error(r.error);
      setPreview(r);
      setPreviewStale(false);
      setConfirming(false);
    });

  const doSend = () => {
    if (!confirming) return setConfirming(true);
    startTransition(async () => {
      const r = await startBroadcastAction({ filters, messages: cleanMessages, mediaUrls, gapSeconds: num(gap, 2) });
      setConfirming(false);
      if ("error" in r) return void toast.error(r.error);
      toast.success(`Đã bắt đầu gửi cho ${formatNumber(r.total)} khách — theo dõi tiến độ ở bảng bên dưới`);
      setPreview(null);
    });
  };

  const canPressSend = canSend && preview !== null && !previewStale && preview.total > 0 && cleanMessages.length > 0 && !pending;
  const excluded = BROADCAST_SKIP_REASONS.filter((k) => (preview?.excluded[k] ?? 0) > 0);

  return (
    <div className="space-y-4 rounded-xl border bg-card p-4 text-[13px] shadow-xs">
      {/* ── Bộ lọc ── */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-28 shrink-0 font-semibold">Fanpage</span>
          {pages.length === 0 ? <span className="text-muted-foreground">Chưa có hội thoại nào trong 48 giờ quét gần nhất.</span> : null}
          {pages.map((p) => (
            <Chip key={p.id} active={filters.pageIds.includes(p.id)} onClick={() => togglePage(p.id)}>
              {p.name || p.id} · {formatNumber(p.count)}
            </Chip>
          ))}
          {filters.pageIds.length ? <button type="button" className="text-xs text-muted-foreground underline" onClick={() => patch({ pageIds: [] })}>Tất cả page</button> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex w-28 shrink-0 items-center gap-1 font-semibold">
            Thẻ Pancake
            <InfoHint>Bấm một lần: khách PHẢI có thẻ (xanh). Bấm lần hai: khách KHÔNG được có thẻ (đỏ). Bấm lần ba: bỏ lọc. Nhiều thẻ xanh = có ít nhất một trong số đó.</InfoHint>
          </span>
          {tags.length === 0 ? <span className="text-muted-foreground">Chưa có thẻ nào.</span> : null}
          {tags.map((t) => (
            <Chip key={t.tag} active={filters.tagsAny.includes(t.tag)} negative={filters.tagsNone.includes(t.tag)} onClick={() => cycleTag(t.tag)}>
              {filters.tagsNone.includes(t.tag) ? "không " : ""}
              {t.tag} · {formatNumber(t.count)}
            </Chip>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <div className="space-y-1">
            <Label>Tin cuối của khách từ ngày</Label>
            <Input type="date" value={filters.from} onChange={(e) => patch({ from: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>đến ngày</Label>
            <Input type="date" value={filters.to} onChange={(e) => patch({ to: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>Trạng thái hội thoại</Label>
            <Select value={filters.replyState} onValueChange={(v) => patch({ replyState: v as BroadcastFilters["replyState"] })}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{REPLY_STATES.map((s) => <SelectItem key={s} value={s}>{REPLY_STATE_LABEL[s]}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="flex items-center gap-1">
              Im ít nhất (giờ)
              <InfoHint>Tính từ tin cuối cùng của hội thoại, dù bên nào gửi. VD 2 = hai bên đã im 2 giờ.</InfoHint>
            </Label>
            <Input inputMode="decimal" defaultValue={String(filters.minSilenceHours)} onChange={(e) => patch({ minSilenceHours: Math.min(23, Math.max(0, num(e.target.value, 0))) })} />
          </div>
          <div className="space-y-1">
            <Label>Số điện thoại</Label>
            <Select value={filters.phone} onValueChange={(v) => patch({ phone: v as BroadcastFilters["phone"] })}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{PHONE_FILTERS.map((s) => <SelectItem key={s} value={s}>{PHONE_FILTER_LABEL[s]}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Đơn hàng</Label>
            <Select value={filters.order} onValueChange={(v) => patch({ order: v as BroadcastFilters["order"] })}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{ORDER_FILTERS.map((s) => <SelectItem key={s} value={s}>{ORDER_FILTER_LABEL[s]}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="flex items-center gap-1">
              Bỏ khách đã nhận tin trong (giờ)
              <InfoHint>Khách đã nhận tin hàng loạt trong số giờ này thì không nhắn lại. 0 = không bỏ.</InfoHint>
            </Label>
            <Input inputMode="numeric" defaultValue={String(filters.skipRecentHours)} onChange={(e) => patch({ skipRecentHours: Math.max(0, Math.round(num(e.target.value, 0))) })} />
          </div>
          <div className="space-y-1">
            <Label>Số khách tối đa</Label>
            <Input inputMode="numeric" defaultValue={String(filters.limit)} onChange={(e) => patch({ limit: Math.min(MAX_RECIPIENTS, Math.max(1, Math.round(num(e.target.value, 500)))) })} />
          </div>
          <div className="flex items-end">
            <Button type="button" variant="outline" onClick={doPreview} disabled={pending}>
              <Eye className="size-4" /> Xem trước
            </Button>
          </div>
        </div>
      </div>

      {/* ── Xem trước ── */}
      {preview ? (
        <div className={cn("space-y-2 rounded-lg border p-3", previewStale && "opacity-50")}>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="text-base font-semibold">{formatNumber(preview.total)} khách sẽ nhận tin</span>
            {previewStale ? <span className="font-medium text-amber-600">Bộ lọc đã đổi — bấm Xem trước lại</span> : null}
            <span className="text-muted-foreground">Dữ liệu hội thoại quét lúc {preview.lastScanAt ? `${formatDateTime(preview.lastScanAt)} (${formatTimeAgo(preview.lastScanAt)})` : "—"}</span>
          </div>
          {excluded.length ? (
            <div className="flex flex-wrap gap-1.5">
              {excluded.map((k) => (
                <span key={k} className="rounded-full bg-muted px-2.5 py-0.5 text-xs">
                  Loại {formatNumber(preview.excluded[k] ?? 0)}: {BROADCAST_SKIP_LABEL[k]}
                </span>
              ))}
            </div>
          ) : null}
          {preview.truncatedPages.length ? (
            <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="size-3.5" /> Page {preview.truncatedPages.join(", ")} có hơn 200 hội thoại trong 48 giờ — lượt quét bị cắt ở trần, một số khách không có trong danh sách.
            </p>
          ) : null}
          {preview.sample.length ? (
            <div className="max-h-72 overflow-auto rounded border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/80 text-left">
                  <tr>
                    <th className="px-2 py-1 font-medium">Khách</th>
                    <th className="px-2 py-1 font-medium">Fanpage</th>
                    <th className="px-2 py-1 font-medium">Thẻ</th>
                    <th className="px-2 py-1 font-medium">Tin cuối của khách</th>
                    <th className="px-2 py-1 font-medium">Tin cuối của shop</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.map((r, i) => (
                    <tr key={`${r.pageId}-${i}`} className="border-t">
                      <td className="px-2 py-1">{r.customerName || "—"}{r.hasPhone ? <span className="ml-1 text-muted-foreground">· có SĐT</span> : null}</td>
                      <td className="px-2 py-1">{r.pageName || r.pageId}</td>
                      <td className="px-2 py-1">{r.tags.join(", ") || "—"}</td>
                      <td className="px-2 py-1">{formatTimeAgo(r.lastCustomerAt)}</td>
                      <td className="px-2 py-1">{formatTimeAgo(r.lastShopAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.total > preview.sample.length ? <p className="border-t px-2 py-1 text-xs text-muted-foreground">Hiện {preview.sample.length} khách đầu (gần hạn 24 giờ nhất, gửi trước).</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ── Nội dung ── */}
      <div className="space-y-2 border-t pt-4">
        <div className="flex items-center gap-2">
          <span className="font-semibold">Nội dung · {cleanMessages.length} tin mỗi khách</span>
          <InfoHint>Mỗi khách nhận lần lượt từng tin, cách nhau chưa tới 1 giây. Biến: {"{ten}"} (chị + tên) · {"{shop}"} · {"{giam}"} (ưu đãi chốt nhanh trong cấu hình chăm sóc) · {"{uu_dai}"}.</InfoHint>
        </div>
        {messages.map((m, i) => (
          <div key={i} className="flex gap-2">
            <Textarea rows={3} value={m} placeholder={`Tin ${i + 1}`} onChange={(e) => setMessages((list) => list.map((x, k) => (k === i ? e.target.value : x)))} />
            {messages.length > 1 ? (
              <Button type="button" variant="ghost" size="icon" aria-label="Xoá tin" onClick={() => setMessages((list) => list.filter((_, k) => k !== i))}>
                <Trash2 className="size-4" />
              </Button>
            ) : null}
          </div>
        ))}
        <div className="flex flex-wrap items-end gap-3">
          {messages.length < MAX_MESSAGES ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setMessages((list) => [...list, ""])}>
              <Plus className="size-4" /> Thêm tin
            </Button>
          ) : null}
          <div className="min-w-72 flex-1 space-y-1">
            <Label>Ảnh / video gửi kèm (URL công khai, tối đa {MAX_MEDIA}, mỗi dòng một link)</Label>
            <Textarea rows={1} value={mediaText} onChange={(e) => setMediaText(e.target.value)} placeholder="https://…" />
          </div>
          <div className="w-40 space-y-1">
            <Label className="flex items-center gap-1">
              Cách nhau (giây/khách)
              <InfoHint>Tối thiểu {MIN_GAP_SECONDS} giây. Nhắn quá dồn dập dễ khiến Meta hạn chế trang.</InfoHint>
            </Label>
            <Input inputMode="decimal" value={gap} onChange={(e) => setGap(e.target.value)} />
          </div>
          {canSend ? (
            <Button type="button" onClick={doSend} disabled={!canPressSend} variant={confirming ? "destructive" : "default"}>
              <Send className="size-4" />
              {confirming ? `Bấm lần nữa để gửi ${formatNumber(preview?.total ?? 0)} khách × ${cleanMessages.length} tin` : preview && !previewStale ? `Gửi cho ${formatNumber(preview.total)} khách` : "Xem trước rồi mới gửi được"}
            </Button>
          ) : (
            <span className="text-muted-foreground">Bạn chỉ có quyền xem.</span>
          )}
        </div>
      </div>
    </div>
  );
}

function Chip({ active, negative, onClick, children }: { active: boolean; negative?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-xs transition",
        active && "border-emerald-600 bg-emerald-600 text-white",
        negative && "border-rose-600 bg-rose-600 text-white",
        !active && !negative && "bg-card hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

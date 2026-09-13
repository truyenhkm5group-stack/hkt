"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MessageSquarePlus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { InfoHint } from "@/components/info-hint";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { addProductNote, removeProductNote } from "@/lib/actions/product-notes";
import { NOTE_CATEGORIES, NOTE_CATEGORY_HINT, NOTE_CATEGORY_LABEL, NOTE_CATEGORY_TONE, NOTE_MAX_LENGTH, type NoteCategory } from "@/lib/constants/product-notes";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export type NoteRow = {
  id: string;
  variantSku: string | null;
  category: NoteCategory;
  body: string;
  actorUserId: string | null;
  actorName: string;
  createdAt: string;
};

/**
 * ═══════ GHI CHÚ VẬN HÀNH — BỐI CẢNH CHO NGƯỜI ĐỌC, KHÔNG PHẢI ĐẦU VÀO CỦA PHÉP TÍNH ═══════
 *
 * Ô "Ghi chú" cũ trên trang này là ô ĐỒNG BỘ TỪ PANCAKE: hiện ra và không ai trong shop viết được.
 * Khối này là đường ghi thật — mỗi dòng mang khoá tài khoản người viết và mốc thời gian.
 *
 * Không con số nào trên ERP đọc bảng này.
 */
export function ProductNotes({ productId, variants, notes, canWrite }: { productId: string; variants: { id: string; sku: string }[]; notes: NoteRow[]; canWrite: boolean }) {
  const [body, setBody] = useState("");
  const [category, setCategory] = useState<NoteCategory>("OTHER");
  const [variantId, setVariantId] = useState<string>("");
  const [pending, start] = useTransition();
  const router = useRouter();

  const luu = () => {
    if (body.trim().length < 3) return;
    start(async () => {
      const r = await addProductNote({ productId, variantId: variantId || null, category, body });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã ghi chú");
      setBody("");
      router.refresh();
    });
  };

  const xoa = (id: string) =>
    start(async () => {
      const r = await removeProductNote({ id });
      if ("error" in r) toast.error(r.error);
      else {
        toast.success("Đã gỡ ghi chú — nội dung cũ vẫn còn trong nhật ký");
        router.refresh();
      }
    });

  return (
    <div className="space-y-4">
      {canWrite ? (
        <div className="space-y-2 rounded-xl border p-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[150px]">
              <Label className="text-xs">Nhóm</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as NoteCategory)}>
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NOTE_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {NOTE_CATEGORY_LABEL[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {variants.length ? (
              <div className="min-w-[170px]">
                <Label className="text-xs">
                  Mẫu mã <InfoHint>Để trống = ghi chú cho cả sản phẩm. Chọn một mẫu mã khi điều cần nói chỉ đúng với size / màu đó.</InfoHint>
                </Label>
                {/* Ô chọn, KHÔNG phải ô gõ: mã gõ tay sai một ký tự là ghi chú treo vào hư không. */}
                <Select value={variantId || "ALL"} onValueChange={(v) => setVariantId(v === "ALL" ? "" : v)}>
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">Cả sản phẩm</SelectItem>
                    {variants.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.sku}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <p className="flex-1 text-[11px] text-muted-foreground">{NOTE_CATEGORY_HINT[category]}</p>
          </div>
          <Textarea rows={2} maxLength={NOTE_MAX_LENGTH} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Lô tháng 8 vải mỏng hơn mẫu, khách đổi 3 cái…" />
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">
              Ghi chú là bối cảnh cho người đọc — KHÔNG ảnh hưởng tới tồn kho, giá vốn hay bất kỳ báo cáo nào.
            </span>
            <Button size="sm" className="h-8" disabled={pending || body.trim().length < 3} onClick={luu}>
              <MessageSquarePlus className="size-3.5" /> Lưu ghi chú
            </Button>
          </div>
        </div>
      ) : null}

      {notes.length ? (
        <ul className="divide-y">
          {notes.map((x) => (
            <li key={x.id} className="flex items-start gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="secondary" className={cn("text-[10px]", NOTE_CATEGORY_TONE[x.category])}>{NOTE_CATEGORY_LABEL[x.category]}</Badge>
                  {x.variantSku ? <span className="rounded bg-muted px-1 font-mono text-[10px]">{x.variantSku}</span> : null}
                  {/* MÁY ghi khác hẳn "chưa biết ai" — nói ra, không để trống. */}
                  <span className="text-[11px] text-muted-foreground">
                    {x.actorUserId ? x.actorName : `${x.actorName || "Hệ thống"} · máy ghi`} · {formatDateTime(x.createdAt)}
                  </span>
                </div>
                <p className="mt-0.5 text-sm whitespace-pre-wrap">{x.body}</p>
              </div>
              {canWrite ? (
                <Button size="icon" variant="ghost" className="size-7 shrink-0" disabled={pending} onClick={() => xoa(x.id)} aria-label="Gỡ ghi chú">
                  <Trash2 className="size-3.5" />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-4 text-center text-sm text-muted-foreground">Chưa có ghi chú nào cho sản phẩm này.</p>
      )}
    </div>
  );
}

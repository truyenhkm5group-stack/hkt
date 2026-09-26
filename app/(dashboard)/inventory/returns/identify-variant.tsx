"use client";

import * as React from "react";
import Link from "next/link";
import { Check, Loader2, Tag } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { identifyUnidentifiedVariantAction, searchVariantsAction, variantsOfProductCodeAction } from "@/lib/actions/returns-unidentified";
import { VARIANT_FIX_ADJUSTMENT_HREF } from "@/lib/constants/return-unidentified";
import type { ProductCodeVariants, VariantOption } from "@/lib/returns/unidentified";
import { formatDateTime, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ═══════════ CHỌN MẪU MÃ CHO MÓN HÀNG HOÀN KHÔNG NHÃN ═══════════
 *
 * MỘT ô chọn cho cả hai chỗ: lúc nhận kiện (bàn "Hàng hoàn không có mã vận đơn") và lúc xác định SAU
 * (cùng bàn ấy + khối "Hàng hoàn không tái nhập"). Hai ô chọn cho cùng một việc thì sớm muộn nói hai điều.
 *
 * Người kho gọi hàng bằng mã chủ shop (`Q001`…), nên đường chính là MÃ HÀNG → MÀU → SIZE: gõ mã, ERP
 * tra ĐÚNG MỘT sản phẩm (`resolveProductByCode` — mơ hồ thì không chọn hộ), rồi bấm màu, bấm size.
 * Gõ thứ khác (tên, SKU, màu) thì rơi về tìm tự do như trước. Không tải cả danh mục vào HTML.
 */

export function VariantPicker({ value, onPick, emptyHint }: { value: VariantOption | null; onPick: (v: VariantOption | null) => void; emptyHint?: React.ReactNode }) {
  const [q, setQ] = React.useState("");
  const [rows, setRows] = React.useState<VariantOption[]>([]);
  const [theoMa, setTheoMa] = React.useState<ProductCodeVariants | null>(null);
  const [mau, setMau] = React.useState<string | null>(null);
  const [dangTim, setDangTim] = React.useState(false);

  React.useEffect(() => {
    const term = q.trim();
    setMau(null);
    if (term.length < 2) {
      setRows([]);
      setTheoMa(null);
      return;
    }
    // Gõ tới đâu tìm tới đó, nhưng chờ 300ms: mỗi ký tự một lượt truy vấn là bắt máy chủ trả tiền
    // cho từng nhịp bàn phím.
    let huy = false;
    const t = setTimeout(async () => {
      setDangTim(true);
      const ma = await variantsOfProductCodeAction(term);
      const tuDo = ma.product ? [] : await searchVariantsAction(term);
      if (huy) return;
      setDangTim(false);
      setTheoMa(ma.product ? ma : null);
      setRows(tuDo);
    }, 300);
    return () => {
      huy = true;
      clearTimeout(t);
    };
  }, [q]);

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-2 text-[12.5px]">
        <Tag className="size-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          <span className="font-medium">{value.sku || value.name}</span>
          {[value.color, value.size].filter(Boolean).length ? <span className="text-muted-foreground"> · {[value.color, value.size].filter(Boolean).join(" / ")}</span> : null}
          <span className="block text-[11.5px] text-muted-foreground">{value.name}</span>
        </span>
        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => onPick(null)}>
          Đổi
        </Button>
      </div>
    );
  }

  const mauSac = theoMa ? [...new Set(theoMa.variants.map((v) => v.color || "—"))] : [];
  const theoMau = theoMa && mau !== null ? theoMa.variants.filter((v) => (v.color || "—") === mau) : [];

  return (
    <div className="space-y-1.5">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Mã hàng (vd Q001) — hoặc tên / SKU / màu để tìm tự do…" className="h-9" autoComplete="off" aria-label="Tìm mẫu mã" />
      {dangTim ? <p className="text-[11.5px] text-muted-foreground">Đang tìm…</p> : null}

      {theoMa?.product ? (
        <div className="space-y-1.5 rounded-lg border p-2">
          <p className="text-[12px]">
            <span className="font-mono font-medium">{theoMa.code}</span> · {theoMa.product.name} · {formatNumber(theoMa.variants.length)} mẫu mã
          </p>
          {theoMa.variants.length ? (
            <>
              <div className="flex flex-wrap gap-1" role="group" aria-label="Màu">
                {mauSac.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMau(m === mau ? null : m)}
                    className={cn("rounded-md border px-2 py-1 text-[12px]", m === mau ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent")}
                  >
                    {m}
                  </button>
                ))}
              </div>
              {mau !== null ? (
                <div className="flex flex-wrap gap-1" role="group" aria-label="Size">
                  {theoMau.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => onPick({ id: v.id, sku: v.sku, name: v.name, color: v.color, size: v.size })}
                      title={[v.sku, v.selling ? "" : "đã ngừng bán / ẩn"].filter(Boolean).join(" · ")}
                      className={cn("flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] hover:bg-accent", !v.selling && "border-dashed text-muted-foreground")}
                    >
                      {v.image ? (
                        // eslint-disable-next-line @next/next/no-img-element -- ảnh danh mục từ Pancake, không qua bộ tối ưu ảnh
                        <img src={v.image} alt="" className="size-6 rounded object-cover" />
                      ) : null}
                      {v.size || v.sku || "—"}
                      {!v.selling ? <span className="text-[10.5px]">(ngừng bán)</span> : null}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-[11.5px] text-muted-foreground">Chọn màu, rồi chọn size.</p>
              )}
            </>
          ) : (
            <p className="text-[11.5px] text-muted-foreground">Mã này chưa có mẫu mã (màu / size) nào trong danh mục ERP.</p>
          )}
        </div>
      ) : rows.length ? (
        <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border p-1">
          {rows.map((v) => (
            <button key={v.id} type="button" onClick={() => onPick(v)} className="block w-full rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-accent">
              <span className="font-medium">{v.sku || v.name}</span>
              {[v.color, v.size].filter(Boolean).length ? <span className="text-muted-foreground"> · {[v.color, v.size].filter(Boolean).join(" / ")}</span> : null}
              <span className="block text-[11px] text-muted-foreground">{v.name}</span>
            </button>
          ))}
        </div>
      ) : q.trim().length >= 2 && !dangTim ? (
        <p className="text-[11.5px] text-muted-foreground">Không thấy mẫu mã nào khớp (mã hàng khớp hai sản phẩm thì ERP không chọn hộ — gõ tên / SKU). {emptyHint}</p>
      ) : null}
    </div>
  );
}

// ───────────────────────── XÁC ĐỊNH MẪU MÃ SAU KHI NHẬN ─────────────────────────

export type IdentifyTarget = {
  id: string;
  code: string;
  /** Số món còn giữ tạm (hoặc còn chờ kết cục) — để người kho đối chiếu với thứ trên bàn. */
  quantity: number;
  conditionLabel: string;
  note: string;
  warehouseNote?: string;
  variantId: string | null;
  /** Tên mẫu đang gán (ảnh chụp) — rỗng khi chưa gán. */
  variantLabel: string;
  identifiedBy?: string | null;
  identifiedAt?: string | Date | null;
};

/**
 * BIỂU MẪU "XÁC ĐỊNH MẪU MÃ" — gán lần đầu, hoặc đổi (lý do bắt buộc) khi món CHƯA có hàng vào tồn.
 * `stockReceived` đọc từ `unidentifiedStockReceived` ở nơi gọi; máy chủ kiểm lại trong khoá dòng.
 * Lượt này KHÔNG cộng tồn — thông báo nói rõ điều đó.
 */
export function IdentifyVariantPanel({ target, stockReceived, onDone }: { target: IdentifyTarget; stockReceived: boolean; onDone: () => void }) {
  const [chon, setChon] = React.useState<VariantOption | null>(null);
  const [note, setNote] = React.useState("");
  const [dangGui, setDangGui] = React.useState(false);
  const doi = Boolean(target.variantId);

  async function gui() {
    if (!chon) return;
    setDangGui(true);
    const r = await identifyUnidentifiedVariantAction({ id: target.id, variantId: chon.id, note: note.trim(), expectedVariantId: target.variantId });
    setDangGui(false);
    if ("error" in r) {
      toast.error(r.error, { duration: 12_000 });
      return;
    }
    toast.success(r.message, { duration: 9000 });
    // Action đã `revalidatePath` trang này ở MỌI nhánh thành công ⇒ giao diện mới về cùng lượt gọi (PR #284).
    onDone();
  }

  return (
    <div className="mt-2 space-y-2 rounded-lg border bg-background p-2.5 text-[12.5px]" data-identify-panel={target.id}>
      <div className="space-y-0.5">
        <p className="font-medium">
          {doi ? "Đổi mẫu mã của" : "Xác định mẫu mã của"} <span className="font-mono">{target.code}</span> · × {formatNumber(target.quantity)} · {target.conditionLabel}
        </p>
        {target.note || target.warehouseNote ? (
          <p className="text-[11.5px] text-muted-foreground">
            {[target.note ? `Ghi chú kiểm: ${target.note}` : "", target.warehouseNote ? `Ghi chú kho: ${target.warehouseNote}` : ""].filter(Boolean).join(" · ")}
          </p>
        ) : null}
        {doi ? (
          <p className="text-[11.5px] text-muted-foreground">
            Đang gán: <span className="font-medium text-foreground">{target.variantLabel || "—"}</span>
            {target.identifiedAt ? ` · xác nhận ${formatDateTime(target.identifiedAt)} bởi ${target.identifiedBy || "—"}` : " · chưa rõ ai xác nhận (dữ liệu trước khi ERP ghi người xác nhận)"}
          </p>
        ) : null}
      </div>

      {stockReceived ? (
        <p className="rounded bg-warning/15 px-2 py-1 text-[11.5px] text-amber-700 dark:text-amber-300">
          Món này đã có hàng vào tồn dưới mẫu mã đang gán — không đổi mẫu ở đây được. Sai mẫu thì lập{" "}
          <Link href={VARIANT_FIX_ADJUSTMENT_HREF} className="font-medium underline">
            phiếu điều chỉnh kho
          </Link>{" "}
          (trừ mẫu cũ, cộng mẫu đúng).
        </p>
      ) : (
        <>
          <VariantPicker value={chon} onPick={setChon} />
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={doi ? "Lý do đổi — BẮT BUỘC (vd: đọc lại tem mác thì là size L)" : "Ghi chú (không bắt buộc): nhận ra nhờ tem mác, đường may…"}
            className={cn("h-8", doi && !note.trim() && "border-destructive")}
            aria-label={doi ? "Lý do đổi mẫu mã" : "Ghi chú xác định mẫu mã"}
          />
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" className="h-8" disabled={dangGui || !chon || (doi && !note.trim())} onClick={() => void gui()}>
              {dangGui ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              {doi ? "Đổi mẫu mã" : "Xác nhận mẫu mã"}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-8" onClick={onDone} disabled={dangGui}>
              Thôi
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Xác nhận mẫu mã KHÔNG cộng tồn. Nó chỉ cho món này được đếm về mẫu và được đi tiếp: tái nhập (nếu còn bán được) hoặc sửa xong → nhập lại theo số đếm.
          </p>
        </>
      )}
    </div>
  );
}

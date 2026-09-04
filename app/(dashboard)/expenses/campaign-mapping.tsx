"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { setCampaignProduct, setProductAliases } from "@/lib/actions/ads-mapping";
import { formatDate, formatNumber, formatVND } from "@/lib/format";
import type { CampaignMappingRow } from "@/lib/queries/ads-mapping";
import { cn } from "@/lib/utils";

type Product = { id: string; name: string; code: string };

function valueOf(row: CampaignMappingRow) {
  if (row.excluded) return "__exclude__";
  return row.productId ?? "";
}

/** Bảng ghép chiến dịch Facebook → mã hàng, kèm bí danh cho từng mã */
export function CampaignMapping({ rows, products, aliases, canWrite }: { rows: CampaignMappingRow[]; products: Product[]; aliases: Record<string, string[]>; canWrite: boolean }) {
  const [search, setSearch] = useState("");
  const [onlyUnmapped, setOnlyUnmapped] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const router = useRouter();
  const productName = (id: string | null) => (id ? products.find((p) => p.id === id)?.name ?? "(đã xoá)" : "");

  const visible = rows.filter((r) => {
    const term = search.trim().toLowerCase();
    if (term && !`${r.campaign} ${r.accountName} ${productName(r.productId)}`.toLowerCase().includes(term)) return false;
    if (onlyUnmapped && (r.productId || r.excluded)) return false;
    return true;
  });
  const unmappedSpend = rows.filter((r) => !r.productId && !r.excluded).reduce((s, r) => s + r.spend, 0);

  const change = (row: CampaignMappingRow, value: string) => {
    setPendingId(row.campaignId);
    startTransition(async () => {
      const result = await setCampaignProduct(row.campaignId, value);
      setPendingId(null);
      if ("error" in result) toast.error(result.error);
      else {
        toast.success(value === "__exclude__" ? "Đã loại chiến dịch khỏi chi phí" : value ? `Đã ghép với ${productName(value)}` : "Đã đặt là chi phí chung");
        router.refresh();
      }
    });
  };

  return (
    <div className="space-y-4">
      {canWrite ? <AliasEditor products={products} aliases={aliases} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tìm chiến dịch, tài khoản…" className="pl-8" />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={onlyUnmapped} onChange={(e) => setOnlyUnmapped(e.target.checked)} /> Chỉ chiến dịch chưa ghép
        </label>
        <span className="text-xs text-muted-foreground">
          {formatNumber(visible.length)}/{formatNumber(rows.length)} chiến dịch · chưa ghép {formatVND(unmappedSpend, { compact: true })}
        </span>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            <tr>
              <th className="px-3 py-2 text-left">Chiến dịch</th>
              <th className="px-3 py-2 text-left">Tài khoản</th>
              <th className="px-3 py-2 text-right">Chi 90 ngày</th>
              <th className="px-3 py-2 text-right">Ngày</th>
              <th className="w-[260px] px-3 py-2 text-left">Mã hàng</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.campaignId} className={cn("border-t", r.excluded && "opacity-60", !r.productId && !r.excluded && "bg-amber-50/40 dark:bg-amber-950/10")}>
                <td className="max-w-[360px] px-3 py-1.5">
                  <div className="truncate font-medium" title={r.campaign}>
                    {r.campaign || r.campaignId}
                  </div>
                  <div className="text-[10.5px] text-muted-foreground">
                    {r.manual ? "ghép tay" : r.productId ? "tự động" : r.excluded ? "không tính" : "chưa ghép"} · gần nhất {formatDate(r.lastDate)}
                  </div>
                </td>
                <td className="px-3 py-1.5 text-xs text-muted-foreground">{r.accountName}</td>
                <td className="numeric px-3 py-1.5 text-right font-semibold">{formatVND(r.spend)}</td>
                <td className="numeric px-3 py-1.5 text-right text-muted-foreground">{r.days}</td>
                <td className="px-3 py-1.5">
                  {canWrite ? (
                    <div className="flex items-center gap-2">
                      <Select value={valueOf(r)} onValueChange={(v) => change(r, v)} disabled={pendingId === r.campaignId}>
                        <SelectTrigger className="h-8 w-full">
                          <SelectValue placeholder="Chọn mã hàng" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__auto__">Tự động / chưa ghép</SelectItem>
                          {products.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.code ? `${p.code} · ` : ""}
                              {p.name}
                            </SelectItem>
                          ))}
                          <SelectItem value="__exclude__">Không tính (shop khác)</SelectItem>
                        </SelectContent>
                      </Select>
                      {pendingId === r.campaignId ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
                    </div>
                  ) : (
                    <span className="text-sm">{r.excluded ? "Không tính" : productName(r.productId) || "—"}</span>
                  )}
                </td>
              </tr>
            ))}
            {visible.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  Không có chiến dịch nào. Chạy “Đồng bộ Facebook Ads” để kéo dữ liệu.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AliasEditor({ products, aliases }: { products: Product[]; aliases: Record<string, string[]> }) {
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(products.map((p) => [p.id, (aliases[p.id] ?? []).join(", ")])));
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const router = useRouter();
  const save = (productId: string) => {
    setPendingId(productId);
    startTransition(async () => {
      const result = await setProductAliases(productId, values[productId] ?? "");
      setPendingId(null);
      if ("error" in result) toast.error(result.error);
      else {
        toast.success(`Đã lưu bí danh · ${result.changed} dòng chi tiêu được ghép lại`);
        router.refresh();
      }
    });
  };
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <p className="mb-2 text-xs text-muted-foreground">
        <b className="text-foreground">Bí danh:</b> từ khoá xuất hiện trong tên chiến dịch để tự ghép về mã hàng (cách nhau bằng dấu phẩy, không phân biệt hoa thường). VD Đầm Q002: <span className="font-mono">q2, q002, vid.q2</span>. Ghép tay theo từng chiến dịch ở bảng dưới luôn được ưu tiên.
      </p>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {products.map((p) => (
          <div key={p.id} className="flex items-center gap-2">
            <span className="w-32 shrink-0 truncate text-xs font-medium" title={p.name}>
              {p.code ? `${p.code} · ` : ""}
              {p.name}
            </span>
            <Input className="h-8" value={values[p.id] ?? ""} onChange={(e) => setValues({ ...values, [p.id]: e.target.value })} placeholder="q2, q002…" />
            <Button type="button" size="sm" variant="outline" onClick={() => save(p.id)} disabled={pendingId === p.id}>
              {pendingId === p.id ? <Loader2 className="size-4 animate-spin" /> : "Lưu"}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

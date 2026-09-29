"use client";

import { Search, Settings2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import type { WinProductRow } from "@/lib/queries/video-scale";
import { cn } from "@/lib/utils";
import { SkuAdsForm } from "./ads-controls";
import { CreateRunDialog } from "./create-run-dialog";
import { PauseButton, SkuPublishingSelect } from "./publishing-controls";
import { SkuModeSelect } from "./small-actions";

const FILTERS = [
  { key: "ALL", label: "Tất cả", test: () => true },
  { key: "NONE", label: "Chưa có video", test: (p: WinProductRow) => p.runs === 0 && p.photoCount > 0 },
  { key: "WORKING", label: "Đang tạo", test: (p: WinProductRow) => p.inProduction > 0 },
  { key: "REVIEW", label: "Chờ duyệt", test: (p: WinProductRow) => p.awaitingReview > 0 },
  { key: "NO_PHOTO", label: "Thiếu ảnh gốc", test: (p: WinProductRow) => p.photoCount === 0 },
] as const;

/**
 * Lưới mã win (chủ shop 29/09/2026: "làm lại UI/UX… tối ưu hơn"): ô tìm mã / tên + bộ lọc theo việc đang chờ; mỗi thẻ đưa nút
 * TẠO VIDEO lên trước, còn các thiết lập ít đổi (chế độ duyệt, fanpage, dừng khẩn cấp, quảng cáo) gọn vào một mục thu gọn — thẻ cũ
 * xếp năm ô chọn chồng lên nhau khiến nút chính chìm mất.
 */
export function WinGrid({
  products,
  music,
  pages,
  accounts,
  canSpend,
  canMode,
  canMoney,
  canEngage,
  canRelease,
  perVideoUsd,
  costNote,
}: {
  products: WinProductRow[];
  music: { id: string; title: string; assetId: string }[];
  pages: { id: string; name: string }[];
  accounts: { id: string; name: string }[];
  canSpend: boolean;
  canMode: boolean;
  canMoney: boolean;
  canEngage: boolean;
  canRelease: boolean;
  perVideoUsd: number | null;
  costNote: string;
}) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("ALL");
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.key, products.filter((p) => f.test(p)).length])) as Record<string, number>, [products]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    const f = FILTERS.find((x) => x.key === filter) ?? FILTERS[0];
    return products.filter((p) => f.test(p) && (!t || `${p.code} ${p.name}`.toLowerCase().includes(t)));
  }, [products, q, filter]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm mã / tên…" className="h-8 w-52 pl-7 text-[12.5px]" aria-label="Tìm mã win" />
        </span>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={cn("rounded-full border px-2.5 py-1 text-[12px]", filter === f.key ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background hover:bg-muted")}
          >
            {f.label} <span className="tabular-nums opacity-75">{counts[f.key]}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-[13px] text-muted-foreground">Không có mã nào khớp bộ lọc.</p>
      ) : (
        <div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((p) => (
            <div key={p.productId} className="flex flex-col gap-2 rounded-lg border bg-card p-3">
              <div className="flex gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element -- ảnh Pancake, URL ngoài */}
                {p.image ? <img src={p.image} alt="" className="size-20 shrink-0 rounded object-cover" loading="lazy" /> : <div className="size-20 shrink-0 rounded bg-muted" />}
                <div className="min-w-0 flex-1 space-y-1 text-[13px]">
                  <p className="font-semibold leading-snug">
                    {p.code || "—"} <span className="font-normal text-muted-foreground">{p.name}</span>
                  </p>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="secondary">{p.stateLabel || "Mã win"}</Badge>
                    <Badge variant={p.photoCount ? "outline" : "destructive"}>{p.photoCount} ảnh gốc</Badge>
                    {p.inProduction ? <Badge variant="outline">{p.inProduction} đang tạo</Badge> : null}
                    {p.approved ? <Badge variant="outline">{p.approved} đã duyệt</Badge> : null}
                    {p.pausedAt ? <Badge variant="destructive">Đang dừng</Badge> : null}
                  </div>
                </div>
              </div>
              {p.photoCount === 0 ? <p className="text-[12px] text-muted-foreground">Chưa có ảnh sản phẩm thật: Thư viện Media → Nguồn ảnh → Nhập ảnh sản phẩm từ Pancake.</p> : null}
              {p.pausedAt ? <p className="text-[12px] text-destructive">Mã đang dừng khẩn cấp{p.pausedReason ? `: ${p.pausedReason}` : ""}.</p> : null}
              <div className="flex flex-wrap items-center gap-2">
                {canSpend && p.photoCount > 0 ? <CreateRunDialog productId={p.productId} label={`${p.code} ${p.name}`} music={music} perVideoUsd={perVideoUsd} costNote={costNote} /> : null}
                {p.awaitingReview ? (
                  <Link href="?tab=duyet" className="rounded-md border border-primary/50 bg-primary/5 px-2.5 py-1 text-[12.5px] font-medium text-primary hover:bg-primary/10">
                    Duyệt {p.awaitingReview} video →
                  </Link>
                ) : null}
              </div>
              <details className="group rounded-md border bg-muted/20 text-[12.5px]">
                <summary className="flex cursor-pointer items-center gap-1.5 px-2 py-1.5 text-muted-foreground">
                  <Settings2 className="size-3.5" aria-hidden /> Thiết lập duyệt · đăng Reel · quảng cáo
                  <span className="ml-auto truncate text-[11px]">{p.pageId ? (pages.find((x) => x.id === p.pageId)?.name ?? p.pageId) : "chưa gán fanpage"}</span>
                </summary>
                <div className="space-y-2 border-t p-2">
                  <SkuModeSelect productId={p.productId} value={p.reviewMode ?? "MANUAL"} disabled={!canMode} />
                  <div className="flex flex-wrap items-center gap-2">
                    <SkuPublishingSelect productId={p.productId} pageId={p.pageId} publishMode={p.publishMode} pages={pages} disabled={!canMode} />
                    <PauseButton scope="SKU" id={p.productId} paused={Boolean(p.pausedAt)} reason={p.pausedReason} canEngage={canEngage} canRelease={canRelease} label="mã" />
                  </div>
                  <SkuAdsForm productId={p.productId} accounts={accounts} value={{ adAccountId: p.adAccountId, adsMode: p.adsMode, dailyBudgetPerAdVnd: p.dailyBudgetPerAdVnd, skuDailyCapVnd: p.skuDailyCapVnd, autoScale: p.autoScale, autoNextRound: p.autoNextRound, adsModeBy: p.adsModeBy }} disabled={!canMoney} />
                </div>
              </details>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

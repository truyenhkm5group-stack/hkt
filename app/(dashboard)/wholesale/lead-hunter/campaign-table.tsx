"use client";

import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatNumber } from "@/lib/format";
import type { CampaignProgress } from "@/lib/queries/wholesale";
import { CAMPAIGN_STATUS_LABEL, type CampaignStatus } from "@/lib/wholesale/constants";
import { CampaignCard, STATUS_TONE } from "@/app/(dashboard)/wholesale/lead-hunter/campaign-card";
import { cn } from "@/lib/utils";

/**
 * Bảng chiến dịch gọn (thay lưới thẻ dài — chủ shop 30/10/2026). Vừa một màn hình: sáu cột, ô hai tầng. Bấm một dòng ⇒ mở
 * thẻ chi tiết cũ ngay dưới dòng (đủ nút Dùng mẫu / Bắt đầu / Nhân bản / Xem lead) — không mất chức năng nào.
 */

const FILTERS = [
  { key: "all", label: "Tất cả", has: () => true },
  { key: "draft", label: "Nháp & mẫu", has: (c: CampaignProgress) => c.isTemplate || c.status === "DRAFT" },
  { key: "running", label: "Đang chạy", has: (c: CampaignProgress) => !c.isTemplate && (c.status === "RUNNING" || c.status === "PAUSED") },
  { key: "done", label: "Xong", has: (c: CampaignProgress) => !c.isTemplate && (c.status === "COMPLETED" || c.status === "STOPPED") },
] as const;

function usd(micros: number): string {
  return `${(micros / 1e6).toLocaleString("vi-VN", { maximumFractionDigits: 2 })} US$`;
}

export function CampaignTable({ rows, usdToVnd }: { rows: CampaignProgress[]; usdToVnd: number }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const [open, setOpen] = useState<string | null>(null);
  const f = FILTERS.find((x) => x.key === filter)!;
  const shown = rows.filter((c) => f.has(c));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Lọc chiến dịch">
        {FILTERS.map((x) => (
          <button key={x.key} type="button" role="tab" aria-selected={filter === x.key} onClick={() => setFilter(x.key)} className={cn("rounded-full border px-2.5 py-1 text-xs", filter === x.key ? "border-primary bg-primary/10 font-medium" : "text-muted-foreground hover:text-foreground")}>
            {x.label} ({rows.filter((c) => x.has(c)).length})
          </button>
        ))}
      </div>
      {shown.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] max-w-[1150px] text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr className="border-b">
                <th className="py-1.5 pr-2 font-medium">Chiến dịch</th>
                <th className="py-1.5 pr-2 font-medium">Thị trường</th>
                <th className="py-1.5 pr-2 font-medium">Trạng thái</th>
                <th className="py-1.5 pr-2 font-medium">Tiến độ</th>
                <th className="py-1.5 pr-2 text-right font-medium">Lead · email · website</th>
                <th className="py-1.5 text-right font-medium">Chi phí</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => {
                const done = c.cellsDone + c.cellsFresh + c.cellsFailed;
                const pct = c.cells ? Math.round((done / c.cells) * 100) : null;
                const isOpen = open === c.id;
                return (
                  <Fragment key={c.id}>
                    <tr className={cn("cursor-pointer border-b align-top hover:bg-muted/40", isOpen && "bg-muted/40")} onClick={() => setOpen(isOpen ? null : c.id)} aria-expanded={isOpen}>
                      <td className="max-w-[320px] py-1.5 pr-2">
                        <div className="flex items-start gap-1">
                          {isOpen ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />}
                          <div className="min-w-0">
                            <div className="truncate font-medium" title={c.name}>
                              {c.isTemplate ? <span className="mr-1 rounded border border-dashed px-1 text-[10px] font-normal text-muted-foreground">Mẫu</span> : null}
                              {c.name}
                            </div>
                            <div className="text-[11px] text-muted-foreground">tối đa {formatNumber(c.maxLeads)} lead</div>
                          </div>
                        </div>
                      </td>
                      <td className="max-w-[200px] truncate py-1.5 pr-2 text-xs" title={c.market}>
                        {c.market}
                      </td>
                      <td className="py-1.5 pr-2">
                        <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", STATUS_TONE[c.status])}>{c.isTemplate ? "Mẫu" : (CAMPAIGN_STATUS_LABEL[c.status as CampaignStatus] ?? c.status)}</span>
                      </td>
                      <td className="w-[150px] py-1.5 pr-2">
                        {c.cells ? (
                          <>
                            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                              <div className="h-full bg-primary" style={{ width: `${pct ?? 0}%` }} />
                            </div>
                            <div className="text-[11px] tabular-nums text-muted-foreground">
                              {formatNumber(done)}/{formatNumber(c.cells)} ô · {pct ?? 0}%
                            </div>
                          </>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">{c.estimate ? `${formatNumber(c.estimate.cellsToScan)} truy vấn dự kiến` : "chưa xếp ô"}</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">
                        <div className="font-medium">{formatNumber(c.newLeads)} lead</div>
                        <div className="text-[11px] text-muted-foreground">
                          {formatNumber(c.withEmail)} email · {formatNumber(c.withWebsite)} web
                        </div>
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {c.costMicros > 0 || !c.estimate ? (
                          <>
                            <div>{usd(c.costMicros)}</div>
                            <div className="text-[11px] text-muted-foreground">≈ {formatNumber(Math.round((c.costMicros / 1e6) * usdToVnd))} ₫</div>
                          </>
                        ) : (
                          <>
                            <div className="text-muted-foreground">ước tính</div>
                            <div className="text-[11px] text-muted-foreground">
                              {usd(c.estimate.minMicros)}–{usd(c.estimate.maxMicros)}
                            </div>
                          </>
                        )}
                      </td>
                    </tr>
                    {isOpen ? (
                      <tr className="border-b">
                        <td colSpan={6} className="bg-muted/20 p-2">
                          <CampaignCard c={c} usdToVnd={usdToVnd} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">Không có chiến dịch nào ở mục «{f.label}».</p>
      )}
    </div>
  );
}

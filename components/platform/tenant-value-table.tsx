"use client";

import * as React from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table/data-table";
import { TENANT_VALUE_BOARD_PAGE_SIZE, TENANT_VALUE_DEFAULT_SORT, TENANT_VALUE_SORTABLE } from "@/lib/constants/tenant-value-board";
import type { CustomerHealthLevel } from "@/lib/constants/customer-health";
import type { CellView, HealthView, TenantValueBoardRow } from "@/lib/saas/tenant-value-view";
import { cn } from "@/lib/utils";

/**
 * Bảng «Giá trị khách hàng» của /platform/saas — client wrapper qua `DataTable` (luật kiến trúc mục 2: Server Component không
 * truyền hàm / cột sang client). Mọi chữ trong ô đã DỰNG Ở MÁY CHỦ từ ảnh chụp (`lib/saas/tenant-value-view.ts`): bảng này chỉ vẽ,
 * không tính. «—» = chưa biết (tooltip nói thiếu gì), «N/A» = không áp dụng. KHÔNG tô màu đạt / không đạt — chưa có đích (luật 38 ·
 * 44); màu duy nhất là MỨC sức khoẻ (mức + mã lý do, không chấm điểm tổng — D9). Tám cột ô hai tầng, vừa ~1.150 px; điện thoại vẽ thẻ.
 */

const LEVEL_TONE: Record<CustomerHealthLevel, string> = {
  CRITICAL: "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300",
  NEEDS_ATTENTION: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300",
  UNKNOWN: "border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300",
  HEALTHY: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  INACTIVE: "border-dashed border-hairline bg-transparent text-muted-foreground",
};

/** Nhãn «tạm» nối tới mục quyết định trên cùng trang. */
function Provisional({ cell }: { cell: CellView }) {
  if (!cell.provisional) return null;
  const id = cell.provisional === "?" ? "quyet-dinh-tam" : `decision-${cell.provisional}`;
  return (
    <a href={`#${id}`} data-no-row-link className="ml-1 rounded border border-dashed border-hairline px-1 text-[10px] font-medium text-muted-foreground hover:text-foreground" title="Ô đang chạy theo quyết định TẠM của chủ shop — bấm để xem">
      tạm{cell.provisional === "?" ? "" : `·${cell.provisional}`}
    </a>
  );
}

/** Một con số + nhãn nhỏ; tooltip là toàn bộ căn cứ của ô. */
function Num({ cell, prefix, strong }: { cell: CellView; prefix?: string; strong?: boolean }) {
  return (
    <span title={cell.hint} className={cn("numeric whitespace-nowrap", strong && "font-semibold", cell.state !== "VALUE" && "text-muted-foreground")} data-cell-state={cell.state}>
      {prefix ? <span className="font-normal text-muted-foreground">{prefix} </span> : null}
      {cell.text}
      {cell.estimated && cell.state === "VALUE" ? <span className="ml-0.5 text-[10px] font-normal text-muted-foreground">ƯT</span> : null}
    </span>
  );
}

function Two({ top, bottom }: { top: React.ReactNode; bottom?: React.ReactNode }) {
  return (
    <div className="leading-tight">
      <div className="text-[13px]">{top}</div>
      {bottom ? <div className="mt-0.5 text-[11.5px] text-muted-foreground">{bottom}</div> : null}
    </div>
  );
}

function HealthCell({ h }: { h: HealthView | null }) {
  if (!h) return <span className="text-xs text-muted-foreground" title="Chưa có dòng sức khoẻ nào cho tổ chức này — lượt chụp của job chưa tới.">Chưa có ảnh sức khoẻ</span>;
  const reasons = [...h.reasons.map((r) => `${r.code}: ${r.text}`), ...h.gaps.map((g) => `Chưa đo ${g.code}: ${g.text}`)].join("\n");
  const churn = h.churn.reasons.map((r) => `${r.code}: ${r.text}`).join("\n");
  const gapHint = h.churn.risk === "UNKNOWN" && h.gaps.length ? `\nThiếu: ${h.gaps.map((g) => g.label).join(" · ")}` : "";
  return (
    <div className="max-w-[170px] space-y-0.5 leading-tight">
      <div className="flex min-w-0 items-center gap-1" title={reasons}>
        <span className={cn("inline-flex items-center whitespace-nowrap rounded-full border px-1.5 py-px text-[11px] font-semibold", LEVEL_TONE[h.level])}>{h.levelLabel}</span>
        <span className="truncate text-[11px] text-muted-foreground">{h.reasons[0]?.code ?? ""}</span>
      </div>
      <div className="truncate text-[11.5px]" title={`${churn}${gapHint}`}>
        <span className="text-muted-foreground">Rời bỏ:</span> <b className="font-semibold">{h.churn.label}</b>
        <span className="text-muted-foreground"> · {h.churn.reasons[0]?.code ?? ""}</span>
      </div>
      {h.staleDays > 0 ? <div className="text-[10.5px] text-muted-foreground">ảnh {h.staleDays} ngày trước</div> : null}
    </div>
  );
}

function TopIssueCell({ h }: { h: HealthView | null }) {
  const t = h?.topIssue ?? null;
  if (!t) return <span className="text-xs text-muted-foreground" title={h ? "Không vấn đề nào có chứng cứ trong ảnh sức khoẻ." : "Chưa có ảnh sức khoẻ."}>{h ? "Không có" : "—"}</span>;
  return (
    <div className="max-w-[210px] whitespace-normal leading-tight">
      <div className="text-[12.5px] font-medium" title={t.explanation}>
        {t.label}
      </div>
      {t.href ? (
        <Link href={t.href} data-no-row-link className="text-[11.5px] text-primary hover:underline">
          {t.actionLabel} →
        </Link>
      ) : null}
    </div>
  );
}

function OrgCell({ r }: { r: TenantValueBoardRow }) {
  return (
    <div className="min-w-0 max-w-[150px] leading-tight">
      <Link href={r.href} data-no-row-link className="block truncate font-semibold hover:underline" title={r.orgName}>
        {r.orgName}
      </Link>
      <div className="truncate text-[11px] text-muted-foreground" title={r.sourceErrors.length ? `Nguồn hỏng trong lượt chụp: ${r.sourceErrors.join(" · ")}` : `Công thức ${r.formulaVersion}`}>
        {r.orgCode}
        {r.orgStatus && r.orgStatus !== "ACTIVE" ? ` · ${r.orgStatus}` : ""}
        {r.staleDays > 0 ? ` · ảnh ${r.staleDays} ngày trước` : ""}
        {r.sourceErrors.length ? ` · ${r.sourceErrors.length} nguồn hỏng` : ""}
      </div>
    </div>
  );
}

const columns: ColumnDef<TenantValueBoardRow, unknown>[] = [
  { id: "org", header: "Khách", size: 150, cell: ({ row }) => <OrgCell r={row.original} /> },
  {
    id: "customerSpend",
    header: "Khách trả",
    size: 115,
    meta: { align: "right" },
    cell: ({ row: { original: r } }) => <Two top={<><Num cell={r.spend} strong /><Provisional cell={r.spend} /></>} bottom={<Num cell={r.spendCash} prefix="tiền về" />} />,
  },
  {
    id: "variableCogs",
    header: "Ta tốn",
    size: 110,
    meta: { align: "right" },
    cell: ({ row: { original: r } }) => <Two top={<Num cell={r.cogs} strong />} bottom={<Num cell={r.unpricedCalls} prefix="chưa giá" />} />,
  },
  {
    id: "aiValue",
    header: "AI tạo · tác động",
    size: 170,
    meta: { align: "right" },
    cell: ({ row: { original: r } }) => (
      <Two
        top={
          <>
            <Num cell={r.aiAutoOrders} strong /> <span className="text-[11px] text-muted-foreground">tự chốt ·</span> <Num cell={r.aiInfluencedOrders} /> <span className="text-[11px] text-muted-foreground">tác động</span>
          </>
        }
        bottom={
          <>
            <Num cell={r.aiCreditedRevenue} />
            <Provisional cell={r.aiCreditedRevenue} /> · <Num cell={r.aiInfluencedRevenue} />
          </>
        }
      />
    ),
  },
  {
    id: "valueMultiple",
    header: "Bội số",
    size: 95,
    meta: { align: "right" },
    cell: ({ row: { original: r } }) => <Two top={<><Num cell={r.multiple} strong /><Provisional cell={r.multiple} /></>} bottom={<Num cell={r.multipleCoverage} prefix="phủ" />} />,
  },
  {
    id: "platformProfit",
    header: "Lãi nền tảng",
    size: 120,
    meta: { align: "right" },
    cell: ({ row: { original: r } }) => <Two top={r.grossProfit.state === "VALUE" ? <Num cell={r.grossProfit} strong /> : <Num cell={r.grossProfitCeiling} strong />} bottom={<Num cell={r.contribution} prefix="sau AI" />} />,
  },
  { id: "health", header: "Sức khoẻ · rời bỏ", size: 165, cell: ({ row }) => <HealthCell h={row.original.health} /> },
  { id: "topIssue", header: "Vấn đề chính", size: 215, cell: ({ row }) => <TopIssueCell h={row.original.health} /> },
];

/** Điện thoại: một thẻ — cùng chữ của bảng, xếp dọc, không cuộn ngang. */
function MobileCard({ r }: { r: TenantValueBoardRow }) {
  const line = "flex items-baseline justify-between gap-2 text-[13px]";
  return (
    <div className="space-y-1.5">
      <OrgCell r={r} />
      <div className={line}>
        <span className="text-muted-foreground">Khách trả</span>
        <span>
          <Num cell={r.spend} strong />
          <Provisional cell={r.spend} />
        </span>
      </div>
      <div className={line}>
        <span className="text-muted-foreground">Ta tốn</span>
        <Num cell={r.cogs} />
      </div>
      <div className={line}>
        <span className="text-muted-foreground">AI tự chốt · tác động</span>
        <span>
          <Num cell={r.aiAutoOrders} /> · <Num cell={r.aiInfluencedOrders} />
        </span>
      </div>
      <div className={line}>
        <span className="text-muted-foreground">Bội số</span>
        <Num cell={r.multiple} />
      </div>
      <div className={line}>
        <span className="text-muted-foreground">Lãi nền tảng</span>
        {r.grossProfit.state === "VALUE" ? <Num cell={r.grossProfit} /> : <Num cell={r.grossProfitCeiling} />}
      </div>
      <HealthCell h={r.health} />
      <TopIssueCell h={r.health} />
    </div>
  );
}

export function TenantValueTable({ rows, pageCount, total }: { rows: TenantValueBoardRow[]; pageCount: number; total: number }) {
  return (
    <DataTable
      columns={columns}
      data={rows}
      pageCount={pageCount}
      total={total}
      getRowId={(r) => r.orgCode}
      sortable={[...TENANT_VALUE_SORTABLE]}
      defaultSort={TENANT_VALUE_DEFAULT_SORT}
      defaultDir="desc"
      defaultPageSize={TENANT_VALUE_BOARD_PAGE_SIZE}
      dense
      mobileCard={(r) => <MobileCard r={r} />}
      emptyTitle="Chưa có ảnh giá trị nào cho cửa sổ này"
      emptyDescription="Lượt chụp chạy ké job alerts của nhà, mỗi ngày VN một lần. Trang này không tự chụp."
    />
  );
}

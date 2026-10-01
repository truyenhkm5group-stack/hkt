"use client";

import { useMemo, useState, useTransition } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Copy, ExternalLink, Loader2, PauseCircle } from "lucide-react";
import { toast } from "sonner";
import { ExtendButton, PauseNowButton } from "@/app/(dashboard)/marketing/creatives/live-actions";
import { ChatTestButton } from "@/app/(dashboard)/marketing/creatives/chat-test";
import { DailyButton } from "@/app/(dashboard)/marketing/creatives/live-daily";
import { RepublishButton, type ComposeCtx, type RepublishSource } from "@/app/(dashboard)/marketing/creatives/manual-gen";
import { MODE_LABEL, VariantImage } from "@/app/(dashboard)/marketing/creatives/variant-bits";
import { DataTable } from "@/components/data-table/data-table";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { pauseVariantNow } from "@/lib/actions/creative";
import type { ProductWinCode } from "@/lib/constants/campaign-setup";
import { LIVE_BOARD_PAGE_SIZE, LIVE_DEFAULT_SORT, LIVE_SORTABLE, LIVE_STATE_LABEL, type LiveBoardRow, type LiveState } from "@/lib/constants/creative-live-board";
import { CREATIVE_VERDICT_LABEL, type CreativeVerdict } from "@/lib/constants/creative-loop";
import { formatDate, formatNumber, formatPercent, formatVND, vnShortStamp } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ═══════════ BẢNG "④ ĐANG CHẠY" ═══════════
 *
 * Một dòng một camp (mỗi bài một chiến dịch, §5i). Cột đầu là TÊN CHIẾN DỊCH NHƯ TRÌNH QUẢN LÝ QUẢNG CÁO đang gọi
 * nó (đọc từ lượt đồng bộ), bấm là mở đúng chiến dịch trên Ads Manager. Số đo là số TRONG KỲ đang lọc; phán quyết
 * là của TOÀN ĐỜI camp — hai thứ ấy nói khác nhau là bình thường, và tiêu đề cột nói rõ cái nào là cái nào.
 *
 * Bảng vừa ~1.150px: mỗi ô số hai tầng (số chính · số phụ), chữ giải thích nằm trong `title`.
 *
 * Mục 44: chỉ phán quyết ĐÃ KẾT LUẬN mới mang màu. `RUNNING` · `AWAITING_ORDERS` · `UNJUDGED` · `PENDING` là
 * "chưa kết luận" — tô chúng xanh hay đỏ là nói trước một điều máy chưa biết.
 */

const VERDICT_TONE: Partial<Record<CreativeVerdict, string>> = {
  WIN: "bg-success/15 text-success",
  PROMISING: "bg-success/10 text-success",
  KILL: "bg-destructive/10 text-destructive",
  LOSE: "bg-destructive/10 text-destructive",
};

/** Trạng thái TIỀN: "đang chạy" (tiền đang chảy) chấm đặc, "chờ tới giờ" vòng rỗng cùng màu; còn lại xám. Không phải phán quyết. */
const STATE_DOT: Record<LiveState, string> = {
  RUNNING: "bg-success",
  SCHEDULED: "border border-success bg-transparent",
  PAUSED: "bg-muted-foreground/50",
  ENDED: "bg-muted-foreground/50",
};

function Hai({ top, bottom, title }: { top: React.ReactNode; bottom: React.ReactNode; title?: string }) {
  return (
    <div className="numeric whitespace-nowrap text-right leading-tight" title={title}>
      <div className="font-medium">{top}</div>
      <div className="text-[11px] text-muted-foreground">{bottom}</div>
    </div>
  );
}

function CampaignCell({ r }: { r: LiveBoardRow }) {
  const n = r.names;
  const nameTitle = [
    n.source === "FACEBOOK" ? `Tên trên Trình quản lý quảng cáo (đồng bộ lúc ${vnShortStamp(n.syncedAt)})` : "Tên ERP đặt lúc đăng — Facebook chưa báo về (camp chưa tiêu đồng nào, hoặc lượt đồng bộ chưa chạy tới).",
    n.renamed ? `Tên ERP lúc đăng: ${n.erpCampaign}` : "",
    r.fbCampaignId ? `ID chiến dịch: ${r.fbCampaignId}` : "",
    r.fbAdId ? `ID quảng cáo: ${r.fbAdId}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div className="flex min-w-0 gap-2">
      <VariantImage imageId={r.imageId} available={r.imageAvailable} alt={r.headline || `Mẫu #${r.slot}`} className="size-12 shrink-0 rounded" iconClassName="size-4" zoomable />
      <div className="min-w-0 max-w-[230px]">
        <div className="flex min-w-0 items-center gap-1">
          {r.adsManagerUrl ? (
            <a href={r.adsManagerUrl} target="_blank" rel="noreferrer" className="group inline-flex min-w-0 items-center gap-1 font-semibold hover:text-primary" title={`${nameTitle}\nBấm để mở trên Ads Manager`}>
              <span className="truncate">{n.campaign || <span className="italic text-muted-foreground">chưa đặt tên</span>}</span>
              <ExternalLink className="size-3 shrink-0 opacity-50 group-hover:opacity-100" aria-hidden />
            </a>
          ) : (
            <span className="truncate font-semibold" title={nameTitle}>
              {n.campaign || <span className="italic text-muted-foreground">chưa đặt tên</span>}
            </span>
          )}
        </div>
        <p className="truncate text-[11px] text-muted-foreground" title={`Nhóm: ${n.adset || "—"}\nQuảng cáo: ${n.ad || "—"}`}>
          {n.source === "ERP" ? <span className="mr-1 rounded bg-muted px-1 text-[10px] font-medium">tên ERP</span> : null}
          {n.renamed ? (
            <span className="mr-1 rounded bg-muted px-1 text-[10px] font-medium" title={`Đã đổi tên trên Trình quản lý. Tên ERP lúc đăng: ${n.erpCampaign}`}>
              đã đổi tên
            </span>
          ) : null}
          {n.ad || n.adset || "—"}
        </p>
        <p className="truncate text-[11px] text-muted-foreground" title={r.headline}>
          {r.productLabel ?? "không gắn mã"} · #{r.slot} {r.headline}
        </p>
      </div>
    </div>
  );
}

function StateCell({ r }: { r: LiveBoardRow }) {
  const budget = r.dailyBudget ? (r.committedBudgetVnd !== null ? `${formatVND(r.committedBudgetVnd)}/ngày` : "ngân sách ngày") : r.committedBudgetVnd !== null ? `trọn đời ${formatVND(r.committedBudgetVnd)}` : "—";
  const title = [
    `${MODE_LABEL[r.mode]} · lô ${formatDate(r.batchDay)}`,
    r.dailyBudget ? `Chạy liên tục (ngân sách ngày); khung chấm tới ${vnShortStamp(r.endAt)}` : `Khung test ${vnShortStamp(r.startAt)} → ${vnShortStamp(r.endAt)}`,
    r.pausedAt ? `Tắt lúc ${vnShortStamp(r.pausedAt)}${r.pauseReason ? ` — ${r.pauseReason}` : ""}` : "",
    r.lastSpendDate ? `Ngày gần nhất có chi (trong kỳ): ${formatDate(r.lastSpendDate)}` : "Chưa có dòng chi nào trong kỳ",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div className="leading-tight" title={title}>
      <div className="flex items-center gap-1.5 font-medium">
        <span className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT[r.state])} aria-hidden />
        {LIVE_STATE_LABEL[r.state]}
      </div>
      <div className="text-[11px] text-muted-foreground">{r.state === "SCHEDULED" ? `chạy lúc ${vnShortStamp(r.startAt)}` : `từ ${vnShortStamp(r.startAt)}`}</div>
      <div className="text-[11px] text-muted-foreground">{budget}</div>
    </div>
  );
}

function VerdictCell({ r }: { r: LiveBoardRow }) {
  const tone = VERDICT_TONE[r.verdict];
  const giu = r.keepChecks.length ? `${r.keepChecks.filter((c) => c.pass === true).length}/${r.keepChecks.length} luật giữ đạt` : "chưa khai luật giữ";
  const title = [
    `Phán quyết trên số đo TOÀN ĐỜI camp: chi ${formatVND(r.lifetimeSpendVnd)} · ${formatNumber(r.lifetimeOrders)} đơn chốt.`,
    ...r.reasons,
    ...r.keepChecks.map((c) => `${c.pass === true ? "✓ đạt" : c.pass === false ? "✗ hụt" : "? chưa"} — ${c.text}`),
  ].join("\n");
  return (
    <div className="max-w-[170px] leading-tight" title={title}>
      <span className={cn("inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold", tone ?? "bg-muted text-muted-foreground")}>{CREATIVE_VERDICT_LABEL[r.verdict]}</span>
      <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{r.reasons[0] ?? giu}</p>
      {r.reasons.length ? <p className="text-[11px] text-muted-foreground">{giu}</p> : null}
    </div>
  );
}

/** TẮT HÀNG LOẠT — mỗi camp một lời gọi `pauseVariantNow` (đủ cổng như nút lẻ), lần lượt, báo lại số tắt được / hỏng. */
function BulkPause({ rows, clear }: { rows: LiveBoardRow[]; clear: () => void }) {
  const live = rows.filter((r) => r.status === "LIVE");
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [done, setDone] = useState(0);
  if (live.length === 0) return null;
  const tat = () =>
    start(async () => {
      let ok = 0;
      const loi: string[] = [];
      setDone(0);
      for (const r of live) {
        const res = await pauseVariantNow({ variantId: r.id });
        if ("error" in res) loi.push(`${r.names.campaign || `#${r.slot}`}: ${res.error}`);
        else ok += 1;
        setDone((d) => d + 1);
      }
      if (ok) toast.success(`Đã tắt ${ok}/${live.length} camp.`);
      if (loi.length) toast.error(`Không tắt được ${loi.length} camp — ${loi.slice(0, 3).join(" · ")}${loi.length > 3 ? " …" : ""}`);
      setOpen(false);
      clear();
    });
  return (
    <>
      <Button variant="outline" size="sm" className="h-7 text-[12px]" onClick={() => setOpen(true)}>
        <PauseCircle className="size-3.5" />
        Tắt {live.length} camp đang chạy
      </Button>
      <AlertDialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Tắt {live.length} camp ngay?</AlertDialogTitle>
            <AlertDialogDescription>
              Máy tắt nhóm quảng cáo của từng camp trên Facebook, lần lượt từng cái, mỗi lượt đi qua đủ cổng như nút “Tắt ngay”. Tắt chỉ làm GIẢM tiền; mỗi lượt ghi tên bạn vào sổ ghi Facebook.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-40 space-y-0.5 overflow-y-auto text-[12.5px]">
            {live.map((r) => (
              <li key={r.id} className="truncate">
                · {r.names.campaign || `Mẫu #${r.slot}`}
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                tat();
              }}
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              {pending ? `Đang tắt ${done}/${live.length}…` : `Tắt ${live.length} camp`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function CopyNames({ rows }: { rows: LiveBoardRow[] }) {
  const copy = async () => {
    const text = rows.map((r) => [r.names.campaign, r.fbCampaignId ?? "", r.fbAdId ?? ""].join("\t")).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`Đã chép tên + ID của ${rows.length} camp (dán được vào Excel / ô tìm của Ads Manager).`);
    } catch {
      toast.error("Trình duyệt không cho chép vào bộ nhớ tạm.");
    }
  };
  return (
    <Button variant="outline" size="sm" className="h-7 text-[12px]" onClick={() => void copy()}>
      <Copy className="size-3.5" />
      Chép tên + ID
    </Button>
  );
}

export function LiveTable({
  rows,
  total,
  pageCount,
  canWrite,
  republish,
}: {
  rows: LiveBoardRow[];
  total: number;
  pageCount: number;
  canWrite: boolean;
  /** Bộ đồ nghề "Đăng lại camp" — chỉ khi người xem bấm được (soạn bài VÀ duyệt chi). */
  republish: { ctx: ComposeCtx; sources: Record<string, RepublishSource>; winCodes: Record<string, ProductWinCode> } | null;
}) {
  const columns = useMemo<ColumnDef<LiveBoardRow, unknown>[]>(
    () => [
      { id: "campaign", header: "Chiến dịch", size: 290, cell: ({ row }) => <CampaignCell r={row.original} /> },
      { id: "start", header: "Trạng thái", size: 120, cell: ({ row }) => <StateCell r={row.original} /> },
      {
        id: "spend",
        header: "Chi · CPM",
        meta: { align: "right" },
        size: 90,
        cell: ({ row }) => <Hai top={formatVND(row.original.spendVnd)} bottom={formatVND(row.original.cpm)} title="Chi trong kỳ (dòng chi hạt AD) · chi cho 1.000 lượt hiển thị" />,
      },
      {
        id: "impressions",
        header: "Hiển thị · CTR",
        meta: { align: "right" },
        size: 90,
        cell: ({ row }) => {
          const r = row.original;
          return <Hai top={formatNumber(r.impressions)} bottom={formatPercent(r.ctr, 2)} title={`${formatNumber(r.clicks)} lượt nhấp · CPC ${formatVND(r.cpc)}`} />;
        },
      },
      {
        id: "messages",
        header: "Tin · chi/tin",
        meta: { align: "right" },
        size: 85,
        cell: ({ row }) => <Hai top={formatNumber(row.original.messages)} bottom={formatVND(row.original.costPerMessage)} />,
      },
      {
        id: "orders",
        header: "Đơn · giao/hoàn",
        meta: { align: "right" },
        size: 85,
        cell: ({ row }) => {
          const r = row.original;
          return (
            <Hai
              top={formatNumber(r.bookedOrders)}
              bottom={`${formatNumber(r.deliveredOrders)} / ${formatNumber(r.returnedOrders)}`}
              title={`Đơn chốt (không huỷ) lên trong kỳ, quy về mẩu bằng ORDER_AD_ID: ${formatNumber(r.ordersDirect)} mang ad_id · ${formatNumber(r.ordersViaPost)} qua bài viết. Có thể đếm THIẾU (~1/4 đơn thật không mang ad_id). Giao thành công / hoàn theo ORDER_OUTCOME.`}
            />
          );
        },
      },
      {
        id: "costPerOrder",
        header: "Chi/đơn · DT",
        meta: { align: "right" },
        size: 95,
        cell: ({ row }) => <Hai top={formatVND(row.original.costPerOrder)} bottom={formatVND(row.original.bookedRevenueVnd)} title="Chi / đơn chốt · doanh thu lên đơn của các đơn quy về mẩu (trong kỳ). Bằng chứng, không phải luật." />,
      },
      { id: "verdict", header: "Phán quyết (toàn đời)", size: 170, cell: ({ row }) => <VerdictCell r={row.original} /> },
      {
        id: "actions",
        header: "",
        size: 120,
        cell: ({ row }) => {
          const r = row.original;
          const src = republish?.sources[r.id];
          return (
            <div className="flex flex-col items-end gap-1">
              {r.fbAdId ? <DailyButton variantId={r.id} name={r.names.campaign} /> : null}
              {r.fbAdId ? <ChatTestButton campKey={r.id} /> : null}
              {republish && src ? <RepublishButton v={src} ctx={republish.ctx} winCode={src.productId ? (republish.winCodes[src.productId] ?? null) : null} /> : null}
              {canWrite && r.status === "LIVE" ? <PauseNowButton variantId={r.id} slot={r.slot} /> : null}
              {canWrite && r.verdict === "PROMISING" && !r.dailyBudget ? <ExtendButton variantId={r.id} slot={r.slot} /> : null}
            </div>
          );
        },
      },
    ],
    [canWrite, republish],
  );

  return (
    <DataTable
      columns={columns}
      data={rows}
      pageCount={pageCount}
      total={total}
      getRowId={(r) => r.id}
      selectable
      bulkActions={(sel, clear) => (
        <>
          {canWrite ? <BulkPause rows={sel} clear={clear} /> : null}
          <CopyNames rows={sel} />
        </>
      )}
      defaultSort={LIVE_DEFAULT_SORT}
      defaultDir="desc"
      sortable={[...LIVE_SORTABLE]}
      defaultPageSize={LIVE_BOARD_PAGE_SIZE}
      emptyTitle="Không có camp nào khớp bộ lọc"
      emptyDescription="Đổi kỳ, xoá bớt bộ lọc hoặc từ khoá. Camp xuất hiện ở đây sau khi được đăng lên Facebook."
    />
  );
}

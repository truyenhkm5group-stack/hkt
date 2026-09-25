"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { AlertTriangle, Ban, Link2, Loader2, PackageSearch, ScanLine } from "lucide-react";
import { toast } from "sonner";
import { CopyButton } from "@/components/misc";
import { SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dismissHmtRow, linkHmtRowToShipment, resolveHmtRowSku } from "@/lib/actions/return-exceptions";
import { HMT_EXCEPTION_QUEUES, HMT_QUEUE, type HmtExceptionQueue } from "@/lib/constants/hmt-returns";
import type { HmtExceptionQueues, HmtExceptionRow } from "@/lib/queries/return-exceptions";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ═══════════ NGOẠI LỆ LÀ VIỆC PHẢI LÀM, KHÔNG PHẢI SỐ ĐỂ NGẮM ═══════════
 *
 * Lượt đối soát để lại 26 dòng không khớp và 144 mã chỉ có ở sheet tổng. Trước khối này chúng là
 * bốn con số trên một thẻ tóm tắt — và một con số không có nút bấm là con số người ta học cách bỏ
 * qua. Sáu tháng sau không ai nhớ nổi 23 dòng ấy là gì.
 *
 * Bốn tab, bốn việc khác nhau, mỗi tab nói rõ NGƯỜI PHẢI LÀM GÌ chứ không mô tả vấn đề.
 *
 * ─── HAI ĐIỀU KHỐI NÀY CỐ Ý KHÔNG LÀM ───
 *
 *  · **Không có nút "khớp hết".** Mỗi dòng là một lần người nhìn hàng thật. Một nút gỡ hàng loạt ở
 *    đây là đúng cái "force-match" mà cả bộ máy đối soát được dựng lên để tránh.
 *  · **Không cộng tồn.** Gỡ xong, kiện vào hàng đợi ĐẾM — y hệt 672 kiện đã khớp. Người kho vẫn
 *    phải mở ra đếm (AGENTS.md mục 10).
 */
export function ExceptionQueues({ data, canWrite }: { data: HmtExceptionQueues; canWrite: boolean }) {
  const [tab, setTab] = useState<HmtExceptionQueue>(() => HMT_EXCEPTION_QUEUES.find((q) => data.counts[q] > 0) ?? "SKU_REVIEW");
  const tong = HMT_EXCEPTION_QUEUES.reduce((a, q) => a + data.counts[q], 0);
  if (!tong && !data.resolved) return null;
  const spec = HMT_QUEUE[tab];
  const rows = data.rows.filter((r) => r.queue === tab);

  return (
    <SectionCard
      title={
        <span className="flex items-center gap-1.5">
          <PackageSearch className="size-4" /> Ngoại lệ hàng hoàn · {formatNumber(tong)} dòng cần người
        </span>
      }
      description={`${data.workbook || "sổ hàng hoàn"}${data.resolved ? ` · ${formatNumber(data.resolved)} dòng đã có người gỡ` : ""}`}
      hint="Không dòng nào ở đây được ghi vào ERP. Gỡ một dòng chỉ ghi lại kết luận của người và — nếu chỉ ra một kiện có thật — đưa kiện đó vào hàng đợi ĐẾM. Tồn kho vẫn không đổi một món cho tới khi có người đếm."
    >
      <div className="flex flex-wrap gap-1.5">
        {HMT_EXCEPTION_QUEUES.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => setTab(q)}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs transition",
              tab === q ? "border-primary bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted",
            )}
          >
            {HMT_QUEUE[q].label} · <b className="numeric">{formatNumber(data.counts[q])}</b>
          </button>
        ))}
      </div>

      {/* Câu VIỆC PHẢI LÀM đứng ngay dưới tab — người mở tab lên là biết phải làm gì, không phải đoán. */}
      <p className="mt-2 rounded-md bg-muted/60 px-2.5 py-2 text-[12px] leading-relaxed text-muted-foreground">{spec.action}</p>

      {tab === "TRACKING_ONLY" ? (
        <TrackingOnlyTable rows={data.trackingOnly} detailOnly={data.detailOnly} />
      ) : rows.length ? (
        <div className="mt-2 overflow-x-auto">
          <Table className="min-w-[980px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[150px]">Nguồn</TableHead>
                <TableHead className="w-[190px]">Mã vận đơn</TableHead>
                <TableHead className="max-w-[240px]">Sổ giấy ghi</TableHead>
                <TableHead className="w-[210px]">Máy đọc được</TableHead>
                <TableHead className="w-[300px]">Gỡ</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <ExceptionRow key={r.id} row={r} canWrite={canWrite} />
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">Không còn dòng nào ở nhóm này.</p>
      )}
    </SectionCard>
  );
}

function ExceptionRow({ row, canWrite }: { row: HmtExceptionRow; canWrite: boolean }) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState("");
  const [variantId, setVariantId] = useState("");
  const [maKien, setMaKien] = useState("");
  const allow = HMT_QUEUE[row.queue].allow;

  const chay = (fn: () => Promise<{ ok: true } | { error: string }>, ok: string) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(ok);
    });

  return (
    <TableRow className={cn(pending && "bg-muted/40")}>
      <TableCell className="align-top text-xs text-muted-foreground">
        <div>{row.sheet}</div>
        <div className="numeric">dòng {row.sourceRow}</div>
      </TableCell>

      <TableCell className="group max-w-[190px] align-top text-xs">
        {row.trackingRaw ? (
          <span className="inline-flex items-center gap-0.5">
            <span className="font-mono">{row.trackingRaw}</span>
            <CopyButton value={row.trackingRaw} what="mã vận đơn" className="size-5 shrink-0 [&_svg]:size-3" />
          </span>
        ) : (
          <span className="text-muted-foreground">(ô trống)</span>
        )}
        {/* Kiện máy đã lần ra — có thì người gỡ không phải tra lại. */}
        {row.shipmentId ? (
          <div className="mt-0.5">
            <Link href={`/shipments/${row.shipmentId}`} className="text-primary hover:underline">
              {row.tracking ?? row.shipmentId}
            </Link>
            {row.orderSystemId ? <span className="text-muted-foreground"> · đơn #{row.orderSystemId}</span> : null}
          </div>
        ) : null}
        {row.customerName ? <div className="truncate text-[11px] text-muted-foreground">{row.customerName}</div> : null}
        {row.customerPhone ? (
          <span className="inline-flex items-center gap-0.5">
            <span className="font-mono text-[11px] text-muted-foreground">{row.customerPhone}</span>
            <CopyButton value={row.customerPhone} what="SĐT" className="size-5 shrink-0 [&_svg]:size-3" />
          </span>
        ) : null}
      </TableCell>

      <TableCell className="max-w-[240px] align-top text-xs">
        <div className="truncate" title={row.productText}>
          {row.productText || <span className="text-muted-foreground">(trống)</span>}
        </div>
        <div className="text-[11px] text-muted-foreground">SL sổ ghi: {formatNumber(row.quantity)}</div>
      </TableCell>

      <TableCell className="max-w-[210px] align-top text-xs">
        {/*
          "Máy đọc được" nói RÕ chỗ hụt. Rỗng không phải lỗi hiển thị — nó chính là lý do dòng này
          nằm đây, nên phải in ra thành chữ chứ không để một ô trắng.
        */}
        <div className="text-muted-foreground">
          mã hàng: <b className="text-foreground">{row.productCode || "không đọc được"}</b>
        </div>
        <div className="text-muted-foreground">
          màu/size: <b className="text-foreground">{[row.color, row.size].filter(Boolean).join(" / ") || "không đọc được"}</b>
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground" title={row.detail}>
          {row.detail}
        </div>
      </TableCell>

      <TableCell className="w-[300px] align-top">
        {!canWrite ? (
          <span className="text-xs text-muted-foreground">Chỉ người có quyền ghi kho mới gỡ được</span>
        ) : (
          <div className="space-y-1.5">
            {allow.includes("RESOLVED_SKU") ? (
              <Select value={variantId} onValueChange={setVariantId} disabled={pending}>
                <SelectTrigger className="h-8 text-xs" aria-label="Chọn mẫu mã đúng">
                  <SelectValue placeholder={row.candidates.length ? `Chọn trong ${row.candidates.length} mẫu của đơn` : "Kiện chưa lần ra — không có ứng viên"} />
                </SelectTrigger>
                <SelectContent>
                  {row.candidates.map((c) => (
                    <SelectItem key={c.variantId} value={c.variantId}>
                      {c.sku} · {[c.color, c.size].filter(Boolean).join(" / ")} · {c.name} ×{c.qty}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {allow.includes("LINKED_SHIPMENT") ? (
              <Input value={maKien} onChange={(e) => setMaKien(e.target.value)} placeholder="Mã kiện trong ERP (shipment id)" className="h-8 text-xs" disabled={pending} aria-label="Mã kiện để nối tay" />
            ) : null}
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Lý do — bắt buộc" className="h-8 text-xs" disabled={pending} aria-label="Lý do gỡ" />
            <div className="flex flex-wrap gap-1">
              {allow.includes("RESOLVED_SKU") ? (
                <Button size="sm" variant="secondary" className="h-7 text-xs" disabled={pending || !variantId || note.trim().length < 3} onClick={() => chay(() => resolveHmtRowSku({ id: row.id, variantId, note }), "Đã ghi mẫu mã do người chọn")}>
                  {pending ? <Loader2 className="size-3 animate-spin" /> : <ScanLine className="size-3" />} Chọn mẫu mã
                </Button>
              ) : null}
              {allow.includes("LINKED_SHIPMENT") ? (
                <Button size="sm" variant="secondary" className="h-7 text-xs" disabled={pending || !maKien.trim() || note.trim().length < 3} onClick={() => chay(() => linkHmtRowToShipment({ id: row.id, shipmentId: maKien.trim(), note }), "Đã nối kiện · kiện vào hàng đợi đếm")}>
                  {pending ? <Loader2 className="size-3 animate-spin" /> : <Link2 className="size-3" />} Nối kiện
                </Button>
              ) : null}
              {allow.includes("DISMISSED") ? (
                <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground hover:text-destructive" disabled={pending || note.trim().length < 3} onClick={() => chay(() => dismissHmtRow({ id: row.id, note }), "Đã bỏ qua kèm lý do")}>
                  <Ban className="size-3" /> Bỏ qua
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * "CÓ MÃ, CHƯA CÓ CHI TIẾT HÀNG" — KHÔNG CÓ NÚT NÀO, VÀ ĐÓ LÀ CÂU TRẢ LỜI.
 *
 * Mã vận đơn chứng minh DANH TÍNH KIỆN, không chứng minh trong kiện có món gì. Đặt một nút "ghi
 * nhận" ở đây là mời người dùng ghi vào sổ một lượng hàng chưa ai nhìn thấy. Việc phải làm nằm ở
 * chỗ khác: kho ghi bổ sung dòng món vào sổ giấy rồi tải bản mới lên.
 */
function TrackingOnlyTable({ rows, detailOnly }: { rows: HmtExceptionQueues["trackingOnly"]; detailOnly: number }) {
  const [q, setQ] = useState("");
  const loc = useMemo(() => {
    const k = q.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
    return k ? rows.filter((r) => r.trackingKey.includes(k) || r.trackingRaw.toUpperCase().includes(k)) : rows;
  }, [rows, q]);
  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm mã vận đơn…" className="h-8 max-w-xs text-xs" aria-label="Tìm mã trong nhóm chỉ có mã" />
        <span className="text-xs text-muted-foreground">
          {formatNumber(loc.length)}/{formatNumber(rows.length)} mã
          {detailOnly ? ` · ${formatNumber(detailOnly)} mã có ở sheet chi tiết mà sheet tổng KHÔNG có` : ""}
        </span>
      </div>
      <div className="flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-[12px] text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <span>Nhóm này KHÔNG có nút ghi nhận, và đó là câu trả lời đúng: mã vận đơn không chứng minh trong kiện có món gì. Kho ghi bổ sung dòng món vào sổ rồi tải bản mới lên.</span>
      </div>
      <div className="max-h-[320px] overflow-y-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[90px]">Dòng sổ</TableHead>
              <TableHead>Mã vận đơn</TableHead>
              <TableHead>Trạng thái sổ ghi</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loc.slice(0, 200).map((r) => (
              <TableRow key={`${r.trackingKey}-${r.sourceRow}`} className="group">
                <TableCell className="numeric text-xs text-muted-foreground">{r.sourceRow}</TableCell>
                <TableCell className="text-xs">
                  <span className="inline-flex items-center gap-0.5">
                    <span className="font-mono">{r.trackingRaw}</span>
                    <CopyButton value={r.trackingRaw} what="mã vận đơn" className="size-5 shrink-0 [&_svg]:size-3" />
                  </span>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.status || "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {loc.length > 200 ? <p className="text-[11px] text-muted-foreground">Hiện 200 dòng đầu — dùng ô tìm để thu hẹp.</p> : null}
    </div>
  );
}

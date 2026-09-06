"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, CopyX, ExternalLink, Loader2, RefreshCw, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money, SectionCard } from "@/components/ui-bits";
import { pushLanding, recheckLanding, setLandingStatus, setLandingVariant } from "@/lib/actions/landing";
import { LANDING_STATUS_LABEL, LANDING_STATUSES, type LandingStatus } from "@/lib/constants/landing";
import { OUTCOME_LABEL, OUTCOME_TONE } from "@/lib/constants/returns";
import { OrderStageBadge, ShipmentStageBadge } from "@/components/status-badge";
import { formatVND } from "@/lib/format";
import type { LandingRow, VariantOption } from "@/lib/queries/landing";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<LandingStatus, string> = {
  NEW: "bg-sky-50 text-sky-800 border-sky-200",
  CONFIRMED: "bg-emerald-50 text-emerald-800 border-emerald-200",
  PUSHED: "bg-violet-50 text-violet-800 border-violet-200",
  CANCELLED: "bg-zinc-100 text-zinc-600 border-zinc-200",
};

const fmt = (d: Date | null | undefined) => (d ? new Date(d).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }) : "—");

export function LandingTable({ rows, variants, canManage }: { rows: LandingRow[]; variants: VariantOption[]; canManage: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const run = (id: string, fn: () => Promise<{ error?: string } & Record<string, unknown>>, okMsg?: (r: Record<string, unknown>) => string) => {
    setBusy(id);
    start(async () => {
      const r = await fn();
      setBusy(null);
      if (r.error) toast.error(String(r.error));
      else {
        if (okMsg) toast.success(okMsg(r));
        router.refresh();
      }
    });
  };
  return (
    <SectionCard title="Danh sách đơn landing" description="Mỗi dòng = một lượt khách điền form. Xác nhận với khách → chọn mẫu mã (nếu ERP chưa ghép) → Gửi POS tạo đơn nháp trên Pancake; sau đó trạng thái giao / hoàn theo đơn Pancake. Cảnh báo trùng SĐT và khách rủi ro hoàn hiện ngay trên dòng." padded={false}>
      <div className="overflow-x-auto">
        <Table className="min-w-[1500px]">
          <TableHeader>
            <TableRow>
              <TableHead>Thời gian · dòng</TableHead>
              <TableHead>Khách hàng</TableHead>
              <TableHead>Sản phẩm trên sheet</TableHead>
              <TableHead>Mẫu mã Pancake</TableHead>
              <TableHead className="text-right">SL · tiền</TableHead>
              <TableHead>Cảnh báo</TableHead>
              <TableHead>Trạng thái ERP</TableHead>
              <TableHead>Đơn POS · kết quả</TableHead>
              <TableHead>Nguồn · ghi chú</TableHead>
              {canManage ? <TableHead className="w-40" /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={canManage ? 10 : 9} className="py-10 text-center text-sm text-muted-foreground">Chưa có đơn landing trong kỳ / bộ lọc này.</TableCell>
              </TableRow>
            ) : (
              rows.map((r) => {
                const isBusy = busy === r.id && pending;
                const dupCount = r.duplicates.length;
                return (
                  <TableRow key={r.id} className={cn(r.status === "CANCELLED" && "opacity-60")}>
                    <TableCell className="text-xs">
                      <div className="font-medium">{fmt(r.submittedAt ?? r.createdAt)}</div>
                      <div className="text-muted-foreground">dòng {r.rowIndex}{r.sheetStatus ? ` · sheet: ${r.sheetStatus}` : ""}</div>
                    </TableCell>
                    <TableCell className="max-w-[240px] text-xs">
                      <div className="font-semibold">{r.customerName || "—"}</div>
                      <div className="font-mono">{r.phone || "—"}</div>
                      <div className="truncate text-muted-foreground" title={`${r.address}${r.province ? `, ${r.province}` : ""}`}>{r.address}{r.province ? `, ${r.province}` : ""}</div>
                    </TableCell>
                    <TableCell className="max-w-[200px] text-xs">
                      <div className="truncate font-medium" title={r.productText}>{r.productText || "—"}</div>
                      <div className="text-muted-foreground">{[r.variantText, r.sizeText, r.colorText].filter(Boolean).join(" · ")}</div>
                    </TableCell>
                    <TableCell className="text-xs">
                      {canManage && r.status !== "CANCELLED" && !r.pancakeSystemId ? (
                        <select
                          className={cn("h-8 max-w-[240px] rounded-md border bg-background px-2 text-xs", !r.variantId && "border-amber-400")}
                          value={r.variantId ?? ""}
                          disabled={isBusy}
                          onChange={(e) => run(r.id, () => setLandingVariant(r.id, e.target.value || null))}
                        >
                          <option value="">— chọn mẫu mã —</option>
                          {variants.map((v) => (
                            <option key={v.id} value={v.id}>{v.label}</option>
                          ))}
                        </select>
                      ) : (
                        <span className={cn(!r.variantId && "text-amber-700")}>{r.variantLabel || "chưa ghép"}</span>
                      )}
                      {r.variantId && r.variantMatchScore > 0 && r.variantMatchScore < 99 ? <div className="text-[10.5px] text-muted-foreground">tự ghép · điểm {r.variantMatchScore}</div> : null}
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      <div>×{r.quantity}</div>
                      <Money value={r.total || r.price * r.quantity} />
                    </TableCell>
                    <TableCell className="text-xs">
                      {dupCount ? (
                        <div className="flex items-start gap-1 text-amber-700" title={r.duplicates.map((d) => `${d.label} · ${fmt(d.at)}`).join("\n")}>
                          <CopyX className="mt-0.5 size-3.5 shrink-0" />
                          <span>Trùng SĐT với {dupCount} đơn ({r.duplicates.filter((d) => d.kind === "PANCAKE").length} Pancake)</span>
                        </div>
                      ) : null}
                      {r.risk?.risky ? (
                        <div className={cn("flex items-start gap-1", r.risk.severity === "critical" ? "text-rose-700" : "text-amber-700")} title={r.risk.reasons.join(", ")}>
                          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                          <span>Rủi ro hoàn: GTC {r.risk.succeed} · hoàn {r.risk.returned}{r.risk.rate ? ` (${Math.round(r.risk.rate * 100)}%)` : ""} → xin cọc</span>
                        </div>
                      ) : r.risk && (r.risk.succeed || r.risk.returned) ? (
                        <div className="text-muted-foreground">Lịch sử: GTC {r.risk.succeed} · hoàn {r.risk.returned}</div>
                      ) : (
                        <div className="text-muted-foreground">Khách mới tại shop</div>
                      )}
                      {r.status !== "CANCELLED" && !r.address ? <div className="flex items-start gap-1 font-semibold text-rose-700"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" /><span>Thiếu địa chỉ → gọi khách xin địa chỉ</span></div> : null}
                      {r.status !== "CANCELLED" && !r.variantId && !r.sizeText ? <div className="flex items-start gap-1 font-semibold text-rose-700"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" /><span>Thiếu size → hỏi khách rồi chọn mẫu mã</span></div> : null}
                      {r.pushError ? <div className="text-rose-700" title={r.pushError}>Gửi POS lỗi: {r.pushError.slice(0, 80)}</div> : null}
                    </TableCell>
                    <TableCell>
                      {canManage ? (
                        <select
                          className={cn("h-8 rounded-md border px-2 text-xs font-medium", STATUS_TONE[r.status])}
                          value={r.status}
                          disabled={isBusy}
                          onChange={(e) => run(r.id, () => setLandingStatus(r.id, e.target.value))}
                        >
                          {LANDING_STATUSES.map((s) => (
                            <option key={s} value={s} disabled={s === "PUSHED" && !r.pancakeSystemId}>{LANDING_STATUS_LABEL[s]}</option>
                          ))}
                        </select>
                      ) : (
                        <span className={cn("rounded-md border px-2 py-1 text-xs font-medium", STATUS_TONE[r.status])}>{LANDING_STATUS_LABEL[r.status]}</span>
                      )}
                      {r.assignee ? <div className="mt-0.5 text-[10.5px] text-muted-foreground">{r.assignee}</div> : null}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.orderId ? (
                        <>
                          <span className="mb-0.5 inline-flex items-center rounded-md bg-emerald-50 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">✓ Đã có đơn POS</span>
                          <br />
                          <Link href={`/orders/${r.orderId}`} className="font-medium text-primary hover:underline">Đơn #{r.orderSystemId ?? ""}</Link>
                          {r.orderStage ? <OrderStageBadge stage={r.orderStage as Parameters<typeof OrderStageBadge>[0]["stage"]} className="ml-1 align-middle" /> : null}
                          {r.orderItemsText ? <div className="mt-0.5 max-w-[260px] text-[11px] leading-snug" title={r.orderItemsText}>Đặt: {r.orderItemsText}{r.orderTotal ? ` · ${formatVND(Number(r.orderTotal))}` : ""}</div> : null}
                          {r.tracking ? (
                            <div className="mt-0.5 text-[11px] leading-snug">
                              <span className="font-medium">ĐVVC:</span> {r.shipmentStatusName || (r.shipmentStage ? <ShipmentStageBadge stage={r.shipmentStage as Parameters<typeof ShipmentStageBadge>[0]["stage"]} /> : "—")}
                              {r.shipmentStatusAt ? <span className="text-muted-foreground"> · {fmt(r.shipmentStatusAt)}</span> : null}
                              <span className="ml-1 font-mono text-[10.5px] text-muted-foreground">{r.tracking}</span>
                            </div>
                          ) : r.orderStage && ["CONFIRMED", "PACKING", "NEW"].includes(r.orderStage) ? (
                            <div className="mt-0.5 text-[11px] text-muted-foreground">Chưa gửi đơn vị vận chuyển</div>
                          ) : null}
                          {r.outcome ? <div className={cn("mt-0.5 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium", OUTCOME_TONE[r.outcome])}>{OUTCOME_LABEL[r.outcome]}</div> : null}
                        </>
                      ) : r.pancakeSystemId ? (
                        <span className="inline-flex items-center rounded-md bg-amber-50 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300" title="ERP đã tạo đơn nháp trên Pancake, đang chờ đồng bộ về">Đơn nháp POS #{r.pancakeSystemId} · chờ đồng bộ</span>
                      ) : (
                        <span className="inline-flex items-center rounded-md bg-rose-50 px-1.5 py-0.5 text-[11px] font-semibold text-rose-700 dark:bg-rose-950/60 dark:text-rose-300" title="Chưa có đơn Pancake nào cùng SĐT quanh ngày điền form và ERP chưa gửi POS">Chưa lên POS</span>
                      )}
                      {r.lastPos ? (
                        <div className="mt-1 rounded-md border border-dashed border-amber-300 bg-amber-50/60 px-1.5 py-1 text-[11px] leading-snug text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100" title="Đơn POS gần nhất của SĐT này trong 90 ngày (không phải đơn của lượt điền form này)">
                          <div className="font-semibold">SĐT đã có đơn POS <Link href={`/orders/${r.lastPos.orderId}`} className="underline">#{r.lastPos.systemId ?? ""}</Link> · {fmt(r.lastPos.at)} <OrderStageBadge stage={r.lastPos.stage as Parameters<typeof OrderStageBadge>[0]["stage"]} className="ml-1 align-middle" /></div>
                          {r.lastPos.items ? <div>Đặt: {r.lastPos.items}{r.lastPos.total ? ` · ${formatVND(Number(r.lastPos.total))}` : ""}</div> : null}
                          {r.lastPos.tracking ? <div><span className="font-medium">ĐVVC:</span> {r.lastPos.vtpStatus || (r.lastPos.shipStage ? <ShipmentStageBadge stage={r.lastPos.shipStage as Parameters<typeof ShipmentStageBadge>[0]["stage"]} /> : "—")} <span className="font-mono text-[10.5px] opacity-80">{r.lastPos.tracking}</span></div> : <div className="opacity-80">Chưa gửi đơn vị vận chuyển</div>}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="max-w-[200px] text-xs">
                      {r.source ? <div className="truncate" title={r.source}>{r.source}</div> : null}
                      {r.note ? <div className="truncate text-muted-foreground" title={r.note}>“{r.note}”</div> : null}
                      {r.internalNote ? <div className="truncate text-sky-800" title={r.internalNote}>{r.internalNote}</div> : null}
                    </TableCell>
                    {canManage ? (
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          {!r.pancakeSystemId && r.status !== "CANCELLED" ? (
                            <Button size="sm" className="h-7" disabled={isBusy || !r.variantId || !r.phone} title={!r.variantId ? "Chọn mẫu mã trước" : "Tạo đơn nháp (trạng thái Mới) trên Pancake POS"} onClick={() => run(r.id, () => pushLanding(r.id), (x) => `Đã tạo đơn nháp POS #${x.systemId}`)}>
                              {isBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} Gửi POS
                            </Button>
                          ) : null}
                          <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={isBusy} onClick={() => run(r.id, () => recheckLanding(r.id))} title="Tính lại trùng / rủi ro theo dữ liệu mới nhất">
                            <RefreshCw className="size-3.5" /> Kiểm tra lại
                          </Button>
                          {r.pancakeSystemId && !r.orderId ? (
                            <a className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline" href={`https://pos.pancake.vn/shop/orders?search=${r.pancakeSystemId}`} target="_blank" rel="noreferrer"><ExternalLink className="size-3" /> Mở POS</a>
                          ) : null}
                        </div>
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </SectionCard>
  );
}

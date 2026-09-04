import { ArrowDownToLine, ClipboardCheck, Coins, Info, ListOrdered } from "lucide-react";
import Link from "next/link";
import { DeleteReceiptButton } from "@/app/(dashboard)/inventory/receipts/delete-receipt-button";
import { ReceiptDialog } from "@/app/(dashboard)/inventory/receipts/receipt-dialog";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { Money, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can, requireUser } from "@/lib/auth/session";
import { formatDate, formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { listStockReceipts, listVariantsForReceipt, stockReceiptSummary } from "@/lib/queries/stock";
import { param, type SearchParams } from "@/lib/search-params";
import { STOCK_RECEIPT_KIND_LABEL, type StockReceiptKind } from "@/lib/validation/stock";
import { cn } from "@/lib/utils";

export const metadata = { title: "Nhập hàng & kiểm kê" };

export default async function StockReceiptsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  const user = await requireUser();
  const canWrite = can(user.role, "inventory:write");
  const selectedId = param(raw, "receipt");
  const [receipts, summary, variants] = await Promise.all([listStockReceipts(200), stockReceiptSummary(), canWrite ? listVariantsForReceipt() : Promise.resolve([])]);
  const selected = selectedId ? receipts.find((r) => r.id === selectedId) : null;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Kho & tài chính"
        title="Nhập hàng & kiểm kê"
        description={`Số liệu nhập kho do shop tự ghi nhận trên ERP · ${formatNumber(summary.receipts)} phiếu nhập · ${formatNumber(summary.adjustments)} phiếu điều chỉnh${summary.lastAt ? ` · gần nhất ${formatDate(summary.lastAt)}` : ""}`}
        actions={
          canWrite ? (
            <>
              <ReceiptDialog variants={variants} defaultKind="ADJUSTMENT" />
              <ReceiptDialog variants={variants} defaultKind="RECEIPT" />
            </>
          ) : null
        }
      />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Tổng đã nhập" value={`+${formatNumber(summary.received)}`} note={`${formatNumber(summary.receipts)} phiếu nhập hàng`} icon={ArrowDownToLine} tone="green" />
        <MetricCard label="Điều chỉnh kiểm kê" value={`${summary.adjusted > 0 ? "+" : ""}${formatNumber(summary.adjusted)}`} note={`${formatNumber(summary.adjustments)} phiếu điều chỉnh`} icon={ClipboardCheck} tone={summary.adjusted < 0 ? "rose" : "slate"} />
        <MetricCard label="Giá trị hàng nhập" value={formatVND(summary.cost, { compact: true })} note="Theo giá nhập ghi trên phiếu" icon={Coins} tone="primary" />
        <MetricCard label="Mẫu mã trong ERP" value={formatNumber(variants.length || 0)} note={`${formatNumber(variants.filter((v) => v.currentStock <= 0).length)} mẫu mã tồn ≤ 0`} icon={ListOrdered} tone="blue" />
      </section>

      <div className="flex items-start gap-3 rounded-xl border bg-muted/40 p-3.5 text-[13px] text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        <div>
          <b className="text-foreground">Cách dùng lần đầu:</b> bấm <b className="text-foreground">Kiểm kê</b>, nhập số đếm thực tế của từng mẫu mã đang có trong kho → ERP tạo phiếu điều chỉnh để tồn khả dụng bằng đúng số đếm (đã tính hàng đang giao). Từ đó về sau, mỗi lần hàng về thì bấm <b className="text-foreground">Nhập hàng</b>. Tồn khả dụng = Nhập − Giao thành công thật − Đang giao; hàng hoàn tự động được coi là về kho. Xem tồn tại <Link href="/products" className="font-semibold text-primary hover:underline">Sản phẩm &amp; tồn kho</Link>.
        </div>
      </div>

      <SectionCard title="Phiếu kho" description="200 phiếu gần nhất · bấm vào phiếu để xem chi tiết" padded={false}>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ngày</TableHead>
                <TableHead>Loại</TableHead>
                <TableHead>Tham chiếu / NCC</TableHead>
                <TableHead>Mẫu mã</TableHead>
                <TableHead className="text-right">Số lượng</TableHead>
                <TableHead className="text-right">Giá trị</TableHead>
                <TableHead>Người lập</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {receipts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                    Chưa có phiếu nào. Bấm “Kiểm kê” để nhập tồn ban đầu hoặc “Nhập hàng” khi có hàng về.
                  </TableCell>
                </TableRow>
              ) : (
                receipts.map((r) => (
                  <TableRow key={r.id} className={cn(selected?.id === r.id && "bg-primary/5")}>
                    <TableCell>
                      <Link href={`/inventory/receipts?receipt=${r.id}#chi-tiet`} className="font-semibold hover:text-primary hover:underline">
                        {formatDate(r.receivedAt)}
                      </Link>
                      <div className="text-[10.5px] text-muted-foreground">lập {formatDateTime(r.createdAt)}</div>
                    </TableCell>
                    <TableCell>
                      <span className={cn("inline-flex rounded-md px-2 py-0.5 text-[11.5px] font-semibold", r.kind === "RECEIPT" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300" : "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300")}>{STOCK_RECEIPT_KIND_LABEL[r.kind as StockReceiptKind] ?? r.kind}</span>
                    </TableCell>
                    <TableCell className="max-w-[220px]">
                      <div className="truncate">{r.reference || "—"}</div>
                      <div className="truncate text-xs text-muted-foreground">{r.supplier || r.note || ""}</div>
                    </TableCell>
                    <TableCell className="numeric">{formatNumber(r.items.length)}</TableCell>
                    <TableCell className={cn("numeric text-right font-semibold", r.totalQuantity < 0 ? "text-rose-600" : "")}>
                      {r.totalQuantity > 0 ? "+" : ""}
                      {formatNumber(r.totalQuantity)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Money value={r.totalCost} className={r.totalCost ? "" : "text-muted-foreground"} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.createdBy}</TableCell>
                    <TableCell>{canWrite ? <DeleteReceiptButton id={r.id} label={`${STOCK_RECEIPT_KIND_LABEL[r.kind as StockReceiptKind] ?? r.kind} ${formatDate(r.receivedAt)}`} /> : null}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      {selected ? (
        <div id="chi-tiet">
          <SectionCard
            title={`${STOCK_RECEIPT_KIND_LABEL[selected.kind as StockReceiptKind] ?? selected.kind} ngày ${formatDate(selected.receivedAt)}`}
            description={[selected.reference, selected.supplier, selected.note].filter(Boolean).join(" · ") || undefined}
            actions={
              <Button asChild variant="ghost" size="sm">
                <Link href="/inventory/receipts">Đóng</Link>
              </Button>
            }
            padded={false}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mẫu mã</TableHead>
                  <TableHead className="text-right">Số lượng</TableHead>
                  <TableHead className="text-right">Giá nhập</TableHead>
                  <TableHead className="text-right">Thành tiền</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {selected.items.map((it) => (
                  <TableRow key={it.id}>
                    <TableCell>
                      <Link href={`/products/${it.variant.id}`} className="font-medium hover:text-primary hover:underline">
                        {it.variant.product?.name ?? "Sản phẩm"}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        <span className="font-mono">{it.variant.sku || "—"}</span>
                        {it.variant.color || it.variant.size ? ` · ${[it.variant.color, it.variant.size].filter(Boolean).join(" / ")}` : ""}
                      </div>
                    </TableCell>
                    <TableCell className={cn("numeric text-right font-semibold", it.quantity < 0 ? "text-rose-600" : "")}>
                      {it.quantity > 0 ? "+" : ""}
                      {formatNumber(it.quantity)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Money value={it.unitCost} className={it.unitCost ? "" : "text-muted-foreground"} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money value={Math.max(it.quantity, 0) * it.unitCost} className={it.unitCost ? "" : "text-muted-foreground"} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </SectionCard>
        </div>
      ) : null}
    </div>
  );
}

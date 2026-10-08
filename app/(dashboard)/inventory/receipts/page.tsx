import { ArrowDownToLine, ClipboardCheck, Coins, Info, ListOrdered } from "lucide-react";
import Link from "next/link";
import { activeSupplierNames } from "@/lib/queries/suppliers";
import { getDb } from "@/db";
import { productIdsHavingMarketerPrice, receiptPricingModeFor } from "@/lib/inventory/receipt-pricing";
import { PricingModeControl } from "@/app/(dashboard)/inventory/receipts/pricing-mode-control";
import { getBrandCopy } from "@/lib/branding/service";
import { isHomeOrg } from "@/lib/branding/copy";
import { DeleteReceiptButton } from "@/app/(dashboard)/inventory/receipts/delete-receipt-button";
import { ReceiptDialog, type ReceiptPrefillView } from "@/app/(dashboard)/inventory/receipts/receipt-dialog";
import { RECEIPT_PREFILL_PARAM } from "@/lib/constants/production-shortcuts";
import { getPoReceiptPrefill } from "@/lib/queries/production-shortcuts";
import { LinkProductionControl } from "@/app/(dashboard)/inventory/receipts/link-production-control";
import { prefilledOrderId } from "@/lib/constants/evidence-gaps";
import { listLinkableReceipts } from "@/lib/queries/evidence-gaps";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { Money, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can,  } from "@/lib/auth/session";
import { requireResource } from "@/lib/auth/scope-guard";
import { isSalesAgentUser } from "@/lib/constants/saas-nav";
import { ScopeDenied } from "@/components/scope-denied";
import { formatDate, formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { pendingReturnsByVariant } from "@/lib/returns/warehouse";
import { listOpenProductionLinks, listStockReceipts, listVariantsForReceipt, stockReceiptSummary, type StockReceiptRow } from "@/lib/queries/stock";
import { param, type SearchParams } from "@/lib/search-params";
import { STOCK_RECEIPT_KIND_LABEL, type StockReceiptKind } from "@/lib/validation/stock";
import { cn } from "@/lib/utils";

export const metadata = { title: "Nhập hàng & kiểm kê" };

export default async function StockReceiptsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  const { user, decision } = await requireResource("INVENTORY", "products:view");
  // Vỏ Chốt Đơn: câu chữ không «ERP» (khách không thuê ERP) — luật sổ kho không đổi.
  const app = isSalesAgentUser(user) ? "Chốt Đơn" : "ERP";
  // Phạm vi hẹp hơn thứ dữ liệu này biểu diễn được ⇒ TỪ CHỐI và nói rõ, không cho xem hết.
  if (decision.allow === "NONE") return <ScopeDenied title="Phiếu nhập kho" reason={decision.reason} fix={decision.fix} />;
  const canWrite = can(user, "inventory:write");
  const selectedId = param(raw, "receipt");
  // Cách định giá phiếu NHẬP HÀNG (lib/constants/receipt-pricing-mode.ts): nhà luôn giá báo MKT, không truy vấn gì thêm.
  const [pricing, copy] = await Promise.all([getDb().then((db) => receiptPricingModeFor(db, { isHome: isHomeOrg(user) })), getBrandCopy(user)]);
  const khaiGia = pricing.mode === "MANUAL";
  const [receipts, summary, variants, pendingMap, supplierOptions, productionLinks, pricedProductIds] = await Promise.all([
    listStockReceipts(200),
    stockReceiptSummary(),
    canWrite ? listVariantsForReceipt() : Promise.resolve([]),
    canWrite ? pendingReturnsByVariant() : Promise.resolve(new Map<string, number>()),
    canWrite ? activeSupplierNames() : Promise.resolve([] as string[]),
    canWrite ? listOpenProductionLinks() : Promise.resolve([]),
    canWrite && !khaiGia ? getDb().then(productIdsHavingMarketerPrice) : Promise.resolve([] as string[]),
  ]);
  /*
    LỐI TẮT "Nhập kho theo lệnh SX" (Agent SC): `?nhap-lenh=<lệnh>` mở hộp thoại Nhập hàng CÓ SẴN, điền
    xưởng · lệnh · số còn phải nhập. Lệnh không nhập được (chưa gửi / đã đủ / không quyền) ⇒ không mở hộp
    thoại, in lý do. Lệnh luôn có mặt trong ô chọn (danh sách ứng viên chỉ lấy 300 lệnh mới nhất).
  */
  const poParam = param(raw, RECEIPT_PREFILL_PARAM);
  const theoLenh = poParam ? await getPoReceiptPrefill(poParam, canWrite) : null;
  const prefill: ReceiptPrefillView | null =
    theoLenh && theoLenh.state.enabled
      ? {
          poId: theoLenh.po.id,
          poCode: theoLenh.po.code,
          productLabel: theoLenh.po.productLabel,
          supplier: theoLenh.po.supplier,
          reference: theoLenh.po.code,
          qty: Object.fromEntries(theoLenh.prefill.rows.filter((r) => r.remaining > 0).map((r) => [r.variantId, r.remaining])),
          unmapped: theoLenh.prefill.unmapped,
        }
      : null;
  const linkOptions =
    prefill && !productionLinks.some((l) => l.kind === "ORDER" && l.id === prefill.poId)
      ? [{ kind: "ORDER" as const, id: prefill.poId, label: `Lệnh ${prefill.poCode} · ${prefill.productLabel} · ${theoLenh?.po.totalQty ?? "—"} cái`, supplier: prefill.supplier }, ...productionLinks]
      : productionLinks;
  const pendingReturns = Object.fromEntries(pendingMap);
  const pendingReturnTotal = [...pendingMap.values()].reduce((t, n) => t + n, 0);
  /*
    Đơn TẠO TAY rời kho bằng PHIẾU GIAO CÓ KÝ NHẬN ở trang đơn (G-ORDER — ORDER_OUTCOME.md mục 11), KHÔNG bằng phiếu XUẤT
    TAY: lối tắt `?xuat-don=` của bản trước đã bỏ — lập cả hai là trừ tồn hai lần.
  */
  const selected = selectedId ? receipts.find((r) => r.id === selectedId) : null;
  // Phiếu NHẬP HÀNG đang mở mà chưa nối: lệnh SX khớp (Agent P2) — chỉ ĐỀ XUẤT, người bấm nối.
  const linkable = canWrite && selected && selected.kind === "RECEIPT" && !selected.productionOrder && !selected.productionBatch ? ((await listLinkableReceipts({ receiptIds: [selected.id] }))[0] ?? null) : null;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Kho"
        title="Nhập hàng & kiểm kê"
        description={`Sổ kho do shop tự ghi nhận trên ${app} · ${formatNumber(summary.receipts)} phiếu nhập · ${formatNumber(summary.adjustments)} phiếu điều chỉnh${pendingReturnTotal ? ` · ${formatNumber(pendingReturnTotal)} sản phẩm hàng hoàn đang chờ kho nhận` : ""}${summary.lastAt ? ` · gần nhất ${formatDate(summary.lastAt)}` : ""}`}
        actions={
          canWrite ? (
            <>
              <ReceiptDialog variants={variants} defaultKind="ADJUSTMENT" pendingReturns={pendingReturns} pricingMode={pricing.mode} emptyHint={copy.text("receipts.emptyVariants")} />
              <ReceiptDialog variants={variants} defaultKind="RETURN" pendingReturns={pendingReturns} pricingMode={pricing.mode} emptyHint={copy.text("receipts.emptyVariants")} />
              <ReceiptDialog variants={variants} defaultKind="RECEIPT" pendingReturns={pendingReturns} supplierOptions={supplierOptions} productionLinks={linkOptions} pricedProductIds={pricedProductIds} prefill={prefill} pricingMode={pricing.mode} emptyHint={copy.text("receipts.emptyVariants")} />
            </>
          ) : null
        }
      />

      {!isHomeOrg(user) && can(user, "settings:manage") ? <PricingModeControl mode={pricing.mode} source={pricing.source} /> : null}

      {poParam && !prefill ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
          Nhập kho theo lệnh: {theoLenh ? `lệnh ${theoLenh.po.code} — ${theoLenh.state.enabled ? "" : theoLenh.state.reason}` : "không tìm thấy lệnh sản xuất trên đường dẫn"}.
        </p>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Tổng đã nhập" value={`+${formatNumber(summary.received)}`} note={`${formatNumber(summary.receipts)} phiếu nhập hàng`} icon={ArrowDownToLine} tone="green" />
        <MetricCard label="Điều chỉnh kiểm kê" value={`${summary.adjusted > 0 ? "+" : ""}${formatNumber(summary.adjusted)}`} note={`${formatNumber(summary.adjustments)} phiếu điều chỉnh`} icon={ClipboardCheck} tone={summary.adjusted < 0 ? "rose" : "slate"} />
        <MetricCard label="Giá trị hàng nhập" value={formatVND(summary.cost, { compact: true })} note={khaiGia ? "Theo giá ghi trên phiếu — đơn giá khai trên phiếu nhập" : "Theo giá ghi trên phiếu — phiếu nhập mới lấy giá báo MKT"} icon={Coins} tone="primary" />
        <MetricCard label={`Mẫu mã trong ${app}`} value={formatNumber(variants.length || 0)} note={`${formatNumber(variants.filter((v) => v.currentStock <= 0).length)} mẫu mã tồn ≤ 0`} icon={ListOrdered} tone="blue" />
      </section>

      <div className="flex items-start gap-3 rounded-xl border bg-muted/40 p-3.5 text-[13px] text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        <div>
          <b className="text-foreground">Cách dùng lần đầu:</b> bấm <b className="text-foreground">Kiểm kê</b>, nhập số đếm thực tế của từng mẫu mã đang có trong kho → {app} tạo phiếu điều chỉnh để tồn khả dụng bằng đúng số đếm (đã tính hàng đang giao). Từ đó về sau, mỗi lần hàng về thì bấm <b className="text-foreground">Nhập hàng</b>. <b className="text-foreground">Tồn thực tế</b> = tổng phiếu kho − hàng đã xuất; <b className="text-foreground">Khả dụng bán</b> = Tồn thực tế − hàng đã chốt đơn chưa xuất. Hàng hoàn <b className="text-foreground">KHÔNG</b> tự về kho: chỉ khi kho lập phiếu <b className="text-foreground">Tái nhập hàng hoàn</b> với số đếm thực tế — đơn vị vận chuyển báo &ldquo;đã hoàn&rdquo; là chưa đủ. Xem tồn tại <Link href="/products" className="font-semibold text-primary hover:underline">Sản phẩm &amp; tồn kho</Link>.
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
                      {productionLinkLabel(r) ? <div className="truncate text-[10.5px] text-muted-foreground">{productionLinkLabel(r)}</div> : null}
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
            description={[selected.reference, selected.supplier, productionLinkLabel(selected), selected.note].filter(Boolean).join(" · ") || undefined}
            actions={
              <Button asChild variant="ghost" size="sm">
                <Link href="/inventory/receipts">Đóng</Link>
              </Button>
            }
            padded={false}
          >
            {linkable ? (
              <LinkProductionControl
                receiptId={linkable.receiptId}
                candidates={linkable.candidates.map((c) => ({ id: c.id, label: `Lệnh ${c.code}${c.sentAt ? ` · gửi ${formatDate(c.sentAt)}` : ""}` }))}
                prefilled={prefilledOrderId(linkable.candidates, param(raw, "po"))}
              />
            ) : null}
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
                    {/* Dòng NHẬP HÀNG giá 0 = phiếu không ghi đơn giá (mã chưa có giá báo MKT / ô đơn giá bỏ trống) ⇒ CHƯA BIẾT, in "—" chứ không in 0 ₫ (mục 42). */}
                    <TableCell className="text-right">
                      {selected.kind === "RECEIPT" && !it.unitCost ? <span className="text-muted-foreground" title={khaiGia ? "Chưa có giá — ô đơn giá để trống lúc nhập" : "Chưa có giá — mã chưa có giá báo MKT lúc nhập"}>—</span> : <Money value={it.unitCost} className={it.unitCost ? "" : "text-muted-foreground"} />}
                    </TableCell>
                    <TableCell className="text-right">
                      {selected.kind === "RECEIPT" && !it.unitCost ? <span className="text-muted-foreground">—</span> : <Money value={Math.max(it.quantity, 0) * it.unitCost} className={it.unitCost ? "" : "text-muted-foreground"} />}
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

/**
 * Phiếu nhập này là hàng của lệnh SX / lô xưởng nào (0133). `null` = chưa khai — phiếu cũ không
 * được đoán lô (AGENTS.md mục 35), nên không in gì thay vì in một lô đoán.
 */
function productionLinkLabel(r: StockReceiptRow): string | null {
  const parts: string[] = [];
  if (r.productionOrder) parts.push(`Lệnh ${r.productionOrder.code}`);
  if (r.productionBatch) parts.push(`Lô ${r.productionBatch.productCode} #${r.productionBatch.batchNo}`);
  return parts.length ? parts.join(" · ") : null;
}

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Boxes, CircleDollarSign, ExternalLink, Shirt, ShoppingBag, Warehouse } from "lucide-react";
import { ProductSalesChart } from "@/components/charts/product-sales-chart";
import { MetricCard } from "@/components/metric-card";
import { JsonViewer } from "@/components/misc";
import { PageHeader } from "@/components/page-header";
import { OrderStageBadge, ShipmentStageBadge, SourceBadge } from "@/components/status-badge";
import { SyncButton } from "@/components/sync-button";
import { DescriptionList, Money, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { env } from "@/lib/env";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { findProductIdByVariant, getProductDetail } from "@/lib/queries/products";
import { cn } from "@/lib/utils";
import { requirePermission } from "@/lib/auth/session";

export const metadata = { title: "Chi tiết sản phẩm" };

function stockTone(remain: number) {
  if (remain <= 0) return "text-destructive";
  if (remain <= 5) return "text-amber-600 dark:text-amber-400";
  return "";
}

export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("products:view");
  const { id } = await params;
  const product = await getProductDetail(id);
  if (!product) {
    const productId = await findProductIdByVariant(id);
    if (productId) redirect(`/products/${productId}`);
    notFound();
  }
  const { totals, warehouses } = product;
  const statusLabel = product.isRemoved ? "Đã xoá" : product.isHidden ? "Đang ẩn" : "Đang bán";
  const statusTone = product.isRemoved ? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300" : product.isHidden ? "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300" : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300";
  const image = product.image || product.variants.find((v) => v.images[0])?.images[0] || null;
  const pancakeUrl = `https://pos.pancake.vn/shop/${env.pancake.shopId}/products`;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={`Sản phẩm · ${product.customId || (product.displayId ? `#${product.displayId}` : "Pancake")}`}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {product.name}
            <span className={cn("inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold", statusTone)}>{statusLabel}</span>
          </span>
        }
        description={`${product.categories.length ? `${product.categories.join(", ")} · ` : ""}${formatNumber(product.variants.length)} mẫu mã (${formatNumber(totals.selling)} đang bán) · đồng bộ ${formatDateTime(product.syncedAt)}`}
        actions={
          <>
            <SyncButton job="pancake-products" label="Đồng bộ sản phẩm & tồn kho" />
            <Button asChild variant="outline" size="sm">
              <a href={pancakeUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="size-4" /> Mở trên Pancake
              </a>
            </Button>
          </>
        }
      />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Tồn khả dụng" value={formatNumber(totals.remain)} note={`Tồn thực tế ${formatNumber(totals.actual)} · ${formatNumber(product.variants.filter((v) => v.remainQuantity <= 5 && !v.isRemoved).length)} mẫu mã tồn ≤ 5`} icon={Boxes} tone={totals.remain <= 0 ? "rose" : "blue"} />
        <MetricCard label="Giá trị tồn kho" value={formatVND(totals.stockValue, { compact: true })} note="Tồn khả dụng × giá nhập gần nhất" icon={Warehouse} tone="primary" />
        <MetricCard label="Bán 30 ngày" value={formatNumber(totals.sold30)} note={`90 ngày: ${formatNumber(totals.sold90)} sản phẩm · ${formatNumber(totals.orders90)} đơn`} icon={ShoppingBag} tone="green" />
        <MetricCard label="Doanh thu 90 ngày" value={formatVND(totals.revenue90, { compact: true })} note="Tiền hàng lên đơn, không tính đơn huỷ" icon={CircleDollarSign} tone="amber" />
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.9fr)]">
        <div className="space-y-5">
          <SectionCard title="Bán ra theo ngày" description="Số lượng bán trong 30 ngày qua (không tính đơn huỷ/xoá)">
            <ProductSalesChart data={product.daily} />
          </SectionCard>

          <SectionCard title={`Mẫu mã (${formatNumber(product.variants.length)})`} description="Tồn kho theo từng kho · số chờ giao / đang hoàn lấy từ Pancake" padded={false}>
            <div className="overflow-x-auto">
              <Table className="min-w-[760px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Mẫu mã</TableHead>
                    <TableHead className="text-right">Giá bán</TableHead>
                    <TableHead className="text-right">Giá vốn</TableHead>
                    <TableHead className="text-right">Tồn KD</TableHead>
                    <TableHead className="text-right">Tồn TT</TableHead>
                    {warehouses.map((w) => (
                      <TableHead key={w.id} className="text-right">
                        {w.name}
                      </TableHead>
                    ))}
                    <TableHead className="text-right">Bán 30 ngày</TableHead>
                    <TableHead className="text-right">Giá trị tồn</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {product.variants.length ? (
                    product.variants.map((v) => {
                      const hidden = v.isHidden || v.isLocked || v.isRemoved;
                      return (
                        <TableRow key={v.id} className={cn(hidden && "opacity-60")}>
                          <TableCell>
                            <div className="flex items-center gap-3">
                              {v.images[0] || image ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={v.images[0] || image || ""} alt="" className="size-9 shrink-0 rounded-md border object-cover" />
                              ) : (
                                <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground"><Shirt className="size-4" /></span>
                              )}
                              <div className="min-w-0">
                                <p className="font-mono text-xs font-semibold">
                                  {v.sku || "—"}
                                  {hidden ? <span className="ml-2 rounded bg-muted px-1 font-sans text-[10px] font-semibold text-muted-foreground">{v.isRemoved ? "Đã xoá" : v.isLocked ? "Khoá" : "Ẩn"}</span> : null}
                                </p>
                                <p className="text-xs text-muted-foreground">{[v.color, v.size].filter(Boolean).join(" / ") || v.detail || "—"}</p>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-semibold"><Money value={v.retailPrice} /></TableCell>
                          <TableCell className="text-right text-muted-foreground"><Money value={v.lastImportedPrice} /></TableCell>
                          <TableCell className={cn("numeric text-right text-base font-bold", stockTone(v.remainQuantity))}>{formatNumber(v.remainQuantity)}</TableCell>
                          <TableCell className="numeric text-right text-muted-foreground">{formatNumber(v.actualRemainQuantity)}</TableCell>
                          {warehouses.map((w) => {
                            const s = v.stocks.find((x) => x.warehouseId === w.id);
                            return (
                              <TableCell key={w.id} className="text-right">
                                {s ? (
                                  <>
                                    <span className={cn("numeric font-semibold", stockTone(s.remainQuantity))}>{formatNumber(s.remainQuantity)}</span>
                                    {s.pendingQuantity > 0 || s.returningQuantity > 0 ? (
                                      <div className="text-[10.5px] text-muted-foreground">
                                        {s.pendingQuantity > 0 ? `chờ giao ${s.pendingQuantity}` : ""}
                                        {s.pendingQuantity > 0 && s.returningQuantity > 0 ? " · " : ""}
                                        {s.returningQuantity > 0 ? `hoàn ${s.returningQuantity}` : ""}
                                      </div>
                                    ) : null}
                                  </>
                                ) : (
                                  <span className="text-xs text-muted-foreground">—</span>
                                )}
                              </TableCell>
                            );
                          })}
                          <TableCell className={cn("numeric text-right font-semibold", v.sold30 === 0 && "text-muted-foreground")}>{formatNumber(v.sold30)}</TableCell>
                          <TableCell className="text-right text-muted-foreground"><Money value={v.stockValue} /></TableCell>
                        </TableRow>
                      );
                    })
                  ) : (
                    <TableRow>
                      <TableCell colSpan={7 + warehouses.length} className="h-24 text-center text-sm text-muted-foreground">Sản phẩm chưa có mẫu mã.</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-3 text-xs text-muted-foreground">
              <span>Tổng tồn khả dụng <span className="numeric font-semibold text-foreground">{formatNumber(totals.remain)}</span> · thực tế <span className="numeric font-semibold text-foreground">{formatNumber(totals.actual)}</span></span>
              <span>Giá trị tồn <span className="numeric font-semibold text-foreground">{formatVND(totals.stockValue)}</span></span>
            </div>
          </SectionCard>

          <SectionCard title="Đơn hàng gần đây" description="10 đơn mới nhất có chứa sản phẩm này" actions={<Link href={`/orders?q=${encodeURIComponent(product.name)}&period=all`} className="text-xs font-semibold text-primary hover:underline">Tìm trong đơn hàng</Link>} padded={false}>
            {product.recentOrders.length ? (
              <div className="overflow-x-auto">
                <Table className="min-w-[560px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mã đơn</TableHead>
                      <TableHead>Khách hàng · mẫu mã</TableHead>
                      <TableHead>Trạng thái</TableHead>
                      <TableHead className="text-right">Tổng đơn</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {product.recentOrders.map((o) => (
                      <TableRow key={o.id}>
                        <TableCell>
                          <Link href={`/orders/${o.id}`} className="font-bold hover:text-primary hover:underline">#{o.systemId ?? o.id}</Link>
                          <div className="whitespace-nowrap text-[11px] text-muted-foreground">{formatDateTime(o.insertedAt)}</div>
                          <div className="mt-0.5"><SourceBadge source={o.source} className="px-1.5 text-[10px]" /></div>
                        </TableCell>
                        <TableCell className="max-w-[240px]">
                          <div className="truncate font-medium">
                            {o.billFullName || "—"}
                            {o.billPhone ? <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">{o.billPhone}</span> : null}
                          </div>
                          <div className="truncate text-xs text-muted-foreground" title={o.items.map((i) => `${i.variationDetail || i.sku || i.productName} ×${i.quantity}`).join(", ")}>
                            {o.items.map((i) => `${i.variationDetail || i.sku || i.productName} ×${i.quantity}`).join(", ") || "—"}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            <OrderStageBadge stage={o.stage} label={o.statusName || undefined} />
                            {o.shipment ? <div><ShipmentStageBadge stage={o.shipment.stage} className="px-1.5 text-[10px]" /></div> : null}
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-bold"><Money value={o.totalPriceAfterDiscount} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="px-5 py-4 text-sm text-muted-foreground">Chưa có đơn hàng nào chứa sản phẩm này.</p>
            )}
          </SectionCard>
        </div>

        <div className="space-y-5">
          <SectionCard title="Thông tin sản phẩm">
            <div className="space-y-4">
              {image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={image} alt={product.name} className="h-56 w-full rounded-lg border object-cover" />
              ) : (
                <div className="flex h-40 w-full items-center justify-center rounded-lg border bg-muted text-muted-foreground"><Shirt className="size-8" /></div>
              )}
              <DescriptionList
                columns={2}
                items={[
                  { label: "Mã sản phẩm", value: product.customId || "—" },
                  { label: "Mã Pancake", value: <span className="font-mono text-xs">{product.displayId ?? product.id}</span> },
                  { label: "Danh mục", value: product.categories.length ? <span className="flex flex-wrap gap-1">{product.categories.map((c) => <Link key={c} href={`/products?category=${encodeURIComponent(c)}`} className="rounded bg-muted px-1.5 py-0.5 text-xs hover:text-primary">{c}</Link>)}</span> : "—" },
                  { label: "Thẻ", value: product.tags.length ? <span className="flex flex-wrap gap-1">{product.tags.map((t) => <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-xs">{t}</span>)}</span> : "—" },
                  { label: "Trạng thái", value: `${statusLabel}${product.isPublished === false ? " · chưa đăng bán" : ""}` },
                  { label: "Số mẫu mã", value: `${formatNumber(product.variants.length)} (${formatNumber(totals.selling)} đang bán)` },
                  { label: "Tạo trên Pancake", value: formatDateTime(product.insertedAt) },
                  { label: "Đồng bộ lần cuối", value: formatDateTime(product.syncedAt) },
                  { label: "Ghi chú", value: product.note || "—", span: true },
                ]}
              />
            </div>
          </SectionCard>

          <SectionCard title="Nhật ký kho gần đây" description="30 giao dịch mới nhất của các mẫu mã" actions={<Link href={`/inventory?q=${encodeURIComponent(product.name)}&period=all`} className="text-xs font-semibold text-primary hover:underline">Xem tất cả</Link>} padded={false}>
            {product.histories.length ? (
              <ul className="max-h-[520px] divide-y overflow-y-auto">
                {product.histories.map((h) => (
                  <li key={h.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                    <span className={cn("numeric w-12 shrink-0 text-right font-bold", h.quantity > 0 ? "text-success" : h.quantity < 0 ? "text-destructive" : "text-muted-foreground")}>{h.quantity > 0 ? `+${formatNumber(h.quantity)}` : formatNumber(h.quantity)}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">
                        <span className="font-mono">{h.variant?.sku || "—"}</span>
                        {h.variant?.color || h.variant?.size ? <span className="ml-1.5 text-muted-foreground">{[h.variant.color, h.variant.size].filter(Boolean).join(" / ")}</span> : null}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {h.type || h.tableName || "—"}
                        {h.warehouse ? ` · ${h.warehouse.name}` : ""}
                        {h.editorName ? ` · ${h.editorName}` : ""}
                      </p>
                    </div>
                    <div className="shrink-0 text-right text-[11px] text-muted-foreground">
                      <p>{formatDateTime(h.insertedAt)}</p>
                      <p>tồn sau <span className="numeric font-semibold text-foreground">{formatNumber(h.remainQuantity)}</span></p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-4 text-sm text-muted-foreground">Chưa có nhật ký kho cho sản phẩm này. Bấm “Đồng bộ nhật ký kho” ở trang Nhật ký kho.</p>
            )}
          </SectionCard>

          <JsonViewer value={product.raw ?? { id: product.id, name: product.name, customId: product.customId, categories: product.categories, variants: product.variants.map((v) => v.raw ?? { id: v.id, sku: v.sku }) }} />
        </div>
      </div>
    </div>
  );
}

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AlertTriangle, Boxes, ExternalLink, Shirt, ShoppingBag, Warehouse } from "lucide-react";
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
import { findProductIdByVariant, getProductDetail, type ProductDetail } from "@/lib/queries/products";
import { getProductMatrix } from "@/lib/queries/product-intelligence";
import { PLAN_STATUS_LABEL, PLAN_STATUS_TONE, type PlanStatus } from "@/lib/constants/planning";
import { successTone } from "@/lib/constants/returns";
import { resolvePeriod } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { can, requirePermission } from "@/lib/auth/session";
import { ProductNotes } from "@/app/(dashboard)/products/[id]/product-notes";
import { listProductNotes } from "@/lib/queries/product-notes";

export const metadata = { title: "Chi tiết sản phẩm" };

/** Ngày dạng YYYY-MM-DD (hạn đặt hàng của `computePlan`) → dd/mm/yyyy. */
function fmtDateKey(key: string | null) {
  if (!key) return "—";
  const [y, m, d] = key.split("-");
  return `${d}/${m}/${y}`;
}

/** Hạn đặt đã qua: in "đã quá hạn đặt", không giấu (xem `reorderByDate`). */
function isPast(key: string) {
  return new Date(`${key}T00:00:00Z`).getTime() < Date.now();
}

export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("products:view");
  const { id } = await params;
  const product = await getProductDetail(id);
  if (!product) {
    const productId = await findProductIdByVariant(id);
    if (productId) redirect(`/products/${productId}`);
    notFound();
  }
  const { totals } = product;
  // Ma trận Màu × Size — chỉ dựng khi mã hàng thật sự có nhiều màu/size, mã một biến thể thì rối.
  const matrixPeriod = resolvePeriod({}, "90d");
  const [matrix, ghiChu] = await Promise.all([getProductMatrix(id, matrixPeriod), listProductNotes(id)]);
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

      {/*
        Ba thẻ đầu đọc SỔ KHO ERP (nhập − đã xuất qua ĐVVC), không đọc Pancake. Thẻ thứ ba là cái
        nhân viên đặt hàng cần: thiếu bao nhiêu, phải đặt bao nhiêu, hạn chót ngày nào.
      */}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Nhập / đã xuất"
          value={`${formatNumber(totals.receiptIn)} / ${formatNumber(totals.shipped)}`}
          note={[
            `Nhập mới ${formatNumber(totals.receiptIn)}`,
            totals.returnIn ? `tái nhập hoàn ${formatNumber(totals.returnIn)}` : null,
            totals.adjust ? `điều chỉnh ${totals.adjust > 0 ? "+" : ""}${formatNumber(totals.adjust)}` : null,
            totals.manualOut ? `xuất tay ${formatNumber(totals.manualOut)}` : null,
            `xuất qua ĐVVC ${formatNumber(totals.shipped)}`,
          ].filter(Boolean).join(" · ")}
          icon={Warehouse}
          tone="primary"
        />
        <MetricCard
          label="Tồn thực tế (sổ kho)"
          value={formatNumber(totals.actual)}
          note={`Chờ xuất ${formatNumber(totals.committed)} · khả dụng ${formatNumber(totals.available)} · giá trị ${formatVND(totals.stockValue, { compact: true })}${totals.unknownStock ? ` · ${formatNumber(totals.unknownStock)} mẫu mã chưa có phiếu nhập, không cộng vào` : ""}`}
          icon={Boxes}
          tone={totals.available <= 0 ? "rose" : "blue"}
        />
        <MetricCard
          label="Còn thiếu / cần đặt"
          value={totals.needOrder || totals.shortage ? `${formatNumber(totals.shortage)} / ${formatNumber(totals.suggested)}` : "Đủ hàng"}
          note={
            totals.needOrder || totals.shortage
              ? `${formatNumber(totals.needOrder)} mẫu mã cần đặt${totals.reorderBy ? ` · ${isPast(totals.reorderBy) ? "đã quá hạn đặt" : "đặt trước"} ${fmtDateKey(totals.reorderBy)}` : ""}${totals.orderCost ? ` · ${formatVND(totals.orderCost, { compact: true })}` : ""}`
              : totals.unknownStock
                ? `${formatNumber(totals.unknownStock)} mẫu mã chưa tính được — cần lập phiếu nhập`
                : "Không mẫu mã nào hết trước khi lô mới kịp về"
          }
          icon={AlertTriangle}
          tone={totals.shortage > 0 || (totals.reorderBy && isPast(totals.reorderBy)) ? "rose" : totals.needOrder ? "amber" : "green"}
        />
        <MetricCard label="Bán 30 ngày" value={formatNumber(totals.sold30)} note={`90 ngày: ${formatNumber(totals.sold90)} sp · ${formatNumber(totals.orders90)} đơn · ${formatVND(totals.revenue90, { compact: true })} tiền hàng (không tính đơn huỷ)`} icon={ShoppingBag} tone="green" />
      </section>

      <VariantStockSection product={product} />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.9fr)]">
        <div className="space-y-5">
          <SectionCard title="Bán ra theo ngày" description="Số lượng bán trong 30 ngày qua (không tính đơn huỷ/xoá)">
            <ProductSalesChart data={product.daily} />
          </SectionCard>

          {matrix ? (
            <SectionCard
              title="Hiệu quả theo Màu × Size"
              description={`${matrixPeriod.label} · mỗi ô: số giao thành công / tỷ lệ GTC / số ngày còn đủ hàng`}
              hint="Xếp theo KẾT QUẢ THẬT, không theo số lên đơn: một mẫu mã bán nhiều mà hoàn nhiều thì kém hơn hẳn mẫu mã bán ít mà hoàn ít. Ô trống nghĩa là mẫu mã đó không bán được cái nào trong kỳ."
              padded={false}
            >
              <div className="overflow-x-auto">
                <Table className="min-w-[520px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Màu \ Size</TableHead>
                      {matrix.sizes.map((size) => (
                        <TableHead key={size} className="text-center">{size}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {matrix.colors.map((color) => (
                      <TableRow key={color}>
                        <TableCell className="font-medium whitespace-nowrap">{color}</TableCell>
                        {matrix.sizes.map((size) => {
                          const cell = matrix.cells[color]?.[size];
                          if (!cell) return <TableCell key={size} className="text-center text-xs text-muted-foreground">—</TableCell>;
                          return (
                            <TableCell key={size} className="text-center">
                              <span className="numeric block text-sm font-semibold">{formatNumber(cell.deliveredQty)}</span>
                              <span className={cn("block text-[11px]", successTone(cell.successRate))}>
                                {cell.successRate === null ? "chưa kết thúc" : `${cell.successRate}%`}
                              </span>
                              <span className="block text-[11px] text-muted-foreground">
                                {cell.daysOfCover === null ? (cell.available === null ? "chưa có phiếu nhập" : "—") : `còn ${cell.daysOfCover} ngày`}
                              </span>
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </SectionCard>
          ) : null}

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
                  {
                    label: "Ghi chú từ Pancake",
                    // Cột này ĐỒNG BỘ TỪ PANCAKE và bị ghi đè ở mỗi lần đồng bộ. Nói thẳng điều đó
                    // ra, nếu không người dùng sẽ đi tìm chỗ sửa nó và không bao giờ thấy.
                    value: product.note ? <span className="text-muted-foreground">{product.note}</span> : <span className="text-muted-foreground">— (ô này đồng bộ từ Pancake, không sửa được ở ERP)</span>,
                    span: true,
                  },
                ]}
              />
            </div>
          </SectionCard>

          {/*
            GHI CHÚ VẬN HÀNH — đường ghi thật, khác hẳn ô "Ghi chú từ Pancake" ở trên.

            Ô kia đồng bộ từ Pancake và bị ghi đè mỗi lần đồng bộ; nó hiện ra nhưng không ai trong
            shop viết vào được. Khối này ghi vào bảng riêng, mỗi dòng mang khoá tài khoản người
            viết và mốc thời gian, và KHÔNG con số nào của ERP đọc nó.
          */}
          <SectionCard
            title="Ghi chú vận hành"
            description={ghiChu.length ? `${formatNumber(ghiChu.length)} ghi chú · mới nhất trước` : "Điều cần nhớ về mã hàng này mà không con số nào nói ra"}
            hint="Bối cảnh cho người đọc: vì sao lô này hay bị đổi, size nào khách kêu chật, xưởng nào giao chậm. Ghi chú KHÔNG tham gia vào tồn kho, giá vốn hay bất kỳ báo cáo nào."
          >
            <ProductNotes
              productId={product.id}
              canWrite={can(user, "inventory:write")}
              variants={product.variants.map((v) => ({ id: v.id, sku: v.sku }))}
              notes={ghiChu.map((x) => ({
                id: x.id,
                variantSku: x.variantSku,
                category: x.category,
                body: x.body,
                actorUserId: x.actorUserId,
                actorName: x.actorName,
                createdAt: x.createdAt.toISOString(),
              }))}
            />
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

type VariantRow = ProductDetail["variants"][number];

/**
 * Tình trạng in ra cho một mẫu mã — đúng `status` của `computePlan`, trừ hai trường hợp:
 * mẫu mã đứng yên (tồn 0, không bán, không đơn chờ) in "Không bán" chứ không in "Hết hàng" — cùng
 * luật `isPlanRowActive` mà trang Kế hoạch SX dùng để bỏ chúng khỏi danh sách; và mẫu mã ĐÃ XOÁ
 * không còn hàng thì không có tình trạng nào để báo.
 */
function variantStatus(v: VariantRow): PlanStatus | null {
  if (!v.ledger) return null;
  if (v.isRemoved && !v.erpStock && !v.ledger.committed) return null;
  return v.active ? v.ledger.status : "IDLE";
}

/**
 * TỒN KHO THEO MẪU MÃ — sổ kho ERP + cảnh báo đặt hàng, đặt NGOÀI lưới hai cột để bảng dùng hết
 * chiều ngang (~1.150px) mà không phải kéo ngang.
 *
 *   Nhập (phiếu kho) − Đã xuất qua ĐVVC = Tồn thực tế
 *   Tồn thực tế − Chờ xuất (đã chốt đơn, còn trong kho) = Khả dụng
 *   Còn thiếu = max(0, −Khả dụng) — đơn đã hứa khách mà kho không đủ hàng để xuất
 *   Cần đặt / hạn đặt = `computePlan`, cùng bộ máy với trang Kế hoạch SX
 */
function VariantStockSection({ product }: { product: ProductDetail }) {
  const { totals, warehouses } = product;
  const a = product.planning.assumptions;
  const image = product.image || product.variants.find((v) => v.images[0])?.images[0] || null;
  const warehouseName = new Map(warehouses.map((w) => [w.id, w.name]));
  return (
    <SectionCard
      title={`Tồn kho theo mẫu mã (${formatNumber(product.variants.length)})`}
      description="Sổ kho ERP: nhập theo phiếu kho, xuất theo vận đơn Viettel Post — số Pancake chỉ để đối chiếu"
      hint={
        <>
          <b>Tồn thực tế</b> = tổng phiếu kho (nhập mới + tái nhập hàng hoàn + điều chỉnh − xuất tay) − số đã rời kho qua ĐVVC. Hàng hoàn chỉ quay lại tồn khi kho lập phiếu tái nhập với số đếm thực tế.{" "}
          <b>Khả dụng</b> = tồn thực tế − hàng đã chốt đơn còn nằm trong kho chờ xuất. <b>Còn thiếu</b> = số đã hứa khách mà kho không đủ hàng để xuất.{" "}
          <b>Cần đặt</b> tính như trang Kế hoạch SX: tốc độ bán {a.velocityWindowDays} ngày × (thời gian sản xuất {a.leadTimeDays} ngày + muốn đủ bán {a.coverDays} ngày) + tồn an toàn {a.safetyDays} ngày − (khả dụng + hàng sắp hoàn về kho).
          Mẫu mã chưa có phiếu nhập thì tồn là CHƯA BIẾT, không phải 0.
        </>
      }
      actions={
        <>
          <Link href="/inventory/receipts" className="text-xs font-semibold text-primary hover:underline">Lập phiếu nhập</Link>
          <Link href="/inventory/planning" className="text-xs font-semibold text-primary hover:underline">Kế hoạch SX</Link>
        </>
      }
      padded={false}
    >
      <div className="overflow-x-auto">
        <Table className="min-w-[1040px]">
          <TableHeader>
            <TableRow>
              <TableHead>Mẫu mã</TableHead>
              <TableHead className="text-right">Giá bán · vốn · trị giá tồn</TableHead>
              <TableHead className="text-right">Nhập kho</TableHead>
              <TableHead className="text-right">Đã xuất</TableHead>
              <TableHead className="text-right">Tồn thực tế</TableHead>
              <TableHead className="text-right">Chờ xuất</TableHead>
              <TableHead className="text-right">Khả dụng</TableHead>
              <TableHead className="text-right">Còn thiếu</TableHead>
              <TableHead>Cảnh báo đặt hàng</TableHead>
              <TableHead className="text-right" title="Không tính đơn huỷ, đơn hoàn, hàng tặng — đúng số trang Kế hoạch SX dùng">Bán ròng 30n</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {product.variants.length ? (
              product.variants.map((v) => {
                const hidden = v.isHidden || v.isLocked || v.isRemoved;
                const l = v.ledger;
                const status = variantStatus(v);
                const pancakeTitle = v.stocks.length
                  ? v.stocks.map((s) => `${warehouseName.get(s.warehouseId) ?? s.warehouse?.name ?? "Kho"}: tồn ${s.remainQuantity}${s.pendingQuantity ? ` · chờ giao ${s.pendingQuantity}` : ""}${s.returningQuantity ? ` · đang hoàn ${s.returningQuantity}` : ""}`).join("\n")
                  : "Pancake chưa có tồn theo kho cho mẫu mã này";
                return (
                  <TableRow key={v.id} className={cn(hidden && "opacity-60", status === "OUT" && "bg-rose-50/40 dark:bg-rose-950/10", status === "CRITICAL" && "bg-orange-50/40 dark:bg-orange-950/10")}>
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
                    <TableCell className="text-right">
                      <Money value={v.retailPrice} className="font-semibold" />
                      <div className="text-[11px] text-muted-foreground">vốn <Money value={l?.unitCost ?? v.lastImportedPrice} /></div>
                      <div className="text-[11px] text-muted-foreground" title="Tồn thực tế ERP × giá vốn">tồn {v.erpStock === null ? "—" : <Money value={v.stockValue} />}</div>
                    </TableCell>
                    {/* NHẬP: phiếu nhập hàng mới là số chính; tái nhập / điều chỉnh / xuất tay là các vế còn lại của tổng phiếu kho. */}
                    <TableCell className="numeric text-right" title={l ? `${formatNumber(l.receiptDocs)} phiếu nhập hàng · tổng ròng mọi phiếu kho ${formatNumber(l.received)}` : undefined}>
                      {l && l.receiptDocs > 0 ? <span className="font-semibold">{formatNumber(l.receiptIn)}</span> : <span className="text-xs text-muted-foreground" title="Chưa có phiếu nhập hàng nào trong ERP — không phải nhập 0 cái">—</span>}
                      {l?.returnIn ? <div className="text-[10.5px] text-muted-foreground">+{formatNumber(l.returnIn)} hoàn về</div> : null}
                      {l?.adjust ? <div className="text-[10.5px] text-muted-foreground">{l.adjust > 0 ? "+" : ""}{formatNumber(l.adjust)} kiểm kê</div> : null}
                      {l?.manualOut ? <div className="text-[10.5px] text-muted-foreground">−{formatNumber(l.manualOut)} xuất tay</div> : null}
                    </TableCell>
                    {/* ĐÃ XUẤT: hàng rời kho theo xác nhận lấy hàng của Viettel Post — không theo tiền, không theo Pancake. */}
                    <TableCell className="numeric text-right">
                      <span className="font-semibold">{formatNumber(l?.shipped ?? null)}</span>
                      {l?.inTransit ? <div className="text-[10.5px] text-muted-foreground" title="Đã rời kho, vận đơn chưa kết thúc">đang đi {formatNumber(l.inTransit)}</div> : null}
                      {l?.awaitingReturn ? <div className="text-[10.5px] text-muted-foreground" title="Đã xác định hoàn, kho chưa lập phiếu tái nhập — chưa cộng lại vào tồn">chờ hoàn {formatNumber(l.awaitingReturn)}</div> : null}
                    </TableCell>
                    <TableCell className="numeric text-right">
                      {v.erpStock === null ? (
                        <span className="inline-block text-[11px] leading-tight whitespace-normal text-muted-foreground">Chưa có<br />phiếu nhập</span>
                      ) : (
                        <span className={cn("text-base font-bold", v.erpStock < 0 && "text-destructive")}>{formatNumber(v.erpStock)}</span>
                      )}
                      <div className={cn("text-[10.5px] text-muted-foreground", v.erpStock !== null && v.remainQuantity !== v.erpStock && "text-amber-700 dark:text-amber-400")} title={pancakeTitle}>
                        Pancake {formatNumber(v.remainQuantity)}
                      </div>
                    </TableCell>
                    <TableCell className={cn("numeric text-right", !l?.committed && "text-muted-foreground")}>{formatNumber(l?.committed ?? null)}</TableCell>
                    <TableCell className={cn("numeric text-right font-semibold", v.available !== null && v.available <= 0 && "text-destructive")}>{formatNumber(v.available)}</TableCell>
                    <TableCell className="numeric text-right">
                      {v.shortage === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : v.shortage > 0 ? (
                        <span className="font-bold text-destructive" title="Đơn đã chốt mà kho không đủ hàng để xuất">{formatNumber(v.shortage)}</span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                    <TableCell className="w-[200px] min-w-[200px] text-xs whitespace-normal">
                      {status ? <span className={cn("inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold", PLAN_STATUS_TONE[status])}>{status === "UNKNOWN" ? "Chưa có phiếu nhập" : PLAN_STATUS_LABEL[status]}</span> : <span className="text-muted-foreground">—</span>}
                      {l && l.suggested > 0 ? (
                        <div className="mt-0.5">
                          <span className="font-bold" title={l.moqApplied ? `Nhu cầu thật là ${formatNumber(l.suggestedBeforeMoq)}, nâng lên vì xưởng nhận từ ${formatNumber(l.suggested)} cái` : undefined}>
                            Đặt {formatNumber(l.suggested)}
                            {l.moqApplied ? <span className="ml-0.5 font-normal text-muted-foreground">(tối thiểu)</span> : null}
                          </span>
                          {l.reorderByDate ? (
                            <span className={cn(" ml-1", isPast(l.reorderByDate) ? "font-semibold text-rose-600 dark:text-rose-400" : "text-muted-foreground")} title={`Phải đặt trước ngày này để lô mới về kịp (thời gian sản xuất ${l.leadTimeDays} ngày)`}>
                              {isPast(l.reorderByDate) ? "· đã quá hạn " : "· trước "}
                              {fmtDateKey(l.reorderByDate)}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                      {l && l.stockKnown && l.velocity > 0 ? (
                        <div className="text-[10.5px] text-muted-foreground" title={l.velocityTrimmed ? `Đã bỏ một ngày đột biến (${formatNumber(l.peakDayQty)} cái) khỏi tốc độ bán` : undefined}>
                          bán {l.velocity.toFixed(1).replace(".", ",")}/ngày{l.velocityTrimmed ? "*" : ""}
                          {l.daysOfCover !== null ? ` · còn ${formatNumber(Math.floor(l.daysOfCover))} ngày` : ""}
                          {l.incoming ? <span className="block" title="Ước lượng hàng quay lại kho (chờ hoàn + phần đang đi ước bị hoàn), đã trừ khỏi số cần đặt">+{formatNumber(l.incoming)} sắp hoàn về kho</span> : null}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className={cn("numeric text-right font-semibold", !l?.sold30 && "text-muted-foreground")}>{formatNumber(l?.sold30 ?? null)}</TableCell>
                  </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell colSpan={10} className="h-24 text-center text-sm text-muted-foreground">Sản phẩm chưa có mẫu mã.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-3 text-xs text-muted-foreground">
        <span>
          Nhập <span className="numeric font-semibold text-foreground">{formatNumber(totals.receiptIn)}</span>
          {" · "}đã xuất <span className="numeric font-semibold text-foreground">{formatNumber(totals.shipped)}</span>
          {" · "}tồn thực tế <span className="numeric font-semibold text-foreground">{formatNumber(totals.actual)}</span>
          {" · "}khả dụng <span className="numeric font-semibold text-foreground">{formatNumber(totals.available)}</span>
          {" · "}còn thiếu <span className={cn("numeric font-semibold", totals.shortage > 0 ? "text-destructive" : "text-foreground")}>{formatNumber(totals.shortage)}</span>
          {" · "}cần đặt <span className="numeric font-semibold text-foreground">{formatNumber(totals.suggested)}</span>
          {totals.unknownStock ? <> · <span className="font-semibold text-foreground">{formatNumber(totals.unknownStock)}</span> mẫu mã chưa có phiếu nhập (không cộng vào tổng)</> : null}
        </span>
        <span>
          Giá trị tồn <span className="numeric font-semibold text-foreground">{formatVND(totals.stockValue)}</span> · Pancake ghi tồn {formatNumber(totals.pancakeRemain)} (đối chiếu)
        </span>
      </div>
    </SectionCard>
  );
}

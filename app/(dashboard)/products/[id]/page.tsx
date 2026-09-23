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
import { explainPlan, fmtDateKey, type PlanExplanation } from "@/lib/constants/plan-explain";
import { DELIVERY_RATE_SOURCE_LABEL } from "@/lib/constants/delivery-rate";
import { STOCK_RECEIPT_KIND_LABEL, type StockReceiptKind } from "@/lib/validation/stock";
import { successTone } from "@/lib/constants/returns";
import { resolvePeriod } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { can, requirePermission } from "@/lib/auth/session";
import { ProductNotes } from "@/app/(dashboard)/products/[id]/product-notes";
import { listProductNotes } from "@/lib/queries/product-notes";

export const metadata = { title: "Chi tiết sản phẩm" };

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
            <SyncButton job="pancake-products" label="Đồng bộ sản phẩm từ Pancake" />
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
          // "Đủ hàng" chỉ khi KHÔNG còn gì chưa biết: đơn chờ xuất trên mẫu mã chưa có phiếu nhập thì
          // ERP không biết đủ hay thiếu — in "—" và nói ra số đó, không in "Đủ hàng".
          value={totals.needOrder || totals.shortage ? `${formatNumber(totals.shortage)} / ${formatNumber(totals.suggested)}` : totals.committedUnknown ? "—" : "Đủ hàng"}
          note={
            [
              totals.needOrder || totals.shortage
                ? `${formatNumber(totals.needOrder)} mẫu mã cần đặt${totals.reorderBy ? ` · ${isPast(totals.reorderBy) ? "đã quá hạn đặt" : "đặt trước"} ${fmtDateKey(totals.reorderBy)}` : ""}${totals.orderCost ? ` · ${formatVND(totals.orderCost, { compact: true })}` : ""}`
                : null,
              totals.committedUnknown
                ? `${formatNumber(totals.committedUnknown)} cái chờ xuất trên mẫu mã chưa có phiếu nhập — chưa biết đủ hay thiếu`
                : totals.unknownStock
                  ? `${formatNumber(totals.unknownStock)} mẫu mã chưa tính được — cần lập phiếu nhập`
                  : null,
            ].filter(Boolean).join(" · ") || "Không mẫu mã nào hết trước khi lô mới kịp về"
          }
          icon={AlertTriangle}
          tone={totals.shortage > 0 || (totals.reorderBy && isPast(totals.reorderBy)) ? "rose" : totals.needOrder || totals.committedUnknown ? "amber" : "green"}
        />
        <MetricCard label="Bán 30 ngày" value={formatNumber(totals.sold30)} note={`90 ngày: ${formatNumber(totals.sold90)} sp · ${formatNumber(totals.orders90)} đơn · ${formatVND(totals.revenue90, { compact: true })} tiền hàng (không tính đơn huỷ)`} icon={ShoppingBag} tone="green" />
      </section>

      <VariantStockSection product={product} />

      <OrderAdviceSection product={product} />

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

          {/*
            PHIẾU KHO ERP — chứng từ đứng sau cột "Nhập kho". Trước đây chỗ này in nhật ký tồn của
            Pancake kèm "tồn sau", mà tồn Pancake âm ở cả 12/12 mẫu mã của Q005 (đo 23/09/2026).
          */}
          <SectionCard title="Phiếu kho gần đây" description="30 dòng phiếu kho mới nhất của các mẫu mã — nguồn của số Nhập kho" actions={<Link href="/inventory/receipts" className="text-xs font-semibold text-primary hover:underline">Nhập hàng & kiểm kê</Link>} padded={false}>
            {product.receiptLog.length ? (
              <ul className="max-h-[520px] divide-y overflow-y-auto">
                {product.receiptLog.map((h) => (
                  <li key={h.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                    <span className={cn("numeric w-12 shrink-0 text-right font-bold", h.quantity > 0 ? "text-success" : h.quantity < 0 ? "text-destructive" : "text-muted-foreground")}>{h.quantity > 0 ? `+${formatNumber(h.quantity)}` : formatNumber(h.quantity)}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">
                        <span className="font-mono">{h.sku || "—"}</span>
                        {h.color || h.size ? <span className="ml-1.5 text-muted-foreground">{[h.color, h.size].filter(Boolean).join(" / ")}</span> : null}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {STOCK_RECEIPT_KIND_LABEL[h.kind as StockReceiptKind] ?? h.kind}
                        {h.reference ? ` · ${h.reference}` : ""}
                        {h.supplier ? ` · ${h.supplier}` : ""}
                        {h.createdBy ? ` · ${h.createdBy}` : ""}
                      </p>
                    </div>
                    <div className="shrink-0 text-right text-[11px] text-muted-foreground">
                      <p>{formatDateTime(h.receivedAt)}</p>
                      {h.unitCost ? <p>giá nhập <Money value={h.unitCost} /></p> : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-4 text-sm text-muted-foreground">Chưa có phiếu kho nào cho mã hàng này — tồn kho chưa tính được. Lập phiếu nhập ở trang Nhập hàng & kiểm kê.</p>
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
  const { totals } = product;
  const a = product.planning.assumptions;
  const image = product.image || product.variants.find((v) => v.images[0])?.images[0] || null;
  return (
    <SectionCard
      title={`Tồn kho theo mẫu mã (${formatNumber(product.variants.length)})`}
      description="Sổ kho ERP: nhập theo phiếu kho, xuất theo vận đơn Viettel Post"
      hint={
        <>
          <b>Tồn thực tế</b> = tổng phiếu kho (nhập mới + tái nhập hàng hoàn + điều chỉnh − xuất tay) − số đã rời kho qua ĐVVC. Hàng hoàn chỉ quay lại tồn khi kho lập phiếu tái nhập với số đếm thực tế.{" "}
          <b>Khả dụng</b> = tồn thực tế − hàng đã chốt đơn còn nằm trong kho chờ xuất. <b>Còn thiếu</b> = số đã hứa khách mà kho không đủ hàng để xuất.{" "}
          <b>Cần đặt</b> tính như trang Kế hoạch SX, diễn giải từng bước ở khối “Đề xuất đặt hàng” bên dưới: tốc độ gửi đi {a.velocityWindowDays} ngày × (sản xuất {a.leadTimeDays} + đủ bán {a.coverDays} + an toàn {a.safetyDays} ngày) − hàng hoàn về kịp bán lại (theo GTC của mã) − (khả dụng + hàng hoàn đang về).
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
                      {l && !l.stockKnown && l.committed > 0 ? (
                        <div className="mt-0.5 font-semibold text-amber-700 dark:text-amber-400" title="Đơn đã chốt đang chờ xuất, nhưng ERP chưa có phiếu nhập nào của mẫu mã này nên không biết kho có đủ hàng không">
                          {formatNumber(l.committed)} cái chờ xuất — lập phiếu nhập để biết đủ hay thiếu
                        </div>
                      ) : null}
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
          {totals.unknownStock ? <> · <span className="font-semibold text-foreground">{formatNumber(totals.unknownStock)}</span> mẫu mã chưa có phiếu nhập (không cộng vào tổng){totals.committedUnknown ? <>, đang có <span className="font-semibold text-amber-700 dark:text-amber-400">{formatNumber(totals.committedUnknown)}</span> cái chờ xuất</> : null}</> : null}
        </span>
        <span>
          Giá trị tồn <span className="numeric font-semibold text-foreground">{formatVND(totals.stockValue)}</span>
        </span>
      </div>
    </SectionCard>
  );
}

type AdviceItem = { v: VariantRow; e: PlanExplanation };

/**
 * ĐỀ XUẤT ĐẶT HÀNG — mỗi số đặt kèm LỜI GIẢI từng bước và các KỊCH BẢN, để người đặt hàng thấy số
 * đó từ đâu ra và sai giả định nào thì đổi bao nhiêu (chủ shop yêu cầu 23/09/2026).
 *
 * Không có phép tính nào ở đây: số đặt là `computePlan`, lời giải là `explainPlan` đọc lại chính
 * đầu vào + đầu ra ấy, nên khối này không thể nói một con số khác với bảng phía trên hay với trang
 * Kế hoạch SX.
 *
 * Chỉ liệt kê mẫu mã CÓ VIỆC: sẽ hết / đang thiếu / sắp thiếu, hoặc chưa có phiếu nhập mà đang có
 * đơn chờ xuất. Mẫu mã đủ hàng không cần lời giải — nó chỉ làm loãng những dòng cần quyết định.
 */
function OrderAdviceSection({ product }: { product: ProductDetail }) {
  const used = product.planning.used;
  const items: AdviceItem[] = product.variants
    .filter((v) => {
      const l = v.ledger;
      if (!l || v.isRemoved) return false;
      if (!l.stockKnown) return l.committed > 0;
      return v.active && (l.suggested > 0 || l.status === "OUT" || l.status === "CRITICAL" || l.status === "LOW");
    })
    .map((v) => {
      const l = v.ledger!;
      return { v, e: explainPlan(l.input, l, { deliveryRate: l.deliveryRate, deliverySource: l.deliverySource, vtpReturnLagDays: l.vtpReturnLagDays, restockDays: used.restockDays }) };
    })
    .sort((x, y) => Number(y.e.known) - Number(x.e.known) || (y.v.ledger?.suggested ?? 0) - (x.v.ledger?.suggested ?? 0));
  const first = product.variants.find((v) => v.ledger)?.ledger ?? null;
  const tongDat = items.reduce((t, x) => t + (x.v.ledger?.suggested ?? 0), 0);
  const tongTien = items.reduce((t, x) => t + (x.v.ledger?.orderCost ?? 0), 0);
  return (
    <SectionCard
      id="de-xuat-dat-hang"
      title="Đề xuất đặt hàng"
      description={
        items.length
          ? `${formatNumber(items.length)} mẫu mã cần quyết định · đề xuất tổng ${formatNumber(tongDat)} cái${tongTien ? ` · ${formatVND(tongTien, { compact: true })} theo giá nhập gần nhất` : ""}`
          : "Không mẫu mã nào cần đặt lúc này"
      }
      hint={
        <>
          <b>Cần có</b> = tốc độ gửi đi × (sản xuất + đủ bán + an toàn) − hàng hoàn của CHÍNH các đơn ấy về kịp bán lại. <b>Đặt</b> = cần có − (khả dụng + hàng hoàn đang về). Tốc độ gửi đi tính trên đơn đã chốt (không huỷ), gồm cả đơn đang giao và đơn đã hoàn — phần quay về được trừ tường minh theo <b>tỷ lệ giao thành công của mã</b> (cùng thang bậc với Báo cáo lợi nhuận) và tỷ lệ hàng hoàn bán lại được. Hàng hoàn chỉ tính là về kịp nếu đơn gửi đi trước khi hết kỳ ít nhất <b>độ trễ hoàn</b> = ĐVVC trả về ({used.vtpReturnLagDays === null ? "chưa đo được" : `${formatNumber(used.vtpReturnLagDays)} ngày, đo`}) + kho tái nhập ({formatNumber(used.restockDays)} ngày, Giả định ở trang Kế hoạch SX).
        </>
      }
      actions={<Link href="/inventory/planning" className="text-xs font-semibold text-primary hover:underline">Sửa giả định</Link>}
      padded={false}
    >
      {first ? (
        <p className="border-b px-5 py-2.5 text-xs text-muted-foreground">
          Căn cứ chung của mã: <b className="text-foreground">GTC {formatNumber(first.deliveryRate)}%</b> ({DELIVERY_RATE_SOURCE_LABEL[first.deliverySource].toLowerCase()}) · hàng hoàn bán lại được <b className="text-foreground">{formatNumber(Math.round((first.input.returnRecoveryRate ?? 1) * 1000) / 10)}%</b> · độ trễ hoàn <b className="text-foreground">{first.input.returnLagDays === null || first.input.returnLagDays === undefined ? "chưa đo được" : `${formatNumber(first.input.returnLagDays)} ngày`}</b> · sản xuất {formatNumber(first.leadTimeDays)} ngày · đủ bán {formatNumber(first.input.coverDays)} ngày · an toàn {formatNumber(first.input.safetyDays)} ngày
        </p>
      ) : null}
      {items.length ? (
        <div className="divide-y">
          {items.map(({ v, e }, idx) => {
            const l = v.ledger!;
            const status = e.known ? l.status : "UNKNOWN";
            return (
              <details key={v.id} open={idx < 3} className="group px-5 py-3">
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="w-40 shrink-0">
                    <span className="block font-mono text-xs font-semibold">{v.sku || "—"}</span>
                    <span className="block text-xs text-muted-foreground">{[v.color, v.size].filter(Boolean).join(" / ") || v.detail || "—"}</span>
                  </span>
                  <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap", PLAN_STATUS_TONE[status])}>{status === "UNKNOWN" ? "Chưa có phiếu nhập" : PLAN_STATUS_LABEL[status]}</span>
                  <span className="w-24 shrink-0 text-right">
                    {e.known ? <span className={cn("numeric text-lg font-bold", l.suggested > 0 ? "text-foreground" : "text-muted-foreground")}>Đặt {formatNumber(l.suggested)}</span> : <span className="text-xs text-muted-foreground">Chưa tính được</span>}
                  </span>
                  <span className="min-w-0 flex-1 text-sm">{e.summary}</span>
                  <span className="text-xs text-primary group-open:hidden">Xem vì sao</span>
                </summary>
                <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
                  <div className="space-y-2">
                    <ul className="space-y-0.5 text-xs text-muted-foreground">
                      {e.basis.map((b) => <li key={b}>• {b}</li>)}
                    </ul>
                    {e.steps.length ? (
                      <table className="w-full text-sm">
                        <tbody>
                          {e.steps.map((st) => (
                            <tr key={st.key} className={cn(st.op === "=" && "border-t font-semibold")}>
                              <td className="w-6 py-1 pr-1 text-center font-mono text-muted-foreground">{st.op}</td>
                              <td className="py-1 pr-2">
                                {st.label}
                                <span className="block text-[11px] font-normal text-muted-foreground">{st.detail}</span>
                              </td>
                              <td className="numeric w-16 py-1 text-right">{formatNumber(st.qty)}</td>
                            </tr>
                          ))}
                          <tr className="border-t-2 font-bold">
                            <td className="py-1.5 text-center">⇒</td>
                            <td className="py-1.5">Đề xuất đặt</td>
                            <td className="numeric py-1.5 text-right text-base">{formatNumber(l.suggested)}</td>
                          </tr>
                        </tbody>
                      </table>
                    ) : null}
                  </div>
                  <div className="space-y-3">
                    {e.scenarios.length ? (
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-muted-foreground">
                            <th className="py-1 text-left font-medium">Nếu…</th>
                            <th className="py-1 text-right font-medium">Đặt</th>
                            <th className="py-1 text-right font-medium">Hết hàng ~</th>
                          </tr>
                        </thead>
                        <tbody>
                          {e.scenarios.map((sc) => (
                            <tr key={sc.key} className={cn(sc.key === "BASE" && "font-semibold")}>
                              <td className="py-1">{sc.label}</td>
                              <td className="numeric py-1 text-right">{formatNumber(sc.suggested)}</td>
                              <td className="py-1 text-right text-muted-foreground">{sc.stockOutDate ? fmtDateKey(sc.stockOutDate) : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : null}
                    {e.notes.length ? (
                      <ul className="space-y-1 text-xs text-muted-foreground">
                        {e.notes.map((nt) => <li key={nt} className="rounded-md bg-muted/50 px-2 py-1">{nt}</li>)}
                      </ul>
                    ) : null}
                  </div>
                </div>
              </details>
            );
          })}
        </div>
      ) : (
        <p className="px-5 py-4 text-sm text-muted-foreground">Hàng đang có cộng hàng hoàn sắp về đủ bán qua thời gian sản xuất, số ngày muốn đủ bán và dự phòng — không mẫu mã nào cần đặt thêm.</p>
      )}
    </SectionCard>
  );
}

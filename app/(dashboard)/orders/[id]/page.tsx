import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, MapPin, Phone, ShoppingBag, Truck, User } from "lucide-react";
import { CopyButton, JsonViewer } from "@/components/misc";
import { PageHeader } from "@/components/page-header";
import { ShipmentTimeline } from "@/components/shipment-timeline";
import { CodStatusBadge, OrderStageBadge, ShipmentStageBadge, SourceBadge } from "@/components/status-badge";
import { SyncOrderButton } from "@/components/sync-order-button";
import { DescriptionList, Money, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { pancakeStatusName } from "@/lib/constants/pancake";
import { COD_STATUS_LABEL } from "@/lib/constants/viettelpost";
import { env } from "@/lib/env";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { getOrderDetail } from "@/lib/queries/orders";
import { requirePermission } from "@/lib/auth/session";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return { title: `Đơn #${id}` };
}

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("orders:read");
  const { id } = await params;
  const order = await getOrderDetail(id);
  if (!order) notFound();
  const s = order.shipment;
  const paid = order.prepaid + order.transferMoney + order.cash;
  const pancakeUrl = order.shopId ? `https://pos.pancake.vn/shop/${order.shopId}/orders?id=${order.id}` : `https://pos.pancake.vn/shop/${env.pancake.shopId}/orders`;
  const grossProfit = order.totalPriceAfterDiscount - order.liveCogs - order.partnerFee - order.returnFee;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={`Đơn hàng · ${order.source}`}
        title={
          <span className="flex flex-wrap items-center gap-3">
            #{order.systemId ?? order.id}
            <OrderStageBadge stage={order.stage} label={pancakeStatusName(order.status)} className="text-xs" />
          </span>
        }
        description={`Tạo ${formatDateTime(order.insertedAt)} · cập nhật Pancake ${formatDateTime(order.updatedAtExternal)} · đồng bộ ${formatDateTime(order.syncedAt)}`}
        actions={
          <>
            <SyncOrderButton orderId={order.id} />
            <Button asChild variant="outline" size="sm">
              <a href={pancakeUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="size-4" /> Mở trên Pancake
              </a>
            </Button>
          </>
        }
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.9fr)]">
        <div className="space-y-5">
          <SectionCard title={`Sản phẩm (${formatNumber(order.totalQuantity)})`} padded={false}>
            <div className="overflow-x-auto">
              <Table className="min-w-[640px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Sản phẩm</TableHead>
                    <TableHead className="text-right">SL</TableHead>
                    <TableHead className="text-right">Đơn giá</TableHead>
                    <TableHead className="text-right">Giảm</TableHead>
                    <TableHead className="text-right">Thành tiền</TableHead>
                    <TableHead className="text-right">Giá vốn</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {order.items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          {item.image || item.variant?.images?.[0] ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={item.image ?? item.variant?.images?.[0]} alt="" className="size-11 shrink-0 rounded-md border object-cover" />
                          ) : (
                            <span className="flex size-11 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground"><ShoppingBag className="size-4" /></span>
                          )}
                          <div className="min-w-0">
                            <p className="font-semibold">
                              {item.variantId ? <Link href={`/products?q=${encodeURIComponent(item.sku || item.productName)}`} className="hover:text-primary hover:underline">{item.productName}</Link> : item.productName}
                              {item.isBonus ? <span className="ml-2 rounded bg-emerald-50 px-1.5 text-[10px] font-semibold text-emerald-700">Tặng kèm</span> : null}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {item.variationDetail || "—"}
                              {item.sku ? <span className="ml-2 font-mono">{item.sku}</span> : null}
                              {item.variant ? <span className="ml-2">· tồn {item.variant.remainQuantity}</span> : null}
                              {item.returnQuantity ? <span className="ml-2 text-rose-600">· hoàn {item.returnQuantity}</span> : null}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-semibold">{item.quantity}</TableCell>
                      <TableCell className="text-right"><Money value={item.unitPrice} /></TableCell>
                      <TableCell className="text-right text-muted-foreground"><Money value={item.totalDiscount} /></TableCell>
                      <TableCell className="text-right font-semibold"><Money value={item.lineTotal} /></TableCell>
                      <TableCell className="text-right text-muted-foreground"><Money value={item.liveUnitCost * item.quantity} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="grid gap-x-8 gap-y-1.5 border-t px-5 py-4 text-sm sm:grid-cols-2">
              <Row label="Tiền hàng" value={<Money value={order.totalPrice} />} />
              <Row label="Giảm giá" value={<Money value={-order.totalDiscount} />} />
              <Row label="Phí ship thu của khách" value={<Money value={order.customerPayFee ? order.shippingFee : 0} />} />
              <Row label="Phụ thu / thuế" value={<Money value={order.surcharge + order.tax} />} />
              <Row label="Khách đã trả trước" value={<Money value={paid} />} />
              <Row label="Phí sàn" value={<Money value={order.feeMarketplace} />} />
              <Row label={<span className="font-bold">Tổng đơn</span>} value={<Money value={order.totalPriceAfterDiscount} className="text-base font-bold" />} />
              <Row label={<span className="font-bold">Thu hộ (COD)</span>} value={<Money value={order.moneyToCollect} className="text-base font-bold text-primary" />} />
            </div>
            <div className="grid gap-x-8 gap-y-1.5 border-t bg-muted/30 px-5 py-4 text-sm sm:grid-cols-2">
              <Row label="Giá vốn" value={<Money value={order.liveCogs} />} />
              <Row label="Phí ĐVVC" value={<Money value={order.partnerFee} />} />
              <Row label="Phí hoàn" value={<Money value={order.returnFee} />} />
              <Row label={<span className="font-bold">Lãi gộp ước tính</span>} value={<Money value={grossProfit} className={`font-bold ${grossProfit >= 0 ? "text-success" : "text-destructive"}`} />} />
            </div>
          </SectionCard>

          <SectionCard title="Vận chuyển & COD" description={s ? `${s.carrier} · cập nhật ${formatDateTime(s.vtpStatusDate ?? s.updatedAt)}` : "Đơn chưa được đẩy sang đơn vị vận chuyển"} actions={s ? <Link href={`/shipments/${s.id}`} className="text-xs font-semibold text-primary hover:underline">Chi tiết vận đơn</Link> : null}>
            {s ? (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                  <ShipmentStageBadge stage={s.stage} label={s.vtpStatusName ?? undefined} className="text-xs" />
                  <CodStatusBadge status={s.codStatus} className="text-xs" />
                  {s.vtpOrderNumber || s.trackingCode ? (
                    <span className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-xs">
                      {s.vtpOrderNumber ?? s.trackingCode}
                      <CopyButton value={s.vtpOrderNumber ?? s.trackingCode ?? ""} />
                    </span>
                  ) : null}
                  {s.vtpOrderNumber ? (
                    <a className="text-xs font-semibold text-primary hover:underline" href={`https://viettelpost.vn/thong-tin-don-hang?peopleTracking=sender&orderNumber=${s.vtpOrderNumber}&orderType=1`} target="_blank" rel="noreferrer">
                      Tra cứu trên Viettel Post
                    </a>
                  ) : null}
                </div>
                <DescriptionList
                  columns={3}
                  items={[
                    { label: "Tiền thu hộ", value: <Money value={s.codAmount} /> },
                    { label: "Đã thu", value: <Money value={s.codCollected} /> },
                    { label: "Phí vận chuyển", value: <Money value={s.shippingFee} /> },
                    { label: "Lấy hàng", value: formatDateTime(s.pickedUpAt) },
                    { label: "Giao thành công", value: formatDateTime(s.deliveredAt) },
                    { label: "Trạng thái COD", value: `${COD_STATUS_LABEL[s.codStatus]}${s.codPaidToBankAt ? ` · ${formatDateTime(s.codPaidToBankAt)}` : ""}` },
                  ]}
                />
                <ShipmentTimeline events={s.events} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Khi Pancake đẩy đơn sang Viettel Post, mã vận đơn và hành trình sẽ xuất hiện tại đây.</p>
            )}
          </SectionCard>

          <SectionCard title="Lịch sử trạng thái" description="Ghi nhận từ Pancake POS" padded={false}>
            {order.statusHistory.length ? (
              <ul className="divide-y">
                {order.statusHistory.map((h) => (
                  <li key={h.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                    <span className="w-36 shrink-0 text-xs text-muted-foreground">{formatDateTime(h.updatedAt)}</span>
                    <span className="font-medium">{pancakeStatusName(h.status)}</span>
                    {h.oldStatus !== null ? <span className="text-xs text-muted-foreground">← {pancakeStatusName(h.oldStatus)}</span> : null}
                    {h.editorName ? <span className="ml-auto text-xs text-muted-foreground">{h.editorName}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-4 text-sm text-muted-foreground">Chưa có lịch sử.</p>
            )}
          </SectionCard>
        </div>

        <div className="space-y-5">
          <SectionCard title="Khách hàng" actions={order.customer ? <Link href={`/customers/${order.customer.id}`} className="text-xs font-semibold text-primary hover:underline">Hồ sơ</Link> : null}>
            <div className="space-y-3 text-sm">
              <p className="flex items-center gap-2 font-semibold"><User className="size-4 text-muted-foreground" />{order.billFullName || order.shipFullName || "—"}</p>
              <p className="flex items-center gap-2"><Phone className="size-4 text-muted-foreground" />{order.billPhone || "—"} <CopyButton value={order.billPhone} /></p>
              <p className="flex items-start gap-2"><MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span>{order.shipFullAddress || order.shipAddress || "—"}</span></p>
              {order.customer ? (
                <div className="grid grid-cols-3 gap-2 border-t pt-3 text-center">
                  <div><p className="numeric text-lg font-bold">{order.customer.orderCount}</p><p className="text-[11px] text-muted-foreground">Đơn</p></div>
                  <div><p className="numeric text-lg font-bold text-success">{order.customer.succeedOrderCount}</p><p className="text-[11px] text-muted-foreground">Thành công</p></div>
                  <div><p className="numeric text-lg font-bold text-destructive">{order.customer.returnedOrderCount}</p><p className="text-[11px] text-muted-foreground">Hoàn</p></div>
                </div>
              ) : null}
            </div>
          </SectionCard>

          <SectionCard title="Thông tin đơn">
            <DescriptionList
              columns={1}
              items={[
                { label: "Nguồn", value: <span className="flex items-center gap-2"><SourceBadge source={order.source} />{order.accountName ? <span className="text-xs text-muted-foreground">{order.accountName}</span> : null}</span> },
                { label: "Kho xuất", value: order.warehouse?.name ?? "—" },
                { label: "Nhân viên chốt đơn", value: order.sellerName || "—" },
                { label: "Chăm sóc / Marketer", value: [order.careName, order.marketerName].filter(Boolean).join(" / ") || "—" },
                { label: "Người tạo", value: order.creatorName || "—" },
                { label: "Thẻ", value: order.tags.length ? <span className="flex flex-wrap gap-1">{order.tags.map((t) => <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-xs">{t}</span>)}</span> : "—" },
                { label: "Ghi chú", value: order.note || "—" },
                { label: "Ghi chú in", value: order.notePrint || "—" },
                { label: "Lý do hoàn", value: order.returnedReason ?? "—" },
                { label: "Mã Pancake", value: <span className="font-mono text-xs">{order.id}</span> },
              ]}
            />
          </SectionCard>

          {order.returns.length ? (
            <SectionCard title="Đổi / trả liên quan">
              <ul className="space-y-2 text-sm">
                {order.returns.map((r) => (
                  <li key={r.id} className="flex items-center justify-between">
                    <span>Phiếu #{r.displayId ?? r.id} · {r.isExchange ? "Đổi hàng" : "Trả hàng"}</span>
                    <span className="text-xs text-muted-foreground">{formatDateTime(r.insertedAt)}</span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Truck className="size-3.5" /> Giá trị đơn {formatVND(order.totalPriceAfterDiscount)} · {formatNumber(order.itemsCount)} dòng hàng
          </div>
          <JsonViewer value={order.raw} />
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}

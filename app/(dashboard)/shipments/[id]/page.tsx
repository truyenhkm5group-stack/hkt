import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, MapPin, Phone, ShoppingBag, User } from "lucide-react";
import { PushHistoryPanel } from "@/app/(dashboard)/shipments/[id]/push-history";
import { RepushButton } from "@/app/(dashboard)/shipments/[id]/repush-button";
import { VtpActions } from "@/app/(dashboard)/shipments/[id]/vtp-actions";
import { CopyButton, JsonViewer } from "@/components/misc";
import { PageHeader } from "@/components/page-header";
import { ShipmentTimeline } from "@/components/shipment-timeline";
import { CodStatusBadge, OrderStageBadge, ShipmentStageBadge, SourceBadge } from "@/components/status-badge";
import { SyncOrderButton } from "@/components/sync-order-button";
import { DescriptionList, Money, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PANCAKE_PARTNER_STATUS } from "@/lib/constants/pancake";
import { COD_STATUS_LABEL, VTP_REASON_CODES } from "@/lib/constants/viettelpost";
import { formatDateTime, formatNumber, formatTimeAgo } from "@/lib/format";
import { getShipmentDetail } from "@/lib/queries/shipments";
import { can, requirePermission } from "@/lib/auth/session";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const shipment = await getShipmentDetail(id);
  return { title: `Vận đơn ${shipment?.vtpOrderNumber ?? shipment?.trackingCode ?? id}` };
}

export default async function ShipmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("shipments:view");
  const canManage = can(user, "shipments:manage");
  const { id } = await params;
  const s = await getShipmentDetail(id);
  if (!s) notFound();
  const number = s.vtpOrderNumber ?? s.trackingCode;
  const isVtp = Boolean(s.vtpOrderNumber) || /viettel/i.test(s.carrier);
  const vtpUrl = s.vtpOrderNumber ? `https://viettelpost.vn/thong-tin-don-hang?peopleTracking=sender&orderNumber=${encodeURIComponent(s.vtpOrderNumber)}&orderType=1` : null;
  const order = s.order;
  const partner = s.partnerStatus ? (PANCAKE_PARTNER_STATUS[s.partnerStatus]?.name ?? s.partnerStatus) : null;
  const reason = s.vtpReasonCode !== null ? `${VTP_REASON_CODES[s.vtpReasonCode] ?? "Mã lý do"} (${s.vtpReasonCode})` : null;
  const receiverName = s.receiverName || order?.billFullName || "—";
  const receiverPhone = s.receiverPhone || order?.billPhone || "";
  const receiverAddress = s.receiverAddress || order?.shipFullAddress || "—";

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={`Vận đơn · ${s.carrier || "ĐVVC"}`}
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="font-mono">{number ?? "Chưa có mã"}</span>
            {number ? <CopyButton value={number} /> : null}
            <ShipmentStageBadge stage={s.stage} label={s.vtpStatusName ?? undefined} className="text-xs" />
            {s.isFinal ? <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">Đã kết thúc</span> : null}
          </span>
        }
        description={`Tạo ${formatDateTime(s.createdAt)} · trạng thái ĐVVC ${formatDateTime(s.vtpStatusDate)} · tra cứu VTP ${s.lastVtpSyncAt ? formatTimeAgo(s.lastVtpSyncAt) : "chưa"} · đồng bộ Pancake ${s.lastPancakeSyncAt ? formatTimeAgo(s.lastPancakeSyncAt) : "chưa"}`}
        actions={
          <>
            {isVtp ? <SyncOrderButton shipmentId={s.id} label="Cập nhật từ Viettel Post" /> : null}
            {isVtp ? <RepushButton shipmentId={s.id} /> : null}
            {isVtp && canManage ? <VtpActions shipmentId={s.id} stage={s.stage} receiver={{ name: s.order?.shipFullName || s.order?.billFullName || "", phone: s.order?.shipPhone || s.order?.billPhone || "", address: s.order?.shipAddress || "", cod: s.codAmount || s.order?.cod || 0, note: s.order?.note || "" }} /> : null}
            {vtpUrl ? (
              <Button asChild variant="outline" size="sm">
                <a href={vtpUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" /> Tra cứu trên Viettel Post
                </a>
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.9fr)]">
        <div className="space-y-5">
          <SectionCard title="Hành trình" description={`${formatNumber(s.events.length)} sự kiện · ${s.vtpLocation ? `vị trí hiện tại: ${s.vtpLocation}` : "chưa có vị trí"}`}>
            <ShipmentTimeline events={s.events} limit={50} />
          </SectionCard>

          <SectionCard
            title="Đơn hàng liên kết"
            description={order ? `Đơn Pancake #${order.systemId ?? order.id} · ${order.source} · tạo ${formatDateTime(order.insertedAt)}` : "Vận đơn không gắn với đơn Pancake nào (nhập từ tài khoản Viettel Post)"}
            actions={order ? <Link href={`/orders/${order.id}`} className="text-xs font-semibold text-primary hover:underline">Mở đơn hàng</Link> : null}
            padded={!order}
          >
            {order ? (
              <>
                <div className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                  <OrderStageBadge stage={order.stage} label={order.statusName || undefined} />
                  <SourceBadge source={order.source} />
                  <span className="text-muted-foreground">
                    Tổng đơn <Money value={order.totalPriceAfterDiscount} className="font-semibold text-foreground" /> · thu hộ <Money value={order.moneyToCollect} className="font-semibold text-foreground" /> · {formatNumber(order.totalQuantity)} sản phẩm
                  </span>
                </div>
                <div className="overflow-x-auto border-t">
                  <Table className="min-w-[560px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Sản phẩm</TableHead>
                        <TableHead className="text-right">SL</TableHead>
                        <TableHead className="text-right">Đơn giá</TableHead>
                        <TableHead className="text-right">Thành tiền</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {order.items.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell>
                            <div className="flex items-center gap-3">
                              {item.image ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={item.image} alt="" className="size-9 shrink-0 rounded-md border object-cover" />
                              ) : (
                                <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground"><ShoppingBag className="size-4" /></span>
                              )}
                              <div className="min-w-0">
                                <p className="truncate font-semibold">{item.productName}</p>
                                <p className="text-xs text-muted-foreground">
                                  {item.variationDetail || "—"}
                                  {item.sku ? <span className="ml-2 font-mono">{item.sku}</span> : null}
                                  {item.returnQuantity ? <span className="ml-2 text-rose-600">· hoàn {item.returnQuantity}</span> : null}
                                </p>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-semibold">{item.quantity}</TableCell>
                          <TableCell className="text-right"><Money value={item.unitPrice} /></TableCell>
                          <TableCell className="text-right font-semibold"><Money value={item.lineTotal} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {s.orderReference ? `Mã tham chiếu từ Viettel Post: ${s.orderReference}. ` : ""}
                Khi đồng bộ đơn Pancake có cùng mã tham chiếu, vận đơn sẽ tự động gắn với đơn.
              </p>
            )}
          </SectionCard>

          {isVtp ? (
            <SectionCard title="Lịch sử webhook Viettel Post">
              <PushHistoryPanel shipmentId={s.id} />
            </SectionCard>
          ) : null}

          <JsonViewer value={s.raw} />
        </div>

        <div className="space-y-5">
          <SectionCard title="Thông tin vận đơn">
            <DescriptionList
              columns={2}
              items={[
                { label: "Đơn vị vận chuyển", value: s.carrier || "—" },
                { label: "Dịch vụ", value: s.service || "—" },
                { label: "Mã vận đơn", value: <span className="font-mono text-xs">{s.trackingCode ?? "—"}</span> },
                { label: "Mã Viettel Post", value: <span className="font-mono text-xs">{s.vtpOrderNumber ?? "—"}</span> },
                { label: "Khối lượng", value: s.weight ? `${formatNumber(s.weight)} g` : "—" },
                { label: "Dự kiến giao", value: s.expectedDelivery || "—" },
                { label: "Trạng thái VTP", value: s.vtpStatus !== null ? `${s.vtpStatusName ?? ""} (${s.vtpStatus})` : s.vtpStatusName ?? "—" },
                { label: "Vị trí hiện tại", value: s.vtpLocation || "—" },
                { label: "Lý do", value: reason ?? "—", span: true },
                { label: "Ghi chú ĐVVC", value: s.vtpNote || "—", span: true },
                { label: "Trạng thái trên Pancake", value: partner ?? "—" },
                { label: "Mã tham chiếu", value: s.orderReference ? <span className="font-mono text-xs">{s.orderReference}</span> : "—" },
                { label: "Lấy hàng", value: formatDateTime(s.pickedUpAt) },
                { label: "Giao lần đầu", value: formatDateTime(s.firstDeliveryAt) },
                { label: "Giao thành công", value: formatDateTime(s.deliveredAt) },
                { label: "Chuyển hoàn", value: formatDateTime(s.returnedAt) },
                ...(s.cancelledAt ? [{ label: "Đã hủy", value: formatDateTime(s.cancelledAt) }] : []),
              ]}
            />
          </SectionCard>

          <SectionCard title="Người nhận">
            <div className="space-y-3 text-sm">
              <p className="flex items-center gap-2 font-semibold"><User className="size-4 text-muted-foreground" />{receiverName}</p>
              <p className="flex items-center gap-2"><Phone className="size-4 text-muted-foreground" />{receiverPhone || "—"} {receiverPhone ? <CopyButton value={receiverPhone} /> : null}</p>
              <p className="flex items-start gap-2"><MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span>{receiverAddress}</span></p>
            </div>
          </SectionCard>

          <SectionCard title="Thu hộ (COD)" actions={<CodStatusBadge status={s.codStatus} />}>
            <DescriptionList
              columns={2}
              items={[
                { label: "Tiền thu hộ", value: <Money value={s.codAmount} className="font-bold" /> },
                { label: "Đã thu", value: <Money value={s.codCollected} /> },
                { label: "Phí COD", value: <Money value={s.codFee} /> },
                { label: "Phí vận chuyển", value: <Money value={s.shippingFee} /> },
                { label: "Trạng thái COD", value: COD_STATUS_LABEL[s.codStatus] },
                { label: "ĐVVC đối soát", value: formatDateTime(s.codReconciledAt) },
                { label: "Về ngân hàng", value: formatDateTime(s.codPaidToBankAt) },
                {
                  label: "Đợt nhận tiền",
                  value: s.codBatch ? (
                    <Link href={`/cod?batch=${s.codBatch.id}`} className="font-mono text-xs text-primary hover:underline">
                      {s.codBatch.reference}
                    </Link>
                  ) : (
                    "—"
                  ),
                },
              ]}
            />
            {s.codBatch ? <p className="mt-3 text-xs text-muted-foreground">Bảng kê {s.codBatch.reference} · {s.codBatch.carrier} · nhận {formatDateTime(s.codBatch.receivedAt)} · tổng <Money value={s.codBatch.totalAmount} /></p> : null}
            {s.codAmount > 0 ? (
              <Link href="/cod" className="mt-3 inline-block text-xs font-semibold text-primary hover:underline">
                Mở trang đối soát COD
              </Link>
            ) : null}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

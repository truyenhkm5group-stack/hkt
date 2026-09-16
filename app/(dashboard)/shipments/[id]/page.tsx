import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, MapPin, Phone, ShoppingBag, User } from "lucide-react";
import { PushHistoryPanel } from "@/app/(dashboard)/shipments/[id]/push-history";
import { RepushButton } from "@/app/(dashboard)/shipments/[id]/repush-button";
import { VtpActions } from "@/app/(dashboard)/shipments/[id]/vtp-actions";
import { ReturnReasonPanel } from "@/app/(dashboard)/shipments/[id]/reason-panel";
import { CopyButton, JsonViewer } from "@/components/misc";
import { PageHeader } from "@/components/page-header";
import { ShipmentTimeline } from "@/components/shipment-timeline";
import { ShipmentActivityLog } from "@/components/shipment-activity-log";
import { CodStatusBadge, OrderStageBadge, ShipmentStageBadge, SourceBadge } from "@/components/status-badge";
import { SyncOrderButton } from "@/components/sync-order-button";
import { DescriptionList, Money, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PANCAKE_PARTNER_STATUS } from "@/lib/constants/pancake";
import { COD_STATUS_LABEL, getViettelPostTrackingUrl, VTP_REASON_CODES } from "@/lib/constants/viettelpost";
import { formatDateTime, formatNumber, formatTimeAgo } from "@/lib/format";
import { getShipmentDetail, outcomeOfShipment } from "@/lib/queries/shipments";
import { reasonsForShipments } from "@/lib/queries/return-reason";
import { getShipmentDwell } from "@/lib/queries/shipment-status-age";
import { getShipmentTimeline } from "@/lib/queries/shipment-timeline";
import { timelineSourceLabel } from "@/lib/constants/shipment-timeline";
import { DWELL_BASIS_LABEL, DWELL_LEVEL_LABEL, DWELL_LEVEL_TONE, DWELL_UNRATED_HINT, DWELL_UNRATED_LABEL } from "@/lib/constants/shipment-status-age";
import { ageLabel } from "@/lib/constants/action-queue";
import { MISSING_TEXT } from "@/lib/format";
import { cn } from "@/lib/utils";
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
  /*
    LÝ DO HOÀN CHỈ HỎI TRÊN KIỆN ĐÃ HOÀN.

    Hỏi "vì sao hoàn" trên một kiện đang đi là mời người ta đoán, và một lý do đoán ra thì không
    phân biệt được với một lý do đã xác minh.

    "Đã hoàn" đọc từ `ORDER_OUTCOME` — nguồn duy nhất — chứ KHÔNG so `shipments.stage` bằng tay:
    `stage` là chặng của hãng vận, và `RETURNED_BY_RULE` (hoàn theo luật tiền) không có mặt ở đó
    chút nào. Đặc tả mục 6 gộp `RETURNED` và `RETURNED_BY_RULE` là hoàn.
  */
  const [outcome, dwell, nhatKy] = await Promise.all([outcomeOfShipment(s.id), getShipmentDwell(s.id), getShipmentTimeline(s.id)]);
  const daHoan = outcome === "RETURNED" || outcome === "RETURNED_BY_RULE";
  const lyDo = daHoan ? (await reasonsForShipments([s.id])).get(s.id) : undefined;
  const number = s.vtpOrderNumber ?? s.trackingCode;
  const isVtp = Boolean(s.vtpOrderNumber) || /viettel/i.test(s.carrier);
  const vtpUrl = getViettelPostTrackingUrl(s.vtpOrderNumber);
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
            {number ? <CopyButton value={number} what="mã vận đơn" /> : null}
            <ShipmentStageBadge stage={s.stage} label={s.vtpStatusName ?? undefined} className="text-xs" />
            {s.isFinal ? <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">Đã kết thúc</span> : null}
          </span>
        }
        description={
          // BA MỐC KHÁC NHAU, KHÔNG NÉN THÀNH MỘT: "ĐVVC nói lúc nào" · "ERP hỏi lại lúc nào" ·
          // "nguồn nào quyết định con số đang hiện". Thiếu vế cuối thì mỗi lần số liệu bị nghi ngờ
          // lại phải mở bảng sự kiện mới biết tin này đến từ webhook, đối chiếu hay một tệp.
          `Tạo ${formatDateTime(s.createdAt)} · trạng thái ĐVVC ${formatDateTime(s.vtpStatusDate)}` +
          (s.vtpSyncSource ? ` (nguồn: ${timelineSourceLabel(s.vtpSyncSource)})` : "") +
          ` · tra cứu VTP ${s.lastVtpSyncAt ? formatTimeAgo(s.lastVtpSyncAt) : "chưa"}` +
          (s.vtpNextSyncAt ? ` · hỏi lại ${formatDateTime(s.vtpNextSyncAt)}` : "") +
          ` · đồng bộ Pancake ${s.lastPancakeSyncAt ? formatTimeAgo(s.lastPancakeSyncAt) : "chưa"}`
        }
        actions={
          <>
            {isVtp ? <SyncOrderButton shipmentId={s.id} label="Cập nhật từ Viettel Post" /> : null}
            {isVtp ? <RepushButton shipmentId={s.id} /> : null}
            {isVtp && canManage ? <VtpActions shipmentId={s.id} stage={s.stage} vtpStatus={s.vtpStatus} rawStatus={s.vtpStatusName} tracking={number} trackingCapability={s.trackingCapability} receiver={{ name: s.order?.shipFullName || s.order?.billFullName || "", phone: s.order?.shipPhone || s.order?.billPhone || "", address: s.order?.shipAddress || "", cod: s.codAmount || s.order?.cod || 0, note: s.order?.note || "" }} /> : null}
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

      {/*
        ĐVVC VỪA NÓI MỘT CÂU ERP CHƯA HIỂU — PHẢI NÓI RA, KHÔNG ĐƯỢC IM.

        `materializeShipmentState()` cố ý bỏ qua sự kiện không dịch được (không đủ căn cứ thì không
        kết luận), nên ô trạng thái ở trên vẫn hiện câu CŨ. Trước bản này người trực không có cách
        nào biết điều đó — họ đọc một trạng thái cũ và tưởng đó là tin mới nhất.
      */}
      {!s.vtpRawMapped && s.vtpRawStatusName ? (
        <div className="rounded-lg border border-violet-300 bg-violet-50 px-4 py-3 text-sm dark:border-violet-900/60 dark:bg-violet-950/40">
          <p className="font-semibold text-violet-900 dark:text-violet-200">Viettel Post: &ldquo;{s.vtpRawStatusName}&rdquo;{s.vtpRawStatusCode !== null ? ` (mã ${s.vtpRawStatusCode})` : ""}</p>
          <p className="mt-0.5 text-[12.5px] text-violet-800 dark:text-violet-300">
            ERP chưa dịch được câu này nên trạng thái vận đơn ở trên vẫn là chứng từ trước đó
            {s.vtpRawStatusAt ? ` (ĐVVC nói lúc ${formatDateTime(s.vtpRawStatusAt)})` : ""}. Chữ gốc được giữ nguyên và đã vào sổ trạng thái;
            việc phải làm là bổ sung mã vào bảng của ERP, không phải đoán.
          </p>
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.9fr)]">
        <div className="space-y-5">
          {/*
            HAI ĐỒNG HỒ ĐỨNG CẠNH NHAU, CỐ Ý.

            "Đứng ở chặng này" đo từ lúc kiện VÀO chặng hiện tại; "ĐVVC nói lần cuối" đo IM LẶNG.
            Một kiện có thể nhận tin mỗi giờ mà vẫn không nhích — và chỉ khi hai số này lệch xa nhau
            thì người trực mới nhìn ra điều đó. Xem lib/constants/shipment-status-age.ts.
          */}
          {dwell ? (
            <SectionCard
              title="Kiện đang đứng ở đâu, bao lâu rồi"
              description={dwell.verdict.unrated ? DWELL_UNRATED_HINT[dwell.verdict.unrated] : undefined}
              actions={
                <span
                  className={cn(
                    "rounded-md px-2 py-0.5 text-[11px] font-semibold",
                    dwell.verdict.level ? DWELL_LEVEL_TONE[dwell.verdict.level] : "border border-dashed bg-muted/40 text-muted-foreground",
                  )}
                >
                  {dwell.verdict.level ? DWELL_LEVEL_LABEL[dwell.verdict.level] : dwell.verdict.unrated ? DWELL_UNRATED_LABEL[dwell.verdict.unrated] : MISSING_TEXT}
                </span>
              }
            >
              <DescriptionList
                columns={2}
                items={[
                  {
                    label: "Đứng ở chặng này",
                    // CHƯA BIẾT in ra dấu gạch, không in thành "0 giờ".
                    value: dwell.verdict.ageHours === null ? MISSING_TEXT : ageLabel(dwell.verdict.ageHours),
                  },
                  { label: "ĐVVC nói lần cuối", value: s.vtpStatusDate ? formatTimeAgo(s.vtpStatusDate) : MISSING_TEXT },
                  {
                    label: "Vào chặng lúc",
                    value: dwell.verdict.since ? `${formatDateTime(dwell.verdict.since)}${dwell.verdict.sinceBasis ? ` · ${DWELL_BASIS_LABEL[dwell.verdict.sinceBasis]}` : ""}` : MISSING_TEXT,
                  },
                  {
                    label: "Tin cùng chặng",
                    value: dwell.verdict.eventsInRun > 1 ? `${formatNumber(dwell.verdict.eventsInRun)} tin mà kiện không nhích` : formatNumber(dwell.verdict.eventsInRun),
                  },
                  { label: "Việc phải làm", value: dwell.nextAction, span: true },
                ]}
              />
            </SectionCard>
          ) : null}

          {/*
            HAI KHỐI, HAI CÂU HỎI KHÁC NHAU — cố ý không gộp.

            "Hành trình" là CHỨNG TỪ ĐVVC thuần tuý: đúng thứ để mở cạnh màn hình Viettel Post mà
            đối chiếu từng dòng. "Nhật ký xử lý" là toàn bộ vòng đời — ĐVVC, hệ thống, người, và
            kết luận ERP suy ra — để trả lời "ai đã làm gì, lúc nào, và sau đó chứng từ có đổi
            không". Gộp chúng lại là làm hỏng việc đối chiếu, vì hàng chục dòng thao tác của người
            sẽ xen vào giữa các mốc của ĐVVC.
          */}
          <SectionCard title="Hành trình" description={`${formatNumber(s.events.length)} sự kiện · ${s.vtpLocation ? `vị trí hiện tại: ${s.vtpLocation}` : "chưa có vị trí"}`}>
            <ShipmentTimeline events={s.events} limit={50} />
          </SectionCard>

          <SectionCard
            title="Nhật ký xử lý"
            description={`${formatNumber(nhatKy.entries.length)} mốc · ${formatNumber(nhatKy.counts.carrier)} chứng từ ĐVVC · ${formatNumber(nhatKy.counts.human)} thao tác của người`}
            hint="Bốn chiều tách rời: chứng từ Viettel Post · việc hệ thống làm · việc người làm · kết luận ERP suy ra. Một dòng của người hay của ERP KHÔNG BAO GIỜ sửa một dòng chứng từ."
          >
            <div className="px-5 py-3">
              <DescriptionList
                columns={2}
                items={[
                  { label: "Ca mở lúc", value: nhatKy.durations.caseOpenedAt ? formatDateTime(nhatKy.durations.caseOpenedAt) : MISSING_TEXT },
                  // CHƯA XẢY RA in ra dấu gạch, không in thành "0 phút" (AGENTS.md luật 42).
                  { label: "Tới lúc giao việc", value: nhatKy.durations.minutesToAssign === null ? MISSING_TEXT : `${formatNumber(nhatKy.durations.minutesToAssign)} phút` },
                  { label: "Tới thao tác đầu", value: nhatKy.durations.minutesToFirstAction === null ? MISSING_TEXT : `${formatNumber(nhatKy.durations.minutesToFirstAction)} phút` },
                  { label: "Tới lúc chốt ca", value: nhatKy.durations.minutesToResolution === null ? MISSING_TEXT : `${formatNumber(nhatKy.durations.minutesToResolution)} phút` },
                  { label: "Gọi khách", value: formatNumber(nhatKy.counts.calls) },
                  { label: "Nhắn khách", value: formatNumber(nhatKy.counts.messages) },
                  { label: "Liên hệ ĐVVC", value: formatNumber(nhatKy.counts.carrierContacts) },
                  {
                    label: `Hạn phản hồi đầu (${nhatKy.durations.slaFirstResponseHours}h)`,
                    value: nhatKy.durations.caseOpenedAt ? (nhatKy.durations.firstResponseBreached ? "ĐÃ VỠ HẠN" : "Trong hạn") : MISSING_TEXT,
                  },
                ]}
              />
            </div>
            <div className="border-t px-5 py-3">
              <ShipmentActivityLog entries={nhatKy.entries} />
            </div>
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
                { label: "Lý do ĐVVC khai", value: reason ?? "—", span: true },
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

          {lyDo ? (
            <SectionCard title="Lý do hoàn" description="Chọn từ danh mục để báo cáo đếm được. Ghi chú chi tiết là tuỳ.">
              <ReturnReasonPanel
                shipmentId={s.id}
                tracking={number ?? s.id}
                reason={lyDo.reason}
                coverage={lyDo.coverage}
                source={lyDo.source}
                rawReason={lyDo.rawReason}
                evidence={lyDo.evidence}
                actorEmail={lyDo.actorEmail}
                canEdit={can(user, "shipments:view")}
              />
            </SectionCard>
          ) : null}

          <SectionCard title="Người nhận">
            <div className="space-y-3 text-sm">
              <p className="flex items-center gap-2 font-semibold"><User className="size-4 text-muted-foreground" />{receiverName}</p>
              <p className="flex items-center gap-2"><Phone className="size-4 text-muted-foreground" />{receiverPhone || "—"} {receiverPhone ? <CopyButton value={receiverPhone} what="SĐT" /> : null}</p>
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

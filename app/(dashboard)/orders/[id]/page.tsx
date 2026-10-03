import Link from "next/link";
import { ReverseRelationsCard } from "@/components/objects/reverse-relations-card";
import { cn } from "@/lib/utils";
import { SHIPMENT_DIRECTION_LABEL } from "@/lib/constants/viettelpost";
import { assessCustomerRisk, erpHistoryByPhone, erpOrderCountByPhone, isNewPhone } from "@/lib/alerts/risk";
import { loadAlertConfig } from "@/lib/alerts/config";
import { notFound } from "next/navigation";
import { ExternalLink, MapPin, Phone, ShoppingBag, Truck, User } from "lucide-react";
import { CopyButton, JsonViewer } from "@/components/misc";
import { PageHeader } from "@/components/page-header";
import { ShipmentTimeline } from "@/components/shipment-timeline";
import { EntityTimeline } from "@/components/entity-timeline";
import { getOrderTimeline } from "@/lib/queries/entity-timeline";
import { CodStatusBadge, OrderStageBadge, ShipmentStageBadge, SourceBadge } from "@/components/status-badge";
import { SyncOrderButton } from "@/components/sync-order-button";
import { DescriptionList, Money, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { pancakeStatusName } from "@/lib/constants/pancake";
import { COD_STATUS_LABEL, getViettelPostTrackingUrl } from "@/lib/constants/viettelpost";
import { env } from "@/lib/env";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { getDb } from "@/db";
import { getOrderDetail, orderChatThreads } from "@/lib/queries/orders";
import { previousOrderHint } from "@/lib/queries/order-hints";
import { getOrderValidation } from "@/lib/queries/preship-validation";
import { SEVERITY_LABEL, SEVERITY_TONE } from "@/lib/constants/preship-validation";
import { pancakeConversationUrl, pancakePosOrderSearchUrl, pancakePosOrderUrlFromRaw, PRE_SHIP_STAGES } from "@/lib/constants/pancake";
import { PromisedDelivery } from "@/app/(dashboard)/orders/[id]/promised-delivery";
import { promisedVerdict } from "@/lib/constants/promised-delivery";
import { vnDateKey } from "@/lib/format";
import { can, requirePermission } from "@/lib/auth/session";
import { CancelManualOrderButton, ConfirmManualDeliveryButton, ManualDeliveryFailedButton, RecordManualPaymentButton, VoidManualDeliveryButton, VoidManualPaymentButton } from "@/app/(dashboard)/orders/[id]/manual-order-actions";
import { ManualPaymentStatusText } from "@/app/(dashboard)/orders/payment-status";
import { canRecordPayment, PAYMENT_KIND_LABEL, PAYMENT_METHOD_LABEL } from "@/lib/constants/order-payments";
import { manualOrderPaymentView } from "@/lib/queries/order-payments";
import { canConfirmManualDelivery, canMarkManualDeliveryFailed, isManualOrderId, manualOrderRaw, manualOrderShortCode } from "@/lib/constants/manual-orders";
import { manualOrderDeliveryView, manualOrderGate } from "@/lib/records/order-create";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return { title: `Đơn #${id}` };
}

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("orders:read");
  const { id } = await params;
  // Hai phép đọc đầu không phụ thuộc nhau; bốn phép đọc sau chỉ cần `order`. Trước đây sáu lượt
  // nối đuôi, mỗi lượt một vòng đi-về CSDL — trang chi tiết đơn là trang mở nhiều nhất sau danh sách.
  const [order, riskCfg] = await Promise.all([getOrderDetail(id), loadAlertConfig()]);
  if (!order) notFound();
  // Đơn thiếu SĐT / địa chỉ (khách cũ mua lại chỉ nhắn "gửi địa chỉ cũ") → gợi ý lấy lại từ đơn cũ của chính khách
  const thieuThongTin = !order.billPhone || !(order.shipFullAddress || order.shipAddress);
  /*
    BẢN SOÁT CHỈ CHẠY CHO ĐƠN CHƯA GỬI.

    Với đơn đã rời kho thì mọi lỗi chứng từ đã hết đường sửa miễn phí, và một dải cảnh báo đỏ trên
    đầu trang chỉ còn là tiếng ồn — người đọc sẽ học cách bỏ qua nó, kể cả trên đơn còn cứu được.
    Bỏ luôn lượt truy vấn cho nhóm đó: trang chi tiết đơn là trang mở nhiều nhất sau danh sách.
  */
  const chuaGui = PRE_SHIP_STAGES.includes(order.stage);
  const [timeline, erpHist, erpOther, prev, soat, nguoiHen] = await Promise.all([
    getOrderTimeline(order.id),
    erpHistoryByPhone([order.billPhone ?? ""], order.id),
    erpOrderCountByPhone([order.billPhone ?? ""], order.id),
    thieuThongTin ? previousOrderHint({ id: order.id, customerId: order.customerId, conversationId: order.conversationId, billPhone: order.billPhone, insertedAt: order.insertedAt }) : Promise.resolve(null),
    // Dải soát nói về đơn POS Pancake (ghép tỉnh / xã để POS đẩy sang ĐVVC). Đơn tạo tay / do chatbot lên (`erp-`) không đi
    // qua POS — soát nó là in chỉ dẫn «mở đơn trên Pancake» cho một tổ chức không có Pancake (0180).
    chuaGui && !isManualOrderId(order.id) ? getOrderValidation(order.id) : Promise.resolve(null),
    /*
      TÊN NGƯỜI GHI LỜI HẸN đọc từ `users` QUA KHOÁ (AGENTS.md mục 34) — không lấy từ một ô chữ nào.
      Một lượt tra khoá chính, và chỉ khi đơn thật sự có lời hẹn.
    */
    order.customerPromisedByUserId && order.customerPromisedAt
      ? getDb().then((db) =>
          db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, order.customerPromisedByUserId!), columns: { name: true, email: true } }),
        )
      : Promise.resolve(null),
  ]);
  const risk = assessCustomerRisk({ succeed: order.customer?.succeedOrderCount ?? 0, returned: order.customer?.returnedOrderCount ?? 0, isBlock: Boolean(order.customer?.isBlock), erpDelivered: erpHist.delivered, erpReturned: erpHist.returned }, riskCfg);
  const newPhone = isNewPhone({ phone: order.billPhone, succeed: order.customer?.succeedOrderCount ?? 0, returned: order.customer?.returnedOrderCount ?? 0, erpOtherOrders: erpOther });
  /**
   * MỌI LẦN GỬI, THEO THỨ TỰ.
   *
   * Trước đây trang này lấy `order.shipment` — quan hệ `one(...)`, tức MỘT dòng bất kỳ. Với đơn gửi
   * lại, người vận hành thấy "đang giao" mà không biết đây đã là lần thứ ba, và lần huỷ trước đó
   * biến mất khỏi màn hình dù vẫn còn nguyên trong sổ.
   */
  const attempts = order.attempts;
  const s = attempts.at(-1) ?? null;
  const paid = order.prepaid + order.transferMoney + order.cash;
  // Đường dẫn POS Pancake tự gửi kèm đơn (mã nội bộ POS ≠ orders.id). Thiếu thì mở danh sách đơn của
  // shop, lọc sẵn theo số đơn.
  /*
    ĐƠN TẠO TAY (pilot P0 #3): không có bản Pancake để mở, không có gì để đồng bộ lại. Sửa / huỷ / xác nhận giao đi qua
    CÙNG cổng với server action (`manualOrderGate`). Hàng rời kho bằng PHIẾU GIAO CÓ KÝ NHẬN (G-ORDER — ORDER_OUTCOME.md
    mục 11), KHÔNG bằng phiếu XUẤT TAY: lối "Lập phiếu xuất kho" của bản trước đã bỏ — làm cả hai là trừ tồn hai lần.
  */
  const manual = isManualOrderId(order.id) && manualOrderRaw(order.raw) !== null;
  const [manualGate, delivery, payment] = manual ? await Promise.all([manualOrderGate(user), manualOrderDeliveryView(order.id), manualOrderPaymentView(order)]) : [null, null, null];
  const manualEditable = manual && manualGate?.allowed === true && order.stage !== "CANCELLED" && order.stage !== "DELIVERED";
  const canDeliver = manual && manualGate?.allowed === true && canConfirmManualDelivery(order.stage) && !delivery?.active && attempts.length === 0;
  const canVoidDelivery = manual && manualGate?.allowed === true && Boolean(delivery?.active);
  // Giao không thành công (ORDER_OUTCOME.md mục 11.2): cùng điều kiện với xác nhận giao; đã ghi ⇒ cho hoàn tác.
  const canFail = canDeliver && canMarkManualDeliveryFailed(order.stage);
  const canUndoFail = manual && manualGate?.allowed === true && order.stage === "RETURNED";
  // Chứng từ thanh toán (ORDER_OUTCOME.md mục 11): cùng cổng; KHÔNG phụ thuộc phiếu giao. Đơn đã huỷ chỉ nhận phiếu hoàn.
  const canPay = manual && manualGate?.allowed === true;
  const canReceipt = canPay && canRecordPayment("RECEIPT", order.stage);
  const canRefund = canPay && canRecordPayment("REFUND", order.stage) && (payment?.state.net ?? 0) > 0;
  const pancakeUrl = manual ? null : (pancakePosOrderUrlFromRaw(order.raw) ?? pancakePosOrderSearchUrl(order.shopId || env.pancake.shopId, order.systemId));
  // Hội thoại Pancake của khách: đơn đồng bộ mang sẵn mã; đơn bot / ghi từ hội thoại tra ngược trong sổ hội thoại chatbot.
  const chatThread = manual ? (await orderChatThreads([order.id])).get(order.id) : undefined;
  const chatUrl = chatThread ? pancakeConversationUrl(chatThread.pageId, chatThread.threadId) : pancakeConversationUrl(order.pageId, order.conversationId);
  const grossProfit = order.totalPriceAfterDiscount - order.liveCogs - order.partnerFee - order.returnFee;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={`Đơn hàng · ${order.source}`}
        title={
          <span className="flex flex-wrap items-center gap-3">
            #{manual ? manualOrderShortCode(order.id) : (order.systemId ?? order.id)}
            <OrderStageBadge stage={order.stage} label={pancakeStatusName(order.status)} className="text-xs" />
          </span>
        }
        description={manual ? `Đơn tạo tay trên ERP · tạo ${formatDateTime(order.insertedAt)}${order.creatorName ? ` bởi ${order.creatorName}` : ""}` : `Tạo ${formatDateTime(order.insertedAt)} · cập nhật Pancake ${formatDateTime(order.updatedAtExternal)} · đồng bộ ${formatDateTime(order.syncedAt)}`}
        actions={
          <>
            {manual ? null : <SyncOrderButton orderId={order.id} />}
            {manualEditable ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/orders/${encodeURIComponent(order.id)}/edit`}>Sửa đơn</Link>
              </Button>
            ) : null}
            {manualEditable ? <CancelManualOrderButton orderId={order.id} /> : null}
            {chatUrl ? (
              <Button asChild variant="outline" size="sm">
                <a href={chatUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" /> Hội thoại Pancake
                </a>
              </Button>
            ) : null}
            {pancakeUrl ? (
              <Button asChild variant="outline" size="sm">
                <a href={pancakeUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" /> Mở trên Pancake
                </a>
              </Button>
            ) : null}
          </>
        }
      />

      {/*
        LỜI HẸN ĐỨNG NGAY DƯỚI TIÊU ĐỀ, TRÊN CẢ DẢI SOÁT.

        Nó quyết định đơn này CÓ ĐANG TRỄ HAY KHÔNG, nên đọc nó trước rồi mới đọc phần còn lại thì
        mọi con số phía dưới mới có nghĩa. Chỉ hiện với đơn chưa rời kho: hẹn một ngày giao cho
        kiện đang trên đường là một con số không ai thực hiện được.
      */}
      {chuaGui ? (
        <PromisedDelivery
          orderId={order.id}
          state={promisedVerdict(order.customerPromisedAt, new Date()).state}
          promisedDate={order.customerPromisedAt ? vnDateKey(order.customerPromisedAt) : null}
          note={order.customerPromisedNote}
          recordedBy={nguoiHen ? nguoiHen.name || nguoiHen.email : null}
          canWrite={can(user, "cs:manage")}
        />
      ) : null}

      {/*
        DẢI SOÁT ĐỨNG TRÊN CÙNG, TRƯỚC MỌI THỨ KHÁC — vì nó là thứ duy nhất trên trang này còn thay
        đổi được kết quả. Mỗi dòng nói ĐỦ BA: trường nào, vì sao hỏng, và sửa thế nào. ERP KHÔNG tự
        sửa và không chặn được: trạng thái đơn nằm ở Pancake, không có đường ghi ngược.
      */}
      {soat && soat.report.findings.length > 0 ? (
        <section
          className={cn(
            "rounded-xl border px-4 py-3",
            soat.report.blockers.length
              ? "border-rose-300/70 bg-rose-50/60 dark:border-rose-900/60 dark:bg-rose-950/20"
              : "border-amber-300/70 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/20",
          )}
        >
          <p className="text-[13px] font-semibold">
            {soat.report.blockers.length
              ? `Đơn này chưa nên gửi: ${soat.report.blockers.length} trường chưa đạt`
              : `Gửi được, nhưng ${soat.report.warnings.length} con số sẽ sai về sau`}
          </p>
          <ul className="mt-2 space-y-1.5">
            {soat.report.findings.map((f) => (
              <li key={f.code} className="text-[12.5px]">
                <span className={cn("mr-1.5 rounded px-1.5 py-0.5 text-[10.5px] font-semibold", SEVERITY_TONE[f.severity])} title={SEVERITY_LABEL[f.severity]}>
                  {f.field}
                </span>
                {f.detail}
                <span className="block pl-1 text-muted-foreground">
                  <b>Vì sao:</b> {f.why}
                </span>
                <span className="block pl-1 text-muted-foreground">
                  <b>Sửa:</b> {f.fix}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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

          {manual && delivery ? (
            <SectionCard
              title="Giao hàng · phiếu giao có ký nhận"
              description="Đơn không qua đơn vị vận chuyển: phiếu có chữ ký người nhận là chứng từ giao. Phiếu KHÔNG phải chứng từ thanh toán — tiền chờ chứng từ riêng."
            >
              <div className="space-y-3 text-sm">
                {delivery.active ? (
                  <DescriptionList
                    columns={3}
                    items={[
                      { label: "Người nhận ký", value: formatDateTime(delivery.active.signedAt) },
                      { label: "Người ký nhận", value: delivery.active.receiverName },
                      { label: "Ghi vào ERP", value: `${formatDateTime(delivery.active.recordedAt)}${delivery.active.recordedByName ? ` · ${delivery.active.recordedByName}` : ""}` },
                      { label: "Tiền", value: payment?.state.status === "PAID" ? "Đã thu đủ theo chứng từ" : "Chưa xác minh — theo chứng từ thanh toán bên dưới" },
                      ...(delivery.active.note ? [{ label: "Ghi chú", value: delivery.active.note }] : []),
                    ]}
                  />
                ) : (
                  <p className="text-muted-foreground">
                    {order.stage === "CONFIRMED"
                      ? "Chưa có phiếu giao — hàng còn giữ trong kho (khả dụng đã trừ phần này)."
                      : order.stage === "RETURNED"
                        ? "Giao KHÔNG thành công — đơn tính là hoàn, hàng đã quay lại tồn."
                        : "Chỉ đơn «Đã xác nhận» mới xác nhận giao được."}
                  </p>
                )}
                {delivery.priorIssues.length ? (
                  <p className="rounded-md bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
                    Đơn này đã có {delivery.priorIssues.length} phiếu XUẤT TAY cũ ({delivery.priorIssues.map((r) => `${formatNumber(r.totalQuantity)} cái · ${formatDateTime(r.receivedAt)}`).join("; ")}). Xác nhận giao cũng trừ tồn, nên kho phải lập MỘT phiếu
                    điều chỉnh tăng đúng bằng số đó (tham chiếu «hoàn phiếu xuất — đơn {manualOrderShortCode(order.id)} đã xác nhận giao»). ERP không tự sửa dữ liệu kho.
                  </p>
                ) : null}
                {canDeliver || canVoidDelivery || canFail || canUndoFail ? (
                  <div className="flex flex-wrap gap-2">
                    {canDeliver ? <ConfirmManualDeliveryButton orderId={order.id} /> : null}
                    {canFail ? <ManualDeliveryFailedButton orderId={order.id} mode="FAIL" /> : null}
                    {canUndoFail ? <ManualDeliveryFailedButton orderId={order.id} mode="UNDO" /> : null}
                    {canVoidDelivery ? <VoidManualDeliveryButton orderId={order.id} /> : null}
                  </div>
                ) : null}
                {delivery.voided.length ? (
                  <ul className="space-y-1 border-t pt-2 text-[12px] text-muted-foreground">
                    {delivery.voided.map((v) => (
                      <li key={v.id}>
                        Phiếu đã huỷ: ký {formatDateTime(v.signedAt)} · {v.receiverName} — huỷ {formatDateTime(v.voidedAt)}
                        {v.voidedByName ? ` bởi ${v.voidedByName}` : ""}: {v.voidReason}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </SectionCard>
          ) : null}

          {manual && payment ? (
            <SectionCard
              title="Thanh toán · chứng từ thu / hoàn tiền"
              description="Tiền của đơn tạo tay đi theo CHỨNG TỪ THANH TOÁN, không theo phiếu giao: giao rồi chưa chắc đã thu, thu trước khi giao vẫn hợp lệ. Ghi nhầm thì huỷ chứng từ (có lý do), không xoá."
            >
              <div className="space-y-3 text-sm">
                <DescriptionList
                  columns={3}
                  items={[
                    { label: "Trạng thái thanh toán", value: <ManualPaymentStatusText state={payment.state} className="text-sm" /> },
                    { label: "Khách phải trả", value: <Money value={payment.state.amountDue} /> },
                    { label: "Đã thu ròng (thu − hoàn)", value: <Money value={payment.state.net} /> },
                    payment.state.overpaid > 0 ? { label: "Thu thừa", value: <Money value={payment.state.overpaid} /> } : { label: "Còn phải thu", value: <Money value={payment.state.outstanding} /> },
                  ]}
                />
                {payment.payments.length ? (
                  <div className="overflow-x-auto rounded-md border">
                    <Table className="min-w-[560px]">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Chứng từ</TableHead>
                          <TableHead>Mốc tiền</TableHead>
                          <TableHead className="text-right">Số tiền</TableHead>
                          <TableHead>Người ghi</TableHead>
                          <TableHead />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {payment.payments.map((pm) => (
                          <TableRow key={pm.id} className={pm.status === "VOIDED" ? "text-muted-foreground" : undefined}>
                            <TableCell>
                              <div className={cn("font-medium", pm.status === "VOIDED" && "line-through")}>{PAYMENT_KIND_LABEL[pm.kind]} · {PAYMENT_METHOD_LABEL[pm.method]}</div>
                              {pm.reference || pm.note ? <div className="text-[11.5px] text-muted-foreground">{[pm.reference, pm.note].filter(Boolean).join(" · ")}</div> : null}
                              {pm.status === "VOIDED" ? <div className="text-[11.5px]">Đã huỷ {formatDateTime(pm.voidedAt)}{pm.voidedByName ? ` bởi ${pm.voidedByName}` : ""}: {pm.voidReason}</div> : null}
                            </TableCell>
                            <TableCell className="whitespace-nowrap">{formatDateTime(pm.paidAt)}</TableCell>
                            <TableCell className={cn("text-right font-semibold", pm.status === "VOIDED" && "line-through")}>
                              <Money value={pm.kind === "REFUND" ? -pm.amount : pm.amount} />
                            </TableCell>
                            <TableCell className="text-[12px]">{pm.createdByName || "—"}</TableCell>
                            <TableCell className="text-right">{canPay && pm.status === "CONFIRMED" ? <VoidManualPaymentButton orderId={order.id} paymentId={pm.id} /> : null}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <p className="text-muted-foreground">Chưa có chứng từ thanh toán nào — tiền của đơn đang CHƯA XÁC MINH (không phải 0 ₫, không phải đã thu).</p>
                )}
                {canReceipt || canRefund ? <RecordManualPaymentButton orderId={order.id} allowReceipt={canReceipt} allowRefund={canRefund} suggestedAmount={payment.state.outstanding} /> : null}
              </div>
            </SectionCard>
          ) : null}

          <SectionCard
            title={attempts.length > 1 ? `Vận chuyển & COD · ${attempts.length} lần gửi` : "Vận chuyển & COD"}
            description={s ? `${s.carrier} · cập nhật ${formatDateTime(s.vtpStatusDate ?? s.updatedAt)}` : "Đơn chưa được đẩy sang đơn vị vận chuyển"}
            actions={s ? <Link href={`/shipments/${s.id}`} className="text-xs font-semibold text-primary hover:underline">Chi tiết vận đơn</Link> : null}
          >
            {attempts.length ? (
              <div className="space-y-5">
                {attempts.map((s, idx) => {
              const vtpUrl = getViettelPostTrackingUrl(s.vtpOrderNumber);
              return (
              <div key={s.id} className={cn("space-y-4", idx > 0 && "border-t pt-5")}>
                {/* SỐ THỨ TỰ + CHIỀU: đơn gửi lại phải đọc được như một dòng thời gian, không phải
                    một trạng thái duy nhất. Lần huỷ trước đó vẫn là chứng từ có thật. */}
                {attempts.length > 1 ? (
                  <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                    <span className="rounded-md bg-primary/10 px-2 py-0.5 font-semibold text-primary">Lần gửi {s.attemptNo ?? idx + 1}</span>
                    {s.direction ? <span className="rounded-md border px-2 py-0.5 text-muted-foreground">{SHIPMENT_DIRECTION_LABEL[s.direction] ?? s.direction}</span> : null}
                    <span className="text-muted-foreground">tạo {formatDateTime(s.createdAt)}</span>
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center gap-3">
                  <ShipmentStageBadge stage={s.stage} label={s.vtpStatusName ?? undefined} className="text-xs" />
                  <CodStatusBadge status={s.codStatus} className="text-xs" />
                  {s.vtpOrderNumber || s.trackingCode ? (
                    <span className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-xs">
                      {s.vtpOrderNumber ?? s.trackingCode}
                      <CopyButton value={s.vtpOrderNumber ?? s.trackingCode ?? ""} what="mã vận đơn" />
                    </span>
                  ) : null}
                  {vtpUrl ? (
                    <a className="text-xs font-semibold text-primary hover:underline" href={vtpUrl} target="_blank" rel="noopener noreferrer">
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
                );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Khi Pancake đẩy đơn sang Viettel Post, mã vận đơn và hành trình sẽ xuất hiện tại đây.</p>
            )}
          </SectionCard>

          {/* DÒNG THỜI GIAN TRUY VẾT — gộp năm chiều sự thật vào một chỗ, mỗi mốc mang theo nguồn
              và sức nặng của nguồn đó. Trước đây muốn hiểu vì sao một con số trông sai thì phải mở
              năm nơi khác nhau rồi tự xếp theo thời gian trong đầu. */}
          <SectionCard
            title="Dòng thời gian đầy đủ"
            description="Đơn · giao vận · tiền · kho · người dùng — xếp theo thời gian, ghi rõ nguồn"
            hint="Cùng một câu 'đã giao': Viettel Post nói thì QUYẾT ĐỊNH kết quả đơn, Pancake nói thì chỉ là bối cảnh. Nhãn nguồn cạnh mỗi mốc nói rõ điều đó, để không ai kết luận sai từ một dòng trông có vẻ đủ."
          >
            <EntityTimeline entries={timeline} />
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
          {risk?.risky ? (
            <div className={cn("rounded-xl border p-3 text-sm", risk.severity === "critical" ? "border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100" : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100")}>
              <div className="font-semibold">⚠ Khách rủi ro — nên xin cọc / xác nhận kỹ trước khi gửi ĐVVC</div>
              <div className="mt-0.5 text-xs">Giao thành công {risk.succeed} · hoàn {risk.returned}{risk.rate ? ` (${Math.round(risk.rate * 100)}%)` : ""} · {risk.reasons.join(", ")} (theo Pancake và lịch sử vận đơn cùng SĐT trong ERP)</div>
            </div>
          ) : null}
          {newPhone ? (
            <div className="rounded-xl border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100">
              <div className="font-semibold">📱 Khách mới tại shop — chưa có đơn nào khác cùng SĐT</div>
              <div className="mt-0.5 text-xs">Kiểm tra lịch sử SĐT toàn Pancake cạnh số điện thoại trên Pancake: nếu SĐT màu xanh (chưa từng mua ở đâu) thì hỏi khách xác nhận số {order.billPhone} đã đúng chưa và xin số phụ trước khi gửi hàng. Gắn thẻ “SĐT mới” cho đơn trên Pancake để bot ERP tự nhắn.</div>
            </div>
          ) : null}
          <SectionCard title="Khách hàng" actions={order.customer ? <Link href={`/customers/${order.customer.id}`} className="text-xs font-semibold text-primary hover:underline">Hồ sơ</Link> : null}>
            <div className="space-y-3 text-sm">
              <p className="flex items-center gap-2 font-semibold"><User className="size-4 text-muted-foreground" />{order.billFullName || order.shipFullName || "—"}</p>
              <p className="flex items-center gap-2"><Phone className="size-4 text-muted-foreground" />{order.billPhone || "—"} <CopyButton value={order.billPhone} what="SĐT" /></p>
              <p className="flex items-start gap-2"><MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span>{order.shipFullAddress || order.shipAddress || "—"}</span></p>
              {thieuThongTin ? (
                <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50/70 p-2.5 text-xs leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
                  <p className="font-semibold">Đơn thiếu {[order.billPhone ? "" : "SĐT", order.shipFullAddress || order.shipAddress ? "" : "địa chỉ"].filter(Boolean).join(" và ")} · chưa gửi được đơn vị vận chuyển</p>
                  {prev ? (
                    <>
                      <p className="mt-1">
                        Khách cũ, lấy lại từ đơn{" "}
                        <Link href={`/orders/${prev.orderId}`} className="font-semibold underline">#{prev.systemId ?? ""}</Link> ngày {formatDateTime(prev.insertedAt)}
                        {prev.matchedBy === "customer" ? " (cùng khách Pancake)" : prev.matchedBy === "conversation" ? " (cùng hội thoại)" : " (trùng SĐT)"}:
                      </p>
                      <p className="mt-1 flex items-center gap-2"><Phone className="size-3.5" /><span className="font-medium">{prev.phone}</span> <CopyButton value={prev.phone} what="SĐT" /></p>
                      <p className="mt-0.5 flex items-start gap-2"><MapPin className="mt-0.5 size-3.5 shrink-0" /><span className="font-medium">{prev.address}</span> <CopyButton value={prev.address} what="địa chỉ" /></p>
                      <p className="mt-1.5 opacity-80">Hỏi khách xác nhận còn đúng địa chỉ này không rồi điền vào đơn trên Pancake (khách có thể đã chuyển nhà).</p>
                    </>
                  ) : (
                    <p className="mt-1 opacity-80">Không tìm thấy đơn cũ của khách để lấy lại thông tin. Nhắn hỏi khách SĐT và địa chỉ trước khi gửi hàng.</p>
                  )}
                  {order.pageId && order.conversationId ? (
                    <a href={`https://pancake.vn/${order.pageId}?c_id=${order.conversationId}`} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 font-semibold underline">
                      <ExternalLink className="size-3.5" /> Mở hội thoại Pancake
                    </a>
                  ) : null}
                </div>
              ) : null}
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
          <ReverseRelationsCard objectKey="order" recordId={order.id} user={user} />
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

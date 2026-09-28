import Link from "next/link";
import { CircleCheck, ExternalLink, PackageCheck, PackageX } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { ScopeDenied } from "@/components/scope-denied";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { OrderStage, ShipmentStage } from "@/db/schema";
import { requireResource } from "@/lib/auth/scope-guard";
import { ORDER_STAGE_LABEL, pancakeConversationUrl, pancakePosOrderSearchUrl, pancakePosOrderUrlFromLink } from "@/lib/constants/pancake";
import { VALIDATION_RULES, type ValidationCode } from "@/lib/constants/preship-validation";
import { getViettelPostTrackingUrl, SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";
import { formatDate, formatDateTime, formatNumber, formatTimeAgo, formatVND, maskPhone } from "@/lib/format";
import { listReservedQueue, type ReservedLineFinding, type ReservedQueueLine } from "@/lib/queries/stock";
import { PhoneReputationProvider, PhoneRiskSummary, PhoneWarningCell, ReturnRateCell } from "@/app/(dashboard)/products/reserved/reputation";
import { loadAlertConfig } from "@/lib/alerts/config";
import { RiskToolbar, SortHead, SortedRows } from "@/app/(dashboard)/products/reserved/risk-view";
import { PosPushBar, PosPushCheckbox, PosPushProvider, PosPushSelectAll, type PosCandidate } from "@/app/(dashboard)/products/reserved/pos-push";
import { ORDER_PACK_LABEL, orderPackState, packStateDetail, type OrderPackState, type OrderStockVerdict } from "@/lib/constants/stock-shortage";
import { getStockShortage } from "@/lib/queries/stock-shortage";
import { cn } from "@/lib/utils";

export const metadata = { title: "Đơn chờ xuất" };

/**
 * ═══════════ ĐƠN ĐÃ CHỐT ĐANG CHỜ XUẤT — CHI TIẾT CỦA Ô "CHỜ XUẤT" TRÊN TRANG SẢN PHẨM ═══════════
 *
 * Mở từ số "chờ xuất N" dưới cột Đã xuất: `?variant=` cho một mẫu mã, `?product=` cho dòng mã hàng.
 * Danh sách đọc ĐÚNG vị ngữ `RESERVED_IN_WAREHOUSE` của sổ kho, rồi TÁCH theo bản soát trước khi
 * gửi (`listReservedQueue`): đơn còn lỗi chặn gửi (thiếu SĐT, địa chỉ, thông tin hàng) chưa đủ điều
 * kiện vào hàng đợi xuất và đứng ở mục riêng, nói rõ thiếu gì. Hai mục cộng lại = con số vừa bấm.
 *
 * Đơn đủ thông tin lại tách theo HÀNG TRONG KHO (chủ shop yêu cầu 28/09/2026): kết luận cấp đơn của
 * bảng phân bổ `allocateStock` (tồn thực tế sổ kho, đơn lên trước được hàng trước) — CÙNG bảng mà
 * trang Thiếu hàng và hàng đợi fulfillment đọc, không có phép tính thứ hai. Chỉ đơn "có hàng" mới là
 * đơn kho in, đóng và gửi Viettel Post được; chúng chọn được để mở một lượt trên POS (`pos-push.tsx`).
 * Chỉ đọc — ERP không đẩy đơn sang ĐVVC.
 */
export default async function ReservedOrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { decision } = await requireResource("INVENTORY", "products:view");
  if (decision.allow === "NONE") return <ScopeDenied title="Đơn chờ xuất" reason={decision.reason} fix={decision.fix} />;
  const sp = await searchParams;
  const variantId = typeof sp.variant === "string" && sp.variant ? sp.variant : null;
  const productId = typeof sp.product === "string" && sp.product ? sp.product : null;
  if (!variantId && !productId) {
    return (
      <div className="space-y-5">
        <PageHeader eyebrow="Kho" title="Đơn chờ xuất" />
        <EmptyState title="Chưa chọn mẫu mã" description="Mở trang này bằng cách bấm số “chờ xuất” trong bảng Sản phẩm & tồn kho." icon={PackageCheck} />
      </div>
    );
  }

  const [{ scope, ready, incomplete }, alertCfg, shortage] = await Promise.all([
    listReservedQueue(variantId ? { variantId } : { productId: productId as string }),
    // Ngưỡng rủi ro uy tín SĐT — nguồn duy nhất là cấu hình cảnh báo. Không đọc được ⇒ không gắn cảnh báo.
    loadAlertConfig().catch(() => null),
    // Không đọc được sổ kho ⇒ KHÔNG kết luận có / không có hàng (mọi đơn về một mục như cũ), không đoán.
    getStockShortage().catch(() => null),
  ]);
  const thresholds = alertCfg ? { phoneRiskReturnRatePct: alertCfg.phoneRiskReturnRatePct, phoneRiskWarningCount: alertCfg.phoneRiskWarningCount, phoneRiskMinOrders: alertCfg.phoneRiskMinOrders } : null;
  if (!scope) {
    return (
      <div className="space-y-5">
        <PageHeader eyebrow="Kho" title="Đơn chờ xuất" />
        <EmptyState title="Không tìm thấy mẫu mã" description="Mẫu mã hoặc sản phẩm này không còn trong danh mục." icon={PackageCheck} />
      </div>
    );
  }

  const units = (lines: ReservedQueueLine[]) => lines.reduce((t, l) => t + l.quantity, 0);
  const orders = (lines: ReservedQueueLine[]) => new Set(lines.map((l) => l.orderId)).size;
  const byProduct = !scope.variant;
  const title = scope.variant ? `${scope.productName} · ${scope.variant.label || scope.variant.sku}` : scope.productName;
  const stock = shortage?.orders ?? null;
  const packOf = (l: ReservedQueueLine): OrderPackState => orderPackState(stock?.get(l.orderId));
  const packable = stock ? ready.filter((l) => packOf(l) === "PACKABLE") : ready;
  const noStock = stock ? ready.filter((l) => packOf(l) === "NO_STOCK") : [];
  const unsure = stock ? ready.filter((l) => packOf(l) === "STOCK_UNKNOWN" || packOf(l) === "NOT_ALLOCATED") : [];
  const posCandidates: PosCandidate[] = [...new Map(packable.map((l) => [l.orderId, { orderId: l.orderId, systemId: l.systemId ?? null, shopId: l.shopId, hasShipment: Boolean(l.shipmentCode) }])).values()];

  return (
    <PhoneReputationProvider orderIds={[...new Set([...ready, ...incomplete].map((l) => l.orderId))]} thresholds={thresholds}>
    <div className="space-y-5">
      <PageHeader
        eyebrow="Kho · Đơn chờ xuất"
        title={title}
        description={
          stock
            ? `${formatNumber(orders(packable))} đơn có hàng, đóng gói & gửi VTP được · ${formatNumber(orders(noStock))} đơn không có hàng để đóng${unsure.length ? ` · ${formatNumber(orders(unsure))} đơn chưa biết tồn` : ""}${incomplete.length ? ` · ${formatNumber(orders(incomplete))} đơn thiếu thông tin` : ""}`
            : `${formatNumber(orders(ready))} đơn · ${formatNumber(units(ready))} sản phẩm đủ điều kiện xuất${incomplete.length ? ` · ${formatNumber(orders(incomplete))} đơn thiếu thông tin chưa vào hàng đợi` : ""}`
        }
        hint={
          <>
            Đơn <b>đã chốt</b> mà hàng <b>chưa rời kho</b> (chưa có xác nhận lấy hàng của Viettel Post), gồm cả đơn chưa
            tạo vận đơn. Đơn còn lỗi <b>chặn gửi</b> của bản Soát đơn trước khi gửi — thiếu/sai SĐT, thiếu hoặc quá ngắn
            địa chỉ, thiếu tỉnh, không có hàng, thiếu màu/size, số lượng sai — <b>chưa đủ điều kiện vào hàng đợi xuất</b>{" "}
            và đứng ở mục riêng bên dưới. Đơn đó VẪN giữ hàng trong kho (đã chốt với khách), nên hai mục cộng lại đúng
            bằng số &ldquo;chờ xuất&rdquo; trên trang Sản phẩm và Khả dụng bán không đổi. Đơn chờ lâu nhất đứng đầu.
            <br />
            <br />
            <b>Có hàng / không có hàng</b>: tồn thực tế của sổ kho (phiếu kho − đã xuất qua ĐVVC) được phân cho các đơn đã chốt theo thứ tự <b>ai lên đơn trước được hàng trước</b> (đơn khách hẹn giao xa xếp cuối) — cùng bảng với trang Thiếu hàng. Kho đóng CẢ ĐƠN, nên đơn nhiều món mà thiếu một món là &ldquo;không có hàng để đóng&rdquo;. Tồn Pancake không dùng để tính. Bảng phân bổ cập nhật mỗi phút.
          </>
        }
        actions={
          scope.variant ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/products/reserved?product=${encodeURIComponent(scope.productId)}`}>Cả mã hàng</Link>
            </Button>
          ) : undefined
        }
      />

      <PhoneRiskSummary labels={Object.fromEntries([...ready, ...incomplete].map((l) => [l.orderId, `#${l.systemId ?? l.orderId}`]))} />

      {ready.length + incomplete.length ? <RiskToolbar orderIds={[...ready, ...incomplete].map((l) => l.orderId)} /> : null}

      <PosPushProvider candidates={posCandidates}>
        <SectionCard
          title={stock ? `Có hàng — đóng gói & gửi VTP được · ${formatNumber(orders(packable))} đơn` : `Đủ điều kiện xuất · ${formatNumber(orders(ready))} đơn`}
          description={stock ? "Đủ SĐT, địa chỉ, thông tin hàng VÀ kho có đủ hàng cho cả đơn — chọn đơn, mở trên POS để đẩy sang Viettel Post, rồi kho in đơn và đóng hàng." : "Đủ SĐT, địa chỉ và thông tin hàng. Chưa đọc được sổ kho nên chưa tách được đơn có hàng / không có hàng."}
          actions={stock && posCandidates.length ? <PosPushBar /> : undefined}
          padded={false}
        >
          {packable.length === 0 ? (
            <EmptyState className="m-4" title="Không có đơn nào đóng được ngay" description={ready.length ? "Các đơn đủ thông tin đều đang chờ hàng hoặc chưa biết tồn — xem các mục bên dưới." : incomplete.length ? "Mọi đơn đang giữ hàng đều còn thiếu thông tin — xem mục bên dưới." : "Các đơn đã được Viettel Post lấy hàng, hoặc đã huỷ."} icon={PackageCheck} />
          ) : (
            <ReadyTable lines={packable} byProduct={byProduct} stock={stock} selectable={Boolean(stock)} />
          )}
        </SectionCard>
      </PosPushProvider>

      {noStock.length ? (
        <SectionCard
          title={`Không có hàng để đóng · ${formatNumber(orders(noStock))} đơn`}
          description="Đủ thông tin nhưng tồn kho đã phân hết cho đơn lên trước — CHƯA đẩy VTP, chưa in đơn / đóng hàng. CSKH báo khách chờ hoặc đổi màu/size."
          actions={
            <Button asChild variant="outline" size="sm">
              <Link href="/inventory/shortage">
                <PackageX className="size-4" /> Thiếu hàng giao đơn
              </Link>
            </Button>
          }
          padded={false}
        >
          <ReadyTable lines={noStock} byProduct={byProduct} stock={stock} />
        </SectionCard>
      ) : null}

      {unsure.length ? (
        <SectionCard title={`Chưa biết tồn · ${formatNumber(orders(unsure))} đơn`} description="Mẫu chưa có phiếu nhập kho (hoặc đơn vừa lên) — ERP không biết còn hay hết; kho đếm tay trước khi đẩy VTP." padded={false}>
          <ReadyTable lines={unsure} byProduct={byProduct} stock={stock} />
        </SectionCard>
      ) : null}

      {incomplete.length ? (
        <SectionCard
          title={`Chưa đủ thông tin · chưa vào hàng đợi xuất · ${formatNumber(orders(incomplete))} đơn`}
          description="Đã chốt và đang giữ hàng, nhưng gửi đi thì gần như chắc chắn hỏng. Bổ sung trên Pancake — đồng bộ xong đơn tự chuyển lên mục trên."
          actions={
            <Button asChild variant="outline" size="sm">
              <Link href="/operations/preship">Soát đơn trước khi gửi</Link>
            </Button>
          }
          padded={false}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Đơn</TableHead>
                <SortHead column="tao">Tạo đơn</SortHead>
                <TableHead>Khách</TableHead>
                <SortHead column="hoan" className="text-right" title="Theo Pancake, trên mọi shop dùng Pancake: đơn thất bại ÷ (thành công + thất bại) của SĐT khách — cùng công thức cột 'Tỷ lệ hoàn' trên POS. Không phải kết quả đơn của ERP. Bấm để xếp rủi ro thấp → cao.">Tỷ lệ hoàn · Pancake</SortHead>
                <SortHead column="bao" className="text-right" title="Số lần SĐT bị shop khác báo trên Pancake — cùng cột 'Cảnh báo SĐT' trên POS. Rê chuột vào số để xem lý do.">Cảnh báo SĐT</SortHead>
                {byProduct ? <TableHead>Mẫu mã</TableHead> : null}
                <SortHead column="sl" className="text-right">SL</SortHead>
                <TableHead>Còn thiếu</TableHead>
                {stock ? <TableHead>Hàng trong kho</TableHead> : null}
                <TableHead>Mở</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <SortedRows
                colSpan={8 + (byProduct ? 1 : 0) + (stock ? 1 : 0)}
                rows={incomplete.map((l, i) => ({
                  key: `${l.orderId}-${l.variantId}-${i}`,
                  orderId: l.orderId,
                  insertedAt: new Date(l.insertedAt).getTime(),
                  qty: l.quantity,
                  value: l.orderValue,
                  node: (
                    <TableRow key={`${l.orderId}-${l.variantId}-${i}`}>
                      <TableCell>
                        <OrderLink line={l} />
                      </TableCell>
                      <CreatedCell line={l} />
                      <CustomerCell line={l} />
                      <ReturnRateCell orderId={l.orderId} />
                      <PhoneWarningCell orderId={l.orderId} />
                      {byProduct ? <VariantCell line={l} /> : null}
                      <QtyCell line={l} />
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {l.blockers.map((f, k) => (
                            <span key={k} className="rounded bg-rose-100 px-1.5 py-0.5 text-[10.5px] font-medium text-rose-800 dark:bg-rose-950/60 dark:text-rose-300" title={ruleOf(f.code)?.fix}>
                              {ruleOf(f.code)?.field ?? f.field}
                              {f.code === "PHONE_MALFORMED" ? " sai dạng" : f.code === "ADDRESS_TOO_SHORT" ? " quá ngắn" : ""}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                      {stock ? <StockCell line={l} verdict={stock.get(l.orderId)} /> : null}
                      <LinksCell line={l} />
                    </TableRow>
                  ),
                }))}
              />
            </TableBody>
          </Table>
        </SectionCard>
      ) : null}
    </div>
    </PhoneReputationProvider>
  );
}

const PACK_TONE: Record<OrderPackState, string> = {
  PACKABLE: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  NO_STOCK: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  STOCK_UNKNOWN: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  NOT_ALLOCATED: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};

/** Có hàng để đóng CẢ ĐƠN hay không — kết luận của bảng phân bổ, không tính lại ở đây. */
function StockCell({ line, verdict }: { line: ReservedQueueLine; verdict: OrderStockVerdict | undefined }) {
  const state = orderPackState(verdict);
  return (
    <TableCell className="max-w-[220px]">
      <span className={cn("rounded px-1.5 py-0.5 text-[10.5px] font-semibold whitespace-nowrap", PACK_TONE[state])}>{ORDER_PACK_LABEL[state]}</span>
      {state !== "PACKABLE" ? <div className="mt-0.5 text-[10.5px] text-muted-foreground">{packStateDetail(verdict, line.variantId)}</div> : null}
    </TableCell>
  );
}

/** Bảng đơn đủ thông tin — dùng cho cả ba mục có hàng / không có hàng / chưa biết tồn. */
function ReadyTable({ lines, byProduct, stock, selectable = false }: { lines: ReservedQueueLine[]; byProduct: boolean; stock: Map<string, OrderStockVerdict> | null; selectable?: boolean }) {
  // Mục chọn được là mục "Có hàng" — tiêu đề mục đã nói điều đó, cột riêng chỉ làm bảng tràn ngang.
  const showStock = Boolean(stock) && !selectable;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {selectable ? (
            <TableHead className="w-8">
              <PosPushSelectAll />
            </TableHead>
          ) : null}
          <TableHead>Đơn</TableHead>
          <SortHead column="tao">Tạo đơn</SortHead>
          <TableHead>Khách</TableHead>
          <SortHead column="hoan" className="text-right" title="Theo Pancake, trên mọi shop dùng Pancake: đơn thất bại ÷ (thành công + thất bại) của SĐT khách — cùng công thức cột 'Tỷ lệ hoàn' trên POS. Không phải kết quả đơn của ERP. Bấm để xếp rủi ro thấp → cao.">Tỷ lệ hoàn · Pancake</SortHead>
          <SortHead column="bao" className="text-right" title="Số lần SĐT bị shop khác báo trên Pancake — cùng cột 'Cảnh báo SĐT' trên POS. Rê chuột vào số để xem lý do.">Cảnh báo SĐT</SortHead>
          {byProduct ? <TableHead>Mẫu mã</TableHead> : null}
          <SortHead column="sl" className="text-right">SL</SortHead>
          {showStock ? <TableHead>Hàng trong kho</TableHead> : null}
          <TableHead>Vận đơn · trạng thái</TableHead>
          <TableHead>Hẹn khách</TableHead>
          <SortHead column="giaTri" className="text-right">Giá trị đơn</SortHead>
          <TableHead>Mở</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <SortedRows
          colSpan={10 + (selectable ? 1 : 0) + (byProduct ? 1 : 0) + (showStock ? 1 : 0)}
          rows={lines.map((l, i) => ({
            key: `${l.orderId}-${l.variantId}-${i}`,
            orderId: l.orderId,
            insertedAt: new Date(l.insertedAt).getTime(),
            qty: l.quantity,
            value: l.orderValue,
            node: (
              <TableRow key={`${l.orderId}-${l.variantId}-${i}`}>
                {selectable ? (
                  <TableCell>
                    <PosPushCheckbox orderId={l.orderId} systemId={l.systemId ?? null} />
                  </TableCell>
                ) : null}
                <TableCell>
                  <OrderLink line={l} />
                  <div className="mt-0.5 flex items-center gap-1 text-[10.5px] font-medium text-emerald-700 dark:text-emerald-400">
                    <CircleCheck className="size-3" aria-hidden /> Đủ thông tin
                  </div>
                  {l.warnings.length ? <FindingList findings={l.warnings} className="text-amber-700 dark:text-amber-400" prefix="Lưu ý: " /> : null}
                </TableCell>
                <CreatedCell line={l} />
                <CustomerCell line={l} />
                <ReturnRateCell orderId={l.orderId} />
                <PhoneWarningCell orderId={l.orderId} />
                {byProduct ? <VariantCell line={l} /> : null}
                <QtyCell line={l} />
                {showStock && stock ? <StockCell line={l} verdict={stock.get(l.orderId)} /> : null}
                <TableCell>
                  {l.shipmentCode ? (
                    <>
                      <div className="font-mono text-xs">{l.shipmentCode}</div>
                      <div className="text-[10.5px] text-muted-foreground">{l.shipmentStage ? (SHIPMENT_STAGE_LABEL[l.shipmentStage as ShipmentStage] ?? l.shipmentStage) : "—"}</div>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">Chưa tạo vận đơn</span>
                  )}
                  <div className="text-[10.5px] text-muted-foreground">Đơn: {ORDER_STAGE_LABEL[l.orderStage as OrderStage] ?? l.orderStage}</div>
                </TableCell>
                <TableCell className="text-xs">{l.promisedAt ? formatDate(l.promisedAt) : <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell className="text-right">
                  <span className="numeric">{formatVND(l.orderValue)}</span>
                </TableCell>
                <LinksCell line={l} />
              </TableRow>
            ),
          }))}
        />
      </TableBody>
    </Table>
  );
}

function ruleOf(code: string) {
  return code in VALIDATION_RULES ? VALIDATION_RULES[code as ValidationCode] : undefined;
}

function OrderLink({ line }: { line: ReservedQueueLine }) {
  return (
    <Link href={`/orders/${line.orderId}`} className="font-semibold hover:text-primary hover:underline">
      #{line.systemId ?? line.orderId}
    </Link>
  );
}

function CreatedCell({ line }: { line: ReservedQueueLine }) {
  return (
    <TableCell>
      <div className="text-xs">{formatDateTime(line.insertedAt)}</div>
      <div className="text-[10.5px] text-muted-foreground">{formatTimeAgo(line.insertedAt)}</div>
    </TableCell>
  );
}

function CustomerCell({ line }: { line: ReservedQueueLine }) {
  return (
    <TableCell>
      <div className="text-sm">{line.customer}</div>
      {line.phone ? <div className="font-mono text-[10.5px] text-muted-foreground">{maskPhone(line.phone)}</div> : null}
    </TableCell>
  );
}

function VariantCell({ line }: { line: ReservedQueueLine }) {
  return (
    <TableCell>
      <div className="text-sm">{line.variantLabel || "—"}</div>
      <div className="font-mono text-[10.5px] text-muted-foreground">{line.sku || "—"}</div>
    </TableCell>
  );
}

function QtyCell({ line }: { line: ReservedQueueLine }) {
  return (
    <TableCell className="text-right">
      <span className="numeric font-semibold">{formatNumber(line.quantity)}</span>
      {line.isBonus ? <div className="text-[10.5px] text-muted-foreground">tặng kèm</div> : null}
    </TableCell>
  );
}

function FindingList({ findings, className, prefix }: { findings: ReservedLineFinding[]; className: string; prefix: string }) {
  const fields = [...new Set(findings.map((f) => ruleOf(f.code)?.field ?? f.field))];
  return (
    <div className={`text-[10.5px] ${className}`} title={findings.map((f) => ruleOf(f.code)?.why).filter(Boolean).join("\n")}>
      {prefix}
      {fields.join(" · ")}
    </div>
  );
}

/**
 * BA LỐI RA NGOÀI: chat của khách trên Pancake · đơn trên POS · tra cứu vận đơn Viettel Post.
 * Thiếu khoá nào thì KHÔNG vẽ liên kết đó (không có mã vận đơn thì không có gì để tra) — một liên
 * kết mở ra trang trống làm người trực tưởng đơn không tồn tại.
 */
function LinksCell({ line }: { line: ReservedQueueLine }) {
  const links = [
    { label: "Chat", href: pancakeConversationUrl(line.pageId, line.conversationId), title: "Mở hội thoại của khách trên Pancake" },
    // Đường dẫn Pancake tự gửi (mã nội bộ POS); thiếu thì mở danh sách đơn của shop lọc theo số đơn.
    { label: "POS", href: pancakePosOrderUrlFromLink(line.posOrderLink) ?? pancakePosOrderSearchUrl(line.shopId, line.systemId), title: "Mở đơn trên POS Pancake" },
    { label: "VTP", href: getViettelPostTrackingUrl(line.shipmentCode), title: "Tra cứu vận đơn trên viettelpost.vn" },
  ];
  return (
    <TableCell>
      <div className="flex flex-wrap items-center gap-1">
        {links.map((k) =>
          k.href ? (
            <a key={k.label} href={k.href} target="_blank" rel="noreferrer" title={k.title} className="inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10.5px] font-medium hover:bg-muted hover:text-primary">
              {k.label} <ExternalLink className="size-2.5" aria-hidden />
            </a>
          ) : (
            <span key={k.label} title={`${k.title} — chưa có`} className="rounded border border-dashed px-1.5 py-0.5 text-[10.5px] text-muted-foreground/60">
              {k.label}
            </span>
          ),
        )}
      </div>
    </TableCell>
  );
}

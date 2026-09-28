import Link from "next/link";
import { CircleCheck, ExternalLink, PackageCheck } from "lucide-react";
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
import { PhoneReputationProvider, PhoneWarningCell, ReturnRateCell } from "@/app/(dashboard)/products/reserved/reputation";

export const metadata = { title: "Đơn chờ xuất" };

/**
 * ═══════════ ĐƠN ĐÃ CHỐT ĐANG CHỜ XUẤT — CHI TIẾT CỦA Ô "CHỜ XUẤT" TRÊN TRANG SẢN PHẨM ═══════════
 *
 * Mở từ số "chờ xuất N" dưới cột Đã xuất: `?variant=` cho một mẫu mã, `?product=` cho dòng mã hàng.
 * Danh sách đọc ĐÚNG vị ngữ `RESERVED_IN_WAREHOUSE` của sổ kho, rồi TÁCH theo bản soát trước khi
 * gửi (`listReservedQueue`): đơn còn lỗi chặn gửi (thiếu SĐT, địa chỉ, thông tin hàng) chưa đủ điều
 * kiện vào hàng đợi xuất và đứng ở mục riêng, nói rõ thiếu gì. Hai mục cộng lại = con số vừa bấm.
 * Chỉ đọc.
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

  const { scope, ready, incomplete } = await listReservedQueue(variantId ? { variantId } : { productId: productId as string });
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

  return (
    <PhoneReputationProvider orderIds={[...new Set([...ready, ...incomplete].map((l) => l.orderId))]}>
    <div className="space-y-5">
      <PageHeader
        eyebrow="Kho · Đơn chờ xuất"
        title={title}
        description={`${formatNumber(orders(ready))} đơn · ${formatNumber(units(ready))} sản phẩm đủ điều kiện xuất${incomplete.length ? ` · ${formatNumber(orders(incomplete))} đơn thiếu thông tin chưa vào hàng đợi` : ""}`}
        hint={
          <>
            Đơn <b>đã chốt</b> mà hàng <b>chưa rời kho</b> (chưa có xác nhận lấy hàng của Viettel Post), gồm cả đơn chưa
            tạo vận đơn. Đơn còn lỗi <b>chặn gửi</b> của bản Soát đơn trước khi gửi — thiếu/sai SĐT, thiếu hoặc quá ngắn
            địa chỉ, thiếu tỉnh, không có hàng, thiếu màu/size, số lượng sai — <b>chưa đủ điều kiện vào hàng đợi xuất</b>{" "}
            và đứng ở mục riêng bên dưới. Đơn đó VẪN giữ hàng trong kho (đã chốt với khách), nên hai mục cộng lại đúng
            bằng số &ldquo;chờ xuất&rdquo; trên trang Sản phẩm và Khả dụng bán không đổi. Đơn chờ lâu nhất đứng đầu.
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

      <SectionCard
        title={`Đủ điều kiện xuất · ${formatNumber(orders(ready))} đơn`}
        description="Đủ SĐT, địa chỉ và thông tin hàng — kho đóng gói và giao ĐVVC được ngay."
        padded={false}
      >
        {ready.length === 0 ? (
          <EmptyState className="m-4" title="Không có đơn nào đủ điều kiện xuất" description={incomplete.length ? "Mọi đơn đang giữ hàng đều còn thiếu thông tin — xem mục bên dưới." : "Các đơn đã được Viettel Post lấy hàng, hoặc đã huỷ."} icon={PackageCheck} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Đơn</TableHead>
                <TableHead>Tạo đơn</TableHead>
                <TableHead>Khách</TableHead>
                <TableHead className="text-right" title="Theo Pancake, trên mọi shop dùng Pancake: đơn thất bại ÷ (thành công + thất bại) của SĐT khách — cùng công thức cột 'Tỷ lệ hoàn' trên POS. Không phải kết quả đơn của ERP.">Tỷ lệ hoàn · Pancake</TableHead>
                <TableHead className="text-right" title="Số lần SĐT bị shop khác báo trên Pancake — cùng cột 'Cảnh báo SĐT' trên POS. Rê chuột vào số để xem lý do.">Cảnh báo SĐT</TableHead>
                {byProduct ? <TableHead>Mẫu mã</TableHead> : null}
                <TableHead className="text-right">SL</TableHead>
                <TableHead>Trạng thái đơn</TableHead>
                <TableHead>Vận đơn</TableHead>
                <TableHead>Hẹn khách</TableHead>
                <TableHead className="text-right">Giá trị đơn</TableHead>
                <TableHead>Mở</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ready.map((l, i) => (
                <TableRow key={`${l.orderId}-${l.variantId}-${i}`}>
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
                  <TableCell className="text-xs">{ORDER_STAGE_LABEL[l.orderStage as OrderStage] ?? l.orderStage}</TableCell>
                  <TableCell>
                    {l.shipmentCode ? (
                      <>
                        <div className="font-mono text-xs">{l.shipmentCode}</div>
                        <div className="text-[10.5px] text-muted-foreground">{l.shipmentStage ? (SHIPMENT_STAGE_LABEL[l.shipmentStage as ShipmentStage] ?? l.shipmentStage) : "—"}</div>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">Chưa tạo vận đơn</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{l.promisedAt ? formatDate(l.promisedAt) : <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="text-right">
                    <span className="numeric">{formatVND(l.orderValue)}</span>
                  </TableCell>
                  <LinksCell line={l} />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>

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
                <TableHead>Tạo đơn</TableHead>
                <TableHead>Khách</TableHead>
                <TableHead className="text-right" title="Theo Pancake, trên mọi shop dùng Pancake: đơn thất bại ÷ (thành công + thất bại) của SĐT khách — cùng công thức cột 'Tỷ lệ hoàn' trên POS. Không phải kết quả đơn của ERP.">Tỷ lệ hoàn · Pancake</TableHead>
                <TableHead className="text-right" title="Số lần SĐT bị shop khác báo trên Pancake — cùng cột 'Cảnh báo SĐT' trên POS. Rê chuột vào số để xem lý do.">Cảnh báo SĐT</TableHead>
                {byProduct ? <TableHead>Mẫu mã</TableHead> : null}
                <TableHead className="text-right">SL</TableHead>
                <TableHead>Còn thiếu</TableHead>
                <TableHead>Mở</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {incomplete.map((l, i) => (
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
                  <LinksCell line={l} />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SectionCard>
      ) : null}
    </div>
    </PhoneReputationProvider>
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

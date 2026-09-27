import Link from "next/link";
import { PackageCheck } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { ScopeDenied } from "@/components/scope-denied";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { OrderStage, ShipmentStage } from "@/db/schema";
import { requireResource } from "@/lib/auth/scope-guard";
import { ORDER_STAGE_LABEL } from "@/lib/constants/pancake";
import { SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";
import { formatDate, formatDateTime, formatNumber, formatTimeAgo, formatVND, maskPhone } from "@/lib/format";
import { listReservedOrderLines } from "@/lib/queries/stock";

export const metadata = { title: "Đơn chờ xuất" };

/**
 * ═══════════ ĐƠN ĐÃ CHỐT ĐANG CHỜ XUẤT — CHI TIẾT CỦA Ô "CHỜ XUẤT" TRÊN TRANG SẢN PHẨM ═══════════
 *
 * Mở từ số "chờ xuất N" dưới cột Đã xuất: `?variant=` cho một mẫu mã, `?product=` cho dòng mã hàng.
 * Danh sách đọc ĐÚNG vị ngữ `RESERVED_IN_WAREHOUSE` của sổ kho, nên tổng số cái ở đây bằng con số
 * người dùng vừa bấm — không phải một định nghĩa "chờ xuất" thứ hai. Chỉ đọc.
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

  const { scope, lines } = await listReservedOrderLines(variantId ? { variantId } : { productId: productId as string });
  if (!scope) {
    return (
      <div className="space-y-5">
        <PageHeader eyebrow="Kho" title="Đơn chờ xuất" />
        <EmptyState title="Không tìm thấy mẫu mã" description="Mẫu mã hoặc sản phẩm này không còn trong danh mục." icon={PackageCheck} />
      </div>
    );
  }

  const units = lines.reduce((t, l) => t + l.quantity, 0);
  const orders = new Set(lines.map((l) => l.orderId)).size;
  const noShipment = new Set(lines.filter((l) => !l.shipmentCode).map((l) => l.orderId)).size;
  const byProduct = !scope.variant;
  const title = scope.variant ? `${scope.productName} · ${scope.variant.label || scope.variant.sku}` : scope.productName;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Kho · Đơn chờ xuất"
        title={title}
        description={`${formatNumber(units)} sản phẩm · ${formatNumber(orders)} đơn${noShipment ? ` · ${formatNumber(noShipment)} đơn chưa tạo vận đơn` : ""}`}
        hint={
          <>
            Đơn <b>đã chốt</b> (xác nhận · đang đóng gói · chờ chuyển) mà hàng <b>chưa rời kho</b> — chưa có xác
            nhận lấy hàng của Viettel Post. Gồm cả đơn chưa tạo vận đơn. Đây đúng là số &ldquo;chờ xuất&rdquo; trên
            trang Sản phẩm: bị trừ khỏi <b>Khả dụng bán</b>, chưa trừ khỏi <b>Tồn thực tế</b>. Hàng tặng kèm cũng
            giữ hàng trong kho nên có mặt ở đây. Đơn chờ lâu nhất đứng đầu.
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

      <SectionCard padded={false}>
        {lines.length === 0 ? (
          <EmptyState className="m-4" title="Không còn đơn nào chờ xuất" description="Các đơn đã được Viettel Post lấy hàng, hoặc đã huỷ." icon={PackageCheck} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Đơn</TableHead>
                <TableHead>Tạo đơn</TableHead>
                <TableHead>Khách</TableHead>
                {byProduct ? <TableHead>Mẫu mã</TableHead> : null}
                <TableHead className="text-right">SL</TableHead>
                <TableHead>Trạng thái đơn</TableHead>
                <TableHead>Vận đơn</TableHead>
                <TableHead>Hẹn khách</TableHead>
                <TableHead className="text-right">Giá trị đơn</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((l, i) => (
                <TableRow key={`${l.orderId}-${l.variantId}-${i}`}>
                  <TableCell>
                    <Link href={`/orders/${l.orderId}`} className="font-semibold hover:text-primary hover:underline">
                      #{l.systemId ?? l.orderId}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div className="text-xs">{formatDateTime(l.insertedAt)}</div>
                    <div className="text-[10.5px] text-muted-foreground">{formatTimeAgo(l.insertedAt)}</div>
                  </TableCell>
                  <TableCell>
                    <div className="text-sm">{l.customer}</div>
                    {l.phone ? <div className="font-mono text-[10.5px] text-muted-foreground">{maskPhone(l.phone)}</div> : null}
                  </TableCell>
                  {byProduct ? (
                    <TableCell>
                      <div className="text-sm">{l.variantLabel || "—"}</div>
                      <div className="font-mono text-[10.5px] text-muted-foreground">{l.sku || "—"}</div>
                    </TableCell>
                  ) : null}
                  <TableCell className="text-right">
                    <span className="numeric font-semibold">{formatNumber(l.quantity)}</span>
                    {l.isBonus ? <div className="text-[10.5px] text-muted-foreground">tặng kèm</div> : null}
                  </TableCell>
                  <TableCell className="text-xs">{ORDER_STAGE_LABEL[l.orderStage as OrderStage] ?? l.orderStage}</TableCell>
                  <TableCell>
                    {l.shipmentCode ? (
                      <>
                        <div className="font-mono text-xs">{l.shipmentCode}</div>
                        <div className="text-[10.5px] text-muted-foreground">{l.shipmentStage ? (SHIPMENT_STAGE_LABEL[l.shipmentStage as ShipmentStage] ?? l.shipmentStage) : "—"}</div>
                      </>
                    ) : (
                      <span className="text-xs text-amber-600 dark:text-amber-400">Chưa tạo vận đơn</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{l.promisedAt ? formatDate(l.promisedAt) : <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="text-right">
                    <span className="numeric">{formatVND(l.orderValue)}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </div>
  );
}

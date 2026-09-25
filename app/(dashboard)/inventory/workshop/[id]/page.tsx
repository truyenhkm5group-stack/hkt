import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { DescriptionList, SectionCard } from "@/components/ui-bits";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can, requirePermission } from "@/lib/auth/session";
import {
  BATCH_STATUS_LABEL,
  DELIVERY_STATE_LABEL,
  DELIVERY_STATE_TONE,
  FABRIC_SOURCE_LABEL,
  PAYMENT_KIND_LABEL,
  PAYMENT_METHOD_LABEL,
  PAYMENT_STATE_LABEL,
  PAYMENT_STATE_TONE,
  type BatchStatus,
  type FabricSource,
  type PaymentKind,
  type PaymentMethod,
} from "@/lib/constants/workshop-ledger";
import { formatDate, formatNumber, formatVND } from "@/lib/format";
import { activeSupplierNames } from "@/lib/queries/suppliers";
import { getProductionBatchDetail, workshopFormOptions, type PaymentRecord, type SupplierPaymentBankLink } from "@/lib/queries/workshop-ledger";
import { cn } from "@/lib/utils";
import { BatchDialog, BatchStatusButtons, DeleteButton, DeliveryDialog, FabricDialog, PaymentDialog } from "../workshop-forms";

export const metadata = { title: "Lô đặt xưởng" };

function Chip({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={cn("inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium", tone)}>{children}</span>;
}

function PaymentRows({ payments, canPay, bankLinks }: { payments: PaymentRecord[]; canPay: boolean; bankLinks: Map<string, SupplierPaymentBankLink[]> }) {
  return (
    <>
      {payments.map((p) => (
        <TableRow key={p.id}>
          <TableCell className="whitespace-nowrap text-xs">{formatDate(p.paidAt)}</TableCell>
          <TableCell className="text-xs">{PAYMENT_KIND_LABEL[p.kind as PaymentKind] ?? p.kind}</TableCell>
          <TableCell className={cn("text-right font-medium tabular-nums", p.kind === "REFUND" && "text-emerald-600 dark:text-emerald-400")}>{formatVND(p.kind === "REFUND" ? -p.amount : p.amount)}</TableCell>
          <TableCell className="text-xs text-muted-foreground">
            {PAYMENT_METHOD_LABEL[p.method as PaymentMethod] ?? p.method}
            {bankLinks.get(p.id)?.length ? (
              <span className="ml-1 text-emerald-600 dark:text-emerald-400">✓ sao kê {bankLinks.get(p.id)?.map((x) => x.bankRef).join(", ")}</span>
            ) : p.method === "BANK" ? (
              <span className="ml-1 text-amber-600 dark:text-amber-400">· chưa đối chiếu sao kê</span>
            ) : null}
            {p.reference && !bankLinks.get(p.id)?.some((x) => x.bankRef === p.reference) ? ` · ${p.reference}` : ""}
            {p.note ? ` · ${p.note}` : ""}
            <div>{p.createdBy}</div>
          </TableCell>
          {canPay ? (
            <TableCell className="text-right">
              <DeleteButton kind="payment" id={p.id} what="đợt thanh toán" />
            </TableCell>
          ) : null}
        </TableRow>
      ))}
    </>
  );
}

export default async function WorkshopBatchPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("planning:view");
  const { id } = await params;
  const canWrite = can(user, "planning:write");
  const canPay = can(user, "expenses:write");
  const [detail, options, suppliers] = await Promise.all([getProductionBatchDetail(id), canWrite ? workshopFormOptions() : Promise.resolve(null), canWrite ? activeSupplierNames() : Promise.resolve([] as string[])]);
  if (!detail) notFound();
  const { batch: b, fabrics, productionOrder } = detail;
  const label = `${b.productCode} · lô ${b.batchNo}`;
  const deletable = b.deliveries.length === 0 && b.payments.length === 0 && fabrics.length === 0;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Đặt xưởng & thanh toán"
        title={label}
        description={[b.productName, b.supplier || "chưa ghi xưởng", BATCH_STATUS_LABEL[b.status as BatchStatus] ?? b.status].filter(Boolean).join(" · ")}
        actions={
          canWrite && options ? (
            <>
              <BatchDialog options={options} suppliers={suppliers} batch={b} />
              <BatchStatusButtons id={b.id} status={b.status} />
              {deletable ? <DeleteButton kind="batch" id={b.id} what="lô này" redirectTo="/inventory/workshop" /> : null}
            </>
          ) : null
        }
      />

      <SectionCard>
        <DescriptionList
          columns={3}
          items={[
            { label: "Ngày đặt hàng", value: formatDate(b.orderedAt) },
            {
              label: "Ngày xưởng phải trả",
              value: (
                <>
                  {b.dueDate ? formatDate(b.dueDate) : "Chưa hẹn"}
                  {b.delivery.overdueDays ? (
                    <span className="ml-2 inline-flex items-center gap-1 text-xs text-rose-600 dark:text-rose-400">
                      <AlertTriangle className="size-3" /> trễ {b.delivery.overdueDays} ngày
                    </span>
                  ) : null}
                </>
              ),
            },
            { label: "Trạng thái trả hàng", value: <Chip tone={DELIVERY_STATE_TONE[b.delivery.state]}>{DELIVERY_STATE_LABEL[b.delivery.state]}</Chip> },
            { label: "SL đặt hàng", value: formatNumber(b.orderedQty) },
            { label: "SL chốt TT với xưởng", value: b.agreedQty == null ? "Chưa chốt" : formatNumber(b.agreedQty) },
            { label: "Xưởng đã trả", value: <b>{formatNumber(b.delivered)}</b> },
            { label: "Đơn giá công", value: formatVND(b.laborUnitPrice) },
            { label: "Thưởng / phạt khác", value: b.adjustment ? `${formatVND(b.adjustment, { sign: true })}${b.adjustmentNote ? ` · ${b.adjustmentNote}` : ""}` : "Không" },
            { label: "Phạt xưởng · hoàn MKT", value: b.workshopPenalty ? `${formatVND(b.workshopPenalty)} · ${b.penaltyAt ? `ghi ${formatDate(b.penaltyAt)}` : "CHƯA có ngày ghi — chưa cộng cho MKT"}${b.penaltyNote ? ` · ${b.penaltyNote}` : ""}` : "Không" },
            { label: "MKT phụ trách", value: b.marketerName ?? "Chưa gán — khai ở Lương › Marketer phụ trách mã" },
            { label: "Ai lo vải", value: FABRIC_SOURCE_LABEL[b.fabricSource as FabricSource] ?? b.fabricSource },
            {
              label: "Bảng đặt màu × size",
              value: productionOrder ? (
                <Link href={`/inventory/planning/orders/${productionOrder.id}`} className="font-mono text-primary hover:underline">
                  {productionOrder.code} · {formatNumber(productionOrder.totalQty)} chiếc
                </Link>
              ) : (
                "Không nối"
              ),
            },
            { label: "Người lập", value: b.createdBy || "—" },
            { label: "Ghi chú", value: b.note || "—", span: true },
          ]}
        />
      </SectionCard>

      {b.variantLines.length ? (
        <SectionCard title="Theo màu / size" hint="Số đặt, số xưởng đã trả và phần còn lại của từng mẫu. Phần còn lại của lô ĐANG SẢN XUẤT được trừ vào số thiếu trên trang Thiếu hàng giao đơn." padded={false}>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Màu</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead className="text-right">Đặt</TableHead>
                  <TableHead className="text-right">Đã trả</TableHead>
                  <TableHead className="text-right">Còn lại</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {b.variantLines.map((l) => (
                  <TableRow key={l.variantId}>
                    <TableCell className="text-sm">{l.color || "—"}</TableCell>
                    <TableCell className="text-sm">{l.size || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(l.ordered)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(l.delivered)}</TableCell>
                    <TableCell className={cn("text-right font-semibold tabular-nums", l.remaining > 0 && b.status === "OPEN" && "text-sky-600 dark:text-sky-400")}>{formatNumber(l.remaining)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard title="Xưởng trả hàng" hint="Mỗi lần xưởng giao là một dòng; số âm là shop trả lại xưởng hàng lỗi. Bấm “Xưởng đã trả xong” khi xưởng báo không giao thêm — kể cả khi chưa đủ số đặt." actions={canWrite && b.status !== "CANCELLED" ? <DeliveryDialog batchId={b.id} label={label} variantLines={b.variantLines} /> : null} padded={false}>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ngày</TableHead>
                  <TableHead className="text-right">Số lượng</TableHead>
                  <TableHead>Ghi chú · người ghi</TableHead>
                  {canWrite ? <TableHead /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {b.deliveries.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={canWrite ? 4 : 3} className="py-8 text-center text-sm text-muted-foreground">
                      Chưa có đợt trả hàng nào.
                    </TableCell>
                  </TableRow>
                ) : (
                  b.deliveries.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="text-xs">{formatDate(d.deliveredAt)}</TableCell>
                      <TableCell className={cn("text-right font-medium tabular-nums", d.quantity < 0 && "text-rose-600 dark:text-rose-400")}>{formatNumber(d.quantity)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {d.note || "—"}
                        <div>{d.createdBy}</div>
                      </TableCell>
                      {canWrite ? (
                        <TableCell className="text-right">
                          <DeleteButton kind="delivery" id={d.id} what="đợt trả hàng" />
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))
                )}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="text-xs font-medium">Tổng</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{formatNumber(b.delivered)}</TableCell>
                  <TableCell colSpan={canWrite ? 2 : 1} className="text-xs text-muted-foreground">
                    / {formatNumber(b.delivery.target)} {b.agreedQty == null ? "đặt" : "chốt"}
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        </SectionCard>

        <SectionCard title="Thanh toán tiền công cho xưởng" actions={canPay ? <PaymentDialog target={{ batchId: b.id }} label={label} remaining={b.pay.remaining} /> : null} padded={false}>
          <div className="grid grid-cols-3 gap-3 border-b px-4 py-3 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Tiền công</div>
              <b className="tabular-nums">{formatVND(b.labor.amount)}</b>
              <div className="text-[11px] text-muted-foreground">{b.labor.reason}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Đã trả{b.pay.deposit ? ` (cọc ${formatVND(b.pay.deposit)})` : ""}</div>
              <b className="tabular-nums">{formatVND(b.pay.paid)}</b>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Còn phải trả</div>
              <b className={cn("tabular-nums", (b.pay.remaining ?? 0) > 0 && "text-rose-600 dark:text-rose-400")}>{formatVND(b.pay.remaining)}</b>
              <div className="mt-0.5">
                <Chip tone={PAYMENT_STATE_TONE[b.pay.state]}>{PAYMENT_STATE_LABEL[b.pay.state]}</Chip>
              </div>
            </div>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ngày</TableHead>
                  <TableHead>Loại</TableHead>
                  <TableHead className="text-right">Số tiền</TableHead>
                  <TableHead>Hình thức · người ghi</TableHead>
                  {canPay ? <TableHead /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {b.payments.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={canPay ? 5 : 4} className="py-8 text-center text-sm text-muted-foreground">
                      Chưa có đợt thanh toán nào cho xưởng.
                    </TableCell>
                  </TableRow>
                ) : (
                  <PaymentRows payments={b.payments} canPay={canPay} bankLinks={detail.bankLinks} />
                )}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      </div>

      <SectionCard
        title="Vải dùng cho lô"
        hint={b.fabricSource === "WORKSHOP" ? "Lô này khai xưởng lo vải — đơn giá công là giá trọn gói, tiền vải 0đ là thật." : "Các đợt vải đã gán vào lô. Chưa gán đợt nào thì giá SX thực tế của lô là CHƯA BIẾT."}
        actions={canWrite && options ? <FabricDialog options={options} suppliers={suppliers} defaultBatchId={b.id} /> : null}
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Đặt · về</TableHead>
                <TableHead>Nhà vải · loại vải</TableHead>
                <TableHead className="text-right">Số lượng</TableHead>
                <TableHead className="text-right">Thành tiền</TableHead>
                <TableHead className="text-right">Đã trả</TableHead>
                <TableHead className="text-right">Còn phải trả</TableHead>
                <TableHead>Thanh toán</TableHead>
                {canWrite || canPay ? <TableHead /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {fabrics.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={canWrite || canPay ? 8 : 7} className="py-8 text-center text-sm text-muted-foreground">
                    Chưa có đợt vải nào gán vào lô này.
                  </TableCell>
                </TableRow>
              ) : (
                fabrics.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {formatDate(f.orderedAt)}
                      <div className={f.receivedAt ? "text-muted-foreground" : "font-medium text-amber-600 dark:text-amber-400"}>{f.receivedAt ? `về ${formatDate(f.receivedAt)}` : "chưa về"}</div>
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="font-medium">{f.supplier || "—"}</div>
                      <div className="text-muted-foreground">{[f.description, f.note].filter(Boolean).join(" · ")}</div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right text-xs tabular-nums">
                      {f.quantity == null ? "—" : `${formatNumber(f.quantity)} ${f.unit}`}
                      {f.unitPrice != null ? <div className="text-muted-foreground">× {formatVND(f.unitPrice)}</div> : null}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{formatVND(f.amount)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatVND(f.pay.paid)}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{formatVND(f.pay.remaining)}</TableCell>
                    <TableCell>
                      <Chip tone={PAYMENT_STATE_TONE[f.pay.state]}>{PAYMENT_STATE_LABEL[f.pay.state]}</Chip>
                    </TableCell>
                    {canWrite || canPay ? (
                      <TableCell className="text-right">
                        <div className="flex justify-end">
                          {canPay ? <PaymentDialog target={{ fabricOrderId: f.id }} label={`vải ${f.description || f.productCode}`} remaining={f.pay.remaining} compact /> : null}
                          {canWrite && options ? <FabricDialog options={options} suppliers={suppliers} fabric={f} /> : null}
                        </div>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        {fabrics.some((f) => f.payments.length) ? (
          <div className="border-t px-4 py-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Các đợt trả tiền vải</p>
            <Table>
              <TableBody>
                <PaymentRows payments={fabrics.flatMap((f) => f.payments)} canPay={canPay} bankLinks={detail.bankLinks} />
              </TableBody>
            </Table>
          </div>
        ) : null}
      </SectionCard>

      <SectionCard title="Giá sản xuất thực tế của lô">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
          <span className="text-muted-foreground">(tiền vải</span>
          <b className="tabular-nums">{formatVND(b.cost.fabricCost)}</b>
          <span className="text-muted-foreground">+ tiền công</span>
          <b className="tabular-nums">{formatVND(b.cost.laborCost)}</b>
          <span className="text-muted-foreground">) ÷ xưởng thực trả</span>
          <b className="tabular-nums">{formatNumber(b.cost.delivered)}</b>
          <span className="text-muted-foreground">=</span>
          <b className="text-2xl tabular-nums">{formatVND(b.cost.unitCost)}</b>
          <span className="text-muted-foreground">/ chiếc</span>
        </div>
        <p className={cn("mt-1 text-xs", b.cost.unitCost == null ? "text-amber-600 dark:text-amber-400" : b.cost.provisional ? "text-sky-600 dark:text-sky-400" : "text-emerald-600 dark:text-emerald-400")}>{b.cost.reason}</p>
      </SectionCard>
    </div>
  );
}

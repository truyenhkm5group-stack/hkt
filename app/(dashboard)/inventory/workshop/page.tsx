import Link from "next/link";
import { AlertTriangle, Banknote, Calculator, Factory, PackageCheck, Scissors, Wallet } from "lucide-react";
import { MetricCard } from "@/components/metric-card";
import { NavLink } from "@/components/nav-progress";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can, requirePermission } from "@/lib/auth/session";
import { DELIVERY_STATE_LABEL, DELIVERY_STATE_TONE, PAYMENT_KIND_LABEL, PAYMENT_METHOD_LABEL, PAYMENT_STATE_LABEL, PAYMENT_STATE_TONE, type PaymentKind, type PaymentMethod } from "@/lib/constants/workshop-ledger";
import { formatDate, formatNumber, formatVND } from "@/lib/format";
import { activeSupplierNames } from "@/lib/queries/suppliers";
import { listMarketerPrices, type MarketerPriceRow } from "@/lib/queries/marketer-price";
import { getWorkshopLedger, workshopFormOptions, type BatchView } from "@/lib/queries/workshop-ledger";
import { param, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { DeleteMarketerPriceButton, MarketerPriceDialog } from "./marketer-price-forms";
import { SheetImportDialog } from "./sheet-import-dialog";
import { BatchDialog, DeleteButton, DeliveryDialog, FabricDialog, PaymentDialog } from "./workshop-forms";

export const metadata = { title: "Đặt xưởng & thanh toán" };

const TABS = [
  { key: "batches", label: "Lô sản xuất", icon: Factory },
  { key: "fabric", label: "Đặt / nhập vải", icon: Scissors },
  { key: "payments", label: "Đợt thanh toán", icon: Banknote },
  { key: "cost", label: "Giá SX thực tế", icon: Calculator },
] as const;
type Tab = (typeof TABS)[number]["key"];

function Chip({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={cn("inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium", tone)}>{children}</span>;
}

const ddmm = (d: Date) => formatDate(d).slice(0, 5);

function EmptyRow({ cols, children }: { cols: number; children: React.ReactNode }) {
  return (
    <TableRow>
      <TableCell colSpan={cols} className="py-10 text-center text-sm text-muted-foreground">
        {children}
      </TableCell>
    </TableRow>
  );
}

export default async function WorkshopLedgerPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("planning:view");
  const raw = await searchParams;
  const tab: Tab = (TABS.find((t) => t.key === param(raw, "tab"))?.key ?? "batches") as Tab;
  const canWrite = can(user, "planning:write");
  const canPay = can(user, "expenses:write");
  // Giá báo MKT đổi LƯƠNG của marketer ⇒ cùng quyền với "Marketer phụ trách mã".
  const canSetPrice = can(user, "payroll:manage");
  const [ledger, options, suppliers, prices] = await Promise.all([
    getWorkshopLedger(),
    canWrite || canSetPrice ? workshopFormOptions() : Promise.resolve(null),
    canWrite ? activeSupplierNames() : Promise.resolve([] as string[]),
    tab === "cost" ? listMarketerPrices() : Promise.resolve([] as MarketerPriceRow[]),
  ]);
  const { summary: s } = ledger;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Sản xuất"
        title="Đặt xưởng & thanh toán"
        hint={
          <>
            Thay bảng tính <b>BÁO CÁO ĐẶT HÀNG</b>: mỗi lô đặt xưởng, mỗi lần xưởng trả hàng, mỗi đợt vải và mỗi đợt thanh toán là một dòng. Tiền công = SL chốt × đơn giá + thưởng/phạt; còn phải trả và trạng thái thanh toán ERP tự tính. Ô để trống là CHƯA BIẾT, không phải 0đ.
            <br />
            <br />
            Sổ này là <b>công nợ và giá thành</b>, không phải chi phí: giá vốn trong báo cáo lợi nhuận vẫn chỉ lấy từ phiếu nhập kho.
          </>
        }
        actions={
          options && canWrite ? (
            <>
              {canPay ? <SheetImportDialog /> : null}
              <FabricDialog options={options} suppliers={suppliers} />
              <BatchDialog options={options} suppliers={suppliers} />
            </>
          ) : null
        }
      />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Lô đang sản xuất" value={formatNumber(s.openBatches)} note={s.overdueBatches ? `${formatNumber(s.overdueBatches)} lô trễ hạn trả` : "Không lô nào trễ hạn"} icon={Factory} tone={s.overdueBatches ? "rose" : "blue"} />
        <MetricCard label="Xưởng đã trả / đã đặt" value={`${formatNumber(s.deliveredQty)} / ${formatNumber(s.orderedQty)}`} note="Chiếc, mọi lô chưa huỷ" icon={PackageCheck} tone="green" />
        <MetricCard
          label="Còn nợ xưởng may"
          value={formatVND(s.owedWorkshop, { compact: true })}
          note={s.unpricedBatches ? `⚠ ${formatNumber(s.unpricedBatches)} lô chưa có số phải trả — không cộng vào đây` : "Tiền công còn phải trả"}
          icon={Wallet}
          tone={s.unpricedBatches ? "amber" : "primary"}
          hint="Chỉ cộng các lô đã tính được tiền công. Lô chưa nhập đơn giá (hoặc chưa chốt SL mà xưởng chưa trả chiếc nào) là CHƯA BIẾT, được đếm riêng."
        />
        <MetricCard label="Còn nợ nhà vải" value={formatVND(s.owedFabric, { compact: true })} note={`Tổng tiền vải ${formatVND(s.fabricTotal, { compact: true })}${s.fabricPending ? ` · ${formatNumber(s.fabricPending)} đợt chưa về` : ""}`} icon={Scissors} tone="slate" />
      </section>

      <div className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-muted p-0.5">
        {TABS.map((t) => (
          <NavLink
            key={t.key}
            href={t.key === "batches" ? "/inventory/workshop" : `/inventory/workshop?tab=${t.key}`}
            className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors", tab === t.key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
          >
            <t.icon className="size-3.5" /> {t.label}
          </NavLink>
        ))}
      </div>

      {tab === "batches" ? <BatchesTab batches={ledger.batches} canWrite={canWrite} canPay={canPay} /> : null}
      {tab === "fabric" ? <FabricTab ledger={ledger} options={canWrite ? options : null} suppliers={suppliers} canWrite={canWrite} canPay={canPay} /> : null}
      {tab === "payments" ? <PaymentsTab payments={ledger.payments} canPay={canPay} /> : null}
      {tab === "cost" ? <CostTab ledger={ledger} prices={prices} products={canSetPrice ? (options?.products ?? []) : null} /> : null}
    </div>
  );
}

// ─────────────────────────── LÔ SẢN XUẤT ───────────────────────────

function BatchesTab({ batches, canWrite, canPay }: { batches: BatchView[]; canWrite: boolean; canPay: boolean }) {
  const cols = canWrite || canPay ? 10 : 9;
  return (
    <SectionCard title="Lô đặt xưởng may" hint="Mỗi dòng một lô (mã + số lô). Bấm vào mã lô để xem từng đợt trả hàng, đợt vải và đợt thanh toán." padded={false}>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Lô · xưởng</TableHead>
              <TableHead>Đặt · hạn trả</TableHead>
              <TableHead className="text-right">Đặt / chốt</TableHead>
              <TableHead>Xưởng đã trả</TableHead>
              <TableHead className="text-right">Tiền công</TableHead>
              <TableHead className="text-right">Đã trả</TableHead>
              <TableHead className="text-right">Còn phải trả</TableHead>
              <TableHead>Thanh toán</TableHead>
              <TableHead>Trả hàng</TableHead>
              {cols === 10 ? <TableHead /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {batches.length === 0 ? (
              <EmptyRow cols={cols}>Chưa có lô đặt xưởng nào — bấm “Thêm lô đặt xưởng” để ghi dòng đầu tiên của trang Thành phẩm.</EmptyRow>
            ) : (
              batches.map((b) => (
                <TableRow key={b.id} className={b.status === "CANCELLED" ? "opacity-60" : ""}>
                  <TableCell>
                    <Link href={`/inventory/workshop/${b.id}`} className="font-mono font-semibold text-primary hover:underline">
                      {b.productCode} · lô {b.batchNo}
                    </Link>
                    <div className="max-w-[180px] truncate text-xs text-muted-foreground">{[b.productName, b.supplier].filter(Boolean).join(" · ") || "—"}</div>
                    <div className="text-[11px] text-muted-foreground">MKT: {b.marketerName ?? <span className="text-amber-600 dark:text-amber-400">chưa gán</span>}</div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {formatDate(b.orderedAt)}
                    <div className="text-muted-foreground">{b.dueDate ? `hạn ${formatDate(b.dueDate)}` : "chưa hẹn"}</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(b.orderedQty)}
                    <div className="text-xs text-muted-foreground">{b.agreedQty == null ? "chưa chốt" : `chốt ${formatNumber(b.agreedQty)}`}</div>
                    <div className="text-[11px] text-muted-foreground">{b.variantLines.length ? `${formatNumber(b.variantLines.length)} mẫu màu/size` : <span className="text-amber-600 dark:text-amber-400">chưa chia màu/size</span>}</div>
                  </TableCell>
                  <TableCell className="text-xs">
                    <b className="text-sm tabular-nums">{formatNumber(b.delivered)}</b>
                    {b.deliveries.length ? <div className="text-muted-foreground">{b.deliveries.map((d) => `${ddmm(d.deliveredAt)}: ${formatNumber(d.quantity)}`).join(" · ")}</div> : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatVND(b.labor.amount)}
                    <div className="text-xs text-muted-foreground" title={b.labor.reason}>
                      {b.labor.amount == null ? "chưa tính được" : `${formatNumber(b.labor.qtyBasis)} × ${formatNumber(b.laborUnitPrice)}${b.adjustment ? ` ${b.adjustment > 0 ? "+" : "−"} ${formatNumber(Math.abs(b.adjustment))}` : ""}${b.workshopPenalty ? ` − phạt ${formatNumber(b.workshopPenalty)}` : ""}${b.labor.basis === "DELIVERED_ESTIMATE" ? " · tạm tính" : ""}`}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatVND(b.pay.paid)}
                    {b.pay.deposit ? <div className="text-xs text-muted-foreground">cọc {formatVND(b.pay.deposit)}</div> : null}
                  </TableCell>
                  <TableCell className={cn("text-right font-semibold tabular-nums", (b.pay.remaining ?? 0) > 0 && "text-rose-600 dark:text-rose-400")}>{formatVND(b.pay.remaining)}</TableCell>
                  <TableCell>
                    <Chip tone={PAYMENT_STATE_TONE[b.pay.state]}>{PAYMENT_STATE_LABEL[b.pay.state]}</Chip>
                  </TableCell>
                  <TableCell>
                    <Chip tone={DELIVERY_STATE_TONE[b.delivery.state]}>{DELIVERY_STATE_LABEL[b.delivery.state]}</Chip>
                    {b.delivery.overdueDays ? (
                      <div className="mt-0.5 flex items-center gap-1 text-[11px] text-rose-600 dark:text-rose-400">
                        <AlertTriangle className="size-3" /> trễ {b.delivery.overdueDays} ngày
                      </div>
                    ) : null}
                  </TableCell>
                  {cols === 10 ? (
                    <TableCell className="text-right">
                      <div className="flex justify-end">
                        {canWrite && b.status !== "CANCELLED" ? <DeliveryDialog batchId={b.id} label={`${b.productCode} · lô ${b.batchNo}`} variantLines={b.variantLines} compact /> : null}
                        {canPay ? <PaymentDialog target={{ batchId: b.id }} label={`${b.productCode} · lô ${b.batchNo}`} remaining={b.pay.remaining} compact /> : null}
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </SectionCard>
  );
}

// ─────────────────────────── VẢI ───────────────────────────

type Ledger = Awaited<ReturnType<typeof getWorkshopLedger>>;
type Options = Awaited<ReturnType<typeof workshopFormOptions>>;

function FabricTab({ ledger, options, suppliers, canWrite, canPay }: { ledger: Ledger; options: Options | null; suppliers: string[]; canWrite: boolean; canPay: boolean }) {
  const cols = canWrite || canPay ? 9 : 8;
  const fabrics = ledger.fabrics;
  return (
    <SectionCard title="Đặt / nhập vải" hint="Mỗi dòng là một lần đặt vải (dòng của trang Vải). Gán vào lô thì tiền vải vào giá SX thực tế của lô đó." padded={false}>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Đặt · về</TableHead>
              <TableHead>Mã · lô</TableHead>
              <TableHead>Nhà vải · loại vải</TableHead>
              <TableHead className="text-right">Số lượng</TableHead>
              <TableHead className="text-right">Thành tiền</TableHead>
              <TableHead className="text-right">Đã trả</TableHead>
              <TableHead className="text-right">Còn phải trả</TableHead>
              <TableHead>Thanh toán</TableHead>
              {cols === 9 ? <TableHead /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {fabrics.length === 0 ? (
              <EmptyRow cols={cols}>Chưa có đợt vải nào — bấm “Thêm đợt vải” để ghi dòng đầu tiên của trang Vải.</EmptyRow>
            ) : (
              fabrics.map((f) => (
                <TableRow key={f.id}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {formatDate(f.orderedAt)}
                    <div className={f.receivedAt ? "text-muted-foreground" : "font-medium text-amber-600 dark:text-amber-400"}>{f.receivedAt ? `về ${formatDate(f.receivedAt)}` : "chưa về"}</div>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono font-semibold">{f.productCode}</span>
                    <div className="text-xs">
                      {f.batchId ? (
                        <Link href={`/inventory/workshop/${f.batchId}`} className="text-primary hover:underline">
                          {f.batchLabel}
                        </Link>
                      ) : (
                        <span className="text-amber-600 dark:text-amber-400">chưa gán lô</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-[220px] text-xs">
                    <div className="truncate font-medium text-foreground">{f.supplier || "—"}</div>
                    <div className="truncate text-muted-foreground">{[f.description, f.note].filter(Boolean).join(" · ")}</div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right text-xs tabular-nums">
                    {f.quantity == null ? "—" : `${formatNumber(f.quantity)} ${f.unit}`}
                    {f.unitPrice != null ? <div className="text-muted-foreground">× {formatVND(f.unitPrice)}</div> : null}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatVND(f.amount)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatVND(f.pay.paid)}
                    {f.pay.deposit ? <div className="text-xs text-muted-foreground">cọc {formatVND(f.pay.deposit)}</div> : null}
                  </TableCell>
                  <TableCell className={cn("text-right font-semibold tabular-nums", (f.pay.remaining ?? 0) > 0 && "text-rose-600 dark:text-rose-400")}>{formatVND(f.pay.remaining)}</TableCell>
                  <TableCell>
                    <Chip tone={PAYMENT_STATE_TONE[f.pay.state]}>{PAYMENT_STATE_LABEL[f.pay.state]}</Chip>
                  </TableCell>
                  {cols === 9 ? (
                    <TableCell className="text-right">
                      <div className="flex justify-end">
                        {canPay ? <PaymentDialog target={{ fabricOrderId: f.id }} label={`vải ${f.productCode}${f.description ? ` · ${f.description}` : ""}`} remaining={f.pay.remaining} compact /> : null}
                        {canWrite && options ? <FabricDialog options={options} suppliers={suppliers} fabric={f} /> : null}
                        {canWrite && f.payments.length === 0 ? <DeleteButton kind="fabric" id={f.id} what="đợt vải" /> : null}
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))
            )}
          </TableBody>
          {fabrics.length ? (
            <TableFooter>
              <TableRow>
                <TableCell colSpan={4} className="text-xs font-medium">
                  Tổng {formatNumber(fabrics.length)} đợt vải
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{formatVND(ledger.summary.fabricTotal)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatVND(fabrics.reduce((t, f) => t + f.pay.paid, 0))}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{formatVND(ledger.summary.owedFabric)}</TableCell>
                <TableCell colSpan={cols - 7} />
              </TableRow>
            </TableFooter>
          ) : null}
        </Table>
      </div>
    </SectionCard>
  );
}

// ─────────────────────────── ĐỢT THANH TOÁN ───────────────────────────

function PaymentsTab({ payments, canPay }: { payments: Ledger["payments"]; canPay: boolean }) {
  const cols = canPay ? 7 : 6;
  const total = payments.reduce((t, p) => t + (p.kind === "REFUND" ? -p.amount : p.amount), 0);
  const toWorkshop = payments.filter((p) => p.targetKind === "BATCH").reduce((t, p) => t + (p.kind === "REFUND" ? -p.amount : p.amount), 0);
  return (
    <SectionCard
      title="Từng đợt thanh toán"
      hint="Mọi lần trả tiền cho xưởng may và nhà vải, mới nhất trên cùng. Ghi thanh toán từ tab Lô sản xuất hoặc Đặt / nhập vải (nút tờ tiền) để mỗi đồng gắn đúng lô / đợt vải."
      padded={false}
    >
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ngày</TableHead>
              <TableHead>Trả cho</TableHead>
              <TableHead>Bên nhận</TableHead>
              <TableHead>Loại</TableHead>
              <TableHead className="text-right">Số tiền</TableHead>
              <TableHead>Hình thức · người ghi</TableHead>
              {canPay ? <TableHead /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {payments.length === 0 ? (
              <EmptyRow cols={cols}>Chưa có đợt thanh toán nào.</EmptyRow>
            ) : (
              payments.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="whitespace-nowrap text-xs">{formatDate(p.paidAt)}</TableCell>
                  <TableCell className="text-sm">
                    {p.batchIdForLink ? (
                      <Link href={`/inventory/workshop/${p.batchIdForLink}`} className="text-primary hover:underline">
                        {p.targetLabel}
                      </Link>
                    ) : (
                      p.targetLabel
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{p.supplierName || "—"}</TableCell>
                  <TableCell className="text-xs">{PAYMENT_KIND_LABEL[p.kind as PaymentKind] ?? p.kind}</TableCell>
                  <TableCell className={cn("text-right font-medium tabular-nums", p.kind === "REFUND" && "text-emerald-600 dark:text-emerald-400")}>{formatVND(p.kind === "REFUND" ? -p.amount : p.amount)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {PAYMENT_METHOD_LABEL[p.method as PaymentMethod] ?? p.method}
                    {p.reference ? ` · ${p.reference}` : ""}
                    <div>
                      {p.createdBy}
                      {p.note ? ` · ${p.note}` : ""}
                    </div>
                  </TableCell>
                  {canPay ? (
                    <TableCell className="text-right">
                      <DeleteButton kind="payment" id={p.id} what="đợt thanh toán" />
                    </TableCell>
                  ) : null}
                </TableRow>
              ))
            )}
          </TableBody>
          {payments.length ? (
            <TableFooter>
              <TableRow>
                <TableCell colSpan={4} className="text-xs font-medium">
                  {formatNumber(payments.length)} đợt · xưởng may {formatVND(toWorkshop)} · nhà vải {formatVND(total - toWorkshop)}
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{formatVND(total)}</TableCell>
                <TableCell colSpan={cols - 5} />
              </TableRow>
            </TableFooter>
          ) : null}
        </Table>
      </div>
    </SectionCard>
  );
}

// ─────────────────────────── GIÁ SX THỰC TẾ ───────────────────────────

function CostTab({ ledger, prices, products }: { ledger: Ledger; prices: MarketerPriceRow[]; products: { code: string; name: string }[] | null }) {
  const byCode = new Map<string, MarketerPriceRow[]>();
  for (const p of prices) byCode.set(p.productCode, [...(byCode.get(p.productCode) ?? []), p]);
  const now = new Date();
  const batches = ledger.batches.filter((b) => b.status !== "CANCELLED");
  return (
    <div className="space-y-5">
      <SectionCard
        title="Giá sản xuất thực tế theo lô"
        hint="Giá SX thực tế = (tiền vải gán vào lô + tiền công) ÷ tổng số hàng xưởng thực tế trả. Lô chưa bấm “xưởng đã trả xong” hoặc chưa chốt SL thanh toán là TẠM TÍNH. Thiếu một vế thì hiện “—” kèm lý do, không ra một giá rẻ giả."
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lô</TableHead>
                <TableHead className="text-right">Tiền vải</TableHead>
                <TableHead className="text-right">Tiền công</TableHead>
                <TableHead className="text-right">Tổng</TableHead>
                <TableHead className="text-right">Xưởng thực trả</TableHead>
                <TableHead className="text-right">Giá SX / chiếc</TableHead>
                <TableHead>Tình trạng</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batches.length === 0 ? (
                <EmptyRow cols={7}>Chưa có lô nào để tính giá.</EmptyRow>
              ) : (
                batches.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell>
                      <Link href={`/inventory/workshop/${b.id}`} className="font-mono font-semibold text-primary hover:underline">
                        {b.productCode} · lô {b.batchNo}
                      </Link>
                      <div className="text-xs text-muted-foreground">{b.fabricSource === "WORKSHOP" ? "xưởng lo vải" : `${formatNumber(b.fabrics.length)} đợt vải`}</div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatVND(b.cost.fabricCost)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatVND(b.cost.laborCost)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatVND(b.cost.total)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(b.cost.delivered)}</TableCell>
                    <TableCell className="text-right text-base font-bold tabular-nums">{formatVND(b.cost.unitCost)}</TableCell>
                    <TableCell className="text-xs">
                      <span className={b.cost.unitCost == null ? "text-amber-600 dark:text-amber-400" : b.cost.provisional ? "text-sky-600 dark:text-sky-400" : "text-emerald-600 dark:text-emerald-400"}>{b.cost.reason}</span>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      <SectionCard
        title="Giá sản xuất thực tế theo mã hàng"
        hint="Cộng MỌI tiền vải của mã (kể cả đợt vải chưa gán lô) và tiền công mọi lô, chia cho tổng hàng xưởng trả. MKT phụ trách đọc từ cấu hình Lương (Marketer phụ trách mã); giá báo MKT là của lô đặt gần nhất có báo giá. Cột “Giá trên phiếu kho” là giá nhập bình quân của phiếu nhập kho gần nhất — thứ báo cáo lợi nhuận đang dùng làm giá vốn. Lệch nhiều nghĩa là phiếu kho đang ghi sai giá; ERP không tự sửa phiếu."
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mã hàng</TableHead>
                <TableHead className="text-right">Tiền vải</TableHead>
                <TableHead className="text-right">Tiền công</TableHead>
                <TableHead className="text-right">Xưởng thực trả</TableHead>
                <TableHead className="text-right">Giá SX / chiếc</TableHead>
                <TableHead className="text-right">Giá trên phiếu kho</TableHead>
                <TableHead className="text-right">Chênh lệch</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ledger.products.length === 0 ? (
                <EmptyRow cols={7}>Chưa có mã hàng nào trong sổ đặt xưởng.</EmptyRow>
              ) : (
                ledger.products.map((p) => {
                  const diff = p.cost.unitCost != null && p.receiptUnitCost != null ? p.receiptUnitCost - p.cost.unitCost : null;
                  return (
                    <TableRow key={p.productCode}>
                      <TableCell>
                        <span className="font-mono font-semibold">{p.productCode}</span>
                        <div className="max-w-[200px] truncate text-xs text-muted-foreground">
                          {formatNumber(p.batches)} lô{p.productName ? ` · ${p.productName}` : ""}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          MKT {p.marketerName ?? "chưa gán"} · báo {formatVND(p.marketerPrice)}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatVND(p.cost.fabricCost)}
                        {p.unassignedFabric ? <div className="text-xs text-amber-600 dark:text-amber-400">{formatVND(p.unassignedFabric)} chưa gán lô</div> : null}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatVND(p.cost.laborCost)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(p.cost.delivered)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        <b className="text-base">{formatVND(p.cost.unitCost)}</b>
                        <div className={cn("text-xs", p.cost.unitCost == null ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>{p.cost.reason}</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatVND(p.receiptUnitCost)}
                        <div className="text-xs text-muted-foreground">{p.receiptAt ? `phiếu ${formatDate(p.receiptAt)}` : p.productId ? "chưa có phiếu nhập" : "mã chưa khớp sản phẩm"}</div>
                      </TableCell>
                      <TableCell className={cn("text-right font-medium tabular-nums", diff != null && diff !== 0 && "text-amber-600 dark:text-amber-400")}>{diff == null ? "—" : formatVND(diff, { sign: true })}</TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      <SectionCard
        title="Giá báo MKT theo mã"
        hint="Giá chốt tính cho MKT thay giá vốn thật, ở phần của MKT (lợi nhuận danh nghĩa theo MKT và lương), cho đơn lên từ 01/09/2026. Một mã một giá; muốn hạ giá xả tồn thì thêm dòng mới có ngày hiệu lực — đơn lên từ ngày đó dùng giá mới. Không sửa lùi được vào kỳ lương đã khoá. Lợi nhuận SHOP vẫn trên giá vốn thật."
        actions={products ? <MarketerPriceDialog products={products} /> : null}
        padded={false}
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mã hàng</TableHead>
                <TableHead className="text-right">Giá đang áp</TableHead>
                <TableHead>Lịch sử giá (hiệu lực từ → giá)</TableHead>
                {products ? <TableHead /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {byCode.size === 0 ? (
                <EmptyRow cols={products ? 4 : 3}>Chưa có giá báo MKT nào — mọi mã đang tính cho MKT bằng giá vốn thật.</EmptyRow>
              ) : (
                [...byCode.entries()].map(([code, rows]) => {
                  const ap = rows.filter((x) => x.effectiveFrom.getTime() <= now.getTime()).at(-1) ?? null;
                  return (
                    <TableRow key={code}>
                      <TableCell className="font-mono font-semibold">{code}</TableCell>
                      <TableCell className="text-right text-base font-bold tabular-nums">{ap ? formatVND(ap.price) : <span className="text-sm font-normal text-muted-foreground">chưa tới ngày hiệu lực</span>}</TableCell>
                      <TableCell className="text-xs">
                        {rows.map((x) => (
                          <div key={x.id} className="flex items-center gap-1">
                            <span className={x === ap ? "font-semibold text-foreground" : "text-muted-foreground"}>
                              {formatDate(x.effectiveFrom)} → {formatVND(x.price)}
                              {x.reason ? ` · ${x.reason}` : ""} · {x.setBy || "—"}
                            </span>
                            {products ? <DeleteMarketerPriceButton id={x.id} label={`${code} từ ${formatDate(x.effectiveFrom)}`} /> : null}
                          </div>
                        ))}
                      </TableCell>
                      {products ? (
                        <TableCell className="text-right">
                          <MarketerPriceDialog products={products} defaultCode={code} />
                        </TableCell>
                      ) : null}
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
    </div>
  );
}

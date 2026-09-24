import Link from "next/link";
import { AlarmClock, Boxes, Factory, HelpCircle, PackageX, Truck } from "lucide-react";
import { InfoHint } from "@/components/info-hint";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can, requirePermission } from "@/lib/auth/session";
import { SHORTAGE_ACTION_LABEL, SHORTAGE_DECISIONS, SHORTAGE_DECISION_LABEL, SHORTAGE_LINKS, waitLabel, waitingOrderDetail, type ShortageAction, type ShortageDecisionKind } from "@/lib/constants/stock-shortage";
import { ShortageDecisionButtons } from "@/app/(dashboard)/inventory/shortage/decision-buttons";
import { formatDate, formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { getStockShortage } from "@/lib/queries/stock-shortage";
import { cn } from "@/lib/utils";

export const metadata = { title: "Thiếu hàng giao đơn" };

const ACTION_TONE: Record<ShortageAction, string> = {
  COUNT_STOCK: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  CHASE_FACTORY: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  ORDER_PRODUCTION: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
};

/**
 * ═══════════ THIẾU HÀNG GIAO ĐƠN ĐÃ CHỐT ═══════════
 *
 * Trang đích của tin Lark "thiếu hàng". Hai bảng, hai phòng:
 *   · THEO MẪU MÃ — phòng Sản xuất (đặt / giục xưởng) và Kho (kiểm đếm khi sổ lệch).
 *   · THEO ĐƠN — CSKH báo khách, đề nghị đổi màu cùng size, hoặc huỷ.
 * Chỉ đọc: không nút nào ở đây ghi dữ liệu. Tạo lệnh sản xuất đi qua trang Kế hoạch SX như cũ.
 */
export default async function StockShortagePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePermission("planning:view");
  const canWrite = can(user, "planning:write");
  const sp = await searchParams;
  // Mở từ link trên tin Lark: `?variant=…&decide=…` — tô dòng đó và nút tương ứng.
  const focusVariant = typeof sp.variant === "string" ? sp.variant : null;
  const focusDecision = typeof sp.decide === "string" && (SHORTAGE_DECISIONS as readonly string[]).includes(sp.decide) ? (sp.decide as ShortageDecisionKind) : null;
  const s = await getStockShortage();
  const focusRow = focusVariant ? s.variants.find((v) => v.variantId === focusVariant) : undefined;
  const now = s.measuredAt;
  const byVariant = new Map(s.variants.map((v) => [v.variantId, v]));
  const waiting = [...s.orders.values()].filter((o) => o.state === "WAITING_STOCK").sort((a, b) => a.insertedAt.getTime() - b.insertedAt.getTime());
  const oldest = s.variants.reduce((m, r) => Math.max(m, r.oldestWaitHours), 0);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Sản xuất"
        title="Thiếu hàng giao đơn"
        hint={
          <>
            <p>
              Đơn <b>đã chốt</b> mà hàng <b>chưa rời kho</b> được phân tồn thực tế theo thứ tự <b>ai lên đơn trước được hàng trước</b> (đơn khách hẹn giao ngày xa xếp cuối). Đơn không được phân đủ là đơn <b>chờ hàng</b>.
            </p>
            <p className="mt-1.5">
              Tồn thực tế = sổ kho ERP (phiếu kho − đã xuất qua ĐVVC). Tồn Pancake KHÔNG dùng để tính — chỉ để gợi ý kho kiểm đếm khi hai bên lệch. Mẫu chưa có phiếu nhập thì tồn là CHƯA BIẾT, đơn giữ nó được đếm riêng, không tính là thiếu.
            </p>
            <p className="mt-1.5">Đề xuất đặt = số của Kế hoạch SX sau khi trừ hàng đã đặt xưởng chưa nhận (cùng phép trừ với trang Quyết định vốn tồn kho). Trang chỉ đề xuất, không tạo lệnh sản xuất.</p>
          </>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={SHORTAGE_LINKS.planning}>
                <Factory className="size-4" /> Kế hoạch đặt hàng SX
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={SHORTAGE_LINKS.stock}>
                <Boxes className="size-4" /> Tồn kho
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/operations/fulfillment">
                <Truck className="size-4" /> Nút thắt rời kho
              </Link>
            </Button>
          </div>
        }
      />

      {focusVariant && focusDecision ? (
        <div className="rounded-xl border border-primary/40 bg-primary/5 px-4 py-2.5 text-[13px]">
          {focusRow ? (
            <>
              Xác nhận từ Lark: <b>{focusRow.productCode || focusRow.productName} {[focusRow.color, focusRow.size].filter(Boolean).join("/")}</b> — <b>{SHORTAGE_DECISION_LABEL[focusDecision]}</b>.{" "}
              {canWrite ? "Bấm nút được tô viền ở dòng bên dưới để ghi." : "Tài khoản này không có quyền lập bảng đặt hàng — nhờ người phụ trách sản xuất bấm."}
            </>
          ) : (
            <>Mẫu trong link không còn thiếu hàng cho đơn đã chốt — không cần xác nhận nữa.</>
          )}
        </div>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Đơn chờ hàng"
          value={formatNumber(s.totals.waitingOrders)}
          note={`${formatVND(s.totals.waitingValue, { compact: true })} giá trị đơn · ${formatNumber(s.totals.readyOrders)} đơn đủ hàng`}
          hint="Đơn đã chốt, còn trong kho, không được phân đủ hàng. Giá trị là số KHAI BÁO trên đơn, không phải tiền đã thu."
          icon={PackageX}
          tone={s.totals.waitingOrders ? "rose" : "slate"}
        />
        <MetricCard
          label="Thiếu"
          value={`${formatNumber(s.totals.shortUnits)} cái`}
          note={`${formatNumber(s.totals.variants)} mẫu mã${s.totals.ledgerNegativeVariants ? ` · ${formatNumber(s.totals.ledgerNegativeVariants)} mẫu sổ kho ÂM` : ""}`}
          hint="Tổng số cái các đơn đang chờ mà kho không có. Mẫu có sổ kho âm thì số thiếu chưa đáng tin tới khi kiểm kê."
          icon={Factory}
          tone={s.totals.shortUnits ? "amber" : "slate"}
        />
        <MetricCard
          label="Chờ lâu nhất"
          value={s.variants.length ? waitLabel(oldest) : "—"}
          note={s.totals.urgentOrders ? `${formatNumber(s.totals.urgentOrders)} đơn chờ quá ${s.urgentAfterHours} giờ` : `Ngưỡng "để lâu": ${s.urgentAfterHours} giờ`}
          hint="Tính từ lúc lên đơn. Ngưỡng để lâu dùng chung với cảnh báo 'đơn chờ xử lý quá hạn' ở trang Cảnh báo — sửa ở đó."
          icon={AlarmClock}
          tone={s.totals.urgentOrders ? "rose" : "slate"}
        />
        <MetricCard
          label="Chưa biết tồn"
          value={formatNumber(s.totals.unknownOrders)}
          note={`${formatNumber(s.totals.unknownVariants)} mẫu chưa có phiếu nhập`}
          hint="Đơn giữ mẫu chưa có phiếu nhập: không biết còn hay thiếu. Kho lập phiếu nhập thì ERP mới tính được."
          icon={HelpCircle}
          tone={s.totals.unknownOrders ? "amber" : "slate"}
        />
      </section>

      <SectionCard
        title={`Theo mẫu mã — ${formatNumber(s.variants.length)} mẫu thiếu`}
        description={`Đo lúc ${formatDateTime(now)} · đơn chờ lâu nhất đứng đầu`}
        hint="Việc cần làm xét theo thứ tự: sổ kho âm hoặc Pancake báo còn đủ ⇒ kho kiểm đếm trước; đã đặt xưởng đủ bù ⇒ giục xưởng, không đặt thêm; còn lại ⇒ đặt sản xuất. Cột Xác nhận: 'Đã đặt rồi' thôi nhắc trên Lark tới khi thiếu vượt mức lúc bấm; 'Sẽ đặt thêm' vẫn nhắc; 'Không đặt nữa' thôi nhắc hẳn — đơn đang chờ vẫn ở hàng đợi CSKH."
        padded={false}
      >
        {s.variants.length === 0 ? (
          <EmptyState title="Không mẫu nào thiếu hàng cho đơn đã chốt" description="Mọi đơn đã chốt còn trong kho đều đã được phân đủ hàng." className="m-4" />
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[1150px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Mẫu mã</TableHead>
                  <TableHead className="text-right">Thiếu</TableHead>
                  <TableHead className="text-right">Đơn chờ</TableHead>
                  <TableHead>Chờ lâu nhất</TableHead>
                  <TableHead className="text-right">Tồn ERP / giữ</TableHead>
                  <TableHead className="text-right">Đã đặt xưởng</TableHead>
                  <TableHead className="text-right">Đề xuất đặt</TableHead>
                  <TableHead>Việc cần làm</TableHead>
                  <TableHead>Xác nhận</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.variants.map((r) => (
                  <TableRow key={r.variantId} id={`v-${r.variantId}`} className={cn(r.urgent && !r.muted && "bg-rose-50/40 dark:bg-rose-950/10", r.muted && "opacity-70", r.variantId === focusVariant && "bg-primary/10 outline outline-2 outline-primary/50")}>
                    <TableCell className="max-w-[240px]">
                      <div className="truncate font-medium" title={`${r.productName} · ${r.sku}`}>
                        {r.productCode ? `${r.productCode} · ` : ""}
                        {r.productName}
                      </div>
                      <div className="font-mono text-[11px] text-muted-foreground">{[r.color, r.size].filter(Boolean).join(" / ") || r.sku}</div>
                    </TableCell>
                    <TableCell className="text-right font-bold tabular-nums text-rose-600 dark:text-rose-400">{formatNumber(r.shortQty)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(r.waitingOrders)}</TableCell>
                    <TableCell className={cn("text-xs whitespace-nowrap", r.urgent && "font-semibold text-rose-600 dark:text-rose-400")} title={`Đơn chờ lâu nhất lên lúc ${formatDateTime(r.oldestWaitingAt)}`}>
                      {waitLabel(r.oldestWaitHours)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-xs">
                      <span className={cn(r.ledgerNegative && "font-semibold text-rose-600")}>{formatNumber(r.onHand)}</span> / {formatNumber(r.reserved)}
                      {r.pancakeStock !== null ? <span className="block text-[10.5px] text-muted-foreground">Pancake {formatNumber(r.pancakeStock)}</span> : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-xs">
                      {r.openPoQty ? formatNumber(r.openPoQty) : <span className="text-muted-foreground">0</span>}
                      {r.openPoQty ? <span className={cn("block text-[10.5px]", r.openPoDueAt && r.openPoDueAt < now ? "font-semibold text-rose-600" : "text-muted-foreground")}>{r.openPoDueAt ? `hạn ${formatDate(r.openPoDueAt)}` : "chưa ghi hạn"}</span> : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-bold">{r.proposeQty === null ? "—" : formatNumber(r.proposeQty)}</TableCell>
                    <TableCell className="max-w-[320px] text-xs">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={cn("rounded px-1.5 py-0.5 text-[10.5px] font-semibold whitespace-nowrap", ACTION_TONE[r.action])}>{SHORTAGE_ACTION_LABEL[r.action]}</span>
                        {r.action === "ORDER_PRODUCTION" ? (
                          <Link href={SHORTAGE_LINKS.newProductionOrder(r.productId)} className="text-[11px] font-medium text-primary hover:underline">
                            Tạo bảng chốt SX →
                          </Link>
                        ) : null}
                        <InfoHint label="Chi tiết">{r.actionText}</InfoHint>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.decision ? (
                        <div className="mb-1 text-[10.5px] text-muted-foreground">
                          {r.muted ? "🔕 " : ""}
                          <b>{SHORTAGE_DECISION_LABEL[r.decision.decision]}</b> · {r.decision.byName} · {formatDateTime(r.decision.at)}
                        </div>
                      ) : null}
                      <ShortageDecisionButtons variantId={r.variantId} current={r.decision?.decision ?? null} suggested={r.variantId === focusVariant ? focusDecision : null} canWrite={canWrite} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      {waiting.length ? (
        <SectionCard
          title={`Theo đơn — ${formatNumber(waiting.length)} đơn chờ hàng`}
          description="Việc của CSKH: báo khách thời gian chờ, đề nghị đổi màu cùng size còn hàng, hoặc huỷ nếu khách không chờ được."
          hint="Đơn lên trước đứng trước. Không đóng gói / tạo vận đơn cho đơn chưa có hàng."
          padded={false}
        >
          <ul className="divide-y">
            {waiting.map((o) => {
              const hours = (now.getTime() - o.insertedAt.getTime()) / 3_600_000;
              const late = hours >= s.urgentAfterHours;
              return (
                <li key={o.orderId} className="flex flex-wrap items-start gap-3 px-5 py-2.5">
                  <span className={cn("mt-0.5 rounded px-1.5 py-0.5 text-[10.5px] font-semibold whitespace-nowrap", late ? "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300" : "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300")}>
                    chờ {waitLabel(hours)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link href={`/orders/${o.orderId}`} className="text-sm font-semibold hover:text-primary hover:underline">
                      #{o.systemId ?? "?"} · {o.customer}
                    </Link>
                    <span className="ml-2 text-xs text-muted-foreground">{formatVND(o.value)}</span>
                    <p className="text-xs text-muted-foreground">{waitingOrderDetail(o, byVariant, now)}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </SectionCard>
      ) : null}
    </div>
  );
}
